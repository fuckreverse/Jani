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

// ── 共享工具：直接子调用列表 + 区间判断 ──────────────────────────────────────
//
// 多个接口（own-events / annotated-source / fn-cfg 等）都需要"排除子调用内部事件"，
// 统一封装在此，避免重复实现。
//
// queryDirectChildren(sessionId, depth, callSeq, returnSeq) → [{call_seq, return_seq}]（按 call_seq 升序）
//   利用 idx_call_edges_depth 索引：depth 等值 + call_seq 范围，O(子调用数)
//
// makeIsInsideChild(sortedChildren) → (seq: number) => boolean
//   子调用已按 call_seq 升序排列，扫描时可提前 break，O(children)
//   子调用的 CALL_PRE(=call_seq) 和 CALL(=return_seq) 边界本身不在"内部"，保留

function queryDirectChildren(sessionId, depth, callSeq, returnSeq) {
    return db.all(
        `SELECT call_seq, return_seq FROM call_edges
         WHERE session_id = ?
           AND depth = ?
           AND call_seq >= ?
           AND call_seq <= ?
         ORDER BY call_seq ASC`,
        sessionId, depth + 1, callSeq, returnSeq
    );
}

function makeIsInsideChild(sortedChildren) {
    if (sortedChildren.length === 0) return () => false;
    return function isInsideChild(seq) {
        for (const c of sortedChildren) {
            if (c.call_seq >= seq) break;   // 剩余子调用起点 >= seq，不可能包含 seq
            if (seq < c.return_seq) return true;  // c.call_seq < seq < c.return_seq → 内部
        }
        return false;
    };
}

