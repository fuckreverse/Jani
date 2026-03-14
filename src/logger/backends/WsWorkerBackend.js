// JALANGI DO NOT INSTRUMENT

/**
 * WsWorkerBackend — 将 WebSocket 发送操作迁移到 Web Worker 中。
 *
 * 与 WsBackend 的核心区别：
 *  - WsBackend：ws.send() 在主线程执行，主线程繁忙时发送延迟
 *  - WsWorkerBackend：ws.send() 在 Worker 独立线程执行，主线程只需 postMessage
 *
 * 主线程负责序列化（EventSerializer），Worker 负责发送（WebSocket.send）。
 * postMessage 使用 Transferable（ArrayBuffer 所有权转移），避免数据拷贝。
 *
 * API 与 WsBackend 完全兼容：connect() / write() / writeSync() / flush() / close()
 *
 * Worker 加载策略：
 *  - 与 IdbWorkerBackend 相同，在浏览器 bundle 场景下，
 *    bin/jalangi.mjs 的 rollup 插件会将
 *    `new URL('../workers/ws-worker.js', import.meta.url)`
 *    替换为预先创建好的 `__wsWorkerUrl` Blob URL（Classic Worker）。
 *
 * 使用方式：
 *   const backend = new WsWorkerBackend({ url: 'ws://localhost:9229/trace' });
 *   await backend.connect();
 *   await backend.write(batch);
 *   await backend.close();
 */

import { serializeBatchToBinary, serializeBatchToNDJSON } from '../EventSerializer.js';
import { createLogger, isDebugEnabled, DOMAIN } from '../logger.js';

const log = createLogger(DOMAIN.BACKEND_WS);

export class WsWorkerBackend {
    /**
     * @param {object} [options]
     * @param {URL|string} [options.workerUrl]  Worker 脚本 URL，默认自动推导
     * @param {string}  [options.url='ws://127.0.0.1:9229/trace']   服务端地址
     * @param {'binary'|'ndjson'} [options.format='binary']          消息格式
     * @param {number}  [options.windowSize=16]    未确认批次数上限（背压窗口，Worker 侧）
     * @param {number}  [options.maxRetries=10]    最大重连次数（-1 = 永远重连）
     * @param {number}  [options.retryBaseMs=500]  初始重连等待（ms），指数退避
     * @param {number}  [options.retryMaxMs=30000] 最大重连等待（ms）
     * @param {number}  [options.connectTimeoutMs=10000] 连接超时（ms）
     * @param {boolean} [options.autoConnect=true]  构造时是否自动连接
     */
    constructor(options = {}) {
        const {
            workerUrl        = new URL('../workers/ws-worker.js', import.meta.url),
            url              = 'ws://127.0.0.1:9229/trace',
            format           = 'binary',
            windowSize       = 16,
            maxRetries       = 10,
            retryBaseMs      = 500,
            retryMaxMs       = 30000,
            connectTimeoutMs = 10000,
            autoConnect      = true,
        } = options;

        this._workerUrl       = workerUrl;
        this._url             = url;
        this._format          = format;
        this._windowSize      = windowSize;
        this._maxRetries      = maxRetries;
        this._retryBaseMs     = retryBaseMs;
        this._retryMaxMs      = retryMaxMs;
        this._connectTimeoutMs = connectTimeoutMs;

        this._worker          = null;
        this._batchIdCounter  = 0;
        this._closed          = false;

        // 主线程侧的 in-flight 追踪：batchId → { resolve, reject, timer }
        // 用于 write() 返回的 Promise（等待 Worker 转发 ack）
        this._inFlight        = new Map();

        // 等待连接 ready 的 Promise 队列
        this._connectWaiters  = [];
        this._connected       = false;

        // flush 等待队列：等待所有 in-flight 清空
        this._flushWaiters    = [];

        // 统计
        this.stats = {
            batchCount:   0,
            totalEvents:  0,
            ackCount:     0,
            errors:       0,
            bytesSent:    0,
        };

        if (autoConnect) {
            this.connect();
        }
    }

    // ── 公共 API ──────────────────────────────────────────────────────────────

    /**
     * 启动 Worker 并等待 WebSocket 连接就绪。
     * @returns {Promise<void>}
     */
    connect() {
        if (this._worker) {
            // 已经在连接中，返回 ready Promise
            if (this._connected) return Promise.resolve();
            return this._waitForConnect();
        }

        this._worker = new Worker(this._workerUrl);
        this._worker.onerror  = (evt) => this._handleWorkerError(evt);
        this._worker.onmessage = (evt) => this._handleMessage(evt.data);

        this._worker.postMessage({
            cmd:              'init',
            url:              this._url,
            format:           this._format,
            windowSize:       this._windowSize,
            maxRetries:       this._maxRetries,
            retryBaseMs:      this._retryBaseMs,
            retryMaxMs:       this._retryMaxMs,
            connectTimeoutMs: this._connectTimeoutMs,
            debugEnabled:     isDebugEnabled(DOMAIN.BACKEND_WS),
        });

        return this._waitForConnect();
    }

