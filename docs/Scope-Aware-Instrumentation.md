# 高强度混淆 JS 动态分析工具——完整改造方案

> **文档状态**：v0.5 — **全部 TODO-1~18 均已完成实施**（含 Wave 5 的 OID/ContextID/DataFlowAnalyzer/AntiDetection/TypedArrayBackend/dataflow.js/第三 AST Pass）  
> **来源**：基于与 Gemini 的技术对话（22 轮问答）+ 对当前 Jalangi2 项目代码的实际分析  
> **最终目标**：构建一套工业级 JS 动态逆向分析工具，核心能力包括：
> 1. **作用域感知的精简插桩**——用"左值状态机"替代无差别右值 log，消除代码体积膨胀
> 2. **SSA 化的运行时数据流分析**——对 trace log 做 backward slicing，还原被 VMP/混淆保护的算法逻辑
> 3. **对象别名追踪**——用 OID（对象唯一 ID）+ 版本号处理 `a=b={}` 类的引用变异
> 4. **异步执行上下文追踪**——用 ContextID/CallID 解决异步 log 交叉感染问题
> 5. **反插桩对抗**——隐藏插桩指纹，绕过恶意代码的自校验检测

---

## 第一部分：背景与问题诊断

### 1.1 当前插桩的核心痛点

当前版本已经用 Babel 完成了迁移（`@babel/parser` + `@babel/generator`），但插桩策略仍是原始的"无差别右值 log"：每个 `Identifier` 在 RHS 上下文都注入 `J$.R`，每个属性读取注入 `J$.G`，导致：

- **代码体积膨胀约 10 倍**：原本 `x + y` 变成 `J$.B(iid, '+', J$.R(iid, 'x', x, flags), J$.R(iid, 'y', y, flags))`
- **JIT 优化被破坏**：V8 无法对多层包裹的表达式做 Inline 优化，性能显著下降
- **log 充斥冗余信息**：同一变量在两次写入之间的所有读取，值完全相同，记录意义接近于零

```js
// 原始代码
let x = 1;
let y = x + x;  // x 被读了两次，值都是 1

// 当前插桩后（每次读取都触发回调）
let x = J$.W(8,  'x', J$.T(1, 1, 22, false), x, 0b001);
let y = J$.W(40, 'y',
    J$.B(32, '+',
        J$.R(16, 'x', x, 0b00),  // ← 第一次读 x（值 = 1）
        J$.R(24, 'x', x, 0b00)   // ← 第二次读 x（值还是 1，完全冗余）
    ),
    y, 0b001
);
```

### 1.2 从 Gemini 对话中提炼的核心洞察

**Q6（性能问题）** 确认了根本原因：  
> "放弃记录 R-Value：如果你已经记录了所有左值（L-Value）的变更，那么在调试时，你可以通过回溯上一次赋值来推断当前的右值。"  
> "追踪重点：赋值语句（AssignmentExpression）+ 函数调用返回值（CallExpression）+ 非确定性 API（Math.random, Date.now）"

**Q11（控制流扁平化）** 确认了数据流优先策略：  
> "控制流是虚幻的，只有数据流才是真实的。"  
> "即使算法被切成了 1000 个 case，只要追踪了赋值，在数据流图里就能一眼看清主干。"

**Q12（SSA 建议）** 提供了 log 后处理的核心算法：  
> "为每一次赋值创建一个唯一的寄存器 ID，维护 LastWrite 表，构建动态数据流图（DDG）。"

**Q2（作用域建议）** 奠定了本方案的核心前提：  
> "有了作用域追踪，可以给同名变量打上唯一 ID（如 a_scope1, a_scope2）。"

### 1.3 当前项目作用域基础设施的实际状态

项目中已有作用域雏形，但存在以下具体的**未完成项**（已通过代码审查确认）：

| 已有能力 | 实际缺陷 |
|----------|---------|
| `Scope` 类含 `vars`、`hasVar`、`isGlobal` | `Scope` 无唯一 ID，运行时无法区分同名变量的词法归属 |
| `Scope.hasEval` 标志 + `addEval()` 方法 | `addEval()` **从未在 `addScopes` 中被调用**，该标志永远为 `false` |
| `instrumentLoad` 中调用 `_scope.hasVar` | 只用来区分全局/局部，没有做任何跳过或降级决策 |
| `J$.N` 在函数入口同步变量初始值 | 运行时已拿到初始值，但 `J$.R` 读取时又重复传值 |
| `Scope.hasWith` **不存在** | `with` 语句打败一切静态分析，但没有保护标志 |

---

## 第二部分：完整 TODO 列表

以下是从 Gemini 对话中提炼 + 与当前代码实际情况对照后，得出的完整改造任务清单，按依赖关系排序：

```
TODO-1  scope.js      — 补全 addEval() 调用（安全基础）             ✅ 已完成
TODO-2  scope.js      — 新增 hasWith 标志和 addWith() 调用          ✅ 已完成
TODO-3  scope.js      — 给每个 Scope 分配唯一 ID                    ✅ 已完成
TODO-4  scope.js      — 记录变量声明 kind（const/let/var）           ✅ 已完成
TODO-5  wrappers.js   — 闭包变量定义域追踪（_findDefScope）          ✅ 已完成
TODO-6  esnstrument.js — resetScopeCounter() 集成进 instrumentCode() ✅ 已完成
TODO-7  wrappers.js   — 向 J$.R/J$.W/J$.Fe 传入 scopeId             ✅ 已完成
TODO-8  wrappers.js   — 新增 wrapReadLightweight()，修改 instrumentLoad() ✅ 已完成
TODO-9  esnstrument.js — 新增第三个 AST Pass（def-use 分析驱动的插桩决策）  ✅ 已完成
TODO-10 instrument/   — 新增 dataflow.js（SSA def-use 分析模块）          ✅ 已完成
TODO-11 JalangiRuntime.js — Shadow Frame 机制（按 callId+name 索引）  ✅ 已完成
TODO-12 JalangiRuntime.js — 新增 J$.Rl 方法（轻量读取钩子）           ✅ 已完成
TODO-13 JalangiRuntime.js — CallID 机制（每次 Fe 分配唯一调用 ID）    ✅ 已完成
TODO-14 JalangiRuntime.js — 对象 OID 机制（为对象分配唯一 ID + 版本号）     ✅ 已完成
TODO-15 JalangiRuntime.js — 异步 ContextID 机制（async/await 追踪 ID）     ✅ 已完成
TODO-16 runtime/      — 新增 DataFlowAnalyzer.js（运行时 SSA + backward slicing） ✅ 已完成
TODO-17 runtime/      — 新增 AntiDetection.js（反插桩对抗：toString Hook 等）      ✅ 已完成
TODO-18 runtime/logging/backends/ — 新增 TypedArrayBackend.js（TypedArray 环形缓冲区）✅ 已完成
```

---

## 第二点五部分：并发实施分析

### 精确依赖图

基于对实际代码文件的分析，各 TODO 的依赖关系如下：

