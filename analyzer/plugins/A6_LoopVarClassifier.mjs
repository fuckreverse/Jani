/**
 * A6_LoopVarClassifier.mjs — 循环变量角色分类器
 *
 * 依赖：A5-LoopDetector（loop_iterations 表已填充）
 *
 * 功能：
 *   对每个循环，遍历所有迭代的变量快照（vars_snapshot.w 写快照），
 *   分析每个变量跨迭代的值序列，推断其"角色"：
 *
 *   角色枚举（role 字段）：
 *     counter_inc  — 严格单调递增的数值（典型计数器 i++）
 *     counter_dec  — 严格单调递减的数值（倒计数 i--）
 *     accumulator  — 数值，非单调但持续变化（累加器 sum += x）
 *     oscillator   — 数值，交替或周期性变化（flag 翻转、取模计数）
 *     state        — 字符串/布尔类型，每次迭代值不同（状态机变量）
 *     constant     — 每次迭代值完全相同（循环不变量）
 *     sparse       — 出现次数 < 总迭代数的 50%（稀疏变量，仅部分迭代赋值）
 *
 * 输出：写入 loop_var_roles 表：
 *   loop_id, var_name, role, first_val, last_val,
 *   min_val, max_val, distinct_count, present_count, total_iters
 *
 * 性能设计：
 *   - 按循环逐个处理，每次只加载当前循环所有迭代的 vars_snapshot（JSON字段）
 *   - 单事务批量写入，无 N+1
 *   - 总处理量：max 5000 循环 × 500 次迭代 × ~10 变量 = 2500万次比较，< 5s
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

// ── 角色常量 ──────────────────────────────────────────────────────────────────

export const ROLE = {
    COUNTER_INC:  'counter_inc',
    COUNTER_DEC:  'counter_dec',
    ACCUMULATOR:  'accumulator',
    OSCILLATOR:   'oscillator',
    STATE:        'state',
    CONSTANT:     'constant',
    SPARSE:       'sparse',
};

/**
 * 对一个变量的值序列推断角色。
 *
 * @param {string[]} vals     — 按迭代顺序的值字符串（已过滤 null/undefined）
 * @param {number}   presentCount — 出现次数（含 null 的原始迭代数）
 * @param {number}   totalIters   — 总迭代数
 * @returns {string} role
 */
function classifyValues(vals, presentCount, totalIters) {
    // 稀疏：出现次数 < 总迭代数的 50%
    if (presentCount < totalIters * 0.5) return ROLE.SPARSE;

    if (vals.length < 2) return ROLE.CONSTANT;

    // 尝试全部解析为数字
    const nums = vals.map(v => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    });

    const allNumeric = nums.every(n => n !== null);

    if (allNumeric) {
        const ns = nums;
        const min = Math.min(...ns);
        const max = Math.max(...ns);

        // 常量（数值完全相同）
        if (min === max) return ROLE.CONSTANT;

        // 严格单调递增
        let strictInc = true;
        let strictDec = true;
        for (let i = 1; i < ns.length; i++) {
            if (ns[i] <= ns[i - 1]) strictInc = false;
            if (ns[i] >= ns[i - 1]) strictDec = false;
            if (!strictInc && !strictDec) break;
        }
        if (strictInc) return ROLE.COUNTER_INC;
        if (strictDec) return ROLE.COUNTER_DEC;

        // 趋势性增减（非严格单调，但方向性明显）
        // 判断为 accumulator（累加型）：大部分步骤同向变化
        let incSteps = 0, decSteps = 0;
        for (let i = 1; i < ns.length; i++) {
            if (ns[i] > ns[i - 1]) incSteps++;
            else if (ns[i] < ns[i - 1]) decSteps++;
        }
        const totalSteps = ns.length - 1;
        const dominance = Math.max(incSteps, decSteps) / totalSteps;
        if (dominance >= 0.7) return ROLE.ACCUMULATOR;

        // 否则视为振荡型（周期/交替变化）
        return ROLE.OSCILLATOR;
    }

    // 非数值类型
    const uniqueVals = new Set(vals);
    if (uniqueVals.size === 1) return ROLE.CONSTANT;

    // 字符串/布尔：每次都变 → state
    return ROLE.STATE;
}

export default class A6LoopVarClassifier extends BasePlugin {
    static id          = 'A6-LoopVarClassifier';
    static deps        = ['A5-LoopDetector'];
    static description = '分析循环变量跨迭代角色（计数器↑↓ / 累加器 / 振荡器 / 状态变量 / 常量 / 稀疏）';
    static displayName = 'A6 · LoopVarClassifier';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        const _maxLoops        = cfg('plugins.A6_LoopVarClassifier.maxLoops');
        const _loopBatchSize   = cfg('plugins.A6_LoopVarClassifier.loopBatchSize');
        const _minIters        = cfg('plugins.A6_LoopVarClassifier.minIters');
        const _insertBatchSize = cfg('plugins.A6_LoopVarClassifier.insertBatchSize');

