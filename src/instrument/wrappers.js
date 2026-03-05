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
 *
 * Phase 4 重构（完成）：所有 wrap 函数从 replaceInExpr 字符串模板改为
 * 直接用 @babel/types 工厂函数构建 AST，消除运行时解析开销。
 * replaceInStatement / replaceInExpr 保留为参考实现，已无内部调用方。
 */

import * as babelParser from '@babel/parser';
import _babelTypes from '@babel/types';
// @babel/types 是 CJS 模块，ESM 导入需取 .default
const t = _babelTypes.default ?? _babelTypes;

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
let logReadLightFunName;  // J$.Rl 轻量变量读取钩子
let logAwaitResumeFunName;  // J$.Aw await 恢复点钩子

// ─── @babel/types 辅助函数（用于直接构建 AST）───────────────────────────────

/**
 * 构建 `<obj>.<prop>` 的 MemberExpression 节点（非计算属性）。
 * @param {string|object} obj  - 对象名（字符串时自动转 Identifier）或 AST 节点
 * @param {string}        prop - 属性名
 */
function memberExpr(obj, prop) {
    const object = (typeof obj === 'string') ? t.identifier(obj) : obj;
    return t.memberExpression(object, t.identifier(prop));
}

/**
 * 构建 `<callee>(<...args>)` 的 CallExpression 节点。
 * @param {string|object} callee - 被调函数（字符串时视为 `J$.<callee>`）或 AST 节点
 * @param {object[]}      args   - 参数 AST 节点数组
 */
function callExpr(callee, args) {
    const calleeNode = (typeof callee === 'string')
        ? memberExpr(_jalangiVar, callee)
        : callee;
    return t.callExpression(calleeNode, args);
}

/**
 * 构建 `J$.<method>(iid, ...rest)` 的通用插桩调用节点。
 * @param {string}   method  - J$ 的方法名（如 'R', 'W', 'B'）
 * @param {object}   iidNode - IID 数字字面量 AST 节点
 * @param {object[]} rest    - 其余参数 AST 节点数组
 */
function jalangiCall(method, iidNode, ...rest) {
    return callExpr(memberExpr(_jalangiVar, method), [iidNode, ...rest]);
}

/**
 * 用给定的沙盒变量名重新生成所有运行时函数名常量 */
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
    logReadLightFunName      = `${v}.Rl`;  // 轻量变量读取钩子
    logAwaitResumeFunName    = `${v}.Aw`;  // await 恢复点钩子
    // 模板缓存依赖占位符前缀，变量名变化时必须清空
    _templateCache.clear();
}

// 模块加载时用默认值初始化一次
_rebuildNames(JALANGI_VAR);

// ─── N_LOG_* 字面量类型常量 ────────────────────────────────────────────────────
// 这些整数常量在运行时传给 J$.T（wrapLiteral），用于标识字面量的具体类型。

const N_LOG_ARRAY_LIT       = 10;
const N_LOG_OBJECT_LIT      = 11;
const N_LOG_FUNCTION_LIT    = 12;
const N_LOG_REGEXP_LIT      = 14;
const N_LOG_STRING_LIT      = 21;
const N_LOG_NUMBER_LIT      = 22;
const N_LOG_BOOLEAN_LIT     = 23;
const N_LOG_UNDEFINED_LIT   = 24;
const N_LOG_NULL_LIT        = 25;
const N_LOG_BIGINT_LIT      = 26;

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
 * 可被 wrapWithX1（J$.X1）包装的 AST 表达式类型白名单。
 *
 * 只有真正的表达式节点才能被包装；Statement、Literal 等其他节点类型不适用。
 * 使用精确的白名单而非 type.includes('Expression') 字符串检查，
 * 避免将来 Babel 新增以 'Expression' 结尾但不适合包装的节点类型（如 'TSTypeAssertion' 等）。
 *
 * 注意：Babel 原生 AST 的字面量类型（NumericLiteral、StringLiteral 等）已由各自的
 * visitor 在插桩后被替换为 CallExpression（J$.T 调用），此处不需要单独列出。
 */
const _EXPRESSION_TYPES = new Set([
    'AssignmentExpression',
    'BinaryExpression',
    'CallExpression',
    'ConditionalExpression',
    'LogicalExpression',
    'MemberExpression',
    'NewExpression',
    'ObjectExpression',
    'ArrayExpression',
    'SequenceExpression',
    'UnaryExpression',
    'UpdateExpression',
    'YieldExpression',
    'AwaitExpression',
    'TaggedTemplateExpression',
    'TemplateLiteral',
    'OptionalCallExpression',
    'OptionalMemberExpression',
    'ArrowFunctionExpression',
    'FunctionExpression',
    'ClassExpression',
    'Identifier',
    'ThisExpression',
    'Super',
    'Import',
    'MetaProperty',
]);

/**
 * 创建 Babel 字面量节点：string → StringLiteral，number → NumericLiteral，以此类推。
 */
const createLiteralAst = (name) => {
    if (typeof name === 'string') {
        return t.stringLiteral(name);
    } else if (typeof name === 'number') {
        return t.numericLiteral(name);
    } else if (typeof name === 'boolean') {
        return t.booleanLiteral(name);
    } else if (name === null) {
        return t.nullLiteral();
    }
    return t.stringLiteral(String(name));
};
const createIdentifierAst = (name) => t.identifier(name);

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

// ─── 模板缓存（遗留：replaceInStatement / replaceInExpr 可完全移除）─────────────
//
// Phase 4 已将所有 wrap 函数迁移至 @babel/types 直接构建，
// replaceInStatement / replaceInExpr 已无任何调用方，
// 保留以防外部测试代码直接调用（或作为参考实现）。

