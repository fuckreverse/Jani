# 运行时系统

源码位置：`src/runtime/`

## 概述

运行时系统负责接收插桩代码在执行时发出的 `J$.xxx()` 调用，并将它们分发给已注册的分析插件。
主要包含以下组件：

| 组件 | 文件 | 职责 |
|------|------|------|
| `JalangiRuntime` | `JalangiRuntime.js` | 所有 J$ 钩子函数的核心实现（基类） |
| `JalangiSandbox` | `JalangiSandbox.js` | 完整沙盒对象，继承 JalangiRuntime（**推荐使用**） |
| `AnalysisHost` | `AnalysisHost.js` | 多插件链式调度器 |
| `SMemory` | `SMemory.js` | Shadow Memory 影子内存服务 |
| `AnalysisTemplate` | `analysisCallbackTemplate.js` | 分析插件接口基类模板 |
| `DataFlowAnalyzer` | `DataFlowAnalyzer.js` | 运行时 SSA 数据流分析器，支持 backward slicing |
| `AntiDetection` | `AntiDetection.js` | 反插桩对抗工具 |

**运行时组件层次**：

```mermaid
classDiagram
    class JalangiRuntime {
        +R(iid, name, val, flags, defScopeId?)
        +Rl(iid, defScopeId, name)
        +W(iid, name, val, lhs, flags, defScopeId?)
        +G(iid, base, offset, flags)
        +P(iid, base, offset, val, flags)
        +F(iid, f, flags)
        +M(iid, base, offset, flags)
        +T(iid, val, type, hasGS)
        +B(iid, op, left, right, flags)
        +U(iid, op, left)
        +C(iid, cond)
        +Fe(iid, f, dis, args, defScopeId?)
        +Fr(iid)
        +Se(iid, val, origFile)
        +Sr(iid)
        +N(iid, name, val, flags)
        +Aw(iid, val, ctxId?)
        +Rt(iid, val)
        +Th(iid, val)
        -#returnStack
        -#switchKeyStack
        -#sidStack
        -#callIdCounter
        -#shadowFrames
        -#oidMap
    }

    class JalangiSandbox {
        +smap
        +sid
        +iids
        +analysis: AnalysisHost
        +tracer: TraceLogger
        +Constants
        +smemory: SMemory
        +iidToLocation(iid)
        +getGlobalIID(iid)
        +newAsyncContext()
        +activateContext(ctxId)
        +currentContextId
        +getShadowStats()
        +resetShadowStats()
    }

    class AnalysisHost {
        +use(plugin): AnalysisHost
        +read(iid, name, val, ...)
        +write(iid, name, val, ...)
        +getField(iid, base, offset, ...)
        +binary(iid, op, left, right, ...)
        -_chains: Map
    }

    class SMemory {
        +getShadowObjectOfObject(obj)
        +getIDFromShadowObjectOrFrame(shadow)
        +getShadowFrame(varName)
        +getOriginalObject(id)
    }

    JalangiSandbox --|> JalangiRuntime : 继承
    JalangiSandbox "1" --> "1" AnalysisHost : analysis
    JalangiSandbox "1" --> "0..1" SMemory : smemory
    AnalysisHost "1" --> "*" Plugin : use()
```

## JalangiSandbox — 完整沙盒

```js
import { JalangiSandbox } from './src/runtime/JalangiSandbox.js';

// 最简用法：纯 analysis，不需要 IndexedDB
const J$ = globalThis.J$ = new JalangiSandbox();
J$.analysis.use(new MyAnalysis(J$));

// 完整用法：内置 ExecutionTrace + IndexedDB 持久化
const J$ = globalThis.J$ = new JalangiSandbox({
    useIdb:    true,
    dbName:    'jalangi-traces',
    storeName: 'execution-trace',
});

// 扩展：追加更多分析插件
J$.analysis.use(new AnotherAnalysis(J$));
```

### 构造参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `useIdb` | `boolean` | `false` | 浏览器中是否启用 IndexedDB 持久化 |
| `dbName` | `string` | — | IndexedDB 数据库名 |
| `storeName` | `string` | — | IndexedDB ObjectStore 名 |
| `withExecutionTrace` | `boolean` | `false` | 是否自动注册内置 ExecutionTraceAnalysis 插件 |
| `sourceCode` | `string` | — | 原始源码（ExecutionTrace 用，可选） |
| `debugShadow` | `boolean` | `false` | 是否开启 Shadow Frame 调试模式。开启后每次 `Rl()` 查表未命中时，递增 miss 计数器并写入 miss 日志，同时向 `console.warn` 输出诊断信息。可通过 `getShadowStats()` 查询结果 |

