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
 * 每条 trace 行输出格式（由 OUTPUT_FORMAT 控制）：
 *
 *   FORMAT_FLAT (8) — 平铺流式输出（默认）：无调用栈缩进，每个事件立即输出，不等函数返回。
 *     适合脚本退出后外部调用被插桩函数的场景（解决异步/延迟调用 trace 丢失问题）。
 *     所有行统一遵循 `[seq] [line:col] 描述 ; kv` 格式：
 *     [  1] [     1:1] var x = 1 ; x=1
 *     [  2] [     2:1] x += 1 ; x=2
 *     [  3] [     3:5] CALL .fromCharCode(1 args) ; this=[Function String], arg0=65
 *     [  4] [     3:5] RETN fromCharCode ; ="A"
 *     [  5] [     3:1] o += String.fromCharCode(c) ; o="A", c=65
 *
 *   FORMAT_TREE (1) — Unicode 树形符号（seq/rc 固定宽度对齐）：
 *     [  9] [ 687:22] │ │ │ ┬ (anonymous)(0 args)
 *     [ 10] [3943:14] │ │ │ │ ┬ Object(1 args) ; arg0=Symbol(Symbol.iterator)
 *     [ 11] [3943:14] │ │ │ │ └ return Object ; ={}
 *     [ 12] [ 687:22] │ │ │ └ return (anonymous) ; =undefined
 *
 *   FORMAT_BLOCK (2) — #region/#endregion 折叠块（VS Code 任意文件可折叠）：
 *     [  9] // #region [ 687:22] CALL (anonymous)(0 args)
 *     [ 10]   // #region [3943:14] CALL Object(1 args) ; arg0=Symbol(Symbol.iterator)
 *     [ 11]   // #endregion Object ; ={}
 *     [ 12] // #endregion (anonymous) ; =undefined
 *
 *   FORMAT_PIPE (4) — ASCII pipe 符号（| 数量 = 调用深度）：
 *     [  9] | | | (anonymous)(0 args) [ 687:22]
 *     [ 10] | | | | Object(1 args) [3943:14] ; arg0=Symbol(Symbol.iterator)
 *     [ 11] | | | | Object RETN ; ={} [3943:14]
 *     [ 12] | | | (anonymous) RETN ; =undefined [ 687:22]
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
import { serialize } from '../utils/serialize.js';
import {
    FORMAT_FLAT, FORMAT_TREE, FORMAT_BLOCK, FORMAT_PIPE,
    fmtSeq,
    createFormatter,
} from '../utils/traceFormatters.js';
import {
    $push as _push, $join as _join, $map as _map, $filter as _filter,
    $splice as _splice, $unshift as _unshift, $pop as _pop,
    $slice, $isArray, $keys, $strSplit, $strReplace, $strSlice, $strTrim,
} from '../runtime/NativeProxy.js';

const dbg = createDiagLogger(DOMAIN.ANALYSIS);

// ── 输出格式选择（硬编码，改这里切换）────────────────────────────────────────
//   FORMAT_FLAT  (8) : 平铺流式输出（默认），无缩进，每事件立即输出，不等函数返回
//   FORMAT_TREE  (1) : Unicode 树形符号（┬ │ └），seq/rc 固定宽度对齐
//   FORMAT_BLOCK (2) : #region/#endregion 折叠块（VS Code 任意文件可折叠）
//   FORMAT_PIPE  (4) : ASCII pipe 符号（| 数量 = 深度）
const OUTPUT_FORMAT = FORMAT_FLAT;

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

// ── 帧结构 ────────────────────────────────────────────────────────────────────

