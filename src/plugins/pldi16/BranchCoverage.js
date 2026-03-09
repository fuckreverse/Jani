// JALANGI DO NOT INSTRUMENT

/**
 * @file BranchCoverage —— 统计每个条件表达式分支被执行的次数。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/plugins/pldi16/BranchCoverage.js \
 *     tests/pldi16/BranchCoverageTest.js
 */

export class BranchCoverageAnalysis {
    constructor(sandbox) {
        this._sandbox      = sandbox;
        this._trueBranches  = {};
        this._falseBranches = {};
    }

    evalCond(iid, result) {
        const id = this._sandbox.getGlobalIID(iid);
        if (result) {
            this._trueBranches[id]  = (this._trueBranches[id]  | 0) + 1;
        } else {
            this._falseBranches[id] = (this._falseBranches[id] | 0) + 1;
        }
    }

    endExecution() {
        const { log, iidToLocation } = this._sandbox;
        for (const id of Object.keys(this._trueBranches)) {
            log(`True branch taken at ${iidToLocation(id)} ${this._trueBranches[id]} times`);
        }
        for (const id of Object.keys(this._falseBranches)) {
            log(`False branch taken at ${iidToLocation(id)} ${this._falseBranches[id]} times`);
        }
    }
}
