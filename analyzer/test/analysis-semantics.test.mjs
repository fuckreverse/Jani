import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as db from '../db/Database.mjs';
import {DependencyIndex,sliceDependencies} from '../DependencyIndex.mjs';
import {analysisQuality} from '../AnalysisQuality.mjs';
import F1 from '../plugins/F1_EventIndex.mjs';
import F2 from '../plugins/F2_SmapLoader.mjs';
import A1 from '../plugins/A1_TaintTracker.mjs';
import A2 from '../plugins/A2_DataFlowGraph.mjs';
import A3 from '../plugins/A3_HotPathAnalyzer.mjs';
import A5 from '../plugins/A5_LoopDetector.mjs';
import F3 from '../plugins/F3_CallGraphBuilder.mjs';
import I2 from '../plugins/I2_SignatureAnalyzer.mjs';
import {withGraph} from '../GraphStore.mjs';
import {init,instrumentCode,buildSmapJson} from '../../src/instrument/esnstrument.js';
import {ALL_CONFIG,runInSandbox} from '../../test/helpers/shared-helpers.mjs';
import {JalangiSandbox} from '../../src/runtime/JalangiSandbox.js';
import {ExecutionTraceAnalysis} from '../../src/plugins/ExecutionTrace.js';
import {TraceLogger} from '../../src/logger/TraceLogger.js';
import {MemoryBackend} from '../../src/logger/transport/MemoryBackend.js';
import {serializeBatch,createFileHeader} from '../../src/encoding/EventSerializer.js';

const directory=mkdtempSync(join(tmpdir(),'jani-semantics-'));
before(()=>db.init(join(directory,'test.db')));
after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
const aSize=map=>map?.size ?? 0;
const context=id=>({sessionId:id,dataDir:join(directory,id),emit(){}});
async function record(id,source) {
    init({...ALL_CONFIG});
    const instrumented=instrumentCode({code:source,origCodeFileName:`${id}.js`,inlineSource:true});
    const sb=new JalangiSandbox(), backend=new MemoryBackend();
    const logger=new TraceLogger({nodeFile:false,nodeConsole:false,keyToConsole:false,logManagerOptions:{backends:[backend]}});
    await logger.init();const analysis=new ExecutionTraceAnalysis(sb,'',{logger});sb.analysis=analysis;
    const out={};runInSandbox(instrumented.code,sb,{$out:out,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask});if(out.done)await out.done;
    const retained={async:aSize(analysis._asyncStates),frames:aSize(analysis._traceFrames),callbacks:aSize(analysis._callbackStates),
        activeCallId:analysis._state.callId,weakRegistrations:analysis._scheduledCallbacks instanceof WeakMap,stack:analysis._callStack.length};
    await analysis.close();
    const events=backend.getEvents().filter(e=>e.seq>0);
    const path=join(directory,`${id}.bin`),smap=join(directory,`${id}.smap.json`);
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch(events))]));
    writeFileSync(smap,JSON.stringify(buildSmapJson(instrumented.sourceMapObject)));
    db.run('INSERT INTO sessions(id,bin_path,smap_path) VALUES (?,?,?)',id,path,smap);
    await new F1().run(context(id));await new F2().run(context(id));
    return {events,out,retained,index:new DependencyIndex(db.raw(),id)};
}
function fixture(id) {
    db.run('INSERT INTO sessions(id) VALUES (?)',id);
    const write=(event,name,binding='a')=>db.run('INSERT INTO writes(session_id,event_id,name,binding_id) VALUES (?,?,?,?)',id,event,name,binding);
    const read=(event,name,binding='a')=>db.run('INSERT INTO reads(session_id,event_id,name,binding_id) VALUES (?,?,?,?)',id,event,name,binding);
    return {write,read,index:new DependencyIndex(db.raw(),id)};
}

