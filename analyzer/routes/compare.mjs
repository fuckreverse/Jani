/**
 * routes/compare.mjs — 多 Trace 对照分析 API（性能优化版）
 *
 * POST /api/compare/sessions      对比多个 Session 的整体指标
 * POST /api/compare/functions     对比多个 Session 的函数调用分布
 * POST /api/compare/hot-iids      对比多个 Session 的热点 IID
 * POST /api/compare/events        对比多个 Session 的事件类型分布
 * POST /api/compare/loops         对比多个 Session 的循环执行情况
 *
 * 性能原则：
 *   - 所有 N sessions 的数据尽量用 IN 子句一次查询，不串行 for 循环
 *   - 使用 GROUP BY session_id 将多 session 聚合合并成单次 SQL
 *   - 动态 IN 列表 SQL 通过拼接来构建（LRU 对此不友好，但避免了 N 次往返）
 *   - builtin 过滤改用临时 WHERE NOT IN（固定短列表，只拼一次）
 *   - 尽量只读聚合表（iid_counts / call_edges / loops），不扫全量 events
 */

import { Router } from 'express';
import { createLogger } from '../logger.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

const log = createLogger('compare');
const router = Router();

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_SESSIONS = cfg('compare.maxSessions');

// 内建函数黑名单（固定列表，SQL 一次拼好不重复）
const BUILTIN_SET = new Set([
    'push','pop','shift','unshift','splice','slice','indexOf','lastIndexOf',
    'includes','find','findIndex','filter','map','reduce','reduceRight',
    'forEach','some','every','sort','reverse','join','concat','flat','flatMap',
    'fill','copyWithin','at','keys','values','entries',
    'charAt','charCodeAt','charCodePointAt','codePointAt','endsWith','startsWith',
    'match','matchAll','normalize','padEnd','padStart','repeat','replace',
    'replaceAll','search','split','substring','toLowerCase','toUpperCase',
    'trim','trimEnd','trimStart',
    'parseInt','parseFloat','isNaN','isFinite',
    'Number','String','Boolean','Math','Date','JSON',
    'Object','Array','Promise','Set','Map','WeakMap','WeakSet',
    'toString','valueOf','hasOwnProperty','isPrototypeOf',
    'apply','bind','call','constructor',
]);
// 预拼好 SQL 片段（固定，LRU 能缓存）
const BUILTIN_NOT_IN_SQL = ` AND fn_name NOT IN (${[...BUILTIN_SET].map(() => '?').join(',')})`;
const BUILTIN_PARAMS      = [...BUILTIN_SET];

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function validateSessionIds(sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length < 2) {
        return '至少需要 2 个 Session 进行对比';
    }
    if (sessionIds.length > MAX_SESSIONS) {
        return `最多支持 ${MAX_SESSIONS} 个 Session 同时对比`;
    }
    if (!sessionIds.every(id => typeof id === 'string' && id.length > 0)) {
        return 'sessionIds 必须是非空字符串数组';
    }
    return null;
}

/** 生成 IN 占位符（如 ?,?,? ） */
function placeholders(n) {
    return Array(n).fill('?').join(',');
}

/**
 * 批量校验 sessions 是否全部存在，同时返回名称映射
 * 单次 IN 查询，而不是 N 次 WHERE id=?
 */
function checkAndFetchSessions(sessionIds) {
    const ph = placeholders(sessionIds.length);
    const rows = db.all(
        `SELECT id, name, created_at, event_count, status FROM sessions WHERE id IN (${ph})`,
        ...sessionIds
    );
    if (rows.length < sessionIds.length) {
        const found = new Set(rows.map(r => r.id));
        const missing = sessionIds.find(id => !found.has(id));
        return { error: `Session ${missing} 不存在` };
    }
    // 保持原始顺序
    const map = new Map(rows.map(r => [r.id, r]));
    return { sessions: sessionIds.map(id => map.get(id)) };
}

