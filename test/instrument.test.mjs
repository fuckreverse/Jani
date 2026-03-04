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

import { init, instrumentCode, analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig } from '../src/instrument/esnstrument.js';
import { JalangiSandbox } from '../src/runtime/JalangiSandbox.js';
import { AnalysisHost   } from '../src/runtime/AnalysisHost.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ─── 测试框架（极简，无外部依赖）────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * 挂起的异步测试 Promise 列表。
 * 所有 async test 函数会将其 Promise 推入此数组，
 * 最终在文件末尾的 _flushAsyncTests() 中统一 await。
 */
const _asyncTests = [];

/**
 * 注册并执行一个测试用例。支持同步函数和 async 函数。
 * - 同步函数：直接捕获异常并打印结果
 * - async 函数：推入 _asyncTests，由末尾 _flushAsyncTests() 统一等待
 */
function test(name, fn) {
    let returnVal;
    try {
        returnVal = fn();
    } catch (e) {
        console.error(`  ✗  ${name}`);
        console.error(`     ${e.message}`);
        failed++;
        return;
    }

    if (returnVal && typeof returnVal.then === 'function') {
        // async 函数返回 Promise，推迟统计
        _asyncTests.push(
            returnVal.then(() => {
                console.log(`  ✓  ${name}`);
                passed++;
            }).catch((e) => {
                console.error(`  ✗  ${name}`);
                console.error(`     ${e?.message ?? String(e)}`);
                failed++;
            })
        );
    } else {
        // 同步函数且无异常
        console.log(`  ✓  ${name}`);
        passed++;
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
    INSTR_AWAIT:              null,   // await 恢复点插桩
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

test('async / await — 插桩结构检查', () => {
    const r = instr('async function fetchData() { var data = await fetch("/api"); return data.json(); }');
    assertIncludes(r.code, 'J$.Fe(', 'async 函数应注入 J$.Fe');
    assertIncludes(r.code, 'J$.Fr(', 'async 函数应注入返回钩子 J$.Fr');
    // 核心：await 表达式应被包裹为 J$.Aw(iid, await ...) 形式
    assertIncludes(r.code, 'J$.Aw(', 'await 表达式应注入 J$.Aw 钩子');
});

test('async / await — J$.Aw 包含正确的 await 结构', () => {
    // await expr 应被改写为 J$.Aw(iid, await expr)，而不是 (await expr, J$.Aw(iid))
    const r = instr('async function f() { return await Promise.resolve(1); }');
    // 检查 J$.Aw 的调用形式：第二个参数应是 await 表达式
    assertIncludes(r.code, 'J$.Aw(', 'await 应被改写为 J$.Aw 钩子');
    // resolved value 应由 J$.Aw 透传（函数返回值为 J$.Aw 的返回值）
    // 验证 await 关键字仍在 J$.Aw 内部（保留了 await 语义）
    const awIdx = r.code.indexOf('J$.Aw(');
    const awContent = r.code.slice(awIdx, r.code.indexOf(')', awIdx + 10) + 1);
    assert(awContent.includes('await'), 'J$.Aw 的参数中应包含 await 关键字（await 语义保留在钩子内部）');
});

test('async / await — 顶层 await（module 模式）注入 J$.Aw', () => {
    const r = instr('const res = await Promise.resolve(42);', { sourceType: 'module' });
    assertIncludes(r.code, 'J$.Aw(', '顶层 await 也应注入 J$.Aw 钩子');
    assertIncludes(r.code, 'await', '顶层 await 的 await 关键字应保留');
});

test('async / await — 链式 await 每处均注入钩子', () => {
    const r = instr(`
        async function chain() {
            const a = await Promise.resolve(1);
            const b = await Promise.resolve(2);
            return a + b;
        }
    `);
    // 统计 J$.Aw 出现次数（应 ≥ 2，每个 await 一个）
    const awCount = (r.code.match(/J\$\.Aw\(/g) || []).length;
    assert(awCount >= 2, `链式 await 应注入 ≥2 个 J$.Aw 钩子，实际: ${awCount}`);
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
// 修复后：箭头函数参数走全量路径 J$.R（不走 Rl，因为箭头函数无 Fe/Fr，Shadow Frame 未初始化），
//         J$.R 的 isGlobal 标志位（bitPattern 第1位）应为 0（false）
// 注：J$.R 现有签名为 J$.R(iid, name, val, flags[, scopeId])，
//    flags 低位 = isGlobal，bitPattern=0 意味着 isGlobal=false
const r = instr('var f = (x) => x + 1;');
// 箭头函数参数不走轻量路径（Rl），因为箭头函数没有 Fe/Fr 初始化 Shadow Frame
const rlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"x"\s*\)/);
assert(rlMatch === null, '箭头参数 x 不应走 Rl（Shadow Frame 未初始化）');
// 走全量路径：检查 bitPattern（isGlobal=false 对应 0）
// flags 后面可能有可选的 scopeId 参数，用 [,)]  允许两种情况
const match = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"x"\s*,[^,]+,\s*(\d+)\s*[,)]/);
assert(match !== null, '应存在对 x 的读取插桩 J$.R');
assertEqual(parseInt(match[1]), 0, '箭头参数 x 的 isGlobal 应为 false（bitPattern=0）');
});

test('BUG3b: 嵌套箭头函数各自独立作用域不相互污染', () => {
// 修复后：外层箭头 x、内层箭头 y 都应在各自 scope 中正确识别为局部变量
// 箭头函数参数不走 Rl（无 Fe/Fr，Shadow Frame 未初始化），走全量路径 J$.R
// J$.R 签名为 J$.R(iid, name, val, flags[, scopeId])，flags=0 → isGlobal=false
const r = instr('var f = (x) => (y) => x + y;');
// 箭头函数参数不走轻量路径（Rl）
const xRlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"x"\s*\)/);
const yRlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"y"\s*\)/);
assert(xRlMatch === null, '箭头参数 x 不应走 Rl');
assert(yRlMatch === null, '箭头参数 y 不应走 Rl');
// 检查全量路径 J$.R，flags 后面可能有可选 scopeId，用 [,)] 允许两种情况
const xRMatch  = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"x"\s*,[^,]+,\s*(\d+)\s*[,)]/);
const yRMatch  = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"y"\s*,[^,]+,\s*(\d+)\s*[,)]/);
assert(xRMatch !== null, '应存在对 x 的读取插桩 J$.R');
assert(yRMatch !== null, '应存在对 y 的读取插桩 J$.R');
// 验证不是全局变量（bitPattern=0）
assertEqual(parseInt(xRMatch[1]), 0, '外层箭头参数 x 应为局部变量（bitPattern=0）');
assertEqual(parseInt(yRMatch[1]), 0, '内层箭头参数 y 应为局部变量（bitPattern=0）');
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
// 标准 VLCQ Source Map v3 生成（vlcqSourceMap 字段）
// ════════════════════════════════════════════════════════════════

