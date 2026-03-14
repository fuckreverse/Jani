// JALANGI DO NOT INSTRUMENT

/**
 * WsSabBackend — 基于 SharedArrayBuffer 的 WebSocket 后端。
 *
 * 与 WsWorkerBackend 的对比
 * ────────────────────────
 *   WsWorkerBackend：
 *     主线程 → postMessage（结构化克隆，微秒级但仍有拷贝）→ Worker 消息队列 → ws.send()
 *     问题：主线程密集执行时 postMessage 队列积压，Worker 的 onmessage 无法及时被调度
 *
 *   WsSabBackend（本类）：
 *     主线程 → Atomics.store（零拷贝写 SAB） + Atomics.notify（唤醒 Worker）→ Worker 读 SAB → ws.send()
 *     优势：写入是真正的原子操作，不依赖 JS 事件循环调度；
 *           Worker 通过 Atomics.waitAsync 等待，与 Worker 消息队列解耦。
 *
 * 背压机制
 * ────────
 *   当环形缓冲区写满时（所有槽均未被消费），主线程执行：
 *     Atomics.wait(meta, META_READ_SEQ, currentReadSeq, backpressureTimeoutMs)
 *   这会真正阻塞主线程直到 Worker 消费一个槽并递增 readSeq，
 *   从而在内存层面实现生产-消费节奏匹配，防止无限积压。
 *
 * 注意事项
 * ────────
 *   1. SharedArrayBuffer 需要页面开启 COOP + COEP：
 *        Cross-Origin-Opener-Policy: same-origin
 *        Cross-Origin-Embedder-Policy: require-corp
 *      若不满足，new SharedArrayBuffer() 会抛出 ReferenceError，
 *      此时 WsSabBackend.isSupported() 返回 false，应降级为 WsWorkerBackend。
 *
 *   2. Atomics.wait() 在主线程中可能被浏览器禁止（Chrome 从 v68 开始禁止）。
 *      浏览器主线程只能用 Atomics.waitAsync()，但它是异步的，无法提供真正的背压。
 *      因此，本类的 writeSync() 提供"尝试写入+失败丢弃"语义（附带警告），
 *      而 write() 使用 Atomics.waitAsync 的轮询等待（最多 backpressureTimeoutMs）。
 *
 *      实际使用中：
 *        - 若从 Web Worker 调用（如嵌套 Worker），可使用 Atomics.wait 阻塞。
 *        - 若从主线程调用，采用 Atomics.waitAsync 配合重试的非阻塞方案。
 *
 *   3. 每个数据槽的大小固定为 slotDataBytes（默认 64KB）。
 *      单条 batch 序列化后超过此大小时，write() 会抛出错误。
 *      建议 drainBatchSize（LogManager 选项）不超过 256 条事件，
 *      以确保 batch 序列化后不超过槽大小。
 *
 * SAB 布局
 * ────────
 *   ┌── 元数据区（16 字节，4 个 Int32）──────────────────────────────┐
 *   │  [0] writeSeq  主线程写入序号                                  │
 *   │  [1] readSeq   Worker 读取序号                                 │
 *   │  [2] ctrl      0=运行, 1=关闭请求                              │
 *   │  [3] _pad                                                     │
 *   ├── 数据槽区（slotCount × (4 + slotDataBytes) 字节）──────────── │
 *   │  每槽头部（4 字节）：u32 byteLength（0=空/已消费）               │
 *   │  每槽数据（slotDataBytes 字节）：序列化后的 ArrayBuffer          │
 *   └────────────────────────────────────────────────────────────── ┘
 *
 * API 与 WsWorkerBackend / WsBackend 兼容：
 *   connect() / write(batch) / writeSync(batch) / flush() / close()
 *
 * Worker 加载策略（同 WsWorkerBackend）：
 *   bin/jalangi.mjs 的 rollup 插件会将
 *   `new URL('../workers/ws-worker-sab.js', import.meta.url)`
 *   替换为预先创建好的 `__wsSabWorkerUrl` Blob URL。
 */

import { serializeBatchToBinary, serializeBatchToNDJSON } from '../EventSerializer.js';
import { createLogger, isDebugEnabled, DOMAIN } from '../logger.js';

const log = createLogger(DOMAIN.BACKEND_WS);

// ── 元数据索引（与 ws-worker-sab.js 保持同步）─────────────────────────────────

const META_WRITE_SEQ  = 0;
const META_READ_SEQ   = 1;
const META_CTRL       = 2;

const META_INTS       = 4;    // 元数据区占 4 个 i32（16 字节）

