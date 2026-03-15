// JALANGI DO NOT INSTRUMENT

/**
 * @module ws.worker
 *
 * WebSocket 发送 Worker（Classic Worker，完全自包含，无 import）。
 * 同时支持两种工作模式，通过 init 消息的 `mode` 字段选择：
 *
 *   mode: 'worker' — 主线程序列化后 postMessage 数据（原 ws-worker.js）
 *     主线程通过 { cmd: 'write', batchId, data } 发送已序列化好的数据，
 *     Worker 直接 ws.send()，服务端 ack 后转发给主线程。
 *
 *   mode: 'sab'    — SharedArrayBuffer 环形缓冲区（原 ws-worker-sab.js）
 *     主线程通过 Atomics 写入 SAB，Worker 轮询消费后 ws.send()，
 *     无需 ack 机制，适合极高频率的 Trace 事件场景。
 *
 * ─── 消息协议（共用，主线程 → Worker）───────────────────────────────────────
 *
 * 初始化（两种模式均使用）：
 *   { cmd: 'init', mode: 'worker'|'sab', url, format?, maxRetries?,
 *     retryBaseMs?, retryMaxMs?, connectTimeoutMs?, debugEnabled?,
 *     // worker 模式专属：
 *     windowSize?,
 *     // sab 模式专属：
 *     sab, slotCount, slotDataBytes }
 *   → { type: 'ready' }           连接成功
 *   → { type: 'error', message }  连接失败
 *
 * worker 模式专属：
 *   { cmd: 'write', batchId, data }  data 为已序列化好的 ArrayBuffer 或字符串
 *   → { type: 'ack', batchId }
 *
 * 共用命令：
 *   { cmd: 'flush' }  → { type: 'flushed' }
 *   { cmd: 'close' }  → { type: 'closed' }
 */

// ── 全局状态 ────────────────────────────────────────────────────────────────────

let _mode         = 'worker';   // 'worker' | 'sab'，由 init 消息设置
let _debugEnabled = false;

const dbg = {
    debug(...a) { if (_debugEnabled) console.debug('[Jalangi:backend:ws-worker]', ...a); },
    warn(...a)  { console.warn( '[Jalangi:backend:ws-worker]', ...a); },
    error(...a) { console.error('[Jalangi:backend:ws-worker]', ...a); },
};

// ── 连接状态 ────────────────────────────────────────────────────────────────────

const WS_STATE = {
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    CLOSING:      'closing',
    CLOSED:       'closed',
};

let _ws              = null;
let _wsState         = WS_STATE.DISCONNECTED;
let _url             = '';
let _format          = 'binary';
let _maxRetries      = 10;
let _retryBaseMs     = 500;
let _retryMaxMs      = 30000;
let _connectTimeoutMs = 10000;
let _retryCount      = 0;
let _retryTimer      = null;

// ── Worker 模式专属状态 ─────────────────────────────────────────────────────────

let _windowSize      = 16;
const _inFlight      = new Map();  // batchId → { timer, data }
const _sendQueue     = [];         // 连接断开期间的待发队列
let _flushWaiters    = [];

// ── SAB 模式专属状态 ────────────────────────────────────────────────────────────

// 元数据索引（与 WsBackend._SabTransport 保持同步）
const META_WRITE_SEQ = 0;
const META_READ_SEQ  = 1;
const META_CTRL      = 2;

let _meta          = null;   // Int32Array（指向 SAB 元数据区）
let _dataBuf       = null;   // Uint8Array（指向 SAB 数据区）
let _slotCount     = 0;
let _slotBytes     = 0;
let _slotDataBytes = 0;

let _readyWaiters  = [];     // SAB 模式：等待连接的回调队列
let _sabFlushWaiters = [];   // SAB 模式：flush 等待队列

// 统计
const stats = {
    batchCount:  0,
    bytesSent:   0,
    ackCount:    0,
    errors:      0,
    retryCount:  0,
    sent:        0,   // SAB 模式用
};

// ── 连接管理（两种模式共用）────────────────────────────────────────────────────