class Frame {
    constructor(depth) {
        this.depth     = depth;
        this.doneLines = [];
    }
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
        this._stack     = [];
        this._callStack = [];
        this._fmt       = createFormatter(OUTPUT_FORMAT);
        // FORMAT_FLAT（8）模式：每个事件立即 emit，不通过 Frame.doneLines 缓冲
        this._flat = !(OUTPUT_FORMAT === FORMAT_TREE || OUTPUT_FORMAT === FORMAT_BLOCK || OUTPUT_FORMAT === FORMAT_PIPE);
        // flat 模式下缓冲当前语句的变量 kv（writeVar/returnStmt/throwStmt 暂存于此，
        // 由 endExpression 统一合并成一行输出，避免每个 writeVar 单独输出一行）
        this._pendingKvs = [];
        // flat 模式下缓冲当前语句的变量读取值
        // 方案F：由 endExpression 从 useNames/useValues 直接填充，不依赖 readVar hook
        this._pendingReads = [];
        // 方案C：缓冲当前语句的属性读写（getField/putField 暂存于此）
        this._pendingFields = [];

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

    _top() { return this._stack[this._stack.length - 1]; }

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

    // ── 函数调用边界 ──────────────────────────────────────────────────────────

    callPre(iid, f, base, args, isConstructor, isMethod) {
        const name   = f?.name || '(anonymous)';
        const prefix = isConstructor ? 'new ' : '';
        const desc   = isMethod
            ? `.${name}(${args.length} args)`
            : `${prefix}${name}(${args.length} args)`;

        const kvParts = _map(args, (a, i) => `arg${i}=${serialize(a)}`);
        if (isMethod && base !== undefined) _unshift(kvParts, `this=${serialize(base)}`);
        // 限制 kvStr 总长度，防止大对象导致行过长
        const MAX_KV = 120;
        let kvStr = _join(kvParts, ', ');
        if (kvStr.length > MAX_KV) kvStr = $strSlice(kvStr, 0, MAX_KV - 1) + '…';

        const { rc } = this._loc(iid);

        if (this._flat) {
            // 平铺模式：立即输出 CALL 行，只用轻量元数据栈（不缓冲 doneLines）
            const callMeta = { rc, depth: 1, desc, kvStr, name };
            // 在调用前保存当前语句积累的 pending 上下文（防止被调函数内部的钩子污染）。
            // 例如：外层语句 `x = foo(y)` 调用 foo，foo 内部的 writeVar/putField 钩子
            // 会向 _pendingKvs/_pendingFields 推入数据，如不隔离会混入外层语句的 trace。
            _push(this._callStack, {
                callMeta,
                savedKvs:    this._pendingKvs,
                savedReads:  this._pendingReads,
                savedFields: this._pendingFields,
            });
            // 清空，确保被调函数内部积累的 pending 不会污染外层语句
            this._pendingKvs    = [];
            this._pendingReads  = [];
            this._pendingFields = [];
            const line = this._fmt.callLine(++this._seq, rc, 1, desc, kvStr);
            this._emitRaw(line);
            return { f, base, args, skip: false };
        }

        const parentDepth = this._stack.length > 0 ? this._top().depth : 0;

        // 如果此时栈为空，说明是脚本退出后的异步回调（setTimeout / Promise / 事件监听器等）
        // 自动推入一个虚拟"异步根帧"，使后续 trace 正常落帧，不再静默丢失
        if (this._stack.length === 0) {
            this._pushAsyncRootFrame(iid);
        }

        const callMeta = { rc, depth: parentDepth + 1, desc, kvStr, name };
        _push(this._stack, new Frame(parentDepth + 1));
        _push(this._callStack, { callMeta });

        return { f, base, args, skip: false };
    }

