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
import { CONTEXT, transformAst } from './astUtil.js';

// ─── Scope 类 ─────────────────────────────────────────────────────────────────

/**
 * 词法作用域节点。
 *
 * @param {Scope|null} parent  - 父作用域；顶层 Program 的父作用域为 null
 * @param {boolean}    isCatch - 是否是 catch 子句产生的特殊作用域
 */
class Scope {
    constructor(parent, isCatch) {
        this.vars     = {};     // name -> 'var' | 'arg' | 'defun' | 'lambda' | 'catch'
        this.funLocs  = {};     // name -> AST loc（仅 defun）
        this.funNodes = {};     // name -> AST node（仅 defun）
        this.hasEval      = false;
        this.hasArguments = false;
        this.parent  = parent;
        this.isCatch = isCatch;
    }

    /**
     * 在作用域中注册一个变量。
     * catch 内部声明的非 catch 变量需要提升到父作用域。
     */
    addVar(name, type, loc, node) {
        const target = (this.isCatch && type !== 'catch') ? this.parent : this;
        // 一旦被标记为 arg，不允许降级为其他类型
        if (target.vars[name] !== 'arg') {
            target.vars[name] = type;
        }
        if (type === 'defun') {
            target.funLocs[name]  = loc;
            target.funNodes[name] = node;
        }
    }

    /** 只在当前作用域中查找（不向上）。*/
    hasOwnVar(name) {
        return HOP(this.vars, name) ? this.vars[name] : null;
    }

    /** 沿作用域链向上查找。*/
    hasVar(name) {
        for (let s = this; s !== null; s = s.parent) {
            if (HOP(s.vars, name)) return s.vars[name];
        }
        return null;
    }

    /** 判断变量是否是全局变量（只存在于没有父作用域的最外层）。*/
    isGlobal(name) {
        for (let s = this; s !== null; s = s.parent) {
            if (HOP(s.vars, name) && s.parent !== null) return false;
        }
        return true;
    }

    addEval() {
        for (let s = this; s !== null; s = s.parent) s.hasEval = true;
    }

    addArguments() {
        for (let s = this; s !== null; s = s.parent) s.hasArguments = true;
    }

    usesEval()      { return this.hasEval; }
    usesArguments() { return this.hasArguments; }
}

// ─── addScopes ────────────────────────────────────────────────────────────────

const FROM_NAME = 'arguments';
const TO_NAME   = `${JALANGI_VAR}_arguments`;

/**
 * 从一个可能是任意模式（pattern）的参数节点中收集所有绑定的标识符名称。
 *
 * 支持 ES6+ 参数格式：
 *  - Identifier          → `x`
 *  - RestElement         → `...rest`
 *  - AssignmentPattern   → `x = 10`（默认值）
 *  - ObjectPattern       → `{a, b}`（对象解构）
 *  - ArrayPattern        → `[x, y]`（数组解构）
 */
function collectParamNames(param, collected) {
    if (!param) return;
    switch (param.type) {
        case 'Identifier':
            collected.push(param.name);
            break;
        case 'RestElement':
            collectParamNames(param.argument, collected);
            break;
        case 'AssignmentPattern':
            collectParamNames(param.left, collected);
            break;
        case 'ObjectPattern':
            for (const prop of param.properties) {
                if (prop.type === 'RestElement') collectParamNames(prop, collected);
                else collectParamNames(prop.value, collected);
            }
            break;
        case 'ArrayPattern':
            for (const el of param.elements) {
                if (el) collectParamNames(el, collected);
            }
            break;
        default:
            break;
    }
}

/**
 * 遍历 AST，为每个作用域节点附加 .scope 属性，并将 `arguments`
 * 标识符重命名为 `J$_arguments`，避免与插桩注入代码冲突。
 *
 * @param {object} ast - acorn 解析得到的 AST（Program 节点）
 */
function addScopes(ast) {
    let currentScope = null;

    /**
     * 处理一个函数参数节点：
     *  1. 简单 Identifier 且名为 `arguments` → 重命名
     *  2. 将其绑定的所有名称注册到当前作用域
     */
    function registerParam(param) {
        if (param.type === 'Identifier') {
            if (param.name === FROM_NAME) param.name = TO_NAME;
            currentScope.addVar(param.name, 'arg');
        } else {
            const names = [];
            collectParamNames(param, names);
            for (const n of names) currentScope.addVar(n, 'arg');
        }
    }

    function handleFun(node) {
        const oldScope = currentScope;
        currentScope = new Scope(currentScope, false);
        node.scope = currentScope;

        switch (node.type) {
            case 'FunctionDeclaration':
                oldScope.addVar(node.id.name, 'defun', node.loc, node);
                node.params.forEach(registerParam);
                break;
            case 'FunctionExpression':
                if (node.id !== null) currentScope.addVar(node.id.name, 'lambda');
                node.params.forEach(registerParam);
                break;
            case 'ArrowFunctionExpression':
                node.params.forEach(registerParam);
                break;
            // Program: currentScope 就是顶层全局作用域
        }
    }

    function handleVar(node) {
        if (!node.id) return;
        if (node.id.type === 'Identifier') {
            currentScope.addVar(node.id.name, 'var');
        } else {
            // 解构声明：收集所有绑定名称
            const names = [];
            collectParamNames(node.id, names);
            for (const n of names) currentScope.addVar(n, 'var');
        }
    }

    function handleCatch(node) {
        currentScope = new Scope(currentScope, true);
        node.scope = currentScope;
        // ES2019+: optional catch binding 时 param 为 null
        if (!node.param) return;
        if (node.param.type === 'Identifier') {
            currentScope.addVar(node.param.name, 'catch');
        } else {
            const names = [];
            collectParamNames(node.param, names);
            for (const n of names) currentScope.addVar(n, 'catch');
        }
    }

    const popScope = (node) => {
        currentScope = currentScope.parent;
        return node;
    };

    const visitorPre = {
        Program:                 handleFun,
        FunctionDeclaration:     handleFun,
        FunctionExpression:      handleFun,
        ArrowFunctionExpression: handleFun,
        VariableDeclarator:      handleVar,
        CatchClause:             handleCatch,
    };

    const visitorPost = {
        Program:                 popScope,
        FunctionDeclaration:     popScope,
        FunctionExpression:      popScope,
        ArrowFunctionExpression: popScope,
        CatchClause:             popScope,

        // 重命名 arguments → J$_arguments（RHS 读取场景）
        Identifier(node, context) {
            if (context === CONTEXT.RHS
                    && node.name === FROM_NAME
                    && currentScope?.hasOwnVar(TO_NAME)) {
                node.name = TO_NAME;
            }
            return node;
        },

        // UpdateExpression 操作数
        UpdateExpression(node) {
            if (node.argument.type === 'Identifier'
                    && node.argument.name === FROM_NAME
                    && currentScope?.hasOwnVar(TO_NAME)) {
                node.argument.name = TO_NAME;
            }
            return node;
        },

        // 赋值左侧
        AssignmentExpression(node) {
            if (node.left.type === 'Identifier'
                    && node.left.name === FROM_NAME
                    && currentScope?.hasOwnVar(TO_NAME)) {
                node.left.name = TO_NAME;
            }
            return node;
        },
    };

    transformAst(ast, visitorPost, visitorPre);
}

export { Scope, addScopes, collectParamNames };
