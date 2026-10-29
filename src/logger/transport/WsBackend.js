// JALANGI DO NOT INSTRUMENT

/**
 * WsBackend — 通过 WebSocket 将事件流推送给外部收集服务。
 *
 * 三种运行模式（通过构造参数 `mode` 选择）：
 *
 *   mode: 'main'   — 主线程模式（原 WsBackend）
 *     ws.send() 在主线程执行，实现最简单，适合调试场景。
 *
 *   mode: 'worker' — Worker 模式（原 WsWorkerBackend，默认）
 *     ws.send() 在 Web Worker 独立线程执行，主线程只需 postMessage。
 *     postMessage 使用 Transferable（ArrayBuffer 所有权转移），避免数据拷贝。
 *     适合高频 trace 场景，主线程不阻塞。
 *
 *   mode: 'sab'    — SharedArrayBuffer 模式（原 WsSabBackend）
 *     主线程 → Atomics.store（零拷贝写 SAB）+ Atomics.notify → Worker 读 SAB → ws.send()
 *     写入是真正的原子操作，不依赖 JS 事件循环调度，彻底解耦主线程与网络发送。
 *     要求：页面需开启 COOP/COEP 响应头（Cross-Origin-Opener-Policy: same-origin
 *           + Cross-Origin-Embedder-Policy: require-corp）。
 *     不满足或环境不支持时，自动降级为 worker 模式。
 *
 * 使用方式：
 *   new WsBackend({ url, mode: 'main' })    // 主线程，调试用
 *   new WsBackend({ url, mode: 'worker' })  // Worker 线程（默认）
 *   new WsBackend({ url, mode: 'sab' })     // SAB 模式（需 COOP/COEP，不支持时自动降级）
 *
 * API：connect() / write(batch) / writeSync(batch) / flush() / close()
 *
 * Worker 脚本加载策略（'worker' / 'sab' 模式）：
 *   两种模式共用同一个 Worker 脚本 ws.worker.js（Classic Worker，无 import）。
 *   在浏览器 bundle 场景下，rollup 插件会将
 *   `new URL('./ws.worker.js', import.meta.url)` 替换为预先创建好的 Blob URL。
 *
 * 服务端协议（见 tools/trace-server/server.mjs）：
 *   协议（二进制）：
 *     客户端 → 服务端：[u32 batchId LE][JTB1 事件流（无文件头，直接事件序列）]
 *     服务端 → 客户端：[u32 batchId LE]  （4 字节 ack）
 */

import { serializeBatch } from '../../encoding/EventSerializer.js';
import { createDiagLogger, isDebugEnabled, DOMAIN } from '../diagnostics.js';

const log = createDiagLogger(DOMAIN.BACKEND_WS);

// ── UUID 生成（兼容浏览器与 Node.js）────────────────────────────────────────────

