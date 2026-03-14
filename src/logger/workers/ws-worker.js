// JALANGI DO NOT INSTRUMENT

/**
 * @module ws-worker
 *
 * WebSocket 发送 Worker（Classic Worker，完全自包含，无 import）。
 * 由 WsWorkerBackend 通过 postMessage 驱动，在独立线程中持有 WebSocket 连接，
 * 主线程只需 postMessage 数据，发送完全在 Worker 内部完成。
 *
 * 核心优势：
 *  - WebSocket 的 ws.send() 在 Worker 独立事件循环中执行，
 *    不受主线程繁忙（插桩代码执行）影响。
 *  - 主线程调用 postMessage 只需几微秒（结构化克隆 + 写入队列），
 *    立即返回，不阻塞插桩回调。
 *  - Worker 事件循环闲置时即可处理消息队列，随时将数据发送出去。
 *
 * 消息协议（主线程 → Worker）：
 *   { cmd: 'init', url, format?, windowSize?, maxRetries?, retryBaseMs?,
 *                  retryMaxMs?, connectTimeoutMs?, debugEnabled? }
 *     → { type: 'ready' }           连接成功
 *     → { type: 'error', message }  连接失败
 *
 *   { cmd: 'write', batchId, data }
 *     data 为已序列化好的 ArrayBuffer 或字符串（含 batchId 前缀，与 WsBackend 协议一致）
 *     → { type: 'ack', batchId }   服务端确认（转发）
 *
 *   { cmd: 'flush' }
 *     等待所有 in-flight 批次都收到服务端 ack
 *     → { type: 'flushed' }
 *
 *   { cmd: 'close' }
 *     → { type: 'closed' }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'ready' }
 *   { type: 'error', message }
 *   { type: 'ack', batchId }
 *   { type: 'flushed' }
 *   { type: 'closed' }
 *   { type: 'stats', ... }   （可选，调试用）
 */

// ── 连接状态 ────────────────────────────────────────────────────────────────────

const State = {
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    CLOSING:      'closing',
    CLOSED:       'closed',
};

let _debugEnabled     = false;

const dbg = {
    debug(...args) { if (_debugEnabled) console.debug('[Jalangi:backend:ws-worker]', ...args); },
    warn(...args)  { console.warn( '[Jalangi:backend:ws-worker]', ...args); },
    error(...args) { console.error('[Jalangi:backend:ws-worker]', ...args); },
};

// ── WebSocket 状态 ──────────────────────────────────────────────────────────────

let _ws              = null;
let _state           = State.DISCONNECTED;
let _url             = '';
let _format          = 'binary';   // 'binary' | 'ndjson'
let _windowSize      = 16;          // 待确认批次上限（Worker 侧，可比主线程更大）
let _maxRetries      = 10;
let _retryBaseMs     = 500;
let _retryMaxMs      = 30000;
let _connectTimeoutMs = 10000;
let _retryCount      = 0;
let _retryTimer      = null;

// in-flight：等待服务端 ack 的批次  batchId → { timer, resolve?, data }
const _inFlight = new Map();

// 等待连接就绪的 flush 请求队列
let _flushWaiters = [];

// 待发送队列（连接断开期间缓冲）
const _sendQueue = [];

// 统计
const stats = {
    batchCount:   0,
    bytesSent:    0,
    ackCount:     0,
    errors:       0,
    retryCount:   0,
};

// ── 连接管理 ────────────────────────────────────────────────────────────────────

function openConnection() {
    _state = State.CONNECTING;

    let connectTimer = setTimeout(() => {
        dbg.warn('connect timeout');
        _ws?.close();
        scheduleRetry();
    }, _connectTimeoutMs);

    try {
        _ws = new WebSocket(_url);
        if (_format === 'binary') {
            _ws.binaryType = 'arraybuffer';
        }
    } catch (err) {
        clearTimeout(connectTimer);
        dbg.error('WebSocket constructor error:', err.message);
        scheduleRetry();
        return;
    }

    _ws.onopen = () => {
        clearTimeout(connectTimer);
        _state       = State.CONNECTED;
        _retryCount  = 0;
        dbg.debug('connected to', _url);
        self.postMessage({ type: 'ready' });

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
    };

    _ws.onclose = () => {
        clearTimeout(connectTimer);
        if (_state === State.CLOSING || _state === State.CLOSED) return;
        _state = State.DISCONNECTED;
        dbg.warn('connection closed unexpectedly, scheduling retry');
        scheduleRetry();
    };

    _ws.onerror = (evt) => {
        clearTimeout(connectTimer);
        stats.errors++;
        dbg.error('WebSocket error');
        if (_state === State.CONNECTING) {
            _state = State.DISCONNECTED;
            scheduleRetry();
        }
    };

    _ws.onmessage = (evt) => handleAck(evt.data);
}

