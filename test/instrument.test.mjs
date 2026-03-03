/**
 * test_esm.mjs — 插桩器端到端集成测试
 *
 * 运行方式：  node test_esm.mjs
 *
 * 覆盖范围：
 *   - ES5 基础语法
 *   - ES6（箭头函数、class、解构、模板字符串、rest/default 参数、Promise）
 *   - ES2017（async/await）
 *   - ES2019（optional catch binding）
 *   - ES2020（optional chaining、nullish coalescing、BigInt、logical assign）
 *   - ES2022（class private fields、顶层 await）
 *   - ESM 模式（import/export）
 *   - IID source map 完整性
 *   - inlineSourceMap 模式
 *   - JALANGI DO NOT INSTRUMENT 跳过逻辑
 *   - Config 选择性禁用插桩
 */

import { init, instrumentCode } from '../src/js/instrument/esnstrument.js';

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
    assert(r.code.length > 0);
    assertIncludes(r.code, 'J$.', '应注入 J$ 钩子');
});

test('function 声明', () => {
    const r = instr('function foo(a) { return a + 1; }');
    assert(r.code.length > 0);
    assertIncludes(r.code, 'J$.Fe', '应注入函数入口钩子');
});

test('for-in 循环', () => {
    const r = instr('var o = {a:1}; for (var k in o) { console.log(k); }');
    assert(r.code.length > 0);
});

test('try-catch-finally', () => {
    const r = instr('try { x(); } catch(e) { console.log(e); } finally { done(); }');
    assert(r.code.length > 0);
});

// ════════════════════════════════════════════════════════════════
// ES6
// ════════════════════════════════════════════════════════════════
console.log('\n── ES6 ──────────────────────────────────────────────────');

test('箭头函数 + 默认参数', () => {
    const r = instr('const f = (x, y = 0) => x + y;');
    assert(r.code.length > 0);
});

test('箭头函数（表达式体）', () => {
    const r = instr('var add = (a, b) => a + b;');
    assert(r.code.length > 0);
});

test('class（constructor + 普通方法）', () => {
    const r = instr('class Animal { constructor(n) { this.name = n; } speak() { return this.name; } }');
    assert(r.code.length > 0);
    // class 方法不应被 wrapLiteral 成字面量
    assertIncludes(r.code, 'speak', 'class 方法名应保留');
});

test('class（getter / setter）', () => {
    const r = instr('class Box { get val() { return this._v; } set val(v) { this._v = v; } }');
    assert(r.code.length > 0);
});

test('class 继承', () => {
    const r = instr('class Dog extends Animal { bark() { return "woof"; } }');
    assert(r.code.length > 0);
});

test('对象解构', () => {
    const r = instr('const {a, b} = obj;');
    assert(r.code.length > 0);
});

test('数组解构', () => {
    const r = instr('const [x, y] = [1, 2];');
    assert(r.code.length > 0);
});

test('模板字符串', () => {
    const r = instr('var s = `hello ${name}`;');
    assert(r.code.length > 0);
});

test('rest 参数', () => {
    const r = instr('function f(...args) { return args; }');
    assert(r.code.length > 0);
});

test('spread 运算符', () => {
    const r = instr('const arr = [1, ...other, 2];');
    assert(r.code.length > 0);
});

test('Promise', () => {
    const r = instr('var p = new Promise((resolve, reject) => { resolve(42); });');
    assert(r.code.length > 0);
});

test('解构函数参数', () => {
    const r = instr('function f({x, y}, [a, b]) { return x + y + a + b; }');
    assert(r.code.length > 0);
});

// ════════════════════════════════════════════════════════════════
// ES2017
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2017 ───────────────────────────────────────────────');

test('async / await', () => {
    const r = instr('async function fetchData() { var data = await fetch("/api"); return data.json(); }');
    assert(r.code.length > 0);
});

// ════════════════════════════════════════════════════════════════
// ES2019
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2019 ───────────────────────────────────────────────');

test('optional catch binding（无参数 catch）', () => {
    // node.param 为 null，不能访问 .name
    const r = instr('try { foo(); } catch { console.log("caught"); }');
    assert(r.code.length > 0);
});

// ════════════════════════════════════════════════════════════════
// ES2020
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2020 ───────────────────────────────────────────────');

test('optional chaining (?.)' , () => {
    const r = instr('var x = obj?.foo?.bar;');
    assert(r.code.length > 0);
});

test('nullish coalescing (??)', () => {
    const r = instr('var x = a ?? b;');
    assert(r.code.length > 0);
});

test('BigInt 字面量', () => {
    // BigInt 节点 typeof 为 'bigint'，插桩器应跳过不崩溃
    const r = instr('var n = 9007199254740991n;');
    assert(r.code.length > 0);
});

test('logical assignment (||= &&= ??=)', () => {
    const r = instr('a ||= b; a &&= c; a ??= d;');
    assert(r.code.length > 0);
});

// ════════════════════════════════════════════════════════════════
// ES2022
// ════════════════════════════════════════════════════════════════
console.log('\n── ES2022 ───────────────────────────────────────────────');

test('class private fields + getter', () => {
    const r = instr('class Counter { #count = 0; increment() { this.#count++; } get value() { return this.#count; } }');
    assert(r.code.length > 0);
});

test('class static field', () => {
    const r = instr('class Cfg { static debug = false; }');
    assert(r.code.length > 0);
});

test('顶层 await（module 模式）', () => {
    const r = instr('const res = await fetch("https://example.com"); console.log(res.status);', { sourceType: 'module' });
    assert(r.code.length > 0);
});

// ════════════════════════════════════════════════════════════════
// ESM import / export
// ════════════════════════════════════════════════════════════════
console.log('\n── ESM ──────────────────────────────────────────────────');

test('import + export（module 模式）', () => {
    const r = instr('import { foo } from "./foo.js"; export const bar = foo();', { sourceType: 'module' });
    assert(r.code.length > 0);
});

test('export default function', () => {
    const r = instr('export default function greet(name) { return `Hello, ${name}`; }', { sourceType: 'module' });
    assert(r.code.length > 0);
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
    assertIncludes(r.code, 'J$.iids =', '应内联 iids 对象');
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
    // 恢复全量 Config
    init(ALL_CONFIG);
});

test('INSTR_BINARY = () => false 时不注入二元运算钩子', () => {
    init({ ...ALL_CONFIG, INSTR_BINARY: () => false });
    const r = instr('var x = 1 + 2;');
    assert(!r.code.includes('J$.B('), '不应有 J$.B 二元运算钩子');
    init(ALL_CONFIG);
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
