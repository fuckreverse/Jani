/**
 * @file Jalangi2 运行时类型声明
 *
 * 覆盖以下模块的公开 API：
 *   - JalangiRuntime.js     (JalangiRuntime class)
 *   - JalangiSandbox.js     (JalangiSandbox class)
 *   - HookDispatcher.js     (HookDispatcher class + HOOKS)
 *   - SMemory.js            (SMemory + SMemoryPlugin)
 *   - DataFlowAnalyzer.js   (DataFlowAnalyzer class + REG_TYPE)
 *   - analysisCallbackTemplate.js (AnalysisTemplate class)
 */

import type {
    IAnalysisPlugin,
    WrappedException,
    IidSourceMap,
    RegisterEntry,
    SerializedRegisterEntry,
    RegType,
    LogEntry,
    WriteLogEntry,
    PutFieldLogEntry,
} from '../types.js';

// ── JalangiRuntime.js ─────────────────────────────────────────────────────────

/**
 * JalangiRuntime 依赖子类提供的公开字段接口。
 * 通常通过 JalangiSandbox 自动满足，不需要手动实现。
 */
export interface JalangiRuntimeHost {
    /** 常量对象（SPECIAL_PROP_SID / SPECIAL_PROP_IID 等） */
    Constants: {
        SPECIAL_PROP_SID: string;
        SPECIAL_PROP_IID: string;
        [key: string]: unknown;
    };
    /** 当前分析插件（HookDispatcher 实例，可为 null） */
    analysis: IAnalysisPlugin | null;
    /** TraceLogger 实例（可选） */
    tracer?: { key?: (level: string, msg: string) => void } | null;
    /** 浏览器结果面板（可选） */
    Results?: { execute?: (fn: (div: HTMLElement) => void) => void } | null;
    /** iid → 位置映射表（{ [sid]: IidSourceMap }） */
    smap: Record<number, IidSourceMap>;
    /** 当前脚本 ID */
    sid: number;
    /** 当前脚本的 iid 映射（scriptEnter 时注册用） */
    iids: IidSourceMap | null;
    /** eval 插桩函数（可选） */
    instrumentEvalCode?: (code: string, iid: number, isDirect: boolean) => string;
}

/**
 * Jalangi2 运行时核心钩子类。
 *
 * 所有插桩代码直接调用的函数（R/W/G/P/B/U/F/M/T/N/Fe/Fr/Se/Sr/…）
 * 均定义为本类的方法。
 *
 * 通常不直接实例化，通过 JalangiSandbox 使用。
 * 子类需在 `this` 上提供 JalangiRuntimeHost 中列出的公开字段。
 */
export declare class JalangiRuntime {

    // ── 子类提供的公开字段（由 JalangiSandbox 实现）──────────────────────────

    /** 当前分析插件（HookDispatcher 实例，可为 null） */
    analysis: HookDispatcher | IAnalysisPlugin | null;

    /**
     * 所有常量对象（SPECIAL_PROP_SID、SPECIAL_PROP_IID 等）。
     * 由子类（JalangiSandbox）提供。
     */
    Constants: {
        SPECIAL_PROP_SID: string;
        SPECIAL_PROP_IID: string;
        [key: string]: unknown;
    };

    /** TraceLogger 实例（可选） */
    tracer: { key?: (level: string, msg: string) => void } | null | undefined;

    /** 浏览器结果面板（可选） */
    Results: { execute?: (fn: (div: HTMLElement) => void) => void } | null | undefined;

    /** iid → 源码位置映射表（{ [sid]: IidSourceMap }） */
    smap: Record<number, IidSourceMap>;

    /** 当前脚本 ID */
    sid: number;

    /** 当前脚本的 iid 映射（scriptEnter 时注册用） */
    iids: IidSourceMap | null;

    // ── Shadow Frame 诊断 API ──────────────────────────────────────────────

    /**
     * 返回 Shadow Frame 的运行时统计信息。
     */
    getShadowStats(): {
        missCount: number;
        missLog: Array<{ iid: number; defScopeId: number; name: string; callId: number }>;
        frameCount: number;
        debugShadow: boolean;
    };

