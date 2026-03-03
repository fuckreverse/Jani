// JALANGI DO NOT INSTRUMENT

/**
 * @file ExecutionTrace —— 按语句粒度输出执行 trace，便于 LLM 分析。
 *
 * 每条顶层表达式语句输出格式：
 *
 *   [row:col]  <indent>原始源码文本 ; var1=v1, var2=v2, ...
 *   [row:col]  <indent+1>→ call fn(n) ; arg0=v, ...
 *   [row:col]  <indent+2>内层语句 ; ...
 *   [row:col]  <indent+1>← return fn ; result=v
 *
 * 所有普通 trace 行通过 TraceLogger.trace() 写入后端（IndexedDB / 文件）；
 * 重点事件（脚本开始/结束、异常）通过 TraceLogger.key() 同步输出到控制台，
 * 同时也写入后端作为边界标记。
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
 * 诊断日志（直接输出到 console，不走 TraceLogger/IDB）：
 *  - JALANGI_DEBUG=1（Node.js）或 localStorage.jalangiDebug='1'（浏览器）开启 debug 级别
 *  - error/warn 级别（栈帧不匹配、未预期异常等）始终输出
 */

import { TraceLogger } from '../runtime/logging/TraceLogger.js';

const MAX_BYTES  = 100;
const INDENT_UNIT = '  ';

// ── 诊断日志工具（直接到 console）─────────────────────────────────────────────
const IS_BROWSER = typeof window !== 'undefined' || typeof globalThis.self !== 'undefined';

function _isDebugEnabled() {
    if (!IS_BROWSER) {
        return (typeof process !== 'undefined') && process?.env?.JALANGI_DEBUG === '1';
    }
    try { return localStorage?.getItem?.('jalangiDebug') === '1'; } catch { return false; }
}

const dbg = {
    debug(...args) {
        if (_isDebugEnabled()) console.debug('[Jalangi:ExecutionTrace]', ...args);
    },
    warn(...args)  { console.warn( '[Jalangi:ExecutionTrace]', ...args); },
    error(...args) { console.error('[Jalangi:ExecutionTrace]', ...args); },
};

// ── 工具 ─────────────────────────────────────────────────────────────────────

function serialize(v) {
    const t = typeof v;
    if (v === null)      return 'null';
    if (v === undefined) return 'undefined';
    if (t === 'function') return `[Function ${v.name || '(anonymous)'}]`;
    if (t === 'symbol')   return v.toString();
    if (t === 'object') {
        let s;
        try { s = JSON.stringify(v); } catch { s = Object.prototype.toString.call(v); }
        if (s === undefined) s = String(v);
        return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) + '…' : s;
    }
    const s = JSON.stringify(v);
    return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) + '…' : s;
}

function getLocation(sandbox, iid) {
    const smap = sandbox?.smap;
    if (!smap) return null;
    const cur = smap[sandbox.sid];
    if (cur) {
        const arr = cur[iid];
        if (Array.isArray(arr) && arr.length >= 4) return arr;
    }
    for (const key of Object.keys(smap)) {
        const entry = smap[key];
        if (entry && typeof entry === 'object') {
            const arr = entry[iid];
            if (Array.isArray(arr) && arr.length >= 4) return arr;
        }
    }
    return null;
}

function extractSource(lines, loc) {
    if (!lines || !loc) return '';
    const [sl, , el, ec] = loc;
    const s0 = Math.max(sl - 1, 0), e0 = Math.min(el - 1, lines.length - 1);

    // 从行首开始截取（忽略 sc），以便包含 var/const/let/return 等关键字。
    let text;
    if (s0 === e0) {
        text = lines[s0].slice(0, ec);
    } else {
        const parts = [lines[s0]];
        for (let i = s0 + 1; i < e0; i++) parts.push(lines[i]);
        parts.push(lines[e0].slice(0, ec));
        text = parts.join(' ');
    }
    return text.replace(/\s+/g, ' ').trim();
}

// ── 帧结构 ────────────────────────────────────────────────────────────────────

class Frame {
    constructor(indent) {
        this.indent    = indent;
        this._kvMap    = new Map();
        this._firstIid = null;
        this._children = [];
        this.doneLines = [];
    }

