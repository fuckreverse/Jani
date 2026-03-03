# 示例分析插件

`src/plugins/` 目录下提供了多个示例分析插件，涵盖不同的动态分析场景，
既可直接使用，也是编写自定义分析的参考范本。

## 插件目录

```
src/plugins/
  tutorial/              ← 入门教程级别的示例
    LogAll.js            ← 记录所有运行时事件
    BranchCoverage.js    ← 分支覆盖率统计
    BacktrackLoop.js     ← 回溯循环（MultiSE 示例）
  pldi16/                ← PLDI 2016 论文对应示例
    TraceAll.js          ← 完整执行跟踪（需 SMemory）
    LogLoadStore.js      ← 内存读写跟踪（需 SMemory）
    LogLoadStoreAlloc.js ← 分配点感知的内存读写跟踪（需 SMemory）
    BranchCoverage.js    ← 分支覆盖（PLDI 版本）
    SkipFunction.js      ← 跳过函数执行示例
    ChangeSematicsOfMult.js ← 修改乘法语义示例
    TraceAll.js          ← 完整跟踪
    CountObjectsPerAllocationSite.js ← 按分配点统计对象数
  dlint/                 ← 代码质量检测（DLint）
    CheckNaN.js          ← NaN 比较检测
    UndefinedOffset.js   ← undefined 属性访问检测
    ConcatUndefinedToString.js ← undefined 字符串拼接检测
    FunCalledWithMoreArguments.js ← 参数过多检测
    ShadowProtoProperty.js ← 原型属性遮蔽检测
    CompareFunctionWithPrimitives.js ← 函数与原始值比较检测
  frames/                ← 帧分析
    FrameAnalysis.js
    Frames.js
  datatraces/            ← 数据流跟踪（需 Trace Server）
    LogData.js
    TraceWriter.js
  coverage/              ← 代码覆盖率
    AddCoverage.js
    ProcessCoverage.js
```

---

## tutorial/ — 入门示例

### LogAll — 记录所有事件

**文件**：`src/plugins/tutorial/LogAll.js`

记录程序执行过程中所有运行时事件（函数调用、属性读写、变量读写等）。
适合作为"Hello World"级别的起点。

```js
import { JalangiSandbox }           from './src/runtime/JalangiSandbox.js';
import { SMemory, SMemoryPlugin }   from './src/runtime/SMemory.js';
import { LogAllAnalysis }           from './src/plugins/tutorial/LogAll.js';

const J$ = globalThis.J$ = new JalangiSandbox();
const smemory = new SMemory(J$);
J$.smemory = smemory;
J$.analysis.use(new SMemoryPlugin(smemory))
           .use(new LogAllAnalysis(smemory, J$));
```

**示例输出**：
```
getField({"base":1,"offset":"log","isMethodCall":true}) at example.js:(1:9)-(1:20)
putField({"base":2,"offset":"x","val":42}) at example.js:(2:1)-(2:10)
```

---

### BranchCoverage — 分支覆盖率

**文件**：`src/plugins/tutorial/BranchCoverage.js`

统计每个条件表达式（`if`、`while`、`?:`、`&&`、`||`）中 true/false 分支被执行的次数。

```js
import { BranchCoverageAnalysis } from './src/plugins/tutorial/BranchCoverage.js';

J$.analysis.use(new BranchCoverageAnalysis(J$));
```

**实现原理**：实现 `conditional(iid, result)` 钩子，
用 `J$.getGlobalIID(iid)` 作为 key 统计 true/false 分支次数，
在 `endExecution()` 中打印结果。

**示例输出**：
```
True branch taken at example.js:(5:5)-(5:15) 3 times
False branch taken at example.js:(5:5)-(5:15) 1 times
```

---

## pldi16/ — PLDI 2016 示例

### TraceAll — 完整执行跟踪

**文件**：`src/plugins/pldi16/TraceAll.js`

打印程序执行过程中所有运行时事件，包括函数调用层级（缩进显示）和对象 ID。
需要配合 SMemory 使用。

```js
import { SMemory, SMemoryPlugin } from './src/runtime/SMemory.js';
import { TraceAllAnalysis }        from './src/plugins/pldi16/TraceAll.js';

const smemory = new SMemory(J$);
J$.smemory = smemory;
J$.analysis.use(new SMemoryPlugin(smemory))
           .use(new TraceAllAnalysis(J$));
```