test('slice depth limits report actual remaining work; breadth is not counted as hops',()=>{
    const {write,read,index}=fixture('depth');
    write(1,'x');read(2,'x');write(2,'y');read(3,'y');write(3,'z');read(4,'z');
    const limited=sliceDependencies(index,[1],{direction:'forward',maxHops:1});
    assert.deepEqual(limited.nodes.map(n=>n.eventId),[1,2]);assert.equal(limited.truncated,true);
    const full=sliceDependencies(index,[1],{direction:'forward',maxHops:3});
    assert.deepEqual(full.nodes.map(n=>n.eventId),[1,2,3,4]);assert.equal(full.truncated,false);
});

test('backward search continues past leaf nodes and preserves lexical bindings',()=>{
    const {write,read,index}=fixture('branches');
    write(1,'x','outer');write(2,'x','inner');write(3,'y');read(4,'x','outer');read(4,'y');
    write(4,'z');read(5,'z');
    const result=sliceDependencies(index,[5]);
    assert.deepEqual(new Set(result.nodes.map(n=>n.eventId)),new Set([5,4,3,1]));
});

test('calls bind by parameter index and consume returns in the actual caller expression',async()=>{
    const {events,index}=await record('calls',`var globalValue=7; function f(a,b){return globalValue+b+a;} var sign=f(1,2); var unrelated=99;`);
    const params=events.filter(e=>e.analysis?.kind==='parameter');
    assert.deepEqual(params.map(e=>[e.writes[0].name,e.analysis.argumentIndex]),[['a',0],['b',1]]);
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign'&&w.val===10));
    const unrelated=events.find(e=>e.writes?.some(w=>w.name==='unrelated'&&w.val===99));
    assert.ok(index.incoming(sink.seq).some(e=>e.edge_type==='call_ret'));
    assert.equal(index.incoming(unrelated.seq).some(e=>e.edge_type==='call_ret'),false);
    const slice=sliceDependencies(index,[sink.seq],{maxHops:20});
    assert.ok(params.every(p=>slice.nodes.some(n=>n.eventId===p.seq)));
    await new A2().run(context('calls'));
    withGraph('calls',g=>assert.ok(g.list({edgeType:'call_arg'}).edges.every(e=>e.evidence==='observed')));
});

test('signature queries isolate sessions and use the same backward dependencies',async()=>{
    const {events,index}=await record('signature',`var x=3; function f(){var x=20; return x;} var sign=f();`);
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign'&&w.val===20));
    // Every event ID also occurs in calls, with different source positions.
    await new I2().run(context('signature'));
    const row=db.get('SELECT * FROM signature_paths WHERE session_id=? AND sink_event_id=?','signature',sink.seq);
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.path_json),sliceDependencies(index,[sink.seq],{maxHops:8}).nodes.map(n=>n.eventId));
    assert.equal(JSON.parse(row.analysis_json).precision,'statement-level');
    assert.equal(db.get('SELECT COUNT(*) n FROM signature_paths WHERE session_id=? AND sink_event_id=?','signature',sink.seq).n,1);
});

test('object identity joins aliases and stops at property overwrite',async()=>{
    const {events,index}=await record('objects',`var obj={};var alias=obj;obj.x=1;var first=alias.x;obj.x=2;var second=alias.x;`);
    const first=events.find(e=>e.writes?.some(w=>w.name==='first'&&w.val===1));
    const second=events.find(e=>e.writes?.some(w=>w.name==='second'&&w.val===2));
    const one=events.find(e=>e.fields?.some(f=>f.isWrite&&f.val===1));
    const two=events.find(e=>e.fields?.some(f=>f.isWrite&&f.val===2));
    assert.ok(index.incoming(first.seq).some(e=>e.edge_type==='field_read'&&e.from_event_id===one.seq));
    assert.ok(index.incoming(second.seq).some(e=>e.edge_type==='field_read'&&e.from_event_id===two.seq));
    assert.equal(index.outgoing(one.seq).some(e=>e.to_event_id===second.seq&&e.edge_type==='field_read'),false);
});

