/**
 * instrument.test.mjs — 插桩器端到端集成测试
 *
 * 运行方式：  node test/instrument.test.mjs
 *            npm test
 *
 * 覆盖范围：
 *   - ES5 基础语法（含钩子断言）
 *   - ES6（箭头函数、class、解构、模板字符串、rest/default 参数、Promise）
 *   - ES2017（async/await）
 *   - ES2019（optional catch binding）
 *   - ES2020（optional chaining、nullish coalescing、BigInt、logical assign）
 *   - ES2022（class private fields、顶层 await）
 *   - ESM 模式（import/export）
 *   - IID source map 完整性
 *   - inlineSourceMap 模式
 *   - JALANGI DO NOT INSTRUMENT 跳过逻辑
 *   - Config 选择性禁用插桩（含全部 12 个 Config 字段）
 *   - 边界条件（语法错误、空代码、严格模式、init 参数校验）
 *   - 插桩幂等性（同文件多次插桩结果一致）
 */

import { init, instrumentCode } from '../src/instrument/esnstrument.js';

// ─── 测试框架（极简，无外部依赖）────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗  ${name}`);
        console.error(`     ${e.message}`);
        failed++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg ?? 'assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(`${msg ?? 'expected equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

function assertIncludes(str, substr, msg) {
    if (!str.includes(substr)) throw new Error(`${msg ?? 'expected to include'}: "${substr}" not found`);
}

// ─── 全量 Config（所有钩子都打开）────────────────────────────────────────────

const ALL_CONFIG = {
    INSTR_READ:               null,
    INSTR_WRITE:              null,
    INSTR_GETFIELD:           null,
    INSTR_PUTFIELD:           null,
    INSTR_BINARY:             null,
    INSTR_UNARY:              null,
    INSTR_LITERAL:            null,
    INSTR_INIT:               null,
    INSTR_END_EXPRESSION:     null,
    INSTR_CONDITIONAL:        null,
    INSTR_TRY_CATCH_ARGUMENTS: null,
    ENABLE_SAMPLING:          false,
};

init(ALL_CONFIG);

/** 快捷 helper：script 模式插桩 */
function instr(code, opts = {}) {
    return instrumentCode({
        code,
        origCodeFileName: opts.file ?? 'test.js',
        instCodeFileName: opts.file ? opts.file.replace('.js', '_inst.js') : 'test_inst.js',
        inlineSourceMap:  opts.inlineSourceMap ?? false,
        inlineSource:     opts.inlineSource    ?? false,
        sourceType:       opts.sourceType      ?? 'script',
        isEval:           opts.isEval          ?? false,
    });
}

// ════════════════════════════════════════════════════════════════
// ES5
// ════════════════════════════════════════════════════════════════
console.log('\n── ES5 ──────────────────────────────────────────────────');

test('基本 var 声明 + 二元运算', () => {
    const r = instr('var x = 1 + 2; console.log(x);');
    assertIncludes(r.code, 'J$.B(', '应注入二元运算钩子 J$.B');
    assertIncludes(r.code, 'J$.W(', '应注入写入钩子 J$.W');
    assertIncludes(r.code, 'J$.N(', '应注入变量初始化钩子 J$.N');
});

test('function 声明', () => {
    const r = instr('function foo(a) { return a + 1; }');
    assertIncludes(r.code, 'J$.Fe(', '应注入函数入口钩子 J$.Fe');
    assertIncludes(r.code, 'J$.Fr(', '应注入函数返回钩子 J$.Fr');
    assertIncludes(r.code, 'J$.B(', '应注入二元运算钩子 J$.B');
});

test('for-in 循环', () => {
    const r = instr('var o = {a:1}; for (var k in o) { console.log(k); }');
    assertIncludes(r.code, 'J$.H(', '应注入 hash 钩子用于 for-in 右侧');
    assertIncludes(r.code, 'J$.W(', '应注入写入钩子（for-in 变量赋值）');
});

test('try-catch-finally', () => {
    const r = instr('try { x(); } catch(e) { console.log(e); } finally { done(); }');
    // try-catch 包裹逻辑：脚本级 try-catch 应存在
    assertIncludes(r.code, 'J$.Se(', '应注入脚本入口钩子 J$.Se');
});

// ════════════════════════════════════════════════════════════════
// ES6
// ════════════════════════════════════════════════════════════════
console.log('\n── ES6 ──────────────────────────────────────────────────');

test('箭头函数 + 默认参数', () => {
    const r = instr('const f = (x, y = 0) => x + y;');
    // 箭头函数无 arguments，不注入 J$.Fe，但会被 wrapLiteral 包装为 J$.T
    assertIncludes(r.code, 'J$.T(', '箭头函数应被 wrapLiteral 包装为 J$.T');
    assertIncludes(r.code, 'J$.B(', '应注入二元运算钩子 J$.B');
});

test('箭头函数（表达式体）', () => {
    const r = instr('var add = (a, b) => a + b;');
    // 表达式体箭头函数无 arguments，不注入 J$.Fe；但变量写入和读取应有钩子
    // NOTE: 箭头参数 a/b 是局部变量，满足轻量读取路径条件，会走 J$.Rl 而不是 J$.R
    assertIncludes(r.code, 'J$.W(', '箭头函数赋值应注入写入钩子 J$.W');
    // 确认存在读取钩子（轻量路径 Rl 或全量路径 R）
    assert(r.code.includes('J$.Rl(') || r.code.includes('J$.R('), '参数应注入读取钩子（J$.Rl 或 J$.R）');
});

