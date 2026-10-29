/** Reproducible backend smoke benchmark; never touches the application database. */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as db from './db/Database.mjs';
import { schedule } from './PluginEngine.mjs';
import { serializeBatch, createFileHeader } from '../src/encoding/EventSerializer.js';
const count = Number(process.argv[2] ?? 50000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new Error('count must be 1..1000000');
const directory = mkdtempSync(join(tmpdir(),'jani-benchmark-'));
try {
    const path = join(directory,'trace.bin');
    const events = Array.from({length:count},(_,i)=>({type:'END_EXPR',seq:i+1,iid:8,callId:1,
        writes:[{name:'x',val:i,scopeId:1,bindingId:'1:1:1'}],
        reads:i ? [{name:'x',val:i-1,scopeId:1,bindingId:'1:1:1'}] : []}));
    events.push({type:'TRACE_END',seq:count+1});
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch(events))]));
    await db.init(join(directory,'benchmark.db'));
    db.run("INSERT INTO sessions(id,bin_path) VALUES ('benchmark',?)",path);
    const delay=monitorEventLoopDelay({resolution:10}); delay.enable();
    let ticks=0; const timer=setInterval(()=>ticks++,10);
    const started=performance.now(); let metrics;
    try {
        await schedule('benchmark',{plugins:['F1-EventIndex','A2-DataFlowGraph'],onProgress:event=>{if(event.type==='analysis_metrics') metrics=event;}});
    } finally {clearInterval(timer); delay.disable();}
    const durationMs=performance.now()-started;
    console.log(JSON.stringify({eventCount:count,durationMs,eventsPerSecond:count/durationMs*1000,
        apiLoopP99Ms:delay.percentile(99)/1e6,apiTimerTicks:ticks,workerHeapBytes:metrics?.heapUsedBytes,
        integrity:db.get("SELECT trace_integrity FROM sessions WHERE id='benchmark'").trace_integrity},null,2));
} finally {db.close();rmSync(directory,{recursive:true,force:true});}
