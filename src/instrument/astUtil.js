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

import { HOP, JALANGI_VAR } from '../Constants.js';

// 当前沙盒变量名，由 esnstrument.js 的 init() 通过 setJalangiVar() 同步
let _jalangiVar = JALANGI_VAR;

/**
 * 更新 astUtil 使用的沙盒变量名。
 * 必须在插桩之前由 esnstrument.init() 调用。
 * @param {string} v  新的变量名
 */
function setJalangiVar(v) { _jalangiVar = v; }

/**
 * AST 遍历上下文枚举。
 * 用于告知 visitor 当前节点所处的语义环境。
 */
const CONTEXT = Object.freeze({
    RHS:    1,  // 右值（读取）上下文
    IGNORE: 2,  // 忽略（不插桩）上下文，如赋值左侧、标签名
    OEXP:   3,  // ObjectExpression 的 properties 列表
    PARAMS: 4,  // 函数形参列表
    OEXP2:  5,  // ObjectExpression 的某个 Property 节点
    GETTER: 6,  // getter 函数体
    SETTER: 7,  // setter 函数体
    TYPEOF: 8,  // typeof 操作数
    METHOD: 9,  // ES6+ class 方法的 FunctionExpression
});

/**
 * 判断是否应忽略该子 AST（J$.I() 调用不需要再插桩）。
 */
function ignoreSubAst(node) {
    return node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier'
        && node.callee.object.name === _jalangiVar
        && node.callee.property.type === 'Identifier'
        && node.callee.property.name === 'I';
}

/**
 * 通用 AST 遍历器，支持前序（visitorPre）和后序（visitorPost）访问。
 *
 * visitorPost 中每个方法的返回值将替换原来的节点。
 * visitorPre 中的返回值被忽略（仅用于副作用，如压栈）。
 *
 * @param {object}  object      - 当前 AST 节点
 * @param {object}  visitorPost - 后序访问者对象
 * @param {object}  visitorPre  - 前序访问者对象
 * @param {number}  context     - 当前上下文（CONTEXT 枚举值）
 * @param {boolean} noIgnore    - 为 true 时不跳过任何子树
 */
function transformAst(object, visitorPost, visitorPre, context, noIgnore) {
    const type = object.type;

    if (visitorPre && HOP(visitorPre, type)) {
        visitorPre[type](object, context);
    }

    for (const key of Object.keys(object)) {
        const child = object[key];
        if (typeof child !== 'object' || child === null || key === 'scope') continue;
        if (!noIgnore && ignoreSubAst(object)) continue;

        let newContext;

        if (
            (type === 'AssignmentExpression'  && key === 'left') ||
            (type === 'UpdateExpression'      && key === 'argument') ||
            (type === 'UnaryExpression'       && key === 'argument' && object.operator === 'delete') ||
            (type === 'ForInStatement'        && key === 'left') ||
            (type === 'ForOfStatement'        && key === 'left') ||
            ((type === 'FunctionExpression' || type === 'FunctionDeclaration') && key === 'id') ||
            (type === 'ArrowFunctionExpression' && key === 'id') ||
            ((type === 'ClassDeclaration' || type === 'ClassExpression') && key === 'id') ||
            (type === 'ImportSpecifier'         && (key === 'local' || key === 'imported')) ||
            (type === 'ImportDefaultSpecifier'  && key === 'local') ||
            (type === 'ImportNamespaceSpecifier'&& key === 'local') ||
            (type === 'ExportSpecifier'         && (key === 'local' || key === 'exported')) ||
            (type === 'LabeledStatement'        && key === 'label') ||
            (type === 'BreakStatement'          && key === 'label') ||
            (type === 'CatchClause'             && key === 'param') ||
            (type === 'ContinueStatement'       && key === 'label') ||
            ((type === 'CallExpression' || type === 'NewExpression') &&
                key === 'callee' &&
                (object.callee.type === 'MemberExpression' ||
                 (object.callee.type === 'Identifier' && object.callee.name === 'eval'))) ||
            (type === 'VariableDeclarator'      && key === 'id') ||
            (type === 'MemberExpression'        && !object.computed && key === 'property') ||
            (type === 'Property'                && key === 'key' && !object.computed) ||
            (type === 'RestElement'             && key === 'argument') ||
            (type === 'AssignmentPattern'       && key === 'left') ||
            (type === 'PropertyDefinition'      && key === 'key' && !object.computed) ||
            (type === 'MethodDefinition'        && key === 'key' && !object.computed)
        ) {
            newContext = CONTEXT.IGNORE;
        } else if (type === 'ObjectExpression' && key === 'properties') {
            newContext = CONTEXT.OEXP;
        } else if (
            (type === 'FunctionExpression' || type === 'FunctionDeclaration' || type === 'ArrowFunctionExpression') &&
            key === 'params'
        ) {
            newContext = CONTEXT.PARAMS;
        } else if (context === CONTEXT.OEXP) {
            newContext = CONTEXT.OEXP2;
        } else if (context === CONTEXT.OEXP2 && key === 'key') {
            newContext = CONTEXT.IGNORE;
        } else if (context === CONTEXT.PARAMS) {
            newContext = CONTEXT.IGNORE;
        } else if (object.key && key === 'value' && object.kind === 'get') {
            newContext = CONTEXT.GETTER;
        } else if (object.key && key === 'value' && object.kind === 'set') {
            newContext = CONTEXT.SETTER;
        } else if (type === 'MethodDefinition' && key === 'value') {
            newContext = CONTEXT.METHOD;
        } else if (type === 'CallExpression' && key === 'callee' && child.type === 'Identifier' && child.name === 'eval') {
            newContext = CONTEXT.IGNORE;
        } else if (type === 'UnaryExpression' && key === 'argument' && object.operator === 'typeof' && child.type === 'Identifier') {
            newContext = CONTEXT.TYPEOF;
        } else {
            newContext = CONTEXT.RHS;
        }

        if (key !== 'bodyOrig') {
            object[key] = transformAst(child, visitorPost, visitorPre, newContext, noIgnore);
        }
    }

    if (visitorPost && HOP(visitorPost, type)) {
        const ret = visitorPost[type](object, context);
        if (ret === undefined) {
            throw new Error(
                `[jalangi] transformAst: visitor for "${type}" returned undefined. Did you forget to return the node?`
            );
        }
        return ret;
    }
    return object;
}

