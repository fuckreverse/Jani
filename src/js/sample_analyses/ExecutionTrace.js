// JALANGI DO NOT INSTRUMENT

/**
 * @file ExecutionTrace —— 按语句粒度输出执行 trace，便于 LLM 分析。
 *
 * 每条顶层表达式语句输出格式：
 *
 *   [seq] [row:col]  <indent>原始源码文本 ; var1=v1, var2=v2, ...
 *   [seq] [row:col]  <indent+1>→ call fn(n) ; arg0=v, ...
 *   [seq] [row:col]  <indent+2>内层语句 ; ...
 *   [seq] [row:col]  <indent+1>← return fn ; result=v
 *
 * 顶层语句行始终先输出（包含该语句执行完毕后的最终变量值），
 * 然后按执行顺序依次输出嵌套的 call/return 及函数体内语句。
 *
 * 用法：
 *   import { ExecutionTraceAnalysis } from './ExecutionTrace.js';
 *   J$.analysis = new ExecutionTraceAnalysis(J$, originalSourceCode);
 */

const MAX_BYTES = 100;
const INDENT_UNIT = '  ';

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
    // 行首的前导空白后续会被 trim 掉，不影响展示。
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
//
// 每进入一层（script / function call），压入一个 Frame。
// Frame 记录该层内所有语句的已序列化输出行（_lines），
// 以及当前正在收集中的语句 pending（_kvMap / _firstIid）。
//
// endExpression 时：
//   1. 把 _kvMap 序列化为顶层语句行，seq 号在此刻分配
//   2. 把该语句执行期间嵌套产生的子行（call/ret/内层语句）从子层取出，
//      附加在顶层语句行之后，统一加入本层的 _lines
//
// invokeFunPre：
//   压入子 Frame，记录 call 行文本（带 seq 占位，稍后输出）
//
// invokeFun（返回后）：
//   1. flush 子层当前 pending
//   2. 把子层所有已完成的行连同 call/ret 行合并为一个"子块"
//   3. 把子块附加到父层当前语句的 _children 里

class Frame {
    constructor(indent) {
        this.indent   = indent;       // 本层基础缩进级别
        this._kvMap   = new Map();    // 当前语句 pending kv（key→最新值）
        this._firstIid = null;        // 当前语句首个子操作 iid
        this._children = [];          // 当前语句产生的子块（call/ret + 内层行）
        this.doneLines = [];          // 本层已完成的输出行（字符串数组）
    }

    collect(iid, key, val) {
        if (this._firstIid === null) this._firstIid = iid;
        this._kvMap.set(key, val);
    }

    /**
     * 将子块（调用链产生的行）附加到当前语句的 children 中。
     * callLine / retLine 是 call/return 的文本行（已格式化，含 seq 占位）。
     */
    addChild(callLine, innerLines, retLine) {
        this._children.push({ callLine, innerLines, retLine });
    }

    /**
     * Flush 当前 pending 为一条完整语句记录（顶层行 + children）。
     * 返回 { stmtLine, childLines } 供调用方分配 seq 并输出。
     */
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

        // 收集所有子行（保持执行顺序）
        const childLines = [];
        for (const { callLine, innerLines, retLine } of this._children) {
            if (callLine) childLines.push(callLine);
            childLines.push(...innerLines);
            if (retLine) childLines.push(retLine);
        }

        // 清空
        this._kvMap.clear();
        this._firstIid = null;
        this._children = [];

        return { stmtLine, childLines };
    }
}

// ── 分析类 ───────────────────────────────────────────────────────────────────

export class ExecutionTraceAnalysis {
    /**
     * @param {object} [sandbox]     - J$ 全局对象
     * @param {string} [sourceCode]  - 原始源码文本
     */
    constructor(sandbox, sourceCode) {
        this._sb    = sandbox;
        this._seq   = 0;
        this._lines = sourceCode ? sourceCode.split(/\r\n|\r|\n/) : null;
        this._stack = [];   // Frame 栈

        // 正在进行中的函数调用信息栈（与 _stack 同步 push/pop）
        // 每项：{ callLineTemplate, innerLines }
        this._callStack = [];
    }

    _output(line) {
        const sb = this._sb;
        if (sb?.log) sb.log(line); else console.log(line);
    }

    _nextSeq() { return ++this._seq; }

    _top() { return this._stack[this._stack.length - 1]; }

    /** 输出并编号一行 */
    _emit(text) {
        this._output(`[${this._nextSeq()}] ${text}`);
    }