test('control dependence stays inside the executed branch and its invocation',async()=>{
    const {events,index}=await record('control',`var x=1;var y; if(x){y=2;}else{y=3;} var after=4;`);
    const branch=events.find(e=>e.analysis?.kind==='branch');
    const inside=events.find(e=>e.writes?.some(w=>w.name==='y'&&w.val===2));
    const after=events.find(e=>e.writes?.some(w=>w.name==='after'&&w.val===4));
    assert.ok(branch.analysis.controlRanges.length);
    assert.ok(index.incoming(inside.seq).some(e=>e.edge_type==='control'&&e.from_event_id===branch.seq));
    assert.equal(index.incoming(after.seq).some(e=>e.edge_type==='control'),false);
});

test('concurrent await pairs keep their own statement buffers and suspend origins',async()=>{
    const {events,index,out}=await record('async',`async function f(x){await Promise.resolve();x=x+1;return x;} $out.done=Promise.all([f(1),f(10)]);`);
    assert.deepEqual(Array.from(await out.done),[2,11]);
    const resumes=events.filter(e=>e.analysis?.kind==='await_resume');
    assert.equal(resumes.length,2);
    for(const resume of resumes) {
        const edge=index.incoming(resume.seq).find(e=>e.edge_type==='await_resume');
        const suspend=events.find(e=>e.seq===edge.from_event_id);
        assert.equal(suspend.analysis.kind,'await_suspend');
        assert.equal(suspend.callId,resume.callId);
    }
});

test('legacy traces do not invent call edges from read order',async()=>{
    fixture('legacy-calls');
    db.run('INSERT INTO call_edges(session_id,call_seq,return_seq,args_json) VALUES (?,?,?,?)','legacy-calls',1,4,'[1]');
    db.run('INSERT INTO reads(session_id,event_id,name) VALUES (?,?,?)','legacy-calls',2,'globalValue');
    await new A2().run(context('legacy-calls'));
    withGraph('legacy-calls',g=>assert.equal(g.list().edges.some(e=>/^call_/.test(e.edge_type)),false));
    assert.equal(analysisQuality(db.raw(),'legacy-calls').observedMetadata,false);
});

test('taint persists truncation metadata for callers',async()=>{
    const {write,read}=fixture('taint-quality');
    for(let i=1;i<=15;i++){write(i,`x${i}`);if(i>1)read(i,`x${i-1}`);}
    await new A1().run({...context('taint-quality'),sourceEventId:1,direction:'forward'});
    const row=db.get('SELECT analysis_json FROM taint_paths WHERE session_id=? LIMIT 1','taint-quality');
    assert.equal(JSON.parse(row.analysis_json).truncated,true);
});


test('default and destructured parameters retain the source parameter index',async()=>{
    const {events}=await record('parameters',`function f({x,y},z=5){return x+y+z;}var sign=f({x:1,y:2});`);
    const params=events.filter(e=>e.analysis?.kind==='parameter');
    assert.deepEqual(params.map(e=>[e.writes[0].name,e.analysis.argumentIndex]),[['x',0],['y',0],['z',1]]);
});

test('successful delete invalidates the previous property definition',async()=>{
    const {events,index}=await record('deletion',`var obj={};obj.x=1;delete obj.x;var sign=obj.x;`);
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign')&&e.fields?.some(f=>!f.isWrite));
    assert.ok(db.get("SELECT event_id FROM fields WHERE session_id='deletion' AND is_write=2"));
    assert.equal(index.incoming(sink.seq).some(e=>e.edge_type==='field_read'),false);
});

test('timer and Promise callbacks link to their own registrations',async()=>{
    const {events,index,out}=await record('scheduling',`$out.done=new Promise(function(resolve){setTimeout(function(){resolve(7);},0);}).then(function(x){return x+1;});`);
    assert.equal(await out.done,8);
    const entries=events.filter(e=>e.analysis?.kind==='callback_enter');
    assert.equal(entries.length,2);
    for(const entry of entries) {
        const edge=index.incoming(entry.seq).find(e=>e.edge_type==='async_schedule');
        assert.equal(events.find(e=>e.seq===edge.from_event_id).analysis.kind,'async_schedule');
    }
    assert.notEqual(entries[0].contextId,entries[1].contextId);
});