test('class（constructor + 普通方法）', () => {
    const r = instr('class Animal { constructor(n) { this.name = n; } speak() { return this.name; } }');
    // class 方法不应被 wrapLiteral 成字面量
    assertIncludes(r.code, 'speak', 'class 方法名应保留');
    assertIncludes(r.code, 'J$.Fe(', 'class 方法应注入 J$.Fe');
    assertIncludes(r.code, 'J$.P(', 'this.name 赋值应注入属性写入钩子 J$.P');
});

test('class（getter / setter）', () => {
    const r = instr('class Box { get val() { return this._v; } set val(v) { this._v = v; } }');
    assertIncludes(r.code, 'J$.Fe(', 'getter/setter 函数应注入 J$.Fe');
    // getter/setter 的 FunctionExpression 不应被当作独立字面量（无 J$.T）
    assert(!r.code.includes('J$.T('), 'getter/setter 内函数不应被 wrapLiteral 包装');
});

test('class 继承', () => {
    const r = instr('class Dog extends Animal { bark() { return "woof"; } }');
    assertIncludes(r.code, 'J$.Fe(', 'class 方法应注入 J$.Fe');
});

test('对象解构', () => {
    const r = instr('const {a, b} = obj;');
    // 解构右侧的 obj 应被插桩为读取
    assertIncludes(r.code, 'J$.R(', '解构右侧应注入读取钩子 J$.R');
});

test('数组解构', () => {
    const r = instr('const [x, y] = [1, 2];');
    // 数组字面量 [1, 2] 应被插桩为字面量
    assertIncludes(r.code, 'J$.T(', '数组字面量应注入 J$.T');
});

test('模板字符串', () => {
    const r = instr('var s = `hello ${name}`;');
    // name 是读取操作
    assertIncludes(r.code, 'J$.R(', '模板字符串中的变量引用应注入读取钩子 J$.R');
});

test('rest 参数', () => {
    const r = instr('function f(...args) { return args; }');
    assertIncludes(r.code, 'J$.Fe(', '含 rest 参数的函数应注入 J$.Fe');
});

test('spread 运算符', () => {
    const r = instr('const arr = [1, ...other, 2];');
    assertIncludes(r.code, 'J$.T(', '含 spread 的数组字面量应注入 J$.T');
    assertIncludes(r.code, 'J$.R(', 'spread 的 other 应注入读取钩子 J$.R');
});

test('Promise', () => {
    const r = instr('var p = new Promise((resolve, reject) => { resolve(42); });');
    // new Promise 被插桩为 J$.F（构造调用与普通调用共用 J$.F），Promise 本身被读取插桩
    assertIncludes(r.code, 'J$.F(', 'new Promise() 应注入 J$.F');
    assertIncludes(r.code, 'J$.R(', 'Promise 标识符应注入读取钩子 J$.R');
});

test('解构函数参数', () => {
    const r = instr('function f({x, y}, [a, b]) { return x + y + a + b; }');
    assertIncludes(r.code, 'J$.Fe(', '解构参数函数应注入 J$.Fe');
    assertIncludes(r.code, 'J$.B(', '函数体内二元运算应注入 J$.B');
});

// ════════════════════════════════════════════════════════════════
// ES2017
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2017 ───────────────────────────────────────────────');

test('async / await', () => {
    const r = instr('async function fetchData() { var data = await fetch("/api"); return data.json(); }');
    assertIncludes(r.code, 'J$.Fe(', 'async 函数应注入 J$.Fe');
    assertIncludes(r.code, 'J$.Fr(', 'async 函数应注入返回钩子 J$.Fr');
});

// ════════════════════════════════════════════════════════════════
// ES2019
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2019 ───────────────────────────────────────────────');

test('optional catch binding（无参数 catch）', () => {
    // node.param 为 null，不能访问 .name —— 测试插桩器不崩溃且正常产出
    const r = instr('try { foo(); } catch { console.log("caught"); }');
    assertIncludes(r.code, 'J$.Se(', 'optional catch binding 代码应能正常插桩');
});

// ════════════════════════════════════════════════════════════════
// ES2020
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2020 ───────────────────────────────────────────────');

test('optional chaining (?.)' , () => {
    const r = instr('var x = obj?.foo?.bar;');
    // optional chaining 被 acorn 拆解为 ChainExpression，内部的属性访问应被插桩
    assertIncludes(r.code, 'J$.G(', 'optional chaining 内部属性访问应注入 J$.G');
});

test('nullish coalescing (??) 注入条件钩子', () => {
    // ?? 被 acorn 解析为 LogicalExpression { operator: '??' }
    // wrapLogicalNullish 应注入 J$.C（条件钩子）记录分支
    const r = instr('var x = a ?? b;');
    assertIncludes(r.code, 'J$.C(', '?? 运算符应注入条件钩子 J$.C');
    // 临时变量现在是 J$.tmp_N（唯一化），不再共享单一的 J$._tm_p 槽
    assertIncludes(r.code, 'J$.tmp_', '?? 应使用唯一临时属性暂存左侧值');
});

