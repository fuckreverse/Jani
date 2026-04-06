/**
 * F4_VariableLifetime.mjs — 统计变量生命周期
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class F4VariableLifetime extends BasePlugin {
    static id = 'F4-VariableLifetime';
    static deps = ['F1-EventIndex'];
    static description = '统计每个变量的首次写入/最后读取/读写次数，写入 var_lifetime 表';
    static displayName = 'F4 · VariableLifetime';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM var_lifetime WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '统计 writes...', 10);

        // 从 writes 统计
        const writeStats = db.all(
            `SELECT name, MIN(event_id) as first_write_seq, COUNT(*) as write_count
             FROM writes
             WHERE session_id = ? AND name IS NOT NULL
             GROUP BY name`,
            [sessionId]
        );

        this.emitProgress(ctx, '统计 reads...', 40);

        // 从 reads 统计
        const readStats = db.all(
            `SELECT name, MAX(event_id) as last_read_seq, COUNT(*) as read_count
             FROM reads
             WHERE session_id = ? AND name IS NOT NULL
             GROUP BY name`,
            [sessionId]
        );

        // 合并
        this.emitProgress(ctx, '写入 var_lifetime 表...', 70);
        const readMap = new Map(readStats.map(r => [r.name, r]));

        db.transaction(() => {
            for (const w of writeStats) {
                const r = readMap.get(w.name);
                db.run(
                    `INSERT INTO var_lifetime (session_id, name, first_write_seq, last_read_seq, write_count, read_count)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [sessionId, w.name, w.first_write_seq, r?.last_read_seq ?? null, w.write_count, r?.read_count ?? 0]
                );
            }
            // 只有 read 没有 write 的变量
            for (const r of readStats) {
                if (!writeStats.find(w => w.name === r.name)) {
                    db.run(
                        `INSERT OR IGNORE INTO var_lifetime (session_id, name, first_write_seq, last_read_seq, write_count, read_count)
                         VALUES (?, ?, NULL, ?, 0, ?)`,
                        [sessionId, r.name, r.last_read_seq, r.read_count]
                    );
                }
            }
        });

        this.emitProgress(ctx, `完成，共 ${writeStats.length} 个变量`, 100);
        this.emitDone(ctx, { varCount: writeStats.length });
    }
}
