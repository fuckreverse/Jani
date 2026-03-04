// JALANGI DO NOT INSTRUMENT

/**
 * @file ExecutionTrace —— 按指令（表达式语句）粒度输出执行 trace，便于 LLM 分析。
 *
 * 粒度说明：
 *   - 仅在"指令边界"（变量写入 / 函数调用 / 表达式语句末尾）记录一条 trace 行。
 *   - **不追踪**表达式内部的子操作（变量读取、二元运算、属性读取等），
 *     以避免代码体积膨胀和运行时回调开销。
 *   - 配合 pluginAnalyzer 自动推导的按需 Config，插桩代码中只存在
 *     J$.W / J$.F / J$.M / J$.X1 等粗粒度钩子。
 *
 * 每条 trace 行输出格式：
 *
 *   [row:col]  <indent>原始源码文本 ; <key>=<value>
 *
 *   变量赋值：   [3:1]  let x = 1 ; x=1
 *   函数调用：   [5:1]  → call foo(2 args) ; arg0=1, arg1=2
 *               [5:1]  ← return foo ; result=3
 *   表达式语句： [7:1]  obj.method()
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
 *   // 框架自动检测此插件只使用了 write / invokeFunPre / invokeFun /
 *   // endExpression / functionEnter / functionExit / scriptEnter / scriptExit /
 *   // _return / _throw / declare / endExecution，
 *   // 并自动关闭 INSTR_READ / INSTR_BINARY / INSTR_GETFIELD 等高开销插桩。
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

// ── 帧结构（指令级：只追踪函数调用嵌套，不收集子操作值）─────────────────────

class Frame {
    constructor(indent) {
        this.indent    = indent;
        this.doneLines = [];
    }

    addChild(callLine, innerLines, retLine) {
        this._children = this._children ?? [];
        this._children.push({ callLine, innerLines, retLine });
    }

    flushChildren() {
        const result = this._children ?? [];
        this._children = [];
        return result;
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

    /** 根据 iid 生成带缩进的源码片段前缀 "[row:col] <indent>" */
    _prefix(iid, indent) {
        const loc    = getLocation(this._sb, iid);
        const rc     = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const indStr = INDENT_UNIT.repeat(indent);
        return { rc, indStr, loc };
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

        const frame    = this._stack.pop();
        const callInfo = this._callStack.pop();

        const name      = f?.name || '(anonymous)';
        const loc       = getLocation(this._sb, iid);
        const rc        = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const retIndent = INDENT_UNIT.repeat(frame.indent > 0 ? frame.indent - 1 : 0);
        const retLine   = `[${rc}] ${retIndent}← return ${name} ; result=${serialize(result)}`;

        dbg.debug(`invokeFun: ← ${name} iid=${iid} stackDepth=${this._stack.length}`);

        // 收集被调函数内部已产生的 doneLines（子函数内的指令 trace）
        const innerLines = frame.doneLines;

        const parent = this._top();
        if (parent) {
            parent.addChild(callInfo.callLineTemplate, innerLines, retLine);
        } else {
            // 顶层调用：立即 emit
            this._emit(callInfo.callLineTemplate);
            for (const l of innerLines) this._emit(l);
            this._emit(retLine);
        }

        return { result };
    }

    // ── 脚本进出（KEY 级别）───────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        dbg.debug(`scriptEnter: "${originalFileName}" iid=${iid} stackDepth=${this._stack.length}`);
        this._key('info', `▶ script: ${originalFileName}`);
        this._stack.push(new Frame(1));
        this._callStack.push({ callLineTemplate: null, innerLines: [] });
    }

    scriptExit(iid, wrappedExceptionVal) {
        if (this._stack.length === 0) {
            dbg.error(`scriptExit: stack underflow (iid=${iid}) — no matching scriptEnter?`);
        } else {
            // Flush 残余的 doneLines（脚本顶层未被 endExpression flush 的行）
            const frame = this._top();
            for (const l of frame.doneLines) this._emit(l);
            this._stack.pop();
            this._callStack.pop();
        }
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
            const loc    = getLocation(this._sb, iid);
            const rc     = loc ? `${loc[0]}:${loc[1]}` : '?:?';
            const indent = INDENT_UNIT.repeat(this._top()?.indent ?? 0);
            const text   = `[${rc}] ${indent}✗ throw ; exception=${exStr}`;

            dbg.debug(`functionExit: exception at iid=${iid}: ${exStr}`);
            this._key('error', text);
            this._emit(text);
        }
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 指令级钩子：变量写入（赋值结果）─────────────────────────────────────

    /**
     * 变量写入：每次赋值立即输出一条 trace 行。
     * 这是指令级追踪的核心——只在真正的"赋值指令"处记录，
     * 不追踪赋值右侧表达式内部的子操作值。
     */
    write(iid, name, val) {
        const frame = this._top();
        if (!frame) return { result: val };

        const { rc, indStr, loc } = this._prefix(iid, frame.indent);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        const line = `[${rc}] ${indStr}${srcText} ; ${name}=${serialize(val)}`;

        // 将写入行追加到当前帧的 doneLines，等待帧 flush 时按顺序输出
        frame.doneLines.push(line);

        return { result: val };
    }

    /**
     * 变量声明初始化（仅非参数、非 catch 的声明）。
     * 效果与 write 相同，但语义上是"第一次初始化"。
     */
    declare(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        if (!isArgument && !isCatchParam) {
            this.write(iid, name, val);
        }
        return { result: val };
    }

    // ── 控制流钩子 ────────────────────────────────────────────────────────────

    _return(iid, val) {
        const frame = this._top();
        if (!frame) return { result: val };
        const { rc, indStr, loc } = this._prefix(iid, frame.indent);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        frame.doneLines.push(`[${rc}] ${indStr}${srcText} ; (return)=${serialize(val)}`);
        return { result: val };
    }

    _throw(iid, val) {
        const frame = this._top();
        if (!frame) return { result: val };
        const { rc, indStr, loc } = this._prefix(iid, frame.indent);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        frame.doneLines.push(`[${rc}] ${indStr}${srcText} ; (throw)=${serialize(val)}`);
        return { result: val };
    }

    // ── 表达式语句末尾（非赋值/非调用的纯副作用语句）─────────────────────────

    /**
     * endExpression（J$.X1）：在每条 ExpressionStatement 末尾触发。
     *
     * 指令级模式下，赋值和函数调用已分别在 write / invokeFun 中记录，
     * 所以这里只处理"纯副作用语句"（如 `i++`、`delete obj.x` 等）。
     *
     * 同时负责 flush 当前帧已积累的 doneLines（包含本语句内产生的 write 行）。
     */
    endExpression(iid) {
        const frame = this._top();
        if (!frame) return;

        // Flush 本语句内积累的所有 write/return/throw 行
        const lines = frame.doneLines.splice(0);
        // 同时 flush 子函数调用行（invokeFun 已记录在 frame.addChild）
        const children = frame.flushChildren();

        // 若本语句什么都没产生（纯读取表达式，如 `x`），仍记录一条源码行作标记
        const hasContent = lines.length > 0 || children.length > 0;

        if (!hasContent) {
            // 纯副作用/纯读语句：仅记录源码位置
            const loc    = getLocation(this._sb, iid);
            const rc     = loc ? `${loc[0]}:${loc[1]}` : '?:?';
            const indStr = INDENT_UNIT.repeat(frame.indent);
            const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
            const line = `[${rc}] ${indStr}${srcText}`;
            if (this._stack.length <= 1) {
                this._emit(line);
            } else {
                this._top()?.doneLines.push(line);
            }
            return;
        }

        // 将积累的行送入输出（或父帧）
        const allLines = [];
        for (const l of lines) allLines.push(l);
        for (const { callLine, innerLines, retLine } of children) {
            if (callLine) allLines.push(callLine);
            for (const l of innerLines) allLines.push(l);
            if (retLine) allLines.push(retLine);
        }

        if (this._stack.length <= 1) {
            // 顶层：直接 emit
            for (const l of allLines) this._emit(l);
        } else {
            // 嵌套帧：放入父帧的 doneLines（等待父帧 flush）
            for (const l of allLines) {
                this._stack[this._stack.length - 1].doneLines.push(l);
            }
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
            const frame = this._stack.pop();
            this._callStack.pop();
            for (const l of frame.doneLines) this._emit(l);
        }

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
