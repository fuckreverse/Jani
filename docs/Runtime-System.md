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
| `R(iid, name, val, flags)` | 变量读取 | `read(iid, name, val, isGlobal, isScriptLocal)` |
| `W(iid, name, val, lhs, flags)` | 变量写入 | `write(iid, name, val, lhs, isGlobal, isScriptLocal)` |
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
| `Fe(iid, f, dis, args)` | 函数进入 | `functionEnter` |
| `Fr(iid)` | 函数退出 | `functionExit` |
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

- `R` / `W` 的 flags：`[isGlobal, isScriptLocal, isArguments]`
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

```js
// 使用 WebSocket 后端（配合 npm run trace-server）
const J$ = globalThis.J$ = new JalangiSandbox({
    useIdb: false,
    // 需要手动配置 WsBackend
});
```
