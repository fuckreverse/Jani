/**
 * server.mjs — JTA Express 服务入口
 *
 * 启动：node server.mjs [--port 3000] [--db <path>] [--traces-dir <dir>] [--no-clear-traces]
 *
 * 功能：
 * - 文件上传（multer）
 * - REST API（sessions + instrument）
 * - WebSocket（插件进度 + 运行输出流 + trace 收集 /ws/trace）
 * - 静态文件服务（前端 dist）
 * - Trace 收集服务（原 trace-server，ws://localhost:<port>/ws/trace）
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { resolve, dirname, join } from 'path';
import { mkdirSync, existsSync, createWriteStream, readdirSync, rmSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';

import {
    createFileHeader,
    EVENT_HEADER_SIZE,
} from '../src/encoding/EventSerializer.js';

import * as db from './db/Database.mjs';
import { autoDiscover } from './PluginEngine.mjs';
import { registerWsClient } from './InstrumentRunner.mjs';
import sessionsRouter from './routes/sessions.mjs';
import instrumentRouter from './routes/instrument.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portArg       = args.indexOf('--port');
const dbArg         = args.indexOf('--db');
const tracesDirArg  = args.indexOf('--traces-dir');
const noClearTraces = args.includes('--no-clear-traces');

const PORT    = portArg >= 0 ? Number(args[portArg + 1])   : (process.env.PORT ? Number(process.env.PORT) : 33000);
const DB_PATH = dbArg   >= 0 ? args[dbArg + 1]             : resolve(__dirname, 'data/jta.db');
const UPLOAD_DIR   = resolve(__dirname, 'data/uploads');
const SESSIONS_DIR = resolve(__dirname, 'data/sessions');
const TRACES_DIR   = tracesDirArg >= 0 ? resolve(args[tracesDirArg + 1]) : resolve(process.cwd(), 'traces');
const UI_DIST     = resolve(__dirname, 'ui/dist');

// 确保目录存在
mkdirSync(UPLOAD_DIR,   { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(TRACES_DIR,   { recursive: true });

// 启动时清空旧 trace 文件（--no-clear-traces 可关闭）
if (!noClearTraces && existsSync(TRACES_DIR)) {
    const oldFiles = readdirSync(TRACES_DIR).filter(f => f.endsWith('.bin') || f.endsWith('.smap.json'));
    for (const f of oldFiles) rmSync(join(TRACES_DIR, f));
    if (oldFiles.length > 0) console.log(`[JTA] Cleared ${oldFiles.length} trace file(s) from: ${TRACES_DIR}`);
}

// ── Trace 收集（原 trace-server）统计 ───────────────────────────────────────

const traceStats = {
    connections:     0,
    batchesReceived: 0,
    eventsReceived:  0,
    bytesReceived:   0,
    errors:          0,
    startTime:       Date.now(),
};

let traceConnSeq = 0;

function makeTraceFilePath() {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ms   = pad(now.getMilliseconds(), 3);
    const seq  = pad(++traceConnSeq, 3);
    return join(TRACES_DIR, `trace_${date}_${time}_${ms}_${seq}.bin`);
}

// ── 初始化数据库 ─────────────────────────────────────────────────────────────

await db.init(DB_PATH);
console.log(`[JTA] Database: ${DB_PATH}`);

// 自动发现并注册插件
await autoDiscover();

// ── Express 应用 ─────────────────────────────────────────────────────────────

const app = express();

// CORS（开发模式允许所有来源）
app.use(cors());

// JSON body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// multer — 文件上传（临时存储到 UPLOAD_DIR）
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

// 文件上传中间件（sessions 路由需要）
app.use('/api/sessions', (req, res, next) => {
    if (req.method === 'POST') {
        upload.fields([
            { name: 'bin',    maxCount: 1 },
            { name: 'smap',   maxCount: 1 },
            { name: 'source', maxCount: 1 },
        ])(req, res, next);
    } else {
        next();
    }
});

// WebSocket 进度广播函数（存入 app，供路由使用）
const wsProgressClients = new Map(); // sessionId → Set<ws>

app.set('wsProgressBroadcast', (sessionId, event) => {
    const clients = wsProgressClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const ws of clients) {
        try {
            if (ws.readyState === 1 /* OPEN */) ws.send(data);
        } catch { /* ignore */ }
    }
});