---

### LogLoadStore — 内存读写跟踪

**文件**：`src/plugins/pldi16/LogLoadStore.js`

跟踪所有对象属性和变量的读写操作，记录操作发生时的对象 ID 和位置。

---

### LogLoadStoreAlloc — 分配点感知跟踪

**文件**：`src/plugins/pldi16/LogLoadStoreAlloc.js`

在 `LogLoadStore` 基础上，追加对象分配点（allocation site）信息。
可回答"这个对象是在哪里创建的"这一问题。

---

## dlint/ — DLint 代码质量检测

DLint 是一套运行时 JavaScript 代码质量检查工具，检测常见编程错误。

### CheckNaN — NaN 比较检测

**文件**：`src/plugins/dlint/CheckNaN.js`

检测 NaN 参与比较运算的情况（`NaN == x` 等，这类比较始终为 false）。

```js
import { CheckNaN } from './src/plugins/dlint/CheckNaN.js';
J$.analysis.use(new CheckNaN(J$));
```

**检测目标**：比较运算符（`==`, `===`, `!=`, `!==`, `<`, `>`, `<=`, `>=`）中有操作数为 NaN。

---

### UndefinedOffset — undefined 属性访问检测

**文件**：`src/plugins/dlint/UndefinedOffset.js`

检测对 `undefined` 或 `null` 对象进行属性访问的情况。

---

### ConcatUndefinedToString — undefined 字符串拼接检测

**文件**：`src/plugins/dlint/ConcatUndefinedToString.js`

检测 `undefined` 被意外拼接到字符串的情况（如 `"value: " + undefined`）。

---

### FunCalledWithMoreArguments — 参数过多检测

**文件**：`src/plugins/dlint/FunCalledWithMoreArguments.js`

检测函数调用时传入参数多于函数声明参数数量的情况。

---

### ShadowProtoProperty — 原型属性遮蔽检测

**文件**：`src/plugins/dlint/ShadowProtoProperty.js`

检测对象实例属性遮蔽（shadow）了原型链上同名属性的情况。

---

### CompareFunctionWithPrimitives — 函数与原始值比较

**文件**：`src/plugins/dlint/CompareFunctionWithPrimitives.js`

检测将函数对象与原始值进行相等比较的情况（通常是忘记调用函数的 bug）。

---

## coverage/ — 代码覆盖率

### AddCoverage — 覆盖率数据收集

**文件**：`src/plugins/coverage/AddCoverage.js`

高级覆盖率分析框架，支持多维度特征追踪和测试用例最小化（delta debugging）。
将覆盖率数据持久化到 `features.json`，结果写入 `results.json`。

---

## datatraces/ — 数据流跟踪

### LogData / TraceWriter

配合 `npm run trace-server` 启动的 WebSocket 服务器，
将运行时事件实时推送到浏览器端或持久化到文件。

```bash
# 1. 启动 Trace Server
npm run trace-server

# 2. 在分析中使用 WsBackend
# （通过 JalangiSandbox 配置，详见 Runtime-System.md）
```

---

## 选择合适的示例

| 场景 | 推荐插件 |
|------|---------|
| 学习 Jalangi2 基础 | `tutorial/LogAll.js` |
| 统计分支覆盖率 | `tutorial/BranchCoverage.js` |
| 完整执行跟踪 | `pldi16/TraceAll.js` |
| 追踪内存读写 | `pldi16/LogLoadStore.js` |
| NaN 错误检测 | `dlint/CheckNaN.js` |
| 多种代码质量检测 | `dlint/*.js`（链式注册多个）|
| 覆盖率驱动测试 | `coverage/AddCoverage.js` |
| 实时浏览器数据流 | `datatraces/TraceWriter.js` + trace-server |

## 注册多个 DLint 分析

```js
import { CheckNaN }               from './src/plugins/dlint/CheckNaN.js';
import { UndefinedOffset }         from './src/plugins/dlint/UndefinedOffset.js';
import { ConcatUndefinedToString } from './src/plugins/dlint/ConcatUndefinedToString.js';

J$.analysis
    .use(new CheckNaN(J$))
    .use(new UndefinedOffset(J$))
    .use(new ConcatUndefinedToString(J$));
```
