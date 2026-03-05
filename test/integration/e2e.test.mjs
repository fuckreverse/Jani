/**
 * test/integration/e2e.test.mjs — 端到端动态执行语义测试
 *
 * 通过"插桩 + vm 沙盒执行"验证插桩前后程序行为一致。
 *
 * 覆盖范围：
 *  - 基础语义：算术、字符串、函数调用、递归、对象/数组
 *  - ES6+：箭头函数、class 实例化/继承、try-catch、for-in、for-of、解构（含真实语法）
 *  - ES2020：可选链、空值合并、逻辑赋值
 *  - ES2017/async：Promise、await 透传、awaitResume 钩子、contextId 独立性
 *  - 闭包 Shadow Frame 场景（7 种，覆盖 #resolveCallId 修复）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { init, instrumentCode } from '../../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../../src/runtime/JalangiSandbox.js';
import { ALL_CONFIG, instrAndRun, runInSandbox } from '../helpers/shared-helpers.mjs';

// ════════════════════════════════════════════════════════════════════════════════
// 基础语义
// ════════════════════════════════════════════════════════════════════════════════

describe('基础语义', () => {
    test('var 声明 + 基本算术', () => {
        const { out } = instrAndRun('var x = 3 + 4; var y = x * 2; $out.x=x; $out.y=y;');
        assert.equal(out.x, 7,  'x 应等于 7');
        assert.equal(out.y, 14, 'y 应等于 14');
    });

    test('字符串连接', () => {
        const { out } = instrAndRun('var s = "hello" + " " + "world"; $out.s=s;');
        assert.equal(out.s, 'hello world');
    });

    test('function 声明 + 调用返回值', () => {
        const { out } = instrAndRun(`
            function add(a, b) { return a + b; }
            var result = add(10, 20);
            $out.result = result;
        `);
        assert.equal(out.result, 30, 'add(10,20) 应返回 30');
    });

    test('递归函数（阶乘）', () => {
        const { out } = instrAndRun(`
            function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
            var r = fact(5);
            $out.r = r;
        `);
        assert.equal(out.r, 120, 'fact(5) 应等于 120');
    });

    test('对象属性读写', () => {
        const { out } = instrAndRun(`
            var obj = { x: 10 };
            obj.y = obj.x + 5;
            var total = obj.x + obj.y;
            $out.total = total;
        `);
        assert.equal(out.total, 25);
    });

    test('数组操作', () => {
        const { out } = instrAndRun(`
            var arr = [1, 2, 3];
            arr.push(4);
            var sum = arr[0] + arr[1] + arr[2] + arr[3];
            $out.sum = sum;
        `);
        assert.equal(out.sum, 10);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES6+ 语义
// ════════════════════════════════════════════════════════════════════════════════

describe('ES6+ 语义', () => {
    test('箭头函数', () => {
        const { out } = instrAndRun(`
            var double = (n) => n * 2;
            var r = double(7);
            $out.r = r;
        `);
        assert.equal(out.r, 14, 'double(7) 应返回 14');
    });

    test('class 实例化与方法调用', () => {
        const { out } = instrAndRun(`
            class Point {
                constructor(x, y) { this.x = x; this.y = y; }
                dist() { return this.x * this.x + this.y * this.y; }
            }
            var p = new Point(3, 4);
            var d = p.dist();
            $out.d = d;
        `);
        assert.equal(out.d, 25, 'Point(3,4).dist() 应返回 25');
    });

    test('class 继承', () => {
        const { out } = instrAndRun(`
            class Animal {
                constructor(name) { this.name = name; }
                speak() { return this.name + ' makes a noise.'; }
            }
            class Dog extends Animal {
                speak() { return this.name + ' barks.'; }
            }
            var d = new Dog('Rex');
            var msg = d.speak();
            $out.msg = msg;
        `);
        assert.equal(out.msg, 'Rex barks.', 'Dog.speak() 应返回正确字符串');
    });

    test('try-catch 语义', () => {
        const { out } = instrAndRun(`
            var caught = null;
            try {
                throw new Error('boom');
            } catch(e) {
                caught = e.message;
            }
            $out.caught = caught;
        `);
        assert.equal(out.caught, 'boom', 'catch 块应捕获异常消息');
    });

    test('for-in 枚举', () => {
        const { out } = instrAndRun(`
            var obj = { a: 1, b: 2, c: 3 };
            var keys = [];
            for (var k in obj) { keys.push(k); }
            var keyStr = keys.sort().join(',');
            $out.keyStr = keyStr;
        `);
        assert.equal(out.keyStr, 'a,b,c', 'for-in 应枚举出所有键');
    });

    test('解构赋值', () => {
        const { out } = instrAndRun(`
            var arr2 = [10, 20, 30];
            var a = arr2[0]; var b = arr2[1];
            var obj2 = { x: 100, y: 200 };
            var x = obj2.x; var y = obj2.y;
            $out.a=a; $out.b=b; $out.x=x; $out.y=y;
        `);
        assert.equal(out.a, 10);
        assert.equal(out.b, 20);
        assert.equal(out.x, 100);
        assert.equal(out.y, 200);
    });

    test('模板字符串', () => {
        const { out } = instrAndRun(`
            var name2 = 'World';
            var s = \`Hello \${name2}!\`;
            $out.s = s;
        `);
        assert.equal(out.s, 'Hello World!');
    });

    test('switch-case 控制流', () => {
        const { out } = instrAndRun(`
            var x = 2;
            var result;
            switch (x) {
                case 1: result = 'one'; break;
                case 2: result = 'two'; break;
                default: result = 'other';
            }
            $out.result = result;
        `);
        assert.equal(out.result, 'two');
    });

    test('rest 参数（用 arguments 等价测试）', () => {
        const { out } = instrAndRun(`
            function sumArgs() {
                var total = 0;
                for (var i = 0; i < arguments.length; i++) total += arguments[i];
                return total;
            }
            var r = sumArgs(1, 2, 3);
            $out.r = r;
        `);
        assert.equal(out.r, 6);
    });

    test('for-of 循环（数组迭代）', () => {
        const { out } = instrAndRun(`
            var arr = [10, 20, 30];
            var sum = 0;
            for (var v of arr) { sum = sum + v; }
            $out.sum = sum;
        `);
        assert.equal(out.sum, 60, 'for-of 应正确累加数组元素');
    });

    test('for-of 循环（字符串迭代）', () => {
        const { out } = instrAndRun(`
            var str = 'abc';
            var chars = [];
            for (var ch of str) { chars.push(ch); }
            $out.r = chars.join('-');
        `);
        assert.equal(out.r, 'a-b-c', 'for-of 应逐字符迭代字符串');
    });

    test('for-of 循环（Map 迭代）', () => {
        const { out } = instrAndRun(`
            var m = new Map([['a', 1], ['b', 2]]);
            var keys = [];
            var vals = [];
            for (var entry of m) { keys.push(entry[0]); vals.push(entry[1]); }
            $out.keys = keys.join(',');
            $out.sum  = vals[0] + vals[1];
        `);
        assert.equal(out.keys, 'a,b', 'for-of Map 应按插入顺序迭代键');
        assert.equal(out.sum, 3,      'for-of Map 值应正确');
    });

    test('对象解构声明（const {x, y} = obj）', () => {
        const { out } = instrAndRun(`
            var obj = { x: 7, y: 13, z: 99 };
            var { x, y } = obj;
            $out.x = x;
            $out.y = y;
        `);
        assert.equal(out.x, 7,  '对象解构 x 应等于 7');
        assert.equal(out.y, 13, '对象解构 y 应等于 13');
    });

    test('对象解构（带默认值）', () => {
        const { out } = instrAndRun(`
            var obj = { a: 10 };
            var { a, b = 42 } = obj;
            $out.a = a;
            $out.b = b;
        `);
        assert.equal(out.a, 10, '解构中已有的属性应取原值');
        assert.equal(out.b, 42, '解构中缺失的属性应取默认值 42');
    });

    test('数组解构声明（const [first, second] = arr）', () => {
        const { out } = instrAndRun(`
            var arr = [100, 200, 300];
            var [first, second] = arr;
            $out.first  = first;
            $out.second = second;
        `);
        assert.equal(out.first,  100, '数组解构第一元素应为 100');
        assert.equal(out.second, 200, '数组解构第二元素应为 200');
    });

    test('数组解构（跳过元素 + rest）', () => {
        const { out } = instrAndRun(`
            var arr = [1, 2, 3, 4, 5];
            var [a, , c, ...rest] = arr;
            $out.a    = a;
            $out.c    = c;
            $out.rest = rest.join(',');
        `);
        assert.equal(out.a,    1,     '解构第 1 元素应为 1');
        assert.equal(out.c,    3,     '跳过第 2、取第 3 元素应为 3');
        assert.equal(out.rest, '4,5', 'rest 应为 [4,5]');
    });

    test('嵌套解构（对象中嵌套数组）', () => {
        const { out } = instrAndRun(`
            var data = { name: 'Alice', scores: [90, 85] };
            var { name, scores: [s1, s2] } = data;
            $out.name = name;
            $out.s1   = s1;
            $out.s2   = s2;
        `);
        assert.equal(out.name, 'Alice', '嵌套解构 name 应为 Alice');
        assert.equal(out.s1,   90,      '嵌套解构 scores[0] 应为 90');
        assert.equal(out.s2,   85,      '嵌套解构 scores[1] 应为 85');
    });

    test('函数参数解构（对象解构形参）', () => {
        const { out } = instrAndRun(`
            function greet({ name, age = 0 }) {
                return name + ':' + age;
            }
            $out.r1 = greet({ name: 'Bob', age: 30 });
            $out.r2 = greet({ name: 'Ann' });
        `);
        assert.equal(out.r1, 'Bob:30', '解构形参应正确读取 name 和 age');
        assert.equal(out.r2, 'Ann:0',  '解构形参默认值应生效');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES2020 可选链 / 空值合并 / 逻辑赋值
// ════════════════════════════════════════════════════════════════════════════════

describe('ES2020 运算符', () => {
    test('可选链 (?.) 与空值合并 (??)', () => {
        const { out } = instrAndRun(`
            var obj = { a: { b: 42 } };
            var v1 = obj?.a?.b;
            var v2 = obj?.z?.b ?? 99;
            var v3 = null ?? 'default';
            $out.v1=v1; $out.v2=v2; $out.v3=v3;
        `);
        assert.equal(out.v1, 42,        '可选链正常读取');
        assert.equal(out.v2, 99,        '可选链 undefined 走 ??');
        assert.equal(out.v3, 'default', '空值合并 null 走右侧');
    });

    test('逻辑赋值 (&&=, ||=, ??=)', () => {
        const { out } = instrAndRun(`
            var a = 1;  a &&= 2;
            var b = 0;  b ||= 3;
            var c = null; c ??= 4;
            $out.a=a; $out.b=b; $out.c=c;
        `);
        assert.equal(out.a, 2, 'a &&= 2 → 2');
        assert.equal(out.b, 3, 'b ||= 3 → 3');
        assert.equal(out.c, 4, 'c ??= 4 → 4');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// async/await 语义
// ════════════════════════════════════════════════════════════════════════════════

describe('async/await 语义', () => {
    test('Promise 基本 resolve', async () => {
        init({ ...ALL_CONFIG });
        const { code } = instrumentCode({
            code: 'var p = Promise.resolve(42); $out.p = p;',
            origCodeFileName: 'promise-test.js',
            instCodeFileName: 'promise-test_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        const val = await $out.p;
        assert.equal(val, 42, 'Promise.resolve(42) 应 resolve 为 42');
    });

    test('await 表达式语义正确，resolved value 被透传', async () => {
        init({ ...ALL_CONFIG, INSTR_AWAIT: null });
        const { code } = instrumentCode({
            code: `
                async function getValue() {
                    var result = await Promise.resolve(99);
                    $out.result = result;
                    return result;
                }
                $out.p = getValue();
            `,
            origCodeFileName: 'await-semantic.js',
            instCodeFileName: 'await-semantic_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        await $out.p;
        assert.equal($out.result, 99, 'await 的 resolved value 应被正确透传（result 应等于 99）');
    });

    test('awaitResume 钩子被调用，参数含 iid、contextId 和 val', async () => {
        init({ ...ALL_CONFIG, INSTR_AWAIT: null });
        const { code } = instrumentCode({
            code: `
                async function task() {
                    var a = await Promise.resolve(11);
                    var b = await Promise.resolve(22);
                    $out.sum = a + b;
                }
                $out.p = task();
            `,
            origCodeFileName: 'await-hook.js',
            instCodeFileName: 'await-hook_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const awaitEvents = [];
        J$inst.analysis.use({
            awaitResume(iid, contextId, val) { awaitEvents.push({ iid, contextId, val }); }
        });
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        await $out.p;

        assert.equal(awaitEvents.length, 2, 'awaitResume 应被调用 2 次');
        assert.equal(awaitEvents[0].val, 11, '第一个 await 的 resolved value 应为 11');
        assert.equal(awaitEvents[1].val, 22, '第二个 await 的 resolved value 应为 22');
        assert.ok(typeof awaitEvents[0].iid === 'number' && awaitEvents[0].iid > 0, 'iid 应为正整数');
        assert.equal(awaitEvents[0].contextId, awaitEvents[1].contextId,
            '同一次 async 调用的两个 awaitResume 应有相同的 contextId');
        assert.ok(typeof awaitEvents[0].contextId === 'number' && awaitEvents[0].contextId > 0,
            'contextId 应为正整数');
    });

    test('多次 async 调用的 awaitResume contextId 互相独立', async () => {
        init({ ...ALL_CONFIG, INSTR_AWAIT: null });
        const { code } = instrumentCode({
            code: `
                async function work(n) {
                    return await Promise.resolve(n);
                }
                $out.p1 = work(1);
                $out.p2 = work(2);
            `,
            origCodeFileName: 'await-ctx.js',
            instCodeFileName: 'await-ctx_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const awaitEvents = [];
        J$inst.analysis.use({
            awaitResume(_iid, contextId, val) { awaitEvents.push({ contextId, val }); }
        });
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        await Promise.all([$out.p1, $out.p2]);

        assert.equal(awaitEvents.length, 2, '应有 2 个 awaitResume 事件');
        assert.notEqual(awaitEvents[0].contextId, awaitEvents[1].contextId,
            '不同次 async 调用的 contextId 应互相独立（不同）');
    });

    test('INSTR_AWAIT=()=>false 时 await 语义仍正确', async () => {
        init({ ...ALL_CONFIG, INSTR_AWAIT: () => false });
        const { code } = instrumentCode({
            code: `
                async function noop() {
                    var v = await Promise.resolve(77);
                    $out.v = v;
                }
                $out.p = noop();
            `,
            origCodeFileName: 'await-disabled.js',
            instCodeFileName: 'await-disabled_inst.js',
            inlineSourceMap:  true,
        });
        assert.ok(!code.includes('J$.Aw'), 'INSTR_AWAIT=()=>false 时不应注入 J$.Aw');
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        await $out.p;
        assert.equal($out.v, 77, '禁用 await 插桩后，await 的值仍应正确为 77');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 闭包 Shadow Frame 场景（覆盖 #resolveCallId 修复）
// ════════════════════════════════════════════════════════════════════════════════

describe('闭包 Shadow Frame 场景', () => {
    test('闭包场景 1：基础计数器（外层退出后闭包累加）', () => {
        const { out } = instrAndRun(`
            function makeCounter() {
                var count = 0;
                return function() { count = count + 1; return count; };
            }
            var counter = makeCounter();
            var a = counter(); var b = counter(); var c = counter();
            $out.a=a; $out.b=b; $out.c=c;
        `);
        assert.equal(out.a, 1, '第 1 次调用 counter() 应返回 1');
        assert.equal(out.b, 2, '第 2 次调用 counter() 应返回 2');
        assert.equal(out.c, 3, '第 3 次调用 counter() 应返回 3');
    });

    test('闭包场景 2：工厂多实例独立（两个计数器互不干扰）', () => {
        const { out } = instrAndRun(`
            function makeCounter() {
                var count = 0;
                return function() { count = count + 1; return count; };
            }
            var c1 = makeCounter();
            var c2 = makeCounter();
            var a1 = c1(); var a2 = c1();
            var b1 = c2();
            var a3 = c1();
            $out.a1=a1; $out.a2=a2; $out.a3=a3; $out.b1=b1;
        `);
        assert.equal(out.a1, 1, 'c1 第 1 次应返回 1');
        assert.equal(out.a2, 2, 'c1 第 2 次应返回 2');
        assert.equal(out.a3, 3, 'c1 第 3 次应返回 3');
        assert.equal(out.b1, 1, 'c2 独立计数，第 1 次应返回 1');
    });

    test('闭包场景 3：嵌套闭包两层（内层访问外层的外层）', () => {
        const { out } = instrAndRun(`
            function outer(x) {
                function middle(y) {
                    return function inner() { return x + y; };
                }
                return middle;
            }
            var m = outer(10);
            var f = m(5);
            $out.r = f();
        `);
        assert.equal(out.r, 15, 'inner() 应返回 10+5=15');
    });

    test('闭包场景 4：闭包写回外层变量（多次修改后读取）', () => {
        const { out } = instrAndRun(`
            function makeAccumulator(init) {
                var total = init;
                return {
                    add: function(n) { total = total + n; },
                    get: function() { return total; }
                };
            }
            var acc = makeAccumulator(100);
            acc.add(5);
            acc.add(20);
            $out.r = acc.get();
        `);
        assert.equal(out.r, 125, 'makeAccumulator(100).add(5).add(20).get() 应返回 125');
    });

    test('闭包场景 5：递归 + 闭包（递归函数本身是闭包）', () => {
        const { out } = instrAndRun(`
            function makeFactorialWithBase(base) {
                return function fact(n) {
                    return n <= 1 ? base : n * fact(n - 1);
                };
            }
            var factBase2 = makeFactorialWithBase(2);
            $out.r = factBase2(4);
        `);
        assert.equal(out.r, 48, 'factBase2(4) 应返回 48（递归到 base=2）');
    });

    test('闭包场景 6：闭包作为回调传递（延迟调用）', () => {
        const { out } = instrAndRun(`
            function makeAdder(x) {
                return function(y) { return x + y; };
            }
            var fns = [];
            for (var i = 0; i < 3; i++) {
                fns.push(makeAdder(i * 10));
            }
            $out.r0 = fns[0](1);
            $out.r1 = fns[1](1);
            $out.r2 = fns[2](1);
        `);
        assert.equal(out.r0, 1,  'fns[0](1) 应等于 0+1=1');
        assert.equal(out.r1, 11, 'fns[1](1) 应等于 10+1=11');
        assert.equal(out.r2, 21, 'fns[2](1) 应等于 20+1=21');
    });

    test('闭包场景 7：IIFE 闭包捕获（立即调用中创建闭包）', () => {
        const { out } = instrAndRun(`
            var fns = (function() {
                var results = [];
                for (var j = 0; j < 3; j++) {
                    results.push((function(captured) {
                        return function() { return captured * captured; };
                    })(j));
                }
                return results;
            })();
            $out.r0 = fns[0]();
            $out.r1 = fns[1]();
            $out.r2 = fns[2]();
        `);
        assert.equal(out.r0, 0, 'fns[0]() 应等于 0*0=0');
        assert.equal(out.r1, 1, 'fns[1]() 应等于 1*1=1');
        assert.equal(out.r2, 4, 'fns[2]() 应等于 2*2=4');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Generator 函数运行时 yield 语义验证
// ════════════════════════════════════════════════════════════════════════════════

describe('Generator 函数运行时语义', () => {
    test('基础 generator：next() 逐步 yield 正确值', () => {
        // 验证 function* 的 yield 语义在插桩后仍正确：
        //   - 每次 next() 暂停在 yield 处
        //   - value 为 yield 表达式的值
        //   - done 标志在最后一次 next() 后变为 true
        const { out } = instrAndRun(`
            function* gen() {
                yield 1;
                yield 2;
                yield 3;
            }
            var it = gen();
            var r1 = it.next();
            var r2 = it.next();
            var r3 = it.next();
            var r4 = it.next();
            $out.v1   = r1.value;
            $out.v2   = r2.value;
            $out.v3   = r3.value;
            $out.done1 = r1.done;
            $out.done4 = r4.done;
        `);
        assert.equal(out.v1,    1,     'yield 1 应产出 value=1');
        assert.equal(out.v2,    2,     'yield 2 应产出 value=2');
        assert.equal(out.v3,    3,     'yield 3 应产出 value=3');
        assert.equal(out.done1, false, '未结束时 done 应为 false');
        assert.equal(out.done4, true,  '耗尽后 done 应为 true');
    });

    test('generator 传参（next(value) 注入值）', () => {
        // 验证 next(val) 将值注入到 yield 表达式的左侧赋值
        const { out } = instrAndRun(`
            function* adder() {
                var a = yield 'first';
                var b = yield 'second';
                $out.sum = a + b;
            }
            var it = adder();
            it.next();       // 启动，暂停在 yield 'first'
            it.next(10);     // 将 10 传给 a，暂停在 yield 'second'
            it.next(20);     // 将 20 传给 b，执行到结束
        `);
        assert.equal(out.sum, 30, 'next(10) + next(20) 累加应等于 30');
    });

    test('generator return 提前终止', () => {
        // 验证 return() 调用后 generator 立即结束，done=true
        const { out } = instrAndRun(`
            function* counter() {
                var i = 0;
                while (true) { yield i; i = i + 1; }
            }
            var it = counter();
            var r1 = it.next();
            var r2 = it.next();
            var r3 = it.return('stopped');
            var r4 = it.next();
            $out.v1 = r1.value;
            $out.v2 = r2.value;
            $out.r3val  = r3.value;
            $out.r3done = r3.done;
            $out.r4done = r4.done;
        `);
        assert.equal(out.v1,    0,         'counter 第 1 次 yield 应为 0');
        assert.equal(out.v2,    1,         'counter 第 2 次 yield 应为 1');
        assert.equal(out.r3val,  'stopped', 'return("stopped") 的 value 应为 "stopped"');
        assert.equal(out.r3done, true,      'return() 后 done 应为 true');
        assert.equal(out.r4done, true,      '终止后再调用 next() done 仍为 true');
    });

    test('generator for-of 迭代语义', () => {
        // 验证 for-of 能正确消费 generator 产出的所有值
        const { out } = instrAndRun(`
            function* range(n) {
                for (var i = 0; i < n; i++) { yield i; }
            }
            var sum = 0;
            for (var v of range(5)) { sum = sum + v; }
            $out.sum = sum;
        `);
        assert.equal(out.sum, 10, 'range(5) 产出 0+1+2+3+4=10');
    });

    test('generator 内嵌套闭包：yield 后闭包变量仍可访问', () => {
        // 验证 generator 暂停/恢复后对外层变量的闭包引用不会丢失
        const { out } = instrAndRun(`
            function* makeGen(base) {
                yield base + 1;
                yield base + 2;
                yield base + 3;
            }
            var it = makeGen(10);
            $out.a = it.next().value;
            $out.b = it.next().value;
            $out.c = it.next().value;
        `);
        assert.equal(out.a, 11, 'base=10, yield base+1 应为 11');
        assert.equal(out.b, 12, 'base=10, yield base+2 应为 12');
        assert.equal(out.c, 13, 'base=10, yield base+3 应为 13');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Promise.all / Promise.race contextId 独立性
// ════════════════════════════════════════════════════════════════════════════════

describe('Promise.all / Promise.race contextId 独立性', () => {
    test('Promise.all 中多个并发 async 任务 contextId 互不相同', async () => {
        // 验证在 Promise.all 并发执行的多个 async 函数中，
        // 每个函数的 awaitResume contextId 是独立的（不会混用同一 contextId）
        init({ ...ALL_CONFIG, INSTR_AWAIT: null });
        const { code } = instrumentCode({
            code: `
                async function task(id) {
                    var v = await Promise.resolve(id * 10);
                    return v;
                }
                $out.p = Promise.all([task(1), task(2), task(3)]);
            `,
            origCodeFileName: 'promise-all-ctx.js',
            instCodeFileName: 'promise-all-ctx_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const ctxIds = [];
        J$inst.analysis.use({
            awaitResume(_iid, contextId) { ctxIds.push(contextId); }
        });
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        const results = await $out.p;

        assert.equal(results.length, 3, 'Promise.all 应返回 3 个结果');
        assert.equal(results[0], 10, 'task(1) 应返回 10');
        assert.equal(results[1], 20, 'task(2) 应返回 20');
        assert.equal(results[2], 30, 'task(3) 应返回 30');
        assert.equal(ctxIds.length, 3, '应有 3 个 awaitResume 事件（每个 task 各 1 个）');

        // 三个并发任务的 contextId 应各不相同
        const uniqueCtx = new Set(ctxIds);
        assert.equal(uniqueCtx.size, 3, 'Promise.all 中 3 个并发 async 任务的 contextId 应互相独立');
    });

    test('Promise.all 语义正确：所有子 Promise resolve 后聚合结果', async () => {
        // 验证 Promise.all 语义在插桩后完整保留（聚合结果顺序与传入顺序一致）
        init({ ...ALL_CONFIG });
        const { code } = instrumentCode({
            code: `
                var p1 = Promise.resolve(100);
                var p2 = Promise.resolve(200);
                var p3 = Promise.resolve(300);
                $out.p = Promise.all([p1, p2, p3]);
            `,
            origCodeFileName: 'promise-all-sem.js',
            instCodeFileName: 'promise-all-sem_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        const results = await $out.p;
        assert.deepEqual(results, [100, 200, 300],
            'Promise.all 聚合结果应与传入顺序一致');
    });

    test('Promise.race 语义正确：最快 resolve 的 Promise 胜出', async () => {
        // 验证 Promise.race 在插桩后仍选择最先 resolve 的值（不改变竞争语义）
        init({ ...ALL_CONFIG });
        const { code } = instrumentCode({
            code: `
                // 用已 settled 的 Promise 模拟确定性竞争
                var fast = Promise.resolve('fast');
                var slow = new Promise(function(resolve) {
                    // 延迟 resolve，但 fast 已经 settled
                    resolve('slow');
                });
                $out.p = Promise.race([fast, slow]);
            `,
            origCodeFileName: 'promise-race.js',
            instCodeFileName: 'promise-race_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        const result = await $out.p;
        assert.equal(result, 'fast',
            'Promise.race 中已 settled 的 fast 应优先 resolve');
    });

    test('Promise.all reject 语义：任一子 Promise reject 则整体 reject', async () => {
        // 验证 Promise.all 的 fast-fail 语义（任一 reject → 整体 reject）
        init({ ...ALL_CONFIG });
        const { code } = instrumentCode({
            code: `
                var p1 = Promise.resolve(1);
                var p2 = Promise.reject(new Error('boom'));
                var p3 = Promise.resolve(3);
                $out.p = Promise.all([p1, p2, p3]);
            `,
            origCodeFileName: 'promise-all-reject.js',
            instCodeFileName: 'promise-all-reject_inst.js',
            inlineSourceMap:  true,
        });
        const J$inst = new JalangiSandbox();
        const $out = {};
        runInSandbox(code, J$inst, { $out, Promise });
        let caught = null;
        try {
            await $out.p;
        } catch (e) {
            caught = e.message;
        }
        assert.equal(caught, 'boom',
            'Promise.all 中任一 reject 应导致整体 reject，错误消息应为 "boom"');
    });
});
