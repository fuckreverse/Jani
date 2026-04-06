/**
 * server.mjs — JTA Express 服务入口
 *
 * 启动：node server.mjs [--port 3000] [--db <path>]
 *
 * 功能：
 * - 文件上传（multer）
 * - REST API（sessions + instrument）
 * - WebSocket（插件进度 + 运行输出流）
 * - 静态文件服务（前端 dist）
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { resolve, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';

import * as db from './db/Database.mjs';
import { autoDiscover } from './PluginEngine.mjs';
import { registerWsClient } from './InstrumentRunner.mjs';
import sessionsRouter from './routes/sessions.mjs';
import instrumentRouter from './routes/instrument.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portArg   = args.indexOf('--port');
const dbArg     = args.indexOf('--db');

const PORT    = portArg >= 0 ? Number(args[portArg + 1])   : (process.env.PORT ? Number(process.env.PORT) : 3000);
const DB_PATH = dbArg   >= 0 ? args[dbArg + 1]             : resolve(__dirname, 'data/jta.db');
const UPLOAD_DIR  = resolve(__dirname, 'data/uploads');
const SESSIONS_DIR = resolve(__dirname, 'data/sessions');
const UI_DIST     = resolve(__dirname, 'ui/dist');

// 确保目录存在
mkdirSync(UPLOAD_DIR,   { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

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
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
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

const wss = new WebSocketServer({ server, path: '/ws' });

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

        // 发送当前会话状态
        try {
            const session = db.get('SELECT status, plugin_status FROM sessions WHERE id = ?', sessionId);
            if (session) {
                ws.send(JSON.stringify({
                    type: 'init',
                    sessionId,
                    status: session.status,
                    pluginStatus: JSON.parse(session.plugin_status || '{}'),
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

    // 未知路由
    ws.send(JSON.stringify({ type: 'error', message: `Unknown WS path: ${pathname}` }));
    ws.close();
});

// ── 启动 ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`[JTA] Server listening on http://localhost:${PORT}`);
    console.log(`[JTA] API: http://localhost:${PORT}/api/health`);
    if (existsSync(UI_DIST)) {
        console.log(`[JTA] UI:  http://localhost:${PORT}/`);
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
