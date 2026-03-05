// 调试：嵌套两层闭包 + IIFE 闭包场景
import { init, instrumentCode } from '../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../src/runtime/JalangiSandbox.js';
import vm from 'vm';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_END_EXPRESSION: null, INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_AWAIT: null, ENABLE_SAMPLING: false,
};

async function runTest(name, src) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`测试：${name}`);
    console.log('='.repeat(60));

    init({ ...ALL_CONFIG });
    const { code } = instrumentCode({
        code: src,
        origCodeFileName: 'test.js',
        instCodeFileName: 'test_inst.js',
        inlineSourceMap: true,
    });

    const J$ = new JalangiSandbox({ debugShadow: true });
    const $out = {};
    const sandbox = vm.createContext({
        J$, console, Error, TypeError, Math, JSON, Date,
        Object, Array, Function, String, Number, Boolean,
        parseInt, parseFloat, isNaN, NaN, Infinity, undefined,
        $out,
    });

    try {
        vm.runInContext(code, sandbox, { timeout: 5000 });
        console.log('结果：', JSON.stringify($out));
        const stats = J$.getShadowStats();
        if (stats.missCount > 0) {
            console.log('Shadow MISS:', stats.missLog);
        } else {
            console.log('Shadow MISS: 0');
        }
    } catch (e) {
        console.error('错误:', e.message);
    }
}

await runTest('嵌套两层闭包', `
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

await runTest('IIFE 闭包捕获', `
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
