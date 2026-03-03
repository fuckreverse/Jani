// JALANGI DO NOT INSTRUMENT

/**
 * @file ScriptLocal —— 打印每次变量读写操作及其作用域信息的示例分析。
 *
 * 用法：
 *   import { ScriptLocalAnalysis } from './ScriptLocal.js';
 *   sandbox.analysis = new ScriptLocalAnalysis();
 *
 * 向后兼容（全局环境）：
 *   如果检测到全局 J$，自动安装为当前分析。
 */

export class ScriptLocalAnalysis {
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
        console.log(`Reading from ${name} (${ScriptLocalAnalysis._writeFlags(isGlobal, isScriptLocal)})`);
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        console.log(`Writing to ${name} (${ScriptLocalAnalysis._writeFlags(isGlobal, isScriptLocal)})`);
    }
}

// 向后兼容：当本文件被全局加载时，自动安装为分析
if (typeof J$ !== 'undefined') {
    J$.analysis = new ScriptLocalAnalysis();
}