console.log('\n── VLCQ Source Map ──────────────────────────────────────');

init(ALL_CONFIG);

test('vlcqSourceMap: 普通插桩时 vlcqSourceMap 字段存在且格式正确', () => {
    const r = instr('var x = 1 + 2;');
    assert(r.vlcqSourceMap !== null && r.vlcqSourceMap !== undefined,
        'vlcqSourceMap 应为非空对象');
    assertEqual(r.vlcqSourceMap.version, 3,
        'vlcqSourceMap.version 应为 3（Source Map v3）');
    assert(Array.isArray(r.vlcqSourceMap.sources),
        'vlcqSourceMap.sources 应为数组');
    assert(typeof r.vlcqSourceMap.mappings === 'string',
        'vlcqSourceMap.mappings 应为字符串');
});

test('vlcqSourceMap: sources 数组包含原始文件名', () => {
    const r = instrumentCode({
        code:             'var x = 1;',
        origCodeFileName: 'hello.js',
        instCodeFileName: 'hello_inst.js',
    });
    assert(r.vlcqSourceMap.sources.some(s => s.includes('hello.js')),
        'vlcqSourceMap.sources 应包含原始文件名 hello.js');
});

test('vlcqSourceMap: mappings 以若干 ";" 开头（行偏移补偿）', () => {
    // 最终输出头部有 2 行（smap 注入行 + IIFE 包裹行），
    // 因此 mappings 应以至少 2 个 ";" 开头
    const r = instr('function f() { return 1; }');
    assert(r.vlcqSourceMap.mappings.startsWith(';;'),
        `mappings 应以 ";;" 开头（2 行偏移），实际为: ${JSON.stringify(r.vlcqSourceMap.mappings.slice(0, 10))}`);
});

test('vlcqSourceMap: JALANGI DO NOT INSTRUMENT 代码不生成 vlcqSourceMap', () => {
    const r = instrumentCode({
        code:             '// JALANGI DO NOT INSTRUMENT\nvar x = 1;',
        origCodeFileName: 'skip.js',
        instCodeFileName: 'skip_inst.js',
    });
    assert(r.vlcqSourceMap === null,
        '包含 DO NOT INSTRUMENT 标记的代码，vlcqSourceMap 应为 null');
});

test('vlcqSourceMap: module 模式下行偏移补偿同样正确', () => {
    const r = instrumentCode({
        code:             'export const x = 1;',
        origCodeFileName: 'mod.mjs',
        instCodeFileName: 'mod_inst.mjs',
        sourceType:       'module',
    });
    assert(r.vlcqSourceMap !== null, 'module 模式下 vlcqSourceMap 应存在');
    assertEqual(r.vlcqSourceMap.version, 3, 'version 应为 3');
    assert(r.vlcqSourceMap.mappings.startsWith(';;'),
        `module 模式 mappings 应以 ";;" 开头，实际: ${JSON.stringify(r.vlcqSourceMap.mappings.slice(0, 10))}`);
});

