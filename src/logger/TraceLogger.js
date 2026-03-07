// JALANGI DO NOT INSTRUMENT

/**
 * @file TraceLogger — ExecutionTrace 的统一日志门面。
 *
 * 职责：
 *  - 区分两种日志级别：
 *      · NORMAL  普通 trace 行（大量，写后端）
 *      · KEY     重点事件（脚本开始/结束、错误、汇总），同时输出到控制台
 *
 *  - 按运行环境自动选择后端：
 *      · 浏览器   NORMAL → IndexedDB（IdbWorkerBackend）
 *                         + 可选 WebSocket（WsBackend）
 *                KEY    → console.log / console.error
 *
 *      · Node.js  NORMAL → 文件（NodeStreamBackend，默认 jalangi-trace.ndjson）
 *                          + 可选 console
 *                KEY    → console.log / console.error
 *
 *  - 所有 NORMAL 写入都通过 LogManager（有 RingBuffer 缓冲 + 后端分发）
 *  - KEY 日志同步写控制台，不经过 LogManager（避免 async 延迟影响可读性）
 *
 *  - pre-init 缓冲队列：_doInit() 完成之前到来的事件暂存于 _preInitQueue，
 *    _mgr 就绪后统一 replay，确保脚本加载阶段的 trace 不丢失。
 *
 * 诊断日志（直接输出到 console，不走 LogManager）：
 *  - 通过 JALANGI_DEBUG=logging (Node.js 环境变量) 或
 *    localStorage.jalangiDebug='logging' (浏览器) 开启 debug 级别输出
 *  - error/warn 级别诊断日志始终输出（无需开关）
 *
 * 使用方式：
 *
 *   // 浏览器（IDB）：
 *   const logger = new TraceLogger({ useIdb: true, dbName: 'my-traces' });
 *   await logger.init();
 *
 *   // 浏览器（IDB + WebSocket）：
 *   const logger = new TraceLogger({ useIdb: true, wsUrl: 'ws://localhost:9229/trace' });
 *   await logger.init();
 *
 *   // Node.js（文件）：
 *   const logger = new TraceLogger({ nodeFile: 'my-trace.ndjson' });
 *   await logger.init();
 *
 *   // 写普通 trace 行（高频，走后端）：
 *   logger.trace({ type: 'trace', seq: 1, text: '[1:1] const x ...' });
 *
 *   // 写重点事件（低频，走控制台）：
 *   logger.key('info',  '▶ script: foo.js');
 *   logger.key('error', '✗ throw ; exception=...');
 *   logger.key('info',  '=== ExecutionTrace: total 123 events ===');
 *
 *   // 结束时 flush + 关闭：
 *   await logger.close();
 */

import { createLogger, DOMAIN } from './logger.js';

// ── 运行环境检测 ────────────────────────────────────────────────────────────────
const IS_BROWSER = typeof window !== 'undefined' || typeof globalThis.self !== 'undefined';

const log = createLogger(DOMAIN.LOGGING);

// 用于 TraceLogger.key() 的输出，统一享受全局限流
const _keyLogger = createLogger('key');

