import { init, instrumentCode } from '../src/instrument/esnstrument.js';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_END_EXPRESSION: null, INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    ENABLE_SAMPLING: false,
};
init(ALL_CONFIG);

const result = instrumentCode({
    code: `function makeAdder(x) { return function(y) { return x + y; }; }`,
    origCodeFileName: 'debug-closure.js',
    instCodeFileName: 'debug-closure_inst.js',
    inlineSourceMap: false,
});

// 格式化打印（不折行）
console.log(result.code);
