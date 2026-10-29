/**
 * A3_HotPathAnalyzer.mjs — 统计 iid 执行频率，检测循环（v3）
 *
 * v3 改进（相对 v2）：
 *  1. 函数边界感知：每次循环检测都在单次函数调用的"own event"窗口内进行。
 *     "own events" = 该帧 [call_seq, return_seq] 内的 events，
 *     **减去**所有直接子调用帧占用的 SEQ 范围。
 *     这样就不会把子函数内反复执行的 iid 误判为本函数的循环。
 *
 *  2. call_edge_id / fn_name 写入 loops 表：每条循环记录关联到它所属的函数调用帧。
 *     NULL call_edge_id 表示顶层脚本（不在任何函数帧内）检测到的循环。
 *
 *  3. 嵌套循环识别改为帧内局部推导（更准确）：
 *     同一函数帧内的多个循环记录按 [start_seq, end_seq] 推导父子关系。
 *     跨帧循环不做父子关联（它们属于不同函数调用实例）。
 *
 * v2 特性保留：
 *  - 自适应间距阈值（median × SPLIT_FACTOR / MERGE_FACTOR）
 *  - src_text / median_gap 写入 loops 表
 *  - iid_counts 统计保持不变
 *
 * 依赖：F1-EventIndex（events 表），F3-CallGraphBuilder（call_edges 表）
 *
 * 性能：
 *  - call_edges 全量加载到内存（一般 < 100 K 条）
 *  - own-event 区间用"帧窗口减子帧"方式构造，无需逐行筛选
 *  - smap 一次性预加载到内存 Map
 *  - 每帧独立做分段 + 合并，JS 侧 O(total_own_events)
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

const BATCH_SIZE     = () => cfg('plugins.A3_HotPathAnalyzer.batchSize');

// ── 自适应阈值参数：来自配置 ──────────────────────────────────────────────────
const MIN_SPLIT_GAP  = () => cfg('plugins.A3_HotPathAnalyzer.minSplitGap');
// SQL IN (...) 的最大占位符数量（SQLite 限制 ~32766，留余量）
const MAX_IN_PARAMS  = () => cfg('plugins.A3_HotPathAnalyzer.maxInParams');
const SPLIT_FACTOR   = () => cfg('plugins.A3_HotPathAnalyzer.splitFactor');
const MERGE_FACTOR   = () => cfg('plugins.A3_HotPathAnalyzer.mergeFactor');
const MIN_ITER_COUNT = () => cfg('plugins.A3_HotPathAnalyzer.minIterCount');

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 计算数组中位数（不改变原数组，允许空数组返回 0） */
function median(arr) {
    if (arr.length === 0) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length & 1 ? s[m] : ((s[m - 1] + s[m]) / 2) | 0;
}

/**
 * 对单个 iid 的有序命中序列做自适应分段 + 合并，返回片段列表。
 *
 * @param {number[]} seqs  — 已按升序排列的 event_id 数组
 * @returns {{ start: number, end: number, count: number, medianGap: number }[]}
 */
