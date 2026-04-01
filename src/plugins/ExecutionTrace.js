// JALANGI DO NOT INSTRUMENT

/**
 * @file ExecutionTrace —— 按语句粒度输出执行 trace，便于 LLM 分析。
 *
 * 粒度说明：
 *   - **语句级追踪**：每个表达式语句输出一行，包含语句文本和所有涉及的变量值。
 *   - 变量值包括：被写入的变量（执行后的值）+ 被读取的变量（当前值）。
 *   - 对于函数调用语句，CALL/RETN 仍独立输出（便于追踪调用栈）。
 *   - 配合 pluginAnalyzer 自动推导的按需 Config，插桩代码中只存在
 *     J$.W / J$.G / J$.P / J$.F / J$.M / J$.Xe 等钩子
 *     （方案F+C：不再需要 J$.R 变量读取插桩）。
 *
 * 输出格式（平铺流式，无调用栈缩进，每个事件立即输出）：
 *
 *   [     1] [     1:1] ▶ script: /path/to/file.js
 *   [     2] [     1:1] CALL foo(2 args) {"a":[...]}
 *   [     3] [     1:1] RETN foo {"v":42}
 *   [     4] [     2:1] x = 1 + 2 {"w":{"x":3},"r":{"y":1}}
 *   [     5] [     3:1] ◀ script end
 *
 * kv 部分以结构化 JSON 输出（便于离线工具解析）：
 *   CALL 行：{"a":[arg0, arg1, ...], "this": ...}
 *   RETN 行：{"v": returnValue}
 *   expr 行：{"w":{写入变量}, "r":{读取变量}, "f":[属性访问]}
 *
 * 如需树形/缩进展示，使用离线工具 trace-render.mjs（接受 trace-parse.mjs 输出）：
 *   cat trace.ndjson | node tools/trace-parse.mjs | node tools/trace-render.mjs --format tree
 *
 * 用法：
 *   import { ExecutionTraceAnalysis } from './ExecutionTrace.js';
 *   const logger = new TraceLogger({ useIdb: true });
 *   J$.analysis = new ExecutionTraceAnalysis(J$, originalSourceCode, { logger });
 *
 * 若不传 logger，会自动根据选项创建：
 *   J$.analysis = new ExecutionTraceAnalysis(J$, null, {
 *     useIdb: true, dbName: 'my-db', storeName: 'trace'
 *   });
 *
 * 自动配置推导（无需手写 Config）：
 *   import { init } from '../instrument/esnstrument.js';
 *   const analysis = new ExecutionTraceAnalysis(J$, src, opts);
 *   init(null, undefined, undefined, undefined, [analysis]);
 *
 * 诊断日志（直接输出到 console，不走 TraceLogger/IDB）：
 *  - JALANGI_DEBUG=analysis（Node.js）或 localStorage.jalangiDebug='analysis'（浏览器）开启 debug 级别
 *  - JALANGI_DEBUG=1 或 * 开启所有域
 *  - error/warn 级别（栈帧不匹配、未预期异常等）始终输出
 */

import { TraceLogger } from '../logger/TraceLogger.js';
import { createDiagLogger, DOMAIN } from '../logger/diagnostics.js';
import { serialize, serializeJson } from '../utils/serialize.js';
import {
    fmtSeq,
    FlatFormatter,
} from '../utils/traceFormatters.js';
import {
    $push as _push, $join as _join, $map as _map, $filter as _filter,
    $splice as _splice, $pop as _pop,
    $isArray, $keys, $strSplit, $strReplace, $strSlice, $strTrim,
} from '../runtime/NativeProxy.js';

const dbg = createDiagLogger(DOMAIN.ANALYSIS);

// 运行时使用的格式化器（唯一实例）
const fmt = new FlatFormatter();

// ── 工具 ─────────────────────────────────────────────────────────────────────

