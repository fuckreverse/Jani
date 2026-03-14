// JALANGI DO NOT INSTRUMENT

/**
 * @file AntiDetection — 反插桩对抗工具集。
 *
 * 恶意脚本常用以下手段检测运行时是否被插桩：
 *   1. `Function.prototype.toString()` 检测函数体是否含插桩注入代码
 *   2. `typeof J$ !== 'undefined'` 等全局变量泄露检测
 *   3. 性能异常检测（某些操作比正常慢 10 倍以上）
 *   4. 调用栈深度检测（`new Error().stack` 看到大量 `J$` 调用）
 *
 * 本模块提供针对上述手段的对策，按需引入，不影响正常插桩分析功能。
 *
 * ### 使用方式
 *
 * ```js
 * import { installToStringHook, createContextWrapper } from './AntiDetection.js';
 *
 * // 1. 安装 Function.toString 拦截器（在脚本初始化时，J$.Se 之前调用）
 * installToStringHook();
 *
 * // 2. 包装 setTimeout/Promise 回调，同时管理异步上下文（结合 TODO-15）
 * const wrappedCb = createContextWrapper(originalCallback, J$);
 * setTimeout(wrappedCb, delay);
 * ```
 *
 * @module AntiDetection
 */

import { $push, $defineProperty, $apply } from './NativeProxy.js';

// ── Function.toString Hook ────────────────────────────────────────────────────

/**
 * 原始 Function.prototype.toString 引用（在 Hook 安装前捕获）。
 * 注意：必须在任何代码修改 Function.prototype 前 import 本模块，
 * 否则 _origToString 可能已经是被修改后的版本。
 */
const _origToString = Function.prototype.toString;

/**
 * 原始函数代码缓存：instrumented function → 原始代码字符串。
 *
 * 由插桩器在代码生成阶段填充（可选）：
 * ```js
 * AntiDetection.registerOriginalCode(instrumentedFn, originalSource);
 * ```
 *
 * 若未填充，toString() 将回退到原始 JS 引擎行为（返回插桩后代码）。
 */
const _originalCodeMap = new WeakMap();

/**
 * 标记 Function.toString Hook 是否已安装（防止重复安装）。
 */
let _toStringHookInstalled = false;

/**
 * 安装 Function.prototype.toString 拦截器。
 *
 * 拦截逻辑：
 * - 若被调用的函数在 `_originalCodeMap` 中有注册的原始代码，返回该原始代码；
 * - 否则，透传给原始 toString，表现为未插桩行为。
 *
 * 防重入安全：若已安装则直接返回，不重复修改 prototype。
 *
 * @returns {boolean}  安装成功返回 true，已安装则返回 false（幂等）
 */
export function installToStringHook() {
    if (_toStringHookInstalled) return false;
    _toStringHookInstalled = true;

    $defineProperty(Function.prototype, 'toString', {
        value: function toStringHook() {
            const orig = _originalCodeMap.get(this);
            if (orig !== undefined) return orig;
            return _origToString.call(this);
        },
        writable:     true,   // 必须为 true，否则 uninstallToStringHook 无法恢复
        configurable: true,   // 必须为 true，否则 Object.defineProperty 恢复时抛 TypeError
        enumerable:   false,
    });

    return true;
}

/**
 * 卸载 Function.prototype.toString Hook（恢复原始行为）。
 * 用于测试或调试场景。
 *
 * @returns {boolean}  卸载成功返回 true，未安装则返回 false
 */
export function uninstallToStringHook() {
    if (!_toStringHookInstalled) return false;
    _toStringHookInstalled = false;

    $defineProperty(Function.prototype, 'toString', {
        value:        _origToString,
        writable:     true,
        configurable: true,
        enumerable:   false,
    });

    return true;
}

