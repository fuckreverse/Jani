/**
 * routes/sessions.mjs — 分析会话 REST API
 *
 * POST /api/sessions                    上传 .bin + .smap.json（可选）+ .js（可选），创建新会话
 * GET  /api/sessions                    列出所有会话
 * GET  /api/sessions/:id                会话详情 + 插件状态
 * GET  /api/sessions/:id/checkpoints    查询插件断点恢复状态
 * GET  /api/sessions/:id/events         查询事件（支持分页 + 过滤）
 * POST /api/sessions/:id/re-run         重新触发指定 phase 或插件列表的分析
 * POST /api/sessions/:id/run-phase3     (向后兼容) 手动触发 Phase 3
 * POST /api/sessions/:id/run-phase4     (向后兼容) 手动触发 Phase 4
 */

import { Router } from 'express';
import { createLogger } from '../logger.mjs';

const log = createLogger('sessions');
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db/Database.mjs';
import { decodeType, TYPE } from '../db/EventTypeCode.mjs';
import { schedule, autoDiscover, getCheckpoints, clearCheckpoints } from '../PluginEngine.mjs';

const router = Router();
const __dirname = resolve(new URL('.', import.meta.url).pathname);
const DATA_DIR = resolve(__dirname, '../data/sessions');

// 确保数据目录存在
mkdirSync(DATA_DIR, { recursive: true });

// ── 分阶段插件定义 ─────────────────────────────────────────────────────────────

/**
 * Phase 1（基础解析，创建会话时立即执行）：F1-EventIndex（+F2 如有 smap）
 * Phase 2（自动，Phase1 完成后继续后台执行）：F3 / F4 / A3
 * Phase 3（手动按需）：A5 / A8 / I1 / I2
 * Phase 4（手动按需）：A2 / A4 / A6 / A7 / I3 / I4
 */
const PHASE1_PLUGINS = ['F1-EventIndex'];
const PHASE2_PLUGINS = ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'];
const PHASE3_PLUGINS = ['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer'];
const PHASE4_PLUGINS = [
    'A2-DataFlowGraph',
    'A4-StringTracker',
    'A6-FunctionSignatureInfer',
    'A7-ObjectMutationTracker',
    'I3-ObfuscationDetector',
    'I4-AlgorithmSummarizer',
];

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
        const binDest = resolve(sessionDir, binFile.originalname || 'trace.bin');
        copyFileSync(binFile.path, binDest);

        // 可选：smap 文件
        const smapFile = files?.smap?.[0] ?? files?.['smap']?.[0];
        let smapDest = null;
        if (smapFile) {
            smapDest = resolve(sessionDir, smapFile.originalname || 'trace.smap.json');
            copyFileSync(smapFile.path, smapDest);
        }

        // 可选：原始 JS 文件
        const sourceFile = files?.source?.[0] ?? files?.['source']?.[0];
        let sourceDest = null;
        if (sourceFile) {
            sourceDest = resolve(sessionDir, sourceFile.originalname || 'source.js');
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
        const phase1Plugins = [...PHASE1_PLUGINS];
        if (smapDest) phase1Plugins.push('F2-SmapLoader');

        // 异步执行 Phase 1，完成后自动触发 Phase 2
        autoDiscover().then(() =>
            schedule(sessionId, {
                plugins: phase1Plugins,
                dataDir: sessionDir,
                phase: 'phase1',
                skipCompleted: true,
                onProgress: (evt) => {
                    wsProgressBroadcast?.(sessionId, evt);
                    // Phase 1 全部完成后，自动后台调度 Phase 2
                    if (evt.type === 'all_done' && evt.phase === 'phase1') {
                        _schedulePhase2(sessionId, sessionDir, wsProgressBroadcast, !!smapDest);
                    }
                },
            })
        ).catch(e => {
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
        return res.status(500).json({ error: e.message });
    }
});

/**
 * 后台调度 Phase 2（在 Phase 1 完成后自动触发）
 */
async function _schedulePhase2(sessionId, sessionDir, wsProgressBroadcast, _hasSmap) {
    try {
        db.run("UPDATE sessions SET status = 'indexing' WHERE id = ?", sessionId);
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
        log.error({ err: e }, '[sessions] phase2 schedule error:');
        wsProgressBroadcast?.(sessionId, { type: 'error', sessionId, phase: 'phase2', message: e.message });
    }
}

// ── GET /api/sessions ──────────────────────────────────────────────────────

