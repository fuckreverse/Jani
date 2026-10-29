import { analyzeSession, parsePluginSelection, PHASE1_PLUGINS, PHASE2_PLUGINS, PHASE3_PLUGINS, PHASE4_PLUGINS } from '../../SessionAnalysis.mjs';
/**
 * sessions/core.mjs — 会话 CRUD + 调度
 *
 * POST   /api/sessions                  上传 .bin + .smap.json（可选）+ .js（可选），创建新会话
 * GET    /api/sessions                  列出所有会话
 * GET    /api/sessions/:id              会话详情 + 插件状态
 * DELETE /api/sessions/:id             删除会话
 * GET    /api/sessions/:id/checkpoints  查询插件断点恢复状态
 * POST   /api/sessions/:id/re-run       重新触发指定 phase 或插件列表的分析
 * POST   /api/sessions/:id/run-phase3   (向后兼容) 手动触发 Phase 3
 * POST   /api/sessions/:id/run-phase4   (向后兼容) 手动触发 Phase 4
 */

import { Router } from 'express';
import { validateFilename } from '../../ExecutionPolicy.mjs';
import { createLogger } from '../../logger.mjs';

const log = createLogger('sessions');
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../../db/Database.mjs';
import { schedule, autoDiscover, getCheckpoints } from '../../PluginEngine.mjs';

import { safeParseJson } from './utils.mjs';

const router = Router();
const __dirname = resolve(new URL('.', import.meta.url).pathname);
export const DATA_DIR = resolve(__dirname, '../../data/sessions');

// 确保数据目录存在
mkdirSync(DATA_DIR, { recursive: true });

