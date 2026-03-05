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

    test('unary 钩子被调用，op 和操作数正确', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({
                code: 'var x = 5; var neg = -x; var notX = !true;',
                origCodeFileName: 'spy-unary.js',
                instCodeFileName: 'spy-unary_inst.js',
                inlineSourceMap: true,
            });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('unary');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const unaryCalls = calls.get('unary');
        assert.ok(unaryCalls.length > 0, 'unary 钩子应至少触发一次');
        // unary(iid, op, left, result)
        const negCall = unaryCalls.find(([_iid, op, arg]) => op === '-' && arg === 5);
        assert.ok(negCall !== undefined, 'unary 钩子应记录 -x（x=5）');
        assert.equal(negCall[3], -5, 'unary 钩子的 result 应等于 -5');

        const notCall = unaryCalls.find(([_iid, op, arg]) => op === '!' && arg === true);
        assert.ok(notCall !== undefined, 'unary 钩子应记录 !true');
        assert.equal(notCall[3], false, 'unary 钩子的 result 应等于 false');
    });

    test('declare 钩子被调用，函数参数可正确识别', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({
                code: 'function add(a, b) { var c = a + b; return c; } add(3, 7);',
                origCodeFileName: 'spy-declare.js',
                instCodeFileName: 'spy-declare_inst.js',
                inlineSourceMap: true,
            });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('declare');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const declareCalls = calls.get('declare');
        assert.ok(declareCalls.length > 0, 'declare 钩子应至少触发一次');
        // declare(iid, name, val, isArgument, argumentIndex, isCatchParam)
        // 验证：参数 a=3，isArgument=true，argumentIndex 应为 0
        const aDecl = declareCalls.find(([_iid, name, val, isArg]) =>
            name === 'a' && val === 3 && isArg === true);
        assert.ok(aDecl !== undefined, 'declare 钩子应记录形参 a=3（isArgument=true）');
        assert.equal(aDecl[4], 0, '形参 a 的 argumentIndex 应为 0');

        // 参数 b=7，isArgument=true，argumentIndex 应为 1
        const bDecl = declareCalls.find(([_iid, name, val, isArg]) =>
            name === 'b' && val === 7 && isArg === true);
        assert.ok(bDecl !== undefined, 'declare 钩子应记录形参 b=7（isArgument=true）');
        assert.equal(bDecl[4], 1, '形参 b 的 argumentIndex 应为 1');

        // 局部变量 c，isArgument=false
        const cDecl = declareCalls.find(([_iid, name, _val, isArg]) =>
            name === 'c' && isArg === false);
        assert.ok(cDecl !== undefined, 'declare 钩子应记录局部变量 c（isArgument=false）');
    });

    test('_return 钩子在函数返回时触发，val 正确', () => {
        const { code: instrCode } = (() => {
            init({ ...ALL_CONFIG });
            return instrumentCode({
                code: 'function double(n) { return n * 2; } var r = double(6);',
                origCodeFileName: 'spy-return.js',
                instCodeFileName: 'spy-return_inst.js',
                inlineSourceMap: true,
            });
        })();
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('_return');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const retCalls = calls.get('_return');
        assert.ok(retCalls.length > 0, '_return 钩子应至少触发一次');
        // _return(iid, val) — val 应是实际返回值
        const ret12 = retCalls.find(([_iid, val]) => val === 12);
        assert.ok(ret12 !== undefined, '_return 钩子应记录 double(6) 的返回值 12');
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

    test('putFieldPre 可拦截并修改属性写入值（在实际写入前）', () => {
        // putField  是后置钩子：实际写入已发生，修改其 result 不影响对象属性。
        // putFieldPre 是前置钩子：可通过修改 val 来改变写入到对象的值。
        // 注意：$out.xxx 赋值也会触发 putFieldPre，需通过标记区分目标对象。
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: `
                var obj = {};
                obj.__target = true;      // 打标记，用于区分 obj 和 $out
                obj.score = 50;
                $out.score = obj.score;   // 读 obj.score 再写到 $out（$out 不被拦截）
            `,
            origCodeFileName: 'e2e-putfieldpre.js',
            instCodeFileName: 'e2e-putfieldpre_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        // 只拦截有 __target 标记的对象的 score 属性
        J$inst.analysis.use({
            putFieldPre(_iid, base, offset, val) {
                if (base && base.__target && offset === 'score') {
                    return { base, offset, val: val * 2, skip: false };
                }
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.score, 100, 'putFieldPre 应将 obj.score=50 改写为 100');
    });

    test('putField（后置）钩子被触发，Spy 正确记录写入参数', () => {
        // putField 是后置观察钩子，不能修改对象属性值，但可以观察写入行为。
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var obj = {}; obj.a = 1; obj.b = 2; obj.c = 3;',
            origCodeFileName: 'e2e-putfield-spy.js',
            instCodeFileName: 'e2e-putfield-spy_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox();
        const { plugin, calls } = createSpy('putField');
        J$inst.analysis.use(plugin);
        runInSandbox(instrCode, J$inst);

        const pfCalls = calls.get('putField');
        assert.ok(pfCalls.length >= 3, 'putField 应至少被调用 3 次（a/b/c 各一次）');
        // putField(iid, base, offset, val, isComputed, isOpAssign)
        const aWrite = pfCalls.find(([_iid, _base, offset, val]) => offset === 'a' && val === 1);
        const bWrite = pfCalls.find(([_iid, _base, offset, val]) => offset === 'b' && val === 2);
        const cWrite = pfCalls.find(([_iid, _base, offset, val]) => offset === 'c' && val === 3);
        assert.ok(aWrite !== undefined, 'putField 应记录 obj.a = 1');
        assert.ok(bWrite !== undefined, 'putField 应记录 obj.b = 2');
        assert.ok(cWrite !== undefined, 'putField 应记录 obj.c = 3');
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

// ════════════════════════════════════════════════════════════════════════════════
// observeOnly 模式验证
// ════════════════════════════════════════════════════════════════════════════════

describe('observeOnly 模式', () => {
    // 公共插桩代码生成：var x = 1 + 2; $out.x = x;
    function makeInstrCode(fileName = 'observe-only') {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var x = 1 + 2; $out.x = x;',
            origCodeFileName: `${fileName}.js`,
            instCodeFileName: `${fileName}_inst.js`,
            inlineSourceMap: true,
        });
        return instrCode;
    }

    test('observeOnly=false（默认）：插件返回 result 可修改执行结果', () => {
        // 标准模式：binary 钩子返回 { result: 999 } 应覆盖 1+2 的结果
        const instrCode = makeInstrCode('observe-false');
        const J$inst = new JalangiSandbox(); // 默认 observeOnly=false
        assert.equal(J$inst.analysis.observeOnly, false, 'observeOnly 默认应为 false');
        J$inst.analysis.use({
            binary(_iid, _op, _l, _r, _result) { return { result: 999 }; }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.x, 999, '标准模式下 binary 钩子返回的 result 应生效');
    });

    test('observeOnly=true：插件返回 result 被忽略，原始计算结果不变', () => {
        // observeOnly 模式：binary 钩子返回 { result: 999 } 应被框架忽略
        const instrCode = makeInstrCode('observe-true');
        const J$inst = new JalangiSandbox({ observeOnly: true });
        assert.equal(J$inst.analysis.observeOnly, true, 'observeOnly 应为 true');
        J$inst.analysis.use({
            binary(_iid, _op, _l, _r, _result) { return { result: 999 }; }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.x, 3, 'observeOnly 模式下 binary 钩子的 result 被忽略，1+2 仍应为 3');
    });

    test('observeOnly=true：插件仍能观察到所有事件（钩子被正常调用）', () => {
        // 验证钩子仍被调用，只是返回值无效
        const instrCode = makeInstrCode('observe-spy');
        const J$inst = new JalangiSandbox({ observeOnly: true });
        const binaryCalls = [];
        J$inst.analysis.use({
            binary(iid, op, left, right, result) {
                binaryCalls.push({ iid, op, left, right, result });
                return { result: 999 }; // 这个返回值应被忽略
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.ok(binaryCalls.length > 0, 'binary 钩子应被正常调用');
        assert.equal(binaryCalls[0].op, '+',  '钩子参数 op 应为 "+"');
        assert.equal(binaryCalls[0].left, 1,  '钩子参数 left 应为 1');
        assert.equal(binaryCalls[0].right, 2, '钩子参数 right 应为 2');
        assert.equal(binaryCalls[0].result, 3, '钩子参数 result 应为原始计算结果 3');
        assert.equal($out.x, 3, '原始程序结果 x 应仍为 3，未被插件修改');
    });

    test('observeOnly=true：write 钩子返回 result 被忽略，变量赋值不受影响', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var y = 42; $out.y = y;',
            origCodeFileName: 'observe-write.js',
            instCodeFileName: 'observe-write_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox({ observeOnly: true });
        J$inst.analysis.use({
            // 试图将所有变量写入值改为 0
            write(_iid, _name, _val) { return { result: 0 }; }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.y, 42, 'observeOnly 模式下 write 钩子的 result 被忽略，y 仍应为 42');
    });

    test('observeOnly=true：invokeFunPre skip=true 被忽略，函数正常调用', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'function double(n) { return n * 2; } $out.r = double(5);',
            origCodeFileName: 'observe-skip.js',
            instCodeFileName: 'observe-skip_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox({ observeOnly: true });
        J$inst.analysis.use({
            // 试图跳过 double 函数的调用
            invokeFunPre(_iid, f, base, args) {
                if (f && f.name === 'double') return { f, base, args, skip: true };
            },
            invokeFun(_iid, f) {
                if (f && f.name === 'double') return { result: -1 };
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.r, 10, 'observeOnly 模式下 invokeFunPre skip 被忽略，double(5) 应正常执行返回 10');
    });

    test('observeOnly=true：getField 钩子返回 result 被忽略，属性读取不受影响', () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var obj = { a: 7 }; $out.v = obj.a;',
            origCodeFileName: 'observe-getfield.js',
            instCodeFileName: 'observe-getfield_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox({ observeOnly: true });
        J$inst.analysis.use({
            getField(_iid, _base, offset) {
                if (offset === 'a') return { result: 999 };
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.v, 7, 'observeOnly 模式下 getField 的 result 被忽略，obj.a 仍应为 7');
    });

    test('observeOnly=true：多插件链中各插件返回值均被忽略', () => {
        // 验证链式分发中 observeOnly 对所有插件统一生效
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var z = 10 - 3; $out.z = z;',
            origCodeFileName: 'observe-chain.js',
            instCodeFileName: 'observe-chain_inst.js',
            inlineSourceMap: true,
        });
        const J$inst = new JalangiSandbox({ observeOnly: true });
        const calls1 = [], calls2 = [];
        J$inst.analysis
            .use({ binary(_iid, _op, l, r) { calls1.push([l, r]); return { result: 100 }; } })
            .use({ binary(_iid, _op, l, r, result) { calls2.push([l, r, result]); return { result: 200 }; } });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        // 两个插件均被调用
        assert.ok(calls1.length > 0, '插件 1 的 binary 钩子应被调用');
        assert.ok(calls2.length > 0, '插件 2 的 binary 钩子应被调用');
        // observeOnly 下链式传值也被忽略：插件 2 看到的 result 应为原始值 7，而非插件 1 的 100
        assert.equal(calls2[0][2], 7, 'observeOnly 下链式 result 传递被阻断，插件 2 应看到原始 result=7');
        // 最终程序结果不受两个插件影响
        assert.equal($out.z, 7, 'observeOnly 模式下 10-3 仍应为 7');
    });

    test('observeOnly 可在 AnalysisHost 直接实例化时使用', async () => {
        // 直接 new AnalysisHost({ observeOnly: true }) 而非通过 JalangiSandbox 透传
        const { AnalysisHost } = await import('../../src/runtime/AnalysisHost.js');
        const host = new AnalysisHost({ observeOnly: true });
        assert.equal(host.observeOnly, true, 'AnalysisHost 构造后 observeOnly 应为 true');
        // 注册一个试图修改值的插件
        let called = false;
        host.use({ read(_iid, _name, val) { called = true; return { result: 999 }; } });
        // 直接调用 read 分发器：原始 val=5，插件试图改为 999
        const ret = host.read(1, 'x', 5, false, false);
        assert.ok(called, 'read 钩子应被调用');
        // observeOnly 下返回值被忽略，调度器本身返回值也为 undefined（不再是插件的返回对象）
        assert.equal(ret, undefined, 'observeOnly 模式下调度器返回 undefined（插件返回值被丢弃）');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// instrumentEval 选项验证
// ════════════════════════════════════════════════════════════════════════════════

describe('instrumentEval 选项', () => {

    // 公共插桩代码生成：运行 eval（注意：不在代码中声明 var $out，由外部沙盒注入）
    function makeEvalInstrCode(fileName = 'eval-test') {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             '$out.result = eval("1 + 2");',
            origCodeFileName: `${fileName}.js`,
            instCodeFileName: `${fileName}_inst.js`,
            inlineSourceMap:  true,
        });
        return instrCode;
    }

    test('instrumentEval=false（默认）：eval 直接透传，不插桩动态代码', () => {
        // 默认模式：eval("1 + 2") 不经过 instrumentEvalCode，直接执行原始代码
        const instrCode = makeEvalInstrCode('eval-false');
        const J$inst = new JalangiSandbox(); // 默认 instrumentEval=false
        assert.equal(J$inst.instrumentEvalEnabled, false, 'instrumentEvalEnabled 默认应为 false');
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.result, 3, 'eval("1 + 2") 应返回 3');
    });

    test('instrumentEval=false（默认）：eval 不触发 instrumentCodePre 钩子', () => {
        // 默认模式下，eval 内容不经过插桩器，instrumentCodePre 不应被调用
        const instrCode = makeEvalInstrCode('eval-no-hook');
        const J$inst = new JalangiSandbox();
        let hookCalled = false;
        J$inst.analysis.use({
            instrumentCodePre(_iid, _code, _isDirect) {
                hookCalled = true;
            }
        });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal(hookCalled, false, 'instrumentEval=false 时 instrumentCodePre 不应被调用');
    });

    test('instrumentEval=true：instrumentEvalEnabled 标志被正确设置，instrumentEvalCode 可注入真正的插桩函数', async () => {
        // 验证：
        //   1. instrumentEval=true 时，instrumentEvalEnabled 标志为 true
        //   2. 可以将 instrumentEvalCode 替换为真正的插桩函数
        //   3. eval 的参数会被该函数处理（而非直通），返回插桩后的代码字符串
        const J$inst = new JalangiSandbox({ instrumentEval: true });
        assert.equal(J$inst.instrumentEvalEnabled, true, 'instrumentEvalEnabled 应为 true');

        // 注入真正的插桩函数，并拦截其调用以验证行为
        const { init: instrInit, instrumentEvalCode } = await import('../../src/instrument/esnstrument.js');
        instrInit({ ...ALL_CONFIG });
        J$inst.instrumentEvalCode = instrumentEvalCode;

        let processedCode = null;
        const realFn = instrumentEvalCode;
        J$inst.instrumentEvalCode = (code, iid, isDirect) => {
            const result = realFn(code, iid, isDirect);
            processedCode = result;
            return result;
        };

        // 用一段简单的 eval 触发 instrumentEvalCode
        const instrCode = makeEvalInstrCode('eval-true');
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });

        // 验证真正的插桩函数被调用，且返回插桩后的代码（包含 J$.Se 等特征标识）
        assert.ok(processedCode !== null, '注入的 instrumentEvalCode 应被调用');
        assert.ok(processedCode.includes('J$.Se'), '插桩后代码应包含 J$.Se 脚本进入钩子');
        assert.ok(processedCode.includes('J$.Sr'), '插桩后代码应包含 J$.Sr 脚本退出钩子');
    });

    test('instrumentEvalEnabled 可在运行时直接切换', () => {
        // 验证 instrumentEvalEnabled 是公开字段，可在构造后动态赋值
        const J$inst = new JalangiSandbox();
        assert.equal(J$inst.instrumentEvalEnabled, false, '默认为 false');
        J$inst.instrumentEvalEnabled = true;
        assert.equal(J$inst.instrumentEvalEnabled, true, '动态切换后应为 true');
        J$inst.instrumentEvalEnabled = false;
        assert.equal(J$inst.instrumentEvalEnabled, false, '切换回 false 应成功');
    });

    test('new Function 默认不被插桩（instrumentEval=false）', () => {
        // 默认不对 new Function 创建的代码进行插桩
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             'var fn = new Function("return 10 + 5;"); $out.result = fn();',
            origCodeFileName: 'new-func-false.js',
            instCodeFileName: 'new-func-false_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox({ instrumentEval: false });
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.result, 15, 'instrumentEval=false 时 new Function 创建的函数应正常执行返回 15');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 框架层语义保证（L2 observeOnly 修复验证）
// ════════════════════════════════════════════════════════════════════════════════

describe('框架层语义保证（L2 observeOnly 修复）', () => {

    test('P0：observeOnly=true 下 functionExit isBacktrack=true 被忽略，不会死循环', () => {
        // 若插件 functionExit 返回 isBacktrack=true，observeOnly 下应被强制忽略
        // 原始骨架：while(true){ try{...} finally{ if(J$.Fr()) continue; else return J$.Ra(); } }
        // observeOnly 修复后 Fr() 强制返回 false，不进入 continue 分支
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             'function f(x) { return x * 2; } $out.r = f(7);',
            origCodeFileName: 'backtrack-guard.js',
            instCodeFileName: 'backtrack-guard_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox({ observeOnly: true });
        let exitCount = 0;
        J$inst.analysis.use({
            functionExit(_iid, returnVal) {
                exitCount++;
                // 试图触发 isBacktrack，observeOnly 下应被强制忽略
                return { returnVal, isBacktrack: true };
            }
        });
        const $out = {};
        // 如果 isBacktrack 没被忽略，会死循环，超时报错
        // 测试需在合理时间内完成
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.r, 14, 'observeOnly=true 下函数返回值应正确（isBacktrack 被忽略，函数只执行一次）');
        // 钩子仍被调用（observeOnly 不阻止观察）
        assert.ok(exitCount > 0, 'functionExit 钩子仍应被调用');
    });

    test('P1：函数对象不被写入 SID/IID 属性（WeakMap 替代，freeze 场景兼容）', () => {
        // 修复前：T() 中 defineProperty 直接写函数属性，Object.freeze(fn) 会 TypeError
        // 修复后：使用 WeakMap，freeze 不影响
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             'var fn = Object.freeze(function() { return 42; }); $out.r = fn();',
            origCodeFileName: 'freeze-fn.js',
            instCodeFileName: 'freeze-fn_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        // 修复前这里会抛 TypeError: Cannot define property J$_sid_ on a non-extensible object
        assert.doesNotThrow(() => runInSandbox(instrCode, J$inst, { $out }), 'frozen 函数不应导致 TypeError');
        assert.equal($out.r, 42, 'frozen 函数调用结果应正确');
    });

    test('P1：函数对象不暴露 SID/IID 属性（WeakMap 替代，Object.getOwnPropertyNames 干净）', () => {
        // 修复后，函数对象的 ownPropertyNames 不应含有 J$ 的内部属性
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             'function greet(name) { return "hello " + name; } $out.fnProps = Object.getOwnPropertyNames(greet);',
            origCodeFileName: 'fn-props.js',
            instCodeFileName: 'fn-props_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        // 正常函数 ownPropertyNames 应只有 'length', 'name', 'prototype'
        const hasJalangiProp = $out.fnProps.some(p => String(p).startsWith('J$'));
        assert.ok(!hasJalangiProp, '函数对象 ownPropertyNames 不应包含 J$ 内部属性');
    });

    test('P1：new 表达式构造语义正确（Reflect.construct 传入 newTarget，instanceof 正确）', () => {
        // 修复前：Reflect.construct(C, args) 第三参数缺失，原型链可能不正确
        // 修复后：Reflect.construct(C, args, C)，对象原型正确，instanceof 语义不变
        // 注意：class 继承中的 super() 调用是插桩器已知限制（super 关键字不能被 J$.F() 包裹），
        //       此处用普通 class（不调用 super）验证 Reflect.construct 的 newTarget 修复
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: `
function Animal(name) {
    this.name = name;
    this.type = 'animal';
}
Animal.prototype.speak = function() { return this.name + " makes a noise."; };

function Dog(name) {
    Animal.call(this, name);
    this.type = 'dog';
}
Dog.prototype = Object.create(Animal.prototype);
Dog.prototype.constructor = Dog;
Dog.prototype.speak = function() { return this.name + " barks."; };

var d = new Dog("Rex");
$out.name = d.name;
$out.type = d.type;
$out.isAnimal = d instanceof Animal;
$out.isDog = d instanceof Dog;
$out.speak = d.speak();
            `,
            origCodeFileName: 'inherit-reflect.js',
            instCodeFileName: 'inherit-reflect_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(instrCode, J$inst, { $out });
        assert.equal($out.name, 'Rex', 'Dog 实例的 name 应为 Rex');
        assert.equal($out.type, 'dog', 'Dog 实例的 type 应为 dog');
        assert.equal($out.isAnimal, true, 'Dog 实例应是 Animal 的实例（instanceof Animal）');
        assert.equal($out.isDog, true, 'Dog 实例应是 Dog 的实例（instanceof Dog）');
        assert.equal($out.speak, 'Rex barks.', 'Dog 的 speak 方法应正确调用');
    });
});