/**
 * 注册一个函数的"原始代码"（插桩前的源码字符串）。
 * 当 toString() Hook 被安装后，对该函数调用 toString() 时返回此字符串。
 *
 * 建议由插桩器在 J$.T（literal，type=function）阶段调用：
 * ```js
 * // 在 esnstrument.js 生成函数字面量时，将原始代码存入 iid→source 表
 * // 在运行时 T() 钩子中调用：
 * registerOriginalCode(val, originalSourceForThisIid);
 * ```
 *
 * @param {Function} instrumentedFn  插桩后的函数对象
 * @param {string}   originalCode    插桩前的原始代码字符串
 */
export function registerOriginalCode(instrumentedFn, originalCode) {
    if (typeof instrumentedFn !== 'function') return;
    _originalCodeMap.set(instrumentedFn, originalCode);
}

// ── 全局变量泄露检测对抗 ──────────────────────────────────────────────────────

/**
 * 检查当前环境中是否存在已知的插桩指纹全局变量。
 * 用于自检：插桩框架应当对被分析代码完全不可见。
 *
 * 已知指纹：
 * - `window.J$` / `globalThis.J$`（旧式 Jalangi 全局暴露）
 * - `window.__jalangi2`（部分 fork 的暴露方式）
 *
 * @returns {string[]}  已发现的泄露变量名列表（期望为空数组）
 */
export function detectGlobalLeaks() {
    const leaks = [];
    const knownLeakNames = ['J$', '__jalangi2', '__jalangi', '_jalangi_'];

    for (const name of knownLeakNames) {
        try {
            if (typeof globalThis[name] !== 'undefined') {
                $push(leaks, name);
            }
        } catch (_) {
            // 部分环境不允许访问某些全局属性
        }
    }

    return leaks;
}

// ── 异步上下文包装器（结合 TODO-15 的 ContextID 机制） ───────────────────────

/**
 * 包装一个异步回调函数，使其在执行时自动分配并激活新的 ContextID。
 *
 * 适用于以下场景：
 * - `setTimeout(wrappedCb, delay)` — 确保定时器回调在独立上下文中执行
 * - `Promise.then(wrappedCb)` — 确保 then 回调在独立上下文中执行
 * - `new Promise(wrappedExecutor)` — 确保 executor 在独立上下文中执行
 *
 * ```js
 * import { createContextWrapper } from './AntiDetection.js';
 *
 * // 在插桩代码中包装 setTimeout 调用（由 esnstrument.js 的 visitorOps 注入）
 * setTimeout(J$.createContextWrapper(originalCallback, J$), delay);
 * ```
 *
 * @param {Function} callback  原始回调函数
 * @param {object}   runtime   JalangiRuntime 实例（提供 newAsyncContext / activateContext）
 * @returns {Function}  包装后的回调（每次调用分配新的 ContextID）
 */
export function createContextWrapper(callback, runtime) {
    if (!runtime?.newAsyncContext) {
        // 若运行时不支持 ContextID，透传回调（降级）
        return callback;
    }

    const contextId = runtime.newAsyncContext();

    return function wrappedCallback(...args) {
        runtime.activateContext(contextId);
        try {
            return $apply(callback, this, args);
        } finally {
            // 回调执行完后重置到顶层上下文（0 = 同步）
            runtime.activateContext(0);
        }
    };
}

// ── 性能指纹对抗 ──────────────────────────────────────────────────────────────

/**
 * 简单的性能基准测量（用于自检插桩开销）。
 * 运行 `iterations` 次空函数调用，返回每次调用的平均耗时（微秒）。
 *
 * 可在分析开始前调用，判断当前环境的插桩开销是否在可接受范围内。
 * 若超过 `maxUsPerCall` 阈值，说明插桩产生了可被检测到的性能异常。
 *
 * @param {number} [iterations=1000]  测试迭代次数
 * @param {number} [maxUsPerCall=10]  最大可接受单次调用耗时（微秒）
 * @returns {{ avgUs: number, acceptable: boolean }}
 */
export function benchmarkCallOverhead(iterations = 1000, maxUsPerCall = 10) {
    const noop = () => {};
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

    for (let i = 0; i < iterations; i++) {
        noop();
    }

    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    const avgUs   = (elapsed * 1000) / iterations; // 转换为微秒

    return {
        avgUs,
        acceptable: avgUs <= maxUsPerCall,
    };
}