    call(iid, f, base, args, result, isConstructor, isMethod) {
        if (this._flat) {
            // 平铺模式：CALL 行已在 callPre 输出，此处只输出 RETN 行
            if (this._callStack.length === 0) {
                const name = f?.name || '(anonymous)';
                dbg.error(`call(flat): callStack underflow — fn=${name} iid=${iid}`);
                return { result };
            }
            const callInfo = _pop(this._callStack);
            const name   = callInfo.callMeta?.name ?? (f?.name || '(anonymous)');
            // 恢复外层语句的 pending 上下文（callPre 时保存的），并丢弃被调函数内部积累的 pending。
            // 这样被调函数内部的变量读写不会出现在外层语句的 trace 行中。
            if (callInfo.savedKvs !== undefined) {
                this._pendingKvs    = callInfo.savedKvs;
                this._pendingReads  = callInfo.savedReads;
                this._pendingFields = callInfo.savedFields;
            }
            const { rc } = this._loc(iid);
            const line   = this._fmt.retLine(++this._seq, rc, 1, name, serialize(result));
            this._emitRaw(line);
            this._logger.scheduleFlush?.();
            return { result };
        }

        if (this._stack.length === 0 || this._callStack.length === 0) {
            const name = f?.name || '(anonymous)';
            dbg.error(
                `call: stack underflow — stack=${this._stack.length}` +
                ` fn=${name} iid=${iid}`
            );
            return { result };
        }

        const frame    = _pop(this._stack);
        const callInfo = _pop(this._callStack);
        const { callMeta } = callInfo;

        const name    = f?.name || '(anonymous)';
        const { rc }  = this._loc(iid);
        const retMeta = { rc, depth: callMeta.depth, name, result: serialize(result) };

        const innerLines = frame.doneLines;

        const parent = this._top();
        if (parent) {
            if (parent._isAsyncRoot) {
                // 父帧是异步根帧：直接 emit 这次调用，然后检查根帧是否可以收尾
                this._emitFormattedCall(callMeta, innerLines, retMeta);
                this._maybeFlushAsyncRootFrame();
                // 异步调用完成，少量 trace 可能达不到 RingBuffer 自动 flush 阈值，主动调度
                this._logger.scheduleFlush?.();
            } else {
                _push(parent.doneLines, { type: 'call', callMeta, innerLines, retMeta });
            }
        } else {
            this._emitFormattedCall(callMeta, innerLines, retMeta);
        }

        return { result };
    }

    _emitFormattedCall(callMeta, innerLines, retMeta) {
        const callLine = this._fmt.callLine(
            ++this._seq, callMeta.rc, callMeta.depth, callMeta.desc, callMeta.kvStr
        );
        this._emitRaw(callLine);

        this._emitItems(innerLines);

        const retLine = this._fmt.retLine(
            ++this._seq, retMeta.rc, retMeta.depth, retMeta.name, retMeta.result
        );
        this._emitRaw(retLine);
    }

    // ── 脚本进出 ──────────────────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        // 若构造时未传 sourceCode（this._lines 为 null），
        // 尝试从 smap 内联的 code 字段补充（inlineSource:true 时有值）。
        // 每次 scriptEnter 都刷新，天然支持多脚本场景。
        if (this._sb?.smap) {
            const sid = this._sb.sid;
            // 优先按当前 sid 查；回退按 instrumentedFileName 查
            const entry = this._sb.smap[sid] ?? this._sb.smap[instrumentedFileName];
            if (entry?.code) {
                this._lines = $strSplit(entry.code, /\r\n|\r|\n/);
                dbg.debug(`scriptEnter: loaded ${this._lines.length} source lines from smap (sid=${sid})`);
            }
        }