    /** 重置 Shadow Frame 统计计数器和日志 */
    resetShadowStats(): void;

    // ── 原生 eval 引用 ────────────────────────────────────────────────────

    /** 原生 eval 引用（供插桩代码使用） */
    EVAL_ORG: typeof eval;

    // ── 公开运行时钩子 ───────────────────────────────────────────────────────

    /** 函数调用：F(iid, f, flags)(...args) */
    F(iid: number, f: Function, flags: number): (...callArgs: unknown[]) => unknown;

    /** 方法调用：M(iid, base, offset, flags)(...args) */
    M(iid: number, base: unknown, offset: unknown, flags: number): (...callArgs: unknown[]) => unknown;

    /** Identity（占位用，直接返回 val） */
    I(val: unknown): unknown;

    /** 字面量（对象/函数/数组/正则/原始值） */
    T(iid: number, val: unknown, type: number, hasGetterSetter: boolean, internalIid: number): unknown;

    /** for-in 对象包装 */
    H(iid: number, val: unknown): unknown;

    /** 变量声明初始化 */
    N(iid: number, name: string, val: unknown, flags: number): unknown;

    /** 属性读取 */
    G(iid: number, base: unknown, offset: unknown, flags: number): unknown;

    /** 属性写入 */
    P(iid: number, base: unknown, offset: unknown, val: unknown, flags: number): unknown;

    /** 变量读取（全量） */
    R(iid: number, name: string, val: unknown, flags: number, defScopeId?: number, bindingId?: string | null): unknown;

    /**
     * 变量读取（轻量）。
     * 不接收 value 参数，直接从 Shadow Frame 查找变量值。
     */
    Rl(iid: number, defScopeId: number, name: string, bindingId?: string | null): unknown;

    /** 变量写入 */
    W(iid: number, name: string, val: unknown, lhs: unknown, flags: number, defScopeId?: number, bindingId?: string | null): unknown;

    /** with 语句 */
    Wi(iid: number, val: unknown): unknown;

    /** 未捕获异常（包装为 { exception } 存入内部状态） */
    Ex(iid: number, e: unknown): void;

    /** throw 语句 */
    Th(iid: number, val: unknown): unknown;

    /** return 语句 */
    Rt(iid: number, val: unknown): unknown;

    /**
     * 函数真正返回时（由 finally 包装调用），读取 Rt 存储的返回值。
     * 同时清除未捕获异常状态，若有未捕获异常则重新抛出。
     */
    Ra(): unknown;

    /** 函数进入 */
    Fe(iid: number, f: Function, dis: unknown, args: unknown[], defScopeId?: number): void;

    /** 函数退出。返回 true 表示回溯（MultiSE 用）。 */
    Fr(iid: number): boolean;

    /** 脚本进入 */
    Se(iid: number, val: unknown, origFileName: string): void;

    /** 脚本退出。返回 true 表示回溯。 */
    Sr(iid: number): boolean | undefined;

    /** 复合赋值（+=、-= 等）：A(iid, base, offset, op, flags)(oprnd2) */
    A(iid: number, base: unknown, offset: unknown, op: string, flags: number): (oprnd2: unknown) => unknown;

    /** 二元运算 */
    B(iid: number, op: string, left: unknown, right: unknown, flags: number): unknown;

    /** 一元运算 */
    U(iid: number, op: string, left: unknown): unknown;

    /** 返回上一个 C() 存入的原始判断值 */
    _(): unknown;

    /** switch 判别式（记录 switchLeft，返回 left） */
    C1(iid: number, left: unknown): unknown;

    /** switch case 标签比较（C1 === C2），返回 right（可能被 conditional 修改） */
    C2(iid: number, right: unknown): unknown;

    /** 条件表达式（通知分析插件，返回 left，可能被修改） */
    C(iid: number, left: unknown): unknown;

    /** 采样模式：判断是否执行插桩版函数体 */
    S(iid: number, f: Function): boolean;

    /** 返回最后一个计算值 */
    L(): unknown;

    /** 顶层表达式语句结束标记 */
    X1(iid: number, val: unknown): unknown;

