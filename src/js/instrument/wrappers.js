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
/*global J$ acorn */

/**
 * AST 包装（wrap）函数库。
 *
 * 负责将插桩钩子注入到各类 AST 节点中，提供：
 *  - wrapPutField / wrapGetField        —— 属性读写
 *  - wrapRead / wrapWrite               —— 变量读写
 *  - wrapBinaryOp / wrapUnaryOp         —— 一二元运算
 *  - wrapLogicalAnd / wrapLogicalOr     —— 短路运算
 *  - wrapConditional / wrapSwitchXxx    —— 条件分支
 *  - wrapLiteral                        —— 字面量
 *  - wrapReturn / wrapThrow             —— return / throw
 *  - wrapMethodCall / wrapFunCall       —— 函数/方法调用
 *  - wrapWithX1 / wrapHash / wrapWith   —— 表达式末尾、hash、with
 *  - wrapEvalArg                        —— eval 参数
 *  - wrapForIn / wrapForInBody          —— for-in
 *  - wrapCatchClause                    —— catch 子句
 *  - wrapScriptBodyWithTryCatch         —— 脚本级 try/catch
 *  - wrapFunBodyWithTryCatch            —— 函数级 try/catch
 *  - wrapModAssign                      —— 复合赋值（op=）
 *
 * 核心优化：replaceInExpr / replaceInStatement 使用 **模板缓存**，
 * 避免每次调用都重新执行 acorn.parse。
 */

if (typeof J$ === 'undefined') {
    J$ = {};
}