### 公开字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `smap` | `object` | iid → 源码位置映射表 `{ [sid]: { [iid]: [sl,sc,el,ec] } }` |
| `sid` | `number` | 当前脚本 ID（`Sr()` 执行后会回滚，脚本结束后为 0） |
| `lastSid` | `number` | 最后执行的脚本 ID（不随 `Sr()` 回滚，脚本执行完成后仍可用于查询位置映射）|
| `iids` | `object\|null` | 当前脚本的 iid 映射（由插桩代码在 Se() 前写入） |
| `analysis` | `AnalysisHost` | 当前分析插件调度器，支持 `.use()` 链式注册 |
| `tracer` | `TraceLogger\|null` | TraceLogger 实例（由 ExecutionTraceAnalysis 写入） |
| `Constants` | `object` | 所有全局常量（APPLY、CALL、HOP、JALANGI_VAR 等） |
| `smemory` | `SMemory\|null` | Shadow Memory 实例（启用后由 SMemoryPlugin 写入） |

### 位置查询

```js
// 根据 iid 获取源码位置
const loc = J$.iidToLocation(iid);
// → "example.js:(1:1)-(1:10)"

// 获取全局唯一 IID（含 sid 前缀）
const globalIid = J$.getGlobalIID(iid);
// → "1:42"
```

## JalangiRuntime — 钩子实现

`JalangiRuntime` 是 `JalangiSandbox` 的父类，实现了所有 `J$.xxx()` 钩子方法。

### 钩子函数列表

每个钩子由插桩代码调用，内部执行"pre → 执行操作 → post"的三段式模式：

| 钩子 | 触发场景 | 分析回调 |
|------|---------|---------|
| `R(iid, name, val, flags, defScopeId?)` | 变量读取（全量路径，兼更新 Shadow Frame） | `read(iid, name, val, isGlobal, isScriptLocal)` |
| `Rl(iid, defScopeId, name)` | 变量读取（**轻量路径**，从 Shadow Frame 查值） | `read(iid, name, val, false, false)` |
| `W(iid, name, val, lhs, flags, defScopeId?)` | 变量写入（兼更新 Shadow Frame） | `write(iid, name, val, lhs, isGlobal, isScriptLocal)` |
| `G(iid, base, offset, flags)` | 属性读取 | `getFieldPre` → `getField` |
| `P(iid, base, offset, val, flags)` | 属性写入 | `putFieldPre` → `putField` |
| `F(iid, f, flags)` | 函数调用 | `invokeFunPre` → `invokeFun` |
| `M(iid, base, offset, flags)` | 方法调用 | `invokeFunPre` → `invokeFun` |
| `T(iid, val, type, hasGS)` | 字面量创建 | `literal` |
| `B(iid, op, left, right, flags)` | 二元运算 | `binaryPre` → `binary` |
| `U(iid, op, left)` | 一元运算 | `unaryPre` → `unary` |
| `C(iid, cond)` | 条件判断 | `conditional` |
| `C1(iid, val)` | switch 键值 | — |
| `C2(iid, val)` | case 标签值 | — |
| `Fe(iid, f, dis, args, defScopeId?)` | 函数进入（分配 CallID，创建 Shadow Frame） | `functionEnter` |
| `Fr(iid)` | 函数退出（弹出 CallID 栈，清除 Shadow Frame） | `functionExit` |
| `Se(iid, val, origFile)` | 脚本进入（同时记录 `J$.lastSid`，不随 `Sr()` 回滚） | `scriptEnter` |
| `Sr(iid)` | 脚本退出（回滚 `sid`，但 `lastSid` 保留，可在脚本完成后仍能查询位置映射） | `scriptExit` |
| `N(iid, name, val, flags)` | 变量声明 | `declare` |
| `Rt(iid, val)` | return 值 | `_return` |
| `Th(iid, val)` | throw 值 | `_throw` |
| `Wi(iid, val)` | with 对象 | `_with` |
| `H(iid, val)` | for-in 对象 | `forinObject` |
| `X1(iid, val)` | 表达式语句末尾 | `endExpression` |
| `Aw(iid, val, ctxId?)` | await 恢复点（透传 resolved value，更新 `#currentContextId`） | `awaitResume(iid, contextId, val)` |

### 钩子执行三段式（以 G / getField 为例）