    /** 执行结束（Node.js 退出 / 浏览器 Alt-Shift-T） */
    endExecution(): void;

    /** 日志输出（路由到 tracer / Results / console.log） */
    log(str: unknown): void;

    // ── OID 查询（公开）──────────────────────────────────────────────────────

    /** 返回对象的当前 OID（不分配新 OID）。非引用类型返回 null。 */
    getOid(obj: unknown): number | null;

    /** 返回对象当前的版本号（每次 P() 修改属性时递增）。 */
    getObjectVersion(obj: unknown): number;

    // ── 异步 ContextID 公开接口（TODO-15）──────────────────────────────────

    /** await 恢复点钩子（J$.Aw） */
    As<T>(iid: number, value: T, contextId?: number): T;
    Aw<T>(iid: number, value: T, contextId?: number): T;
    newBindingFrame(): number;
    bindingIdentity(defScopeId: number, frameId: number): string;
    getBindingId(defScopeId: number): string | null;
    get parentCallId(): number;

    /** 为新的异步任务创建独立的 ContextID */
    newAsyncContext(): number;

    /** 激活指定的异步上下文 */
    activateContext(contextId: number): void;

    /** 返回当前激活的异步上下文 ID（0 = 顶层同步代码） */
    get currentContextId(): number;

    /** 返回当前 CallID（最新函数调用帧的唯一 ID） */
    get currentCallId(): number;
}

// ── JalangiSandbox.js ─────────────────────────────────────────────────────────

/**
 * JalangiSandbox 的构造选项。
 */
export interface JalangiSandboxOptions {
    /**
     * 浏览器中是否启用 IndexedDB 持久化。
     * 仅 withExecutionTrace=true 时生效。
     * @default false
     */
    useIdb?: boolean;
    /** IndexedDB 数据库名（可选） */
    dbName?: string;
    /** IndexedDB ObjectStore 名（可选） */
    storeName?: string;
    /**
     * 是否自动注册内置 ExecutionTraceAnalysis 插件。
     * @default false
     */
    withExecutionTrace?: boolean;
    /** 原始源码（ExecutionTrace 用，可选） */
    sourceCode?: string;
}

/**
 * Jalangi2 完整沙盒对象。
 *
 * 继承 JalangiRuntime（所有运行时钩子），同时提供：
 *   - iidToLocation / getGlobalIID 位置查询
 *   - analysis（HookDispatcher 实例）插件注册
 *
 * 典型用法：
 * ```js
 * import { JalangiSandbox } from './JalangiSandbox.js';
 * const J$ = globalThis.J$ = new JalangiSandbox();
 * J$.analysis.use(new MyAnalysis(J$));
 * ```
 */
export declare class JalangiSandbox extends JalangiRuntime {

    /** iid → 源码位置映射表（{ [sid]: IidSourceMap }） */
    smap: Record<number, IidSourceMap>;

    /** 当前脚本 ID */
    sid: number;

    /** 当前脚本的 iid 映射（由插桩器在 Se() 前写入 J$.iids） */
    iids: IidSourceMap | null;

    /** 当前分析插件（HookDispatcher 实例，支持 .use() 链式注册） */
    analysis: HookDispatcher;

    /** TraceLogger 实例（由 ExecutionTraceAnalysis 写入，供 log() 使用） */
    tracer: unknown | null;

    /** 浏览器结果面板（可选） */
    Results: unknown | null;

    /** 所有常量（与旧式 J$.Constants 保持一致） */
    Constants: {
        APPLY: typeof Function.prototype.apply;
        CALL: typeof Function.prototype.call;
        HAS_OWN_PROPERTY: typeof Object.prototype.hasOwnProperty;
        HAS_OWN_PROPERTY_CALL: (obj: object, prop: string) => boolean;
        JALANGI_VAR: string;
        SPECIAL_PROP: string;
        SPECIAL_PROP2: string;
        SPECIAL_PROP3: string;
        SPECIAL_PROP4: string;
        SPECIAL_PROP_SID: string;
        SPECIAL_PROP_IID: string;
        UNKNOWN: -1;
        HOP: (obj: object, prop: string) => boolean;
        hasGetterSetter: (obj: object, prop: string, isGetter: boolean) => boolean;
    };