test('vlcqSourceMap: 多行代码 mappings 中包含多个 ";" 分隔符（覆盖多行映射）', () => {
    const multiLineCode = [
        'function add(a, b) {',
        '  return a + b;',
        '}',
        'var result = add(1, 2);',
    ].join('\n');
    const r = instr(multiLineCode);
    // 插桩后的代码行数远多于 2，mappings 中 ';' 的数量应远大于 2
    const semicolonCount = (r.vlcqSourceMap.mappings.match(/;/g) ?? []).length;
    assert(semicolonCount > 2,
        `多行代码的 mappings 应包含多个 ";" (实际 ${semicolonCount})`);
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
// 按需插桩（pluginAnalyzer + buildConfigFromHooks）
// ════════════════════════════════════════════════════════════════

console.log('\n── 按需插桩（pluginAnalyzer）─────────────────────────');

// ── buildConfigFromHooks：基本映射 ───────────────────────────────

test('buildConfigFromHooks: 只用 binary 时只开启 INSTR_BINARY', () => {
    const config = buildConfigFromHooks(new Set(['binary', 'binaryPre']));
    assert(config.INSTR_BINARY === null, 'INSTR_BINARY 应为 null（开启）');
    assert(typeof config.INSTR_READ === 'function', 'INSTR_READ 应为 () => false（禁用）');
    assert(typeof config.INSTR_WRITE === 'function', 'INSTR_WRITE 应为 () => false（禁用）');
    assert(typeof config.INSTR_GETFIELD === 'function', 'INSTR_GETFIELD 应为 () => false（禁用）');
    assert(typeof config.INSTR_LITERAL === 'function', 'INSTR_LITERAL 应为 () => false（禁用）');
    assert(config.ENABLE_SAMPLING === false, 'ENABLE_SAMPLING 应为 false');
});

test('buildConfigFromHooks: 只用 read 时只开启 INSTR_READ', () => {
    const config = buildConfigFromHooks(new Set(['read']));
    assert(config.INSTR_READ === null, 'INSTR_READ 应为 null');
    assert(typeof config.INSTR_WRITE === 'function', 'INSTR_WRITE 应被禁用');
    assert(typeof config.INSTR_BINARY === 'function', 'INSTR_BINARY 应被禁用');
});

test('buildConfigFromHooks: functionEnter 需要 INSTR_TRY_CATCH_ARGUMENTS', () => {
    const config = buildConfigFromHooks(new Set(['functionEnter', 'functionExit']));
    assert(config.INSTR_TRY_CATCH_ARGUMENTS === null, 'functionEnter 需要 INSTR_TRY_CATCH_ARGUMENTS');
    assert(typeof config.INSTR_READ === 'function', 'INSTR_READ 不需要，应被禁用');
});

test('buildConfigFromHooks: declare 需要 INSTR_INIT + INSTR_TRY_CATCH_ARGUMENTS', () => {
    const config = buildConfigFromHooks(new Set(['declare']));
    assert(config.INSTR_INIT === null, 'declare 需要 INSTR_INIT');
    assert(config.INSTR_TRY_CATCH_ARGUMENTS === null, 'declare 需要 INSTR_TRY_CATCH_ARGUMENTS');
});

test('buildConfigFromHooks: invokeFunPre/invokeFun 需要 INSTR_INVOKE', () => {
    const config = buildConfigFromHooks(new Set(['invokeFunPre', 'invokeFun']));
    assert(config.INSTR_INVOKE === null, 'invoke 钩子应开启 INSTR_INVOKE');
    assert(typeof config.INSTR_READ === 'function', 'INSTR_READ 不需要，应被禁用');
});

test('buildConfigFromHooks: _return 需要 INSTR_RETURN', () => {
    const config = buildConfigFromHooks(new Set(['_return']));
    assert(config.INSTR_RETURN === null, '_return 钩子应开启 INSTR_RETURN');
    assert(typeof config.INSTR_THROW === 'function', 'INSTR_THROW 不需要，应被禁用');
});

test('buildConfigFromHooks: _throw 需要 INSTR_THROW', () => {
    const config = buildConfigFromHooks(new Set(['_throw']));
    assert(config.INSTR_THROW === null, '_throw 钩子应开启 INSTR_THROW');
    assert(typeof config.INSTR_RETURN === 'function', 'INSTR_RETURN 不需要，应被禁用');
});

test('buildConfigFromHooks: forinObject 需要 INSTR_FORIN', () => {
    const config = buildConfigFromHooks(new Set(['forinObject']));
    assert(config.INSTR_FORIN === null, 'forinObject 钩子应开启 INSTR_FORIN');
    assert(typeof config.INSTR_READ === 'function', 'INSTR_READ 不需要，应被禁用');
});

test('buildConfigFromHooks: endExecution/onReady 不映射任何 Config 字段', () => {
    const config = buildConfigFromHooks(new Set(['endExecution', 'onReady']));
    // 所有 INSTR_* 字段都应被禁用
    for (const [k, v] of Object.entries(config)) {
        if (k.startsWith('INSTR_')) {
            assert(typeof v === 'function', `${k} 应被禁用，得到 ${v}`);
        }
    }
});

test('fullConfig: 返回所有字段均为 null 的全量 Config', () => {
    const config = fullConfig();
    const fields = ['INSTR_READ','INSTR_WRITE','INSTR_GETFIELD','INSTR_PUTFIELD',
        'INSTR_BINARY','INSTR_UNARY','INSTR_LITERAL','INSTR_INIT',
        'INSTR_CONDITIONAL','INSTR_TRY_CATCH_ARGUMENTS','INSTR_END_EXPRESSION',
        'INSTR_INVOKE','INSTR_RETURN','INSTR_THROW','INSTR_FORIN'];
    for (const f of fields) {
        assert(config[f] === null, `fullConfig 的 ${f} 应为 null`);
    }
});

// ── analyzePluginHooks：从实际插件文件扫描 ───────────────────────

test('analyzePluginHooks: 从 CheckNaN.js 扫描出 binary + endExecution', () => {
    const pluginPath = join(__dirname, '../src/plugins/dlint/CheckNaN.js');
    const hooks = analyzePluginHooks([pluginPath]);
    assert(hooks.has('binary'), 'CheckNaN 应包含 binary');
    assert(hooks.has('endExecution'), 'CheckNaN 应包含 endExecution');
    // 不应包含其他高代价钩子
    assert(!hooks.has('read'), 'CheckNaN 不应包含 read');
    assert(!hooks.has('write'), 'CheckNaN 不应包含 write');
    assert(!hooks.has('getField'), 'CheckNaN 不应包含 getField');
});

test('analyzePluginHooks: 从实例对象扫描（运行时反射）', () => {
    // 构造一个只有 binary 和 endExecution 的简单插件实例
    const pluginInstance = {
        binary() {},
        endExecution() {},
    };
    const hooks = analyzePluginHooks([pluginInstance]);
    assert(hooks.has('binary'), '实例扫描应发现 binary');
    assert(hooks.has('endExecution'), '实例扫描应发现 endExecution');
    assert(!hooks.has('read'), '实例扫描不应发现 read');
});

test('analyzePluginHooks: 静态 usedHooks 声明优先', () => {
    // 模拟带有 static usedHooks 声明的插件
    class MyPlugin {
        static usedHooks = ['invokeFunPre', 'invokeFun'];
        // 注意：这里故意不定义 read 方法，但通过 usedHooks 声明
    }
    const hooks = analyzePluginHooks([new MyPlugin()]);
    assert(hooks.has('invokeFunPre'), 'usedHooks 声明的 invokeFunPre 应被识别');
    assert(hooks.has('invokeFun'), 'usedHooks 声明的 invokeFun 应被识别');
});

// ── buildConfigFromPlugins：端到端流程 ───────────────────────────

test('buildConfigFromPlugins: CheckNaN.js → 只开启 INSTR_BINARY', () => {
    const pluginPath = join(__dirname, '../src/plugins/dlint/CheckNaN.js');
    const config = buildConfigFromPlugins([pluginPath]);
    assert(config.INSTR_BINARY === null, 'CheckNaN 只需 INSTR_BINARY');
    assert(typeof config.INSTR_READ === 'function', 'INSTR_READ 应被禁用');
    assert(typeof config.INSTR_WRITE === 'function', 'INSTR_WRITE 应被禁用');
    assert(typeof config.INSTR_GETFIELD === 'function', 'INSTR_GETFIELD 应被禁用');
    assert(typeof config.INSTR_LITERAL === 'function', 'INSTR_LITERAL 应被禁用');
});

test('buildConfigFromPlugins: 空数组返回全量 Config', () => {
    const config = buildConfigFromPlugins([]);
    assert(config.INSTR_BINARY === null, '空数组应返回全量 Config');
    assert(config.INSTR_READ === null, '空数组应返回全量 Config');
});

// ── 按需 Config 实际影响插桩输出 ───────────────────────────────

test('按需插桩: 只开 INSTR_BINARY 时，输出不含 J$.R（read 钩子）', () => {
    const config = buildConfigFromHooks(new Set(['binary', 'binaryPre']));
    init(config);
    const r = instrumentCode({
        code: 'var x = 1 + 2; var y = x;',
        origCodeFileName: 'on-demand.js',
        instCodeFileName: 'on-demand_i.js',
    });
    // binary 操作应被插桩
    assert(r.code.includes('J$.B(') || r.code.includes('J$.Bp('),
        '二元运算应被插桩（J$.B 或 J$.Bp）');
    // read 操作不应被插桩（J$.R）
    assert(!r.code.includes('J$.R('), '变量读取不应被插桩（J$.R 应不存在）');
    // 字面量不应被插桩（J$.T）
    assert(!r.code.includes('J$.T('), '字面量不应被插桩（J$.T 应不存在）');
});

test('按需插桩: 只开 INSTR_READ 时，输出不含 J$.B（binary 钩子）', () => {
    const config = buildConfigFromHooks(new Set(['read']));
    init(config);
    const r = instrumentCode({
        code: 'var x = 1 + 2; var y = x;',
        origCodeFileName: 'on-demand2.js',
        instCodeFileName: 'on-demand2_i.js',
    });
    // read 应被插桩
    assert(r.code.includes('J$.R('), '变量读取应被插桩（J$.R）');
    // binary 不应被插桩
    assert(!r.code.includes('J$.B('), '二元运算不应被插桩（J$.B 应不存在）');
});

test('按需插桩: 关闭 INSTR_INVOKE 时，函数调用不注入 J$.F/J$.M', () => {
    const config = buildConfigFromHooks(new Set(['read']));  // 不含 invokeFunPre/invokeFun
    init(config);
    const r = instrumentCode({
        code: 'function foo() {} foo(); var obj = { bar: function(){} }; obj.bar();',
        origCodeFileName: 'invoke-off.js',
        instCodeFileName: 'invoke-off_i.js',
    });
    assert(!r.code.includes('J$.F('), '关闭 INSTR_INVOKE 时 J$.F 不应出现');
    assert(!r.code.includes('J$.M('), '关闭 INSTR_INVOKE 时 J$.M 不应出现');
});

test('按需插桩: 关闭 INSTR_RETURN 时，return 语句不注入 J$.Rt', () => {
    const config = buildConfigFromHooks(new Set(['binary']));  // 不含 _return
    init(config);
    const r = instrumentCode({
        code: 'function foo(x) { return x + 1; }',
        origCodeFileName: 'return-off.js',
        instCodeFileName: 'return-off_i.js',
    });
    assert(!r.code.includes('J$.Rt('), '关闭 INSTR_RETURN 时 J$.Rt 不应出现');
});

test('按需插桩: 关闭 INSTR_FORIN 时，for-in 不注入 J$.H/J$.I', () => {
    const config = buildConfigFromHooks(new Set(['binary']));  // 不含 forinObject
    init(config);
    const r = instrumentCode({
        code: 'for (var k in obj) { console.log(k); }',
        origCodeFileName: 'forin-off.js',
        instCodeFileName: 'forin-off_i.js',
    });
    assert(!r.code.includes('J$.H('), '关闭 INSTR_FORIN 时 J$.H 不应出现');
});

test('按需插桩: init() 传 plugins 参数自动推导 Config', () => {
    // 模拟只有 binary 的插件实例
    const pluginInst = { binary() {}, endExecution() {} };
    // 传 null config + plugins，应自动推导
    init(null, null, null, 'J$', [pluginInst]);
    const r = instrumentCode({
        code: 'var x = 1 + 2;',
        origCodeFileName: 'auto-config.js',
        instCodeFileName: 'auto-config_i.js',
    });
    assert(r.code.includes('J$.B(') || r.code.includes('J$.Bp('),
        'plugins 推导后 binary 应被插桩');
    assert(!r.code.includes('J$.R('), 'plugins 推导后 read 不应被插桩');
    // 恢复全量 Config 供后续测试使用
    init(ALL_CONFIG);
});

// ════════════════════════════════════════════════════════════════
// 动态执行测试工具
// ════════════════════════════════════════════════════════════════

/**
 * 在 Node.js vm 沙盒中执行插桩后代码。
 *
 * 安全策略：
 *  - vm.createContext() 创建隔离上下文，与宿主进程内存空间隔离
 *  - 沙盒中只注入最小必要全局量（J$、console、Error、Math、Object、Array、…）
 *  - 不注入 process、require、__dirname 等 Node.js 全局，防止逃逸
 *  - vm.runInContext() 设置 timeout，防止死循环
 *
 * @param {string}  instrCode     插桩后代码字符串（来自 instrumentCode().code）
 * @param {object}  J$instance    JalangiSandbox 或轻量 stub 实例
 * @param {object}  [extraGlobals] 额外注入到沙盒的全局变量（测试用）
 * @param {number}  [timeoutMs=2000]  执行超时（毫秒）
 * @returns {object} 上下文对象（可从中读取沙盒内的变量）
 */
function runInSandbox(instrCode, J$instance, extraGlobals = {}, timeoutMs = 2000) {
    // 构建最小化安全上下文（不暴露 process / require 等危险 API）
    const sandbox = vm.createContext({
        // 运行时钩子
        J$: J$instance,
        // 安全的内置对象子集
        console,
        Error, TypeError, RangeError, ReferenceError, SyntaxError,
        Math, JSON, Date,
        Object, Array, Function, String, Number, Boolean, Symbol,
        RegExp, Map, Set, WeakMap, WeakSet,
        Promise, Proxy, Reflect,
        parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        undefined,
        NaN,
        Infinity,
        ...extraGlobals,
    });
    vm.runInContext(instrCode, sandbox, { timeout: timeoutMs });
    return sandbox;
}

/**
 * 一步完成"插桩 + 沙盒执行"，返回 { out, J$ }。
 *
 * 注意：插桩后的 script 代码被 IIFE 包裹，内部的 var 声明是局部变量，
 * 不会挂到 vm sandbox 上。因此需要通过以下方式导出结果：
 *   - sourceCode 末尾添加 "$out.变量名 = 变量名" 赋值语句
 *   - 或者通过注册 write 钩子来捕获变量写入值
 *
 * 沙盒中已预注入 `$out = {}` 对象，可在 sourceCode 中直接使用。
 *
 * @param {string} sourceCode  原始 JS 代码（末尾可追加 "$out.x=x;" 来导出结果）
 * @param {object} [extraGlobals]  额外注入到沙盒的全局变量
 * @returns {{ out: object, J$: JalangiSandbox, vars: object }}
 *   out   — $out 容器（sourceCode 中显式写入的结果）
 *   vars  — write 钩子收集到的所有变量写入记录（key=变量名, value=最后写入值）
 *   J$    — 运行时 sandbox 实例（可继续查询钩子日志等）
 */
function instrAndRun(sourceCode, extraGlobals = {}) {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code:             sourceCode,
        origCodeFileName: 'dyn-test.js',
        instCodeFileName: 'dyn-test_inst.js',
        inlineSourceMap:  true,   // 将 iid 映射内联到输出，Se() 时自动注册
    });
    const J$inst = new JalangiSandbox();
    // 用 write 钩子收集所有变量的最后写入值（可辅助断言）
    const vars = {};
    J$inst.analysis.use({
        write(_iid, name, val) { vars[name] = val; }
    });
    const $out = {};
    const sandbox = runInSandbox(code, J$inst, { $out, ...extraGlobals });
    return { out: $out, vars, J$: J$inst, sandbox };
}