export class WsSabBackend {

    /**
     * 检查当前环境是否支持 SharedArrayBuffer。
     * @returns {boolean}
     */
    static isSupported() {
        return typeof SharedArrayBuffer !== 'undefined';
    }

    /**
     * @param {object} [options]
     * @param {URL|string} [options.workerUrl]         Worker 脚本 URL，默认自动推导
     * @param {string}  [options.url='ws://127.0.0.1:9229/trace']  服务端地址
     * @param {'binary'|'ndjson'} [options.format='binary']         消息格式
     * @param {number}  [options.slotCount=64]         环形缓冲区槽数（越多背压容忍度越高）
     * @param {number}  [options.slotDataBytes=65536]  每槽最大字节数（64KB，对应约 256 条事件）
     * @param {number}  [options.maxRetries=10]        最大重连次数（-1 = 永远重连）
     * @param {number}  [options.retryBaseMs=500]      初始重连等待（ms），指数退避
     * @param {number}  [options.retryMaxMs=30000]     最大重连等待（ms）
     * @param {number}  [options.connectTimeoutMs=10000] 连接超时（ms）
     * @param {number}  [options.backpressureTimeoutMs=200]
     *   write() 等待空槽的最大时间（ms）；超时后 write() 直接丢弃该 batch 并记录警告。
     * @param {boolean} [options.autoConnect=true]     构造时是否自动连接
     */
    constructor(options = {}) {
        const {
            workerUrl               = new URL('../workers/ws-worker-sab.js', import.meta.url),
            url                     = 'ws://127.0.0.1:9229/trace',
            format                  = 'binary',
            slotCount               = 64,
            slotDataBytes           = 65536,     // 64KB 每槽
            maxRetries              = 10,
            retryBaseMs             = 500,
            retryMaxMs              = 30000,
            connectTimeoutMs        = 10000,
            backpressureTimeoutMs   = 200,
            autoConnect             = true,
        } = options;

        if (!WsSabBackend.isSupported()) {
            throw new Error(
                'WsSabBackend: SharedArrayBuffer is not available. ' +
                'Ensure the page is served with COOP/COEP headers, or use WsWorkerBackend instead.'
            );
        }

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

        // ── SharedArrayBuffer 布局 ──
        // 元数据：4 个 Int32（16 字节）
        // 数据槽：slotCount × (4 + slotDataBytes) 字节
        const slotBytes  = 4 + slotDataBytes;   // 每槽总字节数
        const sabBytes   = META_INTS * 4 + slotCount * slotBytes;
        this._sab        = new SharedArrayBuffer(sabBytes);
        this._meta       = new Int32Array(this._sab, 0, META_INTS);
        this._dataBuf    = new Uint8Array(this._sab, META_INTS * 4, slotCount * slotBytes);
        this._slotBytes  = slotBytes;

        // 初始化序号为 0
        Atomics.store(this._meta, META_WRITE_SEQ, 0);
        Atomics.store(this._meta, META_READ_SEQ,  0);
        Atomics.store(this._meta, META_CTRL,       0);

        this._worker         = null;
        this._connected      = false;
        this._closed         = false;
        this._batchIdCounter = 0;

        // connect() 等待 Worker ready 的 Promise 队列
        this._connectWaiters = [];
        this._flushWaiters   = [];

        // 统计
        this.stats = {
            batchCount:   0,
            totalEvents:  0,
            dropped:      0,
            errors:       0,
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
            if (this._connected) return Promise.resolve();
            return this._waitForConnect();
        }

        this._worker = new Worker(this._workerUrl);
        this._worker.onerror   = (evt) => this._handleWorkerError(evt);
        this._worker.onmessage = (evt) => this._handleMessage(evt.data);

        this._worker.postMessage({
            cmd:              'init',
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

    /**
     * 批量写入事件（异步，等待写入缓冲区成功后 resolve）。
     *
     * 如果缓冲区已满，会等待最多 backpressureTimeoutMs 毫秒；
     * 超时仍无空槽则丢弃此 batch 并记录警告。
     *
     * @param {Array} batch
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) throw new Error('WsSabBackend: already closed');
        if (!this._worker) this.connect();

        const data = this._serialize(batch);

        if (data.byteLength > this._slotDataBytes) {
            this.stats.errors++;
            log.warn(`write: batch serialized size ${data.byteLength} > slotDataBytes ${this._slotDataBytes}, dropping`);
            return;
        }

        const success = await this._writeToRing(data);
        if (success) {
            this.stats.batchCount++;
            this.stats.totalEvents += batch.length;
        } else {
            this.stats.dropped++;
            log.warn(`write: ring full after ${this._backpressureTimeoutMs}ms backpressure timeout, batch dropped (total dropped=${this.stats.dropped})`);
        }
    }

    /**
     * 同步写入：尝试写入缓冲区，缓冲区满时直接丢弃（fire-and-try）。
     * 适合 beforeunload 等不能异步等待的场景。
     * @param {Array} batch
     */
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

    /**
     * 等待 Worker 消费完所有已写入的槽。
     * @returns {Promise<void>}
     */
    async flush() {
        if (!this._worker || this._closed) return;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._flushWaiters = this._flushWaiters.filter(w => w.resolve !== resolve);
                reject(new Error('WsSabBackend: flush timeout'));
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

        log.debug(`close() — batches=${this.stats.batchCount} events=${this.stats.totalEvents} dropped=${this.stats.dropped}`);

        // 通知 Worker 关闭
        Atomics.store(this._meta, META_CTRL, 1);
        Atomics.notify(this._meta, META_WRITE_SEQ, 1);

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

    // ── 内部方法 ──────────────────────────────────────────────────────────────

    /**
     * 序列化 batch 为 ArrayBuffer。
     * 格式与 WsBackend / WsWorkerBackend 一致：[u32 batchId LE][...batchData]
     * 服务端 server.mjs 先读 4 字节 batchId，再解析 batchData。
     * SAB 模式没有 ack 机制，batchId 递增但仅供服务端日志使用。
     * @param {Array} batch
     * @returns {Uint8Array}
     */
    _serialize(batch) {
        const batchId = ++this._batchIdCounter;
        if (this._format === 'binary') {
            const batchBuf = serializeBatchToBinary(batch);
            // 拼接 [u32 batchId LE][...batchBuf]
            const out  = new ArrayBuffer(4 + batchBuf.byteLength);
            new DataView(out).setUint32(0, batchId >>> 0, true);
            new Uint8Array(out, 4).set(new Uint8Array(batchBuf));
            return new Uint8Array(out);
        } else {
            const str  = JSON.stringify({ batchId, events: batch }) + '\n';
            return new TextEncoder().encode(str);
        }
    }

    /**
     * 尝试写入一个槽（非阻塞）。
     * @param {Uint8Array} data
     * @returns {boolean} 是否成功写入
     */
    _tryWriteSlot(data) {
        const writeSeq = Atomics.load(this._meta, META_WRITE_SEQ);
        const readSeq  = Atomics.load(this._meta, META_READ_SEQ);

        // 缓冲区满：已用槽数 = writeSeq - readSeq >= slotCount
        if (writeSeq - readSeq >= this._slotCount) {
            return false;  // 缓冲区已满，放弃写入
        }

        const slotIdx    = writeSeq % this._slotCount;
        const slotOffset = slotIdx * this._slotBytes;

        // 写数据到槽（头部 4 字节 = byteLength，然后写数据）
        const lenView = new DataView(this._dataBuf.buffer, this._dataBuf.byteOffset + slotOffset, 4);
        lenView.setUint32(0, data.byteLength, true);
        this._dataBuf.set(data, slotOffset + 4);

        // 递增 writeSeq，通知 Worker 有新数据
        Atomics.add(this._meta, META_WRITE_SEQ, 1);
        Atomics.notify(this._meta, META_WRITE_SEQ, 1);

        return true;
    }

    /**
     * 异步写入（等待空槽）：尝试写入，若缓冲区满则用 Atomics.waitAsync 等待空槽。
     * @param {Uint8Array} data
     * @returns {Promise<boolean>}
     */
    async _writeToRing(data) {
        const deadline = Date.now() + this._backpressureTimeoutMs;

        while (true) {
            if (this._tryWriteSlot(data)) return true;

            // 缓冲区满，等待 Worker 消费一个槽
            const remaining = deadline - Date.now();
            if (remaining <= 0) return false;

            const currentReadSeq = Atomics.load(this._meta, META_READ_SEQ);

            if (typeof Atomics.waitAsync === 'function') {
                // 等待 readSeq 变化（Worker 消费后会递增 readSeq 并 notify）
                const result = await Atomics.waitAsync(
                    this._meta,
                    META_READ_SEQ,
                    currentReadSeq,
                    Math.min(remaining, 50)  // 最多等 50ms，然后重试检查
                ).value;
                if (result === 'timed-out') {
                    // 重新检查 deadline
                    continue;
                }
            } else {
                // 降级：简单 sleep
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
                // 由 close() 的 onmessage 处理
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