test('native exceptions unwind call metadata before a later successful call',async()=>{
    const {events,out}=await record('exceptions',`try{JSON.parse('{');}catch(e){} function f(x){return x+1;} $out.result=f(2);`);
    assert.equal(out.result,3);
    const result=events.find(e=>e.type==='CALL'&&e.fn==='f');
    assert.ok(result);
    assert.ok(events.some(e=>e.analysis?.kind==='exception_exit'));
    assert.ok(result.analysis.dependencies.some(d=>d.type==='return_value'));
});

test('short circuit and conditional results preserve values and condition dependence',async()=>{
    const {events,index,out}=await record('expressions',`var x=0;var a=x??9;var b=x||5;var c=x?1:2;$out.values=[a,b,c];`);
    assert.deepEqual(Array.from(out.values),[0,5,2]);
    for(const name of ['a','b','c']) {
        const event=events.find(e=>e.writes?.some(w=>w.name===name&&w.val!==undefined));
        assert.ok(index.incoming(event.seq).some(e=>e.edge_type==='control'));
    }
});

test('estimated iteration windows partition all hits and exclude child invocations',async()=>{
    const {write}=fixture('iterations');
    for(let id=1;id<=7;id++)db.run('INSERT INTO events(session_id,id,type,iid,call_id) VALUES (?,?,7,?,?)','iterations',id,[1,4,7].includes(id)?8:16,id===3?2:1);
    write(2,'i');write(3,'child');write(5,'i');
    db.run('INSERT INTO loops(session_id,iid,start_seq,end_seq,iteration_count) VALUES (?,8,1,7,3)','iterations');
    await new A5().run(context('iterations'));
    const rows=db.all('SELECT * FROM loop_iterations WHERE session_id=? ORDER BY iteration_idx','iterations');
    assert.deepEqual(rows.map(r=>[r.start_seq,r.end_seq]),[[1,3],[4,6],[7,7]]);
    assert.ok(rows.every(r=>!Object.hasOwn(JSON.parse(r.vars_snapshot).w,'child')));
});

test('loop candidates do not combine interleaved async invocation IDs',async()=>{
    await record('async-loops',`async function f(){await Promise.resolve();for(var i=0;i<2;i++){var x=i+1;}return x;}$out.done=Promise.all([f(),f()]);`);
    await new F3().run(context('async-loops'));await new A3().run(context('async-loops'));
    const loops=db.all('SELECT * FROM loops WHERE session_id=?','async-loops');
    assert.ok(loops.length>0);
    for(const loop of loops) {
        const ids=db.all('SELECT DISTINCT call_id FROM events WHERE session_id=? AND iid=? AND id BETWEEN ? AND ?','async-loops',loop.iid,loop.start_seq,loop.end_seq);
        assert.equal(ids.length,1);
        assert.ok(loop.iteration_count<=3);
    }
});

test('awaiting a then result includes the executed callback return',async()=>{
    const {events,index,out}=await record('callback-value',`async function g(){return await Promise.resolve(1).then(function(x){var changed=x+2;return changed;});}$out.done=g();`);
    assert.equal(await out.done,3);
    const resume=events.find(e=>e.analysis?.kind==='await_resume');
    const returned=events.find(e=>e.analysis?.kind==='return'&&e.reads?.some(r=>r.name==='changed'));
    assert.ok(returned);
    assert.ok(index.incoming(resume.seq).some(e=>e.edge_type==='return_value'&&e.from_event_id===returned.seq));
});

test('ordinary variables named arg0 and callee are not synthetic call payloads',()=>{
    const {write,read,index}=fixture('names');
    write(1,'arg0');read(2,'arg0');write(2,'callee');read(3,'callee');
    assert.deepEqual(sliceDependencies(index,[3]).nodes.map(n=>n.eventId),[3,2,1]);
});

