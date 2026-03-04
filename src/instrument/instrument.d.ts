/**
 * @file Jalangi2 插桩器类型声明
 *
 * 覆盖以下模块的公开 API：
 *   - esnstrument.js   (init / instrumentCode / instrumentEvalCode)
 *   - pluginAnalyzer.js (analyzePluginHooks / buildConfigFromHooks / buildConfigFromPlugins / fullConfig)
 *   - iid.js           (initialize / getIid / getSourceInfo / …)
 *   - dataflow.js      (analyzeDefUse / Decision)
 *   - scope.js         (Scope / addScopes / collectParamNames / resetScopeCounter)
 *   - astUtil.js       (CONTEXT / transformAst / setJalangiVar / ignoreSubAst)
 */

import type { JalangiConfig, IidSourceMap, IAnalysisPlugin } from '../types.js';

// ── esnstrument.js ────────────────────────────────────────────────────────────

export { analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig } from './pluginAnalyzer.js';

/**
 * 初始化插桩器。必须在第一次调用 instrumentCode 之前调用。
 *
 * @param config     - Jalangi Config 对象；传 null 时需同时传入 plugins，自动推导 Config。
 * @param analysis   - 当前 analysis 对象（可选，用于 pre/post hook）。
 * @param sid        - 当前脚本 ID（用于 eval 的 source map）。
 * @param jalangiVar - 沙盒变量名（默认 'J$'）；需满足 JS 标识符规则。
 * @param plugins    - 插件路径字符串或实例列表，当 config 为 null 时自动推导 Config。
 */
export declare function init(
    config: JalangiConfig | null,
    analysis?: IAnalysisPlugin | null,
    sid?: unknown,
    jalangiVar?: string,
    plugins?: Array<string | object>,
): void;

/**
 * instrumentCode 的选项对象。
 */
export interface InstrumentCodeOptions {
    /** 要插桩的代码字符串 */
    code: string;
    /** 原始文件名（用于 source map）。默认 'unknown' */
    origCodeFileName?: string;
    /** 插桩后文件名。默认 'unknown' */
    instCodeFileName?: string;
    /** 是否内联完整 iid→位置 source map（写入插桩代码头部）。默认 false */
    inlineSourceMap?: boolean;
    /** 是否将原始代码内联到 source map。默认 false */
    inlineSource?: boolean;
    /** 解析模式：'script'（默认）或 'module' */
    sourceType?: 'script' | 'module';
    /** 是否是 eval 动态代码。默认 false */
    isEval?: boolean;
    /** eval 调用点的 IID（仅 isEval=true 时使用） */
    thisIid?: number;
    /** 脚本 URL（可选，写入 source map） */
    url?: string;
    /** eval 是否是直接调用（仅 isEval=true 时使用） */
    isDirect?: boolean;
}

/**
 * instrumentCode 的返回值。
 */
export interface InstrumentCodeResult {
    /** 插桩后的完整代码字符串（含 smap 头 + IIFE / module 包裹） */
    code: string;
    /** 插桩后的 AST Program 节点（未 skip 时有值，否则 undefined） */
    instAST: object | undefined;
    /**
     * Jalangi 自有格式的 source map：iid → [startLine, startCol, endLine, endCol]，
     * 以及 nBranches / originalCodeFileName / instrumentedCodeFileName 等元数据。
     */
    sourceMapObject: IidSourceMap;
    /** sourceMapObject 的 JSON 字符串形式 */
    sourceMapString: string;
    /**
     * 标准 VLCQ source map（v3 格式），可直接写为 `.js.map` 文件，
     * 供浏览器 DevTools / VS Code 调试器使用。
     * 仅在代码被实际插桩（非 skip / DO NOT INSTRUMENT）时有值，否则为 null。
     */
    vlcqSourceMap: VlcqSourceMap | null;
}

/**
 * 标准 VLCQ source map（v3 格式）对象。
 * 与 @babel/generator 生成的 map 格式兼容。
 */
