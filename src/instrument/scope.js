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
import _babelTraverse from '@babel/traverse';
// @babel/traverse 是 CJS 模块，ESM 导入需取 .default
const babelTraverse = _babelTraverse.default ?? _babelTraverse;

// ─── ScopeID 计数器 ──────────────────────────────────────────────────────────

let _scopeIdCounter = 0;

/** 每次 instrumentCode 调用前重置，保证 ScopeID 幂等性 */
function resetScopeCounter() {
    _scopeIdCounter = 0;
}

// ─── Scope 类 ─────────────────────────────────────────────────────────────────

/**
 * 词法作用域节点。
 * 保持与 wrappers.js 兼容的接口（vars / funLocs / funNodes / id 等）。
 *
 * @param {Scope|null} parent  - 父作用域；顶层 Program 的父作用域为 null
 * @param {boolean}    isCatch - 是否是 catch 子句产生的特殊作用域
 */
class Scope {
    constructor(parent, isCatch) {
        this.id       = _scopeIdCounter++;
        this.vars     = {};     // name -> 'var' | 'arg' | 'defun' | 'lambda' | 'catch'
        this.funLocs  = {};     // name -> AST loc（仅 defun / lambda）
        this.funNodes = {};     // name -> AST node（仅 defun）
        this.hasEval      = false;
        this.hasArguments = false;
        this.parent  = parent;
        this.isCatch = isCatch;
        this.hasWith_ = false;
        /** @type {boolean} 是否是箭头函数作用域（ArrowFunctionExpression） */
        this.isArrow  = false;
    }

    /**
     * 在作用域中注册一个变量。
     * catch 内部声明的非 catch 变量需要提升到父作用域。
     */
    addVar(name, type, loc, node, kind) {
        const target = (this.isCatch && type !== 'catch') ? this.parent : this;
        // 一旦被标记为 arg，不允许降级为其他类型
        if (target.vars[name] !== 'arg') {
            target.vars[name] = type;
        }
        if (kind) {
            target.varKinds = target.varKinds ?? {};
            target.varKinds[name] = kind;
        }
        if (type === 'defun') {
            target.funLocs[name]  = loc;
            target.funNodes[name] = node;
        }
        if (type === 'lambda') {
            target.funLocs[name] = loc;
        }
    }

