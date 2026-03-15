// JALANGI DO NOT INSTRUMENT

/**
 * @file diagnostics.js — Jalangi2 诊断日志工厂
 *
 * 提供两级日志分类：
 *   1. 域（domain）：代码所属模块，如 'framework'、'backend:ws'、'trace-infra' 等
 *   2. 级别（level）：error / warn / info / debug
 *
 * 级别语义：
 *   error  — 不可恢复错误，始终同步输出到 console.error，完全不受速率限制
 *   warn   — 非预期但可继续，输出到 console.warn，宽松速率限制
 *   info   — 关键里程碑（脚本开始/结束、backend 就绪），输出到 console.log，严格速率限制
 *   debug  — 运行细节（flush 计数、RingBuffer 状态），默认关闭，按域开关控制，严格速率限制
 *
 * Trace 数据（高频插桩事件）不走本模块——应通过 LogManager 缓冲后端输出。
 *
 * ─── Debug 开关 ───────────────────────────────────────────────────────────────
 *
 * Node.js：环境变量 JALANGI_DEBUG
 *   JALANGI_DEBUG=1          → 开启所有域的 debug 输出
 *   JALANGI_DEBUG=*          → 同上
 *   JALANGI_DEBUG=framework  → 只开启 'framework' 域
 *   JALANGI_DEBUG=backend:ws,backend:node  → 开启多个域（逗号分隔）
 *
 * 浏览器：localStorage.jalangiDebug
 *   localStorage.jalangiDebug = '1'          → 开启所有域
 *   localStorage.jalangiDebug = 'backend:idb' → 只开启指定域
 *
 * ─── 使用方式 ─────────────────────────────────────────────────────────────────
 *
 *   import { createDiagLogger } from '../../logger/diagnostics.js';
 *   const log = createDiagLogger('backend:ws');
 *
 *   log.error('connection failed:', err.message);  // 始终输出，不受限制
 *   log.warn('retrying in 500ms');                 // 宽松速率限制
 *   log.info('backend ready');                     // 严格速率限制
 *   log.debug('batch sent, size=', batch.length);  // 仅 debug 开关开启时输出
 *
 * ─── 速率限制配置 ──────────────────────────────────────────────────────────────
 *
 *   import { setRateLimit, resetRateLimiters } from '../../logger/diagnostics.js';
 *
 *   // 调整速率参数（全局生效，0 = 不限制）
 *   setRateLimit({ warnPerWindow: 50, infoPerWindow: 20, windowMs: 5000 });
 *
 *   // 重置指定域或所有域的速率状态（如单测场景）
 *   resetRateLimiters('analysis');   // 只重置 analysis 域
 *   resetRateLimiters();             // 重置所有域
 *
 * ─── 内置域名约定 ──────────────────────────────────────────────────────────────
 *
 *   'framework'    JalangiRuntime, JalangiSandbox, HookDispatcher
 *   'instrument'   astUtil, pluginAnalyzer, esnstrument
 *   'trace-infra'  LogManager, TraceLogger（Trace 基础设施自身的诊断域）
 *   'backend:idb'  IdbBackend, idb.worker
 *   'backend:ws'   WsBackend
 *   'backend:node' NodeStreamBackend
 *   'backend:mem'  MemoryBackend（通常无需 debug）
 *   'analysis'     分析插件业务日志（通过 J$.log 路由）
 */

// ── 运行环境检测 ────────────────────────────────────────────────────────────────
const IS_BROWSER = typeof window !== 'undefined' || typeof globalThis.self !== 'undefined';

// ── 控制台速率限制 ──────────────────────────────────────────────────────────────
//
// 设计目标：防止大规模分析场景（如 JD 安全脚本）中海量日志把浏览器卡死，
// 同时保证关键信息不被完全淹没。
//
// 四项策略：
//   1. 按域独立限速：每个 domain 各自维护独立状态，互不影响
//   2. 按级别差异处理：
//        error  — 完全不限速（始终输出）
//        warn   — 宽松：默认 20 条/10s
//        info   — 严格：默认 10 条/10s
//        debug  — 严格：默认 10 条/10s
//   3. 滑动窗口速率限制：以时间窗口（windowMs）内最大输出条数衡量，
//      窗口结束后自动重置，避免"一次爆发永久封禁"的问题
//   4. 采样输出：超限后不完全静默，每跳过 sampleEvery 条输出一次，
//      附带"已跳过 N 条"提示，信息不完全丢失
//

