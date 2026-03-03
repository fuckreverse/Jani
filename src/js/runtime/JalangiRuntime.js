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
 * 推荐用法（通过 JalangiSandbox 自动组装）：
 *   import { JalangiSandbox } from './JalangiSandbox.js';
 *   const J$ = globalThis.J$ = new JalangiSandbox({ useIdb: true });
 *
 * 直接使用（作为基类继承）：
 *   import { JalangiRuntime } from './JalangiRuntime.js';
 *   class JalangiSandbox extends JalangiRuntime { ... }
 */

// ── 模块级常量 ───────────────────────────────────────────────────────────────

// 在模块加载时捕获原生 eval，防止被插桩代码污染
const EVAL_ORG = eval; // eslint-disable-line no-eval

// ── 模块级无状态工具函数 ─────────────────────────────────────────────────────

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

// ── JalangiRuntime ───────────────────────────────────────────────────────────

/**
 * Jalangi2 运行时核心钩子，封装为可继承的类。
 *
 * 所有插桩代码直接调用的函数（R/W/G/P/B/U/F/M/T/N/Fe/Fr/Se/Sr/…）
 * 均定义为本类的方法，内部执行状态封装为私有字段（`#`）。
 *
 * 本类依赖子类（通常是 JalangiSandbox）在 `this` 上提供以下公开字段：
 *   - this.Constants   包含 { SPECIAL_PROP_SID, SPECIAL_PROP_IID } 的对象
 *   - this.analysis    当前分析插件（AnalysisHost 实例，可为 null）
 *   - this.tracer      TraceLogger 实例（可选）
 *   - this.Results     浏览器结果面板（可选）
 *   - this.smap        iid → 位置映射表（{ [sid]: { [iid]: [sl,sc,el,ec] } }）
 *   - this.sid         当前脚本 ID（number）
 *   - this.iids        当前脚本的 iid 映射（scriptEnter 时注册用）
 *   - this.instrumentEvalCode  eval 插桩函数（可选）
 *
 * 通常不直接实例化，通过 JalangiSandbox 使用。
 */
export class JalangiRuntime {

    // ── 私有执行状态 ─────────────────────────────────────────────────────────

    /** 函数返回值栈（支持 finally 块中的嵌套调用） */
    #returnStack = [];

    /** switch 语句嵌套时保存外层 switchLeft */
    #switchKeyStack = [];

    /** sid 栈（支持多脚本 / eval 嵌套） */
    #sidStack = [];

    /** 脚本 ID 单调递增计数器 */
    #sidCounter = 0;

    /** 上一个 C() 存入的原始判断值（供 _() 使用） */
    #lastVal;

    /** 最近一次计算得到的值（供 L() 使用） */
    #lastComputedValue;

    /** 当前待传播的异常包装对象 */
    #wrappedExceptionVal;

    /** switch 判别式左侧值（供 C2 比较） */
    #switchLeft;

    /** 当前函数帧已处理的参数计数（用于 declare 中计算 argumentIndex） */
    #argIndex;

    /** 原生 eval 引用（供插桩代码使用） */
    EVAL_ORG = EVAL_ORG;

    // ── 私有工具方法 ─────────────────────────────────────────────────────────

    #pushSwitchKey() { this.#switchKeyStack.push(this.#switchLeft); }
    #popSwitchKey()  { this.#switchLeft = this.#switchKeyStack.pop(); }

