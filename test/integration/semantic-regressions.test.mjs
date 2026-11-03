import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init } from '../../src/instrument/esnstrument.js';
import { buildConfigFromHooks } from '../../src/instrument/pluginAnalyzer.js';
import { JalangiSandbox } from '../../src/runtime/JalangiSandbox.js';
import { ExecutionTraceAnalysis } from '../../src/plugins/ExecutionTrace.js';
import { TraceLogger } from '../../src/logger/TraceLogger.js';
import { MemoryBackend } from '../../src/logger/transport/MemoryBackend.js';
import { serializeEvent, deserializeEvent, snapshotEvent } from '../../src/encoding/EventSerializer.js';
import { ALL_CONFIG, instr, runInSandbox } from '../helpers/shared-helpers.mjs';

async function outcome(source, config) {
    const out = {};
    let error;
    try {
        if (config) {
            init(config);
            runInSandbox(instr(source).code, new JalangiSandbox(), { $out: out });
        } else vm.runInNewContext(source, { $out: out, Promise }, { timeout: 2000 });
        await out.done;
    } catch (caught) { error = caught.name; }
    delete out.done;
    return { out: structuredClone(out), error };
}

const scenarios = {
    logicalConstants: `const a=1,b=0,c='x'; a ||= missing(); b &&= missing(); c ??= missing(); $out.x=[a,b,c];`,
    logicalProperties: `var get=0,set=0,key=0,rhs=0,value=1;
        var o={get x(){get++;return value},set x(v){set++;value=v}};
        function k(){key++;return 'x'} function r(){rhs++;return 2}
        o[k()] ||= r(); o[k()] &&= r(); o[k()] ??= r(); $out.x=[get,set,key,rhs,value];`,
    readonlySkipped: `var o=Object.freeze({x:1}); o.x ||= missing(); $out.x=o.x;`,
    strictReadonlyTaken: `'use strict';var o=Object.freeze({x:0}); o.x ||= 2;`,
    sloppyReadonlyTaken: `var o=Object.freeze({x:0});$out.x=(o.x ||= 2);$out.y=o.x;`,
    strictCompound: `'use strict';var o=Object.freeze({x:1}); o.x+=2;`,
    sloppyCompound: `var o=Object.freeze({x:1});$out.x=(o.x+=2);$out.y=o.x;`,
    setterException: `var o={set x(v){throw new TypeError('business error')}};o.x=1;`,
    proxySetFalse: `var calls=0;var o=new Proxy({x:1},{set(){calls++;return false}});o.x=2;$out.x=calls;`,
    proxyDeleteFalse: `var calls=0;var o=new Proxy({x:1},{deleteProperty(){calls++;return false}});$out.x=delete o.x;$out.calls=calls;`,
    strictProxySet: `'use strict';var o=new Proxy({},{set(){return false}});o.x=2;`,
    strictProxyDelete: `'use strict';var o=new Proxy({},{deleteProperty(){return false}});delete o.x;`,
    tagReceiverAndCache: `var first;var o={tag(t,v){if(!first)first=t;return [this===o,t===first,v]}};
        function f(v){return o.tag\`a\${v}\`} $out.x=[f(1),f(2)];`,
    withReferenceCalls: `var o={x:3,f(){return this.x}};with(o){$out.x=[f(),f?.(),f\`x\`]}` ,
    functionNames: `var f=function(){},a=()=>{},C=class{};var o={f:function(){},a:()=>{}};
        var key=Symbol('named');var q={[key]:()=>{}};
        function d(x=()=>{}){return x.name}var {z=()=>{}}={};
        $out.x=[f.name,a.name,C.name,o.f.name,o.a.name,q[key].name,d(),z.name];`,
    functionNameNoBinding: `var f=()=>typeof f;var g=function(){return typeof g};$out.x=[f(),g()];`,
    fieldNames: `var key='computed';class C{f=()=>{};#g=function(){};[key]=()=>{};m(){return this.#g.name}}
        var c=new C();$out.x=[c.f.name,c.m(),c.computed.name];`,
    proxyAsLiteralProperty: `var calls=0;var f=new Proxy(function(){return 2},{getOwnPropertyDescriptor(){calls++;throw Error('descriptor')}});
        var o={f};$out.x=o.f();$out.calls=calls;`,
    proxyPrototypeLiteral: `var calls=0,p=new Proxy({},{ownKeys(){calls++;throw Error('ownKeys')}});var o={__proto__:p,get x(){return 1}};$out.x=calls;`,
    reentrantLogical: `var o={get x(){return 0},set x(v){$out.v=v}};
        function f(n){return o.x ||= n ? f(n-1)+1 : 1}$out.x=f(2);`,
    logicalAwait: `var a={x:0},b={x:0};async function f(o,v){return o.x ||= await Promise.resolve(v)}
        $out.done=Promise.all([f(a,2),f(b,3)]).then(v=>{$out.x=[v,a.x,b.x]});`,
    logicalYield: `var o={x:0};function* f(){return o.x ||= yield 1}var i=f();$out.x=[i.next(),i.next(2),o.x];`,
};