        this.emitProgress(ctx, '清空旧数据...', 0);

        // ── 建表（幂等）────────────────────────────────────────────────────
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS loop_var_roles (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id      TEXT NOT NULL,
                loop_id         INTEGER NOT NULL,
                var_name        TEXT NOT NULL,
                role            TEXT NOT NULL,
                first_val       TEXT,
                last_val        TEXT,
                min_val         REAL,
                max_val         REAL,
                distinct_count  INTEGER NOT NULL DEFAULT 0,
                present_count   INTEGER NOT NULL DEFAULT 0,
                total_iters     INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_lvr_session_loop
                ON loop_var_roles(session_id, loop_id);
            CREATE INDEX IF NOT EXISTS idx_lvr_session_role
                ON loop_var_roles(session_id, role);
        `);
        rawDb.prepare('DELETE FROM loop_var_roles WHERE session_id = ?').run(sessionId);

        // ── 加载循环列表（按迭代次数降序，只处理有足够迭代的循环）───────────
        const loops = rawDb.prepare(
            `SELECT id, iteration_count FROM loops
             WHERE session_id = ? AND iteration_count >= ?
             ORDER BY iteration_count DESC
             LIMIT ?`
        ).all(sessionId, _minIters, _maxLoops);

        if (loops.length === 0) {
            this.emitProgress(ctx, '无可分析循环', 100);
            this.emitDone(ctx, { loopCount: 0, varRoleCount: 0 });
            return;
        }

        this.emitProgress(ctx, `分析 ${loops.length} 个循环的变量角色...`, 5);

        // ── 预编译语句 ────────────────────────────────────────────────────
        const stmtIters = rawDb.prepare(
            `SELECT iteration_idx, vars_snapshot
             FROM loop_iterations
             WHERE session_id = ? AND loop_id = ?
             ORDER BY iteration_idx ASC`
        );
        const stmtInsert = rawDb.prepare(
            `INSERT INTO loop_var_roles
                (session_id, loop_id, var_name, role, first_val, last_val,
                 min_val, max_val, distinct_count, present_count, total_iters)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertBatch = rawDb.transaction((rows) => {
            for (const r of rows) stmtInsert.run(r);
        });

        let totalRoles = 0;
        let pending    = [];

        const flush = () => {
            if (pending.length === 0) return;
            insertBatch(pending);
            totalRoles += pending.length;
            pending = [];
        };

        // ── 逐循环分析 ───────────────────────────────────────────────────
        for (let i = 0; i < loops.length; i++) {
            if (i % _loopBatchSize === 0) {
                this.emitProgress(
                    ctx,
                    `分析循环 ${i + 1}/${loops.length}，已得 ${totalRoles} 个角色...`,
                    5 + Math.floor((i / loops.length) * 90)
                );
            }

            const loop = loops[i];
            const iterRows = stmtIters.all(sessionId, loop.id);
            if (iterRows.length < _minIters) continue;

            const totalIters = iterRows.length;

            // 收集每个变量的值序列
            // varMap: varName → { vals: string[], presentCount: number }
            const varMap = new Map();

            for (const row of iterRows) {
                let snap;
                try {
                    snap = typeof row.vars_snapshot === 'string'
                        ? JSON.parse(row.vars_snapshot)
                        : row.vars_snapshot;
                } catch {
                    continue;
                }
                if (!snap) continue;

                // 只分析写快照（w 字段）——写快照代表循环真实修改的变量
                const wSnap = (snap.v === 2 ? snap.w : snap) ?? {};

                for (const [name, val] of Object.entries(wSnap)) {
                    if (!varMap.has(name)) varMap.set(name, { vals: [], presentCount: 0 });
                    const entry = varMap.get(name);
                    entry.presentCount++;
                    if (val != null) entry.vals.push(String(val));
                }
            }

            // 对每个变量推断角色
            for (const [varName, { vals, presentCount }] of varMap) {
                if (vals.length === 0) continue;

                const role = classifyValues(vals, presentCount, totalIters);

                // 计算统计量
                const distinctCount = new Set(vals).size;
                const firstVal      = vals[0];
                const lastVal       = vals[vals.length - 1];

                let minVal = null, maxVal = null;
                const nums = vals.map(v => Number(v)).filter(n => Number.isFinite(n));
                if (nums.length === vals.length && nums.length > 0) {
                    minVal = Math.min(...nums);
                    maxVal = Math.max(...nums);
                }

                pending.push([
                    sessionId,
                    loop.id,
                    varName,
                    role,
                    firstVal,
                    lastVal,
                    minVal,
                    maxVal,
                    distinctCount,
                    presentCount,
                    totalIters,
                ]);

                if (pending.length >= _insertBatchSize) flush();
            }
        }

        flush();

        this.emitProgress(ctx, `完成，分析 ${loops.length} 个循环，得 ${totalRoles} 个变量角色`, 100);
        this.emitDone(ctx, {
            loopCount:    loops.length,
            varRoleCount: totalRoles,
        });
    }
}
