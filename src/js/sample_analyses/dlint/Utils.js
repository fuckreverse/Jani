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
 * @file dlint 通用工具函数。
 *
 * 用法：
 *   import { printInfo } from './Utils.js';
 *
 * 或通过 sandbox.Utils 访问（向后兼容）：
 *   sandbox.Utils.printInfo(info, printer);
 */

/**
 * 将 iid→count 的统计对象按 count 排序后，逐项调用 printer。
 * 只打印 count > 0 的项。
 *
 * @param {object}   info                  - 形如 { giid: count } 的计数对象
 * @param {Function} printer               - 打印回调，接收 { iid, count } 对象
 * @param {Function} [iidToLocation]       - 可选，将 giid 转为可读位置字符串
 */
export function printInfo(info, printer, iidToLocation) {
    const items = Object.keys(info)
        .map(giid => ({ iid: iidToLocation ? iidToLocation(giid) : giid, count: info[giid] }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count);

    for (const item of items) {
        printer(item);
    }
}

// 向后兼容：挂到 sandbox.Utils
if (typeof J$ !== 'undefined') {
    J$.Utils = { printInfo: (info, printer) => printInfo(info, printer, J$.iidToLocation?.bind(J$)) };
}
