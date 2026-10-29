import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,existsSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {fileURLToPath} from 'url';
import * as db from '../db/Database.mjs';
import {GraphWriter,GraphReader,withGraph} from '../GraphStore.mjs';
import {traverseGraph} from '../GraphTraversal.mjs';
import A2 from '../plugins/A2_DataFlowGraph.mjs';
import {reload} from '../Config.mjs';

const directory=mkdtempSync(join(tmpdir(),'jani-graph-tests-'));
before(async()=>db.init(join(directory,'source.db')));
after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
function session(id){db.run('INSERT INTO sessions(id) VALUES (?)',id);}
function writer(id,limit=2){return new GraphWriter(id,{dataDir:join(directory,id),shardEdgeLimit:limit,batchSize:2});}
const edge=(from,to,fromVar='x',toVar='x',type='assign')=>({from_event_id:from,to_event_id:to,from_var:fromVar,to_var:toVar,edge_type:type,iid:8,line:1});

// These dependencies span event ranges and multiple physical shard files.
test('physical shards preserve cross-shard forward/backward adjacency, filtering and pages',()=>{
    session('cross');const w=writer('cross');
    w.add(edge(1,100,'a','b'));w.add(edge(100,200,'b','c'));
    w.add(edge(200,300,'c','d','copy'));w.add(edge(300,400,'d','e'));
    w.add(edge(null,100,'#1','#1.x','field_read'));
    const summary=w.publish();assert.equal(summary.shardCount,3);assert.equal(summary.maxBufferedEdges,2);
    assert.equal(readdirSync(w.path).filter(n=>n.startsWith('edges-')).length,3);
    const r=new GraphReader('cross',{maxOpenShards:1});
    try {
        assert.deepEqual(r.neighbors('event',200,'both').map(e=>[e.from_event_id,e.to_event_id]),[[100,200],[200,300]]);
        assert.deepEqual(r.neighbors('var','d','backward').map(e=>e.from_var),['c']);
        assert.deepEqual(r.neighbors('event',100,'backward').map(e=>e.id),[1,5]);
        const page=r.list({offset:1,limit:3});assert.deepEqual(page.edges.map(e=>e.id),[2,3,4]);assert.equal(page.total,5);
        assert.equal(r.list({edgeType:'copy'}).total,1);
        assert.equal(r.list({varExact:'b'}).total,2);
        assert.equal(r.list({varName:'d'}).total,2);
        assert.equal(r.list({seqFrom:100,seqTo:200}).total,2);
        assert.deepEqual(r.variables(''),['a','b','c','d','e']);
        assert.equal(r.metrics.maxOpenShards,1);
    } finally{r.close();}
    assert.equal(db.get("SELECT COUNT(*) n FROM dataflow_edges WHERE session_id='cross'").n,0);
});

test('bounded BFS traverses files and respects direction, hops and node caps',()=>{
    withGraph('cross',r=>{
        const result=traverseGraph(r,{eventId:100,direction:'forward',hops:3,maxNodes:30});
        assert.deepEqual(result.edges.map(e=>e.id),[2,3,4]);
        const backward=traverseGraph(r,{eventId:300,direction:'backward',hops:2,maxNodes:30});
        assert.deepEqual(backward.edges.map(e=>e.id),[3,2]);
    });
    withGraph('cross',r=>{
        const result=traverseGraph(r,{eventId:100,maxNodes:3,hops:6});
        assert.ok(result.nodes.length<=3);assert.equal(result.stats.truncated,true);
    });
    withGraph('cross',r=>assert.equal(traverseGraph(r,{eventId:100,hops:0}).edges.length,0));
});

test('high-degree seeds stay bounded and report truncation',()=>{
    session('star');const w=writer('star',10);
    for(let n=2;n<=300;n++)w.add(edge(1,n));w.publish();
    const r=new GraphReader('star',{maxOpenShards:1});
    try {
        assert.equal(r.neighbors('event',1,'forward',5).length,5);
        assert.equal(r.metrics.truncated,true);assert.equal(r.metrics.shardsOpened,1);
        const result=traverseGraph(r,{eventId:1,hops:1,maxNodes:10});
        assert.ok(result.nodes.length<=10);assert.ok(result.edges.length<=10);assert.equal(result.stats.truncated,true);
    } finally{r.close();}
});

