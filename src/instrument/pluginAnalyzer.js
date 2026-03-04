// JALANGI DO NOT INSTRUMENT

/**
 * @file pluginAnalyzer.js — 插件静态分析器 + 按需 Config 生成器
 *
 * 对外导出两个函数：
 *
 *   analyzePluginHooks(pluginPaths)
 *     读取一组插件 JS 文件（或已加载的插件对象），
 *     返回这些插件实际定义的钩子方法名集合 Set<string>。
 *
 *   buildConfigFromHooks(usedHooks)
 *     接受 Hook 名称集合，返回一个 Jalangi Config 对象，
 *     只开启需要的 INSTR_* 字段，其余设为 () => false（禁用）。
 *
 * 同时导出两者的组合快捷函数：
 *   buildConfigFromPlugins(pluginPaths)
 */

import * as babelParser from '@babel/parser';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, DOMAIN } from '../logger/logger.js';

const log = createLogger(DOMAIN.INSTRUMENT);

// ─── 所有已知 Hook 名称 ────────────────────────────────────────────────────────

/**
 * AnalysisTemplate 中定义的全部 Hook 方法名（按名称排序）。
 * 凡是出现在插件中的方法名，都视为"使用了该 Hook"。
 */
export const ALL_HOOKS = new Set([
    'invokeFunPre',
    'invokeFun',
    'literal',
    'forinObject',
    'declare',
    'getFieldPre',
    'getField',
    'putFieldPre',
    'putField',
    'read',
    'write',
    '_return',
    '_throw',
    '_with',
    'functionEnter',
    'functionExit',
    'scriptEnter',
    'scriptExit',
    'binaryPre',
    'binary',
    'unaryPre',
    'unary',
    'conditional',
    'instrumentCodePre',
    'instrumentCode',
    'endExpression',
    'endExecution',
    'runInstrumentedFunctionBody',
    'onReady',
]);

// ─── Hook → Config 字段的映射关系 ─────────────────────────────────────────────

/**
 * 每个 Hook 需要开启哪些 Config 字段。
 * 数组中多个字段表示"都需要开启"（任意一个控制了该 Hook 的插桩）。
 *
 * Config 字段为 null 表示"全部插桩"；() => false 表示"完全禁用"。
 * 此映射表中列出的字段，当对应 Hook 被使用时会被设为 null（开启），
 * 否则设为 () => false（关闭）。
 */
const HOOK_TO_CONFIG_FIELDS = {
    // 函数调用
    invokeFunPre:   ['INSTR_INVOKE'],
    invokeFun:      ['INSTR_INVOKE'],

    // 字面量
    literal:        ['INSTR_LITERAL'],

    // for-in
    forinObject:    ['INSTR_FORIN'],

    // 变量声明
    declare:        ['INSTR_INIT', 'INSTR_TRY_CATCH_ARGUMENTS'],

    // 属性访问
    getFieldPre:    ['INSTR_GETFIELD'],
    getField:       ['INSTR_GETFIELD'],
    putFieldPre:    ['INSTR_PUTFIELD'],
    putField:       ['INSTR_PUTFIELD'],

    // 变量读写
    read:           ['INSTR_READ'],
    write:          ['INSTR_WRITE'],

    // 控制流
    _return:        ['INSTR_RETURN'],
    _throw:         ['INSTR_THROW'],
    _with:          ['INSTR_CONDITIONAL'],

    // 函数进出（functionEnter/Exit 需要 try-catch 包裹 + arguments 声明两者）
    functionEnter:  ['INSTR_TRY_CATCH_ARGUMENTS'],
    functionExit:   ['INSTR_TRY_CATCH_ARGUMENTS'],

    // 脚本进出
    scriptEnter:    ['INSTR_TRY_CATCH_ARGUMENTS'],
    scriptExit:     ['INSTR_TRY_CATCH_ARGUMENTS'],

    // 运算
    binaryPre:      ['INSTR_BINARY'],
    binary:         ['INSTR_BINARY'],
    unaryPre:       ['INSTR_UNARY'],
    unary:          ['INSTR_UNARY'],
    conditional:    ['INSTR_CONDITIONAL'],

    // eval 插桩（instrumentCodePre/Code 始终由 eval 调用触发，不受 Config 控制，此处不映射）
    instrumentCodePre: [],
    instrumentCode:    [],

    // 表达式末尾标记
    endExpression:  ['INSTR_END_EXPRESSION'],

    // 以下钩子不需要插桩支持（纯运行时事件），不映射 Config 字段
    endExecution:              [],
    runInstrumentedFunctionBody: [],
    onReady:                   [],
};

