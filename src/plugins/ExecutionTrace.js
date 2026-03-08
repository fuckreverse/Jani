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
 * 每条 trace 行输出格式（由 OUTPUT_FORMAT 控制）：
 *
 *   FORMAT_TREE (1) — Unicode 树形符号（seq/rc 固定宽度对齐）：
 *     [  9] [ 687:22] │ │ │ ┬ (anonymous)(0 args)
 *     [ 10] [3943:14] │ │ │ │ ┬ Object(1 args) arg0=Symbol(Symbol.iterator)
 *     [ 11] [3943:14] │ │ │ │ └ return Object ={}
 *     [ 12] [ 687:22] │ │ │ └ return (anonymous) =undefined
 *
 *   FORMAT_BLOCK (2) — #region/#endregion 折叠块（VS Code 任意文件可折叠）：
 *     [  9] // #region [ 687:22] CALL (anonymous)(0 args)
 *     [ 10]   // #region [3943:14] CALL Object(1 args) arg0=Symbol(Symbol.iterator)
 *     [ 11]   // #endregion Object ={}
 *     [ 12] // #endregion (anonymous) =undefined
 *
 *   FORMAT_PIPE (4) — ASCII pipe 符号（| 数量 = 调用深度）：
 *     [  9] | | | (anonymous)(0 args) [ 687:22]
 *     [ 10] | | | | Object(1 args) [3943:14] arg0=Symbol(Symbol.iterator)
 *     [ 11] | | | | Object RETN ={} [3943:14]
 *     [ 12] | | | (anonymous) RETN =undefined [ 687:22]
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
import { createLogger, DOMAIN } from '../logger/logger.js';

const MAX_BYTES = 100;

const dbg = createLogger(DOMAIN.ANALYSIS);

// ── 输出格式选择（硬编码，改这里切换）────────────────────────────────────────
//   1 = FORMAT_TREE  : Unicode 树形符号（┬ │ └），seq/rc 固定宽度对齐
//   2 = FORMAT_BLOCK : #region/#endregion 折叠块（VS Code 任意文件可折叠）
//   4 = FORMAT_PIPE  : ASCII pipe 符号（| 数量 = 深度）
const OUTPUT_FORMAT = 1;

// seq 显示宽度（右对齐）：超过此宽度会自动溢出，不截断
const SEQ_WIDTH = 6;
// rc（行:列）显示宽度（右对齐，含冒号）
const RC_WIDTH  = 9;

// ── 工具 ─────────────────────────────────────────────────────────────────────

