// JALANGI DO NOT INSTRUMENT

/**
 * @file LogData —— 记录对象字段访问、变量读写和函数调用，输出结构化 trace（配合 TraceWriter）。
 *
 * 需要配合 SMemory 和 TraceWriter 使用：
 *   node src/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/plugins/ChainedAnalyses.js \
 *     --analysis src/runtime/SMemory.js \
 *     --analysis src/plugins/datatraces/TraceWriter.js \
 *     --analysis src/plugins/datatraces/LogData.js \
 *     tests/octane/deltablue.js
 */

export class LogDataAnalysis {
    constructor(sandbox) {
        this._sandbox     = sandbox;
        this._stringMap   = {};
        this._stringList  = [];
        this._stringCount = 0;
        this._lastiid     = -1;
        this._lastsid     = -1;

        const HOP = this._sandbox.Constants.HOP;
        this._HOP = HOP;

        this._traceWriter = new this._sandbox.TraceWriter('trace.log');
    }

    _logEvent(str) {
        this._traceWriter.logToFile(str + '\n');
    }

    _getStringIndex(str) {
        if (typeof str === 'number' && str >= 0) return str;
        str = String(str);
        if (this._HOP(this._stringMap, str)) return this._stringMap[str];
        this._stringCount++;
        this._stringMap[str] = this._stringCount;
        this._stringList.push(str);
        return -this._stringCount;
    }

    _getValue(v) {
        const type = typeof v;
        if ((type === 'object' || type === 'function') && v !== null) {
            const shadowObj = this._sandbox.smemory.getShadowObjectOfObject(v);
            return this._sandbox.smemory.getIDFromShadowObjectOrFrame(shadowObj);
        } else if (type === 'string') {
            return this._getStringIndex(v);
        }
        return v;
    }

    _getType(v) {
        const type = typeof v;
        if ((type === 'object' || type === 'function') && v !== null) return 'O';
        if (type === 'string') return 'S';
        return 'P';
    }

    callPre(iid, f, base, args, isConstructor, isMethod, functionIid) {
        this._lastiid = iid;
        this._lastsid = this._sandbox.sid;
    }

    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        this._lastiid = iid;
        this._lastsid = this._sandbox.sid;
    }

    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        const mem       = this._sandbox.smemory;
        const so        = mem.getShadowObjectOfObject(base);
        const objectId  = so ? mem.getIDFromShadowObjectOrFrame(so) : 0;
        const shadowObj = mem.getShadowObject(base, offset, true);
        const ownerId   = shadowObj.owner ? mem.getIDFromShadowObjectOrFrame(shadowObj.owner) : 0;
        if (shadowObj.isProperty) {
            this._logEvent(`G,${this._sandbox.sid},${iid},${objectId},${ownerId},${this._getStringIndex(offset)},${this._getValue(val)},${this._getType(val)}`);
        }
    }

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        this._lastiid = iid;
        this._lastsid = this._sandbox.sid;
        const mem       = this._sandbox.smemory;
        const objectId  = mem.getIDFromShadowObjectOrFrame(mem.getShadowObjectOfObject(base));
        const shadowObj = mem.getShadowObject(base, offset, false);
        const ownerId   = shadowObj.owner ? mem.getIDFromShadowObjectOrFrame(shadowObj.owner) : 0;
        if (shadowObj.isProperty) {
            this._logEvent(`P,${this._sandbox.sid},${iid},${objectId},${ownerId},${this._getStringIndex(offset)},${this._getValue(val)},${this._getType(val)}`);
        }
    }

    read(iid, name, val, isGlobal, isScriptLocal) {
        const mem  = this._sandbox.smemory;
        const sf   = mem.getShadowFrame(name);
        this._logEvent(`R,${this._sandbox.sid},${iid},${mem.getIDFromShadowObjectOrFrame(sf)},${this._getStringIndex(name)},${this._getValue(val)},${this._getType(val)}`);
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        const mem  = this._sandbox.smemory;
        const sf   = mem.getShadowFrame(name);
        this._logEvent(`W,${this._sandbox.sid},${iid},${mem.getIDFromShadowObjectOrFrame(sf)},${this._getStringIndex(name)},${this._getValue(val)},${this._getType(val)}`);
    }

    functionEnter(iid, f, dis, args) {
        const mem = this._sandbox.smemory;
        const sf  = mem.getShadowFrame('this');
        this._logEvent(`C,${this._lastsid},${this._lastiid},${this._getValue(f)},${mem.getIDFromShadowObjectOrFrame(sf)}`);
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        this._logEvent(`E,${this._sandbox.sid},${iid},${this._getValue(returnVal)},${this._getType(returnVal)}`);
    }

    endExecution() {
        this._traceWriter.stopTracing();

        const twStrings = new this._sandbox.TraceWriter('strings.json');
        twStrings.logToFile(JSON.stringify(this._stringList) + '\n');
        twStrings.stopTracing();

        const twSmap = new this._sandbox.TraceWriter('smap.json');
        twSmap.logToFile(JSON.stringify(this._sandbox.smap) + '\n');
        twSmap.stopTracing();
    }

    shouldInstrumentFn(iid, f, functionIid) { return false; }

    onReady(cb) { cb(); }
}