test('generation publication is transactional and existing readers pin their snapshot',()=>{
    session('generation');const old=writer('generation');old.add(edge(1,2));old.publish();
    const pinned=new GraphReader('generation');
    db.exec('BEGIN IMMEDIATE');const failed=writer('generation');failed.add(edge(1,3));failed.publish();db.exec('ROLLBACK');failed.abort();
    assert.equal(existsSync(failed.path),false);
    assert.equal(withGraph('generation',r=>r.list().edges[0].to_event_id),2);
    const next=writer('generation');next.add(edge(1,4));next.publish();
    assert.equal(withGraph('generation',r=>r.list().edges[0].to_event_id),4);
    assert.equal(pinned.list().edges[0].to_event_id,2);pinned.close();
});

test('reader reopens persisted catalog without in-memory state',()=>{
    const r=new GraphReader('cross');const first=r.list();r.close();
    assert.deepEqual(withGraph('cross',r=>r.list()),first);
});

test('legacy graphs remain queryable and session data stays isolated',()=>{
    session('legacy');db.run('INSERT INTO dataflow_edges(session_id,from_event_id,to_event_id,from_var,to_var,edge_type) VALUES (?,?,?,?,?,?)','legacy',1,2,'legacy','target','assign');
    withGraph('legacy',r=>{assert.equal(r.list().total,1);assert.deepEqual(r.variables(),['legacy','target']);});
    assert.equal(withGraph('cross',r=>r.list({varExact:'legacy'}).total),0);
});

test('streamed builder matches binding identity across shards and clears legacy edges',async()=>{
    session('build');
    const e=db.raw().prepare("INSERT INTO events(id,session_id,type,iid) VALUES (?,'build',7,8)");
    for(let n=1;n<=8;n++)e.run(n);
    const wr=db.raw().prepare("INSERT INTO writes(session_id,event_id,name,scope_id,binding_id) VALUES ('build',?,?,1,?)");
    const rd=db.raw().prepare("INSERT INTO reads(session_id,event_id,name,scope_id,binding_id) VALUES ('build',?,?,1,?)");
    wr.run(1,'x','a');wr.run(2,'x','b');rd.run(3,'x','a');rd.run(4,'x','b');wr.run(5,'x','a');rd.run(6,'x','a');
    rd.run(7,'x','b');wr.run(7,'y','y');rd.run(8,'unknown','missing');
    process.env.JTA_GRAPH_SHARDEDGELIMIT='2';process.env.JTA_GRAPH_BATCHSIZE='1';reload();
    try{await new A2().run({sessionId:'build',dataDir:join(directory,'build'),emit(){}});}
    finally{delete process.env.JTA_GRAPH_SHARDEDGELIMIT;delete process.env.JTA_GRAPH_BATCHSIZE;reload();}
    withGraph('build',r=>{
        const edges=r.list().edges;
        assert.deepEqual(edges.filter(e=>e.edge_type==='assign').map(e=>[e.from_event_id,e.to_event_id]),[[1,3],[2,4],[5,6],[2,7]]);
        assert.deepEqual(edges.filter(e=>e.edge_type==='copy').map(e=>[e.from_event_id,e.to_event_id,e.to_var]),[[2,7,'y']]);
        assert.equal(r.manifest.shard_count,3);
    });
});

test('failed builder rolls back metadata and retains previous generation',async()=>{
    const before=db.get("SELECT generation FROM dataflow_graphs WHERE session_id='build'").generation;
    db.exec('BEGIN IMMEDIATE');
    try{
        await assert.rejects(new A2().run({sessionId:'build',dataDir:join(directory,'build'),emit(e){if(e.status==='done')throw new Error('injected failure');}}),/injected failure/);
    }finally{db.exec('ROLLBACK');}
    assert.equal(db.get("SELECT generation FROM dataflow_graphs WHERE session_id='build'").generation,before);
    assert.equal(withGraph('build',r=>r.list().total),5);
});

