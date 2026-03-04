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

### 公开字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `smap` | `object` | iid → 源码位置映射表 `{ [sid]: { [iid]: [sl,sc,el,ec] } }` |
| `sid` | `number` | 当前脚本 ID |
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
| `Se(iid, val, origFile)` | 脚本进入 | `scriptEnter` |
| `Sr(iid)` | 脚本退出 | `scriptExit` |
| `N(iid, name, val, flags)` | 变量声明 | `declare` |
| `Rt(iid, val)` | return 值 | `_return` |
| `Th(iid, val)` | throw 值 | `_throw` |
| `Wi(iid, val)` | with 对象 | `_with` |
| `H(iid, val)` | for-in 对象 | `forinObject` |
| `X1(iid, val)` | 表达式语句末尾 | `endExpression` |

### flags 位字段

`flags` 是一个整数，通过位字段编码多个布尔值，可用 `decodeBitPattern` 解码：

- `R` 的 flags：`[isGlobal, isScriptLocal]`；可选第五参数 `defScopeId`（插桩器静态注入）
- `W` 的 flags：`[isGlobal, isScriptLocal, isDeclaration]`；可选第六参数 `defScopeId`
- `Fe` 的可选第五参数：`defScopeId`（函数定义点的 Scope.id）
- `G` 的 flags：`[isComputed, isOpAssign, isMethodCall]`
- `P` 的 flags：`[isComputed, isOpAssign]`
- `F` / `M` 的 flags：`[isConstructor, isMethod]`

### Pre/Post 钩子模式

以属性读取（`G`）为例，展示三段式执行模式：

```
instrumented code calls J$.G(iid, base, offset, flags)
         │
         ▼
   analysis.getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall)
   → 可修改 base / offset，可返回 { skip: true } 跳过操作
         │
         ▼
   执行实际属性读取: result = base[offset]
         │
         ▼
   analysis.getField(iid, base, offset, result, isComputed, isOpAssign, isMethodCall)
   → 可修改 result（返回 { result: newVal }）
         │
         ▼
   返回最终结果给插桩代码
```

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

若某插件的钩子方法返回含 `args` 字段（Array 类型）的对象，
后续插件将看到更新后的参数列表，实现插件间的数据传递与修改。

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

`JalangiRuntime` 内部维护一张 **Shadow Frame 映射表**，索引格式为 `"defScopeId:callId"`，
每个条目是 `Map<name, value>`。其作用是让 `J$.Rl` 轻量读取钩子能够在不接收 `value` 参数的情况下，
仍能正确获取变量当前值，避免将变量值通过表达式传递（减少插桩开销）。

**数据流向**：

```
J$.W(iid, name, val, lhs, flags, defScopeId)
   ↓ 写入时同步
Shadow Frame["defScopeId:callId"][name] = val

J$.R(iid, name, val, flags, defScopeId)
   ↓ 读取时同步（全量路径也更新 Shadow Frame）
Shadow Frame["defScopeId:callId"][name] = val

J$.Rl(iid, defScopeId, name)
   ↓ 直接从 Shadow Frame 查值，不接收 value 参数
val = Shadow Frame["defScopeId:callId"][name]
```

**适用条件**（插桩器静态判断）：局部变量、无 `eval`/`with`、非 `catch` 参数、非 `arguments`。

## 对象 OID 机制（TODO-14）

`JalangiRuntime` 为每个对象/数组/函数分配唯一的 **OID（Object ID）**，支持别名追踪和对象版本管理：

- **分配时机**：`J$.T()`（字面量创建）时，通过 `WeakMap` 为引用类型对象分配 OID
- **别名记录**：`J$.W()` 中，当右值是对象时，记录 `"scopeId:callId:name" → OID` 的映射
- **版本递增**：`J$.P()`（属性写入）时，对 base 对象的 OID 版本号 +1

### 公开 API

```js
// 查询对象的 OID（不分配新 OID）
const oid = J$.getOid(obj);        // → number | null

// 查询对象的版本号（每次 putField 递增）
const ver = J$.getObjectVersion(obj); // → number（0 = 从未被修改）
```

### 用途

```
let a = {};       // T() 中分配 OID_1
let b = a;        // W() 中记录 b → OID_1
b.x = 1;          // P() 中 OID_1 版本号 +1；通过 aliasTable 可知 a 也受影响
```