test('analysis metadata bypasses inherited toJSON hooks',async()=>{
    const arrayDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,'toJSON');
    const objectDescriptor=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
    let encoded;
    try {
        Object.defineProperty(Array.prototype,'toJSON',{configurable:true,value(){throw new Error('unexpected array toJSON');}});
        Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){throw new Error('unexpected object toJSON');}});
        encoded=serializeBatch([{type:'END_EXPR',seq:1,analysis:{schema:1,kind:'branch',dependencies:[],controlRanges:[[1,1,1,9]]}}]);
    } finally {
        if(arrayDescriptor)Object.defineProperty(Array.prototype,'toJSON',arrayDescriptor);else delete Array.prototype.toJSON;
        if(objectDescriptor)Object.defineProperty(Object.prototype,'toJSON',objectDescriptor);else delete Object.prototype.toJSON;
    }
    assert.ok(encoded.byteLength>0);
});

test('completed async invocations release frames, suspensions and callback registrations',async()=>{
    const {out,retained}=await record('async-release',`
        async function f(x){await Promise.resolve();await Promise.resolve();return x;}
        var jobs=[];for(var i=0;i<100;i++)jobs.push(f(i).then(x=>x+1));
        $out.done=Promise.all(jobs);
    `);
    assert.equal((await out.done).length,100);
    assert.deepEqual(retained,{async:0,frames:0,callbacks:0,activeCallId:0,weakRegistrations:true,stack:0});
});

test('expression arrows record a return source and preserve lexical this and arguments',async()=>{
    const {out,events,index}=await record('arrow-returns',`
        let input=7;var f=x=>x+1;var sign=f(input);
        var obj={n:3,method:function(x){return (()=>this.n+arguments[0])();}};
        $out.result=[sign,obj.method(4)];
    `);
    assert.deepEqual(Array.from(out.result),[8,7]);
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign'&&w.val===8));
    const nodes=sliceDependencies(index,[sink.seq],{maxHops:20}).nodes;
    assert.ok(nodes.some(n=>events.find(e=>e.seq===n.eventId)?.analysis?.kind==='return'));
    assert.ok(events.some(e=>e.type==='CALL'&&e.analysis.kind==='call_result'));
});

test('separate arguments do not taint an unused parameter or the returned parameter',async()=>{
    const {events,index}=await record('argument-isolation',`
        let first=11;let second=22;function f(a,b){return a;}let sign=f(first,second);
    `);
    const first=events.find(e=>e.writes?.some(w=>w.name==='first'&&w.val===11));
    const second=events.find(e=>e.writes?.some(w=>w.name==='second'&&w.val===22));
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign'&&w.val===11));
    const ids=sliceDependencies(index,[sink.seq],{maxHops:20}).nodes.map(n=>n.eventId);
    assert.ok(ids.includes(first.seq));assert.equal(ids.includes(second.seq),false);
    const b=events.find(e=>e.analysis.kind==='parameter'&&e.writes[0].name==='b');
    const bIds=sliceDependencies(index,[b.seq],{maxHops:20}).nodes.map(n=>n.eventId);
    assert.ok(bIds.includes(second.seq));assert.equal(bIds.includes(first.seq),false);
});

test('nested, spread and rest arguments keep actual positions and evaluation order',async()=>{
    const {events,out,index}=await record('spread-arguments',`
        var order=[];function value(x){order.push(x);return x;}
        function f(a,...rest){return rest[1];}
        let sign=f(value(1),...[value(2),value(3)],value(4));
        $out.values=[sign,order.join(',')];
    `);
    assert.deepEqual(Array.from(out.values),[3,'1,2,3,4']);
    const rest=events.find(e=>e.analysis.kind==='parameter'&&e.writes[0].name==='rest');
    const incoming=index.incoming(rest.seq).filter(e=>e.edge_type==='call_arg');
    assert.deepEqual(incoming.map(e=>e.from_var),['arg1','arg2','arg3']);
    assert.equal(new Set(incoming.map(e=>e.from_event_id)).size,3);
});

