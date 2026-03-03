/*
 * Copyright (c) 2014 Samsung Electronics Co., Ltd.
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

(function (sandbox) {
    function ChainedAnalyses() {

        function clientAnalysisException(e) {
            console.error("analysis exception!!!");
            console.error(e.stack);
            if (typeof process !== 'undefined' && process.exit) {
                process.exit(1);
            } else {
                throw e;
            }
        }

        var funList = ["_return", "_throw", "_with",
            "binaryPre", "binary", "conditional",
            "declare", "endExecution", "endExpression",
            "forinObject", "functionEnter", "functionExit",
            "getFieldPre", "getField", "instrumentCodePre",
            "instrumentCode", "invokeFunPre", "invokeFun",
            "literal", "onReady","putFieldPre",
            "putField", "read", "runInstrumentedFunctionBody",
            "scriptEnter", "scriptExit",  "unaryPre",
            "unary", "write"];

        this.globals = {};

        this.addAnalysis = function (analysis) {
            var self = this, tmp, length = funList.length;

            for (var i = 0; i < length; i++) {
                var field = funList[i];
                if (tmp = analysis[field]) {
                    var fun = self[field];
                    if (!fun) {
                        // 修复1：用命名函数替换 arguments.callee。
                        //   arguments.callee 在 strict mode 下会抛 TypeError，且已被规范废弃。
                        //   命名函数表达式可以在函数体内通过名字引用自身，完全等价且无副作用。
                        //
                        // 修复2：链式值传递。
                        //   原实现中 args 数组在整个循环期间固定不变，
                        //   所以分析 A 若通过返回值修改了参数，分析 B 收到的仍是原始参数。
                        //   新实现：每轮调用后，若返回值包含修改过的字段（result/args/base/f 等），
                        //   则将其合并回 args，使得后续分析看到更新后的值。
                        fun = self[field] = function chainedDispatch() {
                            try {
                                var ret1;
                                var len = chainedDispatch.afs.length;
                                // 将 arguments 转换为真数组，后续可能被更新
                                var args = Array.prototype.slice.call(arguments);
                                for (var j = 0; j < len; j++) {
                                    ret1 = chainedDispatch.afs[j].apply(chainedDispatch.afThis[j], args);
                                    // 如果分析返回了修改后的参数对象，更新 args 以供后续分析使用
                                    // 约定：返回值是对象且含 skip / result / args 等字段时视为修改
                                    if (ret1 && typeof ret1 === 'object') {
                                        if (Array.isArray(ret1.args)) {
                                            args = ret1.args;
                                        }
                                    }
                                }
                                return ret1;
                            } catch (e) {
                                clientAnalysisException(e);
                            }
                        };
                        fun.afs = [];
                        fun.afThis = [];
                        fun.afName = field;
                    }
                    fun.afs.push(tmp);
                    fun.afThis.push(analysis);
                }
            }
        };
    }

    var thisAnalysis = new ChainedAnalyses();
    Object.defineProperty(sandbox, 'analysis', {
        get:function () {
            return thisAnalysis;
        },
        set:function (a) {
            thisAnalysis.addAnalysis(a);
        }
    });

    if (sandbox.Constants.isBrowser) {
        window.addEventListener('keydown', function (e) {
            // keyboard shortcut is Alt-Shift-T for now
            if (e.altKey && e.shiftKey && e.keyCode === 84) {
                sandbox.analysis.endExecution();
            }
        });
    }

}(J$));
