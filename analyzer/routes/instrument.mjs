/**
 * routes/instrument.mjs — 插桩工作台 REST API
 *
 * POST /api/instrument            插桩源码，返回插桩后代码 + smap
 * POST /api/instrument/run        在服务端沙箱执行插桩后的代码
 * GET  /api/instrument/run/:runId 查询运行任务状态
 */

import { Router } from 'express';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { startRun, getRunStatus } from '../InstrumentRunner.mjs';

const router = Router();
const __dirname = resolve(new URL('.', import.meta.url).pathname);

// Jani 根目录
const JANI_ROOT = resolve(__dirname, '../../');
const JALANGI_BIN = resolve(JANI_ROOT, 'bin/jalangi.mjs');
const DATA_DIR = resolve(__dirname, '../data/sessions');

// ── POST /api/instrument ───────────────────────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const { code, filename = 'script.js', options = {} } = req.body;

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Missing required field: code' });
        }

        // 创建临时目录
        const workDir = resolve(tmpdir(), `jta-instrument-${uuidv4()}`);
        mkdirSync(workDir, { recursive: true });

        const sourceFile = resolve(workDir, filename);
        writeFileSync(sourceFile, code, 'utf8');

        // 构建 instrument 命令
        const args = [
            JALANGI_BIN,
            'instrument',
        ];

        // 通用选项
        if (options.target)        args.push('--target', options.target);
        if (options.sourceType)    args.push('--source-type', options.sourceType);
        if (options.sandboxVar)    args.push('--sandbox-var', options.sandboxVar);
        if (options.randomVar)     args.push('--random-var');
        if (options.debug)         args.push('--debug');

        // 输出选项
        if (options.inlineIid !== false) args.push('--inline-iid'); // 默认内联 iid（便于返回 smap）
        if (options.inlineSource)  args.push('--inline-source');
        if (options.noSourceMap)   args.push('--no-source-map');
        if (options.vlcqSourceMap) args.push('--vlcq-source-map');
        if (options.splitRuntime)  args.push('--split-runtime');
        if (options.dryRun)        args.push('--dry-run');

        // 浏览器专属选项（仅 target=browser 时生效）
        if (options.target === 'browser') {
            if (options.dbName)       args.push('--db-name', options.dbName);
            if (options.storeName)    args.push('--store-name', options.storeName);
            if (options.noIdb)        args.push('--no-idb');
            if (options.minify)       args.push('--minify');
            if (options.deferredLoad) args.push('--deferred-load');
        }

        args.push(sourceFile);

        // 执行插桩
        const result = await runProcess('node', args, { cwd: JANI_ROOT });

        if (result.exitCode !== 0) {
            return res.status(422).json({
                error: 'Instrumentation failed',
                stderr: result.stderr,
            });
        }

        // 读取插桩后的文件
        const baseName = filename.replace(/\.js$/, '');
        const instrumentedPath = resolve(workDir, `${baseName}_jalangi_.js`);
        const smapPath         = resolve(workDir, `${baseName}_jalangi_.smap.json`);
        const mapPath          = resolve(workDir, `${baseName}_jalangi_.js.map`);

        let instrumentedCode = '';
        let smapJson = null;
        let mapJson  = null;

        if (existsSync(instrumentedPath)) {
            instrumentedCode = readFileSync(instrumentedPath, 'utf8');
        }
        if (existsSync(smapPath)) {
            smapJson = JSON.parse(readFileSync(smapPath, 'utf8'));
        }
        if (existsSync(mapPath)) {
            mapJson = JSON.parse(readFileSync(mapPath, 'utf8'));
        }

        // 统计 iid 数量
        const iidCount = smapJson?.iids ? Object.keys(smapJson.iids).length : 0;

        // 清理临时目录
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }

        return res.json({
            instrumentedCode,
            smapJson,
            mapJson,
            iidCount,
        });

    } catch (e) {
        console.error('[POST /api/instrument] error:', e);
        return res.status(500).json({ error: e.message });
    }
});

// ── POST /api/instrument/run ───────────────────────────────────────────────

router.post('/run', async (req, res) => {
    try {
        const { code, filename = 'script.js', options = {}, env = 'node' } = req.body;

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Missing required field: code' });
        }

        const runId = startRun({
            code,
            filename,
            options: { ...options, executionTrace: true },
            env,
            dataDir: DATA_DIR,
        });

        return res.status(202).json({ runId });

    } catch (e) {
        console.error('[POST /api/instrument/run] error:', e);
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/instrument/run/:runId ─────────────────────────────────────────

router.get('/run/:runId', (req, res) => {
    try {
        const { runId } = req.params;
        const task = getRunStatus(runId);

        if (!task) {
            return res.status(404).json({ error: `Run task ${runId} not found` });
        }

        return res.json({
            runId:      task.id,
            status:     task.status,
            stdout:     task.stdout,
            stderr:     task.stderr,
            exitCode:   task.exit_code,
            sessionId:  task.session_id,
            durationMs: task.duration_ms,
            errorMsg:   task.error_msg,
            createdAt:  task.created_at,
        });

    } catch (e) {
        console.error('[GET /api/instrument/run/:runId] error:', e);
        return res.status(500).json({ error: e.message });
    }
});

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 执行子进程并返回结果
 */
function runProcess(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = spawn(cmd, args, {
            ...opts,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('close', (code) => {
            resolve({ exitCode: code ?? 0, stdout, stderr });
        });

        child.on('error', (err) => {
            resolve({ exitCode: 1, stdout, stderr: err.message });
        });
    });
}

export default router;
