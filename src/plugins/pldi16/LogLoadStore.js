// JALANGI DO NOT INSTRUMENT

/**
 * @file LogLoadStore —— 记录每次对象属性读写及变量读写，并打印 shadow ID。
 * @author Koushik Sen
 *
 * 需要配合 SMemory 使用：
 *   node src/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/plugins/ChainedAnalyses.js \
 *     --analysis src/runtime/SMemory.js \
 *     --analysis src/plugins/pldi16/LogLoadStore.js \
 *     tests/pldi16/CountObjectsPerAllocationSiteTest.js
 */

export class LogLoadStoreAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._indentation = 0;
        this._cacheCount  = 0;
        this._cacheStr    = '';
    }

    _log(str) {
        if (this._cacheCount !== this._indentation) {
            this._cacheStr    = '    '.repeat(this._indentation);
            this._cacheCount  = this._indentation;
        }
        this._sandbox.log(this._cacheStr + str);
    }

    callPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid) {
        this._indentation++;
        return { f, base, args, skip: false };
    }

    call(iid, f, base, args, result, isConstructor, isMethod, functionIid, functionSid) {
        this._indentation--;
        return { result };
    }

    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        const mem = this._sandbox.smemory;
        const id  = mem.getIDFromShadowObjectOrFrame(mem.getShadowObject(base, offset, true).owner);
        this._log(`Load of object(id=${id}).${offset} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
    }

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        const mem = this._sandbox.smemory;
        const id  = mem.getIDFromShadowObjectOrFrame(mem.getShadowObject(base, offset, false).owner);
        this._log(`Store of object(id=${id}).${offset}) at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
    }

    read(iid, name, val, isGlobal, isScriptLocal) {
        const mem     = this._sandbox.smemory;
        const frameId = mem.getIDFromShadowObjectOrFrame(mem.getShadowFrame(name));
        this._log(`Load of frame(id=${frameId}).${name} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
        return { result: val };
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        const mem     = this._sandbox.smemory;
        const frameId = mem.getIDFromShadowObjectOrFrame(mem.getShadowFrame(name));
        this._log(`Store of frame(id=${frameId}).${name} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
        return { result: val };
    }

    endExecution() {}
}