/**
 * 所有可被关闭的 Config 字段集合（通过此表可知哪些可以被禁用）。
 */
export const ALL_CONFIG_FIELDS = new Set([
    'INSTR_READ',
    'INSTR_WRITE',
    'INSTR_GETFIELD',
    'INSTR_PUTFIELD',
    'INSTR_BINARY',
    'INSTR_UNARY',
    'INSTR_LITERAL',
    'INSTR_INIT',
    'INSTR_CONDITIONAL',
    'INSTR_TRY_CATCH_ARGUMENTS',
    'INSTR_END_EXPRESSION',
    'INSTR_INVOKE',
    'INSTR_RETURN',
    'INSTR_THROW',
    'INSTR_FORIN',
]);

// ─── analyzePluginHooks：静态 AST 扫描 ───────────────────────────────────────

/**
 * 从文件路径列表（或插件对象列表）中提取使用的 Hook 名称集合。
 *
 * 支持两种输入：
 *   1. 字符串路径 → 读取文件并做静态 AST 扫描
 *   2. 对象实例   → 用 Object.getOwnPropertyNames 检查自身方法（运行时反射）
 *
 * @param {Array<string|object>} plugins - 插件路径字符串或已实例化的插件对象
 * @returns {Set<string>} 使用了哪些 Hook 方法名
 */
export function analyzePluginHooks(plugins) {
    const used = new Set();
    for (const plugin of plugins) {
        if (typeof plugin === 'string') {
            _scanFileForHooks(plugin, used);
        } else if (plugin && typeof plugin === 'object') {
            _scanObjectForHooks(plugin, used);
        }
    }
    return used;
}

/**
 * 静态扫描插件源文件，收集类/对象字面量中定义的 Hook 方法名。
 *
 * 策略：
 *  1. 解析为 Babel AST
 *  2. 遍历所有 ClassDeclaration / ClassExpression 的 ClassMethod（含 MethodDefinition）
 *  3. 遍历所有 ObjectExpression 的 ObjectMethod / Property（函数值）
 *  4. 方法名若在 ALL_HOOKS 中则记录
 */
function _scanFileForHooks(filePath, used) {
    let code;
    try {
        code = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        log.warn(`Cannot read plugin file: ${filePath} (${e.message})`);
        return;
    }

    let ast;
    try {
        ast = babelParser.parse(code, {
            sourceType: 'module',
            plugins: [
                'classProperties',
                'classPrivateProperties',
                'classPrivateMethods',
                'optionalChaining',
                'nullishCoalescingOperator',
                'dynamicImport',
            ],
        });
    } catch (e) {
        log.warn(`Parse error in plugin file: ${filePath} (${e.message})`);
        return;
    }

    _walkAst(ast, used);
}

/**
 * 深度遍历 AST 节点，提取所有可能是 Hook 的方法名。
 */
function _walkAst(node, used) {
    if (!node || typeof node !== 'object') return;

    // ClassMethod（Babel AST，对应 class { foo() {} }）
    if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
        const name = _getMethodName(node.key);
        if (name && ALL_HOOKS.has(name)) used.add(name);
    }

    // ObjectMethod（Babel AST，对应 { foo() {} }）
    if (node.type === 'ObjectMethod') {
        const name = _getMethodName(node.key);
        if (name && ALL_HOOKS.has(name)) used.add(name);
    }

    // ObjectProperty（对应 { foo: function() {} } 或 { foo: () => {} }）
    if (node.type === 'ObjectProperty') {
        const name = _getMethodName(node.key);
        if (name && ALL_HOOKS.has(name)) {
            const val = node.value;
            if (val && (val.type === 'FunctionExpression' || val.type === 'ArrowFunctionExpression')) {
                used.add(name);
            }
        }
    }

    // 递归遍历所有子节点
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) _walkAst(item, used);
        } else if (child && typeof child === 'object' && child.type) {
            _walkAst(child, used);
        }
    }
}

/**
 * 从 AST key 节点提取方法名字符串。
 * 支持 Identifier（foo）和 StringLiteral（'foo'）。
 */
function _getMethodName(keyNode) {
    if (!keyNode) return null;
    if (keyNode.type === 'Identifier') return keyNode.name;
    if (keyNode.type === 'StringLiteral') return keyNode.value;
    return null;
}

