// JALANGI DO NOT INSTRUMENT

/**
 * @file ExecutionTrace —— 按语句粒度输出执行 trace，便于 LLM 分析。
 *
 * 粒度说明：
 *   - **语句级追踪**：每个表达式语句输出一条事件，包含语句涉及的所有变量读写。
 *   - 变量值包括：被写入的变量（执行后的值）+ 被读取的变量（当前值，或 OMITTED 如可追溯）。
 *   - 对于函数调用语句，CALL_PRE/CALL 仍独立输出（便于追踪调用栈）。
 *
 * 输出格式（二进制事件流，.bin 文件）：
 *   运行时直接输出 EventSerializer 定义的紧凑二进制格式（12 字节头 + payload），
 *   所有文本渲染交由后处理工具（trace-parse.mjs → trace-render.mjs）完成。
 *
 * 工具链示例：
 *   node tools/trace-parse.mjs trace.bin --smap trace.smap.json | node tools/trace-render.mjs --format tree
 *
 * 源码映射：
 *   trace 文件本身不包含位置信息（line:col）和源码文本，
 *   这些信息存储在与 .bin 配对的 .smap.json 文件中（由插桩阶段生成）。
 *   iid → [sl, sc, el, ec, srcText?, defIid?] 的映射由后处理工具解析。
 *
 * fai（flow-ambiguous）优化：
 *   对 LIGHTWEIGHT 路径（静态可追溯）的变量读取，值记录为 OMITTED（VALUE_TYPE.OMITTED），
 *   后处理工具通过 smap[iid].defIid 追溯到对应 write 事件的实际值。
 *   对 FULL（fai）路径，照常记录实际值。
 *
 * 用法：
 *   import { ExecutionTraceAnalysis } from './ExecutionTrace.js';
 *   const logger = new TraceLogger({ nodeFile: 'trace.bin' });
 *   J$.analysis = new ExecutionTraceAnalysis(J$, null, { logger });
 *
 * 自动配置推导（无需手写 Config）：
 *   import { init } from '../instrument/esnstrument.js';
 *   const analysis = new ExecutionTraceAnalysis(J$, null, opts);
 *   init(null, undefined, undefined, undefined, [analysis]);
 */

import { TraceLogger } from '../logger/TraceLogger.js';
import { createDiagLogger, DOMAIN } from '../logger/diagnostics.js';
import { functionName, referenceLabel } from '../runtime/ValueMetadata.js';
import {
    $push as _push, $pop as _pop,
    $keys,
} from '../runtime/NativeProxy.js';

const dbg = createDiagLogger(DOMAIN.ANALYSIS);

// ── 工具 ─────────────────────────────────────────────────────────────────────

// Property keys may still be objects supplied by the program. Formatting them
// must not repeat ToPropertyKey/ToPrimitive and execute business code again.
const nativeString = String;
function keyLabel(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        ? referenceLabel(value) : nativeString(value);
}

// ── 分析类 ───────────────────────────────────────────────────────────────────

