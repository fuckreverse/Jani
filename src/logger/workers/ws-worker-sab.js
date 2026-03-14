// JALANGI DO NOT INSTRUMENT

/**
 * @module ws-worker-sab
 *
 * 基于 SharedArrayBuffer 的 WebSocket 发送 Worker。
 *
 * 原理
 * ────
 * 主线程（WsSabBackend）与本 Worker 共享一块 SharedArrayBuffer，
 * 该缓冲区被实现为一个多槽环形缓冲区（ring buffer）：
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  SharedArrayBuffer（元数据区 + 数据槽区）                      │
 *   │                                                              │
 *   │  元数据区（Int32Array，各占 1 个 i32，即 4 字节）：              │
 *   │    [0] writeSeq   主线程写入的序号（单调递增，Atomics.add）      │
 *   │    [1] readSeq    Worker 读取的序号（单调递增，Atomics.add）     │
 *   │    [2] ctrl       控制信号：0=运行, 1=请求关闭                  │
 *   │    [3] _padding                                              │
 *   │                                                              │
 *   │  数据槽区（每槽 = SLOT_HEADER_INTS * 4 + SLOT_DATA_BYTES）：   │
 *   │    头部：[u32 byteLength]（实际数据字节数，0=空槽）              │
 *   │    数据：最多 SLOT_DATA_BYTES 字节的序列化后数据                 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * 为什么用序号而非读/写指针？
 *   序号天然是单调递增的，不需要对 capacity 取模（避免 CAS 竞争），
 *   读写位置 = seq % slotCount。
 *
 * 背压机制
 * ────────
 * - 主线程写满时：执行 Atomics.wait(meta, 1, currentReadSeq, timeout) 等待
 *   Worker 消费一个槽后 Atomics.notify 唤醒，主线程再重试写入。
 * - Worker 读空时：执行 Atomics.wait(meta, 0, currentWriteSeq, timeout) 等待
 *   主线程写入后 Atomics.notify 唤醒，Worker 再重试读取。
 *
 * COOP/COEP 要求
 * ──────────────
 * SharedArrayBuffer 需要页面响应头：
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * 消息协议（主线程 → Worker，通过 postMessage）：
 *   { cmd: 'init', sab, slotCount, slotDataBytes, url, format?,
 *     maxRetries?, retryBaseMs?, retryMaxMs?, connectTimeoutMs?, debugEnabled? }
 *     → { type: 'ready' }            连接成功
 *     → { type: 'error', message }   连接失败
 *
 *   { cmd: 'flush' }
 *     等待环形缓冲区读空（所有已写入数据均已发送）
 *     → { type: 'flushed' }
 *
 *   { cmd: 'close' }
 *     → { type: 'closed' }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'ready' }
 *   { type: 'error', message }
 *   { type: 'flushed' }
 *   { type: 'closed' }
 */

// ── 元数据索引（Int32Array 下标）──────────────────────────────────────────────

const META_WRITE_SEQ  = 0;   // 主线程写入序号
const META_READ_SEQ   = 1;   // Worker 读取序号
const META_CTRL       = 2;   // 控制信号（0=运行, 1=关闭请求）

// ── 配置（由 init 消息填入）────────────────────────────────────────────────────

let _meta        = null;   // Int32Array（指向 SAB 元数据区）
let _dataBuf     = null;   // Uint8Array（指向 SAB 数据区）
let _slotCount   = 0;
let _slotBytes   = 0;      // 每个槽的总字节数（头 4 字节 + 数据区）
let _slotDataBytes = 0;    // 每个槽的数据区字节数

// ── WebSocket ─────────────────────────────────────────────────────────────────

let _ws               = null;
let _wsUrl            = '';
let _format           = 'binary';
let _maxRetries       = 10;
let _retryBaseMs      = 500;
let _retryMaxMs       = 30000;
let _connectTimeoutMs = 10000;
let _retryCount       = 0;
let _retryTimer       = null;
let _wsState          = 'disconnected';   // 'connecting'|'connected'|'closing'|'closed'

let _debugEnabled     = false;

const dbg = {
    debug(...a) { if (_debugEnabled) console.debug('[Jalangi:ws-worker-sab]', ...a); },
    warn(...a)  { console.warn( '[Jalangi:ws-worker-sab]', ...a); },
    error(...a) { console.error('[Jalangi:ws-worker-sab]', ...a); },
};

// 等待连接就绪的回调队列（避免 init 完成前就开始消费环）
let _readyWaiters  = [];
let _flushWaiters  = [];

// 统计
const stats = { sent: 0, bytes: 0, errors: 0 };

// ── 连接管理 ────────────────────────────────────────────────────────────────────

