// JALANGI DO NOT INSTRUMENT

/**
 * @file ChainedAnalyses —— 多分析插件链式执行。
 *
 * 本文件是 AnalysisHost 的封装，保留旧式 addAnalysis() API。
 * 新代码应直接使用 AnalysisHost：
 *
 *   import { AnalysisHost } from '../runtime/AnalysisHost.js';
 *   const host = new AnalysisHost();
 *   host.use(new Analysis1()).use(new Analysis2());
 *   sandbox.analysis = host;
 *
 */

import { AnalysisHost } from '../runtime/AnalysisHost.js';

/**
 * 链式分析容器，内部委托给 AnalysisHost。
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
