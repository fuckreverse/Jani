/** Shared, indexed statement dependencies. No value/name matching across bindings.
 * Explicit call/await edges are supplied by the recorder; old traces do not invent them.
 */
export const synthetic = (name,type) => (type===3 && (name==='callee' || name==='callee_def_iid' || /^arg\d+$/.test(name))) || (type===4 && name==='return');

export class DependencyIndex {
    constructor(raw, sessionId) {
        this.raw = raw;
        this.sessionId = sessionId;
        this.truncated = false;
        this.hasFields=!!raw.prepare('SELECT 1 FROM fields WHERE session_id=? LIMIT 1').get(sessionId);
        this.hasExplicit=!!raw.prepare('SELECT 1 FROM event_dependencies WHERE session_id=? LIMIT 1').get(sessionId);
        this.hasControl=!!raw.prepare('SELECT 1 FROM control_regions WHERE session_id=? LIMIT 1').get(sessionId);
        this.eventType = raw.prepare('SELECT type FROM events WHERE session_id=? AND id=?');
        this.reads = raw.prepare('SELECT * FROM reads WHERE session_id=? AND event_id=? ORDER BY id LIMIT ?');
        this.writes = raw.prepare('SELECT * FROM writes WHERE session_id=? AND event_id=? ORDER BY id LIMIT ?');
        this.fields = raw.prepare('SELECT * FROM fields WHERE session_id=? AND event_id=? ORDER BY id LIMIT ?');
        this.definitions = {};
        for(const bound of [true,false]) {
            const identity=bound ? 'binding_id=?' : 'binding_id IS NULL AND scope_id IS ?';
            this.definitions[bound]={
                prev:raw.prepare(`SELECT event_id FROM writes WHERE session_id=? AND name=? AND ${identity} AND event_id<? ORDER BY event_id DESC,id DESC LIMIT 1`),
                next:raw.prepare(`SELECT event_id FROM writes WHERE session_id=? AND name=? AND ${identity} AND event_id>? ORDER BY event_id,id LIMIT 1`),
                uses:raw.prepare(`SELECT DISTINCT event_id FROM reads WHERE session_id=? AND name=? AND ${identity} AND event_id>? AND event_id<=? ORDER BY event_id LIMIT ?`),
            };
        }
        this.prevField = raw.prepare(`SELECT event_id,is_write,value_id,id FROM fields INDEXED BY idx_fields_dependency WHERE session_id=? AND base_oid=? AND offset=?
            AND is_write IN (1,2) AND (event_id,id)<(?,?) ORDER BY event_id DESC,id DESC LIMIT 1`);
        this.nextField = raw.prepare(`SELECT event_id,id FROM fields INDEXED BY idx_fields_dependency WHERE session_id=? AND base_oid=? AND offset=?
            AND is_write IN (1,2) AND (event_id,id)>(?,?) ORDER BY event_id,id LIMIT 1`);
        this.barrierScans=0;
        if(this.hasFields) {
            raw.exec(`CREATE TEMP TABLE IF NOT EXISTS jani_property_barriers (
                session_id TEXT, field_id INTEGER, next_event INTEGER, next_id INTEGER,
                barrier_event INTEGER, barrier_id INTEGER, PRIMARY KEY(session_id,field_id));
                DELETE FROM jani_property_barriers;`);
            this.cachedBarrier=raw.prepare('SELECT * FROM temp.jani_property_barriers WHERE session_id=? AND field_id=?');
            this.cacheBarrier=raw.prepare('INSERT OR REPLACE INTO temp.jani_property_barriers VALUES (?,?,?,?,?,?)');
        }
        this.fieldBarrier=raw.prepare(`SELECT event_id,id FROM fields INDEXED BY idx_fields_dependency WHERE session_id=? AND base_oid=? AND offset=?
            AND is_write=0 AND value_id IS NOT ? AND (event_id,id)>(?,?)
            AND (event_id,id)<(?,?) ORDER BY event_id,id LIMIT 1`);
        this.fieldUses = raw.prepare(`SELECT DISTINCT event_id FROM fields INDEXED BY idx_fields_dependency WHERE session_id=? AND base_oid=? AND offset=?
            AND is_write=0 AND (event_id,id)>(?,?)
            AND (event_id,id)<(?,?) ORDER BY event_id LIMIT ?`);
        this.explicitIn = raw.prepare('SELECT d.* FROM event_dependencies d JOIN events e ON e.session_id=d.session_id AND e.id=d.from_event_id WHERE d.session_id=? AND d.to_event_id=? ORDER BY d.id LIMIT ?');
        this.explicitOut = raw.prepare('SELECT d.* FROM event_dependencies d JOIN events e ON e.session_id=d.session_id AND e.id=d.to_event_id WHERE d.session_id=? AND d.from_event_id=? ORDER BY d.id LIMIT ?');
        // Lexical control dependence is a conservative approximation, kept distinct
        // from data propagation. Match only the latest evaluation in this invocation.
        const controlled = `FROM control_regions c JOIN events b ON b.session_id=c.session_id AND b.id=c.event_id
            JOIN events e ON e.session_id=b.session_id AND e.call_id IS b.call_id AND e.script_id IS b.script_id AND e.id>b.id
            JOIN smap s ON s.session_id=e.session_id AND s.iid=e.iid
            WHERE c.session_id=? AND (s.sl>c.sl OR (s.sl=c.sl AND s.sc>=c.sc))
            AND (s.el<c.el OR (s.el=c.el AND s.ec<=c.ec))
            AND NOT EXISTS (SELECT 1 FROM event_analysis a JOIN events newer ON newer.session_id=a.session_id AND newer.id=a.event_id
                WHERE a.session_id=b.session_id AND a.kind='branch' AND newer.iid=b.iid
                AND newer.call_id IS b.call_id AND newer.script_id IS b.script_id AND newer.id>b.id AND newer.id<e.id)`;
        this.controlIn=raw.prepare(`SELECT DISTINCT b.id AS from_event_id,e.id AS to_event_id,'control' AS edge_type ${controlled} AND e.id=? LIMIT ?`);
        this.controlOut=raw.prepare(`SELECT DISTINCT b.id AS from_event_id,e.id AS to_event_id,'control' AS edge_type ${controlled} AND b.id=? ORDER BY e.id LIMIT ?`);
    }
    propertyBarrier(field,definition) {
        const cached=this.cachedBarrier.get(this.sessionId,definition.id);
        if(cached)return {
            next:cached.next_event==null ? null : {event_id:cached.next_event,id:cached.next_id},
            barrier:cached.barrier_event==null ? null : {event_id:cached.barrier_event,id:cached.barrier_id},
        };
        const next=this.nextField.get(this.sessionId,field.base_oid,field.offset,definition.event_id,definition.id);
        this.barrierScans++;
        const barrier=this.fieldBarrier.get(this.sessionId,field.base_oid,field.offset,definition.value_id,
            definition.event_id,definition.id,
            next?.event_id ?? Number.MAX_SAFE_INTEGER,next?.id ?? Number.MAX_SAFE_INTEGER);
        this.cacheBarrier.run(this.sessionId,definition.id,next?.event_id ?? null,next?.id ?? null,barrier?.event_id ?? null,barrier?.id ?? null);
        return {next,barrier};
    }