/**
 * 从已插桩的 AST 中构建 iid -> AST 节点的映射表。
 * 会将 AST 中 J$ 函数调用替换为 SymbolicReference（节省空间）。
 */
function serialize(root) {
    let parentFunOrScript = root;
    const iidToAstTable = {};

    const handleFun = (node) => { parentFunOrScript = node; };

    const visitorPre = {
        Program:             handleFun,
        FunctionDeclaration: handleFun,
        FunctionExpression:  handleFun,
    };

    function canMakeSymbolic(node) {
        if (!node.callee.object) return false;
        const { callee } = node;
        return callee.object.name === _jalangiVar
            && callee.property.name !== 'instrumentCode'
            && callee.property.name !== 'getConcrete'
            && callee.property.name !== 'I'
            && !!node.arguments[0];
    }

    function setSerializedAST(iid, ast) {
        iidToAstTable[iid] ??= {};
        iidToAstTable[iid].serializedAST = ast;
    }

    const visitorPost = {
        CallExpression(node) {
            try {
                if (node.callee.object?.name === _jalangiVar &&
                    (node.callee.property.name === 'Se' || node.callee.property.name === 'Fe')) {
                    setSerializedAST(node.arguments[0].value, parentFunOrScript);
                    return node;
                } else if (canMakeSymbolic(node)) {
                    setSerializedAST(node.arguments[0].value, node);
                    return { type: 'SymbolicReference', value: node.arguments[0].value };
                }
                return node;
            } catch (e) {
                console.error(JSON.stringify(node));
                throw e;
            }
        },
    };

    transformAst(root, visitorPost, visitorPre);
    return iidToAstTable;
}

/**
 * 将 serialize() 产生的 SymbolicReference 节点还原为实际 AST 节点。
 */
function deserialize(iidToAstTable) {
    for (const iid of Object.keys(iidToAstTable)) {
        const curAst = iidToAstTable[iid].serializedAST;
        if (!curAst) continue;
        const visitorPost = {
            SymbolicReference(node) {
                const target = iidToAstTable[node.value]?.serializedAST;
                if (!target) throw new Error('bad symbolic reference');
                return target;
            },
        };
        transformAst(curAst, visitorPost);
    }
}

/**
 * 给定已插桩的 AST，返回所有"顶层表达式"对应的 IID 列表。
 */
function computeTopLevelExpressions(ast) {
    let exprDepth = 0;
    const exprDepthStack = [];
    const topLevelExprs  = [];

    const TOP_LEVEL_OPS = new Set(['A','P','G','R','W','H','T','Rt','B','U','C','C1','C2']);

    const visitorPre = {
        CallExpression(node) {
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.type === 'Identifier' &&
                node.callee.object.name === _jalangiVar) {
                const name = node.callee.property.name;
                if ((exprDepth === 0 && TOP_LEVEL_OPS.has(name)) ||
                    (exprDepth === 1 && (name === 'F' || name === 'M'))) {
                    topLevelExprs.push(node.arguments[0].value);
                }
                exprDepth++;
            } else if (
                node.callee.type === 'CallExpression' &&
                node.callee.callee.type === 'MemberExpression' &&
                node.callee.callee.object.name === _jalangiVar &&
                (node.callee.callee.property.name === 'F' || node.callee.callee.property.name === 'M')
            ) {
                exprDepth++;
            }
        },
        FunctionExpression() { exprDepthStack.push(exprDepth); exprDepth = 0; },
        FunctionDeclaration() { exprDepthStack.push(exprDepth); exprDepth = 0; },
    };

    const visitorPost = {
        CallExpression(node) {
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.name === _jalangiVar) {
                exprDepth--;
            } else if (
                node.callee.type === 'CallExpression' &&
                node.callee.callee.type === 'MemberExpression' &&
                node.callee.callee.object.name === _jalangiVar &&
                (node.callee.callee.property.name === 'F' || node.callee.callee.property.name === 'M')
            ) {
                exprDepth--;
            }
            return node;
        },
        FunctionExpression(node) { exprDepth = exprDepthStack.pop(); return node; },
        FunctionDeclaration(node) { exprDepth = exprDepthStack.pop(); return node; },
    };

    transformAst(ast, visitorPost, visitorPre, CONTEXT.RHS);
    return topLevelExprs;
}

export { CONTEXT, transformAst, serialize, deserialize, computeTopLevelExpressions, setJalangiVar };