function serialize(v) {
    const t = typeof v;
    if (v === null)        return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'function')  return `[Function ${v.name || '(anonymous)'}]`;
    if (t === 'symbol')    return v.toString();
    if (t === 'bigint')    return `${v}n`;
    if (t === 'boolean')   return v ? 'true' : 'false';
    if (t === 'number')    return String(v);
    if (t === 'string') {
        const q = v.length > MAX_BYTES ? v.slice(0, MAX_BYTES) + '…' : v;
        return `"${q.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
    }
    if (t === 'object') {
        if (v instanceof Error) {
            const name = v.name || 'Error';
            const msg  = v.message ? String(v.message) : '';
            const truncatedMsg = msg.length > MAX_BYTES ? msg.slice(0, MAX_BYTES) + '…' : msg;
            return `${name}: ${truncatedMsg}`;
        }
        if (Array.isArray(v)) {
            return `Array(${v.length})`;
        }
        try {
            const keys = Object.keys(v);
            if (keys.length === 0) return '{}';
            const parts = [];
            let total = 2;
            for (const k of keys) {
                if (total >= MAX_BYTES) { parts.push('…'); break; }
                let vStr;
                const vv = v[k];
                const vt = typeof vv;
                if (vv === null)             vStr = 'null';
                else if (vt === 'undefined') vStr = 'undefined';
                else if (vt === 'function')  vStr = '[Function]';
                else if (vt === 'object')    vStr = '{…}';
                else if (vt === 'symbol')    vStr = vv.toString();
                else if (vt === 'bigint')    vStr = `${vv}n`;
                else                         vStr = String(vv);
                const entry = `${k}:${vStr}`;
                total += entry.length + 1;
                parts.push(entry);
            }
            const s = `{${parts.join(',')}}`;
            return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) + '…' : s;
        } catch {
            return Object.prototype.toString.call(v);
        }
    }
    return String(v);
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

/** 格式化 seq：右对齐，固定 SEQ_WIDTH 位 */
function fmtSeq(seq) {
    return String(seq).padStart(SEQ_WIDTH);
}

/** 格式化 rc（行:列）：右对齐，固定 RC_WIDTH 位 */
function fmtRc(rc) {
    return rc.padStart(RC_WIDTH);
}

// ── Formatter — 格式化策略（每种格式实现 callLine / retLine / infoLine）────────
//
// 公共接口（三个方法）：
//   callLine(seq, rc, depth, desc, kvStr)   → 调用行
//   retLine (seq, rc, depth, name, result)  → 返回行
//   infoLine(seq, rc, depth, srcText, kv)   → 普通 write/return/throw/纯副作用行
//
// depth = 调用栈深度（从 1 开始；depth=1 表示顶层调用）

class TreeFormatter {
    // ┬ 表示进入（call），└ 表示退出（return），│ 是延续线
    _treePrefix(depth, tip) {
        if (depth <= 0) return tip;
        return '│ '.repeat(depth - 1) + tip;
    }

    callLine(seq, rc, depth, desc, kvStr) {
        const ind = this._treePrefix(depth, '┬ ');
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${desc}${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, depth, name, result) {
        const ind = this._treePrefix(depth, '└ ');
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}return ${name} =${result}`;
    }

    infoLine(seq, rc, depth, srcText, kv) {
        const ind = '│ '.repeat(depth);
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${srcText}${kv ? ' ; ' + kv : ''}`;
    }
}

class BlockFormatter {
    // #region / #endregion 风格：VS Code 在任何文件中识别这两个关键字并提供折叠
    // 每层用 2 空格缩进
    _indent(depth) {
        return '  '.repeat(depth);
    }

    callLine(seq, rc, depth, desc, kvStr) {
        const ind = this._indent(depth - 1); // depth 从 1 起，depth-1 对应父层缩进
        return `[${fmtSeq(seq)}] ${ind}// #region [${fmtRc(rc)}] CALL ${desc}${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, depth, name, result) {
        const ind = this._indent(depth - 1);
        return `[${fmtSeq(seq)}] ${ind}// #endregion ${name} =${result}  [${fmtRc(rc)}]`;
    }

    infoLine(seq, rc, depth, srcText, kv) {
        const ind = this._indent(depth > 0 ? depth - 1 : 0);
        return `[${fmtSeq(seq)}] ${ind}${srcText}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
    }
}

class PipeFormatter {
    // | 数量 = depth，纯 ASCII
    _pipes(depth) {
        return '| '.repeat(depth);
    }

    callLine(seq, rc, depth, desc, kvStr) {
        return `[${fmtSeq(seq)}] ${this._pipes(depth)}${desc} [${fmtRc(rc)}]${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, depth, name, result) {
        return `[${fmtSeq(seq)}] ${this._pipes(depth)}${name} RETN =${result}  [${fmtRc(rc)}]`;
    }

    infoLine(seq, rc, depth, srcText, kv) {
        return `[${fmtSeq(seq)}] ${this._pipes(depth)}${srcText}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
    }
}

function createFormatter(format) {
    if (format === 2) return new BlockFormatter();
    if (format === 4) return new PipeFormatter();
    return new TreeFormatter(); // 默认方案1
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
     * @param {string|false} [options.nodeFile='jalangi-trace.ndjson']
     * @param {boolean} [options.nodeConsole=false]
     */
    constructor(sandbox, sourceCode, options = {}) {
        this._sb    = sandbox;
        this._seq   = 0;
        this._lines = sourceCode ? sourceCode.split(/\r\n|\r|\n/) : null;
        this._stack     = [];
        this._callStack = [];
        this._fmt       = createFormatter(OUTPUT_FORMAT);

        if (options.logger instanceof TraceLogger) {
            this._logger = options.logger;
        } else {
            const { useIdb = false, dbName, storeName, wsUrl, nodeFile, nodeConsole } = options;
            this._logger = new TraceLogger({
                useIdb,
                ...(dbName      != null && { dbName }),
                ...(storeName   != null && { storeName }),
                ...(wsUrl       != null && { wsUrl }),
                ...(nodeFile    !== undefined && { nodeFile }),
                ...(nodeConsole !== undefined && { nodeConsole }),
                keyToConsole: true,
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

        const kvParts = args.map((a, i) => `arg${i}=${serialize(a)}`);
        if (isMethod && base !== undefined) kvParts.unshift(`this=${serialize(base)}`);
        const kvStr = kvParts.length ? kvParts.join(', ') : '';

        const { rc } = this._loc(iid);
        const parentDepth = this._stack.length > 0 ? this._top().depth : 0;

        // 如果此时栈为空，说明是脚本退出后的异步回调（setTimeout / Promise / 事件监听器等）
        // 自动推入一个虚拟"异步根帧"，使后续 trace 正常落帧，不再静默丢失
        if (this._stack.length === 0) {
            this._pushAsyncRootFrame(iid);
        }

        const callMeta = { rc, depth: parentDepth + 1, desc, kvStr, name };
        this._stack.push(new Frame(parentDepth + 1));
        this._callStack.push({ callMeta });

        return { f, base, args, skip: false };
    }

    call(iid, f, base, args, result, isConstructor, isMethod) {
        if (this._stack.length === 0 || this._callStack.length === 0) {
            const name = f?.name || '(anonymous)';
            dbg.error(
                `call: stack underflow — stack=${this._stack.length}` +
                ` fn=${name} iid=${iid}`
            );
            return { result };
        }

        const frame    = this._stack.pop();
        const callInfo = this._callStack.pop();
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
                parent.doneLines.push({ type: 'call', callMeta, innerLines, retMeta });
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
        // scriptEnter 分配一个 seq，作为 trace 的第一条记录
        this._emitKeyLine(`▶ script: ${originalFileName}`);
        this._key('info', `▶ script: ${originalFileName}`);
        this._stack.push(new Frame(0));
        this._callStack.push({ callMeta: null });
    }

    scriptExit(iid, wrappedExceptionVal) {
        if (this._stack.length === 0) {
            dbg.error(`scriptExit: stack underflow (iid=${iid})`);
        } else {
            const frame = this._top();
            this._emitItems(frame.doneLines);
            this._stack.pop();
            this._callStack.pop();
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
            this._stack.push(frame);
            this._callStack.push({ callMeta });
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
        if (wrappedExceptionVal) {
            const exStr  = serialize(wrappedExceptionVal.exception);
            const { rc } = this._loc(iid);
            const frame  = this._top();
            const depth = frame?.depth ?? 0;
            frame?.doneLines.push({ type: 'info', rc, depth, srcText: '✗ throw', kv: `exception=${exStr}` });
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
                const frame    = this._stack.pop();
                const callInfo = this._callStack.pop();
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
                    parent.doneLines.push({ type: 'call', callMeta, innerLines: frame.doneLines, retMeta });
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

    write(iid, name, val) {
        const frame = this._top();
        if (!frame) return { result: val };
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        frame.doneLines.push({ type: 'info', rc, depth: frame.depth, srcText, kv: `${name}=${serialize(val)}` });
        return { result: val };
    }

    declare(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        if (!isArgument && !isCatchParam) {
            this.write(iid, name, val);
        }
        return { result: val };
    }

    returnStmt(iid, val) {
        const frame = this._top();
        if (!frame) return { result: val };
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        frame.doneLines.push({ type: 'info', rc, depth: frame.depth, srcText, kv: `(return)=${serialize(val)}` });
        return { result: val };
    }

    throwStmt(iid, val) {
        const frame = this._top();
        if (!frame) return { result: val };
        const { rc, loc } = this._loc(iid);
        const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
        frame.doneLines.push({ type: 'info', rc, depth: frame.depth, srcText, kv: `(throw)=${serialize(val)}` });
        return { result: val };
    }

    // ── 表达式语句末尾 ────────────────────────────────────────────────────────

    endExpression(iid) {
        const frame = this._top();
        if (!frame) return;

        const items = frame.doneLines.splice(0);

        if (items.length === 0) {
            // 纯副作用/纯读语句：只记录源码位置行
            const { rc, loc } = this._loc(iid);
            const srcText = loc && this._lines ? extractSource(this._lines, loc) : `(iid=${iid})`;
            const meta = { type: 'info', rc, depth: frame.depth, srcText, kv: '' };
            if (this._stack.length <= 1) {
                const line = this._fmt.infoLine(++this._seq, rc, frame.depth, srcText, '');
                this._emitRaw(line);
            } else {
                this._stack[this._stack.length - 1].doneLines.push(meta);
            }
            return;
        }

        if (this._stack.length <= 1) {
            this._emitItems(items);
        } else {
            for (const item of items) {
                this._stack[this._stack.length - 1].doneLines.push(item);
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
        this._stack.push(frame);
        this._callStack.push({ callMeta: null, _isAsyncRoot: true });
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
            this._stack.pop();
            this._callStack.pop();
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
            const frame = this._stack.pop();
            this._callStack.pop();
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
                const items = frame.doneLines.splice(0);
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
            const frame = this._stack.pop();
            this._callStack.pop();
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

    onReady(cb) { cb(); }
}
