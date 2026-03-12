#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * trace-server — Jalangi2 WebSocket 日志收集服务。
 *
 * 接收来自浏览器 WsBackend 的事件批次，写入本地文件（NDJSON 格式）。
 *
 * 启动：
 *   node tools/trace-server/server.mjs [--port 9229] [--out trace.ndjson] [--format binary|ndjson] [--no-text-only] [--no-clear] [--help]
 *
 * 协议（见 WsBackend.js）：
 *   二进制模式：
 *     客户端 → 服务端：[u32 batchId LE][u32 count LE][u32 size0 LE][event0 binary]...
 *     服务端 → 客户端：[u32 batchId LE]（4 字节 ack）
 *   NDJSON 模式：
 *     客户端 → 服务端：JSON 行 { batchId, events: [...] }
 *     服务端 → 客户端：JSON 行 { type: 'ack', batchId }
 *
 * 输出格式（磁盘）：
 *   默认（--text-only）：trace 类型事件只写入 text 字段的纯文本，其余事件仍为 JSON。
 *   --no-text-only：所有事件统一输出为 NDJSON（一行一个 JSON 对象），可用 `jq` 直接分析。
 */

import { createServer }   from 'node:http';
import { WebSocketServer } from 'ws';
import { createWriteStream, truncateSync, existsSync } from 'node:fs';
import { resolve, dirname }  from 'node:path';
import { fileURLToPath }     from 'node:url';
import { parseArgs }         from 'node:util';

import {
    deserializeBatchFromBinary,
    serializeBatchToNDJSON,
} from '../../src/logger/EventSerializer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 参数解析 ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        port:        { type: 'string',  default: '9229'           },
        out:         { type: 'string',  default: 'trace.ndjson'   },
        format:      { type: 'string',  default: 'binary'         },  // binary | ndjson
        verbose:     { type: 'boolean', default: false            },
        'text-only': { type: 'boolean', default: true               },  // trace 事件只存 text
        'max-payload': { type: 'string', default: '0'              },  // 0=无限制，单位：MB
        clear:       { type: 'boolean', default: true             },  // 启动时清空输出文件
        help:        { type: 'boolean', default: false            },  // 显示帮助
    },
    strict: false,
});

// ─── Help ──────────────────────────────────────────────────────────────────────

if (args.help) {
    console.log(`
Usage: node tools/trace-server/server.mjs [options]

Options:
  --port <number>        WebSocket 监听端口（默认: 9229）
  --out <file>           输出文件路径（默认: trace.ndjson）
  --format <mode>        接收格式：binary | ndjson（默认: binary）
  --text-only            trace 事件只写 text 字段（默认开启，用 --no-text-only 关闭）
  --clear                启动时清空输出文件（默认开启，用 --no-clear 关闭）
  --max-payload <MB>     最大消息体积（MB），0 表示无限制（默认: 0）
  --verbose              打印每个 batch 的接收日志
  --help                 显示此帮助信息
`);
    process.exit(0);
}

const PORT        = parseInt(args.port, 10);
const OUT         = resolve(args.out);
const FORMAT      = args.format === 'ndjson' ? 'ndjson' : 'binary';
const VERBOSE     = args.verbose;
const TEXT_ONLY   = args['text-only'];
const MAX_PAYLOAD = args['max-payload'] === '0' ? 0 : parseInt(args['max-payload'], 10) * 1024 * 1024;
const CLEAR       = args.clear;

// ─── 文件输出流 ────────────────────────────────────────────────────────────────

// 启动时根据 --clear 选项决定是否清空输出文件
if (CLEAR && existsSync(OUT)) {
    truncateSync(OUT, 0);
    console.log(`[server] Cleared output file: ${OUT}`);
}

const outStream = createWriteStream(OUT, { flags: 'a', encoding: 'utf8' });

outStream.on('error', (err) => {
    console.error('[server] Output stream error:', err.message);
});

