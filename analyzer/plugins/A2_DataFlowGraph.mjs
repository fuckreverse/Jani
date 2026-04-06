/**
 * A2_DataFlowGraph.mjs — 构建变量级 def-use 数据流图
 * 写入 dataflow_edges 表
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class A2DataFlowGraph extends BasePlugin {
    static id = 'A2-DataFlowGraph';
    static deps = ['F1-EventIndex'];
    static description = '构建变量级 def-use 数据流图，写入 dataflow_edges 表';
    static displayName = 'A2 · DataFlowGraph';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM dataflow_edges WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '读取所有 writes...', 5);
        const writes = db.all(
            'SELECT event_id, name, value FROM writes WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC',
            [sessionId]
        );

        this.emitProgress(ctx, '读取所有 reads...', 20);
        const reads = db.all(
            'SELECT event_id, name FROM reads WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC',
            [sessionId]
        );

        // 建索引：varName → 所有 write event_id（按时间排序）
        const writeIndex = new Map(); // name → [{event_id, value}]
        for (const w of writes) {
            if (!writeIndex.has(w.name)) writeIndex.set(w.name, []);
            writeIndex.get(w.name).push({ event_id: w.event_id, value: w.value });
        }

        this.emitProgress(ctx, '构建 def-use 边...', 40);
        let edges = [];
        let totalWritten = 0;

        const flushEdges = () => {
            if (edges.length === 0) return;
            db.transaction(() => {
                for (const e of edges) {
                    db.run(
                        'INSERT INTO dataflow_edges (session_id, from_event_id, to_event_id, from_var, to_var, edge_type, iid, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        e
                    );
                }
            });
            totalWritten += edges.length;
            edges = [];
        };

        for (const r of reads) {
            const defs = writeIndex.get(r.name);
            if (!defs) continue;

            // 找最近一次在 r.event_id 之前的 write（二分查找）
            let bestDef = null;
            for (const d of defs) {
                if (d.event_id < r.event_id) bestDef = d;
                else break;
            }
            if (!bestDef) continue;

            // 获取 line/iid
            const evt = db.get('SELECT iid, line FROM events WHERE id = ? AND session_id = ?', [r.event_id, sessionId]);

            edges.push([
                sessionId,
                bestDef.event_id,
                r.event_id,
                r.name,    // from_var
                r.name,    // to_var
                'assign',
                evt ? evt.iid : null,
                evt ? evt.line : null,
            ]);

            if (edges.length >= 500) {
                flushEdges();
                this.emitProgress(ctx, `已写入 ${totalWritten} 条 assign 边...`, 55);
            }
        }
        flushEdges();

        // field 边
        this.emitProgress(ctx, '构建 field 边...', 70);
        const fields = db.all(
            'SELECT event_id, base, offset, value, is_write FROM fields WHERE session_id = ? LIMIT 5000',
            [sessionId]
        );

        for (const f of fields) {
            if (f.base === null || f.base === undefined) continue;
            if (f.offset === null || f.offset === undefined) continue;

            const varLabel = `${f.base}.${f.offset}`;
            const evt = db.get('SELECT iid, line FROM events WHERE id = ? AND session_id = ?', [f.event_id, sessionId]);

            if (f.is_write) {
                edges.push([
                    sessionId,
                    f.event_id,    // from_event_id (writer)
                    null,          // to_event_id
                    String(f.base),
                    varLabel,
                    'field_write',
                    evt ? evt.iid : null,
                    evt ? evt.line : null,
                ]);
            } else {
                edges.push([
                    sessionId,
                    null,          // from_event_id
                    f.event_id,    // to_event_id (reader)
                    varLabel,
                    String(f.base),
                    'field_read',
                    evt ? evt.iid : null,
                    evt ? evt.line : null,
                ]);
            }

            if (edges.length >= 500) {
                flushEdges();
                this.emitProgress(ctx, `已写入 field 边...`, 85);
            }
        }
        flushEdges();

        const total = db.get('SELECT COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ?', [sessionId]);
        const cnt = total ? total.cnt : 0;
        this.emitProgress(ctx, `完成，共 ${cnt} 条数据流边`, 100);
        this.emitDone(ctx, { edgeCount: cnt });
    }
}
