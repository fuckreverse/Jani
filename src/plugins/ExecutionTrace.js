// JALANGI DO NOT INSTRUMENT

/**
 * @file ExecutionTrace —— 按语句粒度输出执行 trace，便于 LLM 分析。
 *
 * 粒度说明：
 *   - **语句级追踪**：每个表达式语句输出一条事件，包含语句涉及的所有变量读写。
 *   - 变量值包括：被写入的变量（执行后的值）+ 被读取的变量（当前值，或 OMITTED 如可追溯）。
 *   - 对于函数调用语句，CALL_PRE/CALL 仍独立输出（便于追踪调用栈）。
 *
 * 输出格式（二进制事件流，.bin 文件）：
 *   运行时直接输出 EventSerializer 定义的紧凑二进制格式（12 字节头 + payload），
 *   所有文本渲染交由后处理工具（trace-parse.mjs → trace-render.mjs）完成。
 *
 * 工具链示例：
 *   node tools/trace-parse.mjs trace.bin --smap trace.smap.json | node tools/trace-render.mjs --format tree
 *
 * 源码映射：
 *   trace 文件本身不包含位置信息（line:col）和源码文本，
 *   这些信息存储在与 .bin 配对的 .smap.json 文件中（由插桩阶段生成）。
 *   iid → [sl, sc, el, ec, srcText?, defIid?] 的映射由后处理工具解析。
 *
 * fai（flow-ambiguous）优化：
 *   对 LIGHTWEIGHT 路径（静态可追溯）的变量读取，值记录为 OMITTED（VALUE_TYPE.OMITTED），
 *   后处理工具通过 smap[iid].defIid 追溯到对应 write 事件的实际值。
 *   对 FULL（fai）路径，照常记录实际值。
 *
 * 用法：
 *   import { ExecutionTraceAnalysis } from './ExecutionTrace.js';
 *   const logger = new TraceLogger({ nodeFile: 'trace.bin' });
 *   J$.analysis = new ExecutionTraceAnalysis(J$, null, { logger });
 *
 * 自动配置推导（无需手写 Config）：
 *   import { init } from '../instrument/esnstrument.js';
 *   const analysis = new ExecutionTraceAnalysis(J$, null, opts);
 *   init(null, undefined, undefined, undefined, [analysis]);
 */

import { TraceLogger } from '../logger/TraceLogger.js';
import { createDiagLogger, DOMAIN } from '../logger/diagnostics.js';
import { serialize } from '../utils/serialize.js';
import {
    $push as _push, $pop as _pop,
    $isArray, $keys,
} from '../runtime/NativeProxy.js';

const dbg = createDiagLogger(DOMAIN.ANALYSIS);

