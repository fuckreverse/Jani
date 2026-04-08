/**
 * routes/instrument.mjs — 插桩工作台 REST API
 *
 * POST /api/instrument            插桩源码，返回插桩后代码 + smap（支持预处理）
 * POST /api/instrument/run        在服务端沙箱执行插桩后的代码（支持预处理）
 * GET  /api/instrument/run/:runId 查询运行任务状态
 */

import { Router } from 'express';
import { createLogger } from '../logger.mjs';

const log = createLogger('instrument');
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
        const { code, filename = 'script.js', options = {}, preprocess = null } = req.body;

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Missing required field: code' });
        }

        // ── 预处理（可选）──────────────────────────────────────────────────
        let codeToInstrument = code;
        let preprocessedCode = null;
        let preprocessStats  = null;
        let preprocessWarnings = [];

        if (preprocess && preprocess.enabled) {
            try {
                const result = await _runPreprocess(code, preprocess);
                preprocessedCode = result.code;
                preprocessStats  = result.stats;
                preprocessWarnings = result.warnings || [];
                codeToInstrument = preprocessedCode;
            } catch (e) {
                return res.status(422).json({ error: `预处理失败: ${e.message}` });
            }
        }

        // 创建临时目录
        const workDir = resolve(tmpdir(), `jta-instrument-${uuidv4()}`);
        mkdirSync(workDir, { recursive: true });

        const sourceFile = resolve(workDir, filename);
        writeFileSync(sourceFile, codeToInstrument, 'utf8');

        // 确定输出文件路径（始终显式指定，避免 browser target 默认 in-place 覆盖原文件）
        const baseName = filename.replace(/\.js$/, '');
        const instrumentedPath = resolve(workDir, `${baseName}_jalangi_.js`);
        const smapPath         = resolve(workDir, `${baseName}_jalangi_.map.json`);
        const mapPath          = resolve(workDir, `${baseName}_jalangi_.js.map`);

        // 构建 instrument 命令
        const args = [
            JALANGI_BIN,
            'instrument',
            '--output', instrumentedPath,  // 显式指定输出路径
        ];

        // 通用选项
        if (options.target)        args.push('--target', options.target);
        if (options.sourceType)    args.push('--source-type', options.sourceType);
        if (options.sandboxVar)    args.push('--sandbox-var', options.sandboxVar);
        if (options.randomVar)     args.push('--random-var');
        if (options.debug)         args.push('--debug');

        // 输出选项
        if (options.inlineIid) args.push('--inline-iid');
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
            if (options.wsUrl)        args.push('--ws-url', options.wsUrl);
            if (options.wsSab)        args.push('--ws-sab');
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
            // 预处理信息（仅在启用时返回）
            preprocessedCode,
            preprocessStats,
            preprocessWarnings,
        });

    } catch (e) {
        log.error({ err: e }, '[POST /api/instrument] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── POST /api/instrument/run ───────────────────────────────────────────────

router.post('/run', async (req, res) => {
    try {
        const { code, filename = 'script.js', options = {}, env = 'node', preprocess = null } = req.body;

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Missing required field: code' });
        }

        // ── 预处理（可选）──────────────────────────────────────────────────
        let codeToRun = code;
        let preprocessedCode = null;

        if (preprocess && preprocess.enabled) {
            try {
                const result = await _runPreprocess(code, preprocess);
                preprocessedCode = result.code;
                codeToRun = preprocessedCode;
            } catch (e) {
                return res.status(422).json({ error: `预处理失败: ${e.message}` });
            }
        }

        const runId = startRun({
            code:     codeToRun,
            filename,
            options:  { ...options, executionTrace: true },
            env,
            dataDir:  DATA_DIR,
            preprocessedCode,   // 传入 runner，用于记录
        });

        return res.status(202).json({ runId });

    } catch (e) {
        log.error({ err: e }, '[POST /api/instrument/run] error:');
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
        log.error({ err: e }, '[GET /api/instrument/run/:runId] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── 内部：执行预处理 ──────────────────────────────────────────────────────────

/**
 * 调用 Jani 预处理模块对代码做 AST 级变换。
 * @param {string} code          原始 JS 代码
 * @param {object} preprocessOpts 预处理选项（来自前端）
 * @returns {{ code, stats, warnings }}
 */
/**
 * 将前端 esXXXX 年份标识映射到 @babel/preset-env 支持的 browserslist targets。
 * 对应关系依据各 ECMAScript 版本特性在 Chrome 中的落地版本：
 *   es2015 → Chrome 49（第一个完整支持 ES6 的版本）
 *   es2017 → Chrome 58（原生 async/await，无需 generator 降级）
 *   es2020 → Chrome 80（可选链、空值合并）
 *   es2022 → Chrome 103（类私有字段完整支持）
 */
const ES_YEAR_TARGETS = {
    es2015: 'chrome 49',
    es2017: 'chrome 58',
    es2020: 'chrome 80',
    es2022: 'chrome 103',
};

async function _runPreprocess(code, preprocessOpts) {
    // 动态导入（避免循环依赖，同时保持 top-level 路径隔离）
    const { preprocessCode } = await import(`${JANI_ROOT}/src/preprocess/index.js`);

    const {
        preset,
        deobfuscate = {},
        normalizeArrow = {},
        sourceType  = 'script',
    } = preprocessOpts;

    // 将 esXXXX 年份标识映射为 browserslist targets（若未命中则原样传入）
    const rawTargets = preprocessOpts.transpile?.targets ?? 'es2015';
    const resolvedTargets = ES_YEAR_TARGETS[rawTargets] ?? rawTargets;
    const transpile = { ...preprocessOpts.transpile, targets: resolvedTargets };

    return preprocessCode(code, {
        preset,
        deobfuscate,
        transpile,
        normalizeArrow,
        sourceType,
    });
}

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
