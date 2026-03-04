import { init, instrumentCode } from '../src/instrument/esnstrument.js';
import { JalangiSandbox } from '../src/runtime/JalangiSandbox.js';
import vm from 'vm';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_END_EXPRESSION: null, INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    ENABLE_SAMPLING: false,
};
init(ALL_CONFIG);

// 场景 6：工厂多实例
const code6 = instrumentCode({
    code: `
        function makeAdder(x) { return function(y) { return x + y; }; }
        var fns = [];
        for (var i = 0; i < 3; i++) { fns.push(makeAdder(i * 10)); }
        $out.r0 = fns[0](1);
        $out.r1 = fns[1](1);
        $out.r2 = fns[2](1);
    `,
    origCodeFileName: 'debug-closure.js',
    instCodeFileName: 'debug-closure_inst.js',
    inlineSourceMap: true,
}).code;

const J$inst = new JalangiSandbox({ debugShadow: true });
const $out = {};
const sandbox = vm.createContext({ J$: J$inst, console, $out, Error, Math, Object, Array, Function, String, Number, Boolean, parseInt, isNaN, undefined, NaN });
try {
    vm.runInContext(code6, sandbox, { timeout: 3000 });
    console.log('out:', $out);
    const stats = J$inst.getShadowStats();
    console.log('miss count:', stats.missCount);
    if (stats.missLog.length > 0) {
        console.log('miss log:', JSON.stringify(stats.missLog.slice(0, 5)));
    }
} catch (e) {
    console.error('ERROR:', e.message);
}
