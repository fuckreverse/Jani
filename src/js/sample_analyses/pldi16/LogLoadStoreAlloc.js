// JALANGI DO NOT INSTRUMENT

/**
 * @file LogLoadStoreAlloc —— 记录对象字段读写，并追踪每个对象的分配点。
 * @author Koushik Sen
 *
 * 需要配合 SMemory 使用：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/sample_analyses/ChainedAnalyses.js \
 *     --analysis src/js/runtime/SMemory.js \
 *     --analysis src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js \
 *     tests/pldi16/CountObjectsPerAllocationSiteTest.js
 */

export class LogLoadStoreAllocAnalysis {
    constructor(sandbox) {
        this._sandbox    = sandbox ?? (typeof J$ !== 'undefined' ? J$ : null);
        this._indentation = 0;
        this._cacheCount  = 0;
        this._cacheStr    = '';
        this._logs        = [];
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

    invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid) {
        this._indentation++;
        return { f, base, args, skip: false };
    }

    literal(iid, val, hasGetterSetter) {
        if (typeof val === 'object' && val !== null) {
            const sobj = this._sandbox.smemory.getShadowObjectOfObject(val);
            if (sobj) sobj.allocSite = J$.iidToLocation(J$.sid, iid);
        }
        return { result: val };
    }

    invokeFun(iid, f, base, args, val, isConstructor, isMethod, functionIid, functionSid) {
        this._indentation--;
        if (isConstructor && typeof val === 'object' && val !== null) {
            const sobj = this._sandbox.smemory.getShadowObjectOfObject(val);
            if (sobj) sobj.allocSite = J$.iidToLocation(J$.sid, iid);
        }
        return { result: val };
    }

    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        const sobj = this._sandbox.smemory.getShadowObject(base, offset, true).owner;
        this._log(`Load '${offset}' of object allocated at ${sobj?.allocSite} at ${J$.iidToLocation(J$.sid, iid)}`);
    }

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        const sobj = this._sandbox.smemory.getShadowObject(base, offset, false).owner;
        this._log(`Store '${offset}' of object allocated at ${sobj?.allocSite}) at ${J$.iidToLocation(J$.sid, iid)}`);
    }

    endExecution() {
        if (this._sandbox.Results) {
            for (const entry of this._logs) this._sandbox.log(entry);
        }
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new LogLoadStoreAllocAnalysis(J$);
}
