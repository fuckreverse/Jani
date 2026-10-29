/**
 * PluginEngine.mjs — 插件调度器
 * Worker-backed DAG scheduling, atomic result publication and validated checkpoints.
 * Analysis jobs serialize writes; WAL readers retain the last committed snapshot.
 */

import { resolve, dirname } from 'path';
import { readdirSync, createReadStream, readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { cfg } from './Config.mjs';
import { isMainThread } from 'worker_threads';
import { enqueueAnalysis } from './AnalysisQueue.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import * as db from './db/Database.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('PluginEngine');

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 全局插件注册表：id → 插件类 */
const pluginRegistry = new Map();

/** 是否已完成插件发现（只需执行一次） */
let _discovered = false;

/**
 * 注册插件类
 * @param {typeof import('./plugins/BasePlugin.mjs').default} PluginClass
 */
export function registerPlugin(PluginClass) {
    if (!PluginClass.id) {
        throw new Error(`Plugin class must have a static 'id' property`);
    }
    pluginRegistry.set(PluginClass.id, PluginClass);
}

/**
 * 从 plugins/ 目录自动发现并加载所有插件（幂等，只在首次调用时执行）
 */
export async function autoDiscover() {
    if (_discovered) return;
    const pluginsDir = resolve(__dirname, 'plugins');
    let files;
    try {
        files = readdirSync(pluginsDir);
    } catch {
        return;
    }

    for (const file of files) {
        if (!file.endsWith('.mjs') || file === 'BasePlugin.mjs') continue;
        try {
            const mod = await import(pathToFileURL(resolve(pluginsDir, file)).href);
            const PluginClass = mod.default;
            if (PluginClass && PluginClass.id) {
                registerPlugin(PluginClass);
            }
        } catch (e) {
            log.warn({ err: e, file }, `加载插件 ${file} 失败`);
        }
    }
    _discovered = true;
}

/**
 * 对插件列表进行拓扑排序
 * @param {string[]} pluginIds - 要执行的插件 ID 列表
 * @returns {string[][]} 执行层级（每层内的插件可并发执行）
 */
function topologicalSort(pluginIds) {
    const idSet = new Set(pluginIds);
    const inDegree = new Map();
    const graph = new Map(); // id → dependents[]

    // 初始化
    for (const id of idSet) {
        inDegree.set(id, 0);
        graph.set(id, []);
    }

    // 建图
    for (const id of idSet) {
        const PluginClass = pluginRegistry.get(id);
        if (!PluginClass) continue;
        for (const dep of [...(PluginClass.deps || []), ...(PluginClass.observes || [])]) {
            if (!idSet.has(dep)) continue; // Completed prerequisites are checked before execution.
            graph.get(dep).push(id);
            inDegree.set(id, (inDegree.get(id) || 0) + 1);
        }
    }

    // BFS 分层
    const layers = [];
    let queue = [...idSet].filter(id => inDegree.get(id) === 0);

    while (queue.length > 0) {
        layers.push([...queue]);
        const nextQueue = [];
        for (const id of queue) {
            for (const dependent of (graph.get(id) || [])) {
                const newDeg = inDegree.get(dependent) - 1;
                inDegree.set(dependent, newDeg);
                if (newDeg === 0) nextQueue.push(dependent);
            }
        }
        queue = nextQueue;
    }

    // 检测循环依赖
    const scheduled = layers.flat();
    if (scheduled.length !== idSet.size) {
        const missing = [...idSet].filter(id => !scheduled.includes(id));
        throw new Error(`插件循环依赖: ${missing.join(', ')}`);
    }

    return layers;
}

/**
 * 查询某会话某插件是否已有成功的检查点（断点恢复用）
 * @param {string} sessionId
 * @param {string} pluginId
 * @returns {boolean}
 */
function hasCheckpoint(sessionId, pluginId) {
    try {
        const row = db.get(
            'SELECT id, fingerprint FROM plugin_checkpoints WHERE session_id = ? AND plugin_id = ? AND is_stale = 0',
            sessionId, pluginId
        );
        if (!row || row.fingerprint !== fingerprints.get(`${sessionId}:${pluginId}`)) return false;
        if (pluginId === 'A2-DataFlowGraph') {
            const graph = db.get('SELECT root_path FROM dataflow_graphs WHERE session_id=?',sessionId);
            if (!graph || !existsSync(resolve(graph.root_path,'catalog.sqlite'))) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 写入插件检查点（同时清除 is_stale 标记，表示数据已是最新）
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {string|null} phase
 * @param {number} durationMs
 * @param {object|null} summary  - emitDone() 携带的统计摘要
 */
function writeCheckpoint(sessionId, pluginId, phase, durationMs, summary) {
    try {
        const summaryJson = summary ? JSON.stringify(summary) : null;
        db.run(
            `INSERT OR REPLACE INTO plugin_checkpoints (session_id, plugin_id, phase, completed_at, duration_ms, is_stale, summary_json, fingerprint)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
            sessionId, pluginId, phase || null, Date.now(), durationMs, summaryJson, fingerprints.get(`${sessionId}:${pluginId}`) ?? null
        );
    } catch (e) {
        throw e;
    }
}

/**
 * 将指定插件列表的检查点标记为 stale（上游数据已更新，结果可能过期）
 * 只影响已存在的 checkpoint，不影响尚未运行的插件。
 * @param {string} sessionId
 * @param {string[]} pluginIds - 需要标记为 stale 的下游插件 ID 列表
 */
export function markStale(sessionId, pluginIds) {
    if (!pluginIds || pluginIds.length === 0) return;
    try {
        for (const pluginId of pluginIds) {
            db.run(
                'UPDATE plugin_checkpoints SET is_stale = 1 WHERE session_id = ? AND plugin_id = ?',
                sessionId, pluginId
            );
        }
    } catch (e) {
        log.warn({ err: e }, 'markStale error');
    }
}

/**
 * 获取某会话所有已完成的插件检查点
 * @param {string} sessionId
 * @returns {Array<{plugin_id, phase, completed_at, duration_ms}>}
 */
export function getCheckpoints(sessionId) {
    try {
        return db.all(
            'SELECT plugin_id, phase, completed_at, duration_ms, is_stale, summary_json FROM plugin_checkpoints WHERE session_id = ? ORDER BY completed_at ASC',
            sessionId
        );
    } catch {
        return [];
    }
}

/**
 * 清除某会话某插件（或全部）的检查点（用于强制重跑）
 */
export function clearCheckpoints(sessionId, pluginId = null) {
    try {
        if (pluginId) {
            db.run('DELETE FROM plugin_checkpoints WHERE session_id = ? AND plugin_id = ?', sessionId, pluginId);
        } else {
            db.run('DELETE FROM plugin_checkpoints WHERE session_id = ?', sessionId);
        }
    } catch (e) {
        log.warn({ err: e }, 'clearCheckpoints error');
    }
}

/**
 * 为指定 session 调度并执行插件
 *
 * @param {string} sessionId
 * @param {object} options
 * @param {string[]} [options.plugins]     - 插件 ID 列表（默认全部已注册插件）
 * @param {Function} [options.onProgress]  - 进度回调 (event) => void
 * @param {string}  [options.dataDir]      - 会话数据目录
 * @param {string}  [options.phase]        - 阶段标记（'phase1'/'phase3'/'phase4'/'manual'）
 * @param {boolean} [options.skipCompleted] - 是否跳过已完成的插件（断点恢复，默认 true）
 * @returns {Promise<void>}
 */
const activeSessions = new Set();
export async function schedule(sessionId, options = {}) {
    if (isMainThread && options.worker !== false) {
        return enqueueAnalysis('schedule', sessionId, options);
    }
    if (activeSessions.has(sessionId)) throw new Error(`Session ${sessionId} is already running`);
    activeSessions.add(sessionId);
    try {
        return await scheduleLocal(sessionId, { ...options, onProgress: event => {
            try { options.onProgress?.(event); } catch (error) { log.warn({ err: error }, 'Progress observer failed'); }
        } });
    }
    finally { activeSessions.delete(sessionId); }
}

async function scheduleLocal(sessionId, options = {}) {
    const {
        plugins: requestedPlugins,
        onProgress,
        dataDir,
        phase,
        skipCompleted = true,
    } = options;

    await fingerprintInputs(sessionId);
    // 确定要执行的插件列表
    const pluginIds = [...new Set(requestedPlugins ?? [...pluginRegistry.keys()].filter(id => id !== 'A1-TaintTracker'))];
    for (const id of pluginIds) {
        if (!pluginRegistry.has(id)) throw new Error(`Unknown plugin: ${id}`);
    }
    // Include missing/stale prerequisites recursively, retaining the requested phase API.
    for (let i = 0; i < pluginIds.length; i++) {
        const plugin = pluginRegistry.get(pluginIds[i]);
        for (const dep of plugin.observes || []) {
            if (db.get('SELECT id FROM plugin_checkpoints WHERE session_id=? AND plugin_id=?', sessionId, dep)
                && !hasCheckpoint(sessionId, dep) && !pluginIds.includes(dep)) pluginIds.push(dep);
        }
        for (const dep of plugin.deps || []) {
            if (!pluginRegistry.has(dep)) throw new Error(`Missing dependency: ${dep}`);
            if (!pluginIds.includes(dep) && !hasCheckpoint(sessionId, dep)) pluginIds.push(dep);
        }
    }

    if (pluginIds.length === 0) {
        return;
    }

    // 拓扑排序
    let layers;
    try {
        layers = topologicalSort(pluginIds);
    } catch (e) {
        throw new Error(`拓扑排序失败: ${e.message}`);
    }

    // 统计跳过和需执行的插件
    const skipped = [];
    const toRun = [];
    if (skipCompleted) {
        for (const id of pluginIds) {
            if (!(options.forcePlugins || []).includes(id) && hasCheckpoint(sessionId, id)) skipped.push(id);
            else toRun.push(id);
        }
    } else {
        toRun.push(...pluginIds);
    }

    for (let i = 0; i < toRun.length; i++) {
        for (const id of downstreamOf(toRun[i])) {
            const index = skipped.indexOf(id);
            if (index >= 0) { skipped.splice(index, 1); toRun.push(id); }
        }
    }

    // 更新 plugin_status：pending（仅待执行的）；已跳过的保持 done
    const existingSession = db.get('SELECT plugin_status FROM sessions WHERE id = ?', sessionId);
    let currentStatus = {};
    try { currentStatus = JSON.parse(existingSession?.plugin_status || '{}'); } catch {}

    for (const id of toRun) currentStatus[id] = 'pending';
    for (const id of skipped) currentStatus[id] = 'skipped'; // 明确标记跳过
    db.run(
        'UPDATE sessions SET plugin_status = ? WHERE id = ?',
        JSON.stringify(currentStatus),
        sessionId
    );

    // 通知调度开始
    if (typeof onProgress === 'function') {
        onProgress({
            type: 'schedule_start',
            sessionId,
            phase: phase || null,
            plugins: pluginIds,
            toRun,
            skipped,
        });
    }

    // 如果全部跳过，直接结束
    if (toRun.length === 0) {
        if (typeof onProgress === 'function') {
            onProgress({ type: 'all_done', sessionId, phase: phase || null, skipped, toRun: [] });
        }
        db.run('UPDATE sessions SET status = ? WHERE id = ?', options.settleSession === false ? 'indexing' : 'ready', sessionId);
        return;
    }

    const failed = new Set();
    const toRunSet = new Set(toRun);
    db.run("UPDATE sessions SET status = 'processing' WHERE id = ?", sessionId);
    for (const layer of layers) {
        for (const pluginId of layer.filter(id => toRunSet.has(id))) {
            const plugin = pluginRegistry.get(pluginId);
            const deps = [...(plugin.deps || []), ...(plugin.observes || [])];
            if (deps.some(dep => failed.has(dep))) {
                failed.add(pluginId);
                updatePluginStatus(sessionId, pluginId, 'blocked');
                onProgress?.({ type: 'plugin_blocked', sessionId, plugin: pluginId, status: 'blocked' });
                continue;
            }
            // Results downstream of a rerun cannot remain fresh.
            markStale(sessionId, downstreamOf(pluginId));
            try { await runPlugin(sessionId, pluginId, { onProgress, dataDir, phase, extraCtx: options.pluginContexts?.[pluginId] }); }
            catch { failed.add(pluginId); }
        }
    }
    const status = failed.size ? 'failed' : options.settleSession === false ? 'indexing' : 'ready';
    db.run('UPDATE sessions SET status = ? WHERE id = ?', status, sessionId);
    onProgress?.({ type: failed.size ? 'schedule_failed' : 'all_done', sessionId, phase: phase || null, skipped, toRun, failed: [...failed] });
    if (failed.size) throw new Error(`Analysis failed: ${[...failed].join(', ')}`);

}

/**
 * 执行单个插件
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {object} options
 */
async function runPlugin(sessionId, pluginId, options = {}) {
    const { onProgress, dataDir, phase } = options;
    const PluginClass = pluginRegistry.get(pluginId);

    if (!PluginClass) {
        log.warn({ pluginId }, `未知插件: ${pluginId}`);
        return;
    }

    // 更新状态为 running
    updatePluginStatus(sessionId, pluginId, 'running');

    // 捕获最后一次 emitDone 的 summary（由 BasePlugin.emitDone 发出）
    let lastSummary = null;

    const emit = (event) => {
        // 拦截 done 事件，记录 summary 供 writeCheckpoint 使用
        if (event.status === 'done' && event.summary !== undefined) {
            lastSummary = event.summary;
            return; // Completion is published only after transaction commit.
        }
        if (typeof onProgress === 'function') {
            onProgress({ ...event, sessionId });
        }
    };

    const rollbackHandlers = [];
    const commitHandlers = [];
    const ctx = {
        onRollback: handler => rollbackHandlers.push(handler),
        onCommit: handler => commitHandlers.push(handler),
        sessionId,
        db,
        emit,
        dataDir: dataDir ?? resolve(__dirname, 'data/sessions', sessionId),
        ...(options.extraCtx ?? {}),
    };

    const startTime = Date.now();

    try {
        log.debug({ sessionId, pluginId }, `插件 ${pluginId} 开始执行`);
        emit({ type: 'plugin_start', plugin: pluginId, status: 'running', message: '开始执行...' });

        const plugin = new PluginClass();
        // Worker owns this connection. Publish results and checkpoint atomically;
        // WAL readers continue seeing the previous successful snapshot.
        db.exec('BEGIN IMMEDIATE');
        await plugin.run(ctx);

        const duration = Date.now() - startTime;
        updatePluginStatus(sessionId, pluginId, 'done');

        // 写入检查点（断点恢复）+ summary 持久化
        writeCheckpoint(sessionId, pluginId, phase, duration, lastSummary);
        db.exec('COMMIT');
        for (const handler of commitHandlers) { try { handler(); } catch (error) { log.warn({ err: error }, 'Post-commit cleanup deferred'); } }

        log.info({ sessionId, pluginId, durationMs: duration }, `插件 ${pluginId} 执行完成 (${duration}ms)`);
        emit({ type: 'plugin_done', plugin: pluginId, status: 'done', durationMs: duration, summary: lastSummary });

    } catch (e) {
        if (db.raw().inTransaction) db.exec('ROLLBACK');
        for (const handler of rollbackHandlers) { try { handler(); } catch (cleanupError) { log.warn({ err: cleanupError }, 'Plugin cleanup failed'); } }
        const duration = Date.now() - startTime;
        log.error({
            err: e,
            sessionId,
            pluginId,
            durationMs: duration,
        }, `插件 ${pluginId} 执行失败: ${e.message}`);
        updatePluginStatus(sessionId, pluginId, 'failed');
        emit({ type: 'plugin_failed', plugin: pluginId, status: 'failed', error: e.message, durationMs: duration });

        // 标记 session 失败
        db.run('UPDATE sessions SET status = ? WHERE id = ?', 'failed', sessionId);
        throw e;
    }
}

/**
 * 手动触发单个插件（供 API 调用）
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {object} options
 */
export async function runSinglePlugin(sessionId, pluginId, options = {}) {
    if (isMainThread && options.worker !== false) return enqueueAnalysis('single', sessionId, { ...options, pluginId });
    return schedule(sessionId, {
        ...options, plugins: [pluginId], forcePlugins: [pluginId],
        phase: options.phase || 'manual', worker: false,
        pluginContexts: { [pluginId]: options.extraCtx ?? {} },
    });
}

/**
 * 更新会话的 plugin_status 字段中某个插件的状态
 */
function updatePluginStatus(sessionId, pluginId, status) {
    try {
        const session = db.get('SELECT plugin_status FROM sessions WHERE id = ?', sessionId);
        if (!session) return;
        let ps = {};
        try { ps = JSON.parse(session.plugin_status || '{}'); } catch {}
        ps[pluginId] = status;
        db.run('UPDATE sessions SET plugin_status = ? WHERE id = ?', JSON.stringify(ps), sessionId);
    } catch (e) {
        log.warn({ err: e }, 'updatePluginStatus error');
    }
}

/**
 * 获取已注册的所有插件信息
 * @returns {Array<{id, description, deps, displayName}>}
 */
export function listPlugins() {
    return [...pluginRegistry.entries()].map(([id, cls]) => ({
        id,
        description: cls.description || '',
        deps: cls.deps || [],
        displayName: cls.displayName || id,
    }));
}

function downstreamOf(id) {
    const result = new Set();
    const visit = upstream => {
        for (const [key, cls] of pluginRegistry) {
            if ([...(cls.deps || []), ...(cls.observes || [])].includes(upstream) && !result.has(key)) {
                result.add(key); visit(key);
            }
        }
    };
    visit(id);
    return [...result];
}

const fingerprints = new Map();
async function fingerprintInputs(sessionId) {
    const session = db.get('SELECT bin_path,smap_path,source_file FROM sessions WHERE id = ?', sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const hash = createHash('sha256');
    for (const path of [session.bin_path, session.smap_path, session.source_file]) {
        hash.update(String(path));
        if (path) for await (const chunk of createReadStream(path)) hash.update(chunk);
    }
    hash.update(JSON.stringify(cfg('plugins')));
    for (const file of readdirSync(resolve(__dirname,'plugins')).filter(f => f.endsWith('.mjs')).sort()) hash.update(readFileSync(resolve(__dirname,'plugins',file)));
    hash.update(readFileSync(resolve(__dirname,'../src/encoding/EventSerializer.js')));
    hash.update(readFileSync(resolve(__dirname,'GraphStore.mjs')));
    hash.update(JSON.stringify(cfg('graph')));
    const input = hash.digest('hex');
    for (const [id, cls] of pluginRegistry) {
        fingerprints.set(`${sessionId}:${id}`, createHash('sha256').update(input).update(cls.toString()).digest('hex'));
    }
}