    isSynthetic(row,eventId) {
        if(!['callee','callee_def_iid','return'].includes(row.name) && !/^arg\d+$/.test(row.name))return false;
        return synthetic(row.name,this.eventType.get(this.sessionId,eventId)?.type);
    }
    identity(row) { return [this.sessionId,row.name,row.binding_id ?? row.scope_id ?? null]; }
    bounded(stmt, args, limit) {
        const rows = stmt.all(...args,limit+1);
        if (rows.length>limit) this.truncated=true;
        return rows.slice(0,limit);
    }
    incoming(eventId, limit=500) {
        const edges=[];
        const add=(from,fromVar,toVar,type,evidence='binding') => {
            if(from!=null && from!==eventId) edges.push({from_event_id:from,to_event_id:eventId,from_var:fromVar,to_var:toVar,edge_type:type,evidence});
        };
        for(const r of this.bounded(this.reads,[this.sessionId,eventId],limit)) {
            if(this.isSynthetic(r,eventId)) continue;
            const def=this.definitions[r.binding_id!=null].prev.get(...this.identity(r),eventId);
            if(def) add(def.event_id,r.name,r.name,'assign',r.binding_id ? 'binding' : 'legacy-scope');
        }
        for(const f of this.hasFields ? this.bounded(this.fields,[this.sessionId,eventId],limit) : []) {
            if(f.is_write || f.base_oid==null || f.offset==null) continue;
            const def=this.prevField.get(this.sessionId,f.base_oid,f.offset,eventId,f.id);
            if(def?.is_write===1 && def.value_id!=null && f.value_id===def.value_id) {
                const {barrier}=this.propertyBarrier(f,def);
                if(!barrier || barrier.event_id>eventId || (barrier.event_id===eventId && barrier.id>f.id))
                    add(def.event_id,`#${f.base_oid}.${f.offset}`,`#${f.base_oid}.${f.offset}`,'field_read','object-property');
            }
        }
        if(this.hasExplicit)edges.push(...this.bounded(this.explicitIn,[this.sessionId,eventId],limit));
        if(this.hasControl)edges.push(...this.bounded(this.controlIn,[this.sessionId,eventId],limit).map(e=>({...e,evidence:'lexical-control'})));
        return this.cap(edges,limit);
    }
    outgoing(eventId, limit=500) {
        const edges=[];
        for(const w of this.bounded(this.writes,[this.sessionId,eventId],limit)) {
            if(this.isSynthetic(w,eventId)) continue;
            const end=this.definitions[w.binding_id!=null].next.get(...this.identity(w),eventId)?.event_id ?? Number.MAX_SAFE_INTEGER;
            for(const r of this.bounded(this.definitions[w.binding_id!=null].uses,[...this.identity(w),eventId,end],limit))
                edges.push({from_event_id:eventId,to_event_id:r.event_id,from_var:w.name,to_var:w.name,edge_type:'assign'});
        }
        for(const f of this.hasFields ? this.bounded(this.fields,[this.sessionId,eventId],limit) : []) {
            if(f.is_write!==1 || f.base_oid==null || f.offset==null || f.value_id==null) continue;
            const interval=this.propertyBarrier(f,f);
            let end=interval.next;
            const barrier=interval.barrier;
            if(barrier && (!end || barrier.event_id<end.event_id || (barrier.event_id===end.event_id && barrier.id<end.id)))end=barrier;
            for(const r of this.bounded(this.fieldUses,[this.sessionId,f.base_oid,f.offset,eventId,f.id,
                end?.event_id ?? Number.MAX_SAFE_INTEGER,end?.id ?? Number.MAX_SAFE_INTEGER],limit)) {
                if(r.event_id!==eventId) edges.push({from_event_id:eventId,to_event_id:r.event_id,
                    from_var:`#${f.base_oid}.${f.offset}`,to_var:`#${f.base_oid}.${f.offset}`,edge_type:'field_read'});
            }
        }
        if(this.hasExplicit)edges.push(...this.bounded(this.explicitOut,[this.sessionId,eventId],limit));
        if(this.hasControl)edges.push(...this.bounded(this.controlOut,[this.sessionId,eventId],limit).map(e=>({...e,evidence:'lexical-control'})));
        return this.cap(edges,limit);
    }
    cap(edges,limit) {
        const unique=[...new Map(edges.map(e=>[JSON.stringify([e.from_event_id,e.to_event_id,e.from_var,e.to_var,e.edge_type]),e])).values()];
        if(unique.length>limit)this.truncated=true;
        return unique.slice(0,limit);
    }
}