```
文件维度：
  scope.js     → 独立模块（只依赖 Constants.js + astUtil.js）
  iid.js       → 独立模块（零外部依赖）
  wrappers.js  → 依赖 scope.js（通过 esnstrument.js 的 setScope()）+ iid.js
  esnstrument.js → 依赖 scope.js + wrappers.js + iid.js
  dataflow.js  → 依赖 scope.js（新文件，静态分析，不依赖 runtime）
  JalangiRuntime.js → 独立运行时（不依赖 instrument/ 中任何文件）
  DataFlowAnalyzer.js → 独立运行时后处理（不依赖 instrument/）

TODO 间依赖：
  TODO-3 (ScopeID) ←必须先于← TODO-5 (闭包定义域) + TODO-7 (传 scopeId) + TODO-10 (dataflow.js)
  TODO-6 (resetScopeCounter) ←必须先于← TODO-3 (ScopeID) 真正可用
  TODO-1 (addEval) + TODO-2 (hasWith) ←必须先于← TODO-8 (轻量路径判断条件)
  TODO-4 (kind 记录) ←必须先于← TODO-10 (dataflow.js 的 const 优化分支)
  TODO-5 (闭包定义域) ←必须先于← TODO-8 (wrapReadLightweight 中的 defScope.id)
  TODO-7 (scopeId 传参) ←必须先于← TODO-11 (Shadow Frame 的 W() 集成)
  TODO-8 (J$.Rl 插桩端) ←必须先于← TODO-12 (J$.Rl 运行时端，两端联调)
  TODO-11 (Shadow Frame) ←必须先于← TODO-12 (J$.Rl 查 frame)
  TODO-13 (CallID) ←必须先于← TODO-11 (Shadow Frame 的 callId key)
  TODO-10 (dataflow.js) ←必须先于← TODO-9 (第三个 pass 消费决策表)
  TODO-14 (OID) 独立于 TODO-13 (CallID)，两者可并发
  TODO-15 (ContextID) 独立于 TODO-14 (OID)，两者可并发
  TODO-16 (DataFlowAnalyzer) 独立于 TODO-17 (反插桩对抗)，两者可并发
  TODO-18 (TypedArray) 完全独立于其他所有 runtime TODO
```

---

### 可并发实施矩阵

以下图示中，**同一波次**的 TODO 之间无依赖，可由不同开发者同时开展。

```
Wave 1（完全独立，可 4 路并发）
┌────────────────┬────────────────┬────────────────┬────────────────┐
│   TODO-1       │   TODO-2       │   TODO-3+6     │   TODO-18      │
│ addEval()调用  │ hasWith 标志   │ ScopeID 分配   │ TypedArray log │
│ scope.js 3行   │ scope.js 15行  │ scope.js+esn.js│ 新文件独立开发 │
│ 触碰文件：1    │ 触碰文件：2    │ 触碰文件：2    │ 触碰文件：1    │
└────────────────┴────────────────┴────────────────┴────────────────┘
  注意：TODO-3 改 scope.js（新增 id 字段和 resetScopeCounter），TODO-6 改 esnstrument.js
        （调用 resetScopeCounter）。两文件不同，可并发；建议合并成一个 PR 一并提交

Wave 2（依赖 Wave 1 的 TODO-3+6 完成）
┌────────────────┬────────────────┬────────────────┐
│   TODO-4       │   TODO-5       │   TODO-13      │
│ kind 记录      │ 闭包定义域追踪  │ CallID 机制    │
│ scope.js       │ scope.js       │ JalangiRuntime │
│ 触碰文件：1    │ 触碰文件：2    │ 触碰文件：1    │
└────────────────┴────────────────┴────────────────┘
  注意：TODO-4 和 TODO-5 都改 scope.js，建议同一人做或 rebase 协调

Wave 3（依赖 Wave 1 的 TODO-1+2 和 Wave 2 的 TODO-5+13 完成）
┌────────────────┬────────────────┬────────────────┐
│   TODO-7       │   TODO-11      │   TODO-10      │
│ 传 scopeId     │ Shadow Frame   │ dataflow.js    │
│ wrappers.js    │ JalangiRuntime │ 新文件独立开发 │
│ 触碰文件：1    │ 触碰文件：1    │ 触碰文件：1    │
└────────────────┴────────────────┴────────────────┘
  注意：TODO-7 改 wrappers.js，TODO-11 改 JalangiRuntime，TODO-10 是新文件，三者完全独立

Wave 4（依赖 Wave 3 的对应 TODO 完成）
┌────────────────┬────────────────┬────────────────┬────────────────┐
│   TODO-8       │   TODO-12      │   TODO-9       │   TODO-14      │
│ 轻量路径插桩端  │ J$.Rl 运行时  │ 第三 AST Pass  │ OID 机制       │
│ 依赖 TODO-7    │ 依赖 TODO-11   │ 依赖 TODO-10   │ JalangiRuntime │
│ wrappers.js    │ JalangiRuntime │ esnstrument.js │ 独立开发       │
└────────────────┴────────────────┴────────────────┴────────────────┘
  注意：TODO-8 和 TODO-12 需要联调（插桩端+运行时端配对），建议同一人或强协调

Wave 5（依赖 Wave 4 的对应 TODO 完成，或完全独立）
┌────────────────┬────────────────┬────────────────┐
│   TODO-15      │   TODO-16      │   TODO-17      │
│ 异步 ContextID │DataFlowAnalyzer│ 反插桩对抗     │
│ 依赖 TODO-13   │ 依赖 TODO-14   │ 独立开发       │
│ JalangiRuntime │ 新文件         │ 新文件/wrappers│
└────────────────┴────────────────┴────────────────┘
  注意：TODO-16 和 TODO-17 完全独立，TODO-15 只依赖 TODO-13
```

---

### 关键并发机会（3 处最高价值）

**1. Wave 1 的 scope.js 改动 vs TypedArray 改动**  
`scope.js` 全部 4 个 TODO（1/2/3/4/5/6）都在同一文件，但 TODO-18（TypedArray）完全是一个新文件 `TypedArrayBackend.js`，**可以在 Wave 1 就并发开始**，不需要等任何先决条件。

**2. Wave 3 的三路并发（最关键）**  
这是整个方案中并发收益最大的一波：
- `TODO-7`（wrappers.js）— 插桩侧改动
- `TODO-11`（JalangiRuntime.js）— 运行时侧改动  
- `TODO-10`（dataflow.js）— 全新文件，零冲突

三者改动的文件完全不重叠，可以 **3 路完全并发**，是整个方案的加速主战场。

**3. Wave 5 的三个分析工具 TODO**  
TODO-15、16、17 都是"功能增强"性质，彼此完全独立，且都不影响现有插桩行为，可以在主链路（Wave 1-4）完成后完全并发实施。

---

### 单人顺序实施时的最短路径

如果只有一个人实施，优先级最高的最短关键路径（Critical Path）为：

```
TODO-1 → TODO-2 → TODO-3+6 → TODO-5 → TODO-13 → TODO-7+11 → TODO-8+12 → 验证
(scope安全)  (scopeID)  (闭包域)  (CallID)  (传参+frame)  (轻量路径联调)
```

这条路径完成后，**轻量读取路径（J$.Rl）** 即可端到端工作，可以实测性能提升数据。

TODO-4 → TODO-10 → TODO-9（const dead read 消除）是第二条路径，可以在第一条路径完成后开始。

---

## 第三部分：各 TODO 详细实施方案

---

### TODO-1：补全 `addEval()` 调用

**文件**：`src/instrument/scope.js`  
**优先级**：🔴 最高（所有后续优化的安全基础）  
**工作量**：极低（3 行代码）

**问题**：`Scope.hasEval` 标志和 `addEval()` 方法已存在，但 `addScopes` 的遍历从未检测 `eval` 标识符。这意味着任何包含 `eval` 的作用域，当前代码都**错误地**认为可以安全做静态分析。

**改动位置**：`addScopes()` → `visitorPost.Identifier`（实际代码在 `scope.js` L233-L240，`visitorPost` 对象内）：