router.get('/', (req, res) => {
    try {
        const sessions = db.all(
            `SELECT id, name, created_at, source_file, status, event_count, plugin_status
             FROM sessions
             ORDER BY created_at DESC`
        );

        const result = sessions.map(s => ({
            ...s,
            plugin_status: safeParseJson(s.plugin_status, {}),
        }));

        return res.json(result);
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions] error:');
        return res.status(500).json({ error: e.message });
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

        return res.json({
            ...session,
            plugin_status: safeParseJson(session.plugin_status, {}),
            fileInfo,
            smapCount,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id] error:');
        return res.status(500).json({ error: e.message });
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
        const TABLES_WITH_SESSION = [
            'events', 'writes', 'reads', 'fields', 'smap',
            'call_edges', 'taint_paths', 'var_lifetime', 'scopes',
            'bookmarks', 'iid_counts', 'loops', 'loop_iterations',
            'string_events', 'fn_signatures', 'object_timelines', 'value_patterns',
            'crypto_hints', 'signature_paths', 'obfuscation_hints', 'analysis_summary',
            'dataflow_edges', 'value_index', 'plugin_checkpoints',
        ];
        db.transaction(() => {
            for (const table of TABLES_WITH_SESSION) {
                try {
                    db.run(`DELETE FROM ${table} WHERE session_id = ?`, id);
                } catch { /* 表不存在时忽略 */ }
            }
            // 删除 sessions 主记录
            db.run('DELETE FROM sessions WHERE id = ?', id);
        });

        return res.json({ deleted: true });
    } catch (e) {
        log.error({ err: e }, '[DELETE /api/sessions/:id] error:');
        return res.status(500).json({ error: e.message });
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
        res.status(500).json({ error: e.message });
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
            phase = 'phase3',
            forceRerun = false,
        } = req.body ?? {};

        // 确定要运行的插件列表
        let targetPlugins;
        if (plugins && Array.isArray(plugins) && plugins.length > 0) {
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

        // 强制重跑：清除指定插件的检查点
        if (forceRerun) {
            for (const pluginId of targetPlugins) {
                clearCheckpoints(id, pluginId);
            }
        }

        const sessionDir = resolve(DATA_DIR, id);
        const wsProgressBroadcast = req.app.get('wsProgressBroadcast');

        await autoDiscover();

        schedule(id, {
            plugins: targetPlugins,
            dataDir: sessionDir,
            phase,
            skipCompleted: !forceRerun,
            onProgress: (evt) => {
                wsProgressBroadcast?.(id, evt);
            },
        }).catch(e => {
            log.error({ err: e }, '[re-run] schedule error:');
            wsProgressBroadcast?.(id, { type: 'error', sessionId: id, message: e.message });
        });

        return res.json({ status: 'scheduled', plugins: targetPlugins, phase, forceRerun });
    } catch (e) {
        log.error({ err: e }, '[POST /api/sessions/:id/re-run] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/event-types ────────────────────────────────────
// 返回该会话存在的所有事件类型及其数量

router.get('/:id/event-types', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const rows = db.all(
            `SELECT type, COUNT(*) as cnt FROM events WHERE session_id = ? GROUP BY type ORDER BY cnt DESC`,
            id
        );
        // type 列为整数编码（Phase D），解码为字符串返回前端
        return res.json({ types: rows.map(r => ({ type: decodeType(r.type), cnt: r.cnt })) });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/event-types] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/events ──────────────────────────────────────────

router.get('/:id/events', (req, res) => {
    try {
        const { id } = req.params;
        const {
            line,
            type,
            types,       // 多选，逗号分隔，如 "CALL_PRE,CALL"
            varName,
            seqFrom,
            seqTo,
            limit  = '100',
            offset = '0',   // 向后兼容，推荐改用 cursor
            cursor,         // 游标分页：上次返回的最后一个 seq，下次从 id > cursor 开始
        } = req.query;

        // 检查 session 是否存在
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) {
            return res.status(404).json({ error: `Session ${id} not found` });
        }

        // 构建查询
        const conditions = ['e.session_id = ?'];
        const params = [id];

        // line 已从 events 移除（Phase D），通过 smap 过滤
        if (line !== undefined) {
            conditions.push(`EXISTS (SELECT 1 FROM smap s WHERE s.session_id = e.session_id AND s.iid = e.iid AND s.sl = ?)`);
            params.push(Number(line));
        }
        // types 多选（优先），type 单选（向后兼容）
        // type 列为整数编码（Phase D），过滤时将字符串转为整数
        if (types) {
            const typeList = types.split(',').map(t => t.trim()).filter(Boolean);
            const typeCodes = typeList.map(t => TYPE[t] ?? 0);
            if (typeCodes.length === 1) {
                conditions.push('e.type = ?');
                params.push(typeCodes[0]);
            } else if (typeCodes.length > 1) {
                conditions.push(`e.type IN (${typeCodes.map(() => '?').join(',')})`);
                params.push(...typeCodes);
            }
        } else if (type) {
            conditions.push('e.type = ?');
            params.push(TYPE[type] ?? 0);
        }
        if (seqFrom !== undefined) {
            conditions.push('e.id >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined) {
            conditions.push('e.id <= ?');
            params.push(Number(seqTo));
        }
        // 游标分页：cursor 优先于 offset（O(1) 深页访问）
        if (cursor !== undefined) {
            conditions.push('e.id > ?');
            params.push(Number(cursor));
        }

        // varName：在 writes 或 reads 中包含该变量名
        if (varName) {
            conditions.push(`(
                EXISTS (SELECT 1 FROM writes w WHERE w.session_id = e.session_id AND w.event_id = e.id AND w.name = ?)
                OR EXISTS (SELECT 1 FROM reads  r WHERE r.session_id = e.session_id AND r.event_id = e.id AND r.name = ?)
            )`);
            params.push(varName, varName);
        }

        const where = conditions.join(' AND ');
        const limitN  = Math.min(Number(limit)  || 100, 1000);
        // 游标模式不使用 OFFSET（O(1) 定位）；offset 仅向后兼容
        const offsetN = cursor !== undefined ? 0 : (Number(offset) || 0);

        // line/col/src_text 已从 events 移除（Phase D），LEFT JOIN smap 获取
        const events = db.all(
            `SELECT e.id AS seq, e.type, e.iid,
                    s.sl AS line, s.sc AS col, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE ${where}
             ORDER BY e.id ASC
             LIMIT ? OFFSET ?`,
            ...params, limitN, offsetN
        );

        // 批量查询 writes/reads/fields
        const eventIds = events.map(e => e.seq);
        let writes = [], reads = [], fields = [];

        if (eventIds.length > 0) {
            const placeholders = eventIds.map(() => '?').join(',');
            writes = db.all(
                `SELECT event_id, name, value, omitted FROM writes WHERE session_id = ? AND event_id IN (${placeholders})`,
                id, ...eventIds
            );
            reads = db.all(
                `SELECT event_id, name, value, omitted FROM reads WHERE session_id = ? AND event_id IN (${placeholders})`,
                id, ...eventIds
            );
            fields = db.all(
                `SELECT event_id, base, offset, is_write, value, omitted FROM fields WHERE session_id = ? AND event_id IN (${placeholders})`,
                id, ...eventIds
            );
        }

        // Phase D: line/col/src_text 已通过 LEFT JOIN smap 直接获取，无需再做补全

        // 按 event_id 分组
        const writesMap  = groupBy(writes,  'event_id');
        const readsMap   = groupBy(reads,   'event_id');
        const fieldsMap  = groupBy(fields,  'event_id');

        // 组合结果
        const result = events.map(e => {
            return {
                seq:      e.seq,
                type:     decodeType(e.type),  // 整数 → 字符串（Phase D）
                iid:      e.iid,
                line:     e.line ?? null,
                col:      e.col  ?? null,
                srcText:  e.src_text ?? null,
                writes:   (writesMap[e.seq] || []).map(w => ({
                    name:    w.name,
                    value:   safeParseJson(w.value),
                    omitted: !!w.omitted,
                })),
                reads:    (readsMap[e.seq] || []).map(r => ({
                    name:    r.name,
                    value:   safeParseJson(r.value),
                    omitted: !!r.omitted,
                })),
                fields:   (fieldsMap[e.seq] || []).map(f => ({
                    base:    f.base,
                    offset:  f.offset,
                    isWrite: !!f.is_write,
                    value:   safeParseJson(f.value),
                    omitted: !!f.omitted,
                })),
            };
        });

        // 游标：返回本页最后一条的 seq，供下次请求使用
        const nextCursor = result.length === limitN ? result[result.length - 1].seq : null;

        return res.json({
            sessionId: id,
            events: result,
            count:  result.length,
            hasMore: result.length === limitN,
            nextCursor,
        });

    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/events] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/functions ──────────────────────────────────────
// 按 fn_name 聚合 call_edges，返回函数列表（调用次数、行号等）

router.get('/:id/functions', (req, res) => {
    try {
        const { id } = req.params;
        const {
            search   = '',
            minCalls = '1',
            limit    = '100',
            offset   = '0',
            fnIid,           // 精确 iid 过滤（跨 Tab 跳转时使用）
        } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (search) {
            conditions.push('fn_name LIKE ?');
            params.push(`%${search}%`);
        }
        if (fnIid !== undefined && fnIid !== '') {
            conditions.push('fn_iid = ?');
            params.push(Number(fnIid));
        }

        const minCallsN = Math.max(1, Number(minCalls) || 1);
        const limitN    = Math.min(Number(limit)  || 100, 500);
        const offsetN   = Number(offset) || 0;

        // 每个函数名聚合：调用次数、最小行号、call_seq 范围
        const rows = db.all(
            `SELECT
                fn_name,
                fn_iid,
                COUNT(*)           AS call_count,
                MIN(caller_line)   AS min_line,
                MIN(depth)         AS min_depth,
                MAX(depth)         AS max_depth
             FROM call_edges
             WHERE ${conditions.join(' AND ')}
             GROUP BY fn_name, fn_iid
             HAVING COUNT(*) >= ?
             ORDER BY call_count DESC
             LIMIT ? OFFSET ?`,
            ...params, minCallsN, limitN, offsetN
        );

        // 总数（用于分页）：用 CTE 对聚合结果再计数，完全避免相关子查询
        const totalRow = db.get(
            `SELECT COUNT(*) AS total
             FROM (
               SELECT fn_name
               FROM call_edges
               WHERE ${conditions.join(' AND ')}
               GROUP BY fn_name, fn_iid
               HAVING COUNT(*) >= ?
             )`,
            ...params, minCallsN
        );

        return res.json({
            functions: rows,
            count: rows.length,
            total: totalRow?.total ?? rows.length,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/functions] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/functions/:fnName/calls ─────────────────────────
// 返回某函数名下所有调用记录（含参数、返回值、SEQ 范围）

router.get('/:id/functions/:fnName/calls', (req, res) => {
    try {
        const { id, fnName } = req.params;
        const { limit = '200', offset = '0', fnIid, callSeq } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        const limitN  = Math.min(Number(limit)  || 200, 1000);

        // 支持按 fn_iid 精确过滤，避免同名不同位置的函数调用混在一起
        const conditions = ['session_id = ?', 'fn_name = ?'];
        const baseParams = [id, fnName];
        if (fnIid !== undefined && fnIid !== '') {
            conditions.push('fn_iid = ?');
            baseParams.push(Number(fnIid));
        }
        const where = conditions.join(' AND ');

        const total = db.get(
            `SELECT COUNT(*) AS cnt FROM call_edges WHERE ${where}`,
            ...baseParams
        )?.cnt ?? 0;

        // callSeq 定位：计算目标调用在第几条（rank），从而得到正确的 offset
        // 这样前端不需要翻页，直接跳到包含该调用的那页
        let offsetN = Number(offset) || 0;
        let targetCallId = null;
        if (callSeq !== undefined && callSeq !== '') {
            const callSeqN = Number(callSeq);
            const rankRow = db.get(
                `SELECT COUNT(*) AS rank FROM call_edges
                 WHERE ${where} AND call_seq < ?
                 ORDER BY call_seq ASC`,
                ...baseParams, callSeqN
            );
            if (rankRow) {
                // rank 是目标调用之前有多少条，即它的 0-based 位置
                offsetN = Math.floor(rankRow.rank / limitN) * limitN;
            }
            // 记录目标 call 的 id，供前端高亮
            const targetRow = db.get(
                `SELECT id FROM call_edges WHERE ${where} AND call_seq = ?`,
                ...baseParams, callSeqN
            );
            targetCallId = targetRow?.id ?? null;
        }

        const rows = db.all(
            `SELECT id, call_seq, return_seq, caller_line, fn_name, fn_iid, args_json, return_value, depth
             FROM call_edges
             WHERE ${where}
             ORDER BY call_seq ASC
             LIMIT ? OFFSET ?`,
            ...baseParams, limitN, offsetN
        );

        const result = rows.map(r => ({
            id:           r.id,
            callSeq:      r.call_seq,
            returnSeq:    r.return_seq,
            callerLine:   r.caller_line,
            fnName:       r.fn_name,
            fnIid:        r.fn_iid,
            args:         safeParseJson(r.args_json, []),
            returnValue:  safeParseJson(r.return_value, null),
            depth:        r.depth,
        }));

        return res.json({ calls: result, count: result.length, total, targetCallId, offset: offsetN });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/functions/:fnName/calls] error:');
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/call-graph ──────────────────────────────────────

router.get('/:id/call-graph', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const edges = db.all(
            'SELECT * FROM call_edges WHERE session_id = ? ORDER BY call_seq ASC LIMIT 1000',
            id
        );

        // 构建节点（按 fn_name 去重）
        const nodesMap = new Map();
        for (const e of edges) {
            const key = e.fn_name || `fn@${e.fn_iid}`;
            if (!nodesMap.has(key)) nodesMap.set(key, { id: key, label: key, callCount: 0 });
            nodesMap.get(key).callCount++;
        }

        res.json({
            nodes: [...nodesMap.values()].map(n => ({ data: n })),
            edges: edges.map(e => ({
                data: {
                    id: `e${e.id}`,
                    source: `caller@${e.caller_line}`,
                    target: e.fn_name || `fn@${e.fn_iid}`,
                    callSeq: e.call_seq,
                    returnSeq: e.return_seq,
                    depth: e.depth,
                    argsJson: e.args_json,
                    returnValue: e.return_value,
                }
            })),
            rawEdges: edges,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/hot-iids ────────────────────────────────────────

router.get('/:id/hot-iids', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const hotIids = db.all(
            'SELECT iid, count, line, src_text FROM iid_counts WHERE session_id = ? ORDER BY count DESC LIMIT 200',
            id
        );
        const loops = db.all(
            'SELECT * FROM loops WHERE session_id = ? ORDER BY iteration_count DESC',
            id
        );
        res.json({ hotIids, loops });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/var-lifetime ────────────────────────────────────

router.get('/:id/var-lifetime', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const rows = db.all(
            'SELECT * FROM var_lifetime WHERE session_id = ? ORDER BY write_count DESC LIMIT 500',
            id
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/sessions/:id/taint ──────────────────────────────────────────

router.post('/:id/taint', async (req, res) => {
    try {
        const { id } = req.params;
        const { sourceVar, sourceEventId, direction = 'forward' } = req.body;

        if (!sourceVar && !sourceEventId) {
            return res.status(400).json({ error: 'sourceVar or sourceEventId required' });
        }

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const { runSinglePlugin } = await import('../PluginEngine.mjs');

        await runSinglePlugin(id, 'A1-TaintTracker', {
            extraCtx: { sourceVar, sourceEventId, direction },
            onProgress: (evt) => {
                req.app.get('wsProgressBroadcast')?.(id, evt);
            },
        });

        const paths = db.all(
            'SELECT * FROM taint_paths WHERE session_id = ? AND source_var = ? ORDER BY id DESC LIMIT 50',
            [id, sourceVar || '']
        );
        res.json({ paths });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/loop-iterations ─────────────────────────────────

router.get('/:id/loop-iterations', (req, res) => {
    try {
        const { id } = req.params;
        const { loopId, limit = '200', offset = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (loopId !== undefined) {
            conditions.push('loop_id = ?');
            params.push(Number(loopId));
        }

        const limitN  = Math.min(Number(limit)  || 200, 1000);
        const offsetN = Number(offset) || 0;

        const rows = db.all(
            `SELECT id, loop_id, iteration_idx, start_seq, end_seq, vars_snapshot
             FROM loop_iterations
             WHERE ${conditions.join(' AND ')}
             ORDER BY loop_id ASC, iteration_idx ASC
             LIMIT ? OFFSET ?`,
            ...params, limitN, offsetN
        );

        const result = rows.map(r => ({
            ...r,
            vars_snapshot: safeParseJson(r.vars_snapshot, {}),
        }));

        // 同时返回循环列表（供前端 loop_id 选择）
        const loops = db.all(
            'SELECT id, iid, start_seq, end_seq, iteration_count, line FROM loops WHERE session_id = ? ORDER BY id ASC',
            id
        );

        res.json({ loops, iterations: result, count: result.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/loop-iterations] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-patterns ──────────────────────────────────

router.get('/:id/value-patterns', (req, res) => {
    try {
        const { id } = req.params;
        const { onlyCrypto, limit = '500' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (onlyCrypto === '1' || onlyCrypto === 'true') {
            conditions.push('matched_constant IS NOT NULL');
        }

        const limitN = Math.min(Number(limit) || 500, 2000);

        const rows = db.all(
            `SELECT id, value_hash, count, first_seq, iid, var_name, line, matched_constant
             FROM value_patterns
             WHERE ${conditions.join(' AND ')}
             ORDER BY count DESC
             LIMIT ?`,
            ...params, limitN
        );

        res.json({ patterns: rows, count: rows.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-patterns] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/crypto-hints ────────────────────────────────────

router.get('/:id/crypto-hints', (req, res) => {
    try {
        const { id } = req.params;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const rows = db.all(
            `SELECT id, algorithm, confidence, evidence, iid, line, fn_name
             FROM crypto_hints
             WHERE session_id = ?
             ORDER BY confidence DESC`,
            id
        );

        const result = rows.map(r => ({
            ...r,
            evidence: safeParseJson(r.evidence, []),
        }));

        res.json({ hints: result, count: result.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/crypto-hints] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/signature-paths ────────────────────────────────

router.get('/:id/signature-paths', (req, res) => {
    try {
        const { id } = req.params;
        const { field } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (field) {
            conditions.push('field_name = ?');
            params.push(field);
        }

        const rows = db.all(
            `SELECT id, field_name, sink_event_id, path_json, summary, input_vars, hops
             FROM signature_paths
             WHERE ${conditions.join(' AND ')}
             ORDER BY hops ASC, id ASC`,
            ...params
        );

        const result = rows.map(r => ({
            ...r,
            path_json: safeParseJson(r.path_json, []),
            input_vars: safeParseJson(r.input_vars, []),
        }));

        res.json({ paths: result, count: result.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/signature-paths] error:');
        res.status(500).json({ error: e.message });
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

        if (forceRerun) {
            for (const pluginId of plugins) clearCheckpoints(id, pluginId);
        }

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
        return res.status(500).json({ error: e.message });
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

        if (forceRerun) {
            for (const pluginId of plugins) clearCheckpoints(id, pluginId);
        }

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
        return res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/dataflow ────────────────────────────────────────

router.get('/:id/dataflow', (req, res) => {
    try {
        const { id } = req.params;
        const { edgeType, varName, limit = '500' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (edgeType) {
            conditions.push('edge_type = ?');
            params.push(edgeType);
        }
        if (varName) {
            conditions.push('(from_var = ? OR to_var = ?)');
            params.push(varName, varName);
        }

        const limitN = Math.min(Number(limit) || 500, 2000);
        const edges = db.all(
            `SELECT id, from_event_id, to_event_id, from_var, to_var, edge_type, iid, line
             FROM dataflow_edges
             WHERE ${conditions.join(' AND ')}
             ORDER BY id ASC
             LIMIT ?`,
            [...params, limitN]
        );

        // 汇总统计
        const stats = db.all(
            'SELECT edge_type, COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ? GROUP BY edge_type ORDER BY cnt DESC',
            [id]
        );

        res.json({ edges, stats, count: edges.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/dataflow] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/strings ─────────────────────────────────────────

router.get('/:id/strings', (req, res) => {
    try {
        const { id } = req.params;
        const { encoding, limit = '500', offset = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (encoding) {
            conditions.push('encoding_hint = ?');
            params.push(encoding);
        }

        const limitN = Math.min(Number(limit) || 500, 2000);
        const offsetN = Number(offset) || 0;

        const rows = db.all(
            `SELECT id, event_id, value, var_name, line, iid, encoding_hint
             FROM string_events
             WHERE ${conditions.join(' AND ')}
             ORDER BY line ASC, id ASC
             LIMIT ? OFFSET ?`,
            [...params, limitN, offsetN]
        );

        // 编码分布统计
        const encodingStats = db.all(
            'SELECT encoding_hint, COUNT(*) as cnt FROM string_events WHERE session_id = ? GROUP BY encoding_hint ORDER BY cnt DESC',
            [id]
        );

        res.json({ strings: rows, encodingStats, count: rows.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/strings] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/fn-signatures ───────────────────────────────────

router.get('/:id/fn-signatures', (req, res) => {
    try {
        const { id } = req.params;
        const { onlyPure, limit = '200' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (onlyPure === '1' || onlyPure === 'true') {
            conditions.push('is_pure = 1');
        }

        const limitN = Math.min(Number(limit) || 200, 1000);

        const rows = db.all(
            `SELECT id, fn_name, fn_iid, call_count, is_pure, arg_types, return_types, sample_args, sample_return
             FROM fn_signatures
             WHERE ${conditions.join(' AND ')}
             ORDER BY call_count DESC
             LIMIT ?`,
            [...params, limitN]
        );

        const result = rows.map(r => ({
            ...r,
            arg_types:    safeParseJson(r.arg_types, []),
            return_types: safeParseJson(r.return_types, {}),
            sample_args:  safeParseJson(r.sample_args, []),
        }));

        const summary = db.get(
            'SELECT COUNT(*) as total, SUM(is_pure) as pure_count FROM fn_signatures WHERE session_id = ?',
            [id]
        );

        res.json({ signatures: result, summary, count: result.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/fn-signatures] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/object-timelines ────────────────────────────────

router.get('/:id/object-timelines', (req, res) => {
    try {
        const { id } = req.params;
        const { baseVar, limit = '300', onlyWrites } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (baseVar) {
            conditions.push('base_var = ?');
            params.push(baseVar);
        }
        if (onlyWrites === '1' || onlyWrites === 'true') {
            conditions.push('is_write = 1');
        }

        const limitN = Math.min(Number(limit) || 300, 2000);

        const rows = db.all(
            `SELECT id, base_var, offset_key, change_seq, old_value, new_value, line, is_write
             FROM object_timelines
             WHERE ${conditions.join(' AND ')}
             ORDER BY change_seq ASC
             LIMIT ?`,
            [...params, limitN]
        );

        // 按 base_var 分组的统计
        const baseVarStats = db.all(
            `SELECT base_var, COUNT(*) as change_count
             FROM object_timelines
             WHERE session_id = ? AND is_write = 1
             GROUP BY base_var
             ORDER BY change_count DESC
             LIMIT 50`,
            [id]
        );

        res.json({ timelines: rows, baseVarStats, count: rows.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/object-timelines] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/obfuscation ─────────────────────────────────────

router.get('/:id/obfuscation', (req, res) => {
    try {
        const { id } = req.params;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const hints = db.all(
            'SELECT id, hint_type, description, iid, line, confidence FROM obfuscation_hints WHERE session_id = ? ORDER BY confidence DESC',
            [id]
        );

        const isObfuscated = hints.length > 0;
        const avgConfidence = hints.length > 0
            ? hints.reduce((s, h) => s + (h.confidence || 0), 0) / hints.length
            : 0;

        res.json({
            hints,
            isObfuscated,
            avgConfidence: Math.round(avgConfidence * 100),
            count: hints.length,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/obfuscation] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/summary ─────────────────────────────────────────

router.get('/:id/summary', (req, res) => {
    try {
        const { id } = req.params;
        const { format = 'json' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const row = db.get('SELECT * FROM analysis_summary WHERE session_id = ?', [id]);

        if (!row) {
            return res.status(404).json({ error: 'Summary not found. Run I4-AlgorithmSummarizer first.' });
        }

        if (format === 'md' || format === 'markdown') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(row.summary_md || '');
        }

        return res.json({
            sessionId: id,
            generatedAt: row.generated_at,
            report: safeParseJson(row.summary_json, {}),
            markdown: row.summary_md,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/summary] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-search ────────────────────────────────────
// 按值反查事件（利用 value_index 表）
// 查询参数（至少提供一个）：
//   num=<number>          精确数值匹配（走 idx_vi_num 索引，O(log N)）
//   numMin=<n>&numMax=<n> 数值范围匹配（走 idx_vi_num 范围扫描）
//   str=<string>          精确字符串匹配（走 idx_vi_str 索引，O(log N)）
//   strLike=<pattern>     模糊字符串匹配，支持 * 通配符（内部转为 SQL LIKE，全表扫描）
//   source=write|read|field  可选，限定来源（默认不限）
//   limit=<n>             最多返回条数（默认 200，最大 1000）

router.get('/:id/value-search', (req, res) => {
    try {
        const { id } = req.params;
        const { num, numMin, numMax, str, strLike, source, limit = '200' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike',
            });
        }

        const limitN = Math.min(Number(limit) || 200, 1000);
        const conditions = ['session_id = ?'];
        const params = [id];

        // 数值类查询
        if (num !== undefined) {
            const n = Number(num);
            if (isNaN(n)) return res.status(400).json({ error: 'num must be a valid number' });
            conditions.push("val_type = 'num'", 'val_num = ?');
            params.push(n);
        } else if (numMin !== undefined || numMax !== undefined) {
            conditions.push("val_type = 'num'");
            if (numMin !== undefined) {
                const lo = Number(numMin);
                if (isNaN(lo)) return res.status(400).json({ error: 'numMin must be a valid number' });
                conditions.push('val_num >= ?');
                params.push(lo);
            }
            if (numMax !== undefined) {
                const hi = Number(numMax);
                if (isNaN(hi)) return res.status(400).json({ error: 'numMax must be a valid number' });
                conditions.push('val_num <= ?');
                params.push(hi);
            }
        // 字符串类查询
        } else if (str !== undefined) {
            conditions.push("val_type IN ('str', 'bool')", 'val_str = ?');
            params.push(str);
        } else if (strLike !== undefined) {
            // 将用户输入的 * 转为 SQL LIKE 的 %，同时转义原有的 % 和 _
            const likePattern = strLike
                .replace(/%/g, '\\%')
                .replace(/_/g, '\\_')
                .replace(/\*/g, '%');
            conditions.push("val_type IN ('str', 'bool')", "val_str LIKE ? ESCAPE '\\'");
            params.push(likePattern);
        }

        // 可选：限定来源
        if (source && ['write', 'read', 'field'].includes(source)) {
            conditions.push('source = ?');
            params.push(source);
        }

        const rows = db.all(
            `SELECT event_id, val_type, val_num, val_str, var_name, source
             FROM value_index
             WHERE ${conditions.join(' AND ')}
             ORDER BY event_id ASC
             LIMIT ?`,
            [...params, limitN]
        );

        res.json({ matches: rows, count: rows.length });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-search] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/call-stack ──────────────────────────────────────
// 查询某次函数调用的完整调用栈（祖先帧列表）
// 查询参数：
//   callSeq=<N>    当前帧的 call_seq（CALL_PRE 事件 id）
//   returnSeq=<N>  当前帧的 return_seq（CALL 事件 id）
//   depth=<N>      当前帧的深度，查 depth < N 的所有祖先帧

router.get('/:id/call-stack', (req, res) => {
    try {
        const { id } = req.params;
        const { callSeq, returnSeq, depth } = req.query;

        if (callSeq === undefined || returnSeq === undefined || depth === undefined) {
            return res.status(400).json({ error: 'callSeq, returnSeq, depth are required' });
        }

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const callSeqN   = Number(callSeq);
        const returnSeqN = Number(returnSeq);
        const depthN     = Number(depth);

        // 深度为 0 表示顶层调用，无父帧
        if (depthN <= 0) {
            return res.json({ stack: [] });
        }

        // 查找所有包含当前调用区间且深度更小的帧（即祖先帧），按深度升序排列
        const frames = db.all(
            `SELECT fn_name, fn_iid, caller_line, depth, args_json, return_value, call_seq, return_seq
             FROM call_edges
             WHERE session_id = ?
               AND call_seq <= ?
               AND return_seq >= ?
               AND depth < ?
             ORDER BY depth ASC`,
            id, callSeqN, returnSeqN, depthN
        );

        res.json({
            stack: frames.map(f => ({
                fnName:      f.fn_name,
                fnIid:       f.fn_iid,
                callerLine:  f.caller_line,
                depth:       f.depth,
                args:        safeParseJson(f.args_json, []),
                returnValue: safeParseJson(f.return_value, null),
                callSeq:     f.call_seq,
                returnSeq:   f.return_seq,
            })),
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/call-stack] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/events/:seq/owner-fn ────────────────────────────
// 查询某个事件所属的最近函数帧（即包含该 seq 的 depth 最大的调用边）

router.get('/:id/events/:seq/owner-fn', (req, res) => {
    try {
        const { id, seq } = req.params;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const seqN = Number(seq);
        if (isNaN(seqN)) return res.status(400).json({ error: 'seq must be a number' });

        // 找包含该 seq 的调用帧中 depth 最大的（最近调用者）
        const frame = db.get(
            `SELECT fn_name, fn_iid, caller_line, depth, call_seq, return_seq, args_json, return_value
             FROM call_edges
             WHERE session_id = ? AND call_seq <= ? AND return_seq >= ?
             ORDER BY depth DESC
             LIMIT 1`,
            id, seqN, seqN
        );

        if (!frame) {
            return res.json({ ownerFn: null });
        }

        res.json({
            ownerFn: {
                fnName:      frame.fn_name,
                fnIid:       frame.fn_iid,
                callerLine:  frame.caller_line,
                depth:       frame.depth,
                callSeq:     frame.call_seq,
                returnSeq:   frame.return_seq,
                args:        safeParseJson(frame.args_json, []),
                returnValue: safeParseJson(frame.return_value, null),
            },
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/events/:seq/owner-fn] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── 工具函数 ────────────────────────────────────────────────────────────────

function safeParseJson(str, fallback = null) {
    if (str === null || str === undefined) return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch { return fallback ?? str; }
}

function groupBy(arr, key) {
    const map = {};
    for (const item of arr) {
        const k = item[key];
        if (!map[k]) map[k] = [];
        map[k].push(item);
    }
    return map;
}

/**
 * 从已有的 bin/smap 文件路径创建会话（供内部调用，如 trace-import API）。
 * @param {{ binPath: string, smapPath?: string|null, name?: string, wsProgressBroadcast?: Function }} opts
 * @returns {Promise<string>} sessionId
 */
export async function createSession({
    binPath,
    smapPath    = null,
    sourcePath  = null,
    projectId   = null,
    name        = null,
    wsProgressBroadcast = null,
}) {
    const { copyFileSync: cpSync, mkdirSync: mkdSync, existsSync: exSync } = await import('fs');
    const { resolve: res, basename } = await import('path');
    const { v4: uuid } = await import('uuid');

    const sessionId  = uuid();
    const sessionDir = res(DATA_DIR, sessionId);
    mkdSync(sessionDir, { recursive: true });

    const binDest  = res(sessionDir, basename(binPath));
    cpSync(binPath, binDest);

    let smapDest = null;
    if (smapPath) {
        smapDest = res(sessionDir, basename(smapPath));
        cpSync(smapPath, smapDest);
    }

    // 复制源码文件（从工作空间关联过来时）
    let sourceDest = null;
    if (sourcePath && exSync(sourcePath)) {
        sourceDest = res(sessionDir, basename(sourcePath));
        cpSync(sourcePath, sourceDest);
    }

    const sessionName = name || basename(binPath).replace(/\.bin$/, '') || `session-${sessionId.slice(0, 8)}`;
    const now = Date.now();

    db.run(
        `INSERT INTO sessions (id, name, created_at, source_file, bin_path, smap_path, status, plugin_status, project_id)
         VALUES (?, ?, ?, ?, ?, ?, 'parsing', '{}', ?)`,
        sessionId, sessionName, now, sourceDest, binDest, smapDest, projectId
    );

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
        log.error({ err: e }, '[createSession] plugin schedule error:');
        db.run("UPDATE sessions SET status = 'failed' WHERE id = ?", sessionId);
        wsProgressBroadcast?.(sessionId, { type: 'error', sessionId, message: e.message });
    });

    return sessionId;
}

export default router;
