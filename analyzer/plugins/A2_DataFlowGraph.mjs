/** Streaming, indexed construction of an immutable disk-sharded dataflow graph.
 * Uses the same bounded dependency index as taint and signature slices.
 * No session-sized JavaScript arrays or Maps are created.
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import { GraphWriter } from '../GraphStore.mjs';
import Database from 'better-sqlite3';
import { DependencyIndex, synthetic } from '../DependencyIndex.mjs';

export default class A2DataFlowGraph extends BasePlugin {
    static observes = ['F2-SmapLoader'];
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
        ctx.onCommit?.(() => writer.release());
        const index = new DependencyIndex(raw,sessionId);
        const eventIds = raw.prepare(`SELECT event_id FROM reads WHERE session_id=?
            UNION SELECT event_id FROM fields WHERE session_id=?
            UNION SELECT to_event_id FROM event_dependencies WHERE session_id=?
            UNION SELECT id FROM events WHERE session_id=? AND ? ORDER BY 1`);
        const eventMeta = raw.prepare(`SELECT e.type,e.iid,s.sl AS line FROM events e LEFT JOIN smap s ON s.session_id=e.session_id AND s.iid=e.iid WHERE e.session_id=? AND e.id=?`);
        const evidenceCounts = {};
        let processed=0, copyTruncated=false;
        const add = edge => {
            writer.add(edge);
            const evidence=edge.evidence ?? 'observed';
            evidenceCounts[evidence]=(evidenceCounts[evidence] ?? 0)+1;
        };
        const ownTransaction = !main.inTransaction;
        try {
            if (ownTransaction) main.exec('BEGIN IMMEDIATE');
            this.emitProgress(ctx,'构建共享的变量、属性、调用与控制依赖...',5);
            for (const {event_id:eventId} of eventIds.iterate(sessionId,sessionId,sessionId,sessionId,index.hasControl ? 1 : 0)) {
                const meta=eventMeta.get(sessionId,eventId) ?? {};
                const incoming=index.incoming(eventId,cfg('graph.batchSize') ?? 1000);
                const writes=index.bounded(index.writes,[sessionId,eventId],maxCopy+1).filter(w=>!synthetic(w.name,meta.type));
                let copies=0;
                for(const edge of incoming) {
                    add({...edge,...meta});
                    if(edge.edge_type!=='assign')continue;
                    for(const w of writes) {
                        if(w.name===edge.from_var)continue;
                        if(copies>=maxCopy){copyTruncated=true;break;}
                        add({...edge,...meta,to_var:w.name,edge_type:'copy',evidence:'statement-cooccurrence'});
                        copies++;
                    }
                }
                if(++processed%100000===0)this.emitProgress(ctx,`已处理 ${processed} 条事件`,50);
            }
            const summary = { ...writer.publish(), precision:'statement-level',
                truncated:index.truncated||copyTruncated, evidenceCounts,
                callPropagation:'observed-only', controlDependence:'lexical-approximation' };
            // The main database retains only the generation pointer. Remove legacy
            // edges transactionally when this generation is published.
            main.prepare('DELETE FROM dataflow_edges WHERE session_id=?').run(sessionId);
            this.emitProgress(ctx,`完成，共 ${summary.edgeCount} 条边 / ${summary.shardCount} 个磁盘分片`,100);
            this.emitDone(ctx,summary);
            if (ownTransaction) { main.exec('COMMIT'); writer.release(); }
        } catch (error) {
            if (ownTransaction && main.inTransaction) main.exec('ROLLBACK');
            writer.abort(); throw error;
        }
        finally { if (raw !== main) raw.close(); }
    }
}