function openConnection() {
    _wsState = WS_STATE.CONNECTING;

    const connectTimer = setTimeout(() => {
        dbg.warn('connect timeout');
        _ws?.close();
        scheduleRetry();
    }, _connectTimeoutMs);

    try {
        _ws = new WebSocket(_url);
        if (_format === 'binary') _ws.binaryType = 'arraybuffer';
    } catch (err) {
        clearTimeout(connectTimer);
        dbg.error('WebSocket constructor error:', err.message);
        scheduleRetry();
        return;
    }

    _ws.onopen = () => {
        clearTimeout(connectTimer);
        _wsState    = WS_STATE.CONNECTED;
        _retryCount = 0;
        dbg.debug('connected to', _url);
        self.postMessage({ type: 'ready' });

        if (_mode === 'worker') {
            // 重连后重发 in-flight 批次
            for (const [, entry] of _inFlight) {
                sendRaw(entry.data);
            }
            // 发送连接期间积压的数据
            while (_sendQueue.length > 0) {
                const item = _sendQueue.shift();
                _inFlight.set(item.batchId, item);
                sendRaw(item.data);
            }
        } else {
            // SAB 模式：唤醒 readyWaiters，开始消费循环
            const waiters = _readyWaiters.splice(0);
            for (const fn of waiters) fn(true);
            scheduleConsume();
        }
    };

    _ws.onclose = () => {
        clearTimeout(connectTimer);
        if (_wsState === WS_STATE.CLOSING || _wsState === WS_STATE.CLOSED) return;
        _wsState = WS_STATE.DISCONNECTED;
        dbg.warn('connection closed unexpectedly, scheduling retry');
        scheduleRetry();
    };

    _ws.onerror = () => {
        clearTimeout(connectTimer);
        stats.errors++;
        if (_wsState === WS_STATE.CONNECTING) {
            _wsState = WS_STATE.DISCONNECTED;
            scheduleRetry();
        }
    };

    if (_mode === 'worker') {
        _ws.onmessage = (evt) => handleAck(evt.data);
    } else {
        // SAB 模式下不需要 ack
        _ws.onmessage = () => {};
    }
}

function scheduleRetry() {
    if (_maxRetries !== -1 && _retryCount >= _maxRetries) {
        dbg.error('Max retries reached, giving up');
        _wsState = WS_STATE.CLOSED;
        self.postMessage({ type: 'error', message: 'WsWorker: max retries exceeded' });
        if (_mode === 'sab') {
            const waiters = _readyWaiters.splice(0);
            for (const fn of waiters) fn(false);
        }
        return;
    }
    const delay = Math.min(_retryBaseMs * Math.pow(2, _retryCount), _retryMaxMs);
    _retryCount++;
    stats.retryCount++;
    _wsState = WS_STATE.CONNECTING;
    _retryTimer = setTimeout(() => {
        _retryTimer = null;
        openConnection();
    }, delay);
}

function sendRaw(data) {
    if (_ws?.readyState === /* OPEN */ 1) {
        try {
            _ws.send(data);
            stats.bytesSent += typeof data === 'string' ? data.length * 2 : (data.byteLength ?? 0);
        } catch (err) {
            stats.errors++;
            dbg.error('send error:', err.message);
        }
    }
}

// ── Worker 模式专属逻辑 ────────────────────────────────────────────────────────

function handleAck(data) {
    let batchId;
    if (data instanceof ArrayBuffer) {
        if (data.byteLength >= 4) {
            batchId = new DataView(data).getUint32(0, true);
        }
    } else {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'ack') batchId = msg.batchId;
        } catch { return; }
    }

    if (batchId == null) return;

    const entry = _inFlight.get(batchId);
    if (entry) {
        clearTimeout(entry.timer);
        _inFlight.delete(batchId);
        stats.ackCount++;
        dbg.debug(`ack batchId=${batchId}, inFlight=${_inFlight.size}`);
        self.postMessage({ type: 'ack', batchId });
    }

    if (_inFlight.size === 0 && _flushWaiters.length > 0) {
        const waiters = _flushWaiters.splice(0);
        for (const fn of waiters) fn();
    }
}

// ── SAB 模式专属逻辑 ────────────────────────────────────────────────────────────

function readSlot(slotIdx) {
    const slotOffset = slotIdx * _slotBytes;
    const lenView = new DataView(_dataBuf.buffer, _dataBuf.byteOffset + slotOffset, 4);
    const byteLen = lenView.getUint32(0, true);
    if (byteLen === 0) return null;

    const dataOffset = slotOffset + 4;
    const data = _dataBuf.slice(dataOffset, dataOffset + byteLen);
    return { data, byteLen };
}

