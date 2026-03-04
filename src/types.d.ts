/**
 * @file Jalangi2 共享基础类型声明
 *
 * 本文件定义 Config、Hook 回调返回值、Log 条目、寄存器条目等全局共享类型。
 * 各子模块通过 import type 引用这里的接口，无需重复定义。
 *
 * 本文件不包含任何可运行代码，仅供 IDE 类型检查使用。
 */

// ── Config（插桩配置对象）────────────────────────────────────────────────────

/**
 * 单个 Config 字段的类型：
 *  - `null` / `undefined` → 全量插桩（默认行为）
 *  - `() => false`        → 完全禁用此类操作的插桩
 *  - `(ast: object) => boolean` → 细粒度控制（AST 节点级别）
 */
export type ConfigField = null | undefined | (() => boolean) | ((ast: object) => boolean);

/**
 * Jalangi2 插桩配置对象。
 *
 * 每个字段控制对应类型操作是否被插桩。
 * 字段为 `null`/`undefined` 表示全量插桩；`() => false` 表示禁用。
 *
 * @example
 * // 全量插桩（等同于 fullConfig()）
 * const config: JalangiConfig = {
 *   INSTR_READ: null,
 *   INSTR_WRITE: null,
 *   // ...所有字段均为 null
 *   ENABLE_SAMPLING: false,
 * };
 *
 * @example
 * // 只开启 read / write，其余禁用
 * const config: JalangiConfig = {
 *   INSTR_READ:  null,
 *   INSTR_WRITE: null,
 *   INSTR_GETFIELD:  () => false,
 *   INSTR_PUTFIELD:  () => false,
 *   INSTR_BINARY:    () => false,
 *   INSTR_UNARY:     () => false,
 *   INSTR_LITERAL:   () => false,
 *   INSTR_INIT:      () => false,
 *   INSTR_CONDITIONAL: () => false,
 *   INSTR_TRY_CATCH_ARGUMENTS: () => false,
 *   INSTR_END_EXPRESSION: () => false,
 *   INSTR_INVOKE:    () => false,
 *   INSTR_RETURN:    () => false,
 *   INSTR_THROW:     () => false,
 *   INSTR_FORIN:     () => false,
 *   ENABLE_SAMPLING: false,
 * };
 */
export interface JalangiConfig {
    /** 变量读取（J$.R / J$.Rl） */
    INSTR_READ?: ConfigField;
    /** 变量写入（J$.W） */
    INSTR_WRITE?: ConfigField;
    /** 属性读取（J$.G） */
    INSTR_GETFIELD?: ConfigField;
    /** 属性写入（J$.P） */
    INSTR_PUTFIELD?: ConfigField;
    /** 二元运算（J$.B） */
    INSTR_BINARY?: ConfigField;
    /** 一元运算（J$.U） */
    INSTR_UNARY?: ConfigField;
    /** 字面量（J$.T） */
    INSTR_LITERAL?: ConfigField;
    /** 变量声明初始化（J$.N） */
    INSTR_INIT?: ConfigField;
    /** 条件表达式 / switch（J$.C） */
    INSTR_CONDITIONAL?: ConfigField;
    /** 函数/脚本 try-catch 包裹 + Fe/Fr 进出钩子 */
    INSTR_TRY_CATCH_ARGUMENTS?: ConfigField;
    /** 表达式语句末尾标记（J$.X1） */
    INSTR_END_EXPRESSION?: ConfigField;
    /** 函数/方法调用（J$.F / J$.M） */
    INSTR_INVOKE?: ConfigField;
    /** return 语句（J$.Rt） */
    INSTR_RETURN?: ConfigField;
    /** throw 语句（J$.Th） */
    INSTR_THROW?: ConfigField;
    /** for-in 循环（J$.H） */
    INSTR_FORIN?: ConfigField;
    /** 是否启用采样模式（true = 函数体有两个版本，按 J$.S 决定执行哪个） */
    ENABLE_SAMPLING?: boolean;
    /** 允许额外的自定义字段 */
    [key: string]: unknown;
}

// ── Hook 回调返回值类型 ─────────────────────────────────────────────────────────

/** invokeFunPre 返回值 */
export interface InvokeFunPreResult {
    f: Function;
    base: unknown;
    args: unknown[];
    skip: boolean;
}

/** invokeFun 返回值 */
export interface InvokeFunResult {
    result: unknown;
}

/** literal 返回值 */
export interface LiteralResult {
    result: unknown;
}

