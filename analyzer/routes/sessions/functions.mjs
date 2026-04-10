/**
 * sessions/functions.mjs — 函数调用相关接口
 *
 * GET /api/sessions/:id/functions                        函数列表（聚合统计）
 * GET /api/sessions/:id/functions/:fnName/calls          某函数的所有调用记录
 * GET /api/sessions/:id/calls/:callId/own-events         某次调用的自身事件流
 * GET /api/sessions/:id/call-graph                       调用图
 * GET /api/sessions/:id/call-stack                       调用栈（祖先帧列表）
 * GET /api/sessions/:id/events/:seq/owner-fn             事件所属函数帧
 */

import { Router } from 'express';
import { createLogger } from '../../logger.mjs';

const log = createLogger('sessions');
import * as db from '../../db/Database.mjs';
import { decodeType } from '../../db/EventTypeCode.mjs';
import { safeParseJson, groupBy, BUILTIN_FN_NAMES } from './utils.mjs';

const router = Router({ mergeParams: true });

// ── GET /api/sessions/:id/functions ──────────────────────────────────────
// 按 fn_name 聚合 call_edges，返回函数列表（调用次数、行号等）
//
// 新增过滤参数：
//   minEvents   / maxEvents  — 按函数体事件数（≈ MAX(return_seq)-MIN(call_seq) 近似）过滤
//   hideBuiltin              — '1' 时隐藏 JS 内建函数（charAt/indexOf/push/… 等）
//   sortBy                   — 'call_count'（默认）| 'event_count'（按事件数倒序）

