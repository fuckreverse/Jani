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
// 支持 valueSearch：按值内容（value_hash 字段）模糊搜索
// 支持 seqFrom/seqTo：按首次出现 SEQ（first_seq）范围过滤
// 支持 patternType：按语义类型标签精确过滤（A8 v3）
//   可选值：timestamp_ms | timestamp_s | uuid | hex_str | base64_charset |
//           custom_alphabet | base64_encoded | ip_addr | url | json_obj | byte_array

router.get('/value-patterns', (req, res) => {
    try {
        const { id } = req.params;
        const {
            onlyCrypto, varName, valueSearch, minCount,
            patternType, lenMin, lenMax,
            limit = '100', offset = '0',
            seqFrom, seqTo
        } = req.query;

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
        // 按值内容搜索（value_hash 字段模糊匹配）
        if (valueSearch) {
            conditions.push('value_hash LIKE ?');
            params.push(`%${valueSearch}%`);
        }
        if (minCount) {
            conditions.push('count >= ?');
            params.push(Number(minCount) || 1);
        }
        // 按语义类型标签精确过滤（A8 v3 新增）
        if (patternType) {
            conditions.push('pattern_type = ?');
            params.push(patternType);
        }
        // 按值内容长度范围过滤（LENGTH(value_hash) 即完整值长度）
        if (lenMin !== undefined && lenMin !== '') {
            conditions.push('LENGTH(value_hash) >= ?');
            params.push(Number(lenMin));
        }
        if (lenMax !== undefined && lenMax !== '') {
            conditions.push('LENGTH(value_hash) <= ?');
            params.push(Number(lenMax));
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

        const whereClause = conditions.join(' AND ');

        // 先查总数（用于分页）
        const { total } = db.get(
            `SELECT COUNT(*) AS total FROM value_patterns WHERE ${whereClause}`,
            ...params
        );

        const limitN  = Math.max(1, Math.min(Number(limit)  || 100, 500));
        const offsetN = Math.max(0, Number(offset) || 0);

        const rows = db.all(
            `SELECT id, value_hash, count, first_seq, iid, var_name, line, matched_constant, pattern_type, entropy
             FROM value_patterns
             WHERE ${whereClause}
             ORDER BY count DESC
             LIMIT ? OFFSET ?`,
            ...params, limitN, offsetN
        );

        res.json({ patterns: rows, count: rows.length, total, limit: limitN, offset: offsetN });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/value-patterns] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/value-patterns/:patternId/full-value ─────────────
// 优先通过 value_dict_id 直接查 value_dict.val_text（A8 v2 写入的完整原始值）
// value_hash 本身已是完整值（A8 v2 不再截断），此接口作为统一入口保留

router.get('/value-patterns/:patternId/full-value', (req, res) => {
    try {
        const { id, patternId } = req.params;

        const pattern = db.get(
            'SELECT id, value_dict_id FROM value_patterns WHERE id = ? AND session_id = ?',
            patternId, id
        );
        if (!pattern) return res.status(404).json({ error: 'Pattern not found' });

        const vd = db.get(
            'SELECT val_text FROM value_dict WHERE id = ? AND session_id = ?',
            pattern.value_dict_id, id
        );
        if (!vd) return res.status(404).json({ error: 'Value not found in dictionary' });

        res.json({ fullValue: vd.val_text, patternId: pattern.id });
    } catch (e) {
        log.error({ err: e }, '[GET /value-patterns/:patternId/full-value] error:');
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

// ── GET /api/sessions/:id/cfg ──────────────────────────────────────────────
// 动态控制流图（Dynamic CFG）— 性能优化版
//
// 性能策略：
//   - 函数节点：单次 GROUP BY 聚合，不扫全量 events
//   - 调用边：避免 Self-JOIN，改用 parent_fn 列（F3 已将 depth 和 call_seq 写入）
//     利用 idx_call_edges_depth(session_id, depth, call_seq, return_seq) 做深度过滤
//     + idx_call_edges_stack(session_id, call_seq, return_seq, depth) 做父帧查找
//     通过 WITH 子查询先聚合 child 层，再和 parent 层 GROUP BY 聚合调用关系
//   - hasLoop：预建 Set<loopIid>，O(1) 判断，而非 O(L×H) 嵌套过滤
//   - 所有中间集合用 Map/Set，减少 GC 压力
//
// 查询参数：
//   rootFn      string    以指定函数名为根（仅返回其子树）；不填返回完整 CFG
//   depth       number    展开深度（默认 3，最大 8）
//   minCount    number    iid_counts 执行次数阈值（默认 10）
//   foldLoops   boolean   是否折叠循环块（默认 true）
//   includeIids boolean   是否显示热点节点（默认 true）

router.get('/cfg', (req, res) => {
    try {
        const { id } = req.params;
        const {
            rootFn,
            depth       = '3',
            minCount    = '10',
            foldLoops   = 'true',
            includeIids = 'true',
        } = req.query;

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const depthN       = Math.min(Number(depth)   || 3,  8);
        const minCountN    = Math.max(Number(minCount) || 10, 1);
        const doFoldLoops  = foldLoops   !== 'false';
        const doIncludeIids = includeIids !== 'false';

        // ─ Step 1: 函数节点聚合（单次 GROUP BY，O(F)）──────────────────────
        // 利用 idx_call_edges_fn_name 覆盖索引
        const rootFnClause = rootFn ? ' AND fn_name = ?' : '';
        const fnRows = db.all(
            `SELECT fn_name, fn_iid,
                    COUNT(*)         AS call_count,
                    MIN(caller_line) AS min_line,
                    MIN(depth)       AS min_depth,
                    MAX(depth)       AS max_depth
             FROM call_edges
             WHERE session_id = ?${rootFnClause} AND depth <= ?
             GROUP BY fn_name, fn_iid
             ORDER BY call_count DESC
             LIMIT 500`,
            ...(rootFn ? [id, rootFn, depthN] : [id, depthN])
        );

        // ─ Step 2: 调用边（CTE 方式，消除 Self-JOIN 全表扫）──────────────
        // 思路：
        //   child 层：depth = 1..depthN 的所有 call_edges，按 (fn_name,fn_iid) 聚合
        //   parent 层：depth = 0..depthN-1，对每个 child 找 parent（depth=child.depth-1，
        //               call_seq <= child.call_seq AND return_seq >= child.call_seq）
        //
        //   优化：call_edges 已有 depth 字段，只需在同 session 内找 depth = child.depth-1
        //   且 call_seq/return_seq 范围覆盖 child 的父帧。
        //   利用 idx_call_edges_stack(session_id, call_seq, return_seq, depth) 加速。
        //
        //   使用 CTE 将 child 层先聚合为 (fn_name, fn_iid, depth, call_seq) 元组，
        //   再与 parent 层 JOIN，避免全量 N² 笛卡尔积。
        const callEdges = db.all(
            `WITH child_calls AS (
               -- 取目标深度内所有子调用（已被 idx_call_edges_depth 覆盖）
               SELECT fn_name  AS callee_fn,
                      fn_iid   AS callee_iid,
                      depth    AS child_depth,
                      call_seq AS child_call_seq,
                      id       AS child_id
               FROM call_edges
               WHERE session_id = ? AND depth BETWEEN 1 AND ?
             )
             SELECT
               p.fn_name    AS caller_fn,
               p.fn_iid     AS caller_iid,
               c.callee_fn,
               c.callee_iid,
               COUNT(*)     AS edge_count
             FROM child_calls c
             JOIN call_edges p
               ON p.session_id = ?
               AND p.depth     = c.child_depth - 1
               AND p.call_seq  <= c.child_call_seq
               AND p.return_seq >= c.child_call_seq
             GROUP BY caller_fn, caller_iid, callee_fn, callee_iid
             LIMIT 2000`,
            id, depthN, id
        );

        // ─ Step 3: 热点 IID（可选，O(H)）──────────────────────────────────
        let iidNodes = [];
        if (doIncludeIids) {
            iidNodes = db.all(
                `SELECT iid, count, line, src_text FROM iid_counts
                 WHERE session_id = ? AND count >= ?
                 ORDER BY count DESC LIMIT 100`,
                id, minCountN
            );
        }

        // ─ Step 4: 循环块（O(L)）──────────────────────────────────────────
        const loopRows = db.all(
            `SELECT iid, SUM(iteration_count) AS total_iters, MIN(line) AS line
             FROM loops WHERE session_id = ?
             GROUP BY iid ORDER BY total_iters DESC LIMIT 50`,
            id
        );

        // 预建 Set：O(1) 判断 iid 是否为循环 iid
        const loopIidSet = new Set(loopRows.map(l => l.iid));

        // ─ Step 5: 构建节点（O(F + L + H)）──────────────────────────────
        const nodes   = [];
        const nodeIds = new Set();

        // 函数节点（hasLoop：O(1) Set 查找）
        for (const fn of fnRows) {
            const nodeId = `fn:${fn.fn_name}:${fn.fn_iid ?? '?'}`;
            if (nodeIds.has(nodeId)) continue;
            nodeIds.add(nodeId);
            nodes.push({
                id:        nodeId,
                type:      'function',
                fnName:    fn.fn_name,
                fnIid:     fn.fn_iid,
                callCount: fn.call_count,
                minLine:   fn.min_line,
                minDepth:  fn.min_depth,
                maxDepth:  fn.max_depth,
                // hasLoop 近似：若该函数所在行范围内有循环 IID 的 iid_counts 行号
                // 仅作展示用，使用轻量近似：函数名在 loops 表相关 iid 的 line 附近
                hasLoop: false, // 后续在 Step 5b 用 SQL 关联修正（可选）
            });
        }

        // 循环节点
        for (const loop of loopRows) {
            const nodeId = `loop:${loop.iid}`;
            if (!nodeIds.has(nodeId)) {
                nodeIds.add(nodeId);
                nodes.push({
                    id:         nodeId,
                    type:       'loop',
                    iid:        loop.iid,
                    line:       loop.line,
                    totalIters: loop.total_iters,
                    folded:     doFoldLoops,
                });
            }
        }

        // 热点 IID 节点（排除循环 IID，用预建 Set 判断）
        if (doIncludeIids) {
            for (const iid of iidNodes) {
                if (loopIidSet.has(iid.iid)) continue;  // O(1)
                const nodeId = `iid:${iid.iid}`;
                if (!nodeIds.has(nodeId)) {
                    nodeIds.add(nodeId);
                    nodes.push({
                        id:      nodeId,
                        type:    'hotspot',
                        iid:     iid.iid,
                        count:   iid.count,
                        line:    iid.line,
                        srcText: iid.src_text,
                    });
                }
            }
        }

        // ─ Step 6: 构建边（O(E)）─────────────────────────────────────────
        const edges   = [];
        const edgeIds = new Set();

        for (const e of callEdges) {
            const srcId = `fn:${e.caller_fn}:${e.caller_iid ?? '?'}`;
            const tgtId = `fn:${e.callee_fn}:${e.callee_iid ?? '?'}`;
            if (!nodeIds.has(srcId) || !nodeIds.has(tgtId)) continue;
            const edgeId = `${srcId}→${tgtId}`;
            if (edgeIds.has(edgeId)) continue;
            edgeIds.add(edgeId);
            edges.push({
                id:        edgeId,
                source:    srcId,
                target:    tgtId,
                type:      'call',
                edgeCount: e.edge_count,
            });
        }

        // 循环回边
        for (const loop of loopRows) {
            const loopNodeId = `loop:${loop.iid}`;
            if (!nodeIds.has(loopNodeId)) continue;
            const edgeId = `${loopNodeId}→${loopNodeId}`;
            if (!edgeIds.has(edgeId)) {
                edgeIds.add(edgeId);
                edges.push({
                    id:         edgeId,
                    source:     loopNodeId,
                    target:     loopNodeId,
                    type:       'loop-back',
                    totalIters: loop.total_iters,
                });
            }
        }

        // ─ Step 7: 标记根节点（没有入边的函数节点）──────────────────────
        const hasIncoming = new Set(edges.map(e => e.target));
        const rootNodes   = nodes
            .filter(n => n.type === 'function' && !hasIncoming.has(n.id))
            .map(n => n.id);

        // 快速统计（避免多次 filter）
        let fnNodes = 0, loopNodes = 0, hotspotNodes = 0;
        let callEdgesCount = 0, loopBackEdges = 0;
        for (const n of nodes) {
            if (n.type === 'function') fnNodes++;
            else if (n.type === 'loop') loopNodes++;
            else hotspotNodes++;
        }
        for (const e of edges) {
            if (e.type === 'call') callEdgesCount++;
            else loopBackEdges++;
        }

        res.json({
            nodes,
            edges,
            rootNodes,
            stats: {
                totalNodes:    nodes.length,
                fnNodes,
                loopNodes,
                hotspotNodes,
                totalEdges:    edges.length,
                callEdges:     callEdgesCount,
                loopBackEdges,
            },
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/cfg] error:');
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/fn-cfg ──────────────────────────────────────────
// IDA 风格单函数内部控制流图
//
// 思路：
//   利用 call_edges 确定函数每次调用的 [call_seq, return_seq] 窗口
//   + events 中该窗口内的 iid 序列（排除子调用区间，得到"自身事件"iid 序列）
//   + smap   获取每个 iid 的行号/源码
//   + iid_counts 获取每个 iid 的执行次数
//
//   基本块划分：
//     - 对所有调用的 iid 序列做 union，按行号排序分块
//     - 相邻行号之差 ≤ 1（或源码上"同一基本块"）归为同一块
//     - 识别"跳转点"：某 iid 之后，下一个 iid 不是行号+1（可能是分支或循环）
//
//   边推断（动态观测）：
//     - 对每次实际调用采样，记录 iid 之间的"转移"序列（nextIid[iid] → Set<nextIid>）
//     - 块间转移 = 块末尾 iid → 下一个块的首个 iid 转移
//     - 转移频率用于标注边权重
//
// 查询参数：
//   fnName    string   目标函数名（必填）
//   fnIid     number   fn_iid 精确过滤（同名不同位置时使用）
//   maxCalls  number   采样调用次数上限（默认 20，最多 100）
//   minLine / maxLine  行号范围过滤（可缩小函数体分析范围）

router.get('/fn-cfg', (req, res) => {
    try {
        const { id } = req.params;
        const {
            fnName,
            fnIid,
            maxCalls = '20',
            minLine,
            maxLine,
            callId,   // 可选：指定单次调用 ID，高亮该调用走过的路径
        } = req.query;

        if (!fnName) return res.status(400).json({ error: 'fnName is required' });

        const session = db.get('SELECT id FROM sessions WHERE id = ?', id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const maxCallsN = Math.min(Number(maxCalls) || 20, 100);

        // ─ Step 1: 找到目标函数的调用记录（采样 maxCallsN 次）──────────────
        const fnConds = ['session_id = ?', 'fn_name = ?'];
        const fnParams = [id, fnName];
        if (fnIid !== undefined && fnIid !== '') {
            fnConds.push('fn_iid = ?');
            fnParams.push(Number(fnIid));
        }

        // 聚合信息
        const fnMeta = db.get(
            `SELECT fn_name, fn_iid, COUNT(*) AS call_count,
                    MIN(caller_line) AS entry_line,
                    MIN(depth) AS min_depth
             FROM call_edges WHERE ${fnConds.join(' AND ')}
             GROUP BY fn_name, fn_iid`,
            ...fnParams
        );
        if (!fnMeta) return res.status(404).json({ error: `Function "${fnName}" not found` });

        // 采样调用记录
        // 若指定 callId，直接取该次调用（用于单次路径高亮）
        const callIdN = callId != null ? Number(callId) : null;
        let sampledCalls;
        let totalCalls;
        let singleCallMode = false;  // 单次调用模式

        if (callIdN != null) {
            // 单次调用模式：直接取该次调用，忽略 maxCalls
            const singleCall = db.get(
                `SELECT id, call_seq, return_seq, caller_line
                 FROM call_edges WHERE session_id = ? AND id = ?`,
                id, callIdN
            );
            if (!singleCall) return res.status(404).json({ error: `Call ${callIdN} not found` });
            sampledCalls = [singleCall];
            totalCalls   = 1;
            singleCallMode = true;
        } else {
            const allCalls = db.all(
                `SELECT id, call_seq, return_seq, caller_line
                 FROM call_edges WHERE ${fnConds.join(' AND ')}
                 ORDER BY call_seq ASC`,
                ...fnParams
            );
            totalCalls = allCalls.length;

            // 均匀采样
            sampledCalls = allCalls;
            if (allCalls.length > maxCallsN) {
                const step = allCalls.length / maxCallsN;
                sampledCalls = Array.from({ length: maxCallsN }, (_, i) =>
                    allCalls[Math.floor(i * step)]
                );
            }
        }

        // ─ Step 2: 获取函数体内的子调用（用于排除子调用的 SEQ 区间）────────
        // 对每次采样调用，找到其直接子调用（depth = fn_depth + 1，且 call_seq 在范围内）
        // 为减少查询次数，批量查询所有采样调用的子调用
        // 获取函数本身的 depth
        const fnDepthRow = db.get(
            `SELECT depth FROM call_edges WHERE ${fnConds.join(' AND ')} LIMIT 1`,
            ...fnParams
        );
        const fnDepth = fnDepthRow?.depth ?? 0;

        // ─ Step 3: 批量获取所有采样调用区间内的 events（iid 序列）──────────
        // 对每次调用，先取该区间内所有 iid（按 event.id 顺序）
        // 再排除子调用子区间的 iid（通过 NOT BETWEEN 过滤）
        //
        // 注意：events 表只有 iid 列，没有 seq 列
        //       事件的顺序 = event.id 的顺序（F1 写入时是顺序递增的）
        //       call_seq/return_seq = event.id（F3 用的是 event.id 作为 SEQ）
        //
        // 性能策略：限制采样调用数量，每次调用最多读取 2000 个 iid

        // 收集所有调用的子调用区间（用于排除）
        // 不用 OR 链（会触发 SQLite expression tree 超限），改为取整体范围再 JS 侧过滤
        const subCallMap = new Map(); // callId → [{call_seq, return_seq}]
        if (sampledCalls.length > 0) {
            // 取所有采样调用的最小 call_seq 和最大 return_seq 作为大范围
            const minSeq = Math.min(...sampledCalls.map(c => c.call_seq));
            const maxSeq = Math.max(...sampledCalls.map(c => c.return_seq));
            const allSubCalls = db.all(
                `SELECT id, call_seq, return_seq
                 FROM call_edges
                 WHERE session_id = ? AND depth = ? AND call_seq >= ? AND call_seq <= ?`,
                id, fnDepth + 1, minSeq, maxSeq
            );
            // JS 侧：精确归属到对应的父调用
            for (const sc of allSubCalls) {
                for (const call of sampledCalls) {
                    if (sc.call_seq >= call.call_seq && sc.call_seq <= call.return_seq) {
                        if (!subCallMap.has(call.id)) subCallMap.set(call.id, []);
                        subCallMap.get(call.id).push(sc);
                        break;
                    }
                }
            }
        }

        // ─ Step 4: 收集每次调用的 iid 转移序列（有序）──────────────────────
        // iidTransitions: Map<iid, Map<nextIid, count>>
        const iidTransitions = new Map();
        // iidCallPresence: Map<iid, Set<callId>>（iid 在哪些调用中出现过）
        const iidCallPresence = new Map();
        // iidFirstOccurrence: Map<iid, {callIdx, posInCall}> —— 仅用于排序
        const iidFirstOccurrence = new Map();

        let callIdx = 0;
        for (const call of sampledCalls) {
            const subCalls = subCallMap.get(call.id) || [];

            // 取整个调用区间的 iid+id（不做 NOT BETWEEN 过滤，避免子调用多时触发
            // SQLite "Expression tree is too large" 错误）
            // 在 JS 侧按子调用区间过滤，性能完全足够（最多 2000 条）
            const rawRows = db.all(
                `SELECT id, iid FROM events
                 WHERE session_id = ? AND id >= ? AND id <= ? AND iid IS NOT NULL
                 ORDER BY id ASC
                 LIMIT 2000`,
                id, call.call_seq, call.return_seq
            );

            // JS 侧排除子调用区间：为每个子调用建 [call_seq, return_seq] 区间，
            // 用排序+二分或简单线性扫描均可（子调用数通常不超过几百个）
            let iidSeq;
            if (subCalls.length === 0) {
                iidSeq = rawRows.map(r => r.iid);
            } else {
                // 对子调用区间排序，方便快速判断
                const intervals = subCalls
                    .map(sc => [sc.call_seq, sc.return_seq])
                    .sort((a, b) => a[0] - b[0]);

                iidSeq = [];
                for (const row of rawRows) {
                    const eid = row.id;
                    // 检查 eid 是否落在任意子调用区间内
                    let inSub = false;
                    for (const [lo, hi] of intervals) {
                        if (lo > eid) break;   // 区间已排序，后续不可能匹配
                        if (eid <= hi) { inSub = true; break; }
                    }
                    if (!inSub) iidSeq.push(row.iid);
                }
            }

            // 记录 iid 出现（去重）
            const seenInCall = new Set();
            for (let i = 0; i < iidSeq.length; i++) {
                const iid = iidSeq[i];
                if (!seenInCall.has(iid)) {
                    seenInCall.add(iid);
                    if (!iidCallPresence.has(iid)) iidCallPresence.set(iid, new Set());
                    iidCallPresence.get(iid).add(call.id);

                    if (!iidFirstOccurrence.has(iid)) {
                        iidFirstOccurrence.set(iid, { callIdx, pos: i });
                    }
                }

                // 记录 iid 转移（相邻的 iid 对）
                if (i + 1 < iidSeq.length) {
                    const nextIid = iidSeq[i + 1];
                    if (nextIid !== iid) { // 排除自循环（同一 iid 连续）
                        if (!iidTransitions.has(iid)) iidTransitions.set(iid, new Map());
                        const targets = iidTransitions.get(iid);
                        targets.set(nextIid, (targets.get(nextIid) || 0) + 1);
                    }
                }
            }
            callIdx++;
        }

        // ─ Step 5: 获取所有出现过的 iid 的 smap 信息（行号+源码）─────────────
        const allIids = [...iidCallPresence.keys()];
        if (allIids.length === 0) {
            return res.json({
                fnName: fnMeta.fn_name,
                fnIid: fnMeta.fn_iid,
                totalCalls,
                sampledCalls: sampledCalls.length,
                blocks: [],
                edges: [],
                stats: { blockCount: 0, edgeCount: 0, iidCount: 0 },
            });
        }

        // IN(...) 列表过长会触发 SQLite expression tree 超限，分批查询（每批 500 个）
        const BATCH = 500;
        function queryInBatches(table, selectCols, iids) {
            const rows = [];
            for (let i = 0; i < iids.length; i += BATCH) {
                const chunk = iids.slice(i, i + BATCH);
                const placeholders = chunk.map(() => '?').join(',');
                const chunkRows = db.all(
                    `SELECT ${selectCols} FROM ${table}
                     WHERE session_id = ? AND iid IN (${placeholders})`,
                    id, ...chunk
                );
                rows.push(...chunkRows);
            }
            return rows;
        }

        const smapRows = queryInBatches('smap', 'iid, sl AS line, src_text', allIids);
        const smapMap = new Map(smapRows.map(r => [r.iid, r]));

        // iid_counts（执行次数）
        const iidCountRows = queryInBatches('iid_counts', 'iid, count', allIids);
        const iidCountMap = new Map(iidCountRows.map(r => [r.iid, r.count]));

        // 子调用信息（供显示"调用了哪个函数"）
        // 同样不用 OR 链，改为整体 min/max 范围查询
        const subCallFnRows = sampledCalls.length > 0 ? db.all(
            `SELECT fn_name, fn_iid, caller_line, COUNT(*) AS cnt
             FROM call_edges
             WHERE session_id = ? AND depth = ? AND call_seq >= ? AND call_seq <= ?
             GROUP BY fn_name, fn_iid, caller_line`,
            id, fnDepth + 1,
            Math.min(...sampledCalls.map(c => c.call_seq)),
            Math.max(...sampledCalls.map(c => c.return_seq))
        ) : [];
        // 按 caller_line 建立子调用映射
        const subCallByLine = new Map();
        for (const sc of subCallFnRows) {
            if (!subCallByLine.has(sc.caller_line)) subCallByLine.set(sc.caller_line, []);
            subCallByLine.get(sc.caller_line).push(sc);
        }

        // ─ Step 6: 基本块划分 ────────────────────────────────────────────────
        // 按行号分组 iid，行号相邻（diff ≤ 2）且中间没有"跳转"归为同一块
        //
        // 算法：
        //   1. 对所有 iid 按「首次出现的调用索引 + 在调用中的位置」排序（近似顺序）
        //   2. 按行号聚类：相邻 iid 行号之差 ≤ 2 归为同一块
        //   3. 块内按行号从小到大排列

        // 按行号排序，无行号信息的 iid 放到末尾
        const sortedIids = allIids.sort((a, b) => {
            const la = smapMap.get(a)?.line ?? 999999;
            const lb = smapMap.get(b)?.line ?? 999999;
            if (la !== lb) return la - lb;
            // 同行按首次出现顺序
            const fa = iidFirstOccurrence.get(a);
            const fb = iidFirstOccurrence.get(b);
            if (!fa) return 1;
            if (!fb) return -1;
            return fa.callIdx - fb.callIdx || fa.pos - fb.pos;
        });

        // 行号分块（同一行或相邻行归为一块，每块最多 MAX_IID_PER_BLOCK 个 iid）
        // 注意：MAX_IID_PER_BLOCK 设大一点，减少碎块；行号差阈值 LINE_GAP 控制分块粒度
        const MAX_IID_PER_BLOCK = 40;  // 单块最多 40 个唯一 iid（行去重后通常 ≤ 10 行）
        const LINE_GAP = 3;            // 行号差 > 3 时分新块（原为 2）
        const blocks = [];
        let currentBlock = null;
        let prevLine = -999;

        for (const iid of sortedIids) {
            const smap = smapMap.get(iid);
            const line = smap?.line ?? null;
            const lineDiff = line !== null ? line - prevLine : 999;

            const shouldNewBlock = !currentBlock
                || lineDiff > LINE_GAP
                || currentBlock.iids.length >= MAX_IID_PER_BLOCK;

            if (shouldNewBlock) {
                currentBlock = {
                    id: `block:${blocks.length}`,
                    iids: [],
                    lines: [],
                    srcTexts: [],
                    execCounts: [],
                    callCount: sampledCalls.length,
                    // 该块出现在多少次调用中（最高频 iid 的出现次数）
                    presence: 0,
                    subCalls: [],
                    // 标记：是否是入口块（行号最小）
                    isEntry: blocks.length === 0,
                };
                blocks.push(currentBlock);
            }

            const count = iidCountMap.get(iid) ?? 0;
            const srcText = smap?.src_text ?? '';
            currentBlock.iids.push(iid);
            currentBlock.lines.push(line);
            currentBlock.srcTexts.push(srcText);
            currentBlock.execCounts.push(count);
            currentBlock.presence = Math.max(currentBlock.presence, iidCallPresence.get(iid)?.size ?? 0);

            // 检查该 iid 所在行是否有子调用
            if (line !== null && subCallByLine.has(line)) {
                for (const sc of subCallByLine.get(line)) {
                    if (!currentBlock.subCalls.find(s => s.fnName === sc.fn_name && s.line === sc.caller_line)) {
                        currentBlock.subCalls.push({ fnName: sc.fn_name, fnIid: sc.fn_iid, line: sc.caller_line, cnt: sc.cnt });
                    }
                }
            }

            if (line !== null) prevLine = line;
        }

        // ─ Step 7: 构建块间边 ────────────────────────────────────────────────
        // 利用 iidTransitions（iid → nextIid 的转移频率）
        // 找出"块末尾 iid → 其他块首 iid"的跨块转移

        // 建立 iid → blockIdx 的映射
        const iidToBlock = new Map();
        for (let bi = 0; bi < blocks.length; bi++) {
            for (const iid of blocks[bi].iids) {
                iidToBlock.set(iid, bi);
            }
        }

        // 块边：Map<`${srcBi}→${tgtBi}`, {count, type}>
        const blockEdgeMap = new Map();

        for (const [srcIid, targets] of iidTransitions) {
            const srcBi = iidToBlock.get(srcIid);
            if (srcBi === undefined) continue;

            for (const [tgtIid, count] of targets) {
                const tgtBi = iidToBlock.get(tgtIid);
                if (tgtBi === undefined) continue;
                if (tgtBi === srcBi) continue; // 同块内转移忽略

                const key = `${srcBi}→${tgtBi}`;
                if (!blockEdgeMap.has(key)) {
                    blockEdgeMap.set(key, { srcBi, tgtBi, count: 0, isBack: false, isCond: false });
                }
                blockEdgeMap.get(key).count += count;
            }
        }

        // 识别回边（目标块索引 < 源块索引，且目标块是某个条件块的头）
        // 粗略：tgtBi < srcBi 且 tgtBi 有多于一条入边 → 认为是循环回边
        const inEdgeCount = new Map(); // bi → 入边数
        for (const { srcBi, tgtBi } of blockEdgeMap.values()) {
            inEdgeCount.set(tgtBi, (inEdgeCount.get(tgtBi) || 0) + 1);
        }

        const edges = [];
        for (const edge of blockEdgeMap.values()) {
            const { srcBi, tgtBi, count } = edge;
            // 回边：目标块在源块之前（行号更小）
            const srcMinLine = Math.min(...blocks[srcBi].lines.filter(l => l !== null));
            const tgtMinLine = Math.min(...blocks[tgtBi].lines.filter(l => l !== null));
            const isBack = tgtMinLine < srcMinLine && tgtMinLine !== Infinity;

            // 条件边：源块有多个出边目标
            const srcOutEdges = [...blockEdgeMap.values()].filter(e => e.srcBi === srcBi);
            const isCond = srcOutEdges.length > 1;

            // 边类型
            let edgeType = 'flow';
            if (isBack) edgeType = 'back';
            else if (isCond) edgeType = 'cond';

            // 对于有两条出边的块，标记 true/false
            let edgeLabel = '';
            if (isCond && srcOutEdges.length === 2) {
                const sorted = srcOutEdges.slice().sort((a, b) => b.count - a.count);
                edgeLabel = edge === sorted[0] ? 'T' : 'F';
            }

            edges.push({
                id: `${blocks[srcBi].id}→${blocks[tgtBi].id}`,
                source: blocks[srcBi].id,
                target: blocks[tgtBi].id,
                type: edgeType,
                count,
                label: edgeLabel,
            });
        }

        // ─ Step 7.5: 总块数上限（防止超大函数渲染崩溃）──────────────────────
        // Cytoscape breadthfirst 布局 + label 渲染有节点数上限，超过 50 块时
        // 按 presence 降序保留最重要的块（最常执行的路径）
        const MAX_BLOCKS = 50;
        let blocksToOutput = blocks;
        let keptBlockIds = null;  // null = 全部保留
        if (blocks.length > MAX_BLOCKS) {
            const sorted = [...blocks].sort((a, b) => b.presence - a.presence);
            blocksToOutput = sorted.slice(0, MAX_BLOCKS);
            keptBlockIds = new Set(blocksToOutput.map(b => b.id));
        }

        // ─ Step 8: 整理最终数据 ──────────────────────────────────────────────
        // 块的输出：精简结构
        const outputBlocks = blocksToOutput.map(b => {
            // 行去重（同一行可能有多个 iid）
            const lineMap = new Map(); // line → {srcText, execCount, iids[]}
            for (let i = 0; i < b.iids.length; i++) {
                const line = b.lines[i];
                const key = line ?? `?${i}`;
                if (!lineMap.has(key)) {
                    lineMap.set(key, { line, srcText: b.srcTexts[i], execCount: 0, iids: [] });
                }
                lineMap.get(key).execCount += b.execCounts[i];
                lineMap.get(key).iids.push(b.iids[i]);
            }
            const lineList = [...lineMap.values()].sort((a, b) => {
                if (a.line === null) return 1;
                if (b.line === null) return -1;
                return a.line - b.line;
            });

            // 每块最多显示 MAX_LINES_PER_BLOCK 行，超出时截断并记录省略数量
            // 这直接控制了 Cytoscape 节点 label 的行数，避免 expression tree 超限
            const MAX_LINES_PER_BLOCK = 10;
            const omitted = lineList.length > MAX_LINES_PER_BLOCK
                ? lineList.length - MAX_LINES_PER_BLOCK
                : 0;
            const displayLines = omitted > 0 ? lineList.slice(0, MAX_LINES_PER_BLOCK) : lineList;

            // 单次调用模式：该块是否被本次调用执行（presence > 0 即被执行）
            const activeInCall = singleCallMode ? b.presence > 0 : null;

            return {
                id: b.id,
                isEntry: b.isEntry,
                minLine: lineList.length > 0 ? (lineList[0].line ?? null) : null,
                maxLine: lineList.length > 0 ? (lineList[lineList.length - 1].line ?? null) : null,
                presence: b.presence,
                callCount: sampledCalls.length,
                lines: displayLines,
                omittedLines: omitted,  // 省略行数（前端可显示 "...+N 行"）
                subCalls: b.subCalls,
                isCold: b.presence < sampledCalls.length * 0.1,  // 出现率 < 10% 为冷块
                isHot: b.presence >= sampledCalls.length * 0.9,  // 出现率 ≥ 90% 为热块
                activeInCall,  // 单次调用模式：true=执行过, false=未执行, null=多调用模式
            };
        });

        // 过滤 edges（仅保留两端块都在 blocksToOutput 中的边）
        const outputBlockIds = new Set(outputBlocks.map(b => b.id));
        const filteredEdges = edges.filter(e =>
            outputBlockIds.has(e.source) && outputBlockIds.has(e.target)
        );

        // 单次调用模式：标记边是否被激活（两端块都被执行）
        const outputEdges = singleCallMode ? filteredEdges.map(edge => {
            const srcBlock = outputBlocks.find(b => b.id === edge.source);
            const tgtBlock = outputBlocks.find(b => b.id === edge.target);
            return {
                ...edge,
                activeInCall: !!(srcBlock?.activeInCall && tgtBlock?.activeInCall),
            };
        }) : filteredEdges.map(e => ({ ...e, activeInCall: null }));

        res.json({
            fnName: fnMeta.fn_name,
            fnIid: fnMeta.fn_iid,
            entryLine: fnMeta.entry_line,
            totalCalls,
            sampledCalls: sampledCalls.length,
            singleCallMode,
            callId: callIdN,
            blocks: outputBlocks,
            edges: outputEdges,
            stats: {
                blockCount: outputBlocks.length,
                edgeCount: outputEdges.length,
                iidCount: allIids.length,
                // 若有裁剪，记录原始数量
                totalBlockCount: blocks.length,
                totalEdgeCount: edges.length,
                truncated: keptBlockIds !== null,
            },
        });
    } catch (e) {
        log.error({ err: e }, '[GET /api/sessions/:id/fn-cfg] error:');
        res.status(500).json({ error: e.message });
    }
});

export default router;