for (const [mode, config] of Object.entries({
    full: { ...ALL_CONFIG },
    reads: buildConfigFromHooks(new Set(['readVar'])),
    writes: buildConfigFromHooks(new Set(['writeVar'])),
    disabled: buildConfigFromHooks(new Set()),
})) {
    for (const [name, source] of Object.entries(scenarios)) {
        test(`${mode}: ${name}`, async () => {
            // Compare observable results and exception types, excluding realm-specific prototypes.
            const expected = await outcome(source);
            const actual = await outcome(source, config);
            assert.deepEqual(actual, expected);
        });
    }
}

test('all 58 audit cases, including actual module evaluation and shared scripts', () => {
    const script = fileURLToPath(new URL('../../tools/audit-semantics.mjs', import.meta.url));
    const output = execFileSync(process.execPath, ['--experimental-vm-modules', script], { encoding: 'utf8', timeout: 15000 });
    assert.match(output, /58 equivalent; 0 differences/);
});

test('strict script function declarations remain visible to later scripts', () => {
    init({ ...ALL_CONFIG });
    const runtime = new JalangiSandbox();
    const context = vm.createContext({ J$: runtime, $out: {} });
    for (const source of ["'use strict';function shared(){return 3;}", '$out.x=shared();'])
        runtime.runScript(() => vm.runInContext(instr(source).code, context));
    assert.equal(context.$out.x, 3);
});

test('host boundary reports exactly one exceptional exit and rethrows the original object', () => {
    init({ ...ALL_CONFIG });
    const runtime = new JalangiSandbox();
    const error = new Error('original');
    const exits = [];
    runtime.analysis.use({ scriptExit(_iid, wrapped) { exits.push(wrapped); } });
    assert.throws(() => runInSandbox(instr('let x=1; throw error;').code, runtime, { error }), caught => caught === error);
    runInSandbox(instr('let y=2;').code, runtime);
    assert.equal(exits.length, 2);
    assert.equal(exits[0].exception, error);
    assert.equal(exits[1], undefined);
    assert.equal(runtime.sid, 0);
});

test('logical property hooks execute a read each time and a write only on the taken branch', () => {
    init({ ...ALL_CONFIG });
    const runtime = new JalangiSandbox();
    const reads = [], writes = [];
    runtime.analysis.use({getField(_iid, _base, key) { if(key==='x')reads.push(key); },
        putField(_iid, _base, key) { if(key==='x')writes.push(key); }});
    runInSandbox(instr('var o={x:1};o.x ||= 2;o.x &&= 3;o.x ??= 4;').code, runtime);
    assert.equal(reads.length, 3);
    assert.equal(writes.length, 1);
});

test('binary serialization neither reflects Proxy values nor invokes getters/toJSON', () => {
    let calls = 0;
    const fail = () => { calls++; throw new Error('unexpected observation'); };
    const proxy = new Proxy({}, {get:fail,getPrototypeOf:fail,ownKeys:fail,getOwnPropertyDescriptor:fail});
    const fn = new Proxy(function(){}, {get:fail,getPrototypeOf:fail,getOwnPropertyDescriptor:fail});
    const revocable = Proxy.revocable({}, {}); revocable.revoke();
    const object = {get x(){return fail();},toJSON:fail};
    for (const value of [proxy,fn,revocable.proxy,object]) {
        const encoded = serializeEvent({type:'CALL',iid:1,result:value});
        assert.ok(deserializeEvent(new DataView(encoded),0).event);
    }
    assert.equal(calls, 0);
});