function clearSlot(slotIdx) {
    const slotOffset = slotIdx * _slotBytes;
    const lenView = new DataView(_dataBuf.buffer, _dataBuf.byteOffset + slotOffset, 4);
    lenView.setUint32(0, 0, true);
}

function scheduleConsume() {
    setTimeout(consumeAvailable, 0);
}

function consumeAvailable() {
    if (_wsState !== WS_STATE.CONNECTED || !_meta) return;

    const ctrl = Atomics.load(_meta, META_CTRL);
    if (ctrl === 1) {
        drainAndClose();
        return;
    }

    let consumed = 0;
    let writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
    let readSeq  = Atomics.load(_meta, META_READ_SEQ);

    while (readSeq < writeSeq) {
        const slotIdx = readSeq % _slotCount;
        const slot = readSlot(slotIdx);

        if (slot && slot.byteLen > 0) {
            try {
                if (_format === 'ndjson') {
                    _ws.send(new TextDecoder().decode(slot.data));
                } else {
                    _ws.send(slot.data.buffer);
                }
                stats.sent++;
                stats.bytesSent += slot.byteLen;
            } catch (err) {
                stats.errors++;
                dbg.error('ws.send error:', err.message);
            }
        }

        clearSlot(slotIdx);

        Atomics.add(_meta, META_READ_SEQ, 1);
        Atomics.notify(_meta, META_READ_SEQ, 1);

        readSeq++;
        consumed++;
    }

    // 检查 flush 等待者
    writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
    readSeq  = Atomics.load(_meta, META_READ_SEQ);
    if (readSeq >= writeSeq && _sabFlushWaiters.length > 0) {
        const waiters = _sabFlushWaiters.splice(0);
        for (const fn of waiters) fn();
    }

    // 继续调度
    if (typeof Atomics.waitAsync === 'function') {
        const currentWriteSeq = Atomics.load(_meta, META_WRITE_SEQ);
        const currentReadSeq  = Atomics.load(_meta, META_READ_SEQ);
        if (currentReadSeq >= currentWriteSeq) {
            Atomics.waitAsync(_meta, META_WRITE_SEQ, currentWriteSeq).value.then(() => {
                if (_wsState === WS_STATE.CONNECTED) consumeAvailable();
            });
        } else {
            scheduleConsume();
        }
    } else {
        if (consumed > 0) {
            scheduleConsume();
        } else {
            setTimeout(consumeAvailable, 50);
        }
    }
}

function drainAndClose() {
    if (_meta) {
        const writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
        let readSeq    = Atomics.load(_meta, META_READ_SEQ);
        while (readSeq < writeSeq) {
            const slotIdx = readSeq % _slotCount;
            const slot = readSlot(slotIdx);
            if (slot && slot.byteLen > 0) {
                try {
                    if (_format === 'ndjson') {
                        _ws.send(new TextDecoder().decode(slot.data));
                    } else {
                        _ws.send(slot.data.buffer);
                    }
                    stats.sent++;
                } catch { stats.errors++; }
            }
            clearSlot(slotIdx);
            Atomics.add(_meta, META_READ_SEQ, 1);
            Atomics.notify(_meta, META_READ_SEQ, 1);
            readSeq++;
        }
    }

    dbg.debug(`drainAndClose: sent=${stats.sent} bytes=${stats.bytesSent} errors=${stats.errors}`);

    if (_ws && _ws.readyState <= 1 /* OPEN */) {
        _ws.onclose = () => {
            _wsState = WS_STATE.CLOSED;
            self.postMessage({ type: 'closed' });
        };
        _ws.close(1000, 'client close');
        setTimeout(() => {
            _wsState = WS_STATE.CLOSED;
            self.postMessage({ type: 'closed' });
        }, 2000);
    } else {
        _wsState = WS_STATE.CLOSED;
        self.postMessage({ type: 'closed' });
    }
}

// ── 消息处理（统一入口）────────────────────────────────────────────────────────

