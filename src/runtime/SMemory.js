// JALANGI DO NOT INSTRUMENT

/**
 * @file Shadow Memory —— 为每个 JS 对象、函数和活动帧关联一个唯一的"影子对象"和 ID。
 * @author  Koushik Sen
 *
 * ## 透明性设计（WeakMap 方案）
 *
 * 旧实现通过 `Object.defineProperty` 将特殊属性直接写到目标对象/函数上，
 * 会导致以下副作用，破坏"透明插桩"原则：
 *
 *   1. `Object.getOwnPropertyNames(obj)` 结果多出 `*J$O*`、`*J$A*`、`*J$F*` 等框架属性名
 *      → 被分析代码可感知插桩存在（身份不透明）
 *   2. `Object.freeze(obj)` / `Object.seal(obj)` 后 defineProperty 抛异常，
 *      try-catch 吞掉，影子对象静默创建失败 → 分析工具拿不到 ID（功能静默缺失）
 *   3. 每次 defineProperty 触发 V8 Hidden Class 分裂 → 所有被分析对象 JIT 降级
 *   4. `defineFunction(f)` 向函数写 `*J$F*`，`Object.getOwnPropertyNames(f)` 可见
 *      → 分析框架的存在感泄露给被分析代码
 *
 * 现方案改用三个 WeakMap，**完全不向目标对象/函数写任何属性**：
 *
 *   _shadowMap    : (object | function) → { _id, _actual }
 *     替代 SPECIAL_PROP_SOBJECT / SPECIAL_PROP_ACTUAL（createShadowObject 写到目标对象上）
 *
 *   _fnDefFrameMap : function → frame
 *     替代 SPECIAL_PROP_FRAME（defineFunction 写到函数上）
 *     含义：函数 f 在哪个帧中被定义（defineFunction 时的 frame）
 *
 *   _frameParentMap : frame → parentFrame
 *     替代 SPECIAL_PROP_FRAME（functionEnter 写到新帧对象上）
 *     含义：新帧的父帧链（getFrame 沿此链向上查找变量）
 *
 * 三个 WeakMap 职责分离，键类型不同（对象/函数 vs 帧对象），逻辑清晰。
 *
 * ### 对外 API 完全兼容
 *
 * - `getShadowObjectOfObject(val)`            → 返回影子记录 { _id, _actual }
 * - `getIDFromShadowObjectOrFrame(shadow)`    → 读 shadow._id
 * - `getActualObjectOrFunctionFromShadowObjectOrFrame(shadow)` → 读 shadow._actual
 * - `getShadowObject(obj, prop, isGetField)`  → 同旧接口，owner 换成影子记录
 * - `getShadowFrame(name)`                    → 同旧接口，返回帧影子记录
 * - `getFrame(name)`                          → 同旧接口，返回原始帧对象
 * - `defineFunction(f)`                       → 不写属性，用 _fnDefFrameMap
 * - `initialize` / `functionEnter` / `functionReturn` 等 → 行为不变
 *
 * 这是一个框架级服务，不是普通的分析插件。
 *
 * 使用方式（推荐）：
 *   import { SMemory, SMemoryPlugin } from './SMemory.js';
 *   const smemory = new SMemory(J$);
 *   J$.smemory = smemory;
 *   J$.analysis.use(new SMemoryPlugin(smemory));
 *
 * 向后兼容用法（旧式，与原来 --analysis SMemory.js 行为相同）：
 *   sandbox.analysis = new SMemoryPlugin(sandbox);
 *   // 或者直接加载本文件（末尾已自动执行上述操作）
 */

