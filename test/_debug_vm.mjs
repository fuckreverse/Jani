/**
 * 调试闭包问题
 */
import vm from 'vm';
import { init, instrumentCode } from '../src/instrument/esnstrument.js';
import { JalangiSandbox } from '../src/runtime/JalangiSandbox.js';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null,
    INSTR_PUTFIELD: null, INSTR_BINARY: null, INSTR_UNARY: null,
    INSTR_LITERAL: null, INSTR_INIT: null, INSTR_END_EXPRESSION: null,
    INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null, ENABLE_SAMPLING: false,
};

init(ALL_CONFIG);
const src = `
function makeCounter() {
    var count = 0;
    return function() { count += 1; return count; };
}
var counter = makeCounter();
var a = counter();
$out.a = a;
`;
const { code } = instrumentCode({
    code: src,
    origCodeFileName: 't.js', instCodeFileName: 't_i.js', inlineSourceMap: true,
});

console.log('=== instrumented closure code (truncated) ===');
// 只显示关键部分
const codeLines = code.split('\n');
for (let i = 0; i < codeLines.length; i++) {
    console.log(`${i+1}: ${codeLines[i]}`);
}

const J$inst = new JalangiSandbox();
J$inst.analysis.use({
    write(iid, name, val, lhs) {
        console.log(`WRITE[${iid}] ${name} = ${JSON.stringify(val)}`);
    },
    read(iid, name, val) {
        console.log(`READ[${iid}] ${name} = ${JSON.stringify(val)}`);
    },
    binary(iid, op, l, r, result) {
        console.log(`BINARY[${iid}] ${JSON.stringify(l)} ${op} ${JSON.stringify(r)} = ${JSON.stringify(result)}`);
    },
    functionEnter(iid, f, dis, args) {
        console.log(`FE[${iid}] f.name=${f?.name || '(anon)'}`);
    },
    declare(iid, name, val, isArgument) {
        console.log(`DECLARE[${iid}] ${name} = ${JSON.stringify(val)} isArg=${isArgument}`);
    },
});

const $out = {};
const sandbox = vm.createContext({
    J$: J$inst, $out, console,
    Error, Math, Object, Array, Function, String, Number, Boolean,
    parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
});
try {
    vm.runInContext(code, sandbox, { timeout: 2000 });
    console.log('\n$out.a =', $out.a, '(expected 1)');
} catch(e) {
    console.error('ERROR:', e.message);
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
}
