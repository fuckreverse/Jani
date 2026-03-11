// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

/**
 * @file dataflow.js — 静态 def-use 分析模块（基于 @babel/traverse）。
 *
 * 在插桩的第 0 个 pass（addScopes 之后、transformAst 之前）对原始 AST 做
 * 数据流分析，输出 **插桩决策表**（`Map<nodeKey, Decision>`），供后续 pass
 * 在 `instrumentLoad` 中查表以决定插桩级别：
 *
 * - `'full'`        — 生成全量 `J$.R(iid, name, val, flags, scopeId)` 钩子
 * - `'lightweight'` — 生成轻量 `J$.Rl(iid, defScopeId, name)` 钩子
 * - `'dead'`        — 该读取完全可省略（保留供未来扩展）
 *
 * ### 与旧版相比的改进
 *
 * 旧版 `dataflow.js` 使用自定义 `_walkNode` 遍历，并手动重复了
 * `astUtil.js` 中 400+ 行的 IGNORE 上下文判断逻辑。
 *
 * 新版使用 `@babel/traverse`：
 * - 用 `path.isReferencedIdentifier()` 替代手写的 `_isIgnoreContext`
 * - 用 `path.scope.getBinding()` 和 `binding.constant` 替代手写的 def-site 分析
 * - 彻底消除与 `astUtil.js` 的代码重复
 *
 * ### nodeKey 格式
 *
 * `${scopeId}:${name}:${line}:${col}`（基于 Babel AST 节点的 `.loc.start`）
 * 其中 `scopeId` 来自 `addScopes` 附加到节点上的 `Jalangi Scope` 对象
 *
 * @module dataflow
 */

// @ts-ignore — @babel/traverse 是 CJS 模块，类型定义不包含 .default，运行时需取 .default
import _babelTraverse from '@babel/traverse';
const babelTraverse = /** @type {any} */ (_babelTraverse).default ?? _babelTraverse;

// ── 决策枚举 ──────────────────────────────────────────────────────────────────

/**
 * 插桩决策枚举。
 * - `FULL`        — 全量插桩（J$.R，包含实际值）
 * - `LIGHTWEIGHT` — 轻量插桩（J$.Rl，不传值，从 Shadow Frame 查）
 * - `DEAD`        — 可完全省略（当前保守实现不使用此值，保留供未来扩展）
 */
export const Decision = Object.freeze({
    FULL:        'full',
    LIGHTWEIGHT: 'lightweight',
    DEAD:        'dead',        // 保留，当前不生成
});

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 对 addScopes 之后的 Program 节点做静态 def-use 分析，返回插桩决策表。
 *
 * 每个 use-site（Identifier 出现在 RHS 上下文的位置）对应一条决策。
 * 键格式：`${scopeId}:${name}:${line}:${col}`（基于 Babel AST 位置信息）。
 *
 * @param {object} ast  Babel Program 节点（已经过 addScopes 处理，含 .scope 字段）
 * @returns {Map<string, string>}  插桩决策表
 */
