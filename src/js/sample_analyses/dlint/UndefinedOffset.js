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
 * @file UndefinedOffset —— 检测用 undefined 作为属性键访问/写入属性的情况。
 *
 * 用法：
 *   import { UndefinedOffset } from './UndefinedOffset.js';
 *   sandbox.analysis = new UndefinedOffset(sandbox);
 */

import { printInfo } from './Utils.js';

export class UndefinedOffset {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._info    = {};
    }

    getFieldPre(iid, base, offset) {
        if (offset === undefined) {
            const giid = this._sandbox.getGlobalIID(iid);
            this._info[giid] = (this._info[giid] | 0) + 1;
        }
    }

    putFieldPre(iid, base, offset, val) {
        if (offset === undefined) {
            const giid = this._sandbox.getGlobalIID(iid);
            this._info[giid] = (this._info[giid] | 0) + 1;
        }
    }

    endExecution() {
        const sandbox = this._sandbox;
        printInfo(this._info, x => {
            sandbox.log(
                `Accessed property 'undefined' at ` +
                `${sandbox.iidToLocation(x.iid)} ${x.count} time(s).`
            );
        });
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new UndefinedOffset(J$);
}
