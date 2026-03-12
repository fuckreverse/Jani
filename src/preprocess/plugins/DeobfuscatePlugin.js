// JALANGI DO NOT INSTRUMENT
// @ts-check

/**
 * @file DeobfuscatePlugin.js — 反混淆预处理插件
 *
 * 包含以下变换 Pass（均可独立开启/关闭）：
 *
 * 1. splitSequence        逗号表达式拆分为多条语句
 *    (a=1, b=2, c=3)  →  a=1; b=2; c=3;
 *    注：仅对"语句级"逗号表达式拆分，函数参数内的逗号表达式不动
 *
 * 2. replaceVoid          void 0 / void expr 替换为 undefined（仅 void 0/void '' 等常量形式）
 *    void 0   →  undefined
 *
 * 3. foldConstants        编译期常量折叠
 *    1 + 2             →  3
 *    "foo" + "bar"     →  "foobar"
 *    true && false     →  false
 *    !true             →  false
 *    typeof undefined  →  "undefined"
 *    注：只折叠纯字面量组成的表达式，不处理变量
 *
 * 4. simplifyBoolean      布尔简化
 *    !!x        →  Boolean(x)   （双重否定）
 *    !true      →  false
 *    !false     →  true
 *
 * 5. expandConditional    条件表达式展开为 if-else（仅在语句级可以展开时）
 *    expr1 ? fn1() : fn2()  →  if (expr1) { fn1(); } else { fn2(); }
 *    注：仅对"整条语句就是条件表达式"的情况展开，有返回值的不动
 *
 * 6. inlineDeadCode       删除永假分支 / 永真分支简化
 *    if (false) { ... }            →  （删除整条 if）
 *    if (true)  { doA(); }         →  doA();
 *    while (false) { ... }         →  （删除）
 *    false && expr                 →  false
 *    true  || expr                 →  true
 *
 * 7. normalizeForOf       for-in/for-of 循环标准化（保持原结构，仅展开 init 中的逗号）
 *
 * 8. flattenIIFE          无参 IIFE 展开
 *    (function(){ stmt1; stmt2; })()  →  stmt1; stmt2;
 *    注：仅限无参、无 this 引用、无 return 返回值被使用的情况
 *
 * 默认开启：splitSequence, replaceVoid, foldConstants, simplifyBoolean, inlineDeadCode
 * 默认关闭：expandConditional（改变控制流结构，需谨慎）, flattenIIFE（改变作用域）
 */

import { PreprocessPlugin } from '../PreprocessPlugin.js';

export class DeobfuscatePlugin extends PreprocessPlugin {
    /**
     * @param {object} [options]
     * @param {boolean} [options.splitSequence=true]      逗号表达式拆分
     * @param {boolean} [options.replaceVoid=true]        void 0 → undefined
     * @param {boolean} [options.foldConstants=true]      常量折叠
     * @param {boolean} [options.simplifyBoolean=true]    布尔简化
     * @param {boolean} [options.expandConditional=false] 条件表达式展开 if-else
     * @param {boolean} [options.inlineDeadCode=true]     死代码删除
     * @param {boolean} [options.flattenIIFE=false]       无参 IIFE 展开
     */
    constructor(options = {}) {
        super('DeobfuscatePlugin', options);
        this.splitSequence     = options.splitSequence     ?? true;
        this.replaceVoid       = options.replaceVoid       ?? true;
        this.foldConstants     = options.foldConstants     ?? true;
        this.simplifyBoolean   = options.simplifyBoolean   ?? true;
        this.expandConditional = options.expandConditional ?? false;
        this.inlineDeadCode    = options.inlineDeadCode    ?? true;
        this.flattenIIFE       = options.flattenIIFE       ?? false;
    }

