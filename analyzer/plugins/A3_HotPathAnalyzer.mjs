/**
 * A3_HotPathAnalyzer.mjs — 统计 iid 执行频率，检测循环
 *
 * 性能优化：
 *  - 用一次窗口查询（带 lag）替代 N 次单行 SELECT event_id
 *  - 避免对每个热点 iid 单独发出 SELECT 查询
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 2000;

export default class A3HotPathAnalyzer extends BasePlugin {
    static id = 'A3-HotPathAnalyzer';
    static deps = ['F1-EventIndex'];
    static description = '统计各 iid 执行次数，检测循环，写入 iid_counts/loops 表';
    static displayName = 'A3 · HotPathAnalyzer';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM iid_counts WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM loops WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '统计 iid 执行次数...', 5);

        // 统计每个 iid 的执行次数
        // line/src_text 已从 events 移除（Phase D），改从 smap 按 iid 查询
        const counts = db.all(
            `SELECT e.iid, COUNT(*) as count, s.sl AS line, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE e.session_id = ? AND e.iid IS NOT NULL
             GROUP BY e.iid
             ORDER BY count DESC`,
            [sessionId]
        );

        this.emitProgress(ctx, `${counts.length} 个 iid，批量写入统计...`, 30);

        // 批量写入 iid_counts（prepared statement，单事务）
        const insertIid = rawDb.prepare(
            'INSERT OR REPLACE INTO iid_counts (session_id, iid, count, line, src_text) VALUES (?, ?, ?, ?, ?)'
        );
        const insertIidBatch = rawDb.transaction((batch) => {
            for (const c of batch) insertIid.run(sessionId, c.iid, c.count, c.line, c.src_text);
        });

        for (let i = 0; i < counts.length; i += BATCH_SIZE) {
            insertIidBatch(counts.slice(i, i + BATCH_SIZE));
        }

        this.emitProgress(ctx, '检测循环...', 60);

        // ── 核心优化：一次性取出所有 count >= 3 的 iid 的所有 event id ──────
        // 用窗口函数计算相邻间距，直接在 SQL 层面做分段
        const hotIids = counts.filter(c => c.count >= 3).map(c => c.iid);

        const loops = [];
        const THRESHOLD = 50;

        if (hotIids.length > 0) {
            // 一次性全表扫描，JS 侧按热点 iid 过滤（比分批 IN 查询更高效）
            const hotIidSet = new Set(hotIids);
            // iid → sorted event_id[]
            const iidSeqs = new Map();
            {
                const rows = rawDb.prepare(
                    'SELECT iid, id FROM events WHERE session_id = ? AND iid IS NOT NULL ORDER BY iid ASC, id ASC'
                ).all(sessionId);
                for (const r of rows) {
                    if (!hotIidSet.has(r.iid)) continue;
                    let arr = iidSeqs.get(r.iid);
                    if (!arr) { arr = []; iidSeqs.set(r.iid, arr); }
                    arr.push(r.id);
                }
            }

            // 在内存中按 THRESHOLD 切段
            for (const hot of counts.filter(c => c.count >= 3)) {
                const seqs = iidSeqs.get(hot.iid);
                if (!seqs || seqs.length < 3) continue;

                let segStart = seqs[0];
                let segPrev  = seqs[0];
                let segCount = 1;

                for (let i = 1; i < seqs.length; i++) {
                    const gap = seqs[i] - segPrev;
                    if (gap <= THRESHOLD) {
                        segCount++;
                        segPrev = seqs[i];
                    } else {
                        if (segCount >= 3) {
                            loops.push([sessionId, hot.iid, segStart, segPrev, segCount, hot.line]);
                        }
                        segStart = seqs[i];
                        segPrev  = seqs[i];
                        segCount = 1;
                    }
                }
                if (segCount >= 3) {
                    loops.push([sessionId, hot.iid, segStart, segPrev, segCount, hot.line]);
                }
            }
        }

        // 写入 loops
        if (loops.length > 0) {
            const insertLoop = rawDb.prepare(
                'INSERT INTO loops (session_id, iid, start_seq, end_seq, iteration_count, line) VALUES (?, ?, ?, ?, ?, ?)'
            );
            const insertLoopBatch = rawDb.transaction((batch) => {
                for (const l of batch) insertLoop.run(...l);
            });
            for (let i = 0; i < loops.length; i += BATCH_SIZE) {
                insertLoopBatch(loops.slice(i, i + BATCH_SIZE));
            }
        }

        this.emitProgress(ctx, `完成，${counts.length} 个 iid，检测到 ${loops.length} 个循环`, 100);
        this.emitDone(ctx, { iidCount: counts.length, loopCount: loops.length });
    }
}
