// JALANGI DO NOT INSTRUMENT
// @ts-check

/**
 * @file PreprocessPlugin.js — 预处理插件基类
 *
 * 所有预处理插件均继承此类，重写 apply(ast, babelApi) 方法。
 * apply 方法直接对 AST 做原地变换，返回变换统计信息。
 *
 * 插件 Pipeline：
 *   preprocessCode(code, options) 依次调用每个插件的 apply，
 *   所有插件共享同一个 AST（in-place 变换），最终用 @babel/generator 生成代码。
 *
 * 内置插件（均在 plugins/ 子目录中）：
 *   - DeobfuscatePlugin    反混淆：逗号表达式拆分、void 0 替换、常量折叠等
 *   - TranspilePlugin      语法降级：@babel/preset-env 将 ESNext 转为目标版本
 */

export class PreprocessPlugin {
    /**
     * @param {string} name       插件名称（用于日志）
     * @param {object} [options]  插件自定义选项
     */
    constructor(name, options = {}) {
        this.name    = name;
        this.options = options;
    }

    /**
     * 对 AST 执行变换（原地修改）。
     *
     * @param {import('@babel/types').File} ast      Babel File AST（babelParser.parse 返回值）
     * @param {object}                      babelApi 传入的 Babel API 对象 { traverse, types, generator }
     * @returns {{ [stat: string]: number }} 统计信息，如 { sequenceSplit: 42, voidReplaced: 7 }
     */
    // eslint-disable-next-line no-unused-vars
    apply(ast, babelApi) {
        throw new Error(`PreprocessPlugin.apply() 未实现：${this.name}`);
    }

    toString() {
        return `[PreprocessPlugin:${this.name}]`;
    }
}
