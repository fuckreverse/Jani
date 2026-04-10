/**
 * sessions/analysis.mjs — 分析结果读取接口
 *
 * GET  /api/sessions/:id/hot-iids          热点 IID + 循环
 * GET  /api/sessions/:id/var-lifetime       变量生命周期
 * POST /api/sessions/:id/taint             污点追踪
 * GET  /api/sessions/:id/loop-iterations   循环迭代数据
 * GET  /api/sessions/:id/value-patterns    值模式
 * GET  /api/sessions/:id/crypto-hints      加密算法提示
 * GET  /api/sessions/:id/signature-paths   签名路径
 * GET  /api/sessions/:id/dataflow          数据流边
 * GET  /api/sessions/:id/strings           字符串事件
 * GET  /api/sessions/:id/object-timelines  对象属性时间线
 * GET  /api/sessions/:id/obfuscation       混淆检测结果
 * GET  /api/sessions/:id/summary           算法摘要
 */

import { Router } from 'express';
import { createLogger } from '../../logger.mjs';

const log = createLogger('sessions');
import * as db from '../../db/Database.mjs';
import { safeParseJson } from './utils.mjs';

const router = Router({ mergeParams: true });

// ── GET /api/sessions/:id/hot-iids ────────────────────────────────────────

router.get('/hot-iids', (req, res) => {
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

router.get('/var-lifetime', (req, res) => {
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

router.post('/taint', async (req, res) => {
    try {
        const { id } = req.params;
        const { sourceVar, sourceEventId, direction = 'forward' } = req.body;

        if (!sourceVar && !sourceEventId) {
            return res.status(400).json({ error: 'sourceVar or sourceEventId required' });
        }

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const { runSinglePlugin } = await import('../../PluginEngine.mjs');

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
// 新增 seqFrom/seqTo：按循环起止 SEQ 范围过滤（只看某次函数调用区间内的循环迭代）

router.get('/loop-iterations', (req, res) => {
    try {
        const { id } = req.params;
        const { loopId, limit = '100', offset = '0', seqFrom, seqTo } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (loopId !== undefined) {
            conditions.push('loop_id = ?');
            params.push(Number(loopId));
        }
        // 时间窗口过滤：按迭代起始 SEQ 范围（start_seq 在 [seqFrom, seqTo] 内）
        if (seqFrom !== undefined && seqFrom !== '') {
            conditions.push('start_seq >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            conditions.push('start_seq <= ?');
            params.push(Number(seqTo));
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

        // 同时返回循环列表（供前端 loop_id 选择，按时间窗口过滤）
        const loopConds = ['session_id = ?'];
        const loopParams = [id];
        if (seqFrom !== undefined && seqFrom !== '') {
            loopConds.push('start_seq >= ?');
            loopParams.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            loopConds.push('start_seq <= ?');
            loopParams.push(Number(seqTo));
        }
        const loops = db.all(
            `SELECT id, iid, start_seq, end_seq, iteration_count, line FROM loops WHERE ${loopConds.join(' AND ')} ORDER BY id ASC`,
            ...loopParams
        );

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
// 新增 seqFrom/seqTo：按首次出现 SEQ（first_seq）范围过滤

router.get('/value-patterns', (req, res) => {
    try {
        const { id } = req.params;
        const { onlyCrypto, varName, minCount, limit = '2000', seqFrom, seqTo } = req.query;

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
        // 时间窗口过滤：按首次出现 SEQ（first_seq 在 [seqFrom, seqTo] 内）
        if (seqFrom !== undefined && seqFrom !== '') {
            conditions.push('first_seq >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            conditions.push('first_seq <= ?');
            params.push(Number(seqTo));
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

router.get('/crypto-hints', (req, res) => {
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

router.get('/signature-paths', (req, res) => {
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

// ── GET /api/sessions/:id/dataflow ────────────────────────────────────────
// 新增 seqFrom/seqTo：按事件 SEQ 范围过滤（from_event_id 或 to_event_id 在区间内）

router.get('/dataflow', (req, res) => {
    try {
        const { id } = req.params;
        const { edgeType, varName, limit = '200', offset = '0', seqFrom, seqTo } = req.query;

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
        // 时间窗口过滤：from_event_id（边的起点事件）在 [seqFrom, seqTo] 内
        if (seqFrom !== undefined && seqFrom !== '') {
            conditions.push('from_event_id >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            conditions.push('from_event_id <= ?');
            params.push(Number(seqTo));
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

        // 汇总统计（始终用全量统计）
        const stats = db.all(
            'SELECT edge_type, COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ? GROUP BY edge_type ORDER BY cnt DESC',
            [id]
        );

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
// 新增 seqFrom/seqTo：按事件 SEQ 范围（event_id）过滤

router.get('/strings', (req, res) => {
    try {
        const { id } = req.params;
        const { encoding, limit = '500', offset = '0', seqFrom, seqTo } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', [id]);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const conditions = ['session_id = ?'];
        const params = [id];

        if (encoding) {
            conditions.push('encoding_hint = ?');
            params.push(encoding);
        }
        // 时间窗口过滤：event_id 在 [seqFrom, seqTo] 内
        if (seqFrom !== undefined && seqFrom !== '') {
            conditions.push('event_id >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            conditions.push('event_id <= ?');
            params.push(Number(seqTo));
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

        const totalRow = db.get(
            `SELECT COUNT(*) as cnt FROM string_events WHERE ${conditions.join(' AND ')}`,
            params
        );
        const total = totalRow?.cnt ?? 0;

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
// 新增 seqFrom/seqTo：按变更 SEQ（change_seq）范围过滤，只看某段时间内的属性变化

router.get('/object-timelines', (req, res) => {
    try {
        const { id } = req.params;
        const {
            baseVar,
            onlyWrites,
            page     = '1',
            pageSize = '100',
            seqFrom,
            seqTo,
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
        // 时间窗口过滤：change_seq 在 [seqFrom, seqTo] 内
        if (seqFrom !== undefined && seqFrom !== '') {
            conditions.push('change_seq >= ?');
            params.push(Number(seqFrom));
        }
        if (seqTo !== undefined && seqTo !== '') {
            conditions.push('change_seq <= ?');
            params.push(Number(seqTo));
        }

        const where   = conditions.join(' AND ');
        const pageSizeN = Math.min(Math.max(Number(pageSize) || 100, 1), 500);
        const pageN     = Math.max(Number(page) || 1, 1);
        const offsetN   = (pageN - 1) * pageSizeN;

        const totalRow = db.get(`SELECT COUNT(*) as cnt FROM object_timelines WHERE ${where}`, params);
        const total    = totalRow?.cnt ?? 0;
        const totalPages = Math.max(1, Math.ceil(total / pageSizeN));

        const rows = db.all(
            `SELECT id, base_var, offset_key, change_seq, old_value, new_value, line, is_write, src_text
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

router.get('/obfuscation', (req, res) => {
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

router.get('/summary', (req, res) => {
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

export default router;
