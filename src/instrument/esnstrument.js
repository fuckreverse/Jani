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
// @ts-ignore — @babel/generator 是 CJS 模块，ESM 导入需取 .default
import _babelGenerate   from '@babel/generator';
const babelGenerate = /** @type {any} */ (_babelGenerate).default ?? _babelGenerate;
// @ts-ignore — @babel/traverse 是 CJS 模块，ESM 导入需取 .default
import _babelTraverse from '@babel/traverse';
const babelTraverse = /** @type {any} */ (_babelTraverse).default ?? _babelTraverse;

import { JALANGI_VAR }     from '../Constants.js';
import { CONTEXT, transformAst, setJalangiVar as setAstUtilJalangiVar } from './astUtil.js';
import { addScopes, resetScopeCounter } from './scope.js';
import { analyzeDefUse, analyzeStmtUse }  from './dataflow.js';
import * as IID            from './iid.js';
import * as W              from './wrappers.js';
import { buildConfigFromPlugins } from './pluginAnalyzer.js';
const { instrumentArrowFunctionBody } = W;

// ─── Config 注入（由宿主在使用前调用 init() 设置）──────────────────────────────
/** @type {import('../types.js').JalangiConfig | null} */
let _config = null;
/** @type {import('../types.js').IAnalysisPlugin | null} */
let _analysis = null;
let _sid = null;
let _jalangiVar = JALANGI_VAR;

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
        type:  'J$.AST.REGEXP',
        value: this.source,
        flags: this.flags,  // 使用 this.flags 完整序列化所有标志（d/g/i/m/s/u/v/y）
    };
}

function JSONStringifyHandler(key, value) {
    if (key === 'scope')         return undefined;
    if (value instanceof RegExp) return regExpToJSON.call(value);
    return value;
}

function JSONParseHandler(key, value) {
    if (typeof value === 'object' && value?.type === 'J$.AST.REGEXP') {
        return RegExp(value.value, value.flags ?? '');
    }
    return value;
}

const cloneAst = (src) =>
    JSON.parse(JSON.stringify(src, JSONStringifyHandler), JSONParseHandler);

// ─── 通用 CONTEXT 推断（从 Babel path 推断 astUtil.js 的 CONTEXT 枚举值）────────

/**
 * 根据 Babel path（包含父节点关系）推断当前节点所处的语义上下文（CONTEXT 枚举值）。
 *
 * @param {import('@babel/traverse').NodePath} path
 * @returns {number} CONTEXT 枚举值
 */
function getContext(path) {
    const parent = /** @type {any} */ (path.parent);
    if (!parent) return CONTEXT.RHS;
    const pt = /** @type {string} */ (parent.type);
    // path.key：当节点直接位于父节点的具名属性时为属性名；当节点位于数组中时为数字索引。
    // path.listKey：当节点位于数组中时为该数组的属性名；当节点直接位于具名属性时为 undefined。
    const key    = path.listKey ?? path.key;

    if (
        (pt === 'ImportDeclaration'       && key === 'source') ||
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
        (pt === 'ClassProperty'             && key === 'key' && !parent.computed) ||
        (pt === 'ClassPrivateProperty'      && key === 'key') ||
        (pt === 'PrivateName'               && key === 'id') ||
        // MetaProperty（new.target、import.meta）的 meta 和 property 是保留字 Identifier，不应被插桩
        (pt === 'MetaProperty'              && (key === 'meta' || key === 'property')) ||
        // ObjectMethod.key（如 [Symbol.iterator](){}）：@babel/types 不允许 key 是 CallExpression
        (pt === 'ObjectMethod'              && key === 'key')
    ) {
        return CONTEXT.IGNORE;
    }

    // typeof 操作数（Identifier）
    if (pt === 'UnaryExpression' && parent.operator === 'typeof' && key === 'argument'
            && path.node.type === 'Identifier') {
        return CONTEXT.TYPEOF;
    }

    // 函数参数（params 数组中的每个参数节点）不插桩
    if (
        ((pt === 'FunctionExpression' || pt === 'FunctionDeclaration' || pt === 'ArrowFunctionExpression')
            && key === 'params') ||
        (pt === 'ClassMethod' && key === 'params')
    ) {
        return CONTEXT.IGNORE;
    }

    // ObjectExpression 中非计算属性的 key 不插桩
    if (pt === 'ObjectProperty' && key === 'key' && !parent.computed) {
        return CONTEXT.IGNORE;
    }
    // ObjectPattern 中 ObjectProperty.value 是绑定目标，不插桩
    if (pt === 'ObjectProperty' && key === 'value') {
        const grandParent = path.parentPath?.parent;
        if (grandParent?.type === 'ObjectPattern') {
            return CONTEXT.IGNORE;
        }
    }
    // ArrayPattern.elements 中的元素是绑定目标，不插桩
    if (pt === 'ArrayPattern' && key === 'elements') {
        return CONTEXT.IGNORE;
    }

    // getter / setter / method 上下文
    if (pt === 'ObjectProperty' && key === 'value' && parent.kind === 'get') {
        return CONTEXT.GETTER;
    }
    if (pt === 'ObjectProperty' && key === 'value' && parent.kind === 'set') {
        return CONTEXT.SETTER;
    }
    if (pt === 'ObjectMethod' && key === 'body') {
        if (parent.kind === 'get') return CONTEXT.GETTER;
        if (parent.kind === 'set') return CONTEXT.SETTER;
        return CONTEXT.METHOD;
    }
    if (pt === 'ClassMethod' && key === 'body') {
        if (parent.kind === 'get') return CONTEXT.GETTER;
        if (parent.kind === 'set') return CONTEXT.SETTER;
        return CONTEXT.METHOD;
    }
    if (pt === 'MethodDefinition' && key === 'value') {
        return CONTEXT.METHOD;
    }

    return CONTEXT.RHS;
}