export function analyzeDefUse(ast) {
    const decisions = new Map();

    // 包一层 File 节点（@babel/traverse 需要 File 根节点）
    const fileNode = (ast.type === 'File')
        ? ast
        : { type: 'File', program: ast, errors: [] };

    babelTraverse(fileNode, {
        Identifier(path) {
            // 只处理 RHS（读取）上下文的 Identifier
            if (!path.isReferencedIdentifier()) return;

            const node = path.node;
            const name = node.name;

            // 跳过特殊标识符（undefined / NaN / Infinity 由 wrappers 单独处理）
            if (name === 'undefined' || name === 'NaN' || name === 'Infinity') return;

            // 找到最近的产生 Jalangi Scope 的祖先节点
            const jalScope = _findJalScope(path);
            if (!jalScope) return;  // 无法确定作用域，安全退出

            const scopeId = jalScope.id;

            // 利用 Babel path.scope.getBinding() 获取该标识符的绑定信息
            // getBinding 沿作用域链向上查找，返回最近的绑定
            const binding = path.scope.getBinding(name);

            // 生成 nodeKey（与 wrappers.js 中的查询逻辑保持一致）
            const loc = node.loc?.start;
            const key = `${scopeId}:${name}:${loc?.line ?? 0}:${loc?.column ?? 0}`;

            // ── 决策逻辑 ──────────────────────────────────────────────────────

            // 无绑定 → 全局变量 → 全量
            if (!binding) {
                decisions.set(key, Decision.FULL);
                return;
            }

            // 检查 Jalangi Scope 的 eval/with 污染状态
            // （由 addScopes 在 pre-pass 中传播给整条作用域链）
            if (jalScope.usesEval() || jalScope.usesWith()) {
                decisions.set(key, Decision.FULL);
                return;
            }

            // 箭头函数作用域：不注入 Fe/Fr，Shadow Frame 不会初始化形参
            // 因此箭头函数的参数必须走全量路径
            if (jalScope.isArrow && _isParamOfScope(name, jalScope)) {
                decisions.set(key, Decision.FULL);
                return;
            }

            // catch 变量：语义特殊（可能被引擎静默修改），走全量
            if (jalScope.hasOwnVar(name) === 'catch') {
                decisions.set(key, Decision.FULL);
                return;
            }

            // arguments：语义特殊，走全量
            if (name === 'arguments') {
                decisions.set(key, Decision.FULL);
                return;
            }

            // ── 利用 Babel Binding 信息决策 ──────────────────────────────────

            // 首先检查对象属性 mutation（对 obj 的属性写入），
            // 这必须在 binding.constant 检查之前进行，因为：
            //   var obj = {};  obj.x = 1;
            // 中 binding.constant === true（obj 本身未被重赋值），
            // 但 obj 指向的对象有属性变化，轻量路径无法感知，必须全量。
            const hasMutation = _checkMutation(binding);
            if (hasMutation) {
                decisions.set(key, Decision.FULL);
                return;
            }

            // Q-3 修复：无论 binding.constant 是 true 还是 false，
            // 只要没有属性 mutation（已在上方排除），都走轻量路径（Rl/Shadow Frame）。
            // Shadow Frame 对重赋值也能正确追踪，因此两个分支可合并为无条件赋值。
            decisions.set(key, Decision.LIGHTWEIGHT);
        },
    });

    return decisions;
}

// ── 语句级 use-set 分析 ────────────────────────────────────────────────────────

/**
 * 对 addScopes 之后的 Program 节点做语句级 use-set 分析。
 *
 * 遍历所有 ExpressionStatement，收集该语句中读取的变量列表（名称 + defScopeId）。
 * 结果以语句节点对象本身为 key，存储在返回的 WeakMap 中（避免额外的字符串化开销）。
 *
 * 返回格式：
 *   WeakMap<ExpressionStatementNode, { names: string[], scopes: number[] }>
 *   - names：变量名数组（去重，按首次出现顺序）
 *   - scopes：对应 defScopeId 数组（-1 表示全局变量，无 Shadow Frame）
 *
 * 过滤规则（与 analyzeDefUse 一致）：
 *   - 跳过 undefined / NaN / Infinity（特殊字面量）
 *   - 跳过 J$ 运行时变量自身
 *
 * @param {object} ast        Babel Program/File 节点（已经过 addScopes 处理）
 * @param {string} jalangiVar J$ 运行时变量名（避免收集自身引用）
 * @returns {WeakMap<object, {names: string[], scopes: number[]}>}
 */
