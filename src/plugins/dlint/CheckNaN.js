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
 * @file CheckNaN —— 检测 NaN 参与比较运算的情况。
 *
 * 用法：
 *   import { CheckNaN } from './CheckNaN.js';
 *   sandbox.analysis = new CheckNaN(sandbox);
 *
 */

import { printInfo } from './Utils.js';

export class CheckNaN {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._info    = {};
    }

    binary(iid, op, left, right, result) {
        if (
            op === '==' || op === '===' || op === '!=' || op === '!==' ||
            op === '<'  || op === '>'   || op === '<=' || op === '>='
        ) {
            if (Number.isNaN(left) || Number.isNaN(right)) {   // Q-4 修复：改用 Number.isNaN()（替代 x !== x 惯用法）
                const giid = this._sandbox.getGlobalIID(iid);
                this._info[giid] = (this._info[giid] | 0) + 1;
            }
        }
    }

    endExecution() {
        const sandbox = this._sandbox;
        printInfo(this._info, x => {
            sandbox.log(`Comparison with NaN at ${sandbox.iidToLocation(x.iid)} ${x.count} time(s).`);
        });
    }
}