// ── POST /api/sessions ─────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const files = req.files;

        // 必须有 .bin 文件
        const binFile = files?.bin?.[0] ?? files?.['bin']?.[0];
        if (!binFile) {
            return res.status(400).json({ error: 'Missing required file: bin' });
        }

        const sessionId = uuidv4();
        const sessionDir = resolve(DATA_DIR, sessionId);
        mkdirSync(sessionDir, { recursive: true });

        // 移动 bin 文件
        const binDest = resolve(sessionDir, validateFilename(binFile.originalname || 'trace.bin'));
        copyFileSync(binFile.path, binDest);

        // 可选：smap 文件
        const smapFile = files?.smap?.[0] ?? files?.['smap']?.[0];
        let smapDest = null;
        if (smapFile) {
            smapDest = resolve(sessionDir, validateFilename(smapFile.originalname || 'trace.smap.json'));
            copyFileSync(smapFile.path, smapDest);
        }

        // 可选：原始 JS 文件
        const sourceFile = files?.source?.[0] ?? files?.['source']?.[0];
        let sourceDest = null;
        if (sourceFile) {
            sourceDest = resolve(sessionDir, validateFilename(sourceFile.originalname || 'source.js'));
            copyFileSync(sourceFile.path, sourceDest);
        }

        // 会话名称（来自请求体或文件名）
        const sessionName = req.body?.name
            || (binFile.originalname ? binFile.originalname.replace(/\.bin$/, '') : null)
            || `session-${sessionId.slice(0, 8)}`;

        const now = Date.now();

        // 创建 session 记录（status = parsing：Phase 1 解析中）
        db.run(
            `INSERT INTO sessions (id, name, created_at, source_file, bin_path, smap_path, status, plugin_status)
             VALUES (?, ?, ?, ?, ?, ?, 'parsing', '{}')`,
            sessionId, sessionName, now,
            sourceDest, binDest, smapDest
        );

        const wsProgressBroadcast = req.app.get('wsProgressBroadcast');

        // Phase 1：只跑基础解析（F1-EventIndex + 可选 F2-SmapLoader）
        analyzeSession(sessionId, {
            dataDir: sessionDir, hasSmap: !!smapDest, selectedPlugins: parsePluginSelection(req.body?.selectedPlugins),
            onProgress: evt => wsProgressBroadcast?.(sessionId, evt),
        }).catch(e => {
            log.error({ err: e }, '[sessions] phase1 schedule error:');
            db.run("UPDATE sessions SET status = 'failed' WHERE id = ?", sessionId);
            wsProgressBroadcast?.(sessionId, { type: 'error', sessionId, message: e.message });
        });

        return res.status(201).json({
            sessionId,
            status: 'parsing',
            smapAvailable: !!smapDest,
        });

    } catch (e) {
        log.error({ err: e }, '[POST /api/sessions] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── GET /api/sessions ──────────────────────────────────────────────────────

router.get('/', (req, res) => {
    try {
        const sessions = db.all(
            `SELECT s.id, s.name, s.created_at, s.source_file, s.status, s.event_count, s.plugin_status,
                    EXISTS(
                        SELECT 1 FROM plugin_checkpoints pc
                        WHERE pc.session_id = s.id AND pc.is_stale = 1
                    ) AS has_stale
             FROM sessions s
             ORDER BY s.created_at DESC`
        );

        const result = sessions.map(s => ({
            ...s,
            plugin_status: safeParseJson(s.plugin_status, {}),
            has_stale: Boolean(s.has_stale), // SQLite 返回 0/1，转成 bool
        }));

        return res.json(result);
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id ──────────────────────────────────────────────────

router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT * FROM sessions WHERE id = ?', id);

        if (!session) {
            return res.status(404).json({ error: `Session ${id} not found` });
        }

        // 获取文件元信息（大小）
        const fileInfo = {};
        const tryStatFile = (path, key) => {
            if (!path) { fileInfo[key] = null; return; }
            try {
                const st = statSync(path);
                fileInfo[key] = { path, name: basename(path), size: st.size, mtime: st.mtimeMs };
            } catch {
                fileInfo[key] = { path, name: basename(path), size: null, mtime: null, missing: true };
            }
        };
        tryStatFile(session.bin_path,    'binFile');
        tryStatFile(session.smap_path,   'smapFile');
        tryStatFile(session.source_file, 'sourceFile');

        // smap 条目数（是否已加载 smap）
        const smapCount = session.smap_path
            ? (db.get('SELECT COUNT(*) as cnt FROM smap WHERE session_id = ?', id)?.cnt ?? 0)
            : 0;

        // 关联项目基础信息（如有）
        let projectInfo = null;
        if (session.project_id) {
            try {
                const proj = db.get(
                    'SELECT id, name, status, smap_path, instrumented_path, preprocessed_path, iid_count, source_file FROM projects WHERE id = ?',
                    session.project_id
                );
                if (proj) {
                    // 辅助：获取文件信息（文件名 + 大小），文件不存在时返回 null
                    const fileInfo2 = (p) => {
                        if (!p || !existsSync(p)) return null;
                        try {
                            const st = statSync(p);
                            return { name: basename(p), size: st.size };
                        } catch { return null; }
                    };
                    projectInfo = {
                        id:          proj.id,
                        name:        proj.name,
                        status:      proj.status,
                        iidCount:    proj.iid_count ?? 0,
                        source:      fileInfo2(proj.source_file),
                        preprocessed: fileInfo2(proj.preprocessed_path),
                        instrumented: fileInfo2(proj.instrumented_path),
                        smap:        fileInfo2(proj.smap_path),
                        // 向后兼容字段（OverviewTab 原有使用）
                        hasInstrumented:     !!(proj.instrumented_path && existsSync(proj.instrumented_path)),
                        hasSmap:             !!(proj.smap_path && existsSync(proj.smap_path)),
                        hasPreprocessed:     !!(proj.preprocessed_path && existsSync(proj.preprocessed_path)),
                        hasSource:           !!(proj.source_file && existsSync(proj.source_file)),
                    };
                }
            } catch { /* 查询失败不影响主接口 */ }
        }

        return res.json({
            ...session,
            plugin_status: safeParseJson(session.plugin_status, {}),
            fileInfo,
            smapCount,
            projectInfo,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── DELETE /api/sessions/:id ──────────────────────────────────────────────

router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        // 删除会话目录（bin/smap/source 文件）
        const sessionDir = resolve(DATA_DIR, id);
        if (existsSync(sessionDir)) {
            rmSync(sessionDir, { recursive: true, force: true });
        }

        // 删除所有关联的数据库记录（单事务，原子操作）
        // 注意：先关闭外键约束，避免逐行外键校验拖慢大表删除；事务结束后恢复
        const TABLES_WITH_SESSION = [
            // F1 核心事件表（数据量最大，放前面让事务尽快释放空间）
            'value_index', 'value_dict', 'oid_aliases',
            'writes', 'reads', 'fields', 'events',
            // F2/F3/F4
            'smap', 'call_edges', 'var_lifetime', 'iid_counts',
            // A 系列分析结果
            'taint_paths', 'dataflow_edges', 'dataflow_graphs', 'loops', 'loop_iterations', 'loop_var_roles',
            'object_timelines', 'value_patterns',
            // I 系列分析结果
            'string_events', 'fn_signatures', 'crypto_hints', 'signature_paths',
            'obfuscation_hints', 'web_api_calls',
            // 其他
            'scopes', 'bookmarks', 'analysis_summary', 'plugin_checkpoints',
        ];
        const rawDb = db.raw();
        rawDb.pragma('foreign_keys = OFF');
        try {
            db.transaction(() => {
                for (const table of TABLES_WITH_SESSION) {
                    try {
                        db.run(`DELETE FROM ${table} WHERE session_id = ?`, id);
                    } catch (e) {
                        if (!e.message?.includes('no such table')) throw e;
                    }
                }
                // 删除 sessions 主记录
                db.run('DELETE FROM sessions WHERE id = ?', id);
            });
        } finally {
            rawDb.pragma('foreign_keys = ON');
        }

        return res.json({ deleted: true });
    } catch (e) {
        log.error({ err: e }, '[DELETE /api/sessions/:id] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/checkpoints ─────────────────────────────────────

router.get('/:id/checkpoints', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const checkpoints = getCheckpoints(id);
        res.json({ checkpoints });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/checkpoints] error:');
        res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── POST /api/sessions/:id/re-run ─────────────────────────────────────────
// 重新触发分析（支持断点恢复 or 强制重跑）

router.post('/:id/re-run', async (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT * FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const {
            plugins,
            phase,
            forceRerun = false,
        } = req.body ?? {};

        // 确定要运行的插件列表
        let targetPlugins;
        let resolvedPhase = phase; // 可能是 undefined（单插件模式）
        if (plugins && Array.isArray(plugins) && plugins.length > 0) {
            // 显式传入插件列表（单插件或自定义组合）：直接使用，不依赖 phase
            targetPlugins = plugins;
        } else if (phase === 'phase1') {
            targetPlugins = [...PHASE1_PLUGINS];
            if (session.smap_path) targetPlugins.push('F2-SmapLoader');
        } else if (phase === 'phase2') {
            targetPlugins = [...PHASE2_PLUGINS];
        } else if (phase === 'phase3') {
            targetPlugins = [...PHASE3_PLUGINS];
        } else if (phase === 'phase4') {
            targetPlugins = [...PHASE4_PLUGINS];
        } else {
            return res.status(400).json({
                error: 'Invalid phase. Use phase1/phase2/phase3/phase4 or provide explicit plugins list.',
            });
        }

        const sessionDir = resolve(DATA_DIR, id);
        const wsProgressBroadcast = req.app.get('wsProgressBroadcast');

        await autoDiscover();

        schedule(id, {
            plugins: targetPlugins,
            dataDir: sessionDir,
            phase: resolvedPhase,
            skipCompleted: !forceRerun,
            onProgress: (evt) => {
                wsProgressBroadcast?.(id, evt);
            },
        }).catch(e => {
            log.error({ err: e }, '[re-run] schedule error:');
            wsProgressBroadcast?.(id, { type: 'error', sessionId: id, message: e.message });
        });

        return res.json({ status: 'scheduled', plugins: targetPlugins, phase: resolvedPhase, forceRerun });
    } catch (e) {
        log.error({ err: e }, '[POST /api/sessions/:id/re-run] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── POST /api/sessions/:id/run-phase3 ─────────────────────────────────────
// 手动触发 Phase 3 插件分析

router.post('/:id/run-phase3', async (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const { plugins = PHASE3_PLUGINS, forceRerun = false } = req.body ?? {};

        await autoDiscover();


        // 异步执行，不阻塞响应
        schedule(id, {
            plugins,
            dataDir: resolve(DATA_DIR, id),
            phase: 'phase3',
            skipCompleted: !forceRerun,
            onProgress: (evt) => {
                req.app.get('wsProgressBroadcast')?.(id, evt);
            },
        }).catch(e => {
            log.error({ err: e }, '[run-phase3] schedule error:');
        });

        return res.json({ status: 'scheduled', plugins, phase: 'phase3' });
    } catch (e) {
        log.error({ err: e }, '[POST /api/sessions/:id/run-phase3] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

// ── POST /api/sessions/:id/run-phase4 ─────────────────────────────────────
// 手动触发 Phase 4 插件分析

router.post('/:id/run-phase4', async (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const { plugins = PHASE4_PLUGINS, forceRerun = false } = req.body ?? {};

        await autoDiscover();


        schedule(id, {
            plugins,
            dataDir: resolve(DATA_DIR, id),
            phase: 'phase4',
            skipCompleted: !forceRerun,
            onProgress: (evt) => {
                req.app.get('wsProgressBroadcast')?.(id, evt);
            },
        }).catch(e => {
            log.error({ err: e }, '[run-phase4] schedule error:');
        });

        return res.json({ status: 'scheduled', plugins, phase: 'phase4' });
    } catch (e) {
        log.error({ err: e }, '[POST /api/sessions/:id/run-phase4] error:');
        return res.status(e.status ?? 500).json({ error: e.message });
    }
});

export default router;
