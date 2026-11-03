/**
 * Standalone semantic audit. Run:
 *   node --experimental-vm-modules tools/audit-semantics.mjs
 * Exit 1 means a semantic difference was reproduced, not a harness failure.
 * Also exercised by semantic-regressions.test.mjs in npm test.
 */
import vm from 'node:vm';
import { isDeepStrictEqual, inspect } from 'node:util';
import { instrAndRun, instr } from '../test/helpers/shared-helpers.mjs';
import { JalangiSandbox } from '../src/runtime/JalangiSandbox.js';
import { serializeEvent } from '../src/encoding/EventSerializer.js';

const cases={
catchPattern:`try{throw {x:2}}catch({x}){$out.x=x}`,
catchScope:`let x=1;try{throw 2}catch(x){$out.inner=x}$out.outer=x;`,
classField:`class C { x=1; y=this.x+1; static z=3; } $out.x=new C().y; $out.z=C.z;`,
classPrivateGetter:`class C { #x=1;get #value(){return this.#x} m(){return this.#value} }$out.x=new C().m();`,
classComputed:`var key='m';class C { [key](){return 2} }$out.x=new C().m();`,
classStaticBlock:`class C {static {this.x=2}} $out.x=C.x;`,
argumentsMapping:`function f(a){arguments[0]=3;return a}$out.x=f(1);`,
defaultTDZ:`function f(a=b,b=2){return a}try{f()}catch(e){$out.error=e.name}`,
recursiveLogical:`function f(n){return n ? (f(n-1)??9) : 2} $out.x=f(3);`,
reentrantSwitch:`function g(){switch(2){case 2:return 1}}switch(1){case g():$out.x=1;break;default:$out.x=0}`,
sloppyPrimitive:`var x=1; x.p=2;$out.x=x.p;`,
proxyThrow:`var f=new Proxy(function(){return 2},{get(){throw new Error('extra get')}});$out.x=f();`,
withCall:`var o={x:3,f(){return this.x}};with(o){$out.x=f()}`,
callee:`function f(){return arguments.callee===f}$out.x=f();`,
paramEval:`function f(a=eval('var x=2')){return x}$out.x=f();`,
functionLength:`function f(a,b=2,c){}$out.x=f.length;`,
assignmentName:`var f;f=()=>{};$out.x=f.name;`,
objectName:`var o={f:function(){},a:()=>{}};$out.x=[o.f.name,o.a.name];`,

sloppyWrite:`var o=Object.freeze({x:1}); o.x=2; $out.x=o.x;`,
sloppyDelete:`var o={}; Object.defineProperty(o,'x',{value:1}); $out.x=delete o.x;`,
logicalProperty:`var hits=0,o={get x(){return 1},set x(v){hits++}};o.x ||= missing();$out.hits=hits;`,
logicalConst:`const x=1; x ||= 2; $out.x=x;`,
assignmentTDZ:`let x=(x=1);`,
computedAssignment:`var log=[];var key={[Symbol.toPrimitive](){log.push('key');return 'x'}};var o={};function rhs(){log.push('rhs');return 2}o[key]=rhs();$out.log=log;`,
computedCompound:`var calls=0,key={toString(){calls++;return 'x'}};var o={x:1};o[key]+=2;$out.calls=calls;`,
taggedThis:`var o={x:2,tag(){return this.x}};$out.x=o.tag\`a\`;`,
newTarget:`function F(){this.x=new.target===F} $out.x=new F().x;`,
classExpression:`var C=class Named { m(){return Named} }; $out.x=new C().m()===C;`,
privateMethod:`class C { #m(){return 1} m(){return this.#m()} } $out.x=new C().m();`,
functionName:`var f=function(){}; var a=()=>{};$out.names=[f.name,a.name];`,
blockScope:`let x=1; {let x=2;$out.inner=x} $out.outer=x;`,
functionHoist:`'use strict';function f(){return g();function g(){return 2}} $out.x=f();`,
evalVar:`function f(){eval('var x=2');return x} $out.x=f();`,
evalLexical:`function f(){let x=2;return eval('x')} $out.x=f();`,
shadowUndefined:`function f(undefined){return undefined} $out.x=f(42);`,
shadowNaN:`function f(NaN,Infinity){return [NaN,Infinity]} $out.x=f(2,3);`,
switchNested:`var n=0; switch(1){case (function(){switch(2){case 2:return 1}})():n=3;break;default:n=4}$out.x=n;`,
proxyCall:`var gets=[];var f=new Proxy(function(){return 2},{get(t,k,r){gets.push(String(k));return Reflect.get(t,k,r)}});$out.x=f();$out.gets=gets;`,
forLet:`var a=[];for(let i=0;i<3;i++)a.push(()=>i);$out.x=a.map(f=>f());`,
paramArguments:`function f(arguments){return arguments} $out.x=f(2);`,
strictThis:`function f(){'use strict';return this} $out.x=f()===undefined;`,
returnFinally:`function f(){try{return 1}finally{return 2}} $out.x=f();`,
};
const asyncCases={
asyncReturn:`async function f(){try{return await Promise.resolve(1)}finally{$out.final=true}}$out.done=f().then(x=>{$out.x=x})`,
asyncReject:`async function f(){try{await Promise.reject(2)}catch(e){return e}finally{$out.final=true}}$out.done=f().then(x=>{$out.x=x})`,
concurrent:`async function f(n){await Promise.resolve();return n+1}$out.done=Promise.all([f(1),f(2)]).then(x=>{$out.x=x})`,
asyncDefaultAwait:`async function f(a=1){await 0;return a}$out.done=f().then(x=>{$out.x=x})`,
generator:`function* g(){try{yield 1;return 2}finally{$out.final=true}}var i=g();$out.x=[i.next(),i.next()];`,
generatorThrow:`function* g(){try{yield 1}catch(e){yield e}}var i=g();$out.x=[i.next(),i.throw(2)];`,
yieldLogical:`function* g(){return (yield 1)??2}var i=g();$out.x=[i.next(),i.next(3)];`,
asyncGenerator:`async function* g(){yield 1;yield 2}$out.done=(async()=>{var a=[];for await(const x of g())a.push(x);$out.x=a})()`,
};
const moduleCases={order:'globalThis.order=[]; order.push(1); export const x=order.push(2); order.push(3);',binding:'const local=2; export function f(){return local} globalThis.result=f();',exportBinding:'const local=2; export {local};',exportAwait:'const local=await Promise.resolve(2); export {local};',defaultExpr:'const local=2; export default local;'};

