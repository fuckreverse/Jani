/**
 * A2_DataFlowGraph.mjs — 构建变量级 def-use 数据流图
 * 写入 dataflow_edges 表
 *
 * 性能优化：
 *  - 一次性加载全部 events(id,iid,line)，消除分批 IN 查询
 *  - 使用 prepared statement + 大 batch 事务写入
 *  - def-use 匹配：用二分查找取最近 write，O(log N) 而非线性扫描
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

        this.emitProgress(ctx, '读取所有 writes...', 5);
        const writes = rawDb.prepare(
            'SELECT event_id, name, value FROM writes WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC'
        ).all(sessionId);

        this.emitProgress(ctx, '读取所有 reads...', 15);
        const reads = rawDb.prepare(
            'SELECT event_id, name FROM reads WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC'
        ).all(sessionId);

        // ── 一次性加载全部 events(id, iid, line)，消除分批 IN 查询 ─────────────
        this.emitProgress(ctx, '加载事件元数据...', 25);
        const eventMeta = new Map(); // event_id → {iid, line}
        {
            const rows = rawDb.prepare(
                'SELECT id, iid, line FROM events WHERE session_id = ?'
            ).all(sessionId);
            for (const r of rows) eventMeta.set(r.id, { iid: r.iid, line: r.line });
        }

        // ── 建 write 索引：varName → [{event_id, value}]（已按 event_id ASC 有序）──
        this.emitProgress(ctx, '构建 def-use 边...', 35);
        const writeIndex = new Map(); // name → [{event_id, value}]
        for (const w of writes) {
            if (!writeIndex.has(w.name)) writeIndex.set(w.name, []);
            writeIndex.get(w.name).push({ event_id: w.event_id, value: w.value });
        }

        let edges = [];
        let totalWritten = 0;

        const stmt = rawDb.prepare(
            'INSERT INTO dataflow_edges (session_id, from_event_id, to_event_id, from_var, to_var, edge_type, iid, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const flushEdges = rawDb.transaction((batch) => {
            for (const e of batch) stmt.run(...e);
        });

        const flush = () => {
            if (edges.length === 0) return;
            flushEdges(edges);
            totalWritten += edges.length;
            edges = [];
        };

        for (const r of reads) {
            const defs = writeIndex.get(r.name);
            if (!defs) continue;

            // 用二分查找最近一次在 r.event_id 之前的 write
            const idx = upperBoundLt(defs, r.event_id, d => d.event_id);
            if (idx < 0) continue;
            const bestDef = defs[idx];

            const meta = eventMeta.get(r.event_id);
            edges.push([
                sessionId,
                bestDef.event_id,
                r.event_id,
                r.name,
                r.name,
                'assign',
                meta?.iid ?? null,
                meta?.line ?? null,
            ]);

            if (edges.length >= BATCH_SIZE) {
                flush();
                this.emitProgress(ctx, `已写入 ${totalWritten} 条 assign 边...`, 55);
            }
        }
        flush();

        // ── field 边 ─────────────────────────────────────────────────────────
        this.emitProgress(ctx, '构建 field 边...', 70);
        const fields = rawDb.prepare(
            'SELECT event_id, base, offset, value, is_write FROM fields WHERE session_id = ? LIMIT 5000'
        ).all(sessionId);

        for (const f of fields) {
            if (f.base === null || f.base === undefined) continue;
            if (f.offset === null || f.offset === undefined) continue;

            const varLabel = `${f.base}.${f.offset}`;
            const meta = eventMeta.get(f.event_id); // 直接查全局 Map，无需额外查询

            if (f.is_write) {
                edges.push([sessionId, f.event_id, null, String(f.base), varLabel, 'field_write', meta?.iid ?? null, meta?.line ?? null]);
            } else {
                edges.push([sessionId, null, f.event_id, varLabel, String(f.base), 'field_read', meta?.iid ?? null, meta?.line ?? null]);
            }

            if (edges.length >= BATCH_SIZE) {
                flush();
                this.emitProgress(ctx, `已写入 field 边...`, 85);
            }
        }
        flush();

        const total = rawDb.prepare('SELECT COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ?').get(sessionId);
        const cnt = total ? total.cnt : 0;
        this.emitProgress(ctx, `完成，共 ${cnt} 条数据流边`, 100);
        this.emitDone(ctx, { edgeCount: cnt });
    }
}