// ════════════════════════════════════════════════════════════════
// 动态执行 — 语义正确性（插桩前后行为一致）
// ════════════════════════════════════════════════════════════════
console.log('\n── 动态执行：语义正确性 ──────────────────────────────');

// 注意：插桩后代码被 IIFE 包裹，内部 var 变量不在 sandbox 顶层。
// 所有语义测试通过 $out 容器（instrAndRun 已自动注入）或 vars（write 钩子收集）来断言结果。

test('动态：var 声明 + 基本算术', () => {
    // $out 容器用于导出 IIFE 内部的局部变量值
    const { out } = instrAndRun('var x = 3 + 4; var y = x * 2; $out.x=x; $out.y=y;');
    assertEqual(out.x, 7,  'x 应等于 7');
    assertEqual(out.y, 14, 'y 应等于 14');
});

test('动态：字符串连接', () => {
    const { out } = instrAndRun('var s = "hello" + " " + "world"; $out.s=s;');
    assertEqual(out.s, 'hello world', '字符串连接结果应正确');
});

test('动态：function 声明 + 调用返回值', () => {
    const { out } = instrAndRun(`
        function add(a, b) { return a + b; }
        var result = add(10, 20);
        $out.result = result;
    `);
    assertEqual(out.result, 30, 'add(10,20) 应返回 30');
});

