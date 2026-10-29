/** Bounded, disk-indexed statement-level taint traversal.
 * Reads only the current frontier's bindings and nearby definitions; it never
 * loads an entire session's writes/reads into JavaScript maps.
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import Database from 'better-sqlite3';

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
        let truncated=false,scanned=0;
        const paths=[],visited=new Set();
        const sourceTable=direction==='forward'?'writes':'reads';
        const conditions=['session_id=?'],args=[sessionId];
        if(sourceVar){conditions.push('name=?');args.push(sourceVar);}
        if(sourceEventId){conditions.push('event_id=?');args.push(sourceEventId);}
        if(sourceScopeId!=null){conditions.push('scope_id IS ?');args.push(sourceScopeId);}
        let frontier;
        if(sourceVar){
            const seeds=raw.prepare(`SELECT DISTINCT event_id FROM ${sourceTable} WHERE ${conditions.join(' AND ')} ORDER BY event_id LIMIT ?`).all(...args,maxNodes+1);
            truncated=seeds.length>maxNodes;
            frontier=seeds.slice(0,maxNodes).map(r=>({eventId:r.event_id,path:[r.event_id]}));
        }else frontier=[{eventId:sourceEventId,path:[sourceEventId]}];
        const entries=raw.prepare(`SELECT name,scope_id,binding_id FROM ${sourceTable} WHERE session_id=? AND event_id=? AND name IS NOT NULL ORDER BY id LIMIT ?`);
        const bindingRows=raw.prepare(`SELECT event_id FROM reads WHERE session_id=? AND name=? AND binding_id=? AND event_id>? AND event_id<=? ORDER BY event_id,id LIMIT ?`);
        const scopeRows=raw.prepare(`SELECT event_id FROM reads WHERE session_id=? AND name=? AND binding_id IS NULL AND scope_id IS ? AND event_id>? AND event_id<=? ORDER BY event_id,id LIMIT ?`);
        const prepareDefinition=(binding,forward)=>raw.prepare(`SELECT event_id FROM writes WHERE session_id=? AND name=?
            AND ${binding?'binding_id=?':'binding_id IS NULL AND scope_id IS ?'}
            AND event_id${forward?'>':'<'}? ORDER BY event_id ${forward?'ASC':'DESC'},id ${forward?'ASC':'DESC'} LIMIT 1`);
        const nextBinding=prepareDefinition(true,true),nextScope=prepareDefinition(false,true);
        const prevBinding=prepareDefinition(true,false),prevScope=prepareDefinition(false,false);
        this.emitProgress(ctx,'按磁盘索引扩展污点路径...',5);
        for(let hop=0;hop<maxHops && frontier.length && visited.size<maxNodes && paths.length<maxNodes;hop++){
            const next=[];
            for(const node of frontier){
                if(visited.has(node.eventId))continue;
                if(visited.size>=maxNodes || paths.length>=maxNodes){truncated=true;break;}
                visited.add(node.eventId);
                const rows=entries.all(sessionId,node.eventId,maxNodes+1);
                if(rows.length>maxNodes)truncated=true;
                for(const entry of rows.slice(0,maxNodes)){
                    if(paths.length>=maxNodes){truncated=true;break;}
                    const identity=entry.binding_id ?? entry.scope_id ?? null;
                    const bound=entry.binding_id!=null;
                    const remaining=maxNodes-paths.length;
                    let matches;
                    if(direction==='forward'){
                        const end=(bound?nextBinding:nextScope).get(sessionId,entry.name,identity,node.eventId)?.event_id ?? Number.MAX_SAFE_INTEGER;
                        matches=(bound?bindingRows:scopeRows).all(sessionId,entry.name,identity,node.eventId,end,remaining+1);
                    }else{
                        const definition=(bound?prevBinding:prevScope).get(sessionId,entry.name,identity,node.eventId);
                        matches=definition?[definition]:[];
                    }
                    if(matches.length>remaining)truncated=true;
                    for(const match of matches.slice(0,remaining)){
                        const path=direction==='forward'?[...node.path,match.event_id]:[match.event_id,...node.path];
                        paths.push({sourceEventId:path[0],sinkEventId:path[path.length-1],sinkVar:direction==='forward'?entry.name:sourceVar,eventIds:path});
                        next.push({eventId:match.event_id,path});scanned++;
                    }
                }
            }
            frontier=next;
            this.emitProgress(ctx,`hop ${hop+1}，已发现 ${paths.length} 条路径`,Math.min(90,10+hop*8));
        }
        if(frontier.length && (visited.size>=maxNodes || paths.length>=maxNodes))truncated=true;
        const insert=main.prepare(`INSERT INTO taint_paths(session_id,source_event_id,sink_event_id,path_json,source_var,sink_var,hop_count) VALUES (?,?,?,?,?,?,?)`);
        main.transaction(()=>{
            main.prepare('DELETE FROM taint_paths WHERE session_id=? AND source_var IS ?').run(sessionId,sourceVar??null);
            for(const path of paths)insert.run(sessionId,path.sourceEventId,path.sinkEventId,JSON.stringify(path.eventIds),sourceVar??null,path.sinkVar??null,path.eventIds.length-1);
        })();
        this.emitDone(ctx,{pathCount:paths.length,paths,precision:'statement-level',truncated,visitedNodes:visited.size,scannedMatches:scanned,storage:'disk-indexed'});
    }
}
