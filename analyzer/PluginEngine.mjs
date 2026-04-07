/**
 * PluginEngine.mjs — 插件调度器
 * 拓扑排序 + 串行/并发执行 + 进度回调 + 断点恢复
 */

import { resolve, dirname } from 'path';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import * as db from './db/Database.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 全局插件注册表：id → 插件类 */
const pluginRegistry = new Map();

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
 * 从 plugins/ 目录自动发现并加载所有插件
 */
export async function autoDiscover() {
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
            console.warn(`[PluginEngine] 加载插件 ${file} 失败:`, e.message);
        }
    }
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
        for (const dep of (PluginClass.deps || [])) {
            if (!idSet.has(dep)) continue; // 依赖不在列表中，忽略
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
            'SELECT id FROM plugin_checkpoints WHERE session_id = ? AND plugin_id = ?',
            sessionId, pluginId
        );
        return !!row;
    } catch {
        return false;
    }
}

/**
 * 写入插件检查点
 */
function writeCheckpoint(sessionId, pluginId, phase, durationMs) {
    try {
        db.run(
            `INSERT OR REPLACE INTO plugin_checkpoints (session_id, plugin_id, phase, completed_at, duration_ms)
             VALUES (?, ?, ?, ?, ?)`,
            sessionId, pluginId, phase || null, Date.now(), durationMs
        );
    } catch (e) {
        console.warn('[PluginEngine] writeCheckpoint error:', e.message);
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
            'SELECT plugin_id, phase, completed_at, duration_ms FROM plugin_checkpoints WHERE session_id = ? ORDER BY completed_at ASC',
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
        console.warn('[PluginEngine] clearCheckpoints error:', e.message);
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
export async function schedule(sessionId, options = {}) {
    const {
        plugins: requestedPlugins,
        onProgress,
        dataDir,
        phase,
        skipCompleted = true,
    } = options;

    // 确定要执行的插件列表
    const pluginIds = requestedPlugins ?? [...pluginRegistry.keys()];

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
            if (hasCheckpoint(sessionId, id)) skipped.push(id);
            else toRun.push(id);
        }
    } else {
        toRun.push(...pluginIds);
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
        db.run('UPDATE sessions SET status = ? WHERE id = ?', 'ready', sessionId);
        return;
    }

    // 逐层执行（仅执行 toRun 中的插件）
    const toRunSet = new Set(toRun);
    for (const layer of layers) {
        const activeInLayer = layer.filter(id => toRunSet.has(id));
        if (activeInLayer.length === 0) continue;

        // 同层内并发执行
        await Promise.all(activeInLayer.map(pluginId => runPlugin(sessionId, pluginId, {
            onProgress,
            dataDir,
            phase,
        })));
    }

    // 全部完成后通知
    if (typeof onProgress === 'function') {
        onProgress({ type: 'all_done', sessionId, phase: phase || null, skipped, toRun });
    }

    // 更新 session 状态
    db.run('UPDATE sessions SET status = ? WHERE id = ?', 'ready', sessionId);
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
        console.warn(`[PluginEngine] 未知插件: ${pluginId}`);
        return;
    }

    // 更新状态为 running
    updatePluginStatus(sessionId, pluginId, 'running');

    const emit = (event) => {
        if (typeof onProgress === 'function') {
            onProgress({ ...event, sessionId });
        }
    };

    const ctx = {
        sessionId,
        db,
        emit,
        dataDir: dataDir ?? resolve(__dirname, 'data/sessions', sessionId),
        ...(options.extraCtx ?? {}),
    };

    const startTime = Date.now();

    try {
        emit({ type: 'plugin_start', plugin: pluginId, status: 'running', message: '开始执行...' });

        const plugin = new PluginClass();
        await plugin.run(ctx);

        const duration = Date.now() - startTime;
        updatePluginStatus(sessionId, pluginId, 'done');

        // 写入检查点（断点恢复）
        writeCheckpoint(sessionId, pluginId, phase, duration);

        emit({ type: 'plugin_done', plugin: pluginId, status: 'done', durationMs: duration });

        // 每个插件完成后持久化到磁盘（flush 只在 dirty 时才 export）
        db.flush();

    } catch (e) {
        const duration = Date.now() - startTime;
        console.error(`[PluginEngine] 插件 ${pluginId} 执行失败:`, e);
        updatePluginStatus(sessionId, pluginId, 'failed');
        emit({ type: 'plugin_failed', plugin: pluginId, status: 'failed', error: e.message, durationMs: duration });

        // 标记 session 失败
        db.run('UPDATE sessions SET status = ? WHERE id = ?', 'failed', sessionId);
    }
}

/**
 * 手动触发单个插件（供 API 调用）
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {object} options
 */
export async function runSinglePlugin(sessionId, pluginId, options = {}) {
    return runPlugin(sessionId, pluginId, { ...options, phase: options.phase || 'manual' });
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
        console.warn('[PluginEngine] updatePluginStatus error:', e.message);
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