export class TraceLogger {
    /**
     * @param {object} [options]
     *
     * === 浏览器选项 ===
     * @param {boolean} [options.useIdb=true]        浏览器中是否启用 IndexedDB 后端
     * @param {string}  [options.dbName='jalangi-traces']
     * @param {string}  [options.storeName='execution-trace']
     * @param {string}  [options.wsUrl]              可选：同时推送到 WebSocket 服务
     *
     * === Node.js 选项 ===
     * @param {string|false} [options.nodeFile='jalangi-trace.ndjson']
     *   写入的文件路径；false 表示不写文件（只用控制台）
     * @param {boolean} [options.nodeConsole=false]  Node 中是否也把 trace 输出到控制台
     *
     * === 通用选项 ===
     * @param {boolean} [options.keyToConsole=true]  KEY 日志是否输出到控制台（建议始终 true）
     * @param {object}  [options.logManagerOptions]  透传给 LogManager 的额外选项
     * @param {number}  [options.preInitQueueLimit=100000]
     *   pre-init 缓冲队列最大容量（条数）。
     *   超出后丢弃最早的事件，防止脚本过大导致内存爆炸。
     *   默认 10 万条，足以覆盖绝大多数脚本加载阶段。
     */
    constructor(options = {}) {
        const {
            // 浏览器
            useIdb       = true,
            dbName       = 'jalangi-traces',
            storeName    = 'execution-trace',
            wsUrl        = undefined,
            // Node.js
            nodeFile     = 'jalangi-trace.ndjson',
            nodeConsole  = false,
            // 通用
            keyToConsole     = true,
            logManagerOptions = {},
            preInitQueueLimit = 100000,
        } = options;

        this._opts = {
            useIdb, dbName, storeName, wsUrl,
            nodeFile, nodeConsole, keyToConsole,
            logManagerOptions,
        };

        /** @type {import('./LogManager.js').LogManager|null} */
        this._mgr  = null;
        this._ready = null;  // Promise，init() 返回的

        /**
         * pre-init 缓冲队列：_mgr 就绪前暂存事件，就绪后统一 replay，确保脚本加载阶段不丢失。
         * null 表示初始化已完成；Array（含空数组）表示仍在初始化中。
         * @type {Array<{kind:'trace'|'key', event?: object, level?: string, text?: string}>|null}
         */
        this._preInitQueue      = [];
        this._preInitQueueLimit = preInitQueueLimit;

        log.debug('constructed', {
            env: IS_BROWSER ? 'browser' : 'node',
            useIdb,
            dbName,
            storeName,
            nodeFile: IS_BROWSER ? '(n/a)' : nodeFile,
            wsUrl,
        });
    }

    // ── 初始化 ─────────────────────────────────────────────────────────────────

    /**
     * 异步初始化后端（打开 IDB / 建立 WebSocket / 打开文件流）。
     * 可以不 await；init 完成前产生的事件会缓冲在 _preInitQueue 中，
     * 初始化完成后自动 replay 到后端，不会丢失。
     *
     * @returns {Promise<void>}
     */
    init() {
        if (this._ready) return this._ready;
        log.debug('init() called — starting backend initialization');
        this._ready = this._doInit().catch(err => {
            log.error('init failed, falling back to console-only:', err.message, err.stack ?? '');
            this._flushPreInitQueue();
        });
        return this._ready;
    }