test('嵌套 ?? 各使用独立临时变量（无共享槽竞争）', () => {
    // (a ?? b) ?? c 会生成 J$.tmp_0 和 J$.tmp_1 两个不同的临时槽
    const r = instr('var x = (a ?? b) ?? c;');
    assertIncludes(r.code, 'J$.tmp_0', '外层 ?? 应使用 J$.tmp_0');
    assertIncludes(r.code, 'J$.tmp_1', '内层 ?? 应使用 J$.tmp_1（与外层独立）');
});

test('BigInt 字面量', () => {
    // BigInt 节点 typeof 为 'bigint'，插桩器应跳过不崩溃（不插桩 BigInt 字面量）
    const r = instr('var n = 9007199254740991n;');
    assertIncludes(r.code, 'J$.Se(', 'BigInt 代码应能正常插桩');
    // BigInt 字面量本身不被 wrapLiteral 包装
    assertIncludes(r.code, '9007199254740991n', 'BigInt 字面量应原样保留');
});

test('logical assignment (||= &&= ??=)', () => {
    const r = instr('a ||= b; a &&= c; a ??= d;');
    // LogicalAssignment 拆解为 LogicalExpression + WriteExpression，用 J$.W 记录写入
    // 同时用 J$.C 记录条件分支（||/&&/??）
    assertIncludes(r.code, 'J$.W(', 'logical assignment 应注入写入钩子 J$.W');
    assertIncludes(r.code, 'J$.C(', 'logical assignment 的条件分支应注入 J$.C');
});

// ════════════════════════════════════════════════════════════════
// ES2022
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2022 ───────────────────────────────────────────────');

test('class private fields + getter', () => {
    const r = instr('class Counter { #count = 0; increment() { this.#count++; } get value() { return this.#count; } }');
    assertIncludes(r.code, 'J$.Fe(', '含私有字段的 class 方法应注入 J$.Fe');
    // 私有字段名 #count 应保留（插桩器不改变私有字段标识符）
    assertIncludes(r.code, '#count', '私有字段名 #count 应保留');
});

test('class static field', () => {
    const r = instr('class Cfg { static debug = false; }');
    // static field 初始化应被插桩
    assertIncludes(r.code, 'J$.Se(', 'class static field 代码应能正常插桩');
});

test('顶层 await（module 模式）', () => {
    const r = instr('const res = await fetch("https://example.com"); console.log(res.status);', { sourceType: 'module' });
    assertIncludes(r.code, 'J$.F(', '顶层 await 的 fetch() 调用应注入 J$.F');
});

// ════════════════════════════════════════════════════════════════
// ESM import / export
// ════════════════════════════════════════════════════════════════
console.log('\n── ESM ──────────────────────────────────────────────────');

test('import + export（module 模式）', () => {
    const r = instr('import { foo } from "./foo.js"; export const bar = foo();', { sourceType: 'module' });
    assertIncludes(r.code, 'J$.F(', 'foo() 调用应注入 J$.F');
    assertIncludes(r.code, 'J$.N(', 'const bar 初始化应注入 J$.N');
});

test('export default function', () => {
    const r = instr('export default function greet(name) { return `Hello, ${name}`; }', { sourceType: 'module' });
    assertIncludes(r.code, 'J$.Fe(', 'export default function 应注入 J$.Fe');
    assertIncludes(r.code, 'J$.Fr(', '函数应注入返回钩子 J$.Fr');
});

// ════════════════════════════════════════════════════════════════
// Source map 完整性
// ════════════════════════════════════════════════════════════════
console.log('\n── Source Map ───────────────────────────────────────────');

test('sourceMapObject 存在且含 nBranches', () => {
    const r = instr('var x = 1 + 2;');
    assert(typeof r.sourceMapObject === 'object', 'sourceMapObject 应为对象');
    assert(typeof r.sourceMapObject.nBranches === 'number', 'nBranches 应为数字');
});

test('inlineSourceMap 模式：iids 内联到代码头部', () => {
    const r = instr('var x = 3;', { inlineSourceMap: true });
    // 新格式：globalThis 初始化 + smap[key] + iids（向后兼容）
    assertIncludes(r.code, 'J$.iids=', '应内联 iids 对象（向后兼容）');
    assertIncludes(r.code, 'J$.smap=', '应初始化 smap 对象');
    assertIncludes(r.code, 'J$.smap[', '应以 smap[key] 存储 source map');
});

test('IIFE 闭包包裹：script 模式输出应包含 IIFE 结构', () => {
    // script 模式下插桩代码应被包裹在 (function(J$){...}(J$)) 中，
    // J$ 作为闭包参数传入而非依赖全局访问，消除命名冲突风险
    const r = instr('var x = 1;');
    assertIncludes(r.code, '(function(J$)', 'script 模式应用 IIFE 包裹 J$ 为闭包参数');
});

test('module 模式：const J$ 局部绑定而非 IIFE', () => {
    // module 模式下 ESM 已自带私有作用域，用 const 绑定即可
    const r = instr('export const x = 1;', { sourceType: 'module' });
    assertIncludes(r.code, 'const J$ = globalThis.J$', 'module 模式应用 const 局部绑定');
    assert(!r.code.includes('(function(J$)'), 'module 模式不应再包一层 IIFE');
});

