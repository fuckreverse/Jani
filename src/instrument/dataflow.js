// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

/**
 * @file dataflow.js — 静态 SSA def-use 分析模块。
 *
 * 在插桩的第 0 个 pass（addScopes 之后、transformAst 之前）对原始 AST 做
 * 数据流分析，输出 **插桩决策表**（`Map<nodeKey, Decision>`），供后续 pass
 * 在 `instrumentLoad` 中查表以决定插桩级别：
 *
 * - `'full'`        — 生成全量 `J$.R(iid, name, val, flags, scopeId)` 钩子
 * - `'lightweight'` — 生成轻量 `J$.Rl(iid, defScopeId, name)` 钩子
 * - `'dead'`        — 该读取完全可省略（值在上次写入到此读取之间保证不变），
 *                     当前保守实现中不生成 `'dead'` 决策（降级为 `'lightweight'`）
 *
 * ### 保守近似原则
 *
 * 宁可错判成 `lightweight`，也不错判成 `dead`：
 * - 变量被传入函数（可能被修改）→ `lightweight`
 * - 变量在 `try` 块内 → `lightweight`
 * - 作用域内有 `eval` 或 `with` → `full`
 * - 全局变量 → `full`
 *
 * ### nodeKey 格式
 *
 * `${scopeId}:${name}:${line}:${col}`（对应 Babel AST 中 node.loc.start）
 *
 * @module dataflow
 */

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
 * 对 addScopes 之后的 AST 做静态 def-use 分析，返回插桩决策表。
 *
 * 每个 use-site（Identifier 出现在 RHS 上下文的位置）对应一条决策。
 * 键格式：`${scopeId}:${name}:${line}:${col}`（基于 Babel AST 位置信息）。
 *
 * @param {object} ast  Babel AST（Program 节点，已经过 addScopes 处理，含 .scope 字段）
 * @returns {Map<string, Decision>}  插桩决策表
 */
export function analyzeDefUse(ast) {
    const decisions = new Map();
    _visitProgram(ast, decisions);
    return decisions;
}

// ── AST 遍历辅助 ──────────────────────────────────────────────────────────────

/**
 * 生成 use-site 的唯一键。
 * @param {number} scopeId  当前词法作用域 ID
 * @param {string} name     变量名
 * @param {object} node     Babel AST 节点（含 loc.start）
 * @returns {string}
 */
function _nodeKey(scopeId, name, node) {
    const loc = node.loc?.start;
    return `${scopeId}:${name}:${loc?.line ?? 0}:${loc?.column ?? 0}`;
}

/**
 * 遍历 Program（顶层作用域），递归分析所有函数体。
 * @param {object} program  Babel Program 节点
 * @param {Map}    decisions  结果决策表（就地写入）
 */
function _visitProgram(program, decisions) {
    _visitScope(program, decisions);
}

/**
 * 遍历一个作用域节点（Program / FunctionDeclaration / FunctionExpression /
 * ArrowFunctionExpression / ClassMethod）。
 *
 * 算法：
 * 1. 从 node.scope（由 addScopes 附加）获取词法作用域对象
 * 2. 对作用域内的 body 做 def-site 收集
 * 3. 对所有 use-site（Identifier in RHS）做决策
 * 4. 递归处理内嵌函数作用域
 *
 * @param {object} node      作用域节点
 * @param {Map}    decisions  结果决策表
 */
function _visitScope(node, decisions) {
    const scope = node.scope;
    if (!scope) return;

    // 是否有不安全的动态访问（eval / with）
    const isUnsafe = scope.usesEval() || scope.usesWith();

    // 阶段 1：收集 def-sites（赋值点信息）
    const defSites = _collectDefSites(node, scope);

    // 阶段 2：遍历所有 use-sites，生成决策
    _collectUseSites(node, scope, isUnsafe, defSites, decisions);

    // 阶段 3：递归分析内嵌函数
    _visitChildScopes(node, decisions);
}

// ── 阶段 1：Def-Sites 收集 ────────────────────────────────────────────────────

/**
 * 收集一个作用域内所有变量的赋值点信息。
 *
 * @param {object} scopeNode  作用域 AST 节点（含 body）
 * @param {Scope}  scope      对应的 Scope 对象
 * @returns {Map<string, DefInfo>}  变量名 → 赋值点信息
 *
 * DefInfo：
 * ```js
 * {
 *   defs: Array<{node, kind, isConditional}>,
 *   hasReassign: boolean,     // 是否在声明后有 = 赋值
 *   hasMutation: boolean,     // 是否有对该变量做过对象属性写入（通过 P 路径）
 * }
 * ```
 */
function _collectDefSites(scopeNode, scope) {
    const defSites = new Map();

    // 为作用域内声明的每个变量初始化条目
    for (const [name, type] of Object.entries(scope.vars)) {
        const kind = scope.varKinds?.[name] ?? null;
        defSites.set(name, {
            defs:        [{ kind: kind ?? type, isConditional: false }],
            hasReassign: false,
            hasMutation: false,
        });
    }

    // 遍历 body，检测重赋值（AssignmentExpression / UpdateExpression）
    _walkNode(scopeNode, (node, inConditional) => {
        // 越过子作用域（不深入分析）
        if (node !== scopeNode && _isScopeNode(node)) return 'skip';

        if (node.type === 'AssignmentExpression') {
            const lhs = node.left;
            if (lhs.type === 'Identifier' && defSites.has(lhs.name)) {
                const info = defSites.get(lhs.name);
                info.hasReassign = true;
                info.defs.push({ kind: 'assign', isConditional: inConditional });
            }
        }

        if (node.type === 'UpdateExpression') {
            const arg = node.argument;
            if (arg.type === 'Identifier' && defSites.has(arg.name)) {
                const info = defSites.get(arg.name);
                info.hasReassign = true;
                info.defs.push({ kind: 'update', isConditional: inConditional });
            }
        }
    });

    return defSites;
}

