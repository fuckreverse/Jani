// JALANGI DO NOT INSTRUMENT

/**
 * TraceCollector.mjs — Jani WebSocket Trace 收集器核心逻辑（共享模块）
 *
 * 被以下两处使用：
 *   - tools/trace-server/server.mjs  （独立 CLI 收集服务）
 *   - analyzer/server.mjs            （JTA Web 面板集成收集服务）
 *
 * 职责：
 *   - TraceSession 数据结构与生命周期管理（创建 / 关闭 / 空闲超时）
 *   - WsBackend 协议解析：[u32 batchId LE][JTB1 事件流]
 *   - 事件去重（seenSeqs）、写入流、ack 回复
 *   - 可选 gzip 压缩写盘（.bin.gz）
 *
 * 使用方式：
 *   const collector = new TraceCollector(options);
 *   collector.handleConnection(ws, req);   // 在 wss.on('connection') 里调用
 *   await collector.shutdown();            // 优雅退出
 */

import {
    createWriteStream,
} from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import {
    createFileHeader,
    EVENT_HEADER_SIZE,
} from '../../src/encoding/EventSerializer.js';

// ─── 内部常量 ──────────────────────────────────────────────────────────────────

/** 用于从 WebSocket upgrade URL 解析 sid 的辅助函数 */
function parseSidFromUrl(rawUrl, base) {
    if (!rawUrl) return null;
    try {
        const parsed = new URL(rawUrl, base || 'ws://x');
        return parsed.searchParams.get('sid') || null;
    } catch {
        return null;
    }
}

// ─── TraceCollector 类 ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} TraceSession
 * @property {string|null}   sid           逻辑会话 ID（null 表示无 sid 老客户端）
 * @property {string}        traceFile     输出文件路径
 * @property {import('stream').Writable} stream 写入流（压缩时为 Gzip 流，否则为 WriteStream）
 * @property {import('stream').Writable|null} _fileStream 底层文件流（压缩时才有）
 * @property {boolean}       headerWritten 文件头是否已写
 * @property {number}        eventCount    累计事件数
 * @property {number}        activeConns   当前活跃连接数
 * @property {ReturnType<typeof setTimeout>|null} idleTimer 空闲关闭定时器
 * @property {Set<number>}   seenSeqs      已见事件序号集合（重连去重用）
 * @property {*}             [meta]        调用方附加的任意元数据（如 projectId）
 */

/**
 * @typedef {Object} TraceCollectorOptions
 * @property {string}   outDir          输出目录（已确保存在）
 * @property {boolean}  [compress]      是否 gzip 写盘（默认 true）
 * @property {number}   [gzipLevel]     gzip 压缩级别 1-9（默认 6）
 * @property {number}   [sessionIdleMs] 会话空闲超时 ms（默认 30000）
 * @property {string}   [urlBase]       解析 sid 时用的 URL base（默认 'ws://x'）
 *
 * @property {(msg: string, data?: object) => void} [onInfo]    日志 info
 * @property {(msg: string, data?: object) => void} [onError]   日志 error
 * @property {(msg: string, data?: object) => void} [onDebug]   日志 debug
 * @property {(msg: string, data?: object) => void} [onWarn]    日志 warn
 *
 * @property {(entry: TraceSession) => Promise<void>|void} [onSessionClosed]
 *   会话流关闭后的钩子（用于写 project_map 等扩展逻辑）
 *
 * @property {(req: import('http').IncomingMessage) => {sid: string|null, meta?: *}} [parseSid]
 *   从 HTTP upgrade request 解析 sid 和元数据（可选）；
 *   默认实现：解析 URL ?sid= 参数
 *
 * @property {() => string} [makeSuffix]
 *   无 sid 时生成文件名后缀（默认：随机8字符字符串）
 */

export class TraceCollector {

