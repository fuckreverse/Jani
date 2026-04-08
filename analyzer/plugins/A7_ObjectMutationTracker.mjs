/**
 * A7_ObjectMutationTracker.mjs — 按 (base, offset) 重建对象属性变化时间线
 * 写入 object_timelines 表
 *
 * 性能优化：
 *  - batch_size 1000 → 5000
 *  - 使用 prepared statement + 事务批量写入
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 5000;

export default class A7ObjectMutationTracker extends BasePlugin {
    static id = 'A7-ObjectMutationTracker';
    static deps = ['F1-EventIndex'];
    static description = '按 (base, offset) 重建对象属性变化时间线，写入 object_timelines 表';
    static displayName = 'A7 · ObjectMutationTracker';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM object_timelines WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '读取 fields 表...', 5);
        const fields = db.all(
            `SELECT f.event_id, f.base, f.offset, f.value, f.is_write, e.line
             FROM fields f
             JOIN events e ON f.event_id = e.id AND e.session_id = f.session_id
             WHERE f.session_id = ?
             ORDER BY f.event_id ASC`,
            [sessionId]
        );

        if (fields.length === 0) {
            this.emitProgress(ctx, '无 field 数据，跳过', 100);
            this.emitDone(ctx, { timelineCount: 0 });
            return;
        }

        this.emitProgress(ctx, `处理 ${fields.length} 条 field 记录...`, 20);

        const lastValues = new Map(); // key=`${base}\x00${offset}` → lastValue
        let rows = [];
        let totalWritten = 0;

        const stmt = rawDb.prepare(
            'INSERT INTO object_timelines (session_id, base_var, offset_key, change_seq, old_value, new_value, line, is_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const flushRows = rawDb.transaction((batch) => {
            for (const row of batch) stmt.run(...row);
        });

        const flush = () => {
            if (rows.length === 0) return;
            flushRows(rows);
            totalWritten += rows.length;
            rows = [];
        };

        let processed = 0;
        for (const f of fields) {
            if (f.base === null || f.base === undefined) continue;
            if (f.offset === null || f.offset === undefined) continue;

            const key  = `${f.base}\x00${f.offset}`;
            const prev = lastValues.get(key);

            if (f.is_write) {
                if (prev !== f.value) {
                    rows.push([
                        sessionId,
                        String(f.base),
                        String(f.offset),
                        f.event_id,
                        prev !== undefined ? prev : null,
                        f.value,
                        f.line,
                        1,
                    ]);
                    lastValues.set(key, f.value);
                }
            } else {
                rows.push([
                    sessionId,
                    String(f.base),
                    String(f.offset),
                    f.event_id,
                    prev !== undefined ? prev : null,
                    f.value,
                    f.line,
                    0,
                ]);
            }

            processed++;
            if (rows.length >= BATCH_SIZE) {
                flush();
                const pct = Math.min(90, 20 + Math.round((processed / fields.length) * 70));
                this.emitProgress(ctx, `已写入 ${totalWritten} 条时间线记录...`, pct);
            }
        }
        flush();

        const total = db.get('SELECT COUNT(*) as cnt FROM object_timelines WHERE session_id = ?', [sessionId]);
        const cnt = total ? total.cnt : 0;
        this.emitProgress(ctx, `完成，${cnt} 条时间线记录`, 100);
        this.emitDone(ctx, { timelineCount: cnt });
    }
}
