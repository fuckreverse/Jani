/*
 * Copyright 2013 Samsung Information Systems America, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

/**
 * Jalangi2 插桩入口模块（浏览器 ESM 版）。
 *
 * 职责：
 *  1. 定义 AST visitor（visitorRRPre / visitorRRPost / visitorOps / sampling visitor）
 *  2. 实现 hoistFunctionDeclaration（兼容 Firefox 的函数声明提升）
 *  3. 导出 instrumentCode(options)  —— 主要对外 API
 *  4. 导出 instrumentEvalCode(code, iid, isDirect)  —— eval 插桩包装
 *
 * 依赖：
 *  - @babel/parser    (npm，支持 ES2022+ 及实验性语法解析)
 *  - @babel/generator  (npm，从 Babel AST 生成代码)
 */

import * as babelParser from '@babel/parser';
// @ts-ignore — @babel/generator 是 CJS 模块，类型定义不包含 .default，运行时需取 .default
import _babelGenerate   from '@babel/generator';
// @babel/generator 是 CJS 模块，ESM 导入需取 .default
const babelGenerate = /** @type {any} */ (_babelGenerate).default ?? _babelGenerate;
// @ts-ignore — @babel/traverse 是 CJS 模块，类型定义不包含 .default，运行时需取 .default
import _babelTraverse from '@babel/traverse';
// @babel/traverse 是 CJS 模块，ESM 导入需取 .default
const babelTraverse = /** @type {any} */ (_babelTraverse).default ?? _babelTraverse;

import { JALANGI_VAR }     from '../Constants.js';
import { CONTEXT, transformAst, setJalangiVar as setAstUtilJalangiVar } from './astUtil.js';
import { addScopes, resetScopeCounter } from './scope.js';
import { analyzeDefUse }  from './dataflow.js';
import * as IID            from './iid.js';
import * as W              from './wrappers.js';
import { analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig } from './pluginAnalyzer.js';
// ArrowFunctionExpression 专用初始化（仅做 syncDefuns，不注入 J$.Fe）
const { instrumentArrowFunctionBody } = W;

// ─── Config 注入（由宿主在使用前调用 init() 设置）──────────────────────────────
/** @type {import('../types.js').JalangiConfig | null} */
let _config = null;
/** @type {import('../types.js').IAnalysisPlugin | null} */
let _analysis = null;   // 当前分析对象（J$.analysis 等价物）
let _sid = null;        // 当前脚本 ID
let _jalangiVar = JALANGI_VAR;  // 当前沙盒变量名（可自定义）

/**
 * 初始化插桩器。必须在第一次调用 instrumentCode 之前调用。
 *
 * @param {import('../types.js').JalangiConfig | null} config - Jalangi Config 对象。
 *                                        若传入 null，且同时传入 plugins，则自动从插件推导 Config。
 * @param {import('../types.js').IAnalysisPlugin | null} [analysis] - 当前 analysis 对象（可选，用于 pre/post hook）
 * @param {*}              [sid]       - 当前脚本 ID（用于 eval 的 source map）
 * @param {string}         [jalangiVar] - 沙盒变量名（默认 'J$'）。
 * @param {Array<string|object>} [plugins] - 插件路径或实例列表，用于按需推导 Config。
 *                                            当 config 为 null 且提供了 plugins 时，
 *                                            自动分析插件所用 Hook 并生成最小化 Config。
 *                                            当 config 不为 null 时，plugins 被忽略。
 */
function init(config, analysis, sid, jalangiVar, plugins) {
    // 若 config 为 null 但提供了 plugins，则从插件推导按需 Config
    if (config == null && plugins != null) {
        config = buildConfigFromPlugins(plugins);
    } else if (config == null || typeof config !== 'object') {
        throw new TypeError('[jalangi] init(): config must be a non-null object (or pass plugins to auto-derive config)');
    }
    _config     = config;
    _analysis   = analysis ?? null;
    _sid        = sid ?? null;
    _jalangiVar = (typeof jalangiVar === 'string' && /^[A-Za-z_$][\w$]*$/.test(jalangiVar))
        ? jalangiVar
        : JALANGI_VAR;
    W.init(config, _jalangiVar);
    setAstUtilJalangiVar(_jalangiVar);
}

// ─── 字面量类型常量（本地别名）────────────────────────────────────────────────

const {
    N_LOG_ARRAY_LIT,
    N_LOG_OBJECT_LIT,
    N_LOG_FUNCTION_LIT,
    N_LOG_NUMBER_LIT,
    N_LOG_STRING_LIT,
    N_LOG_BOOLEAN_LIT,
    N_LOG_NULL_LIT,
    N_LOG_REGEXP_LIT,
    N_LOG_UNDEFINED_LIT,
    N_LOG_BIGINT_LIT,
} = W;

// ─── RegExp 序列化（用于 JSON 缓存 IID 时序列化 AST）────────────────────────

function regExpToJSON() {
    return {
        type:       'J$.AST.REGEXP',
        value:      this.source,
        glb:        this.global,
        ignoreCase: this.ignoreCase,
        multiline:  this.multiline,
    };
}

function JSONStringifyHandler(key, value) {
    if (key === 'scope')         return undefined;
    if (value instanceof RegExp) return regExpToJSON.call(value);
    return value;
}

function JSONParseHandler(key, value) {
    if (typeof value === 'object' && value?.type === 'J$.AST.REGEXP') {
        const flags = `${value.glb ? 'g' : ''}${value.ignoreCase ? 'i' : ''}${value.multiline ? 'm' : ''}`;
        return RegExp(value.value, flags);
    }
    return value;
}

const cloneAst = (src) =>
    JSON.parse(JSON.stringify(src, JSONStringifyHandler), JSONParseHandler);

// ─── 通用 CONTEXT 推断（从 Babel path 推断 astUtil.js 的 CONTEXT 枚举值）────────

/**
 * 根据 Babel path（包含父节点关系）推断当前节点所处的语义上下文（CONTEXT 枚举值）。
 * 这是 astUtil.js transformAst 中上下文推断逻辑的等价实现。
 *
 * @param {import('@babel/traverse').NodePath} path
 * @returns {number} CONTEXT 枚举值
 */