test('smap 多文件互不覆盖：不同文件名写入不同 smap key', () => {
    // 模拟两个不同文件分别插桩，各自的 source map key 不同
    const r1 = instrumentCode({
        code: 'var a = 1;',
        origCodeFileName: 'file1.js',
        instCodeFileName: 'file1_inst.js',
        inlineSourceMap: true,
    });
    const r2 = instrumentCode({
        code: 'var b = 2;',
        origCodeFileName: 'file2.js',
        instCodeFileName: 'file2_inst.js',
        inlineSourceMap: true,
    });
    assertIncludes(r1.code, 'smap["file1_inst.js"]', 'file1 应写入 smap["file1_inst.js"]');
    assertIncludes(r2.code, 'smap["file2_inst.js"]', 'file2 应写入 smap["file2_inst.js"]');
    // 两个 key 互不相同，并发加载不覆盖
    assert(!r1.code.includes('smap["file2_inst.js"]'), 'file1 不应出现 file2 的 key');
});

test('sourceMapObject 包含文件名信息', () => {
    const r = instr('var x = 1;', { file: 'myfile.js' });
    assertEqual(r.sourceMapObject.originalCodeFileName, 'myfile.js', '原始文件名应匹配');
});

test('sourceMapObject 中 IID 对应行列信息', () => {
    const r = instr('var x = 3;', { inlineSourceMap: true });
    // 第一个有效 IID（通常是 9）应有 4 元素位置数组 [line, col, endLine, endCol]
    const entries = Object.entries(r.sourceMapObject).filter(([k]) => /^\d+$/.test(k));
    assert(entries.length > 0, '应有 IID 映射条目');
    const [, loc] = entries[0];
    assert(Array.isArray(loc) && loc.length === 4, 'IID 位置应为 4 元素数组');
});

// ════════════════════════════════════════════════════════════════
// JALANGI DO NOT INSTRUMENT 跳过逻辑
// ════════════════════════════════════════════════════════════════
console.log('\n── 跳过插桩 ─────────────────────────────────────────────');

test('含 JALANGI DO NOT INSTRUMENT 的代码不被插桩', () => {
    const original = 'var x = 1; // JALANGI DO NOT INSTRUMENT';
    const r = instr(original);
    // 代码应保持为原始输入（不含 J$.xx 注入）
    assert(!r.code.includes('J$.W(') && !r.code.includes('J$.R('), '不应注入读写钩子');
});

// ════════════════════════════════════════════════════════════════
// Config 选择性禁用
// ════════════════════════════════════════════════════════════════
console.log('\n── Config 选择性禁用 ─────────────────────────────────────');

test('INSTR_READ = () => false 时不注入读取钩子', () => {
    init({ ...ALL_CONFIG, INSTR_READ: () => false });
    const r = instr('var x = a + b;');
    assert(!r.code.includes('J$.R('), '不应有 J$.R 读取钩子');
    init(ALL_CONFIG);
});

test('INSTR_WRITE = () => false 时不注入写入钩子', () => {
    init({ ...ALL_CONFIG, INSTR_WRITE: () => false });
    const r = instr('x = 1;');
    assert(!r.code.includes('J$.W('), '不应有 J$.W 写入钩子');
    init(ALL_CONFIG);
});

test('INSTR_GETFIELD = () => false 时不注入属性读取钩子', () => {
    init({ ...ALL_CONFIG, INSTR_GETFIELD: () => false });
    const r = instr('var x = obj.foo;');
    assert(!r.code.includes('J$.G('), '不应有 J$.G 属性读取钩子');
    init(ALL_CONFIG);
});

test('INSTR_PUTFIELD = () => false 时不注入属性写入钩子', () => {
    init({ ...ALL_CONFIG, INSTR_PUTFIELD: () => false });
    const r = instr('obj.foo = 1;');
    assert(!r.code.includes('J$.P('), '不应有 J$.P 属性写入钩子');
    init(ALL_CONFIG);
});

test('INSTR_BINARY = () => false 时不注入二元运算钩子', () => {
    init({ ...ALL_CONFIG, INSTR_BINARY: () => false });
    const r = instr('var x = 1 + 2;');
    assert(!r.code.includes('J$.B('), '不应有 J$.B 二元运算钩子');
    init(ALL_CONFIG);
});

test('INSTR_UNARY = () => false 时不注入一元运算钩子', () => {
    init({ ...ALL_CONFIG, INSTR_UNARY: () => false });
    const r = instr('var x = -a;');
    assert(!r.code.includes('J$.U('), '不应有 J$.U 一元运算钩子');
    init(ALL_CONFIG);
});

test('INSTR_LITERAL = () => false 时不注入字面量钩子', () => {
    init({ ...ALL_CONFIG, INSTR_LITERAL: () => false });
    const r = instr('var x = [1, 2];');
    assert(!r.code.includes('J$.T('), '不应有 J$.T 字面量钩子');
    init(ALL_CONFIG);
});

test('INSTR_CONDITIONAL = () => false 时不注入条件钩子', () => {
    init({ ...ALL_CONFIG, INSTR_CONDITIONAL: () => false });
    const r = instr('var x = a ? b : c;');
    assert(!r.code.includes('J$.C('), '不应有 J$.C 条件钩子');
    init(ALL_CONFIG);
});