function segmentAndMerge(seqs, params) {
    const { minIterCount, splitFactor, mergeFactor, minSplitGap } = params;
    if (seqs.length < minIterCount) return [];

    // ── Step A：计算相邻间距，求中位数 ──────────────────────────────────────
    const gaps = [];
    for (let i = 1; i < seqs.length; i++) gaps.push(seqs[i] - seqs[i - 1]);
    const med = median(gaps);

    const splitThresh = Math.max(med * splitFactor, minSplitGap);
    const mergeThresh = Math.max(med * mergeFactor, minSplitGap);

    // ── Step B：按 splitThresh 切段 ──────────────────────────────────────────
    const rawSegs = [];
    let segStart = seqs[0];
    let segPrev  = seqs[0];
    let segCount = 1;

    for (let i = 1; i < seqs.length; i++) {
        const gap = seqs[i] - segPrev;
        if (gap <= splitThresh) {
            segCount++;
            segPrev = seqs[i];
        } else {
            if (segCount >= minIterCount) {
                rawSegs.push({ start: segStart, end: segPrev, count: segCount });
            }
            segStart = seqs[i];
            segPrev  = seqs[i];
            segCount = 1;
        }
    }
    if (segCount >= minIterCount) {
        rawSegs.push({ start: segStart, end: segPrev, count: segCount });
    }

    if (rawSegs.length === 0) return [];

    // ── Step C：按 mergeThresh 合并相邻片段 ──────────────────────────────────
    const merged = [{ ...rawSegs[0] }];
    for (let i = 1; i < rawSegs.length; i++) {
        const prev = merged[merged.length - 1];
        const gap  = rawSegs[i].start - prev.end;
        if (gap <= mergeThresh) {
            prev.end   = rawSegs[i].end;
            prev.count += rawSegs[i].count;
        } else {
            merged.push({ ...rawSegs[i] });
        }
    }

    // ── Step D：附上中位数信息 ───────────────────────────────────────────────
    return merged
        .filter(s => s.count >= minIterCount)
        .map(s => ({ ...s, medianGap: med }));
}

/**
 * 对候选循环列表推导嵌套关系（parent_loop_id, loop_depth）。
 * 仅在同一函数帧内部的循环之间推导，跨帧不做关联。
 *
 * 算法：
 *   1. 按 start_seq ASC、end_seq DESC 排序（范围大的优先）
 *   2. 维护活跃祖先栈，找最近包含当前循环的祖先
 *   3. 深度 = 父深度 + 1
 *
 * @param {{ id: number, start_seq: number, end_seq: number }[]} loops
 * @returns {Map<number, { parentId: number|null, depth: number }>}
 */
function inferNesting(loops) {
    const sorted = loops.slice().sort((a, b) =>
        a.start_seq !== b.start_seq
            ? a.start_seq - b.start_seq
            : b.end_seq - a.end_seq
    );

    const result = new Map();
    const stack  = [];

    for (const loop of sorted) {
        while (stack.length > 0 && stack[stack.length - 1].end_seq < loop.end_seq) {
            stack.pop();
        }

        let parentId = null;
        let depth    = 0;
        if (stack.length > 0) {
            const top = stack[stack.length - 1];
            if (top.start_seq <= loop.start_seq) {
                parentId = top.id;
                depth    = top.depth + 1;
            }
        }

        result.set(loop.id, { parentId, depth });
        stack.push({ id: loop.id, start_seq: loop.start_seq, end_seq: loop.end_seq, depth });
    }

    return result;
}

/**
 * 给定一个帧区间 [frameStart, frameEnd] 和它的直接子帧列表
 * [{call_seq, return_seq}]，计算"own-event"区间列表：
 * 即把 [frameStart, frameEnd] 减去所有子帧区间后剩下的若干段 [a, b]。
 *
 * @param {number} frameStart
 * @param {number} frameEnd
 * @param {{ call_seq: number, return_seq: number }[]} directChildren  — 已按 call_seq 升序排列
 * @returns {{ lo: number, hi: number }[]}  — 各段区间（inclusive）
 */
function computeOwnRanges(frameStart, frameEnd, directChildren) {
    const ranges = [];
    let cursor   = frameStart;

    for (const child of directChildren) {
        if (child.call_seq > cursor) {
            ranges.push({ lo: cursor, hi: child.call_seq - 1 });
        }
        cursor = child.return_seq + 1;
    }
    if (cursor <= frameEnd) {
        ranges.push({ lo: cursor, hi: frameEnd });
    }
    return ranges;
}