function getContext(path) {
    const parent = /** @type {any} */ (path.parent);
    if (!parent) return CONTEXT.RHS;
    const pt = /** @type {string} */ (parent.type);
    // path.key：当节点直接位于父节点的具名属性时为属性名（如 'left'、'test'）；
    //           当节点位于数组中时为数字索引（如 0、1）。
    // path.listKey：当节点位于数组中时为该数组的属性名（如 'params'、'body'、'arguments'）；
    //               当节点直接位于具名属性时为 undefined。
    // 因此「在父节点哪个位置」应统一用 key = listKey ?? path.key 来表示。
    const key    = path.listKey ?? path.key;

    // ── IGNORE 上下文：不应该插桩的位置 ────────────────────────────────────────
    if (
        // ImportDeclaration.source（字符串字面量如 "./foo.js"）不应插桩
        (pt === 'ImportDeclaration'       && key === 'source') ||
        // ExportDeclaration.source 同理
        (pt === 'ExportNamedDeclaration'  && key === 'source') ||
        (pt === 'ExportAllDeclaration'    && key === 'source') ||
        (pt === 'AssignmentExpression'   && key === 'left') ||
        (pt === 'UpdateExpression'       && key === 'argument') ||
        (pt === 'UnaryExpression'        && key === 'argument' && parent.operator === 'delete') ||
        (pt === 'ForInStatement'         && key === 'left') ||
        (pt === 'ForOfStatement'         && key === 'left') ||
        ((pt === 'FunctionExpression' || pt === 'FunctionDeclaration') && key === 'id') ||
        (pt === 'ArrowFunctionExpression' && key === 'id') ||
        ((pt === 'ClassDeclaration' || pt === 'ClassExpression') && key === 'id') ||
        (pt === 'ImportSpecifier'          && (key === 'local' || key === 'imported')) ||
        (pt === 'ImportDefaultSpecifier'   && key === 'local') ||
        (pt === 'ImportNamespaceSpecifier' && key === 'local') ||
        (pt === 'ExportSpecifier'          && (key === 'local' || key === 'exported')) ||
        (pt === 'LabeledStatement'         && key === 'label') ||
        (pt === 'BreakStatement'           && key === 'label') ||
        (pt === 'CatchClause'              && key === 'param') ||
        (pt === 'ContinueStatement'        && key === 'label') ||
        ((pt === 'CallExpression' || pt === 'NewExpression') &&
            key === 'callee' &&
            (parent.callee.type === 'MemberExpression' ||
             (parent.callee.type === 'Identifier' && parent.callee.name === 'eval'))) ||
        (pt === 'OptionalCallExpression' &&
            key === 'callee' &&
            (parent.callee.type === 'OptionalMemberExpression' ||
             parent.callee.type === 'MemberExpression')) ||
        (pt === 'VariableDeclarator'        && key === 'id') ||
        (pt === 'MemberExpression'          && !parent.computed && key === 'property') ||
        (pt === 'OptionalMemberExpression'  && !parent.computed && key === 'property') ||
        (pt === 'Property'                  && key === 'key' && !parent.computed) ||
        (pt === 'RestElement'               && key === 'argument') ||
        (pt === 'AssignmentPattern'         && key === 'left') ||
        (pt === 'PropertyDefinition'        && key === 'key' && !parent.computed) ||
        (pt === 'MethodDefinition'          && key === 'key' && !parent.computed) ||
        (pt === 'ClassMethod'               && key === 'key' && !parent.computed) ||
        // Babel AST: ClassProperty（class static/instance 字段声明）的 key 不应插桩
        (pt === 'ClassProperty'             && key === 'key' && !parent.computed) ||
        (pt === 'ClassPrivateProperty'      && key === 'key') ||
        (pt === 'PrivateName'               && key === 'id') ||
        // MetaProperty（new.target、import.meta）的 meta 和 property 都是保留字 Identifier，
        // 不应被插桩（否则 meta: Identifier('new') 会被包装为 CallExpression，破坏 MetaProperty 语法）。
        (pt === 'MetaProperty'              && (key === 'meta' || key === 'property')) ||
        // ObjectMethod 的 computed key（如 [Symbol.iterator](){}）：
        // @babel/types 校验不允许 ObjectMethod.key 是 CallExpression，即使 computed=true。
        // 故对 ObjectMethod.key 一律 IGNORE（不插桩）。
        (pt === 'ObjectMethod'              && key === 'key')
    ) {
        return CONTEXT.IGNORE;
    }

    // ── TYPEOF 上下文：typeof 操作数（Identifier）────────────────────────────
    if (pt === 'UnaryExpression' && parent.operator === 'typeof' && key === 'argument'
            && path.node.type === 'Identifier') {
        return CONTEXT.TYPEOF;
    }

    // ── 函数参数列表（params）→ PARAMS，其子节点视为 IGNORE ──────────────────
    // 函数参数中的标识符/模式不插桩
    if (
        ((pt === 'FunctionExpression' || pt === 'FunctionDeclaration' || pt === 'ArrowFunctionExpression')
            && key === 'params') ||
        (pt === 'ClassMethod' && key === 'params')
    ) {
        return CONTEXT.IGNORE; // params 数组中的每个参数节点 IGNORE
    }

    // ── ObjectExpression / ObjectPattern 属性中的 key 不插桩 ──────────────
    if (pt === 'ObjectProperty' && key === 'key' && !parent.computed) {
        return CONTEXT.IGNORE;
    }
    // ── 解构绑定模式（ObjectPattern）中的 ObjectProperty.value 是绑定目标，不应插桩 ──
    // ObjectProperty 既出现在 ObjectExpression（字面量 {a: 1}，value 是 RHS）中，
    // 也出现在 ObjectPattern（解构 {a: x}，value 是绑定目标，IGNORE）中。
    // 通过检查祖先节点（path.parentPath.parentPath）来区分两种场景。
    if (pt === 'ObjectProperty' && key === 'value') {
        const grandParent = path.parentPath?.parent;
        if (grandParent?.type === 'ObjectPattern') {
            return CONTEXT.IGNORE;
        }
    }
    // ── ArrayPattern.elements 中的元素是绑定目标，不应插桩 ──────────────────
    // ArrayPattern 的每个元素（Identifier / AssignmentPattern / RestElement 等）
    // 都是绑定目标，不应被 wrapRead 插桩。
    if (pt === 'ArrayPattern' && key === 'elements') {
        return CONTEXT.IGNORE;
    }

    // ── GETTER / SETTER / METHOD 上下文 ─────────────────────────────────────
    // Property（ES5 对象字面量）的 getter/setter
    if (pt === 'ObjectProperty' && key === 'value' && parent.kind === 'get') {
        return CONTEXT.GETTER;
    }
    if (pt === 'ObjectProperty' && key === 'value' && parent.kind === 'set') {
        return CONTEXT.SETTER;
    }
    // ObjectMethod（Babel 用 ObjectMethod 表示方法简写、get、set）
    if (pt === 'ObjectMethod' && key === 'body') {
        if (parent.kind === 'get') return CONTEXT.GETTER;
        if (parent.kind === 'set') return CONTEXT.SETTER;
        return CONTEXT.METHOD;
    }
    // ClassMethod 的 body
    if (pt === 'ClassMethod' && key === 'body') {
        if (parent.kind === 'get') return CONTEXT.GETTER;
        if (parent.kind === 'set') return CONTEXT.SETTER;
        return CONTEXT.METHOD;
    }
    // MethodDefinition（ESTree，Babel 用 ClassMethod）
    if (pt === 'MethodDefinition' && key === 'value') {
        return CONTEXT.METHOD;
    }

    // ── 默认：RHS（右值，需要插桩读取）──────────────────────────────────────
    return CONTEXT.RHS;
}

