// JALANGI DO NOT INSTRUMENT

/**
 * @file LogAll —— 记录所有运行时事件的示例分析插件。
 *
 * 演示"新式"插件写法：
 *  - 插件是一个普通的 class，不依赖任何框架全局变量
 *  - 所有外部依赖（smemory）通过构造函数参数显式注入
 *  - 通过 ESM export 导出，由调用方决定如何注册
 *
 * 用法示例：
 *
 *   import { AnalysisHost }             from '../../runtime/AnalysisHost.js';
 *   import { SMemory, SMemoryPlugin }   from '../../runtime/SMemory.js';
 *   import { LogAllAnalysis }           from './LogAll.js';
 *
 *   const smemory = new SMemory(J$.Constants);
 *   J$.smemory  = smemory;
 *   J$.analysis = new AnalysisHost()
 *       .use(new SMemoryPlugin(smemory))
 *       .use(new LogAllAnalysis(smemory));
 */

/**
 * LogAllAnalysis —— 记录所有运行时事件。
 *
 * @param {SMemory} [smemory] - 可选，不传则跳过影子内存相关日志
 */
class LogAllAnalysis {
    constructor(smemory = null) {
        this._mem = smemory;
    }

    _getValue(v) {
        if (!this._mem) return v;
        const type = typeof v;
        if ((type === 'object' || type === 'function') && v !== null) {
            const shadowObj = this._mem.getShadowObjectOfObject(v);
            return this._mem.getIDFromShadowObjectOrFrame(shadowObj);
        }
        return v;
    }

    _loc(iid) {
        if (typeof J$ !== 'undefined' && J$.iidToLocation) {
            return J$.iidToLocation(J$.sid, iid);
        }
        return String(iid);
    }

    // ── 函数调用 ───────────────────────────────────────────────────────────────

    invokeFunPre(iid, f, base, args, isConstructor, isMethod) {
        return { f, base, args, skip: false };
    }

    invokeFun(iid, f, base, args, result, isConstructor, isMethod) {
        return { result };
    }

    // ── 字面量 ─────────────────────────────────────────────────────────────────

    literal(iid, val, hasGetterSetter) {
        return { result: val };
    }

    // ── for-in ─────────────────────────────────────────────────────────────────

    forinObject(iid, val) {
        return { result: val };
    }

    // ── 变量声明 ────────────────────────────────────────────────────────────────

    declare(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        return { result: val };
    }

    // ── 属性读取 ────────────────────────────────────────────────────────────────

    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        return { base, offset, skip: false };
    }

    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        if (this._mem) {
            const shadowObj = this._mem.getShadowObject(base, offset, true);
            console.log('getField(' + JSON.stringify({
                base:         this._mem.getIDFromShadowObjectOrFrame(shadowObj.owner),
                offset,
                val:          this._getValue(val),
                isComputed,
                isOpAssign,
                isMethodCall,
            }) + ') at ' + this._loc(iid));
        }
        return { result: val };
    }

    // ── 属性写入 ────────────────────────────────────────────────────────────────

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        return { base, offset, val, skip: false };
    }

    putField(iid, base, offset, val, isComputed, isOpAssign) {
        if (this._mem) {
            const shadowObj = this._mem.getShadowObject(base, offset, true);
            console.log('putField(' + JSON.stringify({
                base:       this._mem.getIDFromShadowObjectOrFrame(shadowObj.owner),
                offset,
                val:        this._getValue(val),
                isComputed,
                isOpAssign,
            }) + ') at ' + this._loc(iid));
        }
        return { result: val };
    }

    // ── 变量读写 ────────────────────────────────────────────────────────────────

    read(iid, name, val, isGlobal, isScriptLocal) {
        return { result: val };
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        return { result: val };
    }

    // ── 控制流 ─────────────────────────────────────────────────────────────────

    _return(iid, val)  { return { result: val }; }
    _throw(iid, val)   { return { result: val }; }
    _with(iid, val)    { return { result: val }; }

    // ── 函数进出 ────────────────────────────────────────────────────────────────

    functionEnter(iid, f, dis, args) {}

    functionExit(iid, returnVal, wrappedExceptionVal) {
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 脚本进出 ────────────────────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {}

    scriptExit(iid, wrappedExceptionVal) {
        return { wrappedExceptionVal, isBacktrack: false };
    }

    // ── 运算 ───────────────────────────────────────────────────────────────────

    binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed) {
        return { op, left, right, skip: false };
    }

    binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed) {
        return { result };
    }

    unaryPre(iid, op, left) {
        return { op, left, skip: false };
    }

    unary(iid, op, left, result) {
        return { result };
    }

    conditional(iid, result) {
        return { result };
    }

    // ── eval 插桩 ──────────────────────────────────────────────────────────────

    instrumentCodePre(iid, code, isDirect) {
        return { code, skip: false };
    }

    instrumentCode(iid, newCode, newAst, isDirect) {
        return { result: newCode };
    }

    // ── 其他 ───────────────────────────────────────────────────────────────────

    endExpression(iid) {}

    endExecution() {}

    runInstrumentedFunctionBody(iid, f, functionIid) {
        return false;
    }

    /**
     * onReady：Node.js 模式下，异步初始化完成后调用 cb 开始执行目标程序。
     * 浏览器下此回调不生效。
     */
    onReady(cb) {
        cb();
    }
}

export { LogAllAnalysis };
