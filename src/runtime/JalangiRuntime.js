// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

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

/**
 * Shadow Frame 缺失哨兵（Sentinel）。
 *
 * `#shadowLookup` 在 key 不存在时返回此对象，而非 `undefined`。
 * 这样 `Rl()` 能区分两种情况：
 *   - 返回 `_SHADOW_MISS`  → 变量从未被写入 Shadow Frame（真正的缺失）
 *   - 返回普通值（含 `undefined`）→ 变量值本身就是 undefined
 *
 * 使用模块级私有对象而非 Symbol，确保外部代码无法伪造。
 */
const _SHADOW_MISS = Object.freeze({ __jalangiShadowMiss: true });

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
 *   - this.analysis    当前分析插件（HookDispatcher 实例，可为 null）
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

    // ── 子类必须提供的公开字段（由 JalangiSandbox 实现）──────────────────────

    /**
     * 当前分析插件（HookDispatcher 实例，可为 null）。
     * 由子类（JalangiSandbox）在构造时初始化。
     * HookDispatcher 实现了 IAnalysisPlugin 接口（hook 方法动态挂载）。
     * 声明为 any 以避免对动态挂载方法和 observeOnly 等扩展属性的类型检查。
     * @type {any}
     */
    analysis = null;

    /**
     * 所有常量对象（SPECIAL_PROP_SID、SPECIAL_PROP_IID 等）。
     * 由子类（JalangiSandbox）提供。
     * @type {{ SPECIAL_PROP_SID: string, SPECIAL_PROP_IID: string, [key: string]: unknown }}
     */
    Constants = /** @type {any} */ (undefined);

    /**
     * TraceLogger 实例（由 ExecutionTraceAnalysis 写入，供 log() 使用，可为 null）。
     * @type {{ key?: (level: string, msg: string) => void } | null | undefined}
     */
    tracer = null;

    /**
     * 浏览器结果面板（可选，可为 null）。
     * @type {{ execute?: (fn: (div: HTMLElement) => void) => void } | null | undefined}
     */
    Results = null;

    /**
     * iid → 源码位置映射表（`{ [sid]: IidSourceMap }`）。
     * 由子类（JalangiSandbox）维护。
     * @type {Record<number, import('../types.js').IidSourceMap>}
     */
    smap = /** @type {any} */ ({});

    /**
     * 当前脚本 ID。
     * 由子类（JalangiSandbox）维护。
     * @type {number}
     */
    sid = 0;

    /**
     * 当前脚本的 iid 映射（scriptEnter 时注册用，可为 null）。
     * 由插桩器在 Se() 前写入 J$.iids。
     * @type {import('../types.js').IidSourceMap | null}
     */
    iids = null;

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

    /**
     * 当前函数帧的 defScopeId（由 Fe() 写入，供 N() 在初始化形参时写入 Shadow Frame）。
     * 顶层脚本作用域值为 undefined（不需要 Shadow Frame）。
     */
    #currentFunDefScopeId = undefined;

    // ── TODO-13: CallID 机制 —— 区分同一函数的不同调用（递归/闭包/异步） ────

    /** 调用 ID 全局单调计数器 */
    #callIdCounter = 0;

    /** 当前调用帧的 callId（0 = 顶层 / 脚本作用域） */
    #currentCallId = 0;

    /** 调用 ID 栈，支持递归与嵌套调用 */
    #callIdStack = [];

    /**
     * 闭包捕获帧绑定表：Function → parentCallId
     *
     * 在 T()（函数字面量创建）时，将当时外层调用的 #currentCallId 绑定到函数对象上。
     * 这样当内层函数在外层函数退出后才被调用时（外层 callId 已不在栈上），
     * Fe() 仍能通过这个绑定找到外层帧对应的 callId，从而正确解析闭包变量。
     *
     * 使用 WeakMap 确保不阻止函数对象被 GC 回收。
     */
    #funcClosureCallId = new WeakMap();

    /**
     * 闭包引用集合：记录所有「拥有被闭包捕获的 Shadow Frame」的 (defScopeId, callId) 对。
     *
     * **注册时机**：在 T()（函数字面量创建）时，若当前正在某函数帧内，
     * 则将 `"${currentFunDefScopeId}:${currentCallId}"` 写入此 Set。
     * 这发生在外层帧还活着的时候，能保证 Fr() 检查时数据已就绪。
     *
     * **用途**：
     * - Fr() 退出时检查 `"${leavingScopeId}:${leavingCallId}"` 是否在此 Set 中，
     *   若是则**不清除**该帧的 Shadow Frame（允许内层闭包继续读取）。
     * - #resolveCallId() 在调用栈中找不到 defScopeId 时，通过 capturedOuterCallId
     *   精确定位（不再需要从此表回退，此表仅控制 Fr() 的清理行为）。
     *
     * 使用 `"scopeId:callId"` 字符串作为 key，每次工厂函数调用产生独立 callId，
     * 多次调用不会相互覆盖，解决「工厂函数多实例互相覆盖」的问题。
     */
    #closureFrameSet = new Set();

    /**
     * 闭包引用计数：记录每个 (defScopeId, callId) 被多少个闭包函数捕获。
     */
    #closureFrameRefCount = new Map();

    /**
     * 垃圾回收注册表：当闭包函数被 GC 时，递减引用计数。
     * 若计数归零，则清理对应的 Shadow Frame，防止内存泄漏。
     */
    #closureRegistry = typeof FinalizationRegistry !== 'undefined' 
        ? new FinalizationRegistry((key) => {
            const count = this.#closureFrameRefCount.get(key) || 0;
            if (count <= 1) {
                this.#closureFrameRefCount.delete(key);
                this.#closureFrameSet.delete(key);
                const parts = key.split(':');
                this.#shadowClear(parts[0], parts[1]);
            } else {
                this.#closureFrameRefCount.set(key, count - 1);
            }
        }) 
        : null;

    /**
     * callId → 其外层帧的 capturedOuterCallId（闭包链追踪）。
     *
     * 在 Fe() 时记录：`newCallId → capturedOuterCallId`。
     * 这样当一个闭包帧退出后，#resolveCallId 仍能通过这个链向上追踪：
     *   内层 callId → middle callId → outer callId → ...
     *
     * 用于解决多层嵌套闭包场景（内层闭包访问祖父层及以上的变量）。
     */
    #callIdToOuterCallId = new Map();

    /**
     * 调用侧预传递的 capturedOuterCallId。
     *
     * **问题根源**：Fe() 的 `f` 参数是 probe 函数（arguments.callee 探针）的返回值，
     * 而非实际被调用的函数。因此 `funcClosureCallId.get(f)` 无法获取正确的外层 callId。
     *
     * **解决方案**：在 #invokeFun() 中调用函数前，预先从 funcClosureCallId 查出正确的
     * capturedOuterCallId 并存入此字段；Fe() 从这里读取（一次性消费后立即清空）。
     *
     * null 表示无预传递值（非闭包函数调用，或外层帧仍在栈中不需要此机制）。
     */
    #pendingCapturedOuterCallId = null;

    /**
     * Shadow Frame 映射：defScopeId (number) → Map<callId (number), Map<string, any>>
     * 由 W() 在写入时填充，由 Rl() 在轻量读取时消费。
     */
    #shadowFrameMap = new Map();

    /**
     * Shadow Frame 缺失计数器。
     * 每次 Rl() 查表命中 _SHADOW_MISS 哨兵时递增。
     * 可通过 getShadowStats() 查询，用于快速判断是否存在覆盖漏洞。
     */
    #shadowMissCount = 0;

    /**
     * Shadow Frame 缺失日志（仅在 debugShadow=true 时填充）。
     * 每条记录：{ iid, defScopeId, name, callId }
     */
    #shadowMissLog = [];

    /**
     * 是否开启 Shadow Frame 调试模式。
     * true → 记录每次缺失到 #shadowMissLog，并向 console.warn 输出诊断信息。
     * 由构造函数选项 `debugShadow` 控制，默认 false。
     */
    #debugShadow = false;

    // ── 函数 SID/IID 关联表（WeakMap，不阻止 GC，不污染函数对象属性）──────────

    /**
     * 函数对象 → { sid, iid } 的 WeakMap 映射表。
     *
     * 替代旧方案（直接在函数对象上 defineProperty），消除以下副作用：
     *  - V8 hidden class 污染（deoptimization）
     *  - Object.getOwnPropertyNames(fn) 结果变化
     *  - Object.freeze(fn) 场景下 defineProperty 抛 TypeError
     *
     * WeakMap 的 key 是函数对象（弱引用），GC 可正常回收。
     */
    #funcSidIidMap = new WeakMap();

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

    /**
     * 是否对 eval / new Function 的动态代码进行插桩。
     *
     * - `false`（默认）：不插桩动态代码，eval/Function 直接透传原始调用，
     *   语义完全保持原样，适合 trace / observe 等场景。
     * - `true`：对 eval/Function 创建的代码进行插桩（旧式行为），
     *   动态代码也受到分析覆盖，但存在 instrumentEvalCode 未注入时抛出异常的风险。
     *
     * 通过构造函数选项 `instrumentEval: true` 开启，
     * 或在运行时直接赋值 `J$.instrumentEvalEnabled = true`。
     */
    instrumentEvalEnabled = false;

    /**
     * eval / new Function 代码插桩入口。
     *
     * 插桩器在静态阶段会将所有 eval 调用改写为：
     *   `eval(J$.instrumentEvalCode(originalArg, iid, isDirect))`
     * 因此本方法必须始终存在（即使不做实际插桩）。
     *
     * 默认行为（`instrumentEvalEnabled = false`）：直接原样返回代码字符串，不做任何插桩。
     * 若需要对动态代码插桩，可将 `instrumentEvalEnabled` 设为 `true` 后，
     * 将本方法替换为实际插桩函数（如 `instrumentEvalCode` from esnstrument.js）。
     *
     * @param {string}  code      要（可能）插桩的代码字符串
     * @param {number}  _iid      调用点 IID（passthrough）
     * @param {boolean} _isDirect 是否直接调用 eval（passthrough）
     * @returns {string} 原始代码（不插桩时）或插桩后代码
     */
    instrumentEvalCode(code, _iid, _isDirect) {
        // instrumentEvalEnabled=false（默认）：直接返回原始代码，语义不受影响
        // instrumentEvalEnabled=true 时，子类/使用方应将本方法替换为真正的插桩函数
        return code;
    }

    /**
     * @param {object}  [options]
     * @param {boolean} [options.debugShadow=false]
     *   是否开启 Shadow Frame 调试模式。
     *   开启后，每次 Rl() 查表未命中时会：
     *     1. 递增内部 miss 计数器
     *     2. 将 { iid, defScopeId, name, callId } 追加到 miss 日志
     *     3. 向 console.warn 输出诊断信息
     *   可通过 getShadowStats() 查询统计结果。
     * @param {boolean} [options.instrumentEval=false]
     *   是否对 eval / new Function 动态创建的代码进行插桩。
     *   默认 false（不插桩），eval/Function 直接透传原始调用。
     *   设为 true 则恢复旧式行为（动态代码也被插桩分析）。
     */
    constructor(options = {}) {
        // 注意：字段初始化器在 super() 之后执行，此处 super() 隐式完成（无父类）
        this.#debugShadow          = options.debugShadow    === true;
        this.instrumentEvalEnabled = options.instrumentEval === true;
    }

    // ── 私有工具方法 ─────────────────────────────────────────────────────────

    #pushSwitchKey() { this.#switchKeyStack.push(this.#switchLeft); }
    #popSwitchKey()  { this.#switchLeft = this.#switchKeyStack.pop(); }

    // ── TODO-11: Shadow Frame 工具方法 ──────────────────────────────────────

    /**
     * 查找 Shadow Frame 中变量的值。
     *
     * @param {number} defScopeId  变量定义点的 Scope.id
     * @param {number} callId      对应调用帧的 callId
     * @param {string} name        变量名
     * @returns {*} 存储的值；若 key 不存在则返回 `_SHADOW_MISS`（哨兵，表示从未写入）
     */
    #shadowLookup(defScopeId, callId, name) {
        const scopeMap = this.#shadowFrameMap.get(Number(defScopeId));
        if (!scopeMap) return _SHADOW_MISS;
        const frame = scopeMap.get(Number(callId));
        if (!frame || !frame.has(name)) return _SHADOW_MISS;
        return frame.get(name);
    }

    /**
     * 在 Shadow Frame 中写入变量值。
     * @param {number} defScopeId  变量定义点的 Scope.id
     * @param {number} callId      对应调用帧的 callId
     * @param {string} name        变量名
     * @param {*}      val         新值
     */
    #shadowSet(defScopeId, callId, name, val) {
        const dId = Number(defScopeId);
        const cId = Number(callId);
        let scopeMap = this.#shadowFrameMap.get(dId);
        if (!scopeMap) {
            scopeMap = new Map();
            this.#shadowFrameMap.set(dId, scopeMap);
        }
        let frame = scopeMap.get(cId);
        if (!frame) {
            frame = new Map();
            scopeMap.set(cId, frame);
        }
        frame.set(name, val);
    }

    /**
     * 清除某个调用帧的所有 Shadow Frame 条目（函数退出时调用）。
     * @param {number} defScopeId  函数对应的 Scope.id
     * @param {number} callId      该次调用的 callId
     */
    #shadowClear(defScopeId, callId) {
        const dId = Number(defScopeId);
        const cId = Number(callId);
        const scopeMap = this.#shadowFrameMap.get(dId);
        if (scopeMap) {
            scopeMap.delete(cId);
            if (scopeMap.size === 0) {
                this.#shadowFrameMap.delete(dId);
            }
        }
    }

    /**
     * 解析 defScopeId 对应的正确 callId。
     *
     * 有三种情况：
     * 1. **当前帧**（defScopeId === #currentFunDefScopeId）：直接返回 #currentCallId。
     * 2. **祖先帧（仍活着）**：在调用栈 #callIdStack 中回溯寻找匹配的 defScopeId。
     * 3. **外层帧已退出（闭包）**：
     *    a. 从当前帧（callIdStack 栈顶）取 capturedOuterCallId（Fe() 时通过 #funcClosureCallId 绑定）；
     *    b. 若 shadowFrameMap 中存在 `defScopeId:capturedOuterCallId`，则返回该 callId；
     *    c. 若找不到，尝试向上递推：从 capturedOuterCallId 对应的栈帧条目继续查找；
     *    d. 安全降级：回退到 #currentCallId。
     *
     * **注意**：不再使用 #closureScopeCallId 回退，因为它是 Map（会被工厂函数多次调用覆盖）。
     * 现在完全依赖 capturedOuterCallId 精确追踪每个闭包实例的外层 callId。
     *
     * @param {number} defScopeId  变量定义点的 Scope.id
     * @returns {number}  对应的 callId；找不到时回退到 #currentCallId（安全降级）
     */
    #resolveCallId(defScopeId) {
        // 情况 1：就是当前帧
        if (defScopeId === this.#currentFunDefScopeId) {
            return this.#currentCallId;
        }
        // 情况 2：在调用栈（祖先帧）中回溯（从栈顶到栈底）
        for (let i = this.#callIdStack.length - 1; i >= 0; i--) {
            const entry = this.#callIdStack[i];
            if (entry.defScopeId === defScopeId) {
                return entry.callId;
            }
        }
        // 情况 3：外层帧已退出（闭包场景）。
        // 沿 capturedOuterCallId 链往上递推追踪，支持多层嵌套闭包。
        //
        // 链条：当前帧的 capturedOuterCallId → 该 callId 的 capturedOuterCallId → ...
        // 在 #callIdToOuterCallId 中记录了每个 callId 的外层 callId。
        //
        // 从当前栈帧的 capturedOuterCallId 开始递推，逐层向上查找，
        // 直到找到包含 `defScopeId:callId` 的 Shadow Frame 或链条断裂。
        if (this.#callIdStack.length > 0) {
            const topEntry = this.#callIdStack[this.#callIdStack.length - 1];
            let walkCallId = topEntry.capturedOuterCallId;
            const MAX_DEPTH = 64;   // 防止循环引用导致死循环
            for (let depth = 0; depth < MAX_DEPTH && walkCallId != null; depth++) {
            const scopeMap = this.#shadowFrameMap.get(Number(defScopeId));
            if (scopeMap && scopeMap.has(Number(walkCallId))) {
                return walkCallId;
            }
                // 沿链向上追溯
                walkCallId = this.#callIdToOuterCallId.get(walkCallId) ?? null;
            }
        }
        // 情况 4：capturedOuterCallId 链追溯失败，直接搜索 shadowFrameMap。
        //
        // 适用场景：函数被 JS 引擎内部协议调用（如 for...of 的 [Symbol.iterator]() / next()），
        // 不经过 J$.F/J$.M，导致 #pendingCapturedOuterCallId 从未被设置，capturedOuterCallId=null。
        // 此时 capturedOuterCallId 链为空，无法通过链追溯找到外层帧。
        //
        // 但 #closureFrameSet 机制确保了被闭包引用的 Shadow Frame 不被清除，
        // 所以 shadowFrameMap 中仍然有 defScopeId 对应的外层帧条目。
        // 取所有已存在的 callId 中最大的（最近分配的，对应最近一次调用），
        // 这在工厂模式多实例场景下是正确的（每次工厂调用分配独立的 callId）。
        {
            const scopeMap = this.#shadowFrameMap.get(Number(defScopeId));
            if (scopeMap && scopeMap.size > 0) {
                // 取最大 callId（最近分配的，对应最近一次外层函数调用）
                let maxCallId = -Infinity;
                for (const cid of scopeMap.keys()) {
                    if (cid > maxCallId) maxCallId = cid;
                }
                return maxCallId;
            }
        }
        // 安全降级：回退到当前 callId，避免引入 undefined
        return this.#currentCallId;
    }

    /**
     * Shadow Frame 缺失处理器。
     *
     * 每次 Rl() 查表命中 _SHADOW_MISS 哨兵时调用：
     *  1. 无论是否开启 debugShadow，都递增 miss 计数器（低开销，可随时查询）
     *  2. 仅在 debugShadow=true 时记录详细日志并向 console.warn 输出
     *
     * @param {number} iid        - 触发缺失的指令 ID
     * @param {number} defScopeId - 变量定义点的 Scope.id
     * @param {string} name       - 变量名
     */
    #onShadowMiss(iid, defScopeId, name) {
        this.#shadowMissCount++;
        if (this.#debugShadow) {
            const entry = { iid, defScopeId, name, callId: this.#currentCallId };
            this.#shadowMissLog.push(entry);
            console.warn(
                `[Jalangi] Shadow Frame MISS: name="${name}" iid=${iid} ` +
                `defScopeId=${defScopeId} callId=${this.#currentCallId} — ` +
                `Rl() 返回 undefined（Shadow Frame 中没有此变量的记录）。` +
                `可能是写入路径漏插桩或 callId 对不上。`
            );
        }
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
        this.smap[this.sid] = /** @type {import('../types.js').IidSourceMap} */ (this.iids);
    }

    #rollBackSid() {
        this.sid = this.#sidStack.pop();
    }

    #associateSidWithFunction(f, iid) {
        if (typeof f !== 'function') return;
        // 使用 WeakMap 存储，避免直接向函数对象写属性（消除 V8 deopt / freeze 副作用）
        this.#funcSidIidMap.set(f, { sid: this.sid, iid });
    }

    #updateSid(f) {
        this.#sidStack.push(this.sid);
        // 从 WeakMap 读取，兼容旧式 SPECIAL_PROP_SID 属性（外部代码可能直接写）
        const entry = (typeof f === 'function') ? this.#funcSidIidMap.get(f) : undefined;
        this.sid = entry ? entry.sid : getPropSafe(f, this.Constants.SPECIAL_PROP_SID);
    }

    // ── 私有调用辅助 ─────────────────────────────────────────────────────────

    /**
     * 以构造器模式调用函数（等价于 new Constructor(...args)）。
     *
     * 显式将 Constructor 作为 newTarget 传入 Reflect.construct，
     * 确保 new.target 在继承场景（class B extends A）下语义正确：
     *   - new B()  → B 构造函数内 new.target === B
     *   - super()  → A 构造函数内 new.target 仍为 B（JS 引擎自动传递）
     *
     * 若未来需要支持动态 newTarget（如 Proxy 或 Reflect.construct 的第三参数不同），
     * 可在 #invokeFun 中预传递 newTarget 并在此处消费。
     *
     * @param {Function} Constructor  构造函数
     * @param {Array}    args         参数列表
     * @returns {object}  构造的新实例
     */
    #callAsConstructor(Constructor, args) {
        // 第三个参数显式传入 Constructor，等价于原始 `new Constructor(...args)` 的语义
        return Reflect.construct(Constructor, args, Constructor);
    }

    #invokeEval(base, f, args, iid) {
        return f(this.instrumentEvalCode(args[0], iid, false));
    }

    #invokeFunctionDecl(base, f, args, iid) {
        const newArgs = Array.from(args).map(v => String(new String(v)));
        // 注意：不调用原始 f（Function 构造函数），而是先插桩再用 eval 执行，
        // 以便对 new Function(...) 动态创建的代码也进行分析。
        const rawCode = `(function(${newArgs.slice(0, newArgs.length - 1).join(', ')}) { ${newArgs[newArgs.length - 1]} })`;
        const code    = this.instrumentEvalCode(rawCode, iid, false);
        return EVAL_ORG(code);
    }

    #callFun(f, base, args, isConstructor, iid) {
        this.#pushSwitchKey();
        try {
            if (this.instrumentEvalEnabled && f === EVAL_ORG) {
                // instrumentEval=true 时对 eval 动态代码进行插桩（旧式行为）
                return this.#invokeEval(base, f, args, iid);
            } else if (this.instrumentEvalEnabled && f === Function) {
                // instrumentEval=true 时对 new Function 动态代码进行插桩（旧式行为）
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

    /**
     * 调用分析钩子，并在调用前后保存/恢复 `#lastComputedValue`（P3 修复）。
     *
     * **为什么需要这个包装**：
     * 若分析插件在钩子内部读取某个属性（如 `base.name`），这会触发 `G()` 钩子，
     * 从而覆写 `#lastComputedValue`。导致外层操作（如 `B()`）的 `L()` 读取到错误值。
     *
     * **保护机制**：每次分析钩子调用前保存 `#lastComputedValue`，调用后恢复。
     * 若分析钩子内部自己也有返回值需要更新 `#lastComputedValue`，
     * 框架调用方（`B()`/`G()`/`R()` 等）负责在最后统一写入正确值，覆盖恢复的旧值。
     *
     * **性能影响**：每次分析钩子调用多一次私有字段读写，开销可忽略不计。
     *
     * @template T
     * @param {() => T} hookFn  - 调用分析钩子的无参闭包
     * @returns {T}  钩子的返回值
     */
    #callHook(hookFn) {
        const saved = this.#lastComputedValue;
        try {
            return hookFn();
        } finally {
            this.#lastComputedValue = saved;
        }
    }

    /**
     * 获取函数关联的 IID（优先从 WeakMap，回退到旧式属性）。
     * @param {Function} f
     * @returns {number|undefined}
     */
    #getFuncIid(f) {
        if (typeof f !== 'function') return undefined;
        const entry = this.#funcSidIidMap.get(f);
        return entry ? entry.iid : getPropSafe(f, this.Constants.SPECIAL_PROP_IID);
    }

    /**
     * 获取函数关联的 SID（优先从 WeakMap，回退到旧式属性）。
     * @param {Function} f
     * @returns {number|undefined}
     */
    #getFuncSid(f) {
        if (typeof f !== 'function') return undefined;
        const entry = this.#funcSidIidMap.get(f);
        return entry ? entry.sid : getPropSafe(f, this.Constants.SPECIAL_PROP_SID);
    }

    #invokeFun(iid, base, f, args, isConstructor, isMethod) {
        let aret, skip = false, result;
        const analysis = this.analysis;

        if (analysis?.invokeFunPre) {
            // P3: 调用 pre 钩子时保护 #lastComputedValue
            const _fIid = this.#getFuncIid(f), _fSid = this.#getFuncSid(f);
            aret = this.#callHook(() => analysis.invokeFunPre(iid, f, base, args, isConstructor, isMethod, _fIid, _fSid));
            if (aret) {
                f    = aret.f;
                base = aret.base;
                args = aret.args;
                skip = aret.skip;
            }
        }

        if (!skip) {
            // 在调用函数前，预先查出被调用函数的 capturedOuterCallId（闭包修复）。
            // Fe() 的 `f` 参数是 probe fn（arguments.callee 探针），不是被调用函数本身，
            // 导致 funcClosureCallId.get(probe_fn) 无法取到正确值。
            // 通过此字段将正确的 callId "预传递" 给紧随其后的 Fe() 调用。
            this.#pendingCapturedOuterCallId = typeof f === 'function'
                ? (this.#funcClosureCallId.get(f) ?? null)
                : null;
            result = this.#callFun(f, base, args, isConstructor, iid);
            // 函数执行完毕后清空（防止非预期的跨调用泄漏）
            this.#pendingCapturedOuterCallId = null;
        }

        if (analysis?.invokeFun) {
            aret = analysis.invokeFun(iid, f, base, args, result, isConstructor, isMethod,
                this.#getFuncIid(f), this.#getFuncSid(f));
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
            // 独立函数调用（非方法调用）时，base 应为 undefined，
            // 等价于 f() 的原始语义（非严格模式下运行时会自动补全为 globalThis）。
            // 不能用 this（即 J$ runtime 对象），否则 setTimeout / clearTimeout 等
            // window 绑定的 native 方法会因 this 不是 window 而抛出 Illegal invocation。
            return (this.#lastComputedValue = this.#invokeFun(iid, undefined, f, callArgs, isConstructor, false));
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

        // TODO-13: 为函数字面量记录"创建时外层帧 callId"，用于闭包场景的 #resolveCallId。
        // 同时将外层帧的 (defScopeId:callId) 注册到 #closureFrameSet，
        // 告知 Fr() "该帧有闭包引用，退出时不要立即清除 Shadow Frame"。
        if (typeof val === 'function') {
            this.#funcClosureCallId.set(val, this.#currentCallId);
            // 当前正在某函数帧内（而非顶层脚本）才需要注册
            if (this.#currentFunDefScopeId !== undefined) {
                // 使用 "scopeId:callId" 复合 key，每次工厂函数调用独立注册，互不覆盖
                const key = `${this.#currentFunDefScopeId}:${this.#currentCallId}`;
                this.#closureFrameSet.add(key);
                
                if (this.#closureRegistry) {
                    this.#closureFrameRefCount.set(key, (this.#closureFrameRefCount.get(key) || 0) + 1);
                    this.#closureRegistry.register(val, key);
                }
            }
        } else if (val !== null && typeof val === 'object') {
            // 对象字面量（N_LOG_OBJECT_LIT）：为对象中所有函数属性（方法简写 ObjectMethod 等）
            // 设置 funcClosureCallId，以便方法内通过 J$.Rl 访问外层闭包变量时能正确追踪。
            // 背景：ObjectMethod（如 { [Symbol.iterator](){} }）不会被单独 J$.T 包装，
            // 所以方法内的 J$.Rl 无法通过 funcClosureCallId 找到正确的外层帧 callId。
            // 这里遍历所有属性（含 Symbol），为函数类型的属性设置 funcClosureCallId。
            const capturedCallId = this.#currentCallId;
            const capturedScopeId = this.#currentFunDefScopeId;
            // 遍历所有可枚举的字符串 key 属性
            for (const k of Object.getOwnPropertyNames(val)) {
                const v = val[k];
                if (typeof v === 'function' && !this.#funcClosureCallId.has(v)) {
                    this.#funcClosureCallId.set(v, capturedCallId);
                }
            }
            // 遍历 Symbol 属性（如 [Symbol.iterator]）
            for (const s of Object.getOwnPropertySymbols(val)) {
                const v = val[s];
                if (typeof v === 'function' && !this.#funcClosureCallId.has(v)) {
                    this.#funcClosureCallId.set(v, capturedCallId);
                }
            }
            // 将外层帧的 (defScopeId:callId) 注册到 #closureFrameSet
            if (capturedScopeId !== undefined) {
                const key = `${capturedScopeId}:${capturedCallId}`;
                this.#closureFrameSet.add(key);
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

        // TODO-11: 形参/局部变量初始化时，将值写入 Shadow Frame，确保 Rl() 能读到正确值。
        // isLocalSync=true 的变量（如闭包变量同步）已有其他机制处理，此处跳过避免重复。
        // name === 'arguments' 的情况不写入 Shadow Frame（不需要按名查找 arguments）。
        if (!isLocalSync && name !== 'arguments' && this.#currentFunDefScopeId !== undefined) {
            this.#shadowSet(this.#currentFunDefScopeId, this.#currentCallId, name, val);
        }

        return val;
    }

    /** 属性读取 */
    G(iid, base, offset, flags) {
        const [isComputed, isOpAssign, isMethodCall, isOptional] = decodeBitPattern(flags, 4);
        const analysis = this.analysis;
        let aret, skip = false, val;

        // 可选链短路：当 base 为 null 或 undefined 时，直接返回 undefined（等同于原始 ?. 语义）
        if (isOptional && (base == null)) {
            return (this.#lastComputedValue = undefined);
        }

        if (analysis?.getFieldPre) {
            // P3: 调用 pre 钩子时保护 #lastComputedValue 不被 hook 内的递归 J$ 调用污染
            aret = this.#callHook(() => analysis.getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall));
            if (aret) {
                base   = aret.base;
                offset = aret.offset;
                skip   = aret.skip;
            }
        }

        if (!skip) val = base[offset];

        if (analysis?.getField) {
            aret = this.#callHook(() => analysis.getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall));
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
            // P3: 调用 pre 钩子时保护 #lastComputedValue
            aret = this.#callHook(() => analysis.putFieldPre(iid, base, offset, val, isComputed, !!isOpAssign));
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
            aret = this.#callHook(() => analysis.putField(iid, base, offset, val, isComputed, !!isOpAssign));
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
        // 使用 #resolveCallId 支持闭包访问外层作用域的情况
        if (!isGlobal && defScopeId !== undefined) {
            this.#shadowSet(defScopeId, this.#resolveCallId(defScopeId), name, val);
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
     * 当 Shadow Frame 中没有缓存时，通过 #onShadowMiss 记录诊断信息并返回 undefined。
     *
     * @param {number} iid         - 指令 ID
     * @param {number} defScopeId  - 变量定义点的 Scope.id（插桩器静态注入）
     * @param {string} name        - 变量名
     * @returns {*} 变量当前值
     */
    Rl(iid, defScopeId, name) {
        const raw = this.#shadowLookup(defScopeId, this.#resolveCallId(defScopeId), name);

        // 检测 sentinel：与 undefined 相同的静默降级，但会留下可观测的诊断记录
        let val;
        if (raw === _SHADOW_MISS) {
            this.#onShadowMiss(iid, defScopeId, name);
            val = undefined;
        } else {
            val = raw;
        }

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
        // 使用 #resolveCallId 支持闭包写回外层作用域变量
        if (!isGlobal && defScopeId !== undefined) {
            const resolvedCallId = this.#resolveCallId(defScopeId);
            this.#shadowSet(defScopeId, resolvedCallId, name, val);

            // TODO-14: 记录别名（右值是对象/数组/函数时，记录变量 → OID 映射）
            const oid = this.#getOrCreateOid(val);
            if (oid !== null) {
                this.#aliasTable.set(`${defScopeId}:${resolvedCallId}:${name}`, oid);
            } else {
                // 右值变为非引用类型时，清除旧的别名记录
                this.#aliasTable.delete(`${defScopeId}:${resolvedCallId}:${name}`);
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

        // 闭包修复：从 #pendingCapturedOuterCallId 读取外层帧 callId（由 #invokeFun 预传递）。
        //
        // 背景：Fe() 的 `f` 参数是 probe fn（arguments.callee 探针）的返回值，不是被调用函数。
        // probe fn 在函数体执行时才被创建，没有被 T() 记录，所以 funcClosureCallId.get(probe_fn)
        // 取不到正确的外层 callId。
        //
        // 修复：#invokeFun() 在调用函数前已将正确的 capturedOuterCallId 存入
        // #pendingCapturedOuterCallId，在此一次性读取并清空（避免跨调用泄漏）。
        let capturedOuterCallId = this.#pendingCapturedOuterCallId;
        this.#pendingCapturedOuterCallId = null;

        // BUG-objectmethod-closure 后备修复：
        // 当函数通过 JS 引擎内部协议调用（如 for...of 的 iterator.next()、
        // Array.map 的回调等），不会经过 J$.M/J$.F，#pendingCapturedOuterCallId 为 null。
        // 此时尝试在 #callIdStack 中搜索包含 defScopeId 的帧（Shadow Frame 存在该作用域数据），
        // 将其 callId 作为 capturedOuterCallId，使闭包变量读取（J$.Rl）能找到正确的帧。
        //
        // 注意：此后备机制仅适用于"外层帧当前仍在调用栈中"的情况（动态调用的闭包），
        // 对于"外层帧已退出"的情况（factory pattern 等），capturedOuterCallId 仍依赖
        // #invokeFun 预传递（通过 funcClosureCallId 查找）。
        if (capturedOuterCallId === null && defScopeId !== undefined) {
            // 搜索调用栈，找到包含 defScopeId 的最近帧
            for (let i = this.#callIdStack.length - 1; i >= 0; i--) {
                const frame = this.#callIdStack[i];
                if (frame.defScopeId === defScopeId) {
                    capturedOuterCallId = frame.callId;
                    break;
                }
                // 也检查 shadowFrameMap 中是否有该 defScopeId:frame.callId 的记录
                if (this.#shadowFrameMap.has(defScopeId) && this.#shadowFrameMap.get(defScopeId)?.has(frame.callId)) {
                    capturedOuterCallId = frame.callId;
                    break;
                }
            }
        }

        // TODO-13: 分配新 callId，压栈保存旧值
        // 同时保存父帧的 defScopeId，供 Fr() 恢复
        // capturedOuterCallId：此函数在创建时外层帧的 callId（闭包绑定）
        this.#callIdStack.push({
            callId: this.#currentCallId,
            defScopeId: this.#currentFunDefScopeId,
            capturedOuterCallId,
        });
        this.#currentCallId = ++this.#callIdCounter;
        // 记录 callId → capturedOuterCallId 的链式映射，用于多层嵌套闭包的 #resolveCallId 递推。
        if (capturedOuterCallId !== null && capturedOuterCallId !== undefined) {
            this.#callIdToOuterCallId.set(this.#currentCallId, capturedOuterCallId);
        }
        // TODO-11: 记录当前函数的 defScopeId，供 N() 初始化形参到 Shadow Frame
        this.#currentFunDefScopeId = defScopeId;

        this.analysis?.functionEnter?.(iid, f, dis, args);
    }

    /** 函数退出 */
    Fr(iid) {
        let isBacktrack = false;
        let returnVal   = this.#returnStack.pop();
        const analysis  = this.analysis;

        if (analysis?.functionExit) {
            const aret = analysis.functionExit(iid, returnVal, this.#wrappedExceptionVal);
            // observeOnly 模式：强制忽略 isBacktrack（防止 while(true) 死循环）
            // 其他返回字段由 HookDispatcher._makeDispatcher 在上游已过滤，此处仅守卫 isBacktrack
            if (aret && !analysis.observeOnly) {
                returnVal                 = aret.returnVal;
                this.#wrappedExceptionVal = aret.wrappedExceptionVal;
                isBacktrack               = aret.isBacktrack;
            }
        }

        this.#rollBackSid();

        // TODO-13: 弹出 callId 栈，恢复调用方的 callId
        const frame = this.#callIdStack.pop();
        if (frame) {
            const leavingCallId    = this.#currentCallId;
            const leavingScopeId   = this.#currentFunDefScopeId;
            const { callId: parentCallId, defScopeId: parentDefScopeId } = frame;

            // TODO-13 闭包修复：退出时不立即清除 Shadow Frame。
            // 若该帧的 (scopeId:callId) 已被 #closureFrameSet 注册（说明有内层闭包在引用），
            // 则保留 Shadow Frame 数据，让内层闭包函数能继续读取。
            // 否则（无闭包引用）才立即清除，节省内存。
            //
            // 使用 Set 而非 Map，每次工厂函数调用的 callId 各自独立注册，
            // 避免多实例调用时互相覆盖导致旧帧被误清除。
            let isReferencedByClosure = false;
            if (leavingScopeId !== undefined) {
                isReferencedByClosure = this.#closureFrameSet.has(`${leavingScopeId}:${leavingCallId}`);
                if (!isReferencedByClosure) {
                    this.#shadowClear(leavingScopeId, leavingCallId);
                }
            }

            this.#currentCallId = parentCallId;
            // 恢复父帧的 defScopeId
            this.#currentFunDefScopeId = parentDefScopeId;

            // BUG-RT-03 修复：清除 #callIdToOuterCallId 映射，防止内存泄漏。
            // 当函数退出时，若没有闭包在引用此帧，可安全删除，允许 GC 回收。
            // 若有闭包引用（isReferencedByClosure=true），则保留链条，
            // 使得内层闭包的 #resolveCallId() 能继续沿链找到祖父层及以上的变量。
            // （FinalizationRegistry 回调会在闭包函数被 GC 后负责清理 closureFrameSet，
            //   届时再通过 FinalizationRegistry 删除）
            if (!isReferencedByClosure) {
                this.#callIdToOuterCallId.delete(leavingCallId);
            }
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
        // 保存最近一次进入的脚本 sid（Se() 完成后 sid 指向当前脚本，但 Sr() 之后会 rollback）
        // lastSid 不随 Sr() 回滚，可在脚本执行完后通过 J$.lastSid 获取最后执行的脚本 ID
        this.lastSid = this.sid;
        this.analysis?.scriptEnter?.(iid, val, origFileName);
        this.#lastComputedValue = undefined;
    }

    /** 脚本退出 */
    Sr(iid) {
        const analysis = this.analysis;
        let isBacktrack;

        if (analysis?.scriptExit) {
            const aret = analysis.scriptExit(iid, this.#wrappedExceptionVal);
            // observeOnly 模式：强制忽略 isBacktrack，防止脚本被重执行
            if (aret && !analysis.observeOnly) {
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
            // P3: 调用 pre 钩子时保护 #lastComputedValue
            aret = this.#callHook(() => analysis.binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed));
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
            // P3: 调用 pre 钩子时保护 #lastComputedValue
            aret = this.#callHook(() => analysis.unaryPre(iid, op, left));
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
                this.#getFuncIid(f),
                this.#getFuncSid(f)
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
     * await 恢复点钩子（J$.Aw）。
     *
     * 插桩器将 `await expr` 改写为 `J$.Aw(iid, await expr, ctxId)`：
     *   - JS 引擎在 `await expr` 处挂起协程（语义不变）
     *   - Promise 兑现后，resolved value 作为第二参数传入 Aw()
     *   - ctxId 是在 async 函数入口处捕获的 callId（存于局部变量 J$__ctx），
     *     用于在并发 async 调用场景下正确区分不同的 async 实例
     *   - Aw() 返回该 value，让外层表达式继续使用它
     *
     * 除透传 value 外，Aw() 还负责：
     *   1. 将 #currentContextId 更新为本次 async 调用的 ctxId，
     *      使得 await 恢复后的后续操作（R/W/G/P 等）都归属到正确的异步上下文。
     *   2. 回调分析器的 awaitResume(iid, contextId, val) 钩子。
     *
     * @param {number} iid    指令 ID（await 表达式所在位置）
     * @param {*}      val    await 的 resolved value（由 JS 引擎填入）
     * @param {number} [ctxId] 本次 async 函数调用的 callId（由插桩注入，可选）
     * @returns {*}           透传 val（保持语义不变）
     */
    Aw(iid, val, ctxId) {
        // 将 #currentContextId 更新为本次 async 函数的上下文 ID。
        // ctxId 由插桩器注入（async 函数入口处捕获的 callId），
        // 确保在并发 async 调用时能正确区分不同的 async 实例。
        // 若未提供 ctxId（兜底），则使用当前 callId（单次调用场景下仍正确）。
        this.#currentContextId = ctxId ?? this.#currentCallId;

        const analysis = this.analysis;
        if (analysis?.awaitResume) {
            analysis.awaitResume(iid, this.#currentContextId, val);
        }

        // 透传 resolved value，保持 await 表达式的语义
        return val;
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

    // ── Shadow Frame 诊断 API ─────────────────────────────────────────────────

    /**
     * 返回 Shadow Frame 的运行时统计信息。
     *
     * 可在被分析程序执行完毕后调用，用于判断轻量路径是否存在覆盖漏洞：
     *
     * ```js
     * const J$ = new JalangiSandbox({ debugShadow: true });
     * // ... 运行被分析代码 ...
     * const stats = J$.getShadowStats();
     * if (stats.missCount > 0) {
     *     console.error('发现 Shadow Frame 缺失！', stats.missLog);
     * }
     * ```
     *
     * @returns {{ missCount: number, missLog: Array<{iid:number, defScopeId:number, name:string, callId:number}>, frameCount: number, debugShadow: boolean }}
     */
    getShadowStats() {
        return {
            missCount:   this.#shadowMissCount,
            missLog:     this.#shadowMissLog.slice(),   // 返回副本，防止外部修改
            frameCount:  Array.from(this.#shadowFrameMap.values()).reduce((acc, map) => acc + map.size, 0),
            debugShadow: this.#debugShadow,
        };
    }

    /**
     * 重置 Shadow Frame 统计计数器和日志（用于多轮测试之间清空状态）。
     */
    resetShadowStats() {
        this.#shadowMissCount = 0;
        this.#shadowMissLog   = [];
    }
}
