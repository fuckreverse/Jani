// JALANGI DO NOT INSTRUMENT

/**
 * @file ChangeSematicsOfMult —— 将乘法运算替换为加法（演示 skip + result 机制）。
 * @author Koushik Sen
 *
 * 运行示例：
 *   node src/js/commands/jalangi.js --inlineIID --inlineSource \
 *     --analysis src/js/plugins/pldi16/ChangeSematicsOfMult.js \
 *     tests/pldi16/ChangeSematicsOfMultTest.js
 */

export class ChangeSematicsOfMultAnalysis {
    binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed) {
        if (op === '*') {
            return { op, left, right, skip: true };
        }
    }

    binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed) {
        if (op === '*') {
            return { result: left + right };
        }
    }
}