export default class A3HotPathAnalyzer extends BasePlugin {
    static observes = ['F2-SmapLoader'];
    static id = 'A3-HotPathAnalyzer';
    static deps = ['F1-EventIndex'];
    static description = '统计各 iid 执行次数，检测循环（v3：函数边界感知 + 自适应阈值 + 嵌套识别），写入 iid_counts/loops 表';
    static displayName = 'A3 · HotPathAnalyzer';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        // ── 从配置读取所有运行参数 ────────────────────────────────────────────
        const _batchSize    = BATCH_SIZE();
        const _maxInParams  = MAX_IN_PARAMS();
        const _minIterCount = MIN_ITER_COUNT();
        const _segParams    = {
            minIterCount: _minIterCount,
            splitFactor:  SPLIT_FACTOR(),
            mergeFactor:  MERGE_FACTOR(),
            minSplitGap:  MIN_SPLIT_GAP(),
        };

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM iid_counts WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM loops WHERE session_id = ?', [sessionId]);

        // ── Step 1: 统计 iid 执行次数 ───────────────────────────────────────
        this.emitProgress(ctx, '统计 iid 执行次数...', 5);

        const counts = db.all(
            `SELECT e.iid, COUNT(*) as count, s.sl AS line, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE e.session_id = ? AND e.iid IS NOT NULL
             GROUP BY e.iid
             ORDER BY count DESC`,
            [sessionId]
        );

        this.emitProgress(ctx, `${counts.length} 个 iid，批量写入统计...`, 20);

        // 批量写入 iid_counts
        const insertIid = rawDb.prepare(
            'INSERT OR REPLACE INTO iid_counts (session_id, iid, count, line, src_text) VALUES (?, ?, ?, ?, ?)'
        );
        const insertIidBatch = rawDb.transaction((batch) => {
            for (const c of batch) insertIid.run(sessionId, c.iid, c.count, c.line, c.src_text);
        });
        for (let i = 0; i < counts.length; i += _batchSize) {
            insertIidBatch(counts.slice(i, i + _batchSize));
        }

        // ── Step 1.5: 预加载 smap ───────────────────────────────────────────
        const smapMap = new Map(); // iid → { line, src_text }
        {
            const smapRows = rawDb.prepare(
                'SELECT iid, sl AS line, src_text FROM smap WHERE session_id = ?'
            ).all(sessionId);
            for (const r of smapRows) smapMap.set(r.iid, { line: r.line, src_text: r.src_text });
        }

        // 热点 iid 集合（执行次数 >= MIN_ITER_COUNT 的 iid 才可能产生循环）
        const hotIids   = counts.filter(c => c.count >= _minIterCount).map(c => c.iid);
        const hotIidSet = new Set(hotIids);

        if (hotIidSet.size === 0) {
            this.emitProgress(ctx, '完成，无热点 iid', 100);
            const topHitCount = counts.length > 0 ? counts[0].count : 0;
            this.emitDone(ctx, { iidCount: counts.length, loopCount: 0, topHitCount });
            return;
        }

        // ── Step 2: 加载 call_edges，构建帧树 ───────────────────────────────
        this.emitProgress(ctx, '加载调用图...', 30);

        const callEdges = rawDb.prepare(
            `SELECT id, call_seq, return_seq, depth, fn_name
             FROM call_edges
             WHERE session_id = ?
             ORDER BY call_seq ASC`
        ).all(sessionId);

        // 构建 depth → edges 的分组（用于快速找直接子帧）
        // 直接子帧 = depth = 父depth+1，且 call_seq 在父帧 [call_seq, return_seq] 内
        // 为提升性能，对每个帧只找直接子帧：
        //   用栈遍历 callEdges（已按 call_seq 排序）——
        //   栈帧中维护 depth → 当前活跃祖先，遇到 depth=D 的帧时
        //   其直接父帧就是栈中 depth=D-1 的帧

        // children Map：edgeId → directChildren[]（每个子帧 {call_seq, return_seq}）
        const childrenOf = new Map(); // edgeId → [{call_seq, return_seq}]
        for (const e of callEdges) childrenOf.set(e.id, []);