    collect(iid, key, val) {
        if (this._firstIid === null) this._firstIid = iid;
        this._kvMap.set(key, val);
    }

    addChild(callLine, innerLines, retLine) {
        this._children.push({ callLine, innerLines, retLine });
    }

    flushStmt(stmtIid, sb, lines) {
        if (this._kvMap.size === 0 && this._firstIid === null && this._children.length === 0) {
            return null;
        }
        const iid     = stmtIid ?? this._firstIid;
        const loc     = getLocation(sb, iid);
        const rc      = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const indent  = INDENT_UNIT.repeat(this.indent);
        const srcText = lines && loc ? extractSource(lines, loc) : `(iid=${iid})`;
        const valStr  = [...this._kvMap.entries()].map(([k, v]) => `${k}=${serialize(v)}`).join(', ');
        const stmtLine = `[${rc}] ${indent}${srcText}${valStr ? ' ; ' + valStr : ''}`;

        const childLines = [];
        for (const { callLine, innerLines, retLine } of this._children) {
            if (callLine) childLines.push(callLine);
            childLines.push(...innerLines);
            if (retLine) childLines.push(retLine);
        }

        this._kvMap.clear();
        this._firstIid = null;
        this._children = [];

        return { stmtLine, childLines };
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
     *   直接传入已构造好的 TraceLogger 实例（最灵活，可在外部完全配置）
     *
     * @param {boolean} [options.useIdb=false]
     *   浏览器中启用 IndexedDB（自动创建 TraceLogger，等价于传 logger with useIdb:true）
     * @param {string}  [options.dbName='jalangi-traces']
     * @param {string}  [options.storeName='execution-trace']
     * @param {string}  [options.wsUrl]    可选同时推送到 WebSocket
     *
     * @param {string|false} [options.nodeFile='jalangi-trace.ndjson']
     *   Node.js 下输出文件（false = 只输出控制台）
     * @param {boolean} [options.nodeConsole=false]  Node.js 下同时输出控制台
     */
    constructor(sandbox, sourceCode, options = {}) {
        this._sb    = sandbox;
        this._seq   = 0;
        this._lines = sourceCode ? sourceCode.split(/\r\n|\r|\n/) : null;
        this._stack     = [];
        this._callStack = [];

        // ── 建立 TraceLogger ──────────────────────────────────────────────────
        if (options.logger instanceof TraceLogger) {
            // 外部直接传入
            this._logger = options.logger;
            dbg.debug('constructor: using externally provided TraceLogger');
        } else {
            // 根据选项自动构建
            const {
                useIdb    = false,
                dbName,
                storeName,
                wsUrl,
                nodeFile,
                nodeConsole,
            } = options;

            this._logger = new TraceLogger({
                useIdb,
                ...(dbName    != null && { dbName }),
                ...(storeName != null && { storeName }),
                ...(wsUrl     != null && { wsUrl }),
                ...(nodeFile  !== undefined && { nodeFile }),
                ...(nodeConsole !== undefined && { nodeConsole }),
                keyToConsole: true,
            });
            dbg.debug('constructor: created TraceLogger', { useIdb, dbName, storeName });
        }

        // 启动后端初始化（异步，不阻塞构造函数）
        this._loggerReady = this._logger.init();
        this._loggerReady.then(() => {
            dbg.debug('TraceLogger init complete — backend ready:', this._logger.isReady);
        }).catch(err => {
            dbg.error('TraceLogger init error:', err.message, err.stack ?? '');
        });

        // 将 TraceLogger 挂到 sandbox.tracer，
        // 使所有插件通过 sandbox.log() → sandbox.tracer.key() 路由到同一实例
        if (sandbox) {
            sandbox.tracer = this._logger;
        }
    }

    // ── 内部日志辅助 ──────────────────────────────────────────────────────────

    /**
     * 输出普通 trace 行（高频，走 LogManager 缓冲后端）。
     * @param {string} text
     */
    _trace(text) {
        this._logger.trace({ type: 'trace', seq: this._seq, text });
    }

    /**
     * 输出重点事件（低频：脚本边界、异常、汇总）。
     * 同步写控制台，同时写后端作边界标记。
     * @param {'info'|'warn'|'error'} level
     * @param {string} text
     */
    _key(level, text) {
        this._logger.key(level, text);
    }

    _nextSeq() { return ++this._seq; }
    _top()     { return this._stack[this._stack.length - 1]; }

    /** 分配 seq、输出普通行 */
    _emit(text) {
        this._trace(`[${this._nextSeq()}] ${text}`);
    }

    _flushTop(stmtIid) {
        const frame = this._top();
        if (!frame) return;
        const result = frame.flushStmt(stmtIid, this._sb, this._lines);
        if (!result) return;
        const { stmtLine, childLines } = result;
        this._emit(stmtLine);
        for (const cl of childLines) this._emit(cl);
    }

    // ── 函数调用边界 ──────────────────────────────────────────────────────────

    invokeFunPre(iid, f, base, args, isConstructor, isMethod) {
        const name   = f?.name || '(anonymous)';
        const prefix = isConstructor ? 'new ' : '';
        const desc   = isMethod
            ? `→ call .${name}(${args.length} args)`
            : `→ ${prefix}call ${name}(${args.length} args)`;

        const kvParts = args.map((a, i) => `arg${i}=${serialize(a)}`);
        if (isMethod && base !== undefined) kvParts.unshift(`this=${serialize(base)}`);

        const loc          = getLocation(this._sb, iid);
        const rc           = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const parentIndent = this._stack.length > 0 ? this._top().indent : 0;
        const callIndent   = INDENT_UNIT.repeat(parentIndent + 1);
        const callLineTemplate = `[${rc}] ${callIndent}${desc}${kvParts.length ? ' ; ' + kvParts.join(', ') : ''}`;

        const newIndent = parentIndent + 2;
        this._stack.push(new Frame(newIndent));
        this._callStack.push({ callLineTemplate, innerLines: [] });

        dbg.debug(`invokeFunPre: ${desc} iid=${iid} stackDepth=${this._stack.length}`);
        return { f, base, args, skip: false };
    }

    invokeFun(iid, f, base, args, result, isConstructor, isMethod) {
        // 健壮性检查：如果栈帧已空（不正常），记录诊断日志
        if (this._stack.length === 0 || this._callStack.length === 0) {
            const name = f?.name || '(anonymous)';
            dbg.error(
                `invokeFun: stack underflow — stack=${this._stack.length} callStack=${this._callStack.length}` +
                ` fn=${name} iid=${iid} isConstructor=${isConstructor} isMethod=${isMethod}`
            );
            return { result };
        }

        this._flushTop(iid);

        const frame    = this._stack.pop();
        const callInfo = this._callStack.pop();

        const name      = f?.name || '(anonymous)';
        const loc       = getLocation(this._sb, iid);
        const rc        = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const retIndent = INDENT_UNIT.repeat(frame.indent > 0 ? frame.indent - 1 : 0);
        const retLineTemplate = `[${rc}] ${retIndent}← return ${name} ; result=${serialize(result)}`;

        dbg.debug(`invokeFun: ← ${name} iid=${iid} stackDepth=${this._stack.length}`);

        const parent = this._top();
        if (parent) {
            parent.addChild(callInfo.callLineTemplate, [...frame.doneLines], retLineTemplate);
        } else {
            this._emit(callInfo.callLineTemplate);
            for (const l of frame.doneLines) this._emit(l);
            this._emit(retLineTemplate);
        }

        return { result };
    }

    // ── 脚本进出（KEY 级别）───────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        dbg.debug(`scriptEnter: "${originalFileName}" iid=${iid} stackDepth=${this._stack.length}`);
        // 脚本开始：重点日志 → 控制台 + 后端
        this._key('info', `▶ script: ${originalFileName}`);
        this._stack.push(new Frame(1));
        this._callStack.push({ callLineTemplate: null, innerLines: [] });
    }

