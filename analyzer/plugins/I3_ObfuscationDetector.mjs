/**
 * I3_ObfuscationDetector.mjs — 检测混淆特征
 * 检测变量名熵值、字符串解密函数特征、控制流平坦化
 * 写入 obfuscation_hints 表
 *
 * 性能优化：
 *  - string_decoder 检测：用 GROUP BY + HAVING 子查询预筛选，
 *    再一次批量取 return_value 样本，消除 N 次单行查询
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

// 计算字符串熵（越高 = 越随机 = 越像混淆名）
function entropy(s) {
    if (!s || s.length === 0) return 0;
    const freq = {};
    for (const c of s) freq[c] = (freq[c] || 0) + 1;
    let h = 0;
    for (const count of Object.values(freq)) {
        const p = count / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

function isShortObfuscated(name) {
    if (!name) return false;
    if (/^_0x[0-9a-fA-F]+/.test(name)) return true;
    if (name.length <= 3 && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return true;
    return false;
}

export default class I3ObfuscationDetector extends BasePlugin {
    static id = 'I3-ObfuscationDetector';
    static deps = ['F1-EventIndex', 'A3-HotPathAnalyzer'];
    static description = '检测混淆特征：短变量名、字符串解密函数、控制流平坦化';
    static displayName = 'I3 · ObfuscationDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM obfuscation_hints WHERE session_id = ?', [sessionId]);

        const hints = [];

        // ── 1. 短/高熵变量名检测 ────────────────────────────────────────────
        this.emitProgress(ctx, '分析变量名...', 10);
        const varNames = db.all(
            'SELECT DISTINCT name FROM writes WHERE session_id = ? AND name IS NOT NULL LIMIT 2000',
            [sessionId]
        );

        let shortVarCount = 0;
        let highEntropyCount = 0;
        for (const v of varNames) {
            if (isShortObfuscated(v.name)) shortVarCount++;
            if (entropy(v.name) > 3.5 && v.name.length > 4) highEntropyCount++;
        }

        if (varNames.length > 0 && shortVarCount > varNames.length * 0.3 && shortVarCount > 5) {
            hints.push([
                sessionId,
                'short_var',
                `发现 ${shortVarCount}/${varNames.length} 个疑似混淆短变量名（占比 ${Math.round(shortVarCount / varNames.length * 100)}%）`,
                null,
                null,
                Math.min(0.5 + shortVarCount / varNames.length * 0.5, 0.95),
            ]);
        }

        if (highEntropyCount > 5) {
            hints.push([
                sessionId,
                'high_entropy_name',
                `发现 ${highEntropyCount} 个高熵变量名（Shannon entropy > 3.5），疑似随机混淆命名`,
                null,
                null,
                Math.min(0.3 + highEntropyCount * 0.05, 0.85),
            ]);
        }

        // ── 2. 字符串解密函数检测（优化：批量取 return_value，消除 N 次查询）──
        this.emitProgress(ctx, '检测字符串解密函数...', 40);

        // 第一步：GROUP 筛选出候选函数（已有 HAVING 过滤）
        const callGroups = db.all(
            `SELECT fn_name, fn_iid, COUNT(*) as cnt, COUNT(DISTINCT return_value) as distinct_ret
             FROM call_edges
             WHERE session_id = ? AND return_value IS NOT NULL
             GROUP BY fn_name, fn_iid
             HAVING cnt >= 5 AND distinct_ret >= 3`,
            [sessionId]
        );

        if (callGroups.length > 0) {
            // 第二步：一次批量取所有候选函数的 return_value 样本（最多 20 条/函数）
            // 用 fn_name IN (...) 批量取，比 N 次单独查询快很多
            const CHUNK = 900;
            const fnNames = callGroups.map(cg => cg.fn_name).filter(Boolean);

            // fn_name → return_value[]
            const retValMap = new Map();
            for (let i = 0; i < fnNames.length; i += CHUNK) {
                const chunk = fnNames.slice(i, i + CHUNK);
                const ph = chunk.map(() => '?').join(',');
                const rows = rawDb.prepare(
                    `SELECT fn_name, return_value FROM call_edges
                     WHERE session_id = ? AND fn_name IN (${ph}) AND return_value IS NOT NULL
                     LIMIT ${chunk.length * 20}`
                ).all(sessionId, ...chunk);
                for (const r of rows) {
                    let arr = retValMap.get(r.fn_name);
                    if (!arr) { arr = []; retValMap.set(r.fn_name, arr); }
                    if (arr.length < 20) arr.push(r.return_value);
                }
            }

            for (const cg of callGroups) {
                const retVals = retValMap.get(cg.fn_name) || [];
                const strRets = retVals.filter(r => r && r.startsWith('"'));
                if (strRets.length >= 3) {
                    hints.push([
                        sessionId,
                        'string_decoder',
                        `函数 "${cg.fn_name}" 被调用 ${cg.cnt} 次，返回 ${cg.distinct_ret} 个不同字符串，疑似字符串解密函数`,
                        cg.fn_iid,
                        null,
                        Math.min(0.4 + strRets.length * 0.1, 0.90),
                    ]);
                }
            }
        }

        // ── 3. 控制流平坦化检测 ──────────────────────────────────────────────
        this.emitProgress(ctx, '检测控制流平坦化...', 70);
        const hotIids = db.all(
            'SELECT iid, count, line FROM iid_counts WHERE session_id = ? AND count >= 10 ORDER BY count DESC LIMIT 50',
            [sessionId]
        );

        if (hotIids.length > 0) {
            const numericWrites = db.all(
                `SELECT name, COUNT(*) as cnt, COUNT(DISTINCT value) as distinct_vals
                 FROM writes
                 WHERE session_id = ? AND value IS NOT NULL
                   AND value NOT LIKE '"%"'
                   AND value NOT LIKE 'null'
                   AND value NOT LIKE 'undefined'
                   AND value NOT LIKE 'true'
                   AND value NOT LIKE 'false'
                 GROUP BY name
                 HAVING cnt >= 5 AND distinct_vals >= 3`,
                [sessionId]
            );

            if (numericWrites.length >= 2 && hotIids.length >= 5) {
                hints.push([
                    sessionId,
                    'flat_control_flow',
                    `发现 ${hotIids.length} 个热点 iid + ${numericWrites.length} 个多值数字变量，疑似控制流平坦化（状态机跳转）`,
                    hotIids[0].iid,
                    hotIids[0].line,
                    Math.min(0.3 + numericWrites.length * 0.05, 0.75),
                ]);
            }
        }

        // ── 写入所有 hints ───────────────────────────────────────────────────
        this.emitProgress(ctx, `写入 ${hints.length} 个混淆特征...`, 90);

        if (hints.length > 0) {
            db.transaction(() => {
                for (const hint of hints) {
                    db.run(
                        'INSERT INTO obfuscation_hints (session_id, hint_type, description, iid, line, confidence) VALUES (?, ?, ?, ?, ?, ?)',
                        hint
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，发现 ${hints.length} 个混淆特征`, 100);
        this.emitDone(ctx, { hintCount: hints.length });
    }
}