test('empty graphs and query validation do not leak handles',()=>{
    session('empty');writer('empty').publish();
    withGraph('empty',r=>{
        assert.equal(r.list().total,0);assert.deepEqual(r.variables(),[]);assert.deepEqual(r.neighbors('event',1),[]);
        assert.throws(()=>r.list({limit:-1}));assert.throws(()=>r.list({offset:-1}));
        assert.throws(()=>r.neighbors('event',1,'invalid'));assert.throws(()=>traverseGraph(r,{eventId:'bad'}));
    });
});

test('HTTP graph endpoints preserve response shape across physical shards',async()=>{
    const {default:express}=await import('express');
    const {default:router}=await import('../routes/sessions/analysis.mjs');
    const {once}=await import('events');
    const app=express();app.use('/api/sessions/:id',router);
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const root=`http://127.0.0.1:${server.address().port}/api/sessions/cross`;
    try{
        const page=await (await fetch(`${root}/dataflow?limit=2&offset=2`)).json();
        assert.deepEqual(page.edges.map(e=>e.id),[3,4]);assert.equal(page.total,5);assert.equal(page.count,2);assert.equal(page.offset,2);
        const vars=await (await fetch(`${root}/dataflow/vars?prefix=b`)).json();assert.deepEqual(vars,{vars:['b']});
        const sub=await (await fetch(`${root}/dataflow/subgraph?eventId=200&direction=forward&hops=2`)).json();
        assert.deepEqual(sub.edges.map(e=>e.id),[3,4]);assert.ok(sub.stats.nodeCount>0);
        assert.equal((await fetch(`${root}/dataflow?limit=-1`)).status,400);
        assert.equal((await fetch(`${root}/dataflow/subgraph?eventId=1&direction=invalid`)).status,400);
        assert.equal((await fetch(root.replace('cross','missing')+'/dataflow')).status,404);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('standalone failed rebuild is atomic without an external scheduler transaction',async()=>{
    const before=db.get("SELECT generation FROM dataflow_graphs WHERE session_id='build'").generation;
    await assert.rejects(new A2().run({sessionId:'build',dataDir:join(directory,'build'),emit(e){if(e.status==='done')throw new Error('publish failed');}}),/publish failed/);
    assert.equal(db.get("SELECT generation FROM dataflow_graphs WHERE session_id='build'").generation,before);
    assert.equal(withGraph('build',r=>r.list().total),5);
});

test('metadata follows session deletion and a missing shard fails visibly',()=>{
    session('remove');const w=writer('remove');w.add(edge(1,2));w.publish();
    rmSync(join(w.path,'edges-1.sqlite'));
    assert.throws(()=>withGraph('remove',r=>r.neighbors('event',1)),/open|exist/i);
    db.run("DELETE FROM sessions WHERE id='remove'");
    assert.equal(db.get("SELECT * FROM dataflow_graphs WHERE session_id='remove'"),undefined);
});

test('worker scheduling publishes disk shards and a valid checkpoint',async()=>{
    const {writeFileSync}=await import('fs');
    const {serializeBatch,createFileHeader}=await import('../../src/encoding/EventSerializer.js');
    const {schedule}=await import('../PluginEngine.mjs');
    const bin=join(directory,'worker-graph.bin');
    writeFileSync(bin,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([
        {type:'END_EXPR',seq:1,writes:[{name:'x',val:1,scopeId:1,bindingId:'0:1:1'}]},
        {type:'END_EXPR',seq:2,reads:[{name:'x',val:1,scopeId:1,bindingId:'0:1:1'}]},
        {type:'TRACE_END',seq:3},
    ]))]));
    db.run('INSERT INTO sessions(id,bin_path) VALUES (?,?)','worker-graph',bin);
    await schedule('worker-graph',{plugins:['A2-DataFlowGraph'],dataDir:join(directory,'worker-graph')});
    assert.equal(withGraph('worker-graph',r=>r.list().total),1);
    assert.equal(db.get("SELECT status FROM sessions WHERE id='worker-graph'").status,'ready');
    const record=db.get("SELECT summary_json FROM plugin_checkpoints WHERE session_id='worker-graph' AND plugin_id='A2-DataFlowGraph'");
    assert.equal(JSON.parse(record.summary_json).storage,'disk-sharded');
});

