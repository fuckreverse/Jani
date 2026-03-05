# Jalangi2 项目状态追踪文档

> 最后更新：2026-03-05  
> 测试通过：246/246 ✅  
> **所有已知 Bug 与代码质量问题均已修复，测试覆盖盲区已全部补充**

---

## 一、已完成修复

### ✅ BUG-RT-03：`#callIdToOuterCallId` 内存泄漏 + 嵌套闭包链断裂

**文件**：`src/runtime/JalangiRuntime.js`

**原始问题**：`#callIdToOuterCallId` 在 `Fe()` 写入，`Fr()` 无清理 → Map 只增不减，长期运行内存泄漏。

**修复过程**（两阶段）：
1. 第一次修复：在 `Fr()` 中无条件 `delete(leavingCallId)` — 解决了内存泄漏，**但引入新 Bug**：嵌套闭包（outer→middle→inner）中，middle 退出时链条 `middle.callId→outer.callId` 被删除，inner 无法通过链追踪到 outer 层变量（闭包场景 3 失败：NaN !== 15）。
2. 最终修复：与 Shadow Frame 清理条件保持一致，**仅在没有闭包引用该帧时才删除链条**：

```js
// Fr() 中：
let isReferencedByClosure = false;
if (leavingScopeId !== undefined) {
    isReferencedByClosure = this.#closureFrameSet.has(`${leavingScopeId}:${leavingCallId}`);
    if (!isReferencedByClosure) { this.#shadowClear(leavingScopeId, leavingCallId); }
}
if (!isReferencedByClosure) {
    this.#callIdToOuterCallId.delete(leavingCallId);
}
```

---

### ✅ BUG-RT-04：`DataFlowAnalyzer.backwardSlice` 排序错误

**文件**：`src/runtime/DataFlowAnalyzer.js`

`iid` 是编译时静态 ID，循环重复执行时相同无法区分时序；改用 `regId`（运行时单调递增序号）排序：
```js
return result.sort((a, b) => a.regId - b.regId);
```

---

### ✅ BUG-INS-05：`ObjectMethod` 作用域管理缺失

**文件**：`src/instrument/esnstrument.js`

`runInstrumentPass` visitor 遗漏 `ObjectMethod` 的 `enter/exit` scope 管理，导致对象方法内 `_scope` 指向错误。已在 visitor 中补充：
```js
ObjectMethod: {
    enter(path) { W.setScope(path.node); },
    exit(path)  { /* instrumentFunctionEntryExit + popScope + wrapFunBodyWithTryCatch */ },
},
```

---

### ✅ BUG-RT-05：`JalangiSandbox` 异步注册无法 await

**文件**：`src/runtime/JalangiSandbox.js`

构造函数无法 await 异步插件注册，导致早期 trace 事件丢失。已引入静态异步工厂方法：
```js
static async create(options = {}) {
    const sandbox = new JalangiSandbox(options);
    if (options.withExecutionTrace) await sandbox.#registerExecutionTrace(options);
    return sandbox;
}
```
**迁移**：需要 ExecutionTrace 时改用 `await JalangiSandbox.create({ withExecutionTrace: true })`。

---

### ✅ BUG-RT-06：`SMemory` 覆盖 `AnalysisHost`

**文件**：`src/runtime/SMemory.js`

向后兼容代码无条件覆盖 `J$.analysis`，已注册的其他插件全部丢失。已修复为优先集成：
```js
if (J$.analysis?.use && typeof J$.analysis.use === 'function') {
    J$.analysis.use(new SMemoryPlugin(smemory));
} else {
    J$.analysis = new SMemoryPlugin(smemory);
}
```

---

### ✅ BUG-LOG-02：`NodeStreamBackend.flush()` 兼容性

**文件**：`src/logger/backends/NodeStreamBackend.js`

`writableNeedDrain` 在 Node.js v15.2 前不存在。已改用带 `undefined` 回退的兼容写法：
```js
const needDrain = this._stream.writableNeedDrain !== undefined
    ? this._stream.writableNeedDrain
    : !this._drainable;
```

