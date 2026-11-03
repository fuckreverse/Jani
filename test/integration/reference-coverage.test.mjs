import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {init} from '../../src/instrument/esnstrument.js';
import {buildConfigFromHooks} from '../../src/instrument/pluginAnalyzer.js';
import {JalangiSandbox} from '../../src/runtime/JalangiSandbox.js';
import {instr,runInSandbox,ALL_CONFIG} from '../helpers/shared-helpers.mjs';

function execute(source,config={...ALL_CONFIG}) {
    init(config);
    const reads=[],writes=[],gets=[],puts=[],calls=[],native=[];
    const runtime=new JalangiSandbox({observeOnly:true});
    runtime.analysis.use({
        readVar(...args){reads.push(args)},writeVar(...args){writes.push(args)},
        getField(...args){gets.push(args)},putField(...args){puts.push(args)},
        call(...args){calls.push(args)},nativeOperation(...args){native.push(args)},
    });
    const out={};
    runInSandbox(instr(source).code,runtime,{$out:out});
    return {out,reads,writes,gets,puts,calls,native};
}

test('updates emit read/write hooks with the stored numeric value and preserve old numeric result',()=>{
    const result=execute('var n="2";var old=n++;$out.values=[old,n];');
    assert.deepEqual(structuredClone(result.out.values),[2,3]);
    assert.equal(result.reads.filter(a=>a[1]==='n'&&a[2]==='2').length,1);
    assert.equal(result.writes.filter(a=>a[1]==='n'&&a[2]===3).length,1);
});

test('BigInt property update reads/writes once and retains the real receiver',()=>{
    const target={x:2n};
    init({...ALL_CONFIG});
    const runtime=new JalangiSandbox({observeOnly:true});const gets=[],puts=[];
    runtime.analysis.use({getField(...a){if(a[1]===target)gets.push(a)},putField(...a){if(a[1]===target)puts.push(a)}});
    const out={};runInSandbox(instr('$out.old=target.x++;').code,runtime,{target,$out:out});
    assert.equal(out.old,2n);assert.equal(target.x,3n);
    assert.equal(gets.length,1);assert.equal(puts.length,1);
    assert.equal(puts[0][3],3n);assert.equal(gets[0][5],true);
});

test('super getters/setters, compounds and method calls have hooks on the derived receiver',()=>{
    const r=execute(`class A{get x(){return this.value??0}set x(v){this.value=v}m(){return this.value}}
        class B extends A{go(){super.x=1;super.x+=2;var old=super.x++;return [old,super.x,super.m()]}}
        var b=new B();$out.values=b.go();$out.b=b;`);
    assert.deepEqual(structuredClone(r.out.values),[3,4,4]);
    assert.equal(r.puts.filter(a=>a[1]===r.out.b&&a[2]==='x').length,3);
    assert.equal(r.gets.filter(a=>a[1]===r.out.b&&a[2]==='x').length,3);
    assert.ok(r.calls.some(a=>a[2]===r.out.b&&a[4]===4));
});

test('private fields and methods use native brand checks while reporting hooks',()=>{
    const r=execute(`class C{#x=1n;#m(){return this.#x}go(){var old=this.#x++;this.#x+=2n;return [old,this.#m()]}}
        var c=new C();$out.values=c.go();$out.c=c;`);
    assert.deepEqual(structuredClone(r.out.values),[1n,4n]);
    assert.equal(r.puts.filter(a=>a[1]===r.out.c&&a[2]==='#x').length,2);
    assert.ok(r.gets.some(a=>a[1]===r.out.c&&a[2]==='#x'));
    assert.ok(r.calls.some(a=>a[2]===r.out.c&&a[4]===4n));
});

test('with calls, tags and updates report result-only events without rebinding this',()=>{
    const r=execute('var o={x:2,f(){return this.x}};with(o){$out.values=[f(),f?.(),f`x`,x++]};$out.x=o.x;');
    assert.deepEqual(structuredClone(r.out.values),[2,2,2,2]);assert.equal(r.out.x,3);
    assert.deepEqual(r.native.map(a=>a[1]),['with.call','with.optional-call-result','with.tag','with.update']);
});

test('super constructor remains native, preserves new.target and emits a result event',()=>{
    const r=execute('class A{constructor(){this.type=new.target.name}}class B extends A{constructor(){super()}}$out.x=new B().type;');
    assert.equal(r.out.x,'B');assert.equal(r.native.filter(a=>a[1]==='super.constructor').length,1);
});

const sources={
    derivedTDZ:`var keys=0;class A{};class B extends A{constructor(){super[(keys++,'x')]++}}try{new B()}catch(e){$out.x=[keys,e.name]}`,
    privateBrand:`class C{#x=1;static f(o){return o.#x++}}try{C.f({})}catch(e){$out.x=e.name}`,
    numberRounding:`var x=9007199254740992;$out.x=[x++,x,--x];`,
    conversion:`var n=0,x={[Symbol.toPrimitive](){n++;return 2n}};$out.x=[x++,x,n];`,
    computedKey:`var n=0,key={toString(){n++;return 'x'}},o={x:1};$out.x=[o[key]++,o.x,n];`,
    recursion:`function f(n){var x=1;return n?f(n-1)+x++:x++}$out.x=f(3);`,
    readonly:`'use strict';const x=1;try{x++}catch(e){$out.x=e.name}`,
    superKey:`var n=0;class A{get x(){return this.v??0}set x(v){this.v=v}}class B extends A{f(){var key={toString(){n++;return 'x'}};return super[key]++}}var b=new B();$out.x=[b.f(),b.v,n];`,
    superPrivateTag:`class A{tag(){return this.v}}class B extends A{#tag(){return this.v}f(){return [super.tag\`x\`,this.#tag\`x\`]}}var b=new B();b.v=4;$out.x=b.f();`,
};
for(const [mode,config]of Object.entries({full:{...ALL_CONFIG},read:buildConfigFromHooks(new Set(['readVar','getField'])),write:buildConfigFromHooks(new Set(['writeVar','putField'])),none:buildConfigFromHooks(new Set())}))
    for(const [name,source]of Object.entries(sources))test(`${mode}: reference semantics ${name}`,()=>{
        const expected={};vm.runInNewContext(source,{$out:expected});
        assert.deepEqual(structuredClone(execute(source,config).out),structuredClone(expected));
    });
