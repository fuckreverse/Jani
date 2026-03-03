// JALANGI DO NOT INSTRUMENT

/*
 * Copyright 2014 Samsung Information Systems America, Inc.
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

/**
 * @file TraceAll —— 打印所有运行时事件的完整跟踪（需配合 SMemory）。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/sample_analyses/ChainedAnalyses.js \
 *     --analysis src/js/runtime/SMemory.js \
 *     --analysis src/js/sample_analyses/pldi16/TraceAll.js \
 *     tests/pldi16/TraceAllTest.js
 */

const MAX_STRING_LENGTH = 20;

export class TraceAllAnalysis {
    constructor(sandbox) {
        this._sandbox    = sandbox ?? (typeof J$ !== 'undefined' ? J$ : null);
        this._indentation = 0;
        this._cacheCount  = 0;
        this._cacheStr    = '';
        this._logs        = [];
    }

    _getValue(v) {
        const type = typeof v;
        if ((type === 'object' || type === 'function') && v !== null) {
            const shadowObj = this._sandbox.smemory.getShadowObjectOfObject(v);
            return `${type}(id=${this._sandbox.smemory.getIDFromShadowObjectOrFrame(shadowObj)})`;
        }
        if (type === 'string' && v.length > MAX_STRING_LENGTH) {
            return JSON.stringify(v.slice(0, MAX_STRING_LENGTH) + '...');
        }
        return JSON.stringify(v);
    }

    _getFrameID(name) {
        const mem = this._sandbox.smemory;
        return `frame(id=${mem.getIDFromShadowObjectOrFrame(mem.getShadowFrame(name))})`;
    }

    _log(str) {
        if (this._cacheCount !== this._indentation) {
            this._cacheStr   = '    '.repeat(this._indentation);
            this._cacheCount = this._indentation;
        }
        if (this._sandbox.Results) {
            this._logs.push(`<li>${this._cacheStr.replace(/ /g, '\u00a0')}${str} </li>`);
        } else {
            console.log(this._cacheStr + str);
        }
    }

    _loc(iid) { return J$.iidToLocation(J$.sid, iid); }

    invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid) {
        const argsStr = args.map((a, i) => `, args[${i}]=${this._getValue(a)}`).join('');
        this._log(`invokeFunPre(iid=${iid}, f=${this._getValue(f)}, base=${this._getValue(base)}${argsStr}, isConstructor=${isConstructor}, isMethod=${isMethod}, functionIid=${functionIid}, functionSid=${functionSid}) of function created at ${J$.iidToLocation(functionSid, functionIid)} at ${this._loc(iid)}`);
        this._indentation++;
        return { f, base, args, skip: false };
    }

    invokeFun(iid, f, base, args, result, isConstructor, isMethod, functionIid, functionSid) {
        this._indentation--;
        const argsStr = args.map((a, i) => `, args[${i}]=${this._getValue(a)}`).join('');
        this._log(`invokeFun(iid=${iid}, f=${this._getValue(f)}, base=${this._getValue(base)}, result=${this._getValue(result)}${argsStr}, isConstructor=${isConstructor}, isMethod=${isMethod}, functionIid=${functionIid}, functionSid=${functionSid}) of function created at ${J$.iidToLocation(functionSid, functionIid)} at ${this._loc(iid)}`);
        return { result };
    }

    literal(iid, val, hasGetterSetter) {
        this._log(`literal(iid=${iid}, val=${this._getValue(val)}, hasGetterSetter=${hasGetterSetter}) at ${this._loc(iid)}`);
        return { result: val };
    }

    forinObject(iid, val) {
        this._log(`forinObject(iid=${iid}, val=${this._getValue(val)}) at ${this._loc(iid)}`);
        return { result: val };
    }

    declare(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        this._log(`declare(iid=${iid}, name=${name}, val=${this._getValue(val)}, isArgument=${isArgument}, argumentIndex=${argumentIndex}, isCatchParam=${isCatchParam}) at ${this._loc(iid)}`);
        return { result: val };
    }

    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        const id = this._sandbox.smemory.getIDFromShadowObjectOrFrame(this._sandbox.smemory.getShadowObject(base, offset, true).owner);
        this._log(`getFieldPre(iid=${iid}, base=${this._getValue(base)}, offset=${this._getValue(String(offset))}, isComputed=${isComputed}, isOpAssign=${isOpAssign}, isMethodCall=${isMethodCall}) with actualBase=object(id=${id}) at ${this._loc(iid)}`);
        return { base, offset, skip: false };
    }

    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        const id = this._sandbox.smemory.getIDFromShadowObjectOrFrame(this._sandbox.smemory.getShadowObject(base, offset, true).owner);
        this._log(`getField(iid=${iid}, base=${this._getValue(base)}, offset=${this._getValue(String(offset))}, val=${this._getValue(val)}, isComputed=${isComputed}, isOpAssign=${isOpAssign}, isMethodCall=${isMethodCall}) with actualBase=object(id=${id}) at ${this._loc(iid)}`);
        return { result: val };
    }

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        this._log(`putFieldPre(iid=${iid}, base=${this._getValue(base)}, offset=${this._getValue(String(offset))}, val=${this._getValue(val)}, isComputed=${isComputed}, isOpAssign=${isOpAssign}) at ${this._loc(iid)}`);
        return { base, offset, val, skip: false };
    }

    putField(iid, base, offset, val, isComputed, isOpAssign) {
        this._log(`putField(iid=${iid}, base=${this._getValue(base)}, offset=${this._getValue(String(offset))}, val=${this._getValue(val)}, isComputed=${isComputed}, isOpAssign=${isOpAssign}) at ${this._loc(iid)}`);
        return { result: val };
    }

    read(iid, name, val, isGlobal, isScriptLocal) {
        this._log(`read(iid=${iid}, name=${name}, val=${this._getValue(val)}, isGlobal=${isGlobal}, isScriptLocal=${isScriptLocal}) with frameId=${this._getFrameID(name)} at ${this._loc(iid)}`);
        return { result: val };
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        this._log(`write(iid=${iid}, name=${name}, val=${this._getValue(val)}, lhs=${this._getValue(lhs)}, isGlobal=${isGlobal}, isScriptLocal=${isScriptLocal}) with frameId=${this._getFrameID(name)} at ${this._loc(iid)}`);
        return { result: val };
    }

    _return(iid, val) {
        this._log(`_return(iid=${iid}, val=${this._getValue(val)}) at ${this._loc(iid)}`);
        return { result: val };
    }

    _throw(iid, val) {
        this._log(`_throw(iid=${iid}, val=${this._getValue(val)}) at ${this._loc(iid)}`);
        return { result: val };
    }

    _with(iid, val) {
        this._log(`_with(iid=${iid}, val=${this._getValue(val)}) at ${this._loc(iid)}`);
        return { result: val };
    }

    functionEnter(iid, f, dis, args) {
        const argsStr = args.map((a, i) => `, args[${i}]=${this._getValue(a)}`).join('');
        this._log(`functionEnter(iid=${iid}, f=${this._getValue(f)}, this=${this._getValue(dis)}${argsStr}) with frameId=${this._getFrameID('this')} at ${this._loc(iid)}`);
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        const exStr = wrappedExceptionVal ? `{exception: ${this._getValue(wrappedExceptionVal.exception)}}` : 'none';
        this._log(`functionExit(iid=${iid}, returnVal=${this._getValue(returnVal)}, wrappedExceptionVal=${exStr}, frameId=${this._getFrameID('this')}) at ${this._loc(iid)}`);
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        this._log(`scriptEnter(iid=${iid}, instrumentedFileName=${instrumentedFileName}, originalFileName=${originalFileName}) at ${this._loc(iid)}`);
        this._indentation++;
    }

    scriptExit(iid, wrappedExceptionVal) {
        const exStr = wrappedExceptionVal ? `{exception: ${this._getValue(wrappedExceptionVal.exception)}}` : 'none';
        this._log(`scriptExit(iid=${iid}, wrappedExceptionVal=${exStr}) at ${this._loc(iid)}`);
        this._indentation--;
        return { wrappedExceptionVal, isBacktrack: false };
    }

    binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed) {
        this._log(`binaryPre(iid=${iid}, op="${op}", left=${this._getValue(left)}, right=${this._getValue(right)}, isOpAssign=${isOpAssign}, isSwitchCaseComparison=${isSwitchCaseComparison}, isComputed=${isComputed}) at ${this._loc(iid)}`);
        return { op, left, right, skip: false };
    }

    binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed) {
        this._log(`binary(iid=${iid}, op="${op}", left=${this._getValue(left)}, right=${this._getValue(right)}, result=${this._getValue(result)}, isOpAssign=${isOpAssign}, isSwitchCaseComparison=${isSwitchCaseComparison}, isComputed=${isComputed}) at ${this._loc(iid)}`);
        return { result };
    }

    unaryPre(iid, op, left) {
        this._log(`unaryPre(iid=${iid}, op="${op}", left=${this._getValue(left)}) at ${this._loc(iid)}`);
        return { op, left, skip: false };
    }

    unary(iid, op, left, result) {
        this._log(`unary(iid=${iid}, op="${op}", left=${this._getValue(left)}, result=${this._getValue(result)}) at ${this._loc(iid)}`);
        return { result };
    }

    conditional(iid, result) {
        this._log(`conditional(iid=${iid}, result=${this._getValue(result)}) at ${this._loc(iid)}`);
        return { result };
    }

    instrumentCodePre(iid, code, isDirect) {
        this._log(`instrumentCodePre(iid=${iid}, code=${this._getValue(code)}, isDirect=${isDirect}) at ${this._loc(iid)}`);
        return { code, skip: false };
    }

    instrumentCode(iid, newCode, newAst, isDirect) {
        this._log(`instrumentCode(iid=${iid}, newCode=${this._getValue(newCode)}, newAst=${this._getValue(newAst)}, isDirect=${isDirect}) at ${this._loc(iid)}`);
        return { result: newCode };
    }

    endExpression(iid) {
        this._log(`endExpression(iid=${iid}) at ${this._loc(iid)}`);
    }

    endExecution() {
        this._log('endExpression()');
        if (this._sandbox.Results) {
            for (const entry of this._logs) this._sandbox.log(entry);
        }
    }

    runInstrumentedFunctionBody(iid, f, functionIid, functionSid) {
        this._log(`runInstrumentedFunctionBody(iid=${iid}, f=${this._getValue(f)}, functionIid=${functionIid}, functionSid=${functionSid}) of function created at ${J$.iidToLocation(functionSid, functionIid)} at ${this._loc(iid)}`);
        return false;
    }

    onReady(cb) { cb(); }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new TraceAllAnalysis(J$);
}