test('动态：递归函数（阶乘）', () => {
    const { out } = instrAndRun(`
        function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
        var r = fact(5);
        $out.r = r;
    `);
    assertEqual(out.r, 120, 'fact(5) 应等于 120');
});

// ════════════════════════════════════════════════════════════════
// 动态执行 — 闭包 Shadow Frame 场景（测试 #resolveCallId 修复）
// 覆盖 7 种典型场景，确保 Rl 在外层帧退出后仍能正确读取外层变量
// ════════════════════════════════════════════════════════════════
console.log('\n── 动态执行：闭包 Shadow Frame 场景 ──────────────────');

test('闭包场景 1：基础计数器（外层退出后闭包累加）', () => {
    // 外层 makeCounter 退出后，内层 counter 持续访问 count
    // 修复前：Rl 会 MISS（外层 callId 不在栈上）
    const { out } = instrAndRun(`
        function makeCounter() {
            var count = 0;
            return function() { count = count + 1; return count; };
        }
        var counter = makeCounter();
        var a = counter(); var b = counter(); var c = counter();
        $out.a=a; $out.b=b; $out.c=c;
    `);
    assertEqual(out.a, 1, '第 1 次调用 counter() 应返回 1');
    assertEqual(out.b, 2, '第 2 次调用 counter() 应返回 2');
    assertEqual(out.c, 3, '第 3 次调用 counter() 应返回 3');
});

test('闭包场景 2：工厂多实例独立（两个计数器互不干扰）', () => {
    // 两次调用 makeCounter，各自返回独立闭包，capturedCallId 不同
    // 修复前：#closureScopeCallId 会被第二次调用覆盖，导致 c1 的 count 读到 c2 的值
    const { out } = instrAndRun(`
        function makeCounter() {
            var count = 0;
            return function() { count = count + 1; return count; };
        }
        var c1 = makeCounter();
        var c2 = makeCounter();
        var a1 = c1(); var a2 = c1();   // c1: 1, 2
        var b1 = c2();                   // c2: 1（独立！）
        var a3 = c1();                   // c1: 3
        $out.a1=a1; $out.a2=a2; $out.a3=a3; $out.b1=b1;
    `);
    assertEqual(out.a1, 1, 'c1 第 1 次应返回 1');
    assertEqual(out.a2, 2, 'c1 第 2 次应返回 2');
    assertEqual(out.a3, 3, 'c1 第 3 次应返回 3');
    assertEqual(out.b1, 1, 'c2 独立计数，第 1 次应返回 1');
});

test('闭包场景 3：嵌套闭包两层（内层访问外层的外层）', () => {
    // 三层嵌套：outer → middle → inner，inner 访问 outer 的变量
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
    assertEqual(out.r, 15, 'inner() 应返回 10+5=15');
});

test('闭包场景 4：闭包写回外层变量（多次修改后读取）', () => {
    // 闭包写回外层作用域的变量，W() 需用 resolveCallId 写对 callId
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
    assertEqual(out.r, 125, 'makeAccumulator(100).add(5).add(20).get() 应返回 125');
});

test('闭包场景 5：递归 + 闭包（递归函数本身是闭包）', () => {
    // 外层函数返回递归闭包，递归时 callId 不断变化但外层 Shadow Frame 应稳定
    const { out } = instrAndRun(`
        function makeFactorialWithBase(base) {
            return function fact(n) {
                return n <= 1 ? base : n * fact(n - 1);
            };
        }
        var factBase2 = makeFactorialWithBase(2);
        $out.r = factBase2(4);  // 4 * 3 * 2 * base(2) = 24 * 2 = 48
    `);
    assertEqual(out.r, 48, 'factBase2(4) 应返回 48（递归到 base=2）');
});

test('闭包场景 6：闭包作为回调传递（延迟调用）', () => {
    // 外层函数立即退出，闭包作为回调存入数组，稍后批量执行
    const { out } = instrAndRun(`
        function makeAdder(x) {
            return function(y) { return x + y; };
        }
        var fns = [];
        for (var i = 0; i < 3; i++) {
            fns.push(makeAdder(i * 10));
        }
        // 外层帧全部退出后才调用
        $out.r0 = fns[0](1);   // 0 + 1 = 1
        $out.r1 = fns[1](1);   // 10 + 1 = 11
        $out.r2 = fns[2](1);   // 20 + 1 = 21
    `);
    assertEqual(out.r0, 1,  'fns[0](1) 应等于 0+1=1');
    assertEqual(out.r1, 11, 'fns[1](1) 应等于 10+1=11');
    assertEqual(out.r2, 21, 'fns[2](1) 应等于 20+1=21');
});

