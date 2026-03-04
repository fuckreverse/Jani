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
 *   'framework'    JalangiRuntime, JalangiSandbox, AnalysisHost
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

// ── 读取 debug 开关（惰性求值，避免初始化时序问题） ────────────────────────────

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
    /** JalangiRuntime, JalangiSandbox, AnalysisHost */
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
        error(...args) { console.error(prefix, ...args); },
        warn(...args)  { console.warn( prefix, ...args); },
        info(...args)  { console.log(  prefix, ...args); },
        debug(...args) {
            if (isDebugEnabled(domain)) console.debug(prefix, ...args);
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
