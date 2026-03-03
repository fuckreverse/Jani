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

// do not remove the following comment
// JALANGI DO NOT INSTRUMENT

/*jslint browser: true */
/*global J$ */

/**
 * Scope 分析模块。
 *
 * 负责：
 *  - 定义 Scope 类（变量类型追踪：var / arg / defun / lambda / catch）
 *  - 实现 addScopes(ast)，对 AST 进行一次前序+后序遍历，为每个
 *    FunctionDeclaration / FunctionExpression / Program / CatchClause
 *    节点附加 .scope 属性
 *  - 处理 `arguments` → `J$_arguments` 的重命名（避免与插桩代码冲突）
 */

if (typeof J$ === 'undefined') {
    J$ = {};
}

(function (sandbox) {
    if (typeof sandbox.addScopes !== 'undefined') {
        return;
    }

    var astUtil = sandbox.astUtil;
    var JALANGI_VAR = sandbox.Constants.JALANGI_VAR;

    function HOP(obj, prop) {
        return Object.prototype.hasOwnProperty.call(obj, prop);
    }

    function MAP(arr, fun) {
        var len = arr.length;
        var res = new Array(len);
        for (var i = 0; i < len; i++) {
            if (i in arr) {
                res[i] = fun(arr[i]);
            }
        }
        return res;
    }

    // ─── Scope 类 ─────────────────────────────────────────────────────────────

    /**
     * 词法作用域节点。
     *
     * @param {Scope|null} parent    - 父作用域，顶层 Program 的父作用域为 null
     * @param {boolean}    isCatch   - 是否是 catch 子句产生的特殊作用域
     */
    function Scope(parent, isCatch) {
        this.vars     = {};       // name -> 'var' | 'arg' | 'defun' | 'lambda' | 'catch'
        this.funLocs  = {};       // name -> AST loc（仅 defun）
        this.funNodes = {};       // name -> AST node（仅 defun）
        this.hasEval      = false;
        this.hasArguments = false;
        this.parent  = parent;
        this.isCatch = isCatch;
    }

    /**
     * 在作用域中注册一个变量。
     * catch 内部声明的非 catch 变量需要提升到父作用域。
     */
    Scope.prototype.addVar = function (name, type, loc, node) {
        var tmpScope = this;
        if (this.isCatch && type !== 'catch') {
            tmpScope = this.parent;
        }
        // 一旦被标记为 arg，不允许降级为其他类型
        if (tmpScope.vars[name] !== 'arg') {
            tmpScope.vars[name] = type;
        }
        if (type === 'defun') {
            tmpScope.funLocs[name]  = loc;
            tmpScope.funNodes[name] = node;
        }
    };

    /** 只在当前作用域中查找（不向上）。*/
    Scope.prototype.hasOwnVar = function (name) {
        if (HOP(this.vars, name)) {
            return this.vars[name];
        }
        return null;
    };

    /** 沿作用域链向上查找。*/
    Scope.prototype.hasVar = function (name) {
        var s = this;
        while (s !== null) {
            if (HOP(s.vars, name)) {
                return s.vars[name];
            }
            s = s.parent;
        }
        return null;
    };

    /**
     * 判断变量是否是全局变量（即只存在于没有父作用域的最外层）。
     */
    Scope.prototype.isGlobal = function (name) {
        var s = this;
        while (s !== null) {
            if (HOP(s.vars, name) && s.parent !== null) {
                return false;
            }
            s = s.parent;
        }
        return true;
    };

    Scope.prototype.addEval = function () {
        var s = this;
        while (s !== null) {
            s.hasEval = true;
            s = s.parent;
        }
    };

    Scope.prototype.addArguments = function () {
        var s = this;
        while (s !== null) {
            s.hasArguments = true;
            s = s.parent;
        }
    };

    Scope.prototype.usesEval      = function () { return this.hasEval; };
    Scope.prototype.usesArguments = function () { return this.hasArguments; };

    // ─── addScopes ────────────────────────────────────────────────────────────

    /**
     * 遍历 AST，为每个作用域节点附加 .scope 属性，并将 `arguments`
     * 标识符重命名为 `J$_arguments`，避免与插桩注入代码冲突。
     *
     * @param {object} ast - acorn 解析得到的 AST（Program 节点）
     */
    function addScopes(ast) {
        var currentScope = null;

        // `arguments` → `J$_arguments` 重命名
        var fromName = 'arguments';
        var toName   = JALANGI_VAR + '_arguments';

        function handleFun(node) {
            var oldScope = currentScope;
            currentScope = new Scope(currentScope, false);
            node.scope = currentScope;

            if (node.type === 'FunctionDeclaration') {
                oldScope.addVar(node.id.name, 'defun', node.loc, node);
                MAP(node.params, function (param) {
                    if (param.name === fromName) {
                        param.name = toName;
                    }
                    currentScope.addVar(param.name, 'arg');
                });
            } else if (node.type === 'FunctionExpression') {
                if (node.id !== null) {
                    currentScope.addVar(node.id.name, 'lambda');
                }
                MAP(node.params, function (param) {
                    if (param.name === fromName) {
                        param.name = toName;
                    }
                    currentScope.addVar(param.name, 'arg');
                });
            }
            // Program 节点：currentScope 即顶层全局作用域，无需注册 id
        }

        function handleVar(node) {
            currentScope.addVar(node.id.name, 'var');
        }

        function handleCatch(node) {
            currentScope = new Scope(currentScope, true);
            node.scope = currentScope;
            currentScope.addVar(node.param.name, 'catch');
        }

        function popScope(node) {
            currentScope = currentScope.parent;
            return node;
        }

        var visitorPre = {
            'Program':             handleFun,
            'FunctionDeclaration': handleFun,
            'FunctionExpression':  handleFun,
            'VariableDeclarator':  handleVar,
            'CatchClause':         handleCatch
        };

        var visitorPost = {
            'Program':             popScope,
            'FunctionDeclaration': popScope,
            'FunctionExpression':  popScope,
            'CatchClause':         popScope,

            // 重命名 arguments → J$_arguments（RHS 读取场景）
            'Identifier': function (node, context) {
                if (context === astUtil.CONTEXT.RHS
                        && node.name === fromName
                        && currentScope && currentScope.hasOwnVar(toName)) {
                    node.name = toName;
                }
                return node;
            },

            // 重命名 arguments → J$_arguments（UpdateExpression 的操作数）
            'UpdateExpression': function (node) {
                if (node.argument.type === 'Identifier'
                        && node.argument.name === fromName
                        && currentScope && currentScope.hasOwnVar(toName)) {
                    node.argument.name = toName;
                }
                return node;
            },

            // 重命名 arguments → J$_arguments（赋值左侧）
            'AssignmentExpression': function (node) {
                if (node.left.type === 'Identifier'
                        && node.left.name === fromName
                        && currentScope && currentScope.hasOwnVar(toName)) {
                    node.left.name = toName;
                }
                return node;
            }
        };

        astUtil.transformAst(ast, visitorPost, visitorPre);
    }

    // ─── 导出 ──────────────────────────────────────────────────────────────────

    sandbox.addScopes = addScopes;
    sandbox.Scope     = Scope;   // 暴露给需要单独使用的场合

}(J$));

// exports J$.addScopes
// exports J$.Scope
// depends on J$.astUtil
// depends on J$.Constants