// ── 工具 ─────────────────────────────────────────────────────────────────────

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
     * @param {string} [sourceCode]   原始源码文本（已不再运行时使用，保留参数兼容性）
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
     * @param {string|false} [options.nodeFile='jalangi-trace.bin']
     * @param {boolean} [options.nodeConsole=false]
     */
    constructor(sandbox, sourceCode, options = {}) {
        this._sb  = sandbox;
        this._seq = 0;

        // 调用栈元数据（只用于配对 CALL_PRE/CALL，不做树形缓冲）
        this._callStack = [];

        // 缓冲当前语句的变量写入（writeVar/returnStmt/throwStmt 暂存于此）
        this._pendingWrites = [];
        // 缓冲当前语句的变量读取（来自 endExpression 的 useNames/useValues）
        this._pendingReads = [];
        // 缓冲当前语句的属性读写（getField/putField）
        this._pendingFields = [];

        // functionEnter/functionExit 嵌套追踪栈
        this._flatFnStack = [];

        // 构造 logger
        if (options.logger instanceof TraceLogger) {
            this._logger = options.logger;
        } else {
            const {
                useIdb = false, dbName, storeName, wsUrl,
                wsSab, wsWorker, wsFormat,
                nodeFile = 'jalangi-trace.bin',
                nodeConsole,
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
                nodeFile,
                ...(nodeConsole !== undefined && { nodeConsole }),
                keyToConsole: true,
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

    /**
     * 向 logger 发送一条结构化事件（TraceLogger.trace 接受任意对象，
     * NodeStreamBackend 负责将其序列化为二进制）。
     * seq 在此自动递增。
     * @param {object} event  不含 seq 的事件对象（type + iid + 其他字段）
     */
    _emit(event) {
        event.seq = ++this._seq;
        this._logger.trace(event);
    }

    /** emit KEY 事件（脚本进出、错误等低频事件） */
    _emitKey(level, text, iid = 0) {
        this._emit({ type: 'KEY_EVENT', iid, level, text });
    }

    // ── 函数调用边界 ──────────────────────────────────────────────────────────

    callPre(iid, f, base, args, isConstructor, isMethod) {
        const name = f?.name || '(anonymous)';

        // 保存当前语句的 pending 上下文，防止被调函数内部钩子污染
        _push(this._callStack, {
            iid, name,
            isConstructor, isMethod,
            args: args ? Array.from(args) : [],
            base,
            savedWrites: this._pendingWrites,
            savedReads:  this._pendingReads,
            savedFields: this._pendingFields,
        });
        this._pendingWrites = [];
        this._pendingReads  = [];
        this._pendingFields = [];

        // 立即输出 CALL_PRE 事件
        this._emit({
            type: 'CALL_PRE',
            iid,
            fn:            name,
            isConstructor: !!isConstructor,
            isMethod:      !!isMethod,
            args:          args ? Array.from(args) : [],
            ...(isMethod && base !== undefined && { base }),
        });

        return { f, base, args, skip: false };
    }

    call(iid, f, base, args, result, isConstructor, isMethod) {
        if (this._callStack.length === 0) {
            dbg.error(`call: callStack underflow — fn=${f?.name ?? '?'} iid=${iid}`);
            return { result };
        }
        const callInfo = _pop(this._callStack);
        const name = callInfo.name ?? (f?.name || '(anonymous)');

        // 恢复外层语句的 pending 上下文
        this._pendingWrites = callInfo.savedWrites;
        this._pendingReads  = callInfo.savedReads;
        this._pendingFields = callInfo.savedFields;

        this._emit({
            type:   'CALL',
            iid,
            fn:     name,
            result,
        });
        this._logger.scheduleFlush?.();
        return { result };
    }

    // ── 脚本进出 ──────────────────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        this._emit({ type: 'SCRIPT_ENTER', iid, file: originalFileName });
        this._logger.key('info', `▶ script: ${originalFileName}`);
    }

    scriptExit(iid, wrappedExceptionVal) {
        const ev = { type: 'SCRIPT_EXIT', iid };
        if (wrappedExceptionVal) {
            ev.exception = wrappedExceptionVal.exception;
            this._logger.key('error', `◀ script end (exception: ${serialize(wrappedExceptionVal.exception)})`);
        } else {
            this._logger.key('info', '◀ script end');
        }
        this._emit(ev);
        return { wrappedExceptionVal, isBacktrack: false };
    }

    functionEnter(iid, f, dis, args) {
        const topCall = this._callStack.length > 0
            ? this._callStack[this._callStack.length - 1]
            : null;

        if (topCall && !topCall._feCovered) {
            topCall._feCovered = true;
            _push(this._flatFnStack, { _coveredByCallPre: true });
        } else {
            // 无 callPre：native 直接调用（异步回调等），emit FUNCTION_ENTER 事件
            const name = f?.name || '(anonymous)';
            const callMeta = { iid, name, directFe: true };
            _push(this._callStack, {
                ...callMeta,
                _directFe: true,
                savedWrites: this._pendingWrites,
                savedReads:  this._pendingReads,
                savedFields: this._pendingFields,
            });
            this._pendingWrites = [];
            this._pendingReads  = [];
            this._pendingFields = [];
            _push(this._flatFnStack, { _coveredByCallPre: false });
            this._emit({ type: 'FUNCTION_ENTER', iid, fn: name, directFe: true });
        }
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        if (wrappedExceptionVal) {
            const exStr = serialize(wrappedExceptionVal.exception);
            this._emit({
                type:      'FUNCTION_EXIT',
                iid,
                exception: wrappedExceptionVal.exception,
            });
            this._logger.key('warn', `[iid=${iid}] ✗ throw ; exception=${exStr}`);
        }

        const fnEntry = _pop(this._flatFnStack);
        if (fnEntry && !fnEntry._coveredByCallPre) {
            // 对应 _directFe 路径（无 callPre），输出 CALL（返回值）
            if (this._callStack.length > 0) {
                const callInfo = _pop(this._callStack);
                this._pendingWrites = callInfo.savedWrites ?? [];
                this._pendingReads  = callInfo.savedReads  ?? [];
                this._pendingFields = callInfo.savedFields ?? [];
                this._emit({
                    type:   'CALL',
                    iid,
                    fn:     callInfo.name ?? '(anonymous)',
                    result: returnVal,
                });
                this._logger.scheduleFlush?.();
            }
        }
        // callPre 覆盖路径：CALL 行已在 call() 里输出

        if (!wrappedExceptionVal) {
            // 仅在没有异常时输出 FUNCTION_EXIT（不重复输出）
            // 注意：若有异常，FUNCTION_EXIT 已在上方输出（含 exception 字段）
        }

        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 指令级钩子 ────────────────────────────────────────────────────────────

    writeVar(iid, name, val) {
        _push(this._pendingWrites, { name, val });
        return { result: val };
    }

    declareVar(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        if (!isArgument && !isCatchParam) {
            this.writeVar(iid, name, val);
        }
        return { result: val };
    }

    returnStmt(iid, val) {
        _push(this._pendingWrites, { name: '(return)', val });
        return { result: val };
    }

    throwStmt(iid, val) {
        _push(this._pendingWrites, { name: '(throw)', val });
        return { result: val };
    }

    // ── 属性读写钩子 ─────────────────────────────────────────────────────────

    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        if (!isMethodCall) {
            const baseStr = _shortBase(base);
            _push(this._pendingFields, {
                base:      baseStr,
                offset:    String(offset),
                val,
                isComputed: !!isComputed,
                isWrite:   false,
            });
        }
        return { result: val };
    }

    putField(iid, base, offset, val, isComputed, isOpAssign) {
        const baseStr = _shortBase(base);
        _push(this._pendingFields, {
            base:      baseStr,
            offset:    String(offset),
            val,
            isComputed: !!isComputed,
            isWrite:   true,
        });
        return { result: val };
    }

    // ── 表达式语句末尾 ────────────────────────────────────────────────────────

    /**
     * 表达式语句结束钩子（方案F 扩展签名）。
     *
     * @param {number} iid          指令 ID
     * @param {*} [val]             表达式结果（当前未使用）
     * @param {string[]} [useNames] 静态 use-set 变量名列表（插桩器注入）
     * @param {number[]} [useScopes] 对应 defScopeId 列表
     * @param {*[]} [useValues]     变量当前值列表（由运行时从 Shadow Frame 查询）
     * @param {boolean[]} [useOmits] 对应变量是否应省略值（LIGHTWEIGHT 路径）
     */
    endExpression(iid, val, useNames, useScopes, useValues, useOmits) {
        // 方案F：若提供了 useNames/useValues，从中构建 reads 列表
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
                // useOmits[i] 为 true → LIGHTWEIGHT 路径 → 值可追溯，omit=true
                const omit = useOmits ? !!useOmits[i] : false;
                _push(this._pendingReads, { name, val: useValues[i], omit });
            }
        }

        // 聚合当前语句的所有 kv
        const writes = this._pendingWrites;
        const reads  = this._pendingReads;
        const fields = this._pendingFields;
        this._pendingWrites = [];
        this._pendingReads  = [];
        this._pendingFields = [];

        // 过滤：reads 中排除已写入的变量名
        const writtenNames = new Set();
        for (const w of writes) {
            if (w.name) writtenNames.add(w.name);
        }

        // 构建 END_EXPR 事件
        const evWrites = writes.map(w => ({ name: w.name, val: w.val }));
        const evReads  = reads
            .filter(r => !writtenNames.has(r.name))
            .map(r => ({ name: r.name, val: r.val, omit: r.omit === true }));
        const evFields = fields.map(f => ({
            base:    f.base,
            offset:  f.offset,
            val:     f.val,
            isWrite: !!f.isWrite,
        }));

        this._emit({
            type:   'END_EXPR',
            iid,
            writes: evWrites.length > 0 ? evWrites : undefined,
            reads:  evReads.length  > 0 ? evReads  : undefined,
            fields: evFields.length > 0 ? evFields : undefined,
        });
    }

    // ── 执行结束 ──────────────────────────────────────────────────────────────

    endExecution() {
        this._logger.key('info', `=== ExecutionTrace: script done, ${this._seq} events so far (async callbacks may still fire) ===`);
        // 注意：此处故意不关闭 logger，异步回调仍会继续产生 trace
    }

    /**
     * 手动 flush：将所有缓冲的 trace 写入后端，但不关闭 logger。
     * @returns {Promise<void>}
     */
    async flush() {
        await this._loggerReady;
        await this._logger.flush?.();
    }

    /**
     * 手动关闭：flush 后关闭 logger，不再接受新 trace。
     * @returns {Promise<void>}
     */
    async close() {
        this._logger.key('info', `=== ExecutionTrace: closed, total ${this._seq} events ===`);
        try {
            await this._loggerReady;
            await this._logger.close();
        } catch (err) {
            dbg.error('close: logger close error:', err.message, err.stack ?? '');
        }
    }

    onReady(cb) {
        this._loggerReady.then(() => cb(), () => cb());
    }
}
