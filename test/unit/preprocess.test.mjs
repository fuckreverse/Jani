/**
 * test/unit/preprocess.test.mjs — 预处理模块单元测试
 *
 * 覆盖范围：
 *   - PreprocessPlugin 基类行为
 *   - DeobfuscatePlugin：每个 Pass 独立验证（splitSequence / replaceVoid /
 *     foldConstants / simplifyBoolean / expandConditional / inlineDeadCode / flattenIIFE）
 *   - DeobfuscatePlugin：Pass 组合与默认选项
 *   - DeobfuscatePlugin：边界条件与不应触碰的情况
 *   - TranspilePlugin：语法降级基本功能
 *   - preprocessCode()：API 接口（preset / plugins / warnings / stats）
 *   - 与插桩器集成：预处理后的代码可被 Jani 正常插桩
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import { preprocessCode, PreprocessPlugin, DeobfuscatePlugin, TranspilePlugin, NormalizeArrowPlugin }
    from '../../src/preprocess/index.js';
import { init, instrumentCode } from '../../src/instrument/esnstrument.js';
import { ALL_CONFIG } from '../helpers/shared-helpers.mjs';

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 快捷调用 preprocessCode，只使用 DeobfuscatePlugin（script 模式）。
 * @param {string} code
 * @param {object} [opts]  DeobfuscatePlugin 选项
 */
async function deob(code, opts = {}) {
    return preprocessCode(code, {
        plugins: [new DeobfuscatePlugin(opts)],
        sourceType: 'script',
    });
}

/**
 * 只启用单个 Pass，其余全部关闭，方便隔离测试。
 * @param {string} code
 * @param {string} pass  Pass 名称（对应 DeobfuscatePlugin 构造选项键名）
 */
async function deobOnly(code, pass) {
    const opts = {
        splitSequence:    false,
        replaceVoid:      false,
        foldConstants:    false,
        simplifyBoolean:  false,
        expandConditional:false,
        inlineDeadCode:   false,
        flattenIIFE:      false,
        [pass]:           true,
    };
    return deob(code, opts);
}

// ════════════════════════════════════════════════════════════════════════════════
// 基类
// ════════════════════════════════════════════════════════════════════════════════