    constructor(options?: JalangiSandboxOptions);

    /**
     * 将 (sid, iid) 或 "sid:iid" 格式的 giid 字符串转为可读位置字符串。
     *
     * @param sid  脚本 ID，或 "sid:iid" 格式的 giid 字符串
     * @param iid  指令 ID（当 sid 为数字时使用）
     * @returns    可读位置字符串，如 "(foo.js:10:5:10:20)"
     */
    iidToLocation(sid: number | string, iid?: number): string;

    /**
     * 返回全局唯一的 IID 字符串（"sid:iid" 格式）。
     * @param iid  当前指令 ID
     * @returns    "sid:iid" 格式字符串
     */
    getGlobalIID(iid: number): string;
}

// ── HookDispatcher.js ──────────────────────────────────────────────────────────

/**
 * 所有可能的钩子名称（与 analysisCallbackTemplate.js 中的方法保持一致）。
 */
export declare const HOOKS: ReadonlyArray<string>;

/**
 * HookDispatcher 的构造选项。
 */
export interface HookDispatcherOptions {
    /**
     * 插件 hook 抛出异常时的处理函数，接收 (hookName, error)。
     * 默认：打印错误并在 Node.js 下调用 process.exit(1)。
     */
    onError?: (hookName: string, error: Error) => void;
}

/**
 * Jalangi2 多插件链式调度器。
 *
 * 将每个运行时钩子依次分发给所有已注册的插件。
 * 若某个插件的 hook 返回值中含 Array 类型的 `args` 字段，
 * 则该数组会替换后续插件看到的参数列表。
 *
 * @example
* const host = new HookDispatcher();
* host.use(new SMemoryPlugin(smemory)).use(new LogAllAnalysis());
* J$.analysis = host;
 */
export declare class HookDispatcher implements IAnalysisPlugin {

    constructor(options?: HookDispatcherOptions);

    /**
     * 注册一个分析插件。
     * 只有插件中实际存在的 hook 方法才会被注册，其余忽略。
     * 返回 this，支持链式调用：`.use(A).use(B)`。
     *
     * @param plugin  分析插件实例
     * @returns this
     */
    use(plugin: IAnalysisPlugin): this;

    observeOnly: boolean;

    // IAnalysisPlugin 中所有方法在此处均已实现（dispatch 到插件链）
    invokeFunPre?: IAnalysisPlugin['invokeFunPre'];
    invokeFun?: IAnalysisPlugin['invokeFun'];
    literal?: IAnalysisPlugin['literal'];
    forinObject?: IAnalysisPlugin['forinObject'];
    declare?: IAnalysisPlugin['declare'];
    getFieldPre?: IAnalysisPlugin['getFieldPre'];
    getField?: IAnalysisPlugin['getField'];
    putFieldPre?: IAnalysisPlugin['putFieldPre'];
    putField?: IAnalysisPlugin['putField'];
    read?: IAnalysisPlugin['read'];
    write?: IAnalysisPlugin['write'];
    _return?: IAnalysisPlugin['_return'];
    _throw?: IAnalysisPlugin['_throw'];
    _with?: IAnalysisPlugin['_with'];
    functionEnter?: IAnalysisPlugin['functionEnter'];
    functionExit?: IAnalysisPlugin['functionExit'];
    scriptEnter?: IAnalysisPlugin['scriptEnter'];
    scriptExit?: IAnalysisPlugin['scriptExit'];
    binaryPre?: IAnalysisPlugin['binaryPre'];
    binary?: IAnalysisPlugin['binary'];
    unaryPre?: IAnalysisPlugin['unaryPre'];
    unary?: IAnalysisPlugin['unary'];
    conditional?: IAnalysisPlugin['conditional'];
    instrumentCodePre?: IAnalysisPlugin['instrumentCodePre'];
    instrumentCode?: IAnalysisPlugin['instrumentCode'];
    endExpression?: IAnalysisPlugin['endExpression'];
    endExecution?: IAnalysisPlugin['endExecution'];
    runInstrumentedFunctionBody?: IAnalysisPlugin['runInstrumentedFunctionBody'];
    onReady?: IAnalysisPlugin['onReady'];
}

