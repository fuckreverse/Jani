/**
 * routes/projects.mjs — 工作空间（Project）REST API
 *
 * POST   /api/projects                    上传原始 JS，创建工作空间并触发插桩（支持预处理）
 * GET    /api/projects                    列出所有工作空间
 * GET    /api/projects/:id                工作空间详情
 * DELETE /api/projects/:id                删除工作空间
 * POST   /api/projects/:id/sessions       上传 trace.bin，基于此工作空间的 smap 创建分析会话
 * GET    /api/projects/:id/sessions       列出该工作空间的所有会话
 */

import { Router } from 'express';
import { createLogger } from '../logger.mjs';

const log = createLogger('projects');
import {
    existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync, statSync,
} from 'fs';
import { resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import * as db from '../db/Database.mjs';
import { schedule, autoDiscover } from '../PluginEngine.mjs';

const router = Router();
const __dirname = resolve(dirname(fileURLToPath(import.meta.url)));

const JANI_ROOT   = resolve(__dirname, '../../');
const JALANGI_BIN = resolve(JANI_ROOT, 'bin/jalangi.mjs');
const DATA_DIR    = resolve(__dirname, '../data/projects');
const SESSIONS_DIR = resolve(__dirname, '../data/sessions');

mkdirSync(DATA_DIR,    { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

// 分阶段插件定义（与 sessions.mjs 保持一致）
const PHASE1_PLUGINS = ['F1-EventIndex'];
const PHASE2_PLUGINS = ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'];

// ── POST /api/projects ──────────────────────────────────────────────────────
// 上传原始 JS 源码，创建工作空间，异步触发（预处理+）插桩

router.post('/', async (req, res) => {
    try {
        const file = req.files?.source?.[0];
        if (!file) {
            return res.status(400).json({ error: 'Missing required file: source' });
        }

        const projectId  = uuidv4();
        const projectDir = resolve(DATA_DIR, projectId);
        mkdirSync(projectDir, { recursive: true });

        // 保存原始文件
        const originalName = file.originalname || 'script.js';
        const sourceDest   = resolve(projectDir, originalName);
        copyFileSync(file.path, sourceDest);

        // 项目名称
        const projectName = req.body?.name || originalName.replace(/\.js$/, '');

        // 插桩选项（从 body 解析，支持 JSON 字符串或对象）
        let options = {};
        if (req.body?.options) {
            try {
                options = typeof req.body.options === 'string'
                    ? JSON.parse(req.body.options)
                    : req.body.options;
            } catch { /* 忽略解析失败 */ }
        }

        // 预处理选项
        let preprocess = null;
        if (req.body?.preprocess) {
            try {
                preprocess = typeof req.body.preprocess === 'string'
                    ? JSON.parse(req.body.preprocess)
                    : req.body.preprocess;
            } catch { /* 忽略解析失败 */ }
        }

        const now = Date.now();

        // 写入数据库（status=instrumenting）
        db.run(
            `INSERT INTO projects (id, name, created_at, source_file, status, instrument_options, updated_at)
             VALUES (?, ?, ?, ?, 'instrumenting', ?, ?)`,
            projectId, projectName, now, sourceDest,
            JSON.stringify({ options, preprocess }), now
        );

        const wsProgressBroadcast = req.app.get('wsProgressBroadcast');

        // 异步插桩（不阻塞响应）
        _runInstrumentation(projectId, projectDir, sourceDest, originalName, options, preprocess, wsProgressBroadcast)
            .catch(e => {
                log.error({ err: e }, '[projects] instrumentation error:');
                db.run(
                    "UPDATE projects SET status='failed', error_msg=?, updated_at=? WHERE id=?",
                    e.message, Date.now(), projectId
                );
                wsProgressBroadcast?.(projectId, { type: 'error', projectId, message: e.message });
            });

        return res.status(201).json({ projectId, status: 'instrumenting' });

    } catch (e) {
        log.error({ err: e }, '[POST /api/projects] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
    try {
        const rows = db.all(
            `SELECT id, name, created_at, updated_at, status, iid_count, error_msg
             FROM projects
             ORDER BY created_at DESC`
        );
        return res.json(rows);
    } catch (e) {
        log.error({ err: e }, '[GET /api/projects] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects/:id ────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const row = db.get('SELECT * FROM projects WHERE id = ?', id);
        if (!row) return res.status(404).json({ error: 'Project not found' });

        // 附带会话列表（轻量版）
        const sessions = db.all(
            `SELECT id, name, created_at, status, event_count
             FROM sessions WHERE project_id = ? ORDER BY created_at DESC`,
            id
        );

        // 附带文件大小（实时读取 stat，避免 DB 存储冗余字段）
        const fileSize = (p) => {
            try { return p && existsSync(p) ? statSync(p).size : null; } catch { return null; }
        };

        return res.json({
            ...row,
            sessions,
            instrumented_size:   fileSize(row.instrumented_path),
            smap_size:           fileSize(row.smap_path),
            preprocessed_size:   fileSize(row.preprocessed_path),
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/projects/:id] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── POST /api/projects/:id/fork ──────────────────────────────────────────────
// 复用原始源文件重新插桩，创建新工作空间（不需要重新上传文件）

router.post('/:id/fork', async (req, res) => {
    try {
        const { id } = req.params;
        const source = db.get('SELECT id, name, source_file FROM projects WHERE id = ?', id);
        if (!source) return res.status(404).json({ error: 'Project not found' });
        if (!source.source_file || !existsSync(source.source_file)) {
            return res.status(404).json({ error: 'Source file not found for this project' });
        }

        const projectId  = uuidv4();
        const projectDir = resolve(DATA_DIR, projectId);
        mkdirSync(projectDir, { recursive: true });

        // 复制原始源文件到新项目目录
        const originalName = basename(source.source_file);
        const sourceDest   = resolve(projectDir, originalName);
        copyFileSync(source.source_file, sourceDest);

        // 新工作空间名称
        const projectName = req.body?.name?.trim() || `${source.name}-fork`;

        // 插桩选项
        let options = {};
        if (req.body?.options) {
            try {
                options = typeof req.body.options === 'string'
                    ? JSON.parse(req.body.options)
                    : req.body.options;
            } catch { /* 忽略解析失败 */ }
        }

        // 预处理选项
        let preprocess = null;
        if (req.body?.preprocess) {
            try {
                preprocess = typeof req.body.preprocess === 'string'
                    ? JSON.parse(req.body.preprocess)
                    : req.body.preprocess;
            } catch { /* 忽略解析失败 */ }
        }

        const now = Date.now();

        db.run(
            `INSERT INTO projects (id, name, created_at, source_file, status, instrument_options, updated_at)
             VALUES (?, ?, ?, ?, 'instrumenting', ?, ?)`,
            projectId, projectName, now, sourceDest,
            JSON.stringify({ options, preprocess }), now
        );

        const wsProgressBroadcast = req.app.get('wsProgressBroadcast');

        _runInstrumentation(projectId, projectDir, sourceDest, originalName, options, preprocess, wsProgressBroadcast)
            .catch(e => {
                log.error({ err: e }, '[projects/fork] instrumentation error:');
                db.run(
                    "UPDATE projects SET status='failed', error_msg=?, updated_at=? WHERE id=?",
                    e.message, Date.now(), projectId
                );
                wsProgressBroadcast?.(projectId, { type: 'error', projectId, message: e.message });
            });

        return res.status(201).json({ projectId, status: 'instrumenting' });

    } catch (e) {
        log.error({ err: e }, '[POST /api/projects/:id/fork] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── DELETE /api/projects/:id ─────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const row = db.get('SELECT id FROM projects WHERE id = ?', id);
        if (!row) return res.status(404).json({ error: 'Project not found' });

        // 删除文件目录
        const projectDir = resolve(DATA_DIR, id);
        if (existsSync(projectDir)) {
            rmSync(projectDir, { recursive: true, force: true });
        }

        // 解除 sessions 关联（不删除会话本身）
        db.run('UPDATE sessions SET project_id = NULL WHERE project_id = ?', id);

        // 删除记录
        db.run('DELETE FROM projects WHERE id = ?', id);

        return res.json({ deleted: true });
    } catch (e) {
        log.error({ err: e }, '[DELETE /api/projects/:id] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── POST /api/projects/:id/sessions ─────────────────────────────────────────
// 上传 trace.bin，利用已有 smap 创建分析会话

router.post('/:id/sessions', async (req, res) => {
    try {
        const { id } = req.params;
        const project = db.get('SELECT * FROM projects WHERE id = ?', id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (project.status !== 'ready') {
            return res.status(400).json({
                error: `Project is not ready (status: ${project.status}). Wait for instrumentation to complete.`,
            });
        }

        const binFile = req.files?.bin?.[0];
        if (!binFile) {
            return res.status(400).json({ error: 'Missing required file: bin' });
        }

        const sessionId  = uuidv4();
        const sessionDir = resolve(SESSIONS_DIR, sessionId);
        mkdirSync(sessionDir, { recursive: true });

        // 复制 bin 文件
        const binDest = resolve(sessionDir, binFile.originalname || 'trace.bin');
        copyFileSync(binFile.path, binDest);

        // 复制项目的 smap
        let smapDest = null;
        if (project.smap_path && existsSync(project.smap_path)) {
            smapDest = resolve(sessionDir, basename(project.smap_path));
            copyFileSync(project.smap_path, smapDest);
        }

        // 复制预处理后源码（优先）或原始源码（用于源码定位）
        let sourceDest = null;
        const preferredSource = project.preprocessed_path || project.source_file;
        if (preferredSource && existsSync(preferredSource)) {
            sourceDest = resolve(sessionDir, basename(preferredSource));
            copyFileSync(preferredSource, sourceDest);
        }

        const sessionName = req.body?.name
            || `${project.name}/${binFile.originalname?.replace(/\.bin$/, '') || 'trace'}`;

        const now = Date.now();

        db.run(
            `INSERT INTO sessions (id, name, created_at, source_file, bin_path, smap_path, status, plugin_status, project_id)
             VALUES (?, ?, ?, ?, ?, ?, 'parsing', '{}', ?)`,
            sessionId, sessionName, now, sourceDest, binDest, smapDest, id
        );

        const wsProgressBroadcast = req.app.get('wsProgressBroadcast');

        // Phase 1 分析
        const phase1Plugins = [...PHASE1_PLUGINS];
        if (smapDest) phase1Plugins.push('F2-SmapLoader');

        autoDiscover().then(() =>
            schedule(sessionId, {
                plugins: phase1Plugins,
                dataDir: sessionDir,
                phase: 'phase1',
                skipCompleted: true,
                onProgress: (evt) => {
                    wsProgressBroadcast?.(sessionId, evt);
                    if (evt.type === 'all_done' && evt.phase === 'phase1') {
                        _schedulePhase2(sessionId, sessionDir, wsProgressBroadcast, !!smapDest);
                    }
                },
            })
        ).catch(e => {
            log.error({ err: e }, '[projects/sessions] phase1 error:');
            db.run("UPDATE sessions SET status='failed' WHERE id=?", sessionId);
            wsProgressBroadcast?.(sessionId, { type: 'error', sessionId, message: e.message });
        });

        return res.status(201).json({
            sessionId,
            status: 'parsing',
            projectId: id,
            smapAvailable: !!smapDest,
        });

    } catch (e) {
        log.error({ err: e }, '[POST /api/projects/:id/sessions] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects/:id/sessions ──────────────────────────────────────────

router.get('/:id/sessions', (req, res) => {
    try {
        const { id } = req.params;
        const project = db.get('SELECT id FROM projects WHERE id = ?', id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const sessions = db.all(
            `SELECT id, name, created_at, status, event_count, plugin_status
             FROM sessions WHERE project_id = ? ORDER BY created_at DESC`,
            id
        );

        return res.json(sessions.map(s => ({
            ...s,
            plugin_status: safeParseJson(s.plugin_status, {}),
        })));
    } catch (e) {
        log.error({ err: e }, '[GET /api/projects/:id/sessions] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects/:id/instrumented ──────────────────────────────────────
// 下载插桩后代码

router.get('/:id/instrumented', (req, res) => {
    try {
        const { id } = req.params;
        const project = db.get('SELECT * FROM projects WHERE id = ?', id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.instrumented_path || !existsSync(project.instrumented_path)) {
            return res.status(404).json({ error: 'Instrumented file not found' });
        }

        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename(project.instrumented_path)}"`);
        res.send(readFileSync(project.instrumented_path, 'utf8'));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects/:id/preprocessed ──────────────────────────────────────
// 下载预处理后代码（若存在）

router.get('/:id/preprocessed', (req, res) => {
    try {
        const { id } = req.params;
        const project = db.get('SELECT * FROM projects WHERE id = ?', id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.preprocessed_path || !existsSync(project.preprocessed_path)) {
            return res.status(404).json({ error: 'Preprocessed file not found (preprocessing may not be enabled)' });
        }

        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename(project.preprocessed_path)}"`);
        res.send(readFileSync(project.preprocessed_path, 'utf8'));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects/:id/smap ───────────────────────────────────────────────
// 下载 smap.json

router.get('/:id/smap', (req, res) => {
    try {
        const { id } = req.params;
        const project = db.get('SELECT * FROM projects WHERE id = ?', id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.smap_path || !existsSync(project.smap_path)) {
            return res.status(404).json({ error: 'Smap file not found' });
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename(project.smap_path)}"`);
        res.send(readFileSync(project.smap_path, 'utf8'));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/projects/:id/progress ──────────────────────────────────────────
// 查询插桩进度（轮询备选；前端也可通过 WS /ws/projects/:id/progress 订阅）

router.get('/:id/progress', (req, res) => {
    try {
        const { id } = req.params;
        const row = db.get(
            'SELECT id, status, iid_count, error_msg, updated_at FROM projects WHERE id = ?', id
        );
        if (!row) return res.status(404).json({ error: 'Project not found' });
        return res.json(row);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ── 内部：执行（预处理+）插桩 ───────────────────────────────────────────────

async function _runInstrumentation(projectId, projectDir, sourcePath, originalName, options, preprocess, wsProgressBroadcast) {
    wsProgressBroadcast?.(projectId, { type: 'instrument_start', projectId });

    const workDir = resolve(tmpdir(), `jta-proj-${projectId}`);
    mkdirSync(workDir, { recursive: true });

    const baseName         = originalName.replace(/\.js$/, '');
    const instrumentedPath = resolve(workDir, `${baseName}_jalangi_.js`);
    const smapPath         = resolve(workDir, `${baseName}_jalangi_.map.json`);

    // ── 步骤 1：预处理（可选）────────────────────────────────────────────────
    let sourceToInstrument = sourcePath;
    let preprocessedDest   = null;

    if (preprocess && preprocess.enabled) {
        wsProgressBroadcast?.(projectId, { type: 'preprocess_start', projectId });
        try {
            const originalCode = readFileSync(sourcePath, 'utf8');
            const { preprocessCode } = await import(`${JANI_ROOT}/src/preprocess/index.js`);

            const {
                preset,
                deobfuscate    = {},
                normalizeArrow = {},
                sourceType     = 'script',
            } = preprocess;

            // 将 esXXXX 年份标识映射为 browserslist targets
            const ES_YEAR_TARGETS = {
                es2015: 'chrome 49',
                es2017: 'chrome 58',
                es2020: 'chrome 80',
                es2022: 'chrome 103',
            };
            const rawTargets     = preprocess.transpile?.targets ?? 'es2015';
            const resolvedTargets = ES_YEAR_TARGETS[rawTargets] ?? rawTargets;
            const transpile      = { ...preprocess.transpile, targets: resolvedTargets };

            const result = await preprocessCode(originalCode, {
                preset,
                deobfuscate,
                transpile,
                normalizeArrow,
                sourceType,
            });

            // 将预处理后的代码写入工作目录
            const preprocessedWorkPath = resolve(workDir, `${baseName}_preprocessed_.js`);
            writeFileSync(preprocessedWorkPath, result.code, 'utf8');
            sourceToInstrument = preprocessedWorkPath;

            // 同时复制到项目目录（稳定路径）
            preprocessedDest = resolve(projectDir, `${baseName}_preprocessed_.js`);
            writeFileSync(preprocessedDest, result.code, 'utf8');

            log.info(
                { projectId, warnings: result.warnings?.length ?? 0 },
                `[projects] preprocess done, warnings: ${result.warnings?.length ?? 0}`
            );
            wsProgressBroadcast?.(projectId, { type: 'preprocess_done', projectId });
        } catch (e) {
            log.error({ err: e }, '[projects] preprocess error:');
            // 清理临时目录
            try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
            throw new Error(`预处理失败: ${e.message}`);
        }
    }

    // ── 步骤 2：插桩 ─────────────────────────────────────────────────────────
    const args = [
        JALANGI_BIN,
        'instrument',
        '--output', instrumentedPath,
    ];

    if (options.target)        args.push('--target', options.target);
    if (options.sourceType)    args.push('--source-type', options.sourceType);
    if (options.sandboxVar)    args.push('--sandbox-var', options.sandboxVar);
    if (options.randomVar)     args.push('--random-var');
    if (options.inlineIid !== false) args.push('--inline-iid');
    if (options.inlineSource)  args.push('--inline-source');
    if (options.noSourceMap)   args.push('--no-source-map');
    if (options.vlcqSourceMap) args.push('--vlcq-source-map');

    // 浏览器专属
    if (options.target === 'browser') {
        if (options.dbName)       args.push('--db-name', options.dbName);
        if (options.storeName)    args.push('--store-name', options.storeName);
        if (options.noIdb)        args.push('--no-idb');
        if (options.wsUrl) {
            // 将 projectId 注入 WS URL，运行时自动携带，使 trace 能与工作空间关联
            let wsUrlWithProject = options.wsUrl;
            try {
                const u = new URL(options.wsUrl);
                u.searchParams.set('projectId', projectId);
                wsUrlWithProject = u.toString();
            } catch { /* URL 解析失败则原样使用 */ }
            args.push('--ws-url', wsUrlWithProject);
        }
        if (options.wsSab)        args.push('--ws-sab');
        if (options.minify)       args.push('--minify');
        if (options.deferredLoad) args.push('--deferred-load');
    }

    args.push(sourceToInstrument);

    const result = await _spawnProcess('node', args, { cwd: JANI_ROOT });

    if (result.exitCode !== 0) {
        // 清理临时目录
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(result.stderr || `Instrumentation exited with code ${result.exitCode}`);
    }

    // 把产物复制到项目目录（稳定路径）
    const destInstrumented = resolve(projectDir, `${baseName}_jalangi_.js`);
    const destSmap         = resolve(projectDir, `${baseName}_jalangi_.map.json`);

    let iidCount = 0;
    if (existsSync(instrumentedPath)) {
        copyFileSync(instrumentedPath, destInstrumented);
    }
    if (existsSync(smapPath)) {
        copyFileSync(smapPath, destSmap);
        try {
            const smap = JSON.parse(readFileSync(smapPath, 'utf8'));
            iidCount = smap?.iids ? Object.keys(smap.iids).length : 0;
        } catch { /* ignore */ }
    }

    // 清理临时目录
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // 更新数据库
    const now = Date.now();
    db.run(
        `UPDATE projects
         SET status='ready', instrumented_path=?, preprocessed_path=?, smap_path=?, iid_count=?, updated_at=?
         WHERE id=?`,
        existsSync(destInstrumented) ? destInstrumented : null,
        preprocessedDest ?? null,
        existsSync(destSmap)         ? destSmap         : null,
        iidCount, now, projectId
    );

    wsProgressBroadcast?.(projectId, {
        type: 'instrument_done',
        projectId,
        iidCount,
        smapAvailable:          existsSync(destSmap),
        preprocessingApplied:   !!preprocessedDest,
    });
}

// ── 内部：后台调度 Phase 2 ──────────────────────────────────────────────────

async function _schedulePhase2(sessionId, sessionDir, wsProgressBroadcast, _hasSmap) {
    try {
        db.run("UPDATE sessions SET status='indexing' WHERE id=?", sessionId);
        wsProgressBroadcast?.(sessionId, {
            type: 'phase_start',
            sessionId,
            phase: 'phase2',
            plugins: PHASE2_PLUGINS,
        });

        await autoDiscover();
        await schedule(sessionId, {
            plugins: PHASE2_PLUGINS,
            dataDir: sessionDir,
            phase: 'phase2',
            skipCompleted: true,
            onProgress: (evt) => {
                wsProgressBroadcast?.(sessionId, evt);
            },
        });
    } catch (e) {
        log.error({ err: e }, '[projects] phase2 schedule error:');
        wsProgressBroadcast?.(sessionId, { type: 'error', sessionId, phase: 'phase2', message: e.message });
    }
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function _spawnProcess(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => { resolve({ exitCode: code ?? 0, stdout, stderr }); });
        child.on('error', err => { resolve({ exitCode: 1, stdout, stderr: err.message }); });
    });
}

function safeParseJson(str, fallback = null) {
    if (str === null || str === undefined) return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch { return fallback ?? str; }
}

export default router;