/** Breadth-first slice: maxHops is depth, maxNodes bounds the whole result. */
export function sliceDependencies(index, seeds, {direction='backward',maxHops=8,maxNodes=500}={}) {
    const queue=[...new Set(seeds)].slice(0,maxNodes).map(eventId=>({eventId,depth:0}));
    const visited=new Set(queue.map(n=>n.eventId)), nodes=[], edges=[];
    let truncated=seeds.length>maxNodes;
    for(let cursor=0;cursor<queue.length;cursor++) {
        const node=queue[cursor]; nodes.push(node);
        const adjacent=direction==='forward'?index.outgoing(node.eventId,maxNodes):index.incoming(node.eventId,maxNodes);
        if(node.depth>=maxHops) {
            if(adjacent.some(e=>!visited.has(direction==='forward'?e.to_event_id:e.from_event_id)))truncated=true;
            continue;
        }
        for(const edge of adjacent) {
            const eventId=direction==='forward'?edge.to_event_id:edge.from_event_id;
            if(!visited.has(eventId)) {
                if(visited.size>=maxNodes){truncated=true;continue;}
                visited.add(eventId); queue.push({eventId,depth:node.depth+1,parent:node.eventId,varName:edge.from_var});
            }
            if(edges.length<maxNodes)edges.push(edge);else truncated=true;
        }
    }
    return {nodes,edges,truncated:truncated||index.truncated,precision:'statement-level'};
}
