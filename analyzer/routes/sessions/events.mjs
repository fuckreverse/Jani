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
import { safeParseJson, groupBy } from './utils.mjs';

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
            limit  = '100',
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
        if (line !== undefined) {
            conditions.push(`EXISTS (SELECT 1 FROM smap s WHERE s.session_id = e.session_id AND s.iid = e.iid AND s.sl = ?)`);
            params.push(Number(line));
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
        const limitN  = Math.min(Number(limit)  || 100, 1000);
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
        const { num, numMin, numMax, str, strLike, varName, source, limit = '200' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined && varName === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike, varName',
            });
        }

        const limitN = Math.min(Number(limit) || 200, 1000);
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
                limit = '50', offset = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined && varName === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike, varName',
            });
        }

        const limitN  = Math.min(Number(limit)  || 50,  200);
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
        const { topN = '20' } = req.query;
        const topNNum = Math.min(Number(topN) || 20, 200);

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
            limit = '100', offset = '0',
        } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const limitN  = Math.min(Number(limit)  || 100, 500);
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

        // ── Step 1: 将所有 ranges 解析为 [{lo, hi, excludeRanges[]}] ───────────
        // excludeRanges 仅 callId+ownOnly=true 时填入（子调用内部区间）
        const resolvedRanges = [];  // [{ lo, hi, excludes: [{lo,hi}] }]

        for (const r of ranges) {
            if (r.callId != null) {
                // 函数调用范围
                const call = db.get(
                    'SELECT call_seq, return_seq, depth FROM call_edges WHERE id = ? AND session_id = ?',
                    Number(r.callId), id
                );
                if (!call) continue;
                const { call_seq, return_seq, depth } = call;
                const ownOnly = r.ownOnly !== false;  // 默认 true

                if (!ownOnly) {
                    // 全量区间，不排除子调用
                    resolvedRanges.push({ lo: call_seq, hi: return_seq, excludes: [] });
                } else {
                    // 自身事件：用与 own-events 相同的区间减法，得到若干段连续范围
                    const children = db.all(
                        `SELECT call_seq, return_seq FROM call_edges
                         WHERE session_id = ? AND depth = ?
                           AND call_seq >= ? AND call_seq <= ?
                         ORDER BY call_seq ASC`,
                        id, depth + 1, call_seq, return_seq
                    );
                    // 把 [call_seq, return_seq] 按子调用切段，保留子调用边界
                    let cur = call_seq;
                    for (const c of children) {
                        if (c.call_seq >= cur) {
                            resolvedRanges.push({ lo: cur, hi: c.call_seq, excludes: [] });
                        }
                        cur = c.return_seq;
                    }
                    resolvedRanges.push({ lo: cur, hi: return_seq, excludes: [] });
                }
            } else if (r.seqFrom != null && r.seqTo != null) {
                resolvedRanges.push({
                    lo: Number(r.seqFrom),
                    hi: Number(r.seqTo),
                    excludes: [],
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
        const evStmt = rawDb.prepare(
            `SELECT e.id AS seq, e.type, e.iid,
                    s.sl AS line, s.sc AS col, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE e.session_id = ? AND e.id >= ? AND e.id <= ?
             ORDER BY e.id ASC`
        );
        const wStmt = rawDb.prepare(
            `SELECT w.event_id, w.name, vd.val_text AS value, w.omitted
             FROM writes w
             LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
             WHERE w.session_id = ? AND w.event_id >= ? AND w.event_id <= ?`
        );
        const rStmt = rawDb.prepare(
            `SELECT r.event_id, r.name, vd.val_text AS value, r.omitted
             FROM reads r
             LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
             WHERE r.session_id = ? AND r.event_id >= ? AND r.event_id <= ?`
        );
        const fStmt = rawDb.prepare(
            `SELECT f.event_id, f.offset, f.is_write, vd.val_text AS value, f.omitted, f.base_oid
             FROM fields f
             LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
             WHERE f.session_id = ? AND f.event_id >= ? AND f.event_id <= ?`
        );

        // 逐段流式输出（每段最多 BATCH 条，避免单次锁定时间过长）
        const BATCH = 2000;

        for (const seg of resolvedRanges) {
            let cursor = seg.lo;
            while (cursor <= seg.hi) {
                const hiPage = Math.min(cursor + BATCH - 1, seg.hi);
                const evRows = evStmt.all(id, cursor, hiPage);
                if (evRows.length === 0) break;

                // 批量取 writes/reads/fields
                const firstSeq = evRows[0].seq;
                const lastSeq  = evRows[evRows.length - 1].seq;
                const wRows = wStmt.all(id, firstSeq, lastSeq);
                const rRows = rStmt.all(id, firstSeq, lastSeq);
                const fRows = fStmt.all(id, firstSeq, lastSeq);

                // 分组
                const wMap = new Map(), rMap = new Map(), fMap = new Map();
                for (const w of wRows) {
                    if (!wMap.has(w.event_id)) wMap.set(w.event_id, []);
                    wMap.get(w.event_id).push(w);
                }
                for (const r of rRows) {
                    if (!rMap.has(r.event_id)) rMap.set(r.event_id, []);
                    rMap.get(r.event_id).push(r);
                }
                for (const f of fRows) {
                    if (!fMap.has(f.event_id)) fMap.set(f.event_id, []);
                    fMap.get(f.event_id).push(f);
                }

                let chunk = '';
                for (const e of evRows) {
                    const writes = (wMap.get(e.seq) || []).map(w => ({
                        name: w.name,
                        value: safeParseJson(w.value),
                        omitted: !!w.omitted,
                    }));
                    const reads = (rMap.get(e.seq) || []).map(r => ({
                        name: r.name,
                        value: safeParseJson(r.value),
                        omitted: !!r.omitted,
                    }));
                    const fields = (fMap.get(e.seq) || []).map(f => ({
                        offset: f.offset,
                        isWrite: !!f.is_write,
                        value: safeParseJson(f.value),
                        omitted: !!f.omitted,
                        baseOid: f.base_oid ?? null,
                    }));

                    const typeStr = decodeType(e.type);

                    if (format === 'ndjson') {
                        chunk += JSON.stringify({
                            seq:     e.seq,
                            type:    typeStr,
                            iid:     e.iid,
                            line:    e.line ?? null,
                            col:     e.col  ?? null,
                            srcText: e.src_text ?? null,
                            writes,
                            reads,
                            fields,
                        }) + '\n';

                    } else if (format === 'tsv') {
                        // writes/reads/fields 序列化为紧凑字符串
                        const wStr = writes.map(w => w.omitted ? `${w.name}=…` : `${w.name}=${JSON.stringify(w.value)}`).join(';');
                        const rStr = reads.map(r  => r.omitted ? `${r.name}=…` : `${r.name}=${JSON.stringify(r.value)}`).join(';');
                        const fStr = fields.map(f => {
                            const arrow = f.isWrite ? '=' : '->';
                            return `#${f.baseOid ?? '?'}.${f.offset}${arrow}${JSON.stringify(f.value)}`;
                        }).join(';');
                        const loc  = e.line != null ? `${e.line}:${e.col ?? 0}` : '';
                        const src  = (e.src_text ?? '').replace(/\t/g, ' ');
                        chunk += `${e.seq}\t${typeStr}\t${loc}\t${src}\t${wStr}\t${rStr}\t${fStr}\n`;

                    } else {
                        // text — 人类可读
                        const loc    = e.line != null ? `@${e.line}:${e.col ?? 0}` : '';
                        const srcPad = e.src_text ? `  │ ${e.src_text}` : '';
                        let line = `[${String(e.seq).padStart(8)}] ${typeStr.padEnd(14)} ${loc}${srcPad}`;
                        if (writes.length) {
                            line += '\n' + writes.map(w =>
                                `            W  ${w.name} = ${w.omitted ? '…' : JSON.stringify(w.value)}`
                            ).join('\n');
                        }
                        if (reads.length) {
                            line += '\n' + reads.map(r =>
                                `            R  ${r.name} → ${r.omitted ? '…' : JSON.stringify(r.value)}`
                            ).join('\n');
                        }
                        if (fields.length) {
                            line += '\n' + fields.map(f =>
                                `            F  #${f.baseOid ?? '?'}.${f.offset} ${f.isWrite ? '=' : '->'} ${JSON.stringify(f.value)}`
                            ).join('\n');
                        }
                        chunk += line + '\n';
                    }
                }

                res.write(chunk);
                cursor = hiPage + 1;
            }
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

