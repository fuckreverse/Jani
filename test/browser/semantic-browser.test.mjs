/** Real Chrome regression. Uses an isolated temporary profile and localhost only. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once,EventEmitter} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {init,instrumentCode} from '../../src/instrument/esnstrument.js';
import {fullConfig} from '../../src/instrument/pluginAnalyzer.js';
import {deserializeEvent} from '../../src/encoding/EventSerializer.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
function chromePath(){
    const candidates=[process.env.CHROME_BINARY,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
    const found=candidates.find(path=>path&&existsSync(path));
    if(!found)throw new Error('Chrome not found. Set CHROME_BINARY to run the real browser suite.');
    return found;
}
class CDP extends EventEmitter{
    constructor(socket){super();this.socket=socket;this.next=0;this.pending=new Map();
        socket.on('message',bytes=>{const message=JSON.parse(String(bytes));
            if(message.id){const pending=this.pending.get(message.id);if(!pending)return;
                this.pending.delete(message.id);clearTimeout(pending.timer);
                if(message.error)pending.reject(new Error(JSON.stringify(message.error)));else pending.resolve(message.result);
            }else this.emit(message.method,message.params);
        });
        socket.on('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Browser connection closed'));}this.pending.clear();});
    }
    send(method,params={}){return new Promise((resolve,reject)=>{
        const id=++this.next;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Browser timed out: ${method}`));},40000);
        this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));
    });}
    async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
        if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
}

const business={
    'first.js':`let shared=4;class Parent{get x(){return this.value??0}set x(v){this.value=v}m(){return this.value}}
        class Child extends Parent{#n=1n;constructor(){super();this.value=2}step(){const old=super.x++;this.#n++;return [old,super.m(),String(this.#n)]}}
        globalThis.counter=new Child();`,
    'second.js':`$out.shared=shared;$out.counter=counter.step();var n=1n;$out.update=[String(n++),String(n)];
        var dynamic={x:3,f(){return this.x}};with(dynamic){$out.with=[f(),f?.(),f\`x\`,x++]};
        var calls=0;var value={get x(){calls++;throw Error('getter')},toJSON(){calls++;return 2}};
        var key={toString(){calls++;return 'k'}};var target={};target[key]=value;var copy=target[key];
        var fn=new Proxy(function(){return 2},{get(){throw Error('extra function get')}});$out.proxy=fn();$out.observerCalls=calls;
        const node=document.createElement('button');node.textContent='run';document.body.appendChild(node);
        node.addEventListener('click',()=>{node.dataset.result=String(shared+1)});node.click();$out.dom=node.dataset.result;`,
    'dep.mjs':`export let live=1;export function bump(){live++}`,
    'app.mjs':`import {live,bump} from './dep.mjs';const local=await Promise.resolve(7);bump();
        export {local};export function answer(){return local+live}$out.module=[answer(),live];`,
    'worker-body.js':`onmessage=async function(event){class A{get x(){return this.v??0}set x(v){this.v=v}}
        class B extends A{f(){return super.x++}}const b=new B();const n=event.data;
        const result=[b.f(),b.v,String(n+1n)];if(globalThis.__flush)await globalThis.__flush();postMessage(result)}`,
};
function fixtureHtml(observed){const prefix=observed?'/observed/':'/native/';return `<!doctype html><html><body>
${observed?'<script src="/runtime.js"></script>':''}<script>
window.__stage='start';window.$out={};window.__coverage={native:[],get:0,put:0,call:0};
window.__done=(async()=>{
    if(globalThis.J$){window.__stage='ready';await new Promise(resolve=>J$.analysis.onReady(resolve));
        J$.analysis.use({nativeOperation(iid,kind){__coverage.native.push(kind)},getField(){__coverage.get++},putField(){__coverage.put++},call(){__coverage.call++}});}
    function load(file,module=false){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=${JSON.stringify(prefix)}+file;
        if(module)s.type='module';s.onload=resolve;s.onerror=()=>reject(Error('load '+file));document.head.appendChild(s)})}
    window.__stage='scripts';await load('first.js');await load('second.js');window.__stage='module';await load('app.mjs',true);window.__stage='worker';
    $out.worker=await new Promise((resolve,reject)=>{const worker=new Worker(${JSON.stringify(prefix)}+'worker.js');
        worker.onerror=e=>{worker.terminate();reject(Error(e.message))};worker.onmessage=e=>{if(e.data==='ready'){worker.postMessage(2n);return}worker.terminate();resolve(e.data)}});
    await new Promise(resolve=>setTimeout(resolve,30));
    let events=[];
    if(globalThis.J$){window.__stage='flush';await J$.tracer.flush();window.__stage='query';const idb=J$.tracer._mgr._backends.find(backend=>typeof backend.query==='function');
        events=await idb.query({},10000);window.__stage='close';await J$.tracer.close();window.__stage='done';}
    return {out:$out,coverage:__coverage,idb:{count:events.length,native:events.filter(e=>e.analysis?.kind==='native_operation').map(e=>e.analysis.operation),
        references:events.flatMap(e=>e.writes??[]).filter(w=>typeof w.val==='string'&&w.val.startsWith('[Object #')).length}};
})();
</script></body></html>`;}

test('real browser: shared scripts, ESM/TLA, DOM, Worker, IDB and WebSocket preserve behavior and coverage',{timeout:90000},async()=>{
    const directory=mkdtempSync(join(tmpdir(),'jani-browser-'));
    const resources=new Map();const wsEvents=[];const decodingErrors=[];
    const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const resource=resources.get(path);
        if(!resource){res.writeHead(404);res.end('not found');return}
        res.setHeader('Content-Type',path.endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8');res.end(resource);});
    const wss=new WebSocketServer({server});
    wss.on('connection',socket=>socket.on('message',(bytes,isBinary)=>{
        if(!isBinary)return;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        try{for(let offset=4;offset<view.byteLength;){const decoded=deserializeEvent(view,offset);wsEvents.push(decoded.event);offset=decoded.nextOffset;}
            const ack=Buffer.alloc(4);ack.writeUInt32LE(view.getUint32(0,true));socket.send(ack);
        }catch(error){decodingErrors.push(error.message)}
    }));
    let chrome,browserSocket;
    try{
        server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
        const input=join(directory,'bootstrap.js');writeFileSync(input,'');
        for(const [name,db]of [['runtime','jani-main-regression'],['worker-runtime','jani-worker-regression']]){
            const output=join(directory,`${name}.js`);
            execFileSync(process.execPath,[join(root,'bin/jalangi.mjs'),'instrument','--target','browser','--split-runtime',
                '--output',output,'--db-name',db,'--ws-url',`ws://127.0.0.1:${port}/trace`,input],{stdio:'pipe',timeout:30000});
            resources.set(`/${name}.js`,readFileSync(output.replace('.js','.runtime.js'),'utf8'));
        }
        resources.set('/native.html',fixtureHtml(false));resources.set('/observed.html',fixtureHtml(true));
        for(const [file,source]of Object.entries(business)){
            resources.set('/native/'+file,source);init(fullConfig());
            const result=instrumentCode({code:source,sourceType:file.endsWith('.mjs')?'module':'script',
                origCodeFileName:file,instCodeFileName:file,inlineSourceMap:true});
            resources.set('/observed/'+file,result.code);
        }
        resources.set('/native/worker.js',`importScripts('/native/worker-body.js');postMessage('ready')`);
        resources.set('/observed/worker.js',`importScripts('/worker-runtime.js');J$.analysis.onReady(()=>{
            globalThis.__flush=()=>J$.tracer.flush();importScripts('/observed/worker-body.js');postMessage('ready')});`);
        chrome=spawn(chromePath(),['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
            '--disable-background-networking',`--user-data-dir=${join(directory,'profile')}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
        const browserUrl=await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout: '+stderr)),15000);
            chrome.once('error',error=>{clearTimeout(timer);reject(error)});chrome.once('exit',code=>{clearTimeout(timer);reject(Error('Chrome exited '+code+': '+stderr))});
            chrome.stderr.on('data',chunk=>{stderr+=chunk;const match=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1])}});});
        browserSocket=new WebSocket(browserUrl);await once(browserSocket,'open');const browser=new CDP(browserSocket);
        const outcomes=[];
        for(const mode of ['native','observed']){
            const {targetId}=await browser.send('Target.createTarget',{url:'about:blank'});
            const debugPort=new URL(browserUrl).port;
            const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
            const socket=new WebSocket(pages.find(page=>page.id===targetId).webSocketDebuggerUrl);await once(socket,'open');
            const page=new CDP(socket);page.on('Runtime.consoleAPICalled',event=>{if(event.type==='error')console.log('browser error:',event.args.map(a=>a.value??a.description).join(' '))});const exceptions=[];page.on('Runtime.exceptionThrown',event=>exceptions.push(event.exceptionDetails));
            await page.send('Page.enable');await page.send('Runtime.enable');const loaded=once(page,'Page.loadEventFired');
            await page.send('Page.navigate',{url:`http://127.0.0.1:${port}/${mode}.html`});await loaded;
            const outcome=await page.evaluate(`Promise.race([globalThis.__done,new Promise((_,reject)=>setTimeout(()=>reject(Error(JSON.stringify({stage:__stage,out:$out,backends:globalThis.J$?.tracer?._mgr?._backends.map(b=>({name:b.constructor.name,stats:b.stats,pending:b._pending?.size,flight:b._inFlight?.size}))}))),20000))])`);assert.deepEqual(exceptions,[],mode+' browser exceptions');outcomes.push(outcome);
            console.log(`${mode}: ${JSON.stringify(outcome)}`);
            await browser.send('Target.closeTarget',{targetId});socket.close();
        }
        assert.deepEqual(outcomes[1].out,outcomes[0].out);
        assert.deepEqual(outcomes[1].out,{shared:4,counter:[2,3,'2'],update:['1','2'],with:[3,3,3,3],proxy:2,observerCalls:2,dom:'5',module:[9,2],worker:[0,1,'3']});
        assert.ok(outcomes[1].coverage.get>0&&outcomes[1].coverage.put>0&&outcomes[1].coverage.call>0);
        for(const kind of ['super.constructor','with.call','with.tag','with.update'])assert.ok(outcomes[1].coverage.native.includes(kind),kind);
        assert.ok(outcomes[1].idb.count>0);assert.ok(outcomes[1].idb.references>0);assert.ok(outcomes[1].idb.native.includes('with.call'));
        assert.deepEqual(decodingErrors,[]);assert.ok(wsEvents.some(e=>e.type==='SCRIPT_ENTER'));
        assert.ok(wsEvents.some(e=>e.analysis?.operation==='with.call'));assert.ok(wsEvents.some(e=>e.file==='worker-body.js'));
        await browser.send('Browser.close');browserSocket.close();
    }finally{
        browserSocket?.terminate();if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);}
        for(const socket of wss.clients)socket.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));
        rmSync(directory,{recursive:true,force:true});
    }
});
