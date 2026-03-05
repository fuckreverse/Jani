// 调试脚本：详细追踪 Shadow Frame 写入和读取流程
import { init, instrumentCode } from '../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../src/runtime/JalangiSandbox.js';
import { JalangiRuntime }       from '../src/runtime/JalangiRuntime.js';
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
`;

const { code } = instrumentCode({
    code: src,
    origCodeFileName: 'closure-test.js',
    instCodeFileName: 'closure-test_inst.js',
    inlineSourceMap: true,
});

// 创建一个拦截 W 和 Rl 调用的代理沙盒
class DebugSandbox extends JalangiSandbox {
    W(iid, name, val, lhs, flags, defScopeId) {
        const result = super.W(iid, name, val, lhs, flags, defScopeId);
        if (name === 'count') {
            console.log(`W(iid=${iid}, name="${name}", val=${val}, flags=${flags}, defScopeId=${defScopeId}) => shadowSet to callId=${this.currentCallIdForDebug}`);
        }
        return result;
    }
    Rl(iid, defScopeId, name) {
        if (name === 'count') {
            const resolvedCallId = this.resolveCallIdForDebug(defScopeId);
            console.log(`Rl(iid=${iid}, defScopeId=${defScopeId}, name="${name}") resolvedCallId=${resolvedCallId}, currentCallId=${this.currentCallIdForDebug}`);
        }
        return super.Rl(iid, defScopeId, name);
    }
    Fe(iid, f, dis, args, defScopeId) {
        console.log(`Fe: entering function defScopeId=${defScopeId}, currentCallId before=${this.currentCallIdForDebug}`);
        return super.Fe(iid, f, dis, args, defScopeId);
    }
    Fr(iid) {
        console.log(`Fr: exiting function, currentCallId=${this.currentCallIdForDebug}`);
        return super.Fr(iid);
    }
}

// 由于私有字段无法从外部访问，我们通过 getShadowStats 观察
const J$ = new JalangiSandbox({ debugShadow: true });

// 注入一个全面跟踪的分析插件
J$.analysis.use({
    write(iid, name, val) {
        if (name === 'count') {
            console.log(`  [write hook] name=${name}, val=${val}`);
        }
    },
    read(iid, name, val) {
        if (name === 'count') {
            console.log(`  [read hook] name=${name}, val=${val}`);
        }
    },
    functionEnter(iid, f) {
        console.log(`  [functionEnter] iid=${iid}`);
    },
    functionExit(iid) {
        console.log(`  [functionExit] iid=${iid}`);
    },
});

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
    
    const stats = J$.getShadowStats();
    console.log('\n=== Shadow Frame 统计 ===');
    console.log('missCount:', stats.missCount);
    console.log('missLog:', JSON.stringify(stats.missLog, null, 2));
} catch (e) {
    console.error('执行错误:', e.message);
    console.error(e.stack);
}
