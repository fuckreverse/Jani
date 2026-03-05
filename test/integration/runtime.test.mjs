/**
 * test/integration/runtime.test.mjs — 运行时框架层单元测试
 *
 * 覆盖范围：
 *  - HOOKS 常量完整性
 *  - AnalysisHost：构造、use()、链式调度、值传递、异常处理、实例独立性
 *  - SMemory / SMemoryPlugin：ESM 导入、状态管理
 *  - LogAllAnalysis：ESM 导入、钩子返回值格式
 *  - 端到端：三层组合（AnalysisHost + SMemoryPlugin + LogAllAnalysis）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { AnalysisHost, HOOKS }   from '../../src/runtime/AnalysisHost.js';
import { SMemory, SMemoryPlugin } from '../../src/runtime/SMemory.js';
import { LogAllAnalysis }         from '../../src/plugins/tutorial/LogAll.js';

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
            'invokeFun', 'invokeFunPre', 'literal', 'conditional', 'endExecution'];
        for (const name of expected) {
            assert.ok(HOOKS.includes(name), `HOOKS 中应包含 "${name}"`);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// AnalysisHost 构造与基本行为
// ════════════════════════════════════════════════════════════════════════════════

describe('AnalysisHost 构造与基本行为', () => {
    test('new AnalysisHost() 构造后每个 hook 方法都存在', () => {
        const host = new AnalysisHost();
        for (const name of HOOKS) {
            assert.equal(typeof host[name], 'function', `host.${name} 应为函数`);
        }
    });

    test('未注册任何插件时，钩子调用返回 undefined', () => {
        const host = new AnalysisHost();
        assert.equal(host.read(1, 'x', 42, false, false), undefined);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// use() 注册插件
// ════════════════════════════════════════════════════════════════════════════════

describe('use() 注册插件', () => {
    test('use() 返回 this，支持链式语法', () => {
        const host = new AnalysisHost();
        assert.equal(host.use({ read: () => {} }), host);
    });

    test('use().use() 链式注册，顺序即执行顺序', () => {
        const order = [];
        new AnalysisHost()
            .use({ read: () => { order.push(1); } })
            .use({ read: () => { order.push(2); } })
            .read(1, 'x', undefined, false, false);
        assert.deepEqual(order, [1, 2]);
    });

    test('只注册插件中实现的 hook，未实现的不触发', () => {
        const calls = [];
        const host = new AnalysisHost()
            .use({ read: () => { calls.push('read'); } });
        host.read(1, 'x', undefined, false, false);
        host.write(1, 'x', 42, undefined, false, false);
        assert.deepEqual(calls, ['read'], '只有 read 被调用');
    });

    test('同一插件多次 use() 会导致重复调用', () => {
        const calls = [];
        const plugin = { read: () => { calls.push(1); } };
        new AnalysisHost().use(plugin).use(plugin).read(1, 'x', undefined, false, false);
        assert.deepEqual(calls, [1, 1], '重复注册应重复调用');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 链式值传递
// ════════════════════════════════════════════════════════════════════════════════

describe('链式值传递', () => {
    test('最后一个有返回值的插件决定最终返回值', () => {
        const host = new AnalysisHost()
            .use({ read: () => ({ result: 'first' }) })
            .use({ read: () => ({ result: 'last'  }) });
        assert.equal(host.read(1, 'x', undefined, false, false).result, 'last');
    });

    test('插件 A 返回 {result} 时，插件 B 看到修改后的值（链式传递语义）', () => {
        // AnalysisHost 的核心设计：前一个插件返回 { result: newVal }
        // 后续插件看到的对应参数会被替换为 newVal（链式 taint/shadow 传递）
        const seenByB = [];
        new AnalysisHost()
            .use({ read: (_iid, _name, _val) => ({ result: 'MODIFIED' }) })
            .use({ read: (_iid, _name, val)  => { seenByB.push(val); } })
            .read(1, 'x', 'original', false, false);
        assert.deepEqual(seenByB, ['MODIFIED'],
            '插件 B 应看到插件 A 修改后的值（链式传递是 AnalysisHost 的核心特性）');
    });

    test('插件 A 不返回时，插件 B 看到原始入参', () => {
        const seenByB = [];
        new AnalysisHost()
            .use({ read: () => { /* 不返回 */ } })
            .use({ read: (_iid, _name, val) => { seenByB.push(val); } })
            .read(1, 'x', 'original', false, false);
        assert.deepEqual(seenByB, ['original'], '插件 A 无返回时，插件 B 看到原始值');
    });

    test('返回 {args:[...]} 可替换后续插件的整体参数列表', () => {
        const seenByB = [];
        new AnalysisHost()
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
        const host = new AnalysisHost({ onError: () => {} });
        host.use({ read: () => { throw new Error('boom'); } });
        assert.throws(() => host.read(1, 'x', undefined, false, false), /boom/);
    });

    test('插件 A 抛出后不再调用插件 B', () => {
        const calledB = [];
        const host = new AnalysisHost({ onError: () => {} });
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
    test('两个 AnalysisHost 实例互不影响', () => {
        const log1 = [], log2 = [];
        const h1 = new AnalysisHost().use({ read: () => { log1.push(1); } });
        const h2 = new AnalysisHost().use({ read: () => { log2.push(2); } });
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

    test('SMemoryPlugin 可以被 AnalysisHost.use() 接受', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new AnalysisHost().use(new SMemoryPlugin(mem));
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
// 端到端：AnalysisHost + SMemoryPlugin + LogAllAnalysis 三层组合
// ════════════════════════════════════════════════════════════════════════════════

describe('端到端三层组合', () => {
    test('scriptEnter → scriptExit 不抛出', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new AnalysisHost()
            .use(new SMemoryPlugin(mem))
            .use(new LogAllAnalysis(mem));
        host.scriptEnter(1, 'test_inst.js', 'test.js');
        host.scriptExit(1, undefined);
    });

    test('functionEnter → functionExit 不抛出', () => {
        const mem  = new SMemory(FAKE_CONSTANTS);
        const host = new AnalysisHost()
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
        const host = new AnalysisHost()
            .use(new SMemoryPlugin(mem))
            .use(new LogAllAnalysis(mem));
        const ret = host.read(1, 'x', 99, false, false);
        assert.equal(ret?.result, 99, 'LogAllAnalysis.read 应返回原始 val');
    });
});