function getLocation(sandbox, iid) {
    const smap = sandbox?.smap;
    if (!smap) return null;
    // smap 结构可能是：
    // 1. smap["filename"] = { iid: [sl,sc,el,ec], code: "...", ... } （插桩器注入，多文件场景）
    // 2. smap[iid_string] = [sl,sc,el,ec] （扁平格式，单文件默认）
    // 3. smap[number] = { iid: [sl,sc,el,ec], ... } （运行时按 sid 存储）

    // 优先尝试扁平格式：直接用 iid 作为 key
    const directEntry = smap[iid] ?? smap[String(iid)];
    if ($isArray(directEntry) && directEntry.length >= 4) {
        return directEntry;
    }

    // 尝试按 sid 查找（多文件场景）
    const sidEntry = smap[sandbox.sid];
    if (sidEntry && typeof sidEntry === 'object' && !$isArray(sidEntry)) {
        const arr = sidEntry[iid];
        if ($isArray(arr) && arr.length >= 4) return arr;
    }

    // 遍历查找：某些嵌套结构（如 smap["filename"] = { iid: [...] }）
    for (const key of $keys(smap)) {
        if (key === 'nBranches' || key === 'originalCodeFileName' || key === 'instrumentedCodeFileName') continue;
        const val = smap[key];
        if (!val || typeof val !== 'object') continue;
        if ($isArray(val)) {
            // 扁平格式已在前面处理，这里跳过
            continue;
        }
        const arr = val[iid];
        if ($isArray(arr) && arr.length >= 4) return arr;
    }
    return null;
}

function extractSource(lines, loc) {
    if (!lines || !loc) return '';
    // loc 格式：[startLine, startCol, endLine, endCol]
    // Babel：行号从 1 开始（1-indexed），列号从 0 开始（0-indexed）
    const [sl, sc, el, ec] = loc;
    const startLine = Math.max(sl - 1, 0);
    if (startLine >= lines.length) return '';
    const line = lines[startLine];
    // sc/ec 均为 1-indexed（存储时做了 column+1），转换为 0-indexed
    const startCol = Math.max(sc - 1, 0);
    // 若起止在同一行，用 ec 精确截取：ec 是 1-indexed，ec-1 是最后字符的 0-indexed，
    // JS slice end 是 exclusive，所以用 ec-1（等同于原始 Babel 的 0-indexed end.column）
    let text;
    if (el === sl && ec != null && ec > sc) {
        text = $strSlice(line, startCol, ec - 1);
    } else {
        text = $strSlice(line, startCol);
    }
    // 压缩空白并限制最大长度，避免过长输出
    text = $strTrim($strReplace(text, /\s+/g, ' '));
    const MAX_LEN = 48;
    if (text.length > MAX_LEN) {
        text = text.substring(0, MAX_LEN - 1) + '…';
    }
    return text;
}

/**
 * 将属性访问的 base 对象序列化为简短类型标记，避免大数组/对象展开。
 *   数组  → "[…N]"（N 为长度）
 *   对象  → "{…}"
 *   其他  → 直接 serialize（数字/字符串/null 等）
 */
function _shortBase(base) {
    if (base === null || base === undefined) return serialize(base);
    if ($isArray(base)) return `[…${base.length}]`;
    if (typeof base === 'object') return '{…}';
    return serialize(base);
}


// ── 分析类 ───────────────────────────────────────────────────────────────────

