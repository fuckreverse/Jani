/**
 * routes/storage.mjs — 空间使用分析 API
 *
 * GET  /api/storage/stats    扫描 data 目录，返回各分类的空间占用、文件明细和删除建议
 * POST /api/storage/delete   批量删除：uploads 孤立文件 / sessions / projects 目录
 * POST /api/storage/vacuum   执行 SQLite VACUUM + WAL checkpoint，回收删除数据占用的磁盘空间
 */

import { Router } from 'express';
import { createLogger } from '../logger.mjs';

const log = createLogger('storage');

import {
    existsSync, readdirSync, statSync, rmSync, readFileSync,
} from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

const router = Router();
const __dirname = resolve(dirname(fileURLToPath(import.meta.url)));

const DATA_DIR      = resolve(__dirname, '../data');
const UPLOADS_DIR   = resolve(DATA_DIR, 'uploads');
const SESSIONS_DIR  = resolve(DATA_DIR, 'sessions');
const PROJECTS_DIR  = resolve(DATA_DIR, 'projects');
const DB_FILE       = resolve(DATA_DIR, 'jta.db');

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 递归计算目录大小（bytes），返回 { size, fileCount } */
function dirStats(dirPath) {
    let size = 0;
    let fileCount = 0;
    try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const e of entries) {
            const full = join(dirPath, e.name);
            if (e.isDirectory()) {
                const sub = dirStats(full);
                size      += sub.size;
                fileCount += sub.fileCount;
            } else if (e.isFile()) {
                try {
                    const st = statSync(full);
                    size += st.size;
                    fileCount++;
                } catch { /* skip */ }
            }
        }
    } catch { /* skip if not readable */ }
    return { size, fileCount };
}

/** 安全 statSync，返回 null on error */
function safeStat(p) {
    try { return statSync(p); } catch { return null; }
}

/** 格式化 bytes 为人类可读字符串 */
function fmtBytes(n) {
    if (n < 1024)                     return `${n} B`;
    if (n < 1024 * 1024)              return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024)       return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 格式化毫秒时间戳为可读字符串 */