        // 用栈推导直接父子关系
        // 栈：depth → 当前该深度的"活跃"帧（按 call_seq 遍历，遇到深度相同的帧则替换）
        const depthStack = []; // 存放 { edge } 按深度索引（depthStack[d] = edge at depth d）

        for (const edge of callEdges) {
            const d = edge.depth;
            // 截断比当前深度更深的帧（它们已经 return 了）
            depthStack.length = d;

            if (d > 0) {
                const parentEdge = depthStack[d - 1];
                if (parentEdge) {
                    childrenOf.get(parentEdge.id).push({
                        call_seq:   edge.call_seq,
                        return_seq: edge.return_seq,
                    });
                }
            }
            // 将当前帧压入该深度
            depthStack[d] = edge;
        }

        // ── Step 3: 确定循环检测的"窗口"列表 ───────────────────────────────
        // 两类窗口：
        //  A. 每个 call_edges 帧（函数调用实例）→ own-event 区间
        //  B. 顶层脚本（不在任何帧内的事件）→ 顶层 own-event 区间（call_edge_id = NULL）

        // 先算顶层区间（所有 depth=0 帧之外的区间）
        // 顶层：session 中所有事件，减去 depth=0 的调用帧占用的区间
        // callEdges 已按 call_seq ASC，filter 不改变顺序，无需额外 sort
        const depth0Frames = callEdges.filter(e => e.depth === 0);

        // 获取 session events 的 id 范围
        const minMaxRow = rawDb.prepare(
            'SELECT MIN(id) AS minId, MAX(id) AS maxId FROM events WHERE session_id = ?'
        ).get(sessionId);
        const sessionMinId = minMaxRow?.minId ?? 0;
        const sessionMaxId = minMaxRow?.maxId ?? 0;

        // 顶层 own-event 区间（顶层帧视为"整个 session 减去 depth=0 帧"）
        const topLevelRanges = computeOwnRanges(
            sessionMinId, sessionMaxId,
            depth0Frames.map(e => ({ call_seq: e.call_seq, return_seq: e.return_seq }))
        );

        // ── Step 4: 加载热点事件（SQL 层过滤热点 iid）──────────────────────
        // 优化：用 iid IN (...) 只拉热点 iid 的事件，避免加载全量 events
        this.emitProgress(ctx, `加载热点事件 (${hotIidSet.size} 个热点 iid)...`, 40);

        let hotEvents; // { id, iid }[]，已按 id ASC
        if (hotIids.length <= _maxInParams) {
            const placeholders = hotIids.map(() => '?').join(',');
            hotEvents = rawDb.prepare(
                `SELECT id, iid FROM events
                 WHERE session_id = ? AND iid IN (${placeholders})
                 ORDER BY id ASC`
            ).all(sessionId, ...hotIids);
        } else {
            // 超出 IN 限制（极大 session 退化路径）：全量拉取后 JS 侧过滤
            hotEvents = rawDb.prepare(
                `SELECT id, iid FROM events
                 WHERE session_id = ? AND iid IS NOT NULL
                 ORDER BY id ASC`
            ).all(sessionId).filter(e => hotIidSet.has(e.iid));
        }

        this.emitProgress(ctx, `${hotEvents.length} 条热点事件，按帧窗口检测循环...`, 50);

        // ── Step 5: 双指针扫描，一次遍历完成所有帧的事件收集 ────────────────
        //
        // 关键优化：
        //   1. 把所有帧 + 顶层的 own-event 区间展平为一个列表，按 lo ASC 排序。
        //   2. 用单个全局指针 globalPtr 线性扫描 hotEvents（id 单调递增），
        //      对每个窗口从 globalPtr 处向前读，读完后不回退。
        //   3. 总扫描次数 = O(total_hot_events)，而非 O(帧数 × 平均own_events)。
        //
        // 同一帧的多个 own-range 合并到同一个 edgeKey 的 iidSeqs Map 中。

