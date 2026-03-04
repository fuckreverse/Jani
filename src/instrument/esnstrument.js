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
import _babelGenerate   from '@babel/generator';
// @babel/generator 是 CJS 模块，ESM 导入需取 .default
const babelGenerate = _babelGenerate.default ?? _babelGenerate;

import { JALANGI_VAR }     from '../Constants.js';
import { CONTEXT, transformAst, setJalangiVar as setAstUtilJalangiVar } from './astUtil.js';
import { addScopes, resetScopeCounter } from './scope.js';
import { analyzeDefUse }  from './dataflow.js';  // TODO-9/10: 静态 def-use 分析
import * as IID            from './iid.js';
import * as W              from './wrappers.js';
// ArrowFunctionExpression 专用初始化（仅做 syncDefuns，不注入 J$.Fe）
const { instrumentArrowFunctionBody } = W;

// ─── Config 注入（由宿主在使用前调用 init() 设置）──────────────────────────────
let _config = null;
let _analysis = null;   // 当前分析对象（J$.analysis 等价物）
let _sid = null;        // 当前脚本 ID
let _jalangiVar = JALANGI_VAR;  // 当前沙盒变量名（可自定义）

/**
 * 初始化插桩器。必须在第一次调用 instrumentCode 之前调用。
 *
 * @param {object} config      - Jalangi Config 对象
 * @param {object} [analysis]  - 当前 analysis 对象（可选，用于 pre/post hook）
 * @param {*}      [sid]       - 当前脚本 ID（用于 eval 的 source map）
 * @param {string} [jalangiVar] - 沙盒变量名（默认 'J$'）。
 *                                指定其他名称可避免与被分析页面已有的 J$ 变量冲突。
 */
function init(config, analysis, sid, jalangiVar) {
    if (config == null || typeof config !== 'object') {
        throw new TypeError('[jalangi] init(): config must be a non-null object');
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

// ─── visitor：作用域绑定（Pre）────────────────────────────────────────────────

const visitorRRPre = {
    Program:                 W.setScope,
    FunctionDeclaration:     W.setScope,
    FunctionExpression:      W.setScope,
    // ArrowFunctionExpression 在 addScopes 阶段已分配 .scope（含参数注册），
    // 必须在这里同步更新 _scope，否则遍历箭头函数体内的标识符时
    // _scope 仍指向父作用域，导致箭头参数和局部变量被错误识别为全局变量。
    ArrowFunctionExpression: W.setScope,
    // Babel AST：ClassMethod 节点同时含 params 和 body，在 addScopes 阶段
    // 已创建独立作用域（handleFun），需要在此同步更新 _scope。
    ClassMethod:             W.setScope,
    CatchClause:             W.setScope,
};

// ─── visitor：主插桩变换（Post）──────────────────────────────────────────────

const visitorRRPost = {
    // Babel AST 将每种字面量表示为独立节点类型：
    // NumericLiteral、StringLiteral、BooleanLiteral、NullLiteral、RegExpLiteral、BigIntLiteral

    NumericLiteral(node, context) {
        if (context !== CONTEXT.RHS) return node;
        return W.wrapLiteral(node, node, N_LOG_NUMBER_LIT);
    },

    StringLiteral(node, context) {
        if (context !== CONTEXT.RHS) return node;
        return W.wrapLiteral(node, node, N_LOG_STRING_LIT);
    },

    BooleanLiteral(node, context) {
        if (context !== CONTEXT.RHS) return node;
        return W.wrapLiteral(node, node, N_LOG_BOOLEAN_LIT);
    },

    NullLiteral(node, context) {
        if (context !== CONTEXT.RHS) return node;
        return W.wrapLiteral(node, node, N_LOG_NULL_LIT);
    },

    RegExpLiteral(node, context) {
        if (context !== CONTEXT.RHS) return node;
        return W.wrapLiteral(node, node, N_LOG_REGEXP_LIT);
    },

    BigIntLiteral(node, context) {
        // BigInt 字面量（如 42n）：暂不插桩，返回原节点
        return node;
    },

    Program(node) {
        const ret = W.instrumentScriptEntryExit(
            node, node.body,
            IID.getInstCodeFileName(),
            IID.getOrigCodeFileName()
        );
        node.body = ret;
        W.popScope();
        return node;
    },

    VariableDeclaration(node) {
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
                let init = W.wrapWrite(def.init, W.createLiteralAst(def.id.name), def.init, def.id,
                    false, W.getScope().isGlobal(def.id.name), true);
                init = W.wrapWithX1(def.init, init);
                def.init = init;
            }
            return def;
        });
        return node;
    },

    NewExpression(node) {
        const ret = {
            type:      'CallExpression',
            callee:    W.instrumentCall(node, true),
            arguments: node.arguments,
        };
        W.transferLoc(ret, node);
        return ret;
    },

    CallExpression(node) {
        const isEval = node.callee.type === 'Identifier' && node.callee.name === 'eval';
        node.callee = W.instrumentCall(node, false);
        if (isEval) node.arguments = node.arguments.map(W.wrapEvalArg);
        return node;
    },

    AssignmentExpression(node) {
        return node.operator === '='
            ? W.instrumentStore(node, false)
            : W.instrumentLoadModStore(node);
    },

    UpdateExpression(node) {
        let ret = W.instrumentPreIncDec(node);
        if (!node.prefix) ret = W.adjustIncDec(node.operator, ret);
        return ret;
    },

    FunctionExpression(node, context) {
        node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
        // getter / setter / class 方法不作为独立字面量包装
        const ret = (context === CONTEXT.GETTER || context === CONTEXT.SETTER || context === CONTEXT.METHOD)
            ? node
            : W.wrapLiteral(node, node, N_LOG_FUNCTION_LIT);
        W.popScope();
        return ret;
    },

    FunctionDeclaration(node) {
        node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
        W.popScope();
        return node;
    },

    /**
     * ClassMethod 节点直接携带 params 和 body（相当于 MethodDefinition 的函数体）。
     * 在 body.body 中注入 J$.Fe 入口/出口钩子；方法定义本身不包装为字面量。
     */
    ClassMethod(node, context) {
        node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
        W.popScope();
        return node;
    },

    ArrowFunctionExpression(node) {
        // 箭头函数没有独立的 `arguments` / `this` / `callee`，
        // 不注入 J$.Fe / J$.Fr 入口出口钩子，但需要：
        //  1. 对块体注入参数/var 同步语句（syncDefuns）
        //  2. 恢复 _scope 到父作用域（popScope）
        //  3. 将节点包装为字面量（J$.T），与 FunctionExpression 一致
        instrumentArrowFunctionBody(node);
        const ret = W.wrapLiteral(node, node, N_LOG_FUNCTION_LIT);
        W.popScope();
        return ret;
    },

    ObjectExpression: (node) => W.wrapLiteral(node, node, N_LOG_OBJECT_LIT),
    ArrayExpression:  (node) => W.wrapLiteral(node, node, N_LOG_ARRAY_LIT),

    ThisExpression: (node) =>
        W.wrapRead(node, W.createLiteralAst('this'), node, false, false, false),

    Identifier(node, context) {
        if (context === CONTEXT.RHS)    return W.instrumentLoad(node, false);
        if (context === CONTEXT.TYPEOF) return W.instrumentLoad(node, true);
        return node;
    },

    MemberExpression(node, context) {
        if (context === CONTEXT.RHS) return W.instrumentLoad(node, false);
        return node;
    },

    // OptionalMemberExpression（a?.b）：在 RHS 上下文中注入 J$.G 属性读取钩子。
    OptionalMemberExpression(node, context) {
        if (context === CONTEXT.RHS) return W.instrumentLoad(node, false);
        return node;
    },

    // OptionalCallExpression（a?.()）：注入 J$.M / J$.F 调用钩子。
    OptionalCallExpression(node) {
        node.callee = W.instrumentCall(node, false);
        return node;
    },

    SequenceExpression(node) {
        const last = node.expressions.length - 1;
        for (let i = 0; i < last; i++) {
            node.expressions[i] = W.wrapWithX1(node.expressions[i], node.expressions[i]);
        }
        return node;
    },

    ForInStatement(node) {
        node.right = W.wrapHash(node.right, node.right);
        return W.wrapForIn(node, node.left, node.right, node.body);
    },

    CatchClause(node) {
        // ES2019+: optional catch binding 时 node.param 为 null，跳过包装
        if (node.param?.type === 'Identifier') {
            W.wrapCatchClause(node, node.body.body, node.param.name);
        }
        W.popScope();
        return node;
    },

    ReturnStatement(node) {
        const ret = W.wrapReturn(node, node.argument);
        node.argument = W.wrapWithX1(node, ret);
        return node;
    },

    ThrowStatement(node) {
        const ret = W.wrapThrow(node, node.argument);
        node.argument = W.wrapWithX1(node, ret);
        return node;
    },

    ExpressionStatement(node) {
        node.expression = W.wrapWithX1(node, node.expression);
        return node;
    },
};

// ─── visitor：运算符插桩（Post）──────────────────────────────────────────────

function funCond(node) {
    node.test   = W.wrapConditional(node.test, node.test);
    node.test   = W.wrapWithX1(node, node.test);
    node.init   = W.wrapWithX1(node, node.init);
    node.update = W.wrapWithX1(node, node.update);
    return node;
}

const visitorOps = {
    Program(node) {
        node.body = W.wrapScriptBodyWithTryCatch(node, node.body);
        return node;
    },

    BinaryExpression: (node) =>
        W.wrapBinaryOp(node, node.left, node.right, node.operator),

    LogicalExpression(node) {
        if (node.operator === '&&') return W.wrapLogicalAnd(node, node.left, node.right);
        if (node.operator === '||') return W.wrapLogicalOr(node, node.left, node.right);
        if (node.operator === '??') return W.wrapLogicalNullish(node, node.left, node.right);
        return node;
    },

    UnaryExpression(node) {
        if (node.operator === 'void') return node;
        if (node.operator === 'delete') {
            if (node.argument.object) {
                return W.wrapBinaryOp(node, node.argument.object,
                    W.getPropertyAsAst(node.argument), node.operator, node.argument.computed);
            }
            return node;
        }
        return W.wrapUnaryOp(node, node.argument, node.operator);
    },

    SwitchStatement(node) {
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
        return node;
    },

    FunctionExpression(node) {
        // Guard: generator/async FunctionExpression 不应进入 wrapFunBodyWithTryCatch
        // wrapFunBodyWithTryCatch 内部也有相同 guard，此处提前拦截提供更清晰的调用栈
        if (node.generator || node.async) return node;
        node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
        return node;
    },

    FunctionDeclaration(node) {
        // Guard: generator/async FunctionDeclaration 不应进入 wrapFunBodyWithTryCatch
        if (node.generator || node.async) return node;
        node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
        return node;
    },

    WithStatement(node) {
        // TODO-2: 标记当前作用域使用了 with
        W.getScope()?.addWith();
        node.object = W.wrapWith(node.object);
        return node;
    },

    ConditionalExpression: funCond,
    IfStatement:           funCond,
    WhileStatement:        funCond,
    DoWhileStatement:      funCond,
    ForStatement:          funCond,
};

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
    for (const key of Object.keys(ast)) {
        if (key === 'scope') continue;
        const child = ast[key];
        if (child && typeof child === 'object') {
            hoistFunctionDeclaration(child, hoistedFunctions);
        }
    }
    return ast;
}

// ─── AST 转换主流程 ────────────────────────────────────────────────────────────

/**
 * 解析代码字符串，返回 Program 节点。
 * @babel/parser 返回 { type:'File', program: Program }，各 visitor 遍历 Program 节点。
 */
function babelParse(code, sourceType) {
    const file = babelParser.parse(code, {
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
    return file.program;
}

function transformString(code, visitorsPost, visitorsPre, sourceType) {
    const newAst = babelParse(code, sourceType);
    addScopes(newAst);

    // TODO-9/10: Pass 0 — 静态 def-use 分析，生成插桩决策表
    // 分析结果注入 wrappers 模块，后续 instrumentLoad 查表决定插桩级别
    const instrDecisions = analyzeDefUse(newAst);
    W.setInstrDecisions(instrDecisions);

    for (let i = 0; i < visitorsPost.length; i++) {
        transformAst(newAst, visitorsPost[i], visitorsPre[i], CONTEXT.RHS);
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
 *   isEval:           boolean,   // 是否是 eval 动态代码
 *   code:             string,    // 要插桩的代码
 *   thisIid:          number,    // eval 时的调用点 IID
 *   origCodeFileName: string,    // 原始文件名（用于 source map）
 *   instCodeFileName: string,    // 插桩后文件名
 *   inlineSourceMap:  boolean,   // 是否内联完整 source map
 *   inlineSource:     boolean,   // 是否内联原始源代码
 *   url:              string,    // 脚本的 URL（可选）
 *   isDirect:         boolean,   // eval 是否是直接调用
 *   sourceType:       string,    // 'script'（默认）或 'module'
 * }} options
 *
 * @return {{
 *   code:            string,
 *   instAST:         object,
 *   sourceMapObject: object,
 *   sourceMapString: string
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
        isDirect,
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
        const aret = _analysis.instrumentCodePre(thisIid, code, isDirect);
        if (aret) { code = aret.code; skip = aret.skip; }
    }

    let newAst;
    if (!skip && typeof code === 'string' && !code.includes(NO_INSTR)) {
        try {
            if (_config?.ENABLE_SAMPLING) {
                newAst = transformString(code,
                    [visitorCloneBodyPre, visitorRRPost, visitorOps, visitorMergeBodyPre],
                    [undefined,           visitorRRPre,  undefined,  undefined],
                    sourceType);
            } else {
                newAst = transformString(code,
                    [visitorRRPost, visitorOps],
                    [visitorRRPre,  undefined],
                    sourceType);
            }

            newAst = hoistFunctionDeclaration(newAst, []);

                    const newCode = babelGenerate(newAst).code;
            // 用 IIFE 将插桩代码包裹：沙盒变量（_jalangiVar，默认 'J$'）作为闭包参数传入，
            // 而非依赖全局访问，彻底消除插桩标识符与被分析代码自身变量名的冲突风险。
            // module 模式下 ESM 已自带私有作用域，改用 const 局部绑定即可。
            const jv = _jalangiVar;
            if (sourceType === 'module') {
                code = `const ${jv} = globalThis.${jv};\n${newCode}\n${NO_INSTR}\n`;
            } else {
                code = `(function(${jv}){\n${newCode}\n}(typeof ${jv}!=='undefined'?${jv}:{}));\n${NO_INSTR}\n`;
            }
        } catch (ex) {
            const fileName = options.origCodeFileName ?? '(unknown)';
            const wrappedErr = new Error(
                `[jalangi] Failed to instrument ${fileName}: ${ex.message}`
            );
            wrappedErr.cause = ex;
            wrappedErr.origCodeFileName = fileName;
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
        const aret = _analysis.instrumentCode(thisIid, instCode, newAst, isDirect);
        if (aret) instCode = aret.result;
    }

    return {
        code:            instCode,
        instAST:         newAst,
        sourceMapObject: sourceInfo,
        sourceMapString,
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

export { init, instrumentCode, instrumentEvalCode };
