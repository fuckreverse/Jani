// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

/**
 * @file JalangiSandbox — Jalangi2 完整沙盒对象。
 *
 * `new JalangiSandbox(options)` 返回一个自包含的沙盒实例，
 * 已具备所有运行时钩子（R/W/G/P/…）、位置查询（iidToLocation）
 * 以及分析插件注册能力，可直接赋给 globalThis.J$。
 *
 * 用法：
 *   import { JalangiSandbox } from './JalangiSandbox.js';
 *
 *   // 最简：只做 analysis，不需要 IDB
 *   const J$ = globalThis.J$ = new JalangiSandbox();
 *   J$.analysis.use(new MyAnalysis(J$));
 *
 *   // 完整：内置 ExecutionTrace + IndexedDB 持久化
 *   const J$ = globalThis.J$ = new JalangiSandbox({
 *       useIdb:    true,
 *       dbName:    'jalangi-traces',
 *       storeName: 'execution-trace',
 *   });
 *
 *   // 扩展：追加更多分析插件
 *   J$.analysis.use(new AnotherAnalysis(J$));
 */

import {
    APPLY, CALL, HAS_OWN_PROPERTY, HAS_OWN_PROPERTY_CALL,
    JALANGI_VAR, SPECIAL_PROP, SPECIAL_PROP2, SPECIAL_PROP3, SPECIAL_PROP4,
    SPECIAL_PROP_SID, SPECIAL_PROP_IID, UNKNOWN, HOP, hasGetterSetter,
} from '../Constants.js';
import { JalangiRuntime } from './JalangiRuntime.js';
import { AnalysisHost   } from './AnalysisHost.js';

/**
 * Jalangi2 完整沙盒。
 *
 * 继承 JalangiRuntime（所有运行时钩子 R/W/G/P/…），
 * 并直接提供 iidToLocation / getGlobalIID 位置查询方法。
 *
 * **重要**：请通过静态异步工厂方法 `JalangiSandbox.create(options)` 创建实例。
 * 不要直接使用 `new JalangiSandbox()`，因为异步插件注册无法在构造函数中 await。
 *
 * @param {object}  [options]
 * @param {boolean} [options.useIdb=false]
 *   浏览器中是否启用 IndexedDB
 * @param {string}  [options.dbName]
 *   IndexedDB 数据库名
 * @param {string}  [options.storeName]
 *   IndexedDB ObjectStore 名
 * @param {boolean} [options.withExecutionTrace=false]
 *   是否自动注册内置 ExecutionTraceAnalysis 插件。
 *   若为 false（默认），沙盒不预装任何分析，调用方自行 J$.analysis.use(...)。
 * @param {string}  [options.sourceCode]
 *   原始源码（ExecutionTrace 用，可选）
 * @param {boolean} [options.observeOnly=false]
 *   纯观测模式。true 时所有插件钩子仍正常调用，但返回值被完全忽略——
 *   插件无法通过 result/skip/isBacktrack 等字段修改原始程序的执行。
 *   适用于 Trace / Coverage / Profiling 等纯观测场景。
 *   等同于 `new AnalysisHost({ observeOnly: true })`。
 * @param {boolean} [options.instrumentEval=false]
 *   是否对 eval / new Function 动态创建的代码进行插桩。
 *   默认 false：eval/Function 直接透传原始调用，语义完全保持原样，适合 trace / observe 等场景。
 *   设为 true 则恢复旧式行为（动态代码也被插桩分析），需确保 `this.instrumentEvalCode` 已注入。
 */
export class JalangiSandbox extends JalangiRuntime {

    // ── 公开沙盒状态（JalangiRuntime 的钩子方法通过 this 读写这些字段）────

    /** iid → 源码位置映射表（{ [sid]: { [iid]: [sl,sc,el,ec], originalCodeFileName } }） */
    smap = {};

    /** 当前脚本 ID */
    sid = 0;

    /** 当前脚本的 iid 映射（由插桩器在 Se() 前写入 J$.iids） */
    iids = null;

    /** 当前分析插件（AnalysisHost 实例，支持 .use() 链式注册） */
    analysis = null;

    /** TraceLogger 实例（由 ExecutionTraceAnalysis 写入，供 log() 使用） */
    tracer = null;