function fmtAge(mtimeMs) {
    const diffMs = Date.now() - mtimeMs;
    const days   = Math.floor(diffMs / 86400000);
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7)   return `${days} 天前`;
    if (days < 30)  return `${Math.floor(days / 7)} 周前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
}

// ── GET /api/storage/stats ──────────────────────────────────────────────────

router.get('/stats', (req, res) => {
    try {
        const result = _collectStats();
        res.json(result);
    } catch (e) {
        log.error({ err: e }, '[GET /api/storage/stats] error');
        res.status(500).json({ error: e.message });
    }
});

function _collectStats() {
    // ── 1. uploads 目录扫描 ────────────────────────────────────────────────
    const uploadFiles = [];
    let uploadsTotal  = 0;
    let uploadsOrphan = 0;
    let uploadsOrphanSize = 0;

    if (existsSync(UPLOADS_DIR)) {
        const entries = readdirSync(UPLOADS_DIR, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isFile()) continue;
            const fp = join(UPLOADS_DIR, e.name);
            const st = safeStat(fp);
            if (!st) continue;
            uploadsTotal += st.size;

            // 判断是否为孤立文件（multer 临时上传文件，已无人引用）
            // sessions 表中没有 bin_path 包含此文件，projects 表中没有 source_file 包含此文件
            const isReferenced = _isUploadReferenced(fp);
            const item = {
                type: 'upload',
                path: fp,
                name: e.name,
                size: st.size,
                sizeStr: fmtBytes(st.size),
                mtime: st.mtimeMs,
                ageStr: fmtAge(st.mtimeMs),
                orphan: !isReferenced,
            };
            uploadFiles.push(item);
            if (!isReferenced) {
                uploadsOrphan++;
                uploadsOrphanSize += st.size;
            }
        }
    }

    // ── 2. sessions 目录扫描 ───────────────────────────────────────────────
    const sessionItems = [];
    let sessionsTotal  = 0;

    // 从数据库获取所有 sessions 记录
    const dbSessions = _safeDbAll(
        'SELECT id, name, created_at, status, event_count, project_id FROM sessions ORDER BY created_at DESC'
    );
    const dbSessionIds = new Set(dbSessions.map(s => s.id));

    if (existsSync(SESSIONS_DIR)) {
        const entries = readdirSync(SESSIONS_DIR, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const dirPath = join(SESSIONS_DIR, e.name);
            const { size, fileCount } = dirStats(dirPath);
            sessionsTotal += size;

            const dbRec = dbSessions.find(s => s.id === e.name);
            const isOrphan = !dbSessionIds.has(e.name); // 目录存在但 DB 无记录

            // 计算最后修改时间（取目录内最新文件）
            let lastMtime = 0;
            try {
                const files = readdirSync(dirPath);
                for (const f of files) {
                    const st = safeStat(join(dirPath, f));
                    if (st && st.mtimeMs > lastMtime) lastMtime = st.mtimeMs;
                }
            } catch { /* skip */ }

            const dirSt = safeStat(dirPath);
            if (!lastMtime && dirSt) lastMtime = dirSt.mtimeMs;

            sessionItems.push({
                type:       'session',
                id:         e.name,
                path:       dirPath,
                name:       dbRec?.name || e.name,
                size,
                sizeStr:    fmtBytes(size),
                fileCount,
                status:     dbRec?.status || null,
                eventCount: dbRec?.event_count || 0,
                projectId:  dbRec?.project_id || null,
                createdAt:  dbRec?.created_at || null,
                mtime:      lastMtime,
                ageStr:     fmtAge(lastMtime || Date.now()),
                orphan:     isOrphan,
            });
        }
    }

    // ── 3. projects 目录扫描 ───────────────────────────────────────────────
    const projectItems = [];
    let projectsTotal  = 0;

    const dbProjects = _safeDbAll(
        'SELECT id, name, created_at, status, iid_count FROM projects ORDER BY created_at DESC'
    );
    const dbProjectIds = new Set(dbProjects.map(p => p.id));

    if (existsSync(PROJECTS_DIR)) {
        const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const dirPath = join(PROJECTS_DIR, e.name);
            const { size, fileCount } = dirStats(dirPath);
            projectsTotal += size;

            const dbRec   = dbProjects.find(p => p.id === e.name);
            const isOrphan = !dbProjectIds.has(e.name);

            let lastMtime = 0;
            try {
                const files = readdirSync(dirPath);
                for (const f of files) {
                    const st = safeStat(join(dirPath, f));
                    if (st && st.mtimeMs > lastMtime) lastMtime = st.mtimeMs;
                }
            } catch { /* skip */ }

            const dirSt = safeStat(dirPath);
            if (!lastMtime && dirSt) lastMtime = dirSt.mtimeMs;

            projectItems.push({
                type:      'project',
                id:        e.name,
                path:      dirPath,
                name:      dbRec?.name || e.name,
                size,
                sizeStr:   fmtBytes(size),
                fileCount,
                status:    dbRec?.status || null,
                iidCount:  dbRec?.iid_count || 0,
                createdAt: dbRec?.created_at || null,
                mtime:     lastMtime,
                ageStr:    fmtAge(lastMtime || Date.now()),
                orphan:    isOrphan,
            });
        }
    }

    // ── 4. 数据库文件 ──────────────────────────────────────────────────────
    const dbStat = safeStat(DB_FILE);
    const dbSize = dbStat ? dbStat.size : 0;

    // ── 5. 汇总 ────────────────────────────────────────────────────────────
    const totalSize = uploadsTotal + sessionsTotal + projectsTotal + dbSize;

    // ── 6. 生成删除建议 ────────────────────────────────────────────────────
    const suggestions = _buildSuggestions({
        uploadFiles,
        sessionItems,
        projectItems,
        dbSize,
        totalSize,
    });

    return {
        summary: {
            totalSize,
            totalSizeStr: fmtBytes(totalSize),
            breakdown: {
                uploads:  { size: uploadsTotal,  sizeStr: fmtBytes(uploadsTotal),  count: uploadFiles.length },
                sessions: { size: sessionsTotal, sizeStr: fmtBytes(sessionsTotal), count: sessionItems.length },
                projects: { size: projectsTotal, sizeStr: fmtBytes(projectsTotal), count: projectItems.length },
                database: { size: dbSize,        sizeStr: fmtBytes(dbSize) },
            },
        },
        uploads:  uploadFiles,
        sessions: sessionItems.sort((a, b) => b.size - a.size),
        projects: projectItems.sort((a, b) => b.size - a.size),
        suggestions,
    };
}

/**
 * 检查 upload 文件是否被 sessions 或 projects 表引用
 * multer 上传的临时文件路径存储在 bin_path / source_file 等字段中
 */
function _isUploadReferenced(filePath) {
    try {
        const s = _safeDbGet(
            'SELECT id FROM sessions WHERE bin_path = ? OR source_file = ? OR smap_path = ? LIMIT 1',
            [filePath, filePath, filePath]
        );
        if (s) return true;

        const p = _safeDbGet(
            'SELECT id FROM projects WHERE source_file = ? OR instrumented_path = ? OR smap_path = ? LIMIT 1',
            [filePath, filePath, filePath]
        );
        return !!p;
    } catch { return true; } // 保守：出错时认为仍被引用
}

/**
 * 生成删除建议列表
 * 每条建议包含：category（分类）、reason（原因）、items（可选 item 数组）、
 * savedSize（可释放空间）、savedSizeStr、priority（high/medium/low）
 */
function _buildSuggestions({ uploadFiles, sessionItems, projectItems, dbSize, totalSize }) {
    const suggestions = [];

    // ── 建议 1：清理孤立 upload 临时文件 ──────────────────────────────────
    const orphanUploads = uploadFiles.filter(f => f.orphan);
    if (orphanUploads.length > 0) {
        const savedSize = orphanUploads.reduce((s, f) => s + f.size, 0);
        suggestions.push({
            id:          'orphan-uploads',
            priority:    'high',
            category:    'uploads',
            title:       `清理 ${orphanUploads.length} 个孤立上传临时文件`,
            description: 'multer 上传后未被任何会话或工作空间引用的文件，可安全删除。',
            savedSize,
            savedSizeStr: fmtBytes(savedSize),
            items:       orphanUploads.map(f => ({ path: f.path, name: f.name, size: f.size, sizeStr: f.sizeStr, ageStr: f.ageStr })),
        });
    }

    // ── 建议 2：清理孤立 session 目录 ─────────────────────────────────────
    const orphanSessions = sessionItems.filter(s => s.orphan);
    if (orphanSessions.length > 0) {
        const savedSize = orphanSessions.reduce((s, i) => s + i.size, 0);
        suggestions.push({
            id:          'orphan-sessions',
            priority:    'high',
            category:    'sessions',
            title:       `清理 ${orphanSessions.length} 个孤立会话目录`,
            description: '会话目录存在但数据库中已无对应记录，属于残留数据，可安全删除。',
            savedSize,
            savedSizeStr: fmtBytes(savedSize),
            items:       orphanSessions.map(s => ({ path: s.path, id: s.id, size: s.size, sizeStr: s.sizeStr, ageStr: s.ageStr })),
        });
    }

    // ── 建议 3：清理孤立 project 目录 ─────────────────────────────────────
    const orphanProjects = projectItems.filter(p => p.orphan);
    if (orphanProjects.length > 0) {
        const savedSize = orphanProjects.reduce((s, i) => s + i.size, 0);
        suggestions.push({
            id:          'orphan-projects',
            priority:    'high',
            category:    'projects',
            title:       `清理 ${orphanProjects.length} 个孤立工作空间目录`,
            description: '工作空间目录存在但数据库中已无对应记录，属于残留数据，可安全删除。',
            savedSize,
            savedSizeStr: fmtBytes(savedSize),
            items:       orphanProjects.map(p => ({ path: p.path, id: p.id, size: p.size, sizeStr: p.sizeStr, ageStr: p.ageStr })),
        });
    }

    // ── 建议 4：清理失败的工作空间 ────────────────────────────────────────
    const failedProjects = projectItems.filter(p => p.status === 'failed');
    if (failedProjects.length > 0) {
        const savedSize = failedProjects.reduce((s, i) => s + i.size, 0);
        suggestions.push({
            id:          'failed-projects',
            priority:    'medium',
            category:    'projects',
            title:       `删除 ${failedProjects.length} 个插桩失败的工作空间`,
            description: '插桩失败的工作空间占用磁盘但无法使用，建议删除后重新上传。',
            savedSize,
            savedSizeStr: fmtBytes(savedSize),
            items:       failedProjects.map(p => ({ path: p.path, id: p.id, name: p.name, size: p.size, sizeStr: p.sizeStr, ageStr: p.ageStr })),
        });
    }

    // ── 建议 5：清理超过指定天数的旧会话（体积超过阈值）─────────────────
    const _oldSessionDays   = cfg('storage.oldSessionDays');
    const _oldSessionMinMb  = cfg('storage.oldSessionMinMb');
    const OLD_THRESHOLD     = _oldSessionDays * 24 * 3600 * 1000;
    const OLD_SIZE_THRESHOLD = _oldSessionMinMb * 1024 * 1024;
    const oldSessions = sessionItems.filter(
        s => !s.orphan && s.size > OLD_SIZE_THRESHOLD && (Date.now() - s.mtime) > OLD_THRESHOLD
    );
    if (oldSessions.length > 0) {
        const savedSize = oldSessions.reduce((s, i) => s + i.size, 0);
        suggestions.push({
            id:          'old-sessions',
            priority:    'low',
            category:    'sessions',
            title:       `${oldSessions.length} 个大型旧会话超过 ${_oldSessionDays} 天未使用`,
            description: `这些会话体积超过 ${_oldSessionMinMb} MB 且 ${_oldSessionDays} 天内未被访问，如不再需要可删除以释放空间。`,
            savedSize,
            savedSizeStr: fmtBytes(savedSize),
            items:       oldSessions.map(s => ({
                path: s.path, id: s.id, name: s.name, size: s.size, sizeStr: s.sizeStr, ageStr: s.ageStr,
                sessionId: s.id,
            })),
        });
    }

    // ── 建议 6：整体空间充足时给出正面反馈 ───────────────────────────────
    if (suggestions.length === 0) {
        suggestions.push({
            id:          'all-clean',
            priority:    'info',
            category:    'general',
            title:       '空间使用良好，无需清理',
            description: `当前 data 目录总占用 ${fmtBytes(totalSize)}，未发现孤立文件或明显可释放空间。`,
            savedSize:   0,
            savedSizeStr: '0 B',
            items:       [],
        });
    }

    return suggestions;
}

// ── POST /api/storage/delete ────────────────────────────────────────────────

router.post('/delete', async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be a non-empty array' });
        }

        const results  = [];
        let   freed    = 0;

        for (const item of items) {
            const r = await _deleteItem(item);
            results.push(r);
            if (r.ok) freed += r.freedSize || 0;
        }

        res.json({
            results,
            freed,
            freedStr: fmtBytes(freed),
            successCount: results.filter(r => r.ok).length,
            errorCount:   results.filter(r => !r.ok).length,
        });
    } catch (e) {
        log.error({ err: e }, '[POST /api/storage/delete] error');
        res.status(500).json({ error: e.message });
    }
});

/**
 * 删除单个 item
 * item: { type: 'upload'|'session_dir'|'project_dir', path, id? }
 * 安全约束：路径必须在 DATA_DIR 内
 */
async function _deleteItem(item) {
    const { type, path: itemPath, id } = item;

    // ── 安全校验：路径必须在 DATA_DIR 子目录内 ────────────────────────────
    const absPath = resolve(itemPath);
    if (!absPath.startsWith(DATA_DIR + '/') && absPath !== DATA_DIR) {
        return { ok: false, path: itemPath, error: 'Path outside data directory — rejected for safety' };
    }

    // 禁止直接删除 DATA_DIR 本身
    if (absPath === DATA_DIR) {
        return { ok: false, path: itemPath, error: 'Cannot delete root data directory' };
    }

    // 禁止删除 DB 文件
    if (absPath === DB_FILE) {
        return { ok: false, path: itemPath, error: 'Cannot delete database file' };
    }

    const st = safeStat(absPath);
    if (!st) {
        return { ok: false, path: itemPath, error: 'Path not found', type };
    }

    const freedSize = st.isDirectory()
        ? dirStats(absPath).size
        : st.size;

    try {
        switch (type) {
            case 'upload': {
                // 再次检查是否被引用（防止竞态）
                if (_isUploadReferenced(absPath)) {
                    return { ok: false, path: itemPath, error: 'File is still referenced by a session or project' };
                }
                rmSync(absPath, { force: true });
                break;
            }

            case 'session_dir': {
                // 删除 session 目录及数据库记录
                rmSync(absPath, { recursive: true, force: true });
                if (id) {
                    try { db.run('DELETE FROM sessions WHERE id = ?', id); } catch { /* ignore */ }
                    try { db.run('DELETE FROM plugin_checkpoints WHERE session_id = ?', id); } catch { /* ignore */ }
                }
                break;
            }

            case 'project_dir': {
                // 删除 project 目录及数据库记录
                rmSync(absPath, { recursive: true, force: true });
                if (id) {
                    try { db.run('UPDATE sessions SET project_id = NULL WHERE project_id = ?', id); } catch { /* ignore */ }
                    try { db.run('DELETE FROM projects WHERE id = ?', id); } catch { /* ignore */ }
                }
                break;
            }

            default:
                return { ok: false, path: itemPath, error: `Unknown item type: ${type}` };
        }

        log.info({ type, path: absPath, freedSize }, `[storage/delete] deleted ${type}: ${absPath}`);
        return { ok: true, path: itemPath, type, freedSize };

    } catch (e) {
        log.error({ err: e, path: absPath }, '[storage/delete] delete error');
        return { ok: false, path: itemPath, type, error: e.message };
    }
}

// ── POST /api/storage/vacuum ────────────────────────────────────────────────
// 执行 WAL checkpoint（将 WAL 文件合并回主库）+ VACUUM（重建数据库，回收空闲页）。
// VACUUM 在大型数据库上可能耗时较长（秒级），期间数据库被独占锁定。
// 不能在事务内执行，better-sqlite3 的同步 API 直接调用即可。

router.post('/vacuum', (req, res) => {
    try {
        const rawDb = db.raw();

        // 1. WAL checkpoint：将 WAL 文件内容合并回主数据库文件并截断 WAL
        const cpResult = rawDb.pragma('wal_checkpoint(TRUNCATE)');
        log.info({ cpResult }, '[storage/vacuum] WAL checkpoint done');

        // 2. 记录 VACUUM 前的文件大小
        const sizeBefore = safeStat(DB_FILE)?.size ?? 0;

        // 3. VACUUM：重建整个数据库文件，回收所有空闲页的磁盘空间
        rawDb.exec('VACUUM');

        // 4. 统计节省的空间
        const sizeAfter  = safeStat(DB_FILE)?.size ?? 0;
        const freed      = Math.max(0, sizeBefore - sizeAfter);

        log.info({ sizeBefore, sizeAfter, freed }, '[storage/vacuum] VACUUM done');

        res.json({
            ok:           true,
            sizeBefore,
            sizeAfter,
            freed,
            sizeBeforeStr: fmtBytes(sizeBefore),
            sizeAfterStr:  fmtBytes(sizeAfter),
            freedStr:      fmtBytes(freed),
        });
    } catch (e) {
        log.error({ err: e }, '[POST /api/storage/vacuum] error');
        res.status(500).json({ error: e.message });
    }
});

// ── 数据库帮助函数（防止 DB 未初始化时崩溃）──────────────────────────────

function _safeDbAll(sql, params) {
    try {
        return params ? db.all(sql, params) : db.all(sql);
    } catch { return []; }
}

function _safeDbGet(sql, params) {
    try {
        return params ? db.get(sql, params) : db.get(sql);
    } catch { return undefined; }
}

export default router;
