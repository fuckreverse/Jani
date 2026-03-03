// JALANGI DO NOT INSTRUMENT

/**
 * @file Jalangi2 运行时后端 —— 核心钩子实现。
 *
 * 本模块实现了插桩代码在运行时调用的所有 J$.xxx 函数：
 *   R（read）、W（write）、G（getField）、P（putField）、
 *   B（binary）、U（unary）、F（funcCall）、M（methodCall）、
 *   T（literal）、N（declare）、Fe/Fr（functionEnter/Exit）、
 *   Se/Sr（scriptEnter/Exit）、C/C1/C2（conditional）等。
 *
 * 使用方式（推荐）：
 *   import { createRuntime } from './analysis.js';
 *   createRuntime(J$);   // 将所有运行时函数挂到 J$
 *
 * 向后兼容：本文件末尾自动检测全局 J$ 并安装（IIFE 时代的用法）。
 */

/**
 * 将 Jalangi2 运行时钩子安装到 sandbox（通常是 J$）。
 *
 * @param {object} sandbox  - J$ 全局对象，需预先含 Constants、analysis 等字段
 */
export function createRuntime(sandbox) {
    const SPECIAL_PROP_SID = sandbox.Constants.SPECIAL_PROP_SID;
    const SPECIAL_PROP_IID = sandbox.Constants.SPECIAL_PROP_IID;

    // 保存原始 eval 引用，防止被插桩代码污染
    const EVAL_ORG = eval;   // eslint-disable-line no-eval

    // ── 内部状态 ─────────────────────────────────────────────────────────────

    // 函数返回值栈（支持 finally 块中的嵌套调用）
    const returnStack = [];

    let wrappedExceptionVal;
    let lastVal;
    let lastComputedValue;
    let switchLeft;
    const switchKeyStack = [];
    let argIndex;

    // sid 栈（支持多脚本/eval 嵌套）
    const sidStack = [];
    let sidCounter = 0;

    // ── 工具函数 ─────────────────────────────────────────────────────────────

    function getPropSafe(base, prop) {
        if (base === null || base === undefined) return undefined;
        return base[prop];
    }

    function decodeBitPattern(i, len) {
        const ret = new Array(len);
        for (let j = 0; j < len; j++) {
            ret[len - j - 1] = (i & 1) ? true : false;
            i >>= 1;
        }
        return ret;
    }

    function createBitPattern(...bits) {
        let ret = 0;
        for (const b of bits) {
            ret = (ret << 1) + (b ? 1 : 0);
        }
        return ret;
    }

    // ── SID 管理 ─────────────────────────────────────────────────────────────

    function createAndAssignNewSid() {
        sidStack.push(sandbox.sid);
        sandbox.sid = ++sidCounter;
        if (!sandbox.smap) sandbox.smap = {};
        sandbox.smap[sandbox.sid] = sandbox.iids;
    }

    function rollBackSid() {
        sandbox.sid = sidStack.pop();
    }

    // ── 函数 SID / IID 关联 ──────────────────────────────────────────────────

    function associateSidWithFunction(f, iid) {
        if (typeof f !== 'function') return;
        Object.defineProperty(f, SPECIAL_PROP_SID, { enumerable: false, writable: true, configurable: true });
        Object.defineProperty(f, SPECIAL_PROP_IID, { enumerable: false, writable: true, configurable: true });
        f[SPECIAL_PROP_SID] = sandbox.sid;
        f[SPECIAL_PROP_IID] = iid;
    }

    function updateSid(f) {
        sidStack.push(sandbox.sid);
        sandbox.sid = getPropSafe(f, SPECIAL_PROP_SID);
    }

    // ── 构造器调用 ───────────────────────────────────────────────────────────

    /**
     * 使用 Reflect.construct 反射调用构造器（替代旧式 switch/eval 实现）。
     * Reflect.construct 是 ES2015+ 标准方式，语义等价且无 eval 开销。
     */
    function callAsConstructor(Constructor, args) {
        return Reflect.construct(Constructor, args);
    }

    // ── eval / Function 插桩 ─────────────────────────────────────────────────

    function invokeEval(base, f, args, iid) {
        return f(sandbox.instrumentEvalCode(args[0], iid, false));
    }

    function invokeFunctionDecl(base, f, args, iid) {
        const newArgs = Array.from(args).map(v => String(new String(v)));
        // 先用原始参数调用一次，保留异常行为（如参数数量不对时的报错）
        f.apply(base, newArgs);
        const rawCode = `(function(${newArgs.slice(0, newArgs.length - 1).join(', ')}) { ${newArgs[newArgs.length - 1]} })`;
        const code    = sandbox.instrumentEvalCode(rawCode, iid, false);
        return EVAL_ORG(code);   // 使用 EVAL_ORG 保留原始作用域语义
    }

    // ── 核心调用逻辑 ─────────────────────────────────────────────────────────

    function callFun(f, base, args, isConstructor, iid) {
        pushSwitchKey();
        try {
            if (f === EVAL_ORG) {
                return invokeEval(base, f, args, iid);
            } else if (f === Function) {
                return invokeFunctionDecl(base, f, args, iid);
            } else if (isConstructor) {
                return callAsConstructor(f, args);
            } else {
                return Function.prototype.apply.call(f, base, args);
            }
        } finally {
            popSwitchKey();
        }
    }

    function invokeFun(iid, base, f, args, isConstructor, isMethod) {
        let aret, skip = false, result;
        const analysis = sandbox.analysis;

        if (analysis?.invokeFunPre) {
            aret = analysis.invokeFunPre(iid, f, base, args, isConstructor, isMethod,
                getPropSafe(f, SPECIAL_PROP_IID), getPropSafe(f, SPECIAL_PROP_SID));
            if (aret) {
                f    = aret.f;
                base = aret.base;
                args = aret.args;
                skip = aret.skip;
            }
        }

        if (!skip) {
            result = callFun(f, base, args, isConstructor, iid);
        }

        if (analysis?.invokeFun) {
            aret = analysis.invokeFun(iid, f, base, args, result, isConstructor, isMethod,
                getPropSafe(f, SPECIAL_PROP_IID), getPropSafe(f, SPECIAL_PROP_SID));
            if (aret) result = aret.result;
        }

        return result;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 公开运行时钩子函数（插桩代码直接调用）
    // ══════════════════════════════════════════════════════════════════════════

    /** 函数调用（F(iid, f, flags)(...args)） */
    function F(iid, f, flags) {
        const [isConstructor] = decodeBitPattern(flags, 1);
        return function (...callArgs) {
            return (lastComputedValue = invokeFun(iid, this, f, callArgs, isConstructor, false));
        };
    }

    /** 方法调用（M(iid, base, offset, flags)(...args)） */
    function M(iid, base, offset, flags) {
        const [isConstructor, isComputed] = decodeBitPattern(flags, 2);
        const f = G(iid + 2, base, offset, createBitPattern(isComputed, false, true));
        return function (...callArgs) {
            return (lastComputedValue = invokeFun(iid, base, f, callArgs, isConstructor, true));
        };
    }

    /** 忽略（Identity，占位用） */
    function I(val) { return val; }

    /** 字面量（对象/函数/数组/正则/原始值） */
    function T(iid, val, type, hasGetterSetter, internalIid) {
        associateSidWithFunction(val, internalIid);

        if (hasGetterSetter) {
            for (const offset in val) {
                if (Object.prototype.hasOwnProperty.call(val, offset)) {
                    const desc = Object.getOwnPropertyDescriptor(val, offset);
                    if (desc !== undefined) {
                        if (typeof desc.get === 'function') T(iid, desc.get, 12, false, internalIid);
                        if (typeof desc.set === 'function') T(iid, desc.set, 12, false, internalIid);
                    }
                }
            }
        }

        const analysis = sandbox.analysis;
        if (analysis?.literal) {
            const aret = analysis.literal(iid, val, hasGetterSetter);
            if (aret) val = aret.result;
        }

        return (lastComputedValue = val);
    }

    /** for-in 对象包装 */
    function H(iid, val) {
        const analysis = sandbox.analysis;
        if (analysis?.forinObject) {
            const aret = analysis.forinObject(iid, val);
            if (aret) val = aret.result;
        }
        return val;
    }

    /** 变量声明初始化 */
    function N(iid, name, val, flags) {
        const [isArgument, isLocalSync, isCatchParam] = decodeBitPattern(flags, 3);
        const analysis = sandbox.analysis;

        if (isArgument) argIndex++;

        if (!isLocalSync && analysis?.declare) {
            const idx  = (isArgument && argIndex > 1) ? argIndex - 2 : -1;
            const aret = analysis.declare(iid, name, val, isArgument, idx, isCatchParam);
            if (aret) val = aret.result;
        }
        return val;
    }

    /** 属性读取 */
    function G(iid, base, offset, flags) {
        const [isComputed, isOpAssign, isMethodCall] = decodeBitPattern(flags, 3);
        const analysis = sandbox.analysis;
        let aret, skip = false, val;

        if (analysis?.getFieldPre) {
            aret = analysis.getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall);
            if (aret) {
                base   = aret.base;
                offset = aret.offset;
                skip   = aret.skip;
            }
        }

        if (!skip) val = base[offset];

        if (analysis?.getField) {
            aret = analysis.getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall);
            if (aret) val = aret.result;
        }

        return (lastComputedValue = val);
    }

    /** 属性写入 */
    function P(iid, base, offset, val, flags) {
        const [isComputed, isOpAssign] = decodeBitPattern(flags, 2);
        const analysis = sandbox.analysis;
        let aret, skip = false;

        if (analysis?.putFieldPre) {
            aret = analysis.putFieldPre(iid, base, offset, val, isComputed, !!isOpAssign);
            if (aret) {
                base   = aret.base;
                offset = aret.offset;
                val    = aret.val;
                skip   = aret.skip;
            }
        }

        if (!skip) base[offset] = val;

        if (analysis?.putField) {
            aret = analysis.putField(iid, base, offset, val, isComputed, !!isOpAssign);
            if (aret) val = aret.result;
        }

        return (lastComputedValue = val);
    }

    /** 变量读取 */
    function R(iid, name, val, flags) {
        const [isGlobal, isScriptLocal] = decodeBitPattern(flags, 2);
        const analysis = sandbox.analysis;

        if (analysis?.read) {
            const aret = analysis.read(iid, name, val, isGlobal, isScriptLocal);
            if (aret) val = aret.result;
        }

        return (lastComputedValue = val);
    }

    /** 变量写入 */
    function W(iid, name, val, lhs, flags) {
        const [isGlobal, isScriptLocal, isDeclaration] = decodeBitPattern(flags, 3);
        const analysis = sandbox.analysis;

        if (analysis?.write) {
            const aret = analysis.write(iid, name, val, lhs, isGlobal, isScriptLocal);
            if (aret) val = aret.result;
        }

        if (!isDeclaration) {
            return (lastComputedValue = val);
        } else {
            lastComputedValue = undefined;
            return val;
        }
    }

    /** with 语句 */
    function Wi(iid, val) {
        const analysis = sandbox.analysis;
        if (analysis?._with) {
            const aret = analysis._with(iid, val);
            if (aret) val = aret.result;
        }
        return val;
    }

    /** 未捕获异常 */
    function Ex(iid, e) {
        wrappedExceptionVal = { exception: e };
    }

    /** throw 语句 */
    function Th(iid, val) {
        const analysis = sandbox.analysis;
        if (analysis?._throw) {
            const aret = analysis._throw(iid, val);
            if (aret) val = aret.result;
        }
        return (lastComputedValue = val);
    }

    /** return 语句 */
    function Rt(iid, val) {
        const analysis = sandbox.analysis;
        if (analysis?._return) {
            const aret = analysis._return(iid, val);
            if (aret) val = aret.result;
        }
        returnStack.pop();
        returnStack.push(val);
        return (lastComputedValue = val);
    }

    /** 函数真正返回时（由 finally 块中的基础包装调用），读取 Rt 存储的返回值 */
    function Ra() {
        const returnVal  = returnStack.pop();
        wrappedExceptionVal = undefined;
        return returnVal;
    }

    /** 函数进入 */
    function Fe(iid, f, dis, args) {
        argIndex = 0;
        returnStack.push(undefined);
        wrappedExceptionVal = undefined;
        updateSid(f);
        sandbox.analysis?.functionEnter?.(iid, f, dis, args);
    }

    /** 函数退出 */
    function Fr(iid) {
        let isBacktrack = false;
        let returnVal   = returnStack.pop();
        const analysis  = sandbox.analysis;

        if (analysis?.functionExit) {
            const aret = analysis.functionExit(iid, returnVal, wrappedExceptionVal);
            if (aret) {
                returnVal           = aret.returnVal;
                wrappedExceptionVal = aret.wrappedExceptionVal;
                isBacktrack         = aret.isBacktrack;
            }
        }

        rollBackSid();

        if (!isBacktrack) returnStack.push(returnVal);

        // 重新抛出未捕获异常，保持异常控制流
        if (wrappedExceptionVal !== undefined) {
            const tmp   = wrappedExceptionVal.exception;
            wrappedExceptionVal = undefined;
            throw tmp;
        }

        return isBacktrack;
    }

    /** 脚本进入 */
    function Se(iid, val, origFileName) {
        createAndAssignNewSid();
        sandbox.analysis?.scriptEnter?.(iid, val, origFileName);
        lastComputedValue = undefined;
    }

    /** 脚本退出 */
    function Sr(iid) {
        const analysis = sandbox.analysis;
        let isBacktrack;

        if (analysis?.scriptExit) {
            const aret = analysis.scriptExit(iid, wrappedExceptionVal);
            if (aret) {
                wrappedExceptionVal = aret.wrappedExceptionVal;
                isBacktrack         = aret.isBacktrack;
            }
        }

        rollBackSid();

        if (wrappedExceptionVal !== undefined) {
            const tmp   = wrappedExceptionVal.exception;
            wrappedExceptionVal = undefined;
            throw tmp;
        }

        return isBacktrack;
    }

    /** 复合赋值（+=、-= 等） */
    function A(iid, base, offset, op, flags) {
        const [isComputed, isNumber] = decodeBitPattern(flags, 2);
        let oprnd1 = G(iid + 2, base, offset, createBitPattern(isComputed, true, false));
        if (isNumber) oprnd1 = +oprnd1;
        return (oprnd2) => {
            const val = B(iid, op, oprnd1, oprnd2, createBitPattern(false, true, false));
            return P(iid, base, offset, val, createBitPattern(isComputed, true));
        };
    }

    /** 二元运算 */
    function B(iid, op, left, right, flags) {
        const [isComputed, isOpAssign, isSwitchCaseComparison] = decodeBitPattern(flags, 3);
        const analysis = sandbox.analysis;
        let result, aret, skip = false;

        if (analysis?.binaryPre) {
            aret = analysis.binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed);
            if (aret) {
                op    = aret.op;
                left  = aret.left;
                right = aret.right;
                skip  = aret.skip;
            }
        }

        if (!skip) {
            switch (op) {
                case '+':   result = left +   right; break;
                case '-':   result = left -   right; break;
                case '*':   result = left *   right; break;
                case '/':   result = left /   right; break;
                case '%':   result = left %   right; break;
                case '**':  result = left **  right; break;
                case '<<':  result = left <<  right; break;
                case '>>':  result = left >>  right; break;
                case '>>>': result = left >>> right; break;
                case '<':   result = left <   right; break;
                case '>':   result = left >   right; break;
                case '<=':  result = left <=  right; break;
                case '>=':  result = left >=  right; break;
                case '==':  result = left ==  right; break; // eslint-disable-line eqeqeq
                case '!=':  result = left !=  right; break; // eslint-disable-line eqeqeq
                case '===': result = left === right; break;
                case '!==': result = left !== right; break;
                case '&':   result = left &   right; break;
                case '|':   result = left |   right; break;
                case '^':   result = left ^   right; break;
                case 'delete': result = delete left[right]; break;
                case 'instanceof': result = left instanceof right; break;
                case 'in':  result = left in  right; break;
                default:
                    throw new Error(`Binary operator "${op}" at iid ${iid} not found`);
            }
        }

        if (analysis?.binary) {
            aret = analysis.binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed);
            if (aret) result = aret.result;
        }

        return (lastComputedValue = result);
    }

    /** 一元运算 */
    function U(iid, op, left) {
        const analysis = sandbox.analysis;
        let result, aret, skip = false;

        if (analysis?.unaryPre) {
            aret = analysis.unaryPre(iid, op, left);
            if (aret) {
                op   = aret.op;
                left = aret.left;
                skip = aret.skip;
            }
        }

        if (!skip) {
            switch (op) {
                case '+':      result = +left;       break;
                case '-':      result = -left;       break;
                case '~':      result = ~left;       break;
                case '!':      result = !left;       break;
                case 'typeof': result = typeof left; break;
                case 'void':   result = void (left); break;
                default:
                    throw new Error(`Unary operator "${op}" at iid ${iid} not found`);
            }
        }

        if (analysis?.unary) {
            aret = analysis.unary(iid, op, left, result);
            if (aret) result = aret.result;
        }

        return (lastComputedValue = result);
    }

    // ── Switch 辅助 ──────────────────────────────────────────────────────────

    function pushSwitchKey() { switchKeyStack.push(switchLeft); }
    function popSwitchKey()  { switchLeft = switchKeyStack.pop(); }

    function last() { return (lastComputedValue = lastVal); }

    /** switch 判别式（C1(iid, x) —— 记录 switchLeft） */
    function C1(iid, left) {
        switchLeft = left;
        return (lastComputedValue = left);
    }

    /** switch case 标签比较（C2(iid, right)） */
    function C2(iid, right) {
        const analysis = sandbox.analysis;
        // iid+1 避免与 iid 冲突
        let result = B(iid + 1, '===', switchLeft, right, createBitPattern(false, false, true));

        if (analysis?.conditional) {
            const aret = analysis.conditional(iid, result);
            if (aret) {
                if (result && !aret.result) {
                    right = !right;
                } else if (result && aret.result) {
                    right = switchLeft;
                }
            }
        }

        return (lastComputedValue = right);
    }

    /** 条件表达式（C(iid, left)） */
    function C(iid, left) {
        const analysis = sandbox.analysis;
        if (analysis?.conditional) {
            const aret = analysis.conditional(iid, left);
            if (aret) left = aret.result;
        }
        lastVal = left;
        return (lastComputedValue = left);
    }

    /** 采样模式：判断是否执行插桩版函数体 */
    function S(iid, f) {
        const analysis = sandbox.analysis;
        if (analysis?.runInstrumentedFunctionBody) {
            return analysis.runInstrumentedFunctionBody(
                iid, f,
                getPropSafe(f, SPECIAL_PROP_IID),
                getPropSafe(f, SPECIAL_PROP_SID)
            );
        }
        return true;
    }

    /** 返回最后一个计算值 */
    function L() { return lastComputedValue; }

    /** 顶层表达式语句结束标记 */
    function X1(iid, val) {
        sandbox.analysis?.endExpression?.(iid);
        return (lastComputedValue = val);
    }

    /** 执行结束（Node.js 退出 / 浏览器 Alt-Shift-T） */
    function endExecution() {
        sandbox.analysis?.endExecution?.();
    }

    /**
     * 日志输出——统一路由：
     *  1. sandbox.tracer（TraceLogger）存在时，作为 KEY 事件输出（控制台 + 后端）
     *  2. 旧式 sandbox.Results 面板（浏览器内嵌结果显示）
     *  3. 回退：console.log
     */
    function log(str) {
        if (sandbox.tracer?.key) {
            sandbox.tracer.key('info', String(str));
        } else if (sandbox.Results?.execute) {
            sandbox.Results.execute((div) => { div.append(`${str}<br>`); });
        } else {
            console.log(str);
        }
    }

    // ── 安装到 sandbox ───────────────────────────────────────────────────────

    Object.assign(sandbox, {
        U,          // Unary operation
        B,          // Binary operation
        C,          // Condition
        C1,         // Switch key
        C2,         // case label C1 === C2
        _: last,    // Last value passed to C

        H,          // hash in for-in
        I,          // Ignore argument
        G,          // getField
        P,          // putField
        R,          // Read
        W,          // Write
        N,          // Init (declare)
        T,          // object/function/regexp/array Literal
        F,          // Function call
        M,          // Method call
        A,          // Modify and assign +=, -= …
        Fe,         // Function enter
        Fr,         // Function return
        Se,         // Script enter
        Sr,         // Script return
        Rt,         // returned value
        Th,         // thrown value
        Ra,
        Ex,
        L,
        X1,         // top level expression
        Wi,         // with statement
        endExecution,
        S,
        EVAL_ORG,
        log,
    });
}
