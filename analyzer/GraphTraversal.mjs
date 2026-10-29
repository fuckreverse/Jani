/** Bounded BFS. Only indexed adjacency pages from relevant disk shards are read. */
import { cfg } from './Config.mjs';
function integer(value, fallback, maximum, minimum = 0) {
    const n = Number(value ?? fallback);
    if (!Number.isSafeInteger(n) || n < minimum) throw Object.assign(new Error('Invalid graph traversal limit'),{status:400});
    return Math.min(n,maximum);
}
export function traverseGraph(graph, options = {}) {
    const { varName, eventId, direction = 'both' } = options;
    if (!varName && eventId == null) throw Object.assign(new Error('varName or eventId is required'),{status:400});
    if (!['forward','backward','both'].includes(direction)) throw Object.assign(new Error('Invalid graph direction'),{status:400});
    const hops = integer(options.hops,cfg('api.dataflowSubgraphDefaultHops'),cfg('api.dataflowSubgraphMaxHops'));
    const maxNodes = integer(options.maxNodes,cfg('api.dataflowSubgraphDefaultMaxNodes'),cfg('api.dataflowSubgraphMaxNodes'),1);
    const maxEdges = cfg('api.dataflowEdgesLimit');
    const nodes = new Map(), edges = new Map(), queued = new Set(), queue = [];
    let truncated = false;
    const enqueue = (kind,key,hop) => {
        const code = `${kind}:${key}`;
        if (queued.has(code)) return;
        queued.add(code); queue.push({kind,key,hop});
    };
    if (varName) { nodes.set(`var:${varName}`,{id:`var:${varName}`,type:'var',label:varName,edgeTypes:[]}); enqueue('var',varName,0); }
    if (eventId != null) {
        const eid = integer(eventId,0,Number.MAX_SAFE_INTEGER);
        if (nodes.size < maxNodes) { nodes.set(`ev:${eid}`,{id:`ev:${eid}`,type:'event',eventId:eid,varName:null,line:null,iid:null}); enqueue('event',eid,0); }
        else truncated = true;
    }
    for (let i=0;i<queue.length;i++) {
        const current = queue[i];
        if (current.hop >= hops) continue;
        const key = current.kind === 'var' ? 'Vars' : 'Event';
        const forward = cfg(`api.dataflow${key}FwdLimit`), backward = cfg(`api.dataflow${key}BwdLimit`);
        const rows = direction === 'both'
            ? [...graph.neighbors(current.kind,current.key,'forward',forward),...graph.neighbors(current.kind,current.key,'backward',backward)]
            : graph.neighbors(current.kind,current.key,direction,direction==='forward'?forward:backward);
        for (const e of rows) {
            if (edges.has(e.id)) continue;
            if (edges.size >= maxEdges) { truncated=true; break; }
            const next = [];
            if (e.from_var != null) next.push({id:`var:${e.from_var}`,type:'var',label:e.from_var,edgeTypes:[e.edge_type]});
            if (e.to_var != null) next.push({id:`var:${e.to_var}`,type:'var',label:e.to_var,edgeTypes:[e.edge_type]});
            if (e.from_event_id != null) next.push({id:`ev:${e.from_event_id}`,type:'event',eventId:e.from_event_id,varName:e.from_var,line:e.line,iid:e.iid});
            if (e.to_event_id != null) next.push({id:`ev:${e.to_event_id}`,type:'event',eventId:e.to_event_id,varName:e.to_var,line:e.line,iid:e.iid});
            const added = new Set(next.filter(n=>!nodes.has(n.id)).map(n=>n.id));
            if (nodes.size+added.size>maxNodes) { truncated=true; continue; }
            for (const n of next) {
                const previous=nodes.get(n.id);
                if (!previous) nodes.set(n.id,n);
                else if (n.type==='var' && !previous.edgeTypes.includes(e.edge_type)) previous.edgeTypes.push(e.edge_type);
            }
            edges.set(e.id,e);
            const from = current.kind==='var' ? e.from_var : e.from_event_id;
            const to = current.kind==='var' ? e.to_var : e.to_event_id;
            if (direction!=='backward' && to!=null) enqueue(current.kind,to,current.hop+1);
            if (direction!=='forward' && from!=null) enqueue(current.kind,from,current.hop+1);
        }
    }
    const result = [...nodes.values()];
    return {nodes:result,edges:[...edges.values()],stats:{
        nodeCount:result.length,edgeCount:edges.size,varNodes:result.filter(n=>n.type==='var').length,
        eventNodes:result.filter(n=>n.type==='event').length,truncated:truncated||graph.metrics.truncated,hops,
    }};
}