/** forinObject 返回值 */
export interface ForinObjectResult {
    result: unknown;
}

/** declare 返回值 */
export interface DeclareResult {
    result: unknown;
}

/** getFieldPre 返回值 */
export interface GetFieldPreResult {
    base: unknown;
    offset: unknown;
    skip: boolean;
}

/** getField 返回值 */
export interface GetFieldResult {
    result: unknown;
}

/** putFieldPre 返回值 */
export interface PutFieldPreResult {
    base: unknown;
    offset: unknown;
    val: unknown;
    skip: boolean;
}

/** putField 返回值 */
export interface PutFieldResult {
    result: unknown;
}

/** read 返回值 */
export interface ReadResult {
    result: unknown;
}

/** write 返回值 */
export interface WriteResult {
    result: unknown;
}

/** _return / _throw / _with 返回值 */
export interface ValResult {
    result: unknown;
}

/** functionExit 返回值 */
export interface FunctionExitResult {
    returnVal: unknown;
    wrappedExceptionVal: WrappedException | undefined;
    isBacktrack: boolean;
}

/** scriptExit 返回值 */
export interface ScriptExitResult {
    wrappedExceptionVal: WrappedException | undefined;
    isBacktrack: boolean;
}

/** binaryPre 返回值 */
export interface BinaryPreResult {
    op: string;
    left: unknown;
    right: unknown;
    skip: boolean;
}

/** binary 返回值 */
export interface BinaryResult {
    result: unknown;
}

/** unaryPre 返回值 */
export interface UnaryPreResult {
    op: string;
    left: unknown;
    skip: boolean;
}

/** unary 返回值 */
export interface UnaryResult {
    result: unknown;
}

/** conditional 返回值 */
export interface ConditionalResult {
    result: unknown;
}

/** instrumentCodePre 返回值 */
export interface InstrumentCodePreResult {
    code: unknown;
    skip: boolean;
}

/** instrumentCode 返回值 */
export interface InstrumentCodeResult {
    result: string;
}

// ── 通用辅助类型 ──────────────────────────────────────────────────────────────

/**
 * 未捕获异常包装对象（由 JalangiRuntime 在 catch 块中创建）。
 */
export interface WrappedException {
    exception: unknown;
}

/**
 * 源码位置四元组：[startLine, startCol, endLine, endCol]
 * 列号从 1 开始。
 */
export type SourceLocation = [number, number, number, number];

/**
 * iid → 源码位置 映射表（单个脚本）。
 * 数字键为 iid，字符串键为元数据字段。
 */
export interface IidSourceMap {
    /** iid → [startLine, startCol, endLine, endCol] */
    [iid: number]: SourceLocation;
    /** 分支总数（condIid 计算得出） */
    nBranches?: number;
    /** 原始文件名 */
    originalCodeFileName?: string;
    /** 插桩后文件名 */
    instrumentedCodeFileName?: string;
    /** 脚本 URL（可选） */
    url?: string;
    /** eval 所在的父脚本 ID（嵌套 eval 时有值） */
    evalSid?: number;
    /** eval 调用点 IID（嵌套 eval 时有值） */
    evalIid?: number;
    /** 内联原始代码（inlineSource=true 时有值） */
    code?: string;
}

/**
 * 多脚本 smap 映射表：instrumentedCodeFileName → IidSourceMap。
 * 在 JalangiSandbox.smap 中以 sid 为键。
 */
export interface SMapByFileName {
    [fileName: string]: IidSourceMap;
}

// ── DataFlowAnalyzer Log 条目（Discriminated Union）────────────────────────────

/** W（write）条目 */
export interface WriteLogEntry {
    type: 'W';
    iid: number;
    scopeId: number;
    callId: number;
    contextId: number;
    name: string;
    value: unknown;
    oid: number | null;
}

/** R 或 Rl（read）条目 */
export interface ReadLogEntry {
    type: 'R' | 'Rl';
    iid: number;
    scopeId: number;
    callId: number;
    contextId: number;
    name: string;
    value?: unknown;
}

/** P（putField）条目 */
export interface PutFieldLogEntry {
    type: 'P';
    iid: number;
    baseOid: number | null;
    offset: string | number;
    value: unknown;
    callId?: number;
    scopeId?: number;
    contextId?: number;
}

/** G（getField）条目 */
export interface GetFieldLogEntry {
    type: 'G';
    iid: number;
    baseOid: number | null;
    offset: string | number;
    value: unknown;
}