// ── SMemory.js ────────────────────────────────────────────────────────────────

/**
 * getShadowObject 的返回值。
 */
export interface ShadowOwnerAndAccess {
    owner: object | undefined;
    isProperty: boolean;
}

/**
 * SMemory — 影子内存服务。
 *
 * 为每个 JS 对象/函数/活动帧维护一个"影子对象"（shadow object）和唯一 ID。
 * 通过 SMemoryPlugin 与运行时事件桥接。
 *
 * 可通过 J$.smemory 访问（挂载后）。
 */
export declare class SMemory {
    constructor(sandboxOrConstants: object);

    /** 获取属性所在对象的影子对象 */
    getShadowObject(obj: object, prop: string, isGetField: boolean): ShadowOwnerAndAccess;

    /** 获取变量所在活动帧的影子对象 */
    getShadowFrame(name: string): object;

    /** 从影子对象或影子帧中取出唯一 ID */
    getIDFromShadowObjectOrFrame(obj: object | undefined | null): number | undefined;

    /** 从影子对象中取出对应的真实对象 */
    getActualObjectOrFunctionFromShadowObjectOrFrame(obj: object): unknown;

    /** 获取持有变量 name 的活动帧（原始帧对象，非影子对象） */
    getFrame(name: string): object;

    /** 获取 val 对应的影子对象；val 为 null/undefined/原始值时返回 undefined */
    getShadowObjectOfObject(val: unknown): object | undefined;

    /** 将函数 f 与当前活动帧关联（用于跨帧追踪闭包） */
    defineFunction(f: unknown): void;

    /** 在当前帧中注册变量 name */
    initialize(name: string): void;

    /** 函数调用时压入新帧 */
    functionEnter(f: Function): void;

    /** 函数返回时弹出帧 */
    functionReturn(): void;

    /** 脚本进入时管理帧栈 */
    scriptEnter(instrumentedFileName: string, originalFileName: string): void;

    /** 脚本退出时恢复帧栈 */
    scriptReturn(): void;
}

/**
 * SMemoryPlugin — 将 SMemory 服务桥接到 Jalangi 分析钩子的适配器。
 *
 * 实现 literal / declare / functionEnter / functionExit / scriptEnter / scriptExit 钩子，
 * 将事件转发给 SMemory 内部状态方法。
 *
 * @example
 * const smemory = new SMemory(J$);
 * J$.smemory = smemory;
 * J$.analysis = new HookDispatcher().use(new SMemoryPlugin(smemory));
 */
export declare class SMemoryPlugin implements IAnalysisPlugin {
    constructor(smemory: SMemory);

    literal(iid: number, val: unknown): void;
    declare(iid: number, name: string): void;
    functionEnter(iid: number, f: Function): void;
    functionExit(iid: number, returnVal: unknown, wrappedExceptionVal: WrappedException | undefined): {
        returnVal: unknown;
        wrappedExceptionVal: WrappedException | undefined;
        isBacktrack: false;
    };
    scriptEnter(iid: number, instrumentedFileName: string, originalFileName: string): void;
    scriptExit(iid: number, wrappedExceptionVal: WrappedException | undefined): {
        wrappedExceptionVal: WrappedException | undefined;
        isBacktrack: false;
    };
}

// ── DataFlowAnalyzer.js ───────────────────────────────────────────────────────

/**
 * 寄存器类型枚举对象（Object.freeze）。
 */
export declare const REG_TYPE: Readonly<{
    /** 变量赋值 */
    WRITE: 'W';
    /** 函数参数传入 */
    ARG: 'A';
    /** 函数调用返回值 */
    RETURN: 'R';
    /** 属性写入（对象版本 bump） */
    PUTFIELD: 'P';
    /** 初始/未知值（无来源记录） */
    UNKNOWN: 'U';
}>;

