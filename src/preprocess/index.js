// JALANGI DO NOT INSTRUMENT
// @ts-check

/**
 * @file src/preprocess/index.js — 预处理模块统一入口
 *
 * 提供 preprocessCode(code, options) 函数，将若干预处理插件
 * 组成 pipeline，依次对代码做 AST 级变换，输出处理后的代码。
 *
 * 内置插件：
 *   - 'deobfuscate'  反混淆（默认开启）
 *   - 'transpile'    Babel 语法降级（可选，需指定 targets）
 *
 * 用法示例：
 *   import { preprocessCode, DeobfuscatePlugin, TranspilePlugin } from './src/preprocess/index.js';
 *
 *   // 方式一：使用预设 preset（内置组合）
 *   const result = preprocessCode(code, { preset: 'deobfuscate' });
 *
 *   // 方式二：手动组合插件
 *   const result = preprocessCode(code, {
 *     plugins: [
 *       new DeobfuscatePlugin({ splitSequence: true, foldConstants: true }),
 *       new TranspilePlugin({ targets: 'defaults, not IE 11' }),
 *     ],
 *   });
 *
 *   result.code      // 处理后的代码字符串
 *   result.stats     // 各插件统计信息 { pluginName: { stat: count } }
 *   result.warnings  // 警告列表
 */

import * as babelParser from '@babel/parser';
import _babelGenerate   from '@babel/generator';
import _babelTraverse   from '@babel/traverse';
const babelGenerate = /** @type {any} */ (_babelGenerate).default ?? _babelGenerate;
const babelTraverse = /** @type {any} */ (_babelTraverse).default ?? _babelTraverse;

import { PreprocessPlugin }    from './PreprocessPlugin.js';
import { DeobfuscatePlugin }   from './plugins/DeobfuscatePlugin.js';
import { TranspilePlugin }     from './plugins/TranspilePlugin.js';
import { NormalizeArrowPlugin } from './plugins/NormalizeArrowPlugin.js';

// ── 共享 babelApi 对象（传入所有插件）────────────────────────────────────────
const babelApi = { traverse: babelTraverse, types: null, generator: babelGenerate };
// @babel/types 按需懒加载
let _babelTypes = null;
async function getBabelTypes() {
    if (!_babelTypes) _babelTypes = (await import('@babel/types'));
    return _babelTypes;
}

// ── 内置 preset（插件组合快捷方式）────────────────────────────────────────────

/**
 * 根据 preset 名称构建插件列表。
 * @param {string} preset
 * @param {object} options
 * @returns {PreprocessPlugin[]}
 */
function buildPreset(preset, options = {}) {
    switch (preset) {
        case 'deobfuscate':
            return [new DeobfuscatePlugin(options.deobfuscate ?? {})];

        case 'transpile':
            return [new TranspilePlugin(options.transpile ?? {})];

        case 'normalize-arrow':
            return [new NormalizeArrowPlugin(options.normalizeArrow ?? {})];

        case 'full':
            return [
                new NormalizeArrowPlugin(options.normalizeArrow ?? {}),
                new DeobfuscatePlugin(options.deobfuscate ?? {}),
                new TranspilePlugin(options.transpile ?? {}),
            ];

        default:
            throw new Error(`未知 preset: "${preset}"，可用值: deobfuscate | transpile | normalize-arrow | full`);
    }
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 对 JS 代码执行预处理 pipeline。
 *
 * @param {string} code     原始 JS 代码
 * @param {object} options
 * @param {string} [options.preset]       预设名称（deobfuscate | transpile | full | normalize-arrow）
 * @param {PreprocessPlugin[]}  [options.plugins]      手动指定插件列表（与 preset 互斥，plugins 优先）
 * @param {object}              [options.deobfuscate]  DeobfuscatePlugin 选项（配合 preset 使用）
 * @param {object}              [options.transpile]    TranspilePlugin 选项（配合 preset 使用）
 * @param {'script'|'module'}   [options.sourceType='script']  代码类型
 * @param {boolean}             [options.comments=true]        是否保留注释
 * @param {boolean}             [options.compact=false]        输出是否紧凑（不换行）
 * @returns {{ code: string, stats: object, warnings: string[] }}
 */
export async function preprocessCode(code, options = {}) {
    const {
        preset,
        plugins: customPlugins,
        sourceType = 'script',
        comments   = true,
        compact    = false,
    } = options;

    // 选取插件列表
    let plugins;
    if (customPlugins && customPlugins.length > 0) {
        plugins = customPlugins;
    } else if (preset) {
        plugins = buildPreset(preset, options);
    } else {
        // 默认只做反混淆
        plugins = [new DeobfuscatePlugin()];
    }

    // 注入 types（懒加载）
    babelApi.types = await getBabelTypes();

    const warnings = [];
    const stats    = {};

    // ── 解析 ──────────────────────────────────────────────────────────────────
    let ast;
    try {
        ast = babelParser.parse(code, {
            sourceType,
            allowReturnOutsideFunction: true,
            allowSuperOutsideMethod:    true,
            allowUndeclaredExports:     true,
            errorRecovery:              true,
            plugins: [
                'jsx',
                'typescript',
                'decorators-legacy',
                'classProperties',
                'classPrivateProperties',
                'classPrivateMethods',
                'dynamicImport',
                'importMeta',
                'exportDefaultFrom',
                'exportNamespaceFrom',
                'asyncGenerators',
                'bigInt',
                'optionalChaining',
                'nullishCoalescingOperator',
                'numericSeparator',
                'logicalAssignment',
                'objectRestSpread',
            ],
        });
    } catch (err) {
        throw new Error(`预处理：解析失败 — ${err.message}`);
    }

    // 收集解析警告
    if (ast.errors && ast.errors.length > 0) {
        for (const e of ast.errors) {
            warnings.push(`解析警告 [${e.loc?.line}:${e.loc?.column}]: ${e.reasonCode ?? e.message}`);
        }
    }

    // ── 依次执行插件 ──────────────────────────────────────────────────────────
    for (const plugin of plugins) {
        if (!(plugin instanceof PreprocessPlugin)) {
            warnings.push(`跳过非法插件：${plugin}（不是 PreprocessPlugin 实例）`);
            continue;
        }
        try {
            const pluginStats = await plugin.apply(ast, babelApi);
            stats[plugin.name] = pluginStats ?? {};
        } catch (err) {
            warnings.push(`插件 ${plugin.name} 执行失败：${err.message}`);
        }
    }

    // ── 生成代码 ──────────────────────────────────────────────────────────────
    const genResult = babelGenerate(ast, {
        comments,
        compact,
        concise:      false,
        jsescOption:  { minimal: true },
    });

    return {
        code:     genResult.code,
        stats,
        warnings,
    };
}

// ── 导出 ──────────────────────────────────────────────────────────────────────
export { PreprocessPlugin }    from './PreprocessPlugin.js';
export { DeobfuscatePlugin }   from './plugins/DeobfuscatePlugin.js';
export { TranspilePlugin }     from './plugins/TranspilePlugin.js';
export { NormalizeArrowPlugin } from './plugins/NormalizeArrowPlugin.js';
