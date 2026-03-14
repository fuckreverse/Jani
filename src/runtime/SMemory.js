// JALANGI DO NOT INSTRUMENT

/**
 * @file Shadow Memory —— 为每个 JS 对象、函数和活动帧关联一个唯一的"影子对象"和 ID。
 * @author  Koushik Sen
 *
 * 这是一个框架级服务，不是普通的分析插件。
 *
 * 使用方式（推荐）：
 *   import { HookDispatcher } from './HookDispatcher.js';
 *   const host = new HookDispatcher();
 *   host.enableShadowMemory();        // 创建 SMemory 并挂到 J$.smemory
 *   // 现在业务插件可以通过 J$.smemory 访问影子内存
 *   host.use(new MyAnalysis(J$.smemory));
 *
 * 向后兼容用法（旧式，与原来 --analysis SMemory.js 行为相同）：
 *   sandbox.analysis = new SMemoryPlugin(sandbox);
 *   // 或者直接加载本文件（末尾已自动执行上述操作）
 */

import {
    $push, $pop,
    $create, $defineProperty, $getOwnPropertyDescriptor, $getPrototypeOf,
} from './NativeProxy.js';

// ─── SMemory：影子内存服务 ────────────────────────────────────────────────────

/**
 * SMemory 为每个 JS 对象/函数/活动帧维护一个"影子对象"（shadow object）和唯一 ID。
 *
 * 这是一个纯粹的服务类，不实现任何 Jalangi 分析钩子。
 * 通过 SMemoryPlugin 将其与运行时事件桥接。
 *
 * 可通过 J$.smemory 访问。
 */