function openConnection() {
    _wsState = 'connecting';

    const timer = setTimeout(() => {
        dbg.warn('connect timeout');
        _ws?.close();
        scheduleRetry();
    }, _connectTimeoutMs);

    try {
        _ws = new WebSocket(_wsUrl);
        if (_format === 'binary') _ws.binaryType = 'arraybuffer';
    } catch (err) {
        clearTimeout(timer);
        dbg.error('WebSocket error:', err.message);
        scheduleRetry();
        return;
    }

    _ws.onopen = () => {
        clearTimeout(timer);
        _wsState    = 'connected';
        _retryCount = 0;
        dbg.debug('connected to', _wsUrl);
        self.postMessage({ type: 'ready' });
        // 唤醒所有 readyWaiters
        const ws = _readyWaiters.splice(0);
        for (const fn of ws) fn(true);
        // 开始消费环形缓冲区
        scheduleConsume();
    };

    _ws.onclose = () => {
        clearTimeout(timer);
        if (_wsState === 'closing' || _wsState === 'closed') return;
        _wsState = 'disconnected';
        dbg.warn('connection closed unexpectedly, scheduling retry');
        scheduleRetry();
    };

    _ws.onerror = () => {
        clearTimeout(timer);
        stats.errors++;
        if (_wsState === 'connecting') {
            _wsState = 'disconnected';
            scheduleRetry();
        }
    };

    // SAB 模式下不需要 ack，但保留 onmessage 以便服务端发控制帧（如 backpressure）
    _ws.onmessage = () => {};
}

function scheduleRetry() {
    if (_maxRetries !== -1 && _retryCount >= _maxRetries) {
        dbg.error('max retries exceeded');
        _wsState = 'closed';
        self.postMessage({ type: 'error', message: 'WsSabWorker: max retries exceeded' });
        const ws = _readyWaiters.splice(0);
        for (const fn of ws) fn(false);
        return;
    }
    const delay = Math.min(_retryBaseMs * Math.pow(2, _retryCount), _retryMaxMs);
    _retryCount++;
    _wsState = 'connecting';
    _retryTimer = setTimeout(() => {
        _retryTimer = null;
        openConnection();
    }, delay);
}

// ── 环形缓冲区消费循环 ──────────────────────────────────────────────────────────

/**
 * 从 SAB 数据槽中读取序列化后的二进制数据（不复制，直接引用视图）。
 * 注意：读取完毕后必须尽快通知写端（Atomics.add readSeq + notify）。
 *
 * @param {number} slotIdx  槽号（0 ~ _slotCount-1）
 * @returns {{ data: Uint8Array, byteLength: number } | null}
 */
function readSlot(slotIdx) {
    const slotOffset = slotIdx * _slotBytes;
    // 读取槽头部的 byteLength（little-endian u32）
    const lenView = new DataView(_dataBuf.buffer, _dataBuf.byteOffset + slotOffset, 4);
    const byteLen = lenView.getUint32(0, true);
    if (byteLen === 0) return null;

    // 返回数据区的视图（拷贝一份，以便立即释放槽位）
    const dataOffset = slotOffset + 4;
    const data = _dataBuf.slice(dataOffset, dataOffset + byteLen);
    return { data, byteLen };
}

/** 清空槽头部 byteLength，释放槽位供主线程复用 */
function clearSlot(slotIdx) {
    const slotOffset = slotIdx * _slotBytes;
    // 将 byteLength 清零
    const lenView = new DataView(_dataBuf.buffer, _dataBuf.byteOffset + slotOffset, 4);
    lenView.setUint32(0, 0, true);
}

/**
 * 消费循环：读取环形缓冲区中所有可用槽并通过 WebSocket 发送。
 * 使用 setTimeout(0) 调度自身，让 Worker 的事件循环有机会处理其他事件（如 postMessage）。
 */
function scheduleConsume() {
    setTimeout(consumeAvailable, 0);
}