// ─── visitor：克隆函数体（用于 ENABLE_SAMPLING 模式）──────────────────────────

const visitorCloneBodyPre = {
    FunctionExpression(node)  { node.bodyOrig = cloneAst(node.body); return node; },
    FunctionDeclaration(node) { node.bodyOrig = cloneAst(node.body); return node; },
};

// ─── visitor：合并采样函数体（用于 ENABLE_SAMPLING 模式）────────────────────

function mergeBodies(node) {
    // 仅处理经过 Pass 0（visitorCloneBodyPre）存入了 bodyOrig 的函数节点。
    // wrapFunBodyWithTryCatch / wrapScriptBodyWithTryCatch 在 Pass 2 中注入了
    // 辅助性的 "function n() { ... }" wrapper，这些节点没有 bodyOrig，
    // 在此直接跳过，不进行采样合并，否则会将 undefined 作为 consequent。
    if (!node.bodyOrig) return node;

    IID.printIidToLoc(node);
    const iid = IID.getIid();
    const test = {
        type: 'UnaryExpression',
        operator: '!',
        prefix: true,
        argument: {
            type: 'CallExpression',
            callee: {
                type: 'MemberExpression',
                object:   { type: 'Identifier', name: JALANGI_VAR },
                property: { type: 'Identifier', name: 'S' },
                computed: false,
            },
            arguments: [
                iid,
                {
                    type: 'MemberExpression',
                    object:   { type: 'Identifier', name: 'arguments' },
                    property: { type: 'Identifier', name: 'callee' },
                    computed: false,
                },
            ],
        },
    };
    // 先保存当前 body 中的语句列表（instrumented 后的函数体），
    // 再创建全新的 BlockStatement 作为 alternate，避免 alternate: node.body
    // 与 node.body.body 的重新赋值之间产生循环引用，导致
    // hoistFunctionDeclaration 的 Object.keys 遍历无限递归。
    const instrumentedStmts = node.body.body;
    const alternateBlock = { type: 'BlockStatement', body: instrumentedStmts };
    node.body.body = [{
        type:       'IfStatement',
        test,
        consequent: node.bodyOrig,
        alternate:  alternateBlock,
    }];
    delete node.bodyOrig;
    return node;
}

const visitorMergeBodyPre = {
    FunctionExpression:  mergeBodies,
    FunctionDeclaration: mergeBodies,
};

// ─── ignoreSubAst：跳过已插桩的 J$.I() 子树 ────────────────────────────────

function ignoreSubAst(node) {
    return node.type === 'CallExpression'
        && node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === _jalangiVar
        && node.callee.property?.type === 'Identifier'
        && node.callee.property.name === 'I';
}

/**
 * 替换当前 path 所指节点为 newNode，并在 newNode 上打上 __j_instrumented 标记，
 * 防止 @babel/traverse 在 replaceWith 后重新遍历新节点时触发无限循环。
 *
 * @param {import('@babel/traverse').NodePath} path
 * @param {object} newNode
 */
function replaceAndMark(path, newNode) {
    newNode.__j_instrumented = true;
    path.replaceWith(newNode);
}

// ─── 主插桩变换（单一 babelTraverse pass）────────────────────────────────────

/**
 * 使用单一 babelTraverse 完成所有插桩变换（合并了旧版 Pass 1 + Pass 2）。
 *
 * 设计原则：
 *  - 全局 enter 拦截：被 replaceAndMark 标记为 __j_instrumented 的节点，在 enter
 *    时立即 skip 整个子树，防止 replaceWith 触发重新遍历导致无限循环。
 *  - 函数节点（FunctionDeclaration/FunctionExpression/ArrowFunctionExpression）在
 *    单一 exit 里按顺序完成：
 *      1. instrumentFunctionEntryExit（注入 J$.Fe/J$.Fr）
 *      2. wrapFunBodyWithTryCatch（添加 try-catch 包裹）
 *      3. wrapLiteral（包装为 J$.T 字面量钩子）
 *  - Program 节点在 exit 里：instrumentScriptEntryExit → wrapScriptBodyWithTryCatch
 *
 * @param {object} file - Babel File 节点
 */
