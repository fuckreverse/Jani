// JALANGI DO NOT INSTRUMENT

/**
 * @file Shadow Memory —— 为每个 JS 对象、函数和活动帧关联唯一的"影子对象"和 ID。
 * @author  Koushik Sen
 *
 * 导出两个类：
 *
 *   SMemory      —— 纯服务类，维护影子内存状态，供业务插件查询。
 *   SMemoryPlugin —— 分析插件适配器，将 Jalangi 钩子事件转发给 SMemory。
 *
 * 标准用法：
 *
 *   import { SMemory, SMemoryPlugin } from './SMemory.js';
 *   import { AnalysisHost }          from './AnalysisHost.js';
 *
 *   const smemory = new SMemory(J$.Constants);
 *   J$.smemory = smemory;   // 挂到 J$ 供业务插件访问（可选）
 *
 *   J$.analysis = new AnalysisHost()
 *       .use(new SMemoryPlugin(smemory))
 *       .use(new MyAnalysis(smemory));
 */

import { HOP } from '../Constants.js';

// ─── SMemory：影子内存服务 ─────────────────────────────────────────────────────

/**
 * SMemory 为每个 JS 对象/函数/活动帧维护"影子对象"（shadow object）和唯一 ID。
 *
 * 这是一个纯粹的服务类，不实现任何 Jalangi 分析钩子。
 * 通过 SMemoryPlugin 将其与运行时事件桥接。
 *
 * @param {object} constants - Jalangi Constants 对象（提供 JALANGI_VAR / isBrowser 等）
 */
class SMemory {
    constructor(constants) {
        const PREFIX = constants.JALANGI_VAR;
        this._SOBJECT = `*${PREFIX}O*`;
        this._FRAME   = `*${PREFIX}F*`;
        this._ACTUAL  = `*${PREFIX}A*`;
        this._isBrowser = !!constants.isBrowser;

        this._objectId    = 1;
        this._scriptCount = 0;

        this._frame      = Object.create(null);
        this._frameStack = [this._frame];
        this._isEvalScript = [];

        // Node.js 环境：为 process.env 创建初始影子对象
        const processEnv = !this._isBrowser && typeof process !== 'undefined' && process?.env;
        if (processEnv) {
            this._shadowEnv = Object.create(null);
            this._shadowEnv[this._SOBJECT] = this._objectId;
            this._shadowEnv[this._ACTUAL]  = process.env;
            this._objectId += 2;
        }
        this._processEnv = processEnv || null;
    }

    // ── 公开查询 API ────────────────────────────────────────────────────────────

    /**
     * 获取属性所在对象的影子对象。
     * @param {object}  obj
     * @param {string}  prop
     * @param {boolean} isGetField - true=读取操作，false=写入操作
     * @returns {{ owner: object, isProperty: boolean }}
     */
    getShadowObject(obj, prop, isGetField) {
        const ownerAndAccess = this._getOwnerAndAccess(obj, prop, isGetField);
        if (ownerAndAccess.owner !== undefined) {
            ownerAndAccess.owner = this.getShadowObjectOfObject(ownerAndAccess.owner);
        }
        return ownerAndAccess;
    }

    /**
     * 获取变量所在活动帧的影子对象。
     * @param {string} name - 变量名（传 "this" 可获取当前帧）
     * @returns {object}
     */
    getShadowFrame(name) {
        const f   = this.getFrame(name);
        const ret = this.getShadowObjectOfObject(f);
        if (typeof Object.defineProperty === 'function') {
            Object.defineProperty(ret, this._ACTUAL, { enumerable: false, writable: true });
        }
        ret[this._ACTUAL] = f[this._ACTUAL];
        return ret;
    }

    /**
     * 从影子对象或影子帧中取出唯一 ID。
     * @param {object} obj
     * @returns {number|undefined}
     */
    getIDFromShadowObjectOrFrame(obj) {
        if (obj == null) return undefined;
        return obj[this._SOBJECT];
    }

    /**
     * 从影子对象中取出对应的真实对象/函数。
     * @param {object} obj
     * @returns {*}
     */
    getActualObjectOrFunctionFromShadowObjectOrFrame(obj) {
        return obj[this._ACTUAL];
    }

    /**
     * 获取持有变量 name 的活动帧（原始帧，非影子对象）。
     * @param {string} name
     * @returns {object}
     */
    getFrame(name) {
        let tmp = this._frame;
        while (tmp && !HOP(tmp, name)) {
            tmp = tmp[this._FRAME];
        }
        return tmp ?? this._frameStack[0];
    }

    /**
     * 获取 val 对应的影子对象。val 为 null/undefined/原始值时返回 undefined。
     * @param {*} val
     * @returns {object|undefined}
     */
    getShadowObjectOfObject(val) {
        if (this._processEnv && val === process.env) return this._shadowEnv;
        this._createShadowObject(val);
        const type = typeof val;
        if ((type === 'object' || type === 'function') && val !== null && HOP(val, this._SOBJECT)) {
            if (typeof val[this._SOBJECT] === 'object') return val[this._SOBJECT];
        }
        return undefined;
    }

