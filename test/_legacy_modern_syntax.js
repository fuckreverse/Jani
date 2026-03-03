// 测试现代语法的插桩支持
global.acorn = require('acorn');
global.astring = require('astring');
require('./src/js/Constants.js');
require('./src/js/Config.js');
require('./src/js/instrument/astUtil.js');
require('./src/js/instrument/iid.js');
require('./src/js/instrument/scope.js');
require('./src/js/instrument/wrappers.js');
require('./src/js/instrument/esnstrument.js');

function instrument(label, code) {
    try {
        var result = J$.instrumentCode({
            code: code,
            isEval: false,
            origCodeFileName: label + '.js',
            instCodeFileName: label + '_inst.js',
            inlineSourceMap: false,
            inlineSource: false
        });
        console.log('[PASS]', label, '- instrumented', result.code.length, 'chars');
    } catch (e) {
        console.log('[FAIL]', label, '-', e.message);
    }
}

// ES5
instrument('es5', 'var x = 1; function foo(a) { return a + 1; }');

// ES6
instrument('es6_arrow', 'var add = (a, b) => a + b;');
instrument('es6_class', 'class Animal { constructor(name) { this.name = name; } speak() { return this.name; } }');
instrument('es6_destructure', 'var {a, b} = obj; var [x, y] = arr;');
instrument('es6_template', 'var s = `hello ${name}`;');
instrument('es6_spread', 'function f(...args) { return args; }');
instrument('es6_default_param', 'function f(x = 10) { return x; }');
instrument('es6_promise', 'var p = new Promise((resolve, reject) => { resolve(42); });');

// ES2017
instrument('es2017_async', 'async function fetchData() { var data = await fetch("/api"); return data.json(); }');

// ES2019
instrument('es2019_optional_catch', 'try { foo(); } catch { console.log("error"); }');

// ES2020
instrument('es2020_optional_chain', 'var x = obj?.foo?.bar;');
instrument('es2020_nullish', 'var x = a ?? b;');
instrument('es2020_bigint', 'var n = 9007199254740991n;');

// ES2022
instrument('es2022_class_fields', 'class Counter { #count = 0; increment() { this.#count++; } get value() { return this.#count; } }');

// 顶层 await 必须在 module 模式下解析
function instrumentModule(label, code) {
    try {
        var result = J$.instrumentCode({
            code: code,
            isEval: false,
            origCodeFileName: label + '.js',
            instCodeFileName: label + '_inst.js',
            inlineSourceMap: false,
            inlineSource: false,
            sourceType: 'module'
        });
        console.log('[PASS]', label, '- instrumented', result.code.length, 'chars');
    } catch (e) {
        console.log('[FAIL]', label, '-', e.message);
    }
}
instrumentModule('es2022_top_await', 'var data = await fetch("/api");');
instrumentModule('es_module_import', 'import { foo } from "./foo.js"; export const bar = foo();');

console.log('\nacorn version:', require('acorn').version);
