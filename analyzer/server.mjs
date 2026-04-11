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
import { resolve, dirname, join, extname, basename } from 'path';
import { mkdirSync, existsSync, createWriteStream, readdirSync, rmSync, statSync, renameSync, createReadStream, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { createLogger } from './logger.mjs';

const log = createLogger('server');

import {
    createFileHeader,
    EVENT_HEADER_SIZE,
} from '../src/encoding/EventSerializer.js';

import * as db from './db/Database.mjs';
import { autoDiscover } from './PluginEngine.mjs';
import { registerWsClient } from './InstrumentRunner.mjs';
import sessionsRouter from './routes/sessions.mjs';
import instrumentRouter from './routes/instrument.mjs';
import projectsRouter from './routes/projects.mjs';
import storageRouter from './routes/storage.mjs';
import compareRouter from './routes/compare.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portArg       = args.indexOf('--port');
const dbArg         = args.indexOf('--db');
const tracesDirArg  = args.indexOf('--traces-dir');
// --no-clear-traces 保留向后兼容（已无实际效果，默认不清空；--clear-traces 才清空）
const _noClearTraces = args.includes('--no-clear-traces'); // eslint-disable-line no-unused-vars

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

// 启动时清空旧 trace 文件（仅当显式传 --clear-traces 时才清空，默认保留）
const doClearTraces = args.includes('--clear-traces');
if (doClearTraces && existsSync(TRACES_DIR)) {
    const oldFiles = readdirSync(TRACES_DIR).filter(f => f.endsWith('.bin') || f.endsWith('.smap.json'));
    for (const f of oldFiles) rmSync(join(TRACES_DIR, f));
    if (oldFiles.length > 0) log.info({ count: oldFiles.length, dir: TRACES_DIR }, `Cleared ${oldFiles.length} old trace file(s)`);
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
log.info({ dbPath: DB_PATH }, 'Database initialized');

// 自动发现并注册插件
await autoDiscover();

// ── Express 应用 ─────────────────────────────────────────────────────────────

const app = express();

// CORS（开发模式允许所有来源）
app.use(cors());

// HTTP 请求日志（debug 级别，不刷屏，只记录方法、路径、状态、耗时）
app.use((req, res, next) => {
    const startMs = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - startMs;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
        log[level]({ method: req.method, path: req.path, status: res.statusCode, ms }, `${req.method} ${req.path} ${res.statusCode} (${ms}ms)`);
    });
    next();
});

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

