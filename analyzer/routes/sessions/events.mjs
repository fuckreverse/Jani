/**
 * sessions/events.mjs — 事件查询相关接口
 *
 * GET /api/sessions/:id/event-types         事件类型统计
 * GET /api/sessions/:id/events              事件列表（分页 + 过滤）
 * GET /api/sessions/:id/value-search        按值反查 value_index
 * GET /api/sessions/:id/value-search/events 值搜索 + 事件详情合并
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
                `SELECT event_id, name, value, omitted FROM writes WHERE session_id = ? AND event_id IN (${placeholders})`,
                id, ...eventIds
            );
            reads = db.all(
                `SELECT event_id, name, value, omitted FROM reads WHERE session_id = ? AND event_id IN (${placeholders})`,
                id, ...eventIds
            );
            fields = db.all(
                `SELECT event_id, offset, is_write, value, omitted, base_oid FROM fields WHERE session_id = ? AND event_id IN (${placeholders})`,
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

        // 批量取 writes/reads/fields
        const writes = db.all(
            `SELECT event_id, name, value, omitted FROM writes WHERE session_id = ? AND event_id IN (${placeholders})`,
            id, ...eventIds
        );
        const reads = db.all(
            `SELECT event_id, name, value, omitted FROM reads WHERE session_id = ? AND event_id IN (${placeholders})`,
            id, ...eventIds
        );
        const fields = db.all(
            `SELECT event_id, offset, is_write, value, omitted, base_oid FROM fields WHERE session_id = ? AND event_id IN (${placeholders})`,
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

export default router;