    /**
     * @param {import('@babel/types').File} ast
     * @param {{ traverse: Function, types: any, generator: Function }} babelApi
     */
    apply(ast, babelApi) {
        const { traverse, types: t } = babelApi;
        const stats = {
            sequenceSplit:    0,
            voidReplaced:     0,
            constantsFolded:  0,
            booleanSimplified:0,
            conditionalExpanded: 0,
            deadCodeRemoved:  0,
            iifeFlattened:    0,
        };

        // ── Pass 1: 逗号表达式拆分（splitSequence）──────────────────────────────
        // 必须多轮直到稳定，因为拆分后可能露出新的逗号表达式
        if (this.splitSequence) {
            let changed = true;
            while (changed) {
                changed = false;
                traverse(ast, {
                    ExpressionStatement(path) {
                        if (!t.isSequenceExpression(path.node.expression)) return;
                        const seq = path.node.expression;
                        // 将逗号表达式的每个子表达式变成独立 ExpressionStatement
                        const stmts = seq.expressions.map(expr =>
                            t.expressionStatement(expr)
                        );
                        // replaceWithMultiple 要求父节点是块或程序
                        if (path.parentPath.isBlock() || path.parentPath.isProgram()) {
                            path.replaceWithMultiple(stmts);
                            stats.sequenceSplit += stmts.length - 1;
                            changed = true;
                        }
                    },
                    // 处理 for 循环 init 中的逗号表达式 → 拆分为独立语句 + for 初始化
                    // for (a=1, b=2; ...) → a=1; for (b=2; ...)
                    ForStatement(path) {
                        const init = path.node.init;
                        if (!init || !t.isSequenceExpression(init)) return;
                        const exprs = init.expressions;
                        if (exprs.length < 2) return;
                        // 最后一个留在 for init，其余提前
                        const hoisted = exprs.slice(0, -1).map(e => t.expressionStatement(e));
                        path.node.init = exprs[exprs.length - 1];
                        path.insertBefore(hoisted);
                        stats.sequenceSplit += hoisted.length;
                        changed = true;
                    },
                    // 处理 return (a=1, b=2, c) → a=1; b=2; return c;
                    ReturnStatement(path) {
                        const arg = path.node.argument;
                        if (!arg || !t.isSequenceExpression(arg)) return;
                        const exprs = arg.expressions;
                        if (exprs.length < 2) return;
                        const hoisted = exprs.slice(0, -1).map(e => t.expressionStatement(e));
                        path.node.argument = exprs[exprs.length - 1];
                        path.insertBefore(hoisted);
                        stats.sequenceSplit += hoisted.length;
                        changed = true;
                    },
                    // 处理 if (a=1, b=2, cond) → a=1; b=2; if (cond)
                    IfStatement(path) {
                        const test = path.node.test;
                        if (!t.isSequenceExpression(test)) return;
                        const exprs = test.expressions;
                        if (exprs.length < 2) return;
                        const hoisted = exprs.slice(0, -1).map(e => t.expressionStatement(e));
                        path.node.test = exprs[exprs.length - 1];
                        path.insertBefore(hoisted);
                        stats.sequenceSplit += hoisted.length;
                        changed = true;
                    },
                    // while (a=1, cond) — 不处理。
                    // 将条件中的前置表达式提升到循环体外时，每轮循环的副作用顺序
                    // 与原始代码不等价（异常抛出时尤为明显），语义风险过高。
                });
            }
        }

        // ── Pass 2: void 0 替换（replaceVoid）────────────────────────────────
        if (this.replaceVoid) {
            traverse(ast, {
                UnaryExpression(path) {
                    if (path.node.operator !== 'void') return;
                    const arg = path.node.argument;
                    // 只替换 void <纯字面量> 的形式（void 0, void '', void false, void null 等）
                    if (
                        t.isNumericLiteral(arg) ||
                        t.isStringLiteral(arg) ||
                        t.isBooleanLiteral(arg) ||
                        t.isNullLiteral(arg)
                    ) {
                        path.replaceWith(t.identifier('undefined'));
                        stats.voidReplaced++;
                    }
                },
            });
        }

        // ── Pass 3: 常量折叠（foldConstants）─────────────────────────────────
        // 使用 exit 访问器（后序遍历），确保先折叠叶节点再折叠父节点
        if (this.foldConstants) {
            traverse(ast, {
                BinaryExpression: { exit(path) {
                    const { left, right, operator } = path.node;
                    // 只处理两侧都是字面量的情况
                    const lv = _literalValue(left, t);
                    const rv = _literalValue(right, t);
                    if (lv === undefined || rv === undefined) return;

                    let result;
                    try {
                        switch (operator) {
                            case '+':  result = lv + rv;  break;
                            case '-':  result = lv - rv;  break;
                            case '*':  result = lv * rv;  break;
                            case '/':  result = rv !== 0 ? lv / rv : undefined; break;
                            case '%':  result = rv !== 0 ? lv % rv : undefined; break;
                            case '**': result = lv ** rv; break;
                            case '===': result = lv === rv; break;
                            case '!==': result = lv !== rv; break;
                            case '==':  result = lv == rv;  break;  // eslint-disable-line eqeqeq
                            case '!=':  result = lv != rv;  break;  // eslint-disable-line eqeqeq
                            case '<':   result = lv < rv;   break;
                            case '>':   result = lv > rv;   break;
                            case '<=':  result = lv <= rv;  break;
                            case '>=':  result = lv >= rv;  break;
                            case '&':   result = (lv & rv) | 0;  break;
                            case '|':   result = (lv | rv) | 0;  break;
                            case '^':   result = (lv ^ rv) | 0;  break;
                            case '<<':  result = lv << rv;  break;
                            case '>>':  result = lv >> rv;  break;
                            case '>>>': result = lv >>> rv; break;
                            default: return;
                        }
                    } catch (_) { return; }

                    if (result === undefined) return;
                    const node = _valueToNode(result, t);
                    if (node) {
                        path.replaceWith(node);
                        stats.constantsFolded++;
                    }
                }},

                UnaryExpression: { exit(path) {
                    const { operator, argument } = path.node;
                    const av = _literalValue(argument, t);

                    if (operator === 'typeof') {
                        // typeof undefined → "undefined"（undefined_sentinel 表示标识符 undefined）
                        if (av === undefined_sentinel) {
                            path.replaceWith(t.stringLiteral('undefined'));
                            stats.constantsFolded++;
                            return;
                        }
                        // typeof <其他字面量>：null / string / number / boolean
                        if (av !== undefined) {
                            // av 此时是真实的 JS 值（null / 字符串 / 数字 / 布尔）
                            path.replaceWith(t.stringLiteral(typeof av));
                            stats.constantsFolded++;
                            return;
                        }
                    }

                    if (av === undefined) return;
                    let result;
                    switch (operator) {
                        case '-':  result = -av;  break;
                        case '+':  result = +av;  break;
                        case '!':  result = !av;  break;
                        case '~':  result = ~av;  break;
                        default: return;
                    }
                    const node = _valueToNode(result, t);
                    if (node) {
                        path.replaceWith(node);
                        stats.constantsFolded++;
                    }
                }},

                // 逻辑运算短路折叠
                LogicalExpression: { exit(path) {
                    const { left, right, operator } = path.node;
                    const lv = _literalValue(left, t);
                    if (lv === undefined) return;

                    if (operator === '&&') {
                        if (!lv) { path.replaceWith(left);  stats.constantsFolded++; }
                        else     { path.replaceWith(right); stats.constantsFolded++; }
                    } else if (operator === '||') {
                        if (lv) { path.replaceWith(left);  stats.constantsFolded++; }
                        else    { path.replaceWith(right); stats.constantsFolded++; }
                    }
                }},

                // 三元条件折叠
                ConditionalExpression: { exit(path) {
                    const { test, consequent, alternate } = path.node;
                    const tv = _literalValue(test, t);
                    if (tv === undefined) return;
                    path.replaceWith(tv ? consequent : alternate);
                    stats.constantsFolded++;
                }},
            });
        }

        // ── Pass 4: 布尔简化（simplifyBoolean）───────────────────────────────
        if (this.simplifyBoolean) {
            traverse(ast, {
                UnaryExpression(path) {
                    // !!x → Boolean(x)
                    if (
                        path.node.operator === '!' &&
                        t.isUnaryExpression(path.node.argument) &&
                        path.node.argument.operator === '!'
                    ) {
                        const inner = path.node.argument.argument;
                        path.replaceWith(
                            t.callExpression(t.identifier('Boolean'), [inner])
                        );
                        stats.booleanSimplified++;
                        return;
                    }
                    // !true → false, !false → true
                    if (path.node.operator === '!') {
                        const arg = path.node.argument;
                        if (t.isBooleanLiteral(arg)) {
                            path.replaceWith(t.booleanLiteral(!arg.value));
                            stats.booleanSimplified++;
                        }
                    }
                },
            });
        }

        // ── Pass 5: 条件表达式展开为 if-else（expandConditional）─────────────
        if (this.expandConditional) {
            traverse(ast, {
                ExpressionStatement(path) {
                    const expr = path.node.expression;
                    if (!t.isConditionalExpression(expr)) return;
                    const { test, consequent, alternate } = expr;

                    // 只展开两支都是调用表达式或赋值（有副作用）的情况
                    const conseqIsEffect = _hasEffect(consequent, t);
                    const altIsEffect   = _hasEffect(alternate, t);
                    if (!conseqIsEffect && !altIsEffect) return;

                    const ifStmt = t.ifStatement(
                        test,
                        t.blockStatement([t.expressionStatement(consequent)]),
                        t.blockStatement([t.expressionStatement(alternate)])
                    );
                    path.replaceWith(ifStmt);
                    stats.conditionalExpanded++;
                },
            });
        }

        // ── Pass 6: 死代码删除（inlineDeadCode）──────────────────────────────
        if (this.inlineDeadCode) {
            traverse(ast, {
                IfStatement(path) {
                    const tv = _literalValue(path.node.test, t);
                    if (tv === undefined) return;

                    if (tv) {
                        // if (true) { consequent } else { ... } → consequent
                        const cons = path.node.consequent;
                        if (t.isBlockStatement(cons)) {
                            // 若块内有 let/const/class 声明，必须保留块作用域包装，
                            // 否则这些块级声明会泄漏到外层作用域，改变语义。
                            if (_hasBlockScopedDecl(cons, t)) {
                                // 保留块：用独立 BlockStatement 替换整条 if
                                path.replaceWith(cons);
                            } else {
                                path.replaceWithMultiple(cons.body);
                            }
                        } else {
                            path.replaceWith(cons);
                        }
                        stats.deadCodeRemoved++;
                    } else {
                        // if (false) { ... } else { alternate } → alternate（若有）
                        const alt = path.node.alternate;
                        if (alt) {
                            if (t.isBlockStatement(alt)) {
                                path.replaceWithMultiple(alt.body);
                            } else {
                                path.replaceWith(alt);
                            }
                        } else {
                            path.remove();
                        }
                        stats.deadCodeRemoved++;
                    }
                },

                WhileStatement(path) {
                    const tv = _literalValue(path.node.test, t);
                    if (tv === false || (typeof tv === 'number' && tv === 0)) {
                        path.remove();
                        stats.deadCodeRemoved++;
                    }
                },

                ForStatement(path) {
                    const test = path.node.test;
                    if (!test) return;
                    const tv = _literalValue(test, t);
                    if (tv === false || (typeof tv === 'number' && tv === 0)) {
                        path.remove();
                        stats.deadCodeRemoved++;
                    }
                },
            });
        }

        // ── Pass 7: 无参 IIFE 展开（flattenIIFE）─────────────────────────────
        if (this.flattenIIFE) {
            traverse(ast, {
                ExpressionStatement(path) {
                    const expr = path.node.expression;
                    // (function() { ... })() 或 (() => { ... })()
                    if (!t.isCallExpression(expr)) return;
                    const callee = expr.callee;
                    if (expr.arguments.length > 0) return;

                    let fn;
                    if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
                        fn = callee;
                    } else if (
                        t.isParenthesizedExpression?.(callee) &&
                        (t.isFunctionExpression(callee.expression) || t.isArrowFunctionExpression(callee.expression))
                    ) {
                        fn = callee.expression;
                    } else {
                        return;
                    }

                    // 不展开有参数的函数
                    if (fn.params && fn.params.length > 0) return;
                    if (!t.isBlockStatement(fn.body)) return;

                    // 安全检查 1：普通函数不能含 this 引用
                    if (t.isFunctionExpression(fn) && _containsThis(fn.body, t)) return;

                    const stmts = fn.body.body;

                    // 安全检查 2：函数体内有任意 return 语句，展开后会逃逸成外层函数的 return
                    // （唯一允许的例外是末尾的裸 return; 会在下方被过滤掉，但只有当它确实在末尾时才能忽略）
                    // 保守策略：只要函数体内有任何 return，就不展开（末尾 return; 也禁止，因为无法确保安全）
                    if (_containsAnyReturn(fn.body, t)) return;

                    // 安全检查 3：函数体内有 break/continue，展开后会逃逸到外层循环
                    if (_containsBreakContinue(fn.body, t)) return;

                    // 安全检查 4：函数体内有 var 声明，且外层作用域中已有同名 var/let/const，
                    // 则展开会引发同名变量冲突或改变值。
                    // 保守策略：只要函数体内有 var 声明，就检查外层是否已有该名字。
                    if (_hasVarShadowConflict(fn.body, path, t)) return;

                    // 安全检查 5：函数体内有 let/const/class（块作用域），
                    // 展开后会泄漏到外层——改为用 BlockStatement 包裹展开，保留块作用域。
                    const hasBlockScoped = _hasBlockScopedDecl(fn.body, t);

                    // 过滤末尾的裸 return;
                    const body = stmts.filter((s, i) => {
                        if (i === stmts.length - 1 && t.isReturnStatement(s) && !s.argument) return false;
                        return true;
                    });

                    if (body.length === 0) {
                        path.remove();
                    } else if (hasBlockScoped) {
                        // 保留块作用域：用 BlockStatement 替换，而非直接展开
                        path.replaceWith(t.blockStatement(body));
                    } else {
                        path.replaceWithMultiple(body);
                    }
                    stats.iifeFlattened++;
                },
            });
        }

