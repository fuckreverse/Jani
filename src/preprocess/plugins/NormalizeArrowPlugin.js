// JALANGI DO NOT INSTRUMENT
// @ts-check

/**
 * @file NormalizeArrowPlugin.js — 箭头函数标准化插件
 *
 * 将**百分百安全**的箭头函数转换为等价的普通 `function` 表达式，
 * 使插桩器能为其注入 `J$.Fe` / `J$.Fx`（functionEnter / functionExit）钩子。
 *
 * ## 动机
 *
 * Jani 插桩器对 `ArrowFunctionExpression` 有以下已知限制：
 *   - 不注入 `J$.Fe` / `J$.Fx`（因为箭头函数没有独立的 arguments / this / callee）
 *   - 不添加 try-catch 包裹（会改变表达式体箭头函数的 return 语义）
 *
 * 这意味着箭头函数内部的异常无法被 `J$.Ex` 捕获，
 * 分析插件也收不到 `functionEnter` / `functionExit` 回调，
 * 导致跨函数数据流追踪出现盲区。
 *
 * 预处理将满足条件的箭头函数转为普通函数，可以完全消除这一盲区。
 *
 * ## 安全条件（全部满足才转换）
 *
 * 转换会**严格跳过**以下任意一种情况：
 *
 * 1. **函数体内引用了 `this`**
 *    箭头函数的 `this` 来自外层词法作用域；普通函数的 `this` 由调用方式决定。
 *    一旦转换，`this` 的指向会从"外层对象"变成"调用时的对象或 undefined"，语义破坏。
 *
 * 2. **函数体内引用了 `arguments`**
 *    箭头函数没有自己的 `arguments`，访问的是外层函数的 `arguments`。
 *    转换为普通函数后，`arguments` 变为自身的（空对象或调用时的参数），语义破坏。
 *
 * 3. **函数体内引用了 `super`**
 *    箭头函数的 `super` 来自外层词法作用域（通常是类方法）；
 *    普通函数没有词法 `super`，转换后引用 `super` 会报语法/运行时错误。
 *
 * 4. **函数体内引用了 `new.target`**
 *    箭头函数的 `new.target` 透传自外层；普通函数有自己的 `new.target`（通常为 undefined）。
 *
 * 5. **箭头函数位于类体内（ClassMethod / ClassProperty 等）**
 *    即使箭头函数体内本身不含 `this`，类体内的 `this` 是隐式的，
 *    且可能有 `super` 方法调用。类体内的箭头→函数转换需要额外分析，保守拒绝。
 *
 * 6. **async 箭头函数**
 *    async 转换需要 regenerator-runtime，不在本插件范围内；
 *    TranspilePlugin 可处理 async 语法降级。
 *
 * 7. **生成器箭头函数**（理论上不存在，ES 规范不允许，防御性处理）
 *
 * ## 转换规则
 *
 * | 箭头形式 | 转换为 |
 * |---------|--------|
 * | `x => expr`（表达式体）| `function(x) { return expr; }` |
 * | `(x, y) => { stmts }` | `function(x, y) { stmts }` |
 * | 带默认参数/解构参数 | 参数原样保留，仅改变函数类型 |
 *
 * 函数名（`id`）保持为 `null`——箭头函数本来就没有名字。
 *
 * ## 统计输出
 *
 * 返回 `{ arrowNormalized: number }` 表示成功转换的箭头函数数量。
 */

import { PreprocessPlugin } from '../PreprocessPlugin.js';

export class NormalizeArrowPlugin extends PreprocessPlugin {
    /**
     * @param {object} [options]
     * @param {boolean} [options.includeAsync=false]
     *   是否尝试转换 async 箭头函数。
     *   **注意**：async 箭头转 async function 在语义上是安全的（async function 也有词法 this 问题，
     *   但 async 的特性本身不变），仅转换形式。默认关闭，因为插桩器对 async function 有额外逻辑，
     *   若后续插桩不支持 async function 的某些模式则可能引入问题。
     *   通常只在明确知道目标代码需要 functionEnter/Exit 且不用 TranspilePlugin 时才开启。
     */
    constructor(options = {}) {
        super('NormalizeArrowPlugin', options);
        this.includeAsync = options.includeAsync ?? false;
    }

