/**
 * F4_VariableLifetime.mjs — 统计变量生命周期
 *
 * 性能优化：
 *  - 用 Map 替代 writeStats.find()（O(N²) → O(1)）
 *  - 使用 prepared statement + 单事务批量 INSERT
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 5000;

export default class F4VariableLifetime extends BasePlugin {
    static id = 'F4-VariableLifetime';
    static deps = ['F1-EventIndex'];
    static description = '统计每个变量的首次写入/最后读取/读写次数，写入 var_lifetime 表';
    static displayName = 'F4 · VariableLifetime';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

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

        // 合并：用 Map 代替 O(N) find
        this.emitProgress(ctx, '写入 var_lifetime 表...', 70);
        const readMap  = new Map(readStats.map(r => [r.name, r]));
        const writeMap = new Map(writeStats.map(w => [w.name, w]));

        const stmt = rawDb.prepare(
            `INSERT INTO var_lifetime (session_id, name, first_write_seq, last_read_seq, write_count, read_count)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const stmtIgnore = rawDb.prepare(
            `INSERT OR IGNORE INTO var_lifetime (session_id, name, first_write_seq, last_read_seq, write_count, read_count)
             VALUES (?, ?, NULL, ?, 0, ?)`
        );

        const insertBatch = rawDb.transaction((writes, reads) => {
            for (const w of writes) {
                const r = readMap.get(w.name);
                stmt.run(sessionId, w.name, w.first_write_seq, r?.last_read_seq ?? null, w.write_count, r?.read_count ?? 0);
            }
            // 只有 read 没有 write 的变量
            for (const r of reads) {
                if (!writeMap.has(r.name)) {
                    stmtIgnore.run(sessionId, r.name, r.last_read_seq, r.read_count);
                }
            }
        });

        // 分批执行（超大数据集时避免单事务过重）
        const CHUNK = BATCH_SIZE;
        for (let i = 0; i < writeStats.length; i += CHUNK) {
            // 首批同时处理 read-only 变量，后续批次传空数组
            const readChunk = i === 0 ? readStats : [];
            insertBatch(writeStats.slice(i, i + CHUNK), readChunk);
            if (i > 0 || writeStats.length > CHUNK) {
                this.emitProgress(ctx,
                    `已写入 ${Math.min(i + CHUNK, writeStats.length)}/${writeStats.length} 个变量...`,
                    70 + Math.round((i / writeStats.length) * 25)
                );
            }
        }
        // 如果 writeStats 为空，read-only 变量还没处理
        if (writeStats.length === 0 && readStats.length > 0) {
            insertBatch([], readStats);
        }

        this.emitProgress(ctx, `完成，共 ${writeStats.length} 个变量`, 100);

        // 统计总读写次数（writeStats/readStats 在内存中，O(N) 求和）
        const totalWrites = writeStats.reduce((s, w) => s + (w.write_count || 0), 0);
        const totalReads  = readStats.reduce((s, r) => s + (r.read_count  || 0), 0);
        const varCount    = writeStats.length + readStats.filter(r => !writeStats.some(w => w.name === r.name)).length;

        this.emitDone(ctx, { varCount, totalWrites, totalReads });
    }
}
