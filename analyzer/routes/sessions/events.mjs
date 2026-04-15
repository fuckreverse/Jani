/**
 * sessions/events.mjs — 事件查询相关接口
 *
 * GET /api/sessions/:id/event-types         事件类型统计
 * GET /api/sessions/:id/events              事件列表（分页 + 过滤）
 * GET /api/sessions/:id/value-search        按值反查 value_index
 * GET /api/sessions/:id/value-search/events 值搜索 + 事件详情合并
 * GET /api/sessions/:id/value-dict          值字典查询（按 val_type/text 搜索，含引用计数）
 * GET /api/sessions/:id/value-dict/stats    值字典统计（总条目数、类型分布、Top-N 高频值）
 */

import { Router } from 'express';
import { createLogger } from '../../logger.mjs';

const log = createLogger('sessions');
import * as db from '../../db/Database.mjs';
import { decodeType, TYPE } from '../../db/EventTypeCode.mjs';
import { safeParseJson, groupBy, makeIsInsideChild } from './utils.mjs';
import { cfg } from '../../Config.mjs';

const router = Router({ mergeParams: true });

// ── GET /api/sessions/:id/event-types ────────────────────────────────────
// 返回该会话存在的所有事件类型及其数量

router.get('/event-types', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const rows = db.all(
            `SELECT type, COUNT(*) as cnt FROM events WHERE session_id = ? GROUP BY type ORDER BY cnt DESC`,
            id
        );
        // type 列为整数编码（Phase D），解码为字符串返回前端
        return res.json({ types: rows.map(r => ({ type: decodeType(r.type), cnt: r.cnt })) });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/event-types] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/events ──────────────────────────────────────────