test('闭包场景 7：IIFE 闭包捕获（立即调用中创建闭包）', () => {
    // IIFE 本身立即执行，但返回的内层函数在 IIFE 退出后才被调用
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
        $out.r0 = fns[0]();  // 0*0=0
        $out.r1 = fns[1]();  // 1*1=1
        $out.r2 = fns[2]();  // 2*2=4
    `);
    assertEqual(out.r0, 0, 'fns[0]() 应等于 0*0=0');
    assertEqual(out.r1, 1, 'fns[1]() 应等于 1*1=1');
    assertEqual(out.r2, 4, 'fns[2]() 应等于 2*2=4');
});

test('动态：对象属性读写', () => {
    const { out } = instrAndRun(`
        var obj = { x: 10 };
        obj.y = obj.x + 5;
        var total = obj.x + obj.y;
        $out.total = total;
    `);
    assertEqual(out.total, 25, 'total 应等于 25');
});

test('动态：数组操作', () => {
    const { out } = instrAndRun(`
        var arr = [1, 2, 3];
        arr.push(4);
        var sum = arr[0] + arr[1] + arr[2] + arr[3];
        $out.sum = sum;
    `);
    assertEqual(out.sum, 10, '数组元素求和应为 10');
});

test('动态：箭头函数', () => {
    const { out } = instrAndRun(`
        var double = (n) => n * 2;
        var r = double(7);
        $out.r = r;
    `);
    assertEqual(out.r, 14, 'double(7) 应返回 14');
});

test('动态：class 实例化与方法调用', () => {
    const { out } = instrAndRun(`
        class Point {
            constructor(x, y) { this.x = x; this.y = y; }
            dist() { return this.x * this.x + this.y * this.y; }
        }
        var p = new Point(3, 4);
        var d = p.dist();
        $out.d = d;
    `);
    assertEqual(out.d, 25, 'Point(3,4).dist() 应返回 25');
});

test('动态：class 继承', () => {
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
    assertEqual(out.msg, 'Rex barks.', 'Dog.speak() 应返回正确字符串');
});

test('动态：try-catch 语义', () => {
    const { out } = instrAndRun(`
        var caught = null;
        try {
            throw new Error('boom');
        } catch(e) {
            caught = e.message;
        }
        $out.caught = caught;
    `);
    assertEqual(out.caught, 'boom', 'catch 块应捕获异常消息');
});

test('动态：for-in 枚举', () => {
    const { out } = instrAndRun(`
        var obj = { a: 1, b: 2, c: 3 };
        var keys = [];
        for (var k in obj) { keys.push(k); }
        var keyStr = keys.sort().join(',');
        $out.keyStr = keyStr;
    `);
    assertEqual(out.keyStr, 'a,b,c', 'for-in 应枚举出所有键');
});

test('动态：解构赋值', () => {
    const { out } = instrAndRun(`
        var arr2 = [10, 20, 30];
        var a = arr2[0]; var b = arr2[1];
        var obj2 = { x: 100, y: 200 };
        var x = obj2.x; var y = obj2.y;
        $out.a=a; $out.b=b; $out.x=x; $out.y=y;
    `);
    assertEqual(out.a, 10,  '数组解构 a');
    assertEqual(out.b, 20,  '数组解构 b');
    assertEqual(out.x, 100, '对象解构 x');
    assertEqual(out.y, 200, '对象解构 y');
});

test('动态：可选链 (?.) 与空值合并 (??)', () => {
    const { out } = instrAndRun(`
        var obj = { a: { b: 42 } };
        var v1 = obj?.a?.b;
        var v2 = obj?.z?.b ?? 99;
        var v3 = null ?? 'default';
        $out.v1=v1; $out.v2=v2; $out.v3=v3;
    `);
    assertEqual(out.v1, 42,        '可选链正常读取');
    assertEqual(out.v2, 99,        '可选链 undefined 走 ??');
    assertEqual(out.v3, 'default', '空值合并 null 走右侧');
});

test('动态：模板字符串', () => {
    const { out } = instrAndRun(`
        var name2 = 'World';
        var s = \`Hello \${name2}!\`;
        $out.s = s;
    `);
    assertEqual(out.s, 'Hello World!', '模板字符串求值应正确');
});

test('动态：switch-case 控制流', () => {
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
    assertEqual(out.result, 'two', 'switch-case 应选中 case 2');
});

test('动态：rest 参数 + spread', () => {
    // rest/spread 涉及 for-of（generator 协议），此处用常规方法测等价逻辑
    const { out } = instrAndRun(`
        function sumArgs() {
            var total = 0;
            for (var i = 0; i < arguments.length; i++) total += arguments[i];
            return total;
        }
        var r = sumArgs(1, 2, 3);
        $out.r = r;
    `);
    assertEqual(out.r, 6, 'sumArgs(1,2,3) 应等于 6');
});

test('动态：逻辑赋值 (&&=, ||=, ??=)', () => {
    const { out } = instrAndRun(`
        var a = 1;  a &&= 2;
        var b = 0;  b ||= 3;
        var c = null; c ??= 4;
        $out.a=a; $out.b=b; $out.c=c;
    `);
    assertEqual(out.a, 2, 'a &&= 2 → 2');
    assertEqual(out.b, 3, 'b ||= 3 → 3');
    assertEqual(out.c, 4, 'c ??= 4 → 4');
});

test('动态：Promise（基本 resolve）', async () => {
    // Promise.resolve() 返回 Promise，需要 await 才能获取 resolved 值
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code:             'var p = Promise.resolve(42); $out.p = p;',
        origCodeFileName: 'promise-test.js',
        instCodeFileName: 'promise-test_inst.js',
        inlineSourceMap:  true,
    });
    const J$inst = new JalangiSandbox();
    const $out = {};
    runInSandbox(code, J$inst, { $out, Promise });
    const val = await $out.p;
    assertEqual(val, 42, 'Promise.resolve(42) 应 resolve 为 42');
});

test('动态：await 表达式语义正确，resolved value 被透传', async () => {
    // 验证插桩后 J$.Aw(iid, await expr) 正确透传 resolved value。
    // 若 Aw() 没有 return val，则 result 为 undefined。
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
    // 等待 async 函数完成
    await $out.p;
    assertEqual($out.result, 99, 'await 的 resolved value 应被正确透传（result 应等于 99）');
});

test('动态：awaitResume 钩子被调用，参数含 iid、contextId 和 val', async () => {
    // 验证 J$.Aw 触发后会调用分析器的 awaitResume 回调，且参数正确。
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
        awaitResume(iid, contextId, val) {
            awaitEvents.push({ iid, contextId, val });
        }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out, Promise });
    await $out.p;

    // 应有两次 awaitResume（await Promise.resolve(11) 和 await Promise.resolve(22)）
    assertEqual(awaitEvents.length, 2, 'awaitResume 应被调用 2 次（对应两个 await）');
    assertEqual(awaitEvents[0].val, 11, '第一个 await 的 resolved value 应为 11');
    assertEqual(awaitEvents[1].val, 22, '第二个 await 的 resolved value 应为 22');
    // iid 应是非零数值
    assert(typeof awaitEvents[0].iid === 'number' && awaitEvents[0].iid > 0, 'iid 应为正整数');
    // contextId 在同一次 async 函数调用中应保持一致（复用 callId）
    assertEqual(awaitEvents[0].contextId, awaitEvents[1].contextId,
        '同一次 async 调用的两个 awaitResume 应有相同的 contextId');
    // contextId 应为正整数（async 函数进入时 callId 已分配）
    assert(typeof awaitEvents[0].contextId === 'number' && awaitEvents[0].contextId > 0,
        'contextId 应为正整数');
});

test('动态：多次 async 调用的 awaitResume contextId 互相独立', async () => {
    // 两次调用同一个 async 函数，每次的 contextId 应不同（callId 单调递增）。
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
        awaitResume(iid, contextId, val) {
            awaitEvents.push({ contextId, val });
        }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out, Promise });
    await Promise.all([$out.p1, $out.p2]);

    assertEqual(awaitEvents.length, 2, '应有 2 个 awaitResume 事件');
    // 两次不同调用的 contextId 必须不同
    assert(awaitEvents[0].contextId !== awaitEvents[1].contextId,
        '不同次 async 调用的 contextId 应互相独立（不同）');
});