```mermaid
sequenceDiagram
    participant Code as 插桩代码
    participant RT as JalangiRuntime
    participant Host as AnalysisHost
    participant Plugin as 分析插件

    Code->>RT: J$.G(iid, base, offset, flags)
    RT->>Host: getFieldPre(iid, base, offset, isComputed, ...)
    Host->>Plugin: getFieldPre(...) [按注册顺序依次调用]
    Plugin-->>Host: { base, offset, skip } 或 undefined
    Host-->>RT: 合并后的参数
    RT->>RT: result = base[offset]（实际读取）
    RT->>Host: getField(iid, base, offset, result, ...)
    Host->>Plugin: getField(...) [按注册顺序依次调用]
    Plugin-->>Host: { result } 或 undefined
    Host-->>RT: 最终 result
    RT-->>Code: 返回 result
```

### flags 位字段

`flags` 是一个整数，通过位字段编码多个布尔值，可用 `decodeBitPattern` 解码：

- `R` 的 flags：`[isGlobal, isScriptLocal]`；可选第五参数 `defScopeId`（插桩器静态注入）
- `W` 的 flags：`[isGlobal, isScriptLocal, isDeclaration]`；可选第六参数 `defScopeId`
- `Fe` 的可选第五参数：`defScopeId`（函数定义点的 Scope.id）
- `G` 的 flags：`[isComputed, isOpAssign, isMethodCall, isOptional]`（第 4 位 `isOptional=1` 时为可选链 `?.`，`base` 为 `null`/`undefined` 直接短路返回 `undefined`）
- `P` 的 flags：`[isComputed, isOpAssign]`
- `F` / `M` 的 flags：`[isConstructor, isMethod]`

## AnalysisHost — 多插件调度器

`AnalysisHost` 管理多个分析插件，并将每个钩子依次分发给所有注册了该钩子的插件。

```js
import { AnalysisHost } from './src/runtime/AnalysisHost.js';

const host = new AnalysisHost();

// 注册多个插件（链式调用）
host.use(new SMemoryPlugin(smemory))
    .use(new LogAllAnalysis(smemory))
    .use(new MyCustomAnalysis());
```

### 支持的钩子名称

```
_return, _throw, _with,
awaitResume,
binaryPre, binary, conditional,
declare, endExecution, endExpression,
forinObject, functionEnter, functionExit,
getFieldPre, getField, instrumentCodePre,
instrumentCode, invokeFunPre, invokeFun,
literal, onReady, putFieldPre,
putField, read, runInstrumentedFunctionBody,
scriptEnter, scriptExit, unaryPre,
unary, write
```

### 参数传递机制

`AnalysisHost` 支持两种插件间数据传递方式：

1. **全量 args 替换**：若插件返回含 `args` 字段（Array 类型）的对象，后续插件将使用该新参数数组。

2. **精确 result 传递**（推荐）：若插件仅返回 `{ result }` 对象，调度器会根据内置的 `RESULT_ARG_INDEX` 表自动将 `result` 更新到对应参数位置，后续插件可直接看到修改后的值。支持的钩子及其 `result` 位置如下：

| 钩子 | result 在 args 中的位置（0-based） |
|------|------------------------------------|
| `binary` | 4（binary(iid, op, left, right, **result**, ...)）|
| `unary` | 2（unary(iid, op, **val**, ...)）|
| `write` | 2（write(iid, name, **val**, ...)）|
| `read` | 2（read(iid, name, **val**, ...)）|
| `getField` | 3（getField(iid, base, offset, **val**, ...)）|
| `putField` | 3（putField(iid, base, offset, **val**, ...)）|
| `invokeFun` | 4（invokeFun(iid, f, base, args, **result**, ...)）|
| `literal` | 1（literal(iid, **val**, ...)）|
| `conditional` | 1（conditional(iid, **result**, ...)）|
| `forinObject` | 1（forinObject(iid, **val**, ...)）|
| `declare` | 2（declare(iid, name, **val**, ...)）|
| `_return` | 1（_return(iid, **val**, ...)）|
| `_throw` | 1（_throw(iid, **val**, ...)）|

### 错误处理

```js
const host = new AnalysisHost({
    onError: (hookName, error) => {
        console.error(`[${hookName}] Plugin error:`, error);
        // 自定义错误处理，如测试时阻止 process.exit
    },
});
```

## SMemory — 影子内存

`SMemory` 为每个 JavaScript 对象、函数和活动帧维护一个"影子对象"和唯一 ID，
使分析插件可以将任意元数据附加到 JS 对象上，而不修改原对象本身。

```js
import { SMemory, SMemoryPlugin } from './src/runtime/SMemory.js';

const smemory = new SMemory(J$);
// 通过 SMemoryPlugin 将其与运行时事件桥接
J$.analysis.use(new SMemoryPlugin(smemory));

// 现在可以通过 J$.smemory 访问影子内存
```

