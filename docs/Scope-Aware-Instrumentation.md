# 作用域感知插桩改造方案（Scope-Aware Instrumentation）

> **文档状态**：草稿 v0.1 — 持续迭代中，未开始实施  
> **目标**：实现完整的作用域感知插桩，用"左值状态机"替代当前无差别的右值 log，从根本上减少运行时冗余，同时提供更精确的词法上下文信息。

---

## 一、问题根源：当前插桩的核心局限

### 1.1 现状：每个右值读取都独立 log

当前 `instrumentLoad` 对每个出现在 RHS 上下文的 `Identifier` 都注入 `J$.R`：

```js
// 原始代码
let x = 1;
let y = x + x;

// 插桩后（当前行为）
let x = J$.W(iid1, 'x', J$.T(iid0, 1, 22, false), x, 0b001);
let y = J$.W(iid5, 'y',
    J$.B(iid4, '+',
        J$.R(iid2, 'x', x, 0b00),   // ← 第一次读 x
        J$.R(iid3, 'x', x, 0b00)    // ← 第二次读 x，重复了
    ),
    y, 0b001
);
```

两次 `J$.R` 都传了 `x` 的当前值，对运行时来说这是冗余的——因为 `J$.W` 已经在写入时记录了 x 的值，读取时传值本是为了"方便"，但代价是：
- 插桩代码体积膨胀
- 运行时每次求值都触发回调
- 分析插件必须自己维护一份 shadow 状态才能做去重

### 1.2 当前架构的已有基础

项目已经有了作用域分析的雏形，但**没有充分利用**：

| 已有 | 未充分利用的地方 |
|------|----------------|
| `scope.js` 的 `Scope` 类（含 `vars`、`hasVar`、`isGlobal`） | `Scope` 没有唯一 ID，运行时无法区分同名变量所属的词法作用域 |
| `wrappers.js` 的 `instrumentLoad` 中调用了 `_scope.hasVar` | 只用来区分全局/局部，没有做任何跳过或降级 |
| `Scope.hasEval`、`usesEval()` 方法 | `addEval()` **从未在 `addScopes` 中被调用**，该标志永远是 `false` |
| `J$.N`（declare）在函数入口同步了所有变量 | 运行时拿到了初始值，但读取时 `J$.R` 又传了一遍当前值 |

---

## 二、目标架构：三层升级

改造分三个正交的层次，可以独立实施，也可以叠加：

```
Layer 3：完整 def-use 分析（SSA 化 + 最终裁决"此 R 可省略"）
   ↑ 依赖
Layer 2：作用域 ID + 轻量 J$.Rl 路径（局部确定变量不传 value）
   ↑ 依赖
Layer 1：基础修复（补 addEval + 给 Scope 分配 ID）
```

---

## 三、Layer 1：基础修复（必须先做）

### 3.1 补全 `addEval()` 调用

**文件**：`src/instrument/scope.js`，`addScopes` 函数内部的 `visitorPost`

**问题**：`Scope` 类已经有 `addEval()` 方法，但 `addScopes` 遍历时发现 `eval` 标识符从来没有调用它。任何包含 `eval` 的作用域，静态分析结论都不可信（`eval` 能动态创建任意变量）。

**改动**：在 `visitorPost.Identifier` 中增加 `eval` 检测：

```js
// scope.js → addScopes() → visitorPost
Identifier(node, context) {
    // 已有：arguments 重命名
    if (context === CONTEXT.RHS && node.name === FROM_NAME && ...) { ... }

    // 新增：检测 eval 调用，标记整条作用域链
    if (node.name === 'eval') {
        currentScope?.addEval();
    }
    return node;
},
```

**影响**：后续 Layer 2/3 的所有优化在 `usesEval()===true` 的作用域内自动失效，退回当前行为。

### 3.2 给每个 Scope 分配唯一 ID

**文件**：`src/instrument/scope.js`，`Scope` 构造器

**改动**：

```js
let _scopeIdCounter = 0;

class Scope {
    constructor(parent, isCatch) {
        this.id       = _scopeIdCounter++;  // 新增
        this.vars     = {};
        // ... 其余不变
    }
}
```

`_scopeIdCounter` 在每次 `instrumentCode` 调用前随 IID 一起重置（在 `iid.js` 的 `initialize()` 中，或在 `scope.js` 导出一个 `resetScopeCounter()` 函数供 `esnstrument.js` 调用）。

