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
 * @file StatCollector —— 轻量级性能统计（计时器、计数器、累加器）。
 *
 * 可在 Node.js 中直接运行（打印已保存的统计数据）：
 *   node src/js/utils/StatCollector.js
 */

import { readFileSync, writeFileSync } from 'fs';

const STATS_FILE_NAME = 'jalangi_stats';

let timers       = {};
let counters     = {};
let accumulators = {};

/** @type {boolean} 可在外部设置为 false 以禁用所有统计 */
export const STAT_FLAG = true;

/**
 * 启动（或恢复）命名计时器。
 * @param {string} timerName
 */
export function resumeTimer(timerName) {
    let timer = timers[timerName];
    if (!timer) {
        timer = timers[timerName] = { begin: -1, total: 0, count: 0 };
    }
    if (timer.begin >= 0) {
        throw new Error(`Trying to resume active timer ${timerName}`);
    }
    timer.begin = Date.now();
    timer.count++;
}

/**
 * 暂停命名计时器，累积耗时。
 * @param {string} timerName
 */
export function suspendTimer(timerName) {
    const now   = Date.now();
    const timer = timers[timerName];
    if (!timer) throw new Error(`Trying to suspend a non-existent timer ${timerName}`);
    if (timer.begin === -1) throw new Error(`Trying to suspend inactive timer ${timerName}`);
    timer.total += (now - timer.begin);
    timer.begin  = -1;
}

/**
 * 向累加器添加一个数值样本。
 * @param {string} accumulatorName
 * @param {number} val
 */
export function addToAccumulator(accumulatorName, val) {
    let acc = accumulators[accumulatorName];
    if (!acc) {
        acc = accumulators[accumulatorName] = { count: 0, sum: 0, max: undefined, min: undefined };
    }
    acc.count++;
    acc.sum += val;
    if (acc.max === undefined || val > acc.max) acc.max = val;
    if (acc.min === undefined || val < acc.min) acc.min = val;
}

/**
 * 计数器自增。
 * @param {string} counterName
 */
export function addToCounter(counterName) {
    counters[counterName] = (counters[counterName] | 0) + 1;
}

/** 从磁盘加载已保存的统计数据。 */
export function loadStats() {
    try {
        const tmp = JSON.parse(readFileSync(STATS_FILE_NAME, 'utf8'));
        timers       = tmp.timers;
        counters     = tmp.counters;
        accumulators = tmp.accumulators;
    } catch { /* 文件不存在时静默忽略 */ }
}

/** 将当前统计数据持久化到磁盘。 */
export function storeStats() {
    writeFileSync(STATS_FILE_NAME, JSON.stringify({ timers, counters, accumulators }), 'utf8');
}

/** 打印所有统计数据到控制台。 */
export function printStats() {
    for (const timer of Object.keys(timers)) {
        const t = timers[timer];
        console.log(`Time spent in ${timer} = ${t.total} ms (count = ${t.count})`);
    }
    for (const counter of Object.keys(counters)) {
        console.log(`Number of ${counter} = ${counters[counter]}`);
    }
    for (const name of Object.keys(accumulators)) {
        const a = accumulators[name];
        console.log(`${name}: average = ${a.sum / a.count} max = ${a.max} min = ${a.min}`);
    }
}

/**
 * 向后兼容对象（供旧代码通过 StatCollector.xxx 调用）
 */
export const StatCollector = {
    STAT_FLAG,
    resumeTimer,
    suspendTimer,
    addToAccumulator,
    addToCounter,
    loadStats,
    storeStats,
    printStats,
};

// ─── 独立运行模式 ────────────────────────────────────────────────────────────

const isMain = (typeof process !== 'undefined') &&
    process.argv[1] &&
    (new URL(import.meta.url)).pathname === process.argv[1];

if (isMain) {
    loadStats();
    printStats();
}
