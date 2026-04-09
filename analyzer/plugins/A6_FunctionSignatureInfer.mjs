/**
 * A6_FunctionSignatureInfer.mjs — 聚合函数调用记录，推断纯函数性
 * 统计参数/返回值类型分布，写入 fn_signatures 表
 *
 * 性能优化：
 *  - 使用 rawDb prepared statement + 单事务批量写入
 *  - 纯函数检测：同名函数调用极多时提前 break
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 2000;
// 每个函数最多保留的调用记录数（超过此数的函数调用量太多，is_pure 检测截断）
const MAX_CALLS_PER_FN = 5000;

function inferType(value) {
    if (value === null || value === undefined) return 'null';
    const s = String(value).trim();
    const stripped = s.replace(/^"|"$/g, '');
    if (stripped === 'null') return 'null';
    if (stripped === 'undefined') return 'undefined';
    if (stripped === 'true' || stripped === 'false') return 'boolean';
    if (!isNaN(Number(stripped)) && stripped !== '') return 'number';
    if (stripped.startsWith('{') || stripped.startsWith('[')) return 'object';
    if (s.startsWith('"') || s.startsWith("'")) return 'string';
    return 'string';
}

export default class A6FunctionSignatureInfer extends BasePlugin {
    static id = 'A6-FunctionSignatureInfer';
    static deps = ['F3-CallGraphBuilder'];
    static description = '聚合函数调用记录，推断纯函数性，统计参数/返回值类型分布';
    static displayName = 'A6 · FunctionSignatureInfer';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        rawDb.prepare('DELETE FROM fn_signatures WHERE session_id = ?').run(sessionId);

        this.emitProgress(ctx, '读取 call_edges...', 10);
        const edges = rawDb.prepare(
            'SELECT fn_name, fn_iid, args_json, return_value FROM call_edges WHERE session_id = ?'
        ).all(sessionId);

        if (edges.length === 0) {
            this.emitProgress(ctx, '无调用数据，跳过', 100);
            this.emitDone(ctx, { fnCount: 0 });
            return;
        }

        this.emitProgress(ctx, `处理 ${edges.length} 条调用记录...`, 20);

        // 按 fn_name + fn_iid 分组（内存计算，截断超大调用量函数）
        const fnMap = new Map();
        for (const e of edges) {
            const key = `${e.fn_name}|${e.fn_iid}`;
            if (!fnMap.has(key)) {
                fnMap.set(key, {
                    fn_name: e.fn_name,
                    fn_iid: e.fn_iid,
                    calls: [],
                    truncated: false,
                });
            }
            const fn = fnMap.get(key);
            if (fn.calls.length < MAX_CALLS_PER_FN) {
                let args = [];
                try { args = JSON.parse(e.args_json || '[]'); } catch {}
                fn.calls.push({ args, ret: e.return_value });
            } else {
                fn.truncated = true;
            }
        }

        this.emitProgress(ctx, `分析 ${fnMap.size} 个函数签名...`, 40);

        const stmt = rawDb.prepare(
            'INSERT INTO fn_signatures (session_id, fn_name, fn_iid, call_count, is_pure, arg_types, return_types, sample_args, sample_return) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const insertBatch = rawDb.transaction((batch) => {
            for (const row of batch) stmt.run(row);
        });

        const rows = [];
        for (const [, fn] of fnMap) {
            const { calls } = fn;
            const callCount = calls.length;

            // 参数类型分布
            const maxArgLen = calls.reduce((m, c) => Math.max(m, Array.isArray(c.args) ? c.args.length : 0), 0);
            const argTypes = [];
            for (let i = 0; i < maxArgLen; i++) {
                const types = {};
                for (const c of calls) {
                    const argVal = Array.isArray(c.args)
                        ? (c.args[i] !== undefined ? (c.args[i]?.value ?? c.args[i]) : undefined)
                        : undefined;
                    const t = inferType(argVal);
                    types[t] = (types[t] || 0) + 1;
                }
                argTypes.push(types);
            }

            // 返回值类型分布
            const retTypes = {};
            for (const c of calls) {
                const t = inferType(c.ret);
                retTypes[t] = (retTypes[t] || 0) + 1;
            }

            // 纯函数检测（截断函数标记为不纯）
            let isPure = 0;
            if (!fn.truncated && callCount >= 2) {
                const inputRetMap = new Map();
                let pure = true;
                for (const c of calls) {
                    const inputKey = JSON.stringify(c.args);
                    if (inputRetMap.has(inputKey)) {
                        if (inputRetMap.get(inputKey) !== c.ret) {
                            pure = false;
                            break;
                        }
                    } else {
                        inputRetMap.set(inputKey, c.ret);
                    }
                }
                isPure = pure ? 1 : 0;
            }

            const sample = calls[calls.length - 1];
            rows.push([
                sessionId,
                fn.fn_name,
                fn.fn_iid,
                callCount,
                isPure,
                JSON.stringify(argTypes),
                JSON.stringify(retTypes),
                JSON.stringify(sample ? sample.args : []),
                sample ? (sample.ret ?? null) : null,
            ]);

            if (rows.length >= BATCH_SIZE) {
                insertBatch(rows.splice(0));
                this.emitProgress(ctx, `已写入签名...`, 60);
            }
        }

        if (rows.length > 0) insertBatch(rows);

        this.emitProgress(ctx, `完成，${fnMap.size} 个函数签名`, 100);
        this.emitDone(ctx, { fnCount: fnMap.size });
    }
}
