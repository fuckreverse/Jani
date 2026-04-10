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
 * Phase 4（手动按需）：A2 / A4 / A7 / I3 / I4
 */
const PHASE1_PLUGINS = ['F1-EventIndex'];
const PHASE2_PLUGINS = ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'];
const PHASE3_PLUGINS = ['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer'];
const PHASE4_PLUGINS = [
    'A2-DataFlowGraph',
    'A4-StringTracker',
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
`SELECT event_id, offset, is_write, value, omitted, base_oid FROM fields WHERE session_id = ? AND event_id IN (${placeholders})`,
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
                    offset:  f.offset,
                    isWrite: !!f.is_write,
                    value:   safeParseJson(f.value),
                    omitted: !!f.omitted,
                    baseOid: f.base_oid ?? null,
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
//
// 新增过滤参数：
//   minEvents   / maxEvents  — 按函数体事件数（≈ MAX(return_seq)-MIN(call_seq) 近似）过滤
//   hideBuiltin              — '1' 时隐藏 JS 内建函数（charAt/indexOf/push/… 等）
//   sortBy                   — 'call_count'（默认）| 'event_count'（按事件数倒序）

// 常见 JS 内建 / 原生方法名列表（用于 hideBuiltin 过滤）
const BUILTIN_FN_NAMES = new Set([
    // String.prototype
    'charAt','charCodeAt','codePointAt','indexOf','lastIndexOf',
    'slice','substring','substr','trim','trimStart','trimEnd','trimLeft','trimRight',
    'split','replace','replaceAll','match','matchAll','search',
    'includes','startsWith','endsWith','repeat','padStart','padEnd',
    'toUpperCase','toLowerCase','toLocaleLowerCase','toLocaleUpperCase',
    'normalize','localeCompare','toString','valueOf','concat','at',
    // Array.prototype
    'push','pop','shift','unshift','splice','concat','join','reverse','sort',
    'map','filter','reduce','reduceRight','forEach','find','findIndex',
    'findLast','findLastIndex','some','every','flat','flatMap',
    'includes','indexOf','lastIndexOf','fill','copyWithin','entries','keys','values',
    'at','toString','toReversed','toSorted','toSpliced','with',
    // Math
    'floor','ceil','round','abs','max','min','pow','sqrt','log','log2','log10',
    'exp','sign','trunc','cbrt','hypot','random','sin','cos','tan',
    'asin','acos','atan','atan2','sinh','cosh','tanh','clz32','fround','imul',
    // Number / global
    'parseInt','parseFloat','isNaN','isFinite','isInteger','isSafeInteger',
    'toFixed','toPrecision','toExponential',
    // Object
    'hasOwnProperty','isPrototypeOf','propertyIsEnumerable',
    'getOwnPropertyNames','getOwnPropertyDescriptor','getPrototypeOf',
    'assign','keys','values','entries','freeze','seal','create','defineProperty',
    // JSON
    'parse','stringify',
    // Promise / async
    'then','catch','finally','resolve','reject','all','allSettled','race','any',
    // Misc
    'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
    'apply','call','bind','hasOwn','set','get','delete','has','clear',
    'add','size','entries','forEach',
]);

router.get('/:id/functions', (req, res) => {
    try {
        const { id } = req.params;
        const {
            search      = '',
            minCalls    = '1',
            limit       = '100',
            offset      = '0',
            fnIid,              // 精确 iid 过滤（跨 Tab 跳转时使用）
            minEvents,          // 函数体最少事件数（近似：MAX(return_seq)-MIN(call_seq)）
            maxEvents,          // 函数体最多事件数
            hideBuiltin = '0',  // '1' 隐藏 JS 内建函数
            sortBy      = 'call_count',  // 'call_count' | 'event_count'
            line,               // 调用点行号过滤：caller_line = N（精确匹配）
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
        // hideBuiltin：fn_name 不在内建名单中（仅 fn_name 不含 '.' 的短名；Math.xxx 等带点的
        // 由于 call_edges.fn_name 通常只存方法短名，这里直接用 NOT IN 过滤）
        if (hideBuiltin === '1') {
            const placeholders = Array.from(BUILTIN_FN_NAMES).map(() => '?').join(',');
            conditions.push(`fn_name NOT IN (${placeholders})`);
            params.push(...BUILTIN_FN_NAMES);
        }
        // line：按调用点行号精确过滤（caller_line = N）
        // 用于定位 (anonymous) 等同名函数：在第 N 行调用的函数
        if (line !== undefined && line !== '') {
            conditions.push('caller_line = ?');
            params.push(Number(line));
        }

        const minCallsN  = Math.max(1, Number(minCalls) || 1);
        const limitN     = Math.min(Number(limit)  || 100, 500);
        const offsetN    = Number(offset) || 0;
        const minEventsN = minEvents !== undefined && minEvents !== '' ? Number(minEvents) : null;
        const maxEventsN = maxEvents !== undefined && maxEvents !== '' ? Number(maxEvents) : null;

        // HAVING 子句：call_count + 可选的 own_event_count 范围
        // own_event_count 是 F3 预计算的自身事件数（不含子调用）；
        // 对旧数据（own_event_count IS NULL）降级为 return_seq - call_seq 近似值
        const ownExpr = `SUM(COALESCE(own_event_count, COALESCE(return_seq,call_seq) - call_seq))`;
        const havingClauses = [`COUNT(*) >= ?`];
        const havingParams  = [minCallsN];
        if (minEventsN !== null) {
            havingClauses.push(`${ownExpr} >= ?`);
            havingParams.push(minEventsN);
        }
        if (maxEventsN !== null) {
            havingClauses.push(`${ownExpr} <= ?`);
            havingParams.push(maxEventsN);
        }

        // ORDER BY：按事件数排序时用均值（avgOwnExpr），更能反映"单次调用的复杂度"
        // avgOwnExpr 此时还未定义，但 SQL 支持 SELECT 别名在 ORDER BY 中引用，
        // 为避免混淆直接内联表达式
        const avgOwnOrderExpr = `CAST(ROUND(1.0 * ${ownExpr} / COUNT(*)) AS INTEGER)`;
        const orderExpr = sortBy === 'event_count'
            ? `${avgOwnOrderExpr} DESC`
            : `call_count DESC`;

        // 每个函数名聚合：调用次数、自身事件数（总量和均值）、最小行号、深度范围
        const avgOwnExpr = `CAST(ROUND(1.0 * ${ownExpr} / COUNT(*)) AS INTEGER)`;
        const rows = db.all(
            `SELECT
                fn_name,
                fn_iid,
                COUNT(*)         AS call_count,
                ${ownExpr}       AS event_count,
                ${avgOwnExpr}    AS avg_own_event_count,
                MIN(caller_line) AS min_line,
                MIN(depth)       AS min_depth,
                MAX(depth)       AS max_depth
             FROM call_edges
             WHERE ${conditions.join(' AND ')}
             GROUP BY fn_name, fn_iid
             HAVING ${havingClauses.join(' AND ')}
             ORDER BY ${orderExpr}
             LIMIT ? OFFSET ?`,
            ...params, ...havingParams, limitN, offsetN
        );

        // 总数（用于分页）：用子查询对聚合结果再计数
        const totalRow = db.get(
            `SELECT COUNT(*) AS total
             FROM (
               SELECT fn_name
               FROM call_edges
               WHERE ${conditions.join(' AND ')}
               GROUP BY fn_name, fn_iid
               HAVING ${havingClauses.join(' AND ')}
             )`,
            ...params, ...havingParams
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

// ── GET /api/sessions/:id/calls/:callId/own-events ────────────────────────
// 返回某次具体调用的「自身事件流」：[call_seq, return_seq] 区间内去除所有直接子调用占据的 SEQ
//
// 实现方式（高性能，无全表扫描）：
//  1. 查该次调用的所有直接子调用区间（depth+1，call_seq ∈ [callSeqN, returnSeqN]）
//     → 利用 idx_call_edges_stack 索引，O(子调用数)
//  2. 将排除区间传入 SQL WHERE，或在 Node.js 侧过滤（取决于子调用数量）
//  3. 支持游标分页：cursor 为上次返回的最后 event SEQ，下次从 id > cursor 开始
//     → 配合子区间排除，每页取 limit 条自身事件

router.get('/:id/calls/:callId/own-events', (req, res) => {
    try {
        const { id, callId } = req.params;
        const { limit = '200', cursor } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: `Session ${id} not found` });

        // 取该次调用基本信息
        const call = db.get(
            'SELECT call_seq, return_seq, depth FROM call_edges WHERE id = ? AND session_id = ?',
            Number(callId), id
        );
        if (!call) return res.status(404).json({ error: `Call ${callId} not found` });

        const { call_seq: callSeqN, return_seq: returnSeqN, depth: depthN } = call;
        const limitN = Math.min(Number(limit) || 200, 500);

        // ── Step 1: 取所有直接子调用区间（depth+1，在本调用区间内）──────────────
        // 使用 idx_call_edges_stack 索引：(session_id, call_seq, return_seq, depth)
        const children = db.all(
            `SELECT call_seq, return_seq FROM call_edges
             WHERE session_id = ?
               AND depth = ?
               AND call_seq  >= ?
               AND return_seq <= ?
             ORDER BY call_seq ASC`,
            id, depthN + 1, callSeqN, returnSeqN
        );

        // ── Step 2: 构建 SQL 排除条件 ─────────────────────────────────────────
        // 策略：排除每个子调用的「内部」事件（call_seq+1 到 return_seq-1），
        // 但保留头（CALL_PRE @ call_seq）和尾（CALL @ return_seq），
        // 这样 A 的事件流里仍能看到「调用了 B」及「B 的返回值」。
        // 只有 call_seq < return_seq-1 时才需要排除（否则区间为空）。
        // 当子调用数量较少时（< 200），直接用 SQL；否则改为 Node.js 侧过滤
        const baseConditions = [
            'e.session_id = ?',
            'e.id >= ?',
            'e.id <= ?',
        ];
        const baseParams = [id, callSeqN, returnSeqN];

        // 游标分页
        if (cursor !== undefined && cursor !== '') {
            baseConditions.push('e.id > ?');
            baseParams.push(Number(cursor));
        }

        let events;
        if (children.length > 0 && children.length <= 200) {
            // 子调用数量合理：直接在 SQL 里排除内部区间（保留头尾）
            // 只对 call_seq+1 <= return_seq-1 的子调用生成排除条件（否则无内部事件）
            const innerChildren = children.filter(c => c.call_seq + 1 <= c.return_seq - 1);
            const excludeClauses = innerChildren.map(() => 'e.id NOT BETWEEN ? AND ?');
            const excludeParams  = innerChildren.flatMap(c => [c.call_seq + 1, c.return_seq - 1]);
            const where = excludeClauses.length > 0
                ? [...baseConditions, ...excludeClauses].join(' AND ')
                : baseConditions.join(' AND ');

            events = db.all(
                `SELECT e.id AS seq, e.type, e.iid,
                        s.sl AS line, s.sc AS col, s.src_text
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE ${where}
                 ORDER BY e.id ASC
                 LIMIT ?`,
                ...baseParams, ...excludeParams, limitN
            );
        } else if (children.length > 200) {
            // 子调用数量过多：先取全量 event，Node.js 侧过滤
            // 这种情况极罕见（一个函数有 200+ 直接子调用）
            const rawEvents = db.all(
                `SELECT e.id AS seq, e.type, e.iid,
                        s.sl AS line, s.sc AS col, s.src_text
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE ${baseConditions.join(' AND ')}
                 ORDER BY e.id ASC
                 LIMIT ?`,
                ...baseParams, limitN * 3  // 多取以应对过滤损耗
            );
            // 构建子区间排除集合（排除内部，保留头尾，O(N+M)）
            events = rawEvents.filter(e => {
                for (const c of children) {
                    if (e.seq > c.call_seq && e.seq < c.return_seq) return false;
                }
                return true;
            }).slice(0, limitN);
        } else {
            // 无子调用：直接返回全量
            const where = baseConditions.join(' AND ');
            events = db.all(
                `SELECT e.id AS seq, e.type, e.iid,
                        s.sl AS line, s.sc AS col, s.src_text
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE ${where}
                 ORDER BY e.id ASC
                 LIMIT ?`,
                ...baseParams, limitN
            );
        }

        // ── Step 3: 批量查 writes/reads/fields ────────────────────────────────
        const eventIds = events.map(e => e.seq);
        let writes = [], reads = [], fields = [];

        if (eventIds.length > 0) {
            const ph = eventIds.map(() => '?').join(',');
            writes = db.all(`SELECT event_id, name, value, omitted FROM writes WHERE session_id = ? AND event_id IN (${ph})`, id, ...eventIds);
            reads  = db.all(`SELECT event_id, name, value, omitted FROM reads  WHERE session_id = ? AND event_id IN (${ph})`, id, ...eventIds);
            fields = db.all(`SELECT event_id, offset, is_write, value, omitted, base_oid FROM fields WHERE session_id = ? AND event_id IN (${ph})`, id, ...eventIds);
        }

        const writesMap = groupBy(writes, 'event_id');
        const readsMap  = groupBy(reads,  'event_id');
        const fieldsMap = groupBy(fields, 'event_id');

        const result = events.map(e => ({
            seq:     e.seq,
            type:    decodeType(e.type),
            iid:     e.iid,
            line:    e.line ?? null,
            col:     e.col  ?? null,
            srcText: e.src_text ?? null,
            writes:  (writesMap[e.seq] || []).map(w => ({ name: w.name, value: safeParseJson(w.value), omitted: !!w.omitted })),
            reads:   (readsMap[e.seq]  || []).map(r => ({ name: r.name, value: safeParseJson(r.value), omitted: !!r.omitted })),
            fields:  (fieldsMap[e.seq] || []).map(f => ({ offset: f.offset, isWrite: !!f.is_write, value: safeParseJson(f.value), omitted: !!f.omitted, baseOid: f.base_oid ?? null })),
        }));

        const nextCursor = result.length === limitN ? result[result.length - 1].seq : null;

        return res.json({
            sessionId: id,
            callId:    Number(callId),
            events:    result,
            count:     result.length,
            hasMore:   result.length === limitN,
            nextCursor,
            childCount: children.length,  // 供前端展示"隐藏了 N 个子调用"
        });

    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/calls/:callId/own-events] error:');
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
        const { loopId, limit = '100', offset = '0' } = req.query;

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

        // total：仅统计当前过滤条件下的迭代总数（供前端分页）
        const totalRow = db.get(
            `SELECT COUNT(*) as total FROM loop_iterations WHERE ${conditions.join(' AND ')}`,
            ...params
        );

        res.json({ loops, iterations: result, count: result.length, total: totalRow?.total ?? 0, offset: offsetN });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/loop-iterations] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-patterns ──────────────────────────────────

router.get('/:id/value-patterns', (req, res) => {
    try {
        const { id } = req.params;
        const { onlyCrypto, varName, minCount, limit = '2000' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (onlyCrypto === '1' || onlyCrypto === 'true') {
            conditions.push('matched_constant IS NOT NULL');
        }
        if (varName) {
            conditions.push('var_name LIKE ?');
            params.push(`%${varName}%`);
        }
        if (minCount) {
            conditions.push('count >= ?');
            params.push(Number(minCount) || 1);
        }

        const limitN = Math.min(Number(limit) || 2000, 2000);

        const rows = db.all(
            `SELECT id, value_hash, count, first_seq, iid, var_name, line, matched_constant
             FROM value_patterns
             WHERE ${conditions.join(' AND ')}
             ORDER BY count DESC
             LIMIT ?`,
            ...params, limitN
        );

        res.json({ patterns: rows, count: rows.length, total: rows.length });
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
        const { edgeType, varName, limit = '200', offset = '0' } = req.query;

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

        const limitN  = Math.min(Number(limit)  || 200, 1000);
        const offsetN = Number(offset) || 0;

        const edges = db.all(
            `SELECT id, from_event_id, to_event_id, from_var, to_var, edge_type, iid, line
             FROM dataflow_edges
             WHERE ${conditions.join(' AND ')}
             ORDER BY id ASC
             LIMIT ? OFFSET ?`,
            [...params, limitN, offsetN]
        );

        // 汇总统计（始终用全量统计，不受 edgeType/varName 过滤影响，方便显示全局分布）
        const stats = db.all(
            'SELECT edge_type, COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ? GROUP BY edge_type ORDER BY cnt DESC',
            [id]
        );

        // 当前过滤条件下的总数
        const totalRow = db.get(
            `SELECT COUNT(*) as total FROM dataflow_edges WHERE ${conditions.join(' AND ')}`,
            params
        );

        res.json({ edges, stats, count: edges.length, total: totalRow?.total ?? 0, offset: offsetN });
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

        // 总数（用于分页）
        const totalRow = db.get(
            `SELECT COUNT(*) as cnt FROM string_events WHERE ${conditions.join(' AND ')}`,
            params
        );
        const total = totalRow?.cnt ?? 0;

        // 编码分布统计
        const encodingStats = db.all(
            'SELECT encoding_hint, COUNT(*) as cnt FROM string_events WHERE session_id = ? GROUP BY encoding_hint ORDER BY cnt DESC',
            [id]
        );

        res.json({ strings: rows, encodingStats, count: rows.length, total, hasMore: offsetN + rows.length < total });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/strings] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/object-timelines ────────────────────────────────

router.get('/:id/object-timelines', (req, res) => {
    try {
        const { id } = req.params;
        const {
            baseVar,
            onlyWrites,
            page     = '1',
            pageSize = '100',
        } = req.query;

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

        const where   = conditions.join(' AND ');
        const pageSizeN = Math.min(Math.max(Number(pageSize) || 100, 1), 500);
        const pageN     = Math.max(Number(page) || 1, 1);
        const offsetN   = (pageN - 1) * pageSizeN;

        // 总数（用于分页）
        const totalRow = db.get(`SELECT COUNT(*) as cnt FROM object_timelines WHERE ${where}`, params);
        const total    = totalRow?.cnt ?? 0;
        const totalPages = Math.max(1, Math.ceil(total / pageSizeN));

        const rows = db.all(
            `SELECT id, base_var, offset_key, change_seq, old_value, new_value, line, is_write
             FROM object_timelines
             WHERE ${where}
             ORDER BY change_seq ASC
             LIMIT ? OFFSET ?`,
            [...params, pageSizeN, offsetN]
        );

        // 按 base_var 分组的统计（含读写，全量，LIMIT 500 防超大数据集）
        const baseVarStats = db.all(
            `SELECT base_var, COUNT(*) as total_count,
                    SUM(is_write) as write_count,
                    COUNT(*) - SUM(is_write) as read_count
             FROM object_timelines
             WHERE session_id = ?
             GROUP BY base_var
             ORDER BY write_count DESC, total_count DESC
             LIMIT 500`,
            [id]
        );

        res.json({
            timelines:   rows,
            baseVarStats,
            count:       rows.length,
            total,
            totalPages,
            page:        pageN,
            pageSize:    pageSizeN,
            hasMore:     pageN < totalPages,
        });
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
            'SELECT id, hint_type, description, iid, line, confidence, fn_name FROM obfuscation_hints WHERE session_id = ? ORDER BY confidence DESC',
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
        const { num, numMin, numMax, str, strLike, varName, source, limit = '200' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined && varName === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike, varName',
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

        // 可选：按变量名过滤（走 idx_vi_varname 索引）
        if (varName) {
            conditions.push('var_name = ?');
            params.push(varName);
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

// ── GET /api/sessions/:id/value-search/events ─────────────────────────────
// 值搜索 + 事件详情合并接口：一次请求完成"按值找事件"并返回完整事件数据（含分页）
// 解决原方案"取 min/max 范围 + 前端二次过滤"的分页不准问题
// 查询参数与 value-search 相同，额外支持：
//   offset=<n>   分页偏移（默认 0）
//   limit=<n>    每页条数（默认 50，最大 200）

router.get('/:id/value-search/events', (req, res) => {
    try {
        const { id } = req.params;
        const { num, numMin, numMax, str, strLike, varName, source,
                limit = '50', offset = '0' } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (num === undefined && numMin === undefined && numMax === undefined &&
            str === undefined && strLike === undefined && varName === undefined) {
            return res.status(400).json({
                error: 'Provide at least one of: num, numMin/numMax, str, strLike, varName',
            });
        }

        const limitN  = Math.min(Number(limit)  || 50,  200);
        const offsetN = Number(offset) || 0;

        // 构建 value_index 查询条件（与 value-search 相同）
        const viConds  = ['vi.session_id = ?'];
        const viParams = [id];

        if (num !== undefined) {
            const n = Number(num);
            if (isNaN(n)) return res.status(400).json({ error: 'num must be a valid number' });
            viConds.push("vi.val_type = 'num'", 'vi.val_num = ?');
            viParams.push(n);
        } else if (numMin !== undefined || numMax !== undefined) {
            viConds.push("vi.val_type = 'num'");
            if (numMin !== undefined) { viConds.push('vi.val_num >= ?'); viParams.push(Number(numMin)); }
            if (numMax !== undefined) { viConds.push('vi.val_num <= ?'); viParams.push(Number(numMax)); }
        } else if (str !== undefined) {
            viConds.push("vi.val_type IN ('str', 'bool')", 'vi.val_str = ?');
            viParams.push(str);
        } else if (strLike !== undefined) {
            const likePattern = strLike
                .replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, '%');
            viConds.push("vi.val_type IN ('str', 'bool')", "vi.val_str LIKE ? ESCAPE '\\'");
            viParams.push(likePattern);
        }
        if (source && ['write', 'read', 'field'].includes(source)) {
            viConds.push('vi.source = ?');
            viParams.push(source);
        }
        if (varName) {
            viConds.push('vi.var_name = ?');
            viParams.push(varName);
        }

        const viWhere = viConds.join(' AND ');

        // 总命中数（用于前端分页显示）
        const totalRow = db.get(
            `SELECT COUNT(DISTINCT vi.event_id) AS total
             FROM value_index vi WHERE ${viWhere}`,
            viParams
        );
        const total = totalRow?.total ?? 0;

        // 按 event_id 分页取目标事件 id 列表
        const matchRows = db.all(
            `SELECT DISTINCT vi.event_id, vi.var_name, vi.val_type, vi.val_num, vi.val_str, vi.source
             FROM value_index vi
             WHERE ${viWhere}
             ORDER BY vi.event_id ASC
             LIMIT ? OFFSET ?`,
            [...viParams, limitN, offsetN]
        );

        if (matchRows.length === 0) {
            return res.json({ events: [], total, count: 0, hasMore: false });
        }

        const eventIds = matchRows.map(r => r.event_id);
        const placeholders = eventIds.map(() => '?').join(',');

        // 拉取事件主体（JOIN smap）
        const evRows = db.all(
            `SELECT e.id AS seq, e.type, e.iid,
                    s.sl AS line, s.sc AS col, s.src_text
             FROM events e
             LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
             WHERE e.session_id = ? AND e.id IN (${placeholders})
             ORDER BY e.id ASC`,
            id, ...eventIds
        );

        // 批量取 writes/reads/fields
        const writes = db.all(
            `SELECT event_id, name, value, omitted FROM writes WHERE session_id = ? AND event_id IN (${placeholders})`,
            id, ...eventIds
        );
        const reads = db.all(
            `SELECT event_id, name, value, omitted FROM reads WHERE session_id = ? AND event_id IN (${placeholders})`,
            id, ...eventIds
        );
const fields = db.all(
`SELECT event_id, offset, is_write, value, omitted, base_oid FROM fields WHERE session_id = ? AND event_id IN (${placeholders})`,
id, ...eventIds
);

        const writesMap = groupBy(writes, 'event_id');
        const readsMap  = groupBy(reads,  'event_id');
        const fieldsMap = groupBy(fields, 'event_id');

        // 构建 matchInfo：event_id → { varName, valType, valNum, valStr, source }
        const matchInfo = {};
        for (const r of matchRows) {
            matchInfo[r.event_id] = {
                varName:  r.var_name,
                valType:  r.val_type,
                valNum:   r.val_num,
                valStr:   r.val_str,
                source:   r.source,
            };
        }

        const result = evRows.map(e => ({
            seq:       e.seq,
            type:      decodeType(e.type),
            iid:       e.iid,
            line:      e.line ?? null,
            col:       e.col  ?? null,
            srcText:   e.src_text ?? null,
            matchInfo: matchInfo[e.seq] ?? null,   // 命中的值信息（变量名、值）
            writes:    (writesMap[e.seq] || []).map(w => ({ name: w.name, value: safeParseJson(w.value), omitted: !!w.omitted })),
            reads:     (readsMap[e.seq]  || []).map(r => ({ name: r.name, value: safeParseJson(r.value), omitted: !!r.omitted })),
            fields:    (fieldsMap[e.seq] || []).map(f => ({ offset: f.offset, isWrite: !!f.is_write, value: safeParseJson(f.value), omitted: !!f.omitted, baseOid: f.base_oid ?? null })),
        }));

        res.json({
            events:  result,
            total,
            count:   result.length,
            hasMore: offsetN + result.length < total,
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-search/events] error:');
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