// ── API 路由 ────────────────────────────────────────────────────────────────

app.use('/api/sessions',    sessionsRouter);
app.use('/api/instrument',  instrumentRouter);

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
});

// Trace 统计
app.get('/api/trace/stats', (req, res) => {
    const elapsed = ((Date.now() - traceStats.startTime) / 1000).toFixed(1);
    res.json({ ...traceStats, uptime: elapsed, tracesDir: TRACES_DIR });
});

// Trace 文件列表
app.get('/api/trace/files', (req, res) => {
    try {
        const files = readdirSync(TRACES_DIR)
            .filter(f => f.endsWith('.bin'))
            .map(f => {
                const fp = join(TRACES_DIR, f);
                let st = null;
                try { st = statSync(fp); } catch { /* ignore */ }
                return { name: f, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json({ files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件导入为会话
app.post('/api/trace/import', async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename || typeof filename !== 'string' || filename.includes('/') || filename.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const binPath = join(TRACES_DIR, filename);
        if (!existsSync(binPath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        // 查找对应的 smap.json（同名）
        const smapPath = binPath.replace(/\.bin$/, '.smap.json');

        const { createSession } = await import('./routes/sessions.mjs');
        const sessionId = await createSession({
            binPath,
            smapPath: existsSync(smapPath) ? smapPath : null,
            name: filename.replace(/\.bin$/, ''),
            wsProgressBroadcast: req.app.get('wsProgressBroadcast'),
        });
        res.json({ sessionId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 全局错误处理：确保所有 /api/ 路由的错误（含 multer 错误）都返回 JSON
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[JTA] Unhandled error:', err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    if (req.path.startsWith('/api/')) {
        return res.status(status).json({ error: message });
    }
    res.status(status).send(message);
});

// ── 静态文件服务（前端 dist）─────────────────────────────────────────────────

if (existsSync(UI_DIST)) {
    app.use(express.static(UI_DIST));
    // SPA fallback：所有非 API 路由返回 index.html
    app.get(/^(?!\/api\/).*$/, (req, res) => {
        res.sendFile(resolve(UI_DIST, 'index.html'));
    });
} else {
    app.get('/', (req, res) => {
        res.send(`
            <h1>JTA Server Running</h1>
            <p>Frontend not built yet. Run <code>cd ui && npm run build</code> first.</p>
            <p><a href="/api/health">Health Check</a></p>
        `);
    });
}

// ── HTTP + WebSocket 服务器 ───────────────────────────────────────────────────

const server = createServer(app);

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname; // e.g. /ws/sessions/:id/progress  or  /ws/run/:runId

    // ── 插件进度订阅：/ws/sessions/:id/progress ─────────────────────────────
    const progressMatch = pathname.match(/^\/ws\/sessions\/([^/]+)\/progress$/);
    if (progressMatch) {
        const sessionId = progressMatch[1];

        if (!wsProgressClients.has(sessionId)) {
            wsProgressClients.set(sessionId, new Set());
        }
        wsProgressClients.get(sessionId).add(ws);

        // 发送当前会话状态（含检查点信息）
        try {
            const session = db.get('SELECT status, plugin_status FROM sessions WHERE id = ?', sessionId);
            if (session) {
                // 查询检查点（已完成的插件列表）
                let checkpoints = [];
                try {
                    checkpoints = db.all(
                        'SELECT plugin_id, phase, completed_at, duration_ms FROM plugin_checkpoints WHERE session_id = ? ORDER BY completed_at ASC',
                        sessionId
                    );
                } catch { /* table may not exist on old db */ }

                ws.send(JSON.stringify({
                    type: 'init',
                    sessionId,
                    status: session.status,
                    pluginStatus: JSON.parse(session.plugin_status || '{}'),
                    checkpoints,
                }));
            }
        } catch { /* ignore */ }

        ws.on('close', () => {
            const clients = wsProgressClients.get(sessionId);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) wsProgressClients.delete(sessionId);
            }
        });

        return;
    }

    // ── 运行输出订阅：/ws/instrument/run/:runId 或 /ws/run/:runId ─────────────
    const runMatch = pathname.match(/^\/ws\/(?:instrument\/)?run\/([^/]+)$/);
    if (runMatch) {
        const runId = runMatch[1];
        registerWsClient(runId, ws);
        return;
    }

    // ── Trace 收集：/ws/trace（原 trace-server 功能）────────────────────────
    if (pathname === '/ws/trace') {
        const clientAddr = req.socket.remoteAddress;
        traceStats.connections++;

        const traceFile  = makeTraceFilePath();
        const outStream  = createWriteStream(traceFile, { flags: 'w' });
        let   eventCount = 0;
        let   headerWritten = false;

        outStream.on('error', (err) => {
            console.error(`[JTA/trace] Output stream error (${traceFile}):`, err.message);
        });

        console.log(`[JTA/trace] Client connected: ${clientAddr} → ${traceFile}`);
        ws.binaryType = 'arraybuffer';

        ws.on('message', (data, isBinary) => {
            try {
                traceStats.bytesReceived += isBinary
                    ? (data.byteLength ?? Buffer.byteLength(data))
                    : Buffer.byteLength(data, 'utf8');

                if (!isBinary) return; // 忽略文本帧

                // 二进制帧：[u32 batchId LE][事件流 bytes]
                const buf  = data instanceof Buffer
                    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                    : data;
                const view = new DataView(buf);

                const batchId    = view.getUint32(0, true);
                const eventBytes = buf.slice(4);

                // 首次写入：先写文件头
                if (!headerWritten) {
                    outStream.write(Buffer.from(createFileHeader()));
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
                        if (offset <= 0) break;
                    }
                }

                if (eventBytes.byteLength > 0) outStream.write(Buffer.from(eventBytes));

                eventCount           += batchEventCount;
                traceStats.batchesReceived++;
                traceStats.eventsReceived += batchEventCount;

                // 发送 ack（4 字节二进制）
                const ack = new ArrayBuffer(4);
                new DataView(ack).setUint32(0, batchId, true);
                ws.send(ack);

            } catch (err) {
                traceStats.errors++;
                console.error('[JTA/trace] Message processing error:', err.message);
            }
        });

        ws.on('close', () => {
            traceStats.connections = Math.max(0, traceStats.connections - 1);
            outStream.end(() => {
                console.log(`[JTA/trace] Saved: ${traceFile} (${eventCount} events)`);
            });
        });

        ws.on('error', (err) => {
            traceStats.errors++;
            console.error(`[JTA/trace] WS error from ${clientAddr}:`, err.message);
        });

        return;
    }

    // 未知路由
    ws.send(JSON.stringify({ type: 'error', message: `Unknown WS path: ${pathname}` }));
    ws.close();
});

// ── 启动 ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`[JTA] Server listening on http://localhost:${PORT}`);
    console.log(`[JTA] API:    http://localhost:${PORT}/api/health`);
    console.log(`[JTA] Trace:  ws://localhost:${PORT}/ws/trace  (output: ${TRACES_DIR})`);
    if (existsSync(UI_DIST)) {
        console.log(`[JTA] UI:     http://localhost:${PORT}/`);
    } else {
        console.log(`[JTA] UI not built (run: cd ui && npm run build)`);
    }
});

// 优雅退出
process.on('SIGTERM', () => {
    server.close(() => {
        db.close();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    server.close(() => {
        db.close();
        process.exit(0);
    });
});

export default app;