export class ExecutionTraceAnalysis {
    /**
     * @param {object} [sandbox]      J$ 全局对象
     * @param {string} [sourceCode]   原始源码文本（已不再运行时使用，保留参数兼容性）
     * @param {object} [options]
     *
     * === 日志后端（三选一，优先级从高到低）===
     * @param {TraceLogger} [options.logger]
     *   直接传入已构造好的 TraceLogger 实例
     *
     * @param {boolean} [options.useIdb=false]
     * @param {string}  [options.dbName='jalangi-traces']
     * @param {string}  [options.storeName='execution-trace']
     * @param {string}  [options.wsUrl]
     * @param {boolean} [options.wsSab=false]     使用 SharedArrayBuffer 模式（需 COOP/COEP header）
     * @param {boolean} [options.wsWorker=true]   将 WebSocket 移到 Worker 线程
     * @param {string}  [options.wsFormat]        消息格式 'binary'|'ndjson'
     * @param {string|false} [options.nodeFile='jalangi-trace.bin']
     * @param {boolean} [options.nodeConsole=false]
     */
    constructor(sandbox, sourceCode, options = {}) {
        this._sb  = sandbox;
        this._seq = 0;

        // 调用栈元数据（只用于配对 CALL_PRE/CALL，不做树形缓冲）
        this._callStack = [];

        this._state = this._newState();
        this._asyncStates = new Map();
        this._promiseCalls = new WeakMap();
        this._scheduledCallbacks = new WeakMap();
        this._callbackStates = new Map();
        this._traceFrames = new Map();
        // Each invocation owns its pending statement, including across await suspension.
        for (const [property, key] of [['_pendingWrites','writes'],['_pendingReads','reads'],['_pendingFields','fields']]) {
            Object.defineProperty(this, property, { get: () => this._state[key], set: value => { this._state[key] = value; } });
        }

        // 构造 logger
        if (options.logger instanceof TraceLogger) {
            this._logger = options.logger;
        } else {
            const {
                useIdb = false, dbName, storeName, wsUrl,
                wsSab, wsWorker, wsFormat,
                nodeFile = 'jalangi-trace.bin',
                nodeConsole,
                logManagerOptions,
            } = options;
            this._logger = new TraceLogger({
                useIdb,
                ...(dbName      != null && { dbName }),
                ...(storeName   != null && { storeName }),
                ...(wsUrl       != null && { wsUrl }),
                ...(wsSab       !== undefined && { wsSab }),
                ...(wsWorker    !== undefined && { wsWorker }),
                ...(wsFormat    !== undefined && { wsFormat }),
                nodeFile,
                ...(nodeConsole !== undefined && { nodeConsole }),
                keyToConsole: true,
                ...(logManagerOptions != null && { logManagerOptions }),
            });
        }

        this._loggerReady = this._logger.init();
        this._loggerReady.catch(err => {
            dbg.error('TraceLogger init error:', err.message, err.stack ?? '');
        });

        if (sandbox) {
            sandbox.tracer = this._logger;
        }
    }

    // ── 内部辅助 ──────────────────────────────────────────────────────────────

    /**
     * 向 logger 发送一条结构化事件（TraceLogger.trace 接受任意对象，
     * NodeStreamBackend 负责将其序列化为二进制）。
     * seq 在此自动递增。
     * @param {object} event  不含 seq 的事件对象（type + iid + 其他字段）
     */
    _newState(parent = null) {
        return { writes: [], reads: [], fields: [], dependencies: [], parent, ownerFrameId:parent?.ownerFrameId, preparedCalls:[], callId: parent?.callId ?? 0, callInfo: null, returnEvent: null };
    }

    _emit(event) {
        if(this._traceClosed && event.type!=='TRACE_END')return;
        event.seq = ++this._seq;
        event.scriptId ??= this._sb?.sid ?? 0;
        event.callId ??= this._state?.callId ?? this._sb?.currentCallId ?? 0;
        event.parentCallId ??= this._sb?.parentCallId ?? 0;
        event.contextId ??= this._sb?.currentContextId ?? 0;
        event.analysis = { schema: 1, kind: 'statement', ...event.analysis };
        this._logger.trace(event);
        return event.seq;
    }

    /** emit KEY 事件（脚本进出、错误等低频事件） */
    _emitKey(level, text, iid = 0) {
        this._emit({ type: 'KEY_EVENT', iid, level, text });
    }

    // ── 函数调用边界 ──────────────────────────────────────────────────────────

    nativeOperation(iid, operation, value) {
        const eventId = this._emit({type:'END_EXPR',iid,writes:[{name:'(native-result)',val:value}],
            analysis:{kind:'native_operation',operation,coverage:'result_only',
                dependencies:this._state.dependencies.slice()}});
        _push(this._state.dependencies,{eventId,type:'native_result'});
    }