    async _doInit() {
        const t0      = Date.now();
        const backends = [];
        const opts     = this._opts;

        if (IS_BROWSER) {
            // ── 浏览器：IDB 后端 ─────────────────────────────────────────────
            if (opts.useIdb) {
                log.debug('initializing IdbWorkerBackend', { dbName: opts.dbName, storeName: opts.storeName });
                try {
                    const { IdbWorkerBackend } = await import('./backends/IdbWorkerBackend.js');
                    const idb = new IdbWorkerBackend({
                        dbName:    opts.dbName,
                        storeName: opts.storeName,
                    });
                    await idb.init();
                    backends.push(idb);
                    log.debug('IdbWorkerBackend ready');
                } catch (err) {
                    log.error('IdbWorkerBackend init failed:', err.message, err.stack ?? '');
                }
            }

            // ── 浏览器：WebSocket 后端（可选）───────────────────────────────
            if (opts.wsUrl) {
                log.debug('connecting WsBackend', { url: opts.wsUrl });
                try {
                    const { WsBackend } = await import('./backends/WsBackend.js');
                    const ws = new WsBackend({
                        url:         opts.wsUrl,
                        format:      'binary',
                        autoConnect: true,
                    });
                    await ws.connect().catch(err => {
                        log.warn('WsBackend connect failed (non-fatal):', err.message);
                    });
                    backends.push(ws);
                    log.debug('WsBackend connected');
                } catch (err) {
                    log.error('WsBackend setup failed:', err.message, err.stack ?? '');
                }
            }
        } else {
            // ── Node.js：文件后端 ────────────────────────────────────────────
            if (opts.nodeFile) {
                log.debug('opening NodeStreamBackend', { path: opts.nodeFile });
                try {
                    const { NodeStreamBackend } = await import('./backends/NodeStreamBackend.js');
                    backends.push(new NodeStreamBackend({ path: opts.nodeFile }));
                    log.debug('NodeStreamBackend ready', { path: opts.nodeFile });
                } catch (err) {
                    log.error('NodeStreamBackend init failed:', err.message, err.stack ?? '');
                }
            }

            // ── Node.js：控制台后端（可选）──────────────────────────────────
            if (opts.nodeConsole || backends.length === 0) {
                backends.push(new ConsoleBackend());
                log.debug('using ConsoleBackend' + (backends.length === 1 ? ' (fallback, no file backend)' : ' (nodeConsole=true)'));
            }
        }

        if (backends.length === 0) {
            log.warn('no backends configured — trace data will only appear on console (KEY events)');
            this._flushPreInitQueue();
            return;
        }

        const { LogManager } = await import('./LogManager.js');
        this._mgr = new LogManager({
            backends,
            autoClose: true,
            ...this._opts.logManagerOptions,
        });

        const elapsed = Date.now() - t0;
        log.debug(`_doInit() complete — ${backends.length} backend(s) ready, took ${elapsed}ms`);

        this._flushPreInitQueue();
    }

    /**
     * 将 _preInitQueue 中缓冲的事件 replay 到 _mgr，然后将队列置为 null。
     * 若 _mgr 不可用（初始化失败），队列中的事件会被丢弃。
     * @private
     */
    _flushPreInitQueue() {
        const queue = this._preInitQueue;
        this._preInitQueue = null;

        if (!queue || queue.length === 0) return;

        log.debug(`replaying ${queue.length} pre-init buffered event(s) to LogManager`);
        if (!this._mgr) {
            // 后端初始化失败，无处写入，静默丢弃
            log.warn(`pre-init queue dropped (${queue.length} events) — no backend available`);
            return;
        }
        for (const item of queue) {
            if (item.kind === 'trace') {
                this._mgr.log(item.event);
            } else if (item.kind === 'key') {
                this._mgr.log({ type: 'key', level: item.level, text: item.text });
            }
        }
    }

    // ── 公共 API ──────────────────────────────────────────────────────────────

    /**
     * 记录一条普通 trace 行（高频路径，走 LogManager 缓冲后端）。
     *
     * 若 _mgr 尚未就绪，事件会暂存到 _preInitQueue，等 init 完成后 replay。
     *
     * 事件格式由调用方决定；ExecutionTrace 使用：
     *   { type: 'trace', seq: number, text: string }
     *
     * @param {object} event
     */
    trace(event) {
        if (this._mgr) {
            this._mgr.log(event);
        } else if (this._preInitQueue !== null) {
            if (this._preInitQueue.length >= this._preInitQueueLimit) {
                this._preInitQueue.shift();
            }
            this._preInitQueue.push({ kind: 'trace', event });
        }
    }

    /**
     * 记录一条重点事件（低频路径）：
     *  - 始终同步输出到控制台（当 keyToConsole=true）
     *  - 同时以 KEY 事件写入后端（便于在 IDB/文件中搜索边界）
     *    若 _mgr 尚未就绪，写入会暂存到 _preInitQueue，等 init 完成后 replay。
     *
     * @param {'info'|'warn'|'error'} level
     * @param {string} text
     */
    key(level, text) {
        if (this._opts.keyToConsole) {
            // 通过 _keyLogger 输出，统一享受全局限流
            if (level === 'error') {
                _keyLogger.error(text);
            } else if (level === 'warn') {
                _keyLogger.warn(text);
            } else {
                _keyLogger.info(text);
            }
        }
        if (this._mgr) {
            this._mgr.log({ type: 'key', level, text });
        } else if (this._preInitQueue !== null) {
            if (this._preInitQueue.length >= this._preInitQueueLimit) {
                this._preInitQueue.shift();
            }
            this._preInitQueue.push({ kind: 'key', level, text });
        }
    }