    scriptExit(iid, wrappedExceptionVal) {
        // 健壮性检查
        if (this._stack.length === 0) {
            dbg.error(`scriptExit: stack underflow (iid=${iid}) — no matching scriptEnter?`);
        } else {
            this._flushTop(iid);
            this._stack.pop();
            this._callStack.pop();
        }
        // 脚本结束：重点日志
        if (wrappedExceptionVal) {
            const exStr = serialize(wrappedExceptionVal.exception);
            dbg.debug(`scriptExit: exception iid=${iid} exception=${exStr}`);
            this._key('error', `◀ script end (exception: ${exStr})`);
        } else {
            dbg.debug(`scriptExit: normal iid=${iid}`);
            this._key('info', `◀ script end`);
        }
        return { wrappedExceptionVal, isBacktrack: false };
    }

    functionEnter(iid, f, dis, args) { /* 缩进由 invokeFunPre 管理 */ }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        if (wrappedExceptionVal) {
            const exStr = serialize(wrappedExceptionVal.exception);
            this._flushTop(iid);
            const loc    = getLocation(this._sb, iid);
            const rc     = loc ? `${loc[0]}:${loc[1]}` : '?:?';
            const indent = INDENT_UNIT.repeat(this._top()?.indent ?? 0);
            const text   = `[${rc}] ${indent}✗ throw ; exception=${exStr}`;

            dbg.debug(`functionExit: exception at iid=${iid}: ${exStr}`);
            // 异常：重点日志（控制台）+ 普通 trace（后端，保留完整上下文）
            this._key('error', text);
            this._emit(text);   // 同时记进序列（后端），便于关联前后 trace
        }
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 子操作收集 ────────────────────────────────────────────────────────────