router.get('/functions', (req, res) => {
    try {
        const { id } = req.params;
        const {
            search      = '',
            minCalls    = '1',
            limit       = '100',
            offset      = '0',
            fnIid,              // 精确 iid 过滤（跨 Tab 跳转时使用）
            minEvents,          // 函数体最少事件数（近似：MAX(return_seq)-MIN(call_seq)）
            maxEvents,          // 函数体最多事件数
            hideBuiltin = '0',  // '1' 隐藏 JS 内建函数
            sortBy      = 'call_count',  // 'call_count' | 'event_count'
            line,               // 调用点行号过滤：caller_line = N（精确匹配）
        } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (search) {
            conditions.push('fn_name LIKE ?');
            params.push(`%${search}%`);
        }
        if (fnIid !== undefined && fnIid !== '') {
            conditions.push('fn_iid = ?');
            params.push(Number(fnIid));
        }
        // hideBuiltin：fn_name 不在内建名单中（仅 fn_name 不含 '.' 的短名；Math.xxx 等带点的
        // 由于 call_edges.fn_name 通常只存方法短名，这里直接用 NOT IN 过滤）
        if (hideBuiltin === '1') {
            const placeholders = Array.from(BUILTIN_FN_NAMES).map(() => '?').join(',');
            conditions.push(`fn_name NOT IN (${placeholders})`);
            params.push(...BUILTIN_FN_NAMES);
        }
        // line：按调用点行号精确过滤（caller_line = N）
        if (line !== undefined && line !== '') {
            conditions.push('caller_line = ?');
            params.push(Number(line));
        }

        const minCallsN  = Math.max(1, Number(minCalls) || 1);
        const limitN     = Math.min(Number(limit)  || 100, 500);
        const offsetN    = Number(offset) || 0;
        const minEventsN = minEvents !== undefined && minEvents !== '' ? Number(minEvents) : null;
        const maxEventsN = maxEvents !== undefined && maxEvents !== '' ? Number(maxEvents) : null;

        // HAVING 子句：call_count + 可选的 own_event_count 范围
        const ownExpr = `SUM(COALESCE(own_event_count, COALESCE(return_seq,call_seq) - call_seq))`;
        const havingClauses = [`COUNT(*) >= ?`];
        const havingParams  = [minCallsN];
        if (minEventsN !== null) {
            havingClauses.push(`${ownExpr} >= ?`);
            havingParams.push(minEventsN);
        }
        if (maxEventsN !== null) {
            havingClauses.push(`${ownExpr} <= ?`);
            havingParams.push(maxEventsN);
        }

        const avgOwnOrderExpr = `CAST(ROUND(1.0 * ${ownExpr} / COUNT(*)) AS INTEGER)`;
        const orderExpr = sortBy === 'event_count'
            ? `${avgOwnOrderExpr} DESC`
            : `call_count DESC`;

        const avgOwnExpr = `CAST(ROUND(1.0 * ${ownExpr} / COUNT(*)) AS INTEGER)`;
        const rows = db.all(
            `SELECT
                fn_name,
                fn_iid,
                COUNT(*)         AS call_count,
                ${ownExpr}       AS event_count,
                ${avgOwnExpr}    AS avg_own_event_count,
                MIN(caller_line) AS min_line,
                MIN(depth)       AS min_depth,
                MAX(depth)       AS max_depth
             FROM call_edges
             WHERE ${conditions.join(' AND ')}
             GROUP BY fn_name, fn_iid
             HAVING ${havingClauses.join(' AND ')}
             ORDER BY ${orderExpr}
             LIMIT ? OFFSET ?`,
            ...params, ...havingParams, limitN, offsetN
        );

        // 总数（用于分页）：用子查询对聚合结果再计数
        const totalRow = db.get(
            `SELECT COUNT(*) AS total
             FROM (
               SELECT fn_name
               FROM call_edges
               WHERE ${conditions.join(' AND ')}
               GROUP BY fn_name, fn_iid
               HAVING ${havingClauses.join(' AND ')}
             )`,
            ...params, ...havingParams
        );

        return res.json({
            functions: rows,
            count: rows.length,
            total: totalRow?.total ?? rows.length,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/functions] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/functions/:fnName/calls ─────────────────────────
// 返回某函数名下所有调用记录（含参数、返回值、SEQ 范围）

router.get('/functions/:fnName/calls', (req, res) => {
    try {
        const { id, fnName } = req.params;
        const { limit = '200', offset = '0', fnIid, callSeq } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const limitN  = Math.min(Number(limit)  || 200, 1000);

        // 支持按 fn_iid 精确过滤，避免同名不同位置的函数调用混在一起
        const conditions = ['session_id = ?', 'fn_name = ?'];
        const baseParams = [id, fnName];
        if (fnIid !== undefined && fnIid !== '') {
            conditions.push('fn_iid = ?');
            baseParams.push(Number(fnIid));
        }
        const where = conditions.join(' AND ');

        const total = db.get(
            `SELECT COUNT(*) AS cnt FROM call_edges WHERE ${where}`,
            ...baseParams
        )?.cnt ?? 0;

        // callSeq 定位：计算目标调用在第几条（rank），从而得到正确的 offset
        let offsetN = Number(offset) || 0;
        let targetCallId = null;
        if (callSeq !== undefined && callSeq !== '') {
            const callSeqN = Number(callSeq);
            const rankRow = db.get(
                `SELECT COUNT(*) AS rank FROM call_edges
                 WHERE ${where} AND call_seq < ?
                 ORDER BY call_seq ASC`,
                ...baseParams, callSeqN
            );
            if (rankRow) {
                offsetN = Math.floor(rankRow.rank / limitN) * limitN;
            }
            const targetRow = db.get(
                `SELECT id FROM call_edges WHERE ${where} AND call_seq = ?`,
                ...baseParams, callSeqN
            );
            targetCallId = targetRow?.id ?? null;
        }

        const rows = db.all(
            `SELECT id, call_seq, return_seq, caller_line, fn_name, fn_iid, args_json, return_value, depth
             FROM call_edges
             WHERE ${where}
             ORDER BY call_seq ASC
             LIMIT ? OFFSET ?`,
            ...baseParams, limitN, offsetN
        );

        const result = rows.map(r => ({
            id:           r.id,
            callSeq:      r.call_seq,
            returnSeq:    r.return_seq,
            callerLine:   r.caller_line,
            fnName:       r.fn_name,
            fnIid:        r.fn_iid,
            args:         safeParseJson(r.args_json, []),
            returnValue:  safeParseJson(r.return_value, null),
            depth:        r.depth,
        }));

        return res.json({ calls: result, count: result.length, total, targetCallId, offset: offsetN });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/functions/:fnName/calls] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/calls/:callId/own-events ────────────────────────
// 返回某次具体调用的「自身事件流」：[call_seq, return_seq] 区间内去除所有直接子调用占据的 SEQ
//
// 实现方式（高性能，无全表扫描）：
//  1. 查该次调用的所有直接子调用区间（depth+1，call_seq ∈ [callSeqN, returnSeqN]）
//     → 利用 idx_call_edges_stack 索引，O(子调用数)
//  2. 将排除区间传入 SQL WHERE，或在 Node.js 侧过滤（取决于子调用数量）
//  3. 支持游标分页：cursor 为上次返回的最后 event SEQ，下次从 id > cursor 开始
//     → 配合子区间排除，每页取 limit 条自身事件

router.get('/calls/:callId/own-events', (req, res) => {
    try {
        const { id, callId } = req.params;
        const { limit = '200', cursor } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        // 取该次调用基本信息
        const call = db.get(
            'SELECT call_seq, return_seq, depth FROM call_edges WHERE id = ? AND session_id = ?',
            Number(callId), id
        );
        if (!call) return res.status(404).json({ error: `Call ${callId} not found` });

        const { call_seq: callSeqN, return_seq: returnSeqN, depth: depthN } = call;
        const limitN = Math.min(Number(limit) || 200, 500);

        // ── Step 1: 取所有直接子调用区间（depth+1，在本调用区间内）──────────────
        const children = db.all(
            `SELECT call_seq, return_seq FROM call_edges
             WHERE session_id = ?
               AND depth = ?
               AND call_seq  >= ?
               AND return_seq <= ?
             ORDER BY call_seq ASC`,
            id, depthN + 1, callSeqN, returnSeqN
        );

        // ── Step 2: 构建 SQL 排除条件 ─────────────────────────────────────────
        // 策略：排除每个子调用的「内部」事件（call_seq+1 到 return_seq-1），
        // 但保留头（CALL_PRE @ call_seq）和尾（CALL @ return_seq），
        // 这样 A 的事件流里仍能看到「调用了 B」及「B 的返回值」。
        const baseConditions = [
            'e.session_id = ?',
            'e.id >= ?',
            'e.id <= ?',
        ];
        const baseParams = [id, callSeqN, returnSeqN];

        // 游标分页
        if (cursor !== undefined && cursor !== '') {
            baseConditions.push('e.id > ?');
            baseParams.push(Number(cursor));
        }

        let events;
        if (children.length > 0 && children.length <= 200) {
            // 子调用数量合理：直接在 SQL 里排除内部区间（保留头尾）
            const innerChildren = children.filter(c => c.call_seq + 1 <= c.return_seq - 1);
            const excludeClauses = innerChildren.map(() => 'e.id NOT BETWEEN ? AND ?');
            const excludeParams  = innerChildren.flatMap(c => [c.call_seq + 1, c.return_seq - 1]);
            const where = excludeClauses.length > 0
                ? [...baseConditions, ...excludeClauses].join(' AND ')
                : baseConditions.join(' AND ');

            events = db.all(
                `SELECT e.id AS seq, e.type, e.iid,
                        s.sl AS line, s.sc AS col, s.src_text
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE ${where}
                 ORDER BY e.id ASC
                 LIMIT ?`,
                ...baseParams, ...excludeParams, limitN
            );
        } else if (children.length > 200) {
            // 子调用数量过多：先取全量 event，Node.js 侧过滤
            const rawEvents = db.all(
                `SELECT e.id AS seq, e.type, e.iid,
                        s.sl AS line, s.sc AS col, s.src_text
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE ${baseConditions.join(' AND ')}
                 ORDER BY e.id ASC
                 LIMIT ?`,
                ...baseParams, limitN * 3  // 多取以应对过滤损耗
            );
            events = rawEvents.filter(e => {
                for (const c of children) {
                    if (e.seq > c.call_seq && e.seq < c.return_seq) return false;
                }
                return true;
            }).slice(0, limitN);
        } else {
            // 无子调用：直接返回全量
            const where = baseConditions.join(' AND ');
            events = db.all(
                `SELECT e.id AS seq, e.type, e.iid,
                        s.sl AS line, s.sc AS col, s.src_text
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE ${where}
                 ORDER BY e.id ASC
                 LIMIT ?`,
                ...baseParams, limitN
            );
        }

        // ── Step 3: 批量查 writes/reads/fields ────────────────────────────────
        const eventIds = events.map(e => e.seq);
        let writes = [], reads = [], fields = [];

        if (eventIds.length > 0) {
            const ph = eventIds.map(() => '?').join(',');
            writes = db.all(`SELECT event_id, name, value, omitted FROM writes WHERE session_id = ? AND event_id IN (${ph})`, id, ...eventIds);
            reads  = db.all(`SELECT event_id, name, value, omitted FROM reads  WHERE session_id = ? AND event_id IN (${ph})`, id, ...eventIds);
            fields = db.all(`SELECT event_id, offset, is_write, value, omitted, base_oid FROM fields WHERE session_id = ? AND event_id IN (${ph})`, id, ...eventIds);
        }

        const writesMap = groupBy(writes, 'event_id');
        const readsMap  = groupBy(reads,  'event_id');
        const fieldsMap = groupBy(fields, 'event_id');

        const result = events.map(e => ({
            seq:     e.seq,
            type:    decodeType(e.type),
            iid:     e.iid,
            line:    e.line ?? null,
            col:     e.col  ?? null,
            srcText: e.src_text ?? null,
            writes:  (writesMap[e.seq] || []).map(w => ({ name: w.name, value: safeParseJson(w.value), omitted: !!w.omitted })),
            reads:   (readsMap[e.seq]  || []).map(r => ({ name: r.name, value: safeParseJson(r.value), omitted: !!r.omitted })),
            fields:  (fieldsMap[e.seq] || []).map(f => ({ offset: f.offset, isWrite: !!f.is_write, value: safeParseJson(f.value), omitted: !!f.omitted, baseOid: f.base_oid ?? null })),
        }));

        const nextCursor = result.length === limitN ? result[result.length - 1].seq : null;

        return res.json({
            sessionId: id,
            callId:    Number(callId),
            events:    result,
            count:     result.length,
            hasMore:   result.length === limitN,
            nextCursor,
            childCount: children.length,
        });

    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/calls/:callId/own-events] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/call-graph ──────────────────────────────────────

router.get('/call-graph', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const edges = db.all(
            'SELECT * FROM call_edges WHERE session_id = ? ORDER BY call_seq ASC LIMIT 1000',
            id
        );

        // 构建节点（按 fn_name 去重）
        const nodesMap = new Map();
        for (const e of edges) {
            const key = e.fn_name || `fn@${e.fn_iid}`;
            if (!nodesMap.has(key)) nodesMap.set(key, { id: key, label: key, callCount: 0 });
            nodesMap.get(key).callCount++;
        }

        res.json({
            nodes: [...nodesMap.values()].map(n => ({ data: n })),
            edges: edges.map(e => ({
                data: {
                    id: `e${e.id}`,
                    source: `caller@${e.caller_line}`,
                    target: e.fn_name || `fn@${e.fn_iid}`,
                    callSeq: e.call_seq,
                    returnSeq: e.return_seq,
                    depth: e.depth,
                    argsJson: e.args_json,
                    returnValue: e.return_value,
                }
            })),
            rawEdges: edges,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/call-stack ──────────────────────────────────────
// 查询某次函数调用的完整调用栈（祖先帧列表）
// 查询参数：
//   callSeq=<N>    当前帧的 call_seq（CALL_PRE 事件 id）
//   returnSeq=<N>  当前帧的 return_seq（CALL 事件 id）
//   depth=<N>      当前帧的深度，查 depth < N 的所有祖先帧

router.get('/call-stack', (req, res) => {
    try {
        const { id } = req.params;
        const { callSeq, returnSeq, depth } = req.query;

        if (callSeq === undefined || returnSeq === undefined || depth === undefined) {
            return res.status(400).json({ error: 'callSeq, returnSeq, depth are required' });
        }

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const callSeqN   = Number(callSeq);
        const returnSeqN = Number(returnSeq);
        const depthN     = Number(depth);

        // 深度为 0 表示顶层调用，无父帧
        if (depthN <= 0) {
            return res.json({ stack: [] });
        }

        // 查找所有包含当前调用区间且深度更小的帧（即祖先帧），按深度升序排列
        const frames = db.all(
            `SELECT fn_name, fn_iid, caller_line, depth, args_json, return_value, call_seq, return_seq
             FROM call_edges
             WHERE session_id = ?
               AND call_seq <= ?
               AND return_seq >= ?
               AND depth < ?
             ORDER BY depth ASC`,
            id, callSeqN, returnSeqN, depthN
        );

        res.json({
            stack: frames.map(f => ({
                fnName:      f.fn_name,
                fnIid:       f.fn_iid,
                callerLine:  f.caller_line,
                depth:       f.depth,
                args:        safeParseJson(f.args_json, []),
                returnValue: safeParseJson(f.return_value, null),
                callSeq:     f.call_seq,
                returnSeq:   f.return_seq,
            })),
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/call-stack] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/events/:seq/owner-fn ────────────────────────────
// 查询某个事件所属的最近函数帧（即包含该 seq 的 depth 最大的调用边）

router.get('/events/:seq/owner-fn', (req, res) => {
    try {
        const { id, seq } = req.params;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const seqN = Number(seq);
        if (isNaN(seqN)) return res.status(400).json({ error: 'seq must be a number' });

        // 找包含该 seq 的调用帧中 depth 最大的（最近调用者）
        const frame = db.get(
            `SELECT fn_name, fn_iid, caller_line, depth, call_seq, return_seq, args_json, return_value
             FROM call_edges
             WHERE session_id = ? AND call_seq <= ? AND return_seq >= ?
             ORDER BY depth DESC
             LIMIT 1`,
            id, seqN, seqN
        );

        if (!frame) {
            return res.json({ ownerFn: null });
        }

        res.json({
            ownerFn: {
                fnName:      frame.fn_name,
                fnIid:       frame.fn_iid,
                callerLine:  frame.caller_line,
                depth:       frame.depth,
                callSeq:     frame.call_seq,
                returnSeq:   frame.return_seq,
                args:        safeParseJson(frame.args_json, []),
                returnValue: safeParseJson(frame.return_value, null),
            },
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/events/:seq/owner-fn] error:');
        res.status(500).json({ error: e.message });
    }
});

export default router;