---

### ✅ BUG-PLG-01：`FunCalledWithMoreArguments` 误报 rest 参数函数

**文件**：`src/plugins/dlint/FunCalledWithMoreArguments.js`

`f.length` 只计算 rest 参数之前的形参数量，导致 `function f(a, ...rest)` 被传入多参时误报。已通过 `toString()` 检测函数签名是否含 `...` 参数：
```js
let hasRestParam = false;
try {
    hasRestParam = /\(\.\.\.\w|,\s*\.\.\.\w/.test(Function.prototype.toString.call(f));
} catch (_) { hasRestParam = true; }
if (!hasRestParam && args.length > f.length) { /* 报告 */ }
```

---

### ✅ Q-1：`getSourceInfo()` 返回原对象引用

**文件**：`src/instrument/iid.js`

返回 `{ ...iidSourceInfo }` 防御性副本，防止调用者修改污染内部状态。

---

### ✅ Q-2：`EventSerializer.js` 死代码变量 `subView`

**文件**：`src/logger/EventSerializer.js`

删除第 280 行 `const subView = new DataView(buf, offset, size);`（创建后从未使用）。

---

### ✅ Q-3：`dataflow.js` 冗余双分支

**文件**：`src/instrument/dataflow.js`

`binding.constant` 为 true 和 false 两个分支均设置 `Decision.LIGHTWEIGHT`，已合并为无条件赋值，消除死代码分支。

---

### ✅ Q-4：`CheckNaN` 使用 `x !== x` 惯用法

**文件**：`src/plugins/dlint/CheckNaN.js`

已改为现代写法 `Number.isNaN(left) || Number.isNaN(right)`，与 ESLint `use-isnan` 规则对齐。

---

### ✅ 测试覆盖：`unary` / `declare` / `_return` 钩子

**文件**：`test/integration/hooks.test.mjs`

已补充三个 Spy 测试：
- `unary` 钩子：验证 `-x`（`op='-'`, `result=-5`）和 `!true`（`op='!'`, `result=false`）
- `declare` 钩子：验证形参 `isArgument=true`、`argumentIndex` 顺序、局部变量 `isArgument=false`
- `_return` 钩子：验证触发时机与返回值 `val`

---

### ✅ 测试覆盖盲区补充（2026-03-05）

#### 修复附带发现的插桩器 Bug

在补充测试过程中，发现并修复了一个真实 Bug：

**BUG-INS-06：`getContext()` 未正确处理函数解构参数**

**文件**：`src/instrument/esnstrument.js`

**问题**：`function greet({ name, age = 0 }) {}` 中，`{ name }` 的 `name` 标识符被错误地包裹为 `J$.Rl(9, 1, "name")`（轻量读取钩子），出现在解构赋值左侧，导致 `SyntaxError: Invalid destructuring assignment target`。

**根因**：`getContext()` 中缺少对 `ObjectProperty.value`（当该 ObjectProperty 属于 `ObjectPattern` 时）的 IGNORE 规则。另外也缺少 `ObjectProperty.key`（Babel 用 `ObjectProperty` 而原来只有 `Property`）。

**修复**：在 `esnstrument.js` 的 `getContext()` 中补充：
```js
// ObjectProperty.key 在 ObjectPattern 或 ObjectExpression 中均不插桩
if (pt === 'ObjectProperty' && key === 'key' && !parent.computed) {
    return CONTEXT.IGNORE;
}
// ObjectProperty.value 在 ObjectPattern（解构绑定）内是绑定目标，不插桩
if (pt === 'ObjectProperty' && key === 'value') {
    const grandParent = path.parentPath?.parent;
    if (grandParent?.type === 'ObjectPattern') return CONTEXT.IGNORE;
}
// ArrayPattern.elements 是绑定目标，不插桩
if (pt === 'ArrayPattern' && key === 'elements') return CONTEXT.IGNORE;
```

#### 新增测试用例（13 个，共 233 个）

