#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * trace-server — Jani WebSocket 日志收集服务。
 *
 * 接收来自 WsBackend 的 JTB1 二进制事件批次，写入本地 .bin 文件。
 * 同一逻辑会话（由 URL 参数 ?sid= 标识）的多次连接（网络中断重连）共享同一文件。
 *
 * 启动：
 *   node tools/trace-server/server.mjs [--port 9229] [--out traces] [--no-clear] [--help]
 *
 * 协议（见 WsBackend.js）：
 *   二进制模式（默认）：
 *     客户端 → 服务端：[u32 batchId LE][JTB1 事件流（无文件头，直接事件序列）]
 *     服务端 → 客户端：[u32 batchId LE]（4 字节 ack）
 *
 * 会话文件复用逻辑：
 *   - WsBackend 每次构造时生成一个 UUID 作为 sessionId，通过 ?sid= 拼入 URL
 *   - trace-server 解析 URL 中的 sid，在 Map<sid, SessionEntry> 中查找或新建文件
 *   - 同一 sid 的重连追加写入同一文件（文件头只写一次）
 *   - 会话无活跃连接且超过 SESSION_IDLE_MS 后自动关闭文件（防止泄漏）
 *   - 若 URL 不含 sid（老客户端），降级为每次连接独立文件
 *
 * 输出格式（磁盘）：
 *   每个逻辑会话生成一个 .bin 文件（JTB1 格式）：
 *     文件头（8 字节）+ 事件序列（每条 12 字节头 + payload）
 *   文件名格式：trace_<YYYYMMDD>_<HHmmss>_<ms>_<sid8>.bin
 *
 * 后处理：
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree
 */

import { createServer }   from 'node:http';
import { WebSocketServer } from 'ws';
import {
    createWriteStream, mkdirSync, readdirSync, rmSync, existsSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath }     from 'node:url';
import { parseArgs }         from 'node:util';

import {
    createFileHeader,
    FILE_HEADER_SIZE,
    EVENT_HEADER_SIZE,
} from '../../src/encoding/EventSerializer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 参数解析 ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        port:          { type: 'string',  default: '9229'    },
        out:           { type: 'string',  default: 'traces'  },  // 输出目录
        verbose:       { type: 'boolean', default: false     },
        'max-payload': { type: 'string',  default: '0'       },  // 0=无限制，单位：MB
        clear:         { type: 'boolean', default: true      },  // 启动时清空输出目录
        'session-idle':{ type: 'string',  default: '30000'   },  // 会话空闲超时（ms）
        help:          { type: 'boolean', default: false     },  // 显示帮助
    },
    strict: false,
});

// ─── Help ──────────────────────────────────────────────────────────────────────

if (args.help) {
    console.log(`
Usage: node tools/trace-server/server.mjs [options]

Options:
  --port <number>        WebSocket 监听端口（默认: 9229）
  --out <dir>            输出目录（默认: traces）
  --clear                启动时清空输出目录中的 .bin 文件（默认开启，用 --no-clear 关闭）
  --max-payload <MB>     最大消息体积（MB），0 表示无限制（默认: 0）
  --session-idle <ms>    会话空闲多久后关闭文件（默认: 30000ms）
  --verbose              打印每个 batch 的接收日志
  --help                 显示此帮助信息

会话文件复用：
  同一逻辑会话（由 WsBackend 在 URL ?sid= 中携带的 UUID 标识）的所有连接
  共享同一 .bin 文件，网络中断重连后追加写入而不是新建文件。
  文件名格式：trace_<YYYYMMDD>_<HHmmss>_<ms>_<sid前8位>.bin

后处理：
  node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree
`);
    process.exit(0);
}

const PORT           = parseInt(args.port, 10);
const OUT_DIR        = resolve(args.out);
const VERBOSE        = args.verbose;
const MAX_PAYLOAD    = args['max-payload'] === '0' ? 0 : parseInt(args['max-payload'], 10) * 1024 * 1024;
const CLEAR          = args.clear;
const SESSION_IDLE_MS = parseInt(args['session-idle'], 10) || 30000;

// ─── 输出目录初始化 ────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

// 启动时根据 --clear 选项决定是否清空目录中的 .bin 文件
if (CLEAR && existsSync(OUT_DIR)) {
    const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.bin') || f.endsWith('.smap.json'));
    for (const f of files) {
        rmSync(join(OUT_DIR, f));
    }
    if (files.length > 0) {
        console.log(`[server] Cleared ${files.length} trace file(s) from: ${OUT_DIR}`);
    }
}

// ─── 会话文件命名 ──────────────────────────────────────────────────────────────