    /**
     * 批量写入事件（异步，等待 Worker 转发 ack 后 resolve）。
     * @param {Array} batch
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) throw new Error('WsWorkerBackend: already closed');
        if (!this._worker) this.connect();

        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._inFlight.delete(batchId);
                this.stats.errors++;
                reject(new Error(`WsWorkerBackend: ack timeout (batchId=${batchId})`));
            }, 35000); // 比 Worker 侧 30s 稍长，避免竞争

            this._inFlight.set(batchId, { resolve, reject, timer });

            // 发送给 Worker，ArrayBuffer 使用 Transferable（零拷贝）
            if (data instanceof ArrayBuffer) {
                this._worker.postMessage({ cmd: 'write', batchId, data }, [data]);
            } else {
                this._worker.postMessage({ cmd: 'write', batchId, data });
            }

            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        });
    }

    /**
     * 同步写入：序列化后立即 postMessage 给 Worker，不等 ack。
     * 与 WsBackend.writeSync 语义一致：fire-and-forget，不追踪 ack。
     * postMessage 本身是同步的（立即写入任务队列，微秒级），
     * Worker 的 onmessage 在其事件循环中立即处理，不受主线程阻塞。
     * @param {Array} batch
     */
    writeSync(batch) {
        if (this._closed || !this._worker) return;
        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;

        // 使用 Transferable 避免数据拷贝（ArrayBuffer 所有权转给 Worker）
        if (data instanceof ArrayBuffer) {
            this._worker.postMessage({ cmd: 'write', batchId, data }, [data]);
        } else {
            this._worker.postMessage({ cmd: 'write', batchId, data });
        }
        // 不注册 in-flight，不等待 ack：fire-and-forget
    }

    /**
     * 等待 Worker 侧所有 in-flight 批次收到 ack。
     * @returns {Promise<void>}
     */
    async flush() {
        if (!this._worker || this._closed) return;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._flushWaiters = this._flushWaiters.filter(w => w.resolve !== resolve);
                reject(new Error('WsWorkerBackend: flush timeout'));
            }, 30000);
            this._flushWaiters.push({
                resolve: () => { clearTimeout(timer); resolve(); },
                reject,
            });
            this._worker.postMessage({ cmd: 'flush' });
        });
    }

    /**
     * 关闭 Worker 和 WebSocket 连接。
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        if (!this._worker) return;

        log.debug(`close() — batches=${this.stats.batchCount} events=${this.stats.totalEvents}`);

        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 8000); // 保险超时
            // 等待 Worker 完成关闭
            this._worker.onmessage = (evt) => {
                this._handleMessage(evt.data);
                if (evt.data?.type === 'closed') {
                    clearTimeout(timer);
                    resolve();
                }
            };
            this._worker.postMessage({ cmd: 'close' });
        });

        this._worker.terminate();
        this._worker = null;
    }

    // ── 内部方法 ──────────────────────────────────────────────────────────────

    _serialize(batchId, batch) {
        if (this._format === 'binary') {
            const batchBuf = serializeBatchToBinary(batch);
            // 格式与 WsBackend 一致：[u32 batchId][...batchBuf]
            const out      = new ArrayBuffer(4 + batchBuf.byteLength);
            const view     = new DataView(out);
            view.setUint32(0, batchId, true);
            new Uint8Array(out, 4).set(new Uint8Array(batchBuf));
            return out;
        } else {
            return JSON.stringify({ batchId, events: batch }) + '\n';
        }
    }

    _handleMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                this._connected = true;
                const waiters = this._connectWaiters.splice(0);
                for (const w of waiters) w.resolve();
                log.debug('WsWorker connected');
                break;
            }
            case 'ack': {
                const entry = this._inFlight.get(msg.batchId);
                if (entry) {
                    clearTimeout(entry.timer);
                    this._inFlight.delete(msg.batchId);
                    this.stats.ackCount++;
                    entry.resolve();
                }
                break;
            }
            case 'flushed': {
                const waiters = this._flushWaiters.splice(0);
                for (const w of waiters) w.resolve();
                break;
            }
            case 'closed': {
                // 由 close() 的 onmessage 覆盖处理，这里不重复处理
                break;
            }
            case 'error': {
                this.stats.errors++;
                log.error('WsWorker error:', msg.message);
                // 连接失败时，reject 所有 waiters
                const waiters = this._connectWaiters.splice(0);
                for (const w of waiters) w.reject(new Error(msg.message));
                break;
            }
            default:
                log.debug('WsWorker unknown message type:', msg.type);
        }
    }

    _handleWorkerError(evt) {
        this.stats.errors++;
        log.error('WsWorker onerror:', evt.message, `(${evt.filename}:${evt.lineno})`);
        // 通知 connect() waiters
        if (this._readyReject) {
            this._readyReject(new Error(`WsWorker load error: ${evt.message}`));
        }
    }

    _waitForConnect() {
        if (this._connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this._connectWaiters.push({ resolve, reject });
        });
    }
}