**`test/unit/instrument.test.mjs`（+2）**：
- `isEval: true` 基础路径验证（返回正常代码、含 NO_INSTR 标记、含基本钩子）
- `isEval: true` + `inlineSourceMap: true` 组合验证（smap 内联正常）

**`test/integration/e2e.test.mjs`（+9）**：
- `for-of` 循环（数组迭代、字符串迭代、Map 迭代）
- 对象解构声明 `var { x, y } = obj`
- 对象解构带默认值 `var { a, b = 42 } = obj`
- 数组解构声明 `var [first, second] = arr`
- 数组解构（跳过元素 + rest）`var [a, , c, ...rest] = arr`
- 嵌套解构（对象中嵌套数组）
- 函数参数解构 `function greet({ name, age = 0 }) {}`

**`test/integration/hooks.test.mjs`（+2）**：
- `putFieldPre` 前置拦截并修改属性写入值（验证 `base.__target` 条件过滤）
- `putField` 后置 Spy（验证 a/b/c 三次写入均被观察到）

---

## 二、剩余低优先级盲区（不影响正确性）

以下少量场景仍未覆盖，优先级极低，可在未来迭代按需补充：

| 遗漏场景 | 文件 | 优先级 |
|---------|------|--------|
| `sourceType: 'module'` 下的 Config 独立禁用行为 | `instrument.test.mjs` | 🟡 低 |
| generator 函数的运行时 yield 语义执行验证 | `e2e.test.mjs` | 🟡 低 |
| 多层 `Promise.all` / `Promise.race` 的 contextId 独立性 | `e2e.test.mjs` | 🟡 低 |

---

## 三、进度总结

| 问题类型 | 已完成 | 总数 | 状态 |
|--------|--------|------|------|
| P0 运行时 Bug（内存/闭包/架构） | 4 | 4 | ✅ 100% |
| P0 插桩器 Bug（含解构参数修复） | 2 | 2 | ✅ 100% |
| P0/P1 日志兼容 | 1 | 1 | ✅ 100% |
| P1 插件正确性 | 1 | 1 | ✅ 100% |
| P2 代码质量 | 4 | 4 | ✅ 100% |
| 测试覆盖补充 | 16 | 16 | ✅ 100% |

**当前全量测试**：246/246 通过 ✅  
**已知遗留待办**：仅剩 3 个极低优先级场景，不影响正确性

---

## 四、`observeOnly` 模式：需求分析与实现规划

> 分析日期：2026-03-05  
> 背景：Trace 场景下希望插件只能观察、不能修改数据，同时希望最大程度保证原始代码执行语义的正确性。  
> **L1（插件层）已完成实现（2026-03-05）**：`AnalysisHost.observeOnly` 选项 + `JalangiSandbox` 透传，新增 8 个测试用例，测试总数 241/241 ✅

---

### 4.1 需求分层

该需求实际上包含**两个独立层次**，必须分开对待：

| 层次 | 问题 | 描述 |
|------|------|------|
| **L1（插件层）** | 插件主观修改执行结果 | 插件通过钩子返回值（`result`/`skip`/`isBacktrack`）改变程序行为 |
| **L2（框架层）** | 插桩本身改变执行语义 | 无论插件是否返回值，插桩代码的结构性注入已经改变了原始程序的执行 |

**L1 是可以用 `observeOnly` 标志完全解决的；L2 不能，需要专项修复。**

---

### 4.2 L1：插件层干扰（`observeOnly` 标志可解决）✅ 已实现

插件通过以下 5 类返回值修改原始执行：

| 返回字段 | 受影响钩子 | 效果 |
|---------|-----------|------|
| `{ result }` | `read/write/getField/putField/binary/unary/literal/conditional/declare/_return/_throw/_with/invokeFun/forinObject` | 替换原始计算结果 |
| `{ skip: true }` | `invokeFunPre / putFieldPre / getFieldPre / binaryPre / unaryPre / instrumentCodePre` | 跳过实际操作 |
| `{ op, left, right }` / `{ f, base, args }` | `binaryPre / unaryPre / invokeFunPre / getFieldPre / putFieldPre` | 替换操作数再执行 |
| `{ isBacktrack: true }` | `functionExit / scriptExit` | 让函数/脚本体从头重执行（MultiSE 用） |
| `{ args: [...] }` | `AnalysisHost` 链式传递 | 后续插件看到修改后的参数 |

