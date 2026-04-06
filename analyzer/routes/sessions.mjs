/**
 * routes/sessions.mjs — 分析会话 REST API
 *
 * POST /api/sessions              上传 .bin + .smap.json（可选）+ .js（可选），创建新会话
 * GET  /api/sessions              列出所有会话
 * GET  /api/sessions/:id          会话详情 + 插件状态
 * GET  /api/sessions/:id/events   查询事件（支持分页 + 过滤）
 */

import { Router } from 'express';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import * as db from '../db/Database.mjs';
import { schedule, autoDiscover } from '../PluginEngine.mjs';

const router = Router();
const __dirname = resolve(new URL('.', import.meta.url).pathname);
const DATA_DIR = resolve(__dirname, '../data/sessions');

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

        // 创建 session 记录
        db.run(
            `INSERT INTO sessions (id, name, created_at, source_file, bin_path, smap_path, status, plugin_status)
             VALUES (?, ?, ?, ?, ?, ?, 'processing', '{}')`,
            sessionId, sessionName, now,
            sourceDest, binDest, smapDest
        );

        // 确定要运行的插件
        const plugins = ['F1-EventIndex', 'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'];
        if (smapDest) plugins.push('F2-SmapLoader');

        // 异步触发插件（不等待）
        autoDiscover().then(() =>
            schedule(sessionId, {
                plugins,
                dataDir: sessionDir,
                onProgress: (evt) => {
                    // 进度通过 WebSocket 推送（在 server.mjs 中注册）
                    req.app.get('wsProgressBroadcast')?.(sessionId, evt);
                },
            })
        ).catch(e => {
            console.error('[sessions] plugin schedule error:', e);
            db.run("UPDATE sessions SET status = 'failed' WHERE id = ?", sessionId);
        });

        return res.status(201).json({
            sessionId,
            status: 'processing',
            smapAvailable: !!smapDest,
        });

    } catch (e) {
        console.error('[POST /api/sessions] error:', e);
        return res.status(500).json({ error: e.message });
    }
});

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
        console.error('[GET /api/sessions] error:', e);
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

        return res.json({
            ...session,
            plugin_status: safeParseJson(session.plugin_status, {}),
        });
    } catch (e) {
        console.error('[GET /api/sessions/:id] error:', e);
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
            varName,
            seqFrom,
            seqTo,
            limit = '100',
            offset = '0',
        } = req.query;

        // 检查 session 是否存在
        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) {
            return res.status(404).json({ error: `Session ${id} not found` });
        }

        // 构建查询
        const conditions = ['e.session_id = ?'];
        const params = [id];

        if (line !== undefined) {
            conditions.push('e.line = ?');
            params.push(Number(line));
        }
        if (type) {
            conditions.push('e.type = ?');
            params.push(type);
        }
        if (seqFrom !== undefined) {
            conditions.push('e.id >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined) {
            conditions.push('e.id <= ?');
            params.push(Number(seqTo));
        }

        // varName：在 writes 或 reads 中包含该变量名
        if (varName) {
            conditions.push(`(
                EXISTS (SELECT 1 FROM writes w WHERE w.event_id = e.id AND w.name = ?)
                OR EXISTS (SELECT 1 FROM reads  r WHERE r.event_id = e.id AND r.name = ?)
            )`);
            params.push(varName, varName);
        }

        const where = conditions.join(' AND ');
        const limitN  = Math.min(Number(limit)  || 100, 1000);
        const offsetN = Number(offset) || 0;

        const events = db.all(
            `SELECT e.id AS seq, e.type, e.iid, e.line, e.col, e.src_text
             FROM events e
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
                `SELECT event_id, name, value, omitted FROM writes WHERE event_id IN (${placeholders})`,
                ...eventIds
            );
            reads = db.all(
                `SELECT event_id, name, value, omitted FROM reads WHERE event_id IN (${placeholders})`,
                ...eventIds
            );
            fields = db.all(
                `SELECT event_id, base, offset, is_write, value, omitted FROM fields WHERE event_id IN (${placeholders})`,
                ...eventIds
            );
        }

        // 按 event_id 分组
        const writesMap  = groupBy(writes,  'event_id');
        const readsMap   = groupBy(reads,   'event_id');
        const fieldsMap  = groupBy(fields,  'event_id');

        // 组合结果
        const result = events.map(e => ({
            seq:      e.seq,
            type:     e.type,
            iid:      e.iid,
            line:     e.line,
            col:      e.col,
            srcText:  e.src_text,
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
        }));

        return res.json({
            sessionId: id,
            events: result,
            count:  result.length,
            hasMore: result.length === limitN,
        });

    } catch (e) {
        console.error('[GET /api/sessions/:id/events] error:', e);
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
        console.error('[GET /api/sessions/:id/loop-iterations] error:', e);
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
        console.error('[GET /api/sessions/:id/value-patterns] error:', e);
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
        console.error('[GET /api/sessions/:id/crypto-hints] error:', e);
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
        console.error('[GET /api/sessions/:id/signature-paths] error:', e);
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

        const { plugins = ['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer'] } = req.body ?? {};

        const { autoDiscover, schedule } = await import('../PluginEngine.mjs');
        await autoDiscover();

        // 异步执行，不阻塞响应
        schedule(id, {
            plugins,
            onProgress: (evt) => {
                req.app.get('wsProgressBroadcast')?.(id, evt);
            },
        }).catch(e => {
            console.error('[run-phase3] schedule error:', e);
        });

        return res.json({ status: 'scheduled', plugins });
    } catch (e) {
        console.error('[POST /api/sessions/:id/run-phase3] error:', e);
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

        const defaultPlugins = [
            'A2-DataFlowGraph',
            'A4-StringTracker',
            'A6-FunctionSignatureInfer',
            'A7-ObjectMutationTracker',
            'I3-ObfuscationDetector',
            'I4-AlgorithmSummarizer',
        ];
        const { plugins = defaultPlugins } = req.body ?? {};

        const { autoDiscover, schedule } = await import('../PluginEngine.mjs');
        await autoDiscover();

        schedule(id, {
            plugins,
            onProgress: (evt) => {
                req.app.get('wsProgressBroadcast')?.(id, evt);
            },
        }).catch(e => {
            console.error('[run-phase4] schedule error:', e);
        });

        return res.json({ status: 'scheduled', plugins });
    } catch (e) {
        console.error('[POST /api/sessions/:id/run-phase4] error:', e);
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
        console.error('[GET /api/sessions/:id/dataflow] error:', e);
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
        console.error('[GET /api/sessions/:id/strings] error:', e);
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
        console.error('[GET /api/sessions/:id/fn-signatures] error:', e);
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
        console.error('[GET /api/sessions/:id/object-timelines] error:', e);
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
        console.error('[GET /api/sessions/:id/obfuscation] error:', e);
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
        console.error('[GET /api/sessions/:id/summary] error:', e);
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

export default router;
