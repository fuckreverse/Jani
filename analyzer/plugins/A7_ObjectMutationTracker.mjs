/**
 * A7_ObjectMutationTracker.mjs — 按 (base_oid, offset) 重建对象属性变化时间线
 * 写入 object_timelines 表
 *
 * 聚合 key = `#${base_oid}\x00${offset}`（精确追踪同一对象实例）
 * base_oid 为 null 的 field 条目（primitive / OID 未知）直接跳过。
 *
 * 方向五（短期）：从 smap 获取 src_text（源码片段），写入 object_timelines.src_text
 * 方向三（长期）：从 oid_aliases 表查询变量名，将 base_var 格式化为 '<name> (#<oid>)'
 *
 * 性能优化：
 *  - batch_size 1000 → 5000
 *  - 使用 prepared statement + 事务批量写入
 *  - oid_aliases 查询：一次性加载到内存 Map，O(1) 查询
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

export default class A7ObjectMutationTracker extends BasePlugin {
    static observes = ['F2-SmapLoader'];
    static id = 'A7-ObjectMutationTracker';
    static deps = ['F1-EventIndex'];
    static description = '按 (base_oid, offset) 重建对象属性变化时间线，写入 object_timelines 表';
    static displayName = 'A7 · ObjectMutationTracker';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        // 在 run() 入口捕获配置
        const _batchSize = cfg('plugins.A7_ObjectMutationTracker.batchSize');

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM object_timelines WHERE session_id = ?', [sessionId]);

        // ── 方向三：从 oid_aliases 加载 OID → 变量名映射（内存 Map，O(1) 查询）──
        this.emitProgress(ctx, '加载 OID 别名...', 3);
        // 每个 OID 可能有多个变量名，取 event_id 最小（最早出现）的那个
        const oidAliasRows = db.all(
            `SELECT oid, var_name
             FROM oid_aliases
             WHERE session_id = ?
             ORDER BY event_id ASC`,
            [sessionId]
        );
        // Map<oid, varName>（只取第一个，即 event_id 最小的）
        const oidToVar = new Map();
        for (const row of oidAliasRows) {
            if (!oidToVar.has(row.oid)) {
                oidToVar.set(row.oid, row.var_name);
            }
        }

        this.emitProgress(ctx, '读取 fields 表...', 5);
        const fields = db.all(
            `SELECT f.event_id, f.offset, vd.val_text AS value, f.value_id, f.is_write, f.base_oid,
                    s.sl AS line, s.src_text
             FROM fields f
             LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
             JOIN events e ON f.event_id = e.id AND e.session_id = f.session_id
             LEFT JOIN smap s ON s.session_id = f.session_id AND s.iid = e.iid
             WHERE f.session_id = ? AND f.base_oid IS NOT NULL
             ORDER BY f.event_id ASC`,
            [sessionId]
        );

        if (fields.length === 0) {
            this.emitProgress(ctx, '无 field 数据，跳过', 100);
            this.emitDone(ctx, { timelineCount: 0 });
            return;
        }

        this.emitProgress(ctx, `处理 ${fields.length} 条 field 记录...`, 20);

        // 用 value_id（整数）作为快照 key 进行变化検测。
        // 字符串比较慢且可能被截断（旧架构 value 列限制 512 字符），改用 value_id 整数比较更准确。
        // 必要时取 val_text 展示完整值。
        const lastValueIds = new Map(); // `#${base_oid}\x00${offset}` → {id: value_id, text: val_text}
        let rows = [];
        let totalWritten = 0;

        const stmt = rawDb.prepare(
            'INSERT INTO object_timelines (session_id, base_var, offset_key, change_seq, old_value, new_value, line, is_write, src_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
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

        /**
         * 格式化 base_var：
         *   - 有别名时：'<varName> (#<oid>)'，如 'myObj (#42)'
         *   - 无别名时：'#<oid>'（保持原有行为）
         */
        const formatBaseVar = (oid) => {
            const varName = oidToVar.get(oid);
            return varName ? `${varName} (#${oid})` : `#${oid}`;
        };

        let processed = 0;
        for (const f of fields) {
            if (f.offset === null || f.offset === undefined) continue;

            const key     = `#${f.base_oid}\x00${f.offset}`;
            const baseVar = formatBaseVar(f.base_oid);
            const prev    = lastValueIds.get(key);  // {id, text} | undefined

            if (f.is_write) {
                // 用 value_id 整数比较变化（比字符串比较更快且无截断问题）
                if (prev?.id !== f.value_id) {
                    rows.push([
                        sessionId,
                        baseVar,
                        String(f.offset),
                        f.event_id,
                        prev !== undefined ? prev.text : null,
                        f.value,
                        f.line,
                        1,
                        f.src_text ?? null,
                    ]);
                    lastValueIds.set(key, { id: f.value_id, text: f.value });
                }
            } else {
                rows.push([
                    sessionId,
                    baseVar,
                    String(f.offset),
                    f.event_id,
                    prev !== undefined ? prev.text : null,
                    f.value,
                    f.line,
                    0,
                    f.src_text ?? null,
                ]);
            }

            processed++;
            if (rows.length >= _batchSize) {
                flush();
                const pct = Math.min(90, 20 + Math.round((processed / fields.length) * 70));
                this.emitProgress(ctx, `已写入 ${totalWritten} 条时间线记录...`, pct);
            }
        }
        flush();

        const aggRow = db.get(
            'SELECT COUNT(DISTINCT base_var) AS obj_count, COUNT(*) AS change_count FROM object_timelines WHERE session_id = ?',
            [sessionId]
        );
        const objCount    = aggRow?.obj_count    ?? 0;
        const changeCount = aggRow?.change_count ?? 0;
        this.emitProgress(ctx, `完成，${changeCount} 条时间线记录`, 100);
        this.emitDone(ctx, { objCount, changeCount });
    }
}
