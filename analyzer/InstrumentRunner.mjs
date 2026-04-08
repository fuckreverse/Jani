/**
 * InstrumentRunner.mjs — 服务端插桩代码运行器
 *
 * 功能：
 * - 子进程运行插桩代码（30s 超时）
 * - 最多 3 个并发运行
 * - stdout/stderr 截断到 1MB
 * - WebSocket 实时推流输出
 * - 运行完成后自动创建 Session
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import * as db from './db/Database.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('InstrumentRunner');

const __dirname = dirname(fileURLToPath(import.meta.url));

// Jani 根目录
const JANI_ROOT = resolve(__dirname, '../');
const JALANGI_BIN = resolve(JANI_ROOT, 'bin/jalangi.mjs');

/** 最大并发运行数 */
const MAX_CONCURRENCY = 3;

/** 单次运行超时（毫秒） */
const TIMEOUT_MS = 30_000;

/** stdout/stderr 最大字节数（1MB） */
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

/** 当前运行中的任务数 */
let activeCount = 0;

/** 等待队列 */
const waitQueue = [];

/** WebSocket 客户端注册表：runId → Set<WebSocket> */
const wsClients = new Map();

/**
 * 注册 WebSocket 客户端订阅运行输出
 * @param {string} runId
 * @param {WebSocket} ws
 */
export function registerWsClient(runId, ws) {
    if (!wsClients.has(runId)) {
        wsClients.set(runId, new Set());
    }
    wsClients.get(runId).add(ws);

    ws.on('close', () => {
        const clients = wsClients.get(runId);
        if (clients) {
            clients.delete(ws);
            if (clients.size === 0) wsClients.delete(runId);
        }
    });
}

/**
 * 向订阅了 runId 的所有 WebSocket 客户端推送消息
 * @param {string} runId
 * @param {object} msg
 */
function broadcast(runId, msg) {
    const clients = wsClients.get(runId);
    if (!clients || clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const ws of clients) {
        try {
            if (ws.readyState === 1 /* OPEN */) {
                ws.send(data);
            }
        } catch { /* ignore */ }
    }
}

/**
 * 获取并发令牌（超过 MAX_CONCURRENCY 时排队等待）
 */
function acquireSlot() {
    if (activeCount < MAX_CONCURRENCY) {
        activeCount++;
        return Promise.resolve();
    }
    return new Promise(resolve => waitQueue.push(resolve));
}

/**
 * 释放并发令牌
 */
function releaseSlot() {
    if (waitQueue.length > 0) {
        const next = waitQueue.shift();
        next();
    } else {
        activeCount--;
    }
}

/**
 * 创建并启动插桩运行任务
 *
 * @param {object} params
 * @param {string} params.code       - 原始 JS 源码
 * @param {string} params.filename   - 文件名（用于 source map）
 * @param {object} params.options    - 插桩选项
 * @param {string} [params.env]      - 执行环境（'node' / 'jsdom'）
 * @param {string} [params.dataDir]  - 会话数据根目录
 * @returns {string} runId
 */
export function startRun(params) {
    const {
        code,
        filename = 'script.js',
        options = {},
        env = 'node',
        dataDir = resolve(__dirname, 'data/sessions'),
    } = params;

    const runId = uuidv4();
    const now = Date.now();

    // 记录到数据库
    db.run(
        `INSERT INTO run_tasks (id, created_at, status, code, filename, env)
         VALUES (?, ?, 'running', ?, ?, ?)`,
        runId, now, code, filename, env
    );

    // 异步执行（不阻塞返回）
    executeRun(runId, { code, filename, options, env, dataDir }).catch(e => {
        log.error({ err: e, runId }, `Run ${runId} 执行异常`);
    });

    return runId;
}

/**
 * 内部执行函数
 */
