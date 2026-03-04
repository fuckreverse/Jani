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

let depth = 0;
function indent() { return '  '.repeat(depth); }

const code = instrumentCode({
    code: `
        function makeAdder(x) { return function(y) { return x + y; }; }
        var f1 = makeAdder(10);
        var f2 = makeAdder(20);
        $out.r1 = f1(1);
        $out.r2 = f2(1);
    `,
    origCodeFileName: 'debug-simple.js',
    instCodeFileName: 'debug-simple_inst.js',
    inlineSourceMap: true,
}).code;

class DebugRuntime extends JalangiSandbox {
    N(iid, name, val, flags) {
        const result = super.N(iid, name, val, flags);
        if (name === 'x' || name === 'y') {
            console.log(`${indent()}N(name=${name}, val=${val}, callId=${this.currentCallId})`);
        }
        return result;
    }
    T(iid, val, type, hasGetterSetter, internalIid) {
        const result = super.T(iid, val, type, hasGetterSetter, internalIid);
        if (typeof val === 'function') {
            console.log(`${indent()}T(func) callId=${this.currentCallId}`);
        }
        return result;
    }
    Rl(iid, defScopeId, name) {
        if (name === 'x') {
            const result = super.Rl(iid, defScopeId, name);
            console.log(`${indent()}Rl(scopeId=${defScopeId}, name='${name}') → ${result}, callId=${this.currentCallId}`);
            return result;
        }
        return super.Rl(iid, defScopeId, name);
    }
    Fe(iid, f, dis, args, defScopeId) {
        depth++;
        console.log(`${indent()}Fe(scopeId=${defScopeId}, prevCallId=${this.currentCallId})`);
        super.Fe(iid, f, dis, args, defScopeId);
    }
    Fr(iid) {
        console.log(`${indent()}Fr(callId=${this.currentCallId})`);
        const r = super.Fr(iid);
        depth--;
        return r;
    }
}

const J$inst = new DebugRuntime();
const $out = {};
const sandbox = vm.createContext({ J$: J$inst, console, $out, Error, Math, Object, Array, Function, String, Number, Boolean, parseInt, isNaN, undefined, NaN });
try {
    vm.runInContext(code, sandbox, { timeout: 3000 });
    console.log('\nout:', $out);
} catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
}
