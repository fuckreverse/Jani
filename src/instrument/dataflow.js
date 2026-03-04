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
 * ### _isRHS 时序说明
 *
 * dataflow.js 在 transformAst 之前运行（Pass 0），此时 Identifier 节点上还没有
 * _isRHS 标注（那是 transformAst 执行时由 astUtil 的 context 机制打上的）。
 * 因此本模块自行维护一套 "ignoreContext" 判断逻辑，对照 astUtil.js 中的
 * IGNORE 条件表，在 _walkNode 遍历时携带 isIgnore 标志，避免对非 RHS 位置
 * 的 Identifier 生成错误决策。
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
 *   hasMutation: boolean,     // 是否有对该变量做过对象属性写入（变量被用作赋值目标的 object）
 * }
 * ```
 */
function _collectDefSites(scopeNode, scope) {
    const defSites = new Map();

    // 为作用域内声明的每个变量初始化条目
    for (const [name, type] of Object.entries(scope.vars)) {
        const kind = scope.varKinds?.[name] ?? null;
        // 参数类型 'arg' 对应 kind = 'param'，其余沿用 varKinds 或 type
        const effectiveKind = (type === 'arg') ? 'param' : (kind ?? type);
        defSites.set(name, {
            defs:        [{ kind: effectiveKind, isConditional: false }],
            hasReassign: false,
            hasMutation: false,
        });
    }

    // 遍历 body，检测重赋值（AssignmentExpression / UpdateExpression）
    // 以及对象属性写入（MemberExpression 赋值，左侧 object 是该变量）
    _walkNode(scopeNode, (node, _isIgnore, inConditional) => {
        // 越过子作用域（不深入分析）
        if (node !== scopeNode && _isScopeNode(node)) return 'skip';

        if (node.type === 'AssignmentExpression') {
            const lhs = node.left;
            if (lhs.type === 'Identifier' && defSites.has(lhs.name)) {
                const info = defSites.get(lhs.name);
                info.hasReassign = true;
                info.defs.push({ kind: 'assign', isConditional: inConditional });
            }
            // 对象属性写入：obj.prop = ... 或 obj[key] = ...
            // 当赋值目标是 MemberExpression 且 object 是本作用域变量时，
            // 标记该变量 hasMutation（对象内容可能被修改，需要全量读取才能感知）
            if (lhs.type === 'MemberExpression' && lhs.object.type === 'Identifier') {
                const objName = lhs.object.name;
                if (defSites.has(objName)) {
                    defSites.get(objName).hasMutation = true;
                }
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
    _walkNode(scopeNode, (node, isIgnore) => {
        // 越过子作用域
        if (node !== scopeNode && _isScopeNode(node)) return 'skip';

        if (node.type !== 'Identifier') return;
        if (isIgnore) return;  // 非 RHS 上下文（赋值左侧、声明 id、标签等）

        const name     = node.name;
        const isGlobal = scope.isGlobal(name);
        const key      = _nodeKey(scope.id, name, node);

        let decision;

        if (isUnsafe || isGlobal) {
            decision = Decision.FULL;
        } else {
            const info = defSites.get(name);
            if (!info) {
                // 变量未在此作用域声明（来自父作用域，即闭包引用）
                // 不记录到决策表，交由 instrumentLoad 的 fallback 逻辑处理：
                // 父作用域的 eval/with 信息已传播到子作用域链（scope.usesEval() 沿链
                // 向上传播），fallback 判断是安全的。
                return;
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
    const { defs, hasReassign, hasMutation } = info;

    // 如果对该变量持有的对象做过属性写入，说明其内容会变，必须全量读取
    // （轻量路径只能感知变量本身的重赋值，感知不到属性变动）
    if (hasMutation) {
        return Decision.FULL;
    }

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
 * 判断父节点 `parent` 的 `key` 子节点是否处于"忽略（非 RHS）"上下文。
 *
 * 对照 astUtil.js 中 transformAst 的 IGNORE 条件表（第 88-125 行），
 * 确保 dataflow.js 在 transformAst 之前运行时也能正确识别非 RHS 位置。
 *
 * @param {object} parent  父节点
 * @param {string} key     子节点在父节点中的属性名
 * @param {object} child   子节点
 * @returns {boolean}  true 表示该位置是 IGNORE 上下文（不插桩）
 */
function _isIgnoreContext(parent, key, child) {
    if (!parent) return false;
    const type = parent.type;

    // 直接对应 astUtil.js transformAst 中的 IGNORE 条件列表
    if (
        (type === 'AssignmentExpression'  && key === 'left') ||
        (type === 'UpdateExpression'      && key === 'argument') ||
        (type === 'UnaryExpression'       && key === 'argument' && parent.operator === 'delete') ||
        (type === 'ForInStatement'        && key === 'left') ||
        (type === 'ForOfStatement'        && key === 'left') ||
        ((type === 'FunctionExpression' || type === 'FunctionDeclaration') && key === 'id') ||
        (type === 'ArrowFunctionExpression' && key === 'id') ||
        ((type === 'ClassDeclaration' || type === 'ClassExpression') && key === 'id') ||
        (type === 'ImportSpecifier'         && (key === 'local' || key === 'imported')) ||
        (type === 'ImportDefaultSpecifier'  && key === 'local') ||
        (type === 'ImportNamespaceSpecifier'&& key === 'local') ||
        (type === 'ExportSpecifier'         && (key === 'local' || key === 'exported')) ||
        (type === 'LabeledStatement'        && key === 'label') ||
        (type === 'BreakStatement'          && key === 'label') ||
        (type === 'CatchClause'             && key === 'param') ||
        (type === 'ContinueStatement'       && key === 'label') ||
        // callee 中的 MemberExpression 或 eval Identifier 都是 IGNORE
        ((type === 'CallExpression' || type === 'NewExpression') &&
            key === 'callee' &&
            (child?.type === 'MemberExpression' ||
             (child?.type === 'Identifier' && child?.name === 'eval'))) ||
        (type === 'OptionalCallExpression' &&
            key === 'callee' &&
            (child?.type === 'OptionalMemberExpression' ||
             child?.type === 'MemberExpression')) ||
        (type === 'VariableDeclarator'      && key === 'id') ||
        (type === 'MemberExpression'        && !parent.computed && key === 'property') ||
        (type === 'OptionalMemberExpression' && !parent.computed && key === 'property') ||
        (type === 'Property'                && key === 'key' && !parent.computed) ||
        (type === 'RestElement'             && key === 'argument') ||
        (type === 'AssignmentPattern'       && key === 'left') ||
        (type === 'PropertyDefinition'      && key === 'key' && !parent.computed) ||
        (type === 'MethodDefinition'        && key === 'key' && !parent.computed) ||
        (type === 'ClassMethod'             && key === 'key' && !parent.computed) ||
        (type === 'ClassPrivateProperty'    && key === 'key') ||
        (type === 'PrivateName'             && key === 'id') ||
        // params 列表内所有子节点都是 IGNORE（声明位置）
        ((type === 'FunctionExpression' || type === 'FunctionDeclaration' ||
          type === 'ArrowFunctionExpression' || type === 'ClassMethod') && key === 'params') ||
        // eval 作为直接调用目标是 IGNORE
        (type === 'CallExpression' && key === 'callee' &&
            child?.type === 'Identifier' && child?.name === 'eval')
    ) {
        return true;
    }

    return false;
}

/**
 * 简单的深度优先 AST 遍历（访问所有节点）。
 * visitor 返回 `'skip'` 时跳过该节点的所有子节点。
 *
 * visitor 签名：(node, isIgnore, inConditional) => void | 'skip'
 *   - isIgnore      当前节点是否处于"忽略（非 RHS）"上下文
 *   - inConditional 当前是否在条件分支内
 *
 * @param {object}   node     起始节点
 * @param {Function} visitor  (node, isIgnore, inConditional) => void | 'skip'
 * @param {boolean}  [isIgnore=false]       当前节点是否处于忽略上下文
 * @param {boolean}  [inConditional=false]  当前是否在条件分支内
 */
function _walkNode(node, visitor, isIgnore = false, inConditional = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const child of node) _walkNode(child, visitor, isIgnore, inConditional);
        return;
    }
    if (!node.type) return;

    const result = visitor(node, isIgnore, inConditional);
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
            const childIsIgnore = _isIgnoreContext(node, key, child);
            _walkNode(child, visitor, childIsIgnore, newInConditional);
        }
    }
}