        return stats;
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 从字面量节点中提取 JS 原始值（string / number / boolean / null / undefined）。
 * 如果不是字面量则返回 undefined（注意与 null 区分）。
 */
function _literalValue(node, t) {
    if (!node) return undefined;
    if (t.isStringLiteral(node))  return node.value;
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isBooleanLiteral(node)) return node.value;
    if (t.isNullLiteral(node))    return null;
    if (t.isIdentifier(node) && node.name === 'undefined') return undefined_sentinel;
    return undefined;
}
// 用 Symbol 区分"undefined 字面量"和"不是字面量"
const undefined_sentinel = Symbol('undefined');

/**
 * 将 JS 原始值转换为 Babel AST 字面量节点。
 */
function _valueToNode(value, t) {
    if (value === undefined_sentinel) return t.identifier('undefined');
    if (typeof value === 'string')  return t.stringLiteral(value);
    if (typeof value === 'number')  {
        if (!isFinite(value)) return null; // Infinity / NaN 不能简单表示为字面量
        return t.numericLiteral(value);
    }
    if (typeof value === 'boolean') return t.booleanLiteral(value);
    if (value === null) return t.nullLiteral();
    return null;
}

/**
 * 检查表达式是否有副作用（调用、赋值、new 等）。
 * 用于判断条件表达式是否值得展开为 if-else。
 */