test('argument errors unwind in catch and finally without contaminating later calls',async()=>{
    const {out,retained,events}=await record('argument-abrupt',`
        function f(x){return x+1;}function fail(){throw new Error('expected');}
        try{f(fail());}catch(e){$out.caught=e.message;}finally{$out.finallyRan=true;}
        $out.result=f(2);
    `);
    assert.equal(out.caught,'expected');assert.equal(out.finallyRan,true);assert.equal(out.result,3);
    assert.equal(retained.stack,0);
    assert.ok(events.some(e=>e.analysis.kind==='argument_aborted'));
});

test('rejected await and finally overriding return release async state',async()=>{
    const {out,retained}=await record('async-finally',`
        async function f(){try{await Promise.reject(1);}catch(e){return e;}finally{await Promise.resolve();return 2;}}
        $out.done=f();
    `);
    assert.equal(await out.done,2);assert.equal(retained.async,0);assert.equal(retained.frames,0);
});

test('missing and default arguments do not borrow another argument source',async()=>{
    const {events,index}=await record('default-argument',`
        let first=11;let fallback=22;function f(a,b=fallback){return b;}let sign=f(first);
    `);
    const first=events.find(e=>e.writes?.some(w=>w.name==='first'&&w.val===11));
    const fallback=events.find(e=>e.writes?.some(w=>w.name==='fallback'&&w.val===22));
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign'&&w.val===22));
    const ids=sliceDependencies(index,[sink.seq],{maxHops:30}).nodes.map(n=>n.eventId);
    assert.ok(ids.includes(fallback.seq));assert.equal(ids.includes(first.seq),false);
});

test('Promise passthrough and finally retain the original result source',async()=>{
    const {events,index,out}=await record('promise-passthrough',`
        async function source(){let original=41;return original;}
        async function run(){return await source().then().catch(()=>99).finally(()=>123);}
        $out.done=run();
    `);
    assert.equal(await out.done,41);
    const resume=events.find(e=>e.analysis.kind==='await_resume');
    const original=events.find(e=>e.writes?.some(w=>w.name==='original'&&w.val===41));
    const ids=sliceDependencies(index,[resume.seq],{maxHops:30}).nodes.map(n=>n.eventId);
    assert.ok(ids.includes(original.seq));
    const ignored=events.find(e=>e.analysis.kind==='return'&&e.writes?.some(w=>w.val===123));
    assert.equal(ids.includes(ignored.seq),false);
});

test('Promise callback returns can assimilate a later async return',async()=>{
    const {events,index,out,retained}=await record('promise-assimilation',`
        async function inner(){await Promise.resolve();let answer=17;return answer;}
        async function run(){return await Promise.resolve().then(()=>inner());}
        $out.done=run();
    `);
    assert.equal(await out.done,17);assert.equal(retained.frames,0);
    const resume=events.filter(e=>e.analysis.kind==='await_resume').at(-1);
    const source=events.find(e=>e.writes?.some(w=>w.name==='answer'&&w.val===17));
    assert.ok(sliceDependencies(index,[resume.seq],{maxHops:40}).nodes.some(n=>n.eventId===source.seq));
});

test('await rejection links to the executed throw rather than a prior return',async()=>{
    const {events,index,out}=await record('promise-rejection',`
        async function fail(){let reason=13;throw reason;}
        async function run(){try{await fail();}catch(e){return e;}}
        $out.done=run();
    `);
    assert.equal(await out.done,13);
    const reject=events.find(e=>e.analysis.kind==='await_reject');
    const reason=events.find(e=>e.writes?.some(w=>w.name==='reason'&&w.val===13));
    assert.ok(reject);
    assert.ok(sliceDependencies(index,[reject.seq],{maxHops:30}).nodes.some(n=>n.eventId===reason.seq));
});

test('observed native property changes invalidate an older property source',async()=>{
    const {events,index,out}=await record('external-property',`
        let obj={};obj.x=1;Object.assign(obj,{x:2});let first=obj.x;
        Object.assign(obj,{x:1});let second=obj.x;$out.values=[first,second];
    `);
    assert.deepEqual(Array.from(out.values),[2,1]);
    const source=events.find(e=>e.fields?.some(f=>f.isWrite&&f.offset==='x'&&f.val===1));
    for(const name of ['first','second']) {
        const sink=events.find(e=>e.writes?.some(w=>w.name===name));
        assert.equal(index.incoming(sink.seq).some(e=>e.edge_type==='field_read'&&e.from_event_id===source.seq),false);
    }
    assert.equal(index.outgoing(source.seq).some(e=>e.edge_type==='field_read'),false);
});