function runInstrumentPass(file) {
    babelTraverse(file, {
        // ── 全局 enter：跳过已被 replaceAndMark 标记的节点子树 ─────────────────
        // 防止 exit 中的 replaceWith 导致重新遍历已插桩节点（无限循环）。
        enter(path) {
            if (path.node.__j_instrumented) path.skip();
        },

        // ── 作用域进入（前序 enter）────────────────────────────────────────────
        Program: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // Step 1（原 Pass 1）：注入脚本入口/出口钩子 J$.Se / J$.Le
                const ret = W.instrumentScriptEntryExit(
                    node, node.body,
                    IID.getInstCodeFileName(),
                    IID.getOrigCodeFileName()
                );
                node.body = ret;
                W.popScope();
                // Step 2（原 Pass 2）：添加脚本级 try-catch 包裹（J$.Ex / J$.Sr / J$.L）
                node.body = W.wrapScriptBodyWithTryCatch(node, node.body);
            },
        },

        FunctionDeclaration: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // Step 1（原 Pass 1）：注入函数入口/出口钩子 J$.Fe / J$.Fr
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
                W.popScope();
                // Step 2（原 Pass 2）：添加函数体 try-catch 包裹
                if (!node.generator && !node.async) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
                // FunctionDeclaration 不需要 wrapLiteral（不是表达式）
            },
        },

        FunctionExpression: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // Step 1（原 Pass 1）：注入函数入口/出口钩子 J$.Fe / J$.Fr
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
                // getter / setter / class 方法不作为独立字面量包装
                const ctx = getContext(path);
                const shouldWrapAsLiteral = !(ctx === CONTEXT.GETTER || ctx === CONTEXT.SETTER || ctx === CONTEXT.METHOD);
                W.popScope();
                // Step 2（原 Pass 2）：添加函数体 try-catch 包裹
                // Guard: generator/async 不包裹；probe fn（__j_probe）不包裹
                if (!node.generator && !node.async && !node.__j_probe) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
                // Step 3（原 Pass 1）：将函数表达式包装为 J$.T 字面量钩子
                const ret = shouldWrapAsLiteral ? W.wrapLiteral(node, node, N_LOG_FUNCTION_LIT) : node;
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        ArrowFunctionExpression: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // 箭头函数没有独立的 arguments / this / callee，
                // 不注入 J$.Fe / J$.Fr 入口出口钩子，但需要：
                //  1. 对块体注入参数/var 同步语句（syncDefuns）
                //  2. 恢复 _scope 到父作用域（popScope）
                //  3. 将节点包装为字面量（J$.T），与 FunctionExpression 一致
                //
                // BUG-5 注释修正（设计取舍，非 bug）：
                // 箭头函数**不**添加 try-catch 包裹，也不注入 J$.Fr。
                // 这是有意为之：箭头函数没有独立的 this/arguments 绑定，
                // 向其插入 try-catch 会改变其中 return 表达式的语义（表达式体箭头函数
                // `() => expr` 无法插入 try-catch），且注入 J$.Fr 需要配套的 J$.Fe，
                // 而箭头函数没有 Fe，两者必须配对。
                // 代价：箭头函数内抛出的异常不会被 J$.Ex 捕获，分析插件也不会收到
                // functionEnter/functionExit 回调。这是已知的、明确接受的取舍。
                instrumentArrowFunctionBody(node);
                W.popScope();
                const ret = W.wrapLiteral(node, node, N_LOG_FUNCTION_LIT);
                replaceAndMark(path, ret);
            },
        },

        ClassMethod: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // BUG-derived-constructor 修复：子类 constructor 在 super() 之前访问 this 会报错。
                // 检测：当前方法是 constructor，且所在 class 有 superClass（即 extends XXX）。
                // 如果是，则 instrumentFunctionEntryExit 中跳过 this 参数（传 undefined）。
                const isDerivedConstructor = node.kind === 'constructor'
                    && path.parentPath?.parent?.superClass != null;
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body, isDerivedConstructor);
                W.popScope();
                // ClassMethod 的 try-catch 包裹：同 FunctionExpression
                if (!node.generator && !node.async) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
            },
        },

        // BUG-INS-05 修复：补充 ObjectMethod 的 scope 管理
        // ObjectMethod 是 Babel 中表示对象字面量方法简写（如 { method() {...} }）的节点类型。
        // 虽然在 scope.js 的 addScopes 中已正确处理，但 runInstrumentPass 的 visitor 遗漏了
        // scope 进出管理，导致该方法内的插桩代码中 _scope 指向错误。
        ObjectMethod: {
            enter(path) {
                W.setScope(path.node);
                // BUG-computed-key 修复：ObjectMethod 的 computed key（如 [Symbol.iterator]）
                // 不能被插桩（@babel/types 不允许 ObjectMethod.key 是 CallExpression）。
                // 在 enter 时将 key 子树的节点打上 __j_instrumented 标记，使其在后续
                // enter 时被 skip，从而跳过对 key 内部节点（如 Symbol 标识符）的插桩。
                if (path.node.computed && path.node.key) {
                    path.node.key.__j_instrumented = true;
                }
            },
            exit(path) {
                const node = path.node;
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
                W.popScope();
                // ObjectMethod 的 try-catch 包裹：同 FunctionExpression
                if (!node.generator && !node.async) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
            },
        },

        // 架构-2 修复：补充 ClassDeclaration 的 scope 进出管理。
        // scope.js/addScopes 中 ClassDeclaration 会在外层作用域注册类名，
        // 但不为 ClassDeclaration 本身创建独立 scope（无 node.scope），
        // 因此这里不需要 setScope/popScope。
        // 添加此 visitor 是为了与 addScopes 的遍历逻辑保持结构对称，
        // 并在 node.scope 存在时（未来可能扩展）正确处理。
        ClassDeclaration: {
            enter(path) {
                if (path.node.scope) W.setScope(path.node);
            },
            exit(path) {
                if (path.node.scope) W.popScope();
            },
        },

        ClassExpression: {
            enter(path) {
                if (path.node.scope) W.setScope(path.node);
            },
            exit(path) {
                if (path.node.scope) W.popScope();
            },
        },

        CatchClause: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // ES2019+: optional catch binding 时 node.param 为 null，跳过包装
                if (node.param?.type === 'Identifier') {
                    W.wrapCatchClause(node, node.body.body, node.param.name);
                }
                W.popScope();
            },
        },

        // ── 后序 exit：字面量插桩（原 Pass 1 visitorRRPost）──────────────────

        NumericLiteral: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_NUMBER_LIT);
                replaceAndMark(path, ret);
            },
        },

        StringLiteral: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_STRING_LIT);
                replaceAndMark(path, ret);
            },
        },

        BooleanLiteral: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_BOOLEAN_LIT);
                replaceAndMark(path, ret);
            },
        },

        NullLiteral: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_NULL_LIT);
                replaceAndMark(path, ret);
            },
        },

        RegExpLiteral: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_REGEXP_LIT);
                replaceAndMark(path, ret);
            },
        },

        BigIntLiteral: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_BIGINT_LIT);
                replaceAndMark(path, ret);
            },
        },

        VariableDeclaration: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.declarations = node.declarations.map((def) => {
                    // BUG-5 fix: 解构声明（ObjectPattern / ArrayPattern）的 def.id 不是 Identifier，
                    // 直接访问 def.id.name 会得到 undefined，导致错误地插入 J$.W(iid, undefined, ...)。
                    // 对非 Identifier 的解构模式暂不插桩写入（解构赋值已由 AssignmentExpression 处理）。
                    //
                    // Guard: 若 def.id 既不是 Identifier 也不是解构 Pattern，说明遇到了未预期的 AST 节点类型
                    const _knownNonIdentTypes = new Set(['ObjectPattern', 'ArrayPattern']);
                    if (def.id.type !== 'Identifier' && !_knownNonIdentTypes.has(def.id.type)) {
                        throw new Error(
                            `[jalangi] VariableDeclaration: unexpected declarator id type "${def.id.type}". ` +
                            `Expected Identifier, ObjectPattern, or ArrayPattern.`
                        );
                    }
                    if (def.init !== null && def.id.type === 'Identifier') {
                        const scope    = W.getScope();
                        const defScope = W._findDefScope(scope, def.id.name);
                        const scopeId  = defScope?.id;
                        let init = W.wrapWrite(def.init, W.createLiteralAst(def.id.name), def.init, def.id,
                            false, scope.isGlobal(def.id.name), true, scopeId);
                        init = W.wrapWithX1(def.init, init);
                        def.init = init;
                    }
                    return def;
                });
            },
        },

        NewExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                const ret = {
                    type:      'CallExpression',
                    callee:    W.instrumentCall(node, true),
                    arguments: node.arguments,
                };
                W.transferLoc(ret, node);
                replaceAndMark(path, ret);
            },
        },

        CallExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                // 跳过已插桩的 J$.* 调用（防止二次插桩）
                // BUG-10 修复：同时覆盖 OptionalMemberExpression（J$?.F 形式，
                // 理论上不会出现，但作为防御性检查一并处理）
                const calleeType = node.callee?.type;
                if ((calleeType === 'MemberExpression' || calleeType === 'OptionalMemberExpression')
                        && node.callee.object?.name === _jalangiVar) return;
                // BUG-super 修复：super() 调用的 callee 是 Super 节点（关键字），
                // 不能作为普通值传入 J$.F(iid, super, 0)，否则产生语法错误。
                // super(...args) 调用必须保持原始语义，跳过 instrumentCall。
                if (calleeType === 'Super') return;
                // BUG-private-field 修复：私有方法调用（this.#method()）的 callee 是
                // MemberExpression { property: PrivateName }。
                // J$.M(iid, base, "#method") 会调用 base["#method"]（undefined），产生 TypeError。
                // 私有方法调用跳过 instrumentCall，保留原始语义。
                if (calleeType === 'MemberExpression' && node.callee.property?.type === 'PrivateName') return;
                const isEval = node.callee.type === 'Identifier' && node.callee.name === 'eval';
                node.callee = W.instrumentCall(node, false);
                if (isEval) node.arguments = node.arguments.map(W.wrapEvalArg);
            },
        },

        AssignmentExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                // BUG-private-field 修复：私有字段赋值（this.#n = val 或 this.#n += val）。
                // J$.P(iid, base, "#n", val) 会将 base["#n"] 设为 val（公有属性！），
                // 而私有字段本身不受影响，导致语义分裂。
                // 私有字段的赋值跳过插桩，保留原始语义。
                const leftNode = node.left;
                if (leftNode?.type === 'MemberExpression' && leftNode.property?.type === 'PrivateName') return;
                const ret = node.operator === '='
                    ? W.instrumentStore(node, false)
                    : W.instrumentLoadModStore(node);
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        UpdateExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                // BUG-private-field 修复：私有字段（this.#n++）的 argument 是
                // MemberExpression { property: PrivateName }。
                // 私有字段不支持 bracket notation（base["#n"]），J$.A/J$.G/J$.P 钩子无法处理，
                // 会返回 undefined，导致数值运算产生 NaN。
                // 对私有字段的自增/自减操作跳过插桩，保留原始语义。
                const arg = node.argument;
                if (arg?.type === 'MemberExpression' && arg.property?.type === 'PrivateName') return;
                let ret = W.instrumentPreIncDec(node);
                if (!node.prefix) ret = W.adjustIncDec(node.operator, ret);
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        ObjectExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_OBJECT_LIT);
                replaceAndMark(path, ret);
            },
        },

        ArrayExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const ret = W.wrapLiteral(path.node, path.node, N_LOG_ARRAY_LIT);
                replaceAndMark(path, ret);
            },
        },

        ThisExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const ret = W.wrapRead(path.node, W.createLiteralAst('this'), path.node, false, false, false);
                replaceAndMark(path, ret);
            },
        },

        Identifier: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const ctx = getContext(path);
                let ret;
                if (ctx === CONTEXT.RHS)    ret = W.instrumentLoad(path.node, false);
                else if (ctx === CONTEXT.TYPEOF) ret = W.instrumentLoad(path.node, true);
                else return;
                if (ret !== path.node) replaceAndMark(path, ret);
            },
        },

        MemberExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                // BUG-private-field 修复：私有字段（this.#n）不支持 bracket notation，
                // J$.G(iid, base, "#n") 会将 base["#n"] 返回 undefined。
                // 私有字段的读取跳过 instrumentLoad，保留原始语义。
                if (path.node.property?.type === 'PrivateName') return;
                const ret = W.instrumentLoad(path.node, false);
                if (ret !== path.node) replaceAndMark(path, ret);
            },
        },

        // OptionalMemberExpression（a?.b）：在 RHS 上下文中注入 J$.G 属性读取钩子。
        OptionalMemberExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.instrumentLoad(path.node, false);
                if (ret !== path.node) replaceAndMark(path, ret);
            },
        },

        // OptionalCallExpression（a?.()）：注入 J$.M / J$.F 调用钩子。
        OptionalCallExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.callee = W.instrumentCall(node, false);
            },
        },

        SequenceExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                const last = node.expressions.length - 1;
                for (let i = 0; i < last; i++) {
                    node.expressions[i] = W.wrapWithX1(node.expressions[i], node.expressions[i]);
                }
            },
        },

        ForInStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.right = W.wrapHash(node.right, node.right);
                const ret = W.wrapForIn(node, node.left, node.right, node.body);
                if (ret !== node) {
                    // wrapForIn 可能附带了一个需要前置插入的局部变量声明（_jalangiTmpVarDecl）。
                    // 例如 `var J$_fk0;` 用于替代旧的 J$._tm_p 沙盒属性传递迭代变量。
                    // 使用 Babel path.replaceWithMultiple 将 [varDecl, forInStmt] 一并替换。
                    const tmpVarDecl = ret._jalangiTmpVarDecl;
                    delete ret._jalangiTmpVarDecl;
                    if (tmpVarDecl) {
                        // 将两个节点都标记为已插桩，防止 enter 时再次遍历
                        tmpVarDecl.__j_instrumented = true;
                        ret.__j_instrumented = true;
                        path.replaceWithMultiple([tmpVarDecl, ret]);
                    } else {
                        replaceAndMark(path, ret);
                    }
                }
            },
        },

        ReturnStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                const ret = W.wrapReturn(node, node.argument);
                node.argument = W.wrapWithX1(node, ret);
            },
        },

        ThrowStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                const ret = W.wrapThrow(node, node.argument);
                node.argument = W.wrapWithX1(node, ret);
            },
        },

        ExpressionStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.expression = W.wrapWithX1(node, node.expression);
            },
        },

        /**
         * AwaitExpression 插桩：将 `await expr` 转换为 `J$.Aw(iid, await expr)`。
         */
        AwaitExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const ret = W.wrapAwait(path.node, path.node.argument);
                if (ret !== path.node) replaceAndMark(path, ret);
            },
        },

        // ── 运算符插桩（原 Pass 2 visitorOps）────────────────────────────────

        BinaryExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                const ret = W.wrapBinaryOp(node, node.left, node.right, node.operator);
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        LogicalExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                let ret = node;
                if (node.operator === '&&') ret = W.wrapLogicalAnd(node, node.left, node.right);
                else if (node.operator === '||') ret = W.wrapLogicalOr(node, node.left, node.right);
                else if (node.operator === '??') ret = W.wrapLogicalNullish(node, node.left, node.right);
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        UnaryExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                if (node.operator === 'void') return;
                let ret = node;
                if (node.operator === 'delete') {
                    if (node.argument.object) {
                        ret = W.wrapBinaryOp(node, node.argument.object,
                            W.getPropertyAsAst(node.argument), node.operator, node.argument.computed);
                    }
                } else {
                    ret = W.wrapUnaryOp(node, node.argument, node.operator);
                }
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        SwitchStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                let dis = W.wrapSwitchDiscriminant(node.discriminant, node.discriminant);
                dis = W.wrapWithX1(node.discriminant, dis);
                node.cases = node.cases.map((acase) => {
                    if (acase.test) {
                        const test = W.wrapSwitchTest(acase.test, acase.test);
                        acase.test = W.wrapWithX1(acase.test, test);
                    }
                    return acase;
                });
                node.discriminant = dis;
            },
        },

        WithStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                W.getScope()?.addWith();
                node.object = W.wrapWith(node.object);
            },
        },

        ConditionalExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.test   = W.wrapConditional(node.test, node.test);
                node.test   = W.wrapWithX1(node, node.test);
            },
        },

        IfStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.test   = W.wrapConditional(node.test, node.test);
                node.test   = W.wrapWithX1(node, node.test);
            },
        },

        WhileStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.test   = W.wrapConditional(node.test, node.test);
                node.test   = W.wrapWithX1(node, node.test);
            },
        },

        DoWhileStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.test   = W.wrapConditional(node.test, node.test);
                node.test   = W.wrapWithX1(node, node.test);
            },
        },

        ForStatement: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                const node = path.node;
                node.test   = W.wrapConditional(node.test, node.test);
                node.test   = W.wrapWithX1(node, node.test);
                node.init   = W.wrapWithX1(node, node.init);
                node.update = W.wrapWithX1(node, node.update);
            },
        },
    });
}