test('scheduler rollback removes a newly published generation after downstream execution failure',async()=>{
    const {schedule,registerPlugin}=await import('../PluginEngine.mjs');
    const previous=db.get("SELECT * FROM dataflow_graphs WHERE session_id='build'");
    const parent=join(directory,'build','dataflow'),before=readdirSync(parent).sort();
    registerPlugin(class {
        static id='test-graph-rollback';static deps=[];
        async run(ctx){await new A2().run(ctx);throw new Error('after publish');}
    });
    await assert.rejects(schedule('build',{worker:false,plugins:['test-graph-rollback'],dataDir:join(directory,'build')}),/Analysis failed/);
    assert.equal(db.get("SELECT generation FROM dataflow_graphs WHERE session_id='build'").generation,previous.generation);
    assert.deepEqual(readdirSync(parent).sort(),before);
    assert.equal(withGraph('build',r=>r.list().total),5);
});

test('large graph construction succeeds with a 48 MiB JS heap budget',async()=>{
    const {spawnSync}=await import('child_process');
    const result=spawnSync(process.execPath,['--max-old-space-size=48',fileURLToPath(new URL('../benchmark-graph.mjs',import.meta.url)),'100000'],{
        encoding:'utf8',timeout:60000,env:{...process.env,LOG_LEVEL:'error',JANI_GRAPH_BENCHMARK_TMPDIR:directory},
    });
    assert.equal(result.status,0,result.stderr || result.error?.message);
    const stats=JSON.parse(result.stdout);
    assert.equal(stats.edgeCount,100000);assert.ok(stats.maxBufferedEdges<=1000);
    assert.equal(stats.queryEdges,1);assert.equal(stats.queryMetrics.maxOpenShards,1);
});


test('page reads and exact-variable filters prune irrelevant shards using the catalog',()=>{
    const page=new GraphReader('cross',{maxOpenShards:1});
    try{
        assert.equal(page.list({limit:1}).total,5);
        assert.equal(page.metrics.shardsOpened,1);
    }finally{page.close();}
    const exact=new GraphReader('cross',{maxOpenShards:1});
    try{
        assert.equal(exact.list({varExact:'e'}).total,1);
        assert.equal(exact.metrics.shardsOpened,1);
    }finally{exact.close();}
});

test('retired generations are reclaimed only after the last reader releases its snapshot', () => {
    session('gc-pinned');
    const old = writer('gc-pinned'); old.add(edge(1,2)); old.publish();
    const first = new GraphReader('gc-pinned'), second = new GraphReader('gc-pinned');
    const next = writer('gc-pinned'); next.add(edge(1,3)); next.publish();
    assert.equal(existsSync(old.path), true);
    assert.equal(first.list().edges[0].to_event_id, 2);
    first.close(); assert.equal(existsSync(old.path), true);
    second.close(); assert.equal(existsSync(old.path), false);
    assert.equal(withGraph('gc-pinned', reader => reader.list().edges[0].to_event_id), 3);
    assert.equal(existsSync(next.path), true);
});

