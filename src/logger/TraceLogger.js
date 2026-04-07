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
 *      · 浏览器   NORMAL → IndexedDB（IdbBackend）
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
 *  - 通过 JALANGI_DEBUG=trace-infra (Node.js 环境变量) 或
 *    localStorage.jalangiDebug='trace-infra' (浏览器) 开启 debug 级别输出
 *  - error/warn 级别诊断日志始终输出（无需开关）
 *
 * 使用方式：
 *
 *   // 浏览器（IDB）：
 *   const logger = new TraceLogger({ useIdb: true, dbName: 'my-traces' });
 *   await logger.init();
 *
 *   // 浏览器（IDB + WebSocket）：
 *   const logger = new TraceLogger({ useIdb: true, wsUrl: 'ws://localhost:33000/ws/trace' });
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

import { createDiagLogger, DOMAIN } from './diagnostics.js';

// ── 运行环境检测 ────────────────────────────────────────────────────────────────
const IS_BROWSER = typeof window !== 'undefined' || typeof globalThis.self !== 'undefined';

const log = createDiagLogger(DOMAIN.TRACE_INFRA);

export class TraceLogger {
    /**
     * @param {object} [options]
     *
     * === 浏览器选项 ===
     * @param {boolean} [options.useIdb=true]        浏览器中是否启用 IndexedDB 后端
     * @param {string}  [options.dbName='jalangi-traces']
     * @param {string}  [options.storeName='execution-trace']
     * @param {string}  [options.wsUrl]              可选：同时推送到 WebSocket 服务
     * @param {boolean} [options.wsSab=false]
     *   浏览器中是否使用 SharedArrayBuffer 模式（WsBackend sab）。
     *   SAB 模式通过环形缓冲区 + Atomics 实现零拷贝写入，Worker 侧 Atomics.waitAsync
     *   等待新数据，消费后立即 ws.send()，彻底解耦主线程与网络发送。
     *   要求：页面需开启 COOP/COEP header（Cross-Origin-Opener-Policy: same-origin
     *         + Cross-Origin-Embedder-Policy: require-corp）。
     *   不满足或环境不支持时，自动降级为 worker 模式（WsBackend worker）。
     * @param {boolean} [options.wsWorker=true]
     *   浏览器中是否将 WebSocket 移到 Web Worker 线程（默认 true）。
     *   Worker 线程发送不受主线程阻塞，适合高频 trace 场景。
     *   设为 false 则退化为主线程 WsBackend（调试用）。
     *   当 wsSab=true 且支持 SAB 时，wsWorker 被忽略（已使用更高效的 SAB 模式）。
     * @param {'ndjson'|'binary'} [options.wsFormat='binary']
     *   WebSocket 消息格式。ExecutionTrace 事件（{type,seq,text}）
     *   无法用 binary 编码，必须用 ndjson；仅当后端接收的是低层钩子事件（含 iid/sid/value）
     *   时才用 binary。wsWorker=true / wsSab=true 时默认 binary（高吞吐），否则默认 ndjson。
     *
     * === Node.js 选项 ===
     * @param {string|false} [options.nodeFile='jalangi-trace.ndjson']
     *   写入的文件路径；false 表示不写文件（只用控制台）
     * @param {boolean} [options.nodeConsole=false]  Node 中是否也把 trace 输出到控制台
     *
     * === 通用选项 ===
     * @param {boolean} [options.keyToConsole=true]  KEY 日志是否输出到控制台（建议始终 true）
     * @param {object}  [options.logManagerOptions]  透传给 LogManager 的额外选项
     */
    constructor(options = {}) {
        const {
            // 浏览器
            useIdb       = true,
            dbName       = 'jalangi-traces',
            storeName    = 'execution-trace',
            wsUrl        = undefined,
            wsSab        = false,
            wsWorker     = true,
            wsFormat     = 'binary',
            // Node.js
            nodeFile     = 'jalangi-trace.ndjson',
            nodeConsole  = false,
            // 通用
            keyToConsole     = true,
            logManagerOptions = {},
        } = options;

        this._opts = {
            useIdb, dbName, storeName, wsUrl, wsSab, wsWorker, wsFormat,
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
        this._preInitQueue = [];

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
                log.debug('initializing IdbBackend', { dbName: opts.dbName, storeName: opts.storeName });
                try {
                    const { IdbBackend } = await import('./transport/IdbBackend.js');
                    const idb = new IdbBackend({
                        dbName:    opts.dbName,
                        storeName: opts.storeName,
                    });
                    await idb.init();
                    backends.push(idb);
                    log.debug('IdbBackend ready');
                } catch (err) {
                    log.error('IdbBackend init failed:', err.message, err.stack ?? '');
                }
            }

            // ── 浏览器：WebSocket 后端（可选）───────────────────────────────
            if (opts.wsUrl) {
                const { WsBackend } = await import('./transport/WsBackend.js');

                // 选择 mode：sab > worker > main
                const mode = opts.wsSab
                    ? 'sab'
                    : (opts.wsWorker !== false ? 'worker' : 'main');

                // ndjson 格式下槽大小需要更大
                const slotDataBytes = opts.wsFormat === 'ndjson' ? 2 * 1024 * 1024 : 65536;

                log.debug(`connecting WsBackend (mode=${mode})`, { url: opts.wsUrl, format: opts.wsFormat });

                let ws = null;
                try {
                    ws = new WsBackend({
                        url:          opts.wsUrl,
                        format:       opts.wsFormat ?? 'binary',
                        mode,
                        slotDataBytes,
                        autoConnect:  true,
                    });
                } catch (err) {
                    log.error(`WsBackend(${mode}) init failed:`, err.message, err.stack ?? '');
                }

                if (ws) {
                    await ws.connect().catch(err => {
                        log.warn(`WsBackend(${mode}) connect failed (non-fatal):`, err.message);
                    });
                    backends.push(ws);
                    log.debug(`WsBackend(${mode}) connected`);
                }
            }
        } else {
            // ── Node.js：文件后端 ────────────────────────────────────────────
            if (opts.nodeFile) {
                log.debug('opening NodeStreamBackend', { path: opts.nodeFile });
                try {
                    const { NodeStreamBackend } = await import('./transport/NodeStreamBackend.js');
                    const nodeBackend = new NodeStreamBackend({
                        path: opts.nodeFile,
                        ...(opts.smap != null && { smap: opts.smap }),
                    });
                    backends.push(nodeBackend);
                    // 内部保存引用，以便外部通过 setSmap() 更新 smap
                    this._nodeBackend = nodeBackend;
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

        // binary 格式：每批 512 条（每条 ~20 字节，512 条 ≈ 10KB，Worker ws.send 吞吐佳）
        // ndjson 格式：每批 64 条（每条 ~200 字节，64 条 ≈ 12KB）
        // 用户通过 logManagerOptions.drainBatchSize 可覆盖。
        const wsFormat = this._opts.wsFormat;
        const defaultDrainBatchSize = wsFormat === 'ndjson' ? 64 : 512;

        // 有 WS 后端时启用定时 flush（50ms），确保同步密集执行阶段产生的事件
        // 能在主线程空闲时及时发出，而不是全部积压到脚本结束后再一次性 flush。
        // 用户通过 logManagerOptions.flushIntervalMs 可覆盖（传 0 可禁用）。
        const hasWsBackend = IS_BROWSER && !!this._opts.wsUrl;
        const defaultFlushIntervalMs = hasWsBackend ? 50 : 0;

        this._mgr = new LogManager({
            backends,
            autoClose: true,
            drainBatchSize: defaultDrainBatchSize,
            flushIntervalMs: defaultFlushIntervalMs,
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
            log.warn(`pre-init queue dropped (${queue.length} events) — no backend available`);
            return;
        }
        for (const item of queue) {
            if (item.kind === 'trace') {
                this._mgr.push(item.event);
            } else if (item.kind === 'key') {
                this._mgr.push({ type: 'key', level: item.level, text: item.text });
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
            this._mgr.push(event);
        } else if (this._preInitQueue !== null) {
            this._preInitQueue.push({ kind: 'trace', event });
        }
    }

    /**
     * 记录一条重点事件（低频路径）：
     *  - 始终同步输出到控制台（当 keyToConsole=true）
     *  - 同时以 KEY 事件写入后端（便于在 IDB/文件中搜索边界）
     *    若 _mgr 尚未就绪，写入会暂存到 _preInitQueue，等 init 完成后 replay。
     *
     * KEY 事件本身是低频的（脚本开始/结束、错误汇总），不需要速率限制，
     * 直接用 console.* 输出即可。
     *
     * @param {'info'|'warn'|'error'} level
     * @param {string} text
     */
    key(level, text) {
        if (this._opts.keyToConsole) {
            // 直接用 console.*，KEY 事件低频，无需速率限制机制
            const fn = level === 'error' ? console.error
                     : level === 'warn'  ? console.warn
                     : console.log;
            fn('[Jalangi]', text);
        }
        if (this._mgr) {
            this._mgr.push({ type: 'key', level, text });
        } else if (this._preInitQueue !== null) {
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
     * 设置（或更新）smap 对象，传递给 NodeStreamBackend，在 close() 时自动写出 .smap.json。
     * 通常由 ExecutionTrace 插件在 scriptEnter 之前调用：
     *   logger.setSmap(buildSmapJson(sourceMapObject));
     *
     * @param {object} smapObj  buildSmapJson() 返回的 smap 对象
     */
    setSmap(smapObj) {
        if (this._nodeBackend?.setSmap) {
            this._nodeBackend.setSmap(smapObj);
        } else if (this._opts) {
            // init 尚未完成，缓存到 opts 中，_doInit 完成时会传入
            this._opts.smap = smapObj;
        }
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