(function (sandbox) {
    if (typeof sandbox.Wrappers !== 'undefined') {
        return;
    }

    var astUtil   = sandbox.astUtil;
    var Config    = sandbox.Config;
    var Constants = sandbox.Constants;
    var IID       = sandbox.IIDManager;

    var JALANGI_VAR = Constants.JALANGI_VAR;
    var RP = JALANGI_VAR + '_';

    // ─── IID 绑定的便捷别名 ────────────────────────────────────────────────────
    // （直接从 IID 模块取，避免重复绑定）

    // ─── 函数名常量 ────────────────────────────────────────────────────────────

    var logFunctionEnterFunName   = JALANGI_VAR + '.Fe';
    var logFunctionReturnFunName  = JALANGI_VAR + '.Fr';
    var logFunCallFunName         = JALANGI_VAR + '.F';
    var logMethodCallFunName      = JALANGI_VAR + '.M';
    var logAssignFunName          = JALANGI_VAR + '.A';
    var logPutFieldFunName        = JALANGI_VAR + '.P';
    var logGetFieldFunName        = JALANGI_VAR + '.G';
    var logScriptEntryFunName     = JALANGI_VAR + '.Se';
    var logScriptExitFunName      = JALANGI_VAR + '.Sr';
    var logReadFunName            = JALANGI_VAR + '.R';
    var logWriteFunName           = JALANGI_VAR + '.W';
    var logIFunName               = JALANGI_VAR + '.I';
    var logHashFunName            = JALANGI_VAR + '.H';
    var logLitFunName             = JALANGI_VAR + '.T';
    var logInitFunName            = JALANGI_VAR + '.N';
    var logReturnFunName          = JALANGI_VAR + '.Rt';
    var logThrowFunName           = JALANGI_VAR + '.Th';
    var logReturnAggrFunName      = JALANGI_VAR + '.Ra';
    var logUncaughtExceptionFunName = JALANGI_VAR + '.Ex';
    var logLastComputedFunName    = JALANGI_VAR + '.L';
    var logTmpVarName             = JALANGI_VAR + '._tm_p';
    var logSampleFunName          = JALANGI_VAR + '.S';
    var logWithFunName            = JALANGI_VAR + '.Wi';
    var logBinaryOpFunName        = JALANGI_VAR + '.B';
    var logUnaryOpFunName         = JALANGI_VAR + '.U';
    var logConditionalFunName     = JALANGI_VAR + '.C';
    var logSwitchLeftFunName      = JALANGI_VAR + '.C1';
    var logSwitchRightFunName     = JALANGI_VAR + '.C2';
    var logLastFunName            = JALANGI_VAR + '._';
    var logX1FunName              = JALANGI_VAR + '.X1';
    var instrumentCodeFunName     = JALANGI_VAR + '.instrumentEvalCode';

    // ─── N_LOG_* 字面量类型常量 ────────────────────────────────────────────────

    var N_LOG_FUNCTION_ENTER  = 4;
    var N_LOG_SCRIPT_ENTER    = 6;
    var N_LOG_GETFIELD        = 8;
    var N_LOG_ARRAY_LIT       = 10;
    var N_LOG_OBJECT_LIT      = 11;
    var N_LOG_FUNCTION_LIT    = 12;
    var N_LOG_RETURN          = 13;
    var N_LOG_REGEXP_LIT      = 14;
    var N_LOG_READ            = 17;
    var N_LOG_HASH            = 19;
    var N_LOG_SPECIAL         = 20;
    var N_LOG_STRING_LIT      = 21;
    var N_LOG_NUMBER_LIT      = 22;
    var N_LOG_BOOLEAN_LIT     = 23;
    var N_LOG_UNDEFINED_LIT   = 24;
    var N_LOG_NULL_LIT        = 25;

    // ─── 工具函数 ──────────────────────────────────────────────────────────────

    function createLiteralAst(name) {
        return {type: 'Literal', value: name};
    }

    function createIdentifierAst(name) {
        return {type: 'Identifier', name: name};
    }

    function transferLoc(toNode, fromNode) {
        if (fromNode.loc) toNode.loc = fromNode.loc;
        if (fromNode.raw) toNode.raw = fromNode.loc;
    }

    function createBitPattern() {
        var ret = 0;
        for (var i = 0; i < arguments.length; i++) {
            ret = (ret << 1) + (arguments[i] ? 1 : 0);
        }
        return ret;
    }

    // ─── 模板缓存（核心优化）────────────────────────────────────────────────────
    //
    // 旧实现中，replaceInStatement / replaceInExpr 每次都调用 acorn.parse(templateString)，
    // 并通过 AST 替换把占位符 RP_1、RP_2 等换成真实 AST 节点。
    //
    // 优化：第一次解析时缓存去掉 loc 的纯结构 AST，后续通过深拷贝 + 替换完成，
    // 省去重复 parse 的开销。

    /** 模板字符串 -> 缓存的 AST body 数组（去掉 loc/start/end） */
    var _templateCache = {};

    /**
     * 深拷贝并替换 AST 中的占位符。
     *
     * 规则：
     *  1. Identifier 且名称以 RP 开头 → 替换为 args[N]
     *  2. BlockStatement 处理完子节点替换后，若 body 展开为数组（来自 RP_N 参数是数组的情况），
     *     则按原始 replaceInStatement 语义展开。
     *
     * 注意：展开判断必须在子节点替换之后执行（先替换占位符，再检查结果是否是数组）。
     */
    function deepCloneAndReplace(node, args) {
        if (node === null || typeof node !== 'object') {
            return node;
        }

        // 数组：逐元素处理，并做 BlockStatement body 的扁平化展开
        if (Array.isArray(node)) {
            var result = [];
            for (var ai = 0; ai < node.length; ai++) {
                var replaced = deepCloneAndReplace(node[ai], args);
                // 若 body 展开后某元素是数组，则 flat 一层（来自 RP_N 是语句数组的情况）
                if (Array.isArray(replaced)) {
                    for (var bi = 0; bi < replaced.length; bi++) {
                        result.push(replaced[bi]);
                    }
                } else {
                    result.push(replaced);
                }
            }
            return result;
        }

        // 占位符 Identifier：名称形如 J$_1 → 取 args[1]
        if (node.type === 'Identifier' && node.name.indexOf(RP) === 0) {
            var idx = parseInt(node.name.substring(RP.length), 10);
            // args[idx] 可能是一个 AST 节点，也可能是一个语句数组（用于 BlockStatement body 展开）
            return args[idx];
        }

        // BlockStatement：先处理子节点，再检查展开
        if (node.type === 'BlockStatement') {
            // 先递归替换 body 数组
            var newBody = deepCloneAndReplace(node.body, args);
            // 如果 body 只有一个 ExpressionStatement 且其 expression 是数组，
            // 这是原始代码中"把语句数组嵌入 block"的约定：展开为那个数组
            if (newBody.length === 1
                    && newBody[0] && newBody[0].type === 'ExpressionStatement'
                    && Array.isArray(newBody[0].expression)) {
                return {type: 'BlockStatement', body: newBody[0].expression};
            }
            return {type: 'BlockStatement', body: newBody};
        }

        // 普通节点：逐属性拷贝
        var obj = {};
        for (var key in node) {
            if (node.hasOwnProperty(key) && key !== 'loc' && key !== 'start' && key !== 'end') {
                obj[key] = deepCloneAndReplace(node[key], args);
            }
        }
        return obj;
    }

    /**
     * 解析模板代码，返回 body 语句数组，并替换占位符。
     *
     * 调用方式与原始版本相同：
     *   replaceInStatement(templateString, arg1, arg2, ...)
     *
     * 其中 templateString 中的 J$_1, J$_2, ... 会被 arg1, arg2, ... 替换。
     */
    function replaceInStatement(code) {
        var cached = _templateCache[code];
        if (!cached) {
            var parsed = acorn.parse(code, {ecmaVersion: 'latest'});
            // 用 JSON 序列化去掉 loc/start/end，缓存纯结构
            cached = JSON.parse(JSON.stringify(parsed.body));
            _templateCache[code] = cached;
        }
        return deepCloneAndReplace(cached, arguments);
    }

    function replaceInExpr(code) {
        var ret = replaceInStatement.apply(this, arguments);
        return ret[0].expression;
    }

    // ─── 作用域引用（由 instrumenter 动态设置）────────────────────────────────

    // 当前活动的 scope（在 visitorRRPre 中设置）
    var scope = null;

    function setScope(node) {
        scope = node.scope;
    }

    function popScope() {
        scope = scope.parent;
    }

    // ─── getPropertyAsAst ─────────────────────────────────────────────────────

    function getPropertyAsAst(ast) {
        return ast.computed ? ast.property : createLiteralAst(ast.property.name);
    }

    // ─── 各种 wrap 函数 ───────────────────────────────────────────────────────

    function wrapPutField(node, base, offset, rvalue, isComputed) {
        if (!Config.INSTR_PUTFIELD || Config.INSTR_PUTFIELD(isComputed ? null : offset.value, node)) {
            IID.printIidToLoc(node);
            var ret = replaceInExpr(
                logPutFieldFunName +
                '(' + RP + '1, ' + RP + '2, ' + RP + '3, ' + RP + '4,' + createBitPattern(isComputed, false) + ')',
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
            var ret = replaceInExpr(
                logAssignFunName + '(' + RP + '1,' + RP + '2,' + RP + '3,' + RP + '4,' + createBitPattern(isComputed, isNumber) + ')(' + RP + '5)',
                IID.getIid(), base, offset, createLiteralAst(op), rvalue
            );
            transferLoc(ret, node);
            return ret;
        }
        return node;
    }

    function wrapMethodCall(node, base, offset, isCtor, isComputed) {
        IID.printIidToLoc(node);
        IID.printSpecialIidToLoc(node.callee);
        var ret = replaceInExpr(
            logMethodCallFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3, ' + createBitPattern(isCtor, isComputed) + ')',
            IID.getIid(), base, offset
        );
        transferLoc(ret, node.callee);
        return ret;
    }

    function wrapFunCall(node, ast, isCtor) {
        IID.printIidToLoc(node);
        var ret = replaceInExpr(
            logFunCallFunName + '(' + RP + '1, ' + RP + '2, ' + createBitPattern(isCtor) + ')',
            IID.getIid(), ast
        );
        transferLoc(ret, node.callee);
        return ret;
    }

    function wrapGetField(node, base, offset, isComputed) {
        if (!Config.INSTR_GETFIELD || Config.INSTR_GETFIELD(node.computed ? null : offset.value, node)) {
            IID.printIidToLoc(node);
            var ret = replaceInExpr(
                logGetFieldFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3,' + createBitPattern(isComputed, false, false) + ')',
                IID.getIid(), base, offset
            );
            transferLoc(ret, node);
            return ret;
        }
        return node;
    }

    function wrapRead(node, name, val, isReUseIid, isGlobal, isScriptLocal) {
        if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
            IID.printIidToLoc(node);
            var ret = replaceInExpr(
                logReadFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3,' + createBitPattern(isGlobal, isScriptLocal) + ')',
                isReUseIid ? IID.getPrevIidNoInc() : IID.getIid(),
                name, val
            );
            transferLoc(ret, node);
            return ret;
        }
        return val;
    }

    function wrapReadWithUndefinedCheck(node, name) {
        var ret = replaceInExpr(
            '(' + logIFunName + '(typeof (' + name + ') === \'undefined\'? (' + RP + '2) : (' + RP + '3)))',
            createIdentifierAst(name),
            wrapRead(node, createLiteralAst(name), createIdentifierAst('undefined'), false, true, false),
            wrapRead(node, createLiteralAst(name), createIdentifierAst(name), true, true, false)
        );
        transferLoc(ret, node);
        return ret;
    }

    function wrapWrite(node, name, val, lhs, isGlobal, isScriptLocal, isDeclaration) {
        if (!Config.INSTR_WRITE || Config.INSTR_WRITE(name, node)) {
            IID.printIidToLoc(node);
            var ret = replaceInExpr(
                logWriteFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3, ' + RP + '4,' + createBitPattern(isGlobal, isScriptLocal, isDeclaration) + ')',
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
            var ret = replaceInExpr(
                logWriteFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3, ' + logIFunName + '(typeof(' + lhs.name + ')===\'undefined\'?undefined:' + lhs.name + '),' + createBitPattern(true, false, false) + ')',
                IID.getIid(), name, val
            );
            transferLoc(ret, node);
            return ret;
        }
        return val;
    }

    function wrapRHSOfModStore(node, left, right, op) {
        var ret = replaceInExpr(RP + '1 ' + op + ' ' + RP + '2', left, right);
        transferLoc(ret, node);
        return ret;
    }

    function makeNumber(node, left) {
        var ret = replaceInExpr(' + ' + RP + '1 ', left);
        transferLoc(ret, node);
        return ret;
    }

    function wrapLHSOfModStore(node, left, right) {
        var ret = replaceInExpr(RP + '1 = ' + RP + '2', left, right);
        transferLoc(ret, node);
        return ret;
    }

    function wrapReturn(node, expr) {
        var lid = (expr === null) ? node : expr;
        IID.printIidToLoc(lid);
        if (expr === null) {
            expr = createIdentifierAst('undefined');
        }
        var ret = replaceInExpr(
            logReturnFunName + '(' + RP + '1, ' + RP + '2)',
            IID.getIid(), expr
        );
        transferLoc(ret, lid);
        return ret;
    }

    function wrapThrow(node, expr) {
        IID.printIidToLoc(expr);
        var ret = replaceInExpr(
            logThrowFunName + '(' + RP + '1, ' + RP + '2)',
            IID.getIid(), expr
        );
        transferLoc(ret, expr);
        return ret;
    }

    function wrapWithX1(node, ast) {
        if (!Config.INSTR_END_EXPRESSION || Config.INSTR_END_EXPRESSION(node)) {
            if (!ast || ast.type.indexOf('Expression') <= 0) return ast;
            IID.printIidToLoc(node);
            var ret = replaceInExpr(
                logX1FunName + '(' + RP + '1,' + RP + '2)',
                IID.getIid(), ast
            );
            transferLoc(ret, node);
            return ret;
        }
        return ast;
    }

    function wrapHash(node, ast) {
        IID.printIidToLoc(node);
        var ret = replaceInExpr(
            logHashFunName + '(' + RP + '1, ' + RP + '2)',
            IID.getIid(), ast
        );
        transferLoc(ret, node);
        return ret;
    }

    function wrapEvalArg(ast) {
        IID.printIidToLoc(ast);
        var ret = replaceInExpr(
            instrumentCodeFunName + '(' + RP + '1, ' + RP + '2, true)',
            ast, IID.getIid()
        );
        transferLoc(ret, ast);
        return ret;
    }

    function wrapUnaryOp(node, argument, operator) {
        if (!Config.INSTR_UNARY || Config.INSTR_UNARY(operator, node)) {
            IID.printOpIidToLoc(node);
            var ret = replaceInExpr(
                logUnaryOpFunName + '(' + RP + '1,' + RP + '2,' + RP + '3)',
                IID.getOpIid(), createLiteralAst(operator), argument
            );
            transferLoc(ret, node);
            return ret;
        }
        return node;
    }

    function wrapBinaryOp(node, left, right, operator, isComputed) {
        if (!Config.INSTR_BINARY || Config.INSTR_BINARY(operator, operator)) {
            IID.printOpIidToLoc(node);
            var ret = replaceInExpr(
                logBinaryOpFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3, ' + RP + '4,' + createBitPattern(isComputed, false, false) + ')',
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
            var ret = replaceInExpr(
                logConditionalFunName + '(' + RP + '1, ' + RP + '2)?' + RP + '3:' + logLastFunName + '()',
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
            var ret = replaceInExpr(
                logConditionalFunName + '(' + RP + '1, ' + RP + '2)?' + logLastFunName + '():' + RP + '3',
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
            var ret = replaceInExpr(
                logSwitchLeftFunName + '(' + RP + '1, ' + RP + '2)',
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
            var ret = replaceInExpr(
                logSwitchRightFunName + '(' + RP + '1, ' + RP + '2)',
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
            var ret = replaceInExpr(
                logWithFunName + '(' + RP + '1, ' + RP + '2)',
                IID.getIid(), node
            );
            transferLoc(ret, node);
            return ret;
        }
        return node;
    }

    function wrapConditional(node, test) {
        if (node === null) return node; // for(;;) 的空条件
        if (!Config.INSTR_CONDITIONAL || Config.INSTR_CONDITIONAL('other', node)) {
            IID.printCondIidToLoc(node);
            var ret = replaceInExpr(
                logConditionalFunName + '(' + RP + '1, ' + RP + '2)',
                IID.getCondIid(), test
            );
            transferLoc(ret, node);
            return ret;
        }
        return node;
    }

    // ─── 字面量 wrap ──────────────────────────────────────────────────────────

    var dummyFun    = function () {};
    var dummyObject = {};
    var dummyArray  = [];

    function getLiteralValue(funId, node) {
        if (node.name === 'undefined') return undefined;
        if (node.name === 'NaN')       return NaN;
        if (node.name === 'Infinity')  return Infinity;
        switch (funId) {
            case N_LOG_NUMBER_LIT:
            case N_LOG_STRING_LIT:
            case N_LOG_NULL_LIT:
            case N_LOG_REGEXP_LIT:
            case N_LOG_BOOLEAN_LIT:
                return node.value;
            case N_LOG_ARRAY_LIT:    return dummyArray;
            case N_LOG_FUNCTION_LIT: return dummyFun;
            case N_LOG_OBJECT_LIT:   return dummyObject;
        }
        throw new Error(funId + ' not known');
    }

    function ifObjectExpressionHasGetterSetter(node) {
        if (node.type === 'ObjectExpression') {
            for (var i = 0; i < node.properties.length; i++) {
                var kind = node.properties[i].kind;
                if (kind === 'get' || kind === 'set') return true;
            }
        }
        return false;
    }

    function getFnIdFromAst(ast) {
        var entryExpr = ast.body.body[0];
        if (entryExpr.type !== 'ExpressionStatement') {
            throw new Error('IllegalStateException');
        }
        entryExpr = entryExpr.expression;
        if (entryExpr.type !== 'CallExpression') throw new Error('IllegalStateException');
        if (entryExpr.callee.type !== 'MemberExpression') throw new Error('IllegalStateException');
        if (entryExpr.callee.object.name !== JALANGI_VAR) throw new Error('IllegalStateException');
        if (entryExpr.callee.property.name !== 'Fe') throw new Error('IllegalStateException');
        return entryExpr['arguments'][0].value;
    }

    function wrapLiteral(node, ast, funId) {
        if (!Config.INSTR_LITERAL || Config.INSTR_LITERAL(getLiteralValue(funId, node), node)) {
            IID.printIidToLoc(node);
            var hasGetterSetter = ifObjectExpressionHasGetterSetter(node);
            var ret;
            if (funId === N_LOG_FUNCTION_LIT) {
                var internalFunId = null;
                if (node.type === 'FunctionExpression') {
                    internalFunId = getFnIdFromAst(node);
                } else {
                    if (node.type !== 'Identifier') throw new Error('IllegalStateException');
                    internalFunId = getFnIdFromAst(scope.funNodes[node.name]);
                }
                ret = replaceInExpr(
                    logLitFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3,' + hasGetterSetter + ', ' + internalFunId + ')',
                    IID.getIid(), ast, createLiteralAst(funId), internalFunId
                );
            } else {
                ret = replaceInExpr(
                    logLitFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3,' + hasGetterSetter + ')',
                    IID.getIid(), ast, createLiteralAst(funId)
                );
            }
            transferLoc(ret, node);
            return ret;
        }
        return node;
    }

    // ─── 语句级 wrap ──────────────────────────────────────────────────────────

    function createExpressionStatement(lhs, node) {
        var ret = replaceInStatement(RP + '1 = ' + RP + '2', lhs, node);
        transferLoc(ret[0].expression, node);
        return ret;
    }

    function createCallInitAsStatement(node, name, val, isArgumentSync, lhs, isCatchParam, isAssign) {
        IID.printIidToLoc(node);
        var ret;
        if (isAssign) {
            ret = replaceInStatement(
                RP + '1 = ' + logInitFunName + '(' + RP + '2, ' + RP + '3, ' + RP + '4, ' + createBitPattern(isArgumentSync, false, isCatchParam) + ')',
                lhs, IID.getIid(), name, val
            );
        } else {
            ret = replaceInStatement(
                logInitFunName + '(' + RP + '1, ' + RP + '2, ' + RP + '3, ' + createBitPattern(isArgumentSync, false, isCatchParam) + ')',
                IID.getIid(), name, val
            );
        }
        transferLoc(ret[0].expression, node);
        return ret;
    }

    function createCallAsFunEnterStatement(node) {
        IID.printIidToLoc(node);
        var ret = replaceInStatement(
            logFunctionEnterFunName + '(' + RP + '1,arguments.callee, this, arguments)',
            IID.getIid()
        );
        transferLoc(ret[0].expression, node);
        return ret;
    }

    function createCallAsScriptEnterStatement(node, instFile, origFile) {
        IID.printIidToLoc(node);
        var ret = replaceInStatement(
            logScriptEntryFunName + '(' + RP + '1,' + RP + '2, ' + RP + '3)',
            IID.getIid(),
            createLiteralAst(instFile),
            createLiteralAst(origFile)
        );
        transferLoc(ret[0].expression, node);
        return ret;
    }

    // ─── for-in / catch / try-catch 包装 ─────────────────────────────────────

    var labelCounter = 0;

    function wrapForIn(node, left, right, body) {
        IID.printIidToLoc(node);
        var tmp, extra, isDeclaration = (left.type === 'VariableDeclaration');
        if (isDeclaration) {
            var name = node.left.declarations[0].id.name;
            tmp = replaceInExpr(name + ' = ' + logTmpVarName);
        } else {
            tmp = replaceInExpr(RP + '1 = ' + logTmpVarName, left);
        }
        transferLoc(tmp, node);
        extra = instrumentStore(tmp, isDeclaration);

        if (body.type === 'BlockExpression') {
            body = body.body;
        } else {
            body = [body];
        }

        var ret;
        if (isDeclaration) {
            ret = replaceInStatement(
                'function n() {  for(' + logTmpVarName + ' in ' + RP + '1) {var ' + name + ' = ' + RP + '2;\n {' + RP + '3}}}',
                right, wrapWithX1(node, extra.right), body
            );
        } else {
            ret = replaceInStatement(
                'function n() {  for(' + logTmpVarName + ' in ' + RP + '1) {' + RP + '2;\n {' + RP + '3}}}',
                right, wrapWithX1(node, extra), body
            );
        }
        ret = ret[0].body.body[0];
        transferLoc(ret, node);
        return ret;
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
            var iid1 = IID.getIid();
            IID.printIidToLoc(node);
            var l = labelCounter++;
            var ret = replaceInStatement(
                'function n() { jalangiLabel' + l + ': while(true) { try {' + RP + '1} catch(' + JALANGI_VAR +
                'e) { ' + logUncaughtExceptionFunName + '(' + RP + '2,' + JALANGI_VAR +
                'e); } finally { if (' + logScriptExitFunName + '(' +
                RP + '3)) { ' + logLastComputedFunName + '(); continue jalangiLabel' + l + ';\n } else {\n  ' +
                logLastComputedFunName + '(); break jalangiLabel' + l + ';\n }}\n }}',
                body, iid1, IID.getIid()
            );
            ret = ret[0].body.body;
            transferLoc(ret[0], node);
            return ret;
        }
        return body;
    }

    function wrapFunBodyWithTryCatch(node, body) {
        if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
            IID.printIidToLoc(node);
            var iid1 = IID.getIid();
            IID.printIidToLoc(node);
            var l = labelCounter++;
            var ret = replaceInStatement(
                'function n() { jalangiLabel' + l + ': while(true) { try {' + RP + '1} catch(' + JALANGI_VAR +
                'e) { ' + logUncaughtExceptionFunName + '(' + RP + '2,' + JALANGI_VAR +
                'e); } finally { if (' + logFunctionReturnFunName + '(' +
                RP + '3)) continue jalangiLabel' + l + ';\n else \n  return ' + logReturnAggrFunName + '();\n }\n }}',
                body, iid1, IID.getIid()
            );
            ret = ret[0].body.body;
            transferLoc(ret[0], node);
            return ret;
        }
        return body;
    }

    // ─── syncDefuns / instrumentFunctionEntryExit / instrumentScriptEntryExit ─

    function HOP(obj, prop) {
        return Object.prototype.hasOwnProperty.call(obj, prop);
    }

    function syncDefuns(node, scopeArg, isScript) {
        var ret = [], ident;
        if (!isScript) {
            if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
                if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                    ident = createIdentifierAst('arguments');
                    ret = ret.concat(createCallInitAsStatement(node,
                        createLiteralAst('arguments'), ident, true, ident, false, true));
                }
            }
        }
        if (scopeArg) {
            for (var name in scopeArg.vars) {
                if (HOP(scopeArg.vars, name)) {
                    if (scopeArg.vars[name] === 'defun') {
                        if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                            ident = createIdentifierAst(name);
                            ident.loc = scopeArg.funLocs[name];
                            ret = ret.concat(createCallInitAsStatement(node,
                                createLiteralAst(name),
                                wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT),
                                false, ident, false, true));
                        } else {
                            ident = createIdentifierAst(name);
                            ident.loc = scopeArg.funLocs[name];
                            ret = ret.concat(createExpressionStatement(ident,
                                wrapLiteral(ident, ident, N_LOG_FUNCTION_LIT)));
                        }
                    }
                    if (scopeArg.vars[name] === 'lambda') {
                        if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                            ident = createIdentifierAst(name);
                            ident.loc = scopeArg.funLocs[name];
                            ret = ret.concat(createCallInitAsStatement(node,
                                createLiteralAst(name), ident, false, ident, false, true));
                        }
                    }
                    if (scopeArg.vars[name] === 'arg') {
                        if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                            ident = createIdentifierAst(name);
                            ret = ret.concat(createCallInitAsStatement(node,
                                createLiteralAst(name), ident, true, ident, false, true));
                        }
                    }
                    if (scopeArg.vars[name] === 'var') {
                        if (!Config.INSTR_INIT || Config.INSTR_INIT(node)) {
                            ret = ret.concat(createCallInitAsStatement(node,
                                createLiteralAst(name),
                                createIdentifierAst(name),
                                false, undefined, false, false));
                        }
                    }
                }
            }
        }
        return ret;
    }

    function instrumentFunctionEntryExit(node, ast) {
        var body;
        if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
            body = createCallAsFunEnterStatement(node);
        } else {
            body = [];
        }
        body = body.concat(syncDefuns(node, scope, false)).concat(ast);
        return body;
    }

    function instrumentScriptEntryExit(node, body0, instFile, origFile) {
        var body;
        if (!Config.INSTR_TRY_CATCH_ARGUMENTS || Config.INSTR_TRY_CATCH_ARGUMENTS(node)) {
            body = createCallAsScriptEnterStatement(node, instFile, origFile);
        } else {
            body = [];
        }
        body = body.concat(syncDefuns(node, scope, true)).concat(body0);
        return body;
    }

    // ─── instrumentStore / instrumentLoad / instrumentLoadModStore / instrumentPreIncDec ─

    function instrumentStore(node, isDeclaration) {
        var ret;
        if (node.left.type === 'Identifier') {
            if (scope.hasVar(node.left.name)) {
                ret = wrapWrite(node.right, createLiteralAst(node.left.name), node.right, node.left,
                    false, scope.isGlobal(node.left.name), isDeclaration);
            } else {
                ret = wrapWriteWithUndefinedCheck(node.right, createLiteralAst(node.left.name), node.right, node.left);
            }
            node.right = ret;
            return node;
        } else {
            ret = wrapPutField(node, node.left.object, getPropertyAsAst(node.left), node.right, node.left.computed);
            return ret;
        }
    }

    function instrumentLoad(ast, isTypeof) {
        var ret;
        if (ast.type === 'Identifier') {
            if (ast.name === 'undefined') {
                return wrapLiteral(ast, ast, N_LOG_UNDEFINED_LIT);
            } else if (ast.name === 'NaN' || ast.name === 'Infinity') {
                return wrapLiteral(ast, ast, N_LOG_NUMBER_LIT);
            }
            if (ast.name === JALANGI_VAR) return ast;
            if (scope.hasVar(ast.name)) {
                return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, scope.isGlobal(ast.name));
            } else if (isTypeof) {
                return wrapReadWithUndefinedCheck(ast, ast.name);
            } else {
                return wrapRead(ast, createLiteralAst(ast.name), ast, false, true, false);
            }
        } else if (ast.type === 'MemberExpression') {
            return wrapGetField(ast, ast.object, getPropertyAsAst(ast), ast.computed);
        }
        return ast;
    }

    function instrumentLoadModStore(node, isNumber) {
        if (node.left.type === 'Identifier') {
            var tmp0 = instrumentLoad(node.left, false);
            if (isNumber) {
                tmp0 = makeNumber(node, instrumentLoad(tmp0, false));
            }
            var tmp1 = wrapRHSOfModStore(node.right, tmp0, node.right, node.operator.substring(0, node.operator.length - 1));
            var tmp2;
            if (scope.hasVar(node.left.name)) {
                tmp2 = wrapWrite(node, createLiteralAst(node.left.name), tmp1, node.left,
                    false, scope.isGlobal(node.left.name), false);
            } else {
                tmp2 = wrapWriteWithUndefinedCheck(node, createLiteralAst(node.left.name), tmp1, node.left);
            }
            tmp2 = wrapLHSOfModStore(node, node.left, tmp2);
            return tmp2;
        } else {
            return wrapModAssign(node, node.left.object,
                getPropertyAsAst(node.left),
                node.operator.substring(0, node.operator.length - 1),
                node.right, node.left.computed, !!isNumber);
        }
    }

    function instrumentPreIncDec(node) {
        var right = createLiteralAst(1);
        right = wrapLiteral(right, right, N_LOG_NUMBER_LIT);
        var ret = wrapRHSOfModStore(node, node.argument, right, node.operator.substring(0, 1) + '=');
        return instrumentLoadModStore(ret, true);
    }

    function adjustIncDec(op, ast) {
        op = (op === '++') ? '-' : '+';
        var right = createLiteralAst(1);
        right = wrapLiteral(right, right, N_LOG_NUMBER_LIT);
        return wrapRHSOfModStore(ast, ast, right, op);
    }

    function instrumentCall(callAst, isCtor) {
        var ast = callAst.callee;
        if (ast.type === 'MemberExpression') {
            return wrapMethodCall(callAst, ast.object, getPropertyAsAst(ast), isCtor, ast.computed);
        } else if (ast.type === 'Identifier' && ast.name === 'eval') {
            return ast;
        } else {
            return wrapFunCall(callAst, ast, isCtor);
        }
    }

    // ─── 导出 ──────────────────────────────────────────────────────────────────

    sandbox.Wrappers = {
        // scope 状态管理（由 esnstrument.js 的 visitor 调用）
        setScope:  setScope,
        popScope:  popScope,
        getScope:  function () { return scope; },

        // AST 辅助
        createLiteralAst:    createLiteralAst,
        createIdentifierAst: createIdentifierAst,
        transferLoc:         transferLoc,
        createBitPattern:    createBitPattern,

        // 字面量类型常量（供 visitor 使用）
        N_LOG_ARRAY_LIT:     N_LOG_ARRAY_LIT,
        N_LOG_OBJECT_LIT:    N_LOG_OBJECT_LIT,
        N_LOG_FUNCTION_LIT:  N_LOG_FUNCTION_LIT,
        N_LOG_NUMBER_LIT:    N_LOG_NUMBER_LIT,
        N_LOG_STRING_LIT:    N_LOG_STRING_LIT,
        N_LOG_BOOLEAN_LIT:   N_LOG_BOOLEAN_LIT,
        N_LOG_NULL_LIT:      N_LOG_NULL_LIT,
        N_LOG_REGEXP_LIT:    N_LOG_REGEXP_LIT,
        N_LOG_UNDEFINED_LIT: N_LOG_UNDEFINED_LIT,

        // wrap 函数
        wrapPutField:          wrapPutField,
        wrapModAssign:         wrapModAssign,
        wrapMethodCall:        wrapMethodCall,
        wrapFunCall:           wrapFunCall,
        wrapGetField:          wrapGetField,
        wrapRead:              wrapRead,
        wrapReadWithUndefinedCheck: wrapReadWithUndefinedCheck,
        wrapWrite:             wrapWrite,
        wrapWriteWithUndefinedCheck: wrapWriteWithUndefinedCheck,
        wrapReturn:            wrapReturn,
        wrapThrow:             wrapThrow,
        wrapWithX1:            wrapWithX1,
        wrapHash:              wrapHash,
        wrapEvalArg:           wrapEvalArg,
        wrapUnaryOp:           wrapUnaryOp,
        wrapBinaryOp:          wrapBinaryOp,
        wrapLogicalAnd:        wrapLogicalAnd,
        wrapLogicalOr:         wrapLogicalOr,
        wrapSwitchDiscriminant: wrapSwitchDiscriminant,
        wrapSwitchTest:        wrapSwitchTest,
        wrapWith:              wrapWith,
        wrapConditional:       wrapConditional,
        wrapLiteral:           wrapLiteral,
        wrapForIn:             wrapForIn,
        wrapCatchClause:       wrapCatchClause,
        wrapScriptBodyWithTryCatch: wrapScriptBodyWithTryCatch,
        wrapFunBodyWithTryCatch:    wrapFunBodyWithTryCatch,

        // 高级函数（供 visitor 直接调用）
        instrumentStore:           instrumentStore,
        instrumentLoad:            instrumentLoad,
        instrumentLoadModStore:    instrumentLoadModStore,
        instrumentPreIncDec:       instrumentPreIncDec,
        adjustIncDec:              adjustIncDec,
        instrumentCall:            instrumentCall,
        instrumentFunctionEntryExit: instrumentFunctionEntryExit,
        instrumentScriptEntryExit:   instrumentScriptEntryExit,

        // 函数入口/脚本入口语句生成
        createCallAsFunEnterStatement:   createCallAsFunEnterStatement,
        createCallAsScriptEnterStatement: createCallAsScriptEnterStatement,
        getPropertyAsAst: getPropertyAsAst
    };

}(J$));

// exports J$.Wrappers
// depends on J$.astUtil
// depends on J$.Config
// depends on J$.Constants
// depends on J$.IIDManager
// depends on acorn (global)