    // ── 内部状态维护（由 SMemoryPlugin 钩子事件驱动）──────────────────────────

    /** 将函数 f 与当前活动帧关联（追踪闭包的词法帧）。 */
    defineFunction(f) {
        if (typeof f === 'function') {
            if (typeof Object.defineProperty === 'function') {
                Object.defineProperty(f, this._FRAME, { enumerable: false, writable: true });
            }
            f[this._FRAME] = this._frame;
        }
    }

    /** 在当前帧中注册变量 name。 */
    initialize(name) {
        this._frame[name] = undefined;
    }

    /** 函数调用时压入新帧。 */
    functionEnter(f) {
        this._frameStack.push(this._frame = Object.create(null));
        if (typeof Object.defineProperty === 'function') {
            Object.defineProperty(this._frame, this._FRAME,  { enumerable: false, writable: true });
            Object.defineProperty(this._frame, this._ACTUAL, { enumerable: false, writable: true });
        }
        this._frame[this._FRAME]  = f[this._FRAME];
        this._frame[this._ACTUAL] = f;
    }

    /** 函数返回时弹出帧。 */
    functionReturn() {
        this._frameStack.pop();
        this._frame = this._frameStack[this._frameStack.length - 1];
    }

    /** 脚本进入时管理帧栈。 */
    scriptEnter(instrumentedFileName, originalFileName) {
        this._scriptCount++;
        if (this._scriptCount > 0) {
            if (!(originalFileName === 'eval' && instrumentedFileName === originalFileName)) {
                if (this._isBrowser) {
                    this._frame = this._frameStack[0];
                } else {
                    this._frameStack.push(this._frame = Object.create(null));
                    this._frame[this._FRAME] = this._frameStack[0];
                }
                this._isEvalScript.push(false);
            } else {
                this._isEvalScript.push(true);
            }
        }
    }

    /** 脚本退出时恢复帧栈。 */
    scriptReturn() {
        if (this._scriptCount > 0 && !this._isEvalScript.pop()) {
            if (!this._isBrowser) {
                this._frameStack.pop();
            }
            this._frame = this._frameStack[this._frameStack.length - 1];
        }
        this._scriptCount--;
    }

    // ── 私有工具 ──────────────────────────────────────────────────────────────

    _getOwnerAndAccess(obj, prop, isGetField) {
        if (typeof Object.getOwnPropertyDescriptor !== 'function') {
            throw new Error('Cannot call getOwnPropertyDescriptor on Object.');
        }
        const oldObj = obj;
        while (obj !== null) {
            if (typeof obj !== 'object' && typeof obj !== 'function') return false;
            const desc = Object.getOwnPropertyDescriptor(obj, prop);
            if (desc !== undefined) {
                if (isGetField  && typeof desc.get === 'function') return { owner: obj, isProperty: false };
                if (!isGetField && typeof desc.set === 'function') return { owner: obj, isProperty: false };
            }
            if (isGetField && HOP(obj, prop)) return { owner: obj, isProperty: true };
            obj = obj.__proto__;
        }
        return isGetField
            ? { owner: undefined, isProperty: true }
            : { owner: oldObj,    isProperty: true };
    }

    _createShadowObject(val) {
        const type = typeof val;
        if ((type === 'object' || type === 'function') && val !== null && !HOP(val, this._SOBJECT)) {
            if (typeof Object.defineProperty === 'function') {
                Object.defineProperty(val, this._SOBJECT, { enumerable: false, writable: true });
                Object.defineProperty(val, this._ACTUAL,  { enumerable: false, writable: true });
            }
            try {
                val[this._SOBJECT] = Object.create(null);
                val[this._SOBJECT][this._SOBJECT] = this._objectId;
                val[this._SOBJECT][this._ACTUAL]  = val;
                this._objectId += 2;
            } catch (_) {
                // 某些 DOM 对象不允许附加属性，忽略
            }
        }
    }
}

// ─── SMemoryPlugin：将 Jalangi 钩子事件桥接到 SMemory ───────────────────────────

/**
 * SMemoryPlugin 实现 Jalangi 分析钩子，将事件转发给 SMemory。
 *
 * 可直接传给 host.use()：
 *   host.use(new SMemoryPlugin(smemory));
 *
 * @param {SMemory} smemory - SMemory 实例
 */
class SMemoryPlugin {
    constructor(smemory) {
        this._mem = smemory;
    }

    literal(iid, val /*, hasGetterSetter */) {
        this._mem.defineFunction(val);
    }

    declare(iid, name /*, val, isArgument, argumentIndex, isCatchParam */) {
        this._mem.initialize(name);
    }

    functionEnter(iid, f /*, dis, args */) {
        this._mem.functionEnter(f);
        this._mem.initialize('this');
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        this._mem.functionReturn();
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        this._mem.scriptEnter(instrumentedFileName, originalFileName);
    }

    scriptExit(iid, wrappedExceptionVal) {
        this._mem.scriptReturn();
        return { wrappedExceptionVal, isBacktrack: false };
    }
}

export { SMemory, SMemoryPlugin };