function makeTraceFilePath(sid) {
    const now  = new Date();
    const pad  = (n, w = 2) => String(n).padStart(w, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ms   = pad(now.getMilliseconds(), 3);
    // sid 取前8字符方便辨认，无 sid 时用随机数
    const suffix = sid ? sid.replace(/-/g, '').slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return join(OUT_DIR, `trace_${date}_${time}_${ms}_${suffix}.bin`);
}

// ─── 从 WebSocket upgrade URL 解析 sid ────────────────────────────────────────

function parseSid(url) {
    if (!url) return null;
    try {
        // URL 可能是相对路径，需要加 dummy base
        const parsed = new URL(url, 'ws://x');
        return parsed.searchParams.get('sid') || null;
    } catch {
        return null;
    }
}

// ─── 会话表 ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SessionEntry
 * @property {string}           sid          逻辑会话 ID（来自 ?sid= 参数）
 * @property {string}           traceFile    输出文件路径
 * @property {import('fs').WriteStream} stream 写入流
 * @property {boolean}          headerWritten 文件头是否已写
 * @property {number}           eventCount   累计事件数
 * @property {number}           activeConns  当前活跃连接数
 * @property {ReturnType<typeof setTimeout>|null} idleTimer 空闲关闭定时器
 */

/** @type {Map<string, SessionEntry>} */
const sessions = new Map();

/**
 * 获取或创建指定 sid 的会话记录。
 * @param {string} sid
 * @returns {SessionEntry}
 */
function getOrCreateSession(sid) {
    if (sessions.has(sid)) {
        const entry = sessions.get(sid);
        // 取消空闲定时器（有新连接进来了）
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
        return entry;
    }

    const traceFile = makeTraceFilePath(sid);
    const stream    = createWriteStream(traceFile, { flags: 'a' });

    stream.on('error', (err) => {
        console.error(`[server] Stream error (${traceFile}):`, err.message);
    });

    /** @type {SessionEntry} */
    const entry = {
        sid,
        traceFile,
        stream,
        headerWritten: false,
        eventCount:    0,
        activeConns:   0,
        idleTimer:     null,
    };

    sessions.set(sid, entry);
    console.log(`[server] New session: sid=${sid}`);
    console.log(`[server]   → Writing to: ${traceFile}`);
    return entry;
}

/**
 * 连接断开时调用：活跃连接数 -1，若降为 0 则启动空闲定时器。
 * @param {SessionEntry} entry
 */
function onConnectionClosed(entry) {
    entry.activeConns = Math.max(0, entry.activeConns - 1);

    if (entry.activeConns > 0) return;  // 还有其他连接，暂不关闭

    // 所有连接均已断开，启动空闲超时
    entry.idleTimer = setTimeout(() => {
        entry.idleTimer = null;
        // 再次确认无活跃连接
        if (entry.activeConns > 0) return;
        entry.stream.end(() => {
            console.log(`[server] Session closed (idle): sid=${entry.sid}, events=${entry.eventCount}`);
            console.log(`[server]   → Trace saved: ${entry.traceFile}`);
        });
        sessions.delete(entry.sid);
    }, SESSION_IDLE_MS);
}

// ─── 统计 ──────────────────────────────────────────────────────────────────────

const stats = {
    connections:     0,
    batchesReceived: 0,
    eventsReceived:  0,
    bytesReceived:   0,
    errors:          0,
    startTime:       Date.now(),
};

function printStats() {
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    const eps     = (stats.eventsReceived / Math.max(parseFloat(elapsed), 0.001)).toFixed(0);
    console.log(
        `[server] ${elapsed}s | connections=${stats.connections} | sessions=${sessions.size} | ` +
        `batches=${stats.batchesReceived} | events=${stats.eventsReceived} (${eps}/s) | ` +
        `bytes=${(stats.bytesReceived / 1024).toFixed(1)}KB | errors=${stats.errors}`
    );
}

// 每 5 秒打印一次统计
const statsTimer = setInterval(printStats, 5000);

// ─── HTTP 服务器 ────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...stats, activeSessions: sessions.size }));
        return;
    }
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...stats, activeSessions: sessions.size }));
        return;
    }
    res.writeHead(404);
    res.end();
});

// ─── WebSocket 服务器 ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({
    server: httpServer,
    path: '/trace',
    maxPayload: MAX_PAYLOAD || undefined,
});