function _hasEffect(node, t) {
    return (
        t.isCallExpression(node)         ||
        t.isNewExpression(node)          ||
        t.isAssignmentExpression(node)   ||
        t.isUpdateExpression(node)       ||
        t.isAwaitExpression(node)        ||
        t.isYieldExpression(node)
    );
}

/**
 * 检查函数体内是否有 this 引用（不包含嵌套函数中的 this）。
 */
function _containsThis(blockNode, t) {
    let found = false;
    // 简单 JSON 遍历（避免引入 traverse 递归中的作用域问题）
    JSON.stringify(blockNode, (key, value) => {
        if (value && typeof value === 'object' && value.type === 'ThisExpression') {
            found = true;
        }
        return value;
    });
    return found;
}

/**
 * 检查函数体（BlockStatement）中是否存在任意 return 语句（有值或无值均算）。
 * 不深入嵌套函数，只在当前函数作用域内检查。
 *
 * 若函数体含 return，展开 IIFE 后 return 会逃逸成外层函数的 return，改变控制流。
 *
 * @param {object} blockNode  Babel BlockStatement 节点（IIFE 函数体）
 * @param {object} t          @babel/types
 */
function _containsAnyReturn(blockNode, t) {
    function visit(node) {
        if (!node || typeof node !== 'object') return false;
        if (Array.isArray(node)) return node.some(visit);
        // 找到 return → 立即返回 true
        if (node.type === 'ReturnStatement') return true;
        // 不进入嵌套函数（它们有自己的 return）
        if (
            node.type === 'FunctionExpression' ||
            node.type === 'FunctionDeclaration' ||
            node.type === 'ArrowFunctionExpression' ||
            node.type === 'ObjectMethod' ||
            node.type === 'ClassMethod'
        ) return false;
        // 遍历所有子节点
        return Object.values(node).some(child =>
            child && typeof child === 'object' ? visit(child) : false
        );
    }
    return visit(blockNode);
}

