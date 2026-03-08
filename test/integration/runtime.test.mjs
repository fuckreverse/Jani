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
        const expected = ['read', 'write', 'getField', 'putField', 'binary', 'unary',
            'functionEnter', 'functionExit', 'scriptEnter', 'scriptExit',
            'call', 'callPre', 'literal', 'conditional', 'endExecution'];
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
        assert.equal(host.read(1, 'x', 42, false, false), undefined);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// use() 注册插件
// ════════════════════════════════════════════════════════════════════════════════

describe('use() 注册插件', () => {
    test('use() 返回 this，支持链式语法', () => {
        const host = new HookDispatcher();
        assert.equal(host.use({ read: () => {} }), host);
    });

    test('use().use() 链式注册，顺序即执行顺序', () => {
        const order = [];
        new HookDispatcher()
            .use({ read: () => { order.push(1); } })
            .use({ read: () => { order.push(2); } })
            .read(1, 'x', undefined, false, false);
        assert.deepEqual(order, [1, 2]);
    });

    test('只注册插件中实现的 hook，未实现的不触发', () => {
        const calls = [];
        const host = new HookDispatcher()
            .use({ read: () => { calls.push('read'); } });
        host.read(1, 'x', undefined, false, false);
        host.write(1, 'x', 42, undefined, false, false);
        assert.deepEqual(calls, ['read'], '只有 read 被调用');
    });

    test('同一插件多次 use() 会导致重复调用', () => {
        const calls = [];
        const plugin = { read: () => { calls.push(1); } };
        new HookDispatcher().use(plugin).use(plugin).read(1, 'x', undefined, false, false);
        assert.deepEqual(calls, [1, 1], '重复注册应重复调用');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 链式值传递
// ════════════════════════════════════════════════════════════════════════════════

describe('链式值传递', () => {
    test('最后一个有返回值的插件决定最终返回值', () => {
        const host = new HookDispatcher()
            .use({ read: () => ({ result: 'first' }) })
            .use({ read: () => ({ result: 'last'  }) });
        assert.equal(host.read(1, 'x', undefined, false, false).result, 'last');
    });

    test('插件 A 返回 {result} 时，插件 B 看到修改后的值（链式传递语义）', () => {
        // HookDispatcher 的核心设计：前一个插件返回 { result: newVal }
        // 后续插件看到的对应参数会被替换为 newVal（链式 taint/shadow 传递）
        const seenByB = [];
        new HookDispatcher()
            .use({ read: (_iid, _name, _val) => ({ result: 'MODIFIED' }) })
            .use({ read: (_iid, _name, val)  => { seenByB.push(val); } })
            .read(1, 'x', 'original', false, false);
        assert.deepEqual(seenByB, ['MODIFIED'],
            '插件 B 应看到插件 A 修改后的值（链式传递是 HookDispatcher 的核心特性）');
    });

    test('插件 A 不返回时，插件 B 看到原始入参', () => {
        const seenByB = [];
        new HookDispatcher()
            .use({ read: () => { /* 不返回 */ } })
            .use({ read: (_iid, _name, val) => { seenByB.push(val); } })
            .read(1, 'x', 'original', false, false);
        assert.deepEqual(seenByB, ['original'], '插件 A 无返回时，插件 B 看到原始值');
    });

    test('返回 {args:[...]} 可替换后续插件的整体参数列表', () => {
        const seenByB = [];
        new HookDispatcher()
            .use({ read: (iid, _name, val, g, sl) => ({ result: val, args: [iid, 'replaced', val, g, sl] }) })
            .use({ read: (_iid, name) => { seenByB.push(name); } })
            .read(1, 'original', undefined, false, false);
        assert.deepEqual(seenByB, ['replaced']);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 异常处理
// ════════════════════════════════════════════════════════════════════════════════

describe('异常处理', () => {
    test('插件抛出异常时 rethrow（通过 onError 阻止 process.exit）', () => {
        const host = new HookDispatcher({ onError: () => {} });
        host.use({ read: () => { throw new Error('boom'); } });
        assert.throws(() => host.read(1, 'x', undefined, false, false), /boom/);
    });

    test('插件 A 抛出后不再调用插件 B', () => {
        const calledB = [];
        const host = new HookDispatcher({ onError: () => {} });
        host.use({ read: () => { throw new Error(); } });
        host.use({ read: () => { calledB.push(true); } });
        try { host.read(1, 'x', undefined, false, false); } catch (_) {}
        assert.deepEqual(calledB, [], '插件 B 不应被调用');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 实例独立性
// ════════════════════════════════════════════════════════════════════════════════

describe('实例独立性', () => {
    test('两个 HookDispatcher 实例互不影响', () => {
        const log1 = [], log2 = [];
        const h1 = new HookDispatcher().use({ read: () => { log1.push(1); } });
        const h2 = new HookDispatcher().use({ read: () => { log2.push(2); } });
        h1.read(1, 'x', undefined, false, false);
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
        for (const name of ['literal', 'declare', 'functionEnter', 'functionExit', 'scriptEnter', 'scriptExit']) {
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
    test('无参构造正常，read/write/getField 方法存在', () => {
        const a = new LogAllAnalysis();
        assert.equal(typeof a.read,     'function');
        assert.equal(typeof a.write,    'function');
        assert.equal(typeof a.getField, 'function');
    });

    test('read 返回 {result: val}', () => {
        const ret = new LogAllAnalysis().read(1, 'x', 42, false, false);
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

    test('read 钩子返回值来自最后一个插件（LogAll）', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new HookDispatcher()
            .use(new SMemoryPlugin(mem))
            .use(new LogAllAnalysis(mem));
        const ret = host.read(1, 'x', 99, false, false);
        assert.equal(ret?.result, 99, 'LogAllAnalysis.read 应返回原始 val');
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