```js
// 现有代码（scope.js L233-L240）
Identifier(node, context) {
    if (context === CONTEXT.RHS
            && node.name === FROM_NAME
            && currentScope?.hasOwnVar(TO_NAME)) {
        node.name = TO_NAME;
    }
    return node;
},
```

**改动后**：

```js
Identifier(node, context) {
    // 已有：arguments 重命名
    if (context === CONTEXT.RHS
            && node.name === FROM_NAME
            && currentScope?.hasOwnVar(TO_NAME)) {
        node.name = TO_NAME;
    }
    // 新增：检测 eval 出现（只要 eval 作为标识符被读取，即标记整条作用域链）
    // 注意：eval 作为普通参数传递（foo(eval)）也应标记，因为它可能在外部被调用
    if (node.name === 'eval') {
        currentScope?.addEval();
    }
    return node;
},
```

**影响**：所有后续的"轻量读取路径"和"dead read 消除"在 `usesEval()===true` 的作用域内自动降级为全量路径，保证语义正确性。

---

### TODO-2：新增 `hasWith` 标志

**文件**：`src/instrument/scope.js`  
**优先级**：🔴 高（`with` 语句和 `eval` 一样打败静态分析）  
**工作量**：低

`with(obj) { x }` 中的 `x` 可能引用 `obj.x` 而非局部变量，无法静态判断。

**改动 1**：`Scope` 类新增标志。注意当前 `Scope` 类的字段顺序（scope.js L31-L39）：

```js
class Scope {
    constructor(parent, isCatch) {
        // 已有
        this.vars     = {};
        this.funLocs  = {};
        this.funNodes = {};
        this.hasEval      = false;
        this.hasArguments = false;
        this.parent  = parent;
        this.isCatch = isCatch;
        // 新增（追加在末尾）
        this.hasWith_ = false;
    }

    addWith() {
        for (let s = this; s !== null; s = s.parent) s.hasWith_ = true;
    }
    usesWith() { return this.hasWith_; }
}
```

**改动 2**：在 `esnstrument.js` 的 `visitorOps.WithStatement` 中（实际代码在 L471-L474），在原有 `wrapWith` 调用之前标记：

```js
// esnstrument.js visitorOps（现有代码 L471-L474）
WithStatement(node) {
    // 新增：标记当前作用域使用了 with
    W.getScope()?.addWith();
    // 已有：
    node.object = W.wrapWith(node.object);
    return node;
},
```

> **注意**：`addScopes` 阶段 `visitorPost` 中也需要检测 `WithStatement`，以便在静态分析阶段就标记（而不只依赖运行时 visitor）。`addScopes` 中同样需要加 `WithStatement(node) { currentScope?.addWith(); return node; }` 到 `visitorPost`。

**影响**：`usesWith()===true` 的作用域和 `usesEval()===true` 处理方式相同——退回全量路径。

---

### TODO-3：给每个 Scope 分配唯一 ID

**文件**：`src/instrument/scope.js`  
**优先级**：🔴 高（后续所有 scopeId 传递的前提）  
**工作量**：低

**问题**：混淆代码大量复用变量名（整个程序只有 `a, b, c`）。没有 ScopeID，运行时 `J$.W(iid, 'a', ...)` 中的 `'a'` 是哪个作用域的 `a` 完全无从区分，数据流分析不可靠。

**改动**：在 `scope.js` 顶部（当前 L19-L21 的 import 之后）新增计数器，并在 `Scope` 构造器（L31）中分配 id：

```js
// scope.js 顶部（import 之后，Scope 类之前）
let _scopeIdCounter = 0;

/** 每次 instrumentCode 调用前重置，保证插桩幂等性 */
function resetScopeCounter() {
    _scopeIdCounter = 0;
}

class Scope {
    constructor(parent, isCatch) {
        this.id       = _scopeIdCounter++;  // 新增：唯一词法作用域 ID
        this.vars     = {};
        this.funLocs  = {};
        this.funNodes = {};
        this.hasEval      = false;
        this.hasArguments = false;
        this.parent  = parent;
        this.isCatch = isCatch;
    }
    // ... 方法不变
}

// 导出末尾增加 resetScopeCounter
export { Scope, addScopes, collectParamNames, resetScopeCounter };
```

**与 IID 初始化集成**（参见 TODO-6）：`iid.js` 的 `initialize()` 不应直接依赖 `scope.js`（会产生新的循环依赖风险）。正确的集成位置是 `esnstrument.js` 的 `instrumentCode()` 函数，在现有的 `IID.initialize(...)` 和 `W.resetPerFile()` 调用之后（L643-L644）直接追加 `resetScopeCounter()`，需要同时在文件顶部增加 import。

---

### TODO-4：记录变量声明 kind（const/let/var）

**文件**：`src/instrument/scope.js`  
**优先级**：🟡 中（`const` 变量的 dead read 消除依赖此信息）  
**工作量**：低

Babel AST 中 `VariableDeclaration.kind` 为 `'const'` 时，变量不可重赋值。这是最强的静态优化依据——`const` 基础类型变量的所有读取都可以完全省略 `J$.R`。

**改动 1**：`Scope.addVar` 签名增加 `kind` 参数：

```js
// 当前：addVar(name, type, loc, node)
// 改为：addVar(name, type, loc, node, kind?)

addVar(name, type, loc, node, kind) {
    const target = (this.isCatch && type !== 'catch') ? this.parent : this;
    if (target.vars[name] !== 'arg') {
        target.vars[name] = type;
    }
    // 新增：记录 kind（'const' | 'let' | 'var' | undefined）
    if (kind) {
        target.varKinds = target.varKinds ?? {};
        target.varKinds[name] = kind;
    }
    if (type === 'defun') {
        target.funLocs[name]  = loc;
        target.funNodes[name] = node;
    }
}

/** 返回变量的声明 kind，或 null */
getVarKind(name) {
    for (let s = this; s !== null; s = s.parent) {
        if (s.varKinds?.[name]) return s.varKinds[name];
    }
    return null;
}
```

**改动 2**：`addScopes` 的 `handleVar` 中，在 `VariableDeclaration` 的 pre visitor 里先记录 `kind`，再在 `VariableDeclarator` 里传给 `addVar`：

```js
// addScopes() 内部
let _currentDeclKind = null;

const visitorPre = {
    // 新增：在 VariableDeclaration 层面记录 kind
    VariableDeclaration(node) {
        _currentDeclKind = node.kind;  // 'const' | 'let' | 'var'
    },
    VariableDeclarator: handleVar,
    // ...
};

const visitorPost = {
    // 新增：VariableDeclaration 处理完后重置
    VariableDeclaration(node) {
        _currentDeclKind = null;
        return node;
    },
    // ...
};

function handleVar(node) {
    if (!node.id) return;
    if (node.id.type === 'Identifier') {
        currentScope.addVar(node.id.name, 'var', undefined, undefined, _currentDeclKind);
    } else {
        const names = [];
        collectParamNames(node.id, names);
        for (const n of names) currentScope.addVar(n, 'var', undefined, undefined, _currentDeclKind);
    }
}
```

---

### TODO-5：闭包变量定义域追踪（定义点 scopeId）

**文件**：`src/instrument/scope.js` + `src/instrument/wrappers.js`  
**优先级**：🟡 中（轻量路径的核心正确性保证）  
**工作量**：中

**问题**：闭包引用时，读取点和定义点不在同一个作用域：

```js
function outer() {
    let x = 1;              // 定义点：outer 的 Scope（scopeId=0）
    function inner() {
        console.log(x);     // 读取点：inner 的 Scope（scopeId=1），但 x 属于 scopeId=0
        x = 2;              // 写入点：也是 inner，但写的是 outer 的 x
    }
}
```

