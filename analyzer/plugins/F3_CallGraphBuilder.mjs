/**
 * F3_CallGraphBuilder.mjs — 配对 CALL_PRE/CALL 事件，重建调用图
 *
 * 性能设计（value_dict 版）：
 *  - 只做 3 次全量顺序扫描（events × 1、reads × 1、writes × 1），完全无 IN 查询
 *  - 利用 (session_id, name) / (session_id, type) 索引，每次扫描 O(N_session)
 *  - reads / writes 单次全量扫描时 JOIN value_dict（一次扫描，不分批）
 *    ── value_dict 行数 << writes 行数；JOIN 走 (session_id,id) PK，每行 O(log vd_size)
 *    ── 比分批 IN 查询（N 次 prepare + 随机 B-Tree 跳转）快数倍
 *  - writes 表一次扫描同时收集 args（CALL_PRE）和 return（CALL），无重复 IO
 *  - 所有数据全部加载到 Map 后纯内存配对，无 N+1
 *  - 批量写入用单事务 + 预编译 stmt，BATCH_SIZE=10000
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import { TYPE } from '../db/EventTypeCode.mjs';

const BATCH_SIZE = () => cfg('plugins.F3_CallGraphBuilder.batchSize');

export default class F3CallGraphBuilder extends BasePlugin {
    static id = 'F3-CallGraphBuilder';
    static deps = ['F1-EventIndex'];
    static description = '配对 CALL_PRE/CALL 事件，重建调用图，写入 call_edges 表';
    static displayName = 'F3 · CallGraphBuilder';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();
        const _batchSize = BATCH_SIZE();

        this.emitProgress(ctx, '清空旧数据...', 0);
        rawDb.prepare('DELETE FROM call_edges WHERE session_id = ?').run(sessionId);

        // ── Step 1: 一次性读取所有 CALL_PRE 和 CALL 事件 ──────────────────────
        this.emitProgress(ctx, '读取调用事件...', 3);
        const callEvents = rawDb.prepare(
            `SELECT id, type, iid FROM events WHERE session_id = ? AND type IN (${TYPE.CALL_PRE}, ${TYPE.CALL}) ORDER BY id ASC`
        ).all(sessionId);

        if (callEvents.length === 0) {
            this.emitProgress(ctx, '无调用事件', 100);
            this.emitDone(ctx, { edgeCount: 0 });
            return;
        }

        // 建立两个 Set，用于 writes 扫描时的快速过滤
        const callPreSet = new Set();
        const callSet    = new Set();
        for (const e of callEvents) {
            if (e.type === TYPE.CALL_PRE) callPreSet.add(e.id);
            else                          callSet.add(e.id);
        }

        this.emitProgress(ctx,
            `找到 ${callPreSet.size} 次调用入口，${callSet.size} 次返回，加载关联数据...`,
            8
        );

        // ── Step 2: 单次扫描 reads 取 callee 名 + callee_def_iid ──────────────
        // 利用 idx_reads_name(session_id, name) 索引，合并扫描 name IN ('callee','callee_def_iid') 的行
        // 单次全量扫描 + JOIN，避免分批 IN 导致的 N 次 prepare + 随机 B-Tree 跳转
        const calleeMap       = new Map(); // event_id → callee name string
        const calleeDefIidMap = new Map(); // event_id → fn_def_iid (number)
        {
            const rows = rawDb.prepare(
                `SELECT r.event_id, r.name, vd.val_text AS value
                 FROM reads r
                 LEFT JOIN value_dict vd ON vd.session_id = r.session_id AND vd.id = r.value_id
                 WHERE r.session_id = ? AND r.name IN ('callee', 'callee_def_iid')`
            ).all(sessionId);
            for (const r of rows) {
                if (r.name === 'callee') {
                    calleeMap.set(r.event_id, r.value?.replace(/^"|"$/g, '') ?? null);
                } else {
                    // callee_def_iid 存的是整数字符串，转回 number
                    const n = r.value !== null ? Number(r.value) : null;
                    if (n !== null && !isNaN(n)) calleeDefIidMap.set(r.event_id, n);
                }
            }
        }

        this.emitProgress(ctx, '加载参数/返回值数据（单次全量扫描）...', 20);

        // ── Step 3: 单次扫描 writes，同时收集 args（CALL_PRE）和 return（CALL）──
        // 全量顺序扫描一次（利用顺序 I/O 优势），JOIN value_dict 取完整值
        // JS 侧按 callPreSet/callSet 分流，比分批 IN 快 10x+
        const argsBuf = new Map(); // callPre event_id → [{name,value}]
        const retMap  = new Map(); // call   event_id → return value string
        {
            const rows = rawDb.prepare(
                `SELECT w.event_id, w.name, vd.val_text AS value
                 FROM writes w
                 LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
                 WHERE w.session_id = ?`
            ).all(sessionId);

            for (const r of rows) {
                if (callPreSet.has(r.event_id)) {
                    // CALL_PRE 的 writes → args
                    let arr = argsBuf.get(r.event_id);
                    if (!arr) { arr = []; argsBuf.set(r.event_id, arr); }
                    arr.push({ name: r.name, value: r.value });
                } else if (callSet.has(r.event_id)) {
                    // CALL 的 writes → return value（优先 name='return'）
                    if (!retMap.has(r.event_id) || r.name === 'return') {
                        retMap.set(r.event_id, r.value ?? null);
                    }
                }
            }
        }
        // 把 argsBuf 序列化为 JSON
        const argsMap = new Map();
        for (const [id, arr] of argsBuf) {
            argsMap.set(id, JSON.stringify(arr));
        }

        // ── Step 3.5: 预加载 smap iid→line（caller_line 来源）──────────────────
        const smapLineMap = new Map(); // iid → sl (start line)
        {
            const rows = rawDb.prepare(
                'SELECT iid, sl FROM smap WHERE session_id = ?'
            ).all(sessionId);
            for (const r of rows) smapLineMap.set(r.iid, r.sl);
        }

        this.emitProgress(ctx, '配对调用栈，构建调用图...', 40);

        // ── Step 4: 内存配对 CALL_PRE / CALL ──────────────────────────────────────
        const stack   = [];
        let depth     = 0;
        let edgeCount = 0;
        const edges   = [];

        const stmt = rawDb.prepare(
            'INSERT INTO call_edges (session_id, call_seq, return_seq, caller_line, fn_name, fn_iid, args_json, return_value, depth, own_event_count, fn_def_iid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const insertBatch = rawDb.transaction((batch) => {
            for (const e of batch) stmt.run(e);
        });

        const flushEdges = () => {
            if (edges.length === 0) return;
            insertBatch(edges);
            edges.length = 0;
        };

        const totalEvents = callEvents.length;
        let processed = 0;

        for (const evt of callEvents) {
            processed++;

            if (evt.type === TYPE.CALL_PRE) {
                stack.push({
                    call_seq:         evt.id,
                    caller_line:      smapLineMap.get(evt.iid) ?? null,
                    fn_iid:           evt.iid,
                    fn_name:          calleeMap.get(evt.id) ?? `fn@${evt.iid || 'unknown'}`,
                    fn_def_iid:       calleeDefIidMap.get(evt.id) ?? null,
                    args_json:        argsMap.get(evt.id) ?? '[]',
                    depth:            depth++,
                    child_event_span: 0,  // 直接子调用消耗的 SEQ 跨度之和
                });

            } else if (evt.type === TYPE.CALL) {
                if (stack.length === 0) { depth = Math.max(0, depth - 1); continue; }
                const frame = stack.pop();
                depth = Math.max(0, depth - 1);

                // own_event_count = 全区间跨度 - 所有直接子调用占用的跨度
                // 全区间：evt.id - frame.call_seq（含 CALL_PRE 和 CALL 自身，近似）
                const totalSpan = evt.id - frame.call_seq;
                const ownCount  = Math.max(0, totalSpan - frame.child_event_span);

                edges.push([
                    sessionId,
                    frame.call_seq,
                    evt.id,
                    frame.caller_line,
                    frame.fn_name,
                    frame.fn_iid,
                    frame.args_json,
                    retMap.get(evt.id) ?? null,
                    frame.depth,
                    ownCount,
                    frame.fn_def_iid ?? null,
                ]);
                edgeCount++;

                // 向父帧累加本次调用消耗的 SEQ 跨度（含子调用），供父帧计算 own_event_count
                if (stack.length > 0) {
                    stack[stack.length - 1].child_event_span += totalSpan;
                }

                if (edges.length >= _batchSize) {
                    flushEdges();
                    const pct = Math.min(95, 40 + Math.round((processed / totalEvents) * 55));
                    this.emitProgress(ctx, `已写入 ${edgeCount} 条调用边...`, pct);
                }
            }
        }

        flushEdges();

        this.emitProgress(ctx, `完成，共 ${edgeCount} 条调用边`, 100);

        // 补充 fnCount / maxDepth（call_edges 已写入 DB）
        let fnCount = 0, maxDepth = 0;
        try {
            const rawDb = db.raw();
            const rows = rawDb.prepare(`
                SELECT COUNT(DISTINCT fn_iid) AS fn_count, MAX(depth) AS max_depth
                FROM call_edges WHERE session_id = ?
            `).get(sessionId);
            fnCount  = rows?.fn_count  ?? 0;
            maxDepth = rows?.max_depth ?? 0;
        } catch { /* 非致命 */ }

        this.emitDone(ctx, { callCount: edgeCount, fnCount, maxDepth });
    }
}