// ─── 函数声明提升（Firefox 兼容）─────────────────────────────────────────────

/**
 * 将 FunctionDeclaration 提升到每个作用域 body 的最前面
 * （紧接在 J$.Se / J$.Fe 调用之后），以匹配浏览器的实际求值顺序。
 */
function hoistFunctionDeclaration(ast, hoistedFunctions) {
    if (ast.body && Array.isArray(ast.body)) {
        const newBody = [];
        let startIndex = 0;

        // 跳过 J$.Se / J$.Fe（必须保持在最前面）
        if (ast.body.length > 0) {
            const first = ast.body[0];
            if (first.type === 'ExpressionStatement'
                    && first.expression.type === 'CallExpression'
                    && first.expression.callee.object?.name === JALANGI_VAR
                    && (first.expression.callee.property?.name === 'Se'
                        || first.expression.callee.property?.name === 'Fe')) {
                newBody.push(first);
                startIndex = 1;
            }
        }

        // 先放 FunctionDeclaration
        for (let i = startIndex; i < ast.body.length; i++) {
            if (ast.body[i].type === 'FunctionDeclaration') {
                newBody.push(ast.body[i]);
                if (newBody.length !== i + 1) hoistedFunctions.push(ast.body[i].id.name);
            }
        }
        // 再放其余语句
        for (let i = startIndex; i < ast.body.length; i++) {
            if (ast.body[i].type !== 'FunctionDeclaration') newBody.push(ast.body[i]);
        }

        ast.body = newBody;
    }

    // 递归处理子节点
    // BUG-9 修复：原代码用 Object.keys(ast) 遍历所有 key，
    // 当 child 是数组时，Object.keys 返回数字索引 ['0','1',...]，
    // 功能上可工作但语义不清晰，且数组自身的 body 等字段可能触发意外逻辑。
    // 现在显式区分数组和对象节点，分别处理。
    for (const key of Object.keys(ast)) {
        if (key === 'scope') continue;
        const child = ast[key];
        if (!child || typeof child !== 'object') continue;
        if (Array.isArray(child)) {
            // 数组子节点（如 body、params）：逐元素处理
            for (const item of child) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    hoistFunctionDeclaration(item, hoistedFunctions);
                }
            }
        } else {
            hoistFunctionDeclaration(child, hoistedFunctions);
        }
    }
    return ast;
}