import {
    $push, $pop,
    $create, $getOwnPropertyDescriptor, $getPrototypeOf,
    $wmGet, $wmSet, $wmHas,
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

        const HOP = Constants.HOP;

        let objectId    = 1;
        let scriptCount = 0;

        let frame      = $create(null);
        const frameStack = [frame];

        // ── 三个 WeakMap 替代 defineProperty ─────────────────────────────────────
        //
        // 1. _shadowMap
        //    键：被分析的目标对象或函数（typeof obj === 'object' || 'function'）
        //    值：{ _id: number, _actual: object }
        //    替代旧方案中写在目标对象上的 SPECIAL_PROP_SOBJECT / SPECIAL_PROP_ACTUAL 属性。
        //
        // 2. _fnDefFrameMap
        //    键：函数对象（typeof fn === 'function'）
        //    值：frame 对象（$create(null) 产生的帧）
        //    含义：函数 fn 被"定义"（defineFunction 调用）时的活跃帧。
        //    替代旧方案中写在函数上的 SPECIAL_PROP_FRAME 属性（defineFunction 时写入）。
        //    functionEnter(f) 通过 $wmGet(_fnDefFrameMap, f) 读取 f 定义时的帧，
        //    从而在新帧上恢复正确的作用域链。
        //
        // 3. _frameParentMap
        //    键：帧对象（$create(null) 产生）
        //    值：父帧对象（也是 $create(null) 产生）
        //    含义：帧的词法父帧，构成帧链（getFrame 沿链向上搜索变量）。
        //    替代旧方案中写在新帧对象上的 SPECIAL_PROP_FRAME 属性（functionEnter 时写入）。
        //
        // 三个 WeakMap 的键类型语义不同，不会混淆：
        //   _shadowMap      键 = 任意被分析对象/函数（来自被分析代码）
        //   _fnDefFrameMap  键 = 函数（来自被分析代码）
        //   _frameParentMap 键 = 框架内部帧对象（$create(null)，不来自被分析代码）
        //
        // 所有操作均通过 NativeProxy.$wmGet/$wmSet/$wmHas 访问，
        // 防止用户代码 monkey-patch WeakMap.prototype 后触发钩子递归。

        const _shadowMap      = new WeakMap();
        const _fnDefFrameMap  = new WeakMap();
        const _frameParentMap = new WeakMap();

        // ── 帧影子 Map（帧的影子记录，独立于 _shadowMap 以区分框架内部帧与被分析对象）──
        //
        // 帧是框架内部创建的 null-prototype 对象（$create(null)），
        // 它本身不会出现在被分析代码中，但 getShadowFrame/getIDFromShadowObjectOrFrame
        // 需要为它分配一个唯一的 ID，以便分析插件追踪变量所在帧。
        const _frameShadowMap = new WeakMap();

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

        /**
         * 获取或创建目标对象的影子记录（存储在 _shadowMap 中）。
         *
         * 与旧 createShadowObject 的区别：
         *   - 完全不向 val 写属性
         *   - 对 Object.freeze / Object.seal 的对象也能正确工作
         *   - 不触发 V8 Hidden Class 变化
         *
         * @param {*} val
         * @returns {{ _id: number, _actual: * } | undefined}
         */
        function getOrCreateShadowRecord(val) {
            const type = typeof val;
            if ((type !== 'object' && type !== 'function') || val === null) return undefined;
            if ($wmHas(_shadowMap, val)) return $wmGet(_shadowMap, val);
            const record = { _id: objectId, _actual: val };
            objectId += 2;
            $wmSet(_shadowMap, val, record);
            return record;
        }

        /**
         * 获取或创建帧对象的影子记录（存储在 _frameShadowMap 中）。
         *
         * @param {object} frameObj  帧对象（$create(null) 创建）
         * @returns {{ _id: number, _actual: undefined }}
         */
        function getOrCreateFrameShadowRecord(frameObj) {
            if ($wmHas(_frameShadowMap, frameObj)) return $wmGet(_frameShadowMap, frameObj);
            const record = { _id: objectId, _actual: undefined };
            objectId += 2;
            $wmSet(_frameShadowMap, frameObj, record);
            return record;
        }

        // ── 公开查询 API ──────────────────────────────────────────────────────────

        /**
         * 获取属性所在对象的影子对象。
         * @param {object}  obj
         * @param {string}  prop
         * @param {boolean} isGetField - true=读取操作，false=写入操作
         * @returns {{ owner: { _id, _actual } | undefined, isProperty: boolean } | false}
         */
        this.getShadowObject = (obj, prop, isGetField) => {
            const ownerAndAccess = getOwnerAndAccess(obj, prop, isGetField);
            if (ownerAndAccess && ownerAndAccess.owner !== undefined) {
                ownerAndAccess.owner = this.getShadowObjectOfObject(ownerAndAccess.owner);
            }
            return ownerAndAccess;
        };

        /**
         * 获取变量所在活动帧的影子对象。
         * @param {string} name - 变量名
         * @returns {{ _id: number, _actual: undefined }}
         */
        this.getShadowFrame = (name) => {
            const f = this.getFrame(name);
            return getOrCreateFrameShadowRecord(f);
        };

        /**
         * 从影子对象或影子帧中取出唯一 ID。
         *
         * 新方案：影子记录格式是 { _id, _actual }，直接读 ._id。
         *
         * @param {{ _id: number } | null | undefined} obj
         * @returns {number|undefined}
         */
        this.getIDFromShadowObjectOrFrame = (obj) => {
            if (obj === undefined || obj === null) return undefined;
            if (typeof obj._id === 'number') return obj._id;
            return undefined;
        };

        /**
         * 从影子对象中取出对应的真实对象。
         *
         * 新方案：直接读 ._actual。
         *
         * @param {{ _actual: * } | null | undefined} obj
         * @returns {*}
         */
        this.getActualObjectOrFunctionFromShadowObjectOrFrame = (obj) => {
            if (obj === undefined || obj === null) return undefined;
            return obj._actual;
        };

        /**
         * 获取持有变量 name 的活动帧（原始帧对象，非影子对象）。
         *
         * 沿 _frameParentMap 构成的帧链向上搜索第一个拥有 name 属性的帧。
         * 若整条链都没有，返回根帧（frameStack[0]）。
         *
         * @param {string} name
         * @returns {object}
         */
        this.getFrame = (name) => {
            let tmp = frame;
            while (tmp) {
                if (HOP(tmp, name)) return tmp;
                const parent = $wmGet(_frameParentMap, tmp);
                if (parent === undefined) break;
                tmp = parent;
            }
            return frameStack[0];
        };

        /**
         * 获取 val 对应的影子对象；val 为 null/undefined/原始值时返回 undefined。
         *
         * 返回格式 { _id: number, _actual: object }。
         * getIDFromShadowObjectOrFrame / getActualObjectOrFunctionFromShadowObjectOrFrame
         * 已同步更新为读新格式。
         *
         * @param {*} val
         * @returns {{ _id: number, _actual: * } | undefined}
         */
        this.getShadowObjectOfObject = (val) => {
            return getOrCreateShadowRecord(val);
        };

        // ── 内部状态维护（由 SMemoryPlugin 钩子驱动）────────────────────────────

        /**
         * 将函数 f 与当前活动帧关联（用于跨帧追踪闭包）。
         *
         * 新方案：不再向 f 写 SPECIAL_PROP_FRAME 属性，
         * 改用 _fnDefFrameMap.set(f, frame)。
         * f 本身不受任何修改，对被分析代码完全透明。
         */
        this.defineFunction = (f) => {
            if (typeof f !== 'function') return;
            $wmSet(_fnDefFrameMap, f, frame);
        };

        /** 在当前帧中注册变量 name。 */
        this.initialize = (name) => {
            frame[name] = undefined;
        };

        /**
         * 函数调用时压入新帧。
         *
         * 新方案：
         *   - 新帧到父帧的链通过 _frameParentMap.set(newFrame, parentFrame) 存储，
         *     替代旧方案在新帧上写 SPECIAL_PROP_FRAME 属性。
         *   - 新帧的"词法父帧"：取 f 定义时的帧（_fnDefFrameMap.get(f)），
         *     这样闭包函数进入时，getFrame 可以沿链正确找到外层帧中的变量。
         *     若 f 没有被 defineFunction 处理过（_fnDefFrameMap 无记录），
         *     则回退到当前活跃帧（parentFrame），与旧方案的 fallback 行为一致。
         *
         * @param {*} f  被调用的函数对象
         */
        this.functionEnter = (f) => {
            const parentFrame = frame;
            frame = $create(null);
            $push(frameStack, frame);

            // 词法父帧：优先用 f 在 defineFunction 时记录的定义帧（闭包链正确性）
            // 若 f 未被 defineFunction 处理（如匿名立即执行函数），则用当前父帧
            const defFrame = (typeof f === 'function') ? $wmGet(_fnDefFrameMap, f) : undefined;
            $wmSet(_frameParentMap, frame, defFrame ?? parentFrame);
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
                        const newFrame = $create(null);
                        $wmSet(_frameParentMap, newFrame, frameStack[0]);
                        $push(frameStack, frame = newFrame);
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
