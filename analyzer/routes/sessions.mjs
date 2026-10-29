import { analyzeSession } from '../SessionAnalysis.mjs';
/**
 * routes/sessions.mjs — 分析会话 REST API（入口，组合子路由）
 *
 * 子模块：
 *   sessions/core.mjs      — 会话 CRUD、阶段调度（POST/GET/DELETE + re-run + run-phase3/4）
 *   sessions/events.mjs    — 事件查询（events / event-types / value-search）
 *   sessions/functions.mjs — 函数调用（functions / calls / call-graph / call-stack / own-events）
 *   sessions/analysis.mjs  — 分析结果读取（crypto / dataflow / loops / strings / obfuscation / …）
 *   sessions/utils.mjs     — 共享工具函数与常量
 */

import { Router } from 'express';
import coreRouter     from './sessions/core.mjs';
import eventsRouter   from './sessions/events.mjs';
import fnRouter       from './sessions/functions.mjs';
import analysisRouter from './sessions/analysis.mjs';
import { DATA_DIR } from './sessions/core.mjs';

// 重新导出供 server.mjs 内部调用（/api/trace/import）
export { DATA_DIR };

const router = Router();

// ── 挂载子路由 ───────────────────────────────────────────────────────────────

// core：会话 CRUD + 调度（优先挂载，包含 / 和 /:id 基础路由）
router.use('/', coreRouter);

// events：事件查询，挂载到 /:id 下（mergeParams 已在子路由中启用）
router.use('/:id', eventsRouter);

// functions：函数调用，挂载到 /:id 下
router.use('/:id', fnRouter);

// analysis：分析结果，挂载到 /:id 下
router.use('/:id', analysisRouter);

export default router;

// ── createSession（供 server.mjs 的 /api/trace/import 调用）─────────────────

import { resolve, basename } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { v4 as uuid } from 'uuid';
import * as db from '../db/Database.mjs';
import { autoDiscover, schedule } from '../PluginEngine.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('sessions');

/**
 * 从已有的 bin/smap 文件路径创建会话（供内部调用，如 trace-import API）。
 * @param {{ binPath: string, smapPath?: string|null, sourcePath?: string|null, projectId?: string|null, name?: string, wsProgressBroadcast?: Function, selectedPlugins?: string[]|null }} opts
 * @returns {Promise<string>} sessionId
 */
export async function createSession({
    binPath,
    smapPath    = null,
    sourcePath  = null,
    projectId   = null,
    name        = null,
    wsProgressBroadcast = null,
    selectedPlugins = null,   // null 表示运行所有 Phase 2 插件（默认）
}) {

    const sessionId  = uuid();
    const sessionDir = resolve(DATA_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const binDest  = resolve(sessionDir, basename(binPath));
    copyFileSync(binPath, binDest);

    let smapDest = null;
    if (smapPath) {
        smapDest = resolve(sessionDir, basename(smapPath));
        copyFileSync(smapPath, smapDest);
    }

    // 复制源码文件（从工作空间关联过来时）
    let sourceDest = null;
    if (sourcePath && existsSync(sourcePath)) {
        sourceDest = resolve(sessionDir, basename(sourcePath));
        copyFileSync(sourcePath, sourceDest);
    }

    const sessionName = name || basename(binPath).replace(/\.bin$/, '') || `session-${sessionId.slice(0, 8)}`;
    const now = Date.now();

    db.run(
        `INSERT INTO sessions (id, name, created_at, source_file, bin_path, smap_path, status, plugin_status, project_id)
         VALUES (?, ?, ?, ?, ?, ?, 'parsing', '{}', ?)`,
        sessionId, sessionName, now, sourceDest, binDest, smapDest, projectId
    );

    analyzeSession(sessionId, {
        dataDir: sessionDir, hasSmap: !!smapDest, selectedPlugins,
        onProgress: evt => wsProgressBroadcast?.(sessionId, evt),
    }).catch(e => {
        log.error({ err: e }, '[createSession] plugin schedule error:');
        db.run("UPDATE sessions SET status = 'failed' WHERE id = ?", sessionId);
        wsProgressBroadcast?.(sessionId, { type: 'error', sessionId, message: e.message });
    });

    return sessionId;
}