### 主要 API

```js
// 获取对象的影子对象（自动创建）
const shadow = smemory.getShadowObjectOfObject(obj);

// 获取影子对象/帧的唯一 ID
const id = smemory.getIDFromShadowObjectOrFrame(shadow);

// 获取当前活动帧的影子帧
const frame = smemory.getShadowFrame(varName);

// 通过 ID 反向查找原始对象
const orig = smemory.getOriginalObject(id);
```

### 影子对象属性键

影子内存使用特殊的隐藏属性键存储元数据，避免与用户代码冲突：

```
*J$O*   → 影子对象引用
*J$F*   → 影子帧标记
*J$A*   → 原始对象反向引用
```

## CallID 机制与 Shadow Frame（轻量变量读取）

### CallID

`JalangiRuntime` 为每次函数调用分配一个唯一的 **CallID**（整数，全局单调递增），
解决同一函数在递归、闭包、异步并发场景下局部变量的区分问题：

- `Fe(iid, f, dis, args, defScopeId)` — 分配新 CallID，将 `(旧 callId, defScopeId)` 压栈
- `Fr(iid)` — 弹出栈顶，恢复调用方的 CallID，同时清除本次调用的 Shadow Frame

### Shadow Frame

`JalangiRuntime` 内部维护一张 **Shadow Frame 映射表**，结构为嵌套的 `Map<number, Map<number, Map>>`（即 `defScopeId -> callId -> Map<name, value>`）。
每个条目是 `Map<name, value>`。其作用是让 `J$.Rl` 轻量读取钩子能够在不接收 `value` 参数的情况下，
仍能正确获取变量当前值，避免将变量值通过表达式传递（减少插桩开销）。

**数据流向**：

```mermaid
flowchart LR
    W["J$.W(iid, name, val, lhs, flags, defScopeId)\n变量写入"]
    R["J$.R(iid, name, val, flags, defScopeId)\n变量读取（全量路径）"]
    Rl["J$.Rl(iid, defScopeId, name)\n变量读取（轻量路径）"]
    SF["Shadow Frame\nMap&lt;defScopeId, Map&lt;callId, Map&lt;name,value&gt;&gt;&gt;"]
    HOOK_W["analysis.write(iid, name, val, ...)"]
    HOOK_R["analysis.read(iid, name, val, ...)"]

    W -->|"写入时同步\nShadowFrame[defScopeId][callId][name] = val"| SF
    R -->|"读取时同步\nShadowFrame[defScopeId][callId][name] = val"| SF
    Rl -->|"查 Shadow Frame 获取值\nval = ShadowFrame[defScopeId][callId][name]"| SF
    W --> HOOK_W
    R --> HOOK_R
    Rl --> HOOK_R
```

**适用条件**（插桩器静态判断）：局部变量、无 `eval`/`with`、非 `catch` 参数、非 `arguments`、**非箭头函数参数**（箭头函数无 `Fe`/`Fr` 钩子，Shadow Frame 不会初始化其形参，因此强制走全量 `R` 路径）。

### Shadow Frame 内存管理与闭包

当函数退出（`Fr`）时，通常会清除其对应的 Shadow Frame。但如果该函数内创建了闭包，闭包可能会在未来访问这些局部变量。
为了解决这个问题，`JalangiRuntime` 引入了 **闭包引用计数** 和 **垃圾回收注册表（FinalizationRegistry）**：
1. 在 `T`（字面量创建）钩子中，如果创建的是函数（闭包），则将其外层帧的 `(defScopeId, callId)` 记录到 `#closureFrameSet`，并递增引用计数。
2. `Fr` 退出时，如果当前帧在 `#closureFrameSet` 中，则**不清除** Shadow Frame。
3. 将闭包函数注册到 `FinalizationRegistry`。当闭包函数被 JS 引擎垃圾回收时，自动递减引用计数；当计数归零时，安全地清理对应的 Shadow Frame，防止内存泄漏。

### Shadow Frame 诊断 API

`JalangiRuntime` 内部使用 **Sentinel 哨兵对象**（`_SHADOW_MISS`）区分两种情况：

- `#shadowLookup` 返回哨兵 → 该变量**从未被写入** Shadow Frame（真正的缺失，可能是写入路径漏插桩或 `callId` 对不上）
- `#shadowLookup` 返回普通值（含 `undefined`）→ 变量值本身就是 `undefined`

