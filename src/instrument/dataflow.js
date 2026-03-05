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

import _babelTraverse from '@babel/traverse';
const babelTraverse = _babelTraverse.default ?? _babelTraverse;

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

            // binding.constant：该变量在其生命周期中是否从未被重赋值
            // binding.constantViolations.length === 0 等价于 constant === true
            if (binding.constant) {
                // 常量绑定且无属性 mutation：可以走轻量路径
                decisions.set(key, Decision.LIGHTWEIGHT);
                return;
            }

            // 有重赋值但无属性 mutation → 轻量路径（Shadow Frame 可感知重赋值）
            decisions.set(key, Decision.LIGHTWEIGHT);
        },
    });

    return decisions;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 从当前 path 向上查找，找到最近的带有 Jalangi Scope（.scope 属性）的 AST 节点。
 * 这些节点由 addScopes 在 pre-pass 中附加。
 *
 * @param {NodePath} path
 * @returns {Scope|null}  Jalangi Scope 对象，或 null
 */
function _findJalScope(path) {
    let cur = path;
    while (cur) {
        const node = cur.node;
        if (node && node.scope) return node.scope;
        cur = cur.parentPath;
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
 * 对象属性 mutation 是指：有代码对以该变量为 object 的 MemberExpression 做赋值。
 * 例如：`obj.prop = val` 或 `obj[key] = val`。
 *
 * 在这种情况下，轻量路径（J$.Rl）只能感知变量引用本身的变化，
 * 无法感知到属性层面的变化，因此必须走全量路径（J$.R）。
 *
 * 实现：检查 binding 的所有引用路径（binding.referencePaths），
 * 看是否有某个引用是赋值表达式中的 MemberExpression.object。
 *
 * @param {import('@babel/traverse').Binding} binding
 * @returns {boolean}
 */
function _checkMutation(binding) {
    for (const refPath of (binding.referencePaths ?? [])) {
        const parent = refPath.parent;
        const parentPath = refPath.parentPath;
        if (!parent || !parentPath) continue;

        // 检查：refPath 是否是 MemberExpression.object
        // 且该 MemberExpression 是赋值表达式的 left
        if (parent.type === 'MemberExpression' && parent.object === refPath.node) {
            const grandParent = parentPath.parent;
            if (grandParent?.type === 'AssignmentExpression'
                    && grandParent.left === parent) {
                return true;
            }
        }
    }
    return false;
}