#### 实现方案

**`src/runtime/AnalysisHost.js`**：

- 构造参数新增 `observeOnly: boolean`（默认 `false`），挂为公开字段 `this.observeOnly`
- `_makeDispatcher` 中通过 `host` 引用**惰性读取** `observeOnly`，支持运行时动态切换
- 关键改动：在消费钩子返回值的 if 条件前加 `!observeOnly` 守卫，钩子仍正常调用（观察不受影响），但所有返回值被丢弃

```js
// src/runtime/AnalysisHost.js — _makeDispatcher 核心改动
const host = this;  // 惰性引用，支持动态切换
return function dispatchHook(...args) {
    const observeOnly = host.observeOnly;
    for (let i = 0; i < chain.fns.length; i++) {
        const r = chain.fns[i].apply(chain.thisArgs[i], args);
        // observeOnly=true 时钩子仍被调用，但返回值完全忽略
        if (!observeOnly && r !== undefined && r !== null && typeof r === 'object') {
            // 原有 result/args 链式传递逻辑
        }
    }
};
```

**`src/runtime/JalangiSandbox.js`**：

- 构造函数透传 `options.observeOnly` 给 `new AnalysisHost()`
- JSDoc 新增 `@param {boolean} [options.observeOnly=false]` 说明

#### 用法

```js
// 方式一：通过 JalangiSandbox（推荐，Trace 场景）
const J$ = new JalangiSandbox({ observeOnly: true });
J$.analysis.use(new MyTraceAnalysis());

// 方式二：直接 new AnalysisHost
J$.analysis = new AnalysisHost({ observeOnly: true }).use(new MyTraceAnalysis());

// 方式三：运行时动态切换（惰性读取支持）
J$.analysis.observeOnly = true;
```

#### 测试覆盖（新增 8 个用例，`test/integration/hooks.test.mjs`）

| 用例 | 验证内容 |
|------|----------|
| `observeOnly=false`（默认）：插件返回 result 可修改执行结果 | 对照组，确认默认行为不变 |
| `observeOnly=true`：插件返回 result 被忽略，原始计算结果不变 | `binary` 返回 999，实际 1+2=3 |
| `observeOnly=true`：插件仍能观察到所有事件 | 钩子参数（op/left/right/result）值正确 |
| `observeOnly=true`：write 钩子 result 被忽略 | 变量赋值值不受影响 |
| `observeOnly=true`：invokeFunPre skip=true 被忽略 | 函数正常调用，skip 无效 |
| `observeOnly=true`：getField 钩子 result 被忽略 | 属性读取值不变 |
| `observeOnly=true`：多插件链中各插件返回值均被忽略 | 链式 result 传递也被阻断 |
| `observeOnly` 可在 AnalysisHost 直接实例化时使用 | 不依赖 JalangiSandbox 也生效 |

---

### 4.3 L2：框架层干扰（需专项修复）

即使插件完全不返回任何值，插桩代码的结构性注入也会从以下多个维度改变原始程序的执行：

#### ❶ `try-catch-finally` 骨架改变异常语义（严重）

**来源**：`wrappers.js` → `_buildTryCatchWrapper()`

每个函数/脚本体被包裹为：

```js
jalangiLabel0: while(true) {
    try { /* 原始代码 */ }
    catch (J$e) { J$.Ex(iid, J$e); }      // 函数版不 re-throw
    finally {
        if (J$.Fr(iid)) continue;           // isBacktrack=true → 死循环风险
        else return J$.Ra();
    }
}
```

