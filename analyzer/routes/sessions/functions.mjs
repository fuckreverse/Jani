/**
 * sessions/functions.mjs — 函数调用相关接口
 *
 * GET /api/sessions/:id/functions                        函数列表（聚合统计）
 * GET /api/sessions/:id/functions/:fnName/calls          某函数的所有调用记录
 * GET /api/sessions/:id/calls/:callId/own-events         某次调用的自身事件流
 * GET /api/sessions/:id/call-graph                       调用图
 * GET /api/sessions/:id/call-stack                       调用栈（祖先帧列表）
 * GET /api/sessions/:id/events/:seq/owner-fn             事件所属函数帧
 * GET /api/sessions/:id/flamegraph                       火焰图（Speedscope 格式，基于 call_edges 聚合）
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

// ── GET /api/sessions/:id/functions/:fnName/callers ────────────────────────
// 反向调用图：查询调用了指定函数的所有调用者（按调用次数降序）
//
// 实现：
//   1. 找到 fn_name=X 的所有 call_edges（目标调用集合）
//   2. 对每个调用帧，查 depth-1 层中包含其 call_seq 的帧（即父帧）
//   3. 以父帧 fn_name 聚合，统计调用次数、行号等
//
// 查询参数：
//   fnIid  — 精确 iid 过滤（同名不同位置的函数）
//   limit  — 返回条数（默认 100）
//   offset — 分页偏移（默认 0）

router.get('/functions/:fnName/callers', (req, res) => {
    try {
        const { id, fnName } = req.params;
        const { fnIid, limit = '100', offset = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const limitN  = Math.min(Number(limit)  || 100, 500);
        const offsetN = Number(offset) || 0;

        // 目标函数的过滤条件
        const targetConds  = ['t.session_id = ?', 't.fn_name = ?'];
        const targetParams = [id, fnName];
        if (fnIid !== undefined && fnIid !== '') {
            targetConds.push('t.fn_iid = ?');
            targetParams.push(Number(fnIid));
        }

        // 用 CTE 先取出目标函数的所有调用记录，再 JOIN 父帧
        //
        // 父帧条件：
        //   p.session_id = id
        //   p.call_seq  <= t.call_seq      （父帧开始不晚于子帧）
        //   p.return_seq >= t.call_seq     （父帧结束不早于子帧开始）
        //   p.depth      = t.depth - 1    （严格父层深度）
        //
        // 如果 t.depth = 0（顶层调用），无父帧，GROUP BY 时 p.fn_name 为 NULL → 用 '(top-level)' 代替
        //
        // 索引利用：idx_call_edges_stack(session_id, call_seq, return_seq, depth)
        //   对 p.call_seq <= X AND p.return_seq >= X 使用范围扫描

        const rows = db.all(
            `WITH target AS (
               SELECT t.call_seq, t.return_seq, t.depth, t.caller_line
               FROM call_edges t
               WHERE ${targetConds.join(' AND ')}
             )
             SELECT
               COALESCE(p.fn_name, '(top-level)') AS caller_fn_name,
               p.fn_iid                            AS caller_fn_iid,
               COUNT(*)                            AS call_count,
               MIN(t.caller_line)                  AS callee_min_line,
               MIN(p.depth)                        AS caller_min_depth,
               MAX(p.depth)                        AS caller_max_depth,
               MIN(p.caller_line)                  AS caller_min_line
             FROM target t
             LEFT JOIN call_edges p
               ON p.session_id = ?
               AND p.call_seq  <= t.call_seq
               AND p.return_seq >= t.call_seq
               AND p.depth      = t.depth - 1
             GROUP BY p.fn_name, p.fn_iid
             ORDER BY call_count DESC
             LIMIT ? OFFSET ?`,
            ...targetParams, id, limitN, offsetN
        );

        // 总调用次数（目标函数被调用的总次数，用于前端显示百分比）
        // 注：targetConds 使用了 't.' 表别名前缀，这里需要去掉别名前缀后再查询
        const countConds  = ['session_id = ?', 'fn_name = ?'];
        const countParams = [id, fnName];
        if (fnIid !== undefined && fnIid !== '') {
            countConds.push('fn_iid = ?');
            countParams.push(Number(fnIid));
        }
        const totalRow = db.get(
            `SELECT COUNT(*) AS cnt FROM call_edges WHERE ${countConds.join(' AND ')}`,
            ...countParams
        );
        const totalCalls = totalRow?.cnt ?? 0;

        return res.json({
            callers: rows.map(r => ({
                callerFnName:    r.caller_fn_name,
                callerFnIid:     r.caller_fn_iid,
                callCount:       r.call_count,
                calleeMinLine:   r.callee_min_line,
                callerMinDepth:  r.caller_min_depth,
                callerMaxDepth:  r.caller_max_depth,
                callerMinLine:   r.caller_min_line,
            })),
            total:       rows.length,
            totalCalls,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/functions/:fnName/callers] error:');
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
        // 使用 idx_call_edges_depth(session_id, depth, call_seq, return_seq)：
        //   depth 等值过滤（=）+ call_seq 范围（>=）命中索引前缀，比旧的 idx_call_edges_stack 快
        const children = db.all(
            `SELECT call_seq, return_seq FROM call_edges
             WHERE session_id = ?
               AND depth = ?
               AND call_seq  >= ?
               AND call_seq  <= ?
             ORDER BY call_seq ASC`,
            id, depthN + 1, callSeqN, returnSeqN
        );
        // 注：把 return_seq <= returnSeqN 改为 call_seq <= returnSeqN 以充分利用索引，
        // 子调用的 call_seq 必然在父区间内，return_seq 超出的情况不存在（正确 trace）。
        // 若 trace 有损坏数据，下方过滤逻辑会在 JS 侧自然排除 return_seq > returnSeqN 的边。

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

        // 统一策略：SQL 只做基础范围+游标过滤，子调用排除全部在 JS 侧完成。
        // 避免 NOT BETWEEN 链过长触发 SQLite "Expression tree is too large" 错误。
        // 多取倍数是为了应对过滤损耗（子调用越多，损耗越大）；子调用少时损耗接近 0。
        const fetchMultiplier = children.length > 50 ? 5 : children.length > 10 ? 3 : 1;
        const rawEvents = db.all(
            `SELECT e.id AS seq, e.type, e.iid,
                    s.sl AS line, s.sc AS col, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE ${baseConditions.join(' AND ')}
             ORDER BY e.id ASC
             LIMIT ?`,
            ...baseParams, limitN * fetchMultiplier
        );

        // JS 侧排除子调用内部区间（保留 call_seq 和 return_seq 两个边界事件）
        let events;
        if (children.length === 0) {
            events = rawEvents.slice(0, limitN);
        } else {
            // 对子调用区间排序，方便提前 break
            const sortedChildren = children.slice().sort((a, b) => a.call_seq - b.call_seq);
            const filtered = [];
            for (const e of rawEvents) {
                let inInner = false;
                for (const c of sortedChildren) {
                    if (c.call_seq > e.seq) break;          // 后续子调用不可能匹配
                    if (e.seq > c.call_seq && e.seq < c.return_seq) {
                        inInner = true;
                        break;
                    }
                }
                if (!inInner) filtered.push(e);
                if (filtered.length >= limitN) break;
            }
            events = filtered;
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

// ── GET /api/sessions/:id/flamegraph ──────────────────────────────────────
// 基于 call_edges 数据生成火焰图（Speedscope left-heavy 格式）
//
// 查询参数：
//   seqFrom  — 起始 SEQ（call_seq >= seqFrom），用于时间窗口剪裁
//   seqTo    — 结束 SEQ（call_seq <= seqTo）
//   maxDepth — 最大展示深度（默认 50，防止超深递归导致输出过大）
//   minSelf  — 最小 self time（事件数），过滤极短调用
//
// 返回 Speedscope JSON 格式，可直接拖入 https://speedscope.app 显示：
//   { $schema, shared: { frames }, profiles: [ { type:'sampled', ... } ] }
//
// 实现策略：
//   1. 取 [seqFrom, seqTo] 内的所有 call_edges（按 call_seq ASC）
//   2. 在 Node.js 侧用深度优先栈重建调用树，计算每帧的 total/self time
//   3. 拼装 Speedscope sampled profile（events = OPEN/CLOSE 对）

router.get('/flamegraph', (req, res) => {
    try {
        const { id } = req.params;
        const { seqFrom, seqTo, maxDepth = '50', minSelf = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const maxDepthN = Math.min(Number(maxDepth) || 50, 200);
        const minSelfN  = Number(minSelf) || 0;

        // ── Step 1: 从 call_edges 取调用数据 ──────────────────────────────
        const conds  = ['session_id = ?', 'depth <= ?'];
        const cparams = [id, maxDepthN];

        if (seqFrom !== undefined && seqFrom !== '') {
            conds.push('call_seq >= ?');
            cparams.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            conds.push('call_seq <= ?');
            cparams.push(Number(seqTo));
        }

        const edges = db.all(
            `SELECT id, fn_name, fn_iid, caller_line, depth, call_seq, return_seq
             FROM call_edges
             WHERE ${conds.join(' AND ')}
             ORDER BY call_seq ASC, depth ASC`,
            ...cparams
        );

        if (edges.length === 0) {
            return res.json(_emptySpeedscopeProfile(id));
        }

        // ── Step 2: 聚合 frame 表（fn_name → frameIndex）─────────────────
        const frameMap = new Map(); // fn_name+line → index
        const frames   = [];        // Speedscope frames array

        function getFrameIdx(fnName, line) {
            const key = `${fnName}:${line ?? ''}`;
            if (frameMap.has(key)) return frameMap.get(key);
            const idx = frames.length;
            frames.push({ name: fnName || '(anonymous)', line: line ?? 0 });
            frameMap.set(key, idx);
            return idx;
        }

        // ── Step 3: 重建调用树，计算 total / self time ────────────────────
        // 以 call_seq 为时间轴，用栈维护当前路径
        // total_events = return_seq - call_seq + 1
        // self_events  = total_events - sum(child.total_events)

        // 按 (depth ASC, call_seq ASC) 已排好序——先将 edges 按深度建父子关系
        // 简化：直接生成 Speedscope sampled profile 中的 OPEN/CLOSE 事件序列
        // Speedscope evented profile 格式：
        //   { type: 'evented', events: [ {type:'O',frame,at},{type:'C',frame,at} ... ] }

        // 用 call_seq / return_seq 作为"时间戳"（单位：事件数）
        // 只有 self_events >= minSelfN 的帧才输出

        const speeddEvents = []; // Speedscope events
        let profileStartTime = Infinity;
        let profileEndTime   = -Infinity;

        for (const edge of edges) {
            const { fn_name, caller_line, call_seq, return_seq } = edge;
            const total = (return_seq ?? call_seq) - call_seq + 1;
            if (total < 1) continue;

            const fidx = getFrameIdx(fn_name, caller_line);
            speeddEvents.push({ type: 'O', frame: fidx, at: call_seq });
            speeddEvents.push({ type: 'C', frame: fidx, at: (return_seq ?? call_seq) + 1 });

            if (call_seq < profileStartTime) profileStartTime = call_seq;
            if ((return_seq ?? call_seq) + 1 > profileEndTime) profileEndTime = (return_seq ?? call_seq) + 1;
        }

        // 按 at 排序（相同 at 时 OPEN 先于 CLOSE）
        speeddEvents.sort((a, b) => {
            if (a.at !== b.at) return a.at - b.at;
            if (a.type !== b.type) return a.type === 'O' ? -1 : 1;
            return 0;
        });

        if (profileStartTime === Infinity) profileStartTime = 0;
        if (profileEndTime   === -Infinity) profileEndTime   = 0;

        // ── Step 4: 聚合统计（fn_name → {totalCalls, totalEvents}）──────
        const fnStats = new Map();
        for (const edge of edges) {
            const key = edge.fn_name || '(anonymous)';
            const total = (edge.return_seq ?? edge.call_seq) - edge.call_seq + 1;
            if (!fnStats.has(key)) fnStats.set(key, { totalCalls: 0, totalEvents: 0 });
            const s = fnStats.get(key);
            s.totalCalls  += 1;
            s.totalEvents += total;
        }
        const topFunctions = [...fnStats.entries()]
            .sort((a, b) => b[1].totalEvents - a[1].totalEvents)
            .slice(0, 20)
            .map(([name, s]) => ({ name, ...s }));

        // ── Step 5: 拼装 Speedscope JSON ─────────────────────────────────
        const speedscope = {
            $schema:  'https://www.speedscope.app/file-format-schema.json',
            shared:   { frames },
            profiles: [{
                type:      'evented',
                name:      `Session ${id}`,
                unit:      'none',
                startValue: profileStartTime,
                endValue:   profileEndTime,
                events:    speeddEvents,
            }],
            // 额外元数据（不影响 Speedscope 解析）
            _meta: {
                sessionId:    id,
                totalEdges:   edges.length,
                seqFrom:      seqFrom ?? null,
                seqTo:        seqTo ?? null,
                topFunctions,
            },
        };

        res.json(speedscope);
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/flamegraph] error:');
        res.status(500).json({ error: e.message });
    }
});

/** 空 Speedscope profile（无调用数据时返回） */
function _emptySpeedscopeProfile(sessionId) {
    return {
        $schema:  'https://www.speedscope.app/file-format-schema.json',
        shared:   { frames: [] },
        profiles: [{
            type:       'evented',
            name:       `Session ${sessionId}`,
            unit:       'none',
            startValue: 0,
            endValue:   0,
            events:     [],
        }],
        _meta: { sessionId, totalEdges: 0, topFunctions: [] },
    };
}

export default router;
