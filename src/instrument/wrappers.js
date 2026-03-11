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
 * 负责将插桩钩子注入到各类 AST 节点中，使用 @babel/types 工厂函数直接构建 AST。
 */

import _babelTypes from '@babel/types';
// @babel/types 是 CJS 模块，ESM 导入需取 .default
const t = _babelTypes.default ?? _babelTypes;

import { JALANGI_VAR, HOP } from '../Constants.js';
import * as IID from './iid.js';

// ─── Config 引用（由宿主调用 init(config) 注入，插桩期间只读）────────────────────
let Config;

// ─── 运行时变量名（由 init() 根据 jalangiVar 动态生成）────────────────────────
let _jalangiVar = JALANGI_VAR;

// ─── @babel/types 辅助函数 ───────────────────────────────────────────────────

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

// 模块加载时 _jalangiVar 已通过声明赋初值（JALANGI_VAR），此处无需额外初始化。

// ─── N_LOG_* 字面量类型常量 ────────────────────────────────────────────────────

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
 * 使用精确白名单而非 type.includes('Expression') 字符串检查。
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

// ─── wrap 函数 ─────────────────────────────────────────────────────────────────

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
        const innerCall = jalangiCall('Ca',
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
    if (!Config.INSTR_READ || Config.INSTR_READ(name.value, node)) {
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
    if (!Config.INSTR_READ || Config.INSTR_READ(name.value, node)) {
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
    if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name.value, node)) {
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
    if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name.value, node)) {
        IID.printIidToLoc(node);
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

const _LOGICAL_OPS = new Set(['||', '&&', '??']);
function _isAssignmentOp(op) {
    return op.endsWith('=') && op.length > 1 && !['==', '!=', '<=', '>=', '===', '!=='].includes(op);
}

function wrapRHSOfModStore(node, left, right, op) {
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
    const ret = t.unaryExpression('+', left);
    transferLoc(ret, node);
    return ret;
}

function wrapLHSOfModStore(node, left, right) {
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

/**
 * 用 J$.Xe(iid, expr[, useNames, useScopes]) 包裹表达式语句。
 *
 * @param {object}   node      - ExpressionStatement 节点（提供位置信息）
 * @param {object}   ast       - 要包裹的表达式 AST 节点
 * @param {string[]|null} [useNames]  - 静态 use-set 变量名列表（方案F，可选）
 * @param {number[]|null} [useScopes] - 对应 defScopeId 列表（-1 表示全局）
 */
function wrapWithX1(node, ast, useNames, useScopes) {
    if (!Config.INSTR_END_EXPRESSION || Config.INSTR_END_EXPRESSION(node)) {
        if (!ast || !_EXPRESSION_TYPES.has(ast.type)) return ast;
        IID.printIidToLoc(node);
        const iidNode = IID.getIid();
        let ret;
        if (useNames && useNames.length > 0) {
            // 方案F：将静态 use-set 编码为字符串数组字面量和数字数组字面量
            const namesLit  = t.arrayExpression(useNames.map(n => t.stringLiteral(n)));
            const scopesLit = t.arrayExpression(
                (useScopes ?? useNames.map(() => -1)).map(s => t.numericLiteral(s))
            );
            ret = jalangiCall('Xe', iidNode, ast, namesLit, scopesLit);
        } else {
            ret = jalangiCall('Xe', iidNode, ast);
        }
        transferLoc(ret, node);
        return ret;
    }
    return ast;
}

function wrapHash(node, ast) {
    if (!Config.INSTR_FORIN || Config.INSTR_FORIN(node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('Fi', IID.getIid(), ast);
        transferLoc(ret, node);
        return ret;
    }
    return ast;
}

function wrapEvalArg(ast) {
    IID.printIidToLoc(ast);
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
        // J$.C(iid, left) ? right : J$.Lv()
        const test = jalangiCall('C', IID.getCondIid(), left);
        const last = callExpr(memberExpr(_jalangiVar, 'Lv'), []);
        const ret = t.conditionalExpression(test, right, last);
        transferLoc(ret, node);
        return ret;
    }
    return node;
}

function wrapLogicalOr(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('||', node)) {
        IID.printCondIidToLoc(node);
        // J$.C(iid, left) ? J$.Lv() : right
        const test = jalangiCall('C', IID.getCondIid(), left);
        const last = callExpr(memberExpr(_jalangiVar, 'Lv'), []);
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
 * 插桩：(tmp = left, J$.C(iid, tmp != null) ? J$.Lv() : right)
 *
 * 使用 J$.tmp_N 成员属性而非裸标识符，避免误识别为占位符。
 */
function wrapLogicalNullish(node, left, right) {
    if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('??', node)) {
        IID.printCondIidToLoc(node);
        const tmpProp = `tmp_${tmpVarCounter++}`;
        const tmpExpr = memberExpr(_jalangiVar, tmpProp);
        const condIid = IID.getCondIid();

        const assign = t.assignmentExpression('=', tmpExpr, left);
        const notNull = t.binaryExpression('!=', tmpExpr, t.nullLiteral());
        const condCall = jalangiCall('C', condIid, notNull);
        const last = callExpr(memberExpr(_jalangiVar, 'Lv'), []);
        const ternary = t.conditionalExpression(condCall, last, right);
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
    if (!Config.INSTR_WITH || Config.INSTR_WITH(node)) {
        IID.printIidToLoc(node);
        const ret = jalangiCall('Wt', IID.getIid(), node);
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
        // Babel RegExpLiteral：{ pattern, flags } 字段
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
 * 从已插桩的函数 AST 中提取 J$.Fe 调用的 IID（internalFunId）。
 *
 * 当 INSTR_TRY_CATCH_ARGUMENTS = () => false 时，函数体没有 J$.Fe 注入，
 * 此时安全地返回 undefined。
 */
function getFnIdFromAst(ast) {
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
    const callN = jalangiCall('Dc', IID.getIid(), name, val, bitsNode);
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

function createCallAsFunEnterStatement(node, scopeId, omitThis = false) {
    IID.printIidToLoc(node);

    // 若函数有名为 'arguments' 的形参，scope.js 已将其重命名为 '${jalangiVar}_arguments'
    const renamedArg = `${_jalangiVar}_arguments`;
    const argumentsIdent = (_scope && _scope.hasOwnVar(renamedArg))
        ? t.identifier(renamedArg)
        : t.identifier('arguments');
    // 子类 constructor 在 super() 之前不能访问 this，omitThis=true 时传 undefined
    const disNode = omitThis ? t.identifier('undefined') : t.thisExpression();

    // probe fn：(function(){try{return arguments.callee}catch(e){return undefined}}())
    const tryBlock = t.blockStatement([
        t.returnStatement(
            t.memberExpression(t.identifier('arguments'), t.identifier('callee'))
        ),
    ]);
    const catchClause = t.catchClause(
        t.identifier('e'),
        t.blockStatement([t.returnStatement(t.identifier('undefined'))])
    );
    const tryStmt = t.tryStatement(tryBlock, catchClause);
    const probeFn = t.functionExpression(null, [], t.blockStatement([tryStmt]));
    const probeCall = t.callExpression(probeFn, []);

    const args = [
        IID.getIid(),
        probeCall,
        disNode,
        argumentsIdent,
    ];
    if (scopeId !== undefined && scopeId !== null) {
        args.push(t.numericLiteral(scopeId));
    }

    const feCall = callExpr(memberExpr(_jalangiVar, 'Fe'), args);
    const stmt = t.expressionStatement(feCall);
    transferLoc(stmt.expression, node);

    // 非 async 函数：probe fn 打上 __j_probe 标记，使 wrapFunBodyWithTryCatch 跳过它
    // async 函数：probe fn 需要被 wrapFunBodyWithTryCatch 包裹，承担 async 函数退出钩子
    if (!node.async) {
        probeFn.__j_probe = true;
    }

    return [stmt];
}

function createCallAsScriptEnterStatement(node, instFile, origFile) {
    IID.printIidToLoc(node);
    const callSe = jalangiCall('Se', IID.getIid(), createLiteralAst(instFile), createLiteralAst(origFile));
    const stmt = t.expressionStatement(callSe);
    transferLoc(stmt.expression, node);
    return [stmt];
}

// ─── for-in / catch / try-catch 包装 ────────────────────────────────────────

let labelCounter = 0;
/** 每次插桩新文件时重置，保证插桩幂等性 */
let tmpVarCounter = 0;

function wrapForIn(node, left, right, body) {
    if (Config.INSTR_FORIN && !Config.INSTR_FORIN(node)) return node;
    IID.printIidToLoc(node);
    const isDeclaration = (left.type === 'VariableDeclaration');

    // 使用唯一局部变量替代旧的 J$._tm_p 沙盒属性，消除 for-in J$ 时意外暴露属性的副作用
    const tmpVarName = `${_jalangiVar}_fk${tmpVarCounter++}`;
    const tmpVarDecl = t.variableDeclaration('var', [
        t.variableDeclarator(t.identifier(tmpVarName)),
    ]);
    const tmpNode = t.identifier(tmpVarName);

    let forin;
    if (isDeclaration) {
        // for-in 只支持单个普通标识符声明，不支持解构模式
        const decl = node.left.declarations[0];
        if (!decl || decl.id.type !== 'Identifier') {
            throw new Error(
                `[jalangi] wrapForIn: for-in left-hand side declaration has a non-Identifier pattern ` +
                `(got ${decl?.id?.type ?? 'undefined'}). ` +
                `Destructuring patterns in for-in are not supported.`
            );
        }
        const name = decl.id.name;
        const tmp = t.assignmentExpression('=', t.identifier(name), tmpNode);
        const extra = instrumentStore(tmp, isDeclaration);
        const varDecl = t.variableDeclaration('var', [
            t.variableDeclarator(t.identifier(name), wrapWithX1(node, extra.right)),
        ]);
        const innerBody = t.blockStatement([varDecl, ...ensureBlockBody(body)]);
        forin = t.forInStatement(tmpNode, right, innerBody);
    } else {
        const tmp = t.assignmentExpression('=', left, tmpNode);
        const extra = instrumentStore(tmp, isDeclaration);
        const x1Stmt = t.expressionStatement(wrapWithX1(node, extra));
        const innerBody = t.blockStatement([x1Stmt, ...ensureBlockBody(body)]);
        forin = t.forInStatement(tmpNode, right, innerBody);
    }
    transferLoc(forin, node);
    forin._jalangiTmpVarDecl = tmpVarDecl;
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
 * isScript=true（脚本体）：
 *   catch:   J$.Ex(iid1, J$e); throw J$e;               — re-throw 保持未捕获语义
 *   finally: J$.Sr(iid3) ? { J$.L(); continue } : { J$.L(); break }
 *
 * isScript=false（函数体）：
 *   catch:   J$.Ex(iid1, J$e);                           — 不 re-throw，让 Fr 正常执行
 *   finally: J$.Fr(iid3) ? continue : return J$.Ra()
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

    const tryBlock = t.blockStatement(bodyStmts);

    const exCall = callExpr(memberExpr(_jalangiVar, 'Ex'), [iid1, eVar]);
    const catchStmts = [t.expressionStatement(exCall)];
    if (isScript) {
        catchStmts.push(t.throwStatement(t.cloneNode(eVar)));
    }
    const catchHandler = t.catchClause(eVar, t.blockStatement(catchStmts));

    const iid3 = IID.getIid();
    const contStmt = t.continueStatement(t.cloneNode(labelId));
    let finallyBlock;
    if (isScript) {
        const srCall   = callExpr(memberExpr(_jalangiVar, 'Sr'), [iid3]);
        const lCall1   = t.expressionStatement(callExpr(memberExpr(_jalangiVar, 'L'), []));
        const lCall2   = t.expressionStatement(callExpr(memberExpr(_jalangiVar, 'L'), []));  // L() is @internal
        const breakStmt = t.breakStatement(t.cloneNode(labelId));
        finallyBlock = t.blockStatement([
            t.ifStatement(
                srCall,
                t.blockStatement([lCall1, contStmt]),
                t.blockStatement([lCall2, breakStmt])
            ),
        ]);
    } else {
        const frCall = callExpr(memberExpr(_jalangiVar, 'Fx'), [iid3]);
        const raCall = callExpr(memberExpr(_jalangiVar, 'Rv'), []);
        finallyBlock = t.blockStatement([
            t.ifStatement(frCall, contStmt, t.returnStatement(raCall)),
        ]);
    }

    const tryStmt = t.tryStatement(tryBlock, catchHandler, finallyBlock);

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
                // 若函数有名为 'arguments' 的形参，scope.js 已将其重命名为 '${jalangiVar}_arguments'
                const renamedArg = `${_jalangiVar}_arguments`;
                const argumentsIdent = (_scope && _scope.hasOwnVar(renamedArg))
                    ? createIdentifierAst(renamedArg)
                    : createIdentifierAst('arguments');
                ret.push(...createCallInitAsStatement(node,
                    createLiteralAst('arguments'), argumentsIdent, true, undefined, false, false));
            }
        }
    }
    ret.push(..._syncVarsCore(node, scopeArg));
    return ret;
}

function instrumentFunctionEntryExit(node, ast, omitThis = false) {
    const scopeId = _scope?.id;
    const body = (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))
        ? createCallAsFunEnterStatement(node, scopeId, omitThis)
        : [];

    // async 函数：probe fn 需要被 wrapFunBodyWithTryCatch 包裹
    if (node.async && body.length > 0
            && (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node))) {
        const feCallExpr = body[0]?.expression;
        const probeFn = feCallExpr?.arguments?.[1]?.callee;
        if (probeFn && probeFn.type === 'FunctionExpression') {
            probeFn.body.body = wrapFunBodyWithTryCatch(probeFn, probeFn.body.body);
        }
    }

    // async 函数：在 J$.Fe() 之后插入 `var __j$ctx = J$.currentCallId`
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

            // isGlobal 作为 isScriptLocal 传入：全局作用域中的变量 isScriptLocal = isGlobal
            return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isGlobal, defScope?.id);
        } else if (isTypeof) {
            return wrapReadWithUndefinedCheck(ast, ast.name);
        } else {
            // 未声明变量：isGlobal=false（无法确定全局性），isScriptLocal=true（假定脚本局部全局变量）
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
        const baseOp = node.operator.slice(0, -1);
        let tmp1 = wrapRHSOfModStore(node.right, tmp0, node.right, baseOp);
        // logical assignment（||= &&= ??=）：生成的 LogicalExpression 不会再被 traverse 重新访问，
        // 需要在此直接注入 J$.C 钩子
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
    if (v !== _jalangiVar) _jalangiVar = v;
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

// ─── 语句级 use-set 映射（方案F，由 dataflow.js analyzeStmtUse 生成）

/** @type {WeakMap<object, {names: string[], scopes: number[]}>|null} */
let _stmtUseMap = null;

function setStmtUseMap(map) {
    _stmtUseMap = map;
}

/**
 * 获取 ExpressionStatement 节点的静态 use-set。
 * @param {object} node ExpressionStatement 节点
 * @returns {{names: string[], scopes: number[]} | null}
 */
function getStmtUse(node) {
    return _stmtUseMap?.get(node) ?? null;
}

// ─── 导出 ──────────────────────────────────────────────────────────────────────

export {
    init, resetPerFile, setInstrDecisions, setStmtUseMap, getStmtUse,
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