export class SMemory {
    /**
     * @param {object} sandboxOrConstants - J$ 全局对象（含 Constants 字段），
     *   或直接传入 Constants 对象（测试用）。
     *   若传入对象含 Constants 属性，则使用 sandboxOrConstants.Constants；
     *   否则视为直接传入的 Constants 对象。
     */
    constructor(sandboxOrConstants) {
        const Constants = sandboxOrConstants?.Constants ?? sandboxOrConstants;

        const PREFIX              = Constants.JALANGI_VAR;
        const SPECIAL_PROP_SOBJECT = `*${PREFIX}O*`;
        const SPECIAL_PROP_FRAME   = `*${PREFIX}F*`;
        const SPECIAL_PROP_ACTUAL  = `*${PREFIX}A*`;

        let objectId    = 1;
        let scriptCount = 0;
        const HOP       = Constants.HOP;

        let frame      = $create(null);
        const frameStack = [frame];

        // Node.js 环境：为 process.env 建立影子对象
        const processEnv  = !Constants.isBrowser && typeof process !== 'undefined' && process?.env;
        const shadowEnv   = $create(null);
        if (processEnv) {
            shadowEnv[SPECIAL_PROP_SOBJECT] = objectId;
            shadowEnv[SPECIAL_PROP_ACTUAL]  = process.env;
            objectId += 2;
        }

        // ── 私有工具 ──────────────────────────────────────────────────────────────

        function getOwnerAndAccess(obj, prop, isGetField) {
            const oldObj = obj;
            while (obj !== null) {
                if (typeof obj !== 'object' && typeof obj !== 'function') return false;
                const desc = $getOwnPropertyDescriptor(obj, prop);
                if (desc !== undefined) {
                    if (isGetField && typeof desc.get === 'function')  return { owner: obj, isProperty: false };
                    if (!isGetField && typeof desc.set === 'function') return { owner: obj, isProperty: false };
                }
                if (isGetField && HOP(obj, prop)) return { owner: obj, isProperty: true };
                obj = $getPrototypeOf(obj);
            }
            return isGetField
                ? { owner: undefined, isProperty: true }
                : { owner: oldObj,    isProperty: true };
        }

        function createShadowObject(val) {
            const type = typeof val;
            if ((type === 'object' || type === 'function') && val !== null && !HOP(val, SPECIAL_PROP_SOBJECT)) {
                $defineProperty(val, SPECIAL_PROP_SOBJECT, { enumerable: false, writable: true, configurable: true });
                $defineProperty(val, SPECIAL_PROP_ACTUAL,  { enumerable: false, writable: true, configurable: true });
                try {
                    val[SPECIAL_PROP_SOBJECT] = $create(null);
                    val[SPECIAL_PROP_SOBJECT][SPECIAL_PROP_SOBJECT] = objectId;
                    val[SPECIAL_PROP_SOBJECT][SPECIAL_PROP_ACTUAL]  = val;
                    objectId += 2;
                } catch {
                    // 某些 DOM 对象不允许附加特殊属性，直接忽略
                }
            }
        }

        // ── 公开查询 API ──────────────────────────────────────────────────────────

        /**
         * 获取属性所在对象的影子对象。
         * @param {object}  obj
         * @param {string}  prop
         * @param {boolean} isGetField - true=读取操作，false=写入操作
         * @returns {{ owner: object, isProperty: boolean }}
         */
        this.getShadowObject = (obj, prop, isGetField) => {
            const ownerAndAccess = getOwnerAndAccess(obj, prop, isGetField);
            if (ownerAndAccess.owner !== undefined) {
                ownerAndAccess.owner = this.getShadowObjectOfObject(ownerAndAccess.owner);
            }
            return ownerAndAccess;
        };

        /**
         * 获取变量所在活动帧的影子对象。
         * @param {string} name - 变量名
         * @returns {object}
         */
        this.getShadowFrame = (name) => {
            const f   = this.getFrame(name);
            const ret = this.getShadowObjectOfObject(f);
            $defineProperty(ret, SPECIAL_PROP_ACTUAL, { enumerable: false, writable: true, configurable: true });
            ret[SPECIAL_PROP_ACTUAL] = f[SPECIAL_PROP_ACTUAL];
            return ret;
        };

        /**
         * 从影子对象或影子帧中取出唯一 ID。
         * @param {object} obj
         * @returns {number|undefined}
         */
        this.getIDFromShadowObjectOrFrame = (obj) => {
            if (obj === undefined || obj === null) return undefined;
            return obj[SPECIAL_PROP_SOBJECT];
        };

        /**
         * 从影子对象中取出对应的真实对象。
         * @param {object} obj
         * @returns {*}
         */
        this.getActualObjectOrFunctionFromShadowObjectOrFrame = (obj) => obj[SPECIAL_PROP_ACTUAL];

        /**
         * 获取持有变量 name 的活动帧（原始帧对象，非影子对象）。
         * @param {string} name
         * @returns {object}
         */
        this.getFrame = (name) => {
            let tmp = frame;
            while (tmp && !HOP(tmp, name)) {
                tmp = tmp[SPECIAL_PROP_FRAME];
            }
            return tmp ?? frameStack[0];
        };

        /**
         * 获取 val 对应的影子对象；val 为 null/undefined/原始值时返回 undefined。
         * @param {*} val
         * @returns {object|undefined}
         */
        this.getShadowObjectOfObject = (val) => {
            if (processEnv && val === process.env) return shadowEnv;
            createShadowObject(val);
            const type = typeof val;
            if ((type === 'object' || type === 'function') && val !== null && HOP(val, SPECIAL_PROP_SOBJECT)) {
                if (typeof val[SPECIAL_PROP_SOBJECT] === 'object') {
                    return val[SPECIAL_PROP_SOBJECT];
                }
            }
            return undefined;
        };

        // ── 内部状态维护（由 SMemoryPlugin 钩子驱动）────────────────────────────

        /** 将函数 f 与当前活动帧关联（用于跨帧追踪闭包）。 */
        this.defineFunction = (f) => {
            if (typeof f !== 'function') return;
            $defineProperty(f, SPECIAL_PROP_FRAME, { enumerable: false, writable: true, configurable: true });
            f[SPECIAL_PROP_FRAME] = frame;
        };

        /** 在当前帧中注册变量 name。 */
        this.initialize = (name) => {
            frame[name] = undefined;
        };

        /** 函数调用时压入新帧。 */
        this.functionEnter = (f) => {
            $push(frameStack, frame = $create(null));
            $defineProperty(frame, SPECIAL_PROP_FRAME,  { enumerable: false, writable: true, configurable: true });
            $defineProperty(frame, SPECIAL_PROP_ACTUAL, { enumerable: false, writable: true, configurable: true });
            frame[SPECIAL_PROP_FRAME]  = f[SPECIAL_PROP_FRAME];
            frame[SPECIAL_PROP_ACTUAL] = f;
        };

        /** 函数返回时弹出帧。 */
        this.functionReturn = () => {
            $pop(frameStack);
            frame = frameStack[frameStack.length - 1];
        };

        const isEvalScript = [];

        /** 脚本进入时管理帧栈。 */
        this.scriptEnter = (instrumentedFileName, originalFileName) => {
            scriptCount++;
            if (scriptCount > 0) {
                if (!(originalFileName === 'eval' && instrumentedFileName === originalFileName)) {
                    if (Constants.isBrowser) {
                        frame = frameStack[0];
                    } else {
                        $push(frameStack, frame = $create(null));
                        frame[SPECIAL_PROP_FRAME] = frameStack[0];
                    }
                    $push(isEvalScript, false);
                } else {
                    $push(isEvalScript, true);
                }
            }
        };

        /** 脚本退出时恢复帧栈。 */
        this.scriptReturn = () => {
            if (scriptCount > 0 && !$pop(isEvalScript)) {
                if (!Constants.isBrowser) {
                    $pop(frameStack);
                }
                frame = frameStack[frameStack.length - 1];
            }
            scriptCount--;
        };
    }
}