export function analyzeStmtUse(ast, jalangiVar) {
    const result = new WeakMap();

    const fileNode = (ast.type === 'File')
        ? ast
        : { type: 'File', program: ast, errors: [] };

    babelTraverse(fileNode, {
        ExpressionStatement: {
            enter(stmtPath) {
                // 在进入 ExpressionStatement 时，扫描该语句子树中所有被引用的 Identifier
                const names  = [];
                const scopes = [];
                const seen   = new Set();

                stmtPath.traverse({
                    Identifier(idPath) {
                        // 只处理 RHS（读取）上下文的 Identifier
                        if (!idPath.isReferencedIdentifier()) return;

                        const node = idPath.node;
                        const name = node.name;

                        // 跳过特殊标识符
                        if (name === 'undefined' || name === 'NaN' || name === 'Infinity') return;
                        if (name === jalangiVar) return;

                        // 去重（同一语句中多次读取同一变量，只记录一次）
                        if (seen.has(name)) return;
                        seen.add(name);

                        // 找到定义该变量的 Jalangi Scope
                        const jalScope = _findJalScope(idPath);
                        if (!jalScope) return;

                        const binding   = idPath.scope.getBinding(name);
                        const defScope  = binding ? _findDefJalScope(idPath, name) : null;

                        // 全局变量 defScopeId = -1（不在 Shadow Frame 里）
                        const defScopeId = defScope ? defScope.id : -1;

                        names.push(name);
                        scopes.push(defScopeId);
                    },
                });

                if (names.length > 0) {
                    result.set(stmtPath.node, { names, scopes });
                }
            },
        },
    });

    return result;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 从当前 path 向上查找，找到最近的带有 Jalangi Scope（.scope 属性）的 AST 节点。
 * 这些节点由 addScopes 在 pre-pass 中附加。
 *
 * @param {import('@babel/traverse').NodePath} path
 * @returns {import('./scope.js').Scope|null}  Jalangi Scope 对象，或 null
 */
function _findJalScope(path) {
    let cur = /** @type {any} */ (path);
    while (cur) {
        const node = cur.node;
        if (node && node.scope) return node.scope;
        cur = cur.parentPath;
    }
    return null;
}

/**
 * 沿 Babel 作用域链向上查找定义了变量 `name` 的 Jalangi Scope。
 *
 * 与 wrappers.js 中的 `_findDefScope` 逻辑对应：
 * 先找到最近的 Jalangi Scope，再沿 jalScope.parent 向上查，直到找到 hasOwnVar(name) 非 null 的 Scope。
 *
 * @param {import('@babel/traverse').NodePath} path  Identifier 的 path
 * @param {string} name                              变量名
 * @returns {import('./scope.js').Scope|null}
 */
function _findDefJalScope(path, name) {
    let scope = _findJalScope(path);
    while (scope) {
        if (scope.hasOwnVar(name) !== null) return scope;
        scope = scope.parent ?? null;
    }
    return null;
}

/**
 * 判断变量名是否是该 Jalangi Scope 的箭头函数参数。
 * 用于确保箭头函数参数走全量路径（Shadow Frame 不为箭头函数创建帧）。
 *
 * @param {string} name
 * @param {object} jalScope  Jalangi Scope 对象
 * @returns {boolean}
 */
function _isParamOfScope(name, jalScope) {
    return jalScope.hasOwnVar(name) === 'arg';
}

/**
 * 检查一个绑定是否存在对象属性 mutation。
 *
 * 对象属性 mutation 是指：有代码对以该变量为 object 的 MemberExpression 做写入。
 * 覆盖以下形式：
 *  - `obj.prop = val`  / `obj[key] = val`   — AssignmentExpression
 *  - `obj.prop++`      / `++obj.prop`        — UpdateExpression
 *  - `obj.prop += val` / `obj.prop -= val`   — AssignmentExpression（复合赋值，left 为 MemberExpression）
 *
 * 在这种情况下，轻量路径（J$.Rl）只能感知变量引用本身的变化，
 * 无法感知到属性层面的变化，因此必须走全量路径（J$.R）。
 *
 * BUG-4 修复：原实现只检测 AssignmentExpression.left 为 MemberExpression 的情形，
 * 遗漏了 UpdateExpression（`++obj.prop`）形式的属性 mutation。
 * 现在同时检测 UpdateExpression.argument 是 MemberExpression.object 的情形。
 *
 * @param {import('@babel/traverse').Binding} binding
 * @returns {boolean}
 */
function _checkMutation(binding) {
    for (const refPath of (binding.referencePaths ?? [])) {
        const parent = refPath.parent;
        const parentPath = refPath.parentPath;
        if (!parent || !parentPath) continue;

        // 检查：refPath 是 MemberExpression.object
        if (parent.type === 'MemberExpression' && parent.object === refPath.node) {
            const grandParent = parentPath.parent;
            if (!grandParent) continue;

            // 形式 1：obj.prop = val（含复合赋值 obj.prop += val）
            if (grandParent.type === 'AssignmentExpression'
                    && grandParent.left === parent) {
                return true;
            }

            // 形式 2：++obj.prop / obj.prop++
            if (grandParent.type === 'UpdateExpression'
                    && grandParent.argument === parent) {
                return true;
            }
        }
    }
    return false;
}