/**
 * 全局速率限制配置。
 * 可通过 setRateLimit(options) 调整。
 *
 * @typedef {object} RateConfig
 * @property {number} warnPerWindow   - warn 级别每窗口最多输出条数（0 = 不限制）
 * @property {number} infoPerWindow   - info 级别每窗口最多输出条数（0 = 不限制）
 * @property {number} debugPerWindow  - debug 级别每窗口最多输出条数（0 = 不限制）
 * @property {number} windowMs        - 滑动窗口大小（毫秒）
 * @property {number} sampleEvery     - 超限后每跳过 N 条才输出一次（0 = 完全静默）
 */

/** @type {RateConfig} */
let _rateConfig = {
    warnPerWindow:  20,
    infoPerWindow:  10,
    debugPerWindow: 10,
    windowMs:       10_000,
    sampleEvery:    10,
};

/**
 * 每个 (domain, level) 组合对应的速率状态。
 * key 格式：`${domain}\0${level}`（用 \0 分隔，避免与域名中的 ':' 冲突）
 *
 * @typedef {object} RateState
 * @property {number} windowStart  - 当前窗口开始时间（ms）
 * @property {number} windowCount  - 当前窗口内已输出条数
 * @property {number} skipped      - 当前被跳过但尚未在采样行中汇报的条数
 */

/** @type {Map<string, RateState>} */
const _rateStates = new Map();

/**
 * 获取指定 (domain, level) 的速率状态，不存在则创建。
 *
 * @param {string} domain
 * @param {string} level
 * @returns {RateState}
 */
function _getState(domain, level) {
    const key = `${domain}\0${level}`;
    let state = _rateStates.get(key);
    if (!state) {
        state = { windowStart: 0, windowCount: 0, skipped: 0 };
        _rateStates.set(key, state);
    }
    return state;
}

/**
 * 返回指定级别对应的每窗口上限（Infinity 表示不限制）。
 *
 * @param {string} level
 * @returns {number}
 */
function _limitForLevel(level) {
    switch (level) {
        case 'error': return Infinity;
        case 'warn':  return _rateConfig.warnPerWindow  === 0 ? Infinity : _rateConfig.warnPerWindow;
        case 'info':  return _rateConfig.infoPerWindow  === 0 ? Infinity : _rateConfig.infoPerWindow;
        case 'debug': return _rateConfig.debugPerWindow === 0 ? Infinity : _rateConfig.debugPerWindow;
        default:      return Infinity;
    }
}

/**
 * 统一的控制台输出门控（含速率限制 + 采样）。
 *
 * 算法：
 *   1. error 级别直接输出，跳过所有速率逻辑
 *   2. 检查是否到了新窗口，若是则重置计数器（并在有积压跳过时补打一条汇总）
 *   3. 窗口内未超限：正常输出，windowCount++
 *   4. 窗口内超限：skipped++；若 skipped 达到 sampleEvery 的整数倍则输出一条采样行
 *
 * @param {Function} consoleFn  console.error / console.warn / console.log / console.debug
 * @param {string}   level      'error' | 'warn' | 'info' | 'debug'
 * @param {string}   domain     域名
 * @param {string}   prefix     输出前缀字符串
 * @param {Array}    args       原始参数
 */