wss.on('connection', (ws, req) => {
    const clientAddr = req.socket.remoteAddress;
    stats.connections++;

    // 从升级请求 URL 解析 sid
    const sid = parseSid(req.url);

    /** @type {SessionEntry} */
    let session;

    if (sid) {
        session = getOrCreateSession(sid);
        session.activeConns++;
        if (session.activeConns > 1) {
            console.log(`[server] Client reconnected: ${clientAddr} → sid=${sid} (active conns: ${session.activeConns})`);
        } else {
            console.log(`[server] Client connected: ${clientAddr} → sid=${sid}`);
        }
    } else {
        // 无 sid（老客户端），降级为每次连接独立文件
        const traceFile = makeTraceFilePath(null);
        const stream    = createWriteStream(traceFile, { flags: 'w' });
        stream.on('error', (err) => {
            console.error(`[server] Stream error (${traceFile}):`, err.message);
        });
        session = {
            sid: null,
            traceFile,
            stream,
            headerWritten: false,
            eventCount:    0,
            activeConns:   1,
            idleTimer:     null,
        };
        console.log(`[server] Client connected (no sid): ${clientAddr}`);
        console.log(`[server]   → Writing to: ${traceFile}`);
    }

    // 使用二进制帧
    ws.binaryType = 'arraybuffer';

    ws.on('message', (data, isBinary) => {
        try {
            stats.bytesReceived += isBinary ? (data.byteLength ?? Buffer.byteLength(data)) : Buffer.byteLength(data, 'utf8');

            if (!isBinary) {
                console.warn(`[server] Received text frame from ${clientAddr}, expected binary. Ignoring.`);
                return;
            }

            // 二进制帧：[u32 batchId LE][事件流 bytes]
            const buf  = data instanceof Buffer
                ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                : data;
            const view = new DataView(buf);

            const batchId    = view.getUint32(0, true);
            const eventBytes = buf.slice(4);  // 剩余部分是事件流

            // 首次写入：写文件头（追加模式下也只写一次）
            if (!session.headerWritten) {
                const header = createFileHeader();
                session.stream.write(Buffer.from(header));
                session.headerWritten = true;
            }

            // 统计事件数
            let batchEventCount = 0;
            if (eventBytes.byteLength >= EVENT_HEADER_SIZE) {
                const ev = new DataView(eventBytes);
                let offset = 0;
                while (offset + EVENT_HEADER_SIZE <= eventBytes.byteLength) {
                    const payloadLen = ev.getUint16(offset + 10, true);
                    offset += EVENT_HEADER_SIZE + payloadLen;
                    batchEventCount++;
                    if (offset <= 0) break;
                }
            }

            // 写入事件字节流
            if (eventBytes.byteLength > 0) {
                session.stream.write(Buffer.from(eventBytes));
            }

            session.eventCount   += batchEventCount;
            stats.batchesReceived++;
            stats.eventsReceived += batchEventCount;

            if (VERBOSE) {
                console.log(`[server] batch #${batchId}: ${batchEventCount} events → ${session.traceFile}`);
            }

            // 发送 ack（4 字节二进制）
            const ack = new ArrayBuffer(4);
            new DataView(ack).setUint32(0, batchId, true);
            ws.send(ack);

        } catch (err) {
            stats.errors++;
            console.error('[server] Message processing error:', err.message);
        }
    });

    ws.on('close', (code, reason) => {
        stats.connections = Math.max(0, stats.connections - 1);

        if (session.sid) {
            // 有 sid：进入空闲等待逻辑，留给重连或超时关闭
            console.log(`[server] Client disconnected: ${clientAddr} → sid=${session.sid} (code=${code}, active: ${stats.connections})`);
            onConnectionClosed(session);
        } else {
            // 无 sid：立即关闭文件
            console.log(`[server] Client disconnected (no sid): ${clientAddr} (code=${code})`);
            session.stream.end(() => {
                console.log(`[server]   → Trace saved: ${session.traceFile} (${session.eventCount} events)`);
                console.log(`[server]   → Decode with: node tools/trace-parse.mjs ${session.traceFile}`);
            });
        }
    });

    ws.on('error', (err) => {
        stats.errors++;
        console.error(`[server] WS error from ${clientAddr}:`, err.message);
    });
});

// ─── 启动 ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
    console.log(`[server] Jani trace server started`);
    console.log(`[server]   WebSocket : ws://0.0.0.0:${PORT}/trace`);
    console.log(`[server]   Health    : http://0.0.0.0:${PORT}/health`);
    console.log(`[server]   Stats     : http://0.0.0.0:${PORT}/stats`);
    console.log(`[server]   Output dir: ${OUT_DIR}`);
    console.log(`[server]   Format    : JTB1 binary (.bin)`);
    console.log(`[server]   Clear     : ${CLEAR}`);
    console.log(`[server]   SessionIdle: ${SESSION_IDLE_MS}ms`);
    if (MAX_PAYLOAD) {
        console.log(`[server]   MaxPayload: ${args['max-payload']}MB`);
    } else {
        console.log(`[server]   MaxPayload: unlimited`);
    }
});

// ─── 优雅关闭 ──────────────────────────────────────────────────────────────────

async function shutdown(signal) {
    console.log(`\n[server] Received ${signal}, shutting down...`);
    clearInterval(statsTimer);
    printStats();

    // 取消所有空闲定时器，立即关闭所有会话文件
    for (const entry of sessions.values()) {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    // 关闭所有 WS 连接（ws.close 会触发 close 事件）
    for (const ws of wss.clients) {
        ws.close(1001, 'server shutdown');
    }

    // 等待所有活跃会话的文件流关闭
    const closePromises = [...sessions.values()].map(entry =>
        new Promise(r => entry.stream.end(r))
    );
    await Promise.all(closePromises);
    sessions.clear();

    await new Promise(resolve => httpServer.close(resolve));
    console.log(`[server] Server stopped. Trace files in: ${OUT_DIR}`);
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