    /**
     * @param {TraceCollectorOptions} options
     */
    constructor(options) {
        const {
            outDir,
            compress         = true,
            gzipLevel        = 6,
            sessionIdleMs    = 30000,
            urlBase          = 'ws://x',
            onInfo           = (msg) => console.log(`[TraceCollector] ${msg}`),
            onError          = (msg) => console.error(`[TraceCollector] ${msg}`),
            onDebug          = () => {},
            onWarn           = (msg) => console.warn(`[TraceCollector] ${msg}`),
            onSessionClosed  = null,
            parseSid         = null,
            makeSuffix       = null,
        } = options;

        this.outDir          = outDir;
        this.compress        = compress;
        this.gzipLevel       = Math.max(1, Math.min(9, Number(gzipLevel)));
        this.sessionIdleMs   = Number(sessionIdleMs) || 30000;
        this.urlBase         = urlBase;

        this._onInfo         = onInfo;
        this._onError        = onError;
        this._onDebug        = onDebug;
        this._onWarn         = onWarn;
        this._onSessionClosed = onSessionClosed;
        this._parseSid       = parseSid;
        this._makeSuffix     = makeSuffix || (() => Math.random().toString(36).slice(2, 10));

        /** @type {Map<string, TraceSession>} */
        this.sessions = new Map();

        /** 统计计数（调用方可直接读取） */
        this.stats = {
            connections:     0,
            batchesReceived: 0,
            eventsReceived:  0,
            bytesReceived:   0,
            errors:          0,
            startTime:       Date.now(),
        };

    }

    // ── 文件路径生成 ─────────────────────────────────────────────────────────

    makeTraceFilePath(sid) {
        const now  = new Date();
        const pad  = (n, w = 2) => String(n).padStart(w, '0');
        const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const ms   = pad(now.getMilliseconds(), 3);
        const suffix = sid
            ? sid.replace(/-/g, '').slice(0, 8)
            : this._makeSuffix();
        const ext = this.compress ? '.bin.gz' : '.bin';
        return join(this.outDir, `trace_${date}_${time}_${ms}_${suffix}${ext}`);
    }

    // ── 会话管理 ─────────────────────────────────────────────────────────────

    /**
     * 获取或创建 sid 对应的 TraceSession。
     * @param {string} sid
     * @param {*} [meta] 调用方附加的元数据
     * @returns {TraceSession}
     */
    getOrCreateSession(sid, meta) {
        if (this.sessions.has(sid)) {
            const entry = this.sessions.get(sid);
            if (entry.idleTimer) {
                clearTimeout(entry.idleTimer);
                entry.idleTimer = null;
            }
            return entry;
        }

        const traceFile  = this.makeTraceFilePath(sid);
        const fileStream = createWriteStream(traceFile, { flags: 'a' });
        fileStream.on('error', (err) => {
            this._onError(`Trace file stream error: ${err.message}`, { err, traceFile });
        });

        let stream;
        let gzipStream = null;
        if (this.compress) {
            gzipStream = createGzip({ level: this.gzipLevel });
            gzipStream.pipe(fileStream);
            gzipStream.on('error', (err) => {
                this._onError(`Trace gzip stream error: ${err.message}`, { err, traceFile });
            });
            stream = gzipStream;
        } else {
            stream = fileStream;
        }

        /** @type {TraceSession} */
        const entry = {
            sid,
            traceFile,
            stream,
            _fileStream:   this.compress ? fileStream : null,
            headerWritten: false,
            eventCount:    0,
            activeConns:   0,
            idleTimer:     null,
            seenSeqs:      new Set(),
            meta,
        };

        this.sessions.set(sid, entry);
        this._onInfo(`New trace session: sid=${sid}, file=${traceFile}`, { sid, traceFile, compress: this.compress });
        return entry;
    }

    /**
     * 关闭会话写入流（处理压缩模式下的 flush）。
     * @param {TraceSession} entry
     * @returns {Promise<void>}
     */
    closeSession(entry) {
        // 用独立 Promise 封装：等流真正关闭后再执行 onSessionClosed 钩子
        return new Promise((resolve) => {
            const afterFlush = () => {
                this._onInfo(
                    `Trace saved: ${entry.traceFile} (${entry.eventCount} events)`,
                    { traceFile: entry.traceFile, eventCount: entry.eventCount }
                );

                if (this._onSessionClosed) {
                    // 无论 onSessionClosed 同步/异步，都等它完成后再 resolve
                    Promise.resolve(this._onSessionClosed(entry))
                        .catch((e) => {
                            this._onWarn(`onSessionClosed hook error: ${e.message}`, { err: e });
                        })
                        .finally(resolve);
                } else {
                    resolve();
                }
            };

            // 压缩模式：先 end gzip，等底层文件流 finish
            if (this.compress && entry._fileStream) {
                entry._fileStream.once('finish', afterFlush);
                // error 时也要 resolve，防止关闭流程卡住（先打日志再继续）
                entry._fileStream.once('error', (err) => {
                    this._onError(`Trace file stream error on close: ${err.message}`, { err, traceFile: entry.traceFile });
                    afterFlush();
                });
                entry.stream.end();
            } else {
                entry.stream.end(afterFlush);
            }
        });
    }