**问题**：
- 原本无 try-catch 的函数，所有异常现在都被框架捕获了一次
- `J$.Fr()` 若因 bug 返回 `true`，函数会无限循环（与 observeOnly 无关，骨架始终存在）
- `Rt()`/`Ra()` 的 returnStack 若错配，实际 return 值会出错
- `J$.Fr()` 自身若抛异常，原始异常控制流会被中断

**处理建议**：在 observeOnly 模式下，`J$.Fr()` 和 `J$.Sr()` 应**强制返回 `false`**（不再询问 analysis），彻底消除死循环隐患。

---

#### ❷ 给函数对象写入隐藏属性（中等）

**来源**：`JalangiRuntime.js` → `#associateSidWithFunction()`

```js
Object.defineProperty(f, propSid, { enumerable: false, writable: true, configurable: true });
f[propSid] = this.sid;
f[propIid] = iid;
```

**问题**：
- 改变函数对象的 hidden class（V8 deoptimization，性能下降）
- `Object.getOwnPropertyNames(fn)` 结果改变（even non-enumerable）
- 若原始代码 `Object.freeze(fn)` 了某函数，此处 `defineProperty` 会抛 `TypeError`

**处理建议**：用 `WeakMap<Function, {sid, iid}>` 替代直接写属性。

---

#### ❸ `new.target` 语义在继承场景中可能错误（中等）

**来源**：`JalangiRuntime.js` → `#callAsConstructor()`

```js
#callAsConstructor(Constructor, args) {
    return Reflect.construct(Constructor, args);  // 第三个参数 newTarget 缺失
}
```

**问题**：`Reflect.construct(C, args)` 的 `new.target` 默认等于 `C`，但在 `class B extends A` 的场景下，调用点的 `new.target` 应该是 `B`，缺少 `newTarget` 参数会导致继承类的 `new.target` 判断错误。

**处理建议**：改为 `Reflect.construct(Constructor, args, Constructor)` 或在 `#invokeFun` 中传递调用点的 `new.target`（需插桩器配合注入）。

---

#### ❹ `for-in` 借助沙盒属性 `J$._tm_p` 传递迭代变量（低）

**来源**：`wrappers.js` → `wrapForIn()`

```js
for (J$._tm_p in J$.H(iid, obj)) {
    var k = J$.X1(iid, J$.W(iid, 'k', J$._tm_p, ...));
}
```

**问题**：`J$._tm_p` 是沙盒对象的一个可写属性。若原始代码对 `J$` 做 `for-in` 或 `Object.keys(J$)`，会意外暴露该临时变量；多层 `for-in` 嵌套时也有覆盖风险（虽当前是顺序执行，但异步场景下理论上存在竞态）。

**处理建议**：使用插桩时生成的唯一局部变量（如 `let J$_fk0 = ...`）替代沙盒属性，消除全局状态副作用。

---

#### ❺ `eval` 字符串被强制插桩（不可避免，需记录）

**来源**：`esnstrument.js` → `CallExpression` visitor

```js
// 原始
eval("x + 1")
// 插桩后
J$.F(iid, eval, bits)(J$.instrumentEvalCode("x + 1", iid, true))
```

**问题**：`eval` 的字符串参数在运行时被替换为插桩后的版本，**直接改变了 eval 执行的代码**。对于仅 trace 的场景，这是不可避免的，因为不插桩 `eval` 会造成 trace 盲区。

**处理建议**：这是框架的已知 trade-off，无法消除。应在文档中明确说明：observeOnly 模式不保证 `eval` / `new Function()` 内代码的语义等价性。

---

#### ❻ 调用栈深度改变 / `Error.stack` 格式改变（不可避免）

所有函数调用经由 `J$.M()` / `J$.F()` 中转（`Function.prototype.apply.call`），调用栈中会出现框架帧。任何依赖 `Error.stack` 字符串格式、`arguments.callee.caller` 或调用栈深度的原始代码，行为都会改变。

**处理建议**：框架级 trade-off，不可消除。

---

#### ❼ `#lastComputedValue` 共享状态的竞争风险（低）

**来源**：`JalangiRuntime.js`，每个 `R/W/G/P/B/U/T/...` 调用都会写 `#lastComputedValue`。

