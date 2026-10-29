/** Streaming, indexed construction of an immutable disk-sharded dataflow graph.
 * Matching retains the existing statement-level assign/copy/call/field semantics.
 * No session-sized JavaScript arrays or Maps are created.
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import { GraphWriter } from '../GraphStore.mjs';
import Database from 'better-sqlite3';

const SKIP = new Set(['callee','callee_def_iid','return','arg0','arg1','arg2','arg3','arg4','arg5','arg6','arg7']);
export default class A2DataFlowGraph extends BasePlugin {
    static id = 'A2-DataFlowGraph';
    static deps = ['F1-EventIndex'];
    static description = '流式构建数据流图，按边数写入独立磁盘分片';
    static displayName = 'A2 · DataFlowGraph';

    async run(ctx) {
        const { sessionId } = ctx;
        const main = db.raw();
        const raw = main.name === ':memory:' ? main : new Database(main.name,{readonly:true,fileMustExist:true});
        if (raw !== main) {
            raw.pragma('cache_size = -4096'); raw.pragma('mmap_size = 0'); raw.pragma('temp_store = FILE');
        }
        const maxCopy = cfg('plugins.A2_DataFlowGraph.maxCopyPerEvent');
        const writer = new GraphWriter(sessionId, { dataDir: ctx.dataDir });
        // If a later checkpoint write fails, the scheduler removes unpublished files.
        ctx.onRollback?.(() => writer.abort());
        const byBinding = raw.prepare(`SELECT event_id FROM writes WHERE session_id=? AND name=?
            AND binding_id=? AND event_id<? ORDER BY event_id DESC,id DESC LIMIT 1`);
        const byScope = raw.prepare(`SELECT event_id FROM writes WHERE session_id=? AND name=?
            AND binding_id IS NULL AND scope_id IS ? AND event_id<? ORDER BY event_id DESC,id DESC LIMIT 1`);
        const definition = r => (r.binding_id != null
            ? byBinding.get(sessionId,r.name,r.binding_id,r.event_id)
            : byScope.get(sessionId,r.name,r.scope_id ?? null,r.event_id))?.event_id;
        const eventWrites = raw.prepare(`SELECT name FROM writes WHERE session_id=? AND event_id=?
            AND name NOT IN ('callee','callee_def_iid','return','arg0','arg1','arg2','arg3','arg4','arg5','arg6','arg7') ORDER BY id LIMIT ?`);
        const reads = raw.prepare(`SELECT r.event_id,r.name,r.binding_id,r.scope_id,e.iid,s.sl AS line
            FROM reads r LEFT JOIN events e ON e.session_id=r.session_id AND e.id=r.event_id
            LEFT JOIN smap s ON s.session_id=r.session_id AND s.iid=e.iid
            WHERE r.session_id=? AND r.name IS NOT NULL ORDER BY r.event_id,r.id`);
        let processed = 0, lastEvent = null, copyCount = 0;
        const add = (from,to,fromVar,toVar,type,meta) => writer.add({
            from_event_id:from,to_event_id:to,from_var:fromVar,to_var:toVar,
            edge_type:type,iid:meta.iid,line:meta.line,
        });
        const ownTransaction = !main.inTransaction;
        try {
            if (ownTransaction) main.exec('BEGIN IMMEDIATE');
            this.emitProgress(ctx,'按索引流式构建 assign/copy 边...',5);
            for (const r of reads.iterate(sessionId)) {
                if (SKIP.has(r.name)) continue;
                if (r.event_id !== lastEvent) { lastEvent = r.event_id; copyCount = 0; }
                const def = definition(r);
                if (def != null) add(def,r.event_id,r.name,r.name,'assign',r);
                if (copyCount < maxCopy) {
                    for (const w of eventWrites.iterate(sessionId,r.event_id,maxCopy+1)) {
                        if (r.name === w.name) continue;
                        add(def ?? r.event_id,r.event_id,r.name,w.name,'copy',r);
                        if (++copyCount >= maxCopy) break;
                    }
                }
                if (++processed % 100000 === 0) this.emitProgress(ctx,`已扫描 ${processed} 条读取，写入 ${writer.count} 条边`,35);
            }
            this.emitProgress(ctx,'按调用区间构建 call 边...',55);
            const rangeReads = raw.prepare(`SELECT r.event_id,r.name,e.iid,s.sl AS line FROM reads r
                LEFT JOIN events e ON e.session_id=r.session_id AND e.id=r.event_id
                LEFT JOIN smap s ON s.session_id=r.session_id AND s.iid=e.iid
                WHERE r.session_id=? AND r.event_id>? AND r.event_id<=? AND r.name IS NOT NULL
                AND r.name NOT IN ('callee','return') ORDER BY r.event_id,r.id LIMIT ?`);
            const afterReturn = raw.prepare(`SELECT r.event_id,r.name,e.iid,s.sl AS line FROM reads r
                LEFT JOIN events e ON e.session_id=r.session_id AND e.id=r.event_id
                LEFT JOIN smap s ON s.session_id=r.session_id AND s.iid=e.iid
                WHERE r.session_id=? AND r.event_id>? AND r.name IS NOT NULL ORDER BY r.event_id,r.id LIMIT 1`);
            for (const call of raw.prepare('SELECT call_seq,return_seq,args_json FROM call_edges WHERE session_id=? ORDER BY call_seq').iterate(sessionId)) {
                if (!call.return_seq || call.return_seq <= call.call_seq) continue;
                let args;
                try { args = JSON.parse(call.args_json); } catch { args = []; }
                const argc = Array.isArray(args) ? Math.min(args.length,255) : 0;
                let index = 0;
                if (argc) for (const r of rangeReads.iterate(sessionId,call.call_seq,call.return_seq,argc)) {
                    add(call.call_seq,r.event_id,`arg${index++}`,r.name,'call_arg',r);
                }
                const r = afterReturn.get(sessionId,call.return_seq);
                if (r && r.name !== 'callee' && r.name !== 'return') add(call.return_seq,r.event_id,'(return)',r.name,'call_ret',r);
            }
            this.emitProgress(ctx,'流式构建对象属性边...',80);
            for (const f of raw.prepare(`SELECT f.event_id,f.offset,f.base_oid,f.is_write,e.iid,s.sl AS line
                FROM fields f LEFT JOIN events e ON e.session_id=f.session_id AND e.id=f.event_id
                LEFT JOIN smap s ON s.session_id=f.session_id AND s.iid=e.iid
                WHERE f.session_id=? AND f.offset IS NOT NULL AND f.base_oid IS NOT NULL ORDER BY f.event_id,f.id`).iterate(sessionId)) {
                const base = `#${f.base_oid}`, variable = `${base}.${f.offset}`;
                if (f.is_write) add(f.event_id,null,variable,base,'field_write',f);
                else add(null,f.event_id,base,variable,'field_read',f);
            }
            const summary = writer.publish();
            // The main database retains only the generation pointer. Remove legacy
            // edges transactionally when this generation is published.
            main.prepare('DELETE FROM dataflow_edges WHERE session_id=?').run(sessionId);
            this.emitProgress(ctx,`完成，共 ${summary.edgeCount} 条边 / ${summary.shardCount} 个磁盘分片`,100);
            this.emitDone(ctx,summary);
            if (ownTransaction) main.exec('COMMIT');
        } catch (error) {
            if (ownTransaction && main.inTransaction) main.exec('ROLLBACK');
            writer.abort(); throw error;
        }
        finally { if (raw !== main) raw.close(); }
    }
}
