// JALANGI DO NOT INSTRUMENT

/**
 * WsBackend — 通过 WebSocket 将事件流推送给外部收集服务。
 *
 * 特性：
 *  - 使用窗口式背压控制（滑动窗口 ack）：每发 windowSize 批次等一次 ack，
 *    避免 WebSocket 内部缓冲区无限增长
 *  - 自动重连（指数退避）：连接断开后自动重试
 *  - 消息格式：二进制（ArrayBuffer，高吞吐）或 NDJSON 文本（可选）
 *  - 支持批次重发（重连后重发未确认批次）
 *
 * 服务端协议（见 trace-server/server.mjs）：
 *   客户端 → 服务端：
 *     二进制帧：[u32 batchId][u32 count][u32 size0][event0][u32 size1][event1]...
 *     或文本帧：JSON { batchId, events: [...] }
 *   服务端 → 客户端：
 *     二进制帧：[u32 batchId]  （4 字节 ack）
 *     或文本帧：JSON { type: 'ack', batchId }
 *
 * 使用方式：
 *   const backend = new WsBackend({ url: 'ws://localhost:9229/trace' });
 */

import { serializeBatchToBinary, serializeBatchToNDJSON } from '../EventSerializer.js';
import { createLogger, DOMAIN } from '../logger.js';

const log = createLogger(DOMAIN.BACKEND_WS);

// 连接状态
const State = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    CLOSING:      'closing',
    CLOSED:       'closed',
});

export class WsBackend {
    /**
     * @param {object} [options]
     * @param {string}  [options.url='ws://127.0.0.1:9229/trace']   服务端地址
     * @param {'binary'|'ndjson'} [options.format='binary']          消息格式
     * @param {number}  [options.windowSize=4]     未确认批次数上限（背压窗口）
     * @param {number}  [options.maxRetries=10]    最大重连次数（-1 = 永远重连）
     * @param {number}  [options.retryBaseMs=500]  初始重连等待（ms），指数退避
     * @param {number}  [options.retryMaxMs=30000] 最大重连等待（ms）
     * @param {number}  [options.connectTimeoutMs=10000] 连接超时（ms）
     * @param {boolean} [options.autoConnect=true]  构造时是否自动连接
     * @param {boolean} [options.replayOnReconnect=true]  重连后重发未确认批次
     */
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
        this._state             = State.DISCONNECTED;
        this._retryCount        = 0;
        this._retryTimer        = null;
        this._batchIdCounter    = 0;

        // 待确认批次队列：Map<batchId, { data, resolve, reject, timer }>
        this._inFlight          = new Map();

        // 等待连接的 Promise 队列（write 时若未连接则排队）
        this._connectWaiters    = [];

        // 统计
        this.stats = {
            batchCount:     0,
            totalEvents:    0,
            ackCount:       0,
            retryCount:     0,
            errors:         0,
            byteSent:       0,
        };