    /** 返回变量的声明 kind，沿作用域链向上查找，找不到返回 null */
    getVarKind(name) {
        for (let s = this; s !== null; s = s.parent) {
            if (s.varKinds?.[name]) return s.varKinds[name];
        }
        return null;
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

    /** 标记整条作用域链使用了 with 语句 */
    addWith() {
        for (let s = this; s !== null; s = s.parent) s.hasWith_ = true;
    }

    usesEval()      { return this.hasEval; }
    usesArguments() { return this.hasArguments; }
    usesWith()      { return this.hasWith_; }
}

// ─── arguments 重命名 ─────────────────────────────────────────────────────────

const FROM_NAME = 'arguments';
// 实际重命名目标名（toName）在 addScopes 函数内动态生成：`${jalangiVar}_arguments`

/**
 * 从一个可能是任意模式（pattern）的参数节点中收集所有绑定的标识符名称。
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
 * 递归将解构参数 pattern 中所有名为 fromName 的 Identifier 节点的 name 改为 toName（就地修改 AST）。
 *
 * 必须在 collectParamNames 之前调用，确保作用域表中注册的名称与 wrappers.js 期望一致。
 */
function renameArgumentsInPattern(param, fromName, toName) {
    if (!param) return;
    switch (param.type) {
        case 'Identifier':
            if (param.name === fromName) param.name = toName;
            break;
        case 'RestElement':
            renameArgumentsInPattern(param.argument, fromName, toName);
            break;
        case 'AssignmentPattern':
            renameArgumentsInPattern(param.left, fromName, toName);
            break;
        case 'ObjectPattern':
            for (const prop of param.properties) {
                if (prop.type === 'RestElement') {
                    renameArgumentsInPattern(prop, fromName, toName);
                } else {
                    renameArgumentsInPattern(prop.value, fromName, toName);
                }
            }
            break;
        case 'ArrayPattern':
            for (const el of param.elements) {
                if (el) renameArgumentsInPattern(el, fromName, toName);
            }
            break;
        default:
            break;
    }
}

// ─── addScopes (基于 @babel/traverse) ────────────────────────────────────────

/**
 * 遍历 AST，为每个作用域节点附加 .scope（Jalangi Scope 对象），
 * 并完成 `arguments` → `J$_arguments` 重命名。
 *
 * @param {object} fileOrProgram - 解析得到的 AST（File 节点或 Program 节点均可）
 * @param {string} [jalangiVar]  - 沙盒变量名（默认 JALANGI_VAR）
 */
function addScopes(fileOrProgram, jalangiVar = JALANGI_VAR) {
    const fileNode = (fileOrProgram.type === 'File')
        ? fileOrProgram
        : { type: 'File', program: fileOrProgram, errors: [] };

    const programNode = fileNode.program;

    const toName = `${jalangiVar}_arguments`;
    let currentScope = null;

    // ── 辅助：注册参数到当前作用域 ─────────────────────────────────────────

    function registerParam(param) {
        if (param.type === 'Identifier') {
            if (param.name === FROM_NAME) param.name = toName;
            currentScope.addVar(param.name, 'arg');
        } else {
            // 解构参数中可能含名为 'arguments' 的绑定，先重命名再收集
            renameArgumentsInPattern(param, FROM_NAME, toName);
            const names = [];
            collectParamNames(param, names);
            for (const n of names) currentScope.addVar(n, 'arg');
        }
    }

    // ── 辅助：进入函数作用域 ────────────────────────────────────────────────

    function enterFun(path) {
        const node = path.node;
        const parentScope = currentScope;
        currentScope = new Scope(currentScope, false);
        node.scope = currentScope;

        switch (node.type) {
            case 'FunctionDeclaration':
                if (node.id) parentScope?.addVar(node.id.name, 'defun', node.loc, node);
                node.params.forEach(registerParam);
                break;
            case 'FunctionExpression':
                if (node.id !== null) currentScope.addVar(node.id.name, 'lambda', node.loc);
                node.params.forEach(registerParam);
                break;
            case 'ArrowFunctionExpression':
                currentScope.isArrow = true;
                node.params.forEach(registerParam);
                break;
            case 'ClassMethod':
            case 'ObjectMethod':
                node.params.forEach(registerParam);
                break;
        }
    }

    // ── 辅助：离开作用域 ────────────────────────────────────────────────────

    function exitScope(path) {
        currentScope = currentScope.parent;
    }

    // ── @babel/traverse visitor ─────────────────────────────────────────────

    babelTraverse(fileNode, {
        Program: {
            enter(path) {
                currentScope = new Scope(null, false);
                path.node.scope = currentScope;
            },
            exit: exitScope,
        },
        FunctionDeclaration: {
            enter: enterFun,
            exit:  exitScope,
        },
        FunctionExpression: {
            enter: enterFun,
            exit:  exitScope,
        },
        ArrowFunctionExpression: {
            enter: enterFun,
            exit:  exitScope,
        },
        ClassMethod: {
            enter: enterFun,
            exit:  exitScope,
        },
        ObjectMethod: {
            enter: enterFun,
            exit:  exitScope,
        },

        // class 声明的语义等同于 const（TDZ + 不可重赋值）
        ClassDeclaration: {
            enter(path) {
                if (path.node.id) {
                    currentScope?.addVar(path.node.id.name, 'var', path.node.loc, path.node, 'const');
                }
            },
        },

        // ClassExpression 有 id 时建独立作用域（类名只在类内可见）
        ClassExpression: {
            enter(path) {
                if (path.node.id) {
                    currentScope = new Scope(currentScope, false);
                    path.node.scope = currentScope;
                    currentScope.addVar(path.node.id.name, 'var', path.node.loc, path.node, 'const');
                }
            },
            exit(path) {
                if (path.node.id) {
                    currentScope = currentScope.parent;
                }
            },
        },

        VariableDeclarator: {
            enter(path) {
                const declarationNode = path.parentPath?.node;
                const kind = declarationNode?.kind ?? null;
                const id = path.node.id;
                if (!id) return;
                if (id.type === 'Identifier') {
                    currentScope?.addVar(id.name, 'var', undefined, undefined, kind);
                } else {
                    const names = [];
                    collectParamNames(id, names);
                    for (const n of names) currentScope?.addVar(n, 'var', undefined, undefined, kind);
                }
            },
        },

        CatchClause: {
            enter(path) {
                const node = path.node;
                currentScope = new Scope(currentScope, true);
                node.scope = currentScope;
                if (!node.param) return;
                if (node.param.type === 'Identifier') {
                    currentScope.addVar(node.param.name, 'catch');
                } else {
                    const names = [];
                    collectParamNames(node.param, names);
                    for (const n of names) currentScope.addVar(n, 'catch');
                }
            },
            exit: exitScope,
        },

        Identifier(path) {
            const node = path.node;

            if (node.name === 'eval') {
                currentScope?.addEval();
            }

            // arguments 重命名：只处理 RHS（读取）上下文
            if (node.name === FROM_NAME && path.isReferencedIdentifier()) {
                if (currentScope?.hasOwnVar(toName)) {
                    node.name = toName;
                }
            }
        },

        UpdateExpression(path) {
            const node = path.node;
            if (node.argument.type === 'Identifier'
                    && node.argument.name === FROM_NAME
                    && currentScope?.hasOwnVar(toName)) {
                node.argument.name = toName;
            }
        },

        AssignmentExpression(path) {
            const node = path.node;
            if (node.left.type === 'Identifier'
                    && node.left.name === FROM_NAME
                    && currentScope?.hasOwnVar(toName)) {
                node.left.name = toName;
            }
        },

        WithStatement(path) {
            currentScope?.addWith();
        },
    });
}

export { Scope, addScopes, collectParamNames, resetScopeCounter };