test('typed previews bypass custom constructor, byteLength and toStringTag getters', () => {
    let calls = 0;
    const fail = () => { calls++; throw new Error('unexpected getter'); };
    const array = new Uint8Array([1,2]);
    for (const key of ['constructor','length','byteLength','buffer','byteOffset',Symbol.toStringTag])
        Object.defineProperty(array,key,{get:fail});
    const bytes = serializeEvent({type:'CALL',iid:1,result:array});
    assert.match(deserializeEvent(new DataView(bytes),0).event.result, /Uint8Array\(2\):2B:0102/);
    assert.equal(calls,0);
});

test('snapshots are cloneable, stable by identity, and exclude executable business values', () => {
    let count = 0;
    const value = {get x(){count++;return 2},toJSON(){count++;return 3}};
    const event = snapshotEvent({type:'CALL_PRE',iid:1,base:value,args:[value,2n,()=>{}],analysis:{kind:'call_input'}});
    assert.doesNotThrow(() => structuredClone(event));
    assert.doesNotThrow(() => JSON.stringify(event));
    assert.equal(event.base,event.args[0]);
    assert.equal(count,0);
});

test('ExecutionTrace and real logger preserve Proxy calls and avoid key recoercion/getter serialization', async () => {
    init({ ...ALL_CONFIG });
    const runtime = new JalangiSandbox({observeOnly:true});
    const backend = new MemoryBackend();
    const logger = new TraceLogger({nodeConsole:false,nodeFile:false,keyToConsole:false,logManagerOptions:{backends:[backend]}});
    await logger.init();
    const analysis = new ExecutionTraceAnalysis(runtime,null,{logger});
    runtime.analysis = analysis; // Let a regression fail the test instead of the dispatcher's process exit handler.
    const out = {};
    try {
        runInSandbox(instr(`var calls=0;
            var f=new Proxy(function(){return 2},{get(){throw Error('extra get')}});
            var o={get x(){calls++;return 2},toJSON(){calls++;return 3}};
            var wrapper={f};wrapper.f();
            var key={toString(){calls++;return 'key'}};var target={};target[key]=o;var read=target[key];
            $out.result=f();$out.calls=calls;`).code, runtime, {$out:out});
    } finally { await logger.close(); }
    assert.equal(out.result,2);
    assert.equal(out.calls,2); // Exactly the two native ToPropertyKey conversions.
    assert.ok(backend.getEvents().some(event=>event.type==='CALL'));
});


test('sloppy primitive writes preserve the primitive receiver of an inherited setter', () => {
    const runtime = new JalangiSandbox();
    let receiver, value;
    Object.defineProperty(Number.prototype, 'semanticSetter', {configurable:true,
        set(v) { 'use strict'; receiver=this; value=v; }});
    try {
        runtime.P(1, 3, 'semanticSetter', 7, 0, false);
        assert.equal(receiver,3);
        assert.equal(value,7);
    } finally { delete Number.prototype.semanticSetter; }
});


test('module host boundary observes top-level-await rejection and restores script state', () => {
    const runtimeUrl = new URL('../../src/runtime/JalangiSandbox.js', import.meta.url).href;
    const helperUrl = new URL('../helpers/shared-helpers.mjs', import.meta.url).href;
    const program = `
        import vm from 'node:vm'; import assert from 'node:assert/strict';
        import {JalangiSandbox} from ${JSON.stringify(runtimeUrl)};
        import {instr} from ${JSON.stringify(helperUrl)};
        const runtime=new JalangiSandbox(); const error={original:true}; const exits=[];
        runtime.analysis.use({scriptExit(_iid,wrapped){exits.push(wrapped)}});
        const context=vm.createContext({J$:runtime,error});
        const code=instr('const x=await Promise.reject(error); export {x};',{sourceType:'module'}).code;
        const module=new vm.SourceTextModule(code,{context}); await module.link(()=>{});
        await assert.rejects(runtime.runModule(()=>module.evaluate()),caught=>caught===error);
        assert.equal(runtime.sid,0); assert.equal(exits.length,1); assert.equal(exits[0].exception,error);
    `;
    execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',program],{timeout:15000,stdio:'pipe'});
});