/**
 * 检查函数体（BlockStatement）中是否含有"裸 break/continue"——
 * 即不在任何嵌套循环/switch 内、展开后会逃逸到 IIFE 外层循环的 break/continue。
 *
 * 算法：depth=0 表示当前在 IIFE 直接函数体中；
 * 遇到嵌套循环/switch 时 depth+1；遇到 break/continue 时若 depth===0 则命中。
 * 不进嵌套函数（函数边界是新作用域，其内的 break/continue 不会逃逸）。
 */
function _containsBreakContinue(blockNode, t) {
    function visit(node, depth) {
        if (!node || typeof node !== 'object') return false;
        if (Array.isArray(node)) return node.some(n => visit(n, depth));
        // break/continue 在当前层（depth===0）才算危险
        if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') {
            return depth === 0;
        }
        // 不进嵌套函数
        if (
            node.type === 'FunctionExpression' ||
            node.type === 'FunctionDeclaration' ||
            node.type === 'ArrowFunctionExpression'
        ) return false;
        // 遇到嵌套循环/switch，其内的 break/continue 是合法的（depth+1）
        const isLoopOrSwitch = (
            node.type === 'ForStatement' || node.type === 'ForInStatement' ||
            node.type === 'ForOfStatement' || node.type === 'WhileStatement' ||
            node.type === 'DoWhileStatement' || node.type === 'SwitchStatement'
        );
        const nextDepth = isLoopOrSwitch ? depth + 1 : depth;
        return Object.values(node).some(child =>
            child && typeof child === 'object' ? visit(child, nextDepth) : false
        );
    }
    return visit(blockNode, 0);
}

