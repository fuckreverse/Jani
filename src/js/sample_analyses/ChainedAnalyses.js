// JALANGI DO NOT INSTRUMENT

/**
 * @file ChainedAnalyses —— 多分析插件链式执行（向后兼容包装）。
 *
 * 本文件是 AnalysisHost 的向后兼容包装，保留旧式 addAnalysis() API。
 * 新代码应直接使用 AnalysisHost：
 *
 *   import { AnalysisHost } from '../runtime/AnalysisHost.js';
 *   const host = new AnalysisHost();
 *   host.use(new Analysis1()).use(new Analysis2());
 *   sandbox.analysis = host;
 *
 * @deprecated 请迁移到 AnalysisHost
 */

import { AnalysisHost } from '../runtime/AnalysisHost.js';

/**
 * 向后兼容的链式分析容器。
 * 内部直接委托给 AnalysisHost。
 *
 * @example
 * sandbox.analysis = new ChainedAnalyses();
 * sandbox.analysis.addAnalysis(new Analysis1());
 * sandbox.analysis.addAnalysis(new Analysis2());
 */
export class ChainedAnalyses extends AnalysisHost {
    /**
     * 注册一个分析插件（addAnalysis 是 AnalysisHost.use 的别名）。
     * @param {object} analysis - 分析插件实例
     * @returns {this}
     */
    addAnalysis(analysis) {
        return this.use(analysis);
    }
}

// 向后兼容：当本文件在旧式全局环境中加载时，自动安装到 J$
if (typeof J$ !== 'undefined' && !J$.analysis) {
    J$.analysis = new ChainedAnalyses();
}
