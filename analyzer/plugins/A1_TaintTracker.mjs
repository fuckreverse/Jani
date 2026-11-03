/** Bounded, disk-indexed statement-level taint traversal.
 * Reads only the current frontier's bindings and nearby definitions; it never
 * loads an entire session's writes/reads into JavaScript maps.
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import Database from 'better-sqlite3';
import { DependencyIndex, sliceDependencies } from '../DependencyIndex.mjs';

export default class A1TaintTracker extends BasePlugin {
    static id='A1-TaintTracker';
    static deps=['F1-EventIndex','F4-VariableLifetime'];
    static description='按磁盘索引进行有界正向/反向污点追踪';
    static displayName='A1 · TaintTracker';
    async run(ctx) {
        const main=db.raw();
        const source=main.name===':memory:' ? main : new Database(main.name,{readonly:true,fileMustExist:true});
        try{
            if(source!==main){source.pragma('cache_size = -4096');source.pragma('mmap_size = 0');source.pragma('temp_store = FILE');}
            return await this.runIndexed(ctx,source,main);
        }finally{if(source!==main)source.close();}
    }
    async runIndexed(ctx,raw,main) {
        const {sessionId,sourceVar,sourceEventId,sourceScopeId=null,direction='forward'}=ctx;
        if(!sourceVar && !sourceEventId)throw new Error('A1-TaintTracker: sourceVar or sourceEventId required');
        if(!['forward','backward'].includes(direction))throw new Error('Invalid taint direction');
        const maxNodes=cfg('plugins.A1_TaintTracker.maxNodes'),maxHops=cfg('plugins.A1_TaintTracker.maxHops');
        const conditions=['session_id=?'],args=[sessionId];
        if(sourceVar){conditions.push('name=?');args.push(sourceVar);}
        if(sourceEventId){conditions.push('event_id=?');args.push(sourceEventId);}
        if(sourceScopeId!=null){conditions.push('scope_id IS ?');args.push(sourceScopeId);}
        const sourceTable=direction==='forward'?'writes':'reads';
        const seeds=sourceVar ? raw.prepare(`SELECT DISTINCT event_id FROM ${sourceTable} WHERE ${conditions.join(' AND ')} ORDER BY event_id LIMIT ?`).all(...args,maxNodes+1).map(r=>r.event_id) : [sourceEventId];
        const index=new DependencyIndex(raw,sessionId);
        const result=sliceDependencies(index,seeds,{direction,maxNodes,maxHops});
        const parents=new Map(result.nodes.map(n=>[n.eventId,n.parent]));
        const paths=result.nodes.filter(n=>n.parent!=null).map(node=>{
            const ids=[node.eventId];
            for(let parent=node.parent;parent!=null;parent=parents.get(parent))ids.push(parent);
            if(direction==='forward')ids.reverse();
            return {sourceEventId:ids[0],sinkEventId:ids[ids.length-1],sinkVar:direction==='forward'?node.varName:sourceVar,eventIds:ids};
        });
        const quality={precision:result.precision,truncated:result.truncated,visitedNodes:result.nodes.length,
            scannedMatches:result.edges.length,storage:'disk-indexed',edges:result.edges};
        const insert=main.prepare(`INSERT INTO taint_paths(session_id,source_event_id,sink_event_id,path_json,source_var,sink_var,hop_count,analysis_json) VALUES (?,?,?,?,?,?,?,?)`);
        main.transaction(()=>{
            main.prepare('DELETE FROM taint_paths WHERE session_id=? AND source_var IS ?').run(sessionId,sourceVar??null);
            for(const path of paths)insert.run(sessionId,path.sourceEventId,path.sinkEventId,JSON.stringify(path.eventIds),sourceVar??null,path.sinkVar??null,path.eventIds.length-1,JSON.stringify({...quality,edges:undefined}));
        })();
        this.emitDone(ctx,{pathCount:paths.length,paths,...quality});
    }
}
