/**
 * test/unit/instrument.test.mjs — 插桩器静态输出单元测试
 *
 * 只测试 instrumentCode() 的输出字符串，不依赖 JalangiSandbox / vm 执行。
 *
 * 覆盖范围：
 *   - ES5 基础语法（var、function、for-in、try-catch）
 *   - ES6（箭头函数、class、解构、模板字符串、rest/spread、Promise）
 *   - ES2017（async/await 插桩结构）
 *   - ES2019（optional catch binding）
 *   - ES2020（optional chaining、nullish coalescing、BigInt、logical assign）
 *   - ES2022（class private fields、顶层 await）
 *   - ESM（import/export）
 *   - IID Source Map 完整性
 *   - VLCQ Source Map v3 格式
 *   - JALANGI DO NOT INSTRUMENT 跳过逻辑
 *   - Config 选择性禁用（全部 INSTR_* 字段）
 *   - 边界条件（语法错误、空代码、严格模式、init 参数校验）
 *   - 插桩幂等性
 *   - BUG 回归测试（BUG1 ~ BUG8，修复后防退化）
 *   - 防御代码（Guard）触发验证
 *   - 自定义沙盒变量名（jalangiVar）
 *   - 按需插桩（pluginAnalyzer + buildConfigFromHooks）
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

import {
    init, instrumentCode,
    analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig,
} from '../../src/instrument/esnstrument.js';
import { ALL_CONFIG, instr } from '../helpers/shared-helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// 每个 describe 结束后恢复全量 Config，避免污染后续 suite
function restoreConfig() { init({ ...ALL_CONFIG }); }

// ════════════════════════════════════════════════════════════════════════════════
// ES5
// ════════════════════════════════════════════════════════════════════════════════

describe('ES5 基础语法', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('基本 var 声明 + 二元运算', () => {
        const r = instr('var x = 1 + 2; console.log(x);');
        assert.ok(r.code.includes('J$.B('),  '应注入二元运算钩子 J$.B');
        assert.ok(r.code.includes('J$.W('),  '应注入写入钩子 J$.W');
        assert.ok(r.code.includes('J$.N('),  '应注入变量初始化钩子 J$.N');
    });

    test('function 声明', () => {
        const r = instr('function foo(a) { return a + 1; }');
        assert.ok(r.code.includes('J$.Fe('), '应注入函数入口钩子 J$.Fe');
        assert.ok(r.code.includes('J$.Fr('), '应注入函数返回钩子 J$.Fr');
        assert.ok(r.code.includes('J$.B('),  '应注入二元运算钩子 J$.B');
    });

    test('for-in 循环', () => {
        const r = instr('var o = {a:1}; for (var k in o) { console.log(k); }');
        assert.ok(r.code.includes('J$.H('), '应注入 hash 钩子用于 for-in 右侧');
        assert.ok(r.code.includes('J$.W('), '应注入写入钩子（for-in 变量赋值）');
    });

    test('try-catch-finally', () => {
        const r = instr('try { x(); } catch(e) { console.log(e); } finally { done(); }');
        assert.ok(r.code.includes('J$.Se('), '应注入脚本入口钩子 J$.Se');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES6
// ════════════════════════════════════════════════════════════════════════════════

describe('ES6 语法', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('箭头函数 + 默认参数', () => {
        const r = instr('const f = (x, y = 0) => x + y;');
        assert.ok(r.code.includes('J$.T('), '箭头函数应被 wrapLiteral 包装为 J$.T');
        assert.ok(r.code.includes('J$.B('), '应注入二元运算钩子 J$.B');
    });

    test('箭头函数（表达式体）', () => {
        const r = instr('var add = (a, b) => a + b;');
        assert.ok(r.code.includes('J$.W('), '箭头函数赋值应注入写入钩子 J$.W');
        assert.ok(r.code.includes('J$.Rl(') || r.code.includes('J$.R('),
            '参数应注入读取钩子（J$.Rl 或 J$.R）');
    });

    test('class（constructor + 普通方法）', () => {
        const r = instr('class Animal { constructor(n) { this.name = n; } speak() { return this.name; } }');
        assert.ok(r.code.includes('speak'),  'class 方法名应保留');
        assert.ok(r.code.includes('J$.Fe('), 'class 方法应注入 J$.Fe');
        assert.ok(r.code.includes('J$.P('),  'this.name 赋值应注入属性写入钩子 J$.P');
    });

    test('class（getter / setter）', () => {
        const r = instr('class Box { get val() { return this._v; } set val(v) { this._v = v; } }');
        assert.ok(r.code.includes('J$.Fe('),   'getter/setter 函数应注入 J$.Fe');
        assert.ok(!r.code.includes('J$.T('),   'getter/setter 内函数不应被 wrapLiteral 包装');
    });

    test('class 继承', () => {
        const r = instr('class Dog extends Animal { bark() { return "woof"; } }');
        assert.ok(r.code.includes('J$.Fe('), 'class 方法应注入 J$.Fe');
    });

    test('对象解构', () => {
        const r = instr('const {a, b} = obj;');
        assert.ok(r.code.includes('J$.R('), '解构右侧应注入读取钩子 J$.R');
    });

    test('数组解构', () => {
        const r = instr('const [x, y] = [1, 2];');
        assert.ok(r.code.includes('J$.T('), '数组字面量应注入 J$.T');
    });

    test('模板字符串', () => {
        const r = instr('var s = `hello ${name}`;');
        assert.ok(r.code.includes('J$.R('), '模板字符串中的变量引用应注入读取钩子 J$.R');
    });

    test('rest 参数', () => {
        const r = instr('function f(...args) { return args; }');
        assert.ok(r.code.includes('J$.Fe('), '含 rest 参数的函数应注入 J$.Fe');
    });

    test('spread 运算符', () => {
        const r = instr('const arr = [1, ...other, 2];');
        assert.ok(r.code.includes('J$.T('), '含 spread 的数组字面量应注入 J$.T');
        assert.ok(r.code.includes('J$.R('), 'spread 的 other 应注入读取钩子 J$.R');
    });

    test('Promise', () => {
        const r = instr('var p = new Promise((resolve, reject) => { resolve(42); });');
        assert.ok(r.code.includes('J$.F('), 'new Promise() 应注入 J$.F');
        assert.ok(r.code.includes('J$.R('), 'Promise 标识符应注入读取钩子 J$.R');
    });

    test('解构函数参数', () => {
        const r = instr('function f({x, y}, [a, b]) { return x + y + a + b; }');
        assert.ok(r.code.includes('J$.Fe('), '解构参数函数应注入 J$.Fe');
        assert.ok(r.code.includes('J$.B('),  '函数体内二元运算应注入 J$.B');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES2017
// ════════════════════════════════════════════════════════════════════════════════

describe('ES2017 async/await', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('async / await — 插桩结构检查', () => {
        const r = instr('async function fetchData() { var data = await fetch("/api"); return data.json(); }');
        assert.ok(r.code.includes('J$.Fe('),  'async 函数应注入 J$.Fe');
        assert.ok(r.code.includes('J$.Fr('),  'async 函数应注入返回钩子 J$.Fr');
        assert.ok(r.code.includes('J$.Aw('),  'await 表达式应注入 J$.Aw 钩子');
    });

    test('async / await — J$.Aw 内部保留 await 关键字', () => {
        const r = instr('async function f() { return await Promise.resolve(1); }');
        assert.ok(r.code.includes('J$.Aw('), 'await 应被改写为 J$.Aw 钩子');
        const awIdx = r.code.indexOf('J$.Aw(');
        const awContent = r.code.slice(awIdx, r.code.indexOf(')', awIdx + 10) + 1);
        assert.ok(awContent.includes('await'), 'J$.Aw 的参数中应包含 await 关键字（await 语义保留在钩子内部）');
    });

    test('async / await — 顶层 await（module 模式）注入 J$.Aw', () => {
        const r = instr('const res = await Promise.resolve(42);', { sourceType: 'module' });
        assert.ok(r.code.includes('J$.Aw('), '顶层 await 也应注入 J$.Aw 钩子');
        assert.ok(r.code.includes('await'),  '顶层 await 的 await 关键字应保留');
    });

    test('async / await — 链式 await 每处均注入钩子', () => {
        const r = instr(`async function chain() {
            const a = await Promise.resolve(1);
            const b = await Promise.resolve(2);
            return a + b;
        }`);
        const awCount = (r.code.match(/J\$\.Aw\(/g) || []).length;
        assert.ok(awCount >= 2, `链式 await 应注入 ≥2 个 J$.Aw 钩子，实际: ${awCount}`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES2019
// ════════════════════════════════════════════════════════════════════════════════

describe('ES2019 optional catch binding', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('optional catch binding（无参数 catch）不崩溃', () => {
        const r = instr('try { foo(); } catch { console.log("caught"); }');
        assert.ok(r.code.includes('J$.Se('), 'optional catch binding 代码应能正常插桩');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES2020
// ════════════════════════════════════════════════════════════════════════════════

describe('ES2020 语法', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('optional chaining (?.) 内部属性访问被插桩', () => {
        const r = instr('var x = obj?.foo?.bar;');
        assert.ok(r.code.includes('J$.G('), 'optional chaining 内部属性访问应注入 J$.G');
    });

    test('nullish coalescing (??) 注入条件钩子', () => {
        const r = instr('var x = a ?? b;');
        assert.ok(r.code.includes('J$.C('),   '?? 运算符应注入条件钩子 J$.C');
        assert.ok(r.code.includes('J$.tmp_'), '?? 应使用唯一临时属性暂存左侧值');
    });

    test('嵌套 ?? 各使用独立临时变量（无共享槽竞争）', () => {
        const r = instr('var x = (a ?? b) ?? c;');
        assert.ok(r.code.includes('J$.tmp_0'), '外层 ?? 应使用 J$.tmp_0');
        assert.ok(r.code.includes('J$.tmp_1'), '内层 ?? 应使用 J$.tmp_1（与外层独立）');
    });

    test('BigInt 字面量不崩溃且原样保留', () => {
        const r = instr('var n = 9007199254740991n;');
        assert.ok(r.code.includes('J$.Se('),          'BigInt 代码应能正常插桩');
        assert.ok(r.code.includes('9007199254740991n'), 'BigInt 字面量应原样保留');
    });

    test('logical assignment (||= &&= ??=) 注入写入和条件钩子', () => {
        const r = instr('a ||= b; a &&= c; a ??= d;');
        assert.ok(r.code.includes('J$.W('), 'logical assignment 应注入写入钩子 J$.W');
        assert.ok(r.code.includes('J$.C('), 'logical assignment 的条件分支应注入 J$.C');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ES2022
// ════════════════════════════════════════════════════════════════════════════════

describe('ES2022 语法', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('class private fields + getter', () => {
        const r = instr('class Counter { #count = 0; increment() { this.#count++; } get value() { return this.#count; } }');
        assert.ok(r.code.includes('J$.Fe('), '含私有字段的 class 方法应注入 J$.Fe');
        assert.ok(r.code.includes('#count'),  '私有字段名 #count 应保留');
    });

    test('class static field 不崩溃', () => {
        const r = instr('class Cfg { static debug = false; }');
        assert.ok(r.code.includes('J$.Se('), 'class static field 代码应能正常插桩');
    });

    test('顶层 await（module 模式）fetch() 调用被插桩', () => {
        const r = instr('const res = await fetch("https://example.com"); console.log(res.status);', { sourceType: 'module' });
        assert.ok(r.code.includes('J$.F('), '顶层 await 的 fetch() 调用应注入 J$.F');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ESM import / export
// ════════════════════════════════════════════════════════════════════════════════

describe('ESM import/export', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('import + export（module 模式）', () => {
        const r = instr('import { foo } from "./foo.js"; export const bar = foo();', { sourceType: 'module' });
        assert.ok(r.code.includes('J$.F('), 'foo() 调用应注入 J$.F');
        assert.ok(r.code.includes('J$.W('), 'const bar 初始化应注入 J$.W');
    });

    test('export default function', () => {
        const r = instr('export default function greet(name) { return `Hello, ${name}`; }', { sourceType: 'module' });
        assert.ok(r.code.includes('J$.Fe('), 'export default function 应注入 J$.Fe');
        assert.ok(r.code.includes('J$.Fr('), '函数应注入返回钩子 J$.Fr');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Source Map
// ════════════════════════════════════════════════════════════════════════════════

describe('IID Source Map', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('sourceMapObject 存在且含 nBranches', () => {
        const r = instr('var x = 1 + 2;');
        assert.ok(typeof r.sourceMapObject === 'object',           'sourceMapObject 应为对象');
        assert.ok(typeof r.sourceMapObject.nBranches === 'number', 'nBranches 应为数字');
    });

    test('inlineSourceMap 模式：iids 内联到代码头部', () => {
        const r = instr('var x = 3;', { inlineSourceMap: true });
        assert.ok(r.code.includes('J$.iids='), '应内联 iids 对象（向后兼容）');
        assert.ok(r.code.includes('J$.smap='), '应初始化 smap 对象');
        assert.ok(r.code.includes('J$.smap['), '应以 smap[key] 存储 source map');
    });

    test('script 模式输出包含 IIFE 结构', () => {
        const r = instr('var x = 1;');
        assert.ok(r.code.includes('(function(J$)'), 'script 模式应用 IIFE 包裹 J$ 为闭包参数');
    });

    test('module 模式：const J$ 局部绑定而非 IIFE', () => {
        const r = instr('export const x = 1;', { sourceType: 'module' });
        assert.ok(r.code.includes('const J$ = globalThis.J$'), 'module 模式应用 const 局部绑定');
        assert.ok(!r.code.includes('(function(J$)'),            'module 模式不应再包一层 IIFE');
    });

    test('smap 多文件互不覆盖：不同文件名写入不同 smap key', () => {
        const r1 = instrumentCode({ code: 'var a = 1;', origCodeFileName: 'file1.js', instCodeFileName: 'file1_inst.js', inlineSourceMap: true });
        const r2 = instrumentCode({ code: 'var b = 2;', origCodeFileName: 'file2.js', instCodeFileName: 'file2_inst.js', inlineSourceMap: true });
        assert.ok(r1.code.includes('smap["file1_inst.js"]'),  'file1 应写入 smap["file1_inst.js"]');
        assert.ok(r2.code.includes('smap["file2_inst.js"]'),  'file2 应写入 smap["file2_inst.js"]');
        assert.ok(!r1.code.includes('smap["file2_inst.js"]'), 'file1 不应出现 file2 的 key');
    });

    test('sourceMapObject 包含文件名信息', () => {
        const r = instr('var x = 1;', { file: 'myfile.js' });
        assert.equal(r.sourceMapObject.originalCodeFileName, 'myfile.js', '原始文件名应匹配');
    });

    test('sourceMapObject 中 IID 对应行列信息为 4 元素数组', () => {
        const r = instr('var x = 3;', { inlineSourceMap: true });
        const entries = Object.entries(r.sourceMapObject).filter(([k]) => /^\d+$/.test(k));
        assert.ok(entries.length > 0, '应有 IID 映射条目');
        const [, loc] = entries[0];
        assert.ok(Array.isArray(loc) && loc.length === 4, 'IID 位置应为 4 元素数组');
    });

    test('inlineSource: true 时 sourceMapObject.code 包含原始源代码', () => {
        const originalCode = 'var x = 1 + 2;';
        const r = instrumentCode({
            code: originalCode,
            origCodeFileName: 'inline-src.js',
            instCodeFileName: 'inline-src_i.js',
            inlineSourceMap: true,
            inlineSource:    true,
        });
        assert.ok(r.sourceMapObject.code === originalCode,
            'inlineSource=true 时 sourceMapObject.code 应等于原始代码');
        // 内联到头部的 JSON 串中也应包含 code 字段
        assert.ok(r.code.includes('"code"'), '头部注入的 JSON 应包含 "code" 字段（inlineSource=true）');
    });

    test('inlineSource: false（默认）时 sourceMapObject 不含 code 字段', () => {
        const r = instrumentCode({
            code: 'var y = 3;',
            origCodeFileName: 'no-inline.js',
            instCodeFileName: 'no-inline_i.js',
            inlineSourceMap: true,
            inlineSource:    false,
        });
        assert.ok(r.sourceMapObject.code === undefined,
            'inlineSource=false 时 sourceMapObject 不应包含 code 字段');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// VLCQ Source Map v3
// ════════════════════════════════════════════════════════════════════════════════

describe('VLCQ Source Map v3', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('vlcqSourceMap 存在且格式正确', () => {
        const r = instr('var x = 1 + 2;');
        assert.ok(r.vlcqSourceMap != null,                     'vlcqSourceMap 应为非空对象');
        assert.equal(r.vlcqSourceMap.version, 3,               'version 应为 3');
        assert.ok(Array.isArray(r.vlcqSourceMap.sources),      'sources 应为数组');
        assert.ok(typeof r.vlcqSourceMap.mappings === 'string', 'mappings 应为字符串');
    });

    test('sources 数组包含原始文件名', () => {
        const r = instrumentCode({ code: 'var x = 1;', origCodeFileName: 'hello.js', instCodeFileName: 'hello_inst.js' });
        assert.ok(r.vlcqSourceMap.sources.some(s => s.includes('hello.js')), 'sources 应包含 hello.js');
    });

    test('mappings 以若干 ";" 开头（行偏移补偿）', () => {
        const r = instr('function f() { return 1; }');
        assert.ok(r.vlcqSourceMap.mappings.startsWith(';;'),
            `mappings 应以 ";;" 开头（2 行偏移），实际: ${JSON.stringify(r.vlcqSourceMap.mappings.slice(0, 10))}`);
    });

    test('JALANGI DO NOT INSTRUMENT 代码不生成 vlcqSourceMap', () => {
        const r = instrumentCode({ code: '// JALANGI DO NOT INSTRUMENT\nvar x = 1;', origCodeFileName: 'skip.js', instCodeFileName: 'skip_inst.js' });
        assert.equal(r.vlcqSourceMap, null, '包含 DO NOT INSTRUMENT 标记，vlcqSourceMap 应为 null');
    });

    test('module 模式下行偏移补偿同样正确', () => {
        const r = instrumentCode({ code: 'export const x = 1;', origCodeFileName: 'mod.mjs', instCodeFileName: 'mod_inst.mjs', sourceType: 'module' });
        assert.ok(r.vlcqSourceMap != null,    'module 模式下 vlcqSourceMap 应存在');
        assert.equal(r.vlcqSourceMap.version, 3, 'version 应为 3');
        assert.ok(r.vlcqSourceMap.mappings.startsWith(';;'),
            `module 模式 mappings 应以 ";;" 开头，实际: ${JSON.stringify(r.vlcqSourceMap.mappings.slice(0, 10))}`);
    });

    test('多行代码 mappings 中包含多个 ";" 分隔符', () => {
        const r = instr('function add(a, b) {\n  return a + b;\n}\nvar result = add(1, 2);');
        const count = (r.vlcqSourceMap.mappings.match(/;/g) ?? []).length;
        assert.ok(count > 2, `多行代码的 mappings 应包含多个 ";" (实际 ${count})`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 跳过插桩
// ════════════════════════════════════════════════════════════════════════════════

describe('JALANGI DO NOT INSTRUMENT 跳过', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('含 JALANGI DO NOT INSTRUMENT 的代码不被插桩', () => {
        const r = instr('var x = 1; // JALANGI DO NOT INSTRUMENT');
        assert.ok(!r.code.includes('J$.W(') && !r.code.includes('J$.R('), '不应注入读写钩子');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Config 选择性禁用
// ════════════════════════════════════════════════════════════════════════════════

describe('Config 选择性禁用', () => {
    after(restoreConfig);

    test('INSTR_READ = () => false 时不注入读取钩子', () => {
        init({ ...ALL_CONFIG, INSTR_READ: () => false });
        assert.ok(!instr('var x = a + b;').code.includes('J$.R('), '不应有 J$.R 读取钩子');
    });

    test('INSTR_WRITE = () => false 时不注入写入钩子', () => {
        init({ ...ALL_CONFIG, INSTR_WRITE: () => false });
        assert.ok(!instr('x = 1;').code.includes('J$.W('), '不应有 J$.W 写入钩子');
    });

    test('INSTR_GETFIELD = () => false 时不注入属性读取钩子', () => {
        init({ ...ALL_CONFIG, INSTR_GETFIELD: () => false });
        assert.ok(!instr('var x = obj.foo;').code.includes('J$.G('), '不应有 J$.G 属性读取钩子');
    });

    test('INSTR_PUTFIELD = () => false 时不注入属性写入钩子', () => {
        init({ ...ALL_CONFIG, INSTR_PUTFIELD: () => false });
        assert.ok(!instr('obj.foo = 1;').code.includes('J$.P('), '不应有 J$.P 属性写入钩子');
    });

    test('INSTR_BINARY = () => false 时不注入二元运算钩子', () => {
        init({ ...ALL_CONFIG, INSTR_BINARY: () => false });
        assert.ok(!instr('var x = 1 + 2;').code.includes('J$.B('), '不应有 J$.B 二元运算钩子');
    });

    test('INSTR_UNARY = () => false 时不注入一元运算钩子', () => {
        init({ ...ALL_CONFIG, INSTR_UNARY: () => false });
        assert.ok(!instr('var x = -a;').code.includes('J$.U('), '不应有 J$.U 一元运算钩子');
    });

    test('INSTR_LITERAL = () => false 时不注入字面量钩子', () => {
        init({ ...ALL_CONFIG, INSTR_LITERAL: () => false });
        assert.ok(!instr('var x = [1, 2];').code.includes('J$.T('), '不应有 J$.T 字面量钩子');
    });

    test('INSTR_CONDITIONAL = () => false 时不注入条件钩子', () => {
        init({ ...ALL_CONFIG, INSTR_CONDITIONAL: () => false });
        assert.ok(!instr('var x = a ? b : c;').code.includes('J$.C('), '不应有 J$.C 条件钩子');
    });

    test('INSTR_INIT = () => false 时不注入变量初始化钩子', () => {
        init({ ...ALL_CONFIG, INSTR_INIT: () => false });
        assert.ok(!instr('var x = 1;').code.includes('J$.N('), '不应有 J$.N 初始化钩子');
    });

    test('INSTR_INVOKE = () => false 时不注入函数调用钩子', () => {
        init({ ...ALL_CONFIG, INSTR_INVOKE: () => false });
        const r = instr('function foo(){} foo(); var o = {}; o.bar = function(){}; o.bar();');
        assert.ok(!r.code.includes('J$.F('), '不应有 J$.F 函数调用钩子');
        assert.ok(!r.code.includes('J$.M('), '不应有 J$.M 方法调用钩子');
    });

    test('INSTR_RETURN = () => false 时不注入 return 钩子', () => {
        init({ ...ALL_CONFIG, INSTR_RETURN: () => false });
        assert.ok(!instr('function f() { return 1; }').code.includes('J$.Rt('), '不应有 J$.Rt return 钩子');
    });

    test('INSTR_THROW = () => false 时不注入 throw 钩子', () => {
        init({ ...ALL_CONFIG, INSTR_THROW: () => false });
        assert.ok(!instr('function f() { throw new Error("e"); }').code.includes('J$.Th('), '不应有 J$.Th throw 钩子');
    });

    test('INSTR_FORIN = () => false 时不注入 for-in 钩子', () => {
        init({ ...ALL_CONFIG, INSTR_FORIN: () => false });
        const r = instr('for (var k in obj) { k; }');
        assert.ok(!r.code.includes('J$.H('), '不应有 J$.H for-in 钩子');
    });

    test('INSTR_END_EXPRESSION = () => false 时不注入 X1 表达式末尾钩子', () => {
        init({ ...ALL_CONFIG, INSTR_END_EXPRESSION: () => false });
        assert.ok(!instr('1 + 2;').code.includes('J$.X1('), '不应有 J$.X1 表达式末尾钩子');
    });

    test('INSTR_TRY_CATCH_ARGUMENTS = () => false 时不注入 try-catch 包裹', () => {
        init({ ...ALL_CONFIG, INSTR_TRY_CATCH_ARGUMENTS: () => false });
        const r = instr('function f(a) { return a; }');
        assert.ok(!r.code.includes('jalangiLabel'), '不应有 jalangiLabel while 循环包裹');
        assert.ok(!r.code.includes('J$.Fe('), '不应有 J$.Fe 函数入口钩子（依赖 try-catch 包裹）');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 边界条件
// ════════════════════════════════════════════════════════════════════════════════

describe('边界条件', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('语法错误代码应抛出带文件名的错误', () => {
        assert.throws(
            () => instr('function (', { file: 'bad.js' }),
            (e) => {
                assert.ok(e.message.includes('bad.js'), '错误信息应包含文件名');
                assert.ok(e.cause instanceof Error,     'error.cause 应为原始 SyntaxError');
                return true;
            }
        );
    });

    test('空字符串代码不崩溃且返回有效结果', () => {
        const r = instr('');
        assert.ok(r.code.includes('JALANGI DO NOT INSTRUMENT'), '空代码插桩结果应含 NO_INSTR 标记');
        assert.ok(typeof r.sourceMapObject === 'object', '空代码应有 sourceMapObject');
    });

    test('含 use strict 的代码不崩溃', () => {
        const r = instr('"use strict"; function foo() { return 1; }');
        assert.ok(r.code.includes('J$.Fe('),              '严格模式代码应注入 J$.Fe');
        assert.ok(r.code.includes('return arguments.callee'), '应有 arguments.callee 的 try-catch 降级');
        assert.ok(r.code.includes('catch (e)'),            '应有 catch 分支降级');
    });

    test('init() 传入 null 应抛出 TypeError', () => {
        assert.throws(() => init(null), (e) => {
            assert.ok(e instanceof TypeError,         '应抛出 TypeError');
            assert.ok(e.message.includes('[jalangi]'), '错误信息应包含 [jalangi] 前缀');
            return true;
        });
        init({ ...ALL_CONFIG }); // 恢复
    });

    test('init() 传入非对象应抛出 TypeError', () => {
        assert.throws(() => init('bad'), TypeError);
        init({ ...ALL_CONFIG }); // 恢复
    });

    test('插桩幂等性：同一代码两次插桩结果完全相同', () => {
        const code = 'for (var k in obj) { k; }';
        const r1 = instr(code);
        const r2 = instr(code);
        assert.equal(r1.sourceMapObject.nBranches, r2.sourceMapObject.nBranches, 'nBranches 应一致');
        assert.equal(r1.code, r2.code, '两次插桩同一代码结果应完全相同');
    });

    test('isEval: true 时代码被 eval 包裹，并包含 JALANGI DO NOT INSTRUMENT', () => {
        // isEval=true 用于插桩 eval 内部代码：不使用 jalangiLabel while(true) 脚本外壳，
        // 使用更轻量的 Se/Sr 入口，且输出末尾仍有防二次插桩标记。
        const r = instrumentCode({
            code:             'var x = 1 + 2; x;',
            origCodeFileName: 'eval-test.js',
            instCodeFileName: 'eval-test_inst.js',
            inlineSourceMap:  false,
            isEval:           true,
        });
        assert.ok(typeof r.code === 'string' && r.code.length > 0, 'isEval=true 应正常返回插桩代码');
        assert.ok(r.code.includes('JALANGI DO NOT INSTRUMENT'), 'isEval 插桩输出末尾应含防二次插桩标记');
        // 应含基本钩子（表明插桩有效）
        assert.ok(r.code.includes('J$.B(') || r.code.includes('J$.W('), 'isEval 模式下基本钩子仍应被注入');
        assert.ok(typeof r.sourceMapObject === 'object', 'isEval 模式应返回 sourceMapObject');
    });

    test('isEval: true 与 inlineSourceMap: true 可同时使用', () => {
        const r = instrumentCode({
            code:             'var y = 10;',
            origCodeFileName: 'eval-smap.js',
            instCodeFileName: 'eval-smap_inst.js',
            inlineSourceMap:  true,
            isEval:           true,
        });
        assert.ok(r.code.includes('J$.smap'), 'isEval+inlineSourceMap=true 应在代码中内联 smap 对象');
        assert.ok(r.sourceMapObject && typeof r.sourceMapObject === 'object', '应有 sourceMapObject');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// BUG 回归测试（修复后添加，防止退化）
// ════════════════════════════════════════════════════════════════════════════════

describe('BUG 回归测试', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('BUG1: INSTR_BINARY 回调第二参数应为 AST node 而非 operator 字符串', () => {
        let secondArgType = null;
        init({ ...ALL_CONFIG, INSTR_BINARY: (_op, second) => { secondArgType = typeof second; return true; } });
        instr('var x = 1 + 2;');
        init({ ...ALL_CONFIG });
        assert.equal(secondArgType, 'object', 'INSTR_BINARY 第二参数应为 AST node（object），不应为字符串');
    });

    test('BUG2: ENABLE_SAMPLING 模式不应崩溃', () => {
        init({ ...ALL_CONFIG, ENABLE_SAMPLING: true });
        const r = instr('function f() { return 1; }');
        assert.ok(r.code.includes('J$.S('), 'ENABLE_SAMPLING 模式应注入采样钩子 J$.S');
    });

    test('BUG2b: ENABLE_SAMPLING 辅助函数 wrapper 不应被 mergeBodies 错误处理', () => {
        init({ ...ALL_CONFIG, ENABLE_SAMPLING: true });
        const r = instr('function outer() { function inner() { return 2; } return inner(); }');
        assert.ok(r.code.includes('J$.S('), '嵌套函数 ENABLE_SAMPLING 应正常产出');
    });

    test('BUG3: 箭头函数参数不应被错误标记为全局变量', () => {
        init({ ...ALL_CONFIG });
        const r = instr('var f = (x) => x + 1;');
        // 箭头函数参数不走轻量路径（Rl），因为箭头函数没有 Fe/Fr 初始化 Shadow Frame
        const rlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"x"\s*\)/);
        assert.equal(rlMatch, null, '箭头参数 x 不应走 Rl（Shadow Frame 未初始化）');
        // 走全量路径：bitPattern=0 意味着 isGlobal=false
        const match = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"x"\s*,[^,]+,\s*(\d+)\s*[,)]/);
        assert.ok(match !== null, '应存在对 x 的读取插桩 J$.R');
        assert.equal(parseInt(match[1]), 0, '箭头参数 x 的 isGlobal 应为 false（bitPattern=0）');
    });

    test('BUG3b: 嵌套箭头函数各自独立作用域不相互污染', () => {
        init({ ...ALL_CONFIG });
        const r = instr('var f = (x) => (y) => x + y;');
        const xRlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"x"\s*\)/);
        const yRlMatch = r.code.match(/J\$\.Rl\(\s*\d+\s*,\s*\d+\s*,\s*"y"\s*\)/);
        assert.equal(xRlMatch, null, '箭头参数 x 不应走 Rl');
        assert.equal(yRlMatch, null, '箭头参数 y 不应走 Rl');
        const xRMatch = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"x"\s*,[^,]+,\s*(\d+)\s*[,)]/);
        const yRMatch = r.code.match(/J\$\.R\(\s*\d+\s*,\s*"y"\s*,[^,]+,\s*(\d+)\s*[,)]/);
        assert.ok(xRMatch !== null, '应存在对 x 的读取插桩 J$.R');
        assert.ok(yRMatch !== null, '应存在对 y 的读取插桩 J$.R');
        assert.equal(parseInt(xRMatch[1]), 0, '外层箭头参数 x 应为局部变量（bitPattern=0）');
        assert.equal(parseInt(yRMatch[1]), 0, '内层箭头参数 y 应为局部变量（bitPattern=0）');
    });

    test('BUG4: strict mode 函数中 arguments 初始化不应产生赋值语句', () => {
        const r = instr('"use strict"; function f(a) { return a; }');
        assert.ok(!r.code.match(/\barguments\s*=/), '严格模式下不应出现 arguments = ... 赋值语句');
        assert.ok(r.code.includes('J$.N('), '应存在 J$.N 调用以通知运行时 arguments 初始化');
    });

    test('BUG5: generator 函数的 yield 不应被 while(true)try/finally 破坏', () => {
        const r = instr('function* gen() { yield 1; yield 2; }');
        assert.ok(r.code.includes('yield'), '插桩后代码应保留 yield 关键字');
        // AST 层面验证：generator 函数体不应被 wrapFunBodyWithTryCatch 包裹
        function findGeneratorFn(node) {
            if (!node || typeof node !== 'object') return null;
            if (node.type === 'FunctionDeclaration' && node.generator) return node;
            for (const key of Object.keys(node)) {
                if (key === 'scope') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    for (const c of child) { const found = findGeneratorFn(c); if (found) return found; }
                } else { const found = findGeneratorFn(child); if (found) return found; }
            }
            return null;
        }
        const genFn = findGeneratorFn(r.instAST);
        assert.ok(genFn !== null, 'instAST 中应存在 generator FunctionDeclaration');
        assert.equal(genFn.body.body[0].type, 'ExpressionStatement',
            `generator 函数体第一条语句应是 ExpressionStatement（J$.Fe 调用），实际是 ${genFn.body.body[0].type}`);
    });

    test('BUG6: async 函数的 await 不应被 while(true)try/finally 破坏', () => {
        const r = instr('async function fetchData() { return await Promise.resolve(42); }');
        assert.ok(r.code.includes('await'), '插桩后代码应保留 await 关键字');
        const bodyMatch = r.code.match(/async function fetchData\s*\(\s*\)\s*\{([\s\S]*?)\n\s*\}/);
        if (bodyMatch) {
            const body = bodyMatch[1];
            assert.ok(!(body.includes('jalangiLabel') && body.includes('J$.Fr')),
                'async 函数体不应同时含有 jalangiLabel 和 J$.Fr（被 wrapFunBodyWithTryCatch 包裹的标志）');
        }
    });

    test('BUG7: script 级未捕获异常应向外传播（catch 块应 re-throw）', () => {
        const r = instr('throw new Error("test");');
        assert.ok(r.code.includes('throw J$e'), 'script-level catch 块应包含 re-throw 语句');
    });

    test('BUG8: 解构 var 声明不应错误地插入名称为 undefined 的写入钩子', () => {
        const r = instr('var { a, b } = obj; var [x, y] = arr;');
        assert.ok(
            !r.code.includes('J$.W(') || !r.code.match(/J\$\.W\(\s*\d+\s*,\s*undefined\s*/),
            '解构声明不应产生 J$.W(iid, undefined, ...) 形式的写入钩子'
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 防御代码（Guard）触发验证
// ════════════════════════════════════════════════════════════════════════════════

