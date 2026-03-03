// JALANGI DO NOT INSTRUMENT

/**
 * @file mocha_prefix —— 在 mocha 测试框架中记录覆盖率的前缀钩子。
 *
 * 使用方式：在顶层 mocha 测试文件最前面引入此文件内容
 * （作为字符串拼接或 require），以便在每个测试用例前后
 * 调用 J$.analysis.beginExecution / endExecution。
 *
 * 注意：本文件不是 ES 模块，因为它需要在测试环境中直接执行。
 */

/* global beforeEach, afterEach */
beforeEach(function () {
    J$.analysis.beginExecution();
});

afterEach(function () {
    J$.analysis.endExecution();
});