如果 `J$.Rl(iid, scopeId_inner, 'x')` 用的是 inner 的 scopeId，运行时 shadow frame 里找不到 `x`（因为 `x` 的值存在 outer 的 frame 里）。

**方案**：在 `instrumentLoad` 中，沿作用域链向上查找到**第一个 `hasOwnVar(name)` 为真**的 Scope，用那个 Scope 的 id：

```js
// wrappers.js
function instrumentLoad(ast, isTypeof) {
    if (ast.type === 'Identifier') {
        // ... 特判 undefined/NaN/Infinity/沙盒变量 ...

        if (_scope.hasVar(ast.name)) {
            // 新增：沿作用域链向上找到变量实际定义的作用域
            const defScope = _findDefScope(_scope, ast.name);
            const isGlobal = _scope.isGlobal(ast.name);
            const varKind  = defScope?.getVarKind(ast.name);

            const canUseLightweight =
                defScope !== null &&
                !isGlobal &&
                !_scope.usesEval() &&
                !_scope.usesWith() &&
                defScope.hasOwnVar(ast.name) !== 'catch' &&
                ast.name !== 'arguments';

            if (canUseLightweight) {
                return wrapReadLightweight(ast, createLiteralAst(ast.name), defScope.id, varKind);
            }
            return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isGlobal);
        }
        // ...
    }
}

/** 沿作用域链向上查找变量实际定义的 Scope */
function _findDefScope(scope, name) {
    for (let s = scope; s !== null; s = s.parent) {
        if (s.hasOwnVar(name)) return s;
    }
    return null;
}
```

---

### TODO-6：resetScopeCounter() 集成到 instrumentCode()

**文件**：`src/instrument/esnstrument.js`（主要改动）+ `src/instrument/scope.js`（新增导出）  
**优先级**：🔴 高（幂等性保证）  
**工作量**：极低（2 处改动）

每次 `instrumentCode` 被调用时，必须重置 ScopeID 计数器，否则同一段代码多次插桩会产生不同的 ScopeID，破坏 source map 的确定性。

> **注意**：文档旧版本（摘要版）写的是"集成到 `iid.js` 的 `initialize()`"，但这会引入 `iid.js → scope.js` 的新依赖，增加循环风险。实际正确位置是 **`esnstrument.js` 的 `instrumentCode()`**，其中现有初始化序列（L643-L644）为：
> ```js
> IID.initialize(isEval, options.instCodeFileName, options.origCodeFileName);
> W.resetPerFile();
> ```
> 只需在此之后追加 `resetScopeCounter()`，并在文件顶部的 `import { addScopes } from './scope.js'` 中增加 `resetScopeCounter` 的具名导入即可。

**改动**（`esnstrument.js` 的 `instrumentCode` 中）：

```js
// instrumentCode() 中现有的初始化行（L643 附近）
IID.initialize(isEval, options.instCodeFileName, options.origCodeFileName);
W.resetPerFile();
resetScopeCounter();  // 新增：从 scope.js 具名导入，保证 ScopeID 幂等性
```

**`scope.js` 的对应改动**：仅在 `export` 语句中增加 `resetScopeCounter`（见 TODO-3）。

---

### TODO-7：向钩子传入 scopeId

**文件**：`src/instrument/wrappers.js`  
**优先级**：🟡 中（核心数据质量提升）  
**工作量**：中

当前 `J$.R`/`J$.W`/`J$.Fe`/`J$.N` 的签名中没有 ScopeID。加上 ScopeID 后，运行时 log 就能区分"函数 A 里的 x" 和 "函数 B 里的 x"，这是 SSA 化 log 的先决条件。

**所有变化均为尾部追加可选参数，向后兼容。**

#### J$.W 改动（`wrapWrite`，`wrappers.js`）

实际插桩端当前模板（L404）：

```js
// 当前模板（wrappers.js L404，wrapWrite 函数内）
`${logWriteFunName}(${RP}1, ${RP}2, ${RP}3, ${RP}4,${createBitPattern(isGlobal, isScriptLocal, isDeclaration)})`

// 改为（scopeId 作为第 6 个参数，0 = 全局/未知）
`${logWriteFunName}(${RP}1, ${RP}2, ${RP}3, ${RP}4,${createBitPattern(isGlobal, isScriptLocal, isDeclaration)},${scopeId ?? 0})`
```

`scopeId` 由调用方（`instrumentStore`）传入，来自 `_findDefScope()` 的结果。

**运行时端 `W()` 当前签名**（`JalangiRuntime.js` L339）：
```js
W(iid, name, val, lhs, flags)  // → 需改为 W(iid, name, val, lhs, flags, scopeId)
```

#### J$.R 改动（`wrapRead`，`wrappers.js`）

实际插桩端当前模板（L370）：

```js
// 当前模板（wrappers.js L370，wrapRead 函数内）
`${logReadFunName}(${RP}1, ${RP}2, ${RP}3,${createBitPattern(isGlobal, isScriptLocal)})`

// 改为（scopeId 作为第 5 个参数）
`${logReadFunName}(${RP}1, ${RP}2, ${RP}3,${createBitPattern(isGlobal, isScriptLocal)},${scopeId ?? 0})`
```

**运行时端 `R()` 当前签名**（`JalangiRuntime.js` L326）：
```js
R(iid, name, val, flags)  // → 需改为 R(iid, name, val, flags, scopeId)
```

#### J$.Fe 改动（`createCallAsFunEnterStatement`，`wrappers.js`）

实际代码在 `wrappers.js` L763-L771，模板字符串在 L767：

```js
// 当前模板（wrappers.js L767，createCallAsFunEnterStatement 函数内）
`${logFunctionEnterFunName}(${RP}1,(function(){try{return arguments.callee}catch(e){return undefined}}()), this, arguments)`

// 改为（第 5 个参数传入当前函数的 scopeId）
`${logFunctionEnterFunName}(${RP}1,(function(){try{return arguments.callee}catch(e){return undefined}}()), this, arguments, ${currentScopeId})`
```

`currentScopeId` 在 `instrumentFunctionEntryExit` 调用时（`wrappers.js` L960），从 `_scope.id` 读取（在 `setScope` 之后可用）。

**运行时端 `Fe()` 当前签名**（`JalangiRuntime.js` L401）：
```js
Fe(iid, f, dis, args)  // → 需改为 Fe(iid, f, dis, args, scopeId)
```

---

### TODO-8：新增轻量读取路径

**文件**：`src/instrument/wrappers.js`  
**优先级**：🟡 中（性能优化核心）  
**工作量**：中

**设计原则**：对于"静态可信的局部变量读取"，不传 `value`，只传 `(iid, callId, name)`。运行时从 Shadow Frame 查值，而不是从代码求值传入。

**条件判断（必须全部满足才走轻量路径）**：

| 条件 | 检查方式 | 不满足时的行为 |
|------|---------|-------------|
| 变量在词法上已声明 | `_scope.hasVar(name)` | 退回 `J$.R` 全量 |
| 不是全局变量 | `!_scope.isGlobal(name)` | 退回 `J$.R` 全量 |
| 作用域内无 `eval` | `!_scope.usesEval()` | 退回 `J$.R` 全量 |
| 作用域内无 `with` | `!_scope.usesWith()` | 退回 `J$.R` 全量 |
| 不是 `catch` 参数 | `defScope.hasOwnVar(name) !== 'catch'` | 退回 `J$.R` 全量 |
| 不是 `arguments` | `name !== 'arguments'` | 退回 `J$.R` 全量 |
| 不是 Proxy 持有者（运行时无法静态判断） | 对引用类型保守处理（走 `J$.Rl` 但不删除） | 走 `J$.Rl` |

