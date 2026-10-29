/** Reproducible A/B comparison: same indexed SQLite input, separate Node processes.
 * Baseline: commit 7a0290e in-memory A2 plus a narrow v4 binding-ID compatibility patch. Override with JANI_GRAPH_BASELINE_REF.
 * Usage: LOG_LEVEL=error node analyzer/benchmark-graph-compare.mjs [edgeCount=200000] [repeats=3]
 */
import {mkdtempSync,rmSync,writeFileSync,copyFileSync,readFileSync} from 'fs';
import {tmpdir} from 'os';
import {resolve,join} from 'path';
import {fileURLToPath,pathToFileURL} from 'url';
import {execFileSync,spawn} from 'child_process';
import {createHash} from 'crypto';
import * as db from './db/Database.mjs';
import {GraphReader} from './GraphStore.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const script=fileURLToPath(import.meta.url);

async function child(mode,input,work,baseline) {
    await db.init(input);
    const Plugin=mode==='memory' ? (await import(pathToFileURL(baseline).href)).default
        : (await import('./plugins/A2_DataFlowGraph.mjs')).default;
    let peakHeap=0,peakRss=0,summary;
    const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);};
    sample();const started=performance.now();
    await new Plugin().run({sessionId:'benchmark',dataDir:work,emit(e){sample();if(e.status==='done')summary=e.summary;}});
    const buildMs=performance.now()-started;sample();
    const buildPeakRssBytes=process.resourceUsage().maxRSS*1024;
    const graph=new GraphReader('benchmark');
    const total=Number(process.env.JANI_COMPARE_EDGE_COUNT);
    const queries=[];
    try{
        for(let i=0;i<100;i++){
            const source=Math.floor(i*(total-1)/99)+1,target=total+source;
            const begin=performance.now();const edges=graph.neighbors('event',target,'backward',10);
            queries.push(performance.now()-begin);
            if(edges.length!==1 || edges[0].from_event_id!==source)throw new Error('Query equivalence failed');
        }
        // Full output equivalence, outside the measured build and query timings.
        const hash=createHash('sha256');let count=0;
        for(let offset=0;offset<total;offset+=1000){
            const page=graph.list({offset,limit:1000});
            for(const e of page.edges){hash.update(JSON.stringify([e.from_event_id,e.to_event_id,e.from_var,e.to_var,e.edge_type,e.iid,e.line])+'\n');count++;}
        }
        queries.sort((a,b)=>a-b);
        console.log(JSON.stringify({mode,edgeCount:count,buildMs,peakHeapBytes:peakHeap,
            buildPeakRssBytes,observedRssBytes:peakRss,outputHash:hash.digest('hex'),
            queryMedianMs:queries[50],queryP95Ms:queries[94],firstColdQueryIncluded:true,
            shardCount:summary?.shardCount??0,bufferedEdges:summary?.maxBufferedEdges??null}));
    }finally{graph.close();db.close();}
}

function run(mode,input,work,baseline,heap,edgeCount) {
    return new Promise((resolveRun,reject)=>{
        const processChild=spawn(process.execPath,[`--max-old-space-size=${heap}`,script,'--child',mode,input,work,baseline],{
            env:{...process.env,LOG_LEVEL:'error',JANI_COMPARE_EDGE_COUNT:String(edgeCount)},stdio:['ignore','pipe','pipe'],
        });
        let out='',err='';const timer=setTimeout(()=>processChild.kill('SIGKILL'),120000);
        processChild.stdout.on('data',b=>{out+=b;});
        processChild.stderr.on('data',b=>{err=(err+b).slice(-12000);});
        processChild.on('error',reject);
        processChild.on('close',(code,signal)=>{
            clearTimeout(timer);
            if(code===0){try{resolveRun({...JSON.parse(out),heapLimitMiB:heap});}catch(error){reject(error);}}
            else resolveRun({mode,heapLimitMiB:heap,failed:true,code,signal,oom:/heap out of memory|Reached heap limit|Allocation failed/i.test(err),errorTail:err.slice(-1500)});
        });
    });
}