export interface VlcqSourceMap {
    version: 3;
    sources: string[];
    mappings: string;
    sourcesContent?: (string | null)[];
    file?: string;
    names?: string[];
    [key: string]: unknown;
}

/**
 * 对代码字符串进行插桩。
 *
 * 调用前必须先调用 init(config)。
 * 若代码包含 `// JALANGI DO NOT INSTRUMENT`，直接返回（不插桩）。
 *
 * @param options  插桩选项
 * @returns        插桩结果（含代码字符串、source map 等）
 *
 * @throws {Error}  若 init() 未被调用（_config === null）
 * @throws {TypeError} 若 options.code 不是字符串
 * @throws {Error}  若插桩过程中 Babel 解析或生成失败
 */
export declare function instrumentCode(options: InstrumentCodeOptions): InstrumentCodeResult;

/**
 * eval 插桩的快捷包装（始终内联 source map 和原始代码）。
 *
 * @param code      eval 中的代码字符串
 * @param iid       eval 调用点的 IID
 * @param isDirect  是否是直接调用（`eval(...)` 而非 `(0, eval)(...)`）
 * @returns 插桩后的代码字符串
 */
export declare function instrumentEvalCode(
    code: string,
    iid: number,
    isDirect: boolean,
): string;

// ── pluginAnalyzer.js ─────────────────────────────────────────────────────────

/**
 * AnalysisTemplate 中所有已知的 Hook 方法名集合。
 */
export declare const ALL_HOOKS: ReadonlySet<string>;

/**
 * 所有可通过 Config 控制的字段名集合。
 */
export declare const ALL_CONFIG_FIELDS: ReadonlySet<string>;

/**
 * 从插件文件路径列表（或已加载的插件对象列表）中提取使用的 Hook 名称集合。
 *
 * 支持两种输入：
 *   1. 字符串路径 → 读取文件并做静态 AST 扫描（仅 Node.js 环境）
 *   2. 对象实例   → 通过运行时反射检查方法（浏览器 / Node.js 均可）
 *
 * @param plugins  插件路径字符串或已实例化的插件对象数组
 * @returns 使用了哪些 Hook 方法名
 */
export declare function analyzePluginHooks(
    plugins: Array<string | object>,
): Set<string>;

/**
 * 根据 Hook 使用集合构建按需 Jalangi Config 对象。
 *
 * 已使用的 Hook → 对应 Config 字段设为 null（全量插桩）。
 * 未使用的 Hook → 对应 Config 字段设为 () => false（完全禁用）。
 *
 * @param usedHooks  从 analyzePluginHooks 返回的 Hook 名称集合
 * @returns 按需 Config 对象
 */
export declare function buildConfigFromHooks(usedHooks: Set<string>): JalangiConfig;

/**
 * 分析插件 → 构建 Config 的一体化快捷函数。
 * 等价于 buildConfigFromHooks(analyzePluginHooks(plugins))。
 *
 * @param plugins  插件路径或实例列表
 * @returns 按需 Config 对象
 */
export declare function buildConfigFromPlugins(
    plugins: Array<string | object>,
): JalangiConfig;

/**
 * 返回全量插桩的 Config（所有字段均为 null，与旧版默认行为一致）。
 */
export declare function fullConfig(): JalangiConfig;

// ── iid.js ────────────────────────────────────────────────────────────────────

/**
 * IID 管理模块的公开 API。
 * 通常仅由 esnstrument.js 内部使用；外部可通过 instrumentCode 的返回值间接访问。
 */
export declare namespace IID {
    /**
     * 初始化 IID 计数器及文件名。
     * 每次调用 instrumentCode 前自动调用，一般不需要手动调用。
     */
    function initialize(forEval: boolean, instFile: string | undefined, origFile: string | undefined): void;

    /**
     * 返回当前 iidSourceInfo 的快照。
     * 包含 iid → 位置映射以及 nBranches / originalCodeFileName / instrumentedCodeFileName 等元数据。
     */
    function getSourceInfo(): IidSourceMap;

