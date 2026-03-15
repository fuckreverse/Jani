// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

/**
 * HookDispatcher —— Jani 运行时钩子分发器。
 *
 * 职责：
 *  1. 维护一个有序的分析插件列表
 *  2. 将每个运行时钩子（readVar / writeVar / getField …）以"链式调用"的方式
 *     依次分发给所有已注册的插件
 *
 * 标准用法：
 *
 *   import { HookDispatcher } from './HookDispatcher.js';
 *   import { SMemoryPlugin, SMemory } from './SMemory.js';
 *   import { LogAllAnalysis } from '../plugins/tutorial/LogAll.js';
 *
 *   const smemory = new SMemory();
 *   J$.analysis = new HookDispatcher()
 *       .use(new SMemoryPlugin(smemory))
 *       .use(new LogAllAnalysis(smemory));
 *
 * observeOnly 模式（Trace 场景推荐）：
 *
 *   J$.analysis = new HookDispatcher({ observeOnly: true })
 *       .use(new MyTraceAnalysis());
 *
 *   // 或通过 JalangiSandbox 透传：
 *   const J$ = await JalangiSandbox.create({ observeOnly: true });
 *   J$.analysis.use(new MyTraceAnalysis());
 */

import { createDiagLogger, DOMAIN } from '../logger/diagnostics.js';
import { $push, $slice, $isArray, $apply, $freeze } from './NativeProxy.js';

const log = createDiagLogger(DOMAIN.FRAMEWORK);

/** 所有可能的钩子名称（与 JalangiRuntime.js 运行时保持一致）。 */
const HOOKS = $freeze([
    'returnStmt', 'throwStmt', 'withStmt',
    'binaryPre', 'binary', 'evalCond',
    'declareVar', 'endExecution', 'endExpression',
    'forInStmt', 'functionEnter', 'functionExit',
    'getFieldPre', 'getField', 'instrumentCodePre',
    'instrumentCode', 'callPre', 'call',
    'evalLiteral', 'onReady', 'putFieldPre',
    'putField', 'readVar', 'shouldInstrumentFn',
    'scriptEnter', 'scriptExit', 'unaryPre',
    'unary', 'writeVar',
    // async/await 恢复点钩子（J$.Aw 触发）
    'awaitResume',
]);

/**
 * 各钩子中 `result` 字段对应的参数位置（0-based）。
 *
 * 当某个插件返回 `{ result }` 时，调度器会将 `args[RESULT_ARG_INDEX[hookName]]`
 * 更新为新的 result 值，使后续插件能看到上一个插件修改后的值。
 *
 * 未列出的钩子（如 `declareVar`、`scriptEnter` 等）返回值语义不是 `result`，
 * 不进行此传递。
 */
const RESULT_ARG_INDEX = $freeze({
    binary:       4,   // binary(iid, op, left, right, result, ...)
    unary:        2,   // unary(iid, op, val, ...)
    writeVar:     2,   // writeVar(iid, name, val, ...)
    readVar:      2,   // readVar(iid, name, val, ...)
    getField:     3,   // getField(iid, base, offset, val, ...)
    putField:     3,   // putField(iid, base, offset, val, ...)
    call:         4,   // call(iid, f, base, args, result, ...)
    evalLiteral:  1,   // evalLiteral(iid, val, ...)
    evalCond:     1,   // evalCond(iid, result, ...)
    forInStmt:    1,   // forInStmt(iid, val, ...)
    declareVar:   2,   // declareVar(iid, name, val, ...)
    returnStmt:   1,   // returnStmt(iid, val, ...)
    throwStmt:    1,   // throwStmt(iid, val, ...)
});