self.onmessage = (evt) => {
    const msg = evt.data;

    switch (msg.cmd) {

        case 'init': {
            _mode             = msg.mode ?? 'worker';
            _debugEnabled     = msg.debugEnabled === true;
            _url              = msg.url ?? 'ws://127.0.0.1:9229/trace';
            _format           = msg.format ?? 'binary';
            _maxRetries       = msg.maxRetries ?? 10;
            _retryBaseMs      = msg.retryBaseMs ?? 500;
            _retryMaxMs       = msg.retryMaxMs ?? 30000;
            _connectTimeoutMs = msg.connectTimeoutMs ?? 10000;

            if (_mode === 'worker') {
                _windowSize = msg.windowSize ?? 16;
                dbg.debug('init(worker)', { url: _url, format: _format, windowSize: _windowSize });
            } else {
                // SAB 模式：接收 SharedArrayBuffer
                _slotCount     = msg.slotCount;
                _slotDataBytes = msg.slotDataBytes;
                _slotBytes     = 4 + _slotDataBytes;

                const sab = msg.sab;
                _meta    = new Int32Array(sab, 0, 4);
                _dataBuf = new Uint8Array(sab, 16, _slotCount * _slotBytes);

                dbg.debug('init(sab)', { url: _url, slotCount: _slotCount, slotDataBytes: _slotDataBytes });
            }

            openConnection();
            break;
        }

        // worker 模式专属：写入已序列化数据
        case 'write': {
            if (_mode !== 'worker') {
                dbg.warn('write cmd received in sab mode — ignoring');
                break;
            }
            const { batchId, data } = msg;
            stats.batchCount++;

            const timer = setTimeout(() => {
                _inFlight.delete(batchId);
                stats.errors++;
                dbg.warn(`ack timeout batchId=${batchId}`);
                // 超时也通知主线程，避免主线程 Promise 永远挂起
                self.postMessage({ type: 'ack', batchId });
            }, 30000);

            const entry = { batchId, data, timer };

            if (_wsState === WS_STATE.CONNECTED) {
                _inFlight.set(batchId, entry);
                sendRaw(data);
            } else {
                _sendQueue.push(entry);
                dbg.debug(`write queued (state=${_wsState}), queue=${_sendQueue.length}`);
            }
            break;
        }

        case 'flush': {
            if (_mode === 'worker') {
                if (_inFlight.size === 0 && _sendQueue.length === 0) {
                    self.postMessage({ type: 'flushed' });
                } else {
                    _flushWaiters.push(() => {
                        self.postMessage({ type: 'flushed' });
                    });
                }
            } else {
                // SAB 模式
                const writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
                const readSeq  = Atomics.load(_meta, META_READ_SEQ);
                if (readSeq >= writeSeq) {
                    self.postMessage({ type: 'flushed' });
                } else {
                    _sabFlushWaiters.push(() => self.postMessage({ type: 'flushed' }));
                }
            }
            break;
        }

        case 'close': {
            if (_mode === 'worker') {
                _wsState = WS_STATE.CLOSING;
                if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
                dbg.debug(`close(worker): batches=${stats.batchCount} bytes=${stats.bytesSent} acks=${stats.ackCount} errors=${stats.errors}`);

                const doClose = () => {
                    if (_ws && _ws.readyState <= /* OPEN */ 1) {
                        _ws.onclose = () => {
                            _wsState = WS_STATE.CLOSED;
                            self.postMessage({ type: 'closed' });
                        };
                        _ws.close(1000, 'client close');
                        setTimeout(() => {
                            _wsState = WS_STATE.CLOSED;
                            self.postMessage({ type: 'closed' });
                        }, 2000);
                    } else {
                        _wsState = WS_STATE.CLOSED;
                        self.postMessage({ type: 'closed' });
                    }
                };

                if (_inFlight.size > 0 || _sendQueue.length > 0) {
                    const closeTimer = setTimeout(doClose, 5000);
                    _flushWaiters.push(() => { clearTimeout(closeTimer); doClose(); });
                } else {
                    doClose();
                }
            } else {
                // SAB 模式
                if (_meta) {
                    Atomics.store(_meta, META_CTRL, 1);
                    Atomics.notify(_meta, META_WRITE_SEQ, 1);
                }
                if (_wsState === WS_STATE.DISCONNECTED || _wsState === WS_STATE.CLOSED) {
                    self.postMessage({ type: 'closed' });
                } else if (_meta) {
                    const writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
                    const readSeq  = Atomics.load(_meta, META_READ_SEQ);
                    if (readSeq >= writeSeq && _wsState === WS_STATE.CONNECTED) {
                        drainAndClose();
                    }
                }
            }
            break;
        }

        default:
            dbg.warn('unknown command:', msg.cmd);
    }
};

self.onerror = (evt) => {
    console.error('[Jalangi:backend:ws-worker] Uncaught Worker error:', evt.message);
};
