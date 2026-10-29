import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as db from '../db/Database.mjs';
import { registerPlugin, schedule, markStale } from '../PluginEngine.mjs';
import F1 from '../plugins/F1_EventIndex.mjs';
import A1 from '../plugins/A1_TaintTracker.mjs';
import { serializeBatch, createFileHeader } from '../../src/encoding/EventSerializer.js';
import { validateFilename, allowedOrigin, executionEnv } from '../ExecutionPolicy.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jani-backend-test-'));
before(async () => { await db.init(join(dir, 'test.db')); });
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function session(id, file = null) {
    db.run('INSERT INTO sessions(id,bin_path) VALUES (?,?)', id, file);
}
const noop = () => {};

test('failure blocks dependents, rejects schedule and rolls back partial output', async () => {
    session('failure');
    registerPlugin(class {
        static id = 'test-fail'; static deps = [];
        async run() { db.run("INSERT INTO events(id,session_id,type,iid) VALUES (1,'failure',7,1)"); throw new Error('expected'); }
    });
    registerPlugin(class {
        static id = 'test-child'; static deps = ['test-fail'];
        async run() { throw new Error('must not run'); }
    });
    await assert.rejects(schedule('failure', { worker: false, plugins: ['test-fail','test-child'] }), /Analysis failed/);
    const row = db.get("SELECT * FROM sessions WHERE id='failure'");
    assert.equal(row.status, 'failed');
    assert.equal(JSON.parse(row.plugin_status)['test-child'], 'blocked');
    assert.equal(db.get("SELECT count(*) n FROM events WHERE session_id='failure'").n, 0);
});

test('stale and changed inputs rerun checkpoints', async () => {
    session('stale'); let count = 0;
    registerPlugin(class { static id = 'test-ok'; static deps = []; async run() { count++; } });
    const opts = { worker: false, plugins: ['test-ok'] };
    await schedule('stale', opts); await schedule('stale', opts); assert.equal(count, 1);
    markStale('stale', ['test-ok']); await schedule('stale', opts); assert.equal(count, 2);
    const path = join(dir, 'input'); writeFileSync(path, 'one');
    db.run("UPDATE sessions SET source_file=? WHERE id='stale'", path);
    await schedule('stale', opts); assert.equal(count, 3);
    writeFileSync(path, 'two'); await schedule('stale', opts); assert.equal(count, 4);
});

test('events with identical sequence numbers survive in separate sessions', async () => {
    const path = join(dir, 'trace.bin');
    writeFileSync(path, Buffer.concat([Buffer.from(createFileHeader()), Buffer.from(serializeBatch([
        { type: 'END_EXPR', iid: 8, seq: 1, callId: 12, writes: [{ name: 'x', val: 1, scopeId: 2, bindingId: '1:2:12' }] },
    ]))]));
    for (const id of ['one','two']) {
        session(id,path); await new F1().run({ sessionId:id, emit:noop });
        assert.equal(db.get('SELECT COUNT(*) n FROM events WHERE session_id=?',id).n,1);
        assert.equal(db.get('SELECT binding_id FROM writes WHERE session_id=?',id).binding_id,'1:2:12');
    }
});

test('truncated payload fails instead of completing', async () => {
    const path = join(dir,'bad.bin');
    writeFileSync(path, Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([{ type:'CALL',seq:1,fn:'f',result:3 }])).subarray(0,15)]));
    session('bad',path);
    await assert.rejects(new F1().run({ sessionId:'bad',emit:noop }), /Invalid trace/);
    assert.equal(db.raw().pragma('foreign_keys',{simple:true}),1);
});

test('taint stops at overwrite and does not cross dynamic bindings', async () => {
    session('taint');
    const write = (id, binding) => db.run('INSERT INTO writes(event_id,session_id,name,scope_id,binding_id) VALUES (?, ?, ?, ?, ?)',id,'taint','x',2,binding);
    const read = (id, binding) => db.run('INSERT INTO reads(event_id,session_id,name,scope_id,binding_id) VALUES (?, ?, ?, ?, ?)',id,'taint','x',2,binding);
    write(1,'a'); read(2,'a'); write(3,'a'); read(4,'a'); read(5,'b');
    await new A1().run({sessionId:'taint',sourceEventId:1,direction:'forward',emit:noop});
    const rows=db.all("SELECT sink_event_id FROM taint_paths WHERE session_id='taint'");
    assert.deepEqual(rows.map(r=>r.sink_event_id),[2]);
});