**新增函数**：

```js
// wrappers.js 中新增
let logReadLightFunName;  // 在 _rebuildNames() 中设置为 `${v}.Rl`

function wrapReadLightweight(node, name, defScopeId, varKind) {
    if (!Config.INSTR_READ || Config.INSTR_READ(name, node)) {
        IID.printIidToLoc(node);
        // callId 在运行时由 J$.currentCallId 提供（通过 Fe 时注入的局部变量）
        const ret = replaceInExpr(
            `${logReadLightFunName}(${RP}1, ${defScopeId}, ${RP}2)`,
            IID.getIid(), name
        );
        transferLoc(ret, node);
        return ret;
    }
    return node;
}
```

> **关于 callId**：轻量路径最终需要的是 `(defScopeId, callId, name)` 三元组来查 Shadow Frame，其中 callId 是运行时动态分配的。但 callId 在插桩时不可知，需要在运行时由 `J$.Fe` 注入一个局部变量（见 TODO-13）。最终签名为 `J$.Rl(iid, defScopeId, name)`，运行时内部通过 defScopeId 对应的当前 callId 来查 frame。

---

### TODO-9：新增第三个 AST Pass（def-use 分析驱动）

**文件**：`src/instrument/esnstrument.js`  
**优先级**：🟠 中低（Layer 3 优化，依赖 TODO-10）  
**工作量**：中

当前 `transformString` 执行两个 pass（`visitorRRPost` + `visitorOps`）。新增第零个 pass（在所有现有 pass 之前），对原始 AST 做数据流分析，生成决策表；后续 pass 查表决定插桩级别。

**改动**：

```js
// esnstrument.js，transformString 函数
function transformString(code, visitorsPost, visitorsPre, sourceType) {
    const newAst = babelParse(code, sourceType);
    addScopes(newAst);
    
    // 新增：Pass 0 — def-use 分析，生成插桩决策表
    const instrDecisions = analyzeDefUse(newAst);  // 来自 dataflow.js
    // 将决策表注入 wrappers 模块（通过 init 或全局状态）
    W.setInstrDecisions(instrDecisions);
    
    for (let i = 0; i < visitorsPost.length; i++) {
        transformAst(newAst, visitorsPost[i], visitorsPre[i], CONTEXT.RHS);
    }
    return newAst;
}
```

**决策表结构**（由 `dataflow.js` 输出）：

```js
// Map<nodeKey, 'full' | 'lightweight' | 'dead'>
// nodeKey = `${scopeId}:${name}:${line}:${col}` （唯一标识一个 use-site）
const instrDecisions = new Map([
    ['0:x:2:8',  'dead'],        // const x，读取可省略
    ['0:y:3:8',  'lightweight'], // let y，读取轻量
    ['1:a:10:5', 'full'],        // 有 eval 的作用域，全量
]);
```

---

### TODO-10：新增 `dataflow.js`（SSA def-use 分析模块）

**文件**：`src/instrument/dataflow.js`（新文件）  
**优先级**：🟠 中低（Layer 3 核心）  
**工作量**：高

**输入**：`addScopes` 之后的原始 AST（还未插桩）  
**输出**：`Map<nodeKey, Decision>` 决策表

**算法设计**（分两个阶段）：

#### 阶段 1：构建 Def-Sites 表

遍历每个函数作用域，收集所有的赋值点：

```
对每个 FunctionDeclaration / FunctionExpression / ArrowFunctionExpression：
  扫描其 body，构建：
    defSites: Map<name, List<{node, kind, isConditional}>>
    - kind: 'param' | 'var' | 'const' | 'let' | 'assign'
    - isConditional: 该赋值是否在分支内（if/while/try 等）
```

#### 阶段 2：对每个 use-site 做决策

```
对每个 Identifier（RHS 上下文）：
  1. 如果作用域含 eval 或 with → 'full'
  2. 如果是全局变量 → 'full'
  3. 查 defSites[name]：
     a. 如果 defSites 为空 → 'full'（未知来源）
     b. 如果 defSites 只有一个，且 isConditional=false：
        - 如果 kind='const' 且值是基础类型（字面量）→ 'dead'
        - 如果 kind='const' 且值是引用类型 → 'lightweight'
        - 如果 kind='param' 且无重赋值 → 'lightweight'
        - 其他情况 → 'lightweight'
     c. 如果 defSites 有多个（任何分支赋值）→ 'lightweight'
  4. 对象引用安全检查：
     - 如果作用域内存在 MemberExpression 写入（J$.P 操作）→
       降级持有该对象的所有变量读取为 'lightweight'（不 'dead'）
```

**保守近似原则**（避免错误的 dead 判定）：

宁可错判成 `lightweight`，也不错判成 `dead`。以下情况一律保守：
- 变量被传入函数（可能被修改）
- 变量在 `try` 块内（catch 可能赋值）
- 变量是 `arguments[N]` 的别名
- 作用域内有任何 `eval` 或 `with`

---

### TODO-11：Shadow Frame 机制

**文件**：`src/runtime/JalangiRuntime.js`  
**优先级**：🔴 高（`J$.Rl` 能正常工作的前提）  
**工作量**：中

**核心设计**：Shadow Frame 是一个按 `(defScopeId, callId)` 复合键索引的 Map，其中：
- `defScopeId`：变量**定义点**的词法作用域 ID（静态，插桩时确定）
- `callId`：运行时**函数调用的唯一 ID**（动态，每次 `Fe` 时分配）

**为什么需要 callId**：同一个函数被调用多次（递归、闭包、异步并发），每次调用的局部变量是独立的，必须用 callId 区分。

```js
// JalangiRuntime.js 新增私有状态
#callIdCounter     = 0;
#currentCallId     = 0;        // 当前帧的 callId
#callIdStack       = [];       // 函数调用栈（存 callId，用于 Fe/Fr 配对）
#shadowFrameMap    = new Map();// (defScopeId << 32 | callId) → Map<name, value>

// 查找某个 (defScopeId, callId) 下变量的当前值
#shadowFrameLookup(defScopeId, callId, name) {
    const key = `${defScopeId}:${callId}`;
    return this.#shadowFrameMap.get(key)?.get(name);
}

// 写入某个 (defScopeId, callId) 下变量的值
#shadowFrameSet(defScopeId, callId, name, value) {
    const key = `${defScopeId}:${callId}`;
    let frame = this.#shadowFrameMap.get(key);
    if (!frame) { frame = new Map(); this.#shadowFrameMap.set(key, frame); }
    frame.set(name, value);
}

// 清理某个 callId 的所有帧（Fr 时调用，防内存泄漏）
#shadowFrameClear(defScopeId, callId) {
    this.#shadowFrameMap.delete(`${defScopeId}:${callId}`);
}
```

**与 `J$.W` 联动**：每次局部变量写入时，同步更新 Shadow Frame：

```js
W(iid, name, val, lhs, flags, scopeId) {
    const [isGlobal, isScriptLocal, isDeclaration] = decodeBitPattern(flags, 3);
    // ... 现有分析插件分发逻辑 ...

    // 新增：同步更新 Shadow Frame（仅限局部变量）
    if (!isGlobal && scopeId !== undefined) {
        this.#shadowFrameSet(scopeId, this.#currentCallId, name, val);
    }
    return val;
}
```

**与 `J$.Fe` / `J$.Fr` 联动**：