router.get('/events', (req, res) => {
    try {
        const { id } = req.params;
        const {
            line,
            type,
            types,       // 多选，逗号分隔，如 "CALL_PRE,CALL"
            varName,
            seqFrom,
            seqTo,
            limit,
            offset = '0',   // 向后兼容，推荐改用 cursor
            cursor,         // 游标分页：上次返回的最后一个 seq，下次从 id > cursor 开始
        } = req.query;

        // 检查 session 是否存在
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) {
            return res.status(404).json({ error: `Session ${id} not found` });
        }

        // 构建查询
        const conditions = ['e.session_id = ?'];
        const params = [id];

        // line 已从 events 移除（Phase D），通过 smap 过滤
        // 支持两种格式：
        //   单行号：line=45        → s.sl = 45
        //   行号范围：line=45-52   → s.sl BETWEEN 45 AND 52
        if (line !== undefined) {
            const dashIdx = String(line).indexOf('-');
            if (dashIdx > 0) {
                const lo = Number(line.slice(0, dashIdx));
                const hi = Number(line.slice(dashIdx + 1));
                conditions.push(`EXISTS (SELECT 1 FROM smap s WHERE s.session_id = e.session_id AND s.iid = e.iid AND s.sl BETWEEN ? AND ?)`);
                params.push(lo, hi);
            } else {
                conditions.push(`EXISTS (SELECT 1 FROM smap s WHERE s.session_id = e.session_id AND s.iid = e.iid AND s.sl = ?)`);
                params.push(Number(line));
            }
        }
        // types 多选（优先），type 单选（向后兼容）
        // type 列为整数编码（Phase D），过滤时将字符串转为整数
        if (types) {
            const typeList = types.split(',').map(t => t.trim()).filter(Boolean);
            const typeCodes = typeList.map(t => TYPE[t] ?? 0);
            if (typeCodes.length === 1) {
                conditions.push('e.type = ?');
                params.push(typeCodes[0]);
            } else if (typeCodes.length > 1) {
                conditions.push(`e.type IN (${typeCodes.map(() => '?').join(',')})`);
                params.push(...typeCodes);
            }
        } else if (type) {
            conditions.push('e.type = ?');
            params.push(TYPE[type] ?? 0);
        }
        if (seqFrom !== undefined) {
            conditions.push('e.id >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined) {
            conditions.push('e.id <= ?');
            params.push(Number(seqTo));
        }
        // 游标分页：cursor 优先于 offset（O(1) 深页访问）
        if (cursor !== undefined) {
            conditions.push('e.id > ?');
            params.push(Number(cursor));
        }

        // varName：在 writes 或 reads 中包含该变量名
        if (varName) {
            conditions.push(`(
                EXISTS (SELECT 1 FROM writes w WHERE w.session_id = e.session_id AND w.event_id = e.id AND w.name = ?)
                OR EXISTS (SELECT 1 FROM reads  r WHERE r.session_id = e.session_id AND r.event_id = e.id AND r.name = ?)
            )`);
            params.push(varName, varName);
        }

        const where = conditions.join(' AND ');
        const _eventsDefaultLimit = cfg('api.defaultPageSize');
        const _eventsMaxCap      = cfg('api.maxEventsCap');
        const limitN  = Math.min(Number(limit)  || _eventsDefaultLimit, _eventsMaxCap);
        // 游标模式不使用 OFFSET（O(1) 定位）；offset 仅向后兼容
        const offsetN = cursor !== undefined ? 0 : (Number(offset) || 0);

        // line/col/src_text 已从 events 移除（Phase D），LEFT JOIN smap 获取
        const events = db.all(
            `SELECT e.id AS seq, e.type, e.iid,
                    s.sl AS line, s.sc AS col, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE ${where}
             ORDER BY e.id ASC
             LIMIT ? OFFSET ?`,
            ...params, limitN, offsetN
        );

        // 批量查询 writes/reads/fields
        const eventIds = events.map(e => e.seq);
        let writes = [], reads = [], fields = [];

        if (eventIds.length > 0) {
            const placeholders = eventIds.map(() => '?').join(',');
            writes = db.all(
                `SELECT w.event_id, w.name, vd.val_text AS value, w.omitted
                 FROM writes w
                 LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
                 WHERE w.session_id = ? AND w.event_id IN (${placeholders})`,
                id, ...eventIds
            );
            reads = db.all(
                `SELECT r.event_id, r.name, vd.val_text AS value, r.omitted
                 FROM reads r
                 LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
                 WHERE r.session_id = ? AND r.event_id IN (${placeholders})`,
                id, ...eventIds
            );
            fields = db.all(
                `SELECT f.event_id, f.offset, f.is_write, vd.val_text AS value, f.omitted, f.base_oid
                 FROM fields f
                 LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
                 WHERE f.session_id = ? AND f.event_id IN (${placeholders})`,
                id, ...eventIds
            );
        }

        // 按 event_id 分组
        const writesMap  = groupBy(writes,  'event_id');
        const readsMap   = groupBy(reads,   'event_id');
        const fieldsMap  = groupBy(fields,  'event_id');

        // 组合结果
        const result = events.map(e => {
            return {
                seq:      e.seq,
                type:     decodeType(e.type),  // 整数 → 字符串（Phase D）
                iid:      e.iid,
                line:     e.line ?? null,
                col:      e.col  ?? null,
                srcText:  e.src_text ?? null,
                writes:   (writesMap[e.seq] || []).map(w => ({
                    name:    w.name,
                    value:   safeParseJson(w.value),
                    omitted: !!w.omitted,
                })),
                reads:    (readsMap[e.seq] || []).map(r => ({
                    name:    r.name,
                    value:   safeParseJson(r.value),
                    omitted: !!r.omitted,
                })),
                fields:   (fieldsMap[e.seq] || []).map(f => ({
                    offset:  f.offset,
                    isWrite: !!f.is_write,
                    value:   safeParseJson(f.value),
                    omitted: !!f.omitted,
                    baseOid: f.base_oid ?? null,
                })),
            };
        });

        // 游标：返回本页最后一条的 seq，供下次请求使用
        const nextCursor = result.length === limitN ? result[result.length - 1].seq : null;

        return res.json({
            sessionId: id,
            events: result,
            count:  result.length,
            hasMore: result.length === limitN,
            nextCursor,
        });

    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/events] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-search ────────────────────────────────────
// 按值反查事件（利用 value_index 表）
// 查询参数（至少提供一个）：
//   num=<number>          精确数值匹配（走 idx_vi_num 索引，O(log N)）
//   numMin=<n>&numMax=<n> 数值范围匹配（走 idx_vi_num 范围扫描）
//   str=<string>          精确字符串匹配（走 idx_vi_str 索引，O(log N)）
//   strLike=<pattern>     模糊字符串匹配，支持 * 通配符（内部转为 SQL LIKE，全表扫描）
//   source=write|read|field  可选，限定来源（默认不限）
//   limit=<n>             最多返回条数（默认 200，最大 1000）

router.get('/value-search', (req, res) => {
    try {
        const { id } = req.params;
        const { num, numMin, numMax, str, strLike, varName, source, limit } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined && varName === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike, varName',
            });
        }

        const _vsDefaultLimit = cfg('api.valueSearchDefaultLimit');
        const _vsMaxLimit     = cfg('api.valueSearchMaxLimit');
        const limitN = Math.min(Number(limit) || _vsDefaultLimit, _vsMaxLimit);
        const conditions = ['session_id = ?'];
        const params = [id];

        // 数值类查询
        if (num !== undefined) {
            const n = Number(num);
            if (isNaN(n)) return res.status(400).json({ error: 'num must be a valid number' });
            conditions.push("val_type = 'num'", 'val_num = ?');
            params.push(n);
        } else if (numMin !== undefined || numMax !== undefined) {
            conditions.push("val_type = 'num'");
            if (numMin !== undefined) {
                const lo = Number(numMin);
                if (isNaN(lo)) return res.status(400).json({ error: 'numMin must be a valid number' });
                conditions.push('val_num >= ?');
                params.push(lo);
            }
            if (numMax !== undefined) {
                const hi = Number(numMax);
                if (isNaN(hi)) return res.status(400).json({ error: 'numMax must be a valid number' });
                conditions.push('val_num <= ?');
                params.push(hi);
            }
        // 字符串类查询
        } else if (str !== undefined) {
            conditions.push("val_type IN ('str', 'bool')", 'val_str = ?');
            params.push(str);
        } else if (strLike !== undefined) {
            // 将用户输入的 * 转为 SQL LIKE 的 %，同时转义原有的 % 和 _
            const likePattern = strLike
                .replace(/%/g, '\\%')
                .replace(/_/g, '\\_')
                .replace(/\*/g, '%');
            conditions.push("val_type IN ('str', 'bool')", "val_str LIKE ? ESCAPE '\\'");
            params.push(likePattern);
        }

        // 可选：限定来源
        if (source && ['write', 'read', 'field'].includes(source)) {
            conditions.push('source = ?');
            params.push(source);
        }

        // 可选：按变量名过滤（走 idx_vi_varname 索引）
        if (varName) {
            conditions.push('var_name = ?');
            params.push(varName);
        }

        const rows = db.all(
            `SELECT event_id, val_type, val_num, val_str, var_name, source
             FROM value_index
             WHERE ${conditions.join(' AND ')}
             ORDER BY event_id ASC
             LIMIT ?`,
            [...params, limitN]
        );

        res.json({ matches: rows, count: rows.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-search] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-search/events ─────────────────────────────
// 值搜索 + 事件详情合并接口：一次请求完成"按值找事件"并返回完整事件数据（含分页）
// 解决原方案"取 min/max 范围 + 前端二次过滤"的分页不准问题
// 查询参数与 value-search 相同，额外支持：
//   offset=<n>   分页偏移（默认 0）
//   limit=<n>    每页条数（默认 50，最大 200）

router.get('/value-search/events', (req, res) => {
    try {
        const { id } = req.params;
        const { num, numMin, numMax, str, strLike, varName, source,
                limit, offset = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined && varName === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike, varName',
            });
        }

        const _vseDefaultLimit = cfg('api.valueSearchEventsDefaultLimit');
        const _vseMaxLimit     = cfg('api.valueSearchEventsMaxLimit');
        const limitN  = Math.min(Number(limit)  || _vseDefaultLimit, _vseMaxLimit);
        const offsetN = Number(offset) || 0;

        // 构建 value_index 查询条件（与 value-search 相同）
        const viConds  = ['vi.session_id = ?'];
        const viParams = [id];

        if (num !== undefined) {
            const n = Number(num);
            if (isNaN(n)) return res.status(400).json({ error: 'num must be a valid number' });
            viConds.push("vi.val_type = 'num'", 'vi.val_num = ?');
            viParams.push(n);
        } else if (numMin !== undefined || numMax !== undefined) {
            viConds.push("vi.val_type = 'num'");
            if (numMin !== undefined) { viConds.push('vi.val_num >= ?'); viParams.push(Number(numMin)); }
            if (numMax !== undefined) { viConds.push('vi.val_num <= ?'); viParams.push(Number(numMax)); }
        } else if (str !== undefined) {
            viConds.push("vi.val_type IN ('str', 'bool')", 'vi.val_str = ?');
            viParams.push(str);
        } else if (strLike !== undefined) {
            const likePattern = strLike
                .replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, '%');
            viConds.push("vi.val_type IN ('str', 'bool')", "vi.val_str LIKE ? ESCAPE '\\'");
            viParams.push(likePattern);
        }
        if (source && ['write', 'read', 'field'].includes(source)) {
            viConds.push('vi.source = ?');
            viParams.push(source);
        }
        if (varName) {
            viConds.push('vi.var_name = ?');
            viParams.push(varName);
        }

        const viWhere = viConds.join(' AND ');

        // 总命中数（用于前端分页显示）
        const totalRow = db.get(
            `SELECT COUNT(DISTINCT vi.event_id) AS total
             FROM value_index vi WHERE ${viWhere}`,
            viParams
        );
        const total = totalRow?.total ?? 0;

        // 按 event_id 分页取目标事件 id 列表
        const matchRows = db.all(
            `SELECT DISTINCT vi.event_id, vi.var_name, vi.val_type, vi.val_num, vi.val_str, vi.source
             FROM value_index vi
             WHERE ${viWhere}
             ORDER BY vi.event_id ASC
             LIMIT ? OFFSET ?`,
            [...viParams, limitN, offsetN]
        );

        if (matchRows.length === 0) {
            return res.json({ events: [], total, count: 0, hasMore: false });
        }

        const eventIds = matchRows.map(r => r.event_id);
        const placeholders = eventIds.map(() => '?').join(',');

        // 拉取事件主体（JOIN smap）
        const evRows = db.all(
            `SELECT e.id AS seq, e.type, e.iid,
                    s.sl AS line, s.sc AS col, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE e.session_id = ? AND e.id IN (${placeholders})
             ORDER BY e.id ASC`,
            id, ...eventIds
        );

        // 批量取 writes/reads/fields（JOIN value_dict 获取完整值）
        const writes = db.all(
            `SELECT w.event_id, w.name, vd.val_text AS value, w.omitted
             FROM writes w
             LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
             WHERE w.session_id = ? AND w.event_id IN (${placeholders})`,
            id, ...eventIds
        );
        const reads = db.all(
            `SELECT r.event_id, r.name, vd.val_text AS value, r.omitted
             FROM reads r
             LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
             WHERE r.session_id = ? AND r.event_id IN (${placeholders})`,
            id, ...eventIds
        );
        const fields = db.all(
            `SELECT f.event_id, f.offset, f.is_write, vd.val_text AS value, f.omitted, f.base_oid
             FROM fields f
             LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
             WHERE f.session_id = ? AND f.event_id IN (${placeholders})`,
            id, ...eventIds
        );

        const writesMap = groupBy(writes, 'event_id');
        const readsMap  = groupBy(reads,  'event_id');
        const fieldsMap = groupBy(fields, 'event_id');

        // 构建 matchInfo：event_id → { varName, valType, valNum, valStr, source }
        const matchInfo = {};
        for (const r of matchRows) {
            matchInfo[r.event_id] = {
                varName:  r.var_name,
                valType:  r.val_type,
                valNum:   r.val_num,
                valStr:   r.val_str,
                source:   r.source,
            };
        }

        const result = evRows.map(e => ({
            seq:       e.seq,
            type:      decodeType(e.type),
            iid:       e.iid,
            line:      e.line ?? null,
            col:       e.col  ?? null,
            srcText:   e.src_text ?? null,
            matchInfo: matchInfo[e.seq] ?? null,   // 命中的值信息（变量名、值）
            writes:    (writesMap[e.seq] || []).map(w => ({ name: w.name, value: safeParseJson(w.value), omitted: !!w.omitted })),
            reads:     (readsMap[e.seq]  || []).map(r => ({ name: r.name, value: safeParseJson(r.value), omitted: !!r.omitted })),
            fields:    (fieldsMap[e.seq] || []).map(f => ({ offset: f.offset, isWrite: !!f.is_write, value: safeParseJson(f.value), omitted: !!f.omitted, baseOid: f.base_oid ?? null })),
        }));

        res.json({
            events:  result,
            total,
            count:   result.length,
            hasMore: offsetN + result.length < total,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-search/events] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-dict/stats ────────────────────────────────
// 值字典统计：总条目数、各类型数量、Top-N 高频引用值
// 引用计数 = 在 writes + reads + fields 中 value_id 出现的总次数
// 查询参数：
//   topN=<n>  返回引用最多的 N 个值（默认 20，最大 200）

router.get('/value-dict/stats', (req, res) => {
    try {
        const { id } = req.params;
        const { topN } = req.query;
        const _vdTopNDefault = cfg('api.valueDictTopNDefault');
        const _vdTopNMax     = cfg('api.valueDictTopNMax');
        const topNNum = Math.min(Number(topN) || _vdTopNDefault, _vdTopNMax);

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        // 总条目数（value_dict 中该 session 的唯一值数）
        const totalRow = db.get(
            'SELECT COUNT(*) AS total FROM value_dict WHERE session_id = ?', [id]
        );

        // 各类型分布
        const typeStats = db.all(
            `SELECT val_type, COUNT(*) AS cnt
             FROM value_dict WHERE session_id = ?
             GROUP BY val_type ORDER BY cnt DESC`,
            [id]
        );

        // Top-N 高频引用值
        // 使用 UNION ALL 聚合三张表的 value_id 引用次数
        const topValues = db.all(
            `SELECT vd.id, vd.val_text, vd.val_type, vd.val_num,
                    SUM(ref.cnt) AS ref_count
             FROM value_dict vd
             JOIN (
                 SELECT value_id, COUNT(*) AS cnt
                 FROM writes WHERE session_id = ? AND value_id IS NOT NULL GROUP BY value_id
                 UNION ALL
                 SELECT value_id, COUNT(*) AS cnt
                 FROM reads  WHERE session_id = ? AND value_id IS NOT NULL GROUP BY value_id
                 UNION ALL
                 SELECT value_id, COUNT(*) AS cnt
                 FROM fields WHERE session_id = ? AND value_id IS NOT NULL GROUP BY value_id
             ) ref ON ref.value_id = vd.id
             WHERE vd.session_id = ?
             GROUP BY vd.id
             ORDER BY ref_count DESC
             LIMIT ?`,
            [id, id, id, id, topNNum]
        );

        res.json({
            sessionId:    id,
            totalEntries: totalRow?.total ?? 0,
            typeStats:    typeStats.map(r => ({ type: r.val_type, count: r.cnt })),
            topValues:    topValues.map(r => ({
                id:        r.id,
                valText:   r.val_text,
                valType:   r.val_type,
                valNum:    r.val_num ?? null,
                refCount:  r.ref_count,
            })),
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-dict/stats] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-dict ──────────────────────────────────────
// 值字典查询：按类型 / 文本搜索字典条目，并返回引用计数
// 查询参数：
//   valType=<type>      限定类型：num / bool / str / null / obj
//   text=<string>       精确匹配 val_text（走 UNIQUE 索引，O(log N)）
//   textLike=<pattern>  模糊匹配 val_text（支持 * 通配，走全扫描）
//   numMin=<n>          数值下限（val_type='num' 时走 idx_vd_num 索引）
//   numMax=<n>          数值上限
//   withRefCount=1      是否附带各表引用计数（默认 0，附带时查询较慢）
//   limit=<n>           返回条数（默认 100，最大 500）
//   offset=<n>          偏移（默认 0）

router.get('/value-dict', (req, res) => {
    try {
        const { id } = req.params;
        const {
            valType, text, textLike, numMin, numMax,
            withRefCount = '0',
            limit, offset = '0',
        } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const _vdDefaultLimit = cfg('api.valueDictDefaultLimit');
        const _vdMaxLimit     = cfg('api.valueDictMaxLimit');
        const limitN  = Math.min(Number(limit)  || _vdDefaultLimit, _vdMaxLimit);
        const offsetN = Number(offset) || 0;

        const conds  = ['vd.session_id = ?'];
        const params = [id];

        if (valType) {
            conds.push('vd.val_type = ?');
            params.push(valType);
        }
        if (text !== undefined) {
            conds.push('vd.val_text = ?');
            params.push(text);
        } else if (textLike !== undefined) {
            const pat = textLike
                .replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, '%');
            conds.push("vd.val_text LIKE ? ESCAPE '\\'");
            params.push(pat);
        }
        if (numMin !== undefined) {
            const lo = Number(numMin);
            if (isNaN(lo)) return res.status(400).json({ error: 'numMin must be a number' });
            conds.push('vd.val_type = ?', 'vd.val_num >= ?');
            params.push('num', lo);
        }
        if (numMax !== undefined) {
            const hi = Number(numMax);
            if (isNaN(hi)) return res.status(400).json({ error: 'numMax must be a number' });
            if (numMin === undefined) { conds.push('vd.val_type = ?'); params.push('num'); }
            conds.push('vd.val_num <= ?');
            params.push(hi);
        }

        const where = conds.join(' AND ');

        let rows;
        if (withRefCount === '1') {
            // 附带引用计数：UNION ALL 聚合三张表，再 LEFT JOIN value_dict
            rows = db.all(
                `SELECT vd.id, vd.val_text, vd.val_type, vd.val_num,
                        COALESCE(SUM(ref.cnt), 0) AS ref_count
                 FROM value_dict vd
                 LEFT JOIN (
                     SELECT value_id, COUNT(*) AS cnt
                     FROM writes WHERE session_id = ? AND value_id IS NOT NULL GROUP BY value_id
                     UNION ALL
                     SELECT value_id, COUNT(*) AS cnt
                     FROM reads  WHERE session_id = ? AND value_id IS NOT NULL GROUP BY value_id
                     UNION ALL
                     SELECT value_id, COUNT(*) AS cnt
                     FROM fields WHERE session_id = ? AND value_id IS NOT NULL GROUP BY value_id
                 ) ref ON ref.value_id = vd.id
                 WHERE ${where}
                 GROUP BY vd.id
                 ORDER BY vd.id ASC
                 LIMIT ? OFFSET ?`,
                [id, id, id, ...params, limitN, offsetN]
            );
        } else {
            rows = db.all(
                `SELECT vd.id, vd.val_text, vd.val_type, vd.val_num
                 FROM value_dict vd
                 WHERE ${where}
                 ORDER BY vd.id ASC
                 LIMIT ? OFFSET ?`,
                [...params, limitN, offsetN]
            );
        }

        // 总数（用于分页）
        const totalRow = db.get(
            `SELECT COUNT(*) AS total FROM value_dict vd WHERE ${where}`,
            params
        );

        res.json({
            sessionId: id,
            entries:   rows.map(r => ({
                id:        r.id,
                valText:   r.val_text,
                valType:   r.val_type,
                valNum:    r.val_num ?? null,
                refCount:  r.ref_count ?? undefined,
            })),
            total:   totalRow?.total ?? 0,
            count:   rows.length,
            hasMore: offsetN + rows.length < (totalRow?.total ?? 0),
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-dict] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/sessions/:id/events/export ──────────────────────────────────
// 导出指定范围内的事件，支持多范围、流式输出。
//
// 请求体（JSON）：
//   ranges  — 范围列表，每项为以下之一：
//     { seqFrom: N, seqTo: N }             — 直接 SEQ 区间（含两端）
//     { callId: N, ownOnly: true|false }   — 函数单次调用；ownOnly=true 仅自身事件（默认 true）
//   format  — 'ndjson'（默认）| 'tsv' | 'text'
//
// 响应：流式（Transfer-Encoding: chunked），大文件安全。

router.post('/events/export', async (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const { ranges = [], format = 'ndjson' } = req.body || {};
        if (!Array.isArray(ranges) || ranges.length === 0) {
            return res.status(400).json({ error: 'ranges must be a non-empty array' });
        }
        if (!['ndjson', 'tsv', 'text'].includes(format)) {
            return res.status(400).json({ error: 'format must be ndjson | tsv | text' });
        }

        // ── Step 1: 将所有 ranges 解析为 [{lo, hi, children[]}] ─────────────
        // 不再把 ownOnly 展开成 N 个小段（可能有 1000+ 段），
        // 而是保留一个大范围 [call_seq, return_seq]，附带子调用列表 children，
        // Step 2 扫描时在 Node.js 侧用 makeIsInsideChild 过滤。
        const resolvedRanges = [];  // [{ lo, hi, children: [{call_seq,return_seq}] }]

        for (const r of ranges) {
            if (r.callId != null) {
                const call = db.get(
                    'SELECT call_seq, return_seq, depth FROM call_edges WHERE id = ? AND session_id = ?',
                    Number(r.callId), id
                );
                if (!call) continue;
                const { call_seq, return_seq, depth } = call;
                const ownOnly = r.ownOnly !== false;  // 默认 true

                if (!ownOnly) {
                    resolvedRanges.push({ lo: call_seq, hi: return_seq, children: [] });
                } else {
                    // 查子调用，Node.js 侧过滤（不展开成多段）
                    const children = db.all(
                        `SELECT call_seq, return_seq FROM call_edges
                         WHERE session_id = ? AND depth = ?
                           AND call_seq >= ? AND call_seq <= ?
                         ORDER BY call_seq ASC`,
                        id, depth + 1, call_seq, return_seq
                    );
                    resolvedRanges.push({ lo: call_seq, hi: return_seq, children });
                }
            } else if (r.seqFrom != null && r.seqTo != null) {
                resolvedRanges.push({
                    lo: Number(r.seqFrom),
                    hi: Number(r.seqTo),
                    children: [],
                });
            }
        }

        if (resolvedRanges.length === 0) {
            return res.status(400).json({ error: 'No valid ranges resolved' });
        }

        // 按 lo 升序排序（便于流式顺序输出）
        resolvedRanges.sort((a, b) => a.lo - b.lo);

        // ── Step 2: 流式扫描并输出 ─────────────────────────────────────────────
        // 按格式设置响应头
        const ext      = format === 'tsv' ? 'tsv' : format === 'text' ? 'txt' : 'ndjson';
        const mime     = format === 'tsv'  ? 'text/tab-separated-values'
                       : format === 'text' ? 'text/plain'
                       : 'application/x-ndjson';
        res.setHeader('Content-Type', `${mime}; charset=utf-8`);
        res.setHeader('Content-Disposition', `attachment; filename="events-export.${ext}"`);
        res.setHeader('Transfer-Encoding', 'chunked');

        // TSV header
        if (format === 'tsv') {
            res.write('seq\ttype\tline\tcol\tsrcText\twrites\treads\tfields\n');
        }

        // 预备 SQL（按段走主键范围扫描）
        const rawDb = db.raw();

        // events：按 PK 范围扫描（不再 JOIN smap，smap 单独点查，避免大范围 JOIN 放大）
        const evStmt = rawDb.prepare(
            `SELECT id AS seq, type, iid
             FROM events
             WHERE session_id = ? AND id >= ? AND id <= ?
             ORDER BY id ASC LIMIT ?`
        );
        const smapStmt = rawDb.prepare(
            'SELECT sl AS line, sc AS col, src_text FROM smap WHERE session_id = ? AND iid = ?'
        );

        // writes/reads/fields：按实际 event id 列表 IN 查询，每批最多 500 个 id
        // （不再用 BETWEEN firstSeq AND lastSeq，避免拉进子调用内部的行）

        // 每批 events 行数（按实际输出行数，非 SEQ 步长）
        const BATCH = cfg('events.exportBatchSize');

        // ── 诊断计数器 ──────────────────────────────────────────────────────────
        const _t0export = performance.now();
        let _diagBatches = 0, _diagEvRows = 0, _diagWRows = 0, _diagRRows = 0, _diagFRows = 0;
        let _diagEvMs = 0, _diagSmapMs = 0, _diagWrfMs = 0, _diagSerMs = 0;

        for (const seg of resolvedRanges) {
            // 构建子调用过滤函数（ownOnly 模式下排除子调用内部事件）
            const isInsideSeg = seg.children.length > 0
                ? makeIsInsideChild(seg.children)
                : () => false;

            // 用密度估算每批要取多少行才能凑够 BATCH 条 own events
            // ownSeq = 总区间 - 子调用内部区间（子调用边界保留，所以 -1/-1 只算内部）
            const segSpan = seg.hi - seg.lo + 1;
            const childInternalSeq = seg.children.reduce((s, c) => s + Math.max(0, c.return_seq - c.call_seq - 1), 0);
            const ownSeq = Math.max(1, segSpan - childInternalSeq);
            const density = ownSeq / segSpan;
            const fetchSize = Math.min(50000, Math.max(BATCH * 2, Math.ceil(BATCH / density)));

            // ── PK 范围扫描 + Node.js 侧过滤，凑满 BATCH 后输出一批 ──────────
            // 核心：一次 SQL 取 fetchSize 行，在内存过滤掉子调用内部行，
            //       积攒到 BATCH 条再做 smap/writes/reads/fields 查询并写出。
            // 这样整个段只需 ceil(ownRows/BATCH) 次 smap+wrf 查询，而不是每个小段一次。

            const flushBatch = (evRows) => {
                if (evRows.length === 0) return;
                _diagBatches++;
                _diagEvRows += evRows.length;

                // smap 点查（去重 iid）
                const _ts0 = performance.now();
                const smapCache = new Map();
                for (const e of evRows) {
                    if (e.iid != null && !smapCache.has(e.iid)) {
                        smapCache.set(e.iid, smapStmt.get(id, e.iid) ?? null);
                    }
                }
                _diagSmapMs += performance.now() - _ts0;

                // writes/reads/fields：精确 IN 查询
                const _tw0 = performance.now();
                const seqList = evRows.map(e => e.seq);
                const ph = seqList.map(() => '?').join(',');
                const wRows = rawDb.prepare(
                    `SELECT w.event_id, w.name, vd.val_text AS value, w.omitted
                     FROM writes w
                     LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
                     WHERE w.session_id = ? AND w.event_id IN (${ph})`
                ).all([id, ...seqList]);
                const rRows = rawDb.prepare(
                    `SELECT r.event_id, r.name, vd.val_text AS value, r.omitted
                     FROM reads r
                     LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
                     WHERE r.session_id = ? AND r.event_id IN (${ph})`
                ).all([id, ...seqList]);
                const fRows = rawDb.prepare(
                    `SELECT f.event_id, f.offset, f.is_write, vd.val_text AS value, f.omitted, f.base_oid
                     FROM fields f
                     LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
                     WHERE f.session_id = ? AND f.event_id IN (${ph})`
                ).all([id, ...seqList]);
                _diagWrfMs += performance.now() - _tw0;
                _diagWRows += wRows.length; _diagRRows += rRows.length; _diagFRows += fRows.length;

                // 分组
                const wMap = new Map(), rMap = new Map(), fMap = new Map();
                for (const w of wRows) { if (!wMap.has(w.event_id)) wMap.set(w.event_id, []); wMap.get(w.event_id).push(w); }
                for (const r of rRows) { if (!rMap.has(r.event_id)) rMap.set(r.event_id, []); rMap.get(r.event_id).push(r); }
                for (const f of fRows) { if (!fMap.has(f.event_id)) fMap.set(f.event_id, []); fMap.get(f.event_id).push(f); }

                const _tser0 = performance.now();
                let chunk = '';
                for (const e of evRows) {
                    const sm = e.iid != null ? (smapCache.get(e.iid) ?? null) : null;
                    const writes = (wMap.get(e.seq) || []).map(w => ({ name: w.name, value: safeParseJson(w.value), omitted: !!w.omitted }));
                    const reads  = (rMap.get(e.seq) || []).map(r => ({ name: r.name, value: safeParseJson(r.value), omitted: !!r.omitted }));
                    const fields = (fMap.get(e.seq) || []).map(f => ({ offset: f.offset, isWrite: !!f.is_write, value: safeParseJson(f.value), omitted: !!f.omitted, baseOid: f.base_oid ?? null }));
                    const typeStr = decodeType(e.type);

                    if (format === 'ndjson') {
                        chunk += JSON.stringify({ seq: e.seq, type: typeStr, iid: e.iid, line: sm?.line ?? null, col: sm?.col ?? null, srcText: sm?.src_text ?? null, writes, reads, fields }) + '\n';
                    } else if (format === 'tsv') {
                        const wStr = writes.map(w => w.omitted ? `${w.name}=…` : `${w.name}=${JSON.stringify(w.value)}`).join(';');
                        const rStr = reads.map(r  => r.omitted ? `${r.name}=…` : `${r.name}=${JSON.stringify(r.value)}`).join(';');
                        const fStr = fields.map(f => `#${f.baseOid ?? '?'}.${f.offset}${f.isWrite ? '=' : '->'}${JSON.stringify(f.value)}`).join(';');
                        const loc  = sm?.line != null ? `${sm.line}:${sm.col ?? 0}` : '';
                        const src  = (sm?.src_text ?? '').replace(/\t/g, ' ');
                        chunk += `${e.seq}\t${typeStr}\t${loc}\t${src}\t${wStr}\t${rStr}\t${fStr}\n`;
                    } else {
                        const loc    = sm?.line != null ? `@${sm.line}:${sm.col ?? 0}` : '';
                        const srcPad = sm?.src_text ? `  │ ${sm.src_text}` : '';
                        let line = `[${String(e.seq).padStart(8)}] ${typeStr.padEnd(14)} ${loc}${srcPad}`;
                        if (writes.length) line += '\n' + writes.map(w => `            W  ${w.name} = ${w.omitted ? '…' : JSON.stringify(w.value)}`).join('\n');
                        if (reads.length)  line += '\n' + reads.map(r  => `            R  ${r.name} → ${r.omitted ? '…' : JSON.stringify(r.value)}`).join('\n');
                        if (fields.length) line += '\n' + fields.map(f => `            F  #${f.baseOid ?? '?'}.${f.offset} ${f.isWrite ? '=' : '->'} ${JSON.stringify(f.value)}`).join('\n');
                        chunk += line + '\n';
                    }
                }
                _diagSerMs += performance.now() - _tser0;
                res.write(chunk);
            };

            let cursor = seg.lo;
            let ownBuf = [];
            while (cursor <= seg.hi) {
                const _tb0 = performance.now();
                const batch = evStmt.all(id, cursor, seg.hi, fetchSize);
                _diagEvMs += performance.now() - _tb0;
                if (batch.length === 0) break;

                for (const r of batch) {
                    if (!isInsideSeg(r.seq)) {
                        ownBuf.push(r);
                        if (ownBuf.length >= BATCH) {
                            flushBatch(ownBuf);
                            ownBuf = [];
                        }
                    }
                }
                cursor = batch[batch.length - 1].seq + 1;
            }
            // 刷出剩余不足 BATCH 的部分
            flushBatch(ownBuf);
            ownBuf = [];
        }

        // ── 导出性能诊断日志 ──────────────────────────────────────────────────
        const _totalExport = performance.now() - _t0export;
        if (_totalExport > 200) {
            log.warn({
                sessionId: id, format,
                resolvedRangeCount: resolvedRanges.length,
                batches: _diagBatches,
                evRows: _diagEvRows,
                wRows: _diagWRows, rRows: _diagRRows, fRows: _diagFRows,
                ms: {
                    events:    +_diagEvMs.toFixed(1),
                    smap:      +_diagSmapMs.toFixed(1),
                    wrFields:  +_diagWrfMs.toFixed(1),
                    serialize: +_diagSerMs.toFixed(1),
                    total:     +_totalExport.toFixed(1),
                },
            }, '[export] slow export');
        }

        res.end();
    } catch (e) {
        log.error({ err: e }, '[POST /api/sessions/:id/events/export] error:');
        // 如果响应头已发送则只能 end，否则可返回 JSON error
        if (res.headersSent) {
            res.end();
        } else {
            res.status(500).json({ error: e.message });
        }
    }
});

export default router;