test('execution policy rejects traversal and foreign origins, strips secrets', () => {
    for (const value of ['../x.js','/tmp/x.js','a\\b.js','..']) assert.throws(()=>validateFilename(value));
    assert.equal(validateFilename('script.js'),'script.js');
    assert.equal(allowedOrigin('https://evil.test',33000),false);
    assert.equal(allowedOrigin('http://localhost:33000',33000),true);
    assert.equal(allowedOrigin(undefined,33000),true);
    process.env.JANI_TEST_SECRET='secret'; assert.equal(executionEnv().JANI_TEST_SECRET,undefined); delete process.env.JANI_TEST_SECRET;
});

test('real worker indexes a trace and returns progress', async () => {
    const path=join(dir,'worker.bin');
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([{type:'SCRIPT_ENTER',seq:1,file:'test.js'}]))]));
    session('worker',path); const progress=[];
    await schedule('worker',{plugins:['F1-EventIndex'],onProgress:e=>progress.push(e)});
    assert.equal(db.get("SELECT event_count FROM sessions WHERE id='worker'").event_count,1);
    assert.ok(progress.some(e=>e.type==='all_done'));
});

test('gzip import and explicit end marker preserve completeness', async () => {
    const { gzipSync } = await import('zlib');
    const path=join(dir,'complete.bin.gz');
    writeFileSync(path,gzipSync(Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([
        {type:'SCRIPT_ENTER',seq:1,file:'x.js'}, {type:'TRACE_END',seq:2},
    ]))])));
    session('gzip',path);
    await new F1().run({sessionId:'gzip',emit:noop});
    assert.equal(db.get("SELECT trace_integrity FROM sessions WHERE id='gzip'").trace_integrity,'complete');
});

test('call graph matches explicit invocation IDs across interleaving', async () => {
    const {default:F3}=await import('../plugins/F3_CallGraphBuilder.mjs');
    const path=join(dir,'interleaved.bin');
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([
        {type:'CALL_PRE',seq:1,fn:'a',callPairId:1,contextId:10},
        {type:'CALL_PRE',seq:2,fn:'b',callPairId:2,contextId:20},
        {type:'CALL',seq:3,fn:'a',result:1,callPairId:1,contextId:20},
        {type:'CALL',seq:4,fn:'b',result:2,callPairId:2,contextId:10},
    ]))]));
    session('interleaved',path);
    await new F1().run({sessionId:'interleaved',emit:noop});
    await new F3().run({sessionId:'interleaved',emit:noop});
    assert.deepEqual(db.all("SELECT call_seq,return_seq FROM call_edges WHERE session_id='interleaved' ORDER BY call_seq"),[
        {call_seq:1,return_seq:3},{call_seq:2,return_seq:4},
    ]);
});

test('cancelled worker rejects before publishing results', async () => {
    session('cancel'); const controller=new AbortController(); controller.abort();
    await assert.rejects(schedule('cancel',{plugins:['F1-EventIndex'],signal:controller.signal}),/cancelled/);
});

test('variable lifetime aggregates bindings separately, including read-only bindings', async () => {
    const { default: F4 } = await import('../plugins/F4_VariableLifetime.mjs');
    session('lifetime');
    for (const binding of ['a','b']) {
        db.run('INSERT INTO writes(session_id,event_id,name,scope_id,binding_id) VALUES (?,?,?,?,?)','lifetime',1,'x',1,binding);
        db.run('INSERT INTO reads(session_id,event_id,name,scope_id,binding_id) VALUES (?,?,?,?,?)','lifetime',2,'x',1,binding);
    }
    db.run("INSERT INTO reads(session_id,event_id,name) VALUES ('lifetime',3,'external')");
    await new F4().run({sessionId:'lifetime',emit:noop});
    const rows=db.all("SELECT name,binding_id,write_count,read_count FROM var_lifetime WHERE session_id='lifetime' ORDER BY name,binding_id");
    assert.deepEqual(rows,[{name:'external',binding_id:null,write_count:0,read_count:1},
        {name:'x',binding_id:'a',write_count:1,read_count:1},{name:'x',binding_id:'b',write_count:1,read_count:1}]);
});

