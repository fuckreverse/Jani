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

    // ── TODO-13: CallID 机制 —— 区分同一函数的不同调用（递归/闭包/异步） ────

    /** 调用 ID 全局单调计数器 */
    #callIdCounter = 0;

    /** 当前调用帧的 callId（0 = 顶层 / 脚本作用域） */
    #currentCallId = 0;

    /** 调用 ID 栈，支持递归与嵌套调用 */
    #callIdStack = [];

    // ── TODO-11: Shadow Frame 机制 —— 按 (defScopeId, callId) 缓存变量值 ──────

    /**
     * Shadow Frame 映射：`${defScopeId}:${callId}` → Map<name, value>
     * 由 W() 在写入时填充，由 Rl() 在轻量读取时消费。
     */
    #shadowFrameMap = new Map();

    // ── TODO-14: 对象 OID 机制 —— 为对象/数组/函数分配唯一 ID，支持别名追踪 ──

    /** OID 单调递增计数器（0 保留，表示"非对象"） */
    #oidCounter = 0;

    /**
     * 对象 → OID 映射（WeakMap 不阻止 GC）。
     * 在 T()（literal）中为新对象分配 OID；W() 中记录别名；P() 中递增版本。
     */
    #oidMap = new WeakMap();

    /**
     * OID → 版本号（对象每次被 P() 修改一个属性时递增）。
     * 版本号使得分析器能检测到"同一 OID 的值在某时刻发生了结构变化"。
     */
    #objectVersions = new Map();

    /**
     * 别名表：`${scopeId}:${callId}:${name}` → OID
     * 由 W() 在变量指向对象时填充，供 DataFlowAnalyzer 做对象别名分析。
     */
    #aliasTable = new Map();

    // ── TODO-15: 异步 ContextID 机制 —— 区分不同异步任务（async/await/Promise）──

    /** 异步上下文 ID 单调递增计数器（0 = 顶层同步上下文） */
    #asyncContextIdCounter = 0;

    /**
     * 当前激活的异步上下文 ID。
     * - 0：顶层同步代码
     * - >0：某个异步任务（async function / setTimeout 等）的回调上下文
     */
    #currentContextId = 0;

    /** 原生 eval 引用（供插桩代码使用） */
    EVAL_ORG = EVAL_ORG;

    // ── 私有工具方法 ─────────────────────────────────────────────────────────

    #pushSwitchKey() { this.#switchKeyStack.push(this.#switchLeft); }
    #popSwitchKey()  { this.#switchLeft = this.#switchKeyStack.pop(); }

    // ── TODO-11: Shadow Frame 工具方法 ──────────────────────────────────────

    /**
     * 查找 Shadow Frame 中变量的值。
     * @param {number} defScopeId  变量定义点的 Scope.id
     * @param {number} callId      对应调用帧的 callId
     * @param {string} name        变量名
     * @returns {*} 存储的值，若不存在则返回 undefined
     */
    #shadowLookup(defScopeId, callId, name) {
        const frame = this.#shadowFrameMap.get(`${defScopeId}:${callId}`);
        return frame?.get(name);
    }

    /**
     * 在 Shadow Frame 中写入变量值。
     * @param {number} defScopeId  变量定义点的 Scope.id
     * @param {number} callId      对应调用帧的 callId
     * @param {string} name        变量名
     * @param {*}      val         新值
     */
    #shadowSet(defScopeId, callId, name, val) {
        const key = `${defScopeId}:${callId}`;
        let frame = this.#shadowFrameMap.get(key);
        if (!frame) {
            frame = new Map();
            this.#shadowFrameMap.set(key, frame);
        }
        frame.set(name, val);
    }

    /**
     * 清除某个调用帧的所有 Shadow Frame 条目（函数退出时调用）。
     * @param {number} defScopeId  函数对应的 Scope.id
     * @param {number} callId      该次调用的 callId
     */
    #shadowClear(defScopeId, callId) {
        this.#shadowFrameMap.delete(`${defScopeId}:${callId}`);
    }

    // ── TODO-14: OID 工具方法 ────────────────────────────────────────────────

    /**
     * 为对象/数组/函数获取或分配 OID（Object ID）。
     * 非对象类型（null、undefined、primitive）返回 null。
     *
     * @param {*} obj  待追踪的值
     * @returns {number|null}  OID，或 null（非引用类型）
     */
    #getOrCreateOid(obj) {
        if (obj === null || obj === undefined) return null;
        if (typeof obj !== 'object' && typeof obj !== 'function') return null;
        if (this.#oidMap.has(obj)) return this.#oidMap.get(obj);
        const oid = ++this.#oidCounter;
        this.#oidMap.set(obj, oid);
        return oid;
    }

    /**
     * 返回对象的当前 OID（不分配新 OID）。
     * 供外部调试/分析器查询，不触发 OID 分配。
     *
     * @param {*} obj  要查询的值
     * @returns {number|null}  已存在的 OID，或 null
     */
    getOid(obj) {
        if (obj === null || obj === undefined) return null;
        if (typeof obj !== 'object' && typeof obj !== 'function') return null;
        return this.#oidMap.get(obj) ?? null;
    }

    /**
     * 返回对象当前的版本号（每次 P() 修改属性时递增）。
     * 返回 0 表示该对象自创建后从未被 P() 修改过。
     *
     * @param {*} obj  要查询的值
     * @returns {number}  版本号
     */
    getObjectVersion(obj) {
        const oid = this.getOid(obj);
        if (oid === null) return 0;
        return this.#objectVersions.get(oid) ?? 0;
    }

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

        // TODO-14: 为对象/数组/函数分配 OID（创建点记录到 #oidMap）
        // type: 0=object, 1=function, 2=array, 3=regex（均为引用类型）
        // 通过 #getOrCreateOid 统一处理，非引用类型自动跳过
        this.#getOrCreateOid(val);

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

        // TODO-14: 属性写入时递增对象版本号（使分析器能检测到对象结构变化）
        const oid = this.#getOrCreateOid(base);
        if (oid !== null) {
            this.#objectVersions.set(oid, (this.#objectVersions.get(oid) ?? 0) + 1);
        }

        if (analysis?.putField) {
            aret = analysis.putField(iid, base, offset, val, isComputed, !!isOpAssign);
            if (aret) val = aret.result;
        }

        return (this.#lastComputedValue = val);
    }

    /** 变量读取 */
    // TODO-7: 第五个参数 defScopeId 由插桩器注入（来自 wrapRead）
    R(iid, name, val, flags, defScopeId) {
        const [isGlobal, isScriptLocal] = decodeBitPattern(flags, 2);
        const analysis = this.analysis;

        // TODO-11: 若有 defScopeId，同步更新 Shadow Frame（确保 Rl 能读到最新值）
        if (!isGlobal && defScopeId !== undefined) {
            this.#shadowSet(defScopeId, this.#currentCallId, name, val);
        }

        if (analysis?.read) {
            const aret = analysis.read(iid, name, val, isGlobal, isScriptLocal);
            if (aret) val = aret.result;
        }

        return (this.#lastComputedValue = val);
    }

    /**
     * TODO-12: 轻量变量读取钩子（J$.Rl）。
     * 不接收 value 参数，直接从 Shadow Frame 查找变量值。
     * 当 Shadow Frame 中没有缓存时，退回全量行为（返回 undefined 并记录日志）。
     *
     * @param {number} iid         - 指令 ID
     * @param {number} defScopeId  - 变量定义点的 Scope.id（插桩器静态注入）
     * @param {string} name        - 变量名
     * @returns {*} 变量当前值
     */
    Rl(iid, defScopeId, name) {
        const val = this.#shadowLookup(defScopeId, this.#currentCallId, name);
        const analysis = this.analysis;

        // 通知分析插件（若有 read 钩子，用 isGlobal=false/isScriptLocal=false）
        if (analysis?.read) {
            const aret = analysis.read(iid, name, val, false, false);
            if (aret) return (this.#lastComputedValue = aret.result);
        }

        return (this.#lastComputedValue = val);
    }

    /** 变量写入 */
    // TODO-7/11: 第六个参数 defScopeId 由插桩器注入（来自 wrapWrite）
    W(iid, name, val, lhs, flags, defScopeId) {
        const [isGlobal, isScriptLocal, isDeclaration] = decodeBitPattern(flags, 3);
        const analysis = this.analysis;

        if (analysis?.write) {
            const aret = analysis.write(iid, name, val, lhs, isGlobal, isScriptLocal);
            if (aret) val = aret.result;
        }

        // TODO-11: 若有 defScopeId，同步写入 Shadow Frame（非全局变量才需要）
        if (!isGlobal && defScopeId !== undefined) {
            this.#shadowSet(defScopeId, this.#currentCallId, name, val);
        }

        // TODO-14: 记录别名（右值是对象/数组/函数时，记录变量 → OID 映射）
        if (!isGlobal && defScopeId !== undefined) {
            const oid = this.#getOrCreateOid(val);
            if (oid !== null) {
                this.#aliasTable.set(`${defScopeId}:${this.#currentCallId}:${name}`, oid);
            } else {
                // 右值变为非引用类型时，清除旧的别名记录
                this.#aliasTable.delete(`${defScopeId}:${this.#currentCallId}:${name}`);
            }
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
    // TODO-13: 第五个参数 defScopeId 由插桩器注入（来自 createCallAsFunEnterStatement）
    Fe(iid, f, dis, args, defScopeId) {
        this.#argIndex = 0;
        this.#returnStack.push(undefined);
        this.#wrappedExceptionVal = undefined;
        this.#updateSid(f);

        // TODO-13: 分配新 callId，压栈保存旧值
        this.#callIdStack.push({ callId: this.#currentCallId, defScopeId });
        this.#currentCallId = ++this.#callIdCounter;

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

        // TODO-13: 弹出 callId 栈，恢复调用方的 callId
        // TODO-11: 同时清理本次调用的 Shadow Frame
        const frame = this.#callIdStack.pop();
        if (frame) {
            const leavingCallId = this.#currentCallId;
            const { callId: parentCallId, defScopeId } = frame;
            // 清除刚离开的调用帧的 Shadow Frame
            if (defScopeId !== undefined) {
                this.#shadowClear(defScopeId, leavingCallId);
            }
            this.#currentCallId = parentCallId;
        }

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

    // ── TODO-15: 异步 ContextID 公开接口 ────────────────────────────────────

    /**
     * TODO-15: await 恢复点钩子（J$.Aw）。
     *
     * 在插桩代码的 `await expr` 之后注入：
     *   `(await expr, J$.Aw(iid))`
     *
     * 当 await 恢复执行时，通知运行时当前异步上下文已切换回来。
     * 分析插件可通过 `awaitResume(iid, contextId)` 回调监听。
     *
     * @param {number} iid  指令 ID（await 表达式所在位置）
     * @returns {void}
     */
    Aw(iid) {
        const analysis = this.analysis;
        if (analysis?.awaitResume) {
            analysis.awaitResume(iid, this.#currentContextId);
        }
    }

    /**
     * TODO-15: 为新的异步任务创建独立的 ContextID。
     *
     * 用于包装 setTimeout / Promise.then / setInterval 等的回调：
     * ```js
     * const ctxId = J$.newAsyncContext();
     * setTimeout(() => { J$.activateContext(ctxId); originalCallback(); }, delay);
     * ```
     *
     * @returns {number}  新分配的 ContextID（唯一单调递增）
     */
    newAsyncContext() {
        return ++this.#asyncContextIdCounter;
    }

    /**
     * TODO-15: 激活指定的异步上下文。
     *
     * 在异步回调入口调用，使后续的 R/W/G/P 等 log 条目都归属到该 contextId。
     *
     * @param {number} contextId  由 newAsyncContext() 返回的 ContextID
     */
    activateContext(contextId) {
        this.#currentContextId = contextId;
    }

    /**
     * TODO-15: 返回当前激活的异步上下文 ID。
     * 供分析器查询，用于在 log 条目上标注 contextId。
     *
     * @returns {number}  当前 ContextID（0 = 顶层同步代码）
     */
    get currentContextId() {
        return this.#currentContextId;
    }

    /**
     * TODO-15: 返回当前 CallID（最新函数调用帧的唯一 ID）。
     * 供分析器和 DataFlowAnalyzer 查询，用于区分同一函数的不同调用实例。
     *
     * @returns {number}  当前 CallID（0 = 顶层脚本作用域）
     */
    get currentCallId() {
        return this.#currentCallId;
    }
}
