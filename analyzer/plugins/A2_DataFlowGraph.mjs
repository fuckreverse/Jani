/**
 * A2_DataFlowGraph.mjs — 构建变量级 def-use 数据流图
 * 写入 dataflow_edges 表
 *
 * 边类型说明：
 *  - assign   边：write(X) → read(X)，同一变量的定义-使用链（def-use）
 *  - copy     边：同一事件内的 read(A) × write(B)，代表跨变量赋值传播（如 b = a）
 *  - call_arg 边：CALL_PRE 事件(call_seq) → 函数体内第 i 个 read，代表实参→形参传递
 *  - call_ret 边：CALL 事件(return_seq) → return_seq 后第一个 read，代表返回值→接收方
 *  - field_write / field_read：属性读写，基于 OID 标识对象
 *
 * 性能优化：
 *  - 一次性加载全部 events/writes/reads/fields，消除分批 IN 查询
 *  - 使用 prepared statement + 大 batch 事务写入
 *  - def-use 匹配：用二分查找取最近 write，O(log N)
 *  - call_arg/call_ret：基于有序 reads 数组 + lowerBound 二分，O(log N) 区间查找
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 5000;
// copy 边每个事件的上界：防止解构赋值/大表达式产生组合爆炸
// 例：const {a,b,c,d,e} = obj 有 5 reads × 5 writes = 25 条，正常
// 但 eval 类场景可能产生数百个 read/write，需限制
const MAX_COPY_PER_EVENT = 20;

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

        // ── 建 write 索引：varName → [event_id, ...]（已按 event_id ASC 有序）──
        this.emitProgress(ctx, '构建 write 索引...', 22);
        const writeIndex = new Map(); // name → [event_id, ...]（扁平数组，减少对象开销）
        for (const w of writes) {
            if (!writeIndex.has(w.name)) writeIndex.set(w.name, []);
            writeIndex.get(w.name).push(w.event_id);
        }

        // ── 建 event_id → writes[] / reads[] 分组索引（供 copy 边使用）────────
        // copy 边需要找到同一事件内同时有 reads 和 writes 的情况（如 b = a 赋值）
        this.emitProgress(ctx, '构建事件内 read-write 分组...', 26);
        // 跳过占位符变量名（Jalangi 内部使用，不是程序变量）
        const SKIP_NAMES = new Set(['callee', 'callee_def_iid', 'return', 'arg0', 'arg1', 'arg2', 'arg3', 'arg4', 'arg5', 'arg6', 'arg7']);
        const evWritesMap = new Map(); // event_id → [varName, ...]
        for (const w of writes) {
            if (!w.name || SKIP_NAMES.has(w.name)) continue;
            if (!evWritesMap.has(w.event_id)) evWritesMap.set(w.event_id, []);
            evWritesMap.get(w.event_id).push(w.name);
        }
        const evReadsMap = new Map();  // event_id → [varName, ...]
        for (const r of reads) {
            if (!r.name || SKIP_NAMES.has(r.name)) continue;
            if (!evReadsMap.has(r.event_id)) evReadsMap.set(r.event_id, []);
            evReadsMap.get(r.event_id).push(r.name);
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
            if (SKIP_NAMES.has(r.name)) continue;
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
        this.emitProgress(ctx, `assign 边完成(${totalWritten})，构建 copy 边...`, 50);

        // ── copy 边：同一事件内的 read × write 配对（跨变量赋值传播）────────────
        // 语义：当一个事件（如 WRITE 事件 `b = a`）同时有 reads 和 writes 时，
        //       表示 reads 中的变量值被传播到 writes 中的变量。
        //       建立 copy 边：from_var = read 变量, to_var = write 变量，
        //
        //       from_event_id = rName（被读取变量）的最近一次 write 事件（def 点）
        //       to_event_id   = 当前赋值事件本身（use/write 点）
        //
        //       这样图中的边方向为：源变量定义点 → 赋值写入点，
        //       准确表达 `b = a` 中"a 的上一次写入"到"b 的本次写入"的数据流方向，
        //       避免 from_event_id = to_event_id 产生的自环问题。
        //
        // 排除：CALL_PRE/CALL 类型的占位符（arg0/return），已在 SKIP_NAMES 中处理
        // 限制：每个事件最多 MAX_COPY_PER_EVENT 条 copy 边（防止组合爆炸）
        this.emitProgress(ctx, '构建 copy 边...', 52);
        let copyCount = 0;
        for (const [eventId, writeNames] of evWritesMap) {
            const readNames = evReadsMap.get(eventId);
            if (!readNames || readNames.length === 0) continue;

            const meta = eventMeta.get(eventId);
            let perEvent = 0;
            outer: for (const rName of readNames) {
                // 找 rName 最近一次在 eventId 之前的 write 事件（def 点）
                // 如不存在则用 eventId 自身（退化为原始行为）
                const rDefs = writeIndex.get(rName);
                const rDefIdx = rDefs ? upperBoundLt(rDefs, eventId, x => x) : -1;
                const fromEventId = rDefIdx >= 0 ? rDefs[rDefIdx] : eventId;

                for (const wName of writeNames) {
                    if (rName === wName) continue; // 跳过自赋值（已由 assign 边覆盖）
                    edges.push([
                        sessionId,
                        fromEventId,  // from_event_id: 源变量(rName)最近的 def 事件
                        eventId,      // to_event_id:   当前赋值写入事件
                        rName,        // from_var（读取源变量）
                        wName,        // to_var（写入目标变量）
                        'copy',
                        meta?.iid ?? null,
                        meta?.line ?? null,
                    ]);
                    copyCount++;
                    perEvent++;
                    if (perEvent >= MAX_COPY_PER_EVENT) break outer; // 防止组合爆炸
                    if (edges.length >= BATCH_SIZE) {
                        flush();
                        this.emitProgress(ctx, `copy 边已写 ${copyCount}...`, 54);
                    }
                }
            }
        }
        flush();
        this.emitProgress(ctx, `copy 边完成(${copyCount})，构建 call 边...`, 55);

        // ── call_arg / call_ret 边 ─────────────────────────────────────────
        //
        // 核心设计（v3 修复）：
        //   F1_EventIndex 将参数以 name='arg0','arg1',... 写入 writes 表，
        //   CALL 事件将返回值以 name='return' 写入 writes 表。
        //   这些特殊名称是占位符，不是程序中的真实变量名。
        //
        //   call_arg 边：
        //     from_event_id = CALL_PRE 事件本身（call_seq），作为"实参传入"节点
        //                     其在 writes 表中有 arg0/arg1... 记录，代表实参值
        //     to_event_id   = 函数体 [call_seq+1, return_seq] 内按顺序第 i 个 read 事件
        //                     代表形参在函数体内首次被使用的位置
        //     from_var      = "arg{i}"（实参位置标签）
        //     to_var        = 形参读取的变量名（函数体内读的第 i 个变量名）
        //
        //   call_ret 边：
        //     from_event_id = CALL 事件本身（return_seq），其在 writes 表中有 name='return'
        //                     代表返回值产出点
        //     to_event_id   = return_seq 之后调用者上下文中第一个 read 事件
        //                     代表返回值被接收/使用的位置
        //     from_var      = "(return)"
        //     to_var        = 接收方读取的变量名

        this.emitProgress(ctx, '加载 call_edges...', 58);
        const callEdges = rawDb.prepare(
            `SELECT id, call_seq, return_seq, fn_name, args_json, return_value
             FROM call_edges WHERE session_id = ? ORDER BY call_seq ASC`
        ).all(sessionId);

        if (callEdges.length > 0) {
            // ── 构建全局 reads 有序数组（按 event_id ASC，已满足）──────────────
            // reads 数组本身已按 event_id 有序（加载时 ORDER BY event_id ASC）

            // ── 预加载 CALL_PRE 的 arg0/arg1 写事件 ─────────────────────────
            // 只需找 call_seq（= CALL_PRE event_id）在 writes 表中有哪几条 arg* 记录
            // 因为 arg0/arg1 的 event_id 就是 call_seq 本身，直接以 call_seq 为 key
            const callPreArgCount = new Map(); // call_seq → argCount（args_json 解出的个数）
            for (const ce of callEdges) {
                if (!ce.args_json) continue;
                let args;
                try { args = JSON.parse(ce.args_json); } catch { args = null; }
                if (Array.isArray(args) && args.length > 0) {
                    callPreArgCount.set(ce.call_seq, args.length);
                }
            }

            // ── 按 call_edge 区间对 reads 建倒排（event_id → 区间 index）──────
            // 用二分直接定位 [call_seq+1, return_seq] 内的第一个 read
            // reads 已按 event_id 有序，lowerBound 直接用

            let callEdgeCount = 0;
            const prevWritten = totalWritten;

            for (const ce of callEdges) {
                if (!ce.return_seq || ce.return_seq <= ce.call_seq) continue;

                // ── call_arg 边 ────────────────────────────────────────────
                // from: CALL_PRE 事件本身（call_seq），代表第 i 个实参传入
                // to:   函数体内按出现顺序的第 i 个 read（形参首次使用）
                const argc = callPreArgCount.get(ce.call_seq) ?? 0;
                if (argc > 0) {
                    // 找函数体内 [call_seq+1, return_seq] 的所有 reads（按 event_id 有序）
                    const rStart = lowerBound(reads, ce.call_seq + 1, r => r.event_id);
                    if (rStart >= 0) {
                        // 取前 argc 个在区间内的 read 事件作为形参使用点
                        let found = 0;
                        for (let ri = rStart; ri < reads.length && found < argc; ri++) {
                            const r = reads[ri];
                            if (r.event_id > ce.return_seq) break;
                            // 跳过特殊占位符名称（callee、return 等）
                            if (!r.name || r.name === 'callee' || r.name === 'return') continue;

                            const meta = eventMeta.get(r.event_id);
                            edges.push([
                                sessionId,
                                ce.call_seq,        // from: CALL_PRE 事件（实参传入点）
                                r.event_id,         // to: 函数体内形参首次使用
                                `arg${found}`,      // from_var: 实参位置标签
                                r.name,             // to_var: 形参变量名
                                'call_arg',
                                meta?.iid ?? null,
                                meta?.line ?? null,
                            ]);
                            found++;
                        }
                    }
                }

                // ── call_ret 边 ────────────────────────────────────────────
                // from: CALL 事件本身（return_seq），代表返回值产出
                // to:   return_seq 之后第一个 read（调用者接收返回值）
                // 注意：要跳过属于子调用的 reads，找调用者上下文的第一个 read
                const afterRet = lowerBound(reads, ce.return_seq + 1, r => r.event_id);
                if (afterRet >= 0) {
                    const toRead = reads[afterRet];
                    if (toRead && toRead.name && toRead.name !== 'callee' && toRead.name !== 'return') {
                        const meta = eventMeta.get(toRead.event_id);
                        edges.push([
                            sessionId,
                            ce.return_seq,          // from: CALL 事件（返回值产出点）
                            toRead.event_id,        // to: 调用者接收返回值的第一个 read
                            '(return)',             // from_var: 返回值标签
                            toRead.name,            // to_var: 调用者接收方变量名
                            'call_ret',
                            meta?.iid ?? null,
                            meta?.line ?? null,
                        ]);
                    }
                }

                if (edges.length >= BATCH_SIZE) {
                    flush();
                    callEdgeCount = totalWritten - prevWritten;
                }
            }
            flush();
            callEdgeCount = totalWritten - prevWritten;
            this.emitProgress(ctx, `call 边完成(${callEdgeCount})，构建 field 边...`, 75);
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