/** F 或 M（function/method call）条目 */
export interface CallLogEntry {
    type: 'F' | 'M';
    iid: number;
    callId: number;
    contextId?: number;
    result: unknown;
    oid?: number | null;
}

/**
 * DataFlowAnalyzer 接受的 Log 条目联合类型。
 * 使用 `type` 字段做判别。
 */
export type LogEntry =
    | WriteLogEntry
    | ReadLogEntry
    | PutFieldLogEntry
    | GetFieldLogEntry
    | CallLogEntry;

// ── DataFlowAnalyzer 寄存器条目 ───────────────────────────────────────────────

/**
 * SSA 寄存器类型枚举值。
 * 与 DataFlowAnalyzer.js 中的 REG_TYPE 保持一致。
 */
export type RegType = 'W' | 'A' | 'R' | 'P' | 'U';

/**
 * SSA 寄存器条目（RegisterEntry）。
 * 由 DataFlowAnalyzer 内部创建，通过 getRegister() / backwardSlice() 等方法对外暴露。
 */
export interface RegisterEntry {
    /** 全局唯一寄存器 ID（单调递增） */
    regId: number;
    /** 寄存器类型 */
    type: RegType;
    /** 产生此赋值的 IID */
    iid: number;
    /** 变量所在词法作用域 ID */
    scopeId: number;
    /** 调用帧 ID */
    callId: number;
    /** 异步上下文 ID */
    contextId: number;
    /** 变量名（返回值寄存器为 '<return>'，未知为 ''） */
    name: string;
    /** 赋值时的具体值 */
    value: unknown;
    /** 若值为对象，对应 OID；否则 null */
    oid: number | null;
    /** 此赋值依赖的源寄存器 ID 集合（backward slice 边） */
    sources: Set<number>;
    /** PUTFIELD 类型专用：OID 版本号（每次 P() 修改属性时递增） */
    oidVersion?: number;
    /** PUTFIELD 类型专用：被修改的属性名 */
    offset?: string | number;
    /** PUTFIELD 类型专用：属性的新值 */
    fieldValue?: unknown;
}

/**
 * RegisterEntry 的可序列化版本（sources 字段转为数组）。
 * 由 DataFlowAnalyzer.exportRegisters() 返回。
 */
export interface SerializedRegisterEntry extends Omit<RegisterEntry, 'sources'> {
    sources: number[];
}

// ── 分析插件接口（IAnalysisPlugin）──────────────────────────────────────────

/**
 * Jalangi2 分析插件接口。
 *
 * 所有方法均可选。实际分析只需实现需要的钩子方法。
 * 如果不返回值（或返回 undefined），执行行为不受影响（被动观测模式）。
 *
 * @example
 * class MyAnalysis implements IAnalysisPlugin {
 *     read(iid, name, val, isGlobal, isScriptLocal) {
 *         console.log(`Read ${name} = ${val}`);
 *         // 不返回值 → 不影响执行
 *     }
 *     write(iid, name, val, lhs, isGlobal, isScriptLocal) {
 *         return { result: val }; // 可修改值
 *     }
 * }
 */
export interface IAnalysisPlugin {
    /** 函数/方法/构造器调用之前 */
    invokeFunPre?(
        iid: number,
        f: Function,
        base: unknown,
        args: unknown[],
        isConstructor: boolean,
        isMethod: boolean,
        functionIid: number,
        functionSid: number,
    ): InvokeFunPreResult | undefined | void;

    /** 函数/方法/构造器调用之后 */
    invokeFun?(
        iid: number,
        f: Function,
        base: unknown,
        args: unknown[],
        result: unknown,
        isConstructor: boolean,
        isMethod: boolean,
        functionIid: number,
        functionSid: number,
    ): InvokeFunResult | undefined | void;

    /** 字面量创建后 */
    literal?(iid: number, val: unknown, hasGetterSetter: boolean): LiteralResult | undefined | void;

    /** for-in 迭代对象时 */
    forinObject?(iid: number, val: unknown): ForinObjectResult | undefined | void;

    /** 变量声明初始化 */
    declare?(
        iid: number,
        name: string,
        val: unknown,
        isArgument: boolean,
        argumentIndex: number,
        isCatchParam: boolean,
    ): DeclareResult | undefined | void;

    /** 属性读取之前 */
    getFieldPre?(
        iid: number,
        base: unknown,
        offset: unknown,
        isComputed: boolean,
        isOpAssign: boolean,
        isMethodCall: boolean,
    ): GetFieldPreResult | undefined | void;