        if (autoConnect) {
            this.connect();
        }
    }

    // ── 公共 API ──────────────────────────────────────────────────────────────

    /**
     * 主动发起连接（autoConnect=false 时手动调用）。
     * @returns {Promise<void>} 连接成功后 resolve
     */
    connect() {
        if (this._state === State.CONNECTED || this._state === State.CONNECTING) {
            return this._waitForConnect();
        }
        this._state = State.CONNECTING;
        return this._openConnection();
    }

    /**
     * 批量写入事件。
     * 若连接未建立，等待重连；连接后立即发送。
     * @param {Array} batch
     * @returns {Promise<void>}  服务端 ack 后 resolve
     */
    async write(batch) {
        if (this._state === State.CLOSED) throw new Error('WsBackend: already closed');

        // 背压：in-flight 窗口已满时等待
        if (this._inFlight.size >= this._windowSize) {
            await this._waitForWindow();
        }

        // 若未连接，等待连接
        if (this._state !== State.CONNECTED) {
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

    /**
     * 同步写入：序列化 + ws.send()，不等 ack，不追踪 in-flight。
     * 【验证用】在主线程同步路径（forceSyncFlushThreshold）中调用，
     * 保证数据在插桩回调返回前已提交给 TCP 缓冲区。
     * @param {Array} batch
     */
    writeSync(batch) {
        if (this._state !== State.CONNECTED || !this._ws) return;
        const batchId = ++this._batchIdCounter;
        const data    = this._serialize(batchId, batch);
        this._sendRaw(data);
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
        // 注意：无 ack 追踪，不支持重发；仅用于验证阶段
    }

    /** 等待所有 in-flight 批次被服务端 ack */
    async flush() {
        if (this._inFlight.size === 0) return;
        await Promise.all([...this._inFlight.values()].map(e =>
            new Promise(resolve => {
                const orig = e.resolve;
                e.resolve = (...a) => { orig(...a); resolve(); };
            })
        ));
    }

    /** 关闭连接 */
    async close() {
        if (this._state === State.CLOSED || this._state === State.CLOSING) return;
        this._state = State.CLOSING;

        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }

        // 等待 in-flight 全部 ack（最多 5 秒）
        if (this._inFlight.size > 0) {
            await Promise.race([
                this.flush(),
                new Promise(r => setTimeout(r, 5000)),
            ]);
        }

        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            // 发送关闭握手
            await new Promise(resolve => {
                this._ws.onclose = resolve;
                this._ws.close(1000, 'client close');
                setTimeout(resolve, 2000);
            });
        }

        this._state = State.CLOSED;
    }

    // ── 内部方法 ──────────────────────────────────────────────────────────────

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
                this._state      = State.CONNECTED;
                this._retryCount = 0;

                // 通知等待连接的 waiters
                const waiters = this._connectWaiters.splice(0);
                for (const r of waiters) r.resolve();

                // 重连后重发未确认批次
                if (this._replayOnReconnect && this._inFlight.size > 0) {
                    for (const [, entry] of this._inFlight) {
                        this._sendRaw(entry.data);
                    }
                }

                resolve();
            };

            this._ws.onclose = (evt) => {
                if (this._state === State.CLOSING || this._state === State.CLOSED) return;
                this._state = State.DISCONNECTED;
                this._scheduleRetry();
            };

            this._ws.onerror = (evt) => {
                clearTimeout(connectTimer);
                this.stats.errors++;
                if (this._state === State.CONNECTING) {
                    this._state = State.DISCONNECTED;
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
            this._state = State.CLOSED;
            // 拒绝所有等待连接的 waiters
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
        this._state = State.CONNECTING;

        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._openConnection().catch(() => {});
        }, delay);
    }

    _handleAck(data) {
        let batchId;
        if (data instanceof ArrayBuffer) {
            // 二进制 ack：4 字节 u32 batchId
            batchId = new DataView(data).getUint32(0, true);
        } else {
            // JSON ack
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
        if (this._format === 'binary') {
            const { serializeBatchToBinary: serialize } = this._getSerializer();
            const batchBuf = serialize(batch);
            const out      = new ArrayBuffer(4 + batchBuf.byteLength);
            const view     = new DataView(out);
            view.setUint32(0, batchId, true);
            new Uint8Array(out, 4).set(new Uint8Array(batchBuf));
            return out;
        } else {
            return JSON.stringify({ batchId, events: batch.map(safeEventForJSON) }) + '\n';
        }
    }

    _getSerializer() {
        if (!this._serializerCache) {
            this._serializerCache = { serializeBatchToBinary };
        }
        return this._serializerCache;
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
        if (this._state === State.CONNECTED) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this._connectWaiters.push({ resolve, reject });
        });
    }

    _waitForWindow() {
        // 等待 in-flight 中任意一个完成
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

// ── NDJSON 序列化辅助（WsBackend 内部用）──────────────────────────────────────
function safeEventForJSON(ev) {
    const safe = {};
    for (const key of Object.keys(ev)) {
        const v = ev[key];
        if (v === undefined)  { safe[key] = '__undefined__'; continue; }
        if (v === null)       { safe[key] = null; continue; }
        const t = typeof v;
        if (t === 'boolean' || t === 'number' || t === 'string') { safe[key] = v; continue; }
        if (t === 'function') { safe[key] = `[Function:${v.name ?? ''}]`; continue; }
        try { safe[key] = JSON.parse(JSON.stringify(v)); } catch { safe[key] = '[object]'; }
    }
    return safe;
}
