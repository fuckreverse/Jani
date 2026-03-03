// JALANGI DO NOT INSTRUMENT

/**
 * @file ChainedAnalysesNoCheck —— 旧式链式分析容器（无运行时检查）。
 *
 * @deprecated 此文件已废弃。请直接使用 AnalysisHost：
 *
 *   import { AnalysisHost } from '../runtime/AnalysisHost.js';
 *   const host = new AnalysisHost();
 *   sandbox.analysis = host;
 *
 * 旧式 ChainedAnalysesNoCheck 不再有任何实际意义：
 *  - 它与 ChainedAnalyses 的唯一区别是"不检查方法存在性"，
 *    而 AnalysisHost 本身就跳过未实现的钩子，因此与 NoCheck 语义完全相同。
 *  - 原先使用 arguments.callee 的模式已移除（严格模式不允许）。
 *
 * 本文件仅作别名保留，以免旧代码导入时报错。
 */

export { AnalysisHost as ChainedAnalysesNoCheck } from '../runtime/AnalysisHost.js';
