// JALANGI DO NOT INSTRUMENT

/**
 * @file SmemTest —— 演示 SMemory API：打印每次属性访问和变量读写对应的 shadow ID。
 *
 * 运行示例（需 SMemory）：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/sample_analyses/ChainedAnalyses.js \
 *     --analysis src/js/runtime/SMemory.js \
 *     --analysis src/js/sample_analyses/scratch/SmemTest.js \
 *     tests/octane/deltablue.js
 */

export class SmemTestAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
    }

    _getValue(v) {
        const type = typeof v;
        if ((type === 'object' || type === 'function') && v !== null) {
            const shadowObj = this._sandbox.smemory.getShadowObjectOfObject(v);
            return this._sandbox.smemory.getIDFromShadowObjectOrFrame(shadowObj);
        }
        return v;
    }

    literal(iid, val, hasGetterSetter) {
        if (typeof val === 'function') {
            console.log(`Function id:${this._getValue(val)}`);
        }
    }

    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        const mem       = this._sandbox.smemory;
        const shadowObj = mem.getShadowObject(base, offset, true);
        console.log(`GET_FIELD ${mem.getIDFromShadowObjectOrFrame(shadowObj.owner)}.${offset} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
    }

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        const mem       = this._sandbox.smemory;
        const shadowObj = mem.getShadowObject(base, offset, false);
        console.log(`PUT_FIELD ${mem.getIDFromShadowObjectOrFrame(shadowObj.owner)}.${offset} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
    }

    read(iid, name, val, isGlobal, isScriptLocal) {
        const mem       = this._sandbox.smemory;
        const shadowObj = mem.getShadowFrame(name);
        console.log(`READ ${mem.getIDFromShadowObjectOrFrame(shadowObj)}.${name} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        const mem       = this._sandbox.smemory;
        const shadowObj = mem.getShadowFrame(name);
        console.log(`WRITE ${mem.getIDFromShadowObjectOrFrame(shadowObj)}.${name} at ${this._sandbox.iidToLocation(this._sandbox.sid, iid)}`);
    }
}