        // scriptEnter 分配一个 seq，作为 trace 的第一条记录
        this._emitKeyLine(`▶ script: ${originalFileName}`);
        this._key('info', `▶ script: ${originalFileName}`);
        if (!this._flat) {
            _push(this._stack, new Frame(0));
            _push(this._callStack, { callMeta: null });
        }
    }

    scriptExit(iid, wrappedExceptionVal) {
        if (!this._flat) {
            if (this._stack.length === 0) {
                dbg.error(`scriptExit: stack underflow (iid=${iid})`);
            } else {
                const frame = this._top();
                this._emitItems(frame.doneLines);
                _pop(this._stack);
                _pop(this._callStack);
            }
        }
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
        if (this._flat) {
            // 平铺模式：直接 emit CALL 行（对应 functionEnter 无 callPre 的情况：
            // 脚本退出后 native 直接调用，或者 callPre 之后进入函数体）。
            // 用 _flatFnDepth 追踪嵌套深度，只有最外层函数才需要 emit（callPre 负责外层调用的 CALL）。
            // 注意：callPre 路径会先 emit CALL，此处 functionEnter 只处理无 callPre 的直接调用。
            // 判断标准：_callStack 顶层是否已有由 callPre 推入的待匹配记录（_fromCallPre 标记）。
            // 简化实现：用 _flatFnStack 跟踪每次 functionEnter 是否已由 callPre 覆盖
            if (!this._flatFnStack) this._flatFnStack = [];
            const topCall = this._callStack.length > 0 ? this._callStack[this._callStack.length - 1] : null;
            if (topCall && !topCall._feCovered) {
                // 已有 callPre 对应的记录，标记为已覆盖，不再重复 emit CALL
                topCall._feCovered = true;
                _push(this._flatFnStack, { _coveredByCallPre: true });
            } else {
                // 无 callPre：native 直接调用（脚本退出后），emit CALL 行
                const name = f?.name || '(anonymous)';
                const { rc } = this._loc(iid);
                const callMeta = { rc, depth: 1, desc: `${name}(${args?.length ?? 0} args)`, kvStr: '', name };
                _push(this._callStack, { callMeta, _directFe: true });
                _push(this._flatFnStack, { _coveredByCallPre: false });
                const line = this._fmt.callLine(++this._seq, rc, 1, callMeta.desc, '');
                this._emitRaw(line);
            }
            return;
        }

        if (this._stack.length === 0) {
            // 栈为空：脚本退出后被 native 代码直接调用（如浏览器直接调用注册的函数）。
            // 推入异步根帧 + 合成帧。
            // _feFrDepth 追踪此合成帧内部通过 native 调用触发的 Fe/Fr 嵌套深度：
            //   = 0 时，下一个 functionExit 就是合成帧对应函数自身的出口
            //   > 0 时，这个 functionExit 是某个内部 native 回调的出口，继续等
            this._pushAsyncRootFrame(iid);
            const name = f?.name || '(anonymous)';
            const { rc } = this._loc(iid);
            const callMeta = { rc, depth: 1, desc: `${name}(${args?.length ?? 0} args)`, kvStr: '', name };
            const frame = new Frame(1);
            frame._isSyntheticEntry = true;
            frame._feFrDepth = 0;
            _push(this._stack, frame);
            _push(this._callStack, { callMeta });
        } else {
            // 栈不为空：只有 _stack 顶层就是合成帧时，才增加其嵌套深度计数。
            // 如果合成帧之上还有 callPre 推的帧，则这次 Fe 属于那些帧内部，
            // 不影响合成帧的 _feFrDepth（它们有自己的深度语义）。
            const top = this._top();
            if (top?._isSyntheticEntry) {
                top._feFrDepth++;
            }
        }
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        if (this._flat) {
            if (wrappedExceptionVal) {
                const exStr  = serialize(wrappedExceptionVal.exception);
                const { rc } = this._loc(iid);
                const line = this._fmt.infoLine(++this._seq, rc, 0, '✗ throw', `exception=${exStr}`);
                this._emitRaw(line);
                this._key('warn', `[${rc}] ✗ throw ; exception=${exStr}`);
            }

            if (!this._flatFnStack) this._flatFnStack = [];
            const fnEntry = _pop(this._flatFnStack);
            if (fnEntry && !fnEntry._coveredByCallPre) {
                // 对应 _directFe 路径（无 callPre），需要输出 RETN 行
                if (this._callStack.length > 0) {
                    const callInfo = _pop(this._callStack);
                    const name   = callInfo.callMeta?.name ?? '(anonymous)';
                    const { rc } = this._loc(iid);
                    const line   = this._fmt.retLine(++this._seq, rc, 1, name, serialize(returnVal));
                    this._emitRaw(line);
                    this._logger.scheduleFlush?.();
                }
            }
            // 对应 callPre 覆盖路径：RETN 行已在 call() 里输出，此处无需额外处理

            return { returnVal, wrappedExceptionVal, isBacktrack: false };
        }

        if (wrappedExceptionVal) {
            const exStr  = serialize(wrappedExceptionVal.exception);
            const { rc } = this._loc(iid);
            const frame  = this._top();
            const depth = frame?.depth ?? 0;
            if (frame) _push(frame.doneLines, { type: 'info', rc, depth, srcText: '✗ throw', kv: `exception=${exStr}` });
            this._key('warn', `[${rc}] ✗ throw ; exception=${exStr}`);
        }

        // 只有 _stack 顶层就是合成帧时，才处理它的出口逻辑
        const top = this._top();
        if (top?._isSyntheticEntry) {
            if (top._feFrDepth > 0) {
                // 还有嵌套的内部 native 回调未退出，这个 functionExit 是内部的
                top._feFrDepth--;
            } else {
                // _feFrDepth === 0：合成帧对应函数本身退出了
                const frame    = _pop(this._stack);
                const callInfo = _pop(this._callStack);
                const { callMeta } = callInfo;
                const { rc }  = this._loc(iid);
                const retMeta = {
                    rc,
                    depth:  callMeta?.depth ?? 1,
                    name:   callMeta?.name ?? '(anonymous)',
                    result: serialize(returnVal),
                };
                const parent = this._top();
                if (parent?._isAsyncRoot) {
                    this._emitFormattedCall(callMeta, frame.doneLines, retMeta);
                    this._maybeFlushAsyncRootFrame();
                    // 异步调用完成，RingBuffer 里可能只有少量 trace（达不到自动 flush 阈值），
                    // 主动调度一次 flush 确保数据及时写入 IDB / 文件后端
                    this._logger.scheduleFlush?.();
                } else if (parent) {
                    _push(parent.doneLines, { type: 'call', callMeta, innerLines: frame.doneLines, retMeta });
                } else {
                    this._emitFormattedCall(callMeta, frame.doneLines, retMeta);
                    // 同上，栈外直接 emit 时也调度 flush
                    this._logger.scheduleFlush?.();
                }
            }
        }

        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 指令级钩子 ────────────────────────────────────────────────────────────
    //
    // 注意：readVar 钩子已删除（方案F）。
    // 变量读取值通过 endExpression 的 useNames/useValues 参数获取（来自 Shadow Frame），
    // 彻底消除 INSTR_READ 插桩，不再有代码膨胀。

    writeVar(iid, name, val) {
        if (this._flat) {
            // flat 模式：暂存到 _pendingKvs，由 endExpression 统一合并输出
            // 注意：不存 rc/srcText（会用 Xe 的 iid 位置，更准确）
            _push(this._pendingKvs, { name, kv: `${name}=${serialize(val)}` });
            return { result: val };
        }
        // 非 flat 模式（tree/block/pipe）：需要记录每条写入的位置信息
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        const frame = this._top();
        if (!frame) return { result: val };
        _push(frame.doneLines, { type: 'info', rc, depth: frame.depth, srcText, kv: `${name}=${serialize(val)}` });
        return { result: val };
    }

    declareVar(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        if (!isArgument && !isCatchParam) {
            this.writeVar(iid, name, val);
        }
        return { result: val };
    }

    returnStmt(iid, val) {
        if (this._flat) {
            // flat 模式：暂存到 _pendingKvs，由 endExpression 统一合并输出。位置由 Xe iid 提供
            _push(this._pendingKvs, { kv: `(return)=${serialize(val)}` });
            return { result: val };
        }
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        const frame = this._top();
        if (!frame) return { result: val };
        _push(frame.doneLines, { type: 'info', rc, depth: frame.depth, srcText, kv: `(return)=${serialize(val)}` });
        return { result: val };
    }

    throwStmt(iid, val) {
        if (this._flat) {
            // flat 模式：暂存到 _pendingKvs，由 endExpression 统一合并输出。位置由 Xe iid 提供
            // （throw 语句也会触发 endExpression，由插桩器保证）
            _push(this._pendingKvs, { kv: `(throw)=${serialize(val)}` });
            return { result: val };
        }
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        const frame = this._top();
        if (!frame) return { result: val };
        _push(frame.doneLines, { type: 'info', rc, depth: frame.depth, srcText, kv: `(throw)=${serialize(val)}` });
        return { result: val };
    }

    // ── 属性读写钩子（方案C）────────────────────────────────────────────────────

    /**
     * 属性读取钩子（方案C）。
     * 暂存到 _pendingFields，由 endExpression 统一合并输出。
     *
     * @param {number} iid         指令 ID
     * @param {*} base             基对象
     * @param {string|number|*} offset  属性名/索引
     * @param {*} val              属性值
     * @param {boolean} isComputed 是否为计算属性（a[b] vs a.b）
     * @param {boolean} isOpAssign 是否为复合赋值的读取部分
     * @param {boolean} isMethodCall 是否为方法调用
     */
    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        if (this._flat) {
            // 只在 flat 模式下暂存属性读取
            // 过滤掉方法调用的 this 读取（避免冗余）
            if (!isMethodCall) {
                const baseStr = _shortBase(base);
                const offsetStr = isComputed ? `[${serialize(offset)}]` : `.${String(offset)}`;
                const key = `${baseStr}${offsetStr}`;
                _push(this._pendingFields, { kv: `${key}=${serialize(val)}` });
            }
        }
        return { result: val };
    }

    /**
     * 属性写入钩子（方案C）。
     * 暂存到 _pendingFields，由 endExpression 统一合并输出。
     *
     * @param {number} iid         指令 ID
     * @param {*} base             基对象
     * @param {string|number|*} offset  属性名/索引
     * @param {*} val              写入值
     * @param {boolean} isComputed 是否为计算属性
     * @param {boolean} isOpAssign 是否为复合赋值
     */
    putField(iid, base, offset, val, isComputed, isOpAssign) {
        if (this._flat) {
            const baseStr = _shortBase(base);
            const offsetStr = isComputed ? `[${serialize(offset)}]` : `.${String(offset)}`;
            const key = `${baseStr}${offsetStr}`;
            _push(this._pendingFields, { kv: `${key}=${serialize(val)}` });
        }
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
        if (this._flat) {
            // flat 模式：聚合当前语句的所有 kv，合并成一行输出
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
                    _push(this._pendingReads, { name, kv: `${name}=${serialize(useValues[i])}` });
                }
            }

            // 合并 reads、writes 和 fields
            const writes = this._pendingKvs;
            const reads  = this._pendingReads;
            const fields = this._pendingFields;
            this._pendingKvs    = []; // 清空缓存，为下一条语句准备
            this._pendingReads  = [];
            this._pendingFields = [];

            // 找出写入的变量名（用于过滤 reads 中重复的）
            const writtenNames = new Set();
            for (const w of writes) {
                const match = w.kv.match(/^([^=]+)=/);
                if (match) writtenNames.add(match[1]);
            }

            // 过滤掉已被写入的读取变量（因为写入的值是执行后的，更准确）
            const filteredReads = _filter(reads, r => !writtenNames.has(r.name));

            // 合并：writes 在前，filteredReads 在后，fields 最后
            const allKvs = [...writes, ...filteredReads, ...fields];

            if (allKvs.length > 0) {
                const kvStr = _join(_map(allKvs, p => p.kv), ', ');
                const line = this._fmt.infoLine(++this._seq, rc, 0, srcText, kvStr);
                this._emitRaw(line);
            } else {
                // 无任何 kv：纯副作用语句（无变量读写），只输出源码位置
                const line = this._fmt.infoLine(++this._seq, rc, 0, srcText, '');
                this._emitRaw(line);
            }
            return;
        }

        const frame = this._top();
        if (!frame) return;

        const items = _splice(frame.doneLines, 0, frame.doneLines.length);

        if (items.length === 0) {
            // 纯副作用/纯读语句：只记录源码位置行
            const { rc, loc } = this._loc(iid);
            const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
            const meta = { type: 'info', rc, depth: frame.depth, srcText, kv: '' };
            if (this._stack.length <= 1) {
                const line = this._fmt.infoLine(++this._seq, rc, frame.depth, srcText, '');
                this._emitRaw(line);
            } else {
                _push(this._stack[this._stack.length - 1].doneLines, meta);
            }
            return;
        }

        if (this._stack.length <= 1) {
            this._emitItems(items);
        } else {
            for (const item of items) {
                _push(this._stack[this._stack.length - 1].doneLines, item);
            }
        }
    }

    _emitItems(items) {
        for (const item of items) {
            if (item.type === 'info') {
                const line = this._fmt.infoLine(++this._seq, item.rc, item.depth, item.srcText, item.kv);
                this._emitRaw(line);
            } else if (item.type === 'call') {
                this._emitFormattedCall(item.callMeta, item.innerLines, item.retMeta);
            }
        }
    }

    // ── 异步根帧管理 ──────────────────────────────────────────────────────────

    /**
     * 脚本退出后，首次接到异步回调时推入一个虚拟"异步根帧"。
     * 该帧带有 _isAsyncRoot 标记，用于区分正常脚本帧。
     * _asyncRootDepth 记录当前挂起的异步调用层数，以便在全部完成时自动弹出。
     */
    _pushAsyncRootFrame(iid) {
        const { rc } = this._loc(iid);
        const frame = new Frame(0);
        frame._isAsyncRoot     = true;
        frame._asyncPendingCalls = 0;
        _push(this._stack, frame);
        _push(this._callStack, { callMeta: null, _isAsyncRoot: true });
        dbg.debug(`[async] pushed async root frame at ${rc}`);
    }

    /**
     * 每次异步调用的 call/functionExit 返回后，检查异步根帧是否仍有挂起调用。
     * 若已无挂起调用且栈只剩根帧，弹出根帧，不做 emit（根帧本身不产生输出行）。
     */
    _maybeFlushAsyncRootFrame() {
        const top = this._top();
        if (!top?._isAsyncRoot) return;
        // 如果栈顶就是异步根帧（即其上方已无其他帧），弹出
        if (this._stack.length === 1) {
            _pop(this._stack);
            _pop(this._callStack);
            dbg.debug('[async] async root frame flushed');
        }
    }

    // ── 执行结束 ──────────────────────────────────────────────────────────────

    endExecution() {
        // 清理脚本主体执行时留下的残余帧（正常情况应已全部弹出）
        while (this._stack.length > 0) {
            const top = this._top();
            if (top?._isAsyncRoot) {
                // 异步根帧：脚本主体结束时可能仍有异步调用未回来，不强制弹出
                break;
            }
            const frame = _pop(this._stack);
            _pop(this._callStack);
            this._emitItems(frame.doneLines);
        }

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
        // 将栈上所有异步根帧中已积累的 doneLines emit 出去
        for (const frame of this._stack) {
            if (frame._isAsyncRoot && frame.doneLines.length > 0) {
                const items = _splice(frame.doneLines, 0, frame.doneLines.length);
                this._emitItems(items);
            }
        }
        await this._loggerReady;
        await this._logger.flush?.();
    }

    /**
     * 手动关闭：flush 后关闭 logger，不再接受新 trace。
     * 调用后分析器将停止记录（后续钩子数据会静默丢弃）。
     * @returns {Promise<void>}
     */
    async close() {
        // 把还在栈上的所有帧的内容 emit 出去
        while (this._stack.length > 0) {
            const frame = _pop(this._stack);
            _pop(this._callStack);
            this._emitItems(frame.doneLines);
        }

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