// ── 阶段 2：Use-Sites 决策 ────────────────────────────────────────────────────

/**
 * 遍历作用域内所有 Identifier 的 RHS 出现位置，生成决策。
 *
 * @param {object} scopeNode  作用域节点
 * @param {Scope}  scope      Scope 对象
 * @param {boolean} isUnsafe  该作用域是否含 eval/with
 * @param {Map}    defSites   阶段 1 产出的 def-site 表
 * @param {Map}    decisions  结果决策表（就地写入）
 */
function _collectUseSites(scopeNode, scope, isUnsafe, defSites, decisions) {
    _walkNode(scopeNode, (node) => {
        // 越过子作用域
        if (node !== scopeNode && _isScopeNode(node)) return 'skip';

        if (node.type !== 'Identifier') return;
        if (!node._isRHS) return;  // 只处理 RHS 上下文（由 addScopes/astUtil 标注）

        const name     = node.name;
        const isGlobal = scope.isGlobal(name);
        const key      = _nodeKey(scope.id, name, node);

        let decision;

        if (isUnsafe || isGlobal) {
            decision = Decision.FULL;
        } else {
            const info = defSites.get(name);
            if (!info) {
                // 变量未在此作用域声明（来自父作用域）→ 全量
                decision = Decision.FULL;
            } else {
                decision = _decideForUse(info);
            }
        }

        decisions.set(key, decision);
    });
}

/**
 * 根据 DefInfo 为一个 use-site 决策。
 *
 * @param {object} info  DefInfo 对象
 * @returns {Decision}
 */
function _decideForUse(info) {
    const { defs, hasReassign } = info;

    // 只有一个 def-site，且不在条件分支内，且是 const 声明
    if (!hasReassign && defs.length === 1) {
        const def = defs[0];
        if (!def.isConditional) {
            if (def.kind === 'const') {
                // const 变量：可以走轻量路径（保守：不生成 'dead'，即使是基础类型也保留记录）
                return Decision.LIGHTWEIGHT;
            }
            if (def.kind === 'param') {
                // 函数参数：声明后无重赋值，走轻量
                return Decision.LIGHTWEIGHT;
            }
        }
    }

    // 其他情况：有重赋值 / 多 def-site / 条件赋值 → 轻量（已比全量便宜）
    return Decision.LIGHTWEIGHT;
}

// ── 阶段 3：递归子作用域 ───────────────────────────────────────────────────────

/**
 * 递归处理所有直接内嵌的子作用域（不跨层）。
 *
 * @param {object} node      当前作用域节点
 * @param {Map}    decisions  结果决策表
 */
function _visitChildScopes(node, decisions) {
    _walkNode(node, (child) => {
        // 跳过自身
        if (child === node) return;
        if (_isScopeNode(child)) {
            _visitScope(child, decisions);
            return 'skip';  // 不继续深入（递归调用已处理）
        }
    });
}

// ── AST 遍历工具 ──────────────────────────────────────────────────────────────

/**
 * 判断一个节点是否产生新的词法作用域（含 .scope 属性）。
 *
 * @param {object} node
 * @returns {boolean}
 */
function _isScopeNode(node) {
    if (!node || !node.type) return false;
    return (
        node.type === 'Program'                 ||
        node.type === 'FunctionDeclaration'     ||
        node.type === 'FunctionExpression'      ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ClassMethod'
    );
}

/**
 * 简单的深度优先 AST 遍历（访问所有节点）。
 * visitor 返回 `'skip'` 时跳过该节点的所有子节点。
 *
 * @param {object}   node     起始节点
 * @param {Function} visitor  (node, inConditional) => void | 'skip'
 * @param {boolean}  [inConditional=false]  当前是否在条件分支内
 */
function _walkNode(node, visitor, inConditional = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const child of node) _walkNode(child, visitor, inConditional);
        return;
    }
    if (!node.type) return;

    const result = visitor(node, inConditional);
    if (result === 'skip') return;

    // 追踪条件分支
    const newInConditional = inConditional
        || node.type === 'IfStatement'
        || node.type === 'ConditionalExpression'
        || node.type === 'SwitchStatement'
        || node.type === 'WhileStatement'
        || node.type === 'DoWhileStatement'
        || node.type === 'ForStatement'
        || node.type === 'ForInStatement'
        || node.type === 'ForOfStatement'
        || node.type === 'TryStatement';

    // 递归遍历所有子节点
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end'
            || key === 'scope' || key === 'extra' || key === 'innerComments'
            || key === 'leadingComments' || key === 'trailingComments') {
            continue;
        }
        const child = node[key];
        if (child && typeof child === 'object') {
            _walkNode(child, visitor, newInConditional);
        }
    }
}