export class ExecutionTraceAnalysis {
    /**
     * @param {object} [sandbox]      J$ 全局对象
     * @param {string} [sourceCode]   原始源码文本（可选，用于提取源码片段）
     * @param {object} [options]
     *
     * === 日志后端（三选一，优先级从高到低）===
     * @param {TraceLogger} [options.logger]
     *   直接传入已构造好的 TraceLogger 实例
     *
     * @param {boolean} [options.useIdb=false]
     * @param {string}  [options.dbName='jalangi-traces']
     * @param {string}  [options.storeName='execution-trace']
     * @param {string}  [options.wsUrl]
     * @param {boolean} [options.wsSab=false]     使用 SharedArrayBuffer 模式（需 COOP/COEP header）
     * @param {boolean} [options.wsWorker=true]   将 WebSocket 移到 Worker 线程
     * @param {string}  [options.wsFormat]        消息格式 'binary'|'ndjson'
     * @param {string|false} [options.nodeFile='jalangi-trace.ndjson']
     * @param {boolean} [options.nodeConsole=false]
     */
    constructor(sandbox, sourceCode, options = {}) {
        this._sb    = sandbox;
        this._seq   = 0;
        this._lines = sourceCode ? $strSplit(sourceCode, /\r\n|\r|\n/) : null;

        // 调用栈元数据（只用于配对 CALL/RETN，不做树形缓冲）
        this._callStack = [];

        // 缓冲当前语句的变量 kv（writeVar/returnStmt/throwStmt 暂存于此，
        // 由 endExpression 统一合并成一行输出，避免每个 writeVar 单独输出一行）
        this._pendingKvs = [];
        // 方案F：缓冲当前语句的变量读取值，由 endExpression 从 useNames/useValues 填充
        this._pendingReads = [];
        // 方案C：缓冲当前语句的属性读写（getField/putField 暂存于此）
        this._pendingFields = [];

        // functionEnter/functionExit 嵌套追踪栈（区分 callPre 覆盖路径 vs 直接调用路径）
        this._flatFnStack = [];

        if (options.logger instanceof TraceLogger) {
            this._logger = options.logger;
        } else {
            const {
                useIdb = false, dbName, storeName, wsUrl,
                wsSab, wsWorker, wsFormat,
                nodeFile, nodeConsole,
                logManagerOptions,
            } = options;
            this._logger = new TraceLogger({
                useIdb,
                ...(dbName      != null && { dbName }),
                ...(storeName   != null && { storeName }),
                ...(wsUrl       != null && { wsUrl }),
                ...(wsSab       !== undefined && { wsSab }),
                ...(wsWorker    !== undefined && { wsWorker }),
                ...(wsFormat    !== undefined && { wsFormat }),
                ...(nodeFile    !== undefined && { nodeFile }),
                ...(nodeConsole !== undefined && { nodeConsole }),
                keyToConsole: true,
                // 透传 LogManager 选项（如验证用的 forceSyncFlushThreshold）
                ...(logManagerOptions != null && { logManagerOptions }),
            });
        }

        this._loggerReady = this._logger.init();
        this._loggerReady.catch(err => {
            dbg.error('TraceLogger init error:', err.message, err.stack ?? '');
        });

        if (sandbox) {
            sandbox.tracer = this._logger;
        }
    }

    // ── 内部辅助 ──────────────────────────────────────────────────────────────

    _key(level, text) {
        this._logger.key(level, text);
    }

    /** emit 已格式化好的一行（seq 由调用侧 ++this._seq 分配，再传进来）*/
    _emitRaw(text) {
        this._logger.trace({ type: 'trace', seq: this._seq, text });
    }

    /** 分配新 seq 并 emit 一行（key 级别事件用）*/
    _emitKeyLine(text) {
        this._emitRaw(`[${fmtSeq(++this._seq)}] ${text}`);
    }

    /** 根据 iid 获取位置信息 */
    _loc(iid) {
        const loc = getLocation(this._sb, iid);
        const rc  = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        return { loc, rc };
    }

    /** 将 kv 对象序列化为合法 JSON 字符串（委托 serializeJson，安全处理宿主对象） */
    _serializeKvObj(kvObj) {
        return serializeJson(kvObj);
    }

    // ── 函数调用边界 ──────────────────────────────────────────────────────────