process.on('exit', () => {
    outStream.end();
    console.log(`\n[server] Trace saved to ${OUT}`);
});

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
    // 提供简单的健康检查端点
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...stats }));
        return;
    }
    // 提供统计查询端点
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
    maxPayload: MAX_PAYLOAD || undefined,  // 0 表示无限制
});

wss.on('connection', (ws, req) => {
    const clientAddr = req.socket.remoteAddress;
    stats.connections++;
    console.log(`[server] Client connected: ${clientAddr} (total: ${stats.connections})`);

    if (FORMAT === 'binary') {
        ws.binaryType = 'arraybuffer';
    }

    ws.on('message', (data, isBinary) => {
        try {
            stats.bytesReceived += isBinary ? data.byteLength : Buffer.byteLength(data, 'utf8');

            let batchId, events;

            if (isBinary) {
                // 二进制格式：[u32 batchId][rest = serializeBatchToBinary output]
                // Node.js ws 库的 message 事件：isBinary=true 时 data 是 Buffer；
                // isBinary=false（文本帧）时 data 也是 Buffer，但需走 NDJSON 路径，
                // 因此必须以 isBinary 标志为唯一判据，不能用 data instanceof Buffer。
                const buf  = data instanceof Buffer
                    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                    : data;  // 浏览器端 ArrayBuffer
                const view = new DataView(buf);
                batchId    = view.getUint32(0, true);
                // 剩余部分是标准批次格式
                const rest = buf.slice(4);
                events     = deserializeBatchFromBinary(rest);
            } else {
                // NDJSON 格式（文本帧）：{ batchId, events: [...] }
                const msg  = JSON.parse(data.toString());
                batchId    = msg.batchId;
                events     = msg.events ?? [];
            }

            // 写入文件（每条一行）
            let line = '';
            for (const ev of events) {
                if (TEXT_ONLY && ev.type === 'trace' && ev.text != null) {
                    line += ev.text + '\n';
                } else {
                    line += JSON.stringify(ev) + '\n';
                }
            }
            if (line) outStream.write(line);

            stats.batchesReceived++;
            stats.eventsReceived += events.length;

            if (VERBOSE) {
                console.log(`[server] batch #${batchId}: ${events.length} events`);
            }

            // 发送 ack：格式与收到的帧类型保持一致
            // 二进制帧 → 4 字节二进制 ack；文本帧（NDJSON）→ JSON ack
            if (isBinary) {
                const ack = new ArrayBuffer(4);
                new DataView(ack).setUint32(0, batchId, true);
                ws.send(ack);
            } else {
                ws.send(JSON.stringify({ type: 'ack', batchId }));
            }

        } catch (err) {
            stats.errors++;
            console.error('[server] Message processing error:', err.message);
        }
    });

    ws.on('close', (code, reason) => {
        stats.connections = Math.max(0, stats.connections - 1);
        console.log(`[server] Client disconnected: ${clientAddr} (code=${code}, active: ${stats.connections})`);
    });

    ws.on('error', (err) => {
        stats.errors++;
        console.error(`[server] WS error from ${clientAddr}:`, err.message);
    });
});

// ─── 启动 ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
    console.log(`[server] Jalangi2 trace server started`);
    console.log(`[server]   WebSocket : ws://0.0.0.0:${PORT}/trace`);
    console.log(`[server]   Health    : http://0.0.0.0:${PORT}/health`);
    console.log(`[server]   Stats     : http://0.0.0.0:${PORT}/stats`);
    console.log(`[server]   Output    : ${OUT}`);
    console.log(`[server]   Format    : ${FORMAT}`);
    console.log(`[server]   Text-only : ${TEXT_ONLY}`);
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

    // 关闭所有 WS 连接
    for (const ws of wss.clients) {
        ws.close(1001, 'server shutdown');
    }

    await new Promise(resolve => httpServer.close(resolve));
    outStream.end(() => {
        console.log(`[server] Trace file closed: ${OUT}`);
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
