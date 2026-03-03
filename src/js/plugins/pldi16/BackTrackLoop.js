// JALANGI DO NOT INSTRUMENT

/**
 * @file BackTrackLoop —— 演示 isBacktrack 机制：函数返回值为真时重新执行函数体。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/plugins/pldi16/BackTrackLoop.js \
 *     tests/pldi16/BackTrackLoopTest.js
 */

export class BackTrackLoopAnalysis {
    functionExit(iid, returnVal, wrappedExceptionVal) {
        return {
            returnVal,
            wrappedExceptionVal,
            isBacktrack: !!returnVal,
        };
    }
}