        // 5a: 展平所有窗口区间
        const allWindows = []; // { lo, hi, edgeKey }[]
        for (const { lo, hi } of topLevelRanges) {
            allWindows.push({ lo, hi, edgeKey: '__toplevel__' });
        }
        for (const edge of callEdges) {
            const children  = childrenOf.get(edge.id); // 已按 call_seq 升序，无需 sort
            const ownRanges = computeOwnRanges(edge.call_seq, edge.return_seq, children);
            for (const { lo, hi } of ownRanges) {
                allWindows.push({ lo, hi, edgeKey: edge.id });
            }
        }

        // 按 lo ASC 排序（保证 globalPtr 单调前进）
        allWindows.sort((a, b) => a.lo !== b.lo ? a.lo - b.lo : a.hi - b.hi);

        // 5b: 双指针收集 — edgeKey → Map<iid, eventId[]>
        const edgeIidSeqs = new Map(); // edgeKey → Map<iid, number[]>

        let globalPtr = 0;
        for (const { lo, hi, edgeKey } of allWindows) {
            if (lo > hi) continue;

            // 跳过 id < lo 的事件（globalPtr 只前进，不后退）
            while (globalPtr < hotEvents.length && hotEvents[globalPtr].id < lo) globalPtr++;

            let iidSeqs = edgeIidSeqs.get(edgeKey);
            if (!iidSeqs) { iidSeqs = new Map(); edgeIidSeqs.set(edgeKey, iidSeqs); }

            for (let i = globalPtr; i < hotEvents.length && hotEvents[i].id <= hi; i++) {
                const e = hotEvents[i];
                let arr = iidSeqs.get(e.iid);
                if (!arr) { arr = []; iidSeqs.set(e.iid, arr); }
                arr.push(e.id);
            }
        }

        // 5c: 对每帧 iidSeqs 做 segmentAndMerge，产生候选循环
        const candidateLoops = [];

        // edgeKey → fnName 快速查找（__toplevel__ → null）
        const edgeFnName = new Map([['__toplevel__', null]]);
        for (const edge of callEdges) edgeFnName.set(edge.id, edge.fn_name ?? null);

        for (const [edgeKey, iidSeqs] of edgeIidSeqs) {
            const callEdgeId = edgeKey === '__toplevel__' ? null : edgeKey;
            const fnName     = edgeFnName.get(edgeKey) ?? null;

            for (const [iid, seqs] of iidSeqs) {
                const segments = segmentAndMerge(seqs, _segParams);
                if (segments.length === 0) continue;
                const smapInfo = smapMap.get(iid) ?? {};
                for (const seg of segments) {
                    candidateLoops.push({
                        iid,
                        start_seq:       seg.start,
                        end_seq:         seg.end,
                        iteration_count: seg.count,
                        medianGap:       seg.medianGap,
                        line:            smapInfo.line     ?? null,
                        src_text:        smapInfo.src_text ?? null,
                        call_edge_id:    callEdgeId,
                        fn_name:         fnName,
                    });
                }
            }
        }

        this.emitProgress(ctx, `发现 ${candidateLoops.length} 个候选循环，推导嵌套关系...`, 72);

        if (candidateLoops.length === 0) {
            this.emitProgress(ctx, '完成，无循环检测到', 100);
            const topHitCount = counts.length > 0 ? counts[0].count : 0;
            this.emitDone(ctx, { iidCount: counts.length, loopCount: 0, topHitCount });
            return;
        }

        // ── Step 6: 推导嵌套关系（帧内局部）────────────────────────────────
        // 按 call_edge_id 分组，各组内独立推导嵌套关系
        const withTempId = candidateLoops.map((l, idx) => ({ ...l, id: idx }));

