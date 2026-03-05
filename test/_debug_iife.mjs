// 调试 IIFE 场景
import { init, instrumentCode } from '../src/instrument/esnstrument.js';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_END_EXPRESSION: null, INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_AWAIT: null, ENABLE_SAMPLING: false,
};

init({ ...ALL_CONFIG });

const src = `
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
`;

const { code } = instrumentCode({
    code: src,
    origCodeFileName: 'test.js',
    instCodeFileName: 'test_inst.js',
    inlineSourceMap: true,
});

const lines = code.split('\n');
lines.forEach((l, i) => console.log(`${i+1}|${l}`));