    /**
     * Flush 当前 Frame 栈顶的 pending 语句，立即输出所有行（含 children）。
     */
    _flushTop(stmtIid) {
        const frame = this._top();
        if (!frame) return;
        const result = frame.flushStmt(stmtIid, this._sb, this._lines);
        if (!result) return;

        const { stmtLine, childLines } = result;
        // 先输出顶层语句行
        this._emit(stmtLine);
        // 再输出子行（call/ret/内层语句），每行单独分配 seq
        for (const cl of childLines) {
            this._emit(cl);
        }
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

        const loc        = getLocation(this._sb, iid);
        const rc         = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const parentIndent = this._stack.length > 0 ? this._top().indent : 0;
        const callIndent   = INDENT_UNIT.repeat(parentIndent + 1);
        // call 行模板（不含 seq，稍后输出时分配）
        const callLineTemplate = `[${rc}] ${callIndent}${desc}${kvParts.length ? ' ; ' + kvParts.join(', ') : ''}`;

        // push 新 Frame（函数体缩进 = parent.indent + 2，比 call 行多一级）
        const newIndent = parentIndent + 2;
        this._stack.push(new Frame(newIndent));
        this._callStack.push({ callLineTemplate, innerLines: [] });

        return { f, base, args, skip: false };
    }

    invokeFun(iid, f, base, args, result, isConstructor, isMethod) {
        // flush 当前层残余 pending
        this._flushTop(iid);

        // 收集当前层所有已完成的行
        const frame = this._stack.pop();
        const callInfo = this._callStack.pop();

        const name   = f?.name || '(anonymous)';
        const loc    = getLocation(this._sb, iid);
        const rc     = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        const retIndent = INDENT_UNIT.repeat(frame.indent > 0 ? frame.indent - 1 : 0);
        const retLineTemplate = `[${rc}] ${retIndent}← return ${name} ; result=${serialize(result)}`;

        // 把 call/inner/ret 作为子块附加给父层的当前语句
        const parent = this._top();
        if (parent) {
            parent.addChild(
                callInfo.callLineTemplate,
                [...frame.doneLines],
                retLineTemplate
            );
        } else {
            // 顶层（script 根层）调用，直接输出
            this._emit(callInfo.callLineTemplate);
            for (const l of frame.doneLines) this._emit(l);
            this._emit(retLineTemplate);
        }

        return { result };
    }

    // ── 脚本进出 ──────────────────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        const loc = getLocation(this._sb, iid);
        const rc  = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        this._emit(`[${rc}] ▶ script: ${originalFileName}`);
        this._stack.push(new Frame(1));
        this._callStack.push({ callLineTemplate: null, innerLines: [] });
    }

    scriptExit(iid, wrappedExceptionVal) {
        this._flushTop(iid);
        this._stack.pop();
        this._callStack.pop();
        const loc = getLocation(this._sb, iid);
        const rc  = loc ? `${loc[0]}:${loc[1]}` : '?:?';
        this._emit(`[${rc}] ◀ script end`);
        return { wrappedExceptionVal, isBacktrack: false };
    }

    functionEnter(iid, f, dis, args) { /* 缩进由 invokeFunPre 管理 */ }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        if (wrappedExceptionVal) {
            this._flushTop(iid);
            const loc    = getLocation(this._sb, iid);
            const rc     = loc ? `${loc[0]}:${loc[1]}` : '?:?';
            const indent = INDENT_UNIT.repeat(this._top()?.indent ?? 0);
            this._emit(`[${rc}] ${indent}✗ throw ; exception=${serialize(wrappedExceptionVal.exception)}`);
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

    binary(iid, op, left, right, result)   { this._top()?.collect(iid, `(${op})`, result); return { result }; }
    unary(iid, op, left, result)           { this._top()?.collect(iid, `(${op})`, result); return { result }; }

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

        // 把完成的行加入本层 doneLines，在父层 flushStmt 时统一输出
        // —— 但若已在根层（script 层，栈长度==1），直接输出
        if (this._stack.length <= 1) {
            // script 层：直接输出
            this._emit(stmtLine);
            for (const cl of childLines) this._emit(cl);
        } else {
            // 函数体层：加入本层 doneLines，等父层 invokeFun 时取走
            frame.doneLines.push(stmtLine, ...childLines);
        }
    }

    endExecution() {
        while (this._stack.length > 0) {
            this._flushTop(null);
            this._stack.pop();
            this._callStack.pop();
        }
        this._output(`=== ExecutionTrace: total ${this._seq} events ===`);
    }

    onReady(cb) { cb(); }
}