    callPre(iid, f, base, args, isConstructor, isMethod, fnDefIid, fnDefSid, promiseOperation) {
        const preparations=this._state.preparedCalls;
        const preparedIndex=preparations.findLastIndex(p=>p.iid===iid);
        const prepared=preparedIndex>=0 ? preparations.splice(preparedIndex,1)[0] : null;
        const info = { iid, name: (this._sb?.functionName?.(f) ?? functionName(f)) || '(anonymous)', invocationId: this._seq + 1,
            caller: this._state, entered: false, exitEvent: null, fnDefIid, argumentEvents:prepared?.argumentEvents };
        _push(this._callStack, info);
        this._emit({ type: 'CALL_PRE', iid, callPairId: info.invocationId, fn: info.name,
            args: args ? Array.from(args) : [], isConstructor: !!isConstructor, isMethod: !!isMethod,
            ...(isMethod && base !== undefined && { base }), ...(fnDefIid !== undefined && { fnDefIid }),
            reads: this._state.reads,
            analysis: { kind: 'call_input', dependencies: this._state.dependencies.slice() } });
        // CALL_PRE payload has no read section. Also emit an explicit input statement.
        const inputEvent = this.endExpression(iid, undefined, undefined, undefined, undefined, undefined,
            { kind: 'call_input' });
        info.inputEvent = inputEvent;
        info.promiseOperation=promiseOperation;
        if(promiseOperation)info.promiseParent=this._promiseInfo(promiseOperation==='resolve' ? args?.[0] : base);
        this._state = this._newState(info.caller);
        this._state.callInfo = info;
        this._state.callId = -info.invocationId;
        return { f, base, args, skip: false };
    }

    call(iid, f, base, args, result) {
        const info = _pop(this._callStack);
        if (!info) return { result };
        this._state = info.caller;
        const dependencies = [{ eventId: info.inputEvent, type: 'call_input' }];
        if(!info.entered)for(const eventId of info.argumentEvents ?? [])dependencies.push({eventId,type:'call_input'});
        if (info.exitEvent ?? info.returnEvent) dependencies.push({ eventId: info.exitEvent ?? info.returnEvent, type: 'return_value' });
        const seq = this._emit({ type: 'CALL', iid, callPairId: info.invocationId, fn: info.name, result,
            analysis: { kind: info.exitEvent ? 'call_result' : 'opaque_call_result', dependencies } });
        if (result !== null && (typeof result === 'object' || typeof result === 'function')) this._promiseCalls.set(result,info);
        _push(this._state.dependencies, { eventId: seq, type: 'call_ret', fromVar: '(return)' });
        this._logger.scheduleFlush?.();
        info.callReturned=true;
        if(info.completed || !info.entered)info.caller=null;
        return { result };
    }

    callException(iid,error) {
        const info=this._callStack[this._callStack.length-1];
        if(!info || info.iid!==iid)return;
        _pop(this._callStack);
        this._state=info.caller;
        const eventId=info.exitEvent ?? this._emit({type:'FUNCTION_EXIT',iid,callPairId:info.invocationId,exception:error,
            analysis:{kind:'exception_exit',dependencies:[{eventId:info.inputEvent,type:'call_input'}]}});
        _push(this._state.dependencies,{eventId,type:'exception_value'});
        info.caller=null;
    }

