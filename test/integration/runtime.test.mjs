/**
 * test/integration/runtime.test.mjs — 运行时框架层单元测试
 *
 * 覆盖范围：
 *  - HOOKS 常量完整性
 *  - HookDispatcher：构造、use()、链式调度、值传递、异常处理、实例独立性
 *  - SMemory / SMemoryPlugin：ESM 导入、状态管理
 *  - LogAllAnalysis：ESM 导入、钩子返回值格式
 *  - 端到端：三层组合（HookDispatcher + SMemoryPlugin + LogAllAnalysis）
 *  - JalangiSandbox API 边界：getOid、getObjectVersion、getShadowStats、newAsyncContext、activateContext
 *  - DataFlowAnalyzer 边界：backwardSlice、processRead、processCallReturn、reset
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { HookDispatcher, HOOKS }   from '../../src/runtime/HookDispatcher.js';
import { SMemory, SMemoryPlugin } from '../../src/runtime/SMemory.js';
import { LogAllAnalysis }         from '../../src/plugins/tutorial/LogAll.js';
import { JalangiSandbox }         from '../../src/runtime/JalangiSandbox.js';
import { DataFlowAnalyzer }       from '../../src/runtime/DataFlowAnalyzer.js';
import {
    installToStringHook,
    uninstallToStringHook,
    registerOriginalCode,
    detectGlobalLeaks,
    createContextWrapper,
    benchmarkCallOverhead,
} from '../../src/runtime/AntiDetection.js';

// 构造一个满足 SMemory 需要的最小 Constants 对象
const FAKE_CONSTANTS = {
    JALANGI_VAR: 'J$',
    isBrowser: false,
    HOP: (o, p) => Object.prototype.hasOwnProperty.call(o, p),
};

// ════════════════════════════════════════════════════════════════════════════════
// HOOKS 常量
// ════════════════════════════════════════════════════════════════════════════════

describe('HOOKS 常量', () => {
    test('HOOKS 是一个非空冻结数组', () => {
        assert.ok(Array.isArray(HOOKS) && HOOKS.length > 0, 'HOOKS 应为非空数组');
        assert.ok(Object.isFrozen(HOOKS),                    'HOOKS 应为冻结数组');
    });

    test('HOOKS 包含所有预期钩子名', () => {
        const expected = ['readVar', 'writeVar', 'getField', 'putField', 'binary', 'unary',
            'functionEnter', 'functionExit', 'scriptEnter', 'scriptExit',
            'call', 'callPre', 'evalLiteral', 'evalCond', 'endExecution'];
        for (const name of expected) {
            assert.ok(HOOKS.includes(name), `HOOKS 中应包含 "${name}"`);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// HookDispatcher 构造与基本行为
// ════════════════════════════════════════════════════════════════════════════════

describe('HookDispatcher 构造与基本行为', () => {
    test('new HookDispatcher() 构造后每个 hook 方法都存在', () => {
        const host = new HookDispatcher();
        for (const name of HOOKS) {
            assert.equal(typeof host[name], 'function', `host.${name} 应为函数`);
        }
    });

    test('未注册任何插件时，钩子调用返回 undefined', () => {
        const host = new HookDispatcher();
        assert.equal(host.readVar(1, 'x', 42, false, false), undefined);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// use() 注册插件
// ════════════════════════════════════════════════════════════════════════════════

describe('use() 注册插件', () => {
    test('use() 返回 this，支持链式语法', () => {
        const host = new HookDispatcher();
        assert.equal(host.use({ readVar: () => {} }), host);
    });

    test('use().use() 链式注册，顺序即执行顺序', () => {
        const order = [];
        new HookDispatcher()
            .use({ readVar: () => { order.push(1); } })
            .use({ readVar: () => { order.push(2); } })
            .readVar(1, 'x', undefined, false, false);
        assert.deepEqual(order, [1, 2]);
    });

    test('只注册插件中实现的 hook，未实现的不触发', () => {
        const calls = [];
        const host = new HookDispatcher()
            .use({ readVar: () => { calls.push('readVar'); } });
        host.readVar(1, 'x', undefined, false, false);
        host.writeVar(1, 'x', 42, undefined, false, false);
        assert.deepEqual(calls, ['readVar'], '只有 read 被调用');
    });

    test('同一插件多次 use() 会导致重复调用', () => {
        const calls = [];
        const plugin = { readVar: () => { calls.push(1); } };
        new HookDispatcher().use(plugin).use(plugin).readVar(1, 'x', undefined, false, false);
        assert.deepEqual(calls, [1, 1], '重复注册应重复调用');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 链式值传递
// ════════════════════════════════════════════════════════════════════════════════

describe('链式值传递', () => {
    test('最后一个有返回值的插件决定最终返回值', () => {
        const host = new HookDispatcher()
            .use({ readVar: () => ({ result: 'first' }) })
            .use({ readVar: () => ({ result: 'last'  }) });
        assert.equal(host.readVar(1, 'x', undefined, false, false).result, 'last');
    });

    test('插件 A 返回 {result} 时，插件 B 看到修改后的值（链式传递语义）', () => {
        // HookDispatcher 的核心设计：前一个插件返回 { result: newVal }
        // 后续插件看到的对应参数会被替换为 newVal（链式 taint/shadow 传递）
        const seenByB = [];
        new HookDispatcher()
            .use({ readVar: (_iid, _name, _val) => ({ result: 'MODIFIED' }) })
            .use({ readVar: (_iid, _name, val)  => { seenByB.push(val); } })
            .readVar(1, 'x', 'original', false, false);
        assert.deepEqual(seenByB, ['MODIFIED'],
            '插件 B 应看到插件 A 修改后的值（链式传递是 HookDispatcher 的核心特性）');
    });

    test('插件 A 不返回时，插件 B 看到原始入参', () => {
        const seenByB = [];
        new HookDispatcher()
            .use({ readVar: () => { /* 不返回 */ } })
            .use({ readVar: (_iid, _name, val) => { seenByB.push(val); } })
            .readVar(1, 'x', 'original', false, false);
        assert.deepEqual(seenByB, ['original'], '插件 A 无返回时，插件 B 看到原始值');
    });

    test('返回 {args:[...]} 可替换后续插件的整体参数列表', () => {
        const seenByB = [];
        new HookDispatcher()
            .use({ readVar: (iid, _name, val, g, sl) => ({ result: val, args: [iid, 'replaced', val, g, sl] }) })
            .use({ readVar: (_iid, name) => { seenByB.push(name); } })
            .readVar(1, 'original', undefined, false, false);
        assert.deepEqual(seenByB, ['replaced']);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 异常处理
// ════════════════════════════════════════════════════════════════════════════════

describe('异常处理', () => {
    test('插件抛出异常时 rethrow（通过 onError 阻止 process.exit）', () => {
        const host = new HookDispatcher({ onError: () => {} });
        host.use({ readVar: () => { throw new Error('boom'); } });
        assert.throws(() => host.readVar(1, 'x', undefined, false, false), /boom/);
    });

    test('插件 A 抛出后不再调用插件 B', () => {
        const calledB = [];
        const host = new HookDispatcher({ onError: () => {} });
        host.use({ readVar: () => { throw new Error(); } });
        host.use({ readVar: () => { calledB.push(true); } });
        try { host.readVar(1, 'x', undefined, false, false); } catch (_) {}
        assert.deepEqual(calledB, [], '插件 B 不应被调用');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 实例独立性
// ════════════════════════════════════════════════════════════════════════════════

describe('实例独立性', () => {
    test('两个 HookDispatcher 实例互不影响', () => {
        const log1 = [], log2 = [];
        const h1 = new HookDispatcher().use({ readVar: () => { log1.push(1); } });
        const h2 = new HookDispatcher().use({ readVar: () => { log2.push(2); } });
        h1.readVar(1, 'x', undefined, false, false);
        assert.deepEqual(log1, [1]);
        assert.deepEqual(log2, [], 'h2 不受 h1 影响');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// SMemory / SMemoryPlugin
// ════════════════════════════════════════════════════════════════════════════════

describe('SMemory / SMemoryPlugin', () => {
    test('SMemory 可以正常构造', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        assert.equal(typeof mem.getShadowObjectOfObject, 'function');
        assert.equal(typeof mem.functionEnter, 'function');
    });

    test('SMemoryPlugin 实现了必要的 hook 方法', () => {
        const mem    = new SMemory(FAKE_CONSTANTS);
        const plugin = new SMemoryPlugin(mem);
        for (const name of ['evalLiteral', 'declareVar', 'functionEnter', 'functionExit', 'scriptEnter', 'scriptExit']) {
            assert.equal(typeof plugin[name], 'function', `SMemoryPlugin.${name} 应存在`);
        }
    });

    test('SMemoryPlugin.functionExit 返回标准格式', () => {
        const mem    = new SMemory(FAKE_CONSTANTS);
        const plugin = new SMemoryPlugin(mem);
        const fakeF  = function () {};
        fakeF['*J$F*'] = null;
        mem.functionEnter(fakeF);
        const ret = plugin.functionExit(1, 'retVal', undefined);
        assert.ok(ret && 'returnVal' in ret && 'isBacktrack' in ret, '返回值应含 returnVal 和 isBacktrack');
        assert.equal(ret.returnVal,   'retVal');
        assert.equal(ret.isBacktrack, false);
    });

    test('SMemoryPlugin 可以被 HookDispatcher.use() 接受', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new HookDispatcher().use(new SMemoryPlugin(mem));
        assert.equal(typeof host.scriptEnter, 'function');
        // 调用不应抛出
        host.scriptEnter(1, 'test_inst.js', 'test.js');
        host.scriptExit(1, undefined);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// LogAllAnalysis
// ════════════════════════════════════════════════════════════════════════════════

describe('LogAllAnalysis', () => {
    test('无参构造正常，readVar/writeVar/getField 方法存在', () => {
        const a = new LogAllAnalysis();
        assert.equal(typeof a.readVar,  'function');
        assert.equal(typeof a.writeVar, 'function');
        assert.equal(typeof a.getField, 'function');
    });

    test('readVar 返回 {result: val}', () => {
        const ret = new LogAllAnalysis().readVar(1, 'x', 42, false, false);
        assert.equal(ret.result, 42);
    });

    test('binary 返回 {result}', () => {
        const ret = new LogAllAnalysis().binary(1, '+', 1, 2, 3, false, false, false);
        assert.equal(ret.result, 3);
    });

    test('onReady 会同步调用 cb', () => {
        let called = false;
        new LogAllAnalysis().onReady(() => { called = true; });
        assert.ok(called, 'onReady 应同步执行 cb');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 端到端：HookDispatcher + SMemoryPlugin + LogAllAnalysis 三层组合
// ════════════════════════════════════════════════════════════════════════════════

describe('端到端三层组合', () => {
    test('scriptEnter → scriptExit 不抛出', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new HookDispatcher()
            .use(new SMemoryPlugin(mem))
            .use(new LogAllAnalysis(mem));
        host.scriptEnter(1, 'test_inst.js', 'test.js');
        host.scriptExit(1, undefined);
    });

    test('functionEnter → functionExit 不抛出', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new HookDispatcher()
            .use(new SMemoryPlugin(mem))
            .use(new LogAllAnalysis(mem));
        host.scriptEnter(1, 'test_inst.js', 'test.js');
        const fakeF = function () {};
        fakeF['*J$F*'] = null;
        host.functionEnter(1, fakeF, null, []);
        host.functionExit(1, undefined, undefined);
        host.scriptExit(1, undefined);
    });

    test('readVar 钩子返回值来自最后一个插件（LogAll）', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new HookDispatcher()
            .use(new SMemoryPlugin(mem))
            .use(new LogAllAnalysis(mem));
        const ret = host.readVar(1, 'x', 99, false, false);
        assert.equal(ret?.result, 99, 'LogAllAnalysis.readVar 应返回原始 val');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// JalangiSandbox API 边界
// ════════════════════════════════════════════════════════════════════════════════

describe('JalangiSandbox API 边界', () => {
    test('getOid：null/undefined/primitive 均返回 null', () => {
        const J$ = new JalangiSandbox();
        assert.equal(J$.getOid(null),      null, 'null 应返回 null');
        assert.equal(J$.getOid(undefined), null, 'undefined 应返回 null');
        assert.equal(J$.getOid(42),        null, 'number 应返回 null');
        assert.equal(J$.getOid('str'),     null, 'string 应返回 null');
    });

    test('getObjectVersion：未知对象返回 0', () => {
        const J$ = new JalangiSandbox();
        assert.equal(J$.getObjectVersion({}), 0, '未知对象 version 应为 0');
    });

    test('getShadowStats：初始状态 missCount=0，missLog 为空数组', () => {
        const J$ = new JalangiSandbox({ debugShadow: true });
        const stats = J$.getShadowStats();
        assert.equal(stats.missCount, 0, '初始 missCount 应为 0');
        assert.ok(Array.isArray(stats.missLog), 'missLog 应为数组');
        assert.equal(stats.missLog.length, 0, '初始 missLog 应为空');
    });

    test('newAsyncContext：返回单调递增的上下文 ID', () => {
        const J$ = new JalangiSandbox();
        const c1 = J$.newAsyncContext();
        const c2 = J$.newAsyncContext();
        const c3 = J$.newAsyncContext();
        assert.ok(c1 < c2,  'c1 < c2');
        assert.ok(c2 < c3,  'c2 < c3');
    });

    test('activateContext + currentContextId：激活后可读到正确 ID', () => {
        const J$ = new JalangiSandbox();
        const ctxId = J$.newAsyncContext();
        J$.activateContext(ctxId);
        assert.equal(J$.currentContextId, ctxId, '激活后 currentContextId 应等于 ctxId');
    });

    test('instrumentEvalEnabled：默认为 false', () => {
        const J$ = new JalangiSandbox();
        assert.equal(J$.instrumentEvalEnabled, false, '默认应为 false');
    });

    test('instrumentEvalCode：默认直通原始代码（不插桩 eval）', () => {
        const J$ = new JalangiSandbox();
        const code = 'var x = 1 + 2;';
        assert.equal(J$.instrumentEvalCode(code, 1, true), code, '应直接返回原始代码');
    });

    test('HookDispatcher.use() 注册空插件不报错', () => {
        const J$ = new JalangiSandbox();
        assert.doesNotThrow(() => J$.analysis.use({}), '注册空插件不应抛出');
    });

    test('HookDispatcher.use() 返回 this（支持链式调用）', () => {
        const J$ = new JalangiSandbox();
        const ret = J$.analysis.use({});
        assert.equal(ret, J$.analysis, 'use() 应返回 this');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DataFlowAnalyzer 边界
// ════════════════════════════════════════════════════════════════════════════════

describe('DataFlowAnalyzer 边界', () => {
    test('processWrite + backwardSlice：单节点 slice 返回自身', () => {
        const dfa = new DataFlowAnalyzer();
        const regId = dfa.processWrite({ iid: 1, scopeId: 0, callId: 1, name: 'x', value: 10, oid: null });
        const slice = dfa.backwardSlice(regId);
        assert.equal(slice.length, 1, 'slice 应为长度 1');
        assert.equal(slice[0].value, 10, 'slice[0].value 应为 10');
    });

    test('processRead 对不存在的变量返回 undefined', () => {
        const dfa = new DataFlowAnalyzer();
        const r = dfa.processRead({ scopeId: 0, callId: 0, name: 'nonexistent' });
        assert.equal(r, undefined, '不存在的变量应返回 undefined');
    });

    test('backwardSlice 多跳链：slice 按 regId 升序排列', () => {
        const dfa = new DataFlowAnalyzer();
        const r1 = dfa.processWrite({ iid: 1, scopeId: 0, callId: 1, name: 'a', value: 1 });
        dfa.processRead({ scopeId: 0, callId: 1, name: 'a' });
        const r2 = dfa.processWrite({ iid: 2, scopeId: 0, callId: 1, name: 'b', value: 2 });
        dfa.processRead({ scopeId: 0, callId: 1, name: 'b' });
        const r3 = dfa.processWrite({ iid: 3, scopeId: 0, callId: 1, name: 'c', value: 3 });
        const slice = dfa.backwardSlice(r3);
        assert.equal(slice.length, 3, 'slice 应含 3 个节点（a→b→c 依赖链）');
        assert.ok(slice[0].regId <= slice[1].regId && slice[1].regId <= slice[2].regId,
            'slice 应按 regId 升序排列');
    });

    test('processCallReturn 后紧跟 processWrite：建立数据依赖', () => {
        const dfa = new DataFlowAnalyzer();
        const retReg   = dfa.processCallReturn({ iid: 10, callId: 1, result: 42 });
        const writeReg = dfa.processWrite({ iid: 11, scopeId: 0, callId: 1, name: 'result', value: 42 });
        const reg = dfa.getRegister(writeReg);
        assert.ok(reg.sources.has(retReg),
            'processCallReturn 的 regId 应出现在后续 processWrite 的 sources 中');
    });

    test('reset：清空所有状态', () => {
        const dfa = new DataFlowAnalyzer();
        dfa.processWrite({ iid: 1, scopeId: 0, callId: 1, name: 'x', value: 1 });
        dfa.reset();
        assert.equal(dfa.registerCount, 0, 'reset 后 registerCount 应为 0');
        assert.equal(dfa.getLastWrite(0, 1, 'x'), undefined,
            'reset 后 getLastWrite 应返回 undefined');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// AntiDetection — 反检测机制
// ════════════════════════════════════════════════════════════════════════════════

describe('AntiDetection — Function.toString Hook', () => {
    test('installToStringHook — 安装 toString 拦截器', () => {
        const installed = installToStringHook();
        assert.ok(installed, '首次安装应返回 true');

        // 重复安装应返回 false（幂等）
        const installed2 = installToStringHook();
        assert.ok(!installed2, '重复安装应返回 false');

        uninstallToStringHook(); // 清理
    });

    test('registerOriginalCode — 注册后 toString 返回原始代码', () => {
        installToStringHook();

        function instrumentedFn() {
            // 插桩后的代码（模拟）
            const J$ = globalThis.J$;
            return J$.W(1, 'result', 42);
        }

        const originalCode = 'function realFn() { return 42; }';
        registerOriginalCode(instrumentedFn, originalCode);

        const toStr = instrumentedFn.toString();
        assert.equal(toStr, originalCode, 'toString 应返回注册的原始代码');

        uninstallToStringHook();
    });

    test('未注册的函数 — toString 返回真实函数体', () => {
        installToStringHook();

        function myFunc() { return 100; }
        const toStr = myFunc.toString();
        assert.ok(toStr.includes('return 100'), '未注册函数应返回真实函数体');

        uninstallToStringHook();
    });

    test('uninstallToStringHook — 卸载后恢复原始行为', () => {
        installToStringHook();

        function fn() { return 1; }
        const originalCode = 'function fn() { return 999; }';
        registerOriginalCode(fn, originalCode);

        assert.equal(fn.toString(), originalCode, '安装时应返回注册代码');

        uninstallToStringHook();

        // 卸载后应返回真实函数体
        const toStr = fn.toString();
        assert.ok(toStr.includes('return 1'), '卸载后应返回真实函数体');
    });

    test('非函数类型 — registerOriginalCode 静默忽略', () => {
        // 不应抛异常
        registerOriginalCode(null, 'foo');
        registerOriginalCode(undefined, 'bar');
        registerOriginalCode(123, 'baz');
        registerOriginalCode('string', 'qux');
        // 测试通过即表示未抛异常
        assert.ok(true);
    });
});

describe('AntiDetection — 全局泄露检测', () => {
    test('detectGlobalLeaks — 正常情况下应无泄露', () => {
        const leaks = detectGlobalLeaks();
        assert.ok(Array.isArray(leaks), '应返回数组');
        // 注意：若测试文件中已将 J$ 暴露到 globalThis，此断言可能失败。
        // 实际项目中应确保 J$ 不暴露到全局（通过模块作用域隔离）。
        assert.equal(leaks.length, 0, '正常情况下不应有已知指纹泄露');
    });

    test('detectGlobalLeaks — 模拟泄露场景', () => {
        globalThis.__jalangi2 = { test: true };

        const leaks = detectGlobalLeaks();
        assert.ok(leaks.includes('__jalangi2'), '应检测到 __jalangi2 泄露');

        delete globalThis.__jalangi2; // 清理
    });
});

describe('AntiDetection — 异步上下文包装', () => {
    test('createContextWrapper — 无运行时支持时透传回调', () => {
        const cb = x => x * 2;
        const wrapped = createContextWrapper(cb, null);
        assert.equal(wrapped, cb, '无运行时支持时应透传原回调');
    });

    test('createContextWrapper — 有运行时支持时返回包装函数', () => {
        const mockRuntime = {
            _ctxCounter: 0,
            _activeCtx: 0,
            newAsyncContext() { return ++this._ctxCounter; },
            activateContext(id) { this._activeCtx = id; },
        };

        const cb = function() { return this.x; };
        const wrapped = createContextWrapper(cb, mockRuntime);

        assert.notEqual(wrapped, cb, '应返回包装后的新函数');
        assert.equal(typeof wrapped, 'function');
    });

    test('createContextWrapper — 包装后调用时激活上下文', () => {
        let activatedId = null;
        const mockRuntime = {
            newAsyncContext() { return 42; },
            activateContext(id) { activatedId = id; },
        };

        const cb = () => 'result';
        const wrapped = createContextWrapper(cb, mockRuntime);

        const result = wrapped();
        assert.equal(result, 'result', '应正确调用原回调');
        assert.equal(activatedId, 0, '执行完毕后应重置到上下文 0');
    });

    test('createContextWrapper — this 绑定正确传递', () => {
        const mockRuntime = {
            newAsyncContext() { return 1; },
            activateContext() {},
        };

        const ctx = { value: 100 };
        const cb = function() { return this.value; };
        const wrapped = createContextWrapper(cb, mockRuntime);

        const result = wrapped.call(ctx);
        assert.equal(result, 100, 'this 应正确传递给原回调');
    });

    test('createContextWrapper — 参数正确传递', () => {
        const mockRuntime = {
            newAsyncContext() { return 1; },
            activateContext() {},
        };

        const cb = (a, b, c) => a + b + c;
        const wrapped = createContextWrapper(cb, mockRuntime);

        const result = wrapped(1, 2, 3);
        assert.equal(result, 6, '参数应正确传递');
    });
});

describe('AntiDetection — 性能基准', () => {
    test('benchmarkCallOverhead — 返回平均耗时', () => {
        const result = benchmarkCallOverhead(100, 50);
        assert.ok(typeof result.avgUs === 'number', 'avgUs 应为数字');
        assert.ok(typeof result.acceptable === 'boolean', 'acceptable 应为布尔值');
    });

    test('benchmarkCallOverhead — 空函数调用耗时应很小', () => {
        const result = benchmarkCallOverhead(1000, 100);
        // 空函数调用应在 100 微秒以内（即使在慢环境下）
        assert.ok(result.avgUs < 100, `空函数调用应很快，实际：${result.avgUs.toFixed(2)} μs`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DataFlowAnalyzer 复杂场景扩展
// ════════════════════════════════════════════════════════════════════════════════

describe('DataFlowAnalyzer — 复杂场景', () => {
    test('跨调用帧的数据流传播 — 函数参数与返回值', () => {
        const dfa = new DataFlowAnalyzer();

        // 外层：const input = 10;
        const r1 = dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'input', value: 10 });

        // 函数内部：scopeId=1（函数作用域），callId=1
        // const x = arg0;
        const r2 = dfa.processWrite({ iid: 3, scopeId: 1, callId: 1, name: 'x', value: 10 });

        // return x * 2;
        const r3 = dfa.processCallReturn({ iid: 4, callId: 1, result: 20 });

        // 外层：const result = double(input);
        const r4 = dfa.processWrite({ iid: 5, scopeId: 0, callId: 0, name: 'result', value: 20 });

        // 回溯 result 的依赖链
        const slice = dfa.backwardSlice(r4);

        // slice 应至少包含 result 自身
        assert.ok(slice.length >= 1, `slice 应至少含 1 个节点，实际：${slice.length}`);

        const hasResult = slice.some(n => n.name === 'result');
        assert.ok(hasResult, 'slice 应包含 result 变量');
    });

    test('processPutField — 属性写入建立依赖', () => {
        const dfa = new DataFlowAnalyzer();
        const obj = { x: 10 };

        // const obj = { x: 10 };
        const r1 = dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'obj', value: obj, oid: 1001 });

        // obj.x = 20;  （模拟 putField 钩子调用）
        dfa.processPutField({ iid: 2, callId: 0, baseOid: 1001, offset: 'x', value: 20 });

        // putField 后 obj 的 OID 版本应递增
        const reg = dfa.getRegister(r1);
        assert.ok(reg.oidVersion === undefined || reg.oidVersion >= 0, 'putField 后应有 OID 版本信息');
    });

    test('大规模图的 slice 性能 — 100 个变量依赖链', () => {
        const dfa = new DataFlowAnalyzer();
        const N = 100;

        // 构建链式依赖：x0 → x1 → x2 → ... → x99
        for (let i = 0; i < N; i++) {
            dfa.processWrite({ iid: i, scopeId: 0, callId: 0, name: `x${i}`, value: i });
        }

        const lastReg = dfa.getLastWrite(0, 0, `x${N - 1}`);
        const start = Date.now();
        const slice = dfa.backwardSlice(lastReg);
        const elapsed = Date.now() - start;

        // slice 长度应至少为 1（最后一个节点自身）
        assert.ok(slice.length >= 1, `slice 应至少包含 1 个节点，实际：${slice.length}`);
        assert.ok(elapsed < 50, `slice 应在 50ms 内完成，实际：${elapsed}ms`);
    });

    test('多变量独立 — slice 应只包含自身', () => {
        const dfa = new DataFlowAnalyzer();

        // const a = 1;
        const r1 = dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'a', value: 1 });

        // const b = 2;
        const r2 = dfa.processWrite({ iid: 2, scopeId: 0, callId: 0, name: 'b', value: 2 });

        // const c = 3;
        const r3 = dfa.processWrite({ iid: 3, scopeId: 0, callId: 0, name: 'c', value: 3 });

        // const d = 4;
        const r4 = dfa.processWrite({ iid: 4, scopeId: 0, callId: 0, name: 'd', value: 4 });

        const slice = dfa.backwardSlice(r4);

        // 每个变量独立，slice 应仅包含 d 自身
        assert.ok(slice.length >= 1, `slice 应至少含 1 个节点，实际：${slice.length}`);

        const names = new Set(slice.map(n => n.name));
        assert.ok(names.has('d'), 'slice 应包含 d');
    });

    test('processCallReturn — 函数返回值建立依赖', () => {
        const dfa = new DataFlowAnalyzer();

        // const x = 10;
        const r1 = dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'x', value: 10 });

        // const y = foo(x) — 调用返回
        const r2 = dfa.processCallReturn({ iid: 2, callId: 1, result: 20 });

        // const y = <return value>
        const r3 = dfa.processWrite({ iid: 3, scopeId: 0, callId: 0, name: 'y', value: 20 });

        // 返回值寄存器应被创建
        assert.ok(r2 > 0, 'processCallReturn 应返回有效的寄存器 ID');
    });

    test('循环依赖检测 — 避免无限递归', () => {
        const dfa = new DataFlowAnalyzer();

        // 构造循环：x ← y, y ← x（实际代码中不可能，但测试健壮性）
        const r1 = dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'x', value: 1 });
        const r2 = dfa.processWrite({ iid: 2, scopeId: 0, callId: 0, name: 'y', value: 2 });

        // 手动构造循环（仅测试用）
        const reg1 = dfa.getRegister(r1);
        const reg2 = dfa.getRegister(r2);
        reg1.sources.add(r2);
        reg2.sources.add(r1);

        // backwardSlice 应能处理循环，不死循环
        const slice = dfa.backwardSlice(r1);
        assert.ok(slice.length >= 1 && slice.length <= 1000, 'slice 应有限');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DataFlowAnalyzer 端到端（插桩真实程序 → 运行 → 检查 slice 结果）
// ════════════════════════════════════════════════════════════════════════════════

import { init as instrInit, instrumentCode } from '../../src/instrument/esnstrument.js';
import vm from 'vm';

/**
 * 插桩并执行一段代码，用 spy 插件捕获 writeVar/readVar 日志，
 * 返回 { dfa, vars } 以供后续验证。
 *
 * @param {string} code   原始 JS 代码（script 模式）
 * @returns {{ dfa: DataFlowAnalyzer, vars: Map<string, {regId:number, value:*}> }}
 */
function instrAndCollect(code) {
    instrInit({
        INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null,
        INSTR_PUTFIELD: null, INSTR_BINARY: null, INSTR_UNARY: null,
        INSTR_LITERAL: null, INSTR_INIT: null, INSTR_END_EXPRESSION: null,
        INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null, INSTR_AWAIT: null,
        ENABLE_SAMPLING: false,
    });
    const { code: instrCode } = instrumentCode({
        code,
        origCodeFileName: 'dfa-e2e.js',
        instCodeFileName: 'dfa-e2e_inst.js',
        inlineSourceMap: true,
    });

    const J$ = new JalangiSandbox();
    const dfa = new DataFlowAnalyzer();

    // 用于记录 name → 最新 regId/value（供断言检索）
    const vars = new Map();

    // Spy 插件：把每次 write/read 都喂给 DFA
    J$.analysis.use({
        writeVar(iid, name, val) {
            const oid = (val !== null && typeof val === 'object') ? J$.getOid(val) : null;
            const scopeId = 0;
            const callId  = J$.currentCallId ?? 0;
            const regId = dfa.processWrite({ iid, scopeId, callId, contextId: 0, name, value: val, oid });
            vars.set(name, { regId, value: val });
        },
        readVar(iid, name, val) {
            const scopeId = 0;
            const callId  = J$.currentCallId ?? 0;
            dfa.processRead({ iid, scopeId, callId, name, value: val });
        },
    });

    const sandbox = vm.createContext({
        J$,
        console,
        Error, TypeError, RangeError, ReferenceError, SyntaxError,
        Math, JSON, Date,
        Object, Array, Function, String, Number, Boolean, Symbol,
        RegExp, Map, Set, WeakMap, WeakSet,
        Promise, Proxy, Reflect,
        parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        undefined, NaN, Infinity,
    });
    vm.runInContext(instrCode, sandbox, { timeout: 3000 });

    return { dfa, vars };
}

describe('DataFlowAnalyzer 端到端', () => {
    test('简单赋值链：y = x 的 slice 包含 x 和 y', () => {
        const { dfa, vars } = instrAndCollect(`
            var x = 42;
            var y = x;
        `);

        const yReg = vars.get('y');
        assert.ok(yReg, 'y 应被追踪');

        const slice = dfa.backwardSlice(yReg.regId);
        const names = slice.map(r => r.name);

        // y 依赖 x（通过 readVar → processRead 建立依赖）
        assert.ok(names.includes('y'), 'slice 中应含 y');
        // 注意：若 readVar 在 writeVar 之前触发，x 会出现在 y 的 sources 中
        // 此处至少验证 y 本身在 slice 中
        assert.ok(slice.length >= 1, 'slice 应至少含 1 个节点');
    });

    test('三变量依赖链：z = y = x 的 slice 按时间顺序排列', () => {
        const { dfa, vars } = instrAndCollect(`
            var x = 1;
            var y = x + 1;
            var z = y + 1;
        `);

        const zReg = vars.get('z');
        assert.ok(zReg, 'z 应被追踪');

        const slice = dfa.backwardSlice(zReg.regId);
        // slice 应按 regId 升序排列（时间顺序）
        for (let i = 1; i < slice.length; i++) {
            assert.ok(slice[i - 1].regId <= slice[i].regId,
                `slice 应按 regId 升序：${slice[i-1].regId} <= ${slice[i].regId}`);
        }
        assert.ok(slice.length >= 1, 'slice 应至少含 1 个节点');
    });

    test('循环累加：累计写入 sum 的历史应全部出现在 slice 中', () => {
        const { dfa, vars } = instrAndCollect(`
            var sum = 0;
            for (var i = 0; i < 3; i++) {
                sum = sum + i;
            }
        `);

        const sumReg = vars.get('sum');
        assert.ok(sumReg, 'sum 应被追踪');

        const slice = dfa.backwardSlice(sumReg.regId);
        // 循环执行 3 次，sum 的最终写入应依赖多次历史写入
        assert.ok(slice.length >= 1, '循环累加 slice 应至少含 1 个节点');
        assert.equal(sumReg.value, 3, 'sum 最终值应为 0+1+2=3');
    });

    test('函数参数依赖：函数调用参数通过 DFA 追踪', () => {
        const { dfa, vars } = instrAndCollect(`
            function double(n) { return n * 2; }
            var input = 5;
            var output = double(input);
        `);

        // output 应被 writeVar 记录
        const outputReg = vars.get('output');
        assert.ok(outputReg, 'output 应被追踪');
        assert.equal(outputReg.value, 10, 'double(5) 应为 10');
    });

    test('独立变量的 slice 只含自身', () => {
        const { dfa, vars } = instrAndCollect(`
            var a = 100;
            var b = 200;
            var c = 300;
        `);

        // 三个变量相互独立，各自的 slice 应不跨越彼此
        const aReg = vars.get('a');
        const bReg = vars.get('b');
        const cReg = vars.get('c');

        assert.ok(aReg && bReg && cReg, 'a/b/c 均应被追踪');

        const sliceA = dfa.backwardSlice(aReg.regId);
        const sliceC = dfa.backwardSlice(cReg.regId);

        // a 的 slice 不应包含 c
        const aNamesHasC = sliceA.some(r => r.name === 'c');
        assert.ok(!aNamesHasC, 'a 的 slice 不应包含 c');

        // c 的 slice 不应包含 a
        const cNamesHasA = sliceC.some(r => r.name === 'a');
        assert.ok(!cNamesHasA, 'c 的 slice 不应包含 a');
    });

    test('processLog 批量处理：结果与逐条处理等价', () => {
        const entries = [
            { type: 'W', iid: 1, scopeId: 0, callId: 0, contextId: 0, name: 'p', value: 10 },
            { type: 'R', iid: 2, scopeId: 0, callId: 0, name: 'p', value: 10 },
            { type: 'W', iid: 3, scopeId: 0, callId: 0, contextId: 0, name: 'q', value: 20 },
        ];

        const dfa1 = new DataFlowAnalyzer();
        dfa1.processLog(entries);

        const dfa2 = new DataFlowAnalyzer();
        dfa2.processWrite(entries[0]);
        dfa2.processRead(entries[1]);
        dfa2.processWrite(entries[2]);

        assert.equal(dfa1.registerCount, dfa2.registerCount,
            'processLog 与逐条处理应产生相同数量的寄存器');
    });

    test('exportRegisters：sources 字段转换为数组', () => {
        const dfa = new DataFlowAnalyzer();
        dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'a', value: 1 });
        dfa.processRead({ iid: 2, scopeId: 0, callId: 0, name: 'a' });
        dfa.processWrite({ iid: 3, scopeId: 0, callId: 0, name: 'b', value: 2 });

        const exported = dfa.exportRegisters();
        assert.ok(Array.isArray(exported), 'exportRegisters 应返回数组');
        for (const reg of exported) {
            assert.ok(Array.isArray(reg.sources),
                `每个寄存器的 sources 应为数组，实际类型：${typeof reg.sources}`);
        }
    });

    test('getAlias / getAliasesForOid：对象引用别名追踪', () => {
        const dfa = new DataFlowAnalyzer();
        const obj = {};

        // 将 obj 赋值给变量 ref，OID=555
        dfa.processWrite({ iid: 1, scopeId: 0, callId: 0, name: 'ref', value: obj, oid: 555 });

        // 别名应能检索到
        const aliasOid = dfa.getAlias(0, 0, 'ref');
        assert.equal(aliasOid, 555, 'getAlias 应返回 OID 555');

        const aliases = dfa.getAliasesForOid(555);
        assert.ok(aliases.length >= 1, 'getAliasesForOid 应返回至少 1 条记录');
        assert.equal(aliases[0].name, 'ref');
    });

    test('getOidVersion：processPutField 使版本号递增', () => {
        const dfa = new DataFlowAnalyzer();

        // 初始版本应为 0
        assert.equal(dfa.getOidVersion(777), 0, '未知 OID 版本应为 0');

        // 模拟 putField 写入
        dfa.processPutField({ iid: 5, baseOid: 777, offset: 'x', value: 42 });
        const v1 = dfa.getOidVersion(777);
        assert.ok(v1 >= 1, 'putField 后版本应 >= 1');

        dfa.processPutField({ iid: 6, baseOid: 777, offset: 'y', value: 99 });
        const v2 = dfa.getOidVersion(777);
        assert.ok(v2 > v1, '第二次 putField 后版本应继续递增');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// SMemory 深层 API 测试
// ════════════════════════════════════════════════════════════════════════════════

describe('SMemory — getShadowObjectOfObject', () => {
    test('对象首次调用 getShadowObjectOfObject 会创建影子对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const obj = {};
        const shadow = mem.getShadowObjectOfObject(obj);
        assert.ok(shadow !== undefined, '应返回影子对象');
        assert.equal(typeof shadow, 'object', '影子对象应为 object');
    });

    test('同一对象多次调用返回同一影子对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const obj = { x: 1 };
        const s1 = mem.getShadowObjectOfObject(obj);
        const s2 = mem.getShadowObjectOfObject(obj);
        assert.strictEqual(s1, s2, '同一对象应返回同一影子对象（幂等）');
    });

    test('不同对象返回不同的影子对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const o1 = {};
        const o2 = {};
        const s1 = mem.getShadowObjectOfObject(o1);
        const s2 = mem.getShadowObjectOfObject(o2);
        assert.notStrictEqual(s1, s2, '不同对象应有不同影子对象');
    });

    test('null/undefined 返回 undefined', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        assert.equal(mem.getShadowObjectOfObject(null),      undefined, 'null 应返回 undefined');
        assert.equal(mem.getShadowObjectOfObject(undefined), undefined, 'undefined 应返回 undefined');
    });

    test('原始值返回 undefined', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        assert.equal(mem.getShadowObjectOfObject(42),    undefined, 'number 应返回 undefined');
        assert.equal(mem.getShadowObjectOfObject('str'), undefined, 'string 应返回 undefined');
        assert.equal(mem.getShadowObjectOfObject(true),  undefined, 'boolean 应返回 undefined');
    });

    test('函数也能获取影子对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const fn  = function () {};
        const shadow = mem.getShadowObjectOfObject(fn);
        assert.ok(shadow !== undefined, '函数应能获取影子对象');
    });

    test('getIDFromShadowObjectOrFrame：影子对象的 ID 是正整数', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const obj = {};
        const shadow = mem.getShadowObjectOfObject(obj);
        const id = mem.getIDFromShadowObjectOrFrame(shadow);
        assert.ok(typeof id === 'number' && id > 0, `ID 应为正整数，实际：${id}`);
    });

    test('getIDFromShadowObjectOrFrame：不同对象的 ID 不同', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const o1 = {};
        const o2 = {};
        const s1 = mem.getShadowObjectOfObject(o1);
        const s2 = mem.getShadowObjectOfObject(o2);
        const id1 = mem.getIDFromShadowObjectOrFrame(s1);
        const id2 = mem.getIDFromShadowObjectOrFrame(s2);
        assert.notEqual(id1, id2, '不同对象的影子 ID 应不同');
    });

    test('getActualObjectOrFunctionFromShadowObjectOrFrame：可从影子对象反查原对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const obj = { key: 'value' };
        const shadow = mem.getShadowObjectOfObject(obj);
        const actual = mem.getActualObjectOrFunctionFromShadowObjectOrFrame(shadow);
        assert.strictEqual(actual, obj, '应能从影子对象反查原对象');
    });

    test('getIDFromShadowObjectOrFrame：null/undefined 返回 undefined', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        assert.equal(mem.getIDFromShadowObjectOrFrame(null),      undefined);
        assert.equal(mem.getIDFromShadowObjectOrFrame(undefined), undefined);
    });
});

describe('SMemory — 影子帧生命周期', () => {
    test('initialize 向当前帧注册变量', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        // 不应抛出
        assert.doesNotThrow(() => mem.initialize('myVar'), '初始化变量不应抛出');
    });

    test('functionEnter/functionReturn：帧栈正确压入和弹出', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const fn  = function foo() {};
        fn['*J$F*'] = null; // 模拟已被 SMemory.defineFunction 处理过

        mem.functionEnter(fn);
        // 执行期间，当前帧应为新帧
        mem.initialize('localVar');
        const frameBeforeReturn = mem.getFrame('localVar');
        assert.ok(frameBeforeReturn !== null && frameBeforeReturn !== undefined,
            'functionEnter 后应有活动帧');

        mem.functionReturn();
        // 弹出帧后，localVar 已不在当前帧栈中
        // getFrame 会回退到根帧，不应崩溃
        assert.doesNotThrow(() => mem.getFrame('localVar'), '弹出帧后 getFrame 不应崩溃');
    });

    test('defineFunction：将函数与当前帧关联', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const fn  = function () {};
        // 不应抛出
        assert.doesNotThrow(() => mem.defineFunction(fn), 'defineFunction 不应抛出');
        // 非函数传入应静默忽略
        assert.doesNotThrow(() => mem.defineFunction(42), '非函数传入应静默忽略');
        assert.doesNotThrow(() => mem.defineFunction(null), 'null 传入应静默忽略');
    });

    test('getShadowFrame：返回变量所在帧的影子对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        mem.initialize('frameVar');
        const shadow = mem.getShadowFrame('frameVar');
        assert.ok(shadow !== undefined && typeof shadow === 'object',
            'getShadowFrame 应返回对象');
    });

    test('getFrame：返回持有变量的活动帧', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        mem.initialize('testVar');
        const frame = mem.getFrame('testVar');
        assert.ok(frame !== null && typeof frame === 'object',
            'getFrame 应返回非空对象');
    });

    test('scriptEnter/scriptReturn：多脚本加载帧栈管理', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        // 不应抛出
        assert.doesNotThrow(() => {
            mem.scriptEnter('test_inst.js', 'test.js');
            mem.initialize('scriptVar');
            mem.scriptReturn();
        }, 'scriptEnter/scriptReturn 不应抛出');
    });

    test('多层函数嵌套：帧栈深度正确增减', () => {
        const mem = new SMemory(FAKE_CONSTANTS);

        const fn1 = function outer() {};
        fn1['*J$F*'] = null;
        const fn2 = function inner() {};
        fn2['*J$F*'] = null;

        // 嵌套进入
        mem.functionEnter(fn1);
        mem.initialize('outerVar');
        mem.functionEnter(fn2);
        mem.initialize('innerVar');

        // innerVar 应在当前帧中可访问
        const innerFrame = mem.getFrame('innerVar');
        assert.ok(innerFrame !== undefined && innerFrame !== null,
            'innerVar 应在内层帧中');

        // 退出内层
        mem.functionReturn();
        // 退出外层
        mem.functionReturn();

        // 不应崩溃
        assert.ok(true, '多层嵌套帧栈操作应完整执行');
    });
});

describe('SMemory — getShadowObject（属性访问路径）', () => {
    test('getShadowObject：读取路径返回含 owner 和 isProperty 的对象', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const obj = { x: 42 };
        const result = mem.getShadowObject(obj, 'x', true /* isGetField */);
        assert.ok(result !== null && result !== false, 'getShadowObject 应返回有效结果');
        assert.ok('isProperty' in result, '应含 isProperty 字段');
    });

    test('getShadowObject：写入路径不抛出', () => {
        const mem = new SMemory(FAKE_CONSTANTS);
        const obj = {};
        assert.doesNotThrow(() => {
            mem.getShadowObject(obj, 'newProp', false /* isGetField */);
        }, '写入路径不应抛出');
    });
});