describe('PreprocessPlugin 基类', () => {
    test('未实现 apply() 时记录 warning（index.js 捕获插件异常）', async () => {
        const p = new PreprocessPlugin('test');
        // index.js 用 try/catch 将插件异常转为 warning，不向外抛出
        const { warnings } = await preprocessCode('var x = 1;', { plugins: [p] });
        assert.ok(
            warnings.some(w => w.includes('apply()') || w.includes('未实现') || w.includes('test')),
            `应有包含插件名的 warning，实际 warnings: ${JSON.stringify(warnings)}`
        );
    });

    test('name / options 正确存储', () => {
        const p = new PreprocessPlugin('myPlugin', { foo: 42 });
        assert.equal(p.name, 'myPlugin');
        assert.equal(p.options.foo, 42);
        assert.ok(p.toString().includes('myPlugin'));
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 逗号表达式拆分（splitSequence）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / splitSequence', () => {
    test('基础逗号表达式拆分为多条语句', async () => {
        const { code, stats } = await deobOnly('a = 1, b = 2, c = 3;', 'splitSequence');
        assert.ok(code.includes('a = 1'), '第一条语句应存在');
        assert.ok(code.includes('b = 2'), '第二条语句应存在');
        assert.ok(code.includes('c = 3'), '第三条语句应存在');
        assert.ok(!code.includes('a = 1, b'), '拆分后不应存在逗号表达式');
        assert.equal(stats.DeobfuscatePlugin.sequenceSplit, 2, '拆出 2 个额外语句');
    });

    test('嵌套逗号表达式（多轮收敛）', async () => {
        // (a=1, b=2, c=3) 内有3个子表达式
        const { code, stats } = await deobOnly('(a = 1, b = 2, c = 3);', 'splitSequence');
        assert.ok(!code.match(/,\s*(b|c)\s*=/), '所有逗号均应拆分');
        assert.ok(stats.DeobfuscatePlugin.sequenceSplit >= 2);
    });

    test('for 循环 init 中的逗号提前', async () => {
        const { code } = await deobOnly('for (a = 1, i = 0; i < 10; i++) {}', 'splitSequence');
        // a = 1 应提升到 for 前面
        assert.ok(/a = 1[;]/.test(code) || /a = 1\n/.test(code), 'a=1 应被提升到 for 外');
    });

    test('return 语句中的逗号提前', async () => {
        const { code } = await deobOnly('function f() { return (a = 1, b = 2, a + b); }', 'splitSequence');
        assert.ok(code.includes('a = 1'), 'a=1 应被提升');
        assert.ok(code.includes('b = 2'), 'b=2 应被提升');
        assert.ok(code.includes('return a + b'), '最后一项应保留在 return 中');
    });

    test('if 条件中的逗号提前', async () => {
        const { code } = await deobOnly('if (x = getX(), x > 0) { use(x); }', 'splitSequence');
        assert.ok(/x = getX\(\)[;]/.test(code) || /x = getX\(\)\n/.test(code),
            'x = getX() 应被提升到 if 前');
        assert.ok(code.includes('if (x > 0)'), 'if 条件只剩最后一项');
    });

    test('函数调用参数内的逗号不拆分', async () => {
        const { code } = await deobOnly('foo(a, b, c);', 'splitSequence');
        assert.ok(code.includes('foo(a, b, c)'), '函数调用参数不应被拆分');
    });

    test('数组/对象字面量内的逗号不拆分', async () => {
        const { code } = await deobOnly('var arr = [1, 2, 3];', 'splitSequence');
        assert.ok(code.includes('[1, 2, 3]'), '数组字面量不应被拆分');
    });

    test('splitSequence 关闭时逗号表达式保持原样', async () => {
        const { code } = await deob('a = 1, b = 2;', { splitSequence: false });
        assert.ok(code.includes(','), '关闭后逗号表达式应保持');
    });

    test('[安全] while 条件中的逗号表达式不处理（展开会改变每轮副作用顺序）', async () => {
        // while (a = getNext(), a !== null) 语义上每轮都先执行 a=getNext() 再判断
        // 不等价于：a=getNext(); while(a !== null) { ...; a=getNext(); }
        // （若循环体抛异常，原始代码下一轮仍会调用 getNext，但改写后不会）
        const { code } = await deobOnly(
            'while (a = getNext(), a !== null) { process(a); }',
            'splitSequence'
        );
        // while 条件中的逗号不应被拆分
        assert.ok(code.includes('a = getNext(), a !== null') ||
                  code.includes('(a = getNext(), a !== null)'),
            'while 条件中的逗号不应被拆分');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — void 替换（replaceVoid）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / replaceVoid', () => {
    test('void 0 → undefined', async () => {
        const { code, stats } = await deobOnly('var x = void 0;', 'replaceVoid');
        assert.ok(code.includes('undefined'), 'void 0 应替换为 undefined');
        assert.ok(!code.includes('void 0'), '不应残留 void 0');
        assert.ok(stats.DeobfuscatePlugin.voidReplaced >= 1, `voidReplaced 应 >= 1，实际 ${stats.DeobfuscatePlugin.voidReplaced}`);
    });

    test("void '' → undefined", async () => {
        const { code } = await deobOnly("var x = void '';", 'replaceVoid');
        assert.ok(code.includes('undefined'));
    });

    test('void false → undefined', async () => {
        const { code } = await deobOnly('var x = void false;', 'replaceVoid');
        assert.ok(code.includes('undefined'));
    });

    test('void null → undefined', async () => {
        const { code } = await deobOnly('var x = void null;', 'replaceVoid');
        assert.ok(code.includes('undefined'));
    });

    test('void someExpression 不替换（有副作用）', async () => {
        const { code } = await deobOnly('var x = void someFunc();', 'replaceVoid');
        assert.ok(code.includes('void someFunc()'), '有副作用的 void 不应替换');
    });

    test('连续多个 void 0 全部替换', async () => {
        const { code, stats } = await deobOnly('var a = void 0, b = void 0, c = void 0;', 'replaceVoid');
        assert.equal((code.match(/undefined/g) ?? []).length, 3, '3 个 void 0 均替换');
        assert.ok(stats.DeobfuscatePlugin.voidReplaced >= 3);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 常量折叠（foldConstants）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / foldConstants', () => {
    test('数值加法折叠', async () => {
        const { code, stats } = await deobOnly('var x = 1 + 2;', 'foldConstants');
        assert.ok(code.includes('3'), '1+2 应折叠为 3');
        assert.ok(!code.includes('1 + 2'), '不应残留原表达式');
        assert.ok(stats.DeobfuscatePlugin.constantsFolded >= 1);
    });

    test('链式数值折叠（1+2+3=6）', async () => {
        const { code } = await deobOnly('var x = 1 + 2 + 3;', 'foldConstants');
        assert.ok(code.includes('6'), '1+2+3 应折叠为 6');
    });

    test('字符串拼接折叠', async () => {
        const { code } = await deobOnly('var s = "foo" + "bar";', 'foldConstants');
        assert.ok(code.includes('"foobar"'), '"foo"+"bar" 应折叠为 "foobar"');
    });

    test('混合数学运算折叠', async () => {
        const { code } = await deobOnly('var x = 10 * 3 - 5;', 'foldConstants');
        assert.ok(code.includes('25'), '10*3-5 应折叠为 25');
    });

    test('比较运算折叠', async () => {
        const { code } = await deobOnly('var r = 5 > 3;', 'foldConstants');
        assert.ok(code.includes('true'), '5>3 应折叠为 true');
    });

    test('全等比较折叠', async () => {
        const { code } = await deobOnly('var r = 1 === 2;', 'foldConstants');
        assert.ok(code.includes('false'), '1===2 应折叠为 false');
    });

    test('typeof 字面量折叠', async () => {
        const { code } = await deobOnly('var t = typeof 42;', 'foldConstants');
        assert.ok(code.includes('"number"'), 'typeof 42 应折叠为 "number"');
    });

    test('typeof undefined 折叠', async () => {
        const { code } = await deobOnly('var t = typeof undefined;', 'foldConstants');
        assert.ok(code.includes('"undefined"'), 'typeof undefined 应折叠');
    });

    test('逻辑 &&：左侧 false 短路', async () => {
        const { code } = await deobOnly('var r = false && someFunc();', 'foldConstants');
        assert.ok(code.includes('false'), '应折叠为 false');
        assert.ok(!code.includes('someFunc'), 'someFunc 不应出现');
    });

    test('逻辑 ||：左侧 true 短路', async () => {
        const { code } = await deobOnly('var r = true || someFunc();', 'foldConstants');
        assert.ok(code.includes('true'), '应折叠为 true');
        assert.ok(!code.includes('someFunc'), 'someFunc 不应出现');
    });

    test('三元条件折叠', async () => {
        const { code } = await deobOnly('var r = true ? "yes" : "no";', 'foldConstants');
        assert.ok(code.includes('"yes"'), '应折叠为 "yes"');
        assert.ok(!code.includes('"no"'), '"no" 不应出现');
    });

    test('一元运算符折叠', async () => {
        const { code } = await deobOnly('var x = -5; var y = +3;', 'foldConstants');
        assert.ok(code.includes('-5'), '-5 应保留');
    });

    test('位运算折叠', async () => {
        const { code } = await deobOnly('var x = 0xff & 0x0f;', 'foldConstants');
        assert.ok(code.includes('15'), '0xff & 0x0f = 15 应折叠');
    });

    test('含变量的表达式不折叠', async () => {
        const { code } = await deobOnly('var x = y + 1;', 'foldConstants');
        assert.ok(code.includes('y + 1'), '含变量表达式不应折叠');
    });

    test('NaN / Infinity 不折叠为字面量', async () => {
        const { code } = await deobOnly('var x = 1 / 0;', 'foldConstants');
        // 除以零结果为 Infinity，Infinity 不能用简单数字字面量表示，应保持原样
        // 实现选择不折叠 rv===0 的除法
        assert.ok(code.includes('1 / 0'), '除以零不折叠');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 布尔简化（simplifyBoolean）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / simplifyBoolean', () => {
    test('!!x → Boolean(x)', async () => {
        const { code, stats } = await deobOnly('var r = !!someVar;', 'simplifyBoolean');
        assert.ok(code.includes('Boolean(someVar)'), '!!x 应改写为 Boolean(x)');
        assert.ok(!code.includes('!!'), '不应残留 !!');
        assert.equal(stats.DeobfuscatePlugin.booleanSimplified, 1);
    });

    test('!true → false', async () => {
        const { code } = await deobOnly('var r = !true;', 'simplifyBoolean');
        assert.ok(code.includes('false'), '!true 应改写为 false');
    });

    test('!false → true', async () => {
        const { code } = await deobOnly('var r = !false;', 'simplifyBoolean');
        assert.ok(code.includes('true'), '!false 应改写为 true');
    });

    test('!expr（非字面量）不处理', async () => {
        const { code } = await deobOnly('var r = !someVar;', 'simplifyBoolean');
        assert.ok(code.includes('!someVar'), '!变量 应保留');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 条件表达式展开（expandConditional）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / expandConditional', () => {
    test('语句级纯副作用三元展开为 if-else', async () => {
        const { code, stats } = await deobOnly(
            'cond ? doA() : doB();',
            'expandConditional'
        );
        assert.ok(code.includes('if'), '应展开为 if');
        assert.ok(code.includes('doA()'), '分支 A 应保留');
        assert.ok(code.includes('doB()'), '分支 B 应保留');
        assert.equal(stats.DeobfuscatePlugin.conditionalExpanded, 1);
    });

    test('有返回值的三元（用作表达式）不展开', async () => {
        const { code } = await deobOnly('var x = cond ? a : b;', 'expandConditional');
        assert.ok(code.includes('?'), '赋值用三元不应展开');
    });

    test('两支均无副作用时不展开', async () => {
        // a 和 b 都是纯读取，不是调用/赋值
        const { code } = await deobOnly('cond ? a : b;', 'expandConditional');
        // 没有副作用，插件会跳过
        assert.ok(code.includes('?'), '无副作用的三元不应展开');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 死代码删除（inlineDeadCode）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / inlineDeadCode', () => {
    test('if (false) { ... } 整条删除', async () => {
        const { code, stats } = await deobOnly(
            'if (false) { console.log("dead"); }',
            'inlineDeadCode'
        );
        assert.ok(!code.includes('dead'), '死代码应被删除');
        assert.equal(stats.DeobfuscatePlugin.deadCodeRemoved, 1);
    });

    test('if (true) { stmt } else { ... } 保留 then 分支', async () => {
        const { code } = await deobOnly(
            'if (true) { console.log("alive"); } else { console.log("dead"); }',
            'inlineDeadCode'
        );
        assert.ok(code.includes('alive'), 'alive 应保留');
        assert.ok(!code.includes('dead'), 'dead 分支应删除');
    });

    test('if (false) { ... } else { stmt } 保留 else 分支', async () => {
        const { code } = await deobOnly(
            'if (false) { unreachable(); } else { doThis(); }',
            'inlineDeadCode'
        );
        assert.ok(!code.includes('unreachable'), '永假分支应删除');
        assert.ok(code.includes('doThis'), 'else 分支应保留');
    });

    test('if (false) 无 else 直接删除整条', async () => {
        const { code } = await deobOnly(
            'before(); if (false) { dead(); } after();',
            'inlineDeadCode'
        );
        assert.ok(!code.includes('dead'), '死代码应删除');
        assert.ok(code.includes('before'), 'before 应保留');
        assert.ok(code.includes('after'), 'after 应保留');
    });

    test('while (false) { ... } 删除', async () => {
        const { code } = await deobOnly(
            'while (false) { neverRun(); }',
            'inlineDeadCode'
        );
        assert.ok(!code.includes('neverRun'), '永假 while 应删除');
    });

    test('if (条件是变量) 不处理', async () => {
        const { code } = await deobOnly(
            'if (someVar) { doA(); }',
            'inlineDeadCode'
        );
        assert.ok(code.includes('someVar'), '变量条件不应处理');
    });

    test('[安全] if(true) 块内含 let 时保留块包装（let 不应泄漏到外层作用域）', async () => {
        const { code } = await deobOnly(
            'if (true) { let x = 1; use(x); } console.log(typeof x);',
            'inlineDeadCode'
        );
        // 若直接展开，let x 变成顶层，console.log(typeof x) 就能访问到 x
        // 正确做法：用 BlockStatement { let x = 1; use(x); } 替换 if
        assert.ok(code.includes('let x'), 'let x 应保留');
        assert.ok(!code.includes('if (true)'), 'if(true) 应被消除');
        // let x 应在块 {} 内（检查 { 在 let x 之前）
        const letIdx = code.indexOf('let x');
        const prevBrace = code.lastIndexOf('{', letIdx);
        assert.ok(prevBrace !== -1, 'let x 应在块作用域 {} 内');
    });

    test('[安全] if(true) 块内仅含 var 时直接展开（var 不需要块保护）', async () => {
        const { code } = await deobOnly(
            'if (true) { var y = 2; doStuff(y); }',
            'inlineDeadCode'
        );
        // var 是函数作用域，展开无安全问题
        assert.ok(!code.includes('if (true)'), 'if(true) 应被消除');
        assert.ok(code.includes('var y = 2'), 'var y 应保留');
    });

    test('[安全] if(true) 块内含 const 时保留块包装', async () => {
        const { code } = await deobOnly(
            'if (true) { const MAX = 100; doStuff(MAX); }',
            'inlineDeadCode'
        );
        assert.ok(code.includes('const MAX'), 'const 应保留');
        assert.ok(!code.includes('if (true)'), 'if(true) 应被消除');
        const constIdx = code.indexOf('const MAX');
        const prevBrace = code.lastIndexOf('{', constIdx);
        assert.ok(prevBrace !== -1, 'const 应在块作用域 {} 内');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 无参 IIFE 展开（flattenIIFE）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / flattenIIFE', () => {
    test('无参无 return 的 function IIFE 展开', async () => {
        const { code, stats } = await deobOnly(
            '(function() { var a = 1; doSomething(a); })();',
            'flattenIIFE'
        );
        assert.ok(!/function\s*\(/.test(code), 'IIFE 函数包装应消失');
        assert.ok(code.includes('var a = 1'), 'var 声明应保留');
        assert.ok(code.includes('doSomething(a)'), '语句应保留');
        assert.equal(stats.DeobfuscatePlugin.iifeFlattened, 1);
    });

    test('含参数的 IIFE 不展开', async () => {
        const { code } = await deobOnly(
            '(function(x) { doSomething(x); })(42);',
            'flattenIIFE'
        );
        assert.ok(/function\s*\(/.test(code), '含参数 IIFE 不应展开');
    });

    test('箭头函数 IIFE 展开', async () => {
        const { code } = await deobOnly(
            '(() => { var b = 2; use(b); })();',
            'flattenIIFE'
        );
        assert.ok(!code.includes('=>'), '箭头函数包装应消失');
        assert.ok(code.includes('var b = 2'), '内部语句应保留');
    });

    test('含 this 的 function IIFE 不展开', async () => {
        const { code } = await deobOnly(
            '(function() { return this.x; })();',
            'flattenIIFE'
        );
        // 含 this 的 IIFE 不展开，且含 return（两个安全检查都会拦截），function 关键字应保留
        assert.ok(/function\s*\(/.test(code), '含 this 的 IIFE 不展开');
    });

    test('空 IIFE 展开后删除', async () => {
        const { code } = await deobOnly(
            '(function() {})();',
            'flattenIIFE'
        );
        // 空 IIFE 展开后没有任何语句，结果应是空的或只剩注释
        assert.ok(!/function\s*\(\s*\)\s*\{\s*\}/.test(code), '空 IIFE 应被移除');
    });

    // ─── 安全性回归测试 ─────────────────────────────────────────────────────────

    test('[安全] 含提前 return 的 IIFE 不展开（展开后 return 会影响外层函数）', async () => {
        const { code } = await deobOnly(
            'function outer() { (function() { doA(); if (cond) return; doB(); })(); doC(); }',
            'flattenIIFE'
        );
        // 若展开，内部的 return 会变成 outer 的 return，doC 不会执行
        // Babel generator 输出 "function ()" 带空格，用宽松匹配
        assert.ok(/function\s*\(/.test(code), '含提前 return 的 IIFE 不应展开');
    });

    test('[安全] 含 break 的 IIFE 不展开（break 会逃逸到外层循环）', async () => {
        const { code } = await deobOnly(
            'for (var i = 0; i < 10; i++) { (function() { if (i === 5) break; doSomething(); })(); }',
            'flattenIIFE'
        );
        // 展开后 break 会终止外层 for 循环，语义完全改变
        assert.ok(/function\s*\(/.test(code), '含 break 的 IIFE 不应展开');
    });

    test('[安全] 含 var 且外层有同名变量的 IIFE 不展开（会覆盖外层变量）', async () => {
        const { code } = await deobOnly(
            'var x = 100; (function() { var x = 1; use(x); })(); console.log(x);',
            'flattenIIFE'
        );
        // 展开后内层 var x 与外层 var x 合并，console.log(x) 变成 1 而不是 100
        assert.ok(/function\s*\(/.test(code), '同名 var 冲突的 IIFE 不应展开');
    });

    test('[安全] 含 let/const 的 IIFE 展开时保留块包装（let/const 块作用域不应泄漏）', async () => {
        const { code } = await deobOnly(
            '(function() { let secret = 42; use(secret); })();',
            'flattenIIFE'
        );
        // 展开后 let secret 不应泄漏到外层；应用 BlockStatement 包裹
        // 代码中不应再有 function (，但 let secret 应在一个块 {} 中
        assert.ok(!/function\s*\(/.test(code), 'function 包装应消失');
        assert.ok(code.includes('let secret'), 'let 声明应保留');
        // 验证 let secret 在块作用域内（输出中有 { 包裹）
        const secretIdx = code.indexOf('let secret');
        const prevBrace = code.lastIndexOf('{', secretIdx);
        assert.ok(prevBrace !== -1, 'let 声明应在块作用域 { 内');
    });

    test('[安全] 含 var（无冲突）的简单 IIFE 正常展开', async () => {
        // IIFE 内有 var，但外层没有同名变量，应正常展开
        const { code, stats } = await deobOnly(
            '(function() { var uniqueVar999 = 1; doSomething(uniqueVar999); })();',
            'flattenIIFE'
        );
        assert.ok(!/function\s*\(/.test(code), '无冲突的 var IIFE 应展开');
        assert.ok(code.includes('var uniqueVar999'), 'var 声明应保留');
        assert.equal(stats.DeobfuscatePlugin.iifeFlattened, 1);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// DeobfuscatePlugin — 默认选项与组合
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / 默认选项', () => {
    test('默认开启：splitSequence + replaceVoid + foldConstants + simplifyBoolean + inlineDeadCode', async () => {
        const code = `
            a = 1, b = 2;
            var x = void 0;
            var y = 1 + 2;
            var z = !!someVar;
            if (false) { dead(); }
        `;
        const { code: out, stats } = await deob(code);
        assert.ok(!out.includes('void 0'), 'void 0 应被替换');
        assert.ok(out.includes('3'), '1+2 应折叠');
        assert.ok(out.includes('Boolean(someVar)'), '!!x 应简化');
        assert.ok(!out.includes('dead'), '死代码应删除');
        assert.ok(stats.DeobfuscatePlugin.sequenceSplit >= 1, '逗号应拆分');
    });

    test('默认关闭 expandConditional：三元不展开', async () => {
        const { code } = await deob('cond ? doA() : doB();');
        // 默认不展开（expandConditional: false）
        assert.ok(code.includes('?'), '默认不展开三元');
    });

    test('默认关闭 flattenIIFE：IIFE 不展开', async () => {
        const { code } = await deob('(function() { doStuff(); })();');
        assert.ok(code.includes('function'), '默认不展开 IIFE');
    });

    test('options 传入 false 可关闭默认开启的 Pass', async () => {
        const { code } = await deob('a = 1, b = 2;', { splitSequence: false });
        assert.ok(code.includes(','), 'splitSequence=false 时逗号应保留');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// TranspilePlugin — 语法降级
// ════════════════════════════════════════════════════════════════════════════════

describe('TranspilePlugin / 语法降级', () => {
    test('箭头函数降级为普通函数', async () => {
        const { code, stats } = await preprocessCode('var f = (x) => x + 1;', {
            plugins: [new TranspilePlugin({ targets: { ie: '11' } })],
            sourceType: 'script',
        });
        assert.ok(!code.includes('=>'), '箭头函数应被转换');
        assert.ok(code.includes('function'), '应转为 function');
        assert.ok(stats.TranspilePlugin.transformedTopLevelNodes > 0);
    });

    test('模板字符串降级为字符串拼接', async () => {
        const { code } = await preprocessCode('var s = `hello ${name}`;', {
            plugins: [new TranspilePlugin({ targets: { ie: '11' } })],
            sourceType: 'script',
        });
        assert.ok(!code.includes('`'), '模板字符串应被转换');
    });

    test('class 语法降级', async () => {
        const { code } = await preprocessCode(
            'class Foo { constructor(x) { this.x = x; } bar() { return this.x; } }',
            {
                plugins: [new TranspilePlugin({ targets: { ie: '11' } })],
                sourceType: 'script',
            }
        );
        // 降级后原 class 声明变为函数，辅助函数（_classCallCheck 等）应被注入
        // 检测 class 语法关键字（"class Foo"）不存在，而不是字符串 "class "（后者可能出现在辅助函数的错误消息中）
        assert.ok(!code.includes('class Foo'), '原 class Foo 声明应被降级');
        assert.ok(code.includes('function'), '应有 function 关键字（降级产物）');
    });

    test('解构赋值降级', async () => {
        const { code } = await preprocessCode('var [a, b] = arr;', {
            plugins: [new TranspilePlugin({ targets: { ie: '11' } })],
            sourceType: 'script',
        });
        assert.ok(!code.includes('[a, b]'), '解构应被降级');
    });

    test('node:current 目标不转换现代语法', async () => {
        const src = 'const f = (x) => x + 1;';
        const { code } = await preprocessCode(src, {
            plugins: [new TranspilePlugin({ targets: { node: 'current' } })],
            sourceType: 'script',
        });
        // node:current 支持箭头函数，不应转换
        assert.ok(code.includes('=>'), 'node:current 下箭头函数应保留');
    });

    test('transpilePlugin stats 包含 targets 字段', async () => {
        const { stats } = await preprocessCode('var x = 1;', {
            plugins: [new TranspilePlugin({ targets: 'defaults' })],
        });
        assert.ok(stats.TranspilePlugin.targets !== undefined, '应有 targets 统计');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// preprocessCode API
// ════════════════════════════════════════════════════════════════════════════════

describe('preprocessCode() API', () => {
    test('preset=deobfuscate 只运行反混淆插件', async () => {
        const { code, stats } = await preprocessCode('a = 1, b = 2; var x = void 0;', {
            preset: 'deobfuscate',
            sourceType: 'script',
        });
        assert.ok(!code.includes('void 0'), '反混淆插件应运行');
        assert.ok(stats.DeobfuscatePlugin, 'stats 中应有 DeobfuscatePlugin 键');
    });

    test('preset=transpile 只运行降级插件', async () => {
        const { stats } = await preprocessCode('var f = x => x;', {
            preset: 'transpile',
            transpile: { targets: { ie: '11' } },
        });
        assert.ok(stats.TranspilePlugin, 'stats 中应有 TranspilePlugin 键');
        assert.ok(!stats.DeobfuscatePlugin, 'stats 中不应有 DeobfuscatePlugin 键');
    });

    test('preset=full 两个插件都运行', async () => {
        const { stats } = await preprocessCode('a = 1, b = 2; var f = x => x;', {
            preset: 'full',
            transpile: { targets: { node: 'current' } },
            sourceType: 'script',
        });
        assert.ok(stats.DeobfuscatePlugin, '应有 DeobfuscatePlugin');
        assert.ok(stats.TranspilePlugin, '应有 TranspilePlugin');
    });

    test('plugins 参数优先于 preset', async () => {
        const { stats } = await preprocessCode('var x = void 0;', {
            preset: 'transpile',  // 指定 transpile，但 plugins 覆盖
            plugins: [new DeobfuscatePlugin()],
        });
        assert.ok(stats.DeobfuscatePlugin, '应运行 plugins 中的插件');
        assert.ok(!stats.TranspilePlugin, '不应运行 preset 中的 transpile');
    });

    test('未知 preset 抛出错误', async () => {
        await assert.rejects(
            () => preprocessCode('var x = 1;', { preset: 'unknown-preset' }),
            /未知 preset/,
        );
    });

    test('语法错误抛出异常', async () => {
        await assert.rejects(
            () => preprocessCode('var x = {{{;', {
                plugins: [new DeobfuscatePlugin()],
            }),
            /解析失败/,
        );
    });

    test('空代码不报错', async () => {
        const { code } = await preprocessCode('', { plugins: [new DeobfuscatePlugin()] });
        assert.equal(code.trim(), '', '空代码应产生空输出');
    });

    test('保留注释（comments: true，默认）', async () => {
        const { code } = await preprocessCode('// 这是注释\nvar x = 1;', {
            plugins: [new DeobfuscatePlugin()],
            comments: true,
        });
        assert.ok(code.includes('这是注释'), '注释应保留');
    });

    test('去除注释（comments: false）', async () => {
        const { code } = await preprocessCode('// 这是注释\nvar x = 1;', {
            plugins: [new DeobfuscatePlugin()],
            comments: false,
        });
        assert.ok(!code.includes('这是注释'), '注释应去除');
    });

    test('stats 对象包含每个插件的统计', async () => {
        const { stats } = await preprocessCode('a = 1, b = 2; var x = void 0;', {
            plugins: [new DeobfuscatePlugin()],
        });
        assert.ok(typeof stats.DeobfuscatePlugin === 'object');
        assert.ok(typeof stats.DeobfuscatePlugin.sequenceSplit === 'number');
        assert.ok(typeof stats.DeobfuscatePlugin.voidReplaced === 'number');
    });

    test('warnings 数组存在（即使无警告）', async () => {
        const { warnings } = await preprocessCode('var x = 1;', {
            plugins: [new DeobfuscatePlugin()],
        });
        assert.ok(Array.isArray(warnings));
    });

    test('sourceType=module 支持 import/export', async () => {
        const { code } = await preprocessCode(
            'import { foo } from "./mod.js"; export default foo;',
            {
                plugins: [new DeobfuscatePlugin()],
                sourceType: 'module',
            }
        );
        assert.ok(code.includes('import'), 'import 应保留');
        assert.ok(code.includes('export'), 'export 应保留');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 与插桩器集成：预处理后的代码可被正常插桩
// ════════════════════════════════════════════════════════════════════════════════

describe('预处理 → 插桩集成', () => {
    before(() => init({ ...ALL_CONFIG }));

    test('反混淆后的代码可正常插桩', async () => {
        const raw = 'a = 1, b = 2, c = a + b;';
        const { code: cleaned } = await preprocessCode(raw, {
            plugins: [new DeobfuscatePlugin()],
            sourceType: 'script',
        });
        // 对预处理后的代码进行插桩，不应报错
        let result;
        assert.doesNotThrow(() => {
            result = instrumentCode({
                code:             cleaned,
                origCodeFileName: 'cleaned.js',
                instCodeFileName: 'cleaned_inst.js',
                sourceType:       'script',
            });
        }, '预处理后的代码应可正常插桩');
        assert.ok(result.code.includes('J$.'), '插桩后代码应含钩子');
        // 三条语句分别被插桩，IID 数量应多于原始单条语句
        const iidCount = Object.keys(result.sourceMapObject ?? {}).filter(k => !isNaN(k)).length;
        assert.ok(iidCount > 0, '应有 IID 生成');
    });

    test('死代码删除后插桩 IID 数量更少', async () => {
        const withDead = `
            if (false) { unusedA(); unusedB(); unusedC(); }
            doReal();
        `;
        const withoutDead = `
            doReal();
        `;
        init({ ...ALL_CONFIG });
        const r1 = instrumentCode({ code: withDead, origCodeFileName: 't1.js', instCodeFileName: 't1_i.js' });
        const r2 = instrumentCode({ code: withoutDead, origCodeFileName: 't2.js', instCodeFileName: 't2_i.js' });
        const cnt1 = Object.keys(r1.sourceMapObject ?? {}).filter(k => !isNaN(k)).length;
        const cnt2 = Object.keys(r2.sourceMapObject ?? {}).filter(k => !isNaN(k)).length;
        assert.ok(cnt1 > cnt2, `含死代码(${cnt1})插桩 IID 应多于删除后(${cnt2})`);
    });

    test('预处理后代码插桩结果含逐行位置信息', async () => {
        const raw = 'x = 1, y = 2, z = x + y;';
        const { code: cleaned } = await preprocessCode(raw, {
            plugins: [new DeobfuscatePlugin({ splitSequence: true })],
            sourceType: 'script',
        });
        init({ ...ALL_CONFIG });
        const result = instrumentCode({
            code:             cleaned,
            origCodeFileName: 'multi-line.js',
            instCodeFileName: 'multi-line_inst.js',
            inlineSourceMap:  false,
            sourceType:       'script',
        });
        // 拆分后有多行，source map 中应有多条不同行号的 IID 映射
        const sm = result.sourceMapObject ?? {};
        const lines = new Set(
            Object.values(sm).filter(Array.isArray).map(v => v[0])
        );
        assert.ok(lines.size >= 2, `拆分后应有多行 IID（实际 ${lines.size} 行）`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 复杂混淆模式（综合）
// ════════════════════════════════════════════════════════════════════════════════

describe('DeobfuscatePlugin / 复杂混淆模式', () => {
    test('混淆风格：逗号 + void + 常量 + 死代码组合', async () => {
        // FLAG 是变量赋值，插件不会折叠变量引用，
        // 但 void 0 替换 + 逗号拆分 + 常量折叠（1===1→true）仍应工作
        const obf = `
            var a = void 0, b = void 0;
            a = 1, b = 2, c = a + b;
            var FLAG = 1 === 1;
            if (!false) { alive(); }
            if (false) { deadCode(); }
        `;
        const { code } = await deob(obf);
        assert.ok(!code.includes('void 0'), 'void 0 应替换');
        assert.ok(!code.includes('deadCode'), '死代码应删除（if false 分支）');
        assert.ok(code.includes('alive'), '存活代码应保留');
        // 1===1 常量折叠
        assert.ok(code.includes('var FLAG = true'), '1===1 应折叠为 true');
    });

    test('混淆风格：嵌套三元折叠', async () => {
        // true ? (false ? "a" : "b") : "c" → "b"
        const { code } = await deob('var r = true ? (false ? "a" : "b") : "c";');
        assert.ok(code.includes('"b"'), '嵌套三元应折叠到最终值');
    });

    test('混淆风格：typeof 防御模式', async () => {
        // typeof undefined === "undefined" 是很常见的混淆防御代码
        // 流程：typeof undefined → "undefined" → "undefined" !== "undefined" → false
        //       → if (false) { panic(); } → 删除整条
        const { code } = await deob('if (typeof undefined !== "undefined") { panic(); }');
        assert.ok(!code.includes('panic'), '常量折叠 + 死代码删除应消除防御代码');
    });

    test('混淆风格：IIFE + 逗号 + 常量', async () => {
        const { code } = await deob(`
            (function() {
                var x = void 0, y = void 0;
                x = 1, y = 2;
            })();
        `, { flattenIIFE: true });
        // IIFE 展开后 void 0 替换 + 逗号拆分
        assert.ok(!code.includes('void 0'), 'void 0 应替换');
        assert.ok(!code.includes('function('), 'IIFE 应展开');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// NormalizeArrowPlugin — 箭头函数标准化
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 快捷调用：只使用 NormalizeArrowPlugin（script 模式）。
 */
async function normalizeArrow(code, opts = {}) {
    return preprocessCode(code, {
        plugins: [new NormalizeArrowPlugin(opts)],
        sourceType: 'script',
    });
}

describe('NormalizeArrowPlugin / 基本转换', () => {
    test('表达式体箭头函数 → function + return', async () => {
        const { code, stats } = await normalizeArrow('var f = x => x * 2;');
        assert.ok(!code.includes('=>'), '箭头函数应被转换');
        assert.ok(code.includes('function'), '应含 function 关键字');
        assert.ok(code.includes('return x * 2'), '表达式体应包裹为 return');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('块体箭头函数 → function（块体原样保留）', async () => {
        const { code, stats } = await normalizeArrow('var f = (x, y) => { var r = x + y; return r; };');
        assert.ok(!code.includes('=>'), '箭头函数应被转换');
        assert.ok(code.includes('function'), '应含 function 关键字');
        assert.ok(code.includes('var r = x + y'), '块体内容应保留');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('无参箭头函数 → function()', async () => {
        const { code } = await normalizeArrow('var f = () => 42;');
        assert.ok(!code.includes('=>'), '箭头函数应被转换');
        // 应生成 function() { return 42; }
        assert.ok(/function\s*\(\s*\)/.test(code), '无参 function 应正确生成');
        assert.ok(code.includes('return 42'), '表达式体应包裹为 return');
    });

    test('多参数箭头函数参数保留', async () => {
        const { code } = await normalizeArrow('var f = (a, b, c) => a + b + c;');
        assert.ok(!code.includes('=>'), '应转换');
        assert.ok(/function\s*\(a,\s*b,\s*c\)/.test(code), '三个参数应保留');
    });

    test('带默认参数的箭头函数', async () => {
        const { code } = await normalizeArrow('var f = (x = 0, y = 1) => x + y;');
        assert.ok(!code.includes('=>'), '应转换');
        assert.ok(code.includes('x = 0'), '默认参数应保留');
        assert.ok(code.includes('y = 1'), '默认参数应保留');
    });

    test('带解构参数的箭头函数', async () => {
        const { code } = await normalizeArrow('var f = ({a, b}) => a + b;');
        assert.ok(!code.includes('=>'), '应转换');
        assert.ok(code.includes('a'), '解构参数应保留');
    });

    test('带 rest 参数的箭头函数', async () => {
        const { code } = await normalizeArrow('var f = (...args) => args.length;');
        assert.ok(!code.includes('=>'), '应转换');
        assert.ok(code.includes('...args') || code.includes('args'), 'rest 参数应保留');
    });

    test('多个箭头函数全部转换，统计正确', async () => {
        const { code, stats } = await normalizeArrow(
            'var a = x => x; var b = y => y + 1; var c = z => z * 2;'
        );
        assert.ok(!code.includes('=>'), '所有箭头函数应被转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 3, '应转换 3 个');
    });

    test('嵌套箭头函数（均无 this/arguments）全部转换', async () => {
        const { code, stats } = await normalizeArrow(
            'var f = x => y => x + y;'
        );
        assert.ok(!code.includes('=>'), '嵌套箭头函数均应转换');
        // 外层 x => (内层 y => x + y) 都应转换
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 2, '嵌套两层均应转换');
    });

    test('回调中的箭头函数转换', async () => {
        const { code, stats } = await normalizeArrow(
            'arr.map(x => x * 2).filter(x => x > 0);'
        );
        assert.ok(!code.includes('=>'), '回调箭头函数应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 2);
    });
});

// ── 安全：不应转换的场景 ──────────────────────────────────────────────────────

describe('NormalizeArrowPlugin / [安全] 保守拒绝场景', () => {
    test('[安全] 含 this 的箭头函数不转换', async () => {
        const { code, stats } = await normalizeArrow(
            'var f = () => this.name;'
        );
        // 含 this，不应转换
        assert.ok(code.includes('=>'), '含 this 的箭头函数不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] 含 this 的方法内箭头函数不转换', async () => {
        const { code, stats } = await normalizeArrow(`
            var obj = {
                method: function() {
                    var fn = () => this.value;
                    return fn();
                }
            };
        `);
        // fn 箭头函数引用了 this（属于 method 的 this），不能转换
        assert.ok(code.includes('=>'), '引用 this 的箭头函数不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] 含 arguments 的箭头函数不转换', async () => {
        const { code, stats } = await normalizeArrow(`
            function outer() {
                var f = () => arguments[0];
                return f();
            }
        `);
        // 箭头函数访问外层 outer 的 arguments，不能转换
        assert.ok(code.includes('=>'), '含 arguments 的箭头函数不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] 含 super 的箭头函数不转换', async () => {
        const { code, stats } = await normalizeArrow(`
            class B extends A {
                foo() {
                    var fn = () => super.bar();
                    return fn();
                }
            }
        `);
        // 含 super，不能转换
        assert.ok(code.includes('=>'), '含 super 的箭头函数不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] 含 new.target 的箭头函数不转换', async () => {
        const { code, stats } = await normalizeArrow(`
            function outer() {
                var fn = () => new.target;
                return fn();
            }
        `);
        assert.ok(code.includes('=>'), '含 new.target 的箭头函数不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] async 箭头函数默认不转换', async () => {
        const { code, stats } = await normalizeArrow(
            'var f = async x => await fetch(x);'
        );
        // 默认 includeAsync=false，async 箭头不转换
        assert.ok(code.includes('=>'), 'async 箭头默认不转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] 类方法内的箭头函数不转换（即使无 this）', async () => {
        // 类体内的箭头函数即使不含 this，也保守跳过
        // 因为类体的上下文复杂（super/new.target 可能通过嵌套传递）
        const { code, stats } = await normalizeArrow(`
            class Foo {
                bar() {
                    return [1, 2, 3].map(x => x * 2);
                }
            }
        `);
        // x => x * 2 位于 ClassMethod bar() 内，应跳过
        assert.ok(code.includes('=>'), '类方法内的箭头不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });

    test('[安全] 类字段初始化器中的箭头函数不转换', async () => {
        const { code, stats } = await normalizeArrow(`
            class Foo {
                double = x => x * 2;
            }
        `);
        assert.ok(code.includes('=>'), '类字段中的箭头不应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 0);
    });
});

// ── 精确的边界场景 ────────────────────────────────────────────────────────────

describe('NormalizeArrowPlugin / 边界场景', () => {
    test('嵌套箭头：外层无 this、内层有 this → 仅内层跳过', async () => {
        // 外层 outer 不含 this（_containsThis 不进入嵌套函数，不会看到内层的 this）
        // 但内层 inner 含 this，所以内层跳过
        const { code, stats } = await normalizeArrow(`
            var outer = x => {
                var inner = () => this.value;
                return inner();
            };
        `);
        // inner 含 this → 不转换
        // outer 检查时：_containsThis 进入 outer 的 body，
        //   遇到 ArrowFunctionExpression(inner) 是 FUNCTION_BOUNDARY → 停止深入
        //   因此 outer 的体内"没有"this → outer 可以转换
        // 预期：outer 转换（=>, 变为 function），inner 保留（=>）
        const arrowCount = (code.match(/=>/g) ?? []).length;
        assert.equal(arrowCount, 1, '应只剩一个箭头函数（内层 inner）');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1, '应转换外层 1 个');
    });

    test('普通函数内的箭头函数（无 this）可以转换', async () => {
        // 箭头函数在普通函数内，但不引用任何危险绑定
        const { code, stats } = await normalizeArrow(`
            function process(arr) {
                return arr.map(x => x * 2);
            }
        `);
        assert.ok(!code.includes('=>'), '箭头函数应被转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('arguments 在形参中（不是引用）不阻止转换', async () => {
        // 形参叫 arguments 的情况由 scope.js 重命名处理，
        // 这里测试体内没有 arguments 引用的箭头函数可以正常转换
        // （注意：形参名 arguments 比较特殊，Babel 解析后形参 Identifier.name='arguments'，
        //   但它在 params 里，不在 body 里，_containsArguments 只扫描 body，所以安全）
        const { code, stats } = await normalizeArrow(
            'var f = (x, y) => x + y;'
        );
        assert.ok(!code.includes('=>'), '没有 arguments 引用的箭头函数应转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('this 在嵌套普通函数内不阻止外层箭头函数转换', async () => {
        // 嵌套的 FunctionExpression 是函数边界，其内的 this 不属于箭头函数
        const { code, stats } = await normalizeArrow(`
            var f = x => {
                var obj = { method: function() { return this.val; } };
                return obj;
            };
        `);
        // f 的 body 内有一个 FunctionExpression，_containsThis 遇到函数边界停止，
        // 不会看到 function() 内部的 this，所以 f 被转换
        assert.ok(!code.includes('=>'), 'this 在嵌套 function 内，不阻止外层箭头转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('super 在嵌套普通函数内不阻止外层箭头函数转换', async () => {
        // 注意：super 在非类方法里本来就是语法错误，Babel errorRecovery 模式会解析
        // 这里用 ObjectMethod 形式包裹，确保语法合法
        // 测试：嵌套函数内的 super 不影响外层箭头
        const { code, stats } = await normalizeArrow(`
            var f = x => {
                var o = { m() { return super.toString(); } };
                return o;
            };
        `);
        // super 在 ObjectMethod 内（函数边界），不影响 f 的判断
        assert.ok(!code.includes('=>'), 'super 在嵌套方法内，不阻止外层箭头转换');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('preset=normalize-arrow 可通过预设名使用', async () => {
        const { code, stats } = await preprocessCode('var f = x => x + 1;', {
            preset: 'normalize-arrow',
            sourceType: 'script',
        });
        assert.ok(!code.includes('=>'), 'preset normalize-arrow 应转换箭头函数');
        assert.ok(stats.NormalizeArrowPlugin, 'stats 中应有 NormalizeArrowPlugin');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 1);
    });

    test('与 DeobfuscatePlugin 组合使用', async () => {
        const { code, stats } = await preprocessCode(
            'var f = x => x + 0; var g = y => void 0;',
            {
                plugins: [
                    new NormalizeArrowPlugin(),
                    new DeobfuscatePlugin(),
                ],
                sourceType: 'script',
            }
        );
        // 箭头函数应被转换，void 0 应被替换
        assert.ok(!code.includes('=>'), '箭头函数应被转换');
        assert.ok(!code.includes('void 0'), 'void 0 应被替换');
        assert.ok(code.includes('undefined'), 'void 0 → undefined');
        assert.equal(stats.NormalizeArrowPlugin.arrowNormalized, 2);
    });
});

// ── 与插桩器集成：转换后箭头函数可收到 functionEnter/Exit 钩子 ────────────────

describe('NormalizeArrowPlugin → 插桩集成', () => {
    before(() => init({ ...ALL_CONFIG }));

    test('转换后代码可正常插桩', async () => {
        const raw = 'var double = x => x * 2; double(21);';
        const { code: normalized } = await normalizeArrow(raw);
        assert.ok(!normalized.includes('=>'), '预处理应消除箭头函数');

        let result;
        assert.doesNotThrow(() => {
            result = instrumentCode({
                code:             normalized,
                origCodeFileName: 'arrow.js',
                instCodeFileName: 'arrow_inst.js',
                sourceType:       'script',
            });
        }, '转换后的代码应可正常插桩');
        assert.ok(result.code.includes('J$.'), '插桩后代码应含钩子');
    });

    test('转换后函数插桩代码中含 J$.Fe（functionEnter 钩子）', async () => {
        // 原始代码是箭头函数，插桩器对箭头函数不注入 Fe
        // 预处理转换后，插桩器应为 function 注入 J$.Fe
        const raw = 'var f = x => x + 1;';
        const { code: normalized } = await normalizeArrow(raw);

        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             normalized,
            origCodeFileName: 'arrow_fe.js',
            instCodeFileName: 'arrow_fe_inst.js',
            sourceType:       'script',
        });
        // 普通 function 会注入 J$.Fe（functionEnter）
        assert.ok(instrCode.includes('J$.Fe'), '转换后的 function 应有 J$.Fe 钩子');
    });

    test('未经转换的箭头函数插桩后无 J$.Fe', async () => {
        // 对照组：不经过 NormalizeArrowPlugin，直接插桩
        // 插桩器对箭头函数不注入 J$.Fe
        const raw = 'var f = x => x + 1;';

        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code:             raw,
            origCodeFileName: 'arrow_no_fe.js',
            instCodeFileName: 'arrow_no_fe_inst.js',
            sourceType:       'script',
        });
        // 箭头函数不注入 J$.Fe（插桩器设计决定）
        assert.ok(!instrCode.includes('J$.Fe'), '未转换的箭头函数不应有 J$.Fe 钩子');
    });
});