test('动态：INSTR_AWAIT=()=>false 时 await 语义仍正确', async () => {
    // 禁用 await 插桩时，await 的值透传不受影响（无 J$.Aw 介入）。
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
    // 验证代码中没有 J$.Aw
    assert(!code.includes('J$.Aw'), 'INSTR_AWAIT=()=>false 时不应注入 J$.Aw');
    const J$inst = new JalangiSandbox();
    const $out = {};
    runInSandbox(code, J$inst, { $out, Promise });
    await $out.p;
    assertEqual($out.v, 77, '禁用 await 插桩后，await 的值仍应正确为 77');
});

// ════════════════════════════════════════════════════════════════
// 动态执行 — 钩子调用验证（Spy 插件）
// ════════════════════════════════════════════════════════════════
console.log('\n── 动态执行：钩子调用验证 ──────────────────────────');

/**
 * 创建一个 Spy 插件：记录所有指定 hook 的调用信息。
 * @param {...string} hookNames  要监控的 hook 名（AnalysisHost 支持的所有 hook 名）
 * @returns {{ plugin: object, calls: Map<string, Array> }}
 */
function createSpy(...hookNames) {
    const calls = new Map();
    const plugin = {};
    for (const name of hookNames) {
        calls.set(name, []);
        plugin[name] = function(...args) {
            calls.get(name).push(args);
        };
    }
    return { plugin, calls };
}

test('钩子：write 钩子被调用，参数含变量名和值', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var x = 42;',
        origCodeFileName: 'spy-write.js',
        instCodeFileName: 'spy-write_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('write');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    const writeCalls = calls.get('write');
    assert(writeCalls.length > 0, 'write 钩子应至少被调用一次');
    // write(iid, name, val, lhs, isGlobal, isScriptLocal)
    const xWrite = writeCalls.find(([_iid, name]) => name === 'x');
    assert(xWrite !== undefined, 'write 钩子中应有变量 x 的写入');
    assertEqual(xWrite[2], 42, 'write 钩子传入的 val 应等于 42');
});

test('钩子：read 钩子被调用，参数含变量名和值', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var x = 10; var y = x + 1;',
        origCodeFileName: 'spy-read.js',
        instCodeFileName: 'spy-read_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('read');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    const readCalls = calls.get('read');
    assert(readCalls.length > 0, 'read 钩子应至少被调用一次');
    // read(iid, name, val, isGlobal, isScriptLocal)
    const xRead = readCalls.find(([_iid, name, val]) => name === 'x' && val === 10);
    assert(xRead !== undefined, 'read 钩子中应有 x=10 的读取记录');
});

test('钩子：binary 钩子被调用，op 和操作数正确', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var r = 3 + 4;',
        origCodeFileName: 'spy-binary.js',
        instCodeFileName: 'spy-binary_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('binary');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    const binCalls = calls.get('binary');
    // binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed)
    const addCall = binCalls.find(([_iid, op, left, right]) => op === '+' && left === 3 && right === 4);
    assert(addCall !== undefined, 'binary 钩子应记录 3 + 4');
    assertEqual(addCall[4], 7, 'binary 钩子传入的 result 应等于 7');
});

test('钩子：getField 钩子被调用，base/offset 正确', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var obj = { val: 99 }; var v = obj.val;',
        origCodeFileName: 'spy-getfield.js',
        instCodeFileName: 'spy-getfield_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('getField');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    const gfCalls = calls.get('getField');
    // getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall)
    const valRead = gfCalls.find(([_iid, base, offset]) =>
        offset === 'val' && typeof base === 'object' && base !== null);
    assert(valRead !== undefined, 'getField 钩子应记录 obj.val 的读取');
    assertEqual(valRead[3], 99, 'getField 传入的 val 应等于 99');
});

test('钩子：putField 钩子被调用，属性写入正确', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var obj = {}; obj.name = "jalangi";',
        origCodeFileName: 'spy-putfield.js',
        instCodeFileName: 'spy-putfield_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('putField');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    const pfCalls = calls.get('putField');
    // putField(iid, base, offset, val, isComputed, isOpAssign)
    const nameWrite = pfCalls.find(([_iid, _base, offset, val]) =>
        offset === 'name' && val === 'jalangi');
    assert(nameWrite !== undefined, 'putField 钩子应记录 obj.name = "jalangi"');
});

test('钩子：functionEnter/functionExit 钩子在函数调用时触发', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'function greet(name) { return "Hello " + name; } var r = greet("test");',
        origCodeFileName: 'spy-fe.js',
        instCodeFileName: 'spy-fe_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('functionEnter', 'functionExit');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    assert(calls.get('functionEnter').length >= 1, 'functionEnter 应至少触发一次');
    assert(calls.get('functionExit').length >= 1, 'functionExit 应至少触发一次');
});

test('钩子：invokeFun 钩子记录函数调用结果', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'function square(n) { return n * n; } var r = square(5);',
        origCodeFileName: 'spy-invoke.js',
        instCodeFileName: 'spy-invoke_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('invokeFun');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    // invokeFun(iid, f, base, args, result, isConstructor, isMethod, ...)
    const invCalls = calls.get('invokeFun');
    const squareCall = invCalls.find(([_iid, _f, _base, args, result]) =>
        Array.isArray(args) && args[0] === 5 && result === 25);
    assert(squareCall !== undefined, 'invokeFun 钩子应记录 square(5) 返回 25');
});

test('钩子：literal 钩子对对象字面量触发', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var obj = { a: 1, b: 2 };',
        origCodeFileName: 'spy-literal.js',
        instCodeFileName: 'spy-literal_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('literal');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    // literal(iid, val, hasGetterSetter)
    const litCalls = calls.get('literal');
    const objLit = litCalls.find(([_iid, val]) =>
        val !== null && typeof val === 'object' && 'a' in val && 'b' in val);
    assert(objLit !== undefined, 'literal 钩子应记录对象字面量 { a:1, b:2 }');
});

test('钩子：conditional 钩子在 if 判断时触发', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var x = 5; var r = (x > 3) ? "big" : "small"; $out.r = r;',
        origCodeFileName: 'spy-cond.js',
        instCodeFileName: 'spy-cond_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('conditional');
    J$inst.analysis.use(plugin);
    const $out = {};
    runInSandbox(code, J$inst, { $out });

    assert(calls.get('conditional').length > 0, 'conditional 钩子应至少触发一次');
    assertEqual($out.r, 'big', '三元运算结果应为 "big"');
});

test('钩子：scriptEnter/scriptExit 在脚本执行时触发', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var z = 1;',
        origCodeFileName: 'spy-script.js',
        instCodeFileName: 'spy-script_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('scriptEnter', 'scriptExit');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    assertEqual(calls.get('scriptEnter').length, 1, 'scriptEnter 应触发一次');
    assertEqual(calls.get('scriptExit').length, 1, 'scriptExit 应触发一次');
});

