// 调试脚本：测试简单闭包场景
import { init, instrumentCode } from '../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../src/runtime/JalangiSandbox.js';
import vm from 'vm';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_END_EXPRESSION: null, INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_AWAIT: null, ENABLE_SAMPLING: false,
};

init({ ...ALL_CONFIG });

const src = `
function makeCounter() {
    var count = 0;
    return function() {
        count = count + 1;
        return count;
    };
}
var counter = makeCounter();
$out.r1 = counter();
$out.r2 = counter();
$out.r3 = counter();
`;

const { code } = instrumentCode({
    code: src,
    origCodeFileName: 'closure-test.js',
    instCodeFileName: 'closure-test_inst.js',
    inlineSourceMap: true,
});

console.log('=== 插桩后代码（前100行）===');
const lines = code.split('\n');
lines.slice(0, 100).forEach((l, i) => console.log(`${i+1}|${l}`));

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
    console.log('\n=== 结果 ===');
    console.log('$out.r1:', $out.r1, '(expected: 1)');
    console.log('$out.r2:', $out.r2, '(expected: 2)');
    console.log('$out.r3:', $out.r3, '(expected: 3)');
    
    const stats = J$.getShadowStats();
    console.log('\n=== Shadow Frame 统计 ===');
    console.log('missCount:', stats.missCount);
    console.log('frameCount:', stats.frameCount);
} catch (e) {
    console.error('执行错误:', e.message);
    console.error(e.stack);
}
