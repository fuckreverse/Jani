// 调试脚本：检查两次 async 调用的 contextId 是否独立
import { init, instrumentCode } from '../src/instrument/esnstrument.js';
import { JalangiSandbox } from '../src/runtime/JalangiSandbox.js';
import vm from 'vm';

const ALL_CONFIG = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null,
    INSTR_PUTFIELD: null, INSTR_BINARY: null, INSTR_UNARY: null,
    INSTR_LITERAL: null, INSTR_INIT: null, INSTR_END_EXPRESSION: null,
    INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_AWAIT: null, ENABLE_SAMPLING: false,
};
init(ALL_CONFIG);
const { code } = instrumentCode({
    code: `
        async function work(n) {
            return await Promise.resolve(n);
        }
        $out.p1 = work(1);
        $out.p2 = work(2);
    `,
    origCodeFileName: 'debug.js',
    instCodeFileName: 'debug_inst.js',
    inlineSourceMap: true,
});

// 打印插桩后的代码，看 Aw 的调用形式
const awIdx = code.indexOf('J$.Aw(');
console.log('Aw context:', code.slice(Math.max(0, awIdx - 50), awIdx + 80));

const J$inst = new JalangiSandbox();
const events = [];
J$inst.analysis.use({
    functionEnter(iid, f, dis, args) {
        if (f && f.name === 'work') {
            console.log('functionEnter work, currentCallId:', J$inst.currentCallId);
        }
    },
    awaitResume(iid, contextId, val) {
        console.log('awaitResume, contextId:', contextId, ', val:', val, ', currentCallId:', J$inst.currentCallId);
        events.push({ contextId, val });
    }
});
const $out = {};
const sandbox = vm.createContext({ J$: J$inst, Promise, $out });
vm.runInContext(code, sandbox);
await Promise.all([$out.p1, $out.p2]);
console.log('\nAll events:', events);
console.log('contextId 0 === contextId 1?', events[0]?.contextId === events[1]?.contextId);
