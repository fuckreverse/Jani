/**
 * test/integration/hooks.test.mjs — 钩子调用验证 + 端到端分析插件测试
 *
 * 通过 Spy 插件验证各钩子被正确触发、参数正确；
 * 并测试分析插件可以修改/拦截运行时行为。
 *
 * 覆盖范围：
 *  - write / read / binary / getField / putField 钩子参数验证
 *  - functionEnter / functionExit / invokeFun 钩子触发
 *  - literal / conditional / scriptEnter / scriptExit / forinObject 钩子
 *  - 端到端：binary/write/getField 结果修改
 *  - 端到端：多插件链式执行顺序
 *  - 端到端：NaN 检测插件
 *  - 端到端：invokeFunPre skip 跳过函数调用
 *  - 端到端：_throw 观测异常
 *  - 端到端：iidToLocation 解析位置信息
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import { init, instrumentCode } from '../../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../../src/runtime/JalangiSandbox.js';
import { ALL_CONFIG, runInSandbox, createSpy } from '../helpers/shared-helpers.mjs';

// ─── 辅助：一步完成"带指定 Config 的插桩 + 沙盒执行" ──────────────────────────

function instrAndRunWith(config, code, fileName = 'test') {
    init(config);
    const { code: instrCode } = instrumentCode({
        code,
        origCodeFileName: `${fileName}.js`,
        instCodeFileName: `${fileName}_inst.js`,
        inlineSourceMap:  true,
    });
    const J$inst = new JalangiSandbox();
    const $out   = {};
    runInSandbox(instrCode, J$inst, { $out });
    return { instrCode, J$inst, $out };
}

// ════════════════════════════════════════════════════════════════════════════════
// Spy 钩子参数验证
// ════════════════════════════════════════════════════════════════════════════════

describe('Spy 钩子参数验证', () => {
    before(() => init({ ...ALL_CONFIG }));

    test('write 钩子被调用，参数含变量名和值', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var x = 42;', origCodeFileName: 'spy-write.js', instCodeFileName: 'spy-write_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('write');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const writeCalls = calls.get('write');
        assert.ok(writeCalls.length > 0, 'write 钩子应至少被调用一次');
        // write(iid, name, val, lhs, isGlobal, isScriptLocal)
        const xWrite = writeCalls.find(([_iid, name]) => name === 'x');
        assert.ok(xWrite !== undefined, 'write 钩子中应有变量 x 的写入');
        assert.equal(xWrite[2], 42, 'write 钩子传入的 val 应等于 42');
    });

    test('read 钩子被调用，参数含变量名和值', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var x = 10; var y = x + 1;', origCodeFileName: 'spy-read.js', instCodeFileName: 'spy-read_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('read');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const readCalls = calls.get('read');
        assert.ok(readCalls.length > 0, 'read 钩子应至少被调用一次');
        // read(iid, name, val, isGlobal, isScriptLocal)
        const xRead = readCalls.find(([_iid, name, val]) => name === 'x' && val === 10);
        assert.ok(xRead !== undefined, 'read 钩子中应有 x=10 的读取记录');
    });

    test('binary 钩子被调用，op 和操作数正确', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var r = 3 + 4;', origCodeFileName: 'spy-binary.js', instCodeFileName: 'spy-binary_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('binary');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const binCalls = calls.get('binary');
        // binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed)
        const addCall = binCalls.find(([_iid, op, left, right]) => op === '+' && left === 3 && right === 4);
        assert.ok(addCall !== undefined, 'binary 钩子应记录 3 + 4');
        assert.equal(addCall[4], 7, 'binary 钩子传入的 result 应等于 7');
    });

    test('getField 钩子被调用，base/offset 正确', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var obj = { val: 99 }; var v = obj.val;', origCodeFileName: 'spy-getfield.js', instCodeFileName: 'spy-getfield_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('getField');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const gfCalls = calls.get('getField');
        // getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall)
        const valRead = gfCalls.find(([_iid, base, offset]) =>
            offset === 'val' && typeof base === 'object' && base !== null);
        assert.ok(valRead !== undefined, 'getField 钩子应记录 obj.val 的读取');
        assert.equal(valRead[3], 99, 'getField 传入的 val 应等于 99');
    });

    test('putField 钩子被调用，属性写入正确', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var obj = {}; obj.name = "jalangi";', origCodeFileName: 'spy-putfield.js', instCodeFileName: 'spy-putfield_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('putField');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const pfCalls = calls.get('putField');
        // putField(iid, base, offset, val, isComputed, isOpAssign)
        const nameWrite = pfCalls.find(([_iid, _base, offset, val]) =>
            offset === 'name' && val === 'jalangi');
        assert.ok(nameWrite !== undefined, 'putField 钩子应记录 obj.name = "jalangi"');
    });

    test('functionEnter/functionExit 钩子在函数调用时触发', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'function greet(name) { return "Hello " + name; } var r = greet("test");', origCodeFileName: 'spy-fe.js', instCodeFileName: 'spy-fe_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('functionEnter', 'functionExit');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        assert.ok(calls.get('functionEnter').length >= 1, 'functionEnter 应至少触发一次');
        assert.ok(calls.get('functionExit').length >= 1,  'functionExit 应至少触发一次');
    });

    test('invokeFun 钩子记录函数调用结果', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'function square(n) { return n * n; } var r = square(5);', origCodeFileName: 'spy-invoke.js', instCodeFileName: 'spy-invoke_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('invokeFun');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        // invokeFun(iid, f, base, args, result, isConstructor, isMethod, ...)
        const invCalls = calls.get('invokeFun');
        const squareCall = invCalls.find(([_iid, _f, _base, args, result]) =>
            Array.isArray(args) && args[0] === 5 && result === 25);
        assert.ok(squareCall !== undefined, 'invokeFun 钩子应记录 square(5) 返回 25');
    });

    test('literal 钩子对对象字面量触发', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var obj = { a: 1, b: 2 };', origCodeFileName: 'spy-literal.js', instCodeFileName: 'spy-literal_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('literal');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        // literal(iid, val, hasGetterSetter)
        const litCalls = calls.get('literal');
        const objLit = litCalls.find(([_iid, val]) =>
            val !== null && typeof val === 'object' && 'a' in val && 'b' in val);
        assert.ok(objLit !== undefined, 'literal 钩子应记录对象字面量 { a:1, b:2 }');
    });

    test('conditional 钩子在三元运算时触发', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var x = 5; var r = (x > 3) ? "big" : "small"; $out.r = r;', origCodeFileName: 'spy-cond.js', instCodeFileName: 'spy-cond_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('conditional');
        J$inst.analysis.use(plugin);
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });

        assert.ok(calls.get('conditional').length > 0, 'conditional 钩子应至少触发一次');
        assert.equal($out.r, 'big', '三元运算结果应为 "big"');
    });

    test('scriptEnter/scriptExit 在脚本执行时触发各一次', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var z = 1;', origCodeFileName: 'spy-script.js', instCodeFileName: 'spy-script_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('scriptEnter', 'scriptExit');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        assert.equal(calls.get('scriptEnter').length, 1, 'scriptEnter 应触发一次');
        assert.equal(calls.get('scriptExit').length,  1, 'scriptExit 应触发一次');
    });

    test('forinObject 在 for-in 时触发，val 是被枚举对象', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({ code: 'var obj = {a:1, b:2}; var keys=[]; for (var k in obj) keys.push(k);', origCodeFileName: 'spy-forin.js', instCodeFileName: 'spy-forin_inst.js', inlineSourceMap: true });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('forinObject');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const foCalls = calls.get('forinObject');
        assert.ok(foCalls.length > 0, 'forinObject 钩子应至少触发一次');
        // forinObject(iid, val) — val 应是被枚举的对象
        const objCall = foCalls.find(([_iid, val]) =>
            val !== null && typeof val === 'object' && 'a' in val);
        assert.ok(objCall !== undefined, 'forinObject 传入的 val 应是被枚举的对象');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 端到端分析插件场景
// ════════════════════════════════════════════════════════════════════════════════

describe('端到端分析插件场景', () => {
    test('分析插件可修改 binary 结果（拦截 + 覆盖）', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var r = 3 + 4; $out.r = r;',
            origCodeFileName: 'e2e-modify.js',
            instCodeFileName: 'e2e-modify_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        J$inst.analysis.use({
            binary(_iid, op, _left, _right, result) {
                if (op === '+') return { result: result * 2 };
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.r, 14, '分析插件应将 3+4=7 翻倍为 14');
    });

    test('分析插件可修改 write 结果（污点标记模拟）', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var x = 5; $out.x = x;',
            origCodeFileName: 'e2e-write.js',
            instCodeFileName: 'e2e-write_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        J$inst.analysis.use({
            write(_iid, name, val) {
                if (name === 'x') return { result: val + 1000 };
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.x, 1005, '分析插件应将 x=5 改写为 x=1005');
    });

    test('分析插件可拦截 getField（属性读取重写）', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var obj = { val: 10 }; var r = obj.val; $out.r = r;',
            origCodeFileName: 'e2e-getfield.js',
            instCodeFileName: 'e2e-getfield_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        J$inst.analysis.use({
            getField(_iid, _base, offset, val) {
                if (offset === 'val') return { result: val * 3 };
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.r, 30, '分析插件应将 obj.val=10 改写为 30');
    });

    test('多个分析插件链式注册，按序执行', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var x = 1;',
            origCodeFileName: 'e2e-chain.js',
            instCodeFileName: 'e2e-chain_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        const log = [];
        J$inst.analysis
            .use({ write: () => { log.push('A'); } })
            .use({ write: () => { log.push('B'); } })
            .use({ write: () => { log.push('C'); } });
        runInSandbox(instrCode, J$inst);
        // 三个插件对同一个 write 均触发，且按注册顺序
        assert.ok(log.includes('A') && log.includes('B') && log.includes('C'),
            '三个链式插件都应被触发');
        const firstA = log.indexOf('A');
        const firstB = log.indexOf('B');
        const firstC = log.indexOf('C');
        assert.ok(firstA < firstB && firstB < firstC, '链式插件应按注册顺序执行');
    });

    test('NaN 检测分析（类 CheckNaN 插件）', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var x = NaN; var r = x + 1;',
            origCodeFileName: 'e2e-nan.js',
            instCodeFileName: 'e2e-nan_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        const violations = [];
        J$inst.analysis.use({
            binary(_iid, op, left, right, result) {
                if (Number.isNaN(left) || Number.isNaN(right) || Number.isNaN(result)) {
                    violations.push({ op, left, right, result });
                }
            }
        });
        runInSandbox(instrCode, J$inst);
        assert.ok(violations.length > 0, 'NaN 检测插件应记录到 NaN 参与的运算');
        assert.equal(violations[0].op, '+', '违规运算符应为 +');
    });

    test('invokeFunPre 可跳过函数调用（skip=true）', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: `
                function square(n) { return n * n; }
                var r = square(5);
                $out.r = r;
            `,
            origCodeFileName: 'e2e-skip.js',
            instCodeFileName: 'e2e-skip_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        J$inst.analysis.use({
            invokeFunPre(_iid, f, base, args) {
                if (f && f.name === 'square') return { f, base, args, skip: true };
            },
            invokeFun(_iid, f, _base, _args, _result) {
                if (f && f.name === 'square') return { result: 999 };
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.r, 999, 'invokeFunPre skip=true 后 r 应被改写为 999');
    });

    test('_throw 在 try-catch 中被分析插件观测', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: `
                var caught = null;
                try { throw new Error('test-error'); }
                catch(e) { caught = e.message; }
                $out.caught = caught;
            `,
            origCodeFileName: 'e2e-throw.js',
            instCodeFileName: 'e2e-throw_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        const throwEvents = [];
        J$inst.analysis.use({
            _throw(_iid, val) { throwEvents.push(val); }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.caught, 'test-error', 'catch 应捕获抛出的异常');
        assert.ok(throwEvents.length > 0,          '_throw 钩子应被触发');
        assert.ok(throwEvents[0] instanceof Error,  '_throw 钩子传入的应是 Error 实例');
    });

    test('iidToLocation 能解析插桩位置信息', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var x = 1 + 2;',
            origCodeFileName: 'e2e-iidloc.js',
            instCodeFileName: 'e2e-iidloc_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        const binaryIids = [];
        J$inst.analysis.use({
            binary(iid) { binaryIids.push(iid); }
        });
        runInSandbox(instrCode, J$inst);

        assert.ok(binaryIids.length > 0, '应记录到 binary 的 iid');
        // Se() 执行后 J$.sid 会 rollback，应使用 J$.lastSid 获取最近执行的脚本 ID
        const sid = J$inst.lastSid;
        assert.ok(typeof sid === 'number' && sid > 0, 'lastSid 应为正整数');
        // iidToLocation 返回格式化字符串，如 "(e2e-iidloc.js:1:8:1:13)"
        const loc = J$inst.iidToLocation(sid, binaryIids[0]);
        assert.ok(typeof loc === 'string' && loc.length > 0, 'iidToLocation 应返回非空字符串');
        assert.ok(loc.includes('e2e-iidloc.js'), 'iidToLocation 应包含文件名');
        // 字符串格式为 "(filename:startLine:startCol:endLine:endCol)"
        const match = loc.match(/\((.*?):(\d+):(\d+):(\d+):(\d+)\)/);
        assert.ok(match !== null, 'iidToLocation 字符串应匹配 (file:line:col:line:col) 格式');
        assert.ok(parseInt(match[2]) >= 1, 'startLine 应 >= 1');
    });
});