        // 按 call_edge_id 分组（null 归为 'toplevel'）
        const frameGroups = new Map(); // callEdgeId-key → loop[]
        for (const l of withTempId) {
            const key = l.call_edge_id ?? '__toplevel__';
            let arr = frameGroups.get(key);
            if (!arr) { arr = []; frameGroups.set(key, arr); }
            arr.push(l);
        }

        const nestingMap = new Map(); // tempId → { parentId, depth }
        for (const loops of frameGroups.values()) {
            const group = inferNesting(loops); // tempId → { parentId, depth }
            for (const [id, info] of group) nestingMap.set(id, info);
        }

        // ── Step 7: 批量写入 loops 表 ───────────────────────────────────────
        const insertLoop = rawDb.prepare(
            `INSERT INTO loops
             (session_id, iid, start_seq, end_seq, iteration_count, line, src_text,
              median_gap, loop_depth, parent_loop_id, call_edge_id, fn_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        );
        const insertLoopBatch = rawDb.transaction((batch) => {
            for (const l of batch) {
                insertLoop.run(
                    sessionId,
                    l.iid,
                    l.start_seq,
                    l.end_seq,
                    l.iteration_count,
                    l.line,
                    l.src_text,
                    l.medianGap,
                    nestingMap.get(l.id)?.depth ?? 0,
                    l.call_edge_id,
                    l.fn_name
                );
            }
        });

        for (let i = 0; i < withTempId.length; i += _batchSize) {
            insertLoopBatch(withTempId.slice(i, i + _batchSize));
        }

        // ── Step 8: 查回真实 id，补写 parent_loop_id ────────────────────────
        // bugfix：用 (iid, start_seq, call_edge_id) 三元组作唯一 key，避免跨帧碰撞
        const insertedRows = rawDb.prepare(
            `SELECT id, iid, start_seq, call_edge_id FROM loops WHERE session_id = ? ORDER BY id ASC`
        ).all(sessionId);

        const keyToRealId = new Map();
        for (const r of insertedRows) {
            keyToRealId.set(`${r.iid}:${r.start_seq}:${r.call_edge_id ?? ''}`, r.id);
        }

        const tempToReal = new Map();
        for (const l of withTempId) {
            const key    = `${l.iid}:${l.start_seq}:${l.call_edge_id ?? ''}`;
            const realId = keyToRealId.get(key);
            if (realId !== undefined) tempToReal.set(l.id, realId);
        }

        const updateParent = rawDb.prepare(
            'UPDATE loops SET parent_loop_id = ? WHERE id = ? AND session_id = ?'
        );
        const updateParentBatch = rawDb.transaction((batch) => {
            for (const [realId, parentRealId] of batch) {
                updateParent.run(parentRealId, realId, sessionId);
            }
        });

        const parentUpdates = [];
        for (const [tempId, { parentId }] of nestingMap) {
            if (parentId === null) continue;
            const realId       = tempToReal.get(tempId);
            const parentRealId = tempToReal.get(parentId);
            if (realId !== undefined && parentRealId !== undefined) {
                parentUpdates.push([realId, parentRealId]);
            }
        }

        for (let i = 0; i < parentUpdates.length; i += _batchSize) {
            updateParentBatch(parentUpdates.slice(i, i + _batchSize));
        }

        // ── 统计嵌套深度分布 ─────────────────────────────────────────────────
        const topLevel = withTempId.filter((_, idx) => (nestingMap.get(idx)?.depth ?? 0) === 0).length;
        const nested   = candidateLoops.length - topLevel;

        this.emitProgress(
            ctx,
            `完成，${counts.length} 个 iid，检测到 ${candidateLoops.length} 个循环` +
            `（顶层 ${topLevel}，嵌套 ${nested}）`,
            100
        );
        const topHitCount = counts.length > 0 ? counts[0].count : 0; // counts 已按 count DESC 排序
        this.emitDone(ctx, {
            iidCount:    counts.length,
            loopCount:   candidateLoops.length,
            topHitCount,
            topLevel,
            nested,
        });
    }
}
