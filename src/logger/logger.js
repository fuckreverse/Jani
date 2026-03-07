// JALANGI DO NOT INSTRUMENT

/**
 * @file logger.js — Jalangi2 统一日志工厂
 *
 * 提供两级日志分类：
 *   1. 域（domain）：代码所属模块，如 'framework'、'backend:ws'、'logging' 等
 *   2. 级别（level）：error / warn / info / debug
 *
 * 级别语义：
 *   error  — 不可恢复错误，始终同步输出到 console.error
 *   warn   — 非预期但可继续，始终同步输出到 console.warn
 *   info   — 关键里程碑（脚本开始/结束、backend 就绪），始终同步输出到 console.log
 *   debug  — 运行细节（flush 计数、RingBuffer 状态），默认关闭，按域开关控制
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
 *   import { createLogger } from '../../logger/logger.js';
 *   const log = createLogger('backend:ws');
 *
 *   log.error('connection failed:', err.message);  // 始终输出
 *   log.warn('retrying in 500ms');                 // 始终输出
 *   log.info('backend ready');                     // 始终输出
 *   log.debug('batch sent, size=', batch.length);  // 仅 debug 开关开启时输出
 *
 * ─── 内置域名约定 ──────────────────────────────────────────────────────────────
 *
 *   'framework'    JalangiRuntime, JalangiSandbox, HookDispatcher
 *   'instrument'   astUtil, pluginAnalyzer, esnstrument
 *   'logging'      LogManager, TraceLogger
 *   'backend:idb'  IdbWorkerBackend, idb-worker
 *   'backend:ws'   WsBackend
 *   'backend:node' NodeStreamBackend
 *   'backend:mem'  MemoryBackend（通常无需 debug）
 *   'analysis'     分析插件业务日志（通过 J$.log 路由）
 */

// ── 运行环境检测 ────────────────────────────────────────────────────────────────
const IS_BROWSER = typeof window !== 'undefined' || typeof globalThis.self !== 'undefined';

// ── 全局控制台输出限流 ──────────────────────────────────────────────────────────
//
// 目的：防止大规模分析场景（如 JD 安全脚本）中海量错误/警告日志把浏览器卡死。
//
// 行为：
//   - 所有通过 createLogger() 产生的控制台输出（error/warn/info/debug）共享一个
//     全局计数器，超出上限后静默丢弃，并仅打印一次"已静默"提示。
//   - 上限默认为 100 条，可通过 setConsoleLimit(n) 调整（0 = 不限制）。
//   - resetConsoleLimit() 重置计数器（如用于多轮测试场景）。
//
let _consoleCount  = 0;      // 已输出条数
let _consoleSilent = false;  // 是否已进入静默状态
let _consoleLimit  = 100;    // 上限（0 = 不限制）

/**
 * 设置控制台输出上限。
 * @param {number} n  最大允许输出条数；0 表示不限制。
 */
export function setConsoleLimit(n) {
    _consoleLimit = (typeof n === 'number' && n >= 0) ? n : 100;
    _consoleCount  = 0;
    _consoleSilent = false;
}

/**
 * 重置计数器（不改变上限）。用于多轮执行场景。
 */
export function resetConsoleLimit() {
    _consoleCount  = 0;
    _consoleSilent = false;
}

/**
 * 统一的控制台输出门控。
 * 返回 true 表示本条允许输出，返回 false 表示应丢弃。
 * 副作用：在刚超限时打印一次静默提示。
 *
 * @param {Function} consoleFn  console.error / console.warn / console.log / console.debug
 * @param {string}   prefix     域名前缀字符串
 * @param {Array}    args       原始参数
 */
function _gatedConsole(consoleFn, prefix, args) {
    if (_consoleLimit === 0) {
        // 不限制
        consoleFn(prefix, ...args);
        return;
    }
    if (_consoleSilent) return;

    _consoleCount++;
    if (_consoleCount <= _consoleLimit) {
        consoleFn(prefix, ...args);
    } else {
        _consoleSilent = true;
        console.warn(
            `[Jalangi] 控制台输出已达上限 ${_consoleLimit} 条，后续日志静默丢弃。` +
            `如需调整限制请调用 setConsoleLimit(n)。`
        );
    }
}

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
 *   import { createLogger, DOMAIN } from '../../logger/logger.js';
 *   const log = createLogger(DOMAIN.FRAMEWORK);
 *
 * JALANGI_DEBUG 开关同样使用这些字符串：
 *   JALANGI_DEBUG=backend:ws,backend:node
 */
export const DOMAIN = Object.freeze({
    /** JalangiRuntime, JalangiSandbox, HookDispatcher */
    FRAMEWORK:    'framework',
    /** astUtil, pluginAnalyzer, esnstrument */
    INSTRUMENT:   'instrument',
    /** LogManager, TraceLogger */
    LOGGING:      'logging',
    /** IdbWorkerBackend, idb-worker */
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

// ── Logger 对象 ─────────────────────────────────────────────────────────────────

/**
 * 创建一个绑定了域名前缀的日志对象。
 *
 * 返回的对象包含四个方法：error / warn / info / debug。
 *   error / warn / info 始终同步输出（不受 debug 开关控制）。
 *   debug 仅在对应域开启时输出。
 *
 * @param {string} domain  域名，如 'backend:ws'、'framework'
 * @returns {{ error: Function, warn: Function, info: Function, debug: Function }}
 */
export function createLogger(domain) {
    const prefix = `[Jalangi:${domain}]`;
    return {
        error(...args) { _gatedConsole(console.error.bind(console), prefix, args); },
        warn(...args)  { _gatedConsole(console.warn.bind(console),  prefix, args); },
        info(...args)  { _gatedConsole(console.log.bind(console),   prefix, args); },
        debug(...args) {
            if (isDebugEnabled(domain)) _gatedConsole(console.debug.bind(console), prefix, args);
        },
    };
}

/**
 * 获取指定域的 debug 开关状态（供 idb-worker 等无法 import 模块的环境手动判断）。
 *
 * @param {string} domain
 * @returns {boolean}
 */
export { isDebugEnabled };
