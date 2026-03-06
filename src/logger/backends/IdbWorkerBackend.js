// JALANGI DO NOT INSTRUMENT

/**
 * IdbWorkerBackend — 浏览器默认日志后端。
 *
 * 通过 Web Worker 在独立线程中将事件写入 IndexedDB，
 * 主线程完全不阻塞。
 *
 * 特性：
 *  - Worker 线程持有 IDB 连接，主线程零 IDB 开销
 *  - 批量写入（单个 IDB 事务写整批），大幅减少事务开销
 *  - 背压控制：待确认批次超过 maxPendingBatches 时，暂停接收新批次
 *  - 支持查询（通过 query() 方法）
 *  - flush/query/clear 采用统一的 request-response 机制，
 *    避免并发调用时覆盖 onmessage 导致响应丢失
 *
 * Worker 加载策略：
 *  - 源码中使用 `new URL('../workers/idb-worker.js', import.meta.url)` 引用 Worker 脚本。
 *  - 在浏览器 bundle 场景下，jalangi.mjs 的 rollup 插件
 *    `jalangi-patch-idb-worker-url` 会将此表达式替换为预先创建好的 `__idbWorkerUrl`
 *    Blob URL（Classic Worker，无 { type: 'module' }），从而避免 Module Worker 不支持
 *    blob: URL 导致的 15s 超时问题。
 *
 * 诊断日志（直接到 console，不走 IDB）：
 *  - localStorage.jalangiDebug='backend:idb' 开启 debug 级别
 *  - error/warn 级别始终输出
 *
 * 使用方式：
 *   const backend = new IdbWorkerBackend({
 *     dbName:    'jalangi-traces',
 *   });
 *   await backend.init();  // 等待 Worker + DB 就绪
 */

import { createLogger, isDebugEnabled, DOMAIN } from '../logger.js';

const log = createLogger(DOMAIN.BACKEND_IDB);

export class IdbWorkerBackend {
    /**
     * @param {object} [options]
     * @param {URL|string} [options.workerUrl]  Worker 脚本 URL，默认自动推导
     * @param {string}  [options.dbName='jalangi-traces']  IndexedDB 数据库名
     * @param {string}  [options.storeName='events']       ObjectStore 名
     * @param {number}  [options.dbVersion=1]              数据库版本
     * @param {number}  [options.maxPendingBatches=8]      最大未确认批次数（背压）
     * @param {number}  [options.writeTimeoutMs=10000]     单批写入超时（ms）
     * @param {boolean} [options.clearOnInit=true]         每次初始化时自动清空旧数据（页面刷新后重新记录）
     */
    constructor(options = {}) {
        const {
            workerUrl         = new URL('../workers/idb-worker.js', import.meta.url),
            dbName            = 'jalangi-traces',
            storeName         = 'events',
            dbVersion         = 1,
            maxPendingBatches = 8,
            writeTimeoutMs    = 10000,
            clearOnInit       = true,
        } = options;

        this._workerUrl         = workerUrl;
        this._dbName            = dbName;
        this._storeName         = storeName;
        this._dbVersion         = dbVersion;
        this._maxPending        = maxPendingBatches;
        this._writeTimeoutMs    = writeTimeoutMs;
        this._clearOnInit       = clearOnInit;

        this._worker            = null;
        this._ready             = false;
        this._closed            = false;
        this._batchIdCounter    = 0;

        // 挂起的 write Promise：batchId → { resolve, reject, timer }
        this._pending           = new Map();

        // 一次性 request-response：reqId → { resolve, reject, timer }
        // 用于 flush / query / clear / close 等需要等待 Worker 应答的操作
        this._requests          = new Map();
        this._reqIdCounter      = 0;

        // 背压等待队列：pending 满时在此挂起，ack 到来后依次唤醒
        this._slotWaiters       = [];

        // 统计
        this.stats = { batchCount: 0, totalEvents: 0, errors: 0, dropped: 0 };

        // 仅在 debug 开启时输出构造参数（非关键路径）
        log.debug('constructed', { dbName, storeName });
    }