    callPre(iid, f, base, args, isConstructor, isMethod) {
        const name   = f?.name || '(anonymous)';
        const prefix = isConstructor ? 'new ' : '';
        const desc   = isMethod
            ? `.${name}(${args.length} args)`
            : `${prefix}${name}(${args.length} args)`;

        const { rc } = this._loc(iid);

        // 构建 kv 对象（结构化）
        const kvObj = {};
        if (isMethod && base !== undefined) kvObj.this = base;
        if (args && args.length > 0) kvObj.a = args;

        // 在调用前保存当前语句积累的 pending 上下文（防止被调函数内部的钩子污染）。
        // 例如：外层语句 `x = foo(y)` 调用 foo，foo 内部的 writeVar/putField 钩子
        // 会向 _pendingKvs/_pendingFields 推入数据，如不隔离会混入外层语句的 trace。
        _push(this._callStack, {
            rc, desc, name, kvObj,
            savedKvs:    this._pendingKvs,
            savedReads:  this._pendingReads,
            savedFields: this._pendingFields,
        });
        // 清空，确保被调函数内部积累的 pending 不会污染外层语句
        this._pendingKvs    = [];
        this._pendingReads  = [];
        this._pendingFields = [];

        // 立即输出 CALL 行
        const line = fmt.callLineJson(++this._seq, rc, 0, desc, this._serializeKvObj(kvObj));
        this._emitRaw(line);
        return { f, base, args, skip: false };
    }

    call(iid, f, base, args, result, isConstructor, isMethod) {
        if (this._callStack.length === 0) {
            const name = f?.name || '(anonymous)';
            dbg.error(`call: callStack underflow — fn=${name} iid=${iid}`);
            return { result };
        }
        const callInfo = _pop(this._callStack);
        const name   = callInfo.name ?? (f?.name || '(anonymous)');

        // 恢复外层语句的 pending 上下文，丢弃被调函数内部积累的 pending
        this._pendingKvs    = callInfo.savedKvs;
        this._pendingReads  = callInfo.savedReads;
        this._pendingFields = callInfo.savedFields;

        const { rc } = this._loc(iid);
        const line = fmt.retLineJson(++this._seq, rc, 0, name, this._serializeKvObj({ v: result }));
        this._emitRaw(line);
        this._logger.scheduleFlush?.();
        return { result };
    }

    // ── 脚本进出 ──────────────────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        // 若构造时未传 sourceCode（this._lines 为 null），
        // 尝试从 smap 内联的 code 字段补充（inlineSource:true 时有值）。
        if (this._sb?.smap) {
            const sid = this._sb.sid;
            const entry = this._sb.smap[sid] ?? this._sb.smap[instrumentedFileName];
            if (entry?.code) {
                this._lines = $strSplit(entry.code, /\r\n|\r|\n/);
                dbg.debug(`scriptEnter: loaded ${this._lines.length} source lines from smap (sid=${sid})`);
            }
        }