function _gatedConsole(consoleFn, level, domain, prefix, args) {
    // error 完全不受限制
    if (level === 'error') {
        consoleFn(prefix, ...args);
        return;
    }

    const limit = _limitForLevel(level);

    // 速率限制已关闭（limit === Infinity 且 windowMs 不重要）
    if (limit === Infinity) {
        consoleFn(prefix, ...args);
        return;
    }

    const state = _getState(domain, level);
    const now   = Date.now();

    // 检查是否进入新窗口
    if (now - state.windowStart >= _rateConfig.windowMs) {
        // 若上一个窗口有未汇报的跳过条数，在新窗口第一条输出前补打汇总
        if (state.skipped > 0) {
            consoleFn(
                prefix,
                `（速率限制：上一窗口已跳过 ${state.skipped} 条日志）`
            );
        }
        // 重置窗口
        state.windowStart = now;
        state.windowCount = 0;
        state.skipped     = 0;
    }

    // 窗口内未超限：正常输出
    if (state.windowCount < limit) {
        consoleFn(prefix, ...args);
        state.windowCount++;
        return;
    }

    // 超限：累积跳过计数
    state.skipped++;

    // 采样：每跳过 sampleEvery 条输出一次（sampleEvery=0 则完全静默）
    const sampleEvery = _rateConfig.sampleEvery;
    if (sampleEvery > 0 && state.skipped % sampleEvery === 0) {
        consoleFn(
            prefix,
            `（速率限制：已跳过 ${state.skipped} 条）`,
            ...args
        );
    }
}

// ── 公共 API：速率限制控制 ──────────────────────────────────────────────────────

/**
 * 调整全局速率限制参数。传入的字段会合并到当前配置中（未传字段保持原值）。
 *
 * @param {Partial<RateConfig>} options
 * @param {number} [options.warnPerWindow]   warn 每窗口最多输出条数（0 = 不限制）
 * @param {number} [options.infoPerWindow]   info 每窗口最多输出条数（0 = 不限制）
 * @param {number} [options.debugPerWindow]  debug 每窗口最多输出条数（0 = 不限制）
 * @param {number} [options.windowMs]        窗口大小（毫秒）
 * @param {number} [options.sampleEvery]     超限后每隔 N 条输出一次（0 = 完全静默）
 *
 * @example
 * // 开发调试时放开限制
 * setRateLimit({ warnPerWindow: 0, infoPerWindow: 0, debugPerWindow: 0 });
 *
 * @example
 * // 高频分析场景收紧限制
 * setRateLimit({ warnPerWindow: 5, infoPerWindow: 3, windowMs: 5000, sampleEvery: 50 });
 */
export function setRateLimit(options) {
    if (options && typeof options === 'object') {
        if (typeof options.warnPerWindow  === 'number') _rateConfig.warnPerWindow  = options.warnPerWindow;
        if (typeof options.infoPerWindow  === 'number') _rateConfig.infoPerWindow  = options.infoPerWindow;
        if (typeof options.debugPerWindow === 'number') _rateConfig.debugPerWindow = options.debugPerWindow;
        if (typeof options.windowMs       === 'number') _rateConfig.windowMs       = options.windowMs;
        if (typeof options.sampleEvery    === 'number') _rateConfig.sampleEvery    = options.sampleEvery;
    }
}

/**
 * 重置速率状态（不改变速率参数）。
 *
 * 用途：单测场景中每个用例开始前调用，避免上一用例的计数污染当前用例。
 *
 * @param {string} [domain]  指定域名时只重置该域（所有级别）；不传则重置全部。
 *
 * @example
 * // 单测 teardown
 * resetRateLimiters();
 *
 * @example
 * // 只重置 analysis 域
 * resetRateLimiters('analysis');
 */
export function resetRateLimiters(domain) {
    if (domain !== undefined) {
        // 只删除该 domain 的所有 level 条目
        for (const key of _rateStates.keys()) {
            if (key.startsWith(`${domain}\0`)) {
                _rateStates.delete(key);
            }
        }
    } else {
        _rateStates.clear();
    }
}

// ── Debug 开关 ──────────────────────────────────────────────────────────────────

/**
 * 返回当前 debug 配置字符串（原始值）。
 * Node.js 每次读取 process.env，浏览器读 localStorage（有 try/catch 保护）。
 * @returns {string|null}
 */