// ─── SMemoryPlugin：将 SMemory 服务桥接到 Jalangi 分析钩子 ──────────────────
//
// 这才是曾经混入 SMemory.js 末尾的 MyAnalysis。
// 现在它是一个独立的、职责明确的适配器：
//   - 实现 Jalangi 分析钩子（literal / declare / functionEnter / …）
//   - 将钩子事件转发给 SMemory 内部状态方法
//   - 可以直接被 host.use() 注册，也可以被旧式 sandbox.analysis = new X() 注册

export class SMemoryPlugin {
    constructor(smemory) {
        this.evalLiteral = (iid, val /*, hasGetterSetter */) => {
            smemory.defineFunction(val);
        };

        this.declareVar = (iid, name /*, val, isArgument, argumentIndex, isCatchParam */) => {
            smemory.initialize(name);
        };

        this.functionEnter = (iid, f /*, dis, args */) => {
            smemory.functionEnter(f);
            smemory.initialize('this');
        };

        this.functionExit = (iid, returnVal, wrappedExceptionVal) => {
            smemory.functionReturn();
            return { returnVal, wrappedExceptionVal, isBacktrack: false };
        };

        this.scriptEnter = (iid, instrumentedFileName, originalFileName) => {
            smemory.scriptEnter(instrumentedFileName, originalFileName);
        };

        this.scriptExit = (iid, wrappedExceptionVal) => {
            smemory.scriptReturn();
            return { wrappedExceptionVal, isBacktrack: false };
        };
    }
}

// ─── 向后兼容安装 ─────────────────────────────────────────────────────────────
//
// 当本文件被旧式 --analysis SMemory.js 命令行参数直接加载时，
// 自动创建 SMemory 实例并安装为分析插件。
//
// 新式推荐用法（通过 HookDispatcher）：
//   import { SMemory, SMemoryPlugin } from './SMemory.js';
//   const smemory = new SMemory(J$);
//   J$.smemory = smemory;
//   host.use(new SMemoryPlugin(smemory));

// 集成到现有 HookDispatcher 而非覆盖。
// 若 J$.analysis 已是 HookDispatcher 实例（支持 .use() 方法），则将 SMemoryPlugin
// 注册为插件，保留其他已注册的分析。否则才直接赋值（向后兼容旧式单一分析）。
//
// 使用 globalThis.J$ 而非裸 J$ 引用：在纯 ESM 环境中，裸 `J$` 访问的是模块顶层
// 作用域标识符，而非全局对象上的 J$。globalThis.J$ 语义明确，各环境行为一致。
if (typeof globalThis.J$ !== 'undefined') {
    const J$ = globalThis.J$;
    const smemory = new SMemory(J$);
    J$.smemory    = smemory;

    if (J$.analysis?.use && typeof J$.analysis.use === 'function') {
        // 已有 HookDispatcher：集成新插件
        J$.analysis.use(new SMemoryPlugin(smemory));
    } else {
        // 兼容旧式单一分析赋值
        J$.analysis = new SMemoryPlugin(smemory);
    }
}
