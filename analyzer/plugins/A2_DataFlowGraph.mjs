/**
 * A2_DataFlowGraph.mjs — 构建变量级 def-use 数据流图
 * 写入 dataflow_edges 表
 *
 * v2 重构：
 *  - assign 边：from_var = 定义变量名, to_var = 使用变量名（≠ 当 SSA 别名时相同，普通 def-use 时相同）
 *              真正的语义：哪个 write 事件 → 哪个 read 事件，变量名作辅助标签
 *  - call_arg 边：函数调用时，实参变量 → 形参变量（基于 call_edges + writes/reads 匹配）
 *  - call_ret 边：函数返回值 → 接收返回值的变量
 *  - field_write / field_read：属性读写，与 v1 相同
 *
 * 性能优化：
 *  - 一次性加载全部 events/writes/reads/fields，消除分批 IN 查询
 *  - 使用 prepared statement + 大 batch 事务写入
 *  - def-use 匹配：用二分查找取最近 write，O(log N)
 *  - call_arg/call_ret：先构建 call_seq → [write event] 的倒排索引，O(1) 查找
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 5000;

// 二分：在有序 arr 中找最后一个 key(item) < target 的位置
function upperBoundLt(arr, target, key) {
    let lo = 0, hi = arr.length - 1, res = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (key(arr[mid]) < target) { res = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return res;
}

// 二分：在有序 arr 中找第一个 key(item) >= target 的位置（-1 = 不存在）
function lowerBound(arr, target, key) {
    let lo = 0, hi = arr.length - 1, res = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (key(arr[mid]) >= target) { res = mid; hi = mid - 1; }
        else lo = mid + 1;
    }
    return res;
}

export default class A2DataFlowGraph extends BasePlugin {
    static id = 'A2-DataFlowGraph';
    static deps = ['F1-EventIndex'];
    static description = '构建变量级 def-use 数据流图，写入 dataflow_edges 表';
    static displayName = 'A2 · DataFlowGraph';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        rawDb.prepare('DELETE FROM dataflow_edges WHERE session_id = ?').run(sessionId);

        // ── 加载事件元数据（iid + line）─────────────────────────────────────
        this.emitProgress(ctx, '加载事件元数据...', 3);
        const eventMeta = new Map(); // event_id → {iid, line}
        {
            const smapLine = new Map();
            for (const r of rawDb.prepare('SELECT iid, sl FROM smap WHERE session_id = ?').all(sessionId)) {
                smapLine.set(r.iid, r.sl);
            }
            for (const r of rawDb.prepare('SELECT id, iid FROM events WHERE session_id = ?').all(sessionId)) {
                eventMeta.set(r.id, { iid: r.iid, line: smapLine.get(r.iid) ?? null });
            }
        }

        // ── 读取所有 writes ────────────────────────────────────────────────
        this.emitProgress(ctx, '读取所有 writes...', 8);
        const writes = rawDb.prepare(
            `SELECT w.event_id, w.name
             FROM writes w
             WHERE w.session_id = ? AND w.name IS NOT NULL ORDER BY w.event_id ASC`
        ).all(sessionId);

        // ── 读取所有 reads ─────────────────────────────────────────────────
        this.emitProgress(ctx, '读取所有 reads...', 15);
        const reads = rawDb.prepare(
            'SELECT event_id, name FROM reads WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC'
        ).all(sessionId);

        // ── 建 write 索引：varName → [{event_id}]（已按 event_id ASC 有序）──
        this.emitProgress(ctx, '构建 write 索引...', 22);
        const writeIndex = new Map(); // name → [event_id, ...]（扁平数组，减少对象开销）
        for (const w of writes) {
            if (!writeIndex.has(w.name)) writeIndex.set(w.name, []);
            writeIndex.get(w.name).push(w.event_id);
        }

        // ── prepare 批量写入 ───────────────────────────────────────────────
        const stmt = rawDb.prepare(
            'INSERT INTO dataflow_edges (session_id, from_event_id, to_event_id, from_var, to_var, edge_type, iid, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const flushEdgesTxn = rawDb.transaction((batch) => {
            for (const e of batch) stmt.run(...e);
        });

        let edges = [];
        let totalWritten = 0;

        const flush = () => {
            if (edges.length === 0) return;
            flushEdgesTxn(edges);
            totalWritten += edges.length;
            edges = [];
        };

        // ── assign 边：read 事件 ← 最近的 write 事件（def-use）──────────────
        // 语义：from_var = 写入方变量名, to_var = 读取方变量名（def-use 时相同变量名）
        // from_event_id = write 事件 SEQ, to_event_id = read 事件 SEQ
        this.emitProgress(ctx, '构建 assign 边...', 30);
        for (const r of reads) {
            const defs = writeIndex.get(r.name);
            if (!defs) continue;

            // 二分查找：最近一次在 r.event_id 之前的 write
            const idx = upperBoundLt(defs, r.event_id, x => x);
            if (idx < 0) continue;
            const defEventId = defs[idx];

            const meta = eventMeta.get(r.event_id);
            edges.push([
                sessionId,
                defEventId,       // from_event_id（write）
                r.event_id,       // to_event_id（read）
                r.name,           // from_var
                r.name,           // to_var（assign: 同名变量的定义→使用）
                'assign',
                meta?.iid ?? null,
                meta?.line ?? null,
            ]);

            if (edges.length >= BATCH_SIZE) {
                flush();
                this.emitProgress(ctx, `assign 边已写 ${totalWritten}...`, 45);
            }
        }
        flush();
        this.emitProgress(ctx, `assign 边完成(${totalWritten})，构建 call 边...`, 55);

        // ── call_arg / call_ret 边 ─────────────────────────────────────────
        // call_arg：调用点的实参 write（call_seq 之前的最近 write） → 被调函数体内的 read
        // call_ret：被调函数内的最后一次 write（return 表达式变量）→ call_seq 之后的 read
        //
        // 数据来源：call_edges 表提供 (call_seq, return_seq, fn_name, args_json)
        // 算法：
        //   1. 对每个 call_edge，从 args_json 解出实参变量名列表
        //   2. 在 writes 表中找调用前最近一次写该变量 → from_event_id
        //   3. 在 call_seq ~ return_seq 内找第一次读该变量（形参绑定）→ to_event_id
        //   4. 对 return_value（return_seq 处的写），找 return_seq 之后的第一次读 → to_event_id

        this.emitProgress(ctx, '加载 call_edges...', 58);
        const callEdges = rawDb.prepare(
            `SELECT id, call_seq, return_seq, fn_name, args_json, return_value
             FROM call_edges WHERE session_id = ? ORDER BY call_seq ASC`
        ).all(sessionId);

        if (callEdges.length > 0) {
            // 构建 event_id → write.name 倒排（供 return 值识别）
            // 构建 reads 按 varName 的有序数组（复用 writeIndex 模式）
            const readIndex = new Map(); // name → [event_id, ...]（有序）
            for (const r of reads) {
                if (!readIndex.has(r.name)) readIndex.set(r.name, []);
                readIndex.get(r.name).push(r.event_id);
            }

            // 构建 event_id → write varName（用于 return_value 识别）
            const writeEventToName = new Map();
            for (const w of writes) writeEventToName.set(w.event_id, w.name);

            let callEdgeCount = 0;
            for (const ce of callEdges) {
                // ── call_arg 边 ────────────────────────────────────────────
                if (ce.args_json) {
                    let args;
                    try { args = JSON.parse(ce.args_json); } catch { args = null; }
                    if (Array.isArray(args)) {
                        for (let i = 0; i < args.length; i++) {
                            const arg = args[i];
                            // arg 可能是 {name, value} 或直接是值字符串
                            const argName = typeof arg === 'object' && arg !== null ? arg.name : null;
                            if (!argName) continue;

                            const argWrites = writeIndex.get(argName);
                            if (!argWrites) continue;

                            // 调用点之前最近一次写实参变量
                            const wIdx = upperBoundLt(argWrites, ce.call_seq, x => x);
                            if (wIdx < 0) continue;
                            const fromEid = argWrites[wIdx];

                            // 函数体内第一次读该变量（形参绑定点）
                            const argReads = readIndex.get(argName);
                            if (!argReads) continue;
                            const rIdx = lowerBound(argReads, ce.call_seq, x => x);
                            if (rIdx < 0 || argReads[rIdx] > ce.return_seq) continue;
                            const toEid = argReads[rIdx];

                            const meta = eventMeta.get(toEid);
                            edges.push([
                                sessionId,
                                fromEid,
                                toEid,
                                argName,           // from_var: 调用方实参名
                                argName,           // to_var: 形参名（暂用实参名，因 smap 不含形参名）
                                'call_arg',
                                meta?.iid ?? null,
                                meta?.line ?? null,
                            ]);
                        }
                    }
                }

                // ── call_ret 边 ────────────────────────────────────────────
                // return_value 是字符串化的值（不是变量名），需要找 return_seq 处的写事件
                // 策略：找 return_seq 前后最近一次写，再找 return_seq 之后第一次读任意变量
                // 简化实现：找 return_seq 前的最后一次写（任意变量）→ return_seq 后第一次读
                if (ce.return_seq && ce.return_seq > ce.call_seq) {
                    // 找 [call_seq, return_seq] 内的最后一次 write
                    // 用 writes 数组（已按 event_id 有序），找 return_seq 前最近
                    // 但 writes 是全量数组，按 event_id 二分即可
                    const lastWriteIdx = upperBoundLt(writes, ce.return_seq + 1, w => w.event_id);
                    if (lastWriteIdx >= 0) {
                        // 向前找在 [call_seq, return_seq] 内的写
                        let foundWriteIdx = -1;
                        for (let wi = lastWriteIdx; wi >= 0; wi--) {
                            if (writes[wi].event_id >= ce.call_seq) {
                                foundWriteIdx = wi;
                                break;
                            }
                            if (writes[wi].event_id < ce.call_seq) break;
                        }
                        if (foundWriteIdx >= 0) {
                            const retWrite = writes[foundWriteIdx];
                            const retName = retWrite.name;
                            if (retName) {
                                // 找 return_seq 之后第一次读该变量
                                const retReads = readIndex.get(retName);
                                if (retReads) {
                                    const rIdx = lowerBound(retReads, ce.return_seq, x => x);
                                    if (rIdx >= 0) {
                                        const toEid = retReads[rIdx];
                                        const meta = eventMeta.get(toEid);
                                        edges.push([
                                            sessionId,
                                            retWrite.event_id,
                                            toEid,
                                            retName,    // from_var: 返回值来源变量
                                            retName,    // to_var: 接收返回值的变量（近似）
                                            'call_ret',
                                            meta?.iid ?? null,
                                            meta?.line ?? null,
                                        ]);
                                    }
                                }
                            }
                        }
                    }
                }

                if (edges.length >= BATCH_SIZE) {
                    flush();
                    callEdgeCount = totalWritten;
                }
            }
            flush();
            this.emitProgress(ctx, `call 边完成(${totalWritten - callEdgeCount})，构建 field 边...`, 75);
        }

        // ── field 边 ─────────────────────────────────────────────────────────
        this.emitProgress(ctx, '构建 field 边...', 78);
        const fields = rawDb.prepare(
            'SELECT event_id, offset, base_oid, is_write FROM fields WHERE session_id = ?'
        ).all(sessionId);

        for (const f of fields) {
            if (f.offset === null || f.offset === undefined) continue;
            if (f.base_oid == null) continue;
            const baseLabel = `#${f.base_oid}`;
            const varLabel  = `${baseLabel}.${f.offset}`;
            const meta = eventMeta.get(f.event_id);

            if (f.is_write) {
                // field_write: 某事件 → 写入对象属性
                // from_var = 属性标签（#oid.prop），to_var = 对象标签（#oid）
                edges.push([sessionId, f.event_id, null, varLabel, baseLabel, 'field_write', meta?.iid ?? null, meta?.line ?? null]);
            } else {
                // field_read: 读取对象属性 → 某事件
                // from_var = 对象标签，to_var = 属性标签
                edges.push([sessionId, null, f.event_id, baseLabel, varLabel, 'field_read', meta?.iid ?? null, meta?.line ?? null]);
            }

            if (edges.length >= BATCH_SIZE) {
                flush();
                this.emitProgress(ctx, `field 边已写 ${totalWritten}...`, 90);
            }
        }
        flush();

        const total = rawDb.prepare('SELECT COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ?').get(sessionId);
        const cnt = total ? total.cnt : 0;
        this.emitProgress(ctx, `完成，共 ${cnt} 条数据流边`, 100);
        this.emitDone(ctx, { edgeCount: cnt });
    }
}
