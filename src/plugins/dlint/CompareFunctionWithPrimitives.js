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
 * @file CompareFunctionWithPrimitives —— 检测将函数与原始值做比较（可能忘记调用该函数）。
 *
 * 用法：
 *   import { CompareFunctionWithPrimitives } from './CompareFunctionWithPrimitives.js';
 *   sandbox.analysis = new CompareFunctionWithPrimitives(sandbox);
 */

import { printInfo } from './Utils.js';

const COMPARISON_OPS = new Set(['==', '===', '!==', '!=', '<', '>', '<=', '>=']);
const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean']);

export class CompareFunctionWithPrimitives {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._info    = {};
    }

    binary(iid, op, left, right, result) {
        if (COMPARISON_OPS.has(op)) {
            const t1 = typeof left;
            const t2 = typeof right;
            if (
                (t1 === 'function' && PRIMITIVE_TYPES.has(t2)) ||
                (t2 === 'function' && PRIMITIVE_TYPES.has(t1))
            ) {
                const giid = this._sandbox.getGlobalIID(iid);
                this._info[giid] = (this._info[giid] | 0) + 1;
            }
        }
    }

    endExecution() {
        const sandbox = this._sandbox;
        printInfo(this._info, x => {
            sandbox.log(
                `Comparing a function with a number or string or boolean at ` +
                `${sandbox.iidToLocation(x.iid)} ${x.count} time(s).`
            );
        });
    }
}
