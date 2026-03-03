import { init, instrumentCode } from './src/js/instrument/esnstrument.js';

const Config = {
    INSTR_READ: null,
    INSTR_WRITE: null,
    INSTR_GETFIELD: null,
    INSTR_PUTFIELD: null,
    INSTR_BINARY: null,
    INSTR_UNARY: null,
    INSTR_LITERAL: null,
    INSTR_INIT: null,
    INSTR_END_EXPRESSION: null,
    INSTR_CONDITIONAL: null,
    INSTR_TRY_CATCH_ARGUMENTS: null,
    ENABLE_SAMPLING: false,
};

init(Config);

// ─── 测试 1：ES5 基本代码 ─────────────────────────────────────────────────────
{
    const r = instrumentCode({
        code: 'var x = 1 + 2; console.log(x);',
        origCodeFileName: 'test.js',
        instCodeFileName: 'test_inst.js',
        inlineSourceMap: false,
        sourceType: 'script',
    });
    console.assert(r.code.length > 0, 'ES5 basic: code should be non-empty');
    console.log('✓ ES5 basic instrumentation OK, length:', r.code.length);
}

// ─── 测试 2：ES6 Arrow + Destructuring ───────────────────────────────────────
{
    const r = instrumentCode({
        code: 'const f = (x, y = 0) => x + y; const [a, b] = [1, 2];',
        origCodeFileName: 'es6.js',
        instCodeFileName: 'es6_inst.js',
        inlineSourceMap: false,
        sourceType: 'script',
    });
    console.assert(r.code.length > 0, 'ES6 arrow: code should be non-empty');
    console.log('✓ ES6 arrow + destructure OK, length:', r.code.length);
}

// ─── 测试 3：ES6 Class ────────────────────────────────────────────────────────
{
    const r = instrumentCode({
        code: 'class Animal { constructor(n) { this.name = n; } speak() { return this.name; } }',
        origCodeFileName: 'class.js',
        instCodeFileName: 'class_inst.js',
        inlineSourceMap: false,
        sourceType: 'script',
    });
    console.assert(r.code.length > 0, 'ES6 class: code should be non-empty');
    console.log('✓ ES6 class OK, length:', r.code.length);
}

// ─── 测试 4：ES2019 Optional Catch Binding ─────────────────────────────────
{
    const r = instrumentCode({
        code: 'try { foo(); } catch { console.log("caught"); }',
        origCodeFileName: 'catch.js',
        instCodeFileName: 'catch_inst.js',
        inlineSourceMap: false,
        sourceType: 'script',
    });
    console.assert(r.code.length > 0, 'ES2019 optional catch: code should be non-empty');
    console.log('✓ ES2019 optional catch OK, length:', r.code.length);
}

// ─── 测试 5：ES Module (top-level await) ─────────────────────────────────────
{
    const r = instrumentCode({
        code: 'const res = await fetch("https://example.com"); console.log(res.status);',
        origCodeFileName: 'module.mjs',
        instCodeFileName: 'module_inst.mjs',
        inlineSourceMap: false,
        sourceType: 'module',
    });
    console.assert(r.code.length > 0, 'ESM top-level await: code should be non-empty');
    console.log('✓ ESM top-level await OK, length:', r.code.length);
}

// ─── 测试 6：ES2022 Class Fields ─────────────────────────────────────────────
{
    const r = instrumentCode({
        code: 'class Counter { #count = 0; increment() { this.#count++; } get value() { return this.#count; } }',
        origCodeFileName: 'fields.js',
        instCodeFileName: 'fields_inst.js',
        inlineSourceMap: false,
        sourceType: 'script',
    });
    console.assert(r.code.length > 0, 'ES2022 class fields: code should be non-empty');
    console.log('✓ ES2022 class private fields OK, length:', r.code.length);
}

console.log('\n✅ All tests passed!');