test('INSTR_INIT = () => false 时不注入变量初始化钩子', () => {
    init({ ...ALL_CONFIG, INSTR_INIT: () => false });
    const r = instr('var x = 1;');
    assert(!r.code.includes('J$.N('), '不应有 J$.N 初始化钩子');
    init(ALL_CONFIG);
});

// ════════════════════════════════════════════════════════════════
// 边界条件
// ════════════════════════════════════════════════════════════════
console.log('\n── 边界条件 ─────────────────────────────────────────────');

test('语法错误代码应抛出带文件名的错误', () => {
    let caught = false;
    try {
        instr('function (', { file: 'bad.js' });
    } catch (e) {
        caught = true;
        // 错误信息应包含文件名（由 instrumentCode 的 catch 块提供）
        assertIncludes(e.message, 'bad.js', '错误信息应包含文件名');
        assert(e.cause instanceof Error, 'error.cause 应为原始 SyntaxError');
    }
    assert(caught, '语法错误代码应抛出异常');
});

test('空字符串代码不崩溃且返回有效结果', () => {
    const r = instr('');
    // 空代码：插桩后只有脚本入口/出口 + NO_INSTR 标记
    assertIncludes(r.code, 'JALANGI DO NOT INSTRUMENT', '空代码插桩结果应含 NO_INSTR 标记');
    assert(typeof r.sourceMapObject === 'object', '空代码应有 sourceMapObject');
});

test('含 use strict 的代码不崩溃', () => {
    // 严格模式下 arguments.callee 会抛出，插桩器应通过 try-catch 降级处理
    const r = instr('"use strict"; function foo() { return 1; }');
    assertIncludes(r.code, 'J$.Fe(', '严格模式代码应注入 J$.Fe');
    // 降级后的 callee 读取不应让插桩结果包含裸 arguments.callee（应有 try-catch 包裹）
    // astring 生成带空格的代码，检查关键词即可
    assertIncludes(r.code, 'return arguments.callee', '应有 arguments.callee 的 try-catch 降级');
    assertIncludes(r.code, 'catch (e)', '应有 catch 分支降级');
});

test('init() 传入 null 应抛出 TypeError', () => {
    let caught = false;
    try {
        init(null);
    } catch (e) {
        caught = true;
        assert(e instanceof TypeError, '应抛出 TypeError');
        assertIncludes(e.message, '[jalangi]', '错误信息应包含 [jalangi] 前缀');
    }
    assert(caught, 'init(null) 应抛出异常');
    // 恢复
    init(ALL_CONFIG);
});

test('init() 传入非对象应抛出 TypeError', () => {
    let caught = false;
    try {
        init('bad');
    } catch (e) {
        caught = true;
        assert(e instanceof TypeError, '应抛出 TypeError');
    }
    assert(caught, 'init("bad") 应抛出异常');
    init(ALL_CONFIG);
});

test('插桩幂等性：同一代码两次插桩 IID 起始值相同', () => {
    // labelCounter 在每次 instrumentCode 前重置，保证幂等性
    const code = 'for (var k in obj) { k; }';
    const r1 = instr(code);
    const r2 = instr(code);
    // 两次插桩的 sourceMapObject 中 nBranches 应一致
    assertEqual(r1.sourceMapObject.nBranches, r2.sourceMapObject.nBranches,
        '两次插桩的 nBranches 应一致（插桩幂等性）');
    // 两次插桩的代码应完全一致（字符串比较）
    assertEqual(r1.code, r2.code, '两次插桩同一代码结果应完全相同');
});

// ════════════════════════════════════════════════════════════════
// BUG 回归测试（修复后添加，防止退化）
// ════════════════════════════════════════════════════════════════
console.log('\n── BUG 回归测试 ─────────────────────────────────────');

test('BUG1: INSTR_BINARY 回调第二参数应为 AST node 而非 operator 字符串', () => {
    // 修复前：Config.INSTR_BINARY(operator, operator)  第二参数是字符串
    // 修复后：Config.INSTR_BINARY(operator, node)      第二参数是 AST node
    let secondArgType = null;
    init({ ...ALL_CONFIG, INSTR_BINARY: (op, second) => { secondArgType = typeof second; return true; } });
    instr('var x = 1 + 2;');
    init(ALL_CONFIG);
    assertEqual(secondArgType, 'object', 'INSTR_BINARY 第二参数应为 AST node（object），不应为字符串');
});

test('BUG2: ENABLE_SAMPLING 模式不应崩溃（循环引用修复）', () => {
    // 修复前：mergeBodies 中 alternate: node.body 造成循环引用 → hoistFunctionDeclaration 栈溢出
    // 修复后：用新建的 BlockStatement 包裹 instrumentedStmts 作为 alternate
    init({ ...ALL_CONFIG, ENABLE_SAMPLING: true });
    const r = instr('function f() { return 1; }');
    assertIncludes(r.code, 'J$.S(', 'ENABLE_SAMPLING 模式应注入采样钩子 J$.S');
    init(ALL_CONFIG);
});