    /**
     * 初始化：启动 Worker，等待 IDB 就绪。
     * 必须在 LogManager 开始写入之前调用（或由 LogManager 自动调用）。
     * @returns {Promise<void>}
     */
    async init() {
        if (this._ready) {
            return;
        }

        const workerUrlStr = String(this._workerUrl);
        const t0 = Date.now();

        // 注意：不传 { type: 'module' }，以 Classic Worker 方式运行。
        // 在 bundle 场景下，jalangi.mjs rollup 插件会将 this._workerUrl 替换为
        // 预先由 Blob 创建的 __idbWorkerUrl（Classic Worker 兼容 blob: URL）。
        this._worker = new Worker(this._workerUrl);
        this._worker.onerror = (evt) => {
            // Worker 脚本级别错误（加载失败 / 语法错误等）
            log.error('Worker onerror:', evt.message, `(${evt.filename}:${evt.lineno})`);
            this.stats.errors++;
            // 若 init 尚未完成，立即 reject，避免等到 15s 超时
            if (this._readyReject) {
                this._readyReject(new Error(`Worker load error: ${evt.message}`));
            }
        };
        this._worker.onmessage = (evt) => this._handleMessage(evt.data);

        // 等待 Worker ready（在 _handleMessage 中处理；init 阶段用临时 Promise 桥接）
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const msg = `Worker init timeout after 15s (workerUrl=${workerUrlStr})`;
                log.error(msg);
                reject(new Error('IdbWorkerBackend: Worker init timeout'));
            }, 15000);

            // 在 _handleMessage 里增加一个单次 'ready' 路由
            this._readyResolve = () => { clearTimeout(timeout); resolve(); };
            this._readyReject  = (e) => { clearTimeout(timeout); reject(e); };

            this._worker.postMessage({
                cmd:       'init',
                dbName:    this._dbName,
                storeName: this._storeName,
                version:   this._dbVersion,
                // 把 debug 开关同步给 Worker（Worker 内无法读取 localStorage）
                debugDomain: isDebugEnabled(DOMAIN.BACKEND_IDB) ? DOMAIN.BACKEND_IDB : null,
            });
        });

        this._readyResolve = null;
        this._readyReject  = null;
        this._ready = true;
        const elapsed = Date.now() - t0;
        log.debug(`IDB ready in ${elapsed}ms (db=${this._dbName} store=${this._storeName})`);

        // 每次页面加载自动清空旧数据，避免多次刷新后数据重复积累
        if (this._clearOnInit) {
            await this.clear();
            log.debug('IDB store cleared on init');
        }
    }

    // ── LogBackend 接口 ────────────────────────────────────────────────────────

    /**
     * 批量写入事件。
     * 如果未调用 init()，会自动触发初始化。
     * @param {Array} batch
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) {
            log.error(`write() called after close — dropping ${batch.length} events`);
            throw new Error('IdbWorkerBackend: already closed');
        }
        if (!this._ready) {
            await this.init();
        }

        // 背压：待确认批次过多时等待（事件驱动，非忙等待）
        if (this._pending.size >= this._maxPending) {
            log.warn(`backpressure: pending=${this._pending.size}/${this._maxPending}, waiting for slot (batch=${batch.length})`);
            await this._waitForSlot();
        }

        const batchId = ++this._batchIdCounter;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(batchId);
                this.stats.errors++;
                const msg = `write timeout after ${this._writeTimeoutMs}ms (batchId=${batchId}, totalErrors=${this.stats.errors})`;
                log.error(msg);
                reject(new Error(`IdbWorkerBackend: write timeout (batchId=${batchId})`));
            }, this._writeTimeoutMs);

            this._pending.set(batchId, { resolve, reject, timer });

            this._worker.postMessage({ cmd: 'write', batch, batchId });
            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        });
    }

    /**
     * 等待 Worker 完成所有进行中的 IDB 事务。
     * @returns {Promise<void>}
     */
    async flush() {
        if (!this._ready || this._closed) return;
        return this._sendRequest('flush', 30000);
    }

    /**
     * 关闭 Worker 和 IDB 连接。
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        if (!this._worker) return;

        log.debug(`close() — batches=${this.stats.batchCount} events=${this.stats.totalEvents} errors=${this.stats.errors}`);

        await this.flush().catch((err) => {
            log.error('flush() during close failed:', err.message);
        });

        // 等待 Worker 确认关闭，超时 3s 后强制 terminate
        await this._sendRequest('close', 3000).catch((err) => {
            log.warn('close(): Worker did not respond:', err.message, '— forcing terminate');
        });

        this._worker.terminate();
        this._worker = null;
    }

    // ── 额外 API ──────────────────────────────────────────────────────────────

    /**
     * 查询 IndexedDB 中的事件。
     * @param {{ type?: string }} [filter]
     * @param {number} [limit=10000]
     * @returns {Promise<Array>}
     */
    async query(filter = {}, limit = 10000) {
        if (!this._ready || this._closed) {
            log.warn('query() called but not ready or closed — returning []');
            return [];
        }
        return this._sendRequest('query', 10000, { filter, limit });
    }

    /**
     * 清空 IndexedDB 中的所有事件。
     * @returns {Promise<void>}
     */
    async clear() {
        if (!this._ready || this._closed) {
            log.warn('clear() called but not ready or closed — skipping');
            return;
        }
        return this._sendRequest('clear', 10000);
    }

    // ── 内部方法 ──────────────────────────────────────────────────────────────

    /**
     * 统一的 request-response 机制。
     * 为每条请求分配唯一 reqId，在 _handleMessage 中按 reqId 路由响应。
     * 支持并发调用，不会互相覆盖。
     *
     * @param {string} cmd         - Worker 命令名
     * @param {number} timeoutMs   - 超时时间（ms）
     * @param {object} [extra={}]  - 附加消息字段
     * @returns {Promise<any>}     - 对于 queryResult 返回 events 数组，其余返回 undefined
     */
    _sendRequest(cmd, timeoutMs, extra = {}) {
        return new Promise((resolve, reject) => {
            const reqId = ++this._reqIdCounter;
            const timer = setTimeout(() => {
                this._requests.delete(reqId);
                const msg = `${cmd} timeout after ${timeoutMs}ms (reqId=${reqId})`;
                log.error(msg);
                reject(new Error(`IdbWorkerBackend: ${cmd} timeout`));
            }, timeoutMs);

            this._requests.set(reqId, { resolve, reject, timer });
            this._worker.postMessage({ cmd, reqId, ...extra });
        });
    }

    _handleMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                // init() 阶段的单次就绪通知
                if (this._readyResolve) {
                    this._readyResolve();
                } else {
                    log.warn('unexpected "ready" message after init — ignoring');
                }
                break;
            }
            case 'ack': {
                const entry = this._pending.get(msg.batchId);
                if (entry) {
                    clearTimeout(entry.timer);
                    this._pending.delete(msg.batchId);
                    entry.resolve();
                    // 背压释放：唤醒等待槽位的调用方
                    this._notifySlotWaiters();
                } else {
                    log.warn(`ack for unknown batchId=${msg.batchId} — already timed out?`);
                }
                break;
            }
            case 'error': {
                // 可能是 write 错误（有 batchId）或通用错误
                const errMsg = msg.message ?? 'unknown error';
                if (msg.batchId != null) {
                    const entry = this._pending.get(msg.batchId);
                    if (entry) {
                        clearTimeout(entry.timer);
                        this._pending.delete(msg.batchId);
                        log.error(`Worker error for batchId=${msg.batchId}:`, errMsg);
                        if (msg.stack) log.error('Worker stack trace:', msg.stack);
                        entry.reject(new Error(errMsg));
                        // 背压释放：出错后也应唤醒等待者
                        this._notifySlotWaiters();
                    } else {
                        log.error('Worker error (no pending entry):', errMsg);
                        if (msg.stack) log.error('Worker stack trace:', msg.stack);
                    }
                } else if (msg.reqId != null) {
                    this._resolveRequest(msg.reqId, null, new Error(errMsg));
                } else {
                    // init 失败（无 batchId/reqId）：立即 reject init Promise，避免 15s 超时
                    log.error('Worker error (unknown origin):', errMsg);
                    if (msg.stack) log.error('Worker stack trace:', msg.stack);
                    if (this._readyReject) {
                        this._readyReject(new Error(errMsg));
                    }
                }
                this.stats.errors++;
                break;
            }
            case 'flushed': {
                this._resolveRequest(msg.reqId, undefined);
                break;
            }
            case 'queryResult': {
                this._resolveRequest(msg.reqId, msg.events);
                break;
            }
            case 'cleared': {
                this._resolveRequest(msg.reqId, undefined);
                break;
            }
            case 'closed': {
                this._resolveRequest(msg.reqId, undefined);
                break;
            }
            default:
                log.warn('unhandled message type:', msg.type, msg);
        }
    }

    /**
     * 按 reqId 路由 request-response 的应答。
     * @param {number} reqId
     * @param {any}    result  - 成功时的返回值
     * @param {Error}  [err]   - 失败时的错误（传入则 reject）
     */
    _resolveRequest(reqId, result, err) {
        if (reqId == null) return;
        const req = this._requests.get(reqId);
        if (!req) {
            log.warn(`_resolveRequest: no pending request for reqId=${reqId} — already timed out?`);
            return;
        }
        clearTimeout(req.timer);
        this._requests.delete(reqId);
        if (err) {
            req.reject(err);
        } else {
            req.resolve(result);
        }
    }

    /**
     * 等待背压槽位释放（事件驱动，非忙等待）。
     * ack 到来后，_notifySlotWaiters() 会依次唤醒队列中的等待者。
     */
    _waitForSlot() {
        if (this._pending.size < this._maxPending) return Promise.resolve();
        return new Promise(resolve => this._slotWaiters.push(resolve));
    }

    /**
     * 唤醒背压等待队列中的下一个调用方（每次 ack 后调用）。
     */
    _notifySlotWaiters() {
        while (this._pending.size < this._maxPending && this._slotWaiters.length > 0) {
            this._slotWaiters.shift()();
        }
    }
}