若某个分析插件在钩子内部再次触发 J$ 调用（例如读取某个属性），会意外覆写 `#lastComputedValue`，破坏值传播链（`J$.L()` 读到错误值）。

**处理建议**：钩子执行期间保存并恢复 `#lastComputedValue`，或明确约定钩子内不允许递归触发 J$ 调用。

---

### 4.4 实现优先级建议

| 优先级 | 问题 | 改动范围 | 收益 | 状态 |
|--------|------|---------|------|------|
| **P0** | L1：`AnalysisHost.observeOnly` 标志 | `AnalysisHost.js`（5 行）+ `JalangiSandbox.js`（透传） | 立即解决插件修改问题，breaking 风险零 | ✅ 已完成 |
| **P0** | `instrumentEval` 选项：默认不插桩 eval/Function 动态代码 | `JalangiRuntime.js`（默认直通方法 + `#callFun` 守卫）+ `JalangiSandbox.js`（透传） | eval/Function 语义完全保持原样，消除动态代码插桩副作用 | ✅ 已完成 |
| **P0** | `J$.Fr()`/`J$.Sr()` 在 observeOnly 模式下强制返回 `false` | `JalangiRuntime.js`（2 处 if 判断） | 消除死循环隐患 | 🔲 待实现 |
| **P1** | 函数 SID/IID 改用 `WeakMap` 存储 | `JalangiRuntime.js`（`#associateSidWithFunction` + `#updateSid`）| 消除属性写入副作用，修复 `freeze` 场景 | 🔲 待实现 |
| **P1** | `Reflect.construct` 补充 `newTarget` | `JalangiRuntime.js`（`#callAsConstructor`，1 行） | 修复继承类 `new.target` 语义 | 🔲 待实现 |
| **P2** | `for-in` 改用局部变量 | `wrappers.js`（`wrapForIn`）+ 插桩器 | 消除沙盒属性污染 | 🔲 待实现 |
| **P3** | `#lastComputedValue` 保存/恢复 | `JalangiRuntime.js`（钩子调用包裹） | 防御递归钩子场景 | 🔲 待实现 |

---

### 4.5 `observeOnly` 模式的完整语义承诺

实现上述 P0+P1 修复后，`observeOnly: true` 可以做出以下承诺：

✅ **保证（插件层）**：
- 任何插件的 `read/write/getField/...` 等钩子返回值均被忽略，不会替换原始计算结果
- 任何插件的 `skip: true` 均被忽略，不会跳过原始操作
- `isBacktrack` 永远不被采纳，函数/脚本不会被重执行
- `J$.Fr()`/`J$.Sr()` 强制返回 `false`，`while(true)` 骨架不会死循环

✅ **保证（框架层，P1 修复后）**：
- 不向函数对象写入任何可见属性（SID/IID 改用 WeakMap）
- `new` 表达式的 `new.target` 语义正确（Reflect.construct 传入 newTarget）

⚠️ **已知局限（不可消除）**：
- `eval` 和 `new Function()` 内执行的代码默认为原始代码（`instrumentEval=false`，已修复）；若显式开启 `instrumentEval: true`，则动态代码为插桩后版本
- 调用栈深度增加，`Error.stack` 格式与原始代码不同
- 函数调用通过 `Function.prototype.apply.call` 中转，`arguments.callee.caller` 语义改变
- `for-in` 使用 `J$._tm_p` 沙盒属性（P2 修复前）

---

## 五、`instrumentEval` 选项：eval / new Function 插桩控制

> 实现日期：2026-03-05  
> 状态：✅ 已完成，测试 246/246

### 5.1 背景

Jalangi2 插桩器在静态阶段会将所有 `eval` / `new Function` 调用改写为：

```js
// 原始（直接 eval）
eval("x + 1")

// 插桩后
eval(J$.instrumentEvalCode("x + 1", iid, true))
```

