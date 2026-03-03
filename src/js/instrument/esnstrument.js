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

// Author: Koushik Sen

// do not remove the following comment
// JALANGI DO NOT INSTRUMENT

/*jslint browser: true */
/*global astUtil acorn esotope J$ */

/**
 * Jalangi2 插桩入口模块（浏览器版）。
 *
 * 职责：
 *  1. 定义 AST visitor（visitorRRPre / visitorRRPost / visitorOps / visitorCloneBodyPre / visitorMergeBodyPre）
 *  2. 实现 hoistFunctionDeclaration（兼容 Firefox 的函数声明提升）
 *  3. 实现 instrumentCode(options) —— 主要对外 API
 *  4. 实现 instrumentEvalCode(code, iid, isDirect) —— eval 插桩包装
 *
 * 依赖的子模块（需在本文件之前加载）：
 *  - J$.IIDManager  （iid.js）
 *  - J$.addScopes   （scope.js）
 *  - J$.Wrappers    （wrappers.js）
 *  - J$.astUtil
 *  - J$.Config
 *  - J$.Constants
 *  - acorn          （全局，由页面或构建工具注入）
 *  - esotope        （全局，由页面或构建工具注入）
 */

if (typeof J$ === 'undefined') {
    J$ = {};
}

(function (sandbox) {
    if (typeof sandbox.instrumentCode !== 'undefined') {
        return;
    }

    var astUtil   = sandbox.astUtil;
    var Config    = sandbox.Config;
    var Constants = sandbox.Constants;
    var IID       = sandbox.IIDManager;
    var W         = sandbox.Wrappers;   // wrap 函数库

    var JALANGI_VAR = Constants.JALANGI_VAR;

    // JSON 使用全局对象的原生版本，防止被用户分析修改
    var _global = (function () { return this; }()) || globalThis;
    var JSON = {
        parse:     _global.JSON.parse.bind(_global.JSON),
        stringify: _global.JSON.stringify.bind(_global.JSON)
    };

    // ─── 字面量类型常量（本地别名）────────────────────────────────────────────

    var N_LOG_ARRAY_LIT     = W.N_LOG_ARRAY_LIT;
    var N_LOG_OBJECT_LIT    = W.N_LOG_OBJECT_LIT;
    var N_LOG_FUNCTION_LIT  = W.N_LOG_FUNCTION_LIT;
    var N_LOG_NUMBER_LIT    = W.N_LOG_NUMBER_LIT;
    var N_LOG_STRING_LIT    = W.N_LOG_STRING_LIT;
    var N_LOG_BOOLEAN_LIT   = W.N_LOG_BOOLEAN_LIT;
    var N_LOG_NULL_LIT      = W.N_LOG_NULL_LIT;
    var N_LOG_REGEXP_LIT    = W.N_LOG_REGEXP_LIT;
    var N_LOG_UNDEFINED_LIT = W.N_LOG_UNDEFINED_LIT;

    // ─── RegExp 序列化（用于 JSON 缓存 IID 时序列化 AST）─────────────────────

    function regExpToJSON() {
        return {
            type:       'J$.AST.REGEXP',
            value:      this.source,
            glb:        this.global,
            ignoreCase: this.ignoreCase,
            multiline:  this.multiline
        };
    }

    function JSONStringifyHandler(key, value) {
        if (key === 'scope')          return undefined;
        if (value instanceof RegExp)  return regExpToJSON.call(value);
        return value;
    }

    function JSONParseHandler(key, value) {
        if (typeof value === 'object' && value && value.type === 'J$.AST.REGEXP') {
            var flags = '';
            if (value.glb)        flags += 'g';
            if (value.ignoreCase) flags += 'i';
            if (value.multiline)  flags += 'm';
            return RegExp(value.value, flags);
        }
        return value;
    }

    function clone(src) {
        return JSON.parse(JSON.stringify(src, JSONStringifyHandler), JSONParseHandler);
    }

    // ─── visitor：克隆函数体（用于 ENABLE_SAMPLING 模式）──────────────────────

    var visitorCloneBodyPre = {
        'FunctionExpression': function (node) {
            node.bodyOrig = clone(node.body);
            return node;
        },
        'FunctionDeclaration': function (node) {
            node.bodyOrig = clone(node.body);
            return node;
        }
    };

    // ─── visitor：合并采样函数体（用于 ENABLE_SAMPLING 模式）──────────────────

    function mergeBodies(node) {
        IID.printIidToLoc(node);
        var iid = IID.getIid();
        var JALANGI_VAR_local = JALANGI_VAR;
        // 内联构建 AST，避免对模板字符串的额外 parse
        var test = {
            type: 'UnaryExpression',
            operator: '!',
            prefix: true,
            argument: {
                type: 'CallExpression',
                callee: {
                    type: 'MemberExpression',
                    object: {type: 'Identifier', name: JALANGI_VAR_local},
                    property: {type: 'Identifier', name: 'S'},
                    computed: false
                },
                arguments: [iid, {type: 'MemberExpression', object: {type: 'Identifier', name: 'arguments'}, property: {type: 'Identifier', name: 'callee'}, computed: false}]
            }
        };
        node.body.body = [{
            type: 'IfStatement',
            test: test,
            consequent: node.bodyOrig,
            alternate: node.body
        }];
        delete node.bodyOrig;
        return node;
    }

    var visitorMergeBodyPre = {
        'FunctionExpression': mergeBodies,
        'FunctionDeclaration': mergeBodies
    };

    // ─── visitor：作用域绑定（Pre）────────────────────────────────────────────

    var visitorRRPre = {
        'Program':             W.setScope,
        'FunctionDeclaration': W.setScope,
        'FunctionExpression':  W.setScope,
        'CatchClause':         W.setScope
    };

    // ─── visitor：主插桩变换（Post）───────────────────────────────────────────

    var visitorRRPost = {
        'Literal': function (node, context) {
            if (context !== astUtil.CONTEXT.RHS) return node;
            var litType;
            switch (typeof node.value) {
                case 'number':  litType = N_LOG_NUMBER_LIT;  break;
                case 'string':  litType = N_LOG_STRING_LIT;  break;
                case 'boolean': litType = N_LOG_BOOLEAN_LIT; break;
                case 'object':
                    litType = (node.value === null) ? N_LOG_NULL_LIT : N_LOG_REGEXP_LIT;
                    break;
            }
            return W.wrapLiteral(node, node, litType);
        },

        'Program': function (node) {
            var ret = W.instrumentScriptEntryExit(
                node, node.body,
                IID.getInstCodeFileName(),
                IID.getOrigCodeFileName()
            );
            node.body = ret;
            W.popScope();
            return node;
        },

        'VariableDeclaration': function (node) {
            node.declarations = node.declarations.map(function (def) {
                if (def.init !== null) {
                    var init = W.wrapWrite(def.init, W.createLiteralAst(def.id.name), def.init, def.id,
                        false, W.getScope().isGlobal(def.id.name), true);
                    init = W.wrapWithX1(def.init, init);
                    def.init = init;
                }
                return def;
            });
            return node;
        },

        'NewExpression': function (node) {
            var ret = {
                type: 'CallExpression',
                callee: W.instrumentCall(node, true),
                arguments: node.arguments
            };
            W.transferLoc(ret, node);
            return ret;
        },

        'CallExpression': function (node) {
            var isEval = node.callee.type === 'Identifier' && node.callee.name === 'eval';
            node.callee = W.instrumentCall(node, false);
            if (isEval) {
                node.arguments = node.arguments.map(W.wrapEvalArg);
            }
            return node;
        },

        'AssignmentExpression': function (node) {
            if (node.operator === '=') {
                return W.instrumentStore(node, false);
            } else {
                return W.instrumentLoadModStore(node);
            }
        },

        'UpdateExpression': function (node) {
            var ret1 = W.instrumentPreIncDec(node);
            if (!node.prefix) {
                ret1 = W.adjustIncDec(node.operator, ret1);
            }
            return ret1;
        },

        'FunctionExpression': function (node, context) {
            node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
            var ret1;
            if (context === astUtil.CONTEXT.GETTER || context === astUtil.CONTEXT.SETTER) {
                ret1 = node;
            } else {
                ret1 = W.wrapLiteral(node, node, N_LOG_FUNCTION_LIT);
            }
            W.popScope();
            return ret1;
        },

        'FunctionDeclaration': function (node) {
            node.body.body = W.instrumentFunctionEntryExit(node, node.body.body);
            W.popScope();
            return node;
        },

        'ObjectExpression': function (node) {
            return W.wrapLiteral(node, node, N_LOG_OBJECT_LIT);
        },

        'ArrayExpression': function (node) {
            return W.wrapLiteral(node, node, N_LOG_ARRAY_LIT);
        },

        'ThisExpression': function (node) {
            return W.wrapRead(node, W.createLiteralAst('this'), node, false, false, false);
        },

        'Identifier': function (node, context) {
            if (context === astUtil.CONTEXT.RHS) {
                return W.instrumentLoad(node, false);
            } else if (context === astUtil.CONTEXT.TYPEOF) {
                return W.instrumentLoad(node, true);
            }
            return node;
        },

        'MemberExpression': function (node, context) {
            if (context === astUtil.CONTEXT.RHS) {
                return W.instrumentLoad(node, false);
            }
            return node;
        },

        'SequenceExpression': function (node) {
            var len = node.expressions.length;
            for (var i = 0; i < len - 1; i++) {
                node.expressions[i] = W.wrapWithX1(node.expressions[i], node.expressions[i]);
            }
            return node;
        },

        'ForInStatement': function (node) {
            node.right = W.wrapHash(node.right, node.right);
            node = W.wrapForIn(node, node.left, node.right, node.body);
            return node;
        },

        'CatchClause': function (node) {
            W.wrapCatchClause(node, node.body.body, node.param.name);
            W.popScope();
            return node;
        },

        'ReturnStatement': function (node) {
            var ret = W.wrapReturn(node, node.argument);
            node.argument = W.wrapWithX1(node, ret);
            return node;
        },

        'ThrowStatement': function (node) {
            var ret = W.wrapThrow(node, node.argument);
            node.argument = W.wrapWithX1(node, ret);
            return node;
        },

        'ExpressionStatement': function (node) {
            node.expression = W.wrapWithX1(node, node.expression);
            return node;
        }
    };

    // ─── visitor：运算符插桩（Post）───────────────────────────────────────────

    function funCond(node) {
        node.test = W.wrapConditional(node.test, node.test);
        node.test = W.wrapWithX1(node, node.test);
        node.init   = W.wrapWithX1(node, node.init);
        node.update = W.wrapWithX1(node, node.update);
        return node;
    }

    var visitorOps = {
        'Program': function (node) {
            node.body = W.wrapScriptBodyWithTryCatch(node, node.body);
            return node;
        },

        'BinaryExpression': function (node) {
            return W.wrapBinaryOp(node, node.left, node.right, node.operator);
        },

        'LogicalExpression': function (node) {
            if (node.operator === '&&') return W.wrapLogicalAnd(node, node.left, node.right);
            if (node.operator === '||') return W.wrapLogicalOr(node, node.left, node.right);
            return node;
        },

        'UnaryExpression': function (node) {
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

        'SwitchStatement': function (node) {
            var dis = W.wrapSwitchDiscriminant(node.discriminant, node.discriminant);
            dis = W.wrapWithX1(node.discriminant, dis);
            node.cases = node.cases.map(function (acase) {
                if (acase.test) {
                    var test = W.wrapSwitchTest(acase.test, acase.test);
                    acase.test = W.wrapWithX1(acase.test, test);
                }
                return acase;
            });
            node.discriminant = dis;
            return node;
        },

        'FunctionExpression': function (node) {
            node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
            return node;
        },

        'FunctionDeclaration': function (node) {
            node.body.body = W.wrapFunBodyWithTryCatch(node, node.body.body);
            return node;
        },

        'WithStatement': function (node) {
            node.object = W.wrapWith(node.object);
            return node;
        },

        'ConditionalExpression': funCond,
        'IfStatement':           funCond,
        'WhileStatement':        funCond,
        'DoWhileStatement':      funCond,
        'ForStatement':          funCond
    };

    // ─── 函数声明提升（Firefox 兼容）──────────────────────────────────────────

    /**
     * 将 FunctionDeclaration 节点提升到每个作用域 body 的最前面
     * （紧接在 J$.Se / J$.Fe 调用之后），以匹配浏览器的实际求值顺序。
     *
     * @param {object}   ast                - 要处理的 AST 节点
     * @param {string[]} hoistedFunctions   - 收集被提升的函数名（用于调试）
     */
    function hoistFunctionDeclaration(ast, hoistedFunctions) {
        if (ast.body) {
            var newBody = [];
            var startIndex = 0;

            // 跳过 J$.Se / J$.Fe 调用（必须保持在最前面）
            if (ast.body.length > 0) {
                var first = ast.body[0];
                if (first.type === 'ExpressionStatement'
                        && first.expression.type === 'CallExpression'
                        && first.expression.callee.object
                        && first.expression.callee.object.name === 'J$'
                        && first.expression.callee.property
                        && (first.expression.callee.property.name === 'Se'
                            || first.expression.callee.property.name === 'Fe')) {
                    newBody.push(first);
                    startIndex = 1;
                }
            }

            // 先放 FunctionDeclaration
            for (var i = startIndex; i < ast.body.length; i++) {
                if (ast.body[i].type === 'FunctionDeclaration') {
                    newBody.push(ast.body[i]);
                    if (newBody.length !== i + 1) {
                        hoistedFunctions.push(ast.body[i].id.name);
                    }
                }
            }
            // 再放其余语句
            for (var j = startIndex; j < ast.body.length; j++) {
                if (ast.body[j].type !== 'FunctionDeclaration') {
                    newBody.push(ast.body[j]);
                }
            }

            ast.body.length = 0;
            for (var k = 0; k < newBody.length; k++) {
                ast.body.push(newBody[k]);
            }
        }

        // 递归处理子节点
        for (var key in ast) {
            if (ast.hasOwnProperty(key) && key !== 'scope') {
                var child = ast[key];
                if (child && typeof child === 'object') {
                    hoistFunctionDeclaration(child, hoistedFunctions);
                }
            }
        }
        return ast;
    }

    // ─── AST 转换主流程 ────────────────────────────────────────────────────────

    function transformString(code, visitorsPost, visitorsPre) {
        // ecmaVersion 2020（ES2020）：包含可选链(?.)、空值合并(??)、BigInt 等。
        // 当升级到 acorn 8+ 时，可改为 'latest' 以自动跟进最新 ES 标准。
        var newAst = acorn.parse(code, {locations: true, ecmaVersion: 2020});
        sandbox.addScopes(newAst);
        var len = visitorsPost.length;
        for (var i = 0; i < len; i++) {
            newAst = astUtil.transformAst(newAst, visitorsPost[i], visitorsPre[i], astUtil.CONTEXT.RHS);
        }
        return newAst;
    }

    // ─── 主 API ────────────────────────────────────────────────────────────────

    // 如果代码中包含此字符串，跳过插桩
    var noInstr = '// JALANGI DO NOT INSTRUMENT';

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
     *   isDirect:         boolean    // eval 是否是直接调用
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
        var aret, skip = false;
        var isEval        = options.isEval;
        var code          = options.code;
        var thisIid       = options.thisIid;
        var inlineSource  = options.inlineSource;
        var url           = options.url;

        // 初始化 IID 计数器及文件名
        IID.initialize(
            isEval,
            options.instCodeFileName,
            options.origCodeFileName
        );

        // pre-hook（允许分析修改代码或跳过插桩）
        if (sandbox.analysis && sandbox.analysis.instrumentCodePre) {
            aret = sandbox.analysis.instrumentCodePre(thisIid, code, options.isDirect);
            if (aret) {
                code  = aret.code;
                skip  = aret.skip;
            }
        }

        var newAst;
        if (!skip && typeof code === 'string' && code.indexOf(noInstr) < 0) {
            try {
                // 注意：shebang（#!）仅出现在 Node.js 脚本首行，浏览器中不会遇到，
                // 故此处不做 removeShebang 处理。

                if (Config.ENABLE_SAMPLING) {
                    newAst = transformString(code,
                        [visitorCloneBodyPre, visitorRRPost, visitorOps, visitorMergeBodyPre],
                        [undefined,           visitorRRPre,  undefined,  undefined]);
                } else {
                    newAst = transformString(code,
                        [visitorRRPost, visitorOps],
                        [visitorRRPre,  undefined]);
                }

                // 提升函数声明（Firefox 兼容）
                var hoistedFcts = [];
                newAst = hoistFunctionDeclaration(newAst, hoistedFcts);

                var newCode = esotope.generate(newAst, {comment: true, parse: acorn.parse});
                code = newCode + '\n' + noInstr + '\n';
            } catch (ex) {
                console.log('Failed to instrument', code);
                throw ex;
            }
        }

        // 构建 source map 信息
        var sourceInfo = IID.getSourceInfo();
        if (url)          sourceInfo.url      = url;
        if (isEval) {
            sourceInfo.evalSid = sandbox.sid;
            sourceInfo.evalIid = thisIid;
        }
        if (inlineSource) sourceInfo.code = options.code;

        var sourceMapString = JSON.stringify(sourceInfo);

        // 精简版 source map 头（不含逐行位置，只有元数据）
        var tmp = {
            nBranches:              sourceInfo.nBranches,
            originalCodeFileName:   sourceInfo.originalCodeFileName,
            instrumentedCodeFileName: sourceInfo.instrumentedCodeFileName
        };
        if (url)    tmp.url = url;
        if (isEval) { tmp.evalSid = sourceInfo.evalSid; tmp.evalIid = thisIid; }

        var instCode;
        if (options.inlineSourceMap) {
            instCode = JALANGI_VAR + '.iids = ' + sourceMapString + ';\n' + code;
        } else {
            instCode = JALANGI_VAR + '.iids = ' + JSON.stringify(tmp) + ';\n' + code;
        }

        // post-hook
        if (isEval && sandbox.analysis && sandbox.analysis.instrumentCode) {
            aret = sandbox.analysis.instrumentCode(thisIid, instCode, newAst, options.isDirect);
            if (aret) {
                instCode = aret.result;
            }
        }

        return {
            code:            instCode,
            instAST:         newAst,
            sourceMapObject: sourceInfo,
            sourceMapString: sourceMapString
        };
    }

    /**
     * eval 插桩的快捷包装（始终内联 source map 和原始代码）。
     */
    function instrumentEvalCode(code, iid, isDirect) {
        return instrumentCode({
            code:            code,
            thisIid:         iid,
            isEval:          true,
            inlineSourceMap: true,
            inlineSource:    true,
            isDirect:        isDirect
        }).code;
    }

    // ─── 导出 ──────────────────────────────────────────────────────────────────

    sandbox.instrumentCode     = instrumentCode;
    sandbox.instrumentEvalCode = instrumentEvalCode;

}(J$));


// exports J$.instrumentCode
// exports J$.instrumentEvalCode
// depends on acorn          (global)
// depends on esotope        (global)
// depends on J$.Constants
// depends on J$.Config
// depends on J$.astUtil
// depends on J$.IIDManager  (iid.js)
// depends on J$.addScopes   (scope.js)
// depends on J$.Wrappers    (wrappers.js)