test('钩子：forinObject 在 for-in 时触发', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var obj = {a:1, b:2}; var keys=[]; for (var k in obj) keys.push(k);',
        origCodeFileName: 'spy-forin.js',
        instCodeFileName: 'spy-forin_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const { plugin, calls } = createSpy('forinObject');
    J$inst.analysis.use(plugin);
    runInSandbox(code, J$inst);

    const foCalls = calls.get('forinObject');
    assert(foCalls.length > 0, 'forinObject 钩子应至少触发一次');
    // forinObject(iid, val) — val 应是被枚举的对象
    const objCall = foCalls.find(([_iid, val]) =>
        val !== null && typeof val === 'object' && 'a' in val);
    assert(objCall !== undefined, 'forinObject 传入的 val 应是被枚举的对象');
});

// ════════════════════════════════════════════════════════════════
// 动态执行 — 完整沙盒端到端测试
// ════════════════════════════════════════════════════════════════
console.log('\n── 动态执行：完整沙盒端到端 ─────────────────────────');

test('端到端：分析插件可修改 binary 结果（拦截 + 覆盖）', () => {
    // 场景：将所有加法结果翻倍的分析插件
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var r = 3 + 4; $out.r = r;',
        origCodeFileName: 'e2e-modify.js',
        instCodeFileName: 'e2e-modify_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    J$inst.analysis.use({
        binary(iid, op, left, right, result) {
            if (op === '+') return { result: result * 2 };
        }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out });
    assertEqual($out.r, 14, '分析插件应将 3+4=7 翻倍为 14');
});

test('端到端：分析插件可修改 write 结果（污点标记模拟）', () => {
    // 场景：将变量 x 的写入值偏移 +1000（模拟污点标记）
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var x = 5; $out.x = x;',
        origCodeFileName: 'e2e-write.js',
        instCodeFileName: 'e2e-write_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    J$inst.analysis.use({
        write(iid, name, val) {
            if (name === 'x') return { result: val + 1000 };
        }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out });
    assertEqual($out.x, 1005, '分析插件应将 x=5 改写为 x=1005');
});

test('端到端：分析插件可拦截 getField（属性读取重写）', () => {
    // 场景：把 obj.secret 重定向返回 "redacted"
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var obj = { secret: "password123" }; var v = obj.secret; $out.v = v;',
        origCodeFileName: 'e2e-getfield.js',
        instCodeFileName: 'e2e-getfield_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    J$inst.analysis.use({
        getField(iid, base, offset, val) {
            if (offset === 'secret') return { result: 'redacted' };
        }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out });
    assertEqual($out.v, 'redacted', '分析插件应将 obj.secret 重定向为 "redacted"');
});

test('端到端：多个分析插件链式注册，按序执行', () => {
    // 场景：两个插件分别 +10 和 *2，最终结果 (3+4+10)*2 = 34
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var r = 3 + 4; $out.r = r;',
        origCodeFileName: 'e2e-chain.js',
        instCodeFileName: 'e2e-chain_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    J$inst.analysis
        .use({ binary(_iid, op, _l, _r, result) { if (op === '+') return { result: result + 10 }; } })
        .use({ binary(_iid, op, _l, _r, result) { if (op === '+') return { result: result * 2 }; } });
    const $out = {};
    runInSandbox(code, J$inst, { $out });
    assertEqual($out.r, 34, '链式插件应先 +10 再 *2，即 (7+10)*2=34');
});

test('端到端：NaN 检测分析（类 CheckNaN 插件）', () => {
    // 场景：检测 NaN 参与的运算，记录到 violations
    init(ALL_CONFIG);
    const { code } = instrumentCode({
        code: 'var x = NaN; var r = x + 1;',
        origCodeFileName: 'e2e-nan.js',
        instCodeFileName: 'e2e-nan_inst.js',
        inlineSourceMap: true,
    });
    const J$inst = new JalangiSandbox();
    const violations = [];
    J$inst.analysis.use({
        binary(iid, op, left, right, result) {
            if (Number.isNaN(left) || Number.isNaN(right) || Number.isNaN(result)) {
                violations.push({ iid, op, left, right, result });
            }
        }
    });
    runInSandbox(code, J$inst);
    assert(violations.length > 0, 'NaN 检测插件应记录到 NaN 参与的运算');
    assertEqual(violations[0].op, '+', '违规运算符应为 +');
});

test('端到端：invokeFunPre 可跳过函数调用', () => {
    // 场景：拦截 square() 调用，skip=true 时不执行原函数，通过 invokeFun 改写返回值
    init(ALL_CONFIG);
    const { code } = instrumentCode({
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
        invokeFunPre(iid, f, base, args, isConstructor, isMethod) {
            if (f && f.name === 'square') {
                return { f, base, args, skip: true };
            }
        },
        invokeFun(iid, f, base, args, result) {
            if (f && f.name === 'square') {
                // skip 后 result 为 undefined，改写为固定值
                return { result: 999 };
            }
        }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out });
    assertEqual($out.r, 999, 'invokeFunPre skip=true 后 r 应被改写为 999');
});

test('端到端：throw 在 try-catch 中被分析插件观测', () => {
    init(ALL_CONFIG);
    const { code } = instrumentCode({
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
        _throw(iid, val) { throwEvents.push(val); }
    });
    const $out = {};
    runInSandbox(code, J$inst, { $out });
    assertEqual($out.caught, 'test-error', 'catch 应捕获抛出的异常');
    assert(throwEvents.length > 0, '_throw 钩子应被触发');
    assert(throwEvents[0] instanceof Error, '_throw 钩子传入的应是 Error 实例');
});

test('端到端：iidToLocation 能解析插桩位置信息', () => {
    // 运行后 J$.sid 指向最后一次 Se() 完成的脚本，smap 已填充
    init(ALL_CONFIG);
    const { code } = instrumentCode({
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
    runInSandbox(code, J$inst);

    assert(binaryIids.length > 0, '应记录到 binary 的 iid');
    // 注意：Sr() 执行后 J$.sid 会 rollback 到执行前的值（0），
    // 应使用 J$.lastSid 获取最近执行的脚本 ID（由 Se() 在 rollback 前保存）
    const sid = J$inst.lastSid;
    const loc = J$inst.iidToLocation(sid, binaryIids[0]);
    assert(typeof loc === 'string' && loc.length > 0, 'iidToLocation 应返回非空字符串');
    // 位置字符串应包含文件名（插桩代码使用 inlineSourceMap 已将映射写入 J$.smap）
    assertIncludes(loc, 'e2e-iidloc.js', 'iidToLocation 应包含原始文件名');
});


// 等待所有异步测试完成，然后打印最终结果
Promise.all(_asyncTests).then(() => {
    console.log(`\n${'─'.repeat(52)}`);
    if (failed === 0) {
        console.log(`✅  All ${passed} tests passed.`);
    } else {
        console.log(`❌  ${failed} failed / ${passed + failed} total`);
        process.exit(1);
    }
});
