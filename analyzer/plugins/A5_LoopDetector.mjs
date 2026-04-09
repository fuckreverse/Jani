/**
 * A5_LoopDetector.mjs — 循环迭代状态展开
 * 依赖：A3-HotPathAnalyzer（loops 表已填充）
 *
 * 性能设计：
 *  - 一次性加载所有 loops、events(id+iid)、writes
 *  - 事件按 id 有序存为数组，writes 按 event_id 分组到 Map
 *  - 每个迭代用二分定位范围起点，线性扫描到终点，O(range_size) 而非 O(N)
 *  - 单事务批量写入，完全无 N+1 查询
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 5000;

// 安全上限：防止混淆代码产生天文数字的循环/迭代记录
const MAX_LOOPS          = 5000;   // 最多处理前 N 个循环（按 start_seq 排序，取频繁的）
const MAX_ITER_PER_LOOP  = 500;    // 每个循环最多记录 N 次迭代

// 二分查找第一个 >= target 的位置
function lowerBound(arr, target, key = x => x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (key(arr[mid]) < target) lo = mid + 1;
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
        // 优先处理迭代次数最多的循环（分析价值最高），同时避免处理过多循环
        const allLoops = rawDb.prepare(
            'SELECT id, iid, start_seq, end_seq, iteration_count, line FROM loops WHERE session_id = ? ORDER BY iteration_count DESC'
        ).all(sessionId);

        if (allLoops.length === 0) {
            this.emitDone(ctx, { loopCount: 0, iterationCount: 0 });
            return;
        }

        // 裁剪到 MAX_LOOPS，取迭代次数最多的前 N 个
        const skipped = allLoops.length > MAX_LOOPS ? allLoops.length - MAX_LOOPS : 0;
        const loops = allLoops.slice(0, MAX_LOOPS);

        this.emitProgress(ctx, `找到 ${allLoops.length} 个循环（处理前 ${loops.length} 个），加载事件 id 列表...`, 5);

        // ── Step 2: 加载该 session 所有事件的 id + iid（只要这两列，很轻量）──────
        // 按 id ASC 排序（数据库返回时已有序），用于切割迭代边界
        const allEvents = rawDb.prepare(
            'SELECT id, iid FROM events WHERE session_id = ? ORDER BY id ASC'
        ).all(sessionId);

        // 按 iid 分组 → iid → sorted id[]（已按 id ASC，顺序天然正确）
        const eventsByIid = new Map(); // iid → Int32Array（节省内存 + 二分友好）
        {
            // 先按 iid 分组到普通 Map<iid, number[]>
            const tmp = new Map();
            for (const e of allEvents) {
                let arr = tmp.get(e.iid);
                if (!arr) { arr = []; tmp.set(e.iid, arr); }
                arr.push(e.id);
            }
            // 转为普通 number[]，已有序
            for (const [iid, arr] of tmp) eventsByIid.set(iid, arr);
        }

        this.emitProgress(ctx, `加载 writes 数据...`, 15);

        // ── Step 3: 一次性加载所有 writes，按 event_id 分组 ───────────────────
        // 同时构建有序的 writeEventIds 数组，用于范围查找
        const writesByEventId = new Map(); // event_id → [{name, value}]
        {
            const rows = rawDb.prepare(
                'SELECT event_id, name, value FROM writes WHERE session_id = ? ORDER BY event_id ASC'
            ).all(sessionId);
            for (const r of rows) {
                if (!r.name) continue;
                let arr = writesByEventId.get(r.event_id);
                if (!arr) { arr = []; writesByEventId.set(r.event_id, arr); }
                arr.push(r);
            }
        }
        // 有序的 write event_id 数组（用于范围二分）
        const writeEventIds = [...writesByEventId.keys()].sort((a, b) => a - b);

        this.emitProgress(ctx, '计算迭代快照...', 30);

        // ── Step 4: 纯内存计算所有循环迭代的快照，单事务批量写入 ────────────────
        const stmt = rawDb.prepare(
            'INSERT INTO loop_iterations (session_id, loop_id, iteration_idx, start_seq, end_seq, vars_snapshot) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertBatch = rawDb.transaction((batch) => {
            for (const row of batch) stmt.run(row);
        });

        let totalIter = 0;
        let pending   = [];

        const flushBatch = () => {
            if (pending.length === 0) return;
            insertBatch(pending);
            totalIter += pending.length;
            pending = [];
        };

        for (let li = 0; li < loops.length; li++) {
            const loop = loops[li];

            if (li % 200 === 0) {
                this.emitProgress(
                    ctx,
                    `处理循环 ${li + 1}/${loops.length}，已生成 ${totalIter} 次迭代...`,
                    30 + Math.floor((li / loops.length) * 60)
                );
            }

            // 该 iid 在 [start_seq, end_seq] 内的所有 event_id（已排序）
            const iidEvents = eventsByIid.get(loop.iid);
            if (!iidEvents || iidEvents.length < 2) continue;

            // 二分找 start_seq 起点
            const startIdx = lowerBound(iidEvents, loop.start_seq);
            const eventsInLoop = [];
            for (let i = startIdx; i < iidEvents.length && iidEvents[i] <= loop.end_seq; i++) {
                eventsInLoop.push(iidEvents[i]);
            }
            if (eventsInLoop.length < 2) continue;

            // 切割迭代，计算快照（每循环最多记录 MAX_ITER_PER_LOOP 次）
            const iterLimit = Math.min(eventsInLoop.length, MAX_ITER_PER_LOOP);
            for (let i = 0; i < iterLimit; i++) {
                const startSeq = eventsInLoop[i];
                const endSeq   = i + 1 < eventsInLoop.length
                    ? eventsInLoop[i + 1] - 1
                    : loop.end_seq;

                // 找 writeEventIds 里 [startSeq, endSeq] 范围内的 event_id
                const wStart = lowerBound(writeEventIds, startSeq);
                const snapshot = {};
                for (let j = wStart; j < writeEventIds.length && writeEventIds[j] <= endSeq; j++) {
                    const eid = writeEventIds[j];
                    const wrs = writesByEventId.get(eid);
                    if (wrs) {
                        for (const w of wrs) snapshot[w.name] = w.value;
                    }
                }

                pending.push([
                    sessionId,
                    loop.id,
                    i,
                    startSeq,
                    endSeq,
                    JSON.stringify(snapshot),
                ]);

                if (pending.length >= BATCH_SIZE) flushBatch();
            }
        }

        flushBatch();

        this.emitProgress(ctx, `完成，${loops.length} 个循环，${totalIter} 次迭代${skipped > 0 ? `（跳过 ${skipped} 个低优先级循环）` : ''}`, 100);
        this.emitDone(ctx, { loopCount: loops.length, skippedLoops: skipped, iterationCount: totalIter });
    }
}
