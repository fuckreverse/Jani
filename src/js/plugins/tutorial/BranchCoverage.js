// JALANGI DO NOT INSTRUMENT

/**
 * @file BranchCoverage —— 统计每个条件表达式分支被执行的次数。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/plugins/tutorial/BranchCoverage.js \
 *     tests/pldi16/BranchCoverageTest.js
 */

export class BranchCoverageAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._trueBranches  = {};
        this._falseBranches = {};
    }

    conditional(iid, result) {
        const id = this._sandbox.getGlobalIID(iid);
        if (result) {
            this._trueBranches[id]  = (this._trueBranches[id]  | 0) + 1;
        } else {
            this._falseBranches[id] = (this._falseBranches[id] | 0) + 1;
        }
    }

    endExecution() {
        const log = (str) => this._sandbox.log(str);
        const iidToLocation = (id) => this._sandbox.iidToLocation(id);

        for (const id of Object.keys(this._trueBranches)) {
            log(`True branch taken at ${iidToLocation(id)} ${this._trueBranches[id]} times`);
        }
        for (const id of Object.keys(this._falseBranches)) {
            log(`False branch taken at ${iidToLocation(id)} ${this._falseBranches[id]} times`);
        }
    }
}