// ─── AST 转换主流程 ────────────────────────────────────────────────────────────

/**
 * 解析代码字符串，返回 Babel File 节点（包含 .program: Program）。
 * @babel/traverse 需要 File 节点作为根节点；addScopes 同样接受 File 节点。
 */
function babelParse(code, sourceType) {
    return babelParser.parse(code, {
        sourceType,
        // 启用 Babel 支持的所有稳定 + 提案语法
        plugins: [
            'classProperties',
            'classPrivateMethods',
            'classPrivateProperties',
            'classStaticBlock',
            'importAttributes',
            'decorators-legacy',
            'doExpressions',
            'exportDefaultFrom',
            'functionBind',
            'logicalAssignment',
            'nullishCoalescingOperator',
            'optionalChaining',
            'throwExpressions',
            'topLevelAwait',
        ],
        // 保留位置信息（loc / start / end），后续 IID 记录依赖 .loc
        // （Babel 默认开启，此处显式标注）
        ranges: false,
    });
}

function transformString(code, sourceType, enableSampling) {
    // babelParse 现在返回 File 节点（{ type:'File', program: Program }）
    const file    = babelParse(code, sourceType);
    const newAst  = file.program;   // Program 节点（各 visitor 操作对象）

    // addScopes 接受 File 节点（供内部 @babel/traverse 使用）
    addScopes(file, _jalangiVar);

    // Pass 0 — 静态 def-use 分析，生成插桩决策表
    // analyzeDefUse 依赖 addScopes 附加的 .scope 字段，输入 Program 节点
    const instrDecisions = analyzeDefUse(newAst);
    W.setInstrDecisions(instrDecisions);

    if (enableSampling) {
        // ENABLE_SAMPLING 模式：Pass -1 克隆函数体（使用旧版 transformAst，仅访问两个节点类型）
        transformAst(newAst, visitorCloneBodyPre, undefined, CONTEXT.RHS);
    }

    // 主插桩变换（单一 pass，合并了旧版 Pass 1 + Pass 2）
    runInstrumentPass(file);

    if (enableSampling) {
        // ENABLE_SAMPLING 模式：最后合并采样函数体
        transformAst(newAst, visitorMergeBodyPre, undefined, CONTEXT.RHS);
    }

    // Pass 结束后清理决策表（避免内存泄漏和跨文件污染）
    W.setInstrDecisions(null);

    return newAst;
}