// ── POST /api/compare/sessions ───────────────────────────────────────────────
// 核心优化：
//   - sessions 基础信息：单次 IN 查询（1次）
//   - 事件类型分布：单次 IN + GROUP BY session_id（1次，不是 N 次）
//   - 函数统计：单次 IN + GROUP BY session_id（1次）
//   - 热点 IID：ROW_NUMBER() 窗口函数取每 session Top-5（1次）
//   - 循环统计：单次 IN + GROUP BY session_id（1次）
//   - 最大深度：单次 IN + GROUP BY session_id（1次）
//   合计：6次查询（原来是 6N 次）

router.post('/sessions', (req, res) => {
    try {
        const { sessionIds } = req.body;
        const err = validateSessionIds(sessionIds);
        if (err) return res.status(400).json({ error: err });

        const { error, sessions } = checkAndFetchSessions(sessionIds);
        if (error) return res.status(404).json({ error });

        const ph = placeholders(sessionIds.length);

        // ── 1. 事件类型分布（全部 session 一次 GROUP BY）
        const typeDistRows = db.all(
            `SELECT session_id, type, COUNT(*) AS cnt
             FROM events WHERE session_id IN (${ph})
             GROUP BY session_id, type`,
            ...sessionIds
        );
        // 按 session_id 分组到 Map
        const typeDistMap = new Map(); // session_id → {type → cnt}
        for (const r of typeDistRows) {
            let m = typeDistMap.get(r.session_id);
            if (!m) { m = {}; typeDistMap.set(r.session_id, m); }
            m[r.type] = r.cnt;
        }

        // ── 2. 函数统计（COUNT DISTINCT fn_name + COUNT(*) per session）
        const fnStatRows = db.all(
            `SELECT session_id,
                    COUNT(DISTINCT fn_name) AS fn_count,
                    COUNT(*) AS call_count
             FROM call_edges WHERE session_id IN (${ph})
             GROUP BY session_id`,
            ...sessionIds
        );
        const fnStatMap = new Map(fnStatRows.map(r => [r.session_id, r]));

        // ── 3. Top-5 热点 IID（ROW_NUMBER 窗口函数，SQLite 3.25+）
        const _topHotIids = cfg('compare.topHotIidsPerSession');
        const hotIidRows = db.all(
            `SELECT session_id, iid, count, line, src_text
             FROM (
               SELECT session_id, iid, count, line, src_text,
                      ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY count DESC) AS rn
               FROM iid_counts
               WHERE session_id IN (${ph})
             ) WHERE rn <= ${_topHotIids}`,
            ...sessionIds
        );
        const hotIidMap = new Map(); // session_id → [{iid,count,line,src_text}]
        for (const r of hotIidRows) {
            let arr = hotIidMap.get(r.session_id);
            if (!arr) { arr = []; hotIidMap.set(r.session_id, arr); }
            arr.push({ iid: r.iid, count: r.count, line: r.line, src_text: r.src_text });
        }

        // ── 4. 循环统计
        const loopStatRows = db.all(
            `SELECT session_id,
                    COUNT(*) AS loop_count,
                    SUM(iteration_count) AS total_iters
             FROM loops WHERE session_id IN (${ph})
             GROUP BY session_id`,
            ...sessionIds
        );
        const loopStatMap = new Map(loopStatRows.map(r => [r.session_id, r]));

        // ── 5. 最大调用深度
        const depthRows = db.all(
            `SELECT session_id, MAX(depth) AS max_depth
             FROM call_edges WHERE session_id IN (${ph})
             GROUP BY session_id`,
            ...sessionIds
        );
        const depthMap = new Map(depthRows.map(r => [r.session_id, r.max_depth]));

        // ── 组装结果
        const results = sessions.map(s => ({
            sessionId:  s.id,
            name:       s.name,
            createdAt:  s.created_at,
            eventCount: s.event_count,
            typeDist:   typeDistMap.get(s.id) ?? {},
            fnCount:    fnStatMap.get(s.id)?.fn_count  ?? 0,
            callCount:  fnStatMap.get(s.id)?.call_count ?? 0,
            loopCount:  loopStatMap.get(s.id)?.loop_count  ?? 0,
            totalIters: loopStatMap.get(s.id)?.total_iters ?? 0,
            maxDepth:   depthMap.get(s.id) ?? 0,
            hotIids:    hotIidMap.get(s.id) ?? [],
        }));

        // ── 分歧分析（纯 JS 计算，O(N × |types|)）
        const baseline = results[0];
        const divergence = results.slice(1).map(r => {
            const allTypes = new Set([
                ...Object.keys(baseline.typeDist),
                ...Object.keys(r.typeDist),
            ]);
            const typeDelta = {};
            for (const t of allTypes) {
                const base = baseline.typeDist[t] ?? 0;
                const curr = r.typeDist[t]        ?? 0;
                if (base !== curr) {
                    typeDelta[t] = {
                        base, curr,
                        delta: curr - base,
                        pct:   base > 0 ? ((curr - base) / base * 100).toFixed(1) : null,
                    };
                }
            }
            return {
                sessionId:  r.sessionId,
                name:       r.name,
                deltaEvents: r.eventCount - baseline.eventCount,
                deltaFns:    r.fnCount    - baseline.fnCount,
                deltaCalls:  r.callCount  - baseline.callCount,
                typeDelta,
                deltaLoops: r.loopCount  - baseline.loopCount,
                deltaIters: r.totalIters - baseline.totalIters,
                deltaDepth: r.maxDepth   - baseline.maxDepth,
            };
        });

        res.json({ sessions: results, divergence });
    } catch (e) {
        log.error({ err: e }, '[POST /api/compare/sessions] error');
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/compare/functions ──────────────────────────────────────────────
// 核心优化：
//   - 所有 session 函数聚合：单次 IN + GROUP BY session_id, fn_name, fn_iid
//   - hideBuiltin：预拼 NOT IN SQL，LRU 可缓存（不再是动态字符串）
//   - sessionNames：已从 checkAndFetchSessions 拿到，不再额外 N 次查询

router.post('/functions', (req, res) => {
    try {
        const { sessionIds, limit, hideBuiltin = false } = req.body;
        const err = validateSessionIds(sessionIds);
        if (err) return res.status(400).json({ error: err });

        const { error, sessions } = checkAndFetchSessions(sessionIds);
        if (error) return res.status(404).json({ error });

        const _fnDefaultLimit = cfg('compare.functionsDefaultLimit');
        const _fnMaxLimit     = cfg('compare.functionsMaxLimit');
        const limitN = Math.min(Number(limit) || _fnDefaultLimit, _fnMaxLimit);
        const ph     = placeholders(sessionIds.length);

        // 单次查询：所有 session 的函数聚合
        // hideBuiltin 时追加固定 NOT IN（预编译 SQL，LRU 友好）
        const builtinClause = hideBuiltin ? BUILTIN_NOT_IN_SQL : '';
        const builtinParams  = hideBuiltin ? BUILTIN_PARAMS : [];

        const rawRows = db.all(
            `SELECT session_id, fn_name, fn_iid,
                    COUNT(*) AS call_count,
                    SUM(COALESCE(own_event_count,
                        COALESCE(return_seq, call_seq) - call_seq)) AS event_count,
                    MIN(caller_line) AS min_line
             FROM call_edges
             WHERE session_id IN (${ph})${builtinClause}
             GROUP BY session_id, fn_name, fn_iid
             ORDER BY session_id, call_count DESC`,
            ...sessionIds, ...builtinParams
        );

        // 按 session_id 分组，每 session 取 Top-limitN 函数
        const sessionFns = new Map(); // session_id → Map<fn_name, {...}>
        const perSessionCount = new Map();

        for (const r of rawRows) {
            let fnMap = sessionFns.get(r.session_id);
            if (!fnMap) { fnMap = new Map(); sessionFns.set(r.session_id, fnMap); }

            // 每 session 最多 limitN 个
            const cnt = perSessionCount.get(r.session_id) ?? 0;
            if (cnt >= limitN) continue;
            perSessionCount.set(r.session_id, cnt + 1);

            fnMap.set(r.fn_name, {
                fnIid:      r.fn_iid,
                callCount:  r.call_count,
                eventCount: r.event_count ?? 0,
                minLine:    r.min_line,
            });
        }

        // 合并所有函数名
        const allFnNames = new Set();
        for (const fnMap of sessionFns.values()) {
            for (const name of fnMap.keys()) allFnNames.add(name);
        }

        // 构建对比矩阵
        const baseMap = sessionFns.get(sessionIds[0]) ?? new Map();
        const matrix  = [];

        for (const fnName of allFnNames) {
            const baseEntry = baseMap.get(fnName);
            const baseCnt   = baseEntry?.callCount ?? 0;
            const row = {
                fnName,
                sessions:    {},
                isDivergent: false,
                maxDeltaPct: 0,
            };

            for (const sid of sessionIds) {
                const entry = sessionFns.get(sid)?.get(fnName) ?? null;
                row.sessions[sid] = entry
                    ? { callCount: entry.callCount, eventCount: entry.eventCount, minLine: entry.minLine }
                    : null;
            }

            for (let i = 1; i < sessionIds.length; i++) {
                const currCnt = row.sessions[sessionIds[i]]?.callCount ?? 0;
                if (baseCnt !== currCnt) {
                    row.isDivergent = true;
                    const deltaPct = baseCnt > 0
                        ? Math.abs((currCnt - baseCnt) / baseCnt * 100)
                        : (currCnt > 0 ? 100 : 0);
                    if (deltaPct > row.maxDeltaPct) row.maxDeltaPct = deltaPct;
                }
            }

            matrix.push(row);
        }

        // 排序：分歧优先，次按 baseline 调用次数
        matrix.sort((a, b) => {
            if (a.isDivergent !== b.isDivergent) return a.isDivergent ? -1 : 1;
            return (b.sessions[sessionIds[0]]?.callCount ?? 0) -
                   (a.sessions[sessionIds[0]]?.callCount ?? 0);
        });

        res.json({
            sessionIds,
            sessionNames:  sessions.map(s => s.name),
            functions:     matrix,
            totalFns:      matrix.length,
            divergentFns:  matrix.filter(r => r.isDivergent).length,
        });
    } catch (e) {
        log.error({ err: e }, '[POST /api/compare/functions] error');
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/compare/hot-iids ───────────────────────────────────────────────
// 核心优化：单次 IN + ROW_NUMBER() 窗口函数，代替 N 次 LIMIT 查询

router.post('/hot-iids', (req, res) => {
    try {
        const { sessionIds, topN } = req.body;
        const err = validateSessionIds(sessionIds);
        if (err) return res.status(400).json({ error: err });

        const { error, sessions } = checkAndFetchSessions(sessionIds);
        if (error) return res.status(404).json({ error });

        const _topNDefault = cfg('compare.hotIidsDefaultTopN');
        const _topNMax     = cfg('compare.hotIidsMaxTopN');
        const topNN = Math.min(Number(topN) || _topNDefault, _topNMax);
        const ph    = placeholders(sessionIds.length);

        // 单次 ROW_NUMBER 窗口查询（SQLite 3.25+）
        const rows = db.all(
            `SELECT session_id, iid, count, line, src_text
             FROM (
               SELECT session_id, iid, count, line, src_text,
                      ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY count DESC) AS rn
               FROM iid_counts
               WHERE session_id IN (${ph})
             ) WHERE rn <= ?`,
            ...sessionIds, topNN
        );

        // 按 session_id 分组
        const sessionIids = new Map(); // session_id → Map<iid, {count,line,srcText}>
        for (const r of rows) {
            let iidMap = sessionIids.get(r.session_id);
            if (!iidMap) { iidMap = new Map(); sessionIids.set(r.session_id, iidMap); }
            iidMap.set(r.iid, { count: r.count, line: r.line, srcText: r.src_text });
        }

        // 合并所有 IID
        const allIids = new Set();
        for (const iidMap of sessionIids.values()) {
            for (const iid of iidMap.keys()) allIids.add(iid);
        }

        const baseMap = sessionIids.get(sessionIds[0]) ?? new Map();
        const matrix  = [];

        for (const iid of allIids) {
            const baseEntry = baseMap.get(iid);
            // 取任意 session 的 line/srcText 补充（baseEntry 优先）
            let line = baseEntry?.line ?? null;
            let srcText = baseEntry?.srcText ?? null;

            const row = {
                iid,
                line,
                srcText,
                sessions:    {},
                isDivergent: false,
                maxDeltaPct: 0,
            };

            const baseCnt = baseEntry?.count ?? 0;
            for (const sid of sessionIds) {
                const entry = sessionIids.get(sid)?.get(iid) ?? null;
                if (!row.line && entry?.line) { row.line = entry.line; row.srcText = entry.srcText; }
                row.sessions[sid] = entry ? { count: entry.count } : null;
            }

            for (let i = 1; i < sessionIds.length; i++) {
                const currCnt = row.sessions[sessionIds[i]]?.count ?? 0;
                if (baseCnt !== currCnt) {
                    row.isDivergent = true;
                    const deltaPct = baseCnt > 0
                        ? Math.abs((currCnt - baseCnt) / baseCnt * 100)
                        : (currCnt > 0 ? 100 : 0);
                    if (deltaPct > row.maxDeltaPct) row.maxDeltaPct = deltaPct;
                }
            }

            matrix.push(row);
        }

        matrix.sort((a, b) => {
            if (a.isDivergent !== b.isDivergent) return a.isDivergent ? -1 : 1;
            return (b.sessions[sessionIds[0]]?.count ?? 0) -
                   (a.sessions[sessionIds[0]]?.count ?? 0);
        });

        res.json({
            sessionIds,
            sessionNames:  sessions.map(s => s.name),
            iids:          matrix,
            totalIids:     matrix.length,
            divergentIids: matrix.filter(r => r.isDivergent).length,
        });
    } catch (e) {
        log.error({ err: e }, '[POST /api/compare/hot-iids] error');
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/compare/events ─────────────────────────────────────────────────
// 核心优化：单次 IN + GROUP BY session_id, type

router.post('/events', (req, res) => {
    try {
        const { sessionIds } = req.body;
        const err = validateSessionIds(sessionIds);
        if (err) return res.status(400).json({ error: err });

        const { error, sessions } = checkAndFetchSessions(sessionIds);
        if (error) return res.status(404).json({ error });

        const ph = placeholders(sessionIds.length);

        const rawRows = db.all(
            `SELECT session_id, type, COUNT(*) AS cnt
             FROM events WHERE session_id IN (${ph})
             GROUP BY session_id, type
             ORDER BY session_id, cnt DESC`,
            ...sessionIds
        );

        // 分组 + 计算 total
        const distMap = new Map(); // session_id → Map<type, cnt>
        const totals  = new Map(); // session_id → total

        for (const r of rawRows) {
            let m = distMap.get(r.session_id);
            if (!m) { m = new Map(); distMap.set(r.session_id, m); }
            m.set(r.type, r.cnt);
            totals.set(r.session_id, (totals.get(r.session_id) ?? 0) + r.cnt);
        }

        // 合并所有 type
        const allTypes = new Set();
        for (const m of distMap.values()) {
            for (const t of m.keys()) allTypes.add(t);
        }

        // 构建行（按 baseline session 数量降序）
        const rows = [];
        for (const type of allTypes) {
            const row = { type, sessions: {} };
            for (const s of sessions) {
                const total = totals.get(s.id) ?? 0;
                const cnt   = distMap.get(s.id)?.get(type) ?? null;
                row.sessions[s.id] = cnt != null
                    ? { count: cnt, pct: total > 0 ? (cnt / total * 100).toFixed(2) : '0.00' }
                    : null;
            }
            rows.push(row);
        }

        rows.sort((a, b) =>
            (b.sessions[sessionIds[0]]?.count ?? 0) -
            (a.sessions[sessionIds[0]]?.count ?? 0)
        );

        res.json({
            sessionIds,
            sessionNames: sessions.map(s => s.name),
            totals:       sessions.map(s => ({ sessionId: s.id, total: totals.get(s.id) ?? 0 })),
            rows,
        });
    } catch (e) {
        log.error({ err: e }, '[POST /api/compare/events] error');
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/compare/loops ──────────────────────────────────────────────────
// 核心优化：单次 IN + GROUP BY session_id, iid

router.post('/loops', (req, res) => {
    try {
        const { sessionIds } = req.body;
        const err = validateSessionIds(sessionIds);
        if (err) return res.status(400).json({ error: err });

        const { error, sessions } = checkAndFetchSessions(sessionIds);
        if (error) return res.status(404).json({ error });

        const ph = placeholders(sessionIds.length);

        const rawRows = db.all(
            `SELECT session_id, iid,
                    SUM(iteration_count) AS total_iters,
                    MIN(line) AS line
             FROM loops WHERE session_id IN (${ph})
             GROUP BY session_id, iid
             ORDER BY session_id, total_iters DESC`,
            ...sessionIds
        );

        // 分组
        const loopMap = new Map(); // session_id → Map<iid, {totalIters,line}>
        for (const r of rawRows) {
            let m = loopMap.get(r.session_id);
            if (!m) { m = new Map(); loopMap.set(r.session_id, m); }
            m.set(r.iid, { totalIters: r.total_iters, line: r.line });
        }

        // 合并所有 IID
        const allIids = new Set();
        for (const m of loopMap.values()) {
            for (const iid of m.keys()) allIids.add(iid);
        }

        const baseMap = loopMap.get(sessionIds[0]) ?? new Map();
        const matrix  = [];

        for (const iid of allIids) {
            const baseEntry = baseMap.get(iid);
            let line = baseEntry?.line ?? null;

            const row = {
                iid,
                line,
                sessions:    {},
                isDivergent: false,
            };

            const baseCnt = baseEntry?.totalIters ?? 0;
            for (const sid of sessionIds) {
                const entry = loopMap.get(sid)?.get(iid) ?? null;
                if (!row.line && entry?.line) row.line = entry.line;
                row.sessions[sid] = entry ? { totalIters: entry.totalIters } : null;
            }

            for (let i = 1; i < sessionIds.length; i++) {
                const currCnt = row.sessions[sessionIds[i]]?.totalIters ?? 0;
                if (baseCnt !== currCnt) row.isDivergent = true;
            }

            matrix.push(row);
        }

        matrix.sort((a, b) => {
            if (a.isDivergent !== b.isDivergent) return a.isDivergent ? -1 : 1;
            return (b.sessions[sessionIds[0]]?.totalIters ?? 0) -
                   (a.sessions[sessionIds[0]]?.totalIters ?? 0);
        });

        res.json({
            sessionIds,
            sessionNames:  sessions.map(s => s.name),
            loops:         matrix,
            totalLoops:    matrix.length,
            divergentLoops: matrix.filter(r => r.isDivergent).length,
        });
    } catch (e) {
        log.error({ err: e }, '[POST /api/compare/loops] error');
        res.status(500).json({ error: e.message });
    }
});

export default router;