过去这两种情况无法区分，`Rl()` 在两者均会静默返回 `undefined` 并影响被分析代码的实际运行结果。引入哨兵后，所有真正的缺失均可被观测到。

```js
// 开启调试模式
const J$ = new JalangiSandbox({ debugShadow: true });

// ... 运行被分析代码 ...
// 每次 Rl() 查表未命中，console.warn 会实时打印：
// [Jalangi] Shadow Frame MISS: name="x" iid=42 defScopeId=3 callId=7 — ...

// 执行完毕后查询统计
const stats = J$.getShadowStats();
// stats.missCount   → 总 miss 次数（总是可用，与 debugShadow 无关）
// stats.missLog     → 每次 miss 的详细记录（仅 debugShadow=true 时有内容）
// stats.frameCount  → 当前存活的 Shadow Frame 帧数（调试内存泄漏用）
// stats.debugShadow → 是否处于调试模式

// 用 iidToLocation 将 iid 转成源码位置
stats.missLog.forEach(({ iid, name }) => {
    console.log(`  ${name} @ ${J$.iidToLocation(J$.lastSid, iid)}`);
});

// 多轮测试之间清空状态
J$.resetShadowStats();
```

> **注意**：生产环境下 `debugShadow` 默认为 `false`，miss 计数器仍然递增（开销极低），
> 但 `missLog` 为空，不写日志，不调用 `console.warn`。
> 只有在需要定位问题时才开启 `debugShadow: true`。

## 对象 OID 机制

`JalangiRuntime` 为每个对象/数组/函数分配唯一的 **OID（Object ID）**，支持别名追踪和对象版本管理：

- **分配时机**：`J$.T()`（字面量创建）时，通过 `WeakMap` 为引用类型对象分配 OID
- **别名记录**：`J$.W()` 中，当右值是对象时，记录 `"scopeId:callId:name" → OID` 的映射
- **版本递增**：`J$.P()`（属性写入）时，对 base 对象的 OID 版本号 +1

### 公开 API

```js
// 查询对象的 OID（不分配新 OID）
const oid = J$.getOid(obj);           // → number | null

// 查询对象的版本号（每次 putField 递增）
const ver = J$.getObjectVersion(obj); // → number（0 = 从未被修改）
```

### 别名追踪示例

```mermaid
sequenceDiagram
    participant Code as 用户代码
    participant RT as JalangiRuntime

    Code->>RT: J$.T(iid, {}, N_LOG_OBJECT_LIT, false)
    RT->>RT: 分配 OID_1，写入 WeakMap
    RT-->>Code: 返回 {} (OID_1)

    Code->>RT: J$.W(iid, 'a', {}, ...) — a = {}
    RT->>RT: a → OID_1 写入 aliasTable

    Code->>RT: J$.W(iid, 'b', a, ...) — b = a
    RT->>RT: b → OID_1 写入 aliasTable

    Code->>RT: J$.P(iid, b, 'x', 1, ...) — b.x = 1
    RT->>RT: OID_1 版本号 +1
    Note over RT: a 与 b 共享 OID_1，均被标记为"已修改"
```

## 异步 ContextID 机制

`JalangiRuntime` 为不同的异步任务分配独立的 **ContextID**，解决异步 log 交叉感染问题：

- **顶层同步代码**：ContextID = 0
- **async function / setTimeout 等**：通过 `newAsyncContext()` 分配新 ContextID

### 公开 API

```js
// 查询当前异步上下文 ID
const ctxId = J$.currentContextId;   // → number（0 = 顶层同步）

// 为新异步任务分配 ContextID
const newCtxId = J$.newAsyncContext(); // → number（唯一递增）

// 激活指定的异步上下文（在回调入口调用）
J$.activateContext(newCtxId);
```

### await 恢复点钩子（`J$.Aw`）

插桩器将 `await expr` 改写为 `J$.Aw(iid, await expr, J$__ctx)`：

```js
// 插桩代码（由 wrappers.js 手工构造 AST 生成）
J$.Aw(iid, await expr, J$__ctx)
// J$__ctx 是 async 函数入口注入的局部变量：
//   var J$__ctx = J$.currentCallId;
// 用于在并发 async 调用时正确区分不同调用实例的 contextId。
```

**运行时处理流程**：
1. JS 引擎在 `await expr` 处挂起协程，Promise 就绪后恢复
2. resolved value 作为 `val` 参数传入 `Aw()`
3. `Aw()` 将 `#currentContextId` 设为 `ctxId`（若提供）或 `#currentCallId`（兜底）
4. `Aw()` 调用 `analysis.awaitResume(iid, contextId, val)`
5. `Aw()` 返回 `val`，语义完全保留