function _rawDebugConfig() {
    if (!IS_BROWSER) {
        return (typeof process !== 'undefined') ? (process.env?.JALANGI_DEBUG ?? null) : null;
    }
    try {
        return localStorage?.getItem?.('jalangiDebug') ?? null;
    } catch {
        return null;
    }
}

/**
 * 判断指定域是否开启了 debug 输出。
 *
 * 规则：
 *   - 配置为空 / 未设置 → false
 *   - 配置为 '1' 或 '*' → 所有域都开启
 *   - 配置为逗号分隔的域名列表 → 精确匹配或前缀匹配
 *     例如 'backend' 可匹配 'backend:ws' 和 'backend:idb'
 *
 * @param {string} domain
 * @returns {boolean}
 */
function isDebugEnabled(domain) {
    const raw = _rawDebugConfig();
    if (!raw) return false;
    if (raw === '1' || raw === '*') return true;

    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        if (part === domain) return true;
        // 前缀匹配：'backend' 匹配 'backend:ws'
        if (domain.startsWith(part + ':')) return true;
    }
    return false;
}

// ── 域名常量 ────────────────────────────────────────────────────────────────────

/**
 * 内置域名常量，避免各模块硬编码字符串。
 *
 * 用法：
 *   import { createDiagLogger, DOMAIN } from '../../logger/diagnostics.js';
 *   const log = createDiagLogger(DOMAIN.FRAMEWORK);
 *
 * JALANGI_DEBUG 开关同样使用这些字符串：
 *   JALANGI_DEBUG=backend:ws,backend:node
 */
export const DOMAIN = Object.freeze({
    /** JalangiRuntime, JalangiSandbox, HookDispatcher */
    FRAMEWORK:    'framework',
    /** astUtil, pluginAnalyzer, esnstrument */
    INSTRUMENT:   'instrument',
    /** LogManager, TraceLogger（Trace 基础设施自身的诊断域） */
    TRACE_INFRA:  'trace-infra',
    /** IdbBackend, idb.worker */
    BACKEND_IDB:  'backend:idb',
    /** WsBackend */
    BACKEND_WS:   'backend:ws',
    /** NodeStreamBackend */
    BACKEND_NODE: 'backend:node',
    /** MemoryBackend（测试用，通常无需 debug） */
    BACKEND_MEM:  'backend:mem',
    /** 分析插件业务日志（通过 J$.log 路由） */
    ANALYSIS:     'analysis',
});

// ── DiagLogger 对象 ─────────────────────────────────────────────────────────────

/**
 * 创建一个绑定了域名前缀的诊断日志对象。
 *
 * 返回的对象包含四个方法：error / warn / info / debug。
 *   error  — 始终输出，完全不受速率限制
 *   warn   — 始终尝试输出，受宽松速率限制（默认 20 条/10s per domain）
 *   info   — 始终尝试输出，受严格速率限制（默认 10 条/10s per domain）
 *   debug  — 仅在对应域开启时尝试输出，受严格速率限制
 *
 * 速率限制均按域独立计算，互不影响。
 * 超出速率限制后以采样方式输出（而非完全静默），每跳过 sampleEvery 条输出一次。
 *
 * @param {string} domain  域名，如 'backend:ws'、'framework'
 * @returns {{ error: Function, warn: Function, info: Function, debug: Function }}
 */
export function createDiagLogger(domain) {
    const prefix = `[Jalangi:${domain}]`;
    return {
        error(...args) {
            _gatedConsole(console.error, 'error', domain, prefix, args);
        },
        warn(...args) {
            _gatedConsole(console.warn, 'warn', domain, prefix, args);
        },
        info(...args) {
            _gatedConsole(console.log, 'info', domain, prefix, args);
        },
        debug(...args) {
            if (isDebugEnabled(domain)) {
                _gatedConsole(console.debug, 'debug', domain, prefix, args);
            }
        },
    };
}

/**
 * 获取指定域的 debug 开关状态（供 idb.worker 等无法 import 模块的环境手动判断）。
 *
 * @param {string} domain
 * @returns {boolean}
 */
export { isDebugEnabled };