/**
 * 通过运行时反射从插件实例/类提取 Hook 方法名。
 *
 * 支持三种形式：
 *   1. Class 定义（函数）     → 遍历 prototype 链
 *   2. Class 实例            → 遍历原型链（跳过 Object.prototype）
 *   3. 普通对象字面量         → 检查对象自身属性
 *
 * 同时也会检查 usedHooks 静态声明（优先级最高）。
 *
 * @param {object|function} pluginOrClass - 插件实例、类或普通对象
 * @param {Set<string>} used
 */
function _scanObjectForHooks(pluginOrClass, used) {
    // 优先检查 usedHooks 显式声明（实例属性 / 类静态属性 / constructor 静态属性均可）
    const explicit = pluginOrClass.usedHooks
        ?? pluginOrClass.constructor?.usedHooks
        ?? (typeof pluginOrClass === 'function' ? pluginOrClass.usedHooks : null);
    if (Array.isArray(explicit)) {
        for (const h of explicit) {
            if (ALL_HOOKS.has(h)) used.add(h);
        }
        // 有显式声明时，以声明为准，不再做反射扫描
        return;
    }

    if (typeof pluginOrClass === 'function') {
        // 类定义（未实例化）：遍历 prototype 链
        let p = pluginOrClass.prototype;
        while (p && p !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(p)) {
                if (ALL_HOOKS.has(name)) used.add(name);
            }
            p = Object.getPrototypeOf(p);
        }
        return;
    }

    // 对象实例或普通对象字面量
    const proto = Object.getPrototypeOf(pluginOrClass);
    const isPlainObject = proto === Object.prototype || proto === null;

    if (isPlainObject) {
        // 普通对象字面量（如 { binary() {} }）：只检查自身属性
        for (const name of Object.getOwnPropertyNames(pluginOrClass)) {
            if (ALL_HOOKS.has(name) && typeof pluginOrClass[name] === 'function') {
                used.add(name);
            }
        }
    } else {
        // Class 实例：遍历原型链（跳过 Object.prototype）
        let p = proto;
        while (p && p !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(p)) {
                if (ALL_HOOKS.has(name)) used.add(name);
            }
            p = Object.getPrototypeOf(p);
        }
        // 同时检查实例自身覆盖的方法
        for (const name of Object.getOwnPropertyNames(pluginOrClass)) {
            if (ALL_HOOKS.has(name) && typeof pluginOrClass[name] === 'function') {
                used.add(name);
            }
        }
    }
}

// ─── buildConfigFromHooks：生成按需 Config ────────────────────────────────────

/**
 * 根据 Hook 使用集合构建 Jalangi Config 对象。
 *
 * 已使用的 Hook → 对应 Config 字段设为 null（全量插桩）。
 * 未使用的 Hook → 对应 Config 字段设为 () => false（完全禁用插桩）。
 *
 * @param {Set<string>} usedHooks - 从 analyzePluginHooks 返回的 Hook 名称集合
 * @returns {object} Jalangi Config 对象
 */
export function buildConfigFromHooks(usedHooks) {
    // 收集需要开启的 Config 字段
    const neededFields = new Set();
    for (const hook of usedHooks) {
        const fields = HOOK_TO_CONFIG_FIELDS[hook];
        if (fields) {
            for (const f of fields) neededFields.add(f);
        }
    }

    // 构建 Config：需要的字段设 null，不需要的设 () => false
    const config = { ENABLE_SAMPLING: false };
    for (const field of ALL_CONFIG_FIELDS) {
        config[field] = neededFields.has(field) ? null : () => false;
    }

    return config;
}

// ─── 快捷组合函数 ─────────────────────────────────────────────────────────────

/**
 * 分析插件 → 构建 Config 的一体化快捷函数。
 *
 * @param {Array<string|object>} plugins - 插件路径或实例列表
 * @returns {object} 按需 Config 对象
 *
 * @example
 * import { buildConfigFromPlugins } from './pluginAnalyzer.js';
 * const config = buildConfigFromPlugins(['./plugins/CheckNaN.js']);
 * init(config);
 * const result = instrumentCode({ code: src, ... });
 */
export function buildConfigFromPlugins(plugins) {
    if (!plugins || plugins.length === 0) {
        // 没有插件 → 返回全量插桩 Config（与旧行为一致）
        return _fullConfig();
    }
    const usedHooks = analyzePluginHooks(plugins);
    return buildConfigFromHooks(usedHooks);
}

/**
 * 返回全量插桩的 Config（所有字段均为 null，与旧版默认行为一致）。
 * @returns {object}
 */
export function fullConfig() {
    return _fullConfig();
}

function _fullConfig() {
    const config = { ENABLE_SAMPLING: false };
    for (const field of ALL_CONFIG_FIELDS) {
        config[field] = null;
    }
    return config;
}