```js
Fe(iid, f, dis, args, scopeId) {
    // 已有逻辑 ...
    
    // 新增：分配新的 callId，压栈
    const newCallId = ++this.#callIdCounter;
    this.#callIdStack.push({ callId: this.#currentCallId, scopeId });
    this.#currentCallId = newCallId;
    
    // ... 其余逻辑
}

// 注意：Fr 现有签名是 Fr(iid)，isBacktrack 是其返回值，不是参数（JalangiRuntime.js L410）
Fr(iid) {
    // 新增：弹栈，恢复上一帧的 callId（插入在已有逻辑的末尾）
    const frame = this.#callIdStack.pop();
    if (frame) {
        // 清理当前帧的 shadow frame（防内存泄漏）
        // 注意：闭包场景下不能立即清理，需要 GC 检测——暂时先保留
        this.#currentCallId = frame.callId;
    }
    // ... 其余逻辑（含原有的 isBacktrack 计算和返回）
}
```

---

### TODO-12：新增 `J$.Rl` 方法

**文件**：`src/runtime/JalangiRuntime.js`  
**优先级**：🔴 高（轻量读取路径的运行时实现）  
**工作量**：低

```js
/**
 * J$.Rl — 轻量变量读取钩子。
 * 不接受 value 参数，从 Shadow Frame 中查当前值。
 *
 * 对应插桩代码：J$.Rl(iid, defScopeId, name)
 *
 * @param {number} iid        - 指令 ID（用于 source map 定位）
 * @param {number} defScopeId - 变量定义点的词法作用域 ID（静态）
 * @param {string} name       - 变量名
 * @returns {*}               - 变量当前值
 */
Rl(iid, defScopeId, name) {
    const val = this.#shadowFrameLookup(defScopeId, this.#currentCallId, name);
    
    // 分发给分析插件（保持与 J$.R 相同的插件接口）
    if (this.analysis?.read) {
        const ret = this.analysis.read(iid, name, val, false, false);
        return ret?.result ?? val;
    }
    return val ?? undefined;
}
```

**注意**：`J$.Rl` 的返回值直接替换了原本的 `Identifier` 节点（即 `x`），因此必须返回变量的当前值，否则后续的 `J$.B`、`J$.P` 等会收到 `undefined`。

---

### TODO-13：CallID 机制（异步执行追踪）

**文件**：`src/runtime/JalangiRuntime.js` + `src/instrument/wrappers.js`  
**优先级**：🟡 中（异步 log 正确性）  
**工作量**：高

**问题**：JS 的异步执行（async/await、Promise、setTimeout）会导致 log 交叉感染：

```
[全局序号] 1  函数A：x = 1
[全局序号] 2  函数B（异步，插队执行）：x = 2
[全局序号] 3  函数A（await 恢复后）：y = x + 1  ← 此时 x 是 B 写的 2，还是 A 自己的 1？
```

如果只按全局序号回溯，无法区分。

**方案：为每个异步任务分配 ContextID**

```js
// JalangiRuntime.js
#asyncContextId    = 0;
#currentContextId  = 0;

/** 创建新的异步上下文（在 Promise、setTimeout 等回调注入） */
newAsyncContext() {
    const id = ++this.#asyncContextId;
    return id;
}

/** 激活一个异步上下文 */
activateContext(contextId) {
    this.#currentContextId = contextId;
}
```

**插桩端改动**（`wrappers.js`）：

对 `AwaitExpression` 和 `YieldExpression` 进行特殊包装，在 `await` 恢复后触发一次上下文切换标记：

```js
// visitorRRPost 新增
AwaitExpression(node) {
    // await 后注入上下文恢复标记
    IID.printIidToLoc(node);
    const ret = replaceInExpr(
        `(await ${RP}1, ${_jalangiVar}.Aw(${RP}2))`,
        node.argument, IID.getIid()
    );
    return ret;
},
```

`J$.Aw(iid)` 是新增的"await 恢复点"钩子，通知运行时当前异步上下文已恢复。

**log 格式增强**：所有 `J$.W`、`J$.R`、`J$.Rl` 的 log 条目自动附加当前 `contextId`，后处理分析时按 contextId 过滤，还原单个异步任务的完整逻辑线。

---

### TODO-14：对象 OID 机制（别名追踪）

**文件**：`src/runtime/JalangiRuntime.js`  
**优先级**：🟡 中（SSA 数据流分析的正确性）  
**工作量**：高

**问题（来自 Gemini Q13）**：

```js
let a = {};       // J$.T 时为对象分配 OID_1
let b = a;        // b 也指向 OID_1
b.x = 1;          // J$.P 修改的是 OID_1，但变量 a 的 J$.W 没有被触发
// 此时读 a.x，如果只看变量层面，会认为 a 没有变过
```

**方案**：

1. **分配 OID**：在 `J$.T`（literal）钩子中，当字面量是对象/数组/函数时，为其分配唯一 OID：

```js
// JalangiRuntime.js
#oidCounter  = 0;
#oidMap      = new WeakMap();  // 对象 → OID

#getOrCreateOid(obj) {
    if (obj === null || typeof obj !== 'object' && typeof obj !== 'function') return null;
    if (this.#oidMap.has(obj)) return this.#oidMap.get(obj);
    const oid = ++this.#oidCounter;
    this.#oidMap.set(obj, oid);
    return oid;
}
```

2. **记录别名表**：在 `J$.W` 中，当右值是对象时，记录 `variableName → OID` 的映射：

```js
W(iid, name, val, lhs, flags, scopeId) {
    // ... 现有逻辑 ...
    const oid = this.#getOrCreateOid(val);
    if (oid !== null) {
        // 记录别名：这个变量现在指向 OID oid
        this.#aliasTable.set(`${scopeId}:${this.#currentCallId}:${name}`, oid);
    }
}
```

3. **记录对象版本号**：在 `J$.P`（putField）中，对象被修改时，递增其版本号：

```js
P(iid, base, offset, val, flags) {
    const oid = this.#getOrCreateOid(base);
    if (oid !== null) {
        this.#objectVersions.set(oid, (this.#objectVersions.get(oid) ?? 0) + 1);
    }
    // ... 现有逻辑 ...
}
```

4. **log 格式**：`J$.W` 的 log 条目增加 `oid` 字段；`J$.P` 的 log 条目包含 `oid` + `version`。后处理分析器通过 OID 关联所有别名的修改历史。

**GC 注意点（来自 Gemini Q21）**：`WeakMap` 不阻止 GC，但 log 里记录了 OID。如果一个对象被 GC 后，同一 OID 被新对象占用，分析器会产生混乱。解决方案：在分配 OID 时，将对象的**创建位置（iid + scopeId）**一同记录到 log 的元数据中，分析器通过 `(oid, creationIid)` 二元组来唯一标识对象实体。

---

### TODO-15：异步 ContextID 机制（详细实现）

**文件**：`src/runtime/JalangiRuntime.js` + `src/instrument/wrappers.js`  
**优先级**：🟡 中  
**工作量**：高

**完整的异步上下文追踪方案**：

在插桩阶段，对以下位置注入 ContextID 管理代码：

| 位置 | 插桩操作 |
|------|---------|
| `async function` 入口 | 调用 `J$.Fe` 时，同时分配新 ContextID |
| `await expr` 处 | 在 await 之前快照 contextId，await 之后恢复 |
| `setTimeout/setInterval` 的回调 | 包装回调函数，入口分配新 ContextID |
| `Promise.then/catch/finally` 的回调 | 同上 |
| `new Promise` 的 executor | 同上 |

**log 格式**：

```
[全局序号][ContextID][CallID] scopeId:name = value
```

后处理分析时，按 ContextID 分组，每组是一条独立的异步执行线；ContextID 相同的条目按全局序号排列，还原出该异步任务的完整逻辑时序。

---

### TODO-16：新增 `DataFlowAnalyzer.js`（运行时 SSA + backward slicing）

**文件**：`src/runtime/DataFlowAnalyzer.js`（新文件）  
**优先级**：🟠 低（分析工具层，不影响插桩核心）  
**工作量**：高

这是一个**后处理分析器**，消费 Jalangi2 运行时产生的 log，在 log 上做 SSA 化 + 数据流分析，用于逆向还原算法逻辑。

**核心数据结构**：

```js
class DataFlowAnalyzer {
    // SSA 寄存器表：每次赋值 → 唯一寄存器 ID
    #registers = new Map();     // registerID → {iid, name, value, sources: Set<registerID>}
    #lastWrite  = new Map();    // (scopeId:callId:name) → registerID（当前 active register）
    #oidVersions = new Map();   // oid → currentVersion
    #aliasTable  = new Map();   // (scopeId:callId:name) → oid

