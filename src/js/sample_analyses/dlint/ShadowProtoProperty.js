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
 * @file ShadowProtoProperty —— 检测属性写入时是否遮蔽了原型链上的同名属性。
 *
 * 用法：
 *   import { ShadowProtoProperty } from './ShadowProtoProperty.js';
 *   sandbox.analysis = new ShadowProtoProperty(sandbox);
 */

import { printInfo } from './Utils.js';

export class ShadowProtoProperty {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._info    = {};
    }

    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        if (
            base !== null &&
            base !== undefined &&
            typeof offset === 'string' &&
            !Object.prototype.hasOwnProperty.call(base, offset)
        ) {
            // 检查原型链上是否存在该属性
            const proto = Object.getPrototypeOf(base);
            if (proto !== null && offset in proto) {
                const giid = this._sandbox.getGlobalIID(iid);
                this._info[giid] = (this._info[giid] | 0) + 1;
            }
        }
        return { base, offset, val, skip: false };
    }

    endExecution() {
        const sandbox = this._sandbox;
        printInfo(this._info, x => {
            sandbox.log(
                `Shadowing a property of the prototype at ` +
                `${sandbox.iidToLocation(x.iid)} ${x.count} time(s).`
            );
        });
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new ShadowProtoProperty(J$);
}