    read(iid, name, val)  { this._top()?.collect(iid, name, val); return { result: val }; }
    write(iid, name, val) { this._top()?.collect(iid, name, val); return { result: val }; }

    declare(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        if (!isArgument && !isCatchParam) this._top()?.collect(iid, name, val);
        return { result: val };
    }

    getField(iid, base, offset, val, isComputed) {
        this._top()?.collect(iid, isComputed ? `[${serialize(offset)}]` : String(offset), val);
        return { result: val };
    }

    putField(iid, base, offset, val, isComputed) {
        this._top()?.collect(iid, isComputed ? `[${serialize(offset)}]` : String(offset), val);
        return { result: val };
    }

    binary(iid, op, left, right, result)  { this._top()?.collect(iid, `(${op})`, result); return { result }; }
    unary(iid, op, left, result)          { this._top()?.collect(iid, `(${op})`, result); return { result }; }

    literal(iid, val) {
        if (typeof val !== 'object' && typeof val !== 'function') {
            this._top()?.collect(iid, '(lit)', val);
        }
        return { result: val };
    }

    conditional(iid, result) { this._top()?.collect(iid, '(cond)', result); return { result }; }
    _return(iid, val)        { this._top()?.collect(iid, '(return)', val); return { result: val }; }
    _throw(iid, val)         { this._top()?.collect(iid, '(throw)',  val); return { result: val }; }

    // ── 语句边界 ──────────────────────────────────────────────────────────────

    endExpression(iid) {
        const frame = this._top();
        if (!frame) return;

        const result = frame.flushStmt(iid, this._sb, this._lines);
        if (!result) return;

        const { stmtLine, childLines } = result;

        if (this._stack.length <= 1) {
            this._emit(stmtLine);
            for (const cl of childLines) this._emit(cl);
        } else {
            frame.doneLines.push(stmtLine, ...childLines);
        }
    }

    // ── 执行结束（KEY 级别汇总）──────────────────────────────────────────────

    endExecution() {
        const residualFrames = this._stack.length;
        if (residualFrames > 0) {
            dbg.warn(`endExecution: ${residualFrames} residual frame(s) in stack — possible missing scriptExit/functionExit`);
        }

        // Flush 残余 pending 帧
        while (this._stack.length > 0) {
            this._flushTop(null);
            this._stack.pop();
            this._callStack.pop();
        }

        // 汇总行：重点日志（控制台 + 后端）
        dbg.debug(`endExecution: total seq=${this._seq}`);
        this._key('info', `=== ExecutionTrace: total ${this._seq} events ===`);

        // 关闭 LogManager（等待 init 完成后再 close，避免竞态）
        this._loggerReady
            .then(() => {
                dbg.debug('endExecution: closing TraceLogger...');
                return this._logger.close();
            })
            .then(() => {
                dbg.debug('endExecution: TraceLogger closed');
            })
            .catch(err => {
                dbg.error('endExecution: logger close error:', err.message, err.stack ?? '');
            });
    }

    onReady(cb) { cb(); }
}
