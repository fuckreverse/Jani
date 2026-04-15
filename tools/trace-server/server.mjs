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
    mkdirSync, readdirSync, rmSync, existsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs }         from 'node:util';

import { TraceCollector } from './TraceCollector.mjs';

// ─── 参数解析 ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        port:          { type: 'string',  default: '9229'    },
        out:           { type: 'string',  default: 'traces'  },  // 输出目录
        verbose:       { type: 'boolean', default: false     },
        'max-payload': { type: 'string',  default: '0'       },  // 0=无限制，单位：MB
        clear:         { type: 'boolean', default: true      },  // 启动时清空输出目录
        'session-idle':{ type: 'string',  default: '30000'   },  // 会话空闲超时（ms）
        compress:      { type: 'boolean', default: true      },  // 写盘时 gzip 压缩（.bin.gz）
        'gzip-level':  { type: 'string',  default: '6'       },  // gzip 压缩级别 1-9
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
  --clear                启动时清空输出目录中的 .bin/.bin.gz 文件（默认开启，用 --no-clear 关闭）
  --max-payload <MB>     最大消息体积（MB），0 表示无限制（默认: 0）
  --session-idle <ms>    会话空闲多久后关闭文件（默认: 30000ms）
  --compress             写盘时 gzip 压缩，输出 .bin.gz（默认开启，用 --no-compress 关闭）
  --gzip-level <1-9>     gzip 压缩级别，1 最快，9 最小（默认: 6）
  --verbose              打印每个 batch 的接收日志
  --help                 显示此帮助信息

会话文件复用：
  同一逻辑会话（由 WsBackend 在 URL ?sid= 中携带的 UUID 标识）的所有连接
  共享同一文件，网络中断重连后追加写入而不是新建文件。
  文件名格式：trace_<YYYYMMDD>_<HHmmss>_<ms>_<sid前8位>.bin[.gz]

后处理：
  node tools/trace-parse.mjs trace.bin.gz | node tools/trace-render.mjs --format tree
`);
    process.exit(0);
}

const PORT            = parseInt(args.port, 10);
const OUT_DIR         = resolve(args.out);
const VERBOSE         = args.verbose;
const MAX_PAYLOAD     = args['max-payload'] === '0' ? 0 : parseInt(args['max-payload'], 10) * 1024 * 1024;
const CLEAR           = args.clear;
const SESSION_IDLE_MS = parseInt(args['session-idle'], 10) || 30000;
const COMPRESS        = args.compress !== false;  // 默认 true
const GZIP_LEVEL      = Math.max(1, Math.min(9, parseInt(args['gzip-level'] ?? '6', 10)));

// ─── 输出目录初始化 ────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

// 启动时根据 --clear 选项决定是否清空目录中的 .bin / .bin.gz 文件
if (CLEAR && existsSync(OUT_DIR)) {
    const files = readdirSync(OUT_DIR).filter(
        f => f.endsWith('.bin') || f.endsWith('.bin.gz') || f.endsWith('.smap.json')
    );
    for (const f of files) {
        rmSync(join(OUT_DIR, f));
    }
    if (files.length > 0) {
        console.log(`[server] Cleared ${files.length} trace file(s) from: ${OUT_DIR}`);
    }
}

// ─── TraceCollector 实例 ───────────────────────────────────────────────────────

const collector = new TraceCollector({
    outDir:       OUT_DIR,
    compress:     COMPRESS,
    gzipLevel:    GZIP_LEVEL,
    sessionIdleMs: SESSION_IDLE_MS,
    urlBase:      `ws://0.0.0.0:${PORT}`,

    onInfo:  (msg) => console.log(`[server] ${msg}`),
    onError: (msg) => console.error(`[server] ${msg}`),
    onDebug: (msg) => { if (VERBOSE) console.log(`[server] ${msg}`); },
    onWarn:  (msg) => console.warn(`[server] ${msg}`),
});

// ─── 统计打印 ──────────────────────────────────────────────────────────────────

function printStats() {
    const s       = collector.stats;
    const elapsed = ((Date.now() - s.startTime) / 1000).toFixed(1);
    const eps     = (s.eventsReceived / Math.max(parseFloat(elapsed), 0.001)).toFixed(0);
    console.log(
        `[server] ${elapsed}s | connections=${s.connections} | sessions=${collector.sessions.size} | ` +
        `batches=${s.batchesReceived} | events=${s.eventsReceived} (${eps}/s) | ` +
        `bytes=${(s.bytesReceived / 1024).toFixed(1)}KB | errors=${s.errors}`
    );
}

// 每 5 秒打印一次统计
const statsTimer = setInterval(printStats, 5000);

// ─── HTTP 服务器 ────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...collector.stats, activeSessions: collector.sessions.size }));
        return;
    }
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...collector.stats, activeSessions: collector.sessions.size }));
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
    // 启用 WebSocket permessage-deflate：在 WS 传输层自动压缩每条消息
    // 浏览器 WebSocket 原生支持，无需客户端改动
    perMessageDeflate: {
        zlibDeflateOptions: { level: GZIP_LEVEL },
        // 允许服务端和客户端各自维护独立的上下文窗口，提高压缩率
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
    },
});

wss.on('connection', (ws, req) => collector.handleConnection(ws, req));

// ─── 启动 ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
    console.log(`[server] Jani trace server started`);
    console.log(`[server]   WebSocket : ws://0.0.0.0:${PORT}/trace`);
    console.log(`[server]   Health    : http://0.0.0.0:${PORT}/health`);
    console.log(`[server]   Stats     : http://0.0.0.0:${PORT}/stats`);
    console.log(`[server]   Output dir: ${OUT_DIR}`);
    console.log(`[server]   Format    : JTB1 binary (.bin${COMPRESS ? '.gz' : ''})`);
    console.log(`[server]   Compress  : ${COMPRESS ? `gzip level=${GZIP_LEVEL}` : 'off'}`);
    console.log(`[server]   WS deflate: on (perMessageDeflate)`);
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

    // 关闭所有 WS 连接（ws.close 会触发 close 事件）
    for (const ws of wss.clients) {
        ws.close(1001, 'server shutdown');
    }

    // 等待所有活跃会话的文件流关闭
    await collector.shutdown();

    await new Promise(resolve => httpServer.close(resolve));
    console.log(`[server] Server stopped. Trace files in: ${OUT_DIR}`);
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