function consumeAvailable() {
    if (_wsState !== 'connected' || !_meta) return;

    const ctrl = Atomics.load(_meta, META_CTRL);
    if (ctrl === 1) {
        // 收到关闭信号，将缓冲区清空后关闭
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
                    // NDJSON 格式：解码为字符串，以文本帧发送（服务端 isBinary=false 路径）
                    _ws.send(new TextDecoder().decode(slot.data));
                } else {
                    _ws.send(slot.data.buffer);
                }
                stats.sent++;
                stats.bytes += slot.byteLen;
            } catch (err) {
                stats.errors++;
                dbg.error('ws.send error:', err.message);
            }
        }

        clearSlot(slotIdx);

        // 递增 readSeq，通知主线程有空槽可写
        Atomics.add(_meta, META_READ_SEQ, 1);
        Atomics.notify(_meta, META_READ_SEQ, 1);  // 唤醒可能在等待空槽的主线程

        readSeq++;
        consumed++;
    }

    // 检查 flush 等待者
    writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
    readSeq  = Atomics.load(_meta, META_READ_SEQ);
    if (readSeq >= writeSeq && _flushWaiters.length > 0) {
        const waiters = _flushWaiters.splice(0);
        for (const fn of waiters) fn();
    }

    // 继续调度（使用 Atomics.waitAsync 等待新数据，避免空转）
    if (typeof Atomics.waitAsync === 'function') {
        const currentWriteSeq = Atomics.load(_meta, META_WRITE_SEQ);
        const currentReadSeq  = Atomics.load(_meta, META_READ_SEQ);
        if (currentReadSeq >= currentWriteSeq) {
            // 缓冲区为空，等待主线程写入
            Atomics.waitAsync(_meta, META_WRITE_SEQ, currentWriteSeq).value.then(() => {
                if (_wsState === 'connected') consumeAvailable();
            });
        } else {
            // 还有数据，继续消费
            scheduleConsume();
        }
    } else {
        // 降级：定时轮询（50ms，适合不支持 Atomics.waitAsync 的环境）
        if (consumed > 0) {
            scheduleConsume();
        } else {
            setTimeout(consumeAvailable, 50);
        }
    }
}

function drainAndClose() {
    // 尽量消费剩余数据
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

    dbg.debug(`drainAndClose: sent=${stats.sent} bytes=${stats.bytes} errors=${stats.errors}`);

    if (_ws && _ws.readyState <= 1 /* OPEN */) {
        _ws.onclose = () => {
            _wsState = 'closed';
            self.postMessage({ type: 'closed' });
        };
        _ws.close(1000, 'client close');
        setTimeout(() => {
            _wsState = 'closed';
            self.postMessage({ type: 'closed' });
        }, 2000);
    } else {
        _wsState = 'closed';
        self.postMessage({ type: 'closed' });
    }
}

// ── 消息处理 ────────────────────────────────────────────────────────────────────

self.onmessage = (evt) => {
    const msg = evt.data;

    switch (msg.cmd) {

        case 'init': {
            _debugEnabled     = msg.debugEnabled === true;
            _wsUrl            = msg.url ?? 'ws://127.0.0.1:9229/trace';
            _format           = msg.format ?? 'binary';
            _maxRetries       = msg.maxRetries ?? 10;
            _retryBaseMs      = msg.retryBaseMs ?? 500;
            _retryMaxMs       = msg.retryMaxMs ?? 30000;
            _connectTimeoutMs = msg.connectTimeoutMs ?? 10000;

            // 接收 SharedArrayBuffer
            const sab          = msg.sab;
            _slotCount         = msg.slotCount;
            _slotDataBytes     = msg.slotDataBytes;
            _slotBytes         = 4 + _slotDataBytes;  // 头 4 字节（u32 byteLength）+ 数据区

            // 元数据区：前 16 字节（4 个 i32）
            _meta    = new Int32Array(sab, 0, 4);
            // 数据区：16 字节之后
            _dataBuf = new Uint8Array(sab, 16, _slotCount * _slotBytes);

            dbg.debug('init', { url: _wsUrl, slotCount: _slotCount, slotDataBytes: _slotDataBytes });
            openConnection();
            break;
        }

        case 'flush': {
            const writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
            const readSeq  = Atomics.load(_meta, META_READ_SEQ);
            if (readSeq >= writeSeq) {
                self.postMessage({ type: 'flushed' });
            } else {
                _flushWaiters.push(() => self.postMessage({ type: 'flushed' }));
            }
            break;
        }

        case 'close': {
            // 设置控制标志，消费循环检测后执行 drainAndClose
            if (_meta) {
                Atomics.store(_meta, META_CTRL, 1);
                // 如果 Worker 可能在 waitAsync 中睡眠，notify 唤醒
                Atomics.notify(_meta, META_WRITE_SEQ, 1);
            }
            // 如果还没连接，直接回复 closed
            if (_wsState === 'disconnected' || _wsState === 'closed') {
                self.postMessage({ type: 'closed' });
            }
            // 否则由 consumeAvailable 检测到 ctrl=1 后执行 drainAndClose
            // 但先检查是否已经空了
            if (_meta) {
                const writeSeq = Atomics.load(_meta, META_WRITE_SEQ);
                const readSeq  = Atomics.load(_meta, META_READ_SEQ);
                if (readSeq >= writeSeq && _wsState === 'connected') {
                    drainAndClose();
                }
            }
            break;
        }

        default:
            dbg.warn('unknown command:', msg.cmd);
    }
};

self.onerror = (evt) => {
    console.error('[Jalangi:ws-worker-sab] Uncaught Worker error:', evt.message);
};
