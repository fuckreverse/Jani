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
 * @file SpecialCoverage —— 记录每轮测试的分支覆盖并调用 Features.addCoverage。
 * @author Koushik Sen
 *
 * 依赖 sandbox.Features（由 AddCoverage.js 安装）。
 */

export class SpecialCoverageAnalysis {
    constructor(sandbox) {
        this._sandbox           = sandbox;
        this._branches          = [];
        this._branchSidToFileName = [];
        this._testCode          = null;
        this._testIndex         = 0;
    }

    _getBranchInfo() {
        const sandbox = this._sandbox;
        let branchInfo = this._branches[sandbox.sid - 1];
        if (!branchInfo) {
            const fileName = sandbox.smap[sandbox.sid]?.originalCodeFileName;
            branchInfo = {};
            this._branches[sandbox.sid - 1]          = branchInfo;
            this._branchSidToFileName[sandbox.sid - 1] = fileName;
        }
        return branchInfo;
    }

    /** 每轮测试开始时调用（由 mocha_prefix / qunit_prefix 触发）。 */
    beginExecution(code) {
        this._testCode          = code;
        this._branches          = [];
        this._branchSidToFileName = [];
    }

    conditional(iid, result) {
        const branchInfo = this._getBranchInfo();
        if (result) {
            branchInfo[iid]     = 1;
        } else {
            branchInfo[iid - 1] = 1;
        }
    }

    endExpression(iid) {
        const branchInfo = this._getBranchInfo();
        branchInfo[iid]  = 2;
    }

    endExecution(noadd) {
        const ret = {};
        for (let i = 0; i < this._branches.length; i++) {
            if (this._branches[i] !== undefined) {
                ret[this._branchSidToFileName[i]] = this._branches[i];
            }
        }
        this._testIndex++;
        const stat = this._sandbox.Features.addCoverage(this._testCode, ret, !noadd);
        console.log(`Modified feature graph ${stat.modified}`);
    }
}