    /**
     * 处理一条 W（write）log 条目
     * 为此次赋值创建新的 SSA 寄存器
     */
    processWrite(entry) {
        const { iid, scopeId, callId, name, value, oid } = entry;
        const regId = this.#registers.size;
        const key = `${scopeId}:${callId}:${name}`;
        // 查找此次赋值的右值来源（从上一次 processRead 的结果）
        const sources = this.#pendingReadSources ?? new Set();
        this.#registers.set(regId, { iid, name, value, oid, sources });
        this.#lastWrite.set(key, regId);
        if (oid) this.#aliasTable.set(key, oid);
        this.#pendingReadSources = null;
        return regId;
    }

    /**
     * 处理一条 R 或 Rl（read）log 条目
     * 记录"此次读取来自哪个 SSA 寄存器"
     */
    processRead(entry) {
        const { scopeId, callId, name } = entry;
        const key = `${scopeId}:${callId}:${name}`;
        return this.#lastWrite.get(key);  // 返回当前 active register
    }

    /**
     * 处理一条 P（putField）log 条目
     * 递增 OID 版本号，找到所有持有该 OID 的变量并标记为脏
     */
    processPutField(entry) {
        const { oid } = entry;
        const newVersion = (this.#oidVersions.get(oid) ?? 0) + 1;
        this.#oidVersions.set(oid, newVersion);
        // 找到所有 aliasTable 中 → oid 的变量，为它们创建新的 SSA 寄存器
        // （因为对象属性变化，持有该对象引用的变量的"语义值"也变了）
        for (const [key, mappedOid] of this.#aliasTable) {
            if (mappedOid === oid) {
                // 创建新寄存器，表示"该变量现在持有 OID 的新版本"
                this.#lastWrite.set(key, this.#createOidVersionRegister(key, oid, newVersion));
            }
        }
    }

    /**
     * Backward Slicing：从终点 registerID 出发，回溯所有影响它的赋值
     * 返回一个有序的赋值序列（即还原出的算法数据流）
     */
    backwardSlice(targetRegId) {
        const visited = new Set();
        const result  = [];
        const queue   = [targetRegId];
        while (queue.length > 0) {
            const regId = queue.shift();
            if (visited.has(regId)) continue;
            visited.add(regId);
            const reg = this.#registers.get(regId);
            if (!reg) continue;
            result.push(reg);
            for (const srcRegId of reg.sources) {
                queue.push(srcRegId);
            }
        }
        // 按 iid 升序排列（还原时间顺序）
        return result.sort((a, b) => a.iid - b.iid);
    }
}
```

**使用场景（来自 Gemini Q10/Q11/Q12）**：

1. **还原 VMP 算法**：找到 VMP 输出的加密结果（如 Cookie/Token），对其 backward slice，过滤掉控制流分发器变量（不通向最终结果的寄存器），剩下的就是算法核心数据流
2. **污点分析**：标记外部输入（`fetch` 返回值、`document.cookie` 等）为污点源，追踪污点传播路径
3. **逆向切片**：从已知输出逆推输入，还原混淆算法的逻辑

---

### TODO-17：反插桩对抗（Function.toString Hook）

**文件**：`src/runtime/JalangiRuntime.js` 或 新增 `src/runtime/AntiDetection.js`  
**优先级**：🟠 低（针对高度对抗性目标）  
**工作量**：中

**问题（来自 Gemini Q8）**：恶意脚本常用以下方式检测插桩：

1. `Function.prototype.toString()` 检测函数体是否被注入了追踪代码
2. 全局变量检测（`typeof __trace !== 'undefined'`）
3. 性能异常检测（某些操作比正常慢 10 倍以上）
4. 调用栈深度检测（`new Error().stack` 看到异常多的 `J$` 调用）

**对策 1：toString Hook**（最关键）

在脚本初始化时（`J$.Se` 前），替换 `Function.prototype.toString`：

```js
// AntiDetection.js
export function installToStringHook(originalCodeMap) {
    const _origToString = Function.prototype.toString;
    // originalCodeMap: iid → 原始函数代码字符串（插桩时收集）
    Object.defineProperty(Function.prototype, 'toString', {
        value: function() {
            const orig = originalCodeMap.get(this);
            if (orig !== undefined) return orig;
            return _origToString.call(this);
        },
        writable: false,
        configurable: false,
        enumerable: false,
    });
}
```

**对策 2：全局变量隐藏**

当前项目的 IIFE 包裹（`(function(J$){ ... }(typeof J$!=='undefined'?J$:{}))`）已经提供了作用域隔离，`J$` 不暴露为 `window.J$`。确认恶意脚本无法通过 `window.J$` 或 `globalThis.J$` 检测到存在。

**对策 3：轻量化 log 减少性能开销**

TODO-8 的轻量读取路径本身就能大幅减少插桩开销，是性能检测对抗的最佳实践。此外，使用 TypedArray 环形缓冲区替代 JSON 对象（见 TODO-18）。

**对策 4：AST 层面静态抹除检测代码（来自 Gemini Q9）**

构建"对抗插件"，在插桩前扫描 AST，识别并抹除已知的检测模式：

```js
// 在 esnstrument.js 中，transformString 之前，增加一个 antiDetection pass
const visitorAntiDetection = {
    // 模式 1：Function.toString() 长度检测
    // 识别：if (fn.toString().length > N) { ... }
    IfStatement(node) {
        if (isToStringLengthCheck(node.test)) {
            // 将 test 替换为 false（静态抹除）
            node.test = { type: 'BooleanLiteral', value: false };
        }
        return node;
    },
    // 模式 2：arguments.callee.toString() 检测
    MemberExpression(node, context) {
        if (isArgumentsCalleeToString(node)) {
            return { type: 'StringLiteral', value: 'function(){}' };
        }
        return node;
    },
    // ... 更多模式
};
```

---

### TODO-18：TypedArray 环形缓冲区 log（性能优化）

**文件**：`src/runtime/logging/backends/TypedArrayBackend.js`（新文件）  
**优先级**：🟠 低（极端性能场景）  
**工作量**：高

> **现状**：`src/runtime/logging/RingBuffer.js` 已存在，使用普通 Array 实现环形缓冲区（注释中已说明 SharedArrayBuffer 版本因 COOP/COEP header 限制而暂不使用）。TODO-18 的目标是在 `backends/` 目录下新增一个 TypedArray 变体，作为可插拔后端，而不是修改现有 `RingBuffer.js`。

**问题（来自 Gemini Q6）**：当前 log 使用 JS 对象数组，每次 `J$.W` 都 push 一个对象，导致：
- 大量 GC 压力（短命对象）
- 事件循环阻塞（异步场景下 I/O 成为瓶颈）

**方案**：使用 `SharedArrayBuffer` + `Float64Array` 作为环形缓冲区，将 log 条目编码为定长二进制格式：

```
每条 log 条目 = 4 × Float64（32 字节）：
  [0] = iid（uint32，作为 float64 存储）
  [1] = scopeId（uint32）+ callId（uint32，高低位打包）
  [2] = value（float64，仅限数值；对象存 OID）
  [3] = metadata（操作类型 + flags，bit-packed）
```

对于非数值类型（字符串、对象），在 buffer 旁边维护一个小型的 `valueTable: Map<uint32, any>`，buffer 中存 valueTable 的 key。

**收益**：
- 零 GC 压力（预分配 buffer，循环复用）
- 写入速度提升 10-100 倍（直接写 typed array 比 push 对象快得多）
- 可以直接序列化为文件（`.bin` 格式），不需要 JSON 序列化

---

## 第四部分：实施优先级与依赖关系

```
阶段 A（必须先做，安全基础）
  TODO-1  补 addEval()
  TODO-2  补 hasWith 标志
  TODO-3  Scope 分配唯一 ID
  TODO-6  resetScopeCounter() 集成
  