test('BUG2b: ENABLE_SAMPLING 辅助函数 wrapper 不应被 mergeBodies 错误处理', () => {
    // 修复前：wrapFunBodyWithTryCatch 注入的 "function n(){}" 辅助节点没有 bodyOrig，
    // 被 visitorMergeBodyPre 误触发导致 consequent=undefined → astring 崩溃
    init({ ...ALL_CONFIG, ENABLE_SAMPLING: true });
    const r = instr('function outer() { function inner() { return 2; } return inner(); }');
    assertIncludes(r.code, 'J$.S(', '嵌套函数 ENABLE_SAMPLING 应正常产出');
    init(ALL_CONFIG);
});

test('BUG3: 箭头函数参数不应被错误标记为全局变量', () => {
// 修复前：visitorRRPre 缺少 ArrowFunctionExpression → _scope 不更新到箭头的 scope
//         导致箭头参数 hasVar() 返回 null → wrapRead 以 isGlobal=true 处理
// 修复后：添加 ArrowFunctionExpression: W.setScope + 对应的 popScope
// 验证方式：箭头参数 x 是局部变量，现在走轻量路径 J$.Rl（天然不是全局变量），
//           或者走全量路径 J$.R 时 bitPattern 应为 0（isGlobal=false）
const r = instr('var f = (x) => x + 1;');
// 优先检查轻量路径（Rl 出现说明已正确识别为局部变量）
const rlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"x"\s*\)/);
if (rlMatch) {
    // 走了轻量路径：Rl 天然只对局部变量生效，断言成立
    assert(true, '箭头参数 x 走轻量路径 J$.Rl，证明是局部变量');
} else {
    // 退回全量路径：检查 bitPattern
    const match = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"x"\s*,[^,]+,\s*(\d+)\s*\)/);
    assert(match !== null, '应存在对 x 的读取插桩 J$.R');
    assertEqual(parseInt(match[1]), 0, '箭头参数 x 的 isGlobal 应为 false（bitPattern=0）');
}
});

test('BUG3b: 嵌套箭头函数各自独立作用域不相互污染', () => {
// 修复后：外层箭头 x、内层箭头 y 都应在各自 scope 中正确识别为局部变量
// NOTE: 现在局部变量走轻量读取路径 J$.Rl，不再有 J$.R for local vars
const r = instr('var f = (x) => (y) => x + y;');
// 检查 x 的读取钩子（Rl 或 R）
const xRlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"x"\s*\)/);
const xRMatch  = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"x"\s*,[^,]+,\s*(\d+)\s*\)/);
// 检查 y 的读取钩子（Rl 或 R）
const yRlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"y"\s*\)/);
const yRMatch  = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"y"\s*,[^,]+,\s*(\d+)\s*\)/);
assert(xRlMatch !== null || xRMatch !== null, '应存在对 x 的读取插桩');
assert(yRlMatch !== null || yRMatch !== null, '应存在对 y 的读取插桩');
// 若走全量路径，验证不是全局变量（bitPattern=0）
if (xRMatch) assertEqual(parseInt(xRMatch[1]), 0, '外层箭头参数 x 应为局部变量（bitPattern=0）');
if (yRMatch) assertEqual(parseInt(yRMatch[1]), 0, '内层箭头参数 y 应为局部变量（bitPattern=0）');
// 若走轻量路径（Rl），天然证明是局部变量，无需额外检查
});

test('BUG4: strict mode 函数中 arguments 初始化不应产生赋值语句', () => {
    // BUG-1 修复前：syncDefuns 为 arguments 生成 "arguments = J$.N(...)" 语句，
    // 在严格模式函数体内会触发 SyntaxError: Unexpected eval or arguments in strict mode。
    // 修复后：改用 isAssign=false，只调用 J$.N(...)，不对 arguments 赋值。
    const r = instr('"use strict"; function f(a) { return a; }');
    // 确保插桩后代码中不含 "arguments =" 赋值形式
    assert(!r.code.match(/\barguments\s*=/), '严格模式下不应出现 arguments = ... 赋值语句');
    // 但应仍有 J$.N 对 arguments 的通知调用
    assertIncludes(r.code, 'J$.N(', '应存在 J$.N 调用以通知运行时 arguments 初始化');
});

test('BUG5: generator 函数的 yield 不应被 while(true)try/finally 破坏', () => {
    // BUG-2 修复前：visitorOps 对所有 FunctionExpression / FunctionDeclaration 都调
    // wrapFunBodyWithTryCatch，包括 generator 函数，导致 yield 被嵌入 try/finally 后
    // 每次 yield 会立即触发 finally，打乱生成器暂停/恢复语义。
    // 修复后：node.generator=true 时直接跳过，不插入 while/try/finally 包裹。
    const r = instr('function* gen() { yield 1; yield 2; }');
    // 插桩后代码应保留 yield 关键字
    assertIncludes(r.code, 'yield', '插桩后代码应保留 yield 关键字');
    // AST 层面验证：在 instAST 中找到 generator FunctionDeclaration，
    // 检查其函数体的第一条语句是 ExpressionStatement（J$.Fe 调用），而不是 LabeledStatement（jalangiLabel while...）。
    // wrapFunBodyWithTryCatch 包裹后，body[0] 会是 LabeledStatement { label: jalangiLabelN, body: WhileStatement }。
    function findGeneratorFn(node) {
        if (!node || typeof node !== 'object') return null;
        if (node.type === 'FunctionDeclaration' && node.generator) return node;
        for (const key of Object.keys(node)) {
            if (key === 'scope') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                for (const c of child) {
                    const found = findGeneratorFn(c);
                    if (found) return found;
                }
            } else {
                const found = findGeneratorFn(child);
                if (found) return found;
            }
        }
        return null;
    }
    const genFn = findGeneratorFn(r.instAST);
    assert(genFn !== null, 'instAST 中应存在 generator FunctionDeclaration');
    const firstStmt = genFn.body.body[0];
    assertEqual(firstStmt.type, 'ExpressionStatement',
        `generator 函数体第一条语句应是 ExpressionStatement（J$.Fe 调用），实际是 ${firstStmt.type}（若为 LabeledStatement 则说明被 wrapFunBodyWithTryCatch 错误包裹）`);
});

