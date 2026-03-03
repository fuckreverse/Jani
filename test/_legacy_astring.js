var {generate} = require('astring');
var acorn = require('acorn');
var tests = [
    ['es5',           'var x = 1; function foo(a) { return a + 1; }'],
    ['arrow',         'var add = (a, b) => a + b;'],
    ['class',         'class Animal { constructor(name) { this.name = name; } speak() { return this.name; } }'],
    ['destructure',   'var {a, b} = obj; var [x, y] = arr;'],
    ['template',      'var s = `hello ${name}`;'],
    ['rest',          'function f(...args) { return args; }'],
    ['default_param', 'function f(x = 10) { return x; }'],
    ['async_await',   'async function fetchData() { var data = await fetch("/api"); return data.json(); }'],
    ['optional_catch','try { foo(); } catch { console.log("err"); }'],
    ['optional_chain','var x = obj?.foo?.bar;'],
    ['nullish',       'var x = a ?? b;'],
    ['bigint',        'var n = 9007199254740991n;'],
    ['class_private', 'class Counter { #count = 0; increment() { this.#count++; } get value() { return this.#count; } }'],
    ['logical_assign','a ||= b; a &&= c; a ??= d;'],
];
tests.forEach(function(pair) {
    var label = pair[0], code = pair[1];
    try {
        var ast = acorn.parse(code, {ecmaVersion: 'latest', locations: true});
        var out = generate(ast);
        console.log('[OK]', label, '(' + out.length + ' chars)');
    } catch(e) {
        console.log('[FAIL]', label, '-', e.message);
    }
});