/**
 * 深拷贝并替换 AST 中的占位符。
 */
function deepCloneAndReplace(node, args) {
    if (node === null || typeof node !== 'object') return node;

    if (Array.isArray(node)) {
        const result = [];
        for (const item of node) {
            const replaced = deepCloneAndReplace(item, args);
            if (Array.isArray(replaced)) result.push(...replaced);
            else result.push(replaced);
        }
        return result;
    }

    if (node.type === 'Identifier' && node.name.startsWith(RP)) {
        return args[parseInt(node.name.slice(RP.length), 10)];
    }

    if (node.type === 'BlockStatement') {
        const newBody = deepCloneAndReplace(node.body, args);
        if (newBody.length === 1
                && newBody[0]?.type === 'ExpressionStatement'
                && Array.isArray(newBody[0].expression)) {
            return { type: 'BlockStatement', body: newBody[0].expression };
        }
        return { type: 'BlockStatement', body: newBody };
    }

    const obj = {};
    for (const key of Object.keys(node)) {
        if (key !== 'loc' && key !== 'start' && key !== 'end') {
            obj[key] = deepCloneAndReplace(node[key], args);
        }
    }
    return obj;
}

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

// ─── wrap 函数（@babel/types 直接构建版）─────────────────────────────────────

function wrapPutField(node, base, offset, rvalue, isComputed) {
    assertAstNode(node,   'wrapPutField/node');
    assertAstNode(base,   'wrapPutField/base');
    assertAstNode(offset, 'wrapPutField/offset');
    if (!Config.INSTR_PUTFIELD || Config.INSTR_PUTFIELD(isComputed ? null : offset.value, node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('P',
            IID.getIid(), base, offset, rvalue,
            t.numericLiteral(createBitPattern(isComputed, false))
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapModAssign(node, base, offset, op, rvalue, isComputed, isNumber) {
    if (!Config.INSTR_PROPERTY_BINARY_ASSIGNMENT || Config.INSTR_PROPERTY_BINARY_ASSIGNMENT(op, node.computed ? null : offset.value, node)) {
        IID.printModIidToLoc(node);
        // J$.A(iid, base, offset, op, bits)(rvalue)
        const innerCall = jalangiCall('A',
            IID.getIid(), base, offset, createLiteralAst(op),
            t.numericLiteral(createBitPattern(isComputed, isNumber))
        );
        const ret = t.callExpression(innerCall, [rvalue]);
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
        const ret = jalangiCall('M',
            IID.getIid(), base, offset,
            t.numericLiteral(createBitPattern(isCtor, isComputed))
        );
        transferLoc(ret, node.callee);
        return ret;
    }
    // INSTR_INVOKE 禁用时：退回原始 callee，保留语义正确性
    // offset 可能是 StringLiteral（非计算属性名），不能直接传给 t.memberExpression 的 property
    if (base.type) {
        if (isComputed) {
            return t.memberExpression(base, offset, true);
        } else {
            // 非计算属性：offset 是 StringLiteral，转为 Identifier
            const propId = (offset.type === 'StringLiteral')
                ? t.identifier(offset.value)
                : offset;
            return t.memberExpression(base, propId, false);
        }
    }
    return base;
}

function wrapFunCall(node, ast, isCtor) {
    if (!Config.INSTR_INVOKE || Config.INSTR_INVOKE(node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('F',
            IID.getIid(), ast,
            t.numericLiteral(createBitPattern(isCtor))
        );
        transferLoc(ret, node.callee);
        return ret;
    }
    return ast;
}

function wrapGetField(node, base, offset, isComputed, isOptional) {
    assertAstNode(node,   'wrapGetField/node');
    assertAstNode(base,   'wrapGetField/base');
    assertAstNode(offset, 'wrapGetField/offset');
    if (!Config.INSTR_GETFIELD || Config.INSTR_GETFIELD(node.computed ? null : offset.value, node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('G',
            IID.getIid(), base, offset,
            t.numericLiteral(createBitPattern(isComputed, false, false, !!isOptional))
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapRead(node, name, val, isReUseIid, isGlobal, isScriptLocal, scopeId) {
    assertAstNode(node, 'wrapRead/node');
    assertAstNode(name, 'wrapRead/name');
    if (name.type === 'StringLiteral' && typeof name.value !== 'string') {
        throw new Error(
            `[jalangi] wrapRead: name.value should be a string identifier name, got ${JSON.stringify(name.value)}. ` +
            `This usually means a destructuring pattern's .id.name (undefined) was passed instead of an Identifier.name.`
        );
    }
    if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
        IID.printIidToLoc(node);
        const iidNode = isReUseIid ? IID.getPrevIidNoInc() : IID.getIid();
        const bitsNode = t.numericLiteral(createBitPattern(isGlobal, isScriptLocal));
        const args = [iidNode, name, val, bitsNode];
        if (scopeId !== undefined && scopeId !== null) {
            args.push(t.numericLiteral(scopeId));
        }
        const ret = callExpr(memberExpr(_jalangiVar, 'R'), args);
        transferLoc(ret, node);
        return ret;
    }
    return val;
}

function wrapReadWithUndefinedCheck(node, name) {
    // J$.I(typeof name === 'undefined' ? wrapRead(...undefined) : wrapRead(...name))
    const undef = t.identifier('undefined');
    const nameId = t.identifier(name);
    const typeofExpr = t.unaryExpression('typeof', nameId);
    const isUndef = t.binaryExpression('===', typeofExpr, t.stringLiteral('undefined'));
    const readUndef = wrapRead(node, createLiteralAst(name), undef, false, true, false);
    const readName  = wrapRead(node, createLiteralAst(name), nameId, true, true, false);
    const conditional = t.conditionalExpression(isUndef, readUndef, readName);
    const ret = callExpr(memberExpr(_jalangiVar, 'I'), [conditional]);
    transferLoc(ret, node);
    return ret;
}

/**
 * await 恢复点包装器。
 * 将 `await expr` 转换为 `J$.Aw(iid, await expr, ctxId)`。
 */
function wrapAwait(node, argument) {
    if (!Config.INSTR_AWAIT || Config.INSTR_AWAIT(node)) {
        IID.printIidToLoc(node);
        const iidNode = IID.getIid();

        const awaitNode = t.awaitExpression(argument);
        if (node.loc) awaitNode.loc = node.loc;

        const ctxVarNode = t.identifier(`${_jalangiVar}__ctx`);

        const ret = jalangiCall('Aw', iidNode, awaitNode, ctxVarNode);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

/**
 * 轻量变量读取钩子包装器。
 * 签名: J$.Rl(iid, defScopeId, name) → value
 */
function wrapReadLightweight(node, name, defScopeId) {
    if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('Rl',
            IID.getIid(),
            t.numericLiteral(defScopeId),
            name
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapWrite(node, name, val, lhs, isGlobal, isScriptLocal, isDeclaration, scopeId) {
    assertAstNode(node, 'wrapWrite/node');
    assertAstNode(name, 'wrapWrite/name');
    if (name.type === 'StringLiteral' && typeof name.value !== 'string') {
        throw new Error(
            `[jalangi] wrapWrite: name.value should be a string identifier name, got ${JSON.stringify(name.value)}. ` +
            `This usually means a destructuring pattern's .id.name (undefined) was passed instead of an Identifier.name.`
        );
    }
    if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name, node)) {
        IID.printIidToLoc(node);
        const bitsNode = t.numericLiteral(createBitPattern(isGlobal, isScriptLocal, isDeclaration));
        const args = [IID.getIid(), name, val, lhs, bitsNode];
        if (scopeId !== undefined && scopeId !== null) {
            args.push(t.numericLiteral(scopeId));
        }
        const ret = callExpr(memberExpr(_jalangiVar, 'W'), args);
        transferLoc(ret, node);
        return ret;
    }
    return val;
}

function wrapWriteWithUndefinedCheck(node, name, val, lhs) {
    if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name, node)) {
        IID.printIidToLoc(node);
        // J$.W(iid, name, val, J$.I(typeof lhs === 'undefined' ? undefined : lhs), bits)
        const lhsId = t.identifier(lhs.name);
        const typeofExpr = t.unaryExpression('typeof', lhsId);
        const isUndef = t.binaryExpression('===', typeofExpr, t.stringLiteral('undefined'));
        const ifExpr = t.conditionalExpression(isUndef, t.identifier('undefined'), lhsId);
        const wrappedLhs = callExpr(memberExpr(_jalangiVar, 'I'), [ifExpr]);
        const bitsNode = t.numericLiteral(createBitPattern(true, false, false));
        const ret = callExpr(memberExpr(_jalangiVar, 'W'), [IID.getIid(), name, val, wrappedLhs, bitsNode]);
        transferLoc(ret, node);
        return ret;
    }
    return val;
}

// 逻辑运算符集合（@babel/types 的 logicalExpression 支持的操作符）
const _LOGICAL_OPS = new Set(['||', '&&', '??']);
// 赋值操作符（以 '=' 结尾且非 '=='、'!='、'<='、'>='、'==='、'!=='）
function _isAssignmentOp(op) {
    return op.endsWith('=') && op.length > 1 && !['==', '!=', '<=', '>=', '===', '!=='].includes(op);
}

function wrapRHSOfModStore(node, left, right, op) {
    // op 可能是：
    //  - 逻辑运算符（'||' '&&' '??'）→ t.logicalExpression
    //  - 赋值运算符（'+=' '||='等）→ t.assignmentExpression
    //  - 普通二元运算符（'+' '-' 等）→ t.binaryExpression
    let ret;
    if (_LOGICAL_OPS.has(op)) {
        ret = t.logicalExpression(op, left, right);
    } else if (_isAssignmentOp(op)) {
        ret = t.assignmentExpression(op, left, right);
    } else {
        ret = t.binaryExpression(op, left, right);
    }
    transferLoc(ret, node);
    return ret;
}

function makeNumber(node, left) {
    // 一元 + 将值转为数字：+left
    const ret = t.unaryExpression('+', left);
    transferLoc(ret, node);
    return ret;
}

function wrapLHSOfModStore(node, left, right) {
    // left = right
    const ret = t.assignmentExpression('=', left, right);
    transferLoc(ret, node);
    return ret;
}

function wrapReturn(node, expr) {
    if (!Config.INSTR_RETURN || Config.INSTR_RETURN(node)) {
        const lid = expr ?? node;
        IID.printIidToLoc(lid);
        const actualExpr = expr ?? t.identifier('undefined');
        const ret = jalangiCall('Rt', IID.getIid(), actualExpr);
        transferLoc(ret, lid);
        return ret;
    }
    return expr;
}

function wrapThrow(node, expr) {
    if (!Config.INSTR_THROW || Config.INSTR_THROW(node)) {
        IID.printIidToLoc(expr);
        const ret = jalangiCall('Th', IID.getIid(), expr);
        transferLoc(ret, expr);
        return ret;
    }
    return expr;
}

function wrapWithX1(node, ast) {
    if (!Config.INSTR_END_EXPRESSION || Config.INSTR_END_EXPRESSION(node)) {
        if (!ast || !_EXPRESSION_TYPES.has(ast.type)) return ast;
        IID.printIidToLoc(node);
        const ret = jalangiCall('X1', IID.getIid(), ast);
        transferLoc(ret, node);
        return ret;
    }
    return ast;
}

function wrapHash(node, ast) {
    if (!Config.INSTR_FORIN || Config.INSTR_FORIN(node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('H', IID.getIid(), ast);
        transferLoc(ret, node);
        return ret;
    }
    return ast;
}

function wrapEvalArg(ast) {
    IID.printIidToLoc(ast);
    // J$.instrumentEvalCode(ast, iid, true)
    const ret = callExpr(memberExpr(_jalangiVar, 'instrumentEvalCode'), [ast, IID.getIid(), t.booleanLiteral(true)]);
    transferLoc(ret, ast);
    return ret;
}

function wrapUnaryOp(node, argument, operator) {
    if (!Config.INSTR_UNARY || Config.INSTR_UNARY(operator, node)) {
        IID.printOpIidToLoc(node);
        const ret = jalangiCall('U', IID.getOpIid(), createLiteralAst(operator), argument);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapBinaryOp(node, left, right, operator, isComputed) {
    if (!Config.INSTR_BINARY || Config.INSTR_BINARY(operator, node)) {
        IID.printOpIidToLoc(node);
        const ret = jalangiCall('B',
            IID.getOpIid(), createLiteralAst(operator), left, right,
            t.numericLiteral(createBitPattern(isComputed, false, false))
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapLogicalAnd(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('&&', node)) {
        IID.printCondIidToLoc(node);
        // J$.C(iid, left) ? right : J$._()
        const test = jalangiCall('C', IID.getCondIid(), left);
        const last = callExpr(memberExpr(_jalangiVar, '_'), []);
        const ret = t.conditionalExpression(test, right, last);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapLogicalOr(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('||', node)) {
        IID.printCondIidToLoc(node);
        // J$.C(iid, left) ? J$._() : right
        const test = jalangiCall('C', IID.getCondIid(), left);
        const last = callExpr(memberExpr(_jalangiVar, '_'), []);
        const ret = t.conditionalExpression(test, last, right);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

/**
 * 插桩 nullish coalescing 运算符 (??)。
 *
 * `a ?? b` 语义：a 不为 null/undefined 时取 a，否则取 b。
 * 插桩：(tmp = left, J$.C(iid, tmp != null) ? J$._() : right)
 */
function wrapLogicalNullish(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('??', node)) {
        IID.printCondIidToLoc(node);
        // 每次使用唯一临时变量名，避免嵌套 ?? 运算符共享同一槽
        // 使用 J$.tmp_N（成员属性访问）而非裸标识符，
        // 因为以 RP 开头的裸标识符会被 deepCloneAndReplace 误识别为占位符
        const tmpProp = `tmp_${tmpVarCounter++}`;
        const tmpExpr = memberExpr(_jalangiVar, tmpProp);
        const condIid = IID.getCondIid();

        // tmp = left
        const assign = t.assignmentExpression('=', tmpExpr, left);
        // tmp != null
        const notNull = t.binaryExpression('!=', tmpExpr, t.nullLiteral());
        // J$.C(condIid, tmp != null)
        const condCall = jalangiCall('C', condIid, notNull);
        // J$.C(iid, tmp != null) ? J$._() : right
        const last = callExpr(memberExpr(_jalangiVar, '_'), []);
        const ternary = t.conditionalExpression(condCall, last, right);
        // (tmp = left, J$.C(iid, tmp != null) ? J$._() : right)
        const ret = t.sequenceExpression([assign, ternary]);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapSwitchDiscriminant(node, discriminant) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('switch', node)) {
        IID.printCondIidToLoc(node);
        const ret = jalangiCall('C1', IID.getCondIid(), discriminant);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapSwitchTest(node, test) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('switch', node)) {
        IID.printCondIidToLoc(node);
        const ret = jalangiCall('C2', IID.getCondIid(), test);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapWith(node) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('with', node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('Wi', IID.getIid(), node);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapConditional(node, test) {
    if (node === null) return node;  // for(;;) 的空条件
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('other', node)) {
        IID.printCondIidToLoc(node);
        const ret = jalangiCall('C', IID.getCondIid(), test);
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
        case N_LOG_BIGINT_LIT:    return BigInt(node.value);
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
 *
 * 当 INSTR_TRY_CATCH_ARGUMENTS = () => false 时，函数体没有 J$.Fe 注入，
 * 此时安全地返回 undefined（让调用方生成不含 internalFunId 的 J$.T 调用）。
 */
function getFnIdFromAst(ast) {
    // 函数体的第一个语句可能是：
    //  1. ExpressionStatement(J$.Fe(...)) — 未经 wrapFunBodyWithTryCatch 的原始结构
    //  2. LabeledStatement > WhileStatement > BlockStatement > TryStatement — 经过 wrapFunBodyWithTryCatch 后
    //  3. 其他（当 INSTR_TRY_CATCH_ARGUMENTS 禁用时没有 Fe 注入）→ 返回 undefined
    let entryExpr = ast.body.body[0];

    // 透过 wrapFunBodyWithTryCatch 生成的 jalangiLabel: while(true) { try {...} ... } 结构
    if (entryExpr?.type === 'LabeledStatement'
            && entryExpr.body?.type === 'WhileStatement'
            && entryExpr.body.body?.type === 'BlockStatement') {
        const tryStmt = entryExpr.body.body.body?.[0];
        if (tryStmt?.type === 'TryStatement') {
            entryExpr = tryStmt.block?.body?.[0];
        }
    }

    // 若第一个语句不是 ExpressionStatement，说明 Fe 未被注入（Config 禁用），安全降级
    if (entryExpr?.type !== 'ExpressionStatement') return undefined;
    const call = entryExpr.expression;
    if (call.type !== 'CallExpression') return undefined;
    if (call.callee.type !== 'MemberExpression') return undefined;
    if (call.callee.object.name !== _jalangiVar) return undefined;
    if (call.callee.property.name !== 'Fe') return undefined;
    return call.arguments[0].value;
}

function wrapLiteral(node, ast, funId) {
    if (!Config.INSTR_LITERAL || Config.INSTR_LITERAL(getLiteralValue(funId, node), node)) {
        IID.printIidToLoc(node);
        const hasGetterSetter = ifObjectExpressionHasGetterSetter(node);
        const iidNode     = IID.getIid();
        const funIdNode   = createLiteralAst(funId);
        const getterNode  = t.booleanLiteral(hasGetterSetter);
        let ret;
        if (funId === N_LOG_FUNCTION_LIT) {
            let internalFunId;
            if (node.type === 'FunctionExpression') {
                internalFunId = getFnIdFromAst(node);
            } else if (node.type === 'ArrowFunctionExpression') {
                internalFunId = undefined;
            } else {
                if (node.type !== 'Identifier') throw new Error('IllegalStateException');
                internalFunId = getFnIdFromAst(_scope.funNodes[node.name]);
            }
            if (internalFunId !== undefined) {
                ret = jalangiCall('T', iidNode, ast, funIdNode, getterNode, t.numericLiteral(internalFunId));
            } else {
                ret = jalangiCall('T', iidNode, ast, funIdNode, getterNode);
            }
        } else {
            ret = jalangiCall('T', iidNode, ast, funIdNode, getterNode);
        }
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

// ─── 语句级 wrap ──────────────────────────────────────────────────────────────

function createExpressionStatement(lhs, node) {
    // lhs = node
    const assign = t.assignmentExpression('=', lhs, node);
    const stmt = t.expressionStatement(assign);
    transferLoc(stmt.expression, node);
    return [stmt];
}

function createCallInitAsStatement(node, name, val, isArgumentSync, lhs, isCatchParam, isAssign) {
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
    const bitsNode = t.numericLiteral(createBitPattern(isArgumentSync, false, isCatchParam));
    const callN = jalangiCall('N', IID.getIid(), name, val, bitsNode);
    let exprStmt;
    if (isAssign) {
        const assign = t.assignmentExpression('=', lhs, callN);
        exprStmt = t.expressionStatement(assign);
    } else {
        exprStmt = t.expressionStatement(callN);
    }
    transferLoc(exprStmt.expression, node);
    return [exprStmt];
}

function createCallAsFunEnterStatement(node, scopeId) {
    IID.printIidToLoc(node);
    // arguments.callee 在严格模式下会抛出 TypeError，使用 try-catch 安全降级为 undefined
    // TODO-7: scopeId 作为第五个参数传给 J$.Fe，运行时用于创建 Shadow Frame

    // 构建 probe fn：(function(){try{return arguments.callee}catch(e){return undefined}}())
    // try { return arguments.callee }
    const tryBlock = t.blockStatement([
        t.returnStatement(
            t.memberExpression(t.identifier('arguments'), t.identifier('callee'))
        ),
    ]);
    // catch(e) { return undefined }
    const catchClause = t.catchClause(
        t.identifier('e'),
        t.blockStatement([t.returnStatement(t.identifier('undefined'))])
    );
    const tryStmt = t.tryStatement(tryBlock, catchClause);
    // (function(){ ... }())
    const probeFn = t.functionExpression(null, [], t.blockStatement([tryStmt]));
    const probeCall = t.callExpression(probeFn, []);

    // J$.Fe(iid, probeCall, this, arguments [, scopeId])
    const args = [
        IID.getIid(),
        probeCall,
        t.thisExpression(),
        t.identifier('arguments'),
    ];
    if (scopeId !== undefined && scopeId !== null) {
        args.push(t.numericLiteral(scopeId));
    }

    const feCall = callExpr(memberExpr(_jalangiVar, 'Fe'), args);
    const stmt = t.expressionStatement(feCall);
    transferLoc(stmt.expression, node);

    // 对于【非 async】函数：给 probe fn 添加 __j_probe 标记，
    // 使 wrapFunBodyWithTryCatch 跳过它，防止 probe fn 获得 Fr 却没有 Fe
    // （否则 callIdStack 会多 pop 一次，破坏闭包 Shadow Frame 的 capturedOuterCallId 追踪）。
    //
    // 对于【async】函数：probe fn 必须经过 wrapFunBodyWithTryCatch，
    // 因为 async 函数自身不被 wrapFunBodyWithTryCatch 包裹（避免破坏 await 语义），
    // probe fn 的 Fr 承担了 async 函数退出钩子的职责。
    if (!node.async) {
        probeFn.__j_probe = true;
    }

    return [stmt];
}

function createCallAsScriptEnterStatement(node, instFile, origFile) {
    IID.printIidToLoc(node);
    // J$.Se(iid, instFile, origFile)
    const callSe = jalangiCall('Se', IID.getIid(), createLiteralAst(instFile), createLiteralAst(origFile));
    const stmt = t.expressionStatement(callSe);
    transferLoc(stmt.expression, node);
    return [stmt];
}

// ─── for-in / catch / try-catch 包装（均已迁移至 @babel/types 直接构建）────────
// 以下仍保留 replaceInStatement（大结构，直接构建繁琐且收益低）

let labelCounter = 0;
/** 每次插桩新文件时重置，保证插桩幂等性 */
let tmpVarCounter = 0;

function wrapForIn(node, left, right, body) {
    if (Config.INSTR_FORIN && !Config.INSTR_FORIN(node)) return node;
    IID.printIidToLoc(node);
    const isDeclaration = (left.type === 'VariableDeclaration');
    // logTmpVarName = 'J$._tm_p'（MemberExpression，不是裸标识符）
    // 需要构建 J$._tm_p 的 AST：MemberExpression(J$, _tm_p)
    const tmpNode = memberExpr(_jalangiVar, '_tm_p');
    let forin;
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
        // `name = J$._tm_p` — 作为 AssignmentExpression，供 instrumentStore 处理
        const tmp = t.assignmentExpression('=', t.identifier(name), tmpNode);
        const extra = instrumentStore(tmp, isDeclaration);
        // for (J$._tm_p in right) { var name = wrapWithX1(extra.right); body... }
        const varDecl = t.variableDeclaration('var', [
            t.variableDeclarator(t.identifier(name), wrapWithX1(node, extra.right)),
        ]);
        const innerBody = t.blockStatement([varDecl, ...ensureBlockBody(body)]);
        forin = t.forInStatement(tmpNode, right, innerBody);
    } else {
        // `left = J$._tm_p` — 用 AssignmentExpression 作为 left，供 instrumentStore 处理
        const tmp = t.assignmentExpression('=', left, tmpNode);
        const extra = instrumentStore(tmp, isDeclaration);
        // for (J$._tm_p in right) { wrapWithX1(extra); body... }
        const x1Stmt = t.expressionStatement(wrapWithX1(node, extra));
        const innerBody = t.blockStatement([x1Stmt, ...ensureBlockBody(body)]);
        forin = t.forInStatement(tmpNode, right, innerBody);
    }
    transferLoc(forin, node);
    return forin;
}

/**
 * 将 body（语句数组 或 BlockStatement）转为语句数组。
 */
function ensureBlockBody(body) {
    if (Array.isArray(body)) return body;
    if (body?.type === 'BlockStatement') return body.body;
    return [body];
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

/**
 * 内部工厂：生成 `jalangiLabel: while(true){ try{...} catch(J$e){...} finally{...} }` 骨架。
 *
 * 脚本（isScript=true）与函数（isScript=false）的区别在于 catch 和 finally 的内容：
 *
 *   isScript=true（脚本体）：
 *     catch:   J$.Ex(iid1, J$e); throw J$e;               — re-throw 保持未捕获语义
 *     finally: J$.Sr(iid3) ? { J$.L(); continue } : { J$.L(); break }
 *
 *   isScript=false（函数体）：
 *     catch:   J$.Ex(iid1, J$e);                           — 不 re-throw，让 Fr 正常执行
 *     finally: J$.Fr(iid3) ? continue : return J$.Ra()
 *
 * @param {object}  node      - 当前 AST 节点（用于 IID/loc 记录）
 * @param {Array}   bodyStmts - 原始语句数组
 * @param {boolean} isScript  - true = 脚本体，false = 函数体
 * @returns {Array} 包含一个 LabeledStatement 的数组
 */
function _buildTryCatchWrapper(node, bodyStmts, isScript) {
    IID.printIidToLoc(node);
    const iid1 = IID.getIid();
    IID.printIidToLoc(node);
    const l = labelCounter++;
    const labelId = t.identifier(`jalangiLabel${l}`);
    const eVar = t.identifier(`${_jalangiVar}e`);

    // try { ...body }
    const tryBlock = t.blockStatement(bodyStmts);

    // catch(J$e) { J$.Ex(iid1, J$e); [throw J$e;] }
    const exCall = callExpr(memberExpr(_jalangiVar, 'Ex'), [iid1, eVar]);
    const catchStmts = [t.expressionStatement(exCall)];
    if (isScript) {
        // 脚本体必须 re-throw，保持未捕获异常语义
        catchStmts.push(t.throwStatement(t.cloneNode(eVar)));
    }
    const catchHandler = t.catchClause(eVar, t.blockStatement(catchStmts));

    // finally { ... }
    const iid3 = IID.getIid();
    const contStmt = t.continueStatement(t.cloneNode(labelId));
    let finallyBlock;
    if (isScript) {
        // J$.Sr(iid3) ? { J$.L(); continue } : { J$.L(); break }
        const srCall   = callExpr(memberExpr(_jalangiVar, 'Sr'), [iid3]);
        const lCall1   = t.expressionStatement(callExpr(memberExpr(_jalangiVar, 'L'), []));
        const lCall2   = t.expressionStatement(callExpr(memberExpr(_jalangiVar, 'L'), []));
        const breakStmt = t.breakStatement(t.cloneNode(labelId));
        finallyBlock = t.blockStatement([
            t.ifStatement(
                srCall,
                t.blockStatement([lCall1, contStmt]),
                t.blockStatement([lCall2, breakStmt])
            ),
        ]);
    } else {
        // J$.Fr(iid3) ? continue : return J$.Ra()
        const frCall = callExpr(memberExpr(_jalangiVar, 'Fr'), [iid3]);
        const raCall = callExpr(memberExpr(_jalangiVar, 'Ra'), []);
        finallyBlock = t.blockStatement([
            t.ifStatement(frCall, contStmt, t.returnStatement(raCall)),
        ]);
    }

    const tryStmt = t.tryStatement(tryBlock, catchHandler, finallyBlock);

    // jalangiLabel: while(true) { try {...} catch(...) {...} finally {...} }
    const labeled = t.labeledStatement(
        t.cloneNode(labelId),
        t.whileStatement(t.booleanLiteral(true), t.blockStatement([tryStmt]))
    );
    transferLoc(labeled, node);
    return [labeled];
}

function wrapScriptBodyWithTryCatch(node, body) {
    if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
        const bodyStmts = Array.isArray(body) ? body : [body];
        return _buildTryCatchWrapper(node, bodyStmts, true);
    }
    return body;
}

function wrapFunBodyWithTryCatch(node, body) {
    // Guard: generator 和 async 函数不应进入包裹逻辑。
    if (node.generator || node.async) {
        return body;
    }
    if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
        const bodyStmts = Array.isArray(body) ? body : [body];
        return _buildTryCatchWrapper(node, bodyStmts, false);
    }
    return body;
}

// ─── syncDefuns / instrumentFunctionEntryExit / instrumentScriptEntryExit ────

/** 合法的变量类型集合（模块级常量，避免在循环内反复创建） */
const _KNOWN_VAR_TYPES = new Set(['defun', 'lambda', 'arg', 'var']);

/**
 * 内部核心：遍历 scopeArg.vars，为每个变量生成对应的初始化语句数组。
 *
 * @param {object}  node      - 当前函数/脚本 AST 节点（用于 IID/loc 记录）
 * @param {object}  scopeArg  - Scope 对象（含 .vars / .funLocs / .varKinds）
 * @returns {Array} 生成的语句数组
 */
function _syncVarsCore(node, scopeArg) {
    if (!scopeArg) return [];
    const ret = [];
    for (const name of Object.keys(scopeArg.vars)) {
        const varType = scopeArg.vars[name];
        if (!_KNOWN_VAR_TYPES.has(varType)) {
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
                ret.push(...createCallInitAsStatement(node,
                    createLiteralAst(name),
                    wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT),
                    false, ident, false, true));
            } else {
                ret.push(...createExpressionStatement(ident,
                    wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT)));
            }
        } else if (varType === 'lambda') {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ident = createIdentifierAst(name);
                ident.loc = scopeArg.funLocs[name];
                ret.push(...createCallInitAsStatement(node,
                    createLiteralAst(name), ident, false, ident, false, true));
            }
        } else if (varType === 'arg') {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ident = createIdentifierAst(name);
                ret.push(...createCallInitAsStatement(node,
                    createLiteralAst(name), ident, true, ident, false, true));
            }
        } else if (varType === 'var') {
            const kind = scopeArg.varKinds?.[name];
            if (kind === 'let' || kind === 'const' || kind === 'class') {
                continue;
            }
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                ret.push(...createCallInitAsStatement(node,
                    createLiteralAst(name),
                    createIdentifierAst(name),
                    false, undefined, false, false));
            }
        }
    }
    return ret;
}

/**
 * 普通函数 / 脚本的变量同步。
 *
 * 对非脚本函数（isScript=false），会在变量列表前先注入 arguments 初始化钩子。
 * 箭头函数应使用 syncArrowDefuns（它不注入 arguments）。
 */
function syncDefuns(node, scopeArg, isScript) {
    const ret = [];
    if (!isScript) {
        if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
            if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                // BUG-1 fix: 不对 arguments 直接赋值（严格模式下赋值 arguments 为语法错误）。
                const ident = createIdentifierAst('arguments');
                ret.push(...createCallInitAsStatement(node,
                    createLiteralAst('arguments'), ident, true, undefined, false, false));
            }
        }
    }
    ret.push(..._syncVarsCore(node, scopeArg));
    return ret;
}

function instrumentFunctionEntryExit(node, ast) {
    const scopeId = _scope?.id;
    const body = (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))
        ? createCallAsFunEnterStatement(node, scopeId)
        : [];

    // 对 async 函数：probe fn 需要被 wrapFunBodyWithTryCatch 包裹
    if (node.async && body.length > 0
            && (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))) {
        const feCallExpr = body[0]?.expression;
        const probeFn = feCallExpr?.arguments?.[1]?.callee;
        if (probeFn && probeFn.type === 'FunctionExpression') {
            probeFn.body.body = wrapFunBodyWithTryCatch(probeFn, probeFn.body.body);
        }
    }

    // 对 async 函数：在 J$.Fe() 之后插入 `var __j$ctx = J$.currentCallId`
    const asyncCtxCapture = (node.async && (!Config.INSTR_AWAIT || Config.INSTR_AWAIT(node)))
        ? [_createAsyncCtxCaptureStatement()]
        : [];

    return [...body, ...asyncCtxCapture, ...syncDefuns(node, _scope, false), ...ast];
}

/**
 * 构造 `var __j$ctx = J$.currentCallId` 的 AST 语句节点。
 */
function _createAsyncCtxCaptureStatement() {
    return t.variableDeclaration('var', [
        t.variableDeclarator(
            t.identifier(`${_jalangiVar}__ctx`),
            memberExpr(_jalangiVar, 'currentCallId')
        ),
    ]);
}

/**
 * 仅对箭头函数（ArrowFunctionExpression）的块体执行参数/var 同步。
 * 箭头函数没有独立的 arguments 绑定，不注入 arguments 初始化钩子。
 */
function instrumentArrowFunctionBody(node) {
    if (node.body.type !== 'BlockStatement') return;
    const synced = syncArrowDefuns(node, _scope);
    if (synced.length > 0) {
        node.body.body = [...synced, ...node.body.body];
    }
}

/**
 * 箭头函数的变量同步（跳过 arguments 初始化，复用 _syncVarsCore）。
 */
function syncArrowDefuns(node, scopeArg) {
    return _syncVarsCore(node, scopeArg);
}

function instrumentScriptEntryExit(node, body0, instFile, origFile) {
    const body = (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))
        ? createCallAsScriptEnterStatement(node, instFile, origFile)
        : [];
    return [...body, ...syncDefuns(node, _scope, true), ...body0];
}

// ─── instrumentStore / instrumentLoad / instrumentLoadModStore / instrumentPreIncDec

/**
 * 沿作用域链向上查找变量实际定义的 Scope。
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
        if (ast.name === _jalangiVar) return ast;
        if (_scope.hasVar(ast.name)) {
            const defScope = _findDefScope(_scope, ast.name);
            const isGlobal = _scope.isGlobal(ast.name);

            let decision = null;
            if (_instrDecisions !== null && ast.loc) {
                const loc = ast.loc.start;
                const key = `${_scope.id}:${ast.name}:${loc.line}:${loc.column}`;
                decision = _instrDecisions.get(key) ?? null;
            }

            const isSafeForLightweight =
                defScope !== null &&
                !isGlobal &&
                !defScope.isArrow &&
                defScope.hasOwnVar(ast.name) !== 'catch' &&
                ast.name !== 'arguments';

            if (decision === 'lightweight' && isSafeForLightweight) {
                return wrapReadLightweight(ast, createLiteralAst(ast.name), defScope.id);
            }

            if (decision === null) {
                const canUseLightweight =
                    defScope !== null &&
                    !isGlobal &&
                    !defScope.isArrow &&
                    !_scope.usesEval() &&
                    !_scope.usesWith() &&
                    defScope.hasOwnVar(ast.name) !== 'catch' &&
                    ast.name !== 'arguments';
                if (canUseLightweight) {
                    return wrapReadLightweight(ast, createLiteralAst(ast.name), defScope.id);
                }
            }

            return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isGlobal, defScope?.id);
        } else if (isTypeof) {
            return wrapReadWithUndefinedCheck(ast, ast.name);
        } else {
            return wrapRead(ast, createLiteralAst(ast.name), ast, false, true, false);
        }
    } else if (ast.type === 'MemberExpression') {
        return wrapGetField(ast, ast.object, getPropertyAsAst(ast), ast.computed, false);
    } else if (ast.type === 'OptionalMemberExpression') {
        return wrapGetField(ast, ast.object, getPropertyAsAst(ast), ast.computed, ast.optional);
    }
    return ast;
}

function instrumentLoadModStore(node, isNumber) {
    if (node.left.type === 'Identifier') {
        let tmp0 = instrumentLoad(node.left, false);
        if (isNumber) tmp0 = makeNumber(node, instrumentLoad(tmp0, false));
        const baseOp = node.operator.slice(0, -1);   // '||=' → '||', '+=' → '+', …
        let tmp1 = wrapRHSOfModStore(node.right, tmp0, node.right, baseOp);
        // logical assignment（||= &&= ??=）：生成的 LogicalExpression 不会再被
        // traverse 重新访问，需要在此直接注入 J$.C 钩子。
        if (baseOp === '||') tmp1 = wrapLogicalOr(tmp1, tmp0, node.right);
        else if (baseOp === '&&') tmp1 = wrapLogicalAnd(tmp1, tmp0, node.right);
        else if (baseOp === '??') tmp1 = wrapLogicalNullish(tmp1, tmp0, node.right);
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
        return wrapMethodCall(callAst, ast.object, getPropertyAsAst(ast), isCtor, ast.computed);
    } else if (ast.type === 'Identifier' && ast.name === 'eval') {
        return ast;
    }
    return wrapFunCall(callAst, ast, isCtor);
}

// ─── 初始化（注入 Config）────────────────────────────────────────────────────

/**
 * 在使用任何 wrap 函数前，必须先调用 init(config, jalangiVar?) 注入配置对象。
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
 */
function resetPerFile() {
    labelCounter = 0;
    tmpVarCounter = 0;
}

// ─── 插桩决策表（由 dataflow.js analyzeDefUse 生成，供 instrumentLoad 查询）

let _instrDecisions = null;

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
    N_LOG_NULL_LIT, N_LOG_REGEXP_LIT, N_LOG_UNDEFINED_LIT, N_LOG_BIGINT_LIT,
    // wrap 函数
    wrapPutField, wrapModAssign, wrapMethodCall, wrapFunCall,
    wrapGetField, wrapRead, wrapReadWithUndefinedCheck, wrapReadLightweight,
    wrapWrite, wrapWriteWithUndefinedCheck,
    wrapReturn, wrapThrow, wrapWithX1, wrapHash, wrapEvalArg,
    wrapUnaryOp, wrapBinaryOp, wrapLogicalAnd, wrapLogicalOr, wrapLogicalNullish,
    wrapSwitchDiscriminant, wrapSwitchTest, wrapWith, wrapConditional,
    wrapLiteral, wrapForIn, wrapCatchClause, wrapAwait,
    wrapScriptBodyWithTryCatch, wrapFunBodyWithTryCatch,
    // 高级函数
    instrumentStore, instrumentLoad, instrumentLoadModStore,
    instrumentPreIncDec, adjustIncDec, instrumentCall,
    instrumentFunctionEntryExit, instrumentArrowFunctionBody, instrumentScriptEntryExit,
    createCallAsFunEnterStatement, createCallAsScriptEnterStatement,
    // 内部工具（测试用）
    _findDefScope,
};
