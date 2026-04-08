/**
 * F3_CallGraphBuilder.mjs — 配对 CALL_PRE/CALL 事件，重建调用图
 *
 * 性能设计（最终版）：
 *  - 只做 3 次全量顺序扫描（events × 1、reads × 1、writes × 1），完全无 IN 查询
 *  - 利用 (session_id, name) / (session_id, type) 索引，每次扫描 O(N_session)
 *  - writes 表一次扫描同时收集 args（CALL_PRE）和 return（CALL），无重复 IO
 *  - 所有数据全部加载到 Map 后纯内存配对，无 N+1
 *  - 批量写入用单事务 + 预编译 stmt，BATCH_SIZE=10000
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 10000;

export default class F3CallGraphBuilder extends BasePlugin {
    static id = 'F3-CallGraphBuilder';
    static deps = ['F1-EventIndex'];
    static description = '配对 CALL_PRE/CALL 事件，重建调用图，写入 call_edges 表';
    static displayName = 'F3 · CallGraphBuilder';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        rawDb.prepare('DELETE FROM call_edges WHERE session_id = ?').run(sessionId);

        // ── Step 1: 一次性读取所有 CALL_PRE 和 CALL 事件 ──────────────────────
        this.emitProgress(ctx, '读取调用事件...', 3);
        const callEvents = rawDb.prepare(
            "SELECT id, type, iid, line FROM events WHERE session_id = ? AND type IN ('CALL_PRE', 'CALL') ORDER BY id ASC"
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
            if (e.type === 'CALL_PRE') callPreSet.add(e.id);
            else                        callSet.add(e.id);
        }

        this.emitProgress(ctx,
            `找到 ${callPreSet.size} 次调用入口，${callSet.size} 次返回，加载关联数据...`,
            8
        );

        // ── Step 2: 单次扫描 reads 取 callee 名 ──────────────────────────────────
        // 利用 idx_reads_name(session_id, name) 索引，只扫 name='callee' 的行
        const calleeMap = new Map(); // event_id → callee name string
        {
            const rows = rawDb.prepare(
                "SELECT event_id, value FROM reads WHERE session_id = ? AND name = 'callee'"
            ).all(sessionId);
            for (const r of rows) {
                calleeMap.set(r.event_id, r.value?.replace(/^"|"$/g, '') ?? null);
            }
        }

        this.emitProgress(ctx, '加载参数/返回值数据（单次扫描）...', 20);

        // ── Step 3: 单次扫描 writes，同时收集 args（CALL_PRE）和 return（CALL）──
        // 全量顺序扫描一次，JS 侧按 Set 分流，比分批 IN 快 10x+
        const argsBuf = new Map(); // callPre event_id → [{name,value}]
        const retMap  = new Map(); // call   event_id → return value string
        {
            const rows = rawDb.prepare(
                'SELECT event_id, name, value FROM writes WHERE session_id = ?'
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

        this.emitProgress(ctx, '配对调用栈，构建调用图...', 40);

        // ── Step 4: 内存配对 CALL_PRE / CALL ──────────────────────────────────────
        const stack   = [];
        let depth     = 0;
        let edgeCount = 0;
        const edges   = [];

        const stmt = rawDb.prepare(
            'INSERT INTO call_edges (session_id, call_seq, return_seq, caller_line, fn_name, fn_iid, args_json, return_value, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
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

            if (evt.type === 'CALL_PRE') {
                stack.push({
                    call_seq:    evt.id,
                    caller_line: evt.line,
                    fn_iid:      evt.iid,
                    fn_name:     calleeMap.get(evt.id) ?? `fn@${evt.iid || 'unknown'}`,
                    args_json:   argsMap.get(evt.id) ?? '[]',
                    depth:       depth++,
                });

            } else if (evt.type === 'CALL') {
                if (stack.length === 0) { depth = Math.max(0, depth - 1); continue; }
                const frame = stack.pop();
                depth = Math.max(0, depth - 1);

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
                ]);
                edgeCount++;

                if (edges.length >= BATCH_SIZE) {
                    flushEdges();
                    const pct = Math.min(95, 40 + Math.round((processed / totalEvents) * 55));
                    this.emitProgress(ctx, `已写入 ${edgeCount} 条调用边...`, pct);
                }
            }
        }

        flushEdges();

        this.emitProgress(ctx, `完成，共 ${edgeCount} 条调用边`, 100);
        this.emitDone(ctx, { edgeCount });
    }
}