    /** 浏览器结果面板（可选） */
    Results = null;

    /** 所有常量（与旧式 J$.Constants 保持一致） */
    Constants = {
        APPLY, CALL, HAS_OWN_PROPERTY, HAS_OWN_PROPERTY_CALL,
        JALANGI_VAR, SPECIAL_PROP, SPECIAL_PROP2, SPECIAL_PROP3, SPECIAL_PROP4,
        SPECIAL_PROP_SID, SPECIAL_PROP_IID, UNKNOWN, HOP, hasGetterSetter,
    };

    /**
     * BUG-RT-05 修复：私有构造函数，防止直接 new 调用。
     * 必须通过静态工厂方法 `create(options)` 创建实例。
     */
    constructor(options = {}) {
        super({
            debugShadow:    options.debugShadow    ?? false,
            instrumentEval: options.instrumentEval ?? false,
        });
        this.analysis = new AnalysisHost({
            observeOnly: options.observeOnly ?? false,
        });
    }

    /**
     * 异步工厂方法，创建并初始化 JalangiSandbox 实例。
     * 
     * 此方法支持异步插件注册（如 ExecutionTraceAnalysis），
     * 确保在使用前所有插件已完全注册，避免早期 trace 事件丢失。
     *
     * @param {object} [options] - 配置选项（同构造函数）
     * @returns {Promise<JalangiSandbox>}
     *
     * @example
     *   // 基础用法
     *   const J$ = await JalangiSandbox.create();
     *   globalThis.J$ = J$;
     *
     *   // 带 ExecutionTrace
     *   const J$ = await JalangiSandbox.create({
     *       withExecutionTrace: true,
     *       useIdb: true,
     *   });
     */
    static async create(options = {}) {
        const sandbox = new JalangiSandbox(options);

        // 若启用 ExecutionTrace，异步注册并等待完成
        if (options.withExecutionTrace) {
            await sandbox.#registerExecutionTrace(options);
        }

        return sandbox;
    }

    // ── 源码位置查询 ──────────────────────────────────────────────────────────

    /**
     * 将 (sid, iid) 或 "sid:iid" 格式的 giid 字符串转为可读位置字符串。
     *
     * @param {number|string} sid  脚本 ID，或 "sid:iid" 格式的 giid 字符串
     * @param {number} [iid]       指令 ID（当 sid 为数字时使用）
     * @returns {string}
     */
    iidToLocation(sid, iid) {
        if (!this.smap) return String(sid);

        let gid = sid;

        if (typeof sid === 'string' && sid.includes(':')) {
            const parts = sid.split(':');
            iid = parseInt(parts[1]);
            sid = parseInt(parts[0]);
        } else {
            gid = `${sid}:${iid}`;
        }

        const entry = this.smap[sid];
        if (!entry) return String(sid);

        let fname = entry.originalCodeFileName;

        // 嵌套 eval：递归拼接 eval 调用位置
        if (entry.evalSid !== undefined) {
            fname = fname + this.iidToLocation(entry.evalSid, entry.evalIid);
        }

        const arr = entry[iid];
        if (arr) {
            if (this.Results) {
                return `<a href="javascript:iidToDisplayCodeLocation('${gid}');">(${fname}:${arr[0]}:${arr[1]}:${arr[2]}:${arr[3]})</a>`;
            }
            return `(${fname}:${arr[0]}:${arr[1]}:${arr[2]}:${arr[3]})`;
        }

        return `(${fname}:iid${iid})`;
    }

    /**
     * 返回全局唯一的 IID 字符串（"sid:iid" 格式）。
     * @param {number} iid
     * @returns {string}
     */
    getGlobalIID(iid) {
        return `${this.sid}:${iid}`;
    }

    // ── 私有辅助 ─────────────────────────────────────────────────────────────

    async #registerExecutionTrace(options) {
        const { ExecutionTraceAnalysis } = await import('../plugins/ExecutionTrace.js');
        this.analysis.use(new ExecutionTraceAnalysis(this, options.sourceCode ?? null, {
            useIdb:    options.useIdb    ?? false,
            dbName:    options.dbName,
            storeName: options.storeName,
        }));
    }
}