/**
 * HookDispatcher —— 多插件链式调度器。
 *
 * 每个 hook 方法在被调用时，会依次调用所有注册了该 hook 的插件。
 * 若某个插件的 hook 返回值中含 Array 类型的 `args` 字段，
 * 则该数组会替换分发器的参数列表，后续插件将看到更新后的参数。
 * 若返回值含 `result` 字段，且该钩子在 RESULT_ARG_INDEX 中有定义，
 * 则对应位置的 args 会被更新，后续插件可见修改后的值。
 *
 * **observeOnly 模式**：当 `options.observeOnly = true` 时，调度器仍会依次
 * 调用所有插件的钩子（保证插件能观察到所有事件），但会忽略所有钩子的返回值——
 * 不消费 `result`、`skip`、`args`、`isBacktrack` 等修改字段，从而在框架层面
 * 保证插件无法改变原始程序的执行结果。适用于 Trace / Coverage / Profiling 等
 * 纯观测场景，消除"插件误返回值导致静默破坏原始程序语义"的风险。
 */
class HookDispatcher {
    /**
     * @param {object}   [options]
     * @param {function} [options.onError] - 插件 hook 抛出异常时的处理函数，
     *   接收 (hookName, error)。
     *   默认行为：打印错误并在 Node.js 环境下调用 process.exit(1)；
     *   浏览器环境下继续向上抛出。
     *   传入自定义函数可覆盖（例如测试时阻止 process.exit）。
     * @param {boolean}  [options.observeOnly=false] - 纯观测模式。
     *   true：所有插件钩子仍正常调用（插件可观察事件），但返回值被完全忽略，
     *         插件无法通过 result/skip/isBacktrack 等字段修改原始程序的执行。
     *   false（默认）：标准模式，插件可通过返回值修改执行行为。
     */
    constructor({ onError, observeOnly = false } = {}) {
        this._onError = onError ?? _defaultOnError;

        /** @type {boolean} 是否处于纯观测模式（插件返回值被完全忽略）。 */
        this.observeOnly = observeOnly;

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
     * - 返回 this，支持链式：`new HookDispatcher().use(A).use(B)`。
     *
     * @param {object} plugin - 分析插件实例
     * @returns {HookDispatcher} this
     */
    use(plugin) {
        for (const name of HOOKS) {
            if (typeof plugin[name] === 'function') {
                $push(this._chains[name].fns, plugin[name]);
                $push(this._chains[name].thisArgs, plugin);
            }
        }
        return this;
    }

    /** @private 为指定 hook 名生成分发函数 */
    _makeDispatcher(name) {
        const chain        = this._chains[name];
        const onError      = () => this._onError;  // 惰性读取，允许构造后替换
        const resultArgIdx = RESULT_ARG_INDEX[name] ?? -1;
        // 惰性读取 observeOnly，允许构造后通过 this.observeOnly 动态切换
        const host         = this;
        return function dispatchHook(...args) {
            let ret;
            const observeOnly = host.observeOnly;
            for (let i = 0; i < chain.fns.length; i++) {
                try {
                    const r = $apply(chain.fns[i], chain.thisArgs[i], args);
                    // observeOnly 模式：钩子仍正常调用，但返回值被完全忽略。
                    // 插件只能观察事件，无法通过任何返回字段修改原始执行结果。
                    if (!observeOnly && r !== undefined && r !== null && typeof r === 'object') {
                        if ($isArray(r.args)) {
                            args = r.args;
                        } else if ('result' in r && resultArgIdx >= 0) {
                            // 将 result 更新到对应参数位置，使后续插件可见修改后的值
                            args = $slice(args, 0);
                            args[resultArgIdx] = r.result;
                        }
                        ret = r;
                    }
                } catch (e) {
                    // 先取出 _onError 再检查是否为函数，防止
                    // _onError 被替换为非函数时 onError()() 抛出 TypeError，
                    // 掩盖原始异常，造成难以调试的双重异常问题。
                    const errHandler = onError();
                    if (typeof errHandler === 'function') errHandler(name, e);
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
    log.error(`exception in plugin hook "${hookName}":`);
    log.error(e.stack ?? e);
    if (typeof process !== 'undefined' && process.exit) {
        process.exit(1);
    }
}

export { HookDispatcher, HOOKS };
