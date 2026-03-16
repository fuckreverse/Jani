/**
 * test/integration/dlint.test.mjs — dlint 规则端到端测试
 *
 * 验证所有 dlint 规则的实际触发效果：
 *  - CheckNaN: NaN 参与比较运算
 *  - CompareFunctionWithPrimitives: 函数与原始值比较
 *  - ConcatUndefinedToString: undefined/null 与字符串拼接
 *  - FunCalledWithMoreArguments: 函数实参多于形参
 *  - ShadowProtoProperty: 遮蔽原型链属性
 *  - UndefinedOffset: 用 undefined 作属性键
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { init, instrumentCode } from '../../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../../src/runtime/JalangiSandbox.js';
import { CheckNaN }             from '../../src/plugins/dlint/CheckNaN.js';
import { CompareFunctionWithPrimitives } from '../../src/plugins/dlint/CompareFunctionWithPrimitives.js';
import { ConcatUndefinedToString }       from '../../src/plugins/dlint/ConcatUndefinedToString.js';
import { FunCalledWithMoreArguments }    from '../../src/plugins/dlint/FunCalledWithMoreArguments.js';
import { ShadowProtoProperty }           from '../../src/plugins/dlint/ShadowProtoProperty.js';
import { UndefinedOffset }               from '../../src/plugins/dlint/UndefinedOffset.js';
import { ALL_CONFIG, runInSandbox }      from '../helpers/shared-helpers.mjs';

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 插桩代码并执行,使用指定的 dlint 规则,返回触发的违规次数。
 * 
 * @param {string} code 原始 JS 代码
 * @param {class} RuleClass dlint 规则类
 * @returns {object} { count: 违规次数, logs: 日志数组 }
 */
function runWithRule(code, RuleClass) {
    init({ ...ALL_CONFIG });
    const { code: instrCode } = instrumentCode({
        code,
        origCodeFileName: 'dlint-test.js',
        instCodeFileName: 'dlint-test_inst.js',
        inlineSourceMap: true,
    });

    const J$ = new JalangiSandbox();
    const logs = [];
    
    // 模拟 sandbox.log 方法
    J$.log = (msg) => logs.push(msg);
    
    // 模拟 getGlobalIID / iidToLocation 方法
    J$.getGlobalIID = (iid) => `${J$.sid}:${iid}`;
    J$.iidToLocation = (giid) => giid;

    const rule = new RuleClass(J$);
    J$.analysis = rule;

    try {
        runInSandbox(instrCode, J$);
        
        // 调用 endExecution 触发规则报告
        if (typeof rule.endExecution === 'function') {
            rule.endExecution();
        }
    } catch (err) {
        // 某些测试代码可能抛异常,不影响规则检测
    }

    // 从日志中提取违规次数
    let count = 0;
    for (const log of logs) {
        const match = log.match(/(\d+) time\(s\)/);
        if (match) {
            count += parseInt(match[1], 10);
        }
    }

    return { count, logs };
}

// ════════════════════════════════════════════════════════════════════════════════
// CheckNaN — 检测 NaN 参与比较运算
// ════════════════════════════════════════════════════════════════════════════════