分析插件可通过 `awaitResume(iid, contextId, val)` 回调监听 await 恢复事件（详见 [Analysis-Development.md](./Analysis-Development.md)）。

### 包装异步回调（结合 AntiDetection.js）

```js
import { createContextWrapper } from './src/runtime/AntiDetection.js';

// 确保 setTimeout 回调在独立异步上下文中运行
setTimeout(createContextWrapper(originalCallback, J$), delay);
```

## 脚本 ID 管理

运行时维护 `sidStack`（脚本 ID 栈）以支持多脚本/eval 嵌套执行：

1. `J$.Se(iid, val, origFile)` —— 脚本进入时推入新 sid，注册 smap 中的映射
2. `J$.Sr(iid)` —— 脚本退出时弹出 sid，恢复父脚本上下文

```js
// 源码位置查询示例
J$.iidToLocation(iid);
// → "example.js:(3:5)-(3:15)"
```

## eval 和 Function 动态代码处理

运行时对 `eval()` 和 `new Function()` 调用做特殊处理，确保动态生成的代码也被插桩：

1. 检测调用目标是否为原生 `eval` 或 `Function` 构造器
2. 调用 `sandbox.instrumentEvalCode(code, iid, isDirect)` 对动态代码插桩
3. 用原生 `EVAL_ORG` 执行插桩后的代码

```js
// 原始代码
eval('var x = 1;');

// 运行时处理流程
// 1. J$.F(iid, eval, flags) 检测到 f === EVAL_ORG
// 2. code = J$.instrumentEvalCode('var x = 1;', iid, true)
// 3. EVAL_ORG(code)  ← 执行插桩后的代码
```

## 日志系统（`src/logger/`）

日志系统已从 `src/runtime/logging/` 迁移并重构为独立模块 `src/logger/`，
同时供 `src/runtime/` 和 `src/instrument/` 使用。

### 统一日志工厂（`logger.js`）

所有诊断日志均通过 `createLogger(domain)` 工厂函数创建，实现两级分类：

| 维度 | 说明 |
|------|------|
| **域（domain）** | 代码所属模块，如 `'framework'`、`'instrument'`、`'backend:ws'` |
| **级别（level）** | `error` / `warn` / `info` — 始终输出；`debug` — 受开关控制 |

```js
import { createLogger, DOMAIN } from './src/logger/logger.js';

const log = createLogger(DOMAIN.FRAMEWORK);

log.error('未预期的错误:', err);  // 始终输出到 console.error
log.warn('重试中...');            // 始终输出到 console.warn
log.info('沙盒已就绪');           // 始终输出到 console.log
log.debug('flush 完成, size=', n); // 仅 debug 开关开启时输出
```

### DOMAIN 常量

```js
import { DOMAIN } from './src/logger/logger.js';

// DOMAIN.FRAMEWORK    → 'framework'   （JalangiRuntime / JalangiSandbox / AnalysisHost）
// DOMAIN.INSTRUMENT   → 'instrument'  （astUtil / pluginAnalyzer / esnstrument）
// DOMAIN.LOGGING      → 'logging'     （LogManager / TraceLogger）
// DOMAIN.BACKEND_IDB  → 'backend:idb' （IdbWorkerBackend / idb-worker）
// DOMAIN.BACKEND_WS   → 'backend:ws'  （WsBackend）
// DOMAIN.BACKEND_NODE → 'backend:node'（NodeStreamBackend）
// DOMAIN.BACKEND_MEM  → 'backend:mem' （MemoryBackend）
// DOMAIN.ANALYSIS     → 'analysis'    （分析插件业务日志）
```

### Debug 开关

**Node.js** 通过 `JALANGI_DEBUG` 环境变量控制：

```bash
JALANGI_DEBUG=1 node bin/jalangi.mjs instrument src/app.js   # 开启所有域
JALANGI_DEBUG=framework,instrument node ...                   # 只开启指定域
JALANGI_DEBUG=backend node ...                                # 前缀匹配（匹配 backend:ws 等）
```

**浏览器** 通过 `localStorage.jalangiDebug` 控制：

```js
localStorage.setItem('jalangiDebug', '1');           // 开启所有域
localStorage.setItem('jalangiDebug', 'backend:idb'); // 只开启指定域
```

**`--debug` 命令行参数**（`bin/jalangi.mjs`）：使用 `--debug` 生成浏览器 bundle 时，
Rollup 会在 bundle 头部自动注入以下代码，等价于在浏览器中预设 `localStorage.jalangiDebug = '1'`：