test('forced worker termination cleans unpublished files and leases while preserving the committed graph', async () => {
    const { Worker } = await import('worker_threads');
    const { once } = await import('events');
    const { collectGraphGenerations } = await import('../GraphStore.mjs');
    session('gc-killed');
    const previous = writer('gc-killed'); previous.add(edge(1,2)); previous.publish();
    const owner = 'test-terminated-worker';
    const worker = new Worker(`
        const { workerData, parentPort } = await import('worker_threads');
        const db = await import(workerData.dbModule);
        const { GraphWriter, GraphReader } = await import(workerData.graphModule);
        await db.init(workerData.dbPath);
        const reader = new GraphReader(workerData.sessionId);
        db.exec('BEGIN IMMEDIATE');
        const writer = new GraphWriter(workerData.sessionId, { dataDir: workerData.dataDir });
        writer.add({ from_event_id: 1, to_event_id: 99, edge_type: 'assign' }); writer.publish();
        // Termination may interrupt a lifecycle critical section in this same PID.
        const { mkdirSync, writeFileSync } = await import('fs');
        const { dirname, join } = await import('path');
        const lock = join(dirname(workerData.dbPath), '.graph-lifecycle.lock');
        mkdirSync(lock);
        writeFileSync(join(lock,'owner.json'), JSON.stringify({ pid:process.pid, graphOwner:workerData.graphOwner }));
        parentPort.postMessage({ path: writer.path });
        setInterval(() => {}, 1000);
    `, { eval: true, type: 'module', workerData: {
        graphOwner: owner, sessionId: 'gc-killed', dbPath: db.raw().name,
        dbModule: new URL('../db/Database.mjs', import.meta.url).href,
        graphModule: new URL('../GraphStore.mjs', import.meta.url).href,
        dataDir: join(directory, 'gc-killed'),
    } });
    let orphan;
    try {
        [orphan] = await once(worker, 'message');
        assert.equal(existsSync(orphan.path), true);
    } finally { await worker.terminate(); }
    collectGraphGenerations('gc-killed', { dataDir: join(directory, 'gc-killed'), finishedOwner: owner });
    assert.equal(existsSync(orphan.path), false);
    assert.equal(readdirSync(previous.path).some(name => name.startsWith('.reader-')), false);
    assert.equal(withGraph('gc-killed', reader => reader.list().edges[0].to_event_id), 2);
});

test('recovery reclaims abandoned and legacy generations but preserves live unfinished writers', async () => {
    const { writeFileSync } = await import('fs');
    const { collectGraphGenerations } = await import('../GraphStore.mjs');
    session('gc-recovery');
    const old = writer('gc-recovery'); old.add(edge(1,2)); old.publish();
    const pinned = new GraphReader('gc-recovery');
    const current = writer('gc-recovery'); current.add(edge(1,3)); current.publish();
    const orphan = writer('gc-recovery');
    collectGraphGenerations('gc-recovery', { dataDir: join(directory,'gc-recovery') });
    assert.equal(existsSync(orphan.path), true);
    // Simulate an interrupted process's owner record and an older on-disk format.
    orphan.catalog.close(); orphan.catalog = null;
    writeFileSync(join(orphan.path,'.generation.json'), JSON.stringify({ sessionId:'gc-recovery', pid:2147483647, released:false }));
    rmSync(join(old.path,'.generation.json'), { force:true });
    pinned.close();
    assert.equal(existsSync(old.path), false);
    collectGraphGenerations('gc-recovery', { dataDir: join(directory,'gc-recovery') });
    assert.equal(existsSync(orphan.path), false);
    assert.equal(existsSync(current.path), true);
});

test('a reader in another worker keeps its generation alive through publication and reclamation', async () => {
    const { Worker } = await import('worker_threads');
    const { once } = await import('events');
    session('gc-other-reader');
    const old = writer('gc-other-reader'); old.add(edge(1,2)); old.publish();
    const worker = new Worker(`
        const { workerData, parentPort } = await import('worker_threads');
        const db = await import(workerData.dbModule);
        const { GraphReader } = await import(workerData.graphModule);
        await db.init(workerData.dbPath);
        const reader = new GraphReader('gc-other-reader');
        parentPort.postMessage('pinned');
        parentPort.once('message', () => {
            const target = reader.list().edges[0].to_event_id;
            reader.close(); db.close(); parentPort.postMessage(target); parentPort.close();
        });
    `, { eval:true, type:'module', workerData: {
        dbPath:db.raw().name, dbModule:new URL('../db/Database.mjs',import.meta.url).href,
        graphModule:new URL('../GraphStore.mjs',import.meta.url).href,
    } });
    try {
        await once(worker,'message');
        const next = writer('gc-other-reader'); next.add(edge(1,3)); next.publish();
        assert.equal(existsSync(old.path),true);
        const response = once(worker,'message'); worker.postMessage('read');
        assert.deepEqual(await response,[2]);
        assert.equal(existsSync(old.path),false);
        assert.equal(withGraph('gc-other-reader',reader=>reader.list().edges[0].to_event_id),3);
    } finally { await worker.terminate(); }
});