if(process.argv[2]==='--child'){
    await child(...process.argv.slice(3));
}else{
    const edgeCount=Number(process.argv[2]??200000),repeats=Number(process.argv[3]??3);
    if(!Number.isSafeInteger(edgeCount)||edgeCount<100||edgeCount>1000000||!Number.isSafeInteger(repeats)||repeats<1||repeats>5)throw new Error('Invalid comparison size/repeats');
    const root=mkdtempSync(join(tmpdir(),'jani-graph-compare-'));
    try{
        const baselineRef=process.env.JANI_GRAPH_BASELINE_REF ?? '7a0290e';
        const revision=execFileSync('git',['rev-parse',`${baselineRef}^{commit}`],{cwd:here,encoding:'utf8'}).trim();
        const original=execFileSync('git',['show',`${revision}:analyzer/plugins/A2_DataFlowGraph.mjs`],{cwd:here,encoding:'utf8'});
        let adapted=original.replace("'./BasePlugin.mjs'",JSON.stringify(pathToFileURL(resolve(here,'plugins/BasePlugin.mjs')).href))
            .replace("'../db/Database.mjs'",JSON.stringify(pathToFileURL(resolve(here,'db/Database.mjs')).href))
            .replace("'../Config.mjs'",JSON.stringify(pathToFileURL(resolve(here,'Config.mjs')).href))
            .replace('w.event_id, w.name, w.scope_id','w.event_id, w.name, w.scope_id, w.binding_id')
            .replace('SELECT event_id, name, scope_id FROM reads','SELECT event_id, name, scope_id, binding_id FROM reads')
            .replaceAll('w.scope_id ?? null','w.binding_id ?? w.scope_id ?? null')
            .replaceAll('r.scope_id ?? null','r.binding_id ?? r.scope_id ?? null');
        if(!adapted.includes('w.binding_id ?? w.scope_id'))throw new Error('Baseline compatibility patch did not apply');
        const baseline=join(root,'memory-baseline.mjs');writeFileSync(baseline,adapted);
        const input=join(root,'source.db');await db.init(input);
        db.run("INSERT INTO sessions(id) VALUES ('benchmark')");
        const raw=db.raw(),evt=raw.prepare("INSERT INTO events(session_id,id,type,iid) VALUES ('benchmark',?,7,8)"),
            wr=raw.prepare("INSERT INTO writes(session_id,event_id,name,scope_id,binding_id) VALUES ('benchmark',?,'x',1,?)"),
            rd=raw.prepare("INSERT INTO reads(session_id,event_id,name,scope_id,binding_id) VALUES ('benchmark',?,'x',1,?)");
        raw.transaction(()=>{for(let i=1;i<=edgeCount;i++){evt.run(i);evt.run(i+edgeCount);wr.run(i,`0:1:${i}`);rd.run(i+edgeCount,`0:1:${i}`);}})();
        db.close();const results=[];
        // Alternate order across repetitions to reduce systematic warm-cache bias.
        for(let repeat=0;repeat<repeats;repeat++){
            for(const mode of repeat%2?['disk','memory']:['memory','disk']){
                const work=join(root,`run-${repeat}-${mode}`);const childInput=work+'.db';copyFileSync(input,childInput);
                console.error(`Comparing ${mode}: ${edgeCount} edges, repeat ${repeat+1}/${repeats}, 512 MiB heap`);
                const result=await run(mode,childInput,work,baseline,512,edgeCount);results.push({...result,repeat});
            }
        }
        for(const mode of ['memory','disk']){
            const work=join(root,`small-heap-${mode}`),childInput=work+'.db';copyFileSync(input,childInput);
            console.error(`Capacity check ${mode}: ${edgeCount} edges, 48 MiB heap`);
            results.push({...await run(mode,childInput,work,baseline,48,edgeCount),capacityCheck:true});
        }
        const successful=results.filter(r=>!r.failed);
        const hashes=new Set(successful.map(r=>r.outputHash));
        const modes=new Set(successful.map(r=>r.mode));
        if(hashes.size!==1)throw new Error('Baseline and disk graph outputs differ');
        console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,baselineRevision:revision,
            baselineOriginalSha256:createHash('sha256').update(original).digest('hex'),
            baselineNote:'Committed memory algorithm with binding_id matching compatibility; shared current database schema/indexes/config.',
            currentGraphStoreSha256:createHash('sha256').update(readFileSync(resolve(here,'GraphStore.mjs'))).digest('hex'),
            currentA2Sha256:createHash('sha256').update(readFileSync(resolve(here,'plugins/A2_DataFlowGraph.mjs'))).digest('hex'),
            edgeCount,inputEvents:edgeCount*2,repeats,outputEquivalent:modes.has('memory')&&modes.has('disk'),results},null,2));
    }finally{db.close();rmSync(root,{recursive:true,force:true});}
}
