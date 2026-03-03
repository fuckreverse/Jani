// JALANGI DO NOT INSTRUMENT

/**
 * AnalysisHost —— Jalangi2 运行时分析调度框架。
 *
 * 职责：
 *  1. 维护一个有序的分析插件列表
 *  2. 将每个运行时钩子（read / write / getField …）以"链式调用"的方式
 *     依次分发给所有已注册的插件
 *
 * 标准用法：
 *
 *   import { AnalysisHost } from './AnalysisHost.js';
 *   import { SMemoryPlugin, SMemory } from './SMemory.js';
 *   import { LogAllAnalysis } from '../sample_analyses/tutorial/LogAll.js';
 *
 *   const smemory = new SMemory();
 *   J$.analysis = new AnalysisHost()
 *       .use(new SMemoryPlugin(smemory))
 *       .use(new LogAllAnalysis(smemory));
 */

/** 所有可能的钩子名称（与 analysis.js 运行时保持一致）。 */
const HOOKS = Object.freeze([
    '_return', '_throw', '_with',
    'binaryPre', 'binary', 'conditional',
    'declare', 'endExecution', 'endExpression',
    'forinObject', 'functionEnter', 'functionExit',
    'getFieldPre', 'getField', 'instrumentCodePre',
    'instrumentCode', 'invokeFunPre', 'invokeFun',
    'literal', 'onReady', 'putFieldPre',
    'putField', 'read', 'runInstrumentedFunctionBody',
    'scriptEnter', 'scriptExit', 'unaryPre',
    'unary', 'write',
]);

/**
 * AnalysisHost —— 多插件链式调度器。
 *
 * 每个 hook 方法在被调用时，会依次调用所有注册了该 hook 的插件。
 * 若某个插件的 hook 返回值中含 Array 类型的 `args` 字段，
 * 则该数组会替换分发器的参数列表，后续插件将看到更新后的参数。
 */
class AnalysisHost {
    /**
     * @param {object}   [options]
     * @param {function} [options.onError] - 插件 hook 抛出异常时的处理函数，
     *   接收 (hookName, error)。
     *   默认行为：打印错误并在 Node.js 环境下调用 process.exit(1)；
     *   浏览器环境下继续向上抛出。
     *   传入自定义函数可覆盖（例如测试时阻止 process.exit）。
     */
    constructor({ onError } = {}) {
        this._onError = onError ?? _defaultOnError;

        /** @private  hookName -> { fns: Function[], thisArgs: object[] } */
        this._chains = {};
        for (const name of HOOKS) {
            this._chains[name] = { fns: [], thisArgs: [] };
        }

        // 为每个 hook 预先生成调度方法，直接挂在实例上
        for (const name of HOOKS) {
            this[name] = this._makeDispatcher(name);
        }
    }

    /**
     * 注册一个分析插件。
     *
     * - 只有插件中实际存在的 hook 方法才会被注册，其余忽略。
     * - 多次调用 use() 的顺序即为钩子的执行顺序。
     * - 返回 this，支持链式：`new AnalysisHost().use(A).use(B)`。
     *
     * @param {object} plugin - 分析插件实例
     * @returns {AnalysisHost} this
     */
    use(plugin) {
        for (const name of HOOKS) {
            if (typeof plugin[name] === 'function') {
                this._chains[name].fns.push(plugin[name]);
                this._chains[name].thisArgs.push(plugin);
            }
        }
        return this;
    }

    /** @private 为指定 hook 名生成分发函数 */
    _makeDispatcher(name) {
        const chain   = this._chains[name];
        const onError = () => this._onError;  // 惰性读取，允许构造后替换
        return function dispatchHook(...args) {
            let ret;
            for (let i = 0; i < chain.fns.length; i++) {
                try {
                    const r = chain.fns[i].apply(chain.thisArgs[i], args);
                    if (r !== undefined && r !== null && typeof r === 'object') {
                        if (Array.isArray(r.args)) args = r.args;
                        ret = r;
                    }
                } catch (e) {
                    onError()(name, e);
                    throw e;  // onError 未终止进程时继续向上抛
                }
            }
            return ret;
        };
    }
}

/**
 * 默认错误处理：打印错误并在 Node.js 下退出进程。
 * @param {string} hookName
 * @param {Error}  e
 */
function _defaultOnError(hookName, e) {
    console.error(`[AnalysisHost] exception in plugin hook "${hookName}":`);
    console.error(e.stack ?? e);
    if (typeof process !== 'undefined' && process.exit) {
        process.exit(1);
    }
}

export { AnalysisHost, HOOKS };
