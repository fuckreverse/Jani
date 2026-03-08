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
 * @file FunCalledWithMoreArguments —— 检测函数被传入的实参多于其形参数的情况。
 *
 * 用法：
 *   import { FunCalledWithMoreArguments } from './FunCalledWithMoreArguments.js';
 *   sandbox.analysis = new FunCalledWithMoreArguments(sandbox);
 */

import { printInfo } from './Utils.js';

export class FunCalledWithMoreArguments {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._info    = {};
    }

    callPre(iid, f, base, args, isConstructor, isMethod) {
        // 只检查有 length 属性的普通函数（排除内置/native 函数，其 length 可能不反映真实参数数）
        // BUG-PLG-01 修复：跳过含 rest 参数的函数。
        // f.length 只计算第一个 rest 参数之前的形参数量，因此 function f(a, ...rest) 的 length=1，
        // 传入 f(1, 2, 3) 时 args.length=3 > f.length=1 会被误报。
        // 通过 toString() 检测函数签名中是否含有 rest 参数（...identifier），跳过此类函数。
        let hasRestParam = false;
        try {
            hasRestParam = /\(\.\.\.\w|,\s*\.\.\.\w/.test(Function.prototype.toString.call(f));
        } catch (_) {
            // native 函数 toString 可能抛出，保守处理：不报告
            hasRestParam = true;
        }
        if (
            !hasRestParam &&
            typeof f === 'function' &&
            typeof f.length === 'number' &&
            !isConstructor &&
            args.length > f.length
        ) {
            const giid = this._sandbox.getGlobalIID(iid);
            this._info[giid] = (this._info[giid] | 0) + 1;
        }
        return { f, base, args, skip: false };
    }

    endExecution() {
        const sandbox = this._sandbox;
        printInfo(this._info, x => {
            sandbox.log(
                `Function called with more arguments than the number of declared parameters at ` +
                `${sandbox.iidToLocation(x.iid)} ${x.count} time(s).`
            );
        });
    }
}
