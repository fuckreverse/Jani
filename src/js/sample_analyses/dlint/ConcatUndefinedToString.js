// JALANGI DO NOT INSTRUMENT

/*
 * Copyright (c) 2014 Samsung Electronics Co., Ltd.
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
 * @file ConcatUndefinedToString —— 检测 undefined/null 与字符串拼接的情况。
 *
 * 用法：
 *   import { ConcatUndefinedToString } from './ConcatUndefinedToString.js';
 *   sandbox.analysis = new ConcatUndefinedToString(sandbox);
 */

import { printInfo } from './Utils.js';

export class ConcatUndefinedToString {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._info    = {};
    }

    binary(iid, op, left, right, result) {
        if (op === '+') {
            if ((left === undefined || left === null) && typeof right === 'string') {
                const giid = this._sandbox.getGlobalIID(iid);
                this._info[giid] = (this._info[giid] | 0) + 1;
            } else if ((right === undefined || right === null) && typeof left === 'string') {
                const giid = this._sandbox.getGlobalIID(iid);
                this._info[giid] = (this._info[giid] | 0) + 1;
            }
        }
    }

    endExecution() {
        const sandbox = this._sandbox;
        printInfo(this._info, x => {
            sandbox.log(
                `Concatenating undefined or null to a string at ` +
                `${sandbox.iidToLocation(x.iid)} ${x.count} time(s).`
            );
        });
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new ConcatUndefinedToString(J$);
}
