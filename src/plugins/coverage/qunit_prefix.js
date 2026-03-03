// JALANGI DO NOT INSTRUMENT

/**
 * @file qunit_prefix —— 在 QUnit 测试框架中记录覆盖率的前缀钩子。
 */

/* global QUnit */
if (typeof QUnit !== 'undefined') {
    QUnit.testStart(function (details) {
        J$.analysis.beginExecution();
    });

    QUnit.testDone(function (details) {
        J$.analysis.endExecution();
    });
}
