// JALANGI DO NOT INSTRUMENT

/**
 * @file CheckUndefinedConcatenatedToString —— 检测 undefined 与字符串拼接。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/plugins/pldi16/CheckUndefinedConcatenatedToString.js \
 *     tests/pldi16/CheckUndefinedConcatenatedToStringTest.js
 */

export class CheckUndefinedConcatenatedToStringAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._logs    = [];
    }

    binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed) {
        if (op === '+' && typeof result === 'string' && (left === undefined || right === undefined)) {
            this._logs.push(this._sandbox.getGlobalIID(iid));
        }
    }

    endExecution() {
        const { log, iidToLocation } = this._sandbox;
        for (const giid of this._logs) {
            log(`Concatenated undefined with string at ${iidToLocation(giid)}`);
        }
    }
}