```js
// ─── Jalangi debug 模式（由 --debug 注入）
if (typeof localStorage !== 'undefined' && !localStorage.getItem('jalangiDebug')) {
    localStorage.setItem('jalangiDebug', '1');
}
```

> 注意：若用户已手动设置 `localStorage.jalangiDebug`，`--debug` 注入不会覆盖（`getItem` 先检查）。

### Trace 事件与诊断日志的区别

| 类型 | 路径 | 用途 |
|------|------|------|
| **诊断日志**（`createLogger`）| 同步输出到控制台 | 框架运行状态、错误、警告 |
| **Trace 事件**（`TraceLogger.trace()`）| 走 `LogManager → RingBuffer → 后端` 缓冲 | 高频插桩事件（read/write/getField/...）|

高频 trace 数据**不经过** `createLogger`，直接走 `LogManager` 缓冲后端，不会阻塞主线程。

### 模块结构

```mermaid
flowchart TD
    LOGGER["logger.js\ncreateLogger(domain) + DOMAIN 常量\n+ isDebugEnabled(domain)"]
    TL["TraceLogger\n(trace 事件门面)"]
    LM["LogManager\n(协调 RingBuffer 与后端)"]
    RB["RingBuffer\n(无锁环形缓冲区)"]
    ES["EventSerializer\n(事件序列化)"]

    subgraph Backends["可插拔后端"]
        MB["MemoryBackend\n(纯内存，测试用)"]
        NS["NodeStreamBackend\n(Node.js 流 / 写文件)"]
        WS["WsBackend\n(WebSocket，传输到 trace server)"]
        IDB["IdbWorkerBackend\n(IndexedDB Worker，浏览器持久化)"]
        TA["TypedArrayBackend\n(Float64Array 环形缓冲区\n零 GC，高吞吐量)"]
    end

    LOGGER -.->|"各模块 import"| TL
    LOGGER -.->|"各模块 import"| LM
    TL --> LM
    LM --> RB
    RB --> ES
    ES --> MB
    ES --> NS
    ES --> WS
    ES --> IDB
    ES --> TA
```

| 组件 | 文件 | 说明 |
|------|------|------|
| `logger.js` | `logger.js` | 统一日志工厂，`createLogger` + `DOMAIN` + debug 开关 |
| `LogManager` | `LogManager.js` | 日志管理器，协调 RingBuffer 和后端 |
| `TraceLogger` | `TraceLogger.js` | trace 事件门面（高频走缓冲，`key` 事件直输出）|
| `RingBuffer` | `RingBuffer.js` | 环形缓冲区，无锁高性能暂存 |
| `EventSerializer` | `EventSerializer.js` | 事件序列化器 |
| `MemoryBackend` | `backends/MemoryBackend.js` | 纯内存后端（测试用）|
| `NodeStreamBackend` | `backends/NodeStreamBackend.js` | Node.js 流（写文件、stdout）|
| `WsBackend` | `backends/WsBackend.js` | WebSocket 后端（传输到 trace server）|
| `IdbWorkerBackend` | `backends/IdbWorkerBackend.js` | IndexedDB Worker 后端（浏览器持久化）|
| `TypedArrayBackend` | `backends/TypedArrayBackend.js` | **高性能 TypedArray 环形缓冲区**后端（零 GC、可导出 `.bin`）|

### TypedArrayBackend — 高性能环形缓冲区

`TypedArrayBackend` 实现了与 `MemoryBackend` 相同的接口，但内部使用预分配的 `Float64Array`
环形缓冲区写入，写入速度比 `Array.push(obj)` 快 10-100 倍，且不产生 GC 压力。

```js
import { TypedArrayBackend } from './src/logger/backends/TypedArrayBackend.js';

const backend = new TypedArrayBackend({ capacity: 1_000_000 });

// 导出二进制（用于离线分析）
const buf = backend.exportBinary();

// 调试读取（最近 100 条）
const events = backend.getEvents(100);
```

每条 log 条目编码为 5 个 Float64（40 字节），字段含义：`entryType | iid | scopeId:callId(packed) | contextId | valueKey`。

## DataFlowAnalyzer — 运行时 SSA 数据流分析

`DataFlowAnalyzer`（`src/runtime/DataFlowAnalyzer.js`）是一个**后处理分析器**，
消费运行时产生的 log 条目，对其做 SSA 化并支持 backward slicing。