function _generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // 降级：手动拼接
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/** 将 sid 参数追加到 WebSocket URL（已有参数时用 & 拼接） */
function _urlWithSid(url, sid) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}sid=${encodeURIComponent(sid)}`;
}

// ── 公共接口 ────────────────────────────────────────────────────────────────────

export class WsBackend {
    /**
     * @param {object} [options]
     * @param {'main'|'worker'|'sab'} [options.mode='worker']  运行模式
     * @param {string}  [options.url='ws://127.0.0.1:9229/trace']  服务端地址
     * @param {string}  [options.sessionId]  会话 ID（用于服务端文件复用，默认自动生成 UUID）
     * @param {'binary'} [options.format='binary']    消息格式（仅支持 binary/JTB1）
     *
     * === 'main' 模式专属选项 ===
     * @param {number}  [options.windowSize=4]     未确认批次数上限（背压窗口）
     * @param {number}  [options.maxRetries=10]    最大重连次数（-1 = 永远重连）
     * @param {number}  [options.retryBaseMs=500]  初始重连等待（ms），指数退避
     * @param {number}  [options.retryMaxMs=30000] 最大重连等待（ms）
     * @param {number}  [options.connectTimeoutMs=10000] 连接超时（ms）
     * @param {boolean} [options.autoConnect=true]  构造时是否自动连接
     * @param {boolean} [options.replayOnReconnect=true]  重连后重发未确认批次
     *
     * === 'worker' 模式专属选项 ===
     * @param {URL|string} [options.workerUrl]  Worker 脚本 URL，默认自动推导
     * @param {number}  [options.windowSize=16]  未确认批次数上限（Worker 侧）
     *
     * === 'sab' 模式专属选项 ===
     * @param {number}  [options.slotCount=64]        环形缓冲区槽数
     * @param {number}  [options.slotDataBytes=65536] 每槽最大字节数（64KB）
     * @param {number}  [options.backpressureTimeoutMs=200]
     *   write() 等待空槽的最大时间（ms）；超时后直接丢弃该 batch 并记录警告。
     */
    constructor(options = {}) {
        const mode = options.mode ?? 'worker';

        // 生成（或接受外部传入）会话 ID，拼入 URL，确保重连时服务端能识别同一逻辑会话
        const sessionId = options.sessionId ?? _generateUUID();
        const urlWithSid = _urlWithSid(options.url ?? 'ws://127.0.0.1:9229/trace', sessionId);
        const optionsWithSid = { ...options, url: urlWithSid, sessionId };

        // SAB 模式：检查是否支持，不支持则降级为 worker
        if (mode === 'sab' && !WsBackend.isSabSupported()) {
            console.warn(
                '[Jalangi] WsBackend(sab): SharedArrayBuffer not available, falling back to worker mode.\n' +
                '  原因: 浏览器需要 COOP/COEP 响应头才能启用 SharedArrayBuffer。\n' +
                '  解决: 在 HTTP 响应中添加以下头：\n' +
                '    Cross-Origin-Opener-Policy: same-origin\n' +
                '    Cross-Origin-Embedder-Policy: require-corp\n' +
                '  如果使用 webpack-dev-server，在 devServer.headers 中配置。'
            );
            this._impl = new _WorkerTransport(optionsWithSid);
        } else if (mode === 'sab') {
            this._impl = new _SabTransport(optionsWithSid);
        } else if (mode === 'worker') {
            this._impl = new _WorkerTransport(optionsWithSid);
        } else {
            this._impl = new _MainTransport(optionsWithSid);
        }

        /** 供外部查询当前会话 ID */
        this.sessionId = sessionId;
    }

    /**
     * 检查当前环境是否支持 SharedArrayBuffer（SAB 模式前提条件）。
     * @returns {boolean}
     */
    static isSabSupported() {
        return typeof SharedArrayBuffer !== 'undefined';
    }

    connect()        { return this._impl.connect(); }
    write(batch)     { return this._impl.write(batch); }
    writeSync(batch) { return this._impl.writeSync(batch); }
    flush()          { return this._impl.flush(); }
    close()          { return this._impl.close(); }

    get stats()      { return this._impl.stats; }
}

// ── 主线程实现（原 WsBackend）──────────────────────────────────────────────────

const _MainState = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    CLOSING:      'closing',
    CLOSED:       'closed',
});

class _MainTransport {
    constructor(options = {}) {
        const {
            url                 = 'ws://127.0.0.1:9229/trace',
            format              = 'binary',
            windowSize          = 4,
            maxRetries          = 10,
            retryBaseMs         = 500,
            retryMaxMs          = 30000,
            connectTimeoutMs    = 10000,
            autoConnect         = true,
            replayOnReconnect   = true,
        } = options;

        this._url               = url;
        this._format            = format;
        this._windowSize        = windowSize;
        this._maxRetries        = maxRetries;
        this._retryBaseMs       = retryBaseMs;
        this._retryMaxMs        = retryMaxMs;
        this._connectTimeoutMs  = connectTimeoutMs;
        this._replayOnReconnect = replayOnReconnect;

        this._ws                = null;
        this._state             = _MainState.DISCONNECTED;
        this._retryCount        = 0;
        this._retryTimer        = null;
        this._batchIdCounter    = 0;

        // 待确认批次队列：Map<batchId, { data, resolve, reject, timer }>
        this._inFlight          = new Map();

        // 等待连接的 Promise 队列
        this._connectWaiters    = [];

        // 统计
        this.stats = {
            batchCount:  0,
            totalEvents: 0,
            ackCount:    0,
            retryCount:  0,
            errors:      0,
            byteSent:    0,
        };

        if (autoConnect) {
            this.connect();
        }
    }

    connect() {
        if (this._state === _MainState.CONNECTED || this._state === _MainState.CONNECTING) {
            return this._waitForConnect();
        }
        this._state = _MainState.CONNECTING;
        return this._openConnection();
    }

    async write(batch) {
        if (this._state === _MainState.CLOSED) throw new Error('WsBackend: already closed');

        if (this._inFlight.size >= this._windowSize) {
            await this._waitForWindow();
        }

        if (this._state !== _MainState.CONNECTED) {
            await this._waitForConnect();
        }

        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._inFlight.delete(batchId);
                this.stats.errors++;
                reject(new Error(`WsBackend: ack timeout (batchId=${batchId})`));
            }, 30000);

            this._inFlight.set(batchId, { data, batch, resolve, reject, timer });
            this._sendRaw(data);

            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        });
    }

    writeSync(batch) {
        if (this._state !== _MainState.CONNECTED || !this._ws) return;
        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);
        this._sendRaw(data);
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
    }

    async flush() {
        if (this._inFlight.size === 0) return;
        await Promise.all([...this._inFlight.values()].map(e =>
            new Promise(resolve => {
                const orig = e.resolve;
                e.resolve = (...a) => { orig(...a); resolve(); };
            })
        ));
    }

    async close() {
        if (this._state === _MainState.CLOSED || this._state === _MainState.CLOSING) return;
        this._state = _MainState.CLOSING;

        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }

        if (this._inFlight.size > 0) {
            await Promise.race([
                this.flush(),
                new Promise(r => setTimeout(r, 5000)),
            ]);
        }

        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            await new Promise(resolve => {
                this._ws.onclose = resolve;
                this._ws.close(1000, 'client close');
                setTimeout(resolve, 2000);
            });
        }

        this._state = _MainState.CLOSED;
    }

    _openConnection() {
        return new Promise((resolve, reject) => {
            let connectTimer = setTimeout(() => {
                reject(new Error('WsBackend: connect timeout'));
                this._ws?.close();
            }, this._connectTimeoutMs);

            try {
                this._ws = new WebSocket(this._url);
                if (this._format === 'binary') {
                    this._ws.binaryType = 'arraybuffer';
                }
            } catch (err) {
                clearTimeout(connectTimer);
                this._scheduleRetry();
                reject(err);
                return;
            }

            this._ws.onopen = () => {
                clearTimeout(connectTimer);
                this._state      = _MainState.CONNECTED;
                this._retryCount = 0;

                const waiters = this._connectWaiters.splice(0);
                for (const r of waiters) r.resolve();

                if (this._replayOnReconnect && this._inFlight.size > 0) {
                    for (const [, entry] of this._inFlight) {
                        this._sendRaw(entry.data);
                    }
                }

                resolve();
            };

            this._ws.onclose = () => {
                if (this._state === _MainState.CLOSING || this._state === _MainState.CLOSED) return;
                this._state = _MainState.DISCONNECTED;
                this._scheduleRetry();
            };

            this._ws.onerror = () => {
                clearTimeout(connectTimer);
                this.stats.errors++;
                if (this._state === _MainState.CONNECTING) {
                    this._state = _MainState.DISCONNECTED;
                    this._scheduleRetry();
                    reject(new Error('WsBackend: connection error'));
                }
            };

            this._ws.onmessage = (evt) => this._handleAck(evt.data);
        });
    }

    _scheduleRetry() {
        if (this._maxRetries !== -1 && this._retryCount >= this._maxRetries) {
            log.error('Max retries reached, giving up');
            this._state = _MainState.CLOSED;
            for (const w of this._connectWaiters) {
                w.reject(new Error('WsBackend: max retries exceeded'));
            }
            this._connectWaiters = [];
            return;
        }

        const delay = Math.min(
            this._retryBaseMs * Math.pow(2, this._retryCount),
            this._retryMaxMs
        );
        this._retryCount++;
        this.stats.retryCount++;
        this._state = _MainState.CONNECTING;

        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._openConnection().catch(() => {});
        }, delay);
    }

    _handleAck(data) {
        let batchId;
        if (data instanceof ArrayBuffer) {
            batchId = new DataView(data).getUint32(0, true);
        } else {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'ack') batchId = msg.batchId;
            } catch { return; }
        }

        const entry = this._inFlight.get(batchId);
        if (entry) {
            clearTimeout(entry.timer);
            this._inFlight.delete(batchId);
            this.stats.ackCount++;
            entry.resolve();
        }
    }

    _serialize(batchId, batch) {
        // 只支持二进制格式（JTB1）
        const batchBuf = serializeBatch(batch);
        const out      = new ArrayBuffer(4 + batchBuf.byteLength);
        const view     = new DataView(out);
        view.setUint32(0, batchId, true);
        new Uint8Array(out, 4).set(new Uint8Array(batchBuf));
        return out;
    }

    _sendRaw(data) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            try {
                this._ws.send(data);
                this.stats.byteSent += typeof data === 'string' ? data.length * 2 : data.byteLength;
            } catch (err) {
                this.stats.errors++;
                log.error('send error:', err);
            }
        }
    }

    _waitForConnect() {
        if (this._state === _MainState.CONNECTED) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this._connectWaiters.push({ resolve, reject });
        });
    }

    _waitForWindow() {
        return new Promise(resolve => {
            const entries = [...this._inFlight.values()];
            let done = false;
            for (const entry of entries) {
                const origResolve = entry.resolve;
                entry.resolve = (...args) => {
                    origResolve(...args);
                    if (!done) { done = true; resolve(); }
                };
            }
        });
    }
}

// ── Worker 线程实现（原 WsWorkerBackend）────────────────────────────────────────

class _WorkerTransport {
    constructor(options = {}) {
        const {
            workerUrl        = new URL('./ws.worker.js', import.meta.url),
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
        this._inFlight        = new Map();

        // 等待连接 ready 的 Promise 队列
        this._connectWaiters  = [];
        this._connected       = false;

        // flush 等待队列
        this._flushWaiters    = [];

        // 统计
        this.stats = {
            batchCount:  0,
            totalEvents: 0,
            ackCount:    0,
            errors:      0,
            bytesSent:   0,
        };

        if (autoConnect) {
            this.connect();
        }
    }

    connect() {
        if (this._worker) {
            if (this._connected) return Promise.resolve();
            return this._waitForConnect();
        }

        this._worker = new Worker(this._workerUrl);
        this._worker.onerror  = (evt) => this._handleWorkerError(evt);
        this._worker.onmessage = (evt) => this._handleMessage(evt.data);

        this._worker.postMessage({
            cmd:              'init',
            mode:             'worker',
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

    async write(batch) {
        if (this._closed) throw new Error('WsBackend(worker): already closed');
        if (!this._worker) this.connect();

        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._inFlight.delete(batchId);
                this.stats.errors++;
                reject(new Error(`WsBackend(worker): ack timeout (batchId=${batchId})`));
            }, 35000);

            this._inFlight.set(batchId, { resolve, reject, timer });

            if (data instanceof ArrayBuffer) {
                this._worker.postMessage({ cmd: 'write', batchId, data }, [data]);
            } else {
                this._worker.postMessage({ cmd: 'write', batchId, data });
            }

            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        });
    }

    writeSync(batch) {
        if (this._closed || !this._worker) return;
        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;

        if (data instanceof ArrayBuffer) {
            this._worker.postMessage({ cmd: 'write', batchId, data }, [data]);
        } else {
            this._worker.postMessage({ cmd: 'write', batchId, data });
        }
    }

    async flush() {
        if (!this._worker || this._closed) return;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._flushWaiters = this._flushWaiters.filter(w => w.resolve !== resolve);
                reject(new Error('WsBackend(worker): flush timeout'));
            }, 30000);
            this._flushWaiters.push({
                resolve: () => { clearTimeout(timer); resolve(); },
                reject,
            });
            this._worker.postMessage({ cmd: 'flush' });
        });
    }

    async close() {
        if (this._closed) return;
        this._closed = true;
        if (!this._worker) return;

        log.debug(`close(worker) — batches=${this.stats.batchCount} events=${this.stats.totalEvents}`);

        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 8000);
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

    _serialize(batchId, batch) {
        // 只支持二进制格式（JTB1）
        const batchBuf = serializeBatch(batch);
        const out      = new ArrayBuffer(4 + batchBuf.byteLength);
        const view     = new DataView(out);
        view.setUint32(0, batchId, true);
        new Uint8Array(out, 4).set(new Uint8Array(batchBuf));
        return out;
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
                break;
            }
            case 'error': {
                this.stats.errors++;
                log.error('WsWorker error:', msg.message);
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

// ── SAB（SharedArrayBuffer）实现（原 WsSabBackend）─────────────────────────────

// 元数据索引（与 ws.worker.js 中 SAB 模式保持同步）
const _SAB_META_WRITE_SEQ  = 0;
const _SAB_META_READ_SEQ   = 1;
const _SAB_META_CTRL       = 2;
const _SAB_META_INTS       = 4;  // 元数据区占 4 个 i32（16 字节）

class _SabTransport {
    constructor(options = {}) {
        const {
            workerUrl               = new URL('./ws.worker.js', import.meta.url),
            url                     = 'ws://127.0.0.1:9229/trace',
            format                  = 'binary',
            slotCount               = 64,
            slotDataBytes           = 65536,
            maxRetries              = 10,
            retryBaseMs             = 500,
            retryMaxMs              = 30000,
            connectTimeoutMs        = 10000,
            backpressureTimeoutMs   = 200,
            autoConnect             = true,
        } = options;

        this._workerUrl             = workerUrl;
        this._url                   = url;
        this._format                = format;
        this._slotCount             = slotCount;
        this._slotDataBytes         = slotDataBytes;
        this._maxRetries            = maxRetries;
        this._retryBaseMs           = retryBaseMs;
        this._retryMaxMs            = retryMaxMs;
        this._connectTimeoutMs      = connectTimeoutMs;
        this._backpressureTimeoutMs = backpressureTimeoutMs;

        const slotBytes  = 4 + slotDataBytes;
        const sabBytes   = _SAB_META_INTS * 4 + slotCount * slotBytes;
        this._sab        = new SharedArrayBuffer(sabBytes);
        this._meta       = new Int32Array(this._sab, 0, _SAB_META_INTS);
        this._dataBuf    = new Uint8Array(this._sab, _SAB_META_INTS * 4, slotCount * slotBytes);
        this._slotBytes  = slotBytes;

        Atomics.store(this._meta, _SAB_META_WRITE_SEQ, 0);
        Atomics.store(this._meta, _SAB_META_READ_SEQ,  0);
        Atomics.store(this._meta, _SAB_META_CTRL,       0);

        this._worker         = null;
        this._connected      = false;
        this._closed         = false;
        this._batchIdCounter = 0;

        this._connectWaiters = [];
        this._flushWaiters   = [];

        this.stats = {
            batchCount:  0,
            totalEvents: 0,
            dropped:     0,
            errors:      0,
        };

        if (autoConnect) {
            this.connect();
        }
    }

    connect() {
        if (this._worker) {
            if (this._connected) return Promise.resolve();
            return this._waitForConnect();
        }

        this._worker = new Worker(this._workerUrl);
        this._worker.onerror   = (evt) => this._handleWorkerError(evt);
        this._worker.onmessage = (evt) => this._handleMessage(evt.data);

        this._worker.postMessage({
            cmd:              'init',
            mode:             'sab',
            sab:              this._sab,
            slotCount:        this._slotCount,
            slotDataBytes:    this._slotDataBytes,
            url:              this._url,
            format:           this._format,
            maxRetries:       this._maxRetries,
            retryBaseMs:      this._retryBaseMs,
            retryMaxMs:       this._retryMaxMs,
            connectTimeoutMs: this._connectTimeoutMs,
            debugEnabled:     isDebugEnabled(DOMAIN.BACKEND_WS),
        });

        return this._waitForConnect();
    }

    async write(batch) {
        if (this._closed) throw new Error('WsBackend(sab): already closed');
        if (!this._worker) this.connect();

        const data = this._serialize(batch);

        if (data.byteLength > this._slotDataBytes) {
            this.stats.errors++;
            this.stats.dropped += batch.length;
            throw new Error(`Trace batch exceeds SAB slot capacity (${data.byteLength} bytes)`);
        }

        const success = await this._writeToRing(data);
        if (success) {
            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        } else {
            this.stats.dropped++;
            throw new Error('Trace SAB backpressure timeout; recording is incomplete');
        }
    }

    writeSync(batch) {
        if (this._closed || !this._worker) return;

        const data = this._serialize(batch);
        if (data.byteLength > this._slotDataBytes) {
            this.stats.errors++;
            return;
        }

        const written = this._tryWriteSlot(data);
        if (written) {
            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        } else {
            this.stats.dropped++;
        }
    }

    async flush() {
        if (!this._worker || this._closed) return;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._flushWaiters = this._flushWaiters.filter(w => w.resolve !== resolve);
                reject(new Error('WsBackend(sab): flush timeout'));
            }, 30000);
            this._flushWaiters.push({
                resolve: () => { clearTimeout(timer); resolve(); },
                reject,
            });
            this._worker.postMessage({ cmd: 'flush' });
        });
    }

    async close() {
        if (this._closed) return;
        this._closed = true;
        if (!this._worker) return;

        log.debug(`close(sab) — batches=${this.stats.batchCount} events=${this.stats.totalEvents} dropped=${this.stats.dropped}`);

        Atomics.store(this._meta, _SAB_META_CTRL, 1);
        Atomics.notify(this._meta, _SAB_META_WRITE_SEQ, 1);

        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 8000);
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

    _serialize(batch) {
        // 只支持二进制格式（JTB1）
        const batchId = ++this._batchIdCounter;
        const batchBuf = serializeBatch(batch);
        const out  = new ArrayBuffer(4 + batchBuf.byteLength);
        new DataView(out).setUint32(0, batchId >>> 0, true);
        new Uint8Array(out, 4).set(new Uint8Array(batchBuf));
        return new Uint8Array(out);
    }

    _tryWriteSlot(data) {
        const writeSeq = Atomics.load(this._meta, _SAB_META_WRITE_SEQ);
        const readSeq  = Atomics.load(this._meta, _SAB_META_READ_SEQ);

        if (writeSeq - readSeq >= this._slotCount) {
            return false;
        }

        const slotIdx    = writeSeq % this._slotCount;
        const slotOffset = slotIdx * this._slotBytes;

        const lenView = new DataView(this._dataBuf.buffer, this._dataBuf.byteOffset + slotOffset, 4);
        lenView.setUint32(0, data.byteLength, true);
        this._dataBuf.set(data, slotOffset + 4);

        Atomics.add(this._meta, _SAB_META_WRITE_SEQ, 1);
        Atomics.notify(this._meta, _SAB_META_WRITE_SEQ, 1);

        return true;
    }

    async _writeToRing(data) {
        const deadline = Date.now() + this._backpressureTimeoutMs;

        while (true) {
            if (this._tryWriteSlot(data)) return true;

            const remaining = deadline - Date.now();
            if (remaining <= 0) return false;

            const currentReadSeq = Atomics.load(this._meta, _SAB_META_READ_SEQ);

            if (typeof Atomics.waitAsync === 'function') {
                const result = await Atomics.waitAsync(
                    this._meta,
                    _SAB_META_READ_SEQ,
                    currentReadSeq,
                    Math.min(remaining, 50)
                ).value;
                if (result === 'timed-out') {
                    continue;
                }
            } else {
                await new Promise(r => setTimeout(r, Math.min(remaining, 10)));
            }
        }
    }

    _handleMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                this._connected = true;
                const waiters = this._connectWaiters.splice(0);
                for (const w of waiters) w.resolve();
                log.debug('WsSabWorker connected');
                break;
            }
            case 'flushed': {
                const waiters = this._flushWaiters.splice(0);
                for (const w of waiters) w.resolve();
                break;
            }
            case 'closed': {
                break;
            }
            case 'error': {
                this.stats.errors++;
                log.error('WsSabWorker error:', msg.message);
                const waiters = this._connectWaiters.splice(0);
                for (const w of waiters) w.reject(new Error(msg.message));
                break;
            }
            default:
                log.debug('WsSabWorker unknown message type:', msg.type);
        }
    }

    _handleWorkerError(evt) {
        this.stats.errors++;
        log.error('WsSabWorker onerror:', evt.message, `(${evt.filename}:${evt.lineno})`);
        const waiters = this._connectWaiters.splice(0);
        for (const w of waiters) w.reject(new Error(`WsSabWorker load error: ${evt.message}`));
    }

    _waitForConnect() {
        if (this._connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this._connectWaiters.push({ resolve, reject });
        });
    }
}