// ─── visitor：克隆函数体（用于 ENABLE_SAMPLING 模式）──────────────────────────

const visitorCloneBodyPre = {
    FunctionExpression(node)  { node.bodyOrig = cloneAst(node.body); return node; },
    FunctionDeclaration(node) { node.bodyOrig = cloneAst(node.body); return node; },
};

// ─── visitor：合并采样函数体（用于 ENABLE_SAMPLING 模式）────────────────────

function mergeBodies(node) {
    // 只处理经过 visitorCloneBodyPre 存入了 bodyOrig 的函数节点
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
                property: { type: 'Identifier', name: 'Sp' },
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
    // 先保存插桩后的语句列表，避免 alternate: node.body 与 node.body.body 赋值之间的循环引用
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
 * 替换当前 path 所指节点为 newNode，并打上 __j_instrumented 标记，
 * 防止 @babel/traverse 在 replaceWith 后重新遍历新节点导致无限循环。
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
 * 使用单一 babelTraverse 完成所有插桩变换。
 *
 * 设计原则：
 *  - 全局 enter 拦截：被 replaceAndMark 标记为 __j_instrumented 的节点，在 enter
 *    时立即 skip 整个子树，防止 replaceWith 触发重新遍历导致无限循环。
 *  - 函数节点在 exit 里按顺序完成：
 *      1. instrumentFunctionEntryExit（注入 J$.Fe/J$.Fr）
 *      2. wrapFunBodyWithTryCatch（添加 try-catch 包裹）
 *      3. wrapLiteral（包装为 J$.T 字面量钩子）
 *  - Program 节点在 exit 里：instrumentScriptEntryExit → wrapScriptBodyWithTryCatch
 *
 * @param {object} file - Babel File 节点
 */
function runInstrumentPass(file) {
    babelTraverse(file, {
        // 全局 enter：跳过已被 replaceAndMark 标记的节点子树
        enter(path) {
            if (path.node.__j_instrumented) path.skip();
        },

        Program: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                const ret = W.instrumentScriptEntryExit(
                    node, node.body,
                    IID.getInstCodeFileName(),
                    IID.getOrigCodeFileName()
                );
                node.body = ret;
                W.popScope();
                node.body = W.wrapScriptBodyWithTryCatch(node, node.body);
            },
        },

        FunctionDeclaration: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
                W.popScope();
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
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
                const ctx = getContext(path);
                const shouldWrapAsLiteral = !(ctx === CONTEXT.GETTER || ctx === CONTEXT.SETTER || ctx === CONTEXT.METHOD);
                W.popScope();
                if (!node.generator && !node.async && !node.__j_probe) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
                const ret = shouldWrapAsLiteral ? W.wrapLiteral(node, node, N_LOG_FUNCTION_LIT) : node;
                if (ret !== node) replaceAndMark(path, ret);
            },
        },

        ArrowFunctionExpression: {
            enter(path) { W.setScope(path.node); },
            exit(path) {
                const node = path.node;
                // 箭头函数没有独立的 arguments / this / callee，不注入 J$.Fe/J$.Fr，
                // 也不添加 try-catch 包裹（会改变表达式体箭头函数的 return 语义）。
                // 代价：箭头函数内的异常不会被 J$.Ex 捕获，分析插件不会收到 functionEnter/Exit 回调。
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
                // 子类 constructor 在 super() 之前不能访问 this，需要跳过 this 参数
                const isDerivedConstructor = node.kind === 'constructor'
                    && path.parentPath?.parent?.superClass != null;
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body, isDerivedConstructor);
                W.popScope();
                if (!node.generator && !node.async) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
            },
        },

        ObjectMethod: {
            enter(path) {
                W.setScope(path.node);
                // computed key（如 [Symbol.iterator]）不能被插桩（@babel/types 不允许 key 是 CallExpression）
                if (path.node.computed && path.node.key) {
                    path.node.key.__j_instrumented = true;
                }
            },
            exit(path) {
                const node = path.node;
                node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
                W.popScope();
                if (!node.generator && !node.async) {
                    node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
                }
            },
        },

        // ClassDeclaration 不为自身创建独立 scope，有 node.scope 时（未来扩展）才处理
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
                // ES2019+: optional catch binding 时 node.param 为 null
                if (node.param?.type === 'Identifier') {
                    W.wrapCatchClause(node, node.body.body, node.param.name);
                }
                W.popScope();
            },
        },

        // ── 字面量插桩 ──────────────────────────────────────────────────────────

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
                    // 解构声明（ObjectPattern / ArrayPattern）暂不插桩写入
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
                const calleeType = node.callee?.type;
                if ((calleeType === 'MemberExpression' || calleeType === 'OptionalMemberExpression')
                        && node.callee.object?.name === _jalangiVar) return;
                // super() 调用的 callee 是 Super 节点（关键字），不能传入 J$.F()
                if (calleeType === 'Super') return;
                // 私有方法调用（this.#method()）不支持 bracket notation，跳过插桩
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
                // 私有字段赋值（this.#n = val）跳过插桩，bracket notation 无法访问私有字段
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
                // 私有字段（this.#n++）不支持 bracket notation，跳过插桩
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
                // 私有字段（this.#n）不支持 bracket notation，J$.G 会返回 undefined
                if (path.node.property?.type === 'PrivateName') return;
                const ret = W.instrumentLoad(path.node, false);
                if (ret !== path.node) replaceAndMark(path, ret);
            },
        },

        // OptionalMemberExpression（a?.b）：在 RHS 上下文中注入 J$.G 属性读取钩子
        OptionalMemberExpression: {
            exit(path) {
                if (ignoreSubAst(path.node)) return;
                if (getContext(path) !== CONTEXT.RHS) return;
                const ret = W.instrumentLoad(path.node, false);
                if (ret !== path.node) replaceAndMark(path, ret);
            },
        },

        // OptionalCallExpression（a?.()）：注入 J$.M / J$.F 调用钩子
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
                    // wrapForIn 可能返回带有 _jalangiTmpVarDecl 的局部变量声明需前置插入
                    const tmpVarDecl = ret._jalangiTmpVarDecl;
                    delete ret._jalangiTmpVarDecl;
                    if (tmpVarDecl) {
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
                // 方案F：从静态分析结果获取 use-set
                const useInfo = W.getStmtUse(node);
                if (useInfo) {
                    node.expression = W.wrapWithX1(node, node.expression, useInfo.names, useInfo.scopes);
                } else {
                    node.expression = W.wrapWithX1(node, node.expression);
                }
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

        // ── 运算符插桩 ────────────────────────────────────────────────────────

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

    // 递归处理子节点（显式区分数组和对象，避免歧义）
    for (const key of Object.keys(ast)) {
        if (key === 'scope') continue;
        const child = ast[key];
        if (!child || typeof child !== 'object') continue;
        if (Array.isArray(child)) {
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
 * @babel/traverse 需要 File 节点作为根节点。
 */
function babelParse(code, sourceType) {
    return babelParser.parse(code, {
        sourceType,
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
        ranges: false,
    });
}

function transformString(code, sourceType, enableSampling) {
    const file    = babelParse(code, sourceType);
    const newAst  = file.program;

    addScopes(file, _jalangiVar);

    // Pass 0a：静态 def-use 分析，生成插桩决策表（依赖 addScopes 附加的 .scope 字段）
    const instrDecisions = analyzeDefUse(newAst);
    W.setInstrDecisions(instrDecisions);

    // Pass 0b：语句级 use-set 分析（方案F）
    const stmtUseMap = analyzeStmtUse(newAst, _jalangiVar);
    W.setStmtUseMap(stmtUseMap);

    if (enableSampling) {
        transformAst(newAst, visitorCloneBodyPre, undefined, CONTEXT.RHS);
    }

    runInstrumentPass(file);

    if (enableSampling) {
        transformAst(newAst, visitorMergeBodyPre, undefined, CONTEXT.RHS);
    }

    W.setInstrDecisions(null);
    W.setStmtUseMap(null);

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
    if (_config === null) {
        throw new Error(
            '[jalangi] instrumentCode() called before init(). ' +
            'You must call init(config) first to provide a Config object.'
        );
    }
    if (options == null || typeof options !== 'object') {
        throw new TypeError(
            `[jalangi] instrumentCode(): options must be a non-null object, got ${typeof options}`
        );
    }
    if (typeof options.code !== 'string') {
        throw new TypeError(
            `[jalangi] instrumentCode(): options.code must be a string, got ${typeof options.code}. ` +
            `If you want to skip instrumentation, pass an empty string '' instead.`
        );
    }
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

    IID.initialize(isEval, options.instCodeFileName, options.origCodeFileName);
    W.resetPerFile();
    resetScopeCounter();

    let skip = false;
    if (_analysis?.instrumentCodePre) {
        const aret = _analysis.instrumentCodePre(/** @type {number} */ (thisIid), code, isDirect);
        if (aret) { code = /** @type {string} */ (aret.code); skip = aret.skip; }
    }

    let newAst;
    let vlcqSourceMap = null;

    if (!skip && typeof code === 'string' && !code.includes(NO_INSTR)) {
        try {
            newAst = transformString(code, sourceType, !!_config?.ENABLE_SAMPLING);

            newAst = hoistFunctionDeclaration(newAst, []);

            const genResult = babelGenerate(newAst, {
                sourceMaps:   true,
                sourceFileName: options.origCodeFileName ?? 'unknown',
            });
            const newCode    = genResult.code;
            const rawVlcqMap = genResult.map;

            const jv = _jalangiVar;
            if (sourceType === 'module') {
                // module 模式：1 行 const 绑定头
                code = `const ${jv} = globalThis.${jv};\n${newCode}\n${NO_INSTR}\n`;
            } else {
                // script 模式：直接输出，var 可正常提升到全局作用域
                code = `${newCode}\n${NO_INSTR}\n`;
            }

            // VLCQ source map 行偏移补偿：
            //   script 模式 = 1 行（smap 注入头）
            //   module 模式 = 2 行（smap 注入头 + const 绑定）
            const HEADER_LINES = sourceType === 'module' ? 2 : 1;

            if (rawVlcqMap) {
                vlcqSourceMap = {
                    ...rawVlcqMap,
                    file:    options.instCodeFileName ?? undefined,
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

    const sourceInfo = IID.getSourceInfo();
    if (url)         sourceInfo.url      = url;
    if (isEval) {
        sourceInfo.evalSid = _sid;
        sourceInfo.evalIid = thisIid;
    }
    if (inlineSource) sourceInfo.code = options.code;

    const sourceMapString = JSON.stringify(sourceInfo);

    const tmp = {
        nBranches:                sourceInfo.nBranches,
        originalCodeFileName:     sourceInfo.originalCodeFileName,
        instrumentedCodeFileName: sourceInfo.instrumentedCodeFileName,
    };
    if (url)    tmp.url = url;
    if (isEval) { tmp.evalSid = sourceInfo.evalSid; tmp.evalIid = thisIid; }

    // 用 smap[sid] 存储各脚本的 source map，避免多脚本并发加载时互相覆盖
    const smapKey = JSON.stringify(sourceInfo.instrumentedCodeFileName ?? 'unknown');
    const jv = _jalangiVar;
    let instCode = options.inlineSourceMap
        ? `(globalThis.${jv}=globalThis.${jv}||{});${jv}.smap=${jv}.smap||{};${jv}.smap[${smapKey}]=${sourceMapString};${jv}.iids=${sourceMapString};\n${code}`
        : `(globalThis.${jv}=globalThis.${jv}||{});${jv}.smap=${jv}.smap||{};${jv}.smap[${smapKey}]=${JSON.stringify(tmp)};${jv}.iids=${JSON.stringify(tmp)};\n${code}`;

    if (isEval && _analysis?.instrumentCode) {
        const aret = _analysis.instrumentCode(/** @type {number} */ (thisIid), instCode, newAst, isDirect);
        if (aret) instCode = aret.result;
    }

    return {
        code:            instCode,
        instAST:         newAst,
        sourceMapObject: sourceInfo,
        sourceMapString,
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

// pluginAnalyzer 工具函数（analyzePluginHooks/buildConfigFromHooks/buildConfigFromPlugins/fullConfig）
// 请直接从 './pluginAnalyzer.js' 导入，不在此再导出。
export { init, instrumentCode, instrumentEvalCode };