describe('CheckNaN — NaN 比较检测', () => {
    test('NaN 参与 == 比较 — 应触发警告', () => {
        const code = `
            var x = NaN;
            var result = (x == 5);
        `;
        const { count } = runWithRule(code, CheckNaN);
        assert.ok(count > 0, 'NaN 参与比较应触发警告');
    });

    test('NaN 参与 === 比较 — 应触发警告', () => {
        const code = `
            var x = NaN;
            var result = (x === x);
        `;
        const { count } = runWithRule(code, CheckNaN);
        assert.ok(count > 0, 'NaN === NaN 应触发警告');
    });

    test('NaN 参与 < 比较 — 应触发警告', () => {
        const code = `
            var x = NaN;
            var result = (x < 10);
        `;
        const { count } = runWithRule(code, CheckNaN);
        assert.ok(count > 0, 'NaN 参与 < 比较应触发警告');
    });

    test('正常数值比较 — 不应触发警告', () => {
        const code = `
            var x = 5;
            var y = 10;
            var result = (x < y);
        `;
        const { count } = runWithRule(code, CheckNaN);
        assert.equal(count, 0, '正常数值比较不应触发警告');
    });

    test('多次 NaN 比较 — 累计计数', () => {
        const code = `
            var x = NaN;
            var r1 = (x == 1);
            var r2 = (x != 2);
            var r3 = (x > 3);
        `;
        const { count } = runWithRule(code, CheckNaN);
        assert.ok(count >= 3, `应触发 3 次警告，实际：${count}`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// CompareFunctionWithPrimitives — 函数与原始值比较
// ════════════════════════════════════════════════════════════════════════════════

describe('CompareFunctionWithPrimitives — 函数与原始值比较', () => {
    test('函数与数字比较 — 应触发警告', () => {
        const code = `
            function foo() { return 42; }
            var result = (foo == 42);
        `;
        const { count } = runWithRule(code, CompareFunctionWithPrimitives);
        assert.ok(count > 0, '函数与数字比较应触发警告');
    });

    test('函数与字符串比较 — 应触发警告', () => {
        const code = `
            function bar() { return 'hello'; }
            var result = (bar === 'hello');
        `;
        const { count } = runWithRule(code, CompareFunctionWithPrimitives);
        assert.ok(count > 0, '函数与字符串比较应触发警告');
    });

    test('函数与布尔值比较 — 应触发警告', () => {
        const code = `
            function check() { return true; }
            var result = (check == true);
        `;
        const { count } = runWithRule(code, CompareFunctionWithPrimitives);
        assert.ok(count > 0, '函数与布尔值比较应触发警告');
    });

    test('函数与对象比较 — 不应触发警告', () => {
        const code = `
            function foo() {}
            var obj = {};
            var result = (foo == obj);
        `;
        const { count } = runWithRule(code, CompareFunctionWithPrimitives);
        assert.equal(count, 0, '函数与对象比较不应触发警告');
    });

    test('正常函数调用比较 — 不应触发警告', () => {
        const code = `
            function getValue() { return 42; }
            var result = (getValue() == 42);
        `;
        const { count } = runWithRule(code, CompareFunctionWithPrimitives);
        assert.equal(count, 0, '函数调用结果比较不应触发警告');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ConcatUndefinedToString — undefined/null 与字符串拼接
// ════════════════════════════════════════════════════════════════════════════════

describe('ConcatUndefinedToString — undefined/null 拼接检测', () => {
    test('undefined 与字符串拼接 — 应触发警告', () => {
        const code = `
            var x = undefined;
            var result = 'value: ' + x;
        `;
        const { count } = runWithRule(code, ConcatUndefinedToString);
        assert.ok(count > 0, 'undefined 与字符串拼接应触发警告');
    });

    test('null 与字符串拼接 — 应触发警告', () => {
        const code = `
            var x = null;
            var result = 'value: ' + x;
        `;
        const { count } = runWithRule(code, ConcatUndefinedToString);
        assert.ok(count > 0, 'null 与字符串拼接应触发警告');
    });

    test('字符串在左侧 undefined 在右侧 — 应触发警告', () => {
        const code = `
            var x = undefined;
            var result = 'prefix' + x;
        `;
        const { count } = runWithRule(code, ConcatUndefinedToString);
        assert.ok(count > 0, '左字符串+右undefined 应触发警告');
    });

    test('undefined 在左侧字符串在右侧 — 应触发警告', () => {
        const code = `
            var x = undefined;
            var result = x + 'suffix';
        `;
        const { count } = runWithRule(code, ConcatUndefinedToString);
        assert.ok(count > 0, '左undefined+右字符串 应触发警告');
    });

    test('正常字符串拼接 — 不应触发警告', () => {
        const code = `
            var x = 'hello';
            var y = 'world';
            var result = x + ' ' + y;
        `;
        const { count } = runWithRule(code, ConcatUndefinedToString);
        assert.equal(count, 0, '正常字符串拼接不应触发警告');
    });

    test('数字与字符串拼接 — 不应触发警告', () => {
        const code = `
            var x = 42;
            var result = 'number: ' + x;
        `;
        const { count } = runWithRule(code, ConcatUndefinedToString);
        assert.equal(count, 0, '数字与字符串拼接不应触发警告');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// FunCalledWithMoreArguments — 函数实参多于形参
// ════════════════════════════════════════════════════════════════════════════════

describe('FunCalledWithMoreArguments — 实参数量检测', () => {
    test('实参多于形参 — 应触发警告', () => {
        const code = `
            function add(a, b) { return a + b; }
            var result = add(1, 2, 3);
        `;
        const { count } = runWithRule(code, FunCalledWithMoreArguments);
        assert.ok(count > 0, '实参多于形参应触发警告');
    });

    test('实参与形参相等 — 不应触发警告', () => {
        const code = `
            function multiply(x, y) { return x * y; }
            var result = multiply(3, 4);
        `;
        const { count } = runWithRule(code, FunCalledWithMoreArguments);
        assert.equal(count, 0, '实参与形参相等不应触发警告');
    });

    test('实参少于形参 — 不应触发警告', () => {
        const code = `
            function foo(a, b, c) { return a; }
            var result = foo(1);
        `;
        const { count } = runWithRule(code, FunCalledWithMoreArguments);
        assert.equal(count, 0, '实参少于形参不应触发警告');
    });

    test('含 rest 参数的函数 — 不应触发警告', () => {
        const code = `
            function sum(a, ...rest) { return a + rest.length; }
            var result = sum(1, 2, 3, 4);
        `;
        const { count } = runWithRule(code, FunCalledWithMoreArguments);
        assert.equal(count, 0, 'rest 参数函数不应触发警告');
    });

    test('构造函数调用 — 不检查', () => {
        const code = `
            function MyClass(x) { this.x = x; }
            var obj = new MyClass(1, 2, 3);
        `;
        const { count } = runWithRule(code, FunCalledWithMoreArguments);
        assert.equal(count, 0, '构造函数调用不应触发警告');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ShadowProtoProperty — 遮蔽原型链属性
// ════════════════════════════════════════════════════════════════════════════════

describe('ShadowProtoProperty — 原型属性遮蔽检测', () => {
    test('对象遮蔽原型方法 — 应触发警告', () => {
        const code = `
            var obj = Object.create({ foo: 10 });
            obj.foo = 20;
        `;
        const { count } = runWithRule(code, ShadowProtoProperty);
        assert.ok(count > 0, '遮蔽原型属性应触发警告');
    });

    test('数组实例遮蔽 Array.prototype 方法 — 应触发警告', () => {
        const code = `
            var arr = [];
            arr.push = function() { return 'custom'; };
        `;
        const { count } = runWithRule(code, ShadowProtoProperty);
        assert.ok(count > 0, '遮蔽 Array.prototype.push 应触发警告');
    });

    test('写入自有属性 — 不应触发警告', () => {
        const code = `
            var obj = { x: 1 };
            obj.x = 2;
        `;
        const { count } = runWithRule(code, ShadowProtoProperty);
        assert.equal(count, 0, '修改自有属性不应触发警告');
    });

    test('新增不在原型链的属性 — 不应触发警告', () => {
        const code = `
            var obj = {};
            obj.newProp = 123;
        `;
        const { count } = runWithRule(code, ShadowProtoProperty);
        assert.equal(count, 0, '新增属性不应触发警告');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// UndefinedOffset — undefined 作属性键
// ════════════════════════════════════════════════════════════════════════════════

describe('UndefinedOffset — undefined 属性键检测', () => {
    test('undefined 作为属性键读取 — 应触发警告', () => {
        const code = `
            var obj = { undefined: 'value' };
            var key = undefined;
            var result = obj[key];
        `;
        const { count } = runWithRule(code, UndefinedOffset);
        assert.ok(count > 0, 'undefined 作属性键读取应触发警告');
    });

    test('undefined 作为属性键写入 — 应触发警告', () => {
        const code = `
            var obj = {};
            var key = undefined;
            obj[key] = 'value';
        `;
        const { count } = runWithRule(code, UndefinedOffset);
        assert.ok(count > 0, 'undefined 作属性键写入应触发警告');
    });

    test('正常属性键访问 — 不应触发警告', () => {
        const code = `
            var obj = { x: 10 };
            var result = obj.x;
        `;
        const { count } = runWithRule(code, UndefinedOffset);
        assert.equal(count, 0, '正常属性访问不应触发警告');
    });

    test('字符串 "undefined" 作属性键 — 不应触发警告', () => {
        const code = `
            var obj = { 'undefined': 'value' };
            var result = obj['undefined'];
        `;
        const { count } = runWithRule(code, UndefinedOffset);
        assert.equal(count, 0, '字符串 "undefined" 作属性键不应触发警告');
    });

    test('计算属性名为 undefined — 应触发警告', () => {
        const code = `
            var obj = {};
            var key;
            obj[key] = 100;
        `;
        const { count } = runWithRule(code, UndefinedOffset);
        assert.ok(count > 0, '未初始化变量作属性键应触发警告');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 综合场景 — 多规则联合检测
// ════════════════════════════════════════════════════════════════════════════════

describe('dlint — 综合场景', () => {
    test('同一代码触发多个规则', () => {
        const code = `
            function foo() { return 42; }
            var x = undefined;
            var r1 = (foo == 42);
            var r2 = 'value: ' + x;
        `;

        const { count: nanCount } = runWithRule(code, CheckNaN);
        const { count: funcCmpCount } = runWithRule(code, CompareFunctionWithPrimitives);
        const { count: concatCount } = runWithRule(code, ConcatUndefinedToString);

        assert.ok(funcCmpCount > 0, '应触发函数比较警告');
        assert.ok(concatCount > 0, '应触发字符串拼接警告');
    });

    test('循环中重复违规 — 累计计数', () => {
        const code = `
            var x = NaN;
            var count = 0;
            for (var i = 0; i < 10; i++) {
                if (x == i) count++;
            }
        `;
        const { count } = runWithRule(code, CheckNaN);
        assert.ok(count >= 10, `循环中应累计触发，实际：${count}`);
    });

    test('规则实例独立性 — 两次运行互不影响', () => {
        const code1 = `var x = NaN; var r = (x == 1);`;
        const code2 = `var y = 5; var s = (y == 5);`;

        const { count: count1 } = runWithRule(code1, CheckNaN);
        const { count: count2 } = runWithRule(code2, CheckNaN);

        assert.ok(count1 > 0, '第一次运行应触发');
        assert.equal(count2, 0, '第二次运行不应触发（规则实例独立）');
    });
});