    /**
     * 调度一次异步 flush（fire-and-forget）。
     *
     * 适用于异步回调产生少量 trace 的场景：
     * 少量事件不足以触发 LogManager 的自动阈值 flush（默认 512 条），
     * 手动调度确保这批数据能及时写入 IDB / 文件后端，而不是无限期积压在 RingBuffer 里。
     *
     * 使用 queueMicrotask（或 Promise.resolve）调度，不阻塞当前调用栈。
     * 如果已有调度挂起，不重复调度（幂等）。
     */
    scheduleFlush() {
        if (this._pendingScheduledFlush) return;
        this._pendingScheduledFlush = true;
        const schedule = typeof queueMicrotask === 'function'
            ? queueMicrotask
            : (fn) => Promise.resolve().then(fn);
        schedule(() => {
            this._pendingScheduledFlush = false;
            if (this._mgr) {
                this._mgr.flush().catch(err => {
                    log.error('scheduleFlush: flush error:', err.message, err.stack ?? '');
                });
            }
        });
    }

    /**
     * Flush 所有缓冲数据 + 关闭所有后端（一般在 endExecution 中调用）。
     * @returns {Promise<void>}
     */
    async close() {
        if (!this._mgr) {
            log.debug('close() called — no LogManager (already closed or never initialized)');
            return;
        }
        log.debug('close() — flushing LogManager...');
        const t0 = Date.now();
        try {
            const stats = this._mgr.getStats?.();
            await this._mgr.close();
            const elapsed = Date.now() - t0;
            log.debug(`close() done in ${elapsed}ms`, stats ? `logged=${stats.logManager.totalLogged} flushed=${stats.logManager.totalFlushed} errors=${stats.logManager.flushErrors}` : '');
        } catch (err) {
            log.error('close() error:', err.message, err.stack ?? '');
        }
        this._mgr = null;
    }

    /**
     * 判断 LogManager 是否已就绪（后端初始化完成）。
     * 可用于调试；通常不需要检查。
     */
    get isReady() {
        return this._mgr !== null;
    }

    /**
     * 返回当前 pre-init 缓冲队列的长度（0 表示已 replay 或队列为空）。
     * 可用于调试，确认初始化阶段事件是否被成功缓冲。
     */
    get preInitQueueSize() {
        return this._preInitQueue?.length ?? 0;
    }
}

// ── 轻量控制台后端（Node.js 无文件时使用）────────────────────────────────────

/**
 * ConsoleBackend — 将 NDJSON 行输出到 stdout（Node.js 专用，不依赖 fs）。
 * 这个类只在 Node.js 环境中使用，所以可以放心用 process.stdout。
 */
class ConsoleBackend {
    constructor() {
        this.stats = { batchCount: 0, totalEvents: 0 };
    }

    async write(batch) {
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
        for (const ev of batch) {
            // 对于 trace 事件直接输出 text 字段（可读性优先）
            if (ev.type === 'trace' && ev.text) {
                process.stdout.write(ev.text + '\n');
            } else {
                let s;
                try { s = JSON.stringify(ev); } catch { s = String(ev); }
                process.stdout.write(s + '\n');
            }
        }
    }

    writeSync(batch) {
        for (const ev of batch) {
            const s = (ev.type === 'trace' && ev.text) ? ev.text : (() => {
                try { return JSON.stringify(ev); } catch { return String(ev); }
            })();
            process.stdout.write(s + '\n');
        }
    }

    async flush() {}
    async close() {}
}
