import { init, instrumentCode } from '../src/instrument/esnstrument.js';
init({ INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_END_EXPRESSION: null, INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_AWAIT: null, ENABLE_SAMPLING: false });
const r = instrumentCode({ code: 'async function fetchData() { var data = await fetch("/api"); return data.json(); }',
    origCodeFileName: 'test.js', instCodeFileName: 'test_inst.js', inlineSourceMap: false });
console.log('Has J$.Fe:', r.code.includes('J$.Fe('));
console.log('Has J$.Fr:', r.code.includes('J$.Fr('));
console.log('Has J$.Aw:', r.code.includes('J$.Aw('));
console.log(r.code);