    function getInstCodeFileName(): string;
    function getOrigCodeFileName(): string;
    function getCondIidCount(): number;
    function getIidIncStep(): number;

    /** 分配下一个 memIid，返回 Babel NumericLiteral AST 节点 */
    function getIid(): object;
    /** 返回上一个 memIid（不递增），返回 Babel NumericLiteral AST 节点 */
    function getPrevIidNoInc(): object;
    /** 分配下一个 condIid */
    function getCondIid(): object;
    /** 分配下一个 opIid */
    function getOpIid(): object;

    /** 将当前 memIid 对应的源码位置记录为 ast 的位置 */
    function printIidToLoc(ast: object): void;
    /** 将 memIid+2 的位置记录为 ast 的位置（方法调用内隐式 getField 预留） */
    function printSpecialIidToLoc(ast: object): void;
    function printModIidToLoc(ast: object): void;
    function printOpIidToLoc(ast: object): void;
    function printCondIidToLoc(ast: object): void;
}

// ── dataflow.js ───────────────────────────────────────────────────────────────

/**
 * 插桩决策枚举值。
 */
export type DecisionValue = 'full' | 'lightweight' | 'dead';

/**
 * 插桩决策枚举对象（Object.freeze）。
 */
export declare const Decision: Readonly<{
    /** 全量插桩（J$.R，包含实际值） */
    FULL: 'full';
    /** 轻量插桩（J$.Rl，不传值，从 Shadow Frame 查） */
    LIGHTWEIGHT: 'lightweight';
    /** 可完全省略（当前保守实现不使用） */
    DEAD: 'dead';
}>;

/**
 * 对 addScopes 之后的 AST 做静态 def-use 分析，返回插桩决策表。
 *
 * @param ast  Babel AST Program 节点（已经过 addScopes 处理，含 .scope 字段）
 * @returns    插桩决策表：`${scopeId}:${name}:${line}:${col}` → DecisionValue
 */
export declare function analyzeDefUse(ast: object): Map<string, DecisionValue>;

// ── scope.js ──────────────────────────────────────────────────────────────────

/** 变量声明类型（在 Scope.vars 中存储的字符串值）。 */
export type VarType = 'var' | 'arg' | 'defun' | 'lambda' | 'catch';

/** 变量声明 kind（ES6+ 声明关键字）。 */
export type VarKind = 'const' | 'let' | 'var' | 'param' | 'assign' | 'update' | null;

/**
 * 词法作用域节点。
 * 由 addScopes 创建并附加到对应的 AST 节点（node.scope）。
 */
export declare class Scope {
    /** 唯一词法作用域 ID（每次 instrumentCode 前通过 resetScopeCounter 重置） */
    readonly id: number;
    /** 作用域内声明的变量：name → VarType */
    vars: Record<string, VarType>;
    /** 函数声明的位置信息：name → AST loc（仅 defun）*/
    funLocs: Record<string, object>;
    /** 函数声明的 AST 节点：name → AST node（仅 defun）*/
    funNodes: Record<string, object>;
    /** 作用域链中是否含 eval */
    hasEval: boolean;
    /** 作用域链中是否含 arguments */
    hasArguments: boolean;
    /** 父作用域（顶层 Program 为 null） */
    parent: Scope | null;
    /** 是否是 catch 子句产生的特殊作用域 */
    isCatch: boolean;
    /** 是否含 with 语句 */
    hasWith_: boolean;
    /** 变量声明 kind（按需创建）：name → VarKind */
    varKinds?: Record<string, VarKind>;

    constructor(parent: Scope | null, isCatch: boolean);

    /**
     * 在作用域中注册一个变量。
     * catch 内部声明的非 catch 变量会被提升到父作用域。
     */
    addVar(name: string, type: VarType, loc?: object, node?: object, kind?: VarKind): void;