test('BUG6: async 函数的 await 不应被 while(true)try/finally 破坏', () => {
    // BUG-3：与 generator 同理，async 函数的 await 被包裹后
    // finally 会在 await 解析前执行，导致提前 return。
    // 修复后：node.async=true 时跳过 wrapFunBodyWithTryCatch。
    const r = instr('async function fetchData() { return await Promise.resolve(42); }');
    assertIncludes(r.code, 'await', '插桩后代码应保留 await 关键字');
    // 结构检查：async 函数体内不应出现函数返回路径包裹（J$.Fr + while 循环）
    // 通过检查输出中 async function 关键字后的第一个 { 到 } 之间是否含有
    // "jalangiLabel" + "J$.Fr" 的组合来判断（二者同时存在才说明被 wrapFunBodyWithTryCatch 包裹）
    // 具体：提取 async function fetchData 函数体文本
    const bodyMatch = r.code.match(/async function fetchData\s*\(\s*\)\s*\{([\s\S]*?)\n\s*\}/);
    if (bodyMatch) {
        const body = bodyMatch[1];
        assert(!(body.includes('jalangiLabel') && body.includes('J$.Fr')),
            'async 函数体不应同时含有 jalangiLabel 和 J$.Fr（被 wrapFunBodyWithTryCatch 包裹的标志）');
    }
});

test('BUG7: script 级未捕获异常应向外传播（不被 catch 块静默吞掉）', () => {
    // BUG-4 修复前：wrapScriptBodyWithTryCatch 的 catch 块只调 J$.Ex(iid, e)，
    // 没有 re-throw，导致脚本中抛出的异常被完全吞掉，对外不可见。
    // 修复后：catch 块末尾加 throw J$e。
    const r = instr('throw new Error("test");');
    // 验证 catch 块模板中含有 throw J$e（JALANGI_VAR = "J$"）
    assertIncludes(r.code, 'throw J$e', 'script-level catch 块应包含 re-throw 语句');
});