test('MCP taint client uses the POST contract', async () => {
    const { JtaClient }=await import('../mcp/client.mjs');
    const client=new JtaClient(); let request;
    client._request=async (...args)=>{request=args;return {paths:[]};};
    await client.traceTaint('s','x','backward',42,3);
    assert.deepEqual(request,['POST','/api/sessions/s/taint',
        {sourceVar:'x',sourceEventId:42,sourceScopeId:3,direction:'backward'},{}]);
});

test('old event primary key is migrated without losing rows', async () => {
    const { default: Database } = await import('better-sqlite3');
    const { readFileSync } = await import('fs');
    const path=join(dir,'legacy.db'); const legacy=new Database(path);
    const schema=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8')
        .replace('CREATE TABLE IF NOT EXISTS events (\n    id          INTEGER NOT NULL,',
            'CREATE TABLE IF NOT EXISTS events (\n    id          INTEGER PRIMARY KEY,')
        .replace('    PRIMARY KEY (session_id, id),\n','');
    legacy.exec(schema);
    legacy.exec("INSERT INTO sessions(id) VALUES ('old'); INSERT INTO events(id,session_id,type) VALUES (1,'old',7)");
    legacy.close(); db.close();
    try {
        await db.init(path);
        assert.equal(db.get("SELECT COUNT(*) n FROM events WHERE session_id='old'").n,1);
        db.run("INSERT INTO sessions(id) VALUES ('new')");
        db.run("INSERT INTO events(id,session_id,type) VALUES (1,'new',7)");
        assert.equal(db.get('SELECT COUNT(*) n FROM events').n,2);
        assert.equal(db.raw().pragma('foreign_key_check').length,0);
    } finally { db.close(); await db.init(join(dir,'test.db')); }
});

test('failed re-import preserves previously indexed data', async () => {
    const path=join(dir,'retry.bin');
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([{type:'END_EXPR',seq:1,writes:[{name:'old',val:7}]}]))]));
    session('retry',path);
    await schedule('retry',{plugins:['F1-EventIndex']});
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from([1,2,3])]));
    await assert.rejects(schedule('retry',{plugins:['F1-EventIndex'],skipCompleted:false}));
    assert.equal(db.get("SELECT name FROM writes WHERE session_id='retry'").name,'old');
    assert.equal(db.get("SELECT status FROM sessions WHERE id='retry'").status,'failed');
});

test('server runner executes in isolated work directory and creates an indexed session', async () => {
    const {startRun,getRunStatus}=await import('../InstrumentRunner.mjs');
    const runId=startRun({code:'var x=1; x=x+1;',filename:'runner-test.js',dataDir:join(dir,'runs')});
    const deadline=Date.now()+15000; let task;
    while(Date.now()<deadline) {
        task=getRunStatus(runId);
        if(['done','failed','timeout'].includes(task.status)) break;
        await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(task.status,'done',task.stderr || task.error_msg);
    assert.ok(task.session_id);
    while(Date.now()<deadline) {
        const status=db.get('SELECT status FROM sessions WHERE id=?',task.session_id)?.status;
        if(status==='ready') break;
        if(status==='failed') assert.fail('run session analysis failed');
        await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(db.get('SELECT status FROM sessions WHERE id=?',task.session_id).status,'ready');
});

test('missing trace prefix cannot be labelled complete', async () => {
    const path=join(dir,'missing-prefix.bin');
    writeFileSync(path,Buffer.concat([Buffer.from(createFileHeader()),Buffer.from(serializeBatch([{type:'TRACE_END',seq:5}]))]));
    session('missing-prefix',path);await new F1().run({sessionId:'missing-prefix',emit:noop});
    assert.equal(db.get("SELECT trace_integrity FROM sessions WHERE id='missing-prefix'").trace_integrity,'gaps');
});