/**
 * 检查 AST 节点中是否有直接（非嵌套函数内的）let/const/class 声明。
 * 用于判断展开时是否需要保留块作用域包装。
 */
function _hasBlockScopedDecl(node, t) {
    if (!node) return false;
    const stmts = t.isBlockStatement(node) ? node.body : [node];
    return stmts.some(s => {
        if (t.isVariableDeclaration(s) && (s.kind === 'let' || s.kind === 'const')) return true;
        if (t.isClassDeclaration(s)) return true;
        return false;
    });
}

/**
 * 检查将 IIFE 函数体中的 var 声明展开到外层作用域时是否会产生冲突。
 * 策略：收集函数体内所有 var 声明的变量名，若外层 path 的绑定中已存在该名字则视为冲突。
 */
function _hasVarShadowConflict(blockNode, iifePath, t) {
    // 收集函数体内顶层 var 声明的变量名
    const varNames = new Set();
    for (const stmt of blockNode.body) {
        if (t.isVariableDeclaration(stmt) && stmt.kind === 'var') {
            for (const decl of stmt.declarations) {
                _collectBindingNames(decl.id, varNames, t);
            }
        }
        if (t.isFunctionDeclaration(stmt) && stmt.id) {
            varNames.add(stmt.id.name);
        }
    }
    if (varNames.size === 0) return false;

    // 检查外层作用域中是否已有同名绑定
    try {
        const scope = iifePath.scope;
        for (const name of varNames) {
            const binding = scope.getBinding(name);
            if (binding) return true; // 已存在该名字的绑定，展开会冲突
        }
    } catch (_) {
        // scope 访问失败时保守返回 true（不展开）
        return true;
    }
    return false;
}

/**
 * 递归收集解构模式中的所有绑定名称（支持 Identifier / ArrayPattern / ObjectPattern）。
 */
function _collectBindingNames(node, names, t) {
    if (!node) return;
    if (t.isIdentifier(node)) { names.add(node.name); return; }
    if (t.isArrayPattern(node)) {
        for (const el of node.elements) {
            if (el) _collectBindingNames(t.isRestElement(el) ? el.argument : el, names, t);
        }
        return;
    }
    if (t.isObjectPattern(node)) {
        for (const prop of node.properties) {
            if (t.isRestElement(prop)) { _collectBindingNames(prop.argument, names, t); }
            else { _collectBindingNames(prop.value, names, t); }
        }
        return;
    }
    if (t.isAssignmentPattern(node)) { _collectBindingNames(node.left, names, t); }
}