**用途**：ScopeID 将作为额外参数传入 `J$.R`/`J$.W`，让运行时能精确定位变量的词法归属，而不只是靠 `(iid, name)` 对。这对混淆代码分析（同一字母变量名在多个作用域）尤为重要。

---

## 四、Layer 2：作用域 ID 注入 + 轻量读取路径

### 4.1 设计：新增 `J$.Rl`（Read-Lightweight）钩子

**核心思想**：对于"静态可信的局部变量读取"，不传 `value`，只传 `(iid, scopeId, name)`。运行时从 Shadow Memory 中查当前值，而不是从代码里重新求值。

**可走轻量路径的条件**（必须**全部**满足）：

| 条件 | 检查位置 | 原因 |
|------|---------|------|
| `_scope.hasVar(name) === true` | 已有（`instrumentLoad`） | 必须是词法上已声明的变量 |
| `!_scope.isGlobal(name)` | 已有（`instrumentLoad`） | 全局变量可能被外部修改 |
| `!_scope.usesEval()` | Layer 1 补全后可用 | 有 eval 则动态创建变量，作用域不可信 |
| `varType !== 'catch'` | 需在 `instrumentLoad` 中新增 | catch 变量有特殊绑定语义 |
| 非 `arguments` 标识符 | 需新增 | `arguments` 是动态对象，每帧不同 |

**轻量路径生成的代码**：

```js
// 原来的重路径（传 value）
J$.R(iid, 'x', x, flags)

// 新的轻量路径（不传 value）
J$.Rl(iid, scopeId, 'x')
// 运行时用 scopeId + 'x' 查影子内存中的当前值
```

### 4.2 `wrappers.js` 改动：`wrapReadLightweight`

新增函数：

```js
function wrapReadLightweight(node, name, scopeId) {
    if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
        IID.printIidToLoc(node);
        const ret = replaceInExpr(
            `${logReadLightFunName}(${RP}1, ${scopeId}, ${RP}2)`,
            IID.getIid(), name
        );
        transferLoc(ret, node);
        return ret;
    }
    // 完全不插桩时：直接返回原 identifier 节点
    return node;  // 注意：这里 val 就是 node 自身
}
```

`logReadLightFunName` = `${v}.Rl`，在 `_rebuildNames` 中注册。

### 4.3 `instrumentLoad` 的判断逻辑改造

```js
function instrumentLoad(ast, isTypeof) {
    if (ast.type === 'Identifier') {
        // ... 现有的 undefined/NaN/Infinity/沙盒变量 特判 ...

        if (_scope.hasVar(ast.name)) {
            const isGlobal = _scope.isGlobal(ast.name);

            // ── 新增：轻量路径判断 ──
            const canUseLightweight =
                !isGlobal &&
                !_scope.usesEval() &&
                _scope.hasOwnVar(ast.name) !== 'catch' &&  // 精确查当前作用域
                ast.name !== 'arguments';

            if (canUseLightweight) {
                return wrapReadLightweight(ast, createLiteralAst(ast.name), _scope.id);
            }
            // ── 原有：重路径 ──
            return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isGlobal);
        }
        // ... 其余不变 ...
    }
    // ... MemberExpression 等 ...
}
```

> **注意**：`hasOwnVar` 这里要语义上对的——一个局部变量可能在当前作用域声明，也可能从父作用域继承（闭包引用）。闭包引用的变量在另一个函数帧里，Shadow Memory 需要按 (scopeId, name) 查，而不是当前帧。Layer 2 暂时只处理"当前作用域自有变量"的情况，闭包引用保留重路径。

### 4.4 运行时 `J$.Rl` 实现

**文件**：`src/runtime/JalangiRuntime.js`

新增方法：

```js
/**
 * J$.Rl — 轻量变量读取钩子。
 * 不接受 value 参数，从 shadow frame 中查当前值。
 *
 * @param {number} iid      - 指令 ID
 * @param {number} scopeId  - 静态词法作用域 ID
 * @param {string} name     - 变量名
 * @returns {*}             - 变量当前值（从 shadow frame 查到，或 undefined）
 */
Rl(iid, scopeId, name) {
    // 从 shadow frame 中查值
    const val = this.#shadowFrameLookup(scopeId, name);
    // 派发给分析插件（如果有）
    if (this.analysis?.read) {
        const ret = this.analysis.read(iid, name, val, /*isGlobal*/ false, /*isScriptLocal*/ false);
        return ret?.result ?? val;
    }
    return val;
}
```

`#shadowFrameLookup` 依赖 Shadow Memory 服务（Layer 3 完整实现前，可先 fallback 到从全局对象查）。

---

## 五、Layer 3：完整 def-use 分析（SSA 化）

### 5.1 目标

通过数据流分析，在 AST 级别确定哪些 `J$.R` **完全可以省略**（不是轻量化，而是彻底删除），条件是：

- 读取点的唯一 reaching definition 是同一作用域内的某次 `J$.W`
- 在 definition 到 use 的路径上，没有任何其他写入（包括 `J$.P` 可能触发的引用变异）

### 5.2 新增第三个 AST Pass

**文件**：`src/instrument/esnstrument.js`，`transformString` 函数

当前是两个 pass：

```js
newAst = transformString(code,
    [visitorRRPost, visitorOps],
    [visitorRRPre,  undefined],
    sourceType);
```

改为三个 pass：

```js
newAst = transformString(code,
    [visitorRRPost, visitorOps, visitorDeadReadElim],
    [visitorRRPre,  undefined,  undefined],
    sourceType);
```

`visitorDeadReadElim` 是后序 visitor，遍历已插桩的 AST（此时 `J$.R`/`J$.Rl` 已经注入），识别可删除的调用。

### 5.3 数据流分析实现：`src/instrument/dataflow.js`（新文件）

**输入**：`addScopes` 之后、第一个 pass 之前的原始 AST  
**输出**：一张 `Map<IID, 'dead'|'lightweight'|'full'>` 表，供第一个 pass 参照

**算法**：

```
对每个作用域（Scope）做局部数据流分析：

1. 扫描该作用域的 body，构建 variable → List<AssignmentNode> 的 def-sites 表
2. 对每个 use-site（Identifier in RHS context）：
   a. 收集到达该 use-site 的所有 definitions（reaching definitions）
   b. 如果 reaching defs 为空 → 全局变量或未声明，保留完整 J$.R
   c. 如果 reaching defs = 1 → 可走 J$.Rl（轻量）
   d. 如果该 def 是当前作用域内唯一的写入，且路径上无分支 → 可省略 J$.R（dead read）
3. 对象引用检测：
   a. 如果 def 的右值是 ObjectExpression 或 ArrayExpression → 引用类型，不能省略（属性可能被 P 修改）
   b. 如果存在任何 MemberExpression 写入 → 触发全作用域的 read-full 降级
```

**实现复杂度说明**：

完整的 reaching definition 分析需要构建 CFG（控制流图），这对以下语句需要特殊处理：
- `if/else`、`while`、`for`、`switch`：分支汇合点的 def 集合是各分支的 union
- `try/catch`：catch 块内对变量的赋值也是 reaching definition
- `break/continue/return`：提前退出路径

一个**保守的近似算法**（避免构建完整 CFG）：

> 如果一个变量在当前函数体内只有**一次赋值**（包含参数默认值），则所有读取可走轻量路径。  
> 如果有**多次赋值**，保留完整路径。

这个近似在实践中覆盖了大量纯函数式代码的情况（`const` 声明、函数参数）。

### 5.4 对 `const` 的特殊优化

Babel AST 中 `VariableDeclaration.kind` 为 `'const'` 时，变量不可重赋值。对于 `const` 声明的变量：

- 其所有 use-site 的 reaching definition **唯一且确定**
- 不存在引用变异（基础类型）时，读取 **100% 可省略**
- 是引用类型（对象/数组）时，`J$.Rl` 仍需保留（属性可能被 `J$.P` 修改）

在 `scope.js` 的 `handleVar` 中记录 `kind`：

```js
// 当前
currentScope.addVar(node.id.name, 'var');

// 改为
currentScope.addVar(node.id.name, node.parent?.kind === 'const' ? 'const' : 'var');
```

（需要在遍历时传递父节点引用，或在 `addScopes` 的 `visitorPre.VariableDeclaration` 中先记录 kind，`visitorPre.VariableDeclarator` 再用）

---

## 六、Shadow Memory 改造：按 (scopeId, name) 查值

### 6.1 现有 SMemory 的局限

`SMemory` 当前维护的是按**对象引用**索引的影子对象（`WeakMap` 语义），用于追踪 heap 上的对象。  
但变量（基础类型值 + 局部变量槽）没有对应的 shadow storage。

### 6.2 新增：Shadow Frame（变量影子帧）

`JalangiRuntime` 中新增一个按 `(scopeId, name)` 索引的变量影子帧机制：

```js
// JalangiRuntime 私有状态
#shadowFrameMap = new Map();  // scopeId → Map<name, value>

#shadowFrameSet(scopeId, name, value) {
    let frame = this.#shadowFrameMap.get(scopeId);
    if (!frame) { frame = new Map(); this.#shadowFrameMap.set(scopeId, frame); }
    frame.set(name, value);
}

#shadowFrameLookup(scopeId, name) {
    return this.#shadowFrameMap.get(scopeId)?.get(name);
}
```

**与 `J$.W` 联动**：每次 `J$.W(iid, name, val, lhs, flags)` 成功时，若 flags 表明是局部变量（`!isGlobal`），同步更新 shadow frame：

```js
W(iid, name, val, lhs, flags) {
    const [isGlobal, isScriptLocal, isDeclaration] = decodeBitPattern(flags, 3);
    // ... 现有逻辑 ...
    if (!isGlobal) {
        // 查当前函数帧对应的 scopeId（需要在 Fe 时压栈）
        const scopeId = this.#currentScopeId;
        if (scopeId !== undefined) this.#shadowFrameSet(scopeId, name, val);
    }
    // ...
}
```

**与函数帧栈联动**：`J$.Fe`（函数入口）时压入 `scopeId`，`J$.Fr`（函数出口）时弹出：

```js
Fe(iid, f, dis, args) {
    this.#scopeIdStack.push(this.#currentScopeId);
    // scopeId 需要从插桩时注入——Fe 调用需要增加一个参数
    // ...
}
```

> **关键设计决策**：ScopeID 是**静态**的（每个词法作用域唯一），但同一函数可能被调用多次（递归、闭包），每次调用是不同的**运行时帧**。因此 Shadow Frame 需要按**调用栈深度**区分，而不只是按 ScopeID。  
> 解决方案：Shadow Frame Map 的 key 改为 `(scopeId, callDepth)` 的复合键，`Fe` 时维护每个 scopeId 的调用计数。

---

## 七、完整的数据流（改造后）

以 `let x = 1; let y = x + x;` 为例：

### 当前行为（重路径）
```js
// 插桩后代码（伪简化）
let x = J$.W(8,  'x', J$.T(1, 1, 22, false), x, flags_local_decl);
let y = J$.W(40, 'y',
    J$.B(32, '+',
        J$.R(16, 'x', x, flags_local),   // ← 多余
        J$.R(24, 'x', x, flags_local)    // ← 多余
    ),
    y, flags_local_decl
);
```

### Layer 2 改造后（轻量路径）
```js
let x = J$.W(8,  'x', J$.T(1, 1, 22, false), x, flags_local_decl);
let y = J$.W(40, 'y',
    J$.B(32, '+',
        J$.Rl(16, scopeId_0, 'x'),   // 不传 value，运行时从 shadow frame 查
        J$.Rl(24, scopeId_0, 'x')
    ),
    y, flags_local_decl
);
```

### Layer 3 改造后（const / 单次赋值）
```js
// 如果是 const x = 1：
const x = J$.W(8, 'x', J$.T(1, 1, 22, false), x, flags_const_decl);
let y = J$.W(40, 'y',
    J$.B(32, '+', x, x),   // J$.R 直接删除！
    y, flags_local_decl
);
```

---

## 八、对现有钩子签名的影响

改造后各钩子签名变化一览：

| 钩子 | 当前签名 | 改造后签名 | 变化说明 |
|------|---------|-----------|---------|
| `J$.R` | `(iid, name, val, flags)` | `(iid, name, val, flags, scopeId?)` | 增加可选 scopeId |
| `J$.W` | `(iid, name, val, lhs, flags)` | `(iid, name, val, lhs, flags, scopeId?)` | 增加可选 scopeId |
| `J$.Rl` | 无 | `(iid, scopeId, name)` | **新增**轻量读取钩子 |
| `J$.Fe` | `(iid, f, dis, args)` | `(iid, f, dis, args, scopeId?)` | 增加可选 scopeId（用于 shadow frame 压栈） |
| `J$.N` | `(iid, name, val, flags)` | `(iid, name, val, flags, scopeId?)` | 增加可选 scopeId |

所有新增参数均为**可选**（尾部追加），保证向后兼容——现有分析插件不需要修改签名即可继续工作。

---

## 九、实施顺序与依赖关系

```
Step 1：scope.js — 给 Scope 分配 id，补 addEval() 调用
        ↓
Step 2：scope.js + iid.js — resetScopeCounter() 集成到 initialize()
        ↓
Step 3：wrappers.js — 增加 wrapReadLightweight()，修改 instrumentLoad()
        ↓
Step 4：wrappers.js + esnstrument.js — 向 J$.R/J$.W/J$.Fe/J$.N 传入 scopeId
        ↓
Step 5：JalangiRuntime.js — 增加 J$.Rl 方法，增加 Shadow Frame 机制
        ↓
Step 6：instrument/dataflow.js（新文件）— 实现 def-use 分析
        ↓
Step 7：esnstrument.js — 增加第三个 pass（visitorDeadReadElim）
        ↓
Step 8：测试 + 对比分析插件兼容性验证
```

---

## 十、风险与边界条件

### 10.1 `with` 语句
`with(obj) { x }` 中的 `x` 可能引用 `obj.x`，完全打败静态分析。
**处理**：`Scope` 需要新增 `hasWith` 标志（类似 `hasEval`），`wrappers.js` 中在 `visitorOps.WithStatement` 时调用 `currentScope.addWith()`。任何 `hasWith()===true` 的作用域退回全量路径。

### 10.2 闭包引用
外层变量被内层函数捕获时，写入可能来自多个帧：
```js
function outer() {
    let x = 1;
    function inner() { x = 2; }  // 写入 outer 的 x
    inner();
    console.log(x);  // 这里 x 的值需要从 outer 的帧里查
}
```
**处理**：读取点的 scopeId 应该是**定义点**的 scopeId，不是读取处函数的 scopeId。需要在 `instrumentLoad` 中沿作用域链向上找到 `hasOwnVar(name)` 为真的那个 Scope 的 id。

### 10.3 参数默认值
```js
function f(x = readSomeGlobal()) { ... }
```
参数默认值表达式在求值时可能有副作用，不能被省略。这类情况在 Layer 3 中需要保守处理：默认值是表达式的参数，读取时保留完整 `J$.R`。

### 10.4 `arguments` 对象
箭头函数没有 `arguments`，但普通函数的 `arguments` 是动态对象，不走轻量路径（已在 Layer 2 条件中排除）。

### 10.5 Proxy 对象
如果变量持有 Proxy，读取（get trap）本身有副作用，不能省略。这是运行时无法静态预知的情况，Layer 3 的 const 优化对引用类型保守处理即可覆盖大部分风险。

---

## 十一、待讨论的开放问题

1. **ScopeID 与调用深度**：Shadow Frame 的 key 到底用什么？`scopeId` 是静态的，同一函数多次调用会共享同一 scopeId。需要引入 `callId`（每次 `Fe` 分配）来区分。这会让 `J$.Rl` 变成 `J$.Rl(iid, callId, name)`——callId 是**运行时**的，需要从 `Fe` 传下来并在每个函数体内可访问。这意味着插桩代码需要在函数体内声明一个局部变量 `const __callId__ = J$.currentCallId`……实现复杂度显著增加。

2. **Config 开关**：是否需要为 Layer 2/3 的行为分别增加 Config 字段（如 `INSTR_USE_LIGHTWEIGHT_READ`、`INSTR_DEAD_READ_ELIM`）？还是始终开启？

3. **分析插件兼容性**：现有的 `dlint`、`datatraces` 等插件是否监听了 `J$.R`？如果分析插件依赖"每次读取都触发 R"，Layer 3 的 dead read elimination 会破坏其语义。解决方案：在插件注册时检测，若插件实现了 `read` 钩子，则自动降级为 Layer 2（保留 `J$.Rl`，不做 dead elimination）。

4. **eval 的边界**：`eval` 作为参数（`foo(eval)`，不调用）是否也应触发 `addEval()`？目前的设计是只有当 `eval` 出现在 `CallExpression.callee` 位置时才标记，这是合理的。

---

## 十二、本文档版本历史

| 版本 | 日期 | 内容 |
|------|------|------|
| v0.1 | 2026-03-04 | 初稿，基于对项目实际代码的完整分析 |