async function executeRun(runId, { code, filename, options, env, dataDir }) {
    // 等待并发槽位
    await acquireSlot();

    const startTime = Date.now();
    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // 创建临时工作目录
    const workDir = resolve(tmpdir(), `jta-run-${runId}`);
    mkdirSync(workDir, { recursive: true });

    const sourceFile = resolve(workDir, filename);
    const traceFile  = resolve(workDir, 'trace.bin');

    try {
        // 写入源码文件
        writeFileSync(sourceFile, code, 'utf8');

        // 构建 jalangi.mjs 命令
        const args = [
            JALANGI_BIN,
            'instrument-and-run',
            '--execution-trace',
            '--trace-file', traceFile,
        ];

        // 通用选项
        if (options.target)       args.push('--target', options.target);
        if (options.sourceType)   args.push('--source-type', options.sourceType);
        if (options.sandboxVar)   args.push('--sandbox-var', options.sandboxVar);
        if (options.randomVar)    args.push('--random-var');
        if (options.debug)        args.push('--debug');

        // instrument-and-run 支持的插桩选项
        if (options.inlineIid)    args.push('--inline-iid');
        if (options.inlineSource) args.push('--inline-source');
        if (options.noWrite)      args.push('--no-write');

        // 分析插件（可多个）
        if (Array.isArray(options.analyses)) {
            for (const a of options.analyses) {
                if (a && a.trim()) args.push('--analysis', a.trim());
            }
        }

        // 初始参数（可多个，格式 key:value）
        if (Array.isArray(options.initParams)) {
            for (const kv of options.initParams) {
                if (kv && kv.trim()) args.push('--init-param', kv.trim());
            }
        }

        args.push(sourceFile);

        log.info({ runId, filename, env }, `启动子进程: ${filename}`);
        log.debug({ runId, cmd: `node ${args.join(' ')}` }, 'Spawn command');
        broadcast(runId, { type: 'stdout', data: `$ node ${args.join(' ')}\n` });

        // 启动子进程
        const child = spawn('node', args, {
            cwd: JANI_ROOT,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // 超时定时器
        const timeoutTimer = setTimeout(() => {
            child.kill('SIGKILL');
        }, TIMEOUT_MS);

        // 处理 stdout
        child.stdout.on('data', (chunk) => {
            const str = chunk.toString('utf8');
            broadcast(runId, { type: 'stdout', data: str });
            stdoutBytes += Buffer.byteLength(str);
            if (stdoutBytes <= MAX_OUTPUT_BYTES) {
                stdoutBuf += str;
            } else if (!stdoutTruncated) {
                stdoutTruncated = true;
                stdoutBuf += '\n[... stdout truncated at 1MB ...]';
            }
        });

        // 处理 stderr
        child.stderr.on('data', (chunk) => {
            const str = chunk.toString('utf8');
            broadcast(runId, { type: 'stderr', data: str });
            stderrBytes += Buffer.byteLength(str);
            if (stderrBytes <= MAX_OUTPUT_BYTES) {
                stderrBuf += str;
            } else if (!stderrTruncated) {
                stderrTruncated = true;
                stderrBuf += '\n[... stderr truncated at 1MB ...]';
            }
        });

        // 等待进程结束
        const exitCode = await new Promise((resolve) => {
            child.on('close', (code, signal) => {
                clearTimeout(timeoutTimer);
                if (signal === 'SIGKILL') {
                    resolve(null); // null 表示被 kill
                } else {
                    resolve(code ?? 0);
                }
            });
        });

        const duration = Date.now() - startTime;

        // 检查超时
        if (exitCode === null) {
            log.warn({ runId, filename, timeoutMs: TIMEOUT_MS }, `Run ${runId} 超时 (${TIMEOUT_MS / 1000}s)`);
            db.run(
                `UPDATE run_tasks SET status = 'timeout', stdout = ?, stderr = ?, duration_ms = ?, error_msg = ? WHERE id = ?`,
                stdoutBuf, stderrBuf, duration,
                'execution timed out after 30s',
                runId
            );
            broadcast(runId, { type: 'error', message: 'execution timed out after 30s' });
            return;
        }

        // 检查是否生成了 trace 文件
        const smapFile  = traceFile.replace('.bin', '.smap.json');
        const hasTrace  = existsSync(traceFile);
        const hasSmap   = existsSync(smapFile);

        let sessionId = null;

        if (exitCode === 0 && hasTrace) {
            // 自动创建 Session
            sessionId = await createSessionFromRun({
                runId, workDir, sourceFile, traceFile,
                smapFile: hasSmap ? smapFile : null,
                filename, dataDir,
            });
        }

        // 更新 run_tasks
        db.run(
            `UPDATE run_tasks
             SET status = ?, stdout = ?, stderr = ?, exit_code = ?, duration_ms = ?, session_id = ?
             WHERE id = ?`,
            exitCode === 0 ? 'done' : 'failed',
            stdoutBuf, stderrBuf, exitCode, duration, sessionId,
            runId
        );

        if (exitCode === 0) {
            log.info({ runId, filename, durationMs: duration, sessionId }, `Run ${runId} 成功 (${duration}ms)`);
        } else {
            log.warn({ runId, filename, exitCode, durationMs: duration }, `Run ${runId} 失败 (exit=${exitCode})`);
            // stderr 有内容时输出，便于排查
            if (stderrBuf.trim()) {
                log.warn({ runId }, `Stderr:\n${stderrBuf.slice(0, 2000)}`);
            }
        }

        broadcast(runId, {
            type: 'done',
            exitCode,
            sessionId,
            durationMs: duration,
        });

    } catch (e) {
        const duration = Date.now() - startTime;
        log.error({ err: e, runId, filename }, `Run ${runId} 内部异常`);
        db.run(
            `UPDATE run_tasks SET status = 'failed', error_msg = ?, duration_ms = ? WHERE id = ?`,
            e.message, duration, runId
        );
        broadcast(runId, { type: 'error', message: e.message });
    } finally {
        releaseSlot();
        // 清理临时文件（不删除 trace 文件，它已被复制到 data/sessions）
        try {
            rmSync(workDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    }
}

/**
 * 从运行结果自动创建 Session 并触发插件
 */
async function createSessionFromRun({ runId, workDir, sourceFile, traceFile, smapFile, filename, dataDir }) {
    const sessionId = uuidv4();
    const sessionDir = resolve(dataDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    // 复制文件到 session 目录
    const { copyFileSync } = await import('fs');

    const binDest  = resolve(sessionDir, 'trace.bin');
    copyFileSync(traceFile, binDest);

    let smapDest = null;
    if (smapFile) {
        smapDest = resolve(sessionDir, 'trace.smap.json');
        copyFileSync(smapFile, smapDest);
    }

    let sourceDest = null;
    if (existsSync(sourceFile)) {
        sourceDest = resolve(sessionDir, filename);
        copyFileSync(sourceFile, sourceDest);
    }

    // 创建 session 记录
    const now = Date.now();
    db.run(
        `INSERT INTO sessions (id, name, created_at, source_file, bin_path, smap_path, status, plugin_status)
         VALUES (?, ?, ?, ?, ?, ?, 'processing', '{}')`,
        sessionId,
        `run-${runId.slice(0, 8)}`,
        now,
        sourceDest ?? null,
        binDest,
        smapDest,
    );

    // 异步触发插件（不等待）
    const { schedule, autoDiscover } = await import('./PluginEngine.mjs');
    autoDiscover().then(() =>
        schedule(sessionId, {
            plugins: ['F1-EventIndex', 'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer', smapDest ? 'F2-SmapLoader' : null].filter(Boolean),
            dataDir: sessionDir,
        })
    ).catch(e => log.error({ err: e, sessionId }, 'Plugin schedule error'));

    return sessionId;
}

/**
 * 查询运行任务状态
 * @param {string} runId
 * @returns {object|null}
 */
export function getRunStatus(runId) {
    return db.get('SELECT * FROM run_tasks WHERE id = ?', runId);
}