// ─── 主 API ────────────────────────────────────────────────────────────────────

const NO_INSTR = '// JALANGI DO NOT INSTRUMENT';

/**
 * 对代码字符串进行插桩。
 *
 * @param {{
 *   isEval?:           boolean,   // 是否是 eval 动态代码
 *   code:              string,    // 要插桩的代码
 *   thisIid?:          number,    // eval 时的调用点 IID
 *   origCodeFileName?: string,    // 原始文件名（用于 source map）
 *   instCodeFileName?: string,    // 插桩后文件名
 *   inlineSourceMap?:  boolean,   // 是否内联完整 source map
 *   inlineSource?:     boolean,   // 是否内联原始源代码
 *   url?:              string,    // 脚本的 URL（可选）
 *   isDirect?:         boolean,   // eval 是否是直接调用
 *   sourceType?:       string,    // 'script'（默认）或 'module'
 * }} options
 *
 * @return {{
 *   code:            string,
 *   instAST:         object,
 *   sourceMapObject: object,
 *   sourceMapString: string,
 *   vlcqSourceMap:   object | null
 * }}
 */
function instrumentCode(options) {
    // Guard: init() 必须在第一次调用前完成
    if (_config === null) {
        throw new Error(
            '[jalangi] instrumentCode() called before init(). ' +
            'You must call init(config) first to provide a Config object.'
        );
    }
    // Guard: options 必须是对象
    if (options == null || typeof options !== 'object') {
        throw new TypeError(
            `[jalangi] instrumentCode(): options must be a non-null object, got ${typeof options}`
        );
    }
    // Guard: code 必须是字符串
    if (typeof options.code !== 'string') {
        throw new TypeError(
            `[jalangi] instrumentCode(): options.code must be a string, got ${typeof options.code}. ` +
            `If you want to skip instrumentation, pass an empty string '' instead.`
        );
    }
    // Guard: sourceType 只允许 'script' 或 'module'
    const _srcType = options.sourceType ?? 'script';
    if (_srcType !== 'script' && _srcType !== 'module') {
        throw new Error(
            `[jalangi] instrumentCode(): options.sourceType must be 'script' or 'module', got ${JSON.stringify(_srcType)}`
        );
    }

    const {
        isEval        = false,
        thisIid,
        inlineSource  = false,
        url,
        isDirect      = false,
        sourceType    = 'script',
    } = options;

    let code = options.code;

    // 初始化 IID 计数器及文件名，并重置文件级可变状态（保证插桩幂等性）
    IID.initialize(isEval, options.instCodeFileName, options.origCodeFileName);
    W.resetPerFile();
    resetScopeCounter();  // TODO-6: 保证 ScopeID 幂等性（每次插桩前重置计数器）

    // pre-hook（允许分析修改代码或跳过插桩）
    let skip = false;
    if (_analysis?.instrumentCodePre) {
        const aret = _analysis.instrumentCodePre(/** @type {number} */ (thisIid), code, isDirect);
        if (aret) { code = /** @type {string} */ (aret.code); skip = aret.skip; }
    }

    let newAst;
    // 标准 VLCQ source map（v3 格式），仅在成功插桩时生成
    let vlcqSourceMap = null;

    if (!skip && typeof code === 'string' && !code.includes(NO_INSTR)) {
        try {
            newAst = transformString(code, sourceType, !!_config?.ENABLE_SAMPLING);

            newAst = hoistFunctionDeclaration(newAst, []);

            // 同时生成代码和标准 VLCQ source map（sourceMaps: true）。
            // sourceFileName 告知 @babel/generator 原始文件名，写入 sources 字段。
            const genResult = babelGenerate(newAst, {
                sourceMaps:   true,
                sourceFileName: options.origCodeFileName ?? 'unknown',
            });
            const newCode    = genResult.code;
            const rawVlcqMap = genResult.map;   // { version:3, sources, mappings, ... }

            // script 模式直接输出插桩代码，不用 IIFE 包裹，保持 var 声明的全局提升语义。
            // module 模式 ESM 已自带私有作用域，改用 const 局部绑定。
            const jv = _jalangiVar;
            if (sourceType === 'module') {
                // module 模式头部：1 行（`const J$ = globalThis.J$;\n`）
                code = `const ${jv} = globalThis.${jv};\n${newCode}\n${NO_INSTR}\n`;
            } else {
                // script 模式：直接输出，不包 IIFE，var 可正常提升到全局作用域
                code = `${newCode}\n${NO_INSTR}\n`;
            }

            // ── VLCQ source map 行偏移补偿 ──────────────────────────────────
            // babelGenerate 生成的 map 中，插桩代码的起始行为第 1 行。
            // 但最终输出文件在这段代码前面还有：
            //   • 第 1 行：`(globalThis.J$=...);J$.smap=...;\n`（smap 注入头，1 行）
            //   • script 模式：无 IIFE 包裹，偏移 = 1 行
            //   • module 模式：const J$ = globalThis.J$; 绑定行，偏移 = 2 行
            //
            // 在 VLCQ mappings 字符串前插入 N 个 ';'（每个 ';' 代表跳过一个生成行），
            // 使调试器能正确将生成行号映射回原始代码行。
            const HEADER_LINES = sourceType === 'module' ? 2 : 1;   // script=1(smap头), module=2(smap头+const绑定)

            if (rawVlcqMap) {
                vlcqSourceMap = {
                    ...rawVlcqMap,
                    file:    options.instCodeFileName ?? undefined,
                    // 在 mappings 前插入 HEADER_LINES 个 ';' 补偿行偏移
                    mappings: ';'.repeat(HEADER_LINES) + (rawVlcqMap.mappings ?? ''),
                };
            }
        } catch (ex) {
            const fileName = options.origCodeFileName ?? '(unknown)';
            const wrappedErr = new Error(
                `[jalangi] Failed to instrument ${fileName}: ${ex.message}`
            );
            wrappedErr.cause = ex;
            /** @type {any} */ (wrappedErr).origCodeFileName = fileName;
            throw wrappedErr;
        }
    }

    // 构建 source map 信息
    const sourceInfo = IID.getSourceInfo();
    if (url)         sourceInfo.url      = url;
    if (isEval) {
        sourceInfo.evalSid = _sid;
        sourceInfo.evalIid = thisIid;
    }
    if (inlineSource) sourceInfo.code = options.code;

    const sourceMapString = JSON.stringify(sourceInfo);

    // 精简版 source map 头（不含逐行位置，只有元数据）
    const tmp = {
        nBranches:                sourceInfo.nBranches,
        originalCodeFileName:     sourceInfo.originalCodeFileName,
        instrumentedCodeFileName: sourceInfo.instrumentedCodeFileName,
    };
    if (url)    tmp.url = url;
    if (isEval) { tmp.evalSid = sourceInfo.evalSid; tmp.evalIid = thisIid; }

    // 用 smap[sid] 存储各脚本的 source map，避免多脚本并发加载时互相覆盖。
    // 旧的 J$.iids 保留为最近一次的快照（向后兼容）。
    const smapKey = JSON.stringify(sourceInfo.instrumentedCodeFileName ?? 'unknown');
    const jv = _jalangiVar;
    let instCode = options.inlineSourceMap
        ? `(globalThis.${jv}=globalThis.${jv}||{});${jv}.smap=${jv}.smap||{};${jv}.smap[${smapKey}]=${sourceMapString};${jv}.iids=${sourceMapString};\n${code}`
        : `(globalThis.${jv}=globalThis.${jv}||{});${jv}.smap=${jv}.smap||{};${jv}.smap[${smapKey}]=${JSON.stringify(tmp)};${jv}.iids=${JSON.stringify(tmp)};\n${code}`;

    // post-hook
    if (isEval && _analysis?.instrumentCode) {
        const aret = _analysis.instrumentCode(/** @type {number} */ (thisIid), instCode, newAst, isDirect);
        if (aret) instCode = aret.result;
    }

    return {
        code:            instCode,
        instAST:         newAst,
        sourceMapObject: sourceInfo,
        sourceMapString,
        // 标准 VLCQ source map（v3 格式），可直接写为 <file>.js.map，
        // 供浏览器 DevTools / VS Code 调试器定位插桩后代码对应的原始代码位置。
        // 仅在代码被实际插桩（非 skip / DO NOT INSTRUMENT）时有值，否则为 null。
        vlcqSourceMap,
    };
}

/**
 * eval 插桩的快捷包装（始终内联 source map 和原始代码）。
 */
function instrumentEvalCode(code, iid, isDirect) {
    return instrumentCode({
        code,
        thisIid:         iid,
        isEval:          true,
        inlineSourceMap: true,
        inlineSource:    true,
        isDirect,
    }).code;
}

export { init, instrumentCode, instrumentEvalCode, analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig };
