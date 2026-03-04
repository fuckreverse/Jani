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
 * AST 包装（wrap）函数库。
 *
 * 负责将插桩钩子注入到各类 AST 节点中。
 * 核心优化：replaceInExpr / replaceInStatement 使用模板缓存，
 * 避免每次调用都重新执行 @babel/parser 解析。
 */

import * as babelParser from '@babel/parser';
import { JALANGI_VAR, HOP } from '../Constants.js';
import * as IID from './iid.js';

// ─── Config 引用（由宿主调用 init(config) 注入，插桩期间只读）────────────────────
// Config 对象通过 init() 参数注入，避免模块间循环依赖。
let Config;

// ─── 运行时变量名（由 init() 根据 jalangiVar 动态生成）────────────────────────
// 默认值为 'J$'，可通过 init(config, jalangiVar) 覆盖。
let _jalangiVar = JALANGI_VAR;  // 当前使用的沙盒变量名（如 'J$' 或 '__j123'）

/** 模板字符串 → 缓存的 AST body 数组（去掉 loc/start/end）。变量名改变时由 _rebuildNames 清空 */
const _templateCache = new Map();

let RP;                         // 占位符前缀，如 'J$_'
let logFunctionEnterFunName;
let logFunctionReturnFunName;
let logFunCallFunName;
let logMethodCallFunName;
let logAssignFunName;
let logPutFieldFunName;
let logGetFieldFunName;
let logScriptEntryFunName;
let logScriptExitFunName;
let logReadFunName;
let logWriteFunName;
let logIFunName;
let logHashFunName;
let logLitFunName;
let logInitFunName;
let logReturnFunName;
let logThrowFunName;
let logReturnAggrFunName;
let logUncaughtExceptionFunName;
let logLastComputedFunName;
let logTmpVarName;
let logWithFunName;
let logBinaryOpFunName;
let logUnaryOpFunName;
let logConditionalFunName;
let logSwitchLeftFunName;
let logSwitchRightFunName;
let logLastFunName;
let logX1FunName;
let instrumentCodeFunName;
let logReadLightFunName;  // TODO-8: J$.Rl 轻量变量读取钩子

/** 用给定的沙盒变量名重新生成所有运行时函数名常量 */
function _rebuildNames(v) {
    _jalangiVar              = v;
    RP                       = `${v}_`;
    logFunctionEnterFunName  = `${v}.Fe`;
    logFunctionReturnFunName = `${v}.Fr`;
    logFunCallFunName        = `${v}.F`;
    logMethodCallFunName     = `${v}.M`;
    logAssignFunName         = `${v}.A`;
    logPutFieldFunName       = `${v}.P`;
    logGetFieldFunName       = `${v}.G`;
    logScriptEntryFunName    = `${v}.Se`;
    logScriptExitFunName     = `${v}.Sr`;
    logReadFunName           = `${v}.R`;
    logWriteFunName          = `${v}.W`;
    logIFunName              = `${v}.I`;
    logHashFunName           = `${v}.H`;
    logLitFunName            = `${v}.T`;
    logInitFunName           = `${v}.N`;
    logReturnFunName         = `${v}.Rt`;
    logThrowFunName          = `${v}.Th`;
    logReturnAggrFunName     = `${v}.Ra`;
    logUncaughtExceptionFunName = `${v}.Ex`;
    logLastComputedFunName   = `${v}.L`;
    logTmpVarName            = `${v}._tm_p`;
    logWithFunName           = `${v}.Wi`;
    logBinaryOpFunName       = `${v}.B`;
    logUnaryOpFunName        = `${v}.U`;
    logConditionalFunName    = `${v}.C`;
    logSwitchLeftFunName     = `${v}.C1`;
    logSwitchRightFunName    = `${v}.C2`;
    logLastFunName           = `${v}._`;
    logX1FunName             = `${v}.X1`;
    instrumentCodeFunName    = `${v}.instrumentEvalCode`;
    logReadLightFunName      = `${v}.Rl`;  // TODO-8: 轻量变量读取钩子
    // 模板缓存依赖占位符前缀，变量名变化时必须清空
    _templateCache.clear();
}

// 模块加载时用默认值初始化一次
_rebuildNames(JALANGI_VAR);

// ─── N_LOG_* 字面量类型常量 ────────────────────────────────────────────────────
// 这些整数常量在运行时传给 J$.T（wrapLiteral），用于标识字面量的具体类型。
// 旧版中存在的 N_LOG_FUNCTION_ENTER(4)、N_LOG_SCRIPT_ENTER(6)、N_LOG_GETFIELD(8)、
// N_LOG_RETURN(13)、N_LOG_READ(17)、N_LOG_HASH(19)、N_LOG_SPECIAL(20) 已不再使用，已删除。

const N_LOG_ARRAY_LIT       = 10;
const N_LOG_OBJECT_LIT      = 11;
const N_LOG_FUNCTION_LIT    = 12;
const N_LOG_REGEXP_LIT      = 14;
const N_LOG_STRING_LIT      = 21;
const N_LOG_NUMBER_LIT      = 22;
const N_LOG_BOOLEAN_LIT     = 23;
const N_LOG_UNDEFINED_LIT   = 24;
const N_LOG_NULL_LIT        = 25;

// ─── AST 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 断言 val 是一个合法的 AST 节点（非 null、非 undefined、且有 type 字段）。
 */
function assertAstNode(val, callerName) {
    if (val == null || typeof val.type !== 'string') {
        throw new Error(
            `[jalangi] ${callerName}: received invalid AST node: ${JSON.stringify(val)}`
        );
    }
}

/**
 * 创建 Babel 字面量节点：string → StringLiteral，number → NumericLiteral，以此类推。
 */
const createLiteralAst = (name) => {
    if (typeof name === 'string') {
        return { type: 'StringLiteral', value: name };
    } else if (typeof name === 'number') {
        return { type: 'NumericLiteral', value: name };
    } else if (typeof name === 'boolean') {
        return { type: 'BooleanLiteral', value: name };
    } else if (name === null) {
        return { type: 'NullLiteral' };
    }
    return { type: 'StringLiteral', value: String(name) };
};
const createIdentifierAst = (name) => ({ type: 'Identifier',  name  });

function transferLoc(toNode, fromNode) {
    if (fromNode.loc) toNode.loc = fromNode.loc;
    if (fromNode.raw) toNode.raw = fromNode.raw;
}

/**
 * 将可变数量的布尔参数编码为一个整数位掩码。
 * createBitPattern(true, false, true) → 0b101 = 5
 */
function createBitPattern(...flags) {
    return flags.reduce((acc, f) => (acc << 1) + (f ? 1 : 0), 0);
}

// ─── 模板缓存（核心优化）────────────────────────────────────────────────────────
//
// replaceInStatement / replaceInExpr 每次都接收一个代码模板字符串，
// 其中的占位符 J$_1, J$_2, ... 会被真实 AST 节点替换。
//
// 第一次解析时缓存去掉 loc 的纯结构 AST，后续深拷贝复用，省去重复 parse。
// _templateCache 已在模块顶部声明；变量名改变时由 _rebuildNames() 清空缓存。

/**
 * 深拷贝并替换 AST 中的占位符。
 *
 * 规则：
 *  1. Identifier 且名称以 RP 开头 → 替换为 args[N]
 *  2. BlockStatement.body 若展开后某元素是数组，则 flat 一层
 */
function deepCloneAndReplace(node, args) {
    if (node === null || typeof node !== 'object') return node;

    // 数组：逐元素处理，flat 一层（支持 BlockStatement body 展开）
    if (Array.isArray(node)) {
        const result = [];
        for (const item of node) {
            const replaced = deepCloneAndReplace(item, args);
            if (Array.isArray(replaced)) result.push(...replaced);
            else result.push(replaced);
        }
        return result;
    }

    // 占位符 Identifier: J$_N → args[N]
    if (node.type === 'Identifier' && node.name.startsWith(RP)) {
        return args[parseInt(node.name.slice(RP.length), 10)];
    }

    // BlockStatement：先递归，再检查展开约定
    if (node.type === 'BlockStatement') {
        const newBody = deepCloneAndReplace(node.body, args);
        if (newBody.length === 1
                && newBody[0]?.type === 'ExpressionStatement'
                && Array.isArray(newBody[0].expression)) {
            return { type: 'BlockStatement', body: newBody[0].expression };
        }
        return { type: 'BlockStatement', body: newBody };
    }

    // 普通节点：逐属性拷贝，跳过位置信息
    const obj = {};
    for (const key of Object.keys(node)) {
        if (key !== 'loc' && key !== 'start' && key !== 'end') {
            obj[key] = deepCloneAndReplace(node[key], args);
        }
    }
    return obj;
}

/**
 * 解析模板代码，返回 body 语句数组，并替换占位符。
 *
 * 调用约定：replaceInStatement(templateStr, arg1, arg2, ...)
 * 其中 templateStr 中的 J$_1, J$_2 … 会被 arg1, arg2 … 替换。
 */
function replaceInStatement(code, ...args) {
    let cached = _templateCache.get(code);
    if (!cached) {
        try {
            const file = babelParser.parse(code, {
                sourceType: 'script',
                plugins: [
                    'optionalChaining',
                    'nullishCoalescingOperator',
                    'logicalAssignment',
                ],
            });
            cached = JSON.parse(JSON.stringify(file.program.body));
            _templateCache.set(code, cached);
        } catch (e) {
            throw new Error(
                `[jalangi] replaceInStatement failed to parse template:\n  ${code}\n  Cause: ${e.message}`
            );
        }
    }
    // args 从索引 1 开始对应模板中的 J$_1，与旧版 arguments[1] 对齐
    return deepCloneAndReplace(cached, [undefined, ...args]);
}

function replaceInExpr(code, ...args) {
    return replaceInStatement(code, ...args)[0].expression;
}

// ─── 作用域引用（由 esnstrument.js 的 visitor 动态管理）──────────────────────

let _scope = null;

const setScope  = (node) => { _scope = node.scope; };
const popScope  = ()     => { _scope = _scope.parent; };
const getScope  = ()     => _scope;

// ─── getPropertyAsAst ────────────────────────────────────────────────────────

/**
 * 将 MemberExpression / OptionalMemberExpression 的属性部分转为字面量 AST。
 * 非计算属性返回属性名字符串；计算属性返回原节点。
 * PrivateName（如 this.#count）：提取 id.name 并加 '#' 前缀。
 */
const getPropertyAsAst = (ast) => {
    if (ast.computed) return ast.property;
    const prop = ast.property;
    if (prop.type === 'PrivateName') {
        return createLiteralAst(`#${prop.id.name}`);
    }
    return createLiteralAst(prop.name);
};

// ─── wrap 函数 ────────────────────────────────────────────────────────────────

function wrapPutField(node, base, offset, rvalue, isComputed) {
    assertAstNode(node,   'wrapPutField/node');
    assertAstNode(base,   'wrapPutField/base');
    assertAstNode(offset, 'wrapPutField/offset');
    if (!Config.INSTR_PUTFIELD || Config.INSTR_PUTFIELD(isComputed ? null : offset.value, node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logPutFieldFunName}(${RP}1, ${RP}2, ${RP}3, ${RP}4,${createBitPattern(isComputed, false)})`,
            IID.getIid(), base, offset, rvalue
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapModAssign(node, base, offset, op, rvalue, isComputed, isNumber) {
    if (!Config.INSTR_PROPERTY_BINARY_ASSIGNMENT || Config.INSTR_PROPERTY_BINARY_ASSIGNMENT(op, node.computed ? null : offset.value, node)) {
        IID.printModIidToLoc(node);
        const ret = replaceInExpr(
            `${logAssignFunName}(${RP}1,${RP}2,${RP}3,${RP}4,${createBitPattern(isComputed, isNumber)})(${RP}5)`,
            IID.getIid(), base, offset, createLiteralAst(op), rvalue
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapMethodCall(node, base, offset, isCtor, isComputed) {
    assertAstNode(node,   'wrapMethodCall/node');
    assertAstNode(base,   'wrapMethodCall/base');
    assertAstNode(offset, 'wrapMethodCall/offset');
    if (!Config.INSTR_INVOKE || Config.INSTR_INVOKE(node)) {
        IID.printIidToLoc(node);
        IID.printSpecialIidToLoc(node.callee);
        const ret = replaceInExpr(
            `${logMethodCallFunName}(${RP}1, ${RP}2, ${RP}3, ${createBitPattern(isCtor, isComputed)})`,
            IID.getIid(), base, offset
        );
        transferLoc(ret, node.callee);
        return ret;
    }
    // INSTR_INVOKE 禁用时：退回原始 callee，保留语义正确性
    return base.type ? { type: 'MemberExpression', object: base, property: offset, computed: isComputed } : base;
}

function wrapFunCall(node, ast, isCtor) {
    if (!Config.INSTR_INVOKE || Config.INSTR_INVOKE(node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logFunCallFunName}(${RP}1, ${RP}2, ${createBitPattern(isCtor)})`,
            IID.getIid(), ast
        );
        transferLoc(ret, node.callee);
        return ret;
    }
    return ast;
}

function wrapGetField(node, base, offset, isComputed) {
    assertAstNode(node,   'wrapGetField/node');
    assertAstNode(base,   'wrapGetField/base');
    assertAstNode(offset, 'wrapGetField/offset');
    if (!Config.INSTR_GETFIELD || Config.INSTR_GETFIELD(node.computed ? null : offset.value, node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logGetFieldFunName}(${RP}1, ${RP}2, ${RP}3,${createBitPattern(isComputed, false, false)})`,
            IID.getIid(), base, offset
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapRead(node, name, val, isReUseIid, isGlobal, isScriptLocal, scopeId) {
    assertAstNode(node, 'wrapRead/node');
    assertAstNode(name, 'wrapRead/name');
    // Guard: 属性名必须是字符串，否则说明上游错误地把解构模式的 .name 传入了
    if (name.type === 'StringLiteral' && typeof name.value !== 'string') {
        throw new Error(
            `[jalangi] wrapRead: name.value should be a string identifier name, got ${JSON.stringify(name.value)}. ` +
            `This usually means a destructuring pattern's .id.name (undefined) was passed instead of an Identifier.name.`
        );
    }
    if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
        IID.printIidToLoc(node);
        // TODO-7: 若有 scopeId，追加为第五个参数，帮助运行时同步 Shadow Frame
        const scopeArg = (scopeId !== undefined && scopeId !== null) ? `, ${scopeId}` : '';
        const ret = replaceInExpr(
            `${logReadFunName}(${RP}1, ${RP}2, ${RP}3,${createBitPattern(isGlobal, isScriptLocal)}${scopeArg})`,
            isReUseIid ? IID.getPrevIidNoInc() : IID.getIid(),
            name, val
        );
        transferLoc(ret, node);
        return ret;
    }
    return val;
}

function wrapReadWithUndefinedCheck(node, name) {
    const ret = replaceInExpr(
        `(${logIFunName}(typeof (${name}) === 'undefined'? (${RP}2) : (${RP}3)))`,
        createIdentifierAst(name),
        wrapRead(node, createLiteralAst(name), createIdentifierAst('undefined'), false, true, false),
        wrapRead(node, createLiteralAst(name), createIdentifierAst(name), true, true, false)
    );
    transferLoc(ret, node);
    return ret;
}

/**
 * TODO-8: 轻量变量读取钩子包装器。
 * 不传实际值——运行时从 Shadow Frame 查找，减少插桩开销。
 * 签名: J$.Rl(iid, defScopeId, name) → value
 * @param {object} node     - 原 AST 节点（用于位置信息）
 * @param {object} name     - StringLiteral 节点（变量名）
 * @param {number} defScopeId - 变量定义点的 Scope.id
 */
function wrapReadLightweight(node, name, defScopeId) {
    if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logReadLightFunName}(${RP}1, ${defScopeId}, ${RP}2)`,
            IID.getIid(),
            name
        );
        transferLoc(ret, node);
        return ret;
    }
    // 若 INSTR_READ 禁用该节点，退回插桩标识符本身（保持语义正确）
    return node;
}

function wrapWrite(node, name, val, lhs, isGlobal, isScriptLocal, isDeclaration, scopeId) {
    assertAstNode(node, 'wrapWrite/node');
    assertAstNode(name, 'wrapWrite/name');
    // Guard: 属性名必须是字符串，否则说明上游错误地把解构模式的 .name 传入了
    if (name.type === 'StringLiteral' && typeof name.value !== 'string') {
        throw new Error(
            `[jalangi] wrapWrite: name.value should be a string identifier name, got ${JSON.stringify(name.value)}. ` +
            `This usually means a destructuring pattern's .id.name (undefined) was passed instead of an Identifier.name.`
        );
    }
    if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name, node)) {
        IID.printIidToLoc(node);
        // TODO-7: 若有 scopeId，追加为第六个参数，帮助运行时更新 Shadow Frame
        const scopeArg = (scopeId !== undefined && scopeId !== null) ? `, ${scopeId}` : '';
        const ret = replaceInExpr(
            `${logWriteFunName}(${RP}1, ${RP}2, ${RP}3, ${RP}4,${createBitPattern(isGlobal, isScriptLocal, isDeclaration)}${scopeArg})`,
            IID.getIid(), name, val, lhs
        );
        transferLoc(ret, node);
        return ret;
    }
    return val;
}

function wrapWriteWithUndefinedCheck(node, name, val, lhs) {
    if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name, node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logWriteFunName}(${RP}1, ${RP}2, ${RP}3, ${logIFunName}(typeof(${lhs.name})==='undefined'?undefined:${lhs.name}),${createBitPattern(true, false, false)})`,
            IID.getIid(), name, val
        );
        transferLoc(ret, node);
        return ret;
    }
    return val;
}

function wrapRHSOfModStore(node, left, right, op) {
    const ret = replaceInExpr(`${RP}1 ${op} ${RP}2`, left, right);
    transferLoc(ret, node);
    return ret;
}

function makeNumber(node, left) {
    const ret = replaceInExpr(` + ${RP}1 `, left);
    transferLoc(ret, node);
    return ret;
}

function wrapLHSOfModStore(node, left, right) {
    const ret = replaceInExpr(`${RP}1 = ${RP}2`, left, right);
    transferLoc(ret, node);
    return ret;
}

function wrapReturn(node, expr) {
    if (!Config.INSTR_RETURN || Config.INSTR_RETURN(node)) {
        const lid = expr ?? node;
        IID.printIidToLoc(lid);
        const actualExpr = expr ?? createIdentifierAst('undefined');
        const ret = replaceInExpr(
            `${logReturnFunName}(${RP}1, ${RP}2)`,
            IID.getIid(), actualExpr
        );
        transferLoc(ret, lid);
        return ret;
    }
    return expr;
}

function wrapThrow(node, expr) {
    if (!Config.INSTR_THROW || Config.INSTR_THROW(node)) {
        IID.printIidToLoc(expr);
        const ret = replaceInExpr(
            `${logThrowFunName}(${RP}1, ${RP}2)`,
            IID.getIid(), expr
        );
        transferLoc(ret, expr);
        return ret;
    }
    return expr;
}

function wrapWithX1(node, ast) {
    if (!Config.INSTR_END_EXPRESSION || Config.INSTR_END_EXPRESSION(node)) {
        if (!ast || !ast.type.includes('Expression')) return ast;
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logX1FunName}(${RP}1,${RP}2)`,
            IID.getIid(), ast
        );
        transferLoc(ret, node);
        return ret;
    }
    return ast;
}

function wrapHash(node, ast) {
    if (!Config.INSTR_FORIN || Config.INSTR_FORIN(node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logHashFunName}(${RP}1, ${RP}2)`,
            IID.getIid(), ast
        );
        transferLoc(ret, node);
        return ret;
    }
    return ast;
}

function wrapEvalArg(ast) {
    IID.printIidToLoc(ast);
    const ret = replaceInExpr(
        `${instrumentCodeFunName}(${RP}1, ${RP}2, true)`,
        ast, IID.getIid()
    );
    transferLoc(ret, ast);
    return ret;
}

function wrapUnaryOp(node, argument, operator) {
    if (!Config.INSTR_UNARY || Config.INSTR_UNARY(operator, node)) {
        IID.printOpIidToLoc(node);
        const ret = replaceInExpr(
            `${logUnaryOpFunName}(${RP}1,${RP}2,${RP}3)`,
            IID.getOpIid(), createLiteralAst(operator), argument
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapBinaryOp(node, left, right, operator, isComputed) {
    if (!Config.INSTR_BINARY || Config.INSTR_BINARY(operator, node)) {
        IID.printOpIidToLoc(node);
        const ret = replaceInExpr(
            `${logBinaryOpFunName}(${RP}1, ${RP}2, ${RP}3, ${RP}4,${createBitPattern(isComputed, false, false)})`,
            IID.getOpIid(), createLiteralAst(operator), left, right
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapLogicalAnd(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('&&', node)) {
        IID.printCondIidToLoc(node);
        const ret = replaceInExpr(
            `${logConditionalFunName}(${RP}1, ${RP}2)?${RP}3:${logLastFunName}()`,
            IID.getCondIid(), left, right
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapLogicalOr(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('||', node)) {
        IID.printCondIidToLoc(node);
        const ret = replaceInExpr(
            `${logConditionalFunName}(${RP}1, ${RP}2)?${logLastFunName}():${RP}3`,
            IID.getCondIid(), left, right
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

/**
 * 插桩 nullish coalescing 运算符 (??)。
 *
 * `a ?? b` 语义：a 不为 null/undefined 时取 a，否则取 b。
 * 插桩模板：将 left 存入临时变量，用 J$.C 记录分支，
 * 若非 nullish（J$._() 取回暂存值），否则取 right。
 *
 */
function wrapLogicalNullish(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('??', node)) {
        IID.printCondIidToLoc(node);
        // 每次使用唯一临时变量名，避免嵌套 ?? 运算符共享同一槽导致的互相覆盖。
        // 例如 (a ?? b) ?? c 中外层的临时槽不会被内层覆盖。
        //
        // 命名使用 J$.tmp_N（成员属性访问）而非 J$_tN（裸标识符），
        // 因为 RP = 'J$_' 是占位符前缀，以 J$_ 开头的裸标识符会被
        // deepCloneAndReplace 误识别为占位符导致崩溃。
        const tmpProp = `tmp_${tmpVarCounter++}`;
        const uniqueTmp = `${_jalangiVar}.${tmpProp}`;
        // `!= null` 使用宽松比较，已同时排除 null 和 undefined（因为 null == undefined），
        // 无需再加 `!== undefined`，后者是冗余条件。
        const ret = replaceInExpr(
            `(${uniqueTmp} = ${RP}2, ${logConditionalFunName}(${RP}1, ${uniqueTmp} != null) ? ${logLastFunName}() : ${RP}3)`,
            IID.getCondIid(), left, right
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapSwitchDiscriminant(node, discriminant) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('switch', node)) {
        IID.printCondIidToLoc(node);
        const ret = replaceInExpr(
            `${logSwitchLeftFunName}(${RP}1, ${RP}2)`,
            IID.getCondIid(), discriminant
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapSwitchTest(node, test) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('switch', node)) {
        IID.printCondIidToLoc(node);
        const ret = replaceInExpr(
            `${logSwitchRightFunName}(${RP}1, ${RP}2)`,
            IID.getCondIid(), test
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapWith(node) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('with', node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logWithFunName}(${RP}1, ${RP}2)`,
            IID.getIid(), node
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapConditional(node, test) {
    if (node === null) return node;  // for(;;) 的空条件
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('other', node)) {
        IID.printCondIidToLoc(node);
        const ret = replaceInExpr(
            `${logConditionalFunName}(${RP}1, ${RP}2)`,
            IID.getCondIid(), test
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

// ─── 字面量 wrap ──────────────────────────────────────────────────────────────

const dummyFun    = () => {};
const dummyObject = {};
const dummyArray  = [];

function getLiteralValue(funId, node) {
    if (node.name === 'undefined') return undefined;
    if (node.name === 'NaN')       return NaN;
    if (node.name === 'Infinity')  return Infinity;
    switch (funId) {
        case N_LOG_NUMBER_LIT:
        case N_LOG_STRING_LIT:
        case N_LOG_BOOLEAN_LIT:   return node.value;
        case N_LOG_NULL_LIT:      return null;
        // Babel RegExpLiteral：{ pattern, flags } 字段，用它们重建 RegExp 对象
        case N_LOG_REGEXP_LIT:
            try { return new RegExp(node.pattern, node.flags); } catch (_) { return null; }
        case N_LOG_ARRAY_LIT:     return dummyArray;
        case N_LOG_FUNCTION_LIT:  return dummyFun;
        case N_LOG_OBJECT_LIT:    return dummyObject;
    }
    throw new Error(`${funId} not known`);
}

function ifObjectExpressionHasGetterSetter(node) {
    if (node.type !== 'ObjectExpression') return false;
    return node.properties.some(p => p.kind === 'get' || p.kind === 'set');
}

/**
 * 从已插桩的函数 AST 中提取 <sandboxVar>.Fe 调用的 IID（internalFunId）。
 * 只适用于含有 <sandboxVar>.Fe 入口语句的 FunctionExpression / FunctionDeclaration。
 * ArrowFunctionExpression 没有 Fe，应直接传 undefined。
 */
function getFnIdFromAst(ast) {
    const entryExpr = ast.body.body[0];
    if (entryExpr.type !== 'ExpressionStatement') throw new Error('IllegalStateException');
    const call = entryExpr.expression;
    if (call.type !== 'CallExpression') throw new Error('IllegalStateException');
    if (call.callee.type !== 'MemberExpression') throw new Error('IllegalStateException');
    if (call.callee.object.name !== _jalangiVar) throw new Error('IllegalStateException');  // 用动态变量名
    if (call.callee.property.name !== 'Fe') throw new Error('IllegalStateException');
    return call.arguments[0].value;
}

function wrapLiteral(node, ast, funId) {
    if (!Config.INSTR_LITERAL || Config.INSTR_LITERAL(getLiteralValue(funId, node), node)) {
        IID.printIidToLoc(node);
        const hasGetterSetter = ifObjectExpressionHasGetterSetter(node);
        let ret;
        if (funId === N_LOG_FUNCTION_LIT) {
            let internalFunId;
            if (node.type === 'FunctionExpression') {
                internalFunId = getFnIdFromAst(node);
            } else if (node.type === 'ArrowFunctionExpression') {
                // 箭头函数没有 J$.Fe 入口钩子，internalFunId 为 undefined（运行时跳过关联）
                internalFunId = undefined;
            } else {
                if (node.type !== 'Identifier') throw new Error('IllegalStateException');
                internalFunId = getFnIdFromAst(_scope.funNodes[node.name]);
            }
            if (internalFunId !== undefined) {
                ret = replaceInExpr(
                    `${logLitFunName}(${RP}1, ${RP}2, ${RP}3,${hasGetterSetter}, ${internalFunId})`,
                    IID.getIid(), ast, createLiteralAst(funId)
                );
            } else {
                // 箭头函数：不传 internalFunId，运行时不尝试关联 J$.Fe
                ret = replaceInExpr(
                    `${logLitFunName}(${RP}1, ${RP}2, ${RP}3,${hasGetterSetter})`,
                    IID.getIid(), ast, createLiteralAst(funId)
                );
            }
        } else {
            ret = replaceInExpr(
                `${logLitFunName}(${RP}1, ${RP}2, ${RP}3,${hasGetterSetter})`,
                IID.getIid(), ast, createLiteralAst(funId)
            );
        }
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

// ─── 语句级 wrap ──────────────────────────────────────────────────────────────

function createExpressionStatement(lhs, node) {
    const ret = replaceInStatement(`${RP}1 = ${RP}2`, lhs, node);
    transferLoc(ret[0].expression, node);
    return ret;
}

function createCallInitAsStatement(node, name, val, isArgumentSync, lhs, isCatchParam, isAssign) {
    // Guard: isAssign=true 时 lhs 必须存在，且不能是 'arguments'（严格模式下赋值 arguments 为语法错误）
    if (isAssign) {
        if (!lhs) {
            throw new Error(
                '[jalangi] createCallInitAsStatement: isAssign=true but lhs is null/undefined. ' +
                'Pass a valid AST node as lhs, or use isAssign=false to call J$.N without assignment.'
            );
        }
        if (lhs.type === 'Identifier' && lhs.name === 'arguments') {
            throw new Error(
                '[jalangi] createCallInitAsStatement: attempting to assign to "arguments" (isAssign=true, lhs=arguments). ' +
                'This causes SyntaxError in strict mode. Use isAssign=false instead.'
            );
        }
    }
    IID.printIidToLoc(node);
    let ret;
    if (isAssign) {
        ret = replaceInStatement(
            `${RP}1 = ${logInitFunName}(${RP}2, ${RP}3, ${RP}4, ${createBitPattern(isArgumentSync, false, isCatchParam)})`,
            lhs, IID.getIid(), name, val
        );
    } else {
        ret = replaceInStatement(
            `${logInitFunName}(${RP}1, ${RP}2, ${RP}3, ${createBitPattern(isArgumentSync, false, isCatchParam)})`,
            IID.getIid(), name, val
        );
    }
    transferLoc(ret[0].expression, node);
    return ret;
}

function createCallAsFunEnterStatement(node, scopeId) {
    IID.printIidToLoc(node);
    // arguments.callee 在严格模式下会抛出 TypeError，使用 try-catch 安全降级为 undefined
    // TODO-7: scopeId 作为第五个参数传给 J$.Fe，运行时用于创建 Shadow Frame
    const scopeArg = (scopeId !== undefined && scopeId !== null) ? `, ${scopeId}` : '';
    const ret = replaceInStatement(
        `${logFunctionEnterFunName}(${RP}1,(function(){try{return arguments.callee}catch(e){return undefined}}()), this, arguments${scopeArg})`,
        IID.getIid()
    );
    transferLoc(ret[0].expression, node);
    return ret;
}

function createCallAsScriptEnterStatement(node, instFile, origFile) {
    IID.printIidToLoc(node);
    const ret = replaceInStatement(
        `${logScriptEntryFunName}(${RP}1,${RP}2, ${RP}3)`,
        IID.getIid(),
        createLiteralAst(instFile),
        createLiteralAst(origFile)
    );
    transferLoc(ret[0].expression, node);
    return ret;
}

// ─── for-in / catch / try-catch 包装 ──────────────────────────────────────────

let labelCounter = 0;
/** 每次插桩新文件时重置，保证插桩幂等性 */
let tmpVarCounter = 0;

function wrapForIn(node, left, right, body) {
    if (Config.INSTR_FORIN && !Config.INSTR_FORIN(node)) return node;
    IID.printIidToLoc(node);
    const isDeclaration = (left.type === 'VariableDeclaration');
    let tmp, extra;
    if (isDeclaration) {
        // Guard: for-in 只支持单个普通标识符声明，不支持解构模式（如 for (var {a} in obj)）。
        const decl = node.left.declarations[0];
        if (!decl || decl.id.type !== 'Identifier') {
            throw new Error(
                `[jalangi] wrapForIn: for-in left-hand side declaration has a non-Identifier pattern ` +
                `(got ${decl?.id?.type ?? 'undefined'}). ` +
                `Destructuring patterns in for-in are not supported.`
            );
        }
        const name = decl.id.name;
        tmp   = replaceInExpr(`${name} = ${logTmpVarName}`);
        extra = instrumentStore(tmp, isDeclaration);
        const ret = replaceInStatement(
            `function n() { for(${logTmpVarName} in ${RP}1) {var ${name} = ${RP}2;\n {${RP}3}}}`,
            right, wrapWithX1(node, extra.right), body
        );
        const forin = ret[0].body.body[0];
        transferLoc(forin, node);
        return forin;
    } else {
        tmp   = replaceInExpr(`${RP}1 = ${logTmpVarName}`, left);
        extra = instrumentStore(tmp, isDeclaration);
        const ret = replaceInStatement(
            `function n() { for(${logTmpVarName} in ${RP}1) {${RP}2;\n {${RP}3}}}`,
            right, wrapWithX1(node, extra), body
        );
        const forin = ret[0].body.body[0];
        transferLoc(forin, node);
        return forin;
    }
}

function wrapCatchClause(node, body, name) {
    if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
        body.unshift(createCallInitAsStatement(
            node,
            createLiteralAst(name),
            createIdentifierAst(name),
            false, createIdentifierAst(name), true, true
        )[0]);
    }
}

function wrapScriptBodyWithTryCatch(node, body) {
    if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
        IID.printIidToLoc(node);
        const iid1 = IID.getIid();
        IID.printIidToLoc(node);
        const l = labelCounter++;
        // BUG-4 fix: catch 块末尾必须 re-throw，否则脚本级未捕获异常被静默吞掉，
        // 导致 try 内部抛出的错误对外不可见，破坏程序的错误传播语义。
        const ret = replaceInStatement(
            `function n() { jalangiLabel${l}: while(true) { try {${RP}1} catch(${_jalangiVar}e) { ${logUncaughtExceptionFunName}(${RP}2,${_jalangiVar}e); throw ${_jalangiVar}e; } finally { if (${logScriptExitFunName}(${RP}3)) { ${logLastComputedFunName}(); continue jalangiLabel${l};\n } else {\n  ${logLastComputedFunName}(); break jalangiLabel${l};\n }}\n }}`,
            body, iid1, IID.getIid()
        );
        const stmts = ret[0].body.body;
        transferLoc(stmts[0], node);
        return stmts;
    }
    return body;
}

function wrapFunBodyWithTryCatch(node, body) {
    // Guard: generator 和 async 函数不应进入包裹逻辑。
    // 修复早已在 visitorOps 层面拦截，但如果未来某个 visitor 気必直接调用此函数，
    // 必须在这里提前抛错而不是静默返回错误的代码。
    if (node.generator) {
        throw new Error(
            `[jalangi] wrapFunBodyWithTryCatch: called on a generator function (function*). ` +
            `Generator functions must NOT be wrapped with while(true)/try/finally because yield semantics would be broken. ` +
            `Handle generator nodes before calling this function.`
        );
    }
    if (node.async) {
        throw new Error(
            `[jalangi] wrapFunBodyWithTryCatch: called on an async function. ` +
            `Async functions must NOT be wrapped with while(true)/try/finally because await semantics would be broken. ` +
            `Handle async nodes before calling this function.`
        );
    }
    if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
        IID.printIidToLoc(node);
        const iid1 = IID.getIid();
        IID.printIidToLoc(node);
        const l = labelCounter++;
        const ret = replaceInStatement(
            `function n() { jalangiLabel${l}: while(true) { try {${RP}1} catch(${_jalangiVar}e) { ${logUncaughtExceptionFunName}(${RP}2,${_jalangiVar}e); } finally { if (${logFunctionReturnFunName}(${RP}3)) continue jalangiLabel${l};\n else \n  return ${logReturnAggrFunName}();\n }\n }}`,
            body, iid1, IID.getIid()
        );
        const stmts = ret[0].body.body;
        transferLoc(stmts[0], node);
        return stmts;
    }
    return body;
}

// ─── syncDefuns / instrumentFunctionEntryExit / instrumentScriptEntryExit ────

function syncDefuns(node, scopeArg, isScript) {
    let ret = [];
    if (!isScript) {
        if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                // BUG-1 fix: 不对 arguments 直接赋值（严格模式下赋值 arguments 为语法错误）。
                // 改用 isAssign=false，只调用 J$.N 通知运行时，不写回 arguments 本身。
                const ident = createIdentifierAst('arguments');
                ret = ret.concat(createCallInitAsStatement(node,
                    createLiteralAst('arguments'), ident, true, undefined, false, false));
            }
        }
    }
    if (scopeArg) {
        // Object.keys 仅返回自有可枚举属性，HOP 检查已冗余，移除
        for (const name of Object.keys(scopeArg.vars)) {
            const varType = scopeArg.vars[name];
            // Guard: varType 必须是已知类型之一；出现未知类型说明 scope.js 收锂了新的变量类型
            const _knownVarTypes = new Set(['defun', 'lambda', 'arg', 'var']);
            if (!_knownVarTypes.has(varType)) {
                throw new Error(
                    `[jalangi] syncDefuns: unknown varType "${varType}" for variable "${name}". ` +
                    `Expected one of: defun, lambda, arg, var. ` +
                    `If scope.js added a new varType, update syncDefuns to handle it.`
                );
            }
            let ident;
            if (varType === 'defun') {
                ident = createIdentifierAst(name);
                ident.loc = scopeArg.funLocs[name];
                if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                    ret = ret.concat(createCallInitAsStatement(node,
                        createLiteralAst(name),
                        wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT),
                        false, ident, false, true));
                } else {
                    ret = ret.concat(createExpressionStatement(ident,
                        wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT)));
                }
            } else if (varType === 'lambda') {
                if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                    ident = createIdentifierAst(name);
                    ident.loc = scopeArg.funLocs[name];
                    ret = ret.concat(createCallInitAsStatement(node,
                        createLiteralAst(name), ident, false, ident, false, true));
                }
            } else if (varType === 'arg') {
                if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                    ident = createIdentifierAst(name);
                    ret = ret.concat(createCallInitAsStatement(node,
                        createLiteralAst(name), ident, true, ident, false, true));
                }
            } else if (varType === 'var') {
                if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                    ret = ret.concat(createCallInitAsStatement(node,
                        createLiteralAst(name),
                        createIdentifierAst(name),
                        false, undefined, false, false));
                }
            }
        }
    }
    return ret;
}

function instrumentFunctionEntryExit(node, ast) {
    // TODO-7: 将当前作用域的 scopeId 传给 Fe，以便运行时创建 Shadow Frame
    const scopeId = _scope?.id;
    const body = (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))
        ? createCallAsFunEnterStatement(node, scopeId)
        : [];
    return [...body, ...syncDefuns(node, _scope, false), ...ast];
}

/**
 * 仅对箭头函数（ArrowFunctionExpression）的块体（block body）执行参数/var 同步。
 *
 * 箭头函数没有独立的 `arguments` 和 `this` 绑定，也无法通过
 * arguments.callee 引用自身，因此：
 *  - 不注入 J$.Fe / J$.Fr 入口/出口钩子
 *  - 不插入 `arguments` 的 J$.N 同步语句（箭头函数无 arguments 对象）
 * 但其参数（arg）和局部 var 声明仍通过 J$.N 注册给运行时分析工具。
 *
 * 表达式体（body 不是 BlockStatement）直接跳过。
 */
function instrumentArrowFunctionBody(node) {
    // 表达式体（e.g. x => x + 1）：body 不是 BlockStatement，无法插入语句。
    if (node.body.type !== 'BlockStatement') return;
    // 块体（e.g. x => { return x + 1; }）：只插入 arg/var 同步，跳过 arguments 同步
    // syncDefuns 以 isScript=true 调用可跳过 arguments 初始化段，
    // 但会导致跳过 try-catch 包裹检查；此处手动过滤更安全：
    // 我们直接跳过 syncDefuns 中的 arguments 部分，只处理 scopeArg.vars
    const synced = syncArrowDefuns(node, _scope);
    if (synced.length > 0) {
        node.body.body = [...synced, ...node.body.body];
    }
}

/**
 * 与 syncDefuns 类似，但跳过 `arguments` 初始化（箭头函数无此绑定）。
 * 仅处理 scopeArg.vars 中的 arg / var / defun / lambda 条目。
 */
function syncArrowDefuns(node, scopeArg) {
    if (!scopeArg) return [];
    let ret = [];
    // Object.keys 仅返回自有可枚举属性，HOP 检查已冗余，移除
    for (const name of Object.keys(scopeArg.vars)) {
        const varType = scopeArg.vars[name];
        let ident;
        if (varType === 'defun') {
            ident = createIdentifierAst(name);
            ident.loc = scopeArg.funLocs[name];
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ret = ret.concat(createCallInitAsStatement(node,
                    createLiteralAst(name),
                    wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT),
                    false, ident, false, true));
            } else {
                ret = ret.concat(createExpressionStatement(ident,
                    wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT)));
            }
        } else if (varType === 'lambda') {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ident = createIdentifierAst(name);
                ident.loc = scopeArg.funLocs[name];
                ret = ret.concat(createCallInitAsStatement(node,
                    createLiteralAst(name), ident, false, ident, false, true));
            }
        } else if (varType === 'arg') {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ident = createIdentifierAst(name);
                ret = ret.concat(createCallInitAsStatement(node,
                    createLiteralAst(name), ident, true, ident, false, true));
            }
        } else if (varType === 'var') {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ret = ret.concat(createCallInitAsStatement(node,
                    createLiteralAst(name),
                    createIdentifierAst(name),
                    false, undefined, false, false));
            }
        }
    }
    return ret;
}

function instrumentScriptEntryExit(node, body0, instFile, origFile) {
    const body = (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))
        ? createCallAsScriptEnterStatement(node, instFile, origFile)
        : [];
    return [...body, ...syncDefuns(node, _scope, true), ...body0];
}

// ─── instrumentStore / instrumentLoad / instrumentLoadModStore / instrumentPreIncDec

/**
 * TODO-5: 沿作用域链向上查找变量实际定义的 Scope。
 * 闭包引用时，读取点和定义点不在同一个作用域，必须用定义点的 scopeId。
 */
function _findDefScope(scope, name) {
    for (let s = scope; s !== null; s = s.parent) {
        if (s.hasOwnVar(name)) return s;
    }
    return null;
}

function instrumentStore(node, isDeclaration) {
    if (node.left.type === 'Identifier') {
        const hasVar = _scope.hasVar(node.left.name);
        if (hasVar) {
            // TODO-7: 传入 scopeId（定义点的 Scope.id）
            const defScope = _findDefScope(_scope, node.left.name);
            const scopeId  = defScope?.id;
            node.right = wrapWrite(node.right, createLiteralAst(node.left.name), node.right, node.left,
                false, _scope.isGlobal(node.left.name), isDeclaration, scopeId);
        } else {
            node.right = wrapWriteWithUndefinedCheck(node.right, createLiteralAst(node.left.name), node.right, node.left);
        }
        return node;
    }
    return wrapPutField(node, node.left.object, getPropertyAsAst(node.left), node.right, node.left.computed);
}

function instrumentLoad(ast, isTypeof) {
    if (ast.type === 'Identifier') {
        if (ast.name === 'undefined') return wrapLiteral(ast, ast, N_LOG_UNDEFINED_LIT);
        if (ast.name === 'NaN' || ast.name === 'Infinity') return wrapLiteral(ast, ast, N_LOG_NUMBER_LIT);
        if (ast.name === _jalangiVar) return ast;  // 沙盒变量自身不插桩
        if (_scope.hasVar(ast.name)) {
            // TODO-5: 沿作用域链向上查找实际定义点（闭包支持）
            const defScope = _findDefScope(_scope, ast.name);
            const isGlobal = _scope.isGlobal(ast.name);

            // TODO-8: 判断是否可以走轻量读取路径
            const canUseLightweight =
                defScope !== null &&
                !isGlobal &&
                !_scope.usesEval() &&
                !_scope.usesWith() &&
                defScope.hasOwnVar(ast.name) !== 'catch' &&
                ast.name !== 'arguments';

            if (canUseLightweight) {
                // 轻量读取路径：不传 value，运行时从 Shadow Frame 查值
                return wrapReadLightweight(ast, createLiteralAst(ast.name), defScope.id);
            }
            // 全量读取路径（包括 scopeId 以支持 Shadow Frame 同步）
            return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isGlobal, defScope?.id);
        } else if (isTypeof) {
            return wrapReadWithUndefinedCheck(ast, ast.name);
        } else {
            return wrapRead(ast, createLiteralAst(ast.name), ast, false, true, false);
        }
    } else if (ast.type === 'MemberExpression') {
        return wrapGetField(ast, ast.object, getPropertyAsAst(ast), ast.computed);
    } else if (ast.type === 'OptionalMemberExpression') {
        // Babel AST：可选链 a?.b，语义与 MemberExpression 相同，注入 J$.G 属性读取钩子
        return wrapGetField(ast, ast.object, getPropertyAsAst(ast), ast.computed);
    }
    return ast;
}

function instrumentLoadModStore(node, isNumber) {
    if (node.left.type === 'Identifier') {
        let tmp0 = instrumentLoad(node.left, false);
        if (isNumber) tmp0 = makeNumber(node, instrumentLoad(tmp0, false));
        const tmp1 = wrapRHSOfModStore(node.right, tmp0, node.right,
            node.operator.slice(0, -1));
        const _defScope2 = _scope.hasVar(node.left.name) ? _findDefScope(_scope, node.left.name) : null;
        const tmp2 = _defScope2 !== null
            ? wrapWrite(node, createLiteralAst(node.left.name), tmp1, node.left,
                false, _scope.isGlobal(node.left.name), false, _defScope2?.id)
            : wrapWriteWithUndefinedCheck(node, createLiteralAst(node.left.name), tmp1, node.left);
        return wrapLHSOfModStore(node, node.left, tmp2);
    }
    return wrapModAssign(node, node.left.object,
        getPropertyAsAst(node.left),
        node.operator.slice(0, -1),
        node.right, node.left.computed, !!isNumber);
}

function instrumentPreIncDec(node) {
    let right = createLiteralAst(1);
    right = wrapLiteral(right, right, N_LOG_NUMBER_LIT);
    const ret = wrapRHSOfModStore(node, node.argument, right, `${node.operator[0]}=`);
    return instrumentLoadModStore(ret, true);
}

function adjustIncDec(op, ast) {
    const binOp = (op === '++') ? '-' : '+';
    let right = createLiteralAst(1);
    right = wrapLiteral(right, right, N_LOG_NUMBER_LIT);
    return wrapRHSOfModStore(ast, ast, right, binOp);
}

function instrumentCall(callAst, isCtor) {
    const ast = callAst.callee;
    if (ast.type === 'MemberExpression') {
        return wrapMethodCall(callAst, ast.object, getPropertyAsAst(ast), isCtor, ast.computed);
    } else if (ast.type === 'OptionalMemberExpression') {
        // Babel AST：可选链方法调用 a?.b()，callee 是 OptionalMemberExpression
        return wrapMethodCall(callAst, ast.object, getPropertyAsAst(ast), isCtor, ast.computed);
    } else if (ast.type === 'Identifier' && ast.name === 'eval') {
        return ast;
    }
    return wrapFunCall(callAst, ast, isCtor);
}

// ─── 初始化（注入 Config）────────────────────────────────────────────────────

/**
 * 在使用任何 wrap 函数前，必须先调用 init(config, jalangiVar?) 注入配置对象。
 *
 * @param {object} config      - Jalangi Config 对象
 * @param {string} [jalangiVar] - 沙盒变量名（默认 'J$'）。
 *                                指定其他名称可避免与被分析页面已有的 J$ 变量冲突。
 */
function init(config, jalangiVar) {
    Config = config;
    const v = (typeof jalangiVar === 'string' && /^[A-Za-z_$][\w$]*$/.test(jalangiVar))
        ? jalangiVar
        : JALANGI_VAR;
    if (v !== _jalangiVar) _rebuildNames(v);
}

/**
 * 每次插桩新文件前调用，重置文件级别的可变状态。
 * 目前负责重置 labelCounter，保证插桩幂等性（相同代码多次插桩结果一致）。
 */
function resetPerFile() {
    labelCounter = 0;
    tmpVarCounter = 0;
}

// ─── TODO-9: 插桩决策表（由 dataflow.js analyzeDefUse 生成，供 instrumentLoad 查询）

/**
 * 当前文件的插桩决策表（Map<nodeKey, Decision>）。
 * null 表示未注入（不使用静态分析优化，全量插桩）。
 * 由 esnstrument.js 的 transformString 调用 setInstrDecisions 注入。
 */
let _instrDecisions = null;

/**
 * 注入插桩决策表（由 esnstrument.js 在 Pass 0 后调用）。
 * 传 null 表示清除（Pass 结束后防止跨文件污染）。
 *
 * @param {Map<string, string>|null} decisions  analyzeDefUse 的输出
 */
function setInstrDecisions(decisions) {
    _instrDecisions = decisions;
}

// ─── 导出 ──────────────────────────────────────────────────────────────────────

export {
    init, resetPerFile, setInstrDecisions,
    // scope 状态管理
    setScope, popScope, getScope,
    // AST 辅助
    createLiteralAst, createIdentifierAst, transferLoc, createBitPattern,
    getPropertyAsAst,
    // 字面量类型常量
    N_LOG_ARRAY_LIT, N_LOG_OBJECT_LIT, N_LOG_FUNCTION_LIT,
    N_LOG_NUMBER_LIT, N_LOG_STRING_LIT, N_LOG_BOOLEAN_LIT,
    N_LOG_NULL_LIT, N_LOG_REGEXP_LIT, N_LOG_UNDEFINED_LIT,
    // wrap 函数
    wrapPutField, wrapModAssign, wrapMethodCall, wrapFunCall,
    wrapGetField, wrapRead, wrapReadWithUndefinedCheck, wrapReadLightweight,
    wrapWrite, wrapWriteWithUndefinedCheck,
    wrapReturn, wrapThrow, wrapWithX1, wrapHash, wrapEvalArg,
    wrapUnaryOp, wrapBinaryOp, wrapLogicalAnd, wrapLogicalOr, wrapLogicalNullish,
    wrapSwitchDiscriminant, wrapSwitchTest, wrapWith, wrapConditional,
    wrapLiteral, wrapForIn, wrapCatchClause,
    wrapScriptBodyWithTryCatch, wrapFunBodyWithTryCatch,
    // 高级函数
    instrumentStore, instrumentLoad, instrumentLoadModStore,
    instrumentPreIncDec, adjustIncDec, instrumentCall,
    instrumentFunctionEntryExit, instrumentArrowFunctionBody, instrumentScriptEntryExit,
    createCallAsFunEnterStatement, createCallAsScriptEnterStatement,
    // 内部工具（测试用）
    _findDefScope,
};
