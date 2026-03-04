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

    constructor(options = {}) {
        super({ debugShadow: options.debugShadow ?? false });
        this.analysis = new AnalysisHost();

        if (options.withExecutionTrace) {
            this.#registerExecutionTrace(options);
        }
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