    ↓

阶段 B（核心插桩优化，最高 ROI）
  TODO-4  记录 const/let/var kind
  TODO-5  闭包变量定义域追踪
  TODO-7  向钩子传 scopeId
  TODO-8  轻量读取路径 J$.Rl（插桩端）
  
    ↓

阶段 C（运行时基础设施）
  TODO-11  Shadow Frame 机制
  TODO-12  J$.Rl 运行时实现
  TODO-13  CallID 机制
  
    ↓

阶段 D（数据流分析层）
  TODO-10  dataflow.js（SSA def-use 分析）
  TODO-9   第三个 AST pass（dead read 消除）
  TODO-14  对象 OID 机制
  TODO-15  异步 ContextID 机制
  
    ↓

阶段 E（分析工具与对抗）
  TODO-16  DataFlowAnalyzer.js（backward slicing）
  TODO-17  反插桩对抗
  TODO-18  TypedArray 环形缓冲区（极端性能场景）
```

---

## 第五部分：钩子签名变化汇总

| 钩子 | 当前签名 | 改造后签名 | 变化说明 |
|------|---------|-----------|---------|
| `J$.R`  | `(iid, name, val, flags)` | `(iid, name, val, flags, scopeId?)` | 增加可选 scopeId |
| `J$.W`  | `(iid, name, val, lhs, flags)` | `(iid, name, val, lhs, flags, scopeId?)` | 增加可选 scopeId |
| `J$.Rl` | 无 | `(iid, defScopeId, name)` | **新增**轻量读取钩子 |
| `J$.Fe` | `(iid, f, dis, args)` | `(iid, f, dis, args, scopeId?)` | 增加可选 scopeId（用于 Shadow Frame 压栈） |
| `J$.Fr` | `(iid)` → 返回 `isBacktrack` | 不变 | Shadow Frame 弹栈在运行时内部处理 |
| `J$.N`  | `(iid, name, val, flags)` | `(iid, name, val, flags, scopeId?)` | 增加可选 scopeId |
| `J$.Aw` | 无 | `(iid)` | **新增** await 恢复点钩子 |

**向后兼容原则**：所有新增参数均为**尾部追加可选参数**。现有分析插件（`dlint`、`datatraces` 等）不需要修改签名即可继续工作。插件若不处理新参数，忽略即可。

---

## 第六部分：关键风险与边界条件

### 6.1 降级（Downleveling）的语义差异（Gemini Q19）

当前项目**不做降级**（直接在 Babel AST 上插桩，原样输出），这是正确决策：
- 降级 `async/await → Promise.then` 会改变 `arguments.callee` 和 `Function.length` 等属性，可能触发恶意代码的反调试逻辑
- 降级 `class → function` 会让 `instanceof` 行为不一致
- 降级 `let/const → var` 会消除 TDZ（Temporal Dead Zone）

**结论**：保持当前不降级的策略，但需要为 `async`/`generator` 函数的特殊语义提供专门的插桩处理（当前项目中 `wrapFunBodyWithTryCatch` 已经明确排除了 async 和 generator）。

### 6.2 海森堡效应：Getter 与 Proxy（Gemini Q21）

对 `obj.prop` 的读取（`J$.G`）可能触发 getter，而 getter 内部可能修改状态。这是无法避免的副作用——插桩本身就会"观察"这些 getter。当前 `J$.G` 已经插桩了属性读取，这部分无需特殊处理；但需要在分析器的文档中明确注意：**对属性读取的 log 并不保证纯粹性**。

### 6.3 原生 API 的非确定性（Gemini Q4）

`Math.random()`、`Date.now()`、`performance.now()` 是非确定性 API，它们的返回值是"外部输入"，必须在 log 中记录（当前 `J$.F`/`J$.M` 已经拦截了所有函数调用，包括这些 API）。如果要支持确定性重放（TTD），还需要在 `J$.F` 中识别这些 API 并将返回值存入 log。

### 6.4 Proxy 对象的不可见陷阱

如果变量持有 Proxy，读取（get trap）本身有副作用，不能省略 `J$.R`。这是运行时无法静态预知的情况。**保守策略**：TODO-4 中，`const` 变量若其值是对象/数组类型（通过 `J$.T` 分配了 OID），其读取走 `J$.Rl` 而非 dead read 消除，确保每次读取都经过运行时检查。

### 6.5 调用栈深度检测

恶意代码可能通过 `new Error().stack` 检查调用栈，发现大量 `J$` 相关调用帧后判定环境异常。轻量路径（TODO-8）本身减少了 `J$.R` 的调用层数，但 `J$.B`、`J$.G`、`J$.F` 等仍然存在。彻底解决需要 TODO-17 的反插桩对抗。

---

## 第七部分：本文档版本历史

| 版本 | 日期 | 内容 |
|------|------|------|
| v0.1 | 2026-03-04 | 初稿，基于对项目实际代码的完整分析 |
| v0.2 | 2026-03-04 | 大幅扩充：基于 Gemini 22 轮对话完整提炼，补充 SSA/数据流分析、对象 OID、异步 ContextID、反插桩对抗、TypedArray 缓冲区等内容；生成完整 18 项 TODO 清单及详细实施方案 |
| v0.3 | 2026-03-04 | 代码审查修正：逐行核对 TODO-1～18 与实际代码的差异，更正多处不准确描述。具体修正项：① TODO-1 精确说明 visitorPost.Identifier 的实际行号（L233-L240）；② TODO-2 修正 hasWith 字段在 Scope 构造器中的正确插入位置和 WithStatement 的二处注入点；③ TODO-3 增补完整的改动代码；④ TODO-6 **关键修正**：集成位置从 `iid.js/initialize()` 改为 `esnstrument.js/instrumentCode()`（L643-L644），避免循环依赖；⑤ TODO-7 补全实际行号（L370/L404/L767）和运行时端当前签名（L326/L339/L401）；⑥ TODO-11 修正 `Fr()` 签名（`isBacktrack` 是返回值非参数）；⑦ 并发矩阵修正文件名（`iid.js→esnstrument.js`）；⑧ 钩子签名汇总表修正 `Fr` 行；⑨ TODO-18 新增 `RingBuffer.js` 已存在的现状说明 |