    /**
     * 连接断开时调用：活跃连接数 -1，降为 0 时启动空闲定时器。
     * @param {TraceSession} entry
     */
    onConnClosed(entry) {
        entry.activeConns = Math.max(0, entry.activeConns - 1);
        if (entry.activeConns > 0) return;

        entry.idleTimer = setTimeout(() => {
            entry.idleTimer = null;
            if (entry.activeConns > 0) return;
            if (entry.sid) this.sessions.delete(entry.sid);
            this.closeSession(entry);
        }, this.sessionIdleMs);
    }

    // ── 无 sid 降级：创建独立会话对象（不进 Map）─────────────────────────────

    /**
     * 为无 sid 的旧客户端创建一次性会话（不入 sessions Map）。
     * @param {*} [meta]
     * @returns {TraceSession}
     */
    createNoSidSession(meta) {
        const traceFile  = this.makeTraceFilePath(null);
        const fileStream = createWriteStream(traceFile, { flags: 'w' });
        fileStream.on('error', (err) => {
            this._onError(`Trace file stream error (no-sid): ${err.message}`, { err, traceFile });
        });

        let stream;
        if (this.compress) {
            const gz = createGzip({ level: this.gzipLevel });
            gz.pipe(fileStream);
            gz.on('error', (err) => {
                this._onError(`Trace gzip error (no-sid): ${err.message}`, { err, traceFile });
            });
            stream = gz;
        } else {
            stream = fileStream;
        }

        /** @type {TraceSession} */
        return {
            sid:           null,
            traceFile,
            stream,
            _fileStream:   this.compress ? fileStream : null,
            headerWritten: false,
            eventCount:    0,
            activeConns:   1,
            idleTimer:     null,
            seenSeqs:      new Set(),
            meta,
        };
    }

    // ── WS 消息处理核心 ───────────────────────────────────────────────────────

    /**
     * 处理一条 WS 二进制消息（含去重、写入、ack）。
     * @param {WebSocket} ws
     * @param {ArrayBuffer|Buffer} data
     * @param {boolean} isBinary
     * @param {TraceSession} session
     */
    handleMessage(ws, data, isBinary, session) {
        this.stats.bytesReceived += isBinary
            ? (data.byteLength ?? Buffer.byteLength(data))
            : Buffer.byteLength(data, 'utf8');

        if (!isBinary) return; // 忽略文本帧

        // 二进制帧：[u32 batchId LE][JTB1 事件流]
        const buf  = data instanceof Buffer
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;
        const view = new DataView(buf);

        const batchId    = view.getUint32(0, true);
        const eventBytes = buf.slice(4);

        // 首次写入：写文件头
        if (!session.headerWritten) {
            session.stream.write(Buffer.from(createFileHeader()));
            session.headerWritten = true;
        }

        // 扫描事件，seq 去重后收集待写片段
        let batchEventCount = 0;
        let dupCount        = 0;
        const evBuf = Buffer.isBuffer(eventBytes)
            ? eventBytes
            : Buffer.from(eventBytes);
        const segments = [];

        if (evBuf.byteLength >= EVENT_HEADER_SIZE) {
            const ev = new DataView(evBuf.buffer, evBuf.byteOffset, evBuf.byteLength);
            let offset = 0;
            while (offset + EVENT_HEADER_SIZE <= evBuf.byteLength) {
                const payloadLen = ev.getUint16(offset + 10, true);
                const eventEnd   = offset + EVENT_HEADER_SIZE + payloadLen;
                if (eventEnd > evBuf.byteLength) break;

                const seq = ev.getUint32(offset + 6, true);
                if (session.seenSeqs.has(seq)) {
                    dupCount++;
                } else {
                    session.seenSeqs.add(seq);
                    segments.push(evBuf.slice(offset, eventEnd));
                    batchEventCount++;
                }

                offset = eventEnd;
                if (offset <= 0) break;
            }
        }

        // 写入去重后的事件字节流
        if (segments.length > 0) {
            const toWrite = segments.length === 1
                ? segments[0]
                : Buffer.concat(segments);
            session.stream.write(toWrite);
        }

        session.eventCount        += batchEventCount;
        this.stats.batchesReceived++;
        this.stats.eventsReceived += batchEventCount;

        if (dupCount > 0) {
            this._onDebug(
                `Trace dedup: ${dupCount} duplicate event(s) skipped`,
                { dupCount, batchId }
            );
        }

        // 发送 ack（4 字节二进制）
        const ack = new ArrayBuffer(4);
        new DataView(ack).setUint32(0, batchId, true);
        ws.send(ack);
    }