const results=[];
async function execute(source, instrumented) {
    const out={};
    try {
        const actual=instrumented ? instrAndRun(source).out :
            (vm.runInNewContext(source, {$out:out,Promise}, {timeout:2000}),out);
        await actual.done;
        delete actual.done;
        return {out:structuredClone(actual)};
    } catch(error) { return {error:error.name,message:error.message}; }
}
function record(name,original,instrumented) {
    results.push({name,equal:isDeepStrictEqual(original,instrumented),original,instrumented});
}
for(const [name,source] of Object.entries({...cases,...asyncCases})) {
    record(name,await execute(source,false),await execute(source,true));
}
if(typeof vm.SourceTextModule!=='function')throw new Error('Run with --experimental-vm-modules to include module cases');
for(const [name,source] of Object.entries(moduleCases)) {
    const outcomes=[];
    for(const instrumented of [false,true]) {
        const context=vm.createContext({J$:new JalangiSandbox()});
        try {
            const m=new vm.SourceTextModule(instrumented?instr(source,{sourceType:'module'}).code:source,{context});
            await m.link(()=>{throw new Error('Unexpected import')});
            await m.evaluate({timeout:2000});
            outcomes.push({out:structuredClone(context.order??context.result??Object.fromEntries(Object.keys(m.namespace).map(key=>[key,typeof m.namespace[key]==='function' ? '[Function]' : m.namespace[key]])))});
        }catch(error){outcomes.push({error:error.name,message:error.message});}
    }
    record('module/'+name,...outcomes);
}
const cross=[];
for(const instrumented of [false,true]) {
    const context=vm.createContext({J$:new JalangiSandbox(),$out:{}});
    try {
        for(const source of ['let shared=2;', '$out.x=shared;'])
            vm.runInContext(instrumented?instr(source).code:source,context,{timeout:2000});
        cross.push({out:structuredClone(context.$out)});
    }catch(error){cross.push({error:error.name,message:error.message});}
}
record('crossScript',...cross);
let getterCalls=0;
serializeEvent({type:'CALL',iid:1,result:{get x(){getterCalls++;return 2}}});
record('serializer/getter',{calls:0},{calls:getterCalls});
let toJSONCalls=0;
serializeEvent({type:'CALL',iid:1,result:{toJSON(){toJSONCalls++;return {x:1}}}});
record('serializer/toJSON',{calls:0},{calls:toJSONCalls});
for(const row of results.filter(r=>!r.equal)) {
    console.log(`DIFF ${row.name}\n  original: ${inspect(row.original,{depth:5})}\n  instrumented: ${inspect(row.instrumented,{depth:5})}`);
}
const differences=results.filter(r=>!r.equal).length;
console.log(`\n${results.length} cases; ${results.length-differences} equivalent; ${differences} differences.`);
process.exitCode=differences?1:0;