    #createAndAssignNewSid() {
        this.#sidStack.push(this.sid);
        this.sid = ++this.#sidCounter;
        if (!this.smap) this.smap = {};
        this.smap[this.sid] = this.iids;
    }

    #rollBackSid() {
        this.sid = this.#sidStack.pop();
    }

    #associateSidWithFunction(f, iid) {
        if (typeof f !== 'function') return;
        const propSid = this.Constants.SPECIAL_PROP_SID;
        const propIid = this.Constants.SPECIAL_PROP_IID;
        Object.defineProperty(f, propSid, { enumerable: false, writable: true, configurable: true });
        Object.defineProperty(f, propIid, { enumerable: false, writable: true, configurable: true });
        f[propSid] = this.sid;
        f[propIid] = iid;
    }

    #updateSid(f) {
        this.#sidStack.push(this.sid);
        this.sid = getPropSafe(f, this.Constants.SPECIAL_PROP_SID);
    }

    // ── 私有调用辅助 ─────────────────────────────────────────────────────────

    #callAsConstructor(Constructor, args) {
        return Reflect.construct(Constructor, args);
    }

    #invokeEval(base, f, args, iid) {
        return f(this.instrumentEvalCode(args[0], iid, false));
    }

    #invokeFunctionDecl(base, f, args, iid) {
        const newArgs = Array.from(args).map(v => String(new String(v)));
        f.apply(base, newArgs);
        const rawCode = `(function(${newArgs.slice(0, newArgs.length - 1).join(', ')}) { ${newArgs[newArgs.length - 1]} })`;
        const code    = this.instrumentEvalCode(rawCode, iid, false);
        return EVAL_ORG(code);
    }

    #callFun(f, base, args, isConstructor, iid) {
        this.#pushSwitchKey();
        try {
            if (f === EVAL_ORG) {
                return this.#invokeEval(base, f, args, iid);
            } else if (f === Function) {
                return this.#invokeFunctionDecl(base, f, args, iid);
            } else if (isConstructor) {
                return this.#callAsConstructor(f, args);
            } else {
                return Function.prototype.apply.call(f, base, args);
            }
        } finally {
            this.#popSwitchKey();
        }
    }

    #invokeFun(iid, base, f, args, isConstructor, isMethod) {
        let aret, skip = false, result;
        const analysis = this.analysis;
        const propIid  = this.Constants.SPECIAL_PROP_IID;
        const propSid  = this.Constants.SPECIAL_PROP_SID;

        if (analysis?.invokeFunPre) {
            aret = analysis.invokeFunPre(iid, f, base, args, isConstructor, isMethod,
                getPropSafe(f, propIid), getPropSafe(f, propSid));
            if (aret) {
                f    = aret.f;
                base = aret.base;
                args = aret.args;
                skip = aret.skip;
            }
        }

        if (!skip) {
            result = this.#callFun(f, base, args, isConstructor, iid);
        }

        if (analysis?.invokeFun) {
            aret = analysis.invokeFun(iid, f, base, args, result, isConstructor, isMethod,
                getPropSafe(f, propIid), getPropSafe(f, propSid));
            if (aret) result = aret.result;
        }

        return result;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 公开运行时钩子（插桩代码直接调用）
    // ══════════════════════════════════════════════════════════════════════════

    /** 函数调用（F(iid, f, flags)(...args)） */
    F(iid, f, flags) {
        const [isConstructor] = decodeBitPattern(flags, 1);
        return (...callArgs) => {
            return (this.#lastComputedValue = this.#invokeFun(iid, this, f, callArgs, isConstructor, false));
        };
    }

    /** 方法调用（M(iid, base, offset, flags)(...args)） */
    M(iid, base, offset, flags) {
        const [isConstructor, isComputed] = decodeBitPattern(flags, 2);
        const f = this.G(iid + 2, base, offset, createBitPattern(isComputed, false, true));
        return (...callArgs) => {
            return (this.#lastComputedValue = this.#invokeFun(iid, base, f, callArgs, isConstructor, true));
        };
    }

    /** 忽略（Identity，占位用） */
    I(val) { return val; }

    /** 字面量（对象/函数/数组/正则/原始值） */
    T(iid, val, type, hasGetterSetter, internalIid) {
        this.#associateSidWithFunction(val, internalIid);

        if (hasGetterSetter) {
            for (const offset in val) {
                if (Object.prototype.hasOwnProperty.call(val, offset)) {
                    const desc = Object.getOwnPropertyDescriptor(val, offset);
                    if (desc !== undefined) {
                        if (typeof desc.get === 'function') this.T(iid, desc.get, 12, false, internalIid);
                        if (typeof desc.set === 'function') this.T(iid, desc.set, 12, false, internalIid);
                    }
                }
            }
        }

        const analysis = this.analysis;
        if (analysis?.literal) {
            const aret = analysis.literal(iid, val, hasGetterSetter);
            if (aret) val = aret.result;
        }

        return (this.#lastComputedValue = val);
    }

    /** for-in 对象包装 */
    H(iid, val) {
        const analysis = this.analysis;
        if (analysis?.forinObject) {
            const aret = analysis.forinObject(iid, val);
            if (aret) val = aret.result;
        }
        return val;
    }

    /** 变量声明初始化 */
    N(iid, name, val, flags) {
        const [isArgument, isLocalSync, isCatchParam] = decodeBitPattern(flags, 3);
        const analysis = this.analysis;

        if (isArgument) this.#argIndex++;

        if (!isLocalSync && analysis?.declare) {
            const idx  = (isArgument && this.#argIndex > 1) ? this.#argIndex - 2 : -1;
            const aret = analysis.declare(iid, name, val, isArgument, idx, isCatchParam);
            if (aret) val = aret.result;
        }
        return val;
    }

    /** 属性读取 */
    G(iid, base, offset, flags) {
        const [isComputed, isOpAssign, isMethodCall] = decodeBitPattern(flags, 3);
        const analysis = this.analysis;
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

        return (this.#lastComputedValue = val);
    }

    /** 属性写入 */
    P(iid, base, offset, val, flags) {
        const [isComputed, isOpAssign] = decodeBitPattern(flags, 2);
        const analysis = this.analysis;
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

        return (this.#lastComputedValue = val);
    }

    /** 变量读取 */
    R(iid, name, val, flags) {
        const [isGlobal, isScriptLocal] = decodeBitPattern(flags, 2);
        const analysis = this.analysis;

        if (analysis?.read) {
            const aret = analysis.read(iid, name, val, isGlobal, isScriptLocal);
            if (aret) val = aret.result;
        }

        return (this.#lastComputedValue = val);
    }

    /** 变量写入 */
    W(iid, name, val, lhs, flags) {
        const [isGlobal, isScriptLocal, isDeclaration] = decodeBitPattern(flags, 3);
        const analysis = this.analysis;

        if (analysis?.write) {
            const aret = analysis.write(iid, name, val, lhs, isGlobal, isScriptLocal);
            if (aret) val = aret.result;
        }

        if (!isDeclaration) {
            return (this.#lastComputedValue = val);
        } else {
            this.#lastComputedValue = undefined;
            return val;
        }
    }

    /** with 语句 */
    Wi(iid, val) {
        const analysis = this.analysis;
        if (analysis?._with) {
            const aret = analysis._with(iid, val);
            if (aret) val = aret.result;
        }
        return val;
    }

    /** 未捕获异常 */
    Ex(iid, e) {
        this.#wrappedExceptionVal = { exception: e };
    }

    /** throw 语句 */
    Th(iid, val) {
        const analysis = this.analysis;
        if (analysis?._throw) {
            const aret = analysis._throw(iid, val);
            if (aret) val = aret.result;
        }
        return (this.#lastComputedValue = val);
    }

    /** return 语句 */
    Rt(iid, val) {
        const analysis = this.analysis;
        if (analysis?._return) {
            const aret = analysis._return(iid, val);
            if (aret) val = aret.result;
        }
        this.#returnStack.pop();
        this.#returnStack.push(val);
        return (this.#lastComputedValue = val);
    }

    /** 函数真正返回时（由 finally 包装调用），读取 Rt 存储的返回值 */
    Ra() {
        const returnVal           = this.#returnStack.pop();
        this.#wrappedExceptionVal = undefined;
        return returnVal;
    }

    /** 函数进入 */
    Fe(iid, f, dis, args) {
        this.#argIndex = 0;
        this.#returnStack.push(undefined);
        this.#wrappedExceptionVal = undefined;
        this.#updateSid(f);
        this.analysis?.functionEnter?.(iid, f, dis, args);
    }

    /** 函数退出 */
    Fr(iid) {
        let isBacktrack = false;
        let returnVal   = this.#returnStack.pop();
        const analysis  = this.analysis;

        if (analysis?.functionExit) {
            const aret = analysis.functionExit(iid, returnVal, this.#wrappedExceptionVal);
            if (aret) {
                returnVal                 = aret.returnVal;
                this.#wrappedExceptionVal = aret.wrappedExceptionVal;
                isBacktrack               = aret.isBacktrack;
            }
        }

        this.#rollBackSid();

        if (!isBacktrack) this.#returnStack.push(returnVal);

        // 重新抛出未捕获异常，保持异常控制流
        if (this.#wrappedExceptionVal !== undefined) {
            const tmp                 = this.#wrappedExceptionVal.exception;
            this.#wrappedExceptionVal = undefined;
            throw tmp;
        }

        return isBacktrack;
    }

    /** 脚本进入 */
    Se(iid, val, origFileName) {
        this.#createAndAssignNewSid();
        this.analysis?.scriptEnter?.(iid, val, origFileName);
        this.#lastComputedValue = undefined;
    }

    /** 脚本退出 */
    Sr(iid) {
        const analysis = this.analysis;
        let isBacktrack;

        if (analysis?.scriptExit) {
            const aret = analysis.scriptExit(iid, this.#wrappedExceptionVal);
            if (aret) {
                this.#wrappedExceptionVal = aret.wrappedExceptionVal;
                isBacktrack               = aret.isBacktrack;
            }
        }

        this.#rollBackSid();

        if (this.#wrappedExceptionVal !== undefined) {
            const tmp                 = this.#wrappedExceptionVal.exception;
            this.#wrappedExceptionVal = undefined;
            throw tmp;
        }

        return isBacktrack;
    }

    /** 复合赋值（+=、-= 等） */
    A(iid, base, offset, op, flags) {
        const [isComputed, isNumber] = decodeBitPattern(flags, 2);
        let oprnd1 = this.G(iid + 2, base, offset, createBitPattern(isComputed, true, false));
        if (isNumber) oprnd1 = +oprnd1;
        return (oprnd2) => {
            const val = this.B(iid, op, oprnd1, oprnd2, createBitPattern(false, true, false));
            return this.P(iid, base, offset, val, createBitPattern(isComputed, true));
        };
    }

    /** 二元运算 */
    B(iid, op, left, right, flags) {
        const [isComputed, isOpAssign, isSwitchCaseComparison] = decodeBitPattern(flags, 3);
        const analysis = this.analysis;
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
                case '+':          result = left +   right; break;
                case '-':          result = left -   right; break;
                case '*':          result = left *   right; break;
                case '/':          result = left /   right; break;
                case '%':          result = left %   right; break;
                case '**':         result = left **  right; break;
                case '<<':         result = left <<  right; break;
                case '>>':         result = left >>  right; break;
                case '>>>':        result = left >>> right; break;
                case '<':          result = left <   right; break;
                case '>':          result = left >   right; break;
                case '<=':         result = left <=  right; break;
                case '>=':         result = left >=  right; break;
                case '==':         result = left ==  right; break; // eslint-disable-line eqeqeq
                case '!=':         result = left !=  right; break; // eslint-disable-line eqeqeq
                case '===':        result = left === right; break;
                case '!==':        result = left !== right; break;
                case '&':          result = left &   right; break;
                case '|':          result = left |   right; break;
                case '^':          result = left ^   right; break;
                case 'delete':     result = delete left[right]; break;
                case 'instanceof': result = left instanceof right; break;
                case 'in':         result = left in  right; break;
                default:
                    throw new Error(`Binary operator "${op}" at iid ${iid} not found`);
            }
        }

        if (analysis?.binary) {
            aret = analysis.binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed);
            if (aret) result = aret.result;
        }

        return (this.#lastComputedValue = result);
    }

    /** 一元运算 */
    U(iid, op, left) {
        const analysis = this.analysis;
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

        return (this.#lastComputedValue = result);
    }

    /** 返回上一个 C() 存入的原始判断值 */
    _() { return (this.#lastComputedValue = this.#lastVal); }

    /** switch 判别式（记录 switchLeft） */
    C1(iid, left) {
        this.#switchLeft = left;
        return (this.#lastComputedValue = left);
    }

    /** switch case 标签比较（C1 === C2） */
    C2(iid, right) {
        const analysis = this.analysis;
        let result = this.B(iid + 1, '===', this.#switchLeft, right, createBitPattern(false, false, true));

        if (analysis?.conditional) {
            const aret = analysis.conditional(iid, result);
            if (aret) {
                if (result && !aret.result) {
                    right = !right;
                } else if (result && aret.result) {
                    right = this.#switchLeft;
                }
            }
        }

        return (this.#lastComputedValue = right);
    }

    /** 条件表达式 */
    C(iid, left) {
        const analysis = this.analysis;
        if (analysis?.conditional) {
            const aret = analysis.conditional(iid, left);
            if (aret) left = aret.result;
        }
        this.#lastVal = left;
        return (this.#lastComputedValue = left);
    }

    /** 采样模式：判断是否执行插桩版函数体 */
    S(iid, f) {
        const analysis = this.analysis;
        if (analysis?.runInstrumentedFunctionBody) {
            return analysis.runInstrumentedFunctionBody(
                iid, f,
                getPropSafe(f, this.Constants.SPECIAL_PROP_IID),
                getPropSafe(f, this.Constants.SPECIAL_PROP_SID)
            );
        }
        return true;
    }

    /** 返回最后一个计算值 */
    L() { return this.#lastComputedValue; }

    /** 顶层表达式语句结束标记 */
    X1(iid, val) {
        this.analysis?.endExpression?.(iid);
        return (this.#lastComputedValue = val);
    }

    /** 执行结束（Node.js 退出 / 浏览器 Alt-Shift-T） */
    endExecution() {
        this.analysis?.endExecution?.();
    }

    /**
     * 日志输出——统一路由：
     *  1. this.tracer（TraceLogger）存在时，作为 KEY 事件输出（控制台 + 后端）
     *  2. 旧式 this.Results 面板（浏览器内嵌结果显示）
     *  3. 回退：console.log
     */
    log(str) {
        if (this.tracer?.key) {
            this.tracer.key('info', String(str));
        } else if (this.Results?.execute) {
            this.Results.execute((div) => { div.append(`${str}<br>`); });
        } else {
            console.log(str);
        }
    }
}