describe('防御代码（Guard）触发验证', () => {
    before(() => init({ ...ALL_CONFIG }));
    after(restoreConfig);

    test('Guard: instrumentCode() code 非字符串应抛出 TypeError', () => {
        assert.throws(
            () => instrumentCode({ code: 42, origCodeFileName: 't.js', instCodeFileName: 't_i.js' }),
            (e) => { assert.ok(e.message.includes('options.code must be a string')); return true; }
        );
    });

    test('Guard: instrumentCode() sourceType 非法值应抛出错误', () => {
        assert.throws(
            () => instrumentCode({ code: 'var x = 1;', origCodeFileName: 't.js', instCodeFileName: 't_i.js', sourceType: 'commonjs' }),
            (e) => { assert.ok(e.message.includes("sourceType must be 'script' or 'module'")); return true; }
        );
    });

    test('Guard: instrumentCode() options 为 null 应抛出 TypeError', () => {
        assert.throws(() => instrumentCode(null), TypeError);
    });

    test('Guard: 普通变量声明插桩正常，wrapWrite 不被 undefined name 触发', () => {
        const r = instr('var x = 1;');
        assert.ok(r.code.includes('J$.W('), '普通变量声明应插入写入钩子');
    });

    test('Guard: generator / async 函数插桩不应抛出错误', () => {
        assert.doesNotThrow(() => instr('function* g() { yield 1; }'),     'generator 函数插桩不应抛出错误');
        assert.doesNotThrow(() => instr('async function f() { await Promise.resolve(); }'), 'async 函数插桩不应抛出错误');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 自定义沙盒变量名（jalangiVar）
// ════════════════════════════════════════════════════════════════════════════════

describe('自定义沙盒变量名（jalangiVar）', () => {
    after(restoreConfig);

    test('使用自定义变量名 __myJ 时，IIFE 包装使用该名称', () => {
        init({ ...ALL_CONFIG }, null, null, '__myJ');
        const r = instrumentCode({ code: 'var x = 1 + 2;', origCodeFileName: 'custom.js', instCodeFileName: 'custom_i.js' });
        assert.ok(r.code.includes('__myJ'), '插桩输出应包含自定义变量名 __myJ');
        assert.ok(!r.code.includes('(function(J$)'), '不应包含旧变量名 J$ 的 IIFE 包装');
        assert.ok(r.code.includes('__myJ.'), '钩子调用应使用 __myJ. 前缀');
    });

    test('自定义变量名不影响 source map 生成', () => {
        init({ ...ALL_CONFIG }, null, null, '__myJ');
        const r = instrumentCode({ code: 'var a = 1;', origCodeFileName: 'smap.js', instCodeFileName: 'smap_i.js', inlineSourceMap: true });
        assert.ok(r.sourceMapObject && Object.keys(r.sourceMapObject).length > 0, '自定义变量名下 source map 应正常生成');
    });

    test('非法变量名（含空格）被忽略，回退到默认 J$', () => {
        init({ ...ALL_CONFIG }, null, null, 'bad name!');
        const r = instrumentCode({ code: 'var x = 1;', origCodeFileName: 'fallback.js', instCodeFileName: 'fallback_i.js' });
        assert.ok(r.code.includes('J$'), '非法变量名应回退到默认 J$');
    });

    test('默认（不传）仍使用 J$', () => {
        init({ ...ALL_CONFIG });
        const r = instrumentCode({ code: 'var x = 1;', origCodeFileName: 'default.js', instCodeFileName: 'default_i.js' });
        assert.ok(r.code.includes('J$'), '不传 jalangiVar 时应使用默认 J$');
    });

    test('随机前缀 __jal_ 格式插桩正确', () => {
        const varName = '__jal_abcdef';
        init({ ...ALL_CONFIG }, null, null, varName);
        const r = instrumentCode({ code: 'var x = 1 + 2;', origCodeFileName: 'random.js', instCodeFileName: 'random_i.js' });
        assert.ok(r.code.includes(varName),        `插桩输出应包含随机变量名 ${varName}`);
        assert.ok(r.code.includes(`${varName}.`),  `钩子调用应使用 ${varName}. 前缀`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 按需插桩（pluginAnalyzer + buildConfigFromHooks）
// ════════════════════════════════════════════════════════════════════════════════

describe('按需插桩（pluginAnalyzer）', () => {
    after(restoreConfig);

    describe('buildConfigFromHooks 基本映射', () => {
        test('只用 binary 时只开启 INSTR_BINARY', () => {
            const config = buildConfigFromHooks(new Set(['binary', 'binaryPre']));
            assert.equal(config.INSTR_BINARY, null,       'INSTR_BINARY 应为 null（开启）');
            assert.equal(typeof config.INSTR_READ, 'function', 'INSTR_READ 应为 () => false（禁用）');
            assert.equal(typeof config.INSTR_WRITE, 'function', 'INSTR_WRITE 应被禁用');
            assert.equal(typeof config.INSTR_GETFIELD, 'function', 'INSTR_GETFIELD 应被禁用');
            assert.equal(typeof config.INSTR_LITERAL, 'function', 'INSTR_LITERAL 应被禁用');
            assert.equal(config.ENABLE_SAMPLING, false,   'ENABLE_SAMPLING 应为 false');
        });

        test('只用 read 时只开启 INSTR_READ', () => {
            const config = buildConfigFromHooks(new Set(['read']));
            assert.equal(config.INSTR_READ, null,          'INSTR_READ 应为 null');
            assert.equal(typeof config.INSTR_WRITE, 'function', 'INSTR_WRITE 应被禁用');
            assert.equal(typeof config.INSTR_BINARY, 'function', 'INSTR_BINARY 应被禁用');
        });

        test('functionEnter 需要 INSTR_TRY_CATCH_ARGUMENTS', () => {
            const config = buildConfigFromHooks(new Set(['functionEnter', 'functionExit']));
            assert.equal(config.INSTR_TRY_CATCH_ARGUMENTS, null, 'functionEnter 需要 INSTR_TRY_CATCH_ARGUMENTS');
            assert.equal(typeof config.INSTR_READ, 'function', 'INSTR_READ 不需要，应被禁用');
        });

        test('declare 需要 INSTR_INIT + INSTR_TRY_CATCH_ARGUMENTS', () => {
            const config = buildConfigFromHooks(new Set(['declare']));
            assert.equal(config.INSTR_INIT, null,                  'declare 需要 INSTR_INIT');
            assert.equal(config.INSTR_TRY_CATCH_ARGUMENTS, null,   'declare 需要 INSTR_TRY_CATCH_ARGUMENTS');
        });

        test('invokeFunPre/invokeFun 需要 INSTR_INVOKE', () => {
            const config = buildConfigFromHooks(new Set(['invokeFunPre', 'invokeFun']));
            assert.equal(config.INSTR_INVOKE, null, 'invoke 钩子应开启 INSTR_INVOKE');
        });

        test('_return 需要 INSTR_RETURN', () => {
            const config = buildConfigFromHooks(new Set(['_return']));
            assert.equal(config.INSTR_RETURN, null,                'INSTR_RETURN 应被开启');
            assert.equal(typeof config.INSTR_THROW, 'function',   'INSTR_THROW 不需要，应被禁用');
        });

        test('_throw 需要 INSTR_THROW', () => {
            const config = buildConfigFromHooks(new Set(['_throw']));
            assert.equal(config.INSTR_THROW, null,                 'INSTR_THROW 应被开启');
            assert.equal(typeof config.INSTR_RETURN, 'function',  'INSTR_RETURN 不需要，应被禁用');
        });

        test('forinObject 需要 INSTR_FORIN', () => {
            const config = buildConfigFromHooks(new Set(['forinObject']));
            assert.equal(config.INSTR_FORIN, null, 'forinObject 钩子应开启 INSTR_FORIN');
        });

        test('endExecution/onReady 不映射任何 Config 字段', () => {
            const config = buildConfigFromHooks(new Set(['endExecution', 'onReady']));
            for (const [k, v] of Object.entries(config)) {
                if (k.startsWith('INSTR_')) assert.equal(typeof v, 'function', `${k} 应被禁用，得到 ${v}`);
            }
        });
    });

    describe('fullConfig', () => {
        test('返回所有字段均为 null 的全量 Config', () => {
            const config = fullConfig();
            for (const f of ['INSTR_READ','INSTR_WRITE','INSTR_GETFIELD','INSTR_PUTFIELD',
                'INSTR_BINARY','INSTR_UNARY','INSTR_LITERAL','INSTR_INIT',
                'INSTR_CONDITIONAL','INSTR_TRY_CATCH_ARGUMENTS','INSTR_END_EXPRESSION',
                'INSTR_INVOKE','INSTR_RETURN','INSTR_THROW','INSTR_FORIN']) {
                assert.equal(config[f], null, `fullConfig 的 ${f} 应为 null`);
            }
        });
    });

    describe('analyzePluginHooks 扫描', () => {
        test('从 CheckNaN.js 扫描出 binary + endExecution', () => {
            const pluginPath = join(__dirname, '../../src/plugins/dlint/CheckNaN.js');
            const hooks = analyzePluginHooks([pluginPath]);
            assert.ok(hooks.has('binary'),       'CheckNaN 应包含 binary');
            assert.ok(hooks.has('endExecution'), 'CheckNaN 应包含 endExecution');
            assert.ok(!hooks.has('read'),        'CheckNaN 不应包含 read');
        });

        test('从实例对象扫描（运行时反射）', () => {
            const instance = { binary() {}, endExecution() {} };
            const hooks = analyzePluginHooks([instance]);
            assert.ok(hooks.has('binary'),       '实例扫描应发现 binary');
            assert.ok(hooks.has('endExecution'), '实例扫描应发现 endExecution');
            assert.ok(!hooks.has('read'),        '实例扫描不应发现 read');
        });

        test('静态 usedHooks 声明优先', () => {
            class MyPlugin { static usedHooks = ['invokeFunPre', 'invokeFun']; }
            const hooks = analyzePluginHooks([new MyPlugin()]);
            assert.ok(hooks.has('invokeFunPre'), 'usedHooks 声明的 invokeFunPre 应被识别');
            assert.ok(hooks.has('invokeFun'),    'usedHooks 声明的 invokeFun 应被识别');
        });
    });

    describe('buildConfigFromPlugins 端到端流程', () => {
        test('CheckNaN.js → 只开启 INSTR_BINARY', () => {
            const pluginPath = join(__dirname, '../../src/plugins/dlint/CheckNaN.js');
            const config = buildConfigFromPlugins([pluginPath]);
            assert.equal(config.INSTR_BINARY, null,               'CheckNaN 只需 INSTR_BINARY');
            assert.equal(typeof config.INSTR_READ, 'function',    'INSTR_READ 应被禁用');
            assert.equal(typeof config.INSTR_WRITE, 'function',   'INSTR_WRITE 应被禁用');
            assert.equal(typeof config.INSTR_GETFIELD, 'function','INSTR_GETFIELD 应被禁用');
        });

        test('空数组返回全量 Config', () => {
            const config = buildConfigFromPlugins([]);
            assert.equal(config.INSTR_BINARY, null, '空数组应返回全量 Config');
            assert.equal(config.INSTR_READ,   null, '空数组应返回全量 Config');
        });
    });

    describe('按需 Config 实际影响插桩输出', () => {
        test('只开 INSTR_BINARY 时，输出不含 J$.R（read 钩子）', () => {
            init(buildConfigFromHooks(new Set(['binary', 'binaryPre'])));
            const r = instrumentCode({ code: 'var x = 1 + 2; var y = x;', origCodeFileName: 'on-demand.js', instCodeFileName: 'on-demand_i.js' });
            assert.ok(r.code.includes('J$.B(') || r.code.includes('J$.Bp('), '二元运算应被插桩');
            assert.ok(!r.code.includes('J$.R('), '变量读取不应被插桩');
            assert.ok(!r.code.includes('J$.T('), '字面量不应被插桩');
        });

        test('只开 INSTR_READ 时，输出不含 J$.B（binary 钩子）', () => {
            init(buildConfigFromHooks(new Set(['read'])));
            const r = instrumentCode({ code: 'var x = 1 + 2; var y = x;', origCodeFileName: 'on-demand2.js', instCodeFileName: 'on-demand2_i.js' });
            assert.ok(r.code.includes('J$.R('),  '变量读取应被插桩');
            assert.ok(!r.code.includes('J$.B('), '二元运算不应被插桩');
        });

        test('关闭 INSTR_INVOKE 时，函数调用不注入 J$.F/J$.M', () => {
            init(buildConfigFromHooks(new Set(['read'])));
            const r = instrumentCode({ code: 'function foo() {} foo(); var obj = { bar: function(){} }; obj.bar();', origCodeFileName: 'invoke-off.js', instCodeFileName: 'invoke-off_i.js' });
            assert.ok(!r.code.includes('J$.F('), '关闭 INSTR_INVOKE 时 J$.F 不应出现');
            assert.ok(!r.code.includes('J$.M('), '关闭 INSTR_INVOKE 时 J$.M 不应出现');
        });

        test('关闭 INSTR_RETURN 时，return 语句不注入 J$.Rt', () => {
            init(buildConfigFromHooks(new Set(['binary'])));
            const r = instrumentCode({ code: 'function foo(x) { return x + 1; }', origCodeFileName: 'return-off.js', instCodeFileName: 'return-off_i.js' });
            assert.ok(!r.code.includes('J$.Rt('), '关闭 INSTR_RETURN 时 J$.Rt 不应出现');
        });

        test('关闭 INSTR_FORIN 时，for-in 不注入 J$.H/J$.I', () => {
            init(buildConfigFromHooks(new Set(['binary'])));
            const r = instrumentCode({ code: 'for (var k in obj) { console.log(k); }', origCodeFileName: 'forin-off.js', instCodeFileName: 'forin-off_i.js' });
            assert.ok(!r.code.includes('J$.H('), '关闭 INSTR_FORIN 时 J$.H 不应出现');
        });

        test('init() 传 plugins 参数自动推导 Config', () => {
            const pluginInst = { binary() {}, endExecution() {} };
            init(null, null, null, 'J$', [pluginInst]);
            const r = instrumentCode({ code: 'var x = 1 + 2;', origCodeFileName: 'auto-config.js', instCodeFileName: 'auto-config_i.js' });
            assert.ok(r.code.includes('J$.B(') || r.code.includes('J$.Bp('), 'plugins 推导后 binary 应被插桩');
            assert.ok(!r.code.includes('J$.R('), 'plugins 推导后 read 不应被插桩');
        });
    });
});