    /** 属性读取之后 */
    getField?(
        iid: number,
        base: unknown,
        offset: unknown,
        val: unknown,
        isComputed: boolean,
        isOpAssign: boolean,
        isMethodCall: boolean,
    ): GetFieldResult | undefined | void;

    /** 属性写入之前 */
    putFieldPre?(
        iid: number,
        base: unknown,
        offset: unknown,
        val: unknown,
        isComputed: boolean,
        isOpAssign: boolean,
    ): PutFieldPreResult | undefined | void;

    /** 属性写入之后 */
    putField?(
        iid: number,
        base: unknown,
        offset: unknown,
        val: unknown,
        isComputed: boolean,
        isOpAssign: boolean,
    ): PutFieldResult | undefined | void;

    /** 变量读取之后 */
    read?(
        iid: number,
        name: string,
        val: unknown,
        isGlobal: boolean,
        isScriptLocal: boolean,
    ): ReadResult | undefined | void;

    /** 变量写入之前 */
    write?(
        iid: number,
        name: string,
        val: unknown,
        lhs: unknown,
        isGlobal: boolean,
        isScriptLocal: boolean,
    ): WriteResult | undefined | void;

    /** return 语句执行前 */
    _return?(iid: number, val: unknown): ValResult | undefined | void;

    /** throw 语句执行前 */
    _throw?(iid: number, val: unknown): ValResult | undefined | void;

    /** with 语句执行时 */
    _with?(iid: number, val: unknown): ValResult | undefined | void;

    /** 函数体开始执行前 */
    functionEnter?(iid: number, f: Function, dis: unknown, args: unknown[]): void;

    /** 函数体执行完毕后 */
    functionExit?(
        iid: number,
        returnVal: unknown,
        wrappedExceptionVal: WrappedException | undefined,
    ): FunctionExitResult | undefined | void;

    /** 脚本开始执行前 */
    scriptEnter?(iid: number, instrumentedFileName: string, originalFileName: string): void;

    /** 脚本执行完毕后 */
    scriptExit?(
        iid: number,
        wrappedExceptionVal: WrappedException | undefined,
    ): ScriptExitResult | undefined | void;

    /** 二元运算之前 */
    binaryPre?(
        iid: number,
        op: string,
        left: unknown,
        right: unknown,
        isOpAssign: boolean,
        isSwitchCaseComparison: boolean,
        isComputed: boolean,
    ): BinaryPreResult | undefined | void;

    /** 二元运算之后 */
    binary?(
        iid: number,
        op: string,
        left: unknown,
        right: unknown,
        result: unknown,
        isOpAssign: boolean,
        isSwitchCaseComparison: boolean,
        isComputed: boolean,
    ): BinaryResult | undefined | void;

    /** 一元运算之前 */
    unaryPre?(
        iid: number,
        op: string,
        left: unknown,
    ): UnaryPreResult | undefined | void;

    /** 一元运算之后 */
    unary?(
        iid: number,
        op: string,
        left: unknown,
        result: unknown,
    ): UnaryResult | undefined | void;

    /** 条件判断之后 */
    conditional?(iid: number, result: unknown): ConditionalResult | undefined | void;

    /** eval/Function 字符串被插桩之前 */
    instrumentCodePre?(
        iid: number,
        code: unknown,
        isDirect: boolean,
    ): InstrumentCodePreResult | undefined | void;

    /** eval/Function 字符串被插桩之后 */
    instrumentCode?(
        iid: number,
        newCode: string,
        newAst: object,
        isDirect: boolean,
    ): InstrumentCodeResult | undefined | void;

    /** 表达式语句执行完毕时 */
    endExpression?(iid: number): void;

    /** 执行结束时 */
    endExecution?(): void;

    /**
     * 采样模式：是否执行插桩版函数体。
     * 仅 Config.ENABLE_SAMPLING = true 时生效。
     */
    runInstrumentedFunctionBody?(
        iid: number,
        f: Function,
        functionIid: number,
        functionSid: number,
    ): boolean;

    /**
     * 异步初始化完成后的回调（Node.js 专用）。
     * 收到此回调时再启动目标程序。
     */
    onReady?(cb: () => void): void;

    /** await 恢复点（J$.Aw，TODO-15） */
    awaitResume?(iid: number, contextId: number): void;

    /** 允许插件定义 usedHooks 静态声明，供 pluginAnalyzer 使用 */
    usedHooks?: string[];
}