    /** 返回变量的声明 kind，沿作用域链向上查找，找不到返回 null */
    getVarKind(name: string): VarKind;

    /** 只在当前作用域中查找 */
    hasOwnVar(name: string): VarType | null;

    /** 沿作用域链向上查找 */
    hasVar(name: string): VarType | null;

    /** 判断变量是否是全局变量 */
    isGlobal(name: string): boolean;

    /** 标记整条作用域链 hasEval = true */
    addEval(): void;
    /** 标记整条作用域链 hasArguments = true */
    addArguments(): void;
    /** 标记整条作用域链 hasWith_ = true */
    addWith(): void;

    usesEval(): boolean;
    usesArguments(): boolean;
    usesWith(): boolean;
}

/**
 * 遍历 AST，为每个作用域节点附加 .scope 属性，
 * 并将 `arguments` 标识符重命名为 `J$_arguments`。
 *
 * @param ast  Babel AST Program 节点
 */
export declare function addScopes(ast: object): void;

/**
 * 重置词法作用域 ID 计数器（每次 instrumentCode 前自动调用）。
 */
export declare function resetScopeCounter(): void;

/**
 * 从参数 pattern 节点中收集所有绑定的标识符名称。
 * 支持 Identifier / RestElement / AssignmentPattern / ObjectPattern / ArrayPattern。
 */
export declare function collectParamNames(param: object, collected: string[]): void;

// ── astUtil.js ────────────────────────────────────────────────────────────────

/**
 * AST 遍历上下文枚举值。
 */
export type ContextValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * AST 遍历上下文枚举对象（Object.freeze）。
 * 告知 visitor 当前节点所处的语义环境，决定是否需要插桩。
 */
export declare const CONTEXT: Readonly<{
    /** 右值（读取）上下文 */
    RHS: 1;
    /** 忽略（不插桩）上下文，如赋值左侧、标签名 */
    IGNORE: 2;
    /** ObjectExpression 的 properties 列表 */
    OEXP: 3;
    /** 函数形参列表 */
    PARAMS: 4;
    /** ObjectExpression 的某个 Property 节点 */
    OEXP2: 5;
    /** getter 函数体 */
    GETTER: 6;
    /** setter 函数体 */
    SETTER: 7;
    /** typeof 操作数 */
    TYPEOF: 8;
    /** ES6+ class 方法的 FunctionExpression */
    METHOD: 9;
}>;

/**
 * 通用 AST 遍历器，支持前序（visitorPre）和后序（visitorPost）访问。
 *
 * @param object      当前 AST 节点
 * @param visitorPost 后序访问者（每个方法的返回值替换原节点）
 * @param visitorPre  前序访问者（返回值被忽略，仅用于副作用）
 * @param context     当前上下文（CONTEXT 枚举值）
 * @param noIgnore    为 true 时不跳过任何子树
 */
export declare function transformAst(
    object: object,
    visitorPost: Record<string, (node: object, context: ContextValue) => object>,
    visitorPre?: Record<string, (node: object, context: ContextValue) => void>,
    context?: ContextValue,
    noIgnore?: boolean,
): void;

/**
 * 更新 astUtil 使用的沙盒变量名。
 * 由 esnstrument.init() 自动调用，一般不需要手动调用。
 */
export declare function setJalangiVar(v: string): void;

/**
 * 判断是否应忽略该子 AST（J$.I() 调用不需要再插桩）。
 */
export declare function ignoreSubAst(node: object): boolean;

// ── IidSourceMap (re-export from types for convenience) ──────────────────────

export type { JalangiConfig, IAnalysisPlugin, WrappedException, SourceLocation } from '../types.js';

/**
 * Jalangi 自有格式的 source map 对象（iid → 位置 + 元数据）。
 * 与 types.d.ts 中的 IidSourceMap 相同，此处 re-export 方便插桩器用户直接从本模块导入。
 */
export type { IidSourceMap } from '../types.js';
