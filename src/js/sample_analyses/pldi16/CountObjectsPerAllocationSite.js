// JALANGI DO NOT INSTRUMENT

/**
 * @file CountObjectsPerAllocationSite —— 统计每个分配点创建的对象数。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/sample_analyses/pldi16/CountObjectsPerAllocationSite.js \
 *     tests/pldi16/CountObjectsPerAllocationSiteTest.js
 */

export class CountObjectsPerAllocationSiteAnalysis {
    constructor(sandbox) {
        this._sandbox    = sandbox ?? (typeof J$ !== 'undefined' ? J$ : null);
        this._allocCount = {};
    }

    literal(iid, val, hasGetterSetter) {
        if (typeof val === 'object' && val !== null) {
            const id = this._sandbox.getGlobalIID(iid);
            this._allocCount[id] = (this._allocCount[id] | 0) + 1;
        }
    }

    invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid) {
        if (isConstructor) {
            const id = this._sandbox.getGlobalIID(iid);
            this._allocCount[id] = (this._allocCount[id] | 0) + 1;
        }
        return { f, base, args, skip: false };
    }

    endExecution() {
        const { log, iidToLocation } = this._sandbox;
        for (const [id, count] of Object.entries(this._allocCount)) {
            log(`Object allocated at ${iidToLocation(id)} = ${count}`);
        }
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new CountObjectsPerAllocationSiteAnalysis(J$);
}
