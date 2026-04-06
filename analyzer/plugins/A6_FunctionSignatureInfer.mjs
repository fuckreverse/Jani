/**
 * A6_FunctionSignatureInfer.mjs — 聚合函数调用记录，推断纯函数性
 * 统计参数/返回值类型分布，写入 fn_signatures 表
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

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

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM fn_signatures WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '读取 call_edges...', 10);
        const edges = db.all(
            'SELECT fn_name, fn_iid, args_json, return_value FROM call_edges WHERE session_id = ?',
            [sessionId]
        );

        if (edges.length === 0) {
            this.emitProgress(ctx, '无调用数据，跳过', 100);
            this.emitDone(ctx, { fnCount: 0 });
            return;
        }

        this.emitProgress(ctx, `处理 ${edges.length} 条调用记录...`, 20);

        // 按 fn_name + fn_iid 分组
        const fnMap = new Map();
        for (const e of edges) {
            const key = `${e.fn_name}|${e.fn_iid}`;
            if (!fnMap.has(key)) {
                fnMap.set(key, {
                    fn_name: e.fn_name,
                    fn_iid: e.fn_iid,
                    calls: [],
                });
            }
            let args = [];
            try { args = JSON.parse(e.args_json || '[]'); } catch {}
            fnMap.get(key).calls.push({ args, ret: e.return_value });
        }

        this.emitProgress(ctx, `分析 ${fnMap.size} 个函数签名...`, 40);

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
                    const argVal = Array.isArray(c.args) ? (c.args[i] !== undefined ? (c.args[i]?.value ?? c.args[i]) : undefined) : undefined;
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

            // 纯函数检测：相同参数是否总返回相同值
            let isPure = 0;
            if (callCount >= 2) {
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
        }

        this.emitProgress(ctx, `写入 ${rows.length} 个函数签名...`, 80);

        if (rows.length > 0) {
            db.transaction(() => {
                for (const row of rows) {
                    db.run(
                        'INSERT INTO fn_signatures (session_id, fn_name, fn_iid, call_count, is_pure, arg_types, return_types, sample_args, sample_return) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        row
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，${rows.length} 个函数签名`, 100);
        this.emitDone(ctx, { fnCount: rows.length });
    }
}