```mermaid
flowchart LR
    LOG["运行时 log 条目\n(W / R / P / G / F / M)"]
    DFA["DataFlowAnalyzer"]
    SSA["SSA 化\n每次赋值 → 唯一 RegisterID\n维护 LastWrite 表"]
    ALIAS["别名追踪\n通过 OID 关联同一对象的所有变量"]
    BS["Backward Slicing\n从目标寄存器出发\n回溯所有影响其值的赋值链"]
    RESULT["依赖链\n[{iid, name, value}, ...]"]

    LOG --> DFA
    DFA --> SSA
    DFA --> ALIAS
    SSA --> BS
    ALIAS --> BS
    BS --> RESULT
```

```js
import { DataFlowAnalyzer } from './src/runtime/DataFlowAnalyzer.js';

const dfa = new DataFlowAnalyzer();

// 实时处理（在分析插件回调中调用）
dfa.processWrite({ iid: 8,  scopeId: 0, callId: 1, name: 'x', value: 1 });
dfa.processRead( { scopeId: 0, callId: 1, name: 'x' });
dfa.processWrite({ iid: 24, scopeId: 0, callId: 1, name: 'y', value: 2 });

// 也可以批量处理 log 数组
dfa.processLog(logEntries);   // 按 entry.type 自动分发

// Backward Slicing：从终点寄存器回溯所有影响它的赋值链
const targetReg = dfa.getLastWrite(0, 1, 'y');
const slice = dfa.backwardSlice(targetReg);
// slice → [{ iid: 8, name: 'x', value: 1 }, { iid: 24, name: 'y', value: 2 }]
```

### 核心 API

| 方法 | 说明 |
|------|------|
| `processWrite(entry)` | 处理 W 条目，创建新 SSA 寄存器，返回新分配的寄存器 ID |
| `processRead(entry)` | 处理 R/Rl 条目，暂存源寄存器（供下次 processWrite 消费），返回当前 active 寄存器 ID |
| `processPutField(entry)` | 处理 P 条目，递增 OID 版本号，为所有别名变量创建版本寄存器 |
| `processCallReturn(entry)` | 处理 F/M 条目，记录函数调用返回值寄存器，返回新建的寄存器 ID |
| `processLog(entries)` | 批量处理 log 数组，按 `entry.type` 自动分发 |
| `backwardSlice(regId)` | 从目标寄存器 BFS 回溯，返回按 iid 升序排列的依赖寄存器链 |
| `getLastWrite(scopeId, callId, name)` | 查询变量最新的 SSA 寄存器 ID（未写入过则 `undefined`） |
| `getRegister(regId)` | 返回指定寄存器 ID 的详情（`RegisterEntry`，未找到则 `undefined`） |
| `getOidVersion(oid)` | 返回指定 OID 的当前版本号（0 = 从未被 putField 修改过） |
| `getAlias(scopeId, callId, name)` | 返回变量当前持有的 OID（若无别名则 `undefined`） |
| `getAliasesForOid(oid)` | 查询持有指定 OID 的所有变量（别名集合） |
| `reset()` | 重置分析器状态，开始处理新一轮 log 序列 |
| `exportRegisters()` | 导出所有寄存器为可序列化数组（`sources` 字段从 Set 转为数组） |

## AntiDetection — 反插桩对抗

`AntiDetection`（`src/runtime/AntiDetection.js`）提供针对恶意脚本常见插桩检测手段的对策。

```js
import {
    installToStringHook,
    registerOriginalCode,
    detectGlobalLeaks,
    createContextWrapper,
    benchmarkCallOverhead,
} from './src/runtime/AntiDetection.js';

// 1. 安装 Function.toString 拦截器（在 J$.Se 之前调用）
installToStringHook();

// 2. 注册函数的原始代码（让 toString() 返回插桩前的代码）
registerOriginalCode(instrumentedFn, originalSourceCode);

// 3. 检查全局变量是否泄露（自检用）
const leaks = detectGlobalLeaks(); // 正常情况下返回 []

// 4. 包装异步回调，分配独立 ContextID（配合异步 ContextID 机制）
const wrappedCb = createContextWrapper(originalCallback, J$);
setTimeout(wrappedCb, delay);

// 5. 基准测试：检测当前环境的插桩调用开销
const { avgUs, acceptable } = benchmarkCallOverhead(1000, 10);
```

### toString Hook 原理

恶意脚本常通过 `fn.toString()` 检测函数体是否被注入了追踪代码。
`installToStringHook()` 在 `Function.prototype.toString` 上安装拦截器：
若目标函数已通过 `registerOriginalCode()` 注册了原始代码，则返回原始代码；
否则，透传给原始 `toString`，行为完全正常。
