/**
 * A3_HotPathAnalyzer.mjs — 统计 iid 执行频率，检测循环
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class A3HotPathAnalyzer extends BasePlugin {
    static id = 'A3-HotPathAnalyzer';
    static deps = ['F1-EventIndex'];
    static description = '统计各 iid 执行次数，检测循环，写入 iid_counts/loops 表';
    static displayName = 'A3 · HotPathAnalyzer';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM iid_counts WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM loops WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '统计 iid 执行次数...', 5);

        // 统计每个 iid 的执行次数
        const counts = db.all(
            `SELECT iid, COUNT(*) as count, MIN(line) as line, MIN(src_text) as src_text
             FROM events
             WHERE session_id = ? AND iid IS NOT NULL
             GROUP BY iid
             ORDER BY count DESC`,
            [sessionId]
        );

        this.emitProgress(ctx, `${counts.length} 个 iid，写入统计...`, 30);

        // 批量写入 iid_counts
        db.transaction(() => {
            for (const c of counts) {
                db.run(
                    'INSERT OR REPLACE INTO iid_counts (session_id, iid, count, line, src_text) VALUES (?, ?, ?, ?, ?)',
                    [sessionId, c.iid, c.count, c.line, c.src_text]
                );
            }
        });

        this.emitProgress(ctx, '检测循环...', 60);

        // 检测循环：对 count >= 3 的 iid，找连续执行段
        const hotIids = counts.filter(c => c.count >= 3);
        const loops = [];

        for (const hot of hotIids) {
            // 获取该 iid 所有出现的 seq
            const seqs = db.all(
                'SELECT id FROM events WHERE session_id = ? AND iid = ? ORDER BY id ASC',
                [sessionId, hot.iid]
            );
            if (seqs.length < 3) continue;

            // 找连续段：相邻 seq 差值 <= 某个阈值（50）认为是同一个循环
            const THRESHOLD = 50;
            let segStart = seqs[0].id;
            let segPrev = seqs[0].id;
            let segCount = 1;

            for (let i = 1; i < seqs.length; i++) {
                const gap = seqs[i].id - segPrev;
                if (gap <= THRESHOLD) {
                    segCount++;
                    segPrev = seqs[i].id;
                } else {
                    if (segCount >= 3) {
                        loops.push([sessionId, hot.iid, segStart, segPrev, segCount, hot.line]);
                    }
                    segStart = seqs[i].id;
                    segPrev = seqs[i].id;
                    segCount = 1;
                }
            }
            if (segCount >= 3) {
                loops.push([sessionId, hot.iid, segStart, segPrev, segCount, hot.line]);
            }
        }

        // 写入 loops
        if (loops.length > 0) {
            db.transaction(() => {
                for (const l of loops) {
                    db.run(
                        'INSERT INTO loops (session_id, iid, start_seq, end_seq, iteration_count, line) VALUES (?, ?, ?, ?, ?, ?)',
                        l
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，${counts.length} 个 iid，检测到 ${loops.length} 个循环`, 100);
        this.emitDone(ctx, { iidCount: counts.length, loopCount: loops.length });
    }
}