    // ── 脚本进出 ──────────────────────────────────────────────────────────────

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        this._emit({ type: 'SCRIPT_ENTER', iid, file: originalFileName });
        this._logger.key('info', `▶ script: ${originalFileName}`);
    }

    scriptExit(iid, wrappedExceptionVal) {
        const ev = { type: 'SCRIPT_EXIT', iid };
        if (wrappedExceptionVal) {
            ev.exception = wrappedExceptionVal.exception;
            this._logger.key('error', `◀ script end (exception: ${(wrappedExceptionVal.exception !== null && ['object', 'function'].includes(typeof wrappedExceptionVal.exception))
                ? referenceLabel(wrappedExceptionVal.exception) : String(wrappedExceptionVal.exception)})`);
        } else {
            this._logger.key('info', '◀ script end');
        }
        this._emit(ev);
        return { wrappedExceptionVal, isBacktrack: false };
    }

    functionEnter(iid, f, dis, args) {
        let info = this._callStack[this._callStack.length - 1];
        if (!info || info.entered || info.fnDefIid !== iid) {
            info = { iid, name: (this._sb?.functionName?.(f) ?? functionName(f)) || '(anonymous)', directFe: true,
                invocationId: this._seq + 1, caller: this._state,
                scheduleOwner:this._state.scheduleOrigin?.propagatesReturn ? this._state.scheduleOrigin.owner : null };
            this._state = this._newState(info.caller);
            this._state.dependencies = info.caller.dependencies.slice();
        }
        info.entered = true;
        this._state.callInfo = info;
        this._state.callId = this._sb?.currentCallId ?? 0;
        this._emit({ type: 'FUNCTION_ENTER', iid, fn: info.name,
            analysis:{kind:'function_enter',invocationId:info.invocationId},
            ...(info.directFe && { directFe: true, callPairId: info.invocationId }) });
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        if(this._state.argumentInfo)this.catchEnter(this._state.ownerFrameId);
        const state = this._state, info = state.callInfo;
        // The legacy async callee probe runs Fx before the real Fe. It is not
        // an invocation exit and must not pop the pending caller state.
        if(info && !info.entered)return {returnVal,wrappedExceptionVal,isBacktrack:false};
        // Flush declarations and reads even when there was no expression-statement hook.
        let pendingEvent;
        if (state.writes.length || state.reads.length || state.fields.length || state.dependencies.length)
            pendingEvent=this.endExpression(iid);
        const sourceEvent=wrappedExceptionVal ? state.throwEvent ?? pendingEvent : state.returnEvent;
        const dependencies=sourceEvent ? [{eventId:sourceEvent,type:wrappedExceptionVal ? 'exception_value' : 'return_value'}] : [];
        const exitEvent = this._emit({ type: 'FUNCTION_EXIT', iid,
            ...(wrappedExceptionVal && { exception: wrappedExceptionVal.exception, callPairId: info?.invocationId }),
            analysis: { kind: wrappedExceptionVal ? 'exception_exit' : 'function_exit', dependencies } });
        if (info) {
            info.exitEvent = exitEvent;
            if(wrappedExceptionVal) {
                info.exceptionEvent=exitEvent;
                if(info.scheduleOwner)info.scheduleOwner.exceptionEvent=exitEvent;
            }
        }
        this._asyncStates.delete(state.callId);
        this._state = info?.caller ?? state.parent ?? this._newState();
        if(info) {
            info.completed=true;
            if(info.callReturned)info.caller=null;
        }
        if (info?.directFe && !wrappedExceptionVal) {
            this._emit({ type: 'CALL', iid, callPairId: info.invocationId, fn: info.name, result: returnVal,
                analysis: { kind: 'callback_result', dependencies: [{ eventId: exitEvent, type: 'return_value' }] } });
        }
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    defaultBegin(iid,index,names,inputs) {
        const caller=this._state;
        this._state=this._newState(caller);
        this._state.defaultInfo={iid,index,names,inputs:new Map(inputs),owner:caller};
    }

    defaultEnd(iid,index) {
        const info=this._state.defaultInfo;
        if(!info || info.iid!==iid || info.index!==index)return;
        const eventId=this.endExpression(iid,undefined,undefined,undefined,undefined,undefined,{kind:'default_argument',argumentIndex:index});
        this._state=info.owner;
        this._state.defaultEvents ??= new Map();
        for(const name of info.names)this._state.defaultEvents.set(name,eventId);
    }

    declarationsEnd(iid) {
        if(this._state.writes.length || this._state.reads.length || this._state.fields.length || this._state.dependencies.length)
            this.endExpression(iid,undefined,undefined,undefined,undefined,undefined,{kind:'declarations'});
    }

    scopeEnter(frameId) { this._state.ownerFrameId=frameId; }

    argumentsBegin(iid) {
        this._state.preparedCalls.push({iid,argumentEvents:[]});
    }

    argumentBegin(iid,index) {
        const preparation=this._state.preparedCalls.findLast(p=>p.iid===iid);
        if(!preparation)return;
        const caller=this._state;
        this._state=this._newState(caller);
        this._state.argumentInfo={preparation,iid,index};
    }

    argumentEnd(iid,index,value,spread) {
        const info=this._state.argumentInfo;
        if(!info || info.iid!==iid || info.index!==index)return;
        const argumentIndex=info.preparation.argumentEvents.length;
        const dependencies=info.spreadSource ? [{eventId:info.spreadSource,type:'call_input'}] : [];
        const eventId=this.endExpression(iid,undefined,undefined,undefined,undefined,undefined,
            {kind:'argument',argumentIndex,dependencies});
        info.preparation.argumentEvents.push(eventId);
        if(spread)info.spreadSource ??= eventId;
        else this._state=this._state.parent;
    }

    argumentSpreadEnd(iid,index) {
        const info=this._state.argumentInfo;
        if(!info || info.iid!==iid || info.index!==index)return;
        if(this._state.writes.length || this._state.reads.length || this._state.fields.length || this._state.dependencies.length)
            this.endExpression(iid,undefined,undefined,undefined,undefined,undefined,{kind:'spread_completion'});
        this._state=this._state.parent;
    }

    catchEnter(frameId,caught=false) {
        let target=this._state;
        while(target && (target.argumentInfo || target.ownerFrameId!==frameId))target=target.parent;
        if(!target)return;
        if(this._state!==target) {
            const eventId=this.endExpression(0,undefined,undefined,undefined,undefined,undefined,{kind:'argument_aborted'});
            this._state=target;
            _push(target.dependencies,{eventId,type:'control'});
        }
        target.preparedCalls=[];
        if(caught && target.throwEvent) {
            _push(target.dependencies,{eventId:target.throwEvent,type:'exception_value'});
            target.throwEvent=null;
        }
    }

    traceBegin(iid,contextId,arrow) {
        if(arrow) {
            let info=this._state.callInfo;
            if(!info || info.entered || info.fnDefIid!==iid) {
                const caller=this._state;
                info={iid,name:'(arrow)',directFe:true,invocationId:this._seq+1,caller,
                    scheduleOwner:caller.scheduleOrigin?.propagatesReturn ? caller.scheduleOrigin.owner : null};
                this._state=this._newState(caller);
                this._state.dependencies=caller.dependencies.slice();
            }
            info.entered=true;
            this._state.callInfo=info;
            this._state.callId=contextId;
            this._emit({type:'FUNCTION_ENTER',iid,fn:info.name,
                ...(info.directFe && {directFe:true,callPairId:info.invocationId}),
                analysis:{kind:'function_enter',invocationId:info.invocationId}});
        }
        this._traceFrames.set(contextId,this._state);
    }

    traceError(contextId,error) {
        const state=this._traceFrames.get(contextId);
        if(state) {
            this.catchEnter(state.ownerFrameId);
            state.exception={exception:error};
        }
    }

    traceFinish(iid,contextId) {
        const state=this._traceFrames.get(contextId);
        if(!state)return;
        this._state=state;
        this.functionExit(iid,state.returnValue,state.exception);
        if(state.resumeCaller)this._state=state.resumeCaller;
        this._asyncStates.delete(contextId);
        this._traceFrames.delete(contextId);
    }

    _promiseInfo(value) {
        return value!==null && (typeof value==='object' || typeof value==='function') ? this._promiseCalls.get(value) : null;
    }

    _promiseSources(info,rejected=false,seen=new Set()) {
        if(!info || seen.has(info))return [];
        seen.add(info);
        const sources=[];
        const eventId=rejected ? info.exceptionEvent : info.returnEvent ?? info.completionEvent;
        if(eventId)sources.push(eventId);
        if(info.assimilatedInfo)sources.push(...this._promiseSources(info.assimilatedInfo,rejected,seen));
        if(info.promiseParent && (!info.callbackCompleted || info.promiseOperation==='finally' || info.promiseOperation==='resolve'))
            sources.push(...this._promiseSources(info.promiseParent,rejected,seen));
        return [...new Set(sources)];
    }

    awaitSuspend(iid, contextId, value) {
        const state = this._state;
        const eventId = this.endExpression(iid, undefined, undefined, undefined, undefined, undefined, { kind: 'await_suspend' });
        const awaitedInfo = value !== null && (typeof value === 'object' || typeof value === 'function') ? this._promiseCalls.get(value) : null;
        this._asyncStates.set(contextId, { state, eventId, awaitedInfo });
        this._state = state.resumeCaller ?? state.parent ?? state;
    }

    awaitResume(iid, contextId) {
        const suspended = this._asyncStates.get(contextId);
        if (!suspended) return;
        const owner=this._traceFrames.get(contextId) ?? suspended.state;
        if(this._state!==suspended.state && this._state!==owner)owner.resumeCaller=this._state;
        this._state = suspended.state;
        this._asyncStates.delete(contextId);
        const eventId = this._emit({ type: 'END_EXPR', iid,
            analysis: { kind: 'await_resume', dependencies: [{ eventId: suspended.eventId, type: 'await_resume' },
                ...this._promiseSources(suspended.awaitedInfo).map(eventId=>({eventId,type:'return_value'}))] } });
        _push(this._state.dependencies, { eventId, type: 'await_resume' });
    }

    contextResume(contextId) {
        const suspended = this._asyncStates.get(contextId);
        if (suspended) {
            this._asyncStates.delete(contextId);
            const owner=this._traceFrames.get(contextId) ?? suspended.state;
            if(this._state!==suspended.state && this._state!==owner)owner.resumeCaller=this._state;
            this._state = suspended.state;
            const eventId=this._emit({type:'END_EXPR',iid:0,analysis:{kind:'await_reject',dependencies:[
                {eventId:suspended.eventId,type:'await_resume'},
                ...this._promiseSources(suspended.awaitedInfo,true).map(eventId=>({eventId,type:'exception_value'})),
            ]}});
            _push(this._state.dependencies,{eventId,type:'await_resume'});
        } else if(this._traceFrames.has(contextId)) {
            this._state=this._traceFrames.get(contextId);
        }
    }

    callbackSchedule(iid, registrationId, promise, position, propagatesReturn, registration) {
        const info=this._state.callInfo;
        const promiseInfo=promise !== null && (typeof promise==='object' || typeof promise==='function') ? this._promiseCalls.get(promise) : null;
        const eventId=this._emit({type:'END_EXPR',iid,analysis:{kind:'async_schedule',
            dependencies:info?.inputEvent ? [{eventId:info.inputEvent,type:'call_input'}] : []}});
        this._scheduledCallbacks.set(registration,{eventId,promiseInfo,owner:info,propagatesReturn});
    }

    callbackEnter(iid,registrationId,contextId,values,registration) {
        const caller=this._state;
        const origin=this._scheduledCallbacks.get(registration);
        this._state=this._newState(caller);
        this._state.scheduleOrigin=origin;
        this._state.callId=contextId;
        this._callbackStates.set(contextId,{caller,state:this._state,origin});
        const dependencies=origin ? [{eventId:origin.eventId,type:'async_schedule'}] : [];
        if(origin?.promiseInfo?.returnEvent)dependencies.push({eventId:origin.promiseInfo.returnEvent,type:'return_value'});
        const eventId=this._emit({type:'END_EXPR',iid,analysis:{kind:'callback_enter',dependencies}});
        _push(this._state.dependencies,{eventId,type:'async_schedule'});
    }

    callbackResult(iid,contextId,value) {
        const origin=this._callbackStates.get(contextId)?.origin;
        if(!origin?.propagatesReturn || !origin.owner)return;
        origin.owner.callbackCompleted=true;
        origin.owner.assimilatedInfo=this._promiseInfo(value);
        if(!origin.owner.returnEvent)origin.owner.completionEvent=this._emit({type:'END_EXPR',iid,
            analysis:{kind:'callback_result',dependencies:[]}});
    }

    callbackThrow(iid,contextId,error) {
        const origin=this._callbackStates.get(contextId)?.origin;
        if(!origin?.owner)return;
        origin.owner.callbackCompleted=true;
        if(!origin.owner.exceptionEvent)origin.owner.exceptionEvent=this._emit({type:'END_EXPR',iid,
            analysis:{kind:'callback_throw',dependencies:[{eventId:origin.eventId,type:'async_schedule'}]}});
    }

    callbackExit(iid,contextId) {
        const callback=this._callbackStates.get(contextId);
        if(!callback)return;
        // Normal functions have already flushed their own frame in functionExit;
        // arrows use this callback boundary as their statement owner.
        if(this._state===callback.state && (this._state.writes.length || this._state.reads.length || this._state.dependencies.length || this._state.fields.length))this.endExpression(iid);
        this._state=callback.caller;
        this._callbackStates.delete(contextId);
    }

    evalCond(iid, value, ranges, expression) {
        const eventId = this.endExpression(iid, undefined, undefined, undefined, undefined, undefined,
            { kind: 'branch', controlRanges: ranges?.[value ? 0 : 1] ?? [] });
        if(expression)_push(this._state.dependencies,{eventId,type:'control'});
        return { result: value };
    }

    readVar(iid, name, val, isGlobal, isScriptLocal, defScopeId, bindingId) {
        const defaultInfo=this._state.defaultInfo;
        if(defaultInfo && defaultInfo.inputs.has(name)) {
            const sourceIndex=defaultInfo.inputs.get(name);
            const eventId=defaultInfo.owner.defaultEvents?.get(name) ?? defaultInfo.owner.callInfo?.argumentEvents?.[sourceIndex];
            if(eventId)_push(this._state.dependencies,{eventId,type:'call_arg',fromVar:`arg${sourceIndex}`,toVar:name});
        }
        _push(this._pendingReads, { name, val, scopeId: defScopeId ?? null,
            bindingId: bindingId ?? this._sb?.getBindingId?.(defScopeId) });
        return { result: val };
    }

    writeVar(iid, name, val, lhs, isGlobal, isScriptLocal, defScopeId, bindingId) {
        // 方向三：如果写入的值是对象引用，附带其 OID（供 F1 建立 oid_aliases 表）
        const oid = (val !== null && val !== undefined &&
                     (typeof val === 'object' || typeof val === 'function'))
            ? (this._sb?.getOid?.(val) ?? null)
            : null;
        // defScopeId：记录变量定义点的静态作用域 ID，用于区分同名变量
        _push(this._pendingWrites, { name, val, oid, scopeId: defScopeId ?? null, bindingId: bindingId ?? this._sb?.getBindingId?.(defScopeId) });
        return { result: val };
    }

    declareVar(iid, name, val, isArgument, argumentIndex, isCatchParam, defScopeId, bindingId, parameterKind) {
        if (name !== 'arguments') {
            this.writeVar(iid, name, val, undefined, false, false, defScopeId, bindingId);
            if (isArgument && Number.isInteger(argumentIndex) && argumentIndex >= 0) {
                const info = this._state.callInfo;
                const sources=info?.argumentEvents
                    ? parameterKind==='RestElement' ? info.argumentEvents.slice(argumentIndex) : info.argumentEvents.slice(argumentIndex,argumentIndex+1)
                    : info?.inputEvent ? [info.inputEvent] : [];
                const dependencies=info && !info.directFe ? sources.map((eventId,offset)=>({eventId,type:'call_arg',fromVar:`arg${argumentIndex+offset}`,toVar:name})) : [];
                const defaultEvent=this._state.defaultEvents?.get(name);
                if(defaultEvent)dependencies.push({eventId:defaultEvent,type:'call_arg',toVar:name});
                this.endExpression(iid, undefined, undefined, undefined, undefined, undefined,
                    { kind: 'parameter', argumentIndex, dependencies });
            }
        }
        return { result: val };
    }

    returnStmt(iid, val) {
        this._state.returnValue=val;
        _push(this._pendingWrites, { name: '(return)', val });
        this._state.returnEvent = this.endExpression(iid, undefined, undefined, undefined, undefined, undefined, { kind: 'return' });
        if(this._state.callInfo) {
            this._state.callInfo.returnEvent=this._state.returnEvent;
            this._state.callInfo.assimilatedInfo=this._promiseInfo(val);
        }
        const scheduleOwner=this._state.callInfo?.scheduleOwner ?? (this._state.scheduleOrigin?.propagatesReturn ? this._state.scheduleOrigin.owner : null);
        if(scheduleOwner)scheduleOwner.returnEvent=this._state.returnEvent;
        return { result: val };
    }

    throwStmt(iid, val) {
        _push(this._pendingWrites, { name: '(throw)', val });
        this._state.throwEvent=this.endExpression(iid,undefined,undefined,undefined,undefined,undefined,{kind:'throw'});
        return { result: val };
    }

    // ── 属性读写钩子 ─────────────────────────────────────────────────────────

    binary(iid,op,left,right,result) {
        if(op==='delete' && result) {
            _push(this._pendingFields,{offset:keyLabel(right),val:undefined,isWrite:true,
                baseOid:this._sb?.getOid?.(left) ?? null,deleted:true});
        }
        return {result};
    }

    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        if (!isMethodCall) {
            // getOid：只读查询，不分配新 OID；非对象返回 null
            const baseOid = this._sb?.getOid?.(base) ?? null;
            _push(this._pendingFields, {
                offset:    keyLabel(offset),
                val,
                isComputed: !!isComputed,
                isWrite:   false,
                baseOid,
            });
        }
        return { result: val };
    }

    putField(iid, base, offset, val, isComputed, isOpAssign) {
        // putField 时 P() 已调用 #getOrCreateOid 分配了 OID，getOid 此处可拿到
        const baseOid = this._sb?.getOid?.(base) ?? null;
        _push(this._pendingFields, {
            offset:    keyLabel(offset),
            val,
            isComputed: !!isComputed,
            isWrite:   true,
            baseOid,
        });
        return { result: val };
    }

    // ── 表达式语句末尾 ────────────────────────────────────────────────────────

    /**
     * 表达式语句结束钩子（方案F 扩展签名）。
     *
     * @param {number} iid          指令 ID
     * @param {*} [val]             表达式结果（当前未使用）
     * @param {string[]} [useNames] 静态 use-set 变量名列表（插桩器注入）
     * @param {number[]} [useScopes] 对应 defScopeId 列表
     * @param {*[]} [useValues]     变量当前值列表（由运行时从 Shadow Frame 查询）
     * @param {boolean[]} [useOmits] 对应变量是否应省略值（LIGHTWEIGHT 路径）
     */
    endExpression(iid, val, useNames, useScopes, useValues, useOmits, analysis = {}) {
        // Only executed readVar hooks contribute dependencies. Static use sets
        // include untaken branches and can invent data-flow edges.
        // 聚合当前语句的所有 kv
        const writes = this._pendingWrites;
        const reads  = this._pendingReads;
        const fields = this._pendingFields;
        this._pendingWrites = [];
        this._pendingReads  = [];
        this._pendingFields = [];

        // 构建 END_EXPR 事件（oid 字段透传：v2 格式 END_EXPR writes 条目末尾附加 val_oid u32）
        // scopeId 字段透传：v3 格式 reads/writes 条目附加 scope_id u32，用于区分同名变量
        // 注：避免使用 `...(cond ? {k:v} : {})` 模式——条件为 false 时仍会分配空对象，
        //     改用直接属性赋值（仅在需要时写入字段，避免 null 分支的无意义对象分配）
        const evWrites = writes.map(w => {
            const ev = { name: w.name, val: w.val };
            if (w.oid != null) ev.oid = w.oid;
            if (w.scopeId != null) ev.scopeId = w.scopeId;
            if (w.bindingId != null) ev.bindingId = w.bindingId;
            return ev;
        });
        const evReads  = reads
            // Preserve read-modify-write dependencies (x = x + 1).
            .map(r => {
                const ev = { name: r.name, val: r.val, omit: r.omit === true };
                if (r.scopeId != null) ev.scopeId = r.scopeId;
                if (r.bindingId != null) ev.bindingId = r.bindingId;
                return ev;
            });
        const evFields = fields.map(f => ({
            offset:  f.offset,
            val:     f.val,
            isWrite: !!f.isWrite,
            baseOid: f.baseOid ?? null,
        }));

        const dependencies = this._state.dependencies;
        this._state.dependencies = [];
        return this._emit({
            type:   'END_EXPR',
            iid,
            writes: evWrites.length > 0 ? evWrites : undefined,
            reads:  evReads.length  > 0 ? evReads  : undefined,
            fields: evFields.length > 0 ? evFields : undefined,
            analysis: { ...analysis, dependencies: [...dependencies, ...(analysis.dependencies ?? [])],
                deletedFieldIndexes: fields.flatMap((f,i)=>f.deleted ? [i] : []) },
        });
    }

    // ── 执行结束 ──────────────────────────────────────────────────────────────

    endExecution() {
        this._logger.key('info', `=== ExecutionTrace: script done, ${this._seq} events so far (async callbacks may still fire) ===`);
        // 注意：此处故意不关闭 logger，异步回调仍会继续产生 trace
    }

    /**
     * 手动 flush：将所有缓冲的 trace 写入后端，但不关闭 logger。
     * @returns {Promise<void>}
     */
    async flush() {
        await this._loggerReady;
        await this._logger.flush();
    }

    /**
     * 手动关闭：flush 后关闭 logger，不再接受新 trace。
     * @returns {Promise<void>}
     */
    async close() {
        if (this._traceClosed) return;
        this._traceClosed = true;
        this._emit({ type: 'TRACE_END', iid: 0 });
        this._asyncStates.clear();
        this._callbackStates.clear();
        this._scheduledCallbacks=new WeakMap();
        this._traceFrames.clear();
        this._logger.key('info', `=== ExecutionTrace: closed, total ${this._seq} events ===`);
        try {
            await this._loggerReady;
            await this._logger.close();
        } catch (err) {
            dbg.error('close: logger close error:', err.message, err.stack ?? '');
            throw err;
        }
    }

    onReady(cb) {
        this._loggerReady.then(() => cb(), () => cb());
    }
}