    // ── 一次性 handleConnection（供 wss.on('connection') 直接调用）──────────

    /**
     * 处理一条 WebSocket 连接。
     * 这是将 collector 挂入 wss 的最简方式：
     *   wss.on('connection', (ws, req) => collector.handleConnection(ws, req));
     *
     * @param {WebSocket} ws
     * @param {import('http').IncomingMessage} req
     */
    handleConnection(ws, req) {
        const clientAddr = req.socket?.remoteAddress ?? 'unknown';
        this.stats.connections++;

        // 解析 sid 和元数据
        let sid, meta;
        if (this._parseSid) {
            const result = this._parseSid(req);
            sid  = result.sid  ?? null;
            meta = result.meta ?? null;
        } else {
            sid  = parseSidFromUrl(req.url, this.urlBase);
            meta = null;
        }

        /** @type {TraceSession} */
        let session;

        if (sid) {
            session = this.getOrCreateSession(sid, meta);
            session.activeConns++;
            if (session.activeConns > 1) {
                this._onInfo(
                    `Trace client reconnected: ${clientAddr} → sid=${sid} (activeConns=${session.activeConns})`,
                    { clientAddr, sid, activeConns: session.activeConns }
                );
            } else {
                this._onInfo(
                    `Trace client connected: ${clientAddr} → sid=${sid}`,
                    { clientAddr, sid, traceFile: session.traceFile }
                );
            }
        } else {
            session = this.createNoSidSession(meta);
            this._onInfo(
                `Trace client connected (no sid): ${clientAddr}`,
                { clientAddr, traceFile: session.traceFile }
            );
        }

        ws.binaryType = 'arraybuffer';

        ws.on('message', (data, isBinary) => {
            try {
                this.handleMessage(ws, data, isBinary, session);
            } catch (err) {
                this.stats.errors++;
                this._onError(`Trace message processing error: ${err.message}`, { err });
            }
        });

        ws.on('close', () => {
            this.stats.connections = Math.max(0, this.stats.connections - 1);

            if (session.sid) {
                this._onInfo(
                    `Trace client disconnected: ${clientAddr} → sid=${session.sid}`,
                    { clientAddr, sid: session.sid }
                );
                this.onConnClosed(session);
            } else {
                this._onInfo(
                    `Trace client disconnected (no sid): ${clientAddr}`,
                    { clientAddr }
                );
                this.closeSession(session);
            }
        });

        ws.on('error', (err) => {
            this.stats.errors++;
            this._onError(`Trace WS error from ${clientAddr}: ${err.message}`, { err, clientAddr });
        });
    }

    // ── 优雅关闭 ─────────────────────────────────────────────────────────────

    /**
     * 关闭所有活跃会话的写入流（用于进程退出前调用）。
     * @returns {Promise<void>}
     */
    async shutdown() {
        for (const entry of this.sessions.values()) {
            if (entry.idleTimer) {
                clearTimeout(entry.idleTimer);
                entry.idleTimer = null;
            }
        }
        const closePromises = [...this.sessions.values()].map(e => this.closeSession(e));
        await Promise.all(closePromises);
        this.sessions.clear();
    }
}