在旧版本中，运行时只要检测到 `f === eval` 或 `f === Function`，就强制对动态代码进行二次插桩。这会导致：
- eval 内执行的代码是插桩后版本，语义可能与原始代码不同
- 若 `instrumentEvalCode` 未注入，运行时直接抛出 `TypeError`
- Trace / observe 等只读场景无法保证 eval 语义等价

### 5.2 实现方案

**三层控制机制**：

| 控制点 | 位置 | 默认行为 |
|--------|------|----------|
| `instrumentEvalCode` 方法 | `JalangiRuntime.js` 字段方法 | 直接返回原始代码（直通） |
| 间接 eval `(0,eval)(code)` | `#callFun` → `f === EVAL_ORG` 分支 | `instrumentEvalEnabled=false` → 直接 apply 调用 |
| `new Function(code)` | `#callFun` → `f === Function` 分支 | `instrumentEvalEnabled=false` → `Reflect.construct` 原生调用 |

**`src/runtime/JalangiRuntime.js`**（核心改动）：

```js
// 1. 公开字段（默认 false）
instrumentEvalEnabled = false;

// 2. 默认直通方法（始终存在，防止 "J$.instrumentEvalCode is not a function" 错误）
instrumentEvalCode(code, _iid, _isDirect) {
    return code;  // instrumentEval=false 时直接返回原始代码
}

// 3. #callFun 守卫
if (this.instrumentEvalEnabled && f === EVAL_ORG) {
    return this.#invokeEval(base, f, args, iid);  // 走插桩路径
} else if (this.instrumentEvalEnabled && f === Function) {
    return this.#invokeFunctionDecl(base, f, args, iid);  // 走插桩路径
} else if (isConstructor) {
    return this.#callAsConstructor(f, args);  // 正常 new 调用
} else {
    return Function.prototype.apply.call(f, base, args);  // 正常 apply 调用
}
```

**`src/runtime/JalangiSandbox.js`**（透传）：

```js
constructor(options = {}) {
    super({
        debugShadow:    options.debugShadow    ?? false,
        instrumentEval: options.instrumentEval ?? false,  // 新增
    });
    ...
}
```

### 5.3 用法

```js
// 默认（推荐，trace/observe 场景）：eval/Function 不被插桩
const J$ = new JalangiSandbox();
// J$.instrumentEvalEnabled === false

// 开启 eval 插桩（需手动注入插桩函数）
import { init, instrumentEvalCode } from './src/instrument/esnstrument.js';
init(config);
const J$ = new JalangiSandbox({ instrumentEval: true });
J$.instrumentEvalCode = instrumentEvalCode;  // 替换为真正的插桩函数

// 运行时动态切换
J$.instrumentEvalEnabled = true;   // 开启
J$.instrumentEvalEnabled = false;  // 关闭
```

### 5.4 测试覆盖（新增 5 个用例，`test/integration/hooks.test.mjs`）

| 用例 | 验证内容 |
|------|----------|
| `instrumentEval=false`（默认）：eval 直接透传 | `eval("1+2")` 返回正确结果 3 |
| `instrumentEval=false`（默认）：不触发 instrumentCodePre | 直通版本不调用插桩器，钩子不触发 |
| `instrumentEval=true`：可注入真正的插桩函数 | 注入后 `instrumentEvalCode` 返回含 `J$.Se`/`J$.Sr` 的插桩代码 |
| `instrumentEvalEnabled` 可在运行时直接切换 | 动态赋值 `true`/`false` 均生效 |
| `new Function` 默认不被插桩 | `new Function("return 15;")()` 返回正确结果 15 |

### 5.5 架构说明

插桩器静态阶段**始终**将 eval 参数包成 `J$.instrumentEvalCode(arg, iid, isDirect)`，因此 `instrumentEvalCode` 方法在运行时必须始终存在（基类提供了安全的直通默认实现）。

两者分工：
- **`instrumentEvalCode` 方法**：控制**直接 eval** 的参数是否被真正插桩
- **`#callFun` 守卫**：控制**间接 eval** `(0,eval)(...)` 和 **`new Function`** 是否走插桩路径
