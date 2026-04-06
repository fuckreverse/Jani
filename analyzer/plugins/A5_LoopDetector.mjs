/**
 * A5_LoopDetector.mjs — 循环迭代状态展开
 * 依赖：A3-HotPathAnalyzer（loops 表已填充）
 *
 * 对 loops 表中每个循环，展开每次迭代的变量快照，写入 loop_iterations。
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class A5LoopDetector extends BasePlugin {
    static id = 'A5-LoopDetector';
    static deps = ['A3-HotPathAnalyzer'];
    static description = '展开循环迭代，记录每次迭代的变量快照';
    static displayName = 'A5 · LoopDetector';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);

        // 迁移兼容：确保表结构正确（旧表可能缺少列）
        try {
            db.exec(`
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
        } catch (e) {
            // 表已存在且结构正确，只清空数据
            db.run('DELETE FROM loop_iterations WHERE session_id = ?', [sessionId]);
        }

        const loops = db.all('SELECT * FROM loops WHERE session_id = ?', [sessionId]);
        if (loops.length === 0) {
            this.emitDone(ctx, { loopCount: 0, iterationCount: 0 });
            return;
        }

        let totalIter = 0;
        let processed = 0;

        for (const loop of loops) {
            this.emitProgress(
                ctx,
                `处理循环 ${loop.id}（iid=${loop.iid}, line=${loop.line}）...`,
                Math.floor((processed / loops.length) * 90)
            );

            // 获取该循环范围内该 iid 的所有事件（按 id ASC）— 每次出现 = 一次迭代起点
            const eventsInLoop = db.all(
                'SELECT id FROM events WHERE session_id = ? AND iid = ? AND id >= ? AND id <= ? ORDER BY id ASC',
                [sessionId, loop.iid, loop.start_seq, loop.end_seq]
            );

            if (eventsInLoop.length < 2) {
                processed++;
                continue;
            }

            // 切割迭代边界
            const iterations = [];
            for (let i = 0; i < eventsInLoop.length; i++) {
                const startSeq = eventsInLoop[i].id;
                const endSeq =
                    i + 1 < eventsInLoop.length
                        ? eventsInLoop[i + 1].id - 1
                        : loop.end_seq;
                iterations.push({ start: startSeq, end: endSeq, idx: i });
            }

            // 对每次迭代，收集 writes 变量快照
            const rows = [];
            for (const iter of iterations) {
                const writes = db.all(
                    `SELECT w.name, w.value
                     FROM writes w
                     JOIN events e ON w.event_id = e.id
                     WHERE e.session_id = ? AND e.id >= ? AND e.id <= ?`,
                    [sessionId, iter.start, iter.end]
                );

                // 后写覆盖前写
                const snapshot = {};
                for (const w of writes) {
                    if (w.name) snapshot[w.name] = w.value;
                }

                rows.push([
                    sessionId,
                    loop.id,
                    iter.idx,
                    iter.start,
                    iter.end,
                    JSON.stringify(snapshot),
                ]);
            }

            if (rows.length > 0) {
                db.transaction(() => {
                    for (const row of rows) {
                        db.run(
                            'INSERT INTO loop_iterations (session_id, loop_id, iteration_idx, start_seq, end_seq, vars_snapshot) VALUES (?, ?, ?, ?, ?, ?)',
                            row
                        );
                    }
                });
                totalIter += rows.length;
            }

            processed++;
        }

        this.emitProgress(ctx, `完成，${loops.length} 个循环，${totalIter} 次迭代`, 100);
        this.emitDone(ctx, { loopCount: loops.length, iterationCount: totalIter });
    }
}
