#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * trace-server — Jani WebSocket 日志收集服务。
 *
 * 接收来自 WsBackend 的 JTB1 二进制事件批次，写入本地 .bin 文件。
 * 每个 WebSocket 连接对应一个独立文件，文件名包含时间戳和序号。
 *
 * 启动：
 *   node tools/trace-server/server.mjs [--port 9229] [--out traces] [--no-clear] [--help]
 *
 * 协议（见 WsBackend.js）：
 *   二进制模式（默认）：
 *     客户端 → 服务端：[u32 batchId LE][JTB1 事件流（无文件头，直接事件序列）]
 *     服务端 → 客户端：[u32 batchId LE]（4 字节 ack）
 *
 * 输出格式（磁盘）：
 *   每个 WebSocket 连接生成一个独立 .bin 文件（JTB1 格式）：
 *     文件头（8 字节）+ 事件序列（每条 12 字节头 + payload）
 *   文件名格式：trace_<YYYYMMDD>_<HHmmss>_<ms>_<seq>.bin
 *
 * 后处理：
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree
 */

import { createServer }   from 'node:http';
import { WebSocketServer } from 'ws';
import {
    createWriteStream, mkdirSync, readdirSync, rmSync, existsSync, writeFileSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath }     from 'node:url';
import { parseArgs }         from 'node:util';

import {
    createFileHeader,
    isBinaryTrace,
    FILE_HEADER_SIZE,
    EVENT_HEADER_SIZE,
    deserializeEvent,
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
  --out <dir>            输出目录（默认: traces）。每个连接写入独立 .bin 文件
  --clear                启动时清空输出目录中的 .bin 文件（默认开启，用 --no-clear 关闭）
  --max-payload <MB>     最大消息体积（MB），0 表示无限制（默认: 0）
  --verbose              打印每个 batch 的接收日志
  --help                 显示此帮助信息

文件命名：
  每个 WebSocket 连接生成一个独立 .bin 文件：
    trace_<YYYYMMDD>_<HHmmss>_<ms>_<seq>.bin

后处理：
  node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree
`);
    process.exit(0);
}

const PORT        = parseInt(args.port, 10);
const OUT_DIR     = resolve(args.out);
const VERBOSE     = args.verbose;
const MAX_PAYLOAD = args['max-payload'] === '0' ? 0 : parseInt(args['max-payload'], 10) * 1024 * 1024;
const CLEAR       = args.clear;

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

let connSeq = 0;

function makeTraceFilePath() {
    const now  = new Date();
    const pad  = (n, w = 2) => String(n).padStart(w, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ms   = pad(now.getMilliseconds(), 3);
    const seq  = pad(++connSeq, 3);
    return join(OUT_DIR, `trace_${date}_${time}_${ms}_${seq}.bin`);
}

// ─── 统计 ──────────────────────────────────────────────────────────────────────

const stats = {
    connections:    0,
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
        `[server] ${elapsed}s | connections=${stats.connections} | ` +
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
        res.end(JSON.stringify({ status: 'ok', ...stats }));
        return;
    }
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
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

    // 为本次连接创建独立的输出文件（.bin 格式）
    const traceFile  = makeTraceFilePath();
    const outStream  = createWriteStream(traceFile, { flags: 'w' });
    let   eventCount = 0;
    let   headerWritten = false;

    outStream.on('error', (err) => {
        console.error(`[server] Output stream error (${traceFile}):`, err.message);
    });

    console.log(`[server] Client connected: ${clientAddr} (total: ${stats.connections})`);
    console.log(`[server]   → Writing to: ${traceFile}`);

    // 使用二进制帧
    ws.binaryType = 'arraybuffer';

    ws.on('message', (data, isBinary) => {
        try {
            stats.bytesReceived += isBinary ? (data.byteLength ?? Buffer.byteLength(data)) : Buffer.byteLength(data, 'utf8');

            if (!isBinary) {
                // 文本帧：不支持，忽略并提示
                console.warn(`[server] Received text frame from ${clientAddr}, expected binary. Ignoring.`);
                return;
            }

            // 二进制帧：[u32 batchId LE][事件流 bytes]
            // 事件流 = 连续的 EventSerializer 事件（12字节头 + payload），无文件头
            const buf  = data instanceof Buffer
                ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                : data;
            const view = new DataView(buf);

            const batchId    = view.getUint32(0, true);
            const eventBytes = buf.slice(4);  // 剩余部分是事件流

            // 首次写入：先写文件头
            if (!headerWritten) {
                const header = createFileHeader();
                outStream.write(Buffer.from(header));
                headerWritten = true;
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
                    if (offset <= 0) break; // 防止无限循环
                }
            }

            // 直接写入事件字节流到文件
            if (eventBytes.byteLength > 0) {
                outStream.write(Buffer.from(eventBytes));
            }

            eventCount           += batchEventCount;
            stats.batchesReceived++;
            stats.eventsReceived += batchEventCount;

            if (VERBOSE) {
                console.log(`[server] batch #${batchId}: ${batchEventCount} events → ${traceFile}`);
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
        console.log(`[server] Client disconnected: ${clientAddr} (code=${code}, active: ${stats.connections})`);
        outStream.end(() => {
            console.log(`[server]   → Trace saved: ${traceFile} (${eventCount} events)`);
            console.log(`[server]   → Decode with: node tools/trace-parse.mjs ${traceFile}`);
        });
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

    for (const ws of wss.clients) {
        ws.close(1001, 'server shutdown');
    }

    await new Promise(resolve => httpServer.close(resolve));
    console.log(`[server] Server stopped. Trace files in: ${OUT_DIR}`);
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
