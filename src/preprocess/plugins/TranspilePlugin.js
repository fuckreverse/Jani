// JALANGI DO NOT INSTRUMENT
// @ts-check

/**
 * @file TranspilePlugin.js — Babel 语法降级预处理插件
 *
 * 使用 @babel/core + @babel/preset-env 将 ESNext / ES2022 代码
 * 降级为目标浏览器/Node.js 版本支持的语法，提升 Jalangi2 插桩的适用范围。
 *
 * 与普通 Babel 用法的不同：
 *   - 接受已解析的 Babel AST（不重复解析）
 *   - 变换后将结果 AST 合并回原 ast（in-place 替换 program.body）
 *   - 不依赖 .babelrc 或 babel.config.js，完全由代码控制
 *
 * 支持的降级变换（由 @babel/preset-env 控制）：
 *   - 箭头函数 → function
 *   - class 语法 → prototype
 *   - async/await → generator（需 regeneratorRuntime）
 *   - 可选链 (?.) → 三元展开
 *   - 空值合并 (??) → 短路或
 *   - 模板字符串 → 字符串拼接
 *   - 解构赋值 → 临时变量
 *   - 展开运算符 → apply/concat
 *   - for-of → 普通 for
 *   - 类私有字段 → WeakMap
 *   - 逻辑赋值 (&&=, ||=, ??=) → 展开形式
 *   … 及更多（取决于 targets）
 *
 * 注意事项：
 *   - async/await 降级需要 regenerator-runtime，默认不注入（可通过 useBuiltIns 控制）
 *   - 降级后代码行列信息与原始代码不同，若需精确 source map 应在降级前保留原始映射
 *   - 降级可能大幅增加代码量（class 展开尤为明显）
 *
 * 用法：
 *   new TranspilePlugin({ targets: 'defaults' })
 *   new TranspilePlugin({ targets: { node: '12' } })
 *   new TranspilePlugin({ targets: 'last 2 Chrome versions, not IE 11' })
 *   new TranspilePlugin({ targets: { ie: '11' } })    // 最大兼容
 */

import { PreprocessPlugin } from '../PreprocessPlugin.js';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { dirname }          from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// @babel/core 是 CJS 模块，通过 createRequire 加载
const _require = createRequire(import.meta.url);

export class TranspilePlugin extends PreprocessPlugin {
    /**
     * @param {object}  [options]
     * @param {string|object} [options.targets='defaults']
     *   Browserslist 字符串或对象，如：
     *     'defaults'
     *     'last 2 Chrome versions'
     *     { node: 'current' }
     *     { ie: '11' }
     *     { browsers: 'last 2 versions' }
     *
     * @param {boolean|'usage'|'entry'} [options.useBuiltIns=false]
     *   是否注入 polyfill：
     *     false  — 不注入任何 polyfill（默认，代码量最小）
     *     'usage' — 按需注入（需要 core-js）
     *     'entry' — 入口注入（需要 core-js）
     *
     * @param {string}  [options.corejs]
     *   core-js 版本，配合 useBuiltIns 使用（如 '3.38'）
     *
     * @param {boolean} [options.loose=false]
     *   宽松模式：生成更简单（但略有差异）的降级代码，代码量更小
     *
     * @param {string[]} [options.exclude]
     *   排除特定 transform，如 ['transform-async-to-generator']
     *   完整列表见 @babel/compat-data
     *
     * @param {string[]} [options.include]
     *   强制包含特定 transform（即使 targets 已原生支持）
     *
     * @param {boolean} [options.modules=false]
     *   是否将 ESM 模块语法转换（import/export → CommonJS/AMD/UMD 等）。
     *   false 保留 ESM，'commonjs' 转为 CJS。
     *   注：Jalangi2 已是 ESM 项目，一般保持 false。
     *
     * @param {boolean} [options.debug=false]
     *   输出 preset-env 选择了哪些 transform（方便调试）
     */
    constructor(options = {}) {
        super('TranspilePlugin', options);
        this.targets     = options.targets     ?? 'defaults';
        this.useBuiltIns = options.useBuiltIns ?? false;
        this.corejs      = options.corejs      ?? undefined;
        this.loose       = options.loose       ?? false;
        this.exclude     = options.exclude     ?? [];
        this.include     = options.include     ?? [];
        this.modules     = options.modules     ?? false;
        this.debugMode   = options.debug       ?? false;
    }

    /**
     * @param {import('@babel/types').File} ast
     * @param {{ traverse: Function, types: any, generator: Function }} babelApi
     */
    async apply(ast, babelApi) {
        const { generator } = babelApi;

        // 懒加载 @babel/core（它是 CJS，不可直接 import 到 ESM 顶层）
        const babel = _require('@babel/core');

        // 构建 preset-env 选项
        const presetEnvOptions = {
            targets:    this.targets,
            modules:    this.modules,
            loose:      this.loose,
            debug:      this.debugMode,
        };
        if (this.exclude.length)   presetEnvOptions.exclude = this.exclude;
        if (this.include.length)   presetEnvOptions.include = this.include;
        if (this.useBuiltIns)      presetEnvOptions.useBuiltIns = this.useBuiltIns;
        if (this.corejs)           presetEnvOptions.corejs = this.corejs;

        // 从 AST 生成代码（@babel/core.transformFromAst 需要源代码字符串）
        const { code: srcCode } = generator(ast, {
            comments:    true,
            compact:     false,
            jsescOption: { minimal: true },
        });

        // 使用 @babel/core 进行变换
        // transformFromAst 的第二个参数是"原始代码"（仅用于 source map）
        let result;
        try {
            result = babel.transformSync(srcCode, {
                babelrc:        false,
                configFile:     false,
                ast:            true,       // 返回变换后的 AST
                code:           false,      // 不需要代码字符串（后面用 generator 生成）
                presets: [
                    ['@babel/preset-env', presetEnvOptions],
                ],
                // 关闭 sourceMap（在 preprocess 阶段不需要，后续插桩会生成自己的 source map）
                sourceMaps:     false,
                // 关闭辅助函数内联（保持代码更简洁）
                // @babel/preset-env 默认会内联辅助函数，这里保持默认
                compact:        false,
                comments:       true,
            });
        } catch (err) {
            throw new Error(`TranspilePlugin: Babel 变换失败 — ${err.message}`);
        }

        if (!result || !result.ast) {
            throw new Error('TranspilePlugin: @babel/core 未返回 AST');
        }

        // 将变换后的 AST 内容合并回原来的 ast 对象（in-place 替换 program）
        // 这样 index.js 中后续调用 babelGenerate(ast, ...) 时拿到的就是降级后的 AST
        const newProgram = result.ast.program ?? result.ast;
        ast.program.body        = newProgram.body        ?? ast.program.body;
        ast.program.directives  = newProgram.directives  ?? ast.program.directives;
        ast.program.sourceType  = newProgram.sourceType  ?? ast.program.sourceType;

        // 统计变换了多少个顶层节点（粗略）
        const transformedNodes = (newProgram.body ?? []).length;

        return {
            transformedTopLevelNodes: transformedNodes,
            targets: JSON.stringify(this.targets),
        };
    }
}