## 异步 ContextID 机制（TODO-15）

`JalangiRuntime` 为不同的异步任务分配独立的 **ContextID**，解决异步 log 交叉感染问题：

- **顶层同步代码**：ContextID = 0
- **async function / setTimeout 等**：通过 `newAsyncContext()` 分配新 ContextID

### 公开 API

```js
// 查询当前异步上下文 ID
const ctxId = J$.currentContextId;  // → number（0 = 顶层同步）

// 为新异步任务分配 ContextID
const newCtxId = J$.newAsyncContext(); // → number（唯一递增）

// 激活指定的异步上下文（在回调入口调用）
J$.activateContext(newCtxId);
```

### await 恢复点钩子（`J$.Aw`）

插桩器在 `await expr` 后注入 `J$.Aw(iid)`，在 await 恢复时通知运行时：

```js
// 插桩代码（由 esnstrument.js 生成）
(await expr, J$.Aw(iid))
```

分析插件可通过 `awaitResume(iid, contextId)` 回调监听 await 恢复事件。

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

## Logging 子系统

`src/runtime/logging/` 提供可插拔的事件日志后端：

| 组件 | 说明 |
|------|------|
| `TraceLogger` | 日志管理器，协调 RingBuffer 和后端 |
| `RingBuffer` | 环形缓冲区，无锁高性能暂存 |
| `MemoryBackend` | 纯内存后端（测试用） |
| `NodeStreamBackend` | Node.js 流（写文件、stdout）|
| `WsBackend` | WebSocket 后端（传输到 trace server）|
| `IdbWorkerBackend` | IndexedDB Worker 后端（浏览器持久化）|
| `TypedArrayBackend` | **高性能 TypedArray 环形缓冲区**后端（零 GC、可导出 `.bin`）|

```js
// 使用 WebSocket 后端（配合 npm run trace-server）
const J$ = globalThis.J$ = new JalangiSandbox({
    useIdb: false,
    // 需要手动配置 WsBackend
});
```

### TypedArrayBackend — 高性能环形缓冲区

`TypedArrayBackend` 实现了与 `MemoryBackend` 相同的接口，但内部使用预分配的 `Float64Array`
环形缓冲区写入，写入速度比 `Array.push(obj)` 快 10-100 倍，且不产生 GC 压力。

```js
import { TypedArrayBackend } from './src/runtime/logging/backends/TypedArrayBackend.js';

const backend = new TypedArrayBackend({ capacity: 1_000_000 });

// 作为 TraceLogger 的后端使用
// await backend.write([ { type: 'W', iid: 8, scopeId: 0, callId: 1, ... } ]);

// 导出二进制（用于离线分析）
const buf = backend.exportBinary();

// 调试读取（最近 100 条）
const events = backend.getEvents(100);
```

每条 log 条目编码为 5 个 Float64（40 字节），字段含义：`entryType | iid | scopeId:callId(packed) | contextId | valueKey`。

## DataFlowAnalyzer — 运行时 SSA 数据流分析（TODO-16）

`DataFlowAnalyzer`（`src/runtime/DataFlowAnalyzer.js`）是一个**后处理分析器**，
消费运行时产生的 log 条目，对其做 SSA 化并支持 backward slicing。

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
| `processWrite(entry)` | 处理 W 条目，创建新 SSA 寄存器 |
| `processRead(entry)` | 处理 R/Rl 条目，暂存源寄存器（供下次 processWrite 消费） |
| `processPutField(entry)` | 处理 P 条目，递增 OID 版本号，为所有别名变量创建版本寄存器 |
| `processCallReturn(entry)` | 处理 F/M 条目，记录函数调用返回值寄存器 |
| `processLog(entries)` | 批量处理 log 数组 |
| `backwardSlice(regId)` | 从目标寄存器 BFS 回溯，返回按 iid 排序的依赖链 |
| `getLastWrite(scopeId, callId, name)` | 查询变量最新的 SSA 寄存器 ID |
| `getAliasesForOid(oid)` | 查询持有指定 OID 的所有变量（别名集合） |
| `exportRegisters()` | 导出所有寄存器（sources 转为数组，可 JSON 序列化） |

## AntiDetection — 反插桩对抗（TODO-17）

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

// 4. 包装异步回调，分配独立 ContextID（配合 TODO-15）
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