/**
 * DataFlowAnalyzer — 运行时 SSA 数据流分析器。
 *
 * 消费 Jalangi2 运行时产生的 log 条目，执行 SSA 化、别名追踪和 Backward Slicing。
 *
 * @example
 * const dfa = new DataFlowAnalyzer();
 * dfa.processWrite({ type: 'W', iid: 8, scopeId: 0, callId: 1, name: 'x', value: 1, oid: null });
 * dfa.processRead({ type: 'R', scopeId: 0, callId: 1, name: 'x' });
 * const slice = dfa.backwardSlice(1);
 */
export declare class DataFlowAnalyzer {

    /**
     * 处理一条 W（write）log 条目。
     * 为此次赋值创建新的 SSA 寄存器，消费 pendingReadSources。
     * @returns 新分配的寄存器 ID
     */
    processWrite(entry: Omit<WriteLogEntry, 'type'> & { type?: 'W' }): number;

    /**
     * 处理一条 R 或 Rl（read）log 条目。
     * 将读到的源寄存器 ID 累积到 pendingReadSources，供下一次 processWrite 消费。
     * @returns 当前 active 寄存器 ID，若变量从未被写入则返回 undefined
     */
    processRead(entry: { scopeId?: number; callId?: number; name?: string }): number | undefined;

    /**
     * 处理一条 P（putField）log 条目。
     * 递增 OID 版本号，并为所有持有该 OID 的变量创建新的版本寄存器。
     */
    processPutField(entry: Omit<PutFieldLogEntry, 'type'> & { type?: 'P'; callId?: number; scopeId?: number; contextId?: number }): void;

    /**
     * 处理一条函数调用返回值（F/M）条目。
     * @returns 新建的返回值寄存器 ID
     */
    processCallReturn(entry: { iid?: number; callId?: number; contextId?: number; result?: unknown; oid?: number | null }): number;

    /**
     * 批量处理 log 条目数组。
     * log 条目按 `type` 字段分发到对应的处理方法。
     *
     * @param entries  log 条目数组（按时间顺序）
     */
    processLog(entries: LogEntry[]): void;

    /**
     * Backward Slicing：从目标寄存器出发，BFS 回溯所有影响其值的赋值寄存器链。
     * 返回按 iid 升序排列的寄存器列表。
     *
     * @param targetRegId  目标寄存器 ID（终点）
     * @returns 影响目标值的所有赋值，按时间升序
     */
    backwardSlice(targetRegId: number): RegisterEntry[];

    /**
     * 返回指定变量的最新 SSA 寄存器 ID。
     * @returns 当前 active 寄存器 ID，若未写入过则 undefined
     */
    getLastWrite(scopeId: number, callId: number, name: string): number | undefined;

    /**
     * 返回指定寄存器 ID 对应的寄存器详情。
     */
    getRegister(regId: number): RegisterEntry | undefined;

    /** 所有已记录寄存器的数量 */
    get registerCount(): number;

    /**
     * 返回 OID 的当前版本号。
     * @returns 版本号（0 = 从未被 putField 修改过）
     */
    getOidVersion(oid: number): number;

    /**
     * 查询变量是否通过别名持有某个 OID。
     * @returns 该变量当前持有的 OID，若无则 undefined
     */
    getAlias(scopeId: number, callId: number, name: string): number | undefined;

    /**
     * 找到所有当前持有指定 OID 的变量（别名集合）。
     */
    getAliasesForOid(targetOid: number): Array<{ scopeId: number; callId: number; name: string }>;

    /** 重置分析器状态（开始处理新一轮 log 序列） */
    reset(): void;

    /**
     * 将所有寄存器导出为可序列化的 JSON 对象（sources 字段从 Set 转为数组）。
     */
    exportRegisters(): SerializedRegisterEntry[];
}

// ── analysisCallbackTemplate.js ───────────────────────────────────────────────

/**
 * Jalangi2 分析插件基础模板。
 *
 * 展示了所有可用的钩子方法及其参数说明。
 * 实际分析只需继承本类，并只保留（覆盖）需要的方法。
 *
 * 默认实现返回不修改行为的值（透传模式）。
 *
 * @example
 * import { AnalysisTemplate } from './analysisCallbackTemplate.js';
 * class MyAnalysis extends AnalysisTemplate {
 *     override read(iid, name, val, isGlobal, isScriptLocal) {
 *         console.log(`Read ${name} = ${val}`);
 *         // 不修改值 → 直接 return（不返回 { result }）
 *     }
 * }
 */
