/** Run with --max-old-space-size=48 to verify graph construction independently
 * of ingestion. Input rows are generated in SQLite without a session-sized array.
 * Example: LOG_LEVEL=error node --max-old-space-size=48 analyzer/benchmark-graph.mjs 200000
 */
import {mkdtempSync,rmSync,readdirSync,statSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import * as db from './db/Database.mjs';
import A2 from './plugins/A2_DataFlowGraph.mjs';
import {GraphReader} from './GraphStore.mjs';
import {traverseGraph} from './GraphTraversal.mjs';

const count=Number(process.argv[2]??200000);
if(!Number.isSafeInteger(count)||count<1||count>10000000)throw new Error('count must be 1..10000000');
const directory=mkdtempSync(join(process.env.JANI_GRAPH_BENCHMARK_TMPDIR ?? tmpdir(),'jani-graph-benchmark-'));
try{
    await db.init(join(directory,'input.db'));
    db.run("INSERT INTO sessions(id) VALUES ('benchmark')");
    const raw=db.raw();
    const insertEvent=raw.prepare("INSERT INTO events(session_id,id,type,iid) VALUES ('benchmark',?,7,8)");
    const insertWrite=raw.prepare("INSERT INTO writes(session_id,event_id,name,binding_id,scope_id) VALUES ('benchmark',?,'x',?,1)");
    const insertRead=raw.prepare("INSERT INTO reads(session_id,event_id,name,binding_id,scope_id) VALUES ('benchmark',?,'x',?,1)");
    raw.transaction(()=>{
        for(let i=0;i<count;i++){
            const binding=`0:1:${i}`, from=i+1,to=count+i+1;
            insertEvent.run(from);insertEvent.run(to);insertWrite.run(from,binding);insertRead.run(to,binding);
        }
    })();
    let summary;const started=performance.now();
    await new A2().run({sessionId:'benchmark',dataDir:directory,emit(e){if(e.status==='done')summary=e.summary;}});
    const durationMs=performance.now()-started;
    const graph=new GraphReader('benchmark',{maxOpenShards:1});
    let subgraph,metrics;
    try{
        // Last shard: the directory index should avoid reading unrelated files.
        subgraph=traverseGraph(graph,{eventId:count*2,direction:'backward',hops:1,maxNodes:10});
        metrics={...graph.metrics};
        if(subgraph.edges.length!==1)throw new Error('Incorrect cross-range lookup');
    }finally{graph.close();}
    const manifest=db.get("SELECT * FROM dataflow_graphs WHERE session_id='benchmark'");
    const bytes=readdirSync(manifest.root_path).reduce((sum,name)=>sum+statSync(join(manifest.root_path,name)).size,0);
    console.log(JSON.stringify({inputEvents:count*2,edgeCount:summary.edgeCount,shardCount:summary.shardCount,
        maxBufferedEdges:summary.maxBufferedEdges,durationMs,heapUsedBytes:process.memoryUsage().heapUsed,
        rssBytes:process.memoryUsage().rss,graphBytes:bytes,queryEdges:subgraph.edges.length,queryMetrics:metrics},null,2));
}finally{db.close();rmSync(directory,{recursive:true,force:true});}