// ── GET /api/sessions/:id/functions ──────────────────────────────────────
// 按 fn_name 聚合 call_edges，返回函数列表（调用次数、行号等）
//
// 新增过滤参数：
//   minEvents   / maxEvents  — 按函数体自身事件数均值（avg_own_event_count，即每次调用自身事件数均值）过滤
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
            fnDefIid,           // 函数定义点 iid 精确过滤（同一函数体每次调用相同）
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
        // fnDefIid 精确过滤：按函数定义点 iid 唯一定位函数体
        if (fnDefIid !== undefined && fnDefIid !== '') {
            conditions.push('fn_def_iid = ?');
            params.push(Number(fnDefIid));
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

        // HAVING 子句：call_count + 可选的 own_event_count 范围（按均值过滤，与前端"事件/次"语义一致）
        const ownExpr    = `SUM(COALESCE(own_event_count, COALESCE(return_seq,call_seq) - call_seq))`;
        const avgOwnExpr = `CAST(ROUND(1.0 * ${ownExpr} / COUNT(*)) AS INTEGER)`;
        const havingClauses = [`COUNT(*) >= ?`];
        const havingParams  = [minCallsN];
        if (minEventsN !== null) {
            // 过滤条件：每次调用均值 >= minEvents
            havingClauses.push(`${avgOwnExpr} >= ?`);
            havingParams.push(minEventsN);
        }
        if (maxEventsN !== null) {
            // 过滤条件：每次调用均值 <= maxEvents
            havingClauses.push(`${avgOwnExpr} <= ?`);
            havingParams.push(maxEventsN);
        }

        const orderExpr = sortBy === 'event_count'
            ? `${avgOwnExpr} DESC`
            : `call_count DESC`;
        const rows = db.all(
            `SELECT
                fn_name,
                fn_iid,
                fn_def_iid,
                COUNT(*)         AS call_count,
                ${ownExpr}       AS event_count,
                ${avgOwnExpr}    AS avg_own_event_count,
                MIN(caller_line) AS min_line,
                MIN(depth)       AS min_depth,
                MAX(depth)       AS max_depth
             FROM call_edges
             WHERE ${conditions.join(' AND ')}
             GROUP BY fn_name, fn_def_iid
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
               GROUP BY fn_name, fn_def_iid
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

        // ── Step 1: 计算"自身区间"段列表 ─────────────────────────────────────
        // 取直接子调用列表（已按 call_seq ASC 排序），然后用区间减法得到若干段连续"自身区间"。
        // 每段区间 [lo, hi] 内的事件全部是本函数自身的（子调用 CALL_PRE/CALL 边界保留）。
        // 这样后续 SQL 分段走主键范围扫描，完全精确，不需要 fetchMultiplier 猜测。
        const children = queryDirectChildren(id, depthN, callSeqN, returnSeqN);

        // computeOwnRanges：[frameStart, frameEnd] 减去子调用区间 [child.call_seq+1, child.return_seq-1]
        // 保留子调用边界本身（CALL_PRE @ call_seq、CALL @ return_seq 均属于本函数）
        // 等价：把 [callSeqN, returnSeqN] 按子调用切成若干段
        //   段 1: [callSeqN,           child[0].call_seq]
        //   段 2: [child[0].return_seq, child[1].call_seq]
        //   ...
        //   末段: [child[-1].return_seq, returnSeqN]
        const ownRanges = [];  // [{lo, hi}]，均为 inclusive
        {
            let cur = callSeqN;
            for (const c of children) {
                if (c.call_seq >= cur) {
                    ownRanges.push({ lo: cur, hi: c.call_seq });  // 含子调用的 CALL_PRE
                }
                cur = c.return_seq;  // 下一段从子调用的 CALL 开始（含 CALL）
            }
            ownRanges.push({ lo: cur, hi: returnSeqN });
        }

        // ── Step 2: 游标定位到起始段 ─────────────────────────────────────────
        // cursor 为上次返回的最后 event SEQ，下次从 > cursor 开始扫描
        const cursorN = (cursor !== undefined && cursor !== '') ? Number(cursor) : callSeqN - 1;

        // 找第一个包含 cursorN+1 的段（lo <= cursor+1 的最后一段，取 hi > cursorN 的第一段）
        let startRangeIdx = 0;
        for (let i = 0; i < ownRanges.length; i++) {
            if (ownRanges[i].hi > cursorN) { startRangeIdx = i; break; }
            startRangeIdx = i + 1;
        }

        // ── Step 3: 分段扫描，凑满 limitN 条事件 ────────────────────────────
        // 每段用主键范围查询 WHERE e.id >= lo AND e.id <= hi，精确走 PK B-tree
        // 完全不需要 fetchMultiplier，也不会漏事件
        const rawStmt = db.raw().prepare(
            `SELECT id AS seq, type, iid FROM events
             WHERE session_id = ? AND id >= ? AND id <= ?
             ORDER BY id ASC LIMIT ?`
        );

        const eventRows = [];
        for (let i = startRangeIdx; i < ownRanges.length && eventRows.length < limitN; i++) {
            const { lo, hi } = ownRanges[i];
            const loEff = i === startRangeIdx ? Math.max(lo, cursorN + 1) : lo;
            if (loEff > hi) continue;
            const remaining = limitN - eventRows.length;
            const rows = rawStmt.all(id, loEff, hi, remaining);
            for (const r of rows) eventRows.push(r);
        }

        // ── Step 4: 批量查 smap（按 iid 点查主键，不 JOIN 主查询）─────────────
        // 先收集唯一 iid 集合，再逐个走 smap(session_id, iid) PK 点查
        const iidSmapCache = new Map();
        const smapPointStmt = db.raw().prepare(
            'SELECT sl, sc, src_text FROM smap WHERE session_id = ? AND iid = ?'
        );
        for (const e of eventRows) {
            if (e.iid != null && !iidSmapCache.has(e.iid)) {
                const s = smapPointStmt.get(id, e.iid);
                iidSmapCache.set(e.iid, s ?? null);
            }
        }

        // ── Step 5: 批量查 writes/reads/fields ───────────────────────────────
        // eventRows 数量 <= limitN（最多 500）；用 event.id 主键范围 + JOIN 方式
        // 复用与 annotated-source 相同的"以 events PK 范围驱动"策略：
        // 对每段 ownRange 分别查，再合并（段数通常 = 子调用数 + 1，通常个位数）
        const writesMap = new Map();  // event_id → [{name, value, omitted}]
        const readsMap  = new Map();
        const fieldsMap = new Map();

        const wStmt = db.raw().prepare(
            `SELECT w.event_id, w.name, vd.val_text AS value, w.omitted
             FROM events e
             JOIN writes w ON w.session_id = e.session_id AND w.event_id = e.id
             LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
             WHERE e.session_id = ? AND e.id >= ? AND e.id <= ?`
        );
        const rStmt = db.raw().prepare(
            `SELECT r.event_id, r.name, vd.val_text AS value, r.omitted
             FROM events e
             JOIN reads r ON r.session_id = e.session_id AND r.event_id = e.id
             LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
             WHERE e.session_id = ? AND e.id >= ? AND e.id <= ?`
        );
        const fStmt = db.raw().prepare(
            `SELECT f.event_id, f.offset, f.is_write, vd.val_text AS value, f.omitted, f.base_oid
             FROM events e
             JOIN fields f ON f.session_id = e.session_id AND f.event_id = e.id
             LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
             WHERE e.session_id = ? AND e.id >= ? AND e.id <= ?`
        );

        // 只扫描实际有事件的段（起始段到最后一条事件所在段）
        const lastSeq = eventRows.length > 0 ? eventRows[eventRows.length - 1].seq : cursorN;
        for (let i = startRangeIdx; i < ownRanges.length; i++) {
            const { lo, hi } = ownRanges[i];
            const loEff = i === startRangeIdx ? Math.max(lo, cursorN + 1) : lo;
            const hiEff = Math.min(hi, lastSeq);
            if (loEff > hiEff) continue;

            for (const w of wStmt.all(id, loEff, hiEff)) {
                if (!writesMap.has(w.event_id)) writesMap.set(w.event_id, []);
                writesMap.get(w.event_id).push(w);
            }
            for (const r of rStmt.all(id, loEff, hiEff)) {
                if (!readsMap.has(r.event_id)) readsMap.set(r.event_id, []);
                readsMap.get(r.event_id).push(r);
            }
            for (const f of fStmt.all(id, loEff, hiEff)) {
                if (!fieldsMap.has(f.event_id)) fieldsMap.set(f.event_id, []);
                fieldsMap.get(f.event_id).push(f);
            }
            if (hiEff >= lastSeq) break;  // 已覆盖所有事件，提前退出
        }

        const result = eventRows.map(e => {
            const s = e.iid != null ? iidSmapCache.get(e.iid) : null;
            return {
                seq:     e.seq,
                type:    decodeType(e.type),
                iid:     e.iid,
                line:    s?.sl  ?? null,
                col:     s?.sc  ?? null,
                srcText: s?.src_text ?? null,
                writes:  (writesMap.get(e.seq) || []).map(w => ({ name: w.name, value: safeParseJson(w.value), omitted: !!w.omitted })),
                reads:   (readsMap.get(e.seq)  || []).map(r => ({ name: r.name, value: safeParseJson(r.value), omitted: !!r.omitted })),
                fields:  (fieldsMap.get(e.seq) || []).map(f => ({ offset: f.offset, isWrite: !!f.is_write, value: safeParseJson(f.value), omitted: !!f.omitted, baseOid: f.base_oid ?? null })),
            };
        });

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

// ── GET /api/sessions/:id/calls/:callId/annotated-source ──────────────────
// 返回某次调用的函数源码，并附加本次调用内的动态执行数据：
//   - 每行的执行次数（本次调用 SEQ 区间内 GROUP BY iid）
//   - 每行读写的变量值（去重后最多 MAX_VALS_PER_LINE 个）
//   - 函数签名推断（来自 fn_signatures，若有）
//
// 实现步骤：
//   1. 从 call_edges 取 call_seq / return_seq
//   2. 扫描 (call_seq, return_seq) 开区间内所有事件，用实际出现的 iid 集合确定函数体
//      （CALL_PRE/CALL 边界事件本身不属于函数体，用开区间排除）
//   3. 用这些 iid JOIN smap 取每行的 sl / src_text
//   4. 统计各 iid 在该区间的执行次数（GROUP BY iid）
//   5. 按行号聚合 reads/writes，每行最多取 MAX_VALS_PER_LINE 个不重复值
//   6. 按行号组装 lines[] 返回

const MAX_VALS_PER_LINE = 6;

router.get('/calls/:callId/annotated-source', (req, res) => {
    try {
        const { id, callId } = req.params;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const call = db.get(
            'SELECT fn_name, fn_iid, call_seq, return_seq, depth FROM call_edges WHERE id = ? AND session_id = ?',
            Number(callId), id
        );
        if (!call) return res.status(404).json({ error: `Call ${callId} not found` });

        const { fn_name: fnName, fn_iid: fnEntryIid, call_seq: callSeq, return_seq: returnSeq, depth: callDepth } = call;

        if (returnSeq == null) {
            return res.json({ fnName, startLine: null, lines: [], signature: null, error: 'no_return_seq' });
        }

        // ── Step 1: 取函数"自身"事件的 iid 集合（排除子调用内部） ──────────
        //
        // 事件序列示意：
        //   [call_seq=CALL_PRE] ... [子CALL_PRE] [子内部...] [子CALL] ... [return_seq=CALL]
        //   call_seq  = CALL_PRE 事件 id；return_seq = CALL 事件 id
        //   本函数自身事件 = 开区间 (call_seq, return_seq) 中，
        //     不属于任何直接子调用内部 (child.call_seq, child.return_seq) 的事件
        //   子调用的 CALL_PRE/CALL 边界本身（本函数发出的调用动作）保留。
        //
        // 策略：复用 queryDirectChildren + makeIsInsideChild，
        //   先取区间内所有 iid+seq，JS 侧过滤，再 JOIN smap 取行号信息。
        //   与 own-events 接口保持一致，避免 NOT EXISTS 逐行子查询。

        const childCalls = queryDirectChildren(id, callDepth, callSeq, returnSeq);
        const isInsideChild = makeIsInsideChild(childCalls);

        // 取区间内所有 (seq, iid)，JS 侧过滤掉子调用内部的 seq
        const rawSeqRows = db.all(
            `SELECT id AS seq, iid FROM events
             WHERE session_id = ?
               AND id > ?
               AND id < ?
               AND iid IS NOT NULL
             ORDER BY id ASC`,
            id, callSeq, returnSeq
        );

        // 过滤后收集"自身层"出现过的 iid 集合
        const ownIidSet = new Set();
        for (const r of rawSeqRows) {
            if (!isInsideChild(r.seq)) ownIidSet.add(r.iid);
        }

        // 用 ownIidSet 逐个点查 smap 主键（session_id, iid）
        // smap 主键是 (session_id, iid)，单点查询 O(log N)
        // ownIidSet 大小 = 本函数自身层去重 iid 数，通常几十到几百个，远比全表扫描快
        const smapRows = [];
        const smapStmt = db.raw().prepare(
            'SELECT iid, sl, sc, src_text FROM smap WHERE session_id = ? AND iid = ? AND sl IS NOT NULL'
        );
        for (const iid of ownIidSet) {
            const row = smapStmt.get(id, iid);
            if (row) smapRows.push(row);
        }
        smapRows.sort((a, b) => a.sl - b.sl || a.sc - b.sc);

        if (smapRows.length === 0) {
            // 区分两种情况：
            // 1. 未插桩函数：开区间 (call_seq, return_seq) 内根本没有事件
            //    → return_seq - call_seq <= 1，开区间为空
            // 2. 有事件但 iid 没有对应 smap 条目（smap 未加载）
            const hasEventsInBody = db.get(
                `SELECT 1 FROM events WHERE session_id = ? AND id > ? AND id < ? LIMIT 1`,
                id, callSeq, returnSeq
            );

            if (!hasEventsInBody) {
                // 未插桩：尝试用调用点 iid 给出调用位置信息
                const callSiteSmap = fnEntryIid
                    ? db.get('SELECT sl, sc, src_text FROM smap WHERE session_id = ? AND iid = ?', id, fnEntryIid)
                    : null;
                return res.json({
                    fnName,
                    startLine: null,
                    lines: [],
                    signature: null,
                    error: 'not_instrumented',
                    callSite: callSiteSmap
                        ? { line: callSiteSmap.sl, col: callSiteSmap.sc, srcText: callSiteSmap.src_text }
                        : null,
                });
            }

            // 有事件但 smap 缺失
            return res.json({ fnName, startLine: null, lines: [], signature: null, error: 'no_smap' });
        }

        // iid → smap 快速查找
        const iidToSmap = new Map();
        for (const r of smapRows) iidToSmap.set(r.iid, r);

        // ── Step 2: 本次调用内各 iid 执行次数 ────────────────────────────
        // 直接按 SEQ 区间扫描，无需 IN 列表；在 JS 层用 iidToSmap 过滤
        const execCountMap = new Map(); // iid → count
        {
            const rows = db.all(
                `SELECT iid, COUNT(*) AS cnt
                 FROM events
                 WHERE session_id = ?
                   AND id > ?
                   AND id < ?
                 GROUP BY iid`,
                id, callSeq, returnSeq
            );
            for (const r of rows) {
                if (iidToSmap.has(r.iid)) execCountMap.set(r.iid, r.cnt);
            }
        }

        // ── Step 3: 本次调用内的 writes / reads（按行号聚合，限值数量） ──
        // 用 SEQ 区间子查询关联 writes/reads，完全避免 IN 列表
        // line → { reads: Map<name, Set<val>>, writes: Map<name, Set<val>> }
        const lineDataMap = new Map();

        function getLineData(line) {
            if (!lineDataMap.has(line)) {
                lineDataMap.set(line, { reads: new Map(), writes: new Map() });
            }
            return lineDataMap.get(line);
        }

        function addVal(mapOfSets, name, val) {
            if (!mapOfSets.has(name)) mapOfSets.set(name, new Set());
            const s = mapOfSets.get(name);
            if (s.size < MAX_VALS_PER_LINE) s.add(val);
        }

        {
            // 以 events 主键范围为驱动（走 PK 范围扫描），再 JOIN writes/reads
            // idx_writes_event(session_id, event_id) / idx_reads_event(session_id, event_id)
            // 在 JS 层用 iidToSmap 过滤掉子调用的事件（iidToSmap 只含本函数自身 iid）
            const writes = db.all(
                `SELECT e.iid, w.name, vd.val_text AS value, w.omitted
                 FROM events e
                 JOIN writes w ON w.session_id = e.session_id AND w.event_id = e.id
                 LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
                 WHERE e.session_id = ?
                   AND e.id > ?
                   AND e.id < ?`,
                id, callSeq, returnSeq
            );
            for (const w of writes) {
                const smap = iidToSmap.get(w.iid);
                const line = smap?.sl ?? null;
                if (line == null || w.omitted) continue;
                addVal(getLineData(line).writes, w.name, w.value);
            }

            const reads = db.all(
                `SELECT e.iid, r.name, vd.val_text AS value, r.omitted
                 FROM events e
                 JOIN reads r ON r.session_id = e.session_id AND r.event_id = e.id
                 LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
                 WHERE e.session_id = ?
                   AND e.id > ?
                   AND e.id < ?`,
                id, callSeq, returnSeq
            );
            for (const r of reads) {
                const smap = iidToSmap.get(r.iid);
                const line = smap?.sl ?? null;
                if (line == null || r.omitted) continue;
                addVal(getLineData(line).reads, r.name, r.value);
            }
        }

        // ── Step 4: 按行号组装 lines[] ────────────────────────────────────
        // 同一行可能有多个 iid（表达式粒度），取执行次数最大的那个（代表该行被执行了几次）
        // 先建 line → maxExecCount 映射
        const lineExecCountMap = new Map(); // line → maxExecCount
        for (const [iid, smapRow] of iidToSmap) {
            const line = smapRow.sl;
            if (line == null) continue;
            const cnt = execCountMap.get(iid) ?? 0;
            if (!lineExecCountMap.has(line) || cnt > lineExecCountMap.get(line)) {
                lineExecCountMap.set(line, cnt);
            }
        }

        // 收集所有唯一的行，取每行「行首 iid」的 src_text（sc 最小的那个 iid）
        const lineSmapMap = new Map(); // line → smap row（行首 iid）
        for (const [, smapRow] of iidToSmap) {
            const line = smapRow.sl;
            if (line == null) continue;
            if (!lineSmapMap.has(line) || smapRow.sc < lineSmapMap.get(line).sc) {
                lineSmapMap.set(line, smapRow);
            }
        }

        const sortedLines = [...lineSmapMap.keys()].sort((a, b) => a - b);
        const startLine   = sortedLines[0] ?? null;

        const lines = sortedLines.map(line => {
            const smapRow   = lineSmapMap.get(line);
            const execCount = lineExecCountMap.get(line) ?? 0;
            const ld        = lineDataMap.get(line);

            const reads = ld
                ? [...ld.reads.entries()].map(([name, vals]) => ({
                    name,
                    values: [...vals].map(v => { try { return JSON.parse(v); } catch { return v; } }),
                }))
                : [];
            const writes = ld
                ? [...ld.writes.entries()].map(([name, vals]) => ({
                    name,
                    values: [...vals].map(v => { try { return JSON.parse(v); } catch { return v; } }),
                }))
                : [];

            return {
                line,
                srcText:   smapRow?.src_text ?? null,
                execCount,
                reads,
                writes,
            };
        });

        // ── Step 5: 函数签名（可选，来自 fn_signatures） ─────────────────
        let signature = null;
        if (fnName) {
            const sigRow = db.get(
                `SELECT arg_types, return_types, call_count, is_pure, sample_args, sample_return
                 FROM fn_signatures
                 WHERE session_id = ? AND fn_name = ?
                 LIMIT 1`,
                id, fnName
            );
            if (sigRow) {
                signature = {
                    callCount:    sigRow.call_count,
                    isPure:       !!sigRow.is_pure,
                    argTypes:     safeParseJson(sigRow.arg_types, []),
                    returnTypes:  safeParseJson(sigRow.return_types, []),
                    sampleArgs:   safeParseJson(sigRow.sample_args, []),
                    sampleReturn: safeParseJson(sigRow.sample_return, null),
                };
            }
        }

        return res.json({
            fnName,
            fnIid: fnEntryIid,
            startLine,
            callSeq,
            returnSeq,
            lines,
            signature,
        });

    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/calls/:callId/annotated-source] error:');
        return res.status(500).json({ error: e.message });
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