test('a caught local throw supplies the catch parameter value',async()=>{
    const {events,index,out}=await record('local-exception',`
        let source=19;try{throw source;}catch(e){$out.result=e;}
    `);
    assert.equal(out.result,19);
    const source=events.find(e=>e.writes?.some(w=>w.name==='source'&&w.val===19));
    const sink=events.find(e=>e.fields?.some(f=>f.isWrite&&f.offset==='result'));
    assert.ok(sliceDependencies(index,[sink.seq],{maxHops:30}).nodes.some(n=>n.eventId===source.seq));
});

test('defaults reading earlier parameters use their supplied argument sources',async()=>{
    const {events,index,out}=await record('parameter-default-chain',`
        let input=7;function f(a,b=a+1){return b;}let sign=f(input);$out.result=sign;
    `);
    assert.equal(out.result,8);
    const source=events.find(e=>e.writes?.some(w=>w.name==='input'&&w.val===7));
    const sink=events.find(e=>e.writes?.some(w=>w.name==='sign'&&w.val===8));
    assert.ok(sliceDependencies(index,[sink.seq],{maxHops:30}).nodes.some(n=>n.eventId===source.seq));
});


test('async completion does not reactivate an already returned synchronous caller',async()=>{
    const {out,retained}=await record('async-retired-caller',`
        async function f(){await Promise.resolve();return 1;}
        function factory(){return f();}
        $out.done=factory().then(()=>2);
    `);
    assert.equal(await out.done,2);
    assert.equal(retained.activeCallId,0);assert.equal(retained.frames,0);
});


test('recurring timers share a weak registration and release each callback frame',async()=>{
    const {out,events,retained}=await record('interval-release',`
        $out.done=new Promise(resolve=>{
            var count=0;var timer=setInterval(()=>{count++;if(count===3){clearInterval(timer);resolve(count);}},1);
        });
    `);
    assert.equal(await out.done,3);assert.equal(retained.callbacks,0);assert.equal(retained.frames,0);
    const entries=events.filter(e=>e.analysis.kind==='callback_enter');
    assert.equal(entries.length,3);
    const origins=entries.map(e=>e.analysis.dependencies.find(d=>d.type==='async_schedule').eventId);
    assert.equal(new Set(origins).size,1);
});

test('repeated property reads scan each definition interval only once',()=>{
    fixture('hot-property');
    const insert=db.raw().prepare('INSERT INTO fields(session_id,event_id,base_oid,offset,is_write,value_id) VALUES (?,?,1,?, ?,1)');
    db.raw().transaction(()=>{
        insert.run('hot-property',1,'x',1);
        for(let i=2;i<=10001;i++)insert.run('hot-property',i,'x',0);
    })();
    const index=new DependencyIndex(db.raw(),'hot-property');
    for(let i=2;i<=10001;i++)assert.equal(index.incoming(i)[0].from_event_id,1);
    assert.equal(index.barrierScans,1);
});


test('native result-only observations survive binary import and dependency indexing', async()=>{
    const result=await record('native-observation-import', `
        var o={value:3, f(){return this.value}};
        with(o){$out.value=f();}
    `);
    assert.equal(result.out.value,3);
    const observations=db.all("SELECT event_id,metadata FROM event_analysis WHERE session_id=? AND kind='native_operation'",'native-observation-import');
    assert.ok(observations.length>0);
    assert.equal(JSON.parse(observations[0].metadata).coverage,'result_only');
    const dependencies=db.all("SELECT * FROM event_dependencies WHERE session_id=? AND edge_type='native_result'",'native-observation-import');
    assert.ok(dependencies.length>0);
});
