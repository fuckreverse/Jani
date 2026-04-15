/**
 * I3_ObfuscationDetector.mjs — 检测混淆特征
 *
 * 检测维度（共 7 类）：
 *  1. short_var              — 短/混淆风格变量名（_0x... 或 ≤3 字符）
 *  2. high_entropy_name      — 高 Shannon 熵变量名（随机混淆命名）
 *  3. string_decoder         — 字符串解密函数（多次调用返回不同字符串 + 全整数参数加强）
 *  4. obfuscated_control_flow— 控制流混淆（CFF/VMP 统一，保守策略）
 *  5. deep_call_stack        — 深调用栈（CFF/VMP dispatch 调用极深）
 *  6. string_pool            — 字符串池（大数组只读变量，经典字符串池混淆）
 *  7. dynamic_eval           — 动态代码执行（eval/Function 构造器调用）
 *  8. var_reuse              — 变量名重用率异常（同名变量频繁写入且值域极分散）
 *
 * 写入 obfuscation_hints 表。
 *
 * 注意：CFF（控制流平坦化）与 VMP（虚拟机保护）在动态运行数据层面
 *  特征高度重叠，难以可靠区分，统一用 'obfuscated_control_flow' 类型。
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

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

// ─── 熵阈值（延迟读取配置）─────────────────────────────────────────────────
let _entropyCfg = null;
function getEntropyThreshold() {
    if (_entropyCfg) return _entropyCfg;
    _entropyCfg = {
        threshold: cfg('plugins.I3_ObfuscationDetector.entropyThreshold'),
        minNameLength: cfg('plugins.I3_ObfuscationDetector.entropyMinNameLength'),
    };
    return _entropyCfg;
}

export default class I3ObfuscationDetector extends BasePlugin {
    static id = 'I3-ObfuscationDetector';
    static deps = ['F1-EventIndex', 'A3-HotPathAnalyzer'];
    static description = '检测混淆特征：短变量名、字符串解密函数、控制流混淆（CFF/VMP）、深调用栈、字符串池、动态 eval、变量名重用';
    static displayName = 'I3 · ObfuscationDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        // 在 run() 入口捕获配置
        const _varNameSampleLimit = cfg('plugins.I3_ObfuscationDetector.varNameSampleLimit');
        const _shortVarRatioThreshold = cfg('plugins.I3_ObfuscationDetector.shortVarRatioThreshold');
        const _shortVarAbsThreshold = cfg('plugins.I3_ObfuscationDetector.shortVarAbsThreshold');
        const _highEntropyCountThreshold = cfg('plugins.I3_ObfuscationDetector.highEntropyCountThreshold');
        const _decoderMinCalls = cfg('plugins.I3_ObfuscationDetector.decoderMinCalls');
        const _decoderMinDistinctRet = cfg('plugins.I3_ObfuscationDetector.decoderMinDistinctRet');
        const _sqlChunkSize = cfg('plugins.I3_ObfuscationDetector.sqlChunkSize');
        const _maxSamplesPerFunc = cfg('plugins.I3_ObfuscationDetector.maxSamplesPerFunc');
        const _minStringRetCount = cfg('plugins.I3_ObfuscationDetector.minStringRetCount');
        const _hotIidCountThreshold = cfg('plugins.I3_ObfuscationDetector.hotIidCountThreshold');
        const _hotIidQueryLimit = cfg('plugins.I3_ObfuscationDetector.hotIidQueryLimit');
        const _numericWriteMinCalls = cfg('plugins.I3_ObfuscationDetector.numericWriteMinCalls');
        const _numericWriteMinDistinctVals = cfg('plugins.I3_ObfuscationDetector.numericWriteMinDistinctVals');
        const _vmpAvgEventThreshold = cfg('plugins.I3_ObfuscationDetector.vmpAvgEventThreshold');
        const _deepStackMinCalls = cfg('plugins.I3_ObfuscationDetector.deepStackMinCalls');
        const _deepStackMaxDepthThreshold = cfg('plugins.I3_ObfuscationDetector.deepStackMaxDepthThreshold');
        const _deepStackAvgDepthThreshold = cfg('plugins.I3_ObfuscationDetector.deepStackAvgDepthThreshold');
        const _deepStackSevereThreshold = cfg('plugins.I3_ObfuscationDetector.deepStackSevereThreshold');
        const _deepStackHighThreshold = cfg('plugins.I3_ObfuscationDetector.deepStackHighThreshold');

        const entCfg = getEntropyThreshold();

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM obfuscation_hints WHERE session_id = ?', [sessionId]);

        const hints = [];

        // ── 1. 短/高熵变量名检测 ────────────────────────────────────────────
        this.emitProgress(ctx, '分析变量名...', 8);
        const varNames = db.all(
            `SELECT DISTINCT name FROM writes WHERE session_id = ? AND name IS NOT NULL LIMIT ${_varNameSampleLimit}`,
            [sessionId]
        );

        let shortVarCount = 0;
        let highEntropyCount = 0;
        for (const v of varNames) {
            if (isShortObfuscated(v.name)) shortVarCount++;
            if (entropy(v.name) > entCfg.threshold && v.name.length > entCfg.minNameLength) highEntropyCount++;
        }

        if (varNames.length > 0 && shortVarCount > varNames.length * _shortVarRatioThreshold && shortVarCount > _shortVarAbsThreshold) {
            hints.push([
                sessionId,
                'short_var',
                `发现 ${shortVarCount}/${varNames.length} 个疑似混淆短变量名（占比 ${Math.round(shortVarCount / varNames.length * 100)}%）`,
                null,
                null,
                Math.min(0.5 + shortVarCount / varNames.length * 0.5, 0.95),
                null, // fn_name
            ]);
        }

        if (highEntropyCount > _highEntropyCountThreshold) {
            hints.push([
                sessionId,
                'high_entropy_name',
                `发现 ${highEntropyCount} 个高熵变量名（Shannon entropy > 3.5），疑似随机混淆命名`,
                null,
                null,
                Math.min(0.3 + highEntropyCount * 0.05, 0.85),
                null, // fn_name
            ]);
        }

        // ── 2. 字符串解密函数检测（增强：全整数参数验证） ──────────────────
        this.emitProgress(ctx, '检测字符串解密函数...', 25);

        // 第一步：GROUP 筛选出候选函数（已有 HAVING 过滤）
        const callGroups = db.all(
            `SELECT fn_name, fn_iid, COUNT(*) as cnt, COUNT(DISTINCT return_value) as distinct_ret
             FROM call_edges
             WHERE session_id = ? AND return_value IS NOT NULL
             GROUP BY fn_name, fn_iid
             HAVING cnt >= ${_decoderMinCalls} AND distinct_ret >= ${_decoderMinDistinctRet}`,
            [sessionId]
        );

        if (callGroups.length > 0) {
            // 第二步：批量取所有候选函数的 return_value + args_json 样本
            const CHUNK = _sqlChunkSize;
            const fnNames = callGroups.map(cg => cg.fn_name).filter(Boolean);

            // "fn_name:fn_iid" → { retVals: string[], argSamples: string[] }
            // key 必须同时包含 fn_iid，否则同名不同位置的函数（fn_iid 不同）会共享同一条目，
            // 导致每个同名 callGroup 都能命中检测，产生描述相似的重复 hint。
            const fnDataMap = new Map();
            for (let i = 0; i < fnNames.length; i += CHUNK) {
                const chunk = fnNames.slice(i, i + CHUNK);
                const ph = chunk.map(() => '?').join(',');
                // 同时取 fn_iid，用于分桶到正确的 key
                const rows = rawDb.prepare(
                    `SELECT fn_name, fn_iid, return_value, args_json FROM call_edges
                     WHERE session_id = ? AND fn_name IN (${ph}) AND return_value IS NOT NULL
                     LIMIT ${chunk.length * 20}`
                ).all(sessionId, ...chunk);
                for (const r of rows) {
                    const key = `${r.fn_name}:${r.fn_iid ?? ''}`;
                    let entry = fnDataMap.get(key);
                    if (!entry) { entry = { retVals: [], argSamples: [] }; fnDataMap.set(key, entry); }
                    if (entry.retVals.length < _maxSamplesPerFunc) entry.retVals.push(r.return_value);
                    if (entry.argSamples.length < _maxSamplesPerFunc && r.args_json) entry.argSamples.push(r.args_json);
                }
            }

            for (const cg of callGroups) {
                const key = `${cg.fn_name}:${cg.fn_iid ?? ''}`;
                const entry = fnDataMap.get(key) || { retVals: [], argSamples: [] };
                const strRets = entry.retVals.filter(r => r && r.startsWith('"'));
                if (strRets.length >= _minStringRetCount) {
                    // ── 增强：检查参数是否全为整数索引 ────────────────────
                    // 字符串池解码器几乎全是 _0x1234(42) 形式——参数只有一个整数
                    let allIntegerArgs = false;
                    if (entry.argSamples.length >= 3) {
                        let intArgCount = 0;
                        for (const argsJson of entry.argSamples) {
                            try {
                                const args = JSON.parse(argsJson);
                                if (Array.isArray(args) && args.length === 1) {
                                    // args 元素格式为 {name, value} 或直接值字符串
                                    const arg = args[0];
                                    const val = typeof arg === 'object' && arg !== null
                                        ? String(arg.value ?? '')
                                        : String(arg ?? '');
                                    // 值是数字字符串（如 "42" 或带引号的数字）
                                    const num = Number(val.replace(/^"|"$/g, ''));
                                    if (!isNaN(num) && Number.isInteger(num)) intArgCount++;
                                }
                            } catch { /* ignore */ }
                        }
                        allIntegerArgs = intArgCount >= entry.argSamples.length * 0.8;
                    }

                    // 基础置信度 + 整数参数加成
                    const baseConf = Math.min(0.4 + strRets.length * 0.1, 0.90);
                    const conf = allIntegerArgs ? Math.min(baseConf + 0.1, 0.95) : baseConf;
                    const intNote = allIntegerArgs ? '（参数全为整数索引，高度符合字符串池解码器特征）' : '';

                    const fnLabel = cg.fn_name || `<匿名函数 iid=${cg.fn_iid ?? '?'}>`;
                    hints.push([
                        sessionId,
                        'string_decoder',
                        `函数 "${fnLabel}" 被调用 ${cg.cnt} 次，返回 ${cg.distinct_ret} 个不同字符串，疑似字符串解密函数${intNote}`,
                        cg.fn_iid,
                        null,
                        conf,
                        cg.fn_name || null, // fn_name，供前端跳转（匿名函数时为 null，不显示跳转按钮）
                    ]);
                }
            }
        }

        // ── 3. 控制流混淆检测（CFF/VMP 统一） ─────────────────────────────
        //
        // CFF（控制流平坦化）与 VMP（虚拟机保护）在运行时数据层面特征高度重叠：
        //  - CFF：大 while+switch 状态机，少量状态变量多值跳转
        //  - VMP：字节码解释器，单函数事件量极高，opcode 变量值域极大
        // 仅凭动态事件数据难以可靠区分，此处统一检测"状态机式控制流混淆"。
        this.emitProgress(ctx, '检测控制流混淆...', 42);
        const hotIids = db.all(
            `SELECT iid, count, line FROM iid_counts WHERE session_id = ? AND count >= ${_hotIidCountThreshold} ORDER BY count DESC LIMIT ${_hotIidQueryLimit}`,
            [sessionId]
        );

        if (hotIids.length > 0) {
            const numericWrites = db.all(
                `SELECT w.name, COUNT(*) as cnt, COUNT(DISTINCT w.value_id) as distinct_vals
                 FROM writes w
                 JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
                 WHERE w.session_id = ? AND vd.val_type = 'num'
                 GROUP BY w.name
                 HAVING cnt >= ${_numericWriteMinCalls} AND distinct_vals >= ${_numericWriteMinDistinctVals}`,
                [sessionId]
            );

            if (numericWrites.length >= 2 && hotIids.length >= 5) {
                const hotFn = db.get(
                    `SELECT AVG(own_event_count) as avg_ev
                     FROM call_edges
                     WHERE session_id = ? AND own_event_count IS NOT NULL
                     ORDER BY own_event_count DESC
                     LIMIT 1`,
                    [sessionId]
                );
                const avgHotEvents = hotFn?.avg_ev ?? 0;

                let tendencyNote = '';
                if (avgHotEvents > _vmpAvgEventThreshold) {
                    tendencyNote = '（最热函数事件量极高，可能为 VMP 虚拟机保护；但也可能是深度嵌套的 CFF，需结合源码判断）';
                } else {
                    tendencyNote = '（特征符合控制流平坦化 CFF；若存在字节码解释器循环也可能为 VMP，建议结合源码确认）';
                }

                hints.push([
                    sessionId,
                    'obfuscated_control_flow',
                    `发现 ${hotIids.length} 个热点 iid + ${numericWrites.length} 个多值数字变量，疑似控制流混淆（CFF/VMP 难以自动区分）${tendencyNote}`,
                    hotIids[0].iid,
                    hotIids[0].line,
                    Math.min(0.3 + numericWrites.length * 0.05, 0.75),
                    null, // fn_name
                ]);
            }
        }

        // ── 4. 深调用栈检测 ─────────────────────────────────────────────────
        //
        // CFF/VMP 会制造极深的调用栈：CFF 的 dispatch 函数互相调用，
        // VMP 的字节码解释器每执行一条指令就可能调用一层。
        // 正常代码的调用深度通常 < 30；混淆代码 > 50 是强信号。
        this.emitProgress(ctx, '检测深调用栈...', 55);
        const depthStats = db.get(
            `SELECT MAX(depth) as max_depth, AVG(depth) as avg_depth, COUNT(*) as total_calls
             FROM call_edges
             WHERE session_id = ? AND depth IS NOT NULL`,
            [sessionId]
        );

        if (depthStats && depthStats.total_calls >= _deepStackMinCalls) {
            const maxDepth = depthStats.max_depth ?? 0;
            const avgDepth = depthStats.avg_depth ?? 0;

            if (maxDepth >= _deepStackMaxDepthThreshold && avgDepth >= _deepStackAvgDepthThreshold) {
                // 取最深调用帧的信息供前端定位
                const deepestCall = db.get(
                    `SELECT fn_name, fn_iid, caller_line, depth
                     FROM call_edges
                     WHERE session_id = ? AND depth = ?
                     LIMIT 1`,
                    [sessionId, maxDepth]
                );

                let note = '';
                if (maxDepth >= _deepStackSevereThreshold) {
                    note = '（调用深度极高，强烈疑似 VMP 虚拟机保护或深度递归混淆）';
                } else if (maxDepth >= _deepStackHighThreshold) {
                    note = '（调用深度很高，疑似 CFF/VMP 或重度递归混淆）';
                } else {
                    note = '（调用深度偏高，可能为 CFF 控制流平坦化或深度递归代码）';
                }

                const conf = maxDepth >= _deepStackSevereThreshold ? 0.85
                    : maxDepth >= _deepStackHighThreshold ? 0.75
                    : 0.60;

                hints.push([
                    sessionId,
                    'deep_call_stack',
                    `最大调用深度 ${maxDepth}（均值 ${avgDepth.toFixed(1)}），共 ${depthStats.total_calls} 次调用${note}`,
                    deepestCall?.fn_iid ?? null,
                    deepestCall?.caller_line ?? null,
                    conf,
                    deepestCall?.fn_name ?? null,
                ]);
            }
        }

        // ── 5. 字符串池检测 ─────────────────────────────────────────────────
        //
        // 混淆器经典手法：把所有字符串集中存入一个大数组，通过下标索引访问。
        // 运行时特征：某变量读取次数 >> 写入次数（几乎只读），且值是一个较大的数组。
        // 用 var_lifetime 的 read_count / write_count 比值识别，
        // 再结合 value_dict 确认值是 JSON 数组形式。
        this.emitProgress(ctx, '检测字符串池...', 68);
        const poolCandidates = db.all(
            `SELECT vl.name, vl.read_count, vl.write_count,
                    vd.val_text, vd.val_type
             FROM var_lifetime vl
             JOIN writes w   ON w.session_id = vl.session_id AND w.name = vl.name
             JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
             WHERE vl.session_id = ?
               AND vl.write_count <= 3
               AND vl.read_count >= 20
               AND vd.val_type = 'str'
             GROUP BY vl.name
             HAVING COUNT(*) > 0
             ORDER BY vl.read_count DESC
             LIMIT 20`,
            [sessionId]
        );

        for (const pc of poolCandidates) {
            // 值必须是 JSON 数组字符串（val_text 以 "[" 开头）
            const valText = pc.val_text ?? '';
            if (!valText.startsWith('"[') && !valText.startsWith('[')) continue;

            // 去除外层 JSON 引号后尝试解析
            let innerText = valText;
            try { innerText = JSON.parse(valText); } catch { /* 保持原值 */ }

            let arr = null;
            try { arr = JSON.parse(innerText); } catch { /* not array */ }
            if (!Array.isArray(arr) || arr.length < 10) continue;

            // 进一步验证：数组元素中字符串占比 >= 60%（字符串池）
            const strCount = arr.filter(x => typeof x === 'string').length;
            if (strCount < arr.length * 0.6) continue;

            const ratio = pc.write_count > 0 ? pc.read_count / pc.write_count : pc.read_count;
            const conf = Math.min(0.5 + Math.log10(ratio + 1) * 0.15, 0.88);

            hints.push([
                sessionId,
                'string_pool',
                `变量 "${pc.name}" 含 ${arr.length} 个字符串元素，被读取 ${pc.read_count} 次而仅写入 ${pc.write_count} 次（读写比 ${ratio.toFixed(0)}:1），疑似字符串池`,
                null,
                null,
                conf,
                null, // fn_name
            ]);
            break; // 只报一个最典型的字符串池变量，避免噪音
        }

        // ── 6. 动态代码执行检测（eval / new Function） ──────────────────────
        //
        // 混淆代码常在运行时用 eval() 或 new Function() 动态解密并执行代码段。
        // call_edges 里 fn_name = 'eval' 或 'Function' 即为直接证据。
        // 注意区分：正常代码也可能合法使用 eval，结合调用次数和其他混淆信号判断。
        this.emitProgress(ctx, '检测动态代码执行...', 78);
        const evalCalls = db.all(
            `SELECT fn_name, COUNT(*) as cnt, MIN(caller_line) as first_line, MIN(fn_iid) as fn_iid
             FROM call_edges
             WHERE session_id = ?
               AND (fn_name = 'eval' OR fn_name = 'Function' OR fn_name = 'new Function')
             GROUP BY fn_name`,
            [sessionId]
        );

        if (evalCalls.length > 0) {
            const totalEvalCnt = evalCalls.reduce((s, r) => s + r.cnt, 0);
            const evalNames = evalCalls.map(r => `${r.fn_name}(${r.cnt}次)`).join('、');

            // 调用次数越多置信度越高（1 次可能是正常用法，10+ 次更疑似混淆）
            const conf = Math.min(0.35 + Math.log10(totalEvalCnt + 1) * 0.25, 0.85);

            const firstEval = evalCalls[0];
            hints.push([
                sessionId,
                'dynamic_eval',
                `检测到动态代码执行：${evalNames}，共 ${totalEvalCnt} 次。混淆代码常用 eval/Function 在运行时解密并执行代码段`,
                firstEval.fn_iid ?? null,
                firstEval.first_line ?? null,
                conf,
                firstEval.fn_name, // fn_name，供前端跳转函数面板
            ]);
        }

        // ── 7. 变量名重用率异常检测 ─────────────────────────────────────────
        //
        // 混淆器为了混淆会在不同作用域复用同一个短变量名（a/b/c/i/j 等），
        // 导致同名变量的写入次数极高，且写入的值种类极多（不同作用域的不同值被聚合）。
        // 信号：高写入次数 + 高值种类数（distinct value_id 占比 > 50%）的短变量名。
        this.emitProgress(ctx, '检测变量名重用异常...', 88);
        const reuseVars = db.all(
            `SELECT w.name,
                    COUNT(*) as write_count,
                    COUNT(DISTINCT w.value_id) as distinct_vals
             FROM writes w
             WHERE w.session_id = ?
               AND w.name IS NOT NULL
               AND LENGTH(w.name) <= 3
             GROUP BY w.name
             HAVING write_count >= 50 AND distinct_vals >= 20
                AND CAST(distinct_vals AS REAL) / write_count > 0.3
             ORDER BY write_count DESC
             LIMIT 10`,
            [sessionId]
        );

        if (reuseVars.length >= 3) {
            // 至少 3 个这样的短变量同时满足条件，才认为是系统性混淆而非偶然
            const totalWrites = reuseVars.reduce((s, v) => s + v.write_count, 0);
            const varList = reuseVars.slice(0, 5).map(v =>
                `"${v.name}"(${v.write_count}次/${v.distinct_vals}值)`
            ).join('、');

            const conf = Math.min(0.3 + reuseVars.length * 0.06, 0.70);

            hints.push([
                sessionId,
                'var_reuse',
                `发现 ${reuseVars.length} 个短变量名被大量重用：${varList}，合计写入 ${totalWrites} 次。多作用域复用短变量名是混淆的常见手法`,
                null,
                null,
                conf,
                null, // fn_name
            ]);
        }

        // ── 写入所有 hints ───────────────────────────────────────────────────
        this.emitProgress(ctx, `写入 ${hints.length} 个混淆特征...`, 95);

        if (hints.length > 0) {
            db.transaction(() => {
                for (const hint of hints) {
                    db.run(
                        'INSERT INTO obfuscation_hints (session_id, hint_type, description, iid, line, confidence, fn_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        hint
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，发现 ${hints.length} 个混淆特征`, 100);

        // 计算综合混淆评分（confidence 加权均值，映射到 0-100）
        const obfuscationScore = hints.length > 0
            ? Math.round(hints.reduce((s, h) => s + (h[5] ?? 0), 0) / hints.length * 100)
            : 0;

        this.emitDone(ctx, { hintCount: hints.length, obfuscationScore });
    }
}