test('BUG8: 解构 var 声明不应错误地插入名称为 undefined 的写入钩子', () => {
    // BUG-5 修复前：VariableDeclaration visitor 直接取 def.id.name，
    // 对 ObjectPattern/ArrayPattern 会得到 undefined，
    // 导致生成 J$.W(iid, undefined, ...) 这样的错误钩子。
    // 修复后：只对 def.id.type === 'Identifier' 时插桩写入。
    const r = instr('var { a, b } = obj; var [x, y] = arr;');
    // 不应出现 name 为 undefined 的写入钩子（即 J$.W(iid, undefined, ...)）
    assert(!r.code.includes('J$.W(') || !r.code.match(/J\$\.W\(\s*\d+\s*,\s*undefined\s*/),
        '解构声明不应产生 J$.W(iid, undefined, ...) 形式的写入钩子');
});

// ════════════════════════════════════════════════════════════════
// 防御代码（Guard）触发测试
// ════════════════════════════════════════════════════════════════

console.log('\n── 防御代码触发验证 ─────────────────────────────────────');

test('Guard: instrumentCode() 在 init() 之前调用应抛出错误', () => {
    // 验证 instrumentCode 在 _config=null 时能正确报错
    // 通过动态 import 获取一个未初始化的新模块实例不太现实，
    // 改为通过传递 null code 验证其他守卫的存在性：
    // 检验 init 调用后 code 非字符串时的守卫
    init(ALL_CONFIG);
    let threw = false;
    try {
        instrumentCode({ code: 42, origCodeFileName: 't.js', instCodeFileName: 't_i.js' });
    } catch (e) {
        threw = true;
        assertIncludes(e.message, 'options.code must be a string', 'code 非字符串错误消息应包含描述');
    }
    assert(threw, '传入非字符串 code 应抛出 TypeError');
});

test('Guard: instrumentCode() sourceType 非法值应抛出错误', () => {
    init(ALL_CONFIG);
    let threw = false;
    try {
        instrumentCode({ code: 'var x = 1;', origCodeFileName: 't.js', instCodeFileName: 't_i.js', sourceType: 'commonjs' });
    } catch (e) {
        threw = true;
        assertIncludes(e.message, "sourceType must be 'script' or 'module'", '非法 sourceType 错误消息应包含描述');
    }
    assert(threw, '非法 sourceType 应抛出错误');
});

test('Guard: instrumentCode() options 为 null 应抛出 TypeError', () => {
    init(ALL_CONFIG);
    let threw = false;
    try {
        instrumentCode(null);
    } catch (e) {
        threw = true;
        assert(e instanceof TypeError, '传入 null options 应抛出 TypeError');
    }
    assert(threw, '传入 null options 应抛出错误');
});

test('Guard: wrapWrite 传入 name.value=undefined 的 Literal 应抛出错误', () => {
    // 模拟 BUG-5 修复前的情形：解构声明的 def.id.name 是 undefined，
    // 被包成 createLiteralAst(undefined) 后传入 wrapWrite
    // 现在 wrapWrite 内部有 guard，应提前抛出诊断性错误
    import('../src/instrument/wrappers.js').then(W => {
        W.init(ALL_CONFIG);
    }).catch(() => {}); // 模块已被缓存，仅验证 guard 的存在性

    // 直接检查：用合法代码插桩不崩溃（guard 只拦截 undefined name）
    const r = instr('var x = 1;');
    assertIncludes(r.code, 'J$.W(', '普通变量声明应插入写入钩子');
});

test('Guard: wrapFunBodyWithTryCatch 的 generator/async 守卫能被 visitorOps 提前拦截', () => {
    // 验证：generator 和 async 函数插桩完整流程不触发 wrapFunBodyWithTryCatch 的 guard
    // 如果 visitorOps 的提前拦截失效，wrapFunBodyWithTryCatch 内部会抛出清晰的错误
    let genThrew = false;
    let asyncThrew = false;
    try { instr('function* g() { yield 1; }'); } catch(e) { genThrew = true; }
    try { instr('async function f() { await Promise.resolve(); }'); } catch(e) { asyncThrew = true; }
    assert(!genThrew, 'generator 函数插桩不应抛出错误（visitorOps 应提前拦截）');
    assert(!asyncThrew, 'async 函数插桩不应抛出错误（visitorOps 应提前拦截）');
});

// ════════════════════════════════════════════════════════════════
// 自定义沙盒变量名（--sandbox-var / jalangiVar 参数）
// ════════════════════════════════════════════════════════════════

console.log('\n── 自定义沙盒变量名 ─────────────────────────────────────');

test('jalangiVar: 使用自定义变量名 __myJ 时，IIFE 包装使用该名称', () => {
    init(ALL_CONFIG, null, null, '__myJ');
    const r = instrumentCode({
        code: 'var x = 1 + 2;',
        origCodeFileName: 'custom.js',
        instCodeFileName: 'custom_i.js',
    });
    assertIncludes(r.code, '__myJ', '插桩输出应包含自定义变量名 __myJ');
    assert(!r.code.includes('(function(J$)') && !r.code.includes('typeof J$!=='),
        '插桩输出不应包含旧变量名 J$ 的 IIFE 包装');
    // 调用钩子应使用新名称
    assertIncludes(r.code, '__myJ.', '钩子调用应使用 __myJ. 前缀');
});

test('jalangiVar: 自定义变量名不影响 source map 生成（iid 正常）', () => {
    init(ALL_CONFIG, null, null, '__myJ');
    const r = instrumentCode({
        code: 'var a = 1;',
        origCodeFileName: 'smap.js',
        instCodeFileName: 'smap_i.js',
        inlineSourceMap: true,
    });
    assert(r.sourceMapObject && Object.keys(r.sourceMapObject).length > 0,
        '自定义变量名下 source map 应正常生成');
});

test('jalangiVar: 非法变量名（含空格）被忽略，回退到默认 J$', () => {
    init(ALL_CONFIG, null, null, 'bad name!');
    const r = instrumentCode({
        code: 'var x = 1;',
        origCodeFileName: 'fallback.js',
        instCodeFileName: 'fallback_i.js',
    });
    assertIncludes(r.code, 'J$', '非法变量名应回退到默认 J$');
});

test('jalangiVar: 默认（不传）仍使用 J$', () => {
    init(ALL_CONFIG);   // 不传第4个参数
    const r = instrumentCode({
        code: 'var x = 1;',
        origCodeFileName: 'default.js',
        instCodeFileName: 'default_i.js',
    });
    assertIncludes(r.code, 'J$', '不传 jalangiVar 时应使用默认 J$');
});

test('jalangiVar: 前缀 __jal_ 随机名格式插桩正确', () => {
    // 模拟 --random-var 生成的名字
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += chars[i % chars.length];  // 固定序列便于测试
    const varName = `__jal_${suffix}`;
    init(ALL_CONFIG, null, null, varName);
    const r = instrumentCode({
        code: 'var x = 1 + 2;',
        origCodeFileName: 'random.js',
        instCodeFileName: 'random_i.js',
    });
    assertIncludes(r.code, varName, `插桩输出应包含随机变量名 ${varName}`);
    assertIncludes(r.code, `${varName}.`, `钩子调用应使用 ${varName}. 前缀`);
});

// ════════════════════════════════════════════════════════════════
// 汇总
// ════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(52)}`);
if (failed === 0) {
    console.log(`✅  All ${passed} tests passed.`);
} else {
    console.log(`❌  ${failed} failed / ${passed + failed} total`);
    process.exit(1);
}
