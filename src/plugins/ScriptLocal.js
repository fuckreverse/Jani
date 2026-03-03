// JALANGI DO NOT INSTRUMENT

/**
 * @file ScriptLocal —— 打印每次变量读写操作及其作用域信息的示例分析。
 *
 * 用法：
 *   import { ScriptLocalAnalysis } from './ScriptLocal.js';
 *   sandbox.analysis = new ScriptLocalAnalysis();
 */

export class ScriptLocalAnalysis {
    /**
     * @param {object} [sandbox]  J$ 全局对象（用于 sandbox.log 路由）
     */
    constructor(sandbox = null) {
        this._sandbox = sandbox;
    }

    _log(str) {
        if (this._sandbox?.log) {
            this._sandbox.log(str);
        } else {
            console.log(str);
        }
    }

    /**
     * 将作用域标志转成可读字符串。
     * @param {boolean} isGlobal
     * @param {boolean} isScriptLocal
     * @returns {string}
     */
    static _writeFlags(isGlobal, isScriptLocal) {
        if (isGlobal && isScriptLocal) return 'global and script-local?!';
        if (isGlobal)                  return 'global';
        if (isScriptLocal)             return 'script-local';
        return 'local';
    }

    read(iid, name, val, isGlobal, isScriptLocal) {
        this._log(`Reading from ${name} (${ScriptLocalAnalysis._writeFlags(isGlobal, isScriptLocal)})`);
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        this._log(`Writing to ${name} (${ScriptLocalAnalysis._writeFlags(isGlobal, isScriptLocal)})`);
    }
}
