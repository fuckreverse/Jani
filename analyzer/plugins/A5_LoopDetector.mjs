/**
 * A5_LoopDetector.mjs — 循环迭代状态展开
 * 依赖：A3-HotPathAnalyzer（loops 表已填充）
 *
 * 性能设计（OOM 安全版）：
 *  - 不再全量预加载 events + writes（100M 事件时会 OOM）
 *  - 改为按循环的 [start_seq, end_seq] 范围按需查询，每次只加载当前循环所需数据
 *  - 每个循环独立查询 writes，避免批次合并范围覆盖整个 trace 导致 OOM
 *    （若 50 个稀疏循环 start_seq/end_seq 分布在整个 trace，合并范围 = 全量数据）
 *  - LOOP_BATCH_SIZE 仅用于进度报告和 INSERT 批量写入，不再合并 writes 查询范围
 *  - 每个循环处理完立即释放内存，峰值内存 ≈ O(single_loop_writes + BATCH_SIZE rows)
 *  - 单事务批量写入，完全无 N+1 查询
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 5000;

// 安全上限：防止混淆代码产生天文数字的循环/迭代记录
const MAX_LOOPS          = 5000;   // 最多处理前 N 个循环（按迭代次数降序）
const MAX_ITER_PER_LOOP  = 500;    // 每个循环最多记录 N 次迭代

// 进度报告粒度：每处理 N 个循环报告一次进度（不再用于合并 writes 范围查询）
const LOOP_BATCH_SIZE = 50;

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
    static description = '展开循环迭代，记录每次迭代的变量快照';
    static displayName = 'A5 · LoopDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);

        // 确保表结构正确
        try {
            rawDb.exec(`
                DROP TABLE IF EXISTS loop_iterations;
                CREATE TABLE IF NOT EXISTS loop_iterations (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id      TEXT NOT NULL,
                    loop_id         INTEGER NOT NULL,
                    iteration_idx   INTEGER NOT NULL,
                    start_seq       INTEGER,
                    end_seq         INTEGER,
                    vars_snapshot   TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_loop_iter_session ON loop_iterations(session_id, loop_id);
            `);
        } catch {
            rawDb.prepare('DELETE FROM loop_iterations WHERE session_id = ?').run(sessionId);
        }

        // ── Step 1: 加载所有循环（按迭代次数降序，最多 MAX_LOOPS 个）─────────────
        const allLoops = rawDb.prepare(
            'SELECT id, iid, start_seq, end_seq, iteration_count, line FROM loops WHERE session_id = ? ORDER BY iteration_count DESC'
        ).all(sessionId);

        if (allLoops.length === 0) {
            this.emitProgress(ctx, '无循环数据', 100);
            this.emitDone(ctx, { loopCount: 0, iterationCount: 0 });
            return;
        }

        const skipped = allLoops.length > MAX_LOOPS ? allLoops.length - MAX_LOOPS : 0;
        const loops = allLoops.slice(0, MAX_LOOPS);

        this.emitProgress(ctx, `找到 ${allLoops.length} 个循环（处理前 ${loops.length} 个）...`, 5);

        // ── 预编译语句 ────────────────────────────────────────────────────────
        // 按 iid + seq 范围查询该循环内的所有 event id（已有 idx_events_type_id 覆盖）
        const stmtEvents = rawDb.prepare(
            'SELECT id FROM events WHERE session_id = ? AND iid = ? AND id >= ? AND id <= ? ORDER BY id ASC'
        );
        // 按 event_id 范围批量查询 writes（利用 idx_writes_event 索引）
        const stmtWrites = rawDb.prepare(
            'SELECT event_id, name, value FROM writes WHERE session_id = ? AND event_id >= ? AND event_id <= ? AND name IS NOT NULL ORDER BY event_id ASC'
        );

        const stmtInsert = rawDb.prepare(
            'INSERT INTO loop_iterations (session_id, loop_id, iteration_idx, start_seq, end_seq, vars_snapshot) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertBatch = rawDb.transaction((batch) => {
            for (const row of batch) stmtInsert.run(row);
        });

        let totalIter = 0;
        let pending   = [];

        const flushBatch = () => {
            if (pending.length === 0) return;
            insertBatch(pending);
            totalIter += pending.length;
            pending = [];
        };

        // ── Step 2: 逐循环处理，每个循环独立查询 writes ─────────────────────
        // 关键：不合并多个循环的 seq 范围——稀疏分布的循环合并后范围 ≈ 全量数据
        for (let i = 0; i < loops.length; i++) {
            // 每 LOOP_BATCH_SIZE 个循环报告一次进度
            if (i % LOOP_BATCH_SIZE === 0) {
                this.emitProgress(
                    ctx,
                    `处理循环 ${i + 1}/${loops.length}，已生成 ${totalIter} 次迭代...`,
                    5 + Math.floor((i / loops.length) * 90)
                );
            }

            const loop = loops[i];

            // 查询该 iid 在 [start_seq, end_seq] 内的所有 event id
            const iidEventRows = stmtEvents.all(sessionId, loop.iid, loop.start_seq, loop.end_seq);
            if (iidEventRows.length < 2) continue;

            const eventsInLoop = iidEventRows.map(r => r.id);

            // 仅查询本循环范围内的 writes（范围精确，不会加载无关数据）
            const writesByEventId = new Map(); // event_id → [{name, value}]
            {
                const rows = stmtWrites.all(sessionId, loop.start_seq, loop.end_seq);
                for (const r of rows) {
                    let arr = writesByEventId.get(r.event_id);
                    if (!arr) { arr = []; writesByEventId.set(r.event_id, arr); }
                    arr.push(r);
                }
            }
            const writeEventIds = [...writesByEventId.keys()].sort((a, b) => a - b);

            // 切割迭代，计算快照（每循环最多记录 MAX_ITER_PER_LOOP 次）
            const iterLimit = Math.min(eventsInLoop.length, MAX_ITER_PER_LOOP);
            for (let j = 0; j < iterLimit; j++) {
                const startSeq = eventsInLoop[j];
                const endSeq   = j + 1 < eventsInLoop.length
                    ? eventsInLoop[j + 1] - 1
                    : loop.end_seq;

                // 二分定位 [startSeq, endSeq] 内的 writes
                const wStart = lowerBound(writeEventIds, startSeq);
                const snapshot = {};
                for (let k = wStart; k < writeEventIds.length && writeEventIds[k] <= endSeq; k++) {
                    const eid = writeEventIds[k];
                    const wrs = writesByEventId.get(eid);
                    if (wrs) {
                        for (const w of wrs) snapshot[w.name] = w.value;
                    }
                }

                pending.push([
                    sessionId,
                    loop.id,
                    j,
                    startSeq,
                    endSeq,
                    JSON.stringify(snapshot),
                ]);

                if (pending.length >= BATCH_SIZE) flushBatch();
            }

            // 每个循环处理完立即释放内存
            writesByEventId.clear();
        }

        flushBatch();

        this.emitProgress(
            ctx,
            `完成，${loops.length} 个循环，${totalIter} 次迭代${skipped > 0 ? `（跳过 ${skipped} 个低优先级循环）` : ''}`,
            100
        );
        this.emitDone(ctx, { loopCount: loops.length, skippedLoops: skipped, iterationCount: totalIter });
    }
}
