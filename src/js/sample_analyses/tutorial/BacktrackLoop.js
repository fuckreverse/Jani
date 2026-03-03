// JALANGI DO NOT INSTRUMENT

/**
 * @file BacktrackLoop —— 演示 isBacktrack 机制：函数返回值为真时重新执行函数体。
 * @author Koushik Sen
 */

export class BacktrackLoopAnalysis {
    functionExit(iid, returnVal, wrappedExceptionVal) {
        return {
            returnVal,
            wrappedExceptionVal,
            isBacktrack: !!returnVal,
        };
    }
}

if (typeof J$ !== 'undefined') {
    J$.analysis = new BacktrackLoopAnalysis();
}
