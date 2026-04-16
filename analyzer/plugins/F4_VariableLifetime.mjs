/**
 * F4_VariableLifetime.mjs — 统计变量生命周期
 *
 * scope_id 感知（v3 格式）：
 *  - 按 (name, scope_id) 分组，区分同名但不同调用帧/作用域的变量
 *  - scope_id=NULL 的记录表示 v1/v2 旧数据或全局变量，单独聚合为一组
 *  - var_lifetime 表新增 scope_id 列记录作用域 ID
 *
 * 性能优化（重递归场景）：
 *  - 主路径：全量下推到 SQLite（INSERT ... SELECT ... LEFT JOIN），完全绕开 JS 层内存
 *  - 统计量（varCount/totalWrites/totalReads）也改为 SQL 聚合查询，不再载入行数据
 *  - 彻底消除极端重递归时 (name × scope_id) 百万级行全量加载到 JS 内存的瓶颈
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
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM var_lifetime WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '统计并写入 var_lifetime...', 10);

        // ── 主路径：全量在 SQLite 内完成统计 + 合并 + INSERT ──────────────────
        //
        // 等价逻辑（原 JS 实现）：
        //   writes 分组（name, scope_id）→ first_write_seq, write_count
        //   reads  分组（name, scope_id）→ last_read_seq,  read_count
        //   按 (name, scope_id) LEFT JOIN 合并两侧，生成 var_lifetime 行
        //
        // FULL OUTER JOIN 模拟：
        //   SQLite 不支持 FULL OUTER JOIN，用 UNION ALL + COALESCE 模拟：
        //   写侧 LEFT JOIN 读侧（覆盖有写/有写且有读两种情况）
        //   UNION ALL
        //   读侧 LEFT JOIN 写侧 WHERE 写侧 IS NULL（仅读不写的变量）
        //
        // 注意：NULL 在 GROUP BY/JOIN 中视为相同值（SQLite 规范），
        //       即两边 scope_id=NULL 的记录能正确匹配。

        rawDb.transaction(() => {
            rawDb.exec(`
                INSERT INTO var_lifetime
                    (session_id, name, scope_id, first_write_seq, last_read_seq, write_count, read_count)

                -- 有写（可能也有读）
                SELECT
                    ? AS session_id,
                    w.name,
                    w.scope_id,
                    MIN(w.event_id)     AS first_write_seq,
                    MAX(r.event_id)     AS last_read_seq,
                    COUNT(DISTINCT w.id) AS write_count,
                    COUNT(DISTINCT r.id) AS read_count
                FROM writes w
                LEFT JOIN reads r
                    ON r.session_id = w.session_id
                   AND r.name       = w.name
                   AND (r.scope_id  = w.scope_id
                        OR (r.scope_id IS NULL AND w.scope_id IS NULL))
                WHERE w.session_id = ? AND w.name IS NOT NULL
                GROUP BY w.name, w.scope_id

                UNION ALL

                -- 只有读，没有对应写
                SELECT
                    ? AS session_id,
                    r.name,
                    r.scope_id,
                    NULL                AS first_write_seq,
                    MAX(r.event_id)     AS last_read_seq,
                    0                   AS write_count,
                    COUNT(DISTINCT r.id) AS read_count
                FROM reads r
                WHERE r.session_id = ? AND r.name IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM writes w2
                      WHERE w2.session_id = r.session_id
                        AND w2.name       = r.name
                        AND (w2.scope_id  = r.scope_id
                             OR (w2.scope_id IS NULL AND r.scope_id IS NULL))
                  )
                GROUP BY r.name, r.scope_id
            `.trim(), [sessionId, sessionId, sessionId, sessionId]);
        })();

        this.emitProgress(ctx, '统计汇总...', 90);

        // ── 统计量：也全部在 SQL 中聚合，不再读行到 JS ────────────────────────
        const stats = rawDb.prepare(`
            SELECT
                COUNT(*)            AS varCount,
                SUM(write_count)    AS totalWrites,
                SUM(read_count)     AS totalReads
            FROM var_lifetime
            WHERE session_id = ?
        `).get(sessionId);

        const varCount    = stats?.varCount    ?? 0;
        const totalWrites = stats?.totalWrites ?? 0;
        const totalReads  = stats?.totalReads  ?? 0;

        this.emitProgress(ctx, `完成，共 ${varCount} 个变量`, 100);
        this.emitDone(ctx, { varCount, totalWrites, totalReads });
    }
}