    /**
     * @param {import('@babel/types').File} ast
     * @param {{ traverse: Function, types: any }} babelApi
     */
    apply(ast, babelApi) {
        const { traverse, types: t } = babelApi;
        let arrowNormalized = 0;
        const includeAsync = this.includeAsync;  // 闭包捕获，避免 visitor 内 this 不是插件实例

        traverse(ast, {
            ArrowFunctionExpression: {
                exit(path) {
                    const node = path.node;

                    // ── 排除1：async 箭头（默认不处理）──────────────────────────
                    if (node.async && !includeAsync) return;

                    // ── 排除2：生成器（理论上不可能，防御性处理）──────────────
                    if (node.generator) return;

                    // ── 排除3：位于类体内（ClassMethod / ClassProperty / static block）
                    if (_isInsideClassBody(path)) return;

                    // ── 排除4-7：体内含危险绑定引用 ──────────────────────────
                    // 需要检查的是箭头函数体，对于表达式体和块体均适用。
                    const body = node.body;
                    if (_containsThis(body))      return;
                    if (_containsArguments(body)) return;
                    if (_containsSuper(body))     return;
                    if (_containsNewTarget(body)) return;

                    // ── 安全，执行转换 ────────────────────────────────────────

                    // 表达式体 `x => expr` → 块体 `function(x) { return expr; }`
                    let newBody;
                    if (t.isBlockStatement(body)) {
                        newBody = body;
                    } else {
                        // 表达式体：包裹成 `return expr;`
                        newBody = t.blockStatement([
                            t.returnStatement(body),
                        ]);
                    }

                    const funcExpr = t.functionExpression(
                        null,           // id：箭头函数本来无名
                        node.params,    // 参数原样保留
                        newBody,
                        node.generator, // false
                        node.async,     // 保留 async 标志（若 includeAsync=true）
                    );

                    // 保留原始位置信息（供 source map 使用）
                    funcExpr.loc   = node.loc;
                    funcExpr.start = node.start;
                    funcExpr.end   = node.end;

                    path.replaceWith(funcExpr);
                    arrowNormalized++;
                },
            },
        });

        return { arrowNormalized };
    }
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

/**
 * 函数边界节点类型集合。
 * 遍历检查时遇到这些类型则停止深入（它们有独立的词法绑定）。
 */
const FUNCTION_BOUNDARY = new Set([
    'FunctionExpression',
    'FunctionDeclaration',
    'ArrowFunctionExpression',  // 嵌套箭头函数也是边界（有自己的 this/arguments 绑定链）
    'ObjectMethod',
    'ClassMethod',
]);

/**
 * 递归遍历节点，不进入嵌套函数边界。
 * 遇到满足 predicate(node)=true 的节点时立即返回 true。
 *
 * @param {object}   node       起始 AST 节点
 * @param {Function} predicate  `(node) => boolean`
 * @returns {boolean}
 */
function _walk(node, predicate) {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(child => _walk(child, predicate));

    if (predicate(node)) return true;

    // 遇到嵌套函数边界，停止深入（这些节点内的 this/arguments/super 是属于它们自己的）
    // 注意：ArrowFunctionExpression 也在边界列表中，但这里检查的是"嵌套的"箭头函数，
    //       而外层的箭头函数由 traverse visitor 处理，不会在这里被 _walk 遇到。
    if (FUNCTION_BOUNDARY.has(node.type)) return false;

    return Object.values(node).some(child =>
        child && typeof child === 'object' ? _walk(child, predicate) : false
    );
}

/**
 * 检查节点内（不进入嵌套函数）是否含有 `this` 引用。
 * @param {object} node
 * @returns {boolean}
 */
function _containsThis(node) {
    return _walk(node, n => n.type === 'ThisExpression');
}

/**
 * 检查节点内（不进入嵌套函数）是否含有 `arguments` 标识符引用。
 *
 * 注意：只检查"作为引用出现的 arguments"，而不是形参名叫 arguments 的情况
 * （形参叫 arguments 时会被 scope.js 重命名，这里不需要特殊处理）。
 *
 * @param {object} node
 * @returns {boolean}
 */
function _containsArguments(node) {
    return _walk(node, n =>
        n.type === 'Identifier' && n.name === 'arguments'
    );
}

/**
 * 检查节点内（不进入嵌套函数）是否含有 `super` 关键字引用。
 * 覆盖 `super.method()` 和 `super()` 两种形式。
 * @param {object} node
 * @returns {boolean}
 */
function _containsSuper(node) {
    return _walk(node, n => n.type === 'Super');
}

/**
 * 检查节点内（不进入嵌套函数）是否含有 `new.target` 引用。
 * Babel 中 `new.target` 表示为 `MetaProperty { meta: 'new', property: 'target' }`。
 * @param {object} node
 * @returns {boolean}
 */
function _containsNewTarget(node) {
    return _walk(node, n =>
        n.type === 'MetaProperty' &&
        n.meta?.name === 'new' &&
        n.property?.name === 'target'
    );
}

/**
 * 检查箭头函数 path 是否位于类体内部（ClassMethod / ClassProperty / StaticBlock 等）。
 *
 * 策略：向上遍历 parentPath，若在遇到任何"类相关父节点"之前未遇到函数边界，则认为在类体内。
 * 遇到函数边界（FunctionExpression / FunctionDeclaration / ArrowFunctionExpression 的外层 path）
 * 则认为已经脱离类体，不需要保守拒绝。
 *
 * @param {import('@babel/traverse').NodePath} arrowPath
 * @returns {boolean}
 */
function _isInsideClassBody(arrowPath) {
    let current = arrowPath.parentPath;
    while (current) {
        const type = current.node?.type;
        // 遇到类相关节点 → 在类体内
        if (
            type === 'ClassMethod'      ||
            type === 'ClassPrivateMethod' ||
            type === 'ClassProperty'    ||
            type === 'ClassPrivateProperty' ||
            type === 'StaticBlock'      ||
            type === 'ClassDeclaration' ||
            type === 'ClassExpression'
        ) {
            return true;
        }
        // 遇到函数边界 → 已经离开直接的类体上下文，停止向上查找
        if (
            type === 'FunctionExpression'  ||
            type === 'FunctionDeclaration' ||
            type === 'ObjectMethod'
            // 注意：不在这里列入 ArrowFunctionExpression，
            // 因为我们正在处理的就是箭头函数，其 parentPath 不会是自身
        ) {
            return false;
        }
        current = current.parentPath;
    }
    return false;
}