function scheduleRetry() {
    if (_maxRetries !== -1 && _retryCount >= _maxRetries) {
        dbg.error('Max retries reached, giving up');
        _state = State.CLOSED;
        self.postMessage({ type: 'error', message: 'WsWorker: max retries exceeded' });
        return;
    }
    const delay = Math.min(_retryBaseMs * Math.pow(2, _retryCount), _retryMaxMs);
    _retryCount++;
    stats.retryCount++;
    _state = State.CONNECTING;
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
        // 转发 ack 给主线程
        self.postMessage({ type: 'ack', batchId });
    }

    // 唤醒 flush 等待者
    if (_inFlight.size === 0 && _flushWaiters.length > 0) {
        const waiters = _flushWaiters.splice(0);
        for (const fn of waiters) fn();
    }
}

// ── 消息处理 ────────────────────────────────────────────────────────────────────

self.onmessage = (evt) => {
    const msg = evt.data;
    switch (msg.cmd) {

        case 'init': {
            _debugEnabled     = msg.debugEnabled === true;
            _url              = msg.url ?? 'ws://127.0.0.1:9229/trace';
            _format           = msg.format ?? 'binary';
            _windowSize       = msg.windowSize ?? 16;
            _maxRetries       = msg.maxRetries ?? 10;
            _retryBaseMs      = msg.retryBaseMs ?? 500;
            _retryMaxMs       = msg.retryMaxMs ?? 30000;
            _connectTimeoutMs = msg.connectTimeoutMs ?? 10000;
            dbg.debug('init', { url: _url, format: _format, windowSize: _windowSize });
            openConnection();
            break;
        }

        case 'write': {
            // msg.data: 已序列化好的 ArrayBuffer 或字符串（含 batchId 前缀）
            // msg.batchId: 批次 ID（用于 ack 路由）
            const { batchId, data } = msg;
            stats.batchCount++;

            const timer = setTimeout(() => {
                _inFlight.delete(batchId);
                stats.errors++;
                dbg.warn(`ack timeout batchId=${batchId}`);
                // 超时时也通知主线程（以 ack 形式），避免主线程 Promise 永远挂起
                self.postMessage({ type: 'ack', batchId });
            }, 30000);

            const entry = { batchId, data, timer };

            if (_state === State.CONNECTED) {
                _inFlight.set(batchId, entry);
                sendRaw(data);
            } else {
                // 连接未就绪：放入待发队列，onopen 时再发
                _sendQueue.push(entry);
                dbg.debug(`write queued (state=${_state}), queue=${_sendQueue.length}`);
            }
            break;
        }

        case 'flush': {
            if (_inFlight.size === 0 && _sendQueue.length === 0) {
                self.postMessage({ type: 'flushed' });
            } else {
                _flushWaiters.push(() => {
                    self.postMessage({ type: 'flushed' });
                });
            }
            break;
        }

        case 'close': {
            _state = State.CLOSING;
            if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
            dbg.debug(`close: batches=${stats.batchCount} bytes=${stats.bytesSent} acks=${stats.ackCount} errors=${stats.errors}`);

            const doClose = () => {
                if (_ws && _ws.readyState <= /* OPEN */ 1) {
                    _ws.onclose = () => {
                        _state = State.CLOSED;
                        self.postMessage({ type: 'closed' });
                    };
                    _ws.close(1000, 'client close');
                    // 保险：2s 后强制完成
                    setTimeout(() => {
                        _state = State.CLOSED;
                        self.postMessage({ type: 'closed' });
                    }, 2000);
                } else {
                    _state = State.CLOSED;
                    self.postMessage({ type: 'closed' });
                }
            };

            if (_inFlight.size > 0 || _sendQueue.length > 0) {
                // 等待 flush 后再关闭，最多 5s
                const closeTimer = setTimeout(doClose, 5000);
                _flushWaiters.push(() => { clearTimeout(closeTimer); doClose(); });
            } else {
                doClose();
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