// 文件上传中间件（projects 路由）
app.use('/api/projects', (req, res, next) => {
    if (req.method === 'POST') {
        const subPath = req.path;  // e.g. '/', '/:id/sessions'
        if (subPath === '/' || subPath === '') {
            // 创建工作空间：只上传源码
            upload.fields([{ name: 'source', maxCount: 1 }])(req, res, next);
        } else if (subPath.endsWith('/sessions')) {
            // 上传 trace bin
            upload.fields([{ name: 'bin', maxCount: 1 }])(req, res, next);
        } else {
            next();
        }
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
app.use('/api/projects',    projectsRouter);
app.use('/api/storage',     storageRouter);
app.use('/api/compare',     compareRouter);

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
});

// Trace 统计
app.get('/api/trace/stats', (req, res) => {
    const elapsed = ((Date.now() - traceStats.startTime) / 1000).toFixed(1);
    res.json({ ...traceStats, uptime: elapsed, tracesDir: TRACES_DIR });
});

// ── Trace 文件 API ──────────────────────────────────────────────────────────

// 工具：验证 trace 文件名（仅允许同目录的 .bin 文件）
function validateTraceFilename(name) {
    return name
        && typeof name === 'string'
        && !name.includes('/')
        && !name.includes('\\')
        && !name.includes('..')
        && name.endsWith('.bin');
}

// Trace 文件列表（支持搜索 ?q= 和分页 ?offset=&limit=）
app.get('/api/trace/files', (req, res) => {
    try {
        const { q = '', offset = '0', limit = '100' } = req.query;
        const offsetN = Math.max(0, Number(offset) || 0);
        const limitN  = Math.min(Math.max(1, Number(limit) || 100), 500);

        // 读取 trace_aliases：alias.json 记录 { filename: aliasName }
        const aliasPath = join(TRACES_DIR, '_aliases.json');
        let aliases = {};
        try {
            if (existsSync(aliasPath)) {
                aliases = JSON.parse(readFileSync(aliasPath, 'utf8'));
            }
        } catch { /* ignore */ }

        // 读取 trace_projectmap：project_map.json 记录 { filename: projectId }
        const pmapPath = join(TRACES_DIR, '_project_map.json');
        let projectMap = {};
        try {
            if (existsSync(pmapPath)) {
                projectMap = JSON.parse(readFileSync(pmapPath, 'utf8'));
            }
        } catch { /* ignore */ }

        let files = readdirSync(TRACES_DIR)
            .filter(f => f.endsWith('.bin'))
            .map(f => {
                const fp = join(TRACES_DIR, f);
                let st = null;
                try { st = statSync(fp); } catch { /* ignore */ }
                const alias = aliases[f] || null;
                const projectId = projectMap[f] || null;
                return {
                    name: f,
                    alias,
                    projectId,
                    size: st?.size ?? 0,
                    mtime: st?.mtimeMs ?? 0,
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        // 搜索过滤（按文件名或别名）
        if (q) {
            const lq = q.toLowerCase();
            files = files.filter(f =>
                f.name.toLowerCase().includes(lq) ||
                (f.alias && f.alias.toLowerCase().includes(lq))
            );
        }

        const total = files.length;
        const paged = files.slice(offsetN, offsetN + limitN);

        // 附加关联工作空间名称
        const projectIds = [...new Set(paged.filter(f => f.projectId).map(f => f.projectId))];
        const projectNames = {};
        for (const pid of projectIds) {
            try {
                const p = db.get('SELECT name FROM projects WHERE id = ?', pid);
                if (p) projectNames[pid] = p.name;
            } catch { /* ignore */ }
        }

        res.json({
            files: paged.map(f => ({
                ...f,
                projectName: f.projectId ? (projectNames[f.projectId] || null) : null,
            })),
            total,
            offset: offsetN,
            limit: limitN,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件重命名（设置别名，不改磁盘文件名）
app.put('/api/trace/files/:name', (req, res) => {
    try {
        const { name } = req.params;
        if (!validateTraceFilename(name)) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const binPath = join(TRACES_DIR, name);
        if (!existsSync(binPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const { alias } = req.body;
        if (typeof alias !== 'string') {
            return res.status(400).json({ error: 'alias must be a string' });
        }

        const aliasPath = join(TRACES_DIR, '_aliases.json');
        let aliases = {};
        try {
            if (existsSync(aliasPath)) {
                aliases = JSON.parse(readFileSync(aliasPath, 'utf8'));
            }
        } catch { /* ignore */ }

        if (alias.trim()) {
            aliases[name] = alias.trim();
        } else {
            delete aliases[name];
        }

        writeFileSync(aliasPath, JSON.stringify(aliases, null, 2));

        res.json({ ok: true, name, alias: alias.trim() || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件删除
app.delete('/api/trace/files/:name', (req, res) => {
    try {
        const { name } = req.params;
        if (!validateTraceFilename(name)) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const binPath = join(TRACES_DIR, name);
        if (!existsSync(binPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        rmSync(binPath);

        // 同时删除对应 smap 文件（如有）
        const smapPath = binPath.replace(/\.bin$/, '.smap.json');
        if (existsSync(smapPath)) {
            try { rmSync(smapPath); } catch { /* ignore */ }
        }

        // 清理 aliases / project_map
        const aliasPath   = join(TRACES_DIR, '_aliases.json');
        const pmapPath    = join(TRACES_DIR, '_project_map.json');
        for (const jPath of [aliasPath, pmapPath]) {
            try {
                if (existsSync(jPath)) {
                    const obj = JSON.parse(readFileSync(jPath, 'utf8'));
                    delete obj[name];
                    writeFileSync(jPath, JSON.stringify(obj, null, 2));
                }
            } catch { /* ignore */ }
        }

        res.json({ ok: true, deleted: name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件批量删除
app.post('/api/trace/files/batch-delete', (req, res) => {
    try {
        const { names } = req.body;
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'names must be a non-empty array' });
        }

        const deleted = [];
        const errors  = [];

        for (const name of names) {
            if (!validateTraceFilename(name)) { errors.push({ name, error: 'invalid' }); continue; }
            const binPath = join(TRACES_DIR, name);
            if (!existsSync(binPath)) { errors.push({ name, error: 'not found' }); continue; }
            try {
                rmSync(binPath);
                const smapPath = binPath.replace(/\.bin$/, '.smap.json');
                if (existsSync(smapPath)) { try { rmSync(smapPath); } catch { /* ignore */ } }
                deleted.push(name);
            } catch (e) {
                errors.push({ name, error: e.message });
            }
        }

        // 批量清理 aliases / project_map
        const aliasPath = join(TRACES_DIR, '_aliases.json');
        const pmapPath  = join(TRACES_DIR, '_project_map.json');
        for (const jPath of [aliasPath, pmapPath]) {
            try {
                if (existsSync(jPath)) {
                    const obj = JSON.parse(readFileSync(jPath, 'utf8'));
                    for (const n of deleted) delete obj[n];
                    writeFileSync(jPath, JSON.stringify(obj, null, 2));
                }
            } catch { /* ignore */ }
        }

        res.json({ deleted, errors });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件下载
app.get('/api/trace/files/:name/download', (req, res) => {
    try {
        const { name } = req.params;
        if (!validateTraceFilename(name)) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const binPath = join(TRACES_DIR, name);
        if (!existsSync(binPath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        createReadStream(binPath).pipe(res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件导入为会话（支持 projectId 关联工作空间 smap）
app.post('/api/trace/import', async (req, res) => {
    try {
        const { filename, name: sessionName, projectId } = req.body;
        if (!filename || typeof filename !== 'string' || filename.includes('/') || filename.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const binPath = join(TRACES_DIR, filename);
        if (!existsSync(binPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        let smapPath   = null;
        let sourcePath = null;

        if (projectId) {
            // 从工作空间获取 smap 路径和原始源码路径
            try {
                const project = db.get('SELECT smap_path, source_file, status FROM projects WHERE id = ?', projectId);
                if (project && project.status === 'ready') {
                    if (project.smap_path && existsSync(project.smap_path)) {
                        smapPath = project.smap_path;
                    }
                    if (project.source_file && existsSync(project.source_file)) {
                        sourcePath = project.source_file;
                    }
                }
            } catch { /* ignore */ }
        } else {
            // 查找同名 smap.json
            const autoSmap = binPath.replace(/\.bin$/, '.smap.json');
            if (existsSync(autoSmap)) smapPath = autoSmap;
        }

        const { createSession } = await import('./routes/sessions.mjs');
        const sid = await createSession({
            binPath,
            smapPath,
            sourcePath,
            projectId: projectId || null,
            name: sessionName || filename.replace(/\.bin$/, ''),
            wsProgressBroadcast: req.app.get('wsProgressBroadcast'),
        });
        res.json({ sessionId: sid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 全局错误处理：确保所有 /api/ 路由的错误（含 multer 错误）都返回 JSON
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    log.error({ err }, 'Unhandled route error');
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

    // ── 工作空间插桩进度订阅：/ws/projects/:id/progress ─────────────────────
    const projectProgressMatch = pathname.match(/^\/ws\/projects\/([^/]+)\/progress$/);
    if (projectProgressMatch) {
        const projectId = projectProgressMatch[1];
        if (!wsProgressClients.has(projectId)) {
            wsProgressClients.set(projectId, new Set());
        }
        wsProgressClients.get(projectId).add(ws);

        // 发送当前状态快照
        try {
            const project = db.get('SELECT status, iid_count, error_msg FROM projects WHERE id = ?', projectId);
            if (project) {
                ws.send(JSON.stringify({ type: 'init', projectId, ...project }));
            }
        } catch { /* ignore */ }

        ws.on('close', () => {
            const clients = wsProgressClients.get(projectId);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) wsProgressClients.delete(projectId);
            }
        });
        return;
    }

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
        // 支持 ?projectId=xxx 自动关联工作空间
        const wsProjectId = url.searchParams.get('projectId') || null;
        traceStats.connections++;

        const traceFilePath = makeTraceFilePath();
        const traceFileName = basename(traceFilePath);
        const outStream  = createWriteStream(traceFilePath, { flags: 'w' });
        let   eventCount = 0;
        let   headerWritten = false;

        outStream.on('error', (err) => {
            log.error({ err, traceFilePath }, 'Trace output stream error');
        });

        log.info({ clientAddr, traceFilePath, projectId: wsProjectId }, `Trace client connected: ${clientAddr}`);
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
                log.error({ err }, 'Trace message processing error');
            }
        });

        ws.on('close', () => {
            traceStats.connections = Math.max(0, traceStats.connections - 1);
            outStream.end(() => {
                log.info({ traceFilePath, eventCount }, `Trace saved: ${traceFilePath} (${eventCount} events)`);

                // 记录来源工作空间（若传入了 projectId）
                if (wsProjectId) {
                    const pmapPath = join(TRACES_DIR, '_project_map.json');
                    try {
                        let pmap = {};
                        if (existsSync(pmapPath)) {
                            try { pmap = JSON.parse(readFileSync(pmapPath, 'utf8')); } catch { /* ignore */ }
                        }
                        pmap[traceFileName] = wsProjectId;
                        writeFileSync(pmapPath, JSON.stringify(pmap, null, 2));
                    } catch { /* ignore */ }
                }
            });
        });

        ws.on('error', (err) => {
            traceStats.errors++;
            log.error({ err, clientAddr }, `Trace WS error from ${clientAddr}`);
        });

        return;
    }

    // 未知路由
    ws.send(JSON.stringify({ type: 'error', message: `Unknown WS path: ${pathname}` }));
    ws.close();
});

// ── 启动 ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    log.info({ port: PORT }, `Server listening on http://localhost:${PORT}`);
    log.info(`API:    http://localhost:${PORT}/api/health`);
    log.info({ tracesDir: TRACES_DIR }, `Trace:  ws://localhost:${PORT}/ws/trace  (output: ${TRACES_DIR})`);
    if (existsSync(UI_DIST)) {
        log.info(`UI:     http://localhost:${PORT}/`);
    } else {
        log.warn('UI not built — run: cd ui && npm run build');
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
