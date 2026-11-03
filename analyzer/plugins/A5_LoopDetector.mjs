/**
 * A5_LoopDetector.mjs — 循环迭代状态展开（v2）
 * 依赖：A3-HotPathAnalyzer（loops 表已填充，v2 提供 median_gap 字段）
 *
 * v2 改进：
 *   1. 迭代切割修正（原不足2）：
 *      - 使用 loop.median_gap 判断循环体体积（每次迭代约跨多少个 event）
 *      - 第一次迭代从 loop.start_seq 开始（而非第一个 iid 命中点）
 *      - 最后一次迭代到 loop.end_seq 结束（而非最后一个 iid 命中点）
 *      - 迭代 [j] 的范围：[eventsInLoop[j], eventsInLoop[j+1]-1]，
 *        第 0 次迭代起点回溯到 loop.start_seq（覆盖循环头之前的初始化代码）
 *
 *   2. 读操作快照（原不足3）：
 *      - 在每次迭代的 [start_seq, end_seq] 内同时查询 reads 表
 *      - vars_snapshot 格式升级为 { v: 2, w: {name: val}, r: {name: lastReadVal} }
 *        其中 w = 写操作（最终写入值），r = 读操作（最后一次读取时的值）
 *      - 向后兼容：旧格式（纯对象）由前端检测 v 字段决定如何渲染
 *
 * 性能设计（OOM 安全 + value_dict 版）：
 *  - 不再全量预加载 events + writes（100M 事件时会 OOM）
 *  - 改为按循环的 [start_seq, end_seq] 范围按需查询，每次只加载当前循环所需数据
 *  - 每个循环独立查询 writes/reads，避免批次合并范围覆盖整个 trace 导致 OOM
 *  - value_dict 一次性预加载到内存 Map，stmtWrites/stmtReads 只取 value_id，JS 侧查 Map
 *  - 单事务批量写入，完全无 N+1 查询
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import { synthetic } from '../DependencyIndex.mjs';
import { executionEventSql } from '../db/EventTypeCode.mjs';

// 二分查找第一个 >= target 的位置
function lowerBound(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export default class A5LoopDetector extends BasePlugin {
    static id = 'A5-LoopDetector';
    static deps = ['A3-HotPathAnalyzer'];
    static description = '展开循环迭代，记录每次迭代的变量写/读快照（v2）';
    static displayName = 'A5 · LoopDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        // 在 run() 入口捕获配置（避免循环内调用 cfg）
        const _batchSize = cfg('plugins.A5_LoopDetector.batchSize');
        const _maxLoops = cfg('plugins.A5_LoopDetector.maxLoops');
        const _maxIterPerLoop = cfg('plugins.A5_LoopDetector.maxIterPerLoop');
        const _loopBatchSize = cfg('plugins.A5_LoopDetector.loopBatchSize');
        const _maxReadVarsPerIter = cfg('plugins.A5_LoopDetector.maxReadVarsPerIter');

        this.emitProgress(ctx, '清空旧数据...', 0);

        // 确保表结构存在（幂等）
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS loop_iterations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id      TEXT NOT NULL,
                loop_id         INTEGER NOT NULL,
                iteration_idx   INTEGER NOT NULL,
                start_seq       INTEGER,
                end_seq         INTEGER,
                vars_snapshot   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_loop_iter_session   ON loop_iterations(session_id, loop_id, iteration_idx);
            CREATE INDEX IF NOT EXISTS idx_loop_iter_start_seq ON loop_iterations(session_id, start_seq);
        `);
        // 只删除当前 session 的旧数据
        rawDb.prepare('DELETE FROM loop_iterations WHERE session_id = ?').run(sessionId);

        // ── Step 1: 加载所有循环（按迭代次数降序，最多 MAX_LOOPS 个）─────────────
        // v2：同时取 median_gap 供迭代切割参考
        const allLoops = rawDb.prepare(
            `SELECT id, iid, start_seq, end_seq, iteration_count, line, src_text,
                    COALESCE(median_gap, 0) AS median_gap
             FROM loops
             WHERE session_id = ?
             ORDER BY iteration_count DESC`
        ).all(sessionId);

        if (allLoops.length === 0) {
            this.emitProgress(ctx, '无循环数据', 100);
            this.emitDone(ctx, { loopCount: 0, iterationCount: 0 });
            return;
        }

        const skipped = allLoops.length > _maxLoops ? allLoops.length - _maxLoops : 0;
        const loops = allLoops.slice(0, _maxLoops);

        this.emitProgress(ctx, `找到 ${allLoops.length} 个循环（处理前 ${loops.length} 个）...`, 5);

        // ── Step 1.5: 预加载 value_dict 到内存 Map ────────────────────────────
        this.emitProgress(ctx, '预加载值字典...', 6);
        const vdMap = new Map(); // value_id → val_text
        {
            const vdRows = rawDb.prepare(
                'SELECT id, val_text FROM value_dict WHERE session_id = ?'
            ).all(sessionId);
            for (const r of vdRows) vdMap.set(r.id, r.val_text);
        }

        // ── 预编译语句 ────────────────────────────────────────────────────────
        // 查循环 iid 在 [start_seq, end_seq] 内的所有 event id（用于确定迭代分割点）
        const stmtEvents = rawDb.prepare(
            `SELECT id FROM events e WHERE session_id = ? AND iid = ? AND id >= ? AND id <= ? AND (? IS NULL OR call_id=?) AND ${executionEventSql()} ORDER BY id ASC`
        );
        // 查写操作（不做 JOIN——完整值通过 vdMap 内存查找）
        const stmtWrites = rawDb.prepare(
            `SELECT w.event_id,w.name,w.value_id,w.binding_id,w.scope_id,e.type AS event_type FROM writes w LEFT JOIN events e ON e.session_id=w.session_id AND e.id=w.event_id WHERE w.session_id=? AND w.event_id>=? AND w.event_id<=? AND w.name IS NOT NULL AND (? IS NULL OR e.call_id=?) ORDER BY w.event_id,w.id`
        );
        // 查读操作（v2 新增）
        const stmtReads = rawDb.prepare(
            `SELECT r.event_id,r.name,r.value_id,r.binding_id,r.scope_id,e.type AS event_type FROM reads r LEFT JOIN events e ON e.session_id=r.session_id AND e.id=r.event_id WHERE r.session_id=? AND r.event_id>=? AND r.event_id<=? AND r.name IS NOT NULL AND (? IS NULL OR e.call_id=?) ORDER BY r.event_id,r.id`
        );

        const stmtInsert = rawDb.prepare(
            'INSERT INTO loop_iterations (session_id, loop_id, iteration_idx, start_seq, end_seq, vars_snapshot) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertBatch = rawDb.transaction((batch) => {
            for (const row of batch) stmtInsert.run(row);
        });

        let totalIter = 0;
        let truncated=skipped>0;
        let pending   = [];

        const flushBatch = () => {
            if (pending.length === 0) return;
            insertBatch(pending);
            totalIter += pending.length;
            pending = [];
        };

        // ── Step 2: 逐循环处理 ───────────────────────────────────────────────
        for (let i = 0; i < loops.length; i++) {
            if (i % _loopBatchSize === 0) {
                this.emitProgress(
                    ctx,
                    `处理循环 ${i + 1}/${loops.length}，已生成 ${totalIter} 次迭代...`,
                    5 + Math.floor((i / loops.length) * 90)
                );
            }

            const loop = loops[i];
            const callId=rawDb.prepare('SELECT call_id FROM events WHERE session_id=? AND id=?').get(sessionId,loop.start_seq)?.call_id ?? null;

            // ── 2a: 取 iid 命中序列（迭代分割点）───────────────────────────
            const iidEventRows = stmtEvents.all(sessionId, loop.iid, loop.start_seq, loop.end_seq,callId,callId);
            if (iidEventRows.length < 2) continue;

            const iidHits = iidEventRows.map(r => r.id); // iid 命中时刻（event_id）

            // ── 2b: 取循环范围内的写操作和读操作 ───────────────────────────
            const writesByEventId = new Map(); // event_id → [{name, value_id}]
            {
                const rows = stmtWrites.all(sessionId, loop.start_seq, loop.end_seq,callId,callId);
                for (const r of rows) {
                    if(synthetic(r.name,r.event_type))continue;
                    let arr = writesByEventId.get(r.event_id);
                    if (!arr) { arr = []; writesByEventId.set(r.event_id, arr); }
                    arr.push(r);
                }
            }
            const writeEventIds = [...writesByEventId.keys()].sort((a, b) => a - b);

            // v2：同时加载读操作
            const readsByEventId = new Map(); // event_id → [{name, value_id}]
            {
                const rows = stmtReads.all(sessionId, loop.start_seq, loop.end_seq,callId,callId);
                for (const r of rows) {
                    if(synthetic(r.name,r.event_type))continue;
                    let arr = readsByEventId.get(r.event_id);
                    if (!arr) { arr = []; readsByEventId.set(r.event_id, arr); }
                    arr.push(r);
                }
            }
            const readEventIds = [...readsByEventId.keys()].sort((a, b) => a - b);

            const identities=new Map();
            for(const entries of [writesByEventId,readsByEventId])for(const rows of entries.values())for(const row of rows) {
                if(!identities.has(row.name))identities.set(row.name,new Set());
                identities.get(row.name).add(row.binding_id ?? `scope:${row.scope_id ?? 'unknown'}`);
            }
            const snapshotName=row=>identities.get(row.name)?.size>1
                ? `${row.name}@${row.binding_id ?? `scope:${row.scope_id ?? 'unknown'}`}` : row.name;

            // Each candidate hit starts one estimated iteration. These intervals
            // partition the observed range without an empty first interval or a
            // doubled final interval; they do not prove source-level loop counts.
            const iterLimit = Math.min(iidHits.length, _maxIterPerLoop);
            truncated ||= iidHits.length > iterLimit;

            for (let j = 0; j < iterLimit; j++) {
                const startSeq = iidHits[j];
                const endSeq = j + 1 < iidHits.length ? iidHits[j + 1] - 1 : loop.end_seq;

                // ── 写快照：[startSeq, endSeq] 内所有 writes，取每个变量的最终写入值 ──
                const wSnap = Object.create(null);
                {
                    const wStart = lowerBound(writeEventIds, startSeq);
                    for (let k = wStart; k < writeEventIds.length && writeEventIds[k] <= endSeq; k++) {
                        const wrs = writesByEventId.get(writeEventIds[k]);
                        if (wrs) {
                            for (const w of wrs) wSnap[snapshotName(w)] = vdMap.get(w.value_id) ?? null;
                        }
                    }
                }

                // ── 读快照：[startSeq, endSeq] 内所有 reads，取每个变量最后一次读到的值 ──
                // 限制变量数防止爆炸（数组高频读取场景）
                const rSnap = Object.create(null);
                {
                    const rStart = lowerBound(readEventIds, startSeq);
                    let readVarCount = 0;
                    for (let k = rStart; k < readEventIds.length && readEventIds[k] <= endSeq; k++) {
                        const rds = readsByEventId.get(readEventIds[k]);
                        if (rds) {
                            for (const r of rds) {
                                if (!(snapshotName(r) in rSnap) && readVarCount >= _maxReadVarsPerIter) { truncated=true; continue; }
                                if (!(snapshotName(r) in rSnap)) readVarCount++;
                                // 使用最后一次读取的值（后覆盖前）
                                rSnap[snapshotName(r)] = vdMap.get(r.value_id) ?? null;
                            }
                        }
                    }
                }

                // v2 格式：{ v: 2, w: {写快照}, r: {读快照} }
                // 前端通过 v 字段判断是否为新格式
                const snapshot = { v: 2, w: wSnap, r: rSnap };

                pending.push([
                    sessionId,
                    loop.id,
                    j,
                    startSeq,
                    endSeq,
                    JSON.stringify(snapshot),
                ]);

                if (pending.length >= _batchSize) flushBatch();
            }

            // 每个循环处理完立即释放内存
            writesByEventId.clear();
            readsByEventId.clear();
        }

        flushBatch();

        this.emitProgress(
            ctx,
            `完成，${loops.length} 个循环，${totalIter} 次迭代${skipped > 0 ? `（跳过 ${skipped} 个低优先级循环）` : ''}`,
            100
        );

        // 补充前端期望字段
        const maxIter = loops.length > 0 ? Math.max(...loops.map(l => l.iteration_count ?? 0)) : 0;
        let iterSnapshots = 0;
        try {
            iterSnapshots = rawDb.prepare(
                'SELECT COUNT(*) AS cnt FROM loop_iterations WHERE session_id = ?'
            ).get(sessionId)?.cnt ?? 0;
        } catch { /* 非致命 */ }

        this.emitDone(ctx, {
            precision: 'heuristic-hit-intervals', truncated,
            loopCount:      loops.length,
            skippedLoops:   skipped,
            iterationCount: totalIter,
            maxIter,
            iterSnapshots,
        });
    }
}
