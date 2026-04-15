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
import { resolve, dirname, join, basename } from 'path';
import { mkdirSync, existsSync, readdirSync, rmSync, statSync, createReadStream, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { createLogger } from './logger.mjs';
import { cfg, configPaths } from './Config.mjs';
import { TraceCollector } from '../tools/trace-server/TraceCollector.mjs';

const log = createLogger('server');

// EventSerializer 已由 TraceCollector 内部 import，此处无需重复引入

import * as db from './db/Database.mjs';
import { autoDiscover, listPlugins } from './PluginEngine.mjs';
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

const PORT    = portArg >= 0 ? Number(args[portArg + 1])   : (process.env.PORT ? Number(process.env.PORT) : cfg('server.port'));
const DB_PATH = dbArg   >= 0 ? args[dbArg + 1]             : resolve(__dirname, 'data/jta.db');
const UPLOAD_DIR   = resolve(__dirname, 'data/uploads');
const SESSIONS_DIR = resolve(__dirname, 'data/sessions');
const TRACES_DIR   = tracesDirArg >= 0 ? resolve(args[tracesDirArg + 1]) : resolve(process.cwd(), 'traces');
const UI_DIST     = resolve(__dirname, 'ui/dist');

// 确保目录存在
mkdirSync(UPLOAD_DIR,   { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(TRACES_DIR,   { recursive: true });

// 压缩设置（来自 traceServer 配置）
const TRACE_COMPRESS = cfg('traceServer.compress') !== false;  // 默认 true
const GZIP_LEVEL     = Math.max(1, Math.min(9, Number(cfg('traceServer.gzipLevel') ?? 6)));
const SESSION_IDLE_MS = Number(cfg('traceServer.sessionIdleMs') ?? 30000);

// 启动时清空旧 trace 文件（仅当显式传 --clear-traces 时才清空，默认保留）
const doClearTraces = args.includes('--clear-traces');
if (doClearTraces && existsSync(TRACES_DIR)) {
    const oldFiles = readdirSync(TRACES_DIR).filter(f => f.endsWith('.bin') || f.endsWith('.bin.gz') || f.endsWith('.smap.json'));
    for (const f of oldFiles) rmSync(join(TRACES_DIR, f));
    if (oldFiles.length > 0) log.info({ count: oldFiles.length, dir: TRACES_DIR }, `Cleared ${oldFiles.length} old trace file(s)`);
}

// ── Trace 收集（TraceCollector 实例）────────────────────────────────────────

// 无 sid 时用递增序号（analyzer 风格，方便与其他日志对照）
let _traceConnSeq = 0;

/**
 * TraceCollector 实例：封装会话管理、消息处理、去重写入等核心逻辑。
 * analyzer 版本通过以下参数定制行为：
 *   - onInfo/onError/onDebug/onWarn → 使用 pino log
 *   - parseSid → 同时从 URL 取 sid 和 projectId
 *   - onSessionClosed → 写 _project_map.json
 *   - makeSuffix → 无 sid 时用递增序号
 */
const traceCollector = new TraceCollector({
    outDir:        TRACES_DIR,
    compress:      TRACE_COMPRESS,
    gzipLevel:     GZIP_LEVEL,
    sessionIdleMs: SESSION_IDLE_MS,
    urlBase:       `http://localhost:${PORT}`,

    onInfo:  (msg, data) => log.info(data ?? {}, msg),
    onError: (msg, data) => log.error(data ?? {}, msg),
    onDebug: (msg, data) => log.debug(data ?? {}, msg),
    onWarn:  (msg, data) => log.warn(data ?? {}, msg),

    // 同时解析 sid 和 projectId
    parseSid: (req) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        return {
            sid:  url.searchParams.get('sid') || null,
            meta: { projectId: url.searchParams.get('projectId') || null },
        };
    },

    // 无 sid 时用递增序号（与原逻辑保持一致）
    makeSuffix: () => String(++_traceConnSeq).padStart(3, '0'),

    // 关闭会话后写 _project_map.json（记录 trace 文件来源工作空间）
    onSessionClosed: (entry) => {
        const projectId = entry.meta?.projectId;
        if (!projectId) return;
        const traceFileName = basename(entry.traceFile);
        const pmapPath = join(TRACES_DIR, '_project_map.json');
        try {
            let pmap = {};
            if (existsSync(pmapPath)) {
                try { pmap = JSON.parse(readFileSync(pmapPath, 'utf8')); } catch { /* ignore */ }
            }
            pmap[traceFileName] = projectId;
            writeFileSync(pmapPath, JSON.stringify(pmap, null, 2));
        } catch { /* ignore */ }
    },
});

/** 统计对象（向后兼容 /api/trace/stats 路由） */
const traceStats = traceCollector.stats;

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
app.use(express.json({ limit: cfg('server.maxJsonBodySize') }));
app.use(express.urlencoded({ extended: true }));

// multer — 文件上传（临时存储到 UPLOAD_DIR）
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: cfg('server.maxFileSize') },
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

// 配置查询（前端用于读取 UI 相关的可配置项）
app.get('/api/config', (req, res) => {
    res.json({
        ui: cfg('ui'),
        api: cfg('api'),
        paths: configPaths(),
    });
});

// Trace 统计
app.get('/api/trace/stats', (req, res) => {
    const elapsed = ((Date.now() - traceCollector.stats.startTime) / 1000).toFixed(1);
    res.json({ ...traceCollector.stats, uptime: elapsed, tracesDir: TRACES_DIR });
});

// ── Trace 文件 API ──────────────────────────────────────────────────────────

// 工具：验证 trace 文件名（仅允许同目录的 .bin / .bin.gz 文件）
function validateTraceFilename(name) {
    return name
        && typeof name === 'string'
        && !name.includes('/')
        && !name.includes('\\')
        && !name.includes('..')
        && (name.endsWith('.bin') || name.endsWith('.bin.gz'));
}

// 获取可选择的分析插件列表（Phase 2/3/4，Phase 1 为必须项不可选）
app.get('/api/plugins', async (req, res) => {
    try {
        await autoDiscover();
        const { PHASE2_PLUGINS, PHASE3_PLUGINS, PHASE4_PLUGINS } = await import('./routes/sessions/core.mjs');
        const all = listPlugins();
        const byId = Object.fromEntries(all.map(p => [p.id, p]));

        // 构造带分组、描述、依赖信息的插件列表
        const makeGroup = (ids, phase) =>
            ids.map(id => ({
                id,
                phase,
                displayName: byId[id]?.displayName || id,
                description: byId[id]?.description || '',
                deps: byId[id]?.deps || [],
            }));

        res.json({
            phase2: makeGroup(PHASE2_PLUGINS, 'phase2'),
            phase3: makeGroup(PHASE3_PLUGINS, 'phase3'),
            phase4: makeGroup(PHASE4_PLUGINS, 'phase4'),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trace 文件列表（支持搜索 ?q= 和分页 ?offset=&limit=）
app.get('/api/trace/files', (req, res) => {
    try {
        const { q = '', offset = '0', limit = '0' } = req.query;
        const offsetN = Math.max(0, Number(offset) || 0);
        const _defaultPageSize = cfg('api.defaultPageSize');
        const _maxPageSize = cfg('api.maxPageSize');
        const limitN  = Math.min(Math.max(1, Number(limit) || _defaultPageSize), _maxPageSize);

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
            .filter(f => f.endsWith('.bin') || f.endsWith('.bin.gz'))
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

        // 同时删除对应 smap 文件（如有，兼容 .bin 和 .bin.gz）
        const smapPath = name.endsWith('.bin.gz')
            ? binPath.replace(/\.bin\.gz$/, '.smap.json')
            : binPath.replace(/\.bin$/, '.smap.json');
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
                const smapPath = name.endsWith('.bin.gz')
                    ? binPath.replace(/\.bin\.gz$/, '.smap.json')
                    : binPath.replace(/\.bin$/, '.smap.json');
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

// Trace 文件导入为会话（支持 projectId 关联工作空间 smap，selectedPlugins 自定义分析插件）
app.post('/api/trace/import', async (req, res) => {
    try {
        const { filename, name: sessionName, projectId, selectedPlugins } = req.body;
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
            // 查找同名 smap.json（兼容 .bin 和 .bin.gz）
            const autoSmap = filename.endsWith('.bin.gz')
                ? binPath.replace(/\.bin\.gz$/, '.smap.json')
                : binPath.replace(/\.bin$/, '.smap.json');
            if (existsSync(autoSmap)) smapPath = autoSmap;
        }

        const { createSession } = await import('./routes/sessions.mjs');
        const sid = await createSession({
            binPath,
            smapPath,
            sourcePath,
            projectId: projectId || null,
            name: sessionName || filename.replace(/\.bin\.gz$/, '').replace(/\.bin$/, ''),
            wsProgressBroadcast: req.app.get('wsProgressBroadcast'),
            selectedPlugins: Array.isArray(selectedPlugins) ? selectedPlugins : null,
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

// 为 /ws/trace 单独创建一个 WebSocketServer，启用 permessage-deflate
const wssTrace = new WebSocketServer({
    server,
    path: '/ws/trace',
    perMessageDeflate: {
        zlibDeflateOptions: { level: GZIP_LEVEL },
        // 保留上下文窗口（提升压缩率），服务端和客户端各自维护
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
    },
});

// 通用 WebSocket 服务器（进度 / 运行输出等）
const wss = new WebSocketServer({ server });

// ── /ws/trace 连接处理（委托给 TraceCollector）────────────────────────────
wssTrace.on('connection', (ws, req) => traceCollector.handleConnection(ws, req));

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
                        'SELECT plugin_id, phase, completed_at, duration_ms, is_stale FROM plugin_checkpoints WHERE session_id = ? ORDER BY completed_at ASC',
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

    // 未知路由（/ws/trace 已由 wssTrace 独立处理）
    ws.send(JSON.stringify({ type: 'error', message: `Unknown WS path: ${pathname}` }));
    ws.close();
});

// ── 启动 ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    log.info({ port: PORT }, `Server listening on http://localhost:${PORT}`);
    log.info(`API:    http://localhost:${PORT}/api/health`);
    log.info(
        { tracesDir: TRACES_DIR, compress: TRACE_COMPRESS, gzipLevel: GZIP_LEVEL },
        `Trace:  ws://localhost:${PORT}/ws/trace  (output: ${TRACES_DIR}, compress: ${TRACE_COMPRESS ? `gzip level=${GZIP_LEVEL}` : 'off'}, perMessageDeflate: on)`
    );
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
