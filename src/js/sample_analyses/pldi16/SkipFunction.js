// JALANGI DO NOT INSTRUMENT

/**
 * @file SkipFunction —— 演示 skip 机制：跳过对特定函数的调用。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/sample_analyses/pldi16/SkipFunction.js \
 *     tests/pldi16/SkipFunctionTest.js
 */

export class SkipFunctionAnalysis {
    invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid) {
        // 如果全局定义了 evilFunction 且当前调用的是它，则跳过执行
        if (typeof evilFunction === 'function' && f === evilFunction) {
            return { f, base, args, skip: true };
        }
        return { f, base, args, skip: false };
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new SkipFunctionAnalysis();
}