        this._emitKeyLine(`▶ script: ${originalFileName}`);
        this._key('info', `▶ script: ${originalFileName}`);
    }

    scriptExit(iid, wrappedExceptionVal) {
        const exitText = wrappedExceptionVal
            ? `◀ script end (exception: ${serialize(wrappedExceptionVal.exception)})`
            : `◀ script end`;
        this._emitKeyLine(exitText);
        if (wrappedExceptionVal) {
            this._key('error', exitText);
        } else {
            this._key('info', exitText);
        }
        return { wrappedExceptionVal, isBacktrack: false };
    }

    functionEnter(iid, f, dis, args) {
        // 追踪每次 functionEnter 是否已由 callPre 覆盖（有 callPre 则不重复 emit CALL）
        const topCall = this._callStack.length > 0
            ? this._callStack[this._callStack.length - 1]
            : null;

        if (topCall && !topCall._feCovered) {
            // 已有 callPre 对应的记录，标记为已覆盖，不再重复 emit CALL
            topCall._feCovered = true;
            _push(this._flatFnStack, { _coveredByCallPre: true });
        } else {
            // 无 callPre：native 直接调用（脚本退出后的异步回调），emit CALL 行
            const name = f?.name || '(anonymous)';
            const { rc } = this._loc(iid);
            const callMeta = { rc, desc: `${name}(${args?.length ?? 0} args)`, name };
            _push(this._callStack, {
                ...callMeta,
                _directFe: true,
                savedKvs:    this._pendingKvs,
                savedReads:  this._pendingReads,
                savedFields: this._pendingFields,
            });
            this._pendingKvs    = [];
            this._pendingReads  = [];
            this._pendingFields = [];
            _push(this._flatFnStack, { _coveredByCallPre: false });
            const line = fmt.callLine(++this._seq, rc, 0, callMeta.desc, '');
            this._emitRaw(line);
        }
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        if (wrappedExceptionVal) {
            const exStr  = serialize(wrappedExceptionVal.exception);
            const { rc } = this._loc(iid);
            const line = fmt.infoLine(++this._seq, rc, 0, '✗ throw', `exception=${exStr}`);
            this._emitRaw(line);
            this._key('warn', `[${rc}] ✗ throw ; exception=${exStr}`);
        }

        const fnEntry = _pop(this._flatFnStack);
        if (fnEntry && !fnEntry._coveredByCallPre) {
            // 对应 _directFe 路径（无 callPre），需要输出 RETN 行
            if (this._callStack.length > 0) {
                const callInfo = _pop(this._callStack);
                const name   = callInfo.name ?? '(anonymous)';
                // 恢复外层 pending
                this._pendingKvs    = callInfo.savedKvs    ?? [];
                this._pendingReads  = callInfo.savedReads  ?? [];
                this._pendingFields = callInfo.savedFields ?? [];
                const { rc } = this._loc(iid);
                const line = fmt.retLineJson(++this._seq, rc, 0, name, this._serializeKvObj({ v: returnVal }));
                this._emitRaw(line);
                this._logger.scheduleFlush?.();
            }
        }
        // 对应 callPre 覆盖路径：RETN 行已在 call() 里输出，此处无需额外处理

        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 指令级钩子 ────────────────────────────────────────────────────────────
    //
    // 注意：readVar 钩子已删除（方案F）。
    // 变量读取值通过 endExpression 的 useNames/useValues 参数获取（来自 Shadow Frame），
    // 彻底消除 INSTR_READ 插桩，不再有代码膨胀。

    writeVar(iid, name, val) {
        // 暂存到 _pendingKvs，由 endExpression 统一合并输出
        _push(this._pendingKvs, { name, val });
        return { result: val };
    }

    declareVar(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        if (!isArgument && !isCatchParam) {
            this.writeVar(iid, name, val);
        }
        return { result: val };
    }

    returnStmt(iid, val) {
        // 暂存到 _pendingKvs，由 endExpression 统一合并输出
        _push(this._pendingKvs, { name: '(return)', val });
        return { result: val };
    }

    throwStmt(iid, val) {
        // 暂存到 _pendingKvs，由 endExpression 统一合并输出
        _push(this._pendingKvs, { name: '(throw)', val });
        return { result: val };
    }

    // ── 属性读写钩子（方案C）────────────────────────────────────────────────────

    /**
     * 属性读取钩子（方案C）。
     * 暂存到 _pendingFields，由 endExpression 统一合并输出。
     */
    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        // 过滤掉方法调用的 this 读取（避免冗余）
        if (!isMethodCall) {
            const baseStr = _shortBase(base);
            const offsetStr = isComputed ? `[${serialize(offset)}]` : `.${String(offset)}`;
            const key = `${baseStr}${offsetStr}`;
            _push(this._pendingFields, {
                fieldInfo: { base: baseStr, offset: String(offset), val, isComputed }
            });
        }
        return { result: val };
    }

    /**
     * 属性写入钩子（方案C）。
     * 暂存到 _pendingFields，由 endExpression 统一合并输出。
     */
    putField(iid, base, offset, val, isComputed, isOpAssign) {
        const baseStr = _shortBase(base);
        const offsetStr = isComputed ? `[${serialize(offset)}]` : `.${String(offset)}`;
        _push(this._pendingFields, {
            fieldInfo: { base: baseStr, offset: String(offset), val, isComputed, isWrite: true }
        });
        return { result: val };
    }

    // ── 表达式语句末尾 ────────────────────────────────────────────────────────

    /**
     * 表达式语句结束钩子。
     *
     * 方案F 扩展签名：
     *   endExpression(iid, val, useNames, useScopes, useValues)
     *
     * @param {number} iid          指令 ID
     * @param {*} [val]             表达式结果（可选，当前未使用）
     * @param {string[]} [useNames] 静态 use-set 变量名列表（插桩器注入）
     * @param {number[]} [useScopes] 对应 defScopeId 列表
     * @param {*[]} [useValues]     变量当前值列表（由运行时从 Shadow Frame 查询）
     */
    endExpression(iid, val, useNames, useScopes, useValues) {
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;

        // 方案F：若提供了 useNames/useValues，直接使用（不再依赖 readVar hook）
        if (useNames && useValues && useNames.length > 0) {
            const builtins = new Set(['String', 'Number', 'Boolean', 'Object', 'Array',
                'Function', 'Symbol', 'BigInt', 'Math', 'Date', 'RegExp', 'Error',
                'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
                'JSON', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
                'console', 'window', 'global', 'globalThis', 'document', 'navigator',
                'undefined', 'NaN', 'Infinity']);

            for (let i = 0; i < useNames.length; i++) {
                const name = useNames[i];
                if (builtins.has(name)) continue;
                _push(this._pendingReads, { name, val: useValues[i] });
            }
        }

        // 聚合当前语句的所有 kv，合并成一行输出
        const writes = this._pendingKvs;
        const reads  = this._pendingReads;
        const fields = this._pendingFields;
        this._pendingKvs    = [];
        this._pendingReads  = [];
        this._pendingFields = [];

        // 结构化 JSON 输出
        const kvObj = { w: {}, r: {}, f: [] };
        const writtenNames = new Set();

        // 写入变量
        for (const w of writes) {
            if (w.name) {
                kvObj.w[w.name] = w.val;
                writtenNames.add(w.name);
            }
        }

        // 读取变量（过滤已写入的）
        for (const r of reads) {
            if (!writtenNames.has(r.name)) {
                kvObj.r[r.name] = r.val;
            }
        }

        // 属性访问
        for (const f of fields) {
            if (f.fieldInfo) kvObj.f.push(f.fieldInfo);
        }

        // 清理空字段
        if ($keys(kvObj.w).length === 0) delete kvObj.w;
        if ($keys(kvObj.r).length === 0) delete kvObj.r;
        if (kvObj.f.length === 0) delete kvObj.f;

        const line = fmt.infoLineJson(
            ++this._seq, rc, 0, srcText,
            $keys(kvObj).length > 0 ? this._serializeKvObj(kvObj) : '{}'
        );
        this._emitRaw(line);
    }

    // ── 执行结束 ──────────────────────────────────────────────────────────────

    endExecution() {
        this._key('info', `=== ExecutionTrace: script done, ${this._seq} events so far (async callbacks may still fire) ===`);

        // ⚠️ 注意：此处故意 **不** 关闭 logger。
        // 脚本主体退出后，注册的回调（setTimeout / Promise / 事件监听器等）仍会被调用，
        // 我们需要持续追踪这些后续调用。
        // 若要手动关闭，请调用 analysis.close() 或 analysis.flush()。
    }

    /**
     * 手动 flush：将所有缓冲的 trace 写入后端，但不关闭 logger（可继续追踪）。
     * 适合在特定时机强制落盘（如页面 visibilitychange、beforeunload 等）。
     * @returns {Promise<void>}
     */
    async flush() {
        await this._loggerReady;
        await this._logger.flush?.();
    }

    /**
     * 手动关闭：flush 后关闭 logger，不再接受新 trace。
     * 调用后分析器将停止记录（后续钩子数据会静默丢弃）。
     * @returns {Promise<void>}
     */
    async close() {
        this._key('info', `=== ExecutionTrace: closed, total ${this._seq} events ===`);

        try {
            await this._loggerReady;
            await this._logger.close();
        } catch (err) {
            dbg.error('close: logger close error:', err.message, err.stack ?? '');
        }
    }

    onReady(cb) {
        // 等待日志后端（IDB Worker / WebSocket）就绪后再回调，
        // 避免 Node.js 侧在后端 ready 前就开始执行插桩代码产生大量 pre-init 积压。
        // 无论成功还是失败都回调，避免死锁。
        this._loggerReady.then(() => cb(), () => cb());
    }
}
