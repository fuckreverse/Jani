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
 *
 * 使用方式：
 *   const backend = new IdbWorkerBackend({
 *     workerUrl: new URL('../workers/idb-worker.js', import.meta.url),
 *     dbName:    'jalangi-traces',
 *   });
 *   await backend.init();  // 等待 Worker + DB 就绪
 */

export class IdbWorkerBackend {
    /**
     * @param {object} [options]
     * @param {URL|string} [options.workerUrl]  Worker 脚本 URL，默认自动推导
     * @param {string}  [options.dbName='jalangi-traces']  IndexedDB 数据库名
     * @param {string}  [options.storeName='events']       ObjectStore 名
     * @param {number}  [options.dbVersion=1]              数据库版本
     * @param {number}  [options.maxPendingBatches=8]      最大未确认批次数（背压）
     * @param {number}  [options.writeTimeoutMs=10000]     单批写入超时（ms）
     */
    constructor(options = {}) {
        const {
            workerUrl         = new URL('../workers/idb-worker.js', import.meta.url),
            dbName            = 'jalangi-traces',
            storeName         = 'events',
            dbVersion         = 1,
            maxPendingBatches = 8,
            writeTimeoutMs    = 10000,
        } = options;

        this._workerUrl         = workerUrl;
        this._dbName            = dbName;
        this._storeName         = storeName;
        this._dbVersion         = dbVersion;
        this._maxPending        = maxPendingBatches;
        this._writeTimeoutMs    = writeTimeoutMs;

        this._worker            = null;
        this._ready             = false;
        this._closed            = false;
        this._batchIdCounter    = 0;

        // 挂起的 Promise：batchId → { resolve, reject, timer }
        this._pending           = new Map();

        // 统计
        this.stats = { batchCount: 0, totalEvents: 0, errors: 0, dropped: 0 };
    }

    /**
     * 初始化：启动 Worker，等待 IDB 就绪。
     * 必须在 LogManager 开始写入之前调用（或由 LogManager 自动调用）。
     * @returns {Promise<void>}
     */
    async init() {
        if (this._ready) return;

        this._worker = new Worker(this._workerUrl, { type: 'module' });
        this._worker.onerror = (evt) => {
            console.error('[IdbWorkerBackend] Worker error:', evt.message);
            this.stats.errors++;
        };
        this._worker.onmessage = (evt) => this._handleMessage(evt.data);

        // 等待 Worker ready
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('IdbWorkerBackend: Worker init timeout')),
                15000
            );
            // 临时拦截第一条消息
            const origOnMessage = this._worker.onmessage.bind(this);
            this._worker.onmessage = (evt) => {
                if (evt.data.type === 'ready') {
                    clearTimeout(timeout);
                    this._worker.onmessage = origOnMessage;
                    resolve();
                } else if (evt.data.type === 'error') {
                    clearTimeout(timeout);
                    reject(new Error(evt.data.message));
                }
            };

            this._worker.postMessage({
                cmd:       'init',
                dbName:    this._dbName,
                storeName: this._storeName,
                version:   this._dbVersion,
            });
        });

        this._ready = true;
    }

    // ── LogBackend 接口 ────────────────────────────────────────────────────────

    /**
     * 批量写入事件。
     * 如果未调用 init()，会自动触发初始化。
     * @param {Array} batch
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) throw new Error('IdbWorkerBackend: already closed');
        if (!this._ready) await this.init();

        // 背压：待确认批次过多时等待
        if (this._pending.size >= this._maxPending) {
            await this._waitForSlot();
        }

        const batchId = ++this._batchIdCounter;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(batchId);
                this.stats.errors++;
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
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('IdbWorkerBackend: flush timeout')),
                30000
            );
            const orig = this._worker.onmessage.bind(this);
            // 临时拦截 flushed 消息
            const onMsg = (evt) => {
                if (evt.data.type === 'flushed') {
                    clearTimeout(timeout);
                    this._worker.onmessage = orig;
                    resolve();
                } else {
                    orig({ data: evt.data });
                }
            };
            this._worker.onmessage = onMsg;
            this._worker.postMessage({ cmd: 'flush' });
        });
    }

    /**
     * 关闭 Worker 和 IDB 连接。
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        if (!this._worker) return;

        await this.flush().catch(() => {});

        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 3000);
            this._worker.onmessage = (evt) => {
                if (evt.data.type === 'closed') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
            this._worker.postMessage({ cmd: 'close' });
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
        if (!this._ready || this._closed) return [];
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('IdbWorkerBackend: query timeout')),
                10000
            );
            const orig = this._worker.onmessage.bind(this);
            this._worker.onmessage = (evt) => {
                if (evt.data.type === 'queryResult') {
                    clearTimeout(timeout);
                    this._worker.onmessage = orig;
                    resolve(evt.data.events);
                } else {
                    orig({ data: evt.data });
                }
            };
            this._worker.postMessage({ cmd: 'query', filter, limit });
        });
    }

    /**
     * 清空 IndexedDB 中的所有事件。
     * @returns {Promise<void>}
     */
    async clear() {
        if (!this._ready || this._closed) return;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('IdbWorkerBackend: clear timeout')),
                10000
            );
            const orig = this._worker.onmessage.bind(this);
            this._worker.onmessage = (evt) => {
                if (evt.data.type === 'cleared') {
                    clearTimeout(timeout);
                    this._worker.onmessage = orig;
                    resolve();
                } else {
                    orig({ data: evt.data });
                }
            };
            this._worker.postMessage({ cmd: 'clear' });
        });
    }

    // ── 内部方法 ──────────────────────────────────────────────────────────────

    _handleMessage(msg) {
        switch (msg.type) {
            case 'ack': {
                const entry = this._pending.get(msg.batchId);
                if (entry) {
                    clearTimeout(entry.timer);
                    this._pending.delete(msg.batchId);
                    entry.resolve();
                }
                break;
            }
            case 'error': {
                const entry = this._pending.get(msg.batchId);
                if (entry) {
                    clearTimeout(entry.timer);
                    this._pending.delete(msg.batchId);
                    entry.reject(new Error(msg.message));
                } else {
                    console.error('[IdbWorkerBackend] Worker error:', msg.message);
                }
                this.stats.errors++;
                break;
            }
            case 'ready':
            case 'flushed':
            case 'queryResult':
            case 'cleared':
            case 'closed':
                // 这些由临时拦截的 onmessage 处理，到这里说明没人处理，忽略
                break;
            default:
                console.warn('[IdbWorkerBackend] Unhandled message type:', msg.type);
        }
    }

    /**
     * 等待 pending 批次中有一个完成（背压释放槽位）。
     */
    _waitForSlot() {
        // 等待第一个 pending 的 resolve（任意一个完成即可）
        return new Promise(resolve => {
            const check = () => {
                if (this._pending.size < this._maxPending) {
                    resolve();
                } else {
                    // 在下一个微任务再检查
                    Promise.resolve().then(check);
                }
            };
            check();
        });
    }
}