export declare class AnalysisTemplate implements IAnalysisPlugin {
    invokeFunPre(iid: number, f: Function, base: unknown, args: unknown[], isConstructor: boolean, isMethod: boolean, functionIid: number, functionSid: number): { f: Function; base: unknown; args: unknown[]; skip: false };
    invokeFun(iid: number, f: Function, base: unknown, args: unknown[], result: unknown, isConstructor: boolean, isMethod: boolean, functionIid: number, functionSid: number): { result: unknown };
    literal(iid: number, val: unknown, hasGetterSetter: boolean): { result: unknown };
    forinObject(iid: number, val: unknown): { result: unknown };
    declare(iid: number, name: string, val: unknown, isArgument: boolean, argumentIndex: number, isCatchParam: boolean): { result: unknown };
    getFieldPre(iid: number, base: unknown, offset: unknown, isComputed: boolean, isOpAssign: boolean, isMethodCall: boolean): { base: unknown; offset: unknown; skip: false };
    getField(iid: number, base: unknown, offset: unknown, val: unknown, isComputed: boolean, isOpAssign: boolean, isMethodCall: boolean): { result: unknown };
    putFieldPre(iid: number, base: unknown, offset: unknown, val: unknown, isComputed: boolean, isOpAssign: boolean): { base: unknown; offset: unknown; val: unknown; skip: false };
    putField(iid: number, base: unknown, offset: unknown, val: unknown, isComputed: boolean, isOpAssign: boolean): { result: unknown };
    read(iid: number, name: string, val: unknown, isGlobal: boolean, isScriptLocal: boolean): { result: unknown };
    write(iid: number, name: string, val: unknown, lhs: unknown, isGlobal: boolean, isScriptLocal: boolean): { result: unknown };
    _return(iid: number, val: unknown): { result: unknown };
    _throw(iid: number, val: unknown): { result: unknown };
    _with(iid: number, val: unknown): { result: unknown };
    functionEnter(iid: number, f: Function, dis: unknown, args: unknown[]): void;
    functionExit(iid: number, returnVal: unknown, wrappedExceptionVal: WrappedException | undefined): { returnVal: unknown; wrappedExceptionVal: WrappedException | undefined; isBacktrack: false };
    scriptEnter(iid: number, instrumentedFileName: string, originalFileName: string): void;
    scriptExit(iid: number, wrappedExceptionVal: WrappedException | undefined): { wrappedExceptionVal: WrappedException | undefined; isBacktrack: false };
    binaryPre(iid: number, op: string, left: unknown, right: unknown, isOpAssign: boolean, isSwitchCaseComparison: boolean, isComputed: boolean): { op: string; left: unknown; right: unknown; skip: false };
    binary(iid: number, op: string, left: unknown, right: unknown, result: unknown, isOpAssign: boolean, isSwitchCaseComparison: boolean, isComputed: boolean): { result: unknown };
    unaryPre(iid: number, op: string, left: unknown): { op: string; left: unknown; skip: false };
    unary(iid: number, op: string, left: unknown, result: unknown): { result: unknown };
    conditional(iid: number, result: unknown): { result: unknown };
    instrumentCodePre(iid: number, code: unknown, isDirect: boolean): { code: unknown; skip: false };
    instrumentCode(iid: number, newCode: string, newAst: object, isDirect: boolean): { result: string };
    endExpression(iid: number): void;
    endExecution(): void;
    runInstrumentedFunctionBody(iid: number, f: Function, functionIid: number, functionSid: number): false;
    onReady(cb: () => void): void;
}

// ── Re-exports ─────────────────────────────────────────────────────────────────

export type {
    IAnalysisPlugin,
    WrappedException,
    IidSourceMap,
    RegisterEntry,
    SerializedRegisterEntry,
    RegType,
    LogEntry,
    WriteLogEntry,
    ReadLogEntry,
    PutFieldLogEntry,
    GetFieldLogEntry,
    CallLogEntry,
} from '../types.js';


