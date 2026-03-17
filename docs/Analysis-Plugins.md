# 示例分析插件

`src/plugins/` 目录下提供了多个示例分析插件，涵盖不同的动态分析场景，
既可直接使用，也是编写自定义分析的参考范本。

## 插件分类概览

```
src/plugins/
  ExecutionTrace.js      ← 语句级执行跟踪（核心，逆向分析专用）
  tutorial/              ← 入门教学示例（新插件开发起点）
    LogAll.js            ← 记录所有运行时事件（推荐模板）
    BranchCoverage.js    ← 分支覆盖率统计
    BacktrackLoop.js     ← 演示 isBacktrack 机制
  pldi16/                ← 机制演示示例（PLDI 2016 论文配套）
    ChangeSematicsOfMult.js  ← 演示 skip + result：修改乘法语义
    SkipFunction.js          ← 演示 skip：跳过指定函数调用
  dlint/                 ← 运行时代码质量检测（DLint）
    CheckNaN.js
    UndefinedOffset.js
    ConcatUndefinedToString.js
    FunCalledWithMoreArguments.js
    ShadowProtoProperty.js
    CompareFunctionWithPrimitives.js
    Utils.js             ← dlint 内部工具（统计排序打印）
  frames/                ← 帧栈基础设施
    Frames.js            ← shadow 帧栈实现
    FrameAnalysis.js     ← 将 Frames 接入 Jalangi 钩子系统
  coverage/              ← 覆盖率驱动测试框架
    AddCoverage.js       ← 特征图管理 + Delta-Debug
    ProcessCoverage.js   ← 汇总多轮 coverage*.json
    SpecialCoverage.js   ← 按测试用例记录分支覆盖，对接 AddCoverage
  dsjs/                  ← 动态类型统计（生成 HTML 可视化）
    Dsjs.js
    index.html
```

---

## 如何选择

| 场景 | 推荐插件 |
|------|---------|
| 学习 Jani 基础、开发新插件 | `tutorial/LogAll.js` |
| 统计分支覆盖率 | `tutorial/BranchCoverage.js` |
| 语句级执行跟踪（逆向分析）| `ExecutionTrace.js` |
| NaN 比较错误检测 | `dlint/CheckNaN.js` |
| 多种代码质量检测 | `dlint/*.js`（链式注册多个）|
| 覆盖率驱动测试最小化 | `coverage/AddCoverage.js` |
| 动态类型统计可视化 | `dsjs/Dsjs.js` |
| 演示 skip/result 机制 | `pldi16/ChangeSematicsOfMult.js` |
| 演示 isBacktrack 机制 | `tutorial/BacktrackLoop.js` |

---

## tutorial/ — 入门示例

### LogAll — 记录所有事件

**文件**：`src/plugins/tutorial/LogAll.js`

记录程序执行过程中所有运行时事件（函数调用、属性读写、变量读写等）。
是**编写新分析插件的推荐起点**，演示了现代插件写法：
- 普通 class，不依赖任何框架全局变量
- 所有外部依赖（smemory）通过构造函数显式注入
- 通过 ESM export 导出

```js
import { HookDispatcher }         from '../../runtime/HookDispatcher.js';
import { SMemory, SMemoryPlugin } from '../../runtime/SMemory.js';
import { LogAllAnalysis }         from './src/plugins/tutorial/LogAll.js';

const smemory = new SMemory(J$.Constants);
J$.smemory  = smemory;
J$.analysis = new HookDispatcher()
    .use(new SMemoryPlugin(smemory))
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

**实现原理**：实现 `evalCond(iid, result)` 钩子，用 `J$.getGlobalIID(iid)` 作为 key 统计 true/false 分支次数，在 `endExecution()` 中打印结果。

**示例输出**：
```
True branch taken at example.js:(5:5)-(5:15) 3 times
False branch taken at example.js:(5:5)-(5:15) 1 times
```

---

### BacktrackLoop — 演示 isBacktrack 机制

**文件**：`src/plugins/tutorial/BacktrackLoop.js`

极简示例（11 行），展示 `functionExit` 返回 `isBacktrack: true` 时的行为——
当函数返回值为真时，Jalangi 会重新执行该函数体（类似循环回溯）。

```js
import { BacktrackLoopAnalysis } from './src/plugins/tutorial/BacktrackLoop.js';

J$.analysis.use(new BacktrackLoopAnalysis());
```

---

## pldi16/ — 机制演示示例

这两个极简示例来自 PLDI 2016 论文，各自演示一个核心 hook 机制。

### ChangeSematicsOfMult — 修改乘法语义

**文件**：`src/plugins/pldi16/ChangeSematicsOfMult.js`

演示 `binaryPre` 的 `skip` 机制和 `binary` 的 `result` 修改机制：
将所有乘法运算（`*`）替换为加法运算。

```js
import { ChangeSematicsOfMultAnalysis } from './src/plugins/pldi16/ChangeSematicsOfMult.js';

J$.analysis.use(new ChangeSematicsOfMultAnalysis());
// 之后 3 * 4 的结果变为 7（3 + 4）
```

---

### SkipFunction — 跳过函数调用

**文件**：`src/plugins/pldi16/SkipFunction.js`

演示 `callPre` 的 `skip` 机制：当检测到调用特定函数（`evilFunction`）时，
返回 `skip: true` 阻止该函数实际执行。

```js
import { SkipFunctionAnalysis } from './src/plugins/pldi16/SkipFunction.js';

J$.analysis.use(new SkipFunctionAnalysis());
```

---

## dlint/ — 运行时代码质量检测

DLint 是一套运行时 JavaScript 代码质量检查工具，检测常见编程错误。
各检测器可单独使用，也可通过 `HookDispatcher.use()` 链式注册多个。

```js
import { CheckNaN }                   from './src/plugins/dlint/CheckNaN.js';
import { UndefinedOffset }             from './src/plugins/dlint/UndefinedOffset.js';
import { ConcatUndefinedToString }     from './src/plugins/dlint/ConcatUndefinedToString.js';
import { FunCalledWithMoreArguments }  from './src/plugins/dlint/FunCalledWithMoreArguments.js';
import { ShadowProtoProperty }         from './src/plugins/dlint/ShadowProtoProperty.js';
import { CompareFunctionWithPrimitives } from './src/plugins/dlint/CompareFunctionWithPrimitives.js';

J$.analysis
    .use(new CheckNaN(J$))
    .use(new UndefinedOffset(J$))
    .use(new ConcatUndefinedToString(J$))
    .use(new FunCalledWithMoreArguments(J$))
    .use(new ShadowProtoProperty(J$))
    .use(new CompareFunctionWithPrimitives(J$));
```

所有检测器的结构一致：在 `endExecution()` 中按触发次数从高到低排序打印报告。

---

### CheckNaN — NaN 比较检测

**文件**：`src/plugins/dlint/CheckNaN.js`

检测 NaN 参与比较运算的情况（`NaN == x` 等，这类比较始终为 `false`）。

**检测目标**：比较运算符（`==`、`===`、`!=`、`!==`、`<`、`>`、`<=`、`>=`）中有操作数为 NaN。

**示例输出**：
```
Comparison with NaN at example.js:(3:5)-(3:15) 2 time(s).
```

---

### UndefinedOffset — undefined 属性键检测

**文件**：`src/plugins/dlint/UndefinedOffset.js`

检测以 `undefined` 作为属性键进行读取或写入的情况（如 `obj[undefined]`，通常是变量未初始化导致的 bug）。

**钩子**：`getFieldPre` / `putFieldPre`，检测 `offset === undefined`。

---

### ConcatUndefinedToString — undefined 字符串拼接检测

**文件**：`src/plugins/dlint/ConcatUndefinedToString.js`

检测 `undefined` 或 `null` 被意外拼接到字符串的情况（如 `"value: " + undefined`，结果为 `"value: undefined"`）。

**钩子**：`binary`，检测 `op === '+'` 且一侧为字符串、另一侧为 `undefined`/`null`。

---

### FunCalledWithMoreArguments — 参数过多检测

**文件**：`src/plugins/dlint/FunCalledWithMoreArguments.js`

检测函数调用时传入参数多于函数声明参数数量的情况。
自动跳过含 rest 参数（`...args`）的函数，避免误报。

**钩子**：`callPre`，比较 `args.length > f.length`。

---

### ShadowProtoProperty — 原型属性遮蔽检测

**文件**：`src/plugins/dlint/ShadowProtoProperty.js`

检测对象实例属性写入时遮蔽（shadow）了原型链上同名属性的情况，
这通常是意外修改了本应共享的原型方法。

**钩子**：`putFieldPre`，检查 `offset in Object.getPrototypeOf(base)` 且 `base` 自身无该属性。

---

### CompareFunctionWithPrimitives — 函数与原始值比较

**文件**：`src/plugins/dlint/CompareFunctionWithPrimitives.js`

检测将函数对象与原始值（字符串、数字、布尔）进行相等比较的情况，
通常是忘记调用函数（写成 `if (fn == 0)` 而非 `if (fn() == 0)`）。

**钩子**：`binary`，检测比较运算中一侧为 `function`、另一侧为原始类型。

---

## frames/ — 帧栈基础设施

### Frames + FrameAnalysis

**文件**：`src/plugins/frames/Frames.js`、`src/plugins/frames/FrameAnalysis.js`

维护函数调用帧栈（shadow frame），追踪每个变量所属的函数帧。
`Frames` 是纯数据结构，`FrameAnalysis` 将其接入 Jalangi 钩子系统。

其他分析可通过 `sandbox.frames` 访问帧信息：

```js
import { FrameAnalysisPlugin } from './src/plugins/frames/FrameAnalysis.js';

J$.analysis.use(new FrameAnalysisPlugin(J$));
// 之后 J$.frames 可用
```

---

## coverage/ — 覆盖率驱动测试框架

### AddCoverage — 特征图管理 + 测试最小化

**文件**：`src/plugins/coverage/AddCoverage.js`

高级覆盖率分析框架，核心是一套**特征图（feature graph）**算法：
将每轮测试覆盖的代码分支构建成特征集合，
支持多维度特征追踪和测试用例最小化（Delta-Debug）。

数据持久化到 `tmp/features.json`，结果写入 `tmp/results.json`。

```js
import { Features } from './src/plugins/coverage/AddCoverage.js';

// 添加一轮测试的覆盖率数据
Features.addCoverage(testCode, coverageMap, /* forceAdd */ true);

// 独立运行（触发 Delta-Debug 最小化）
node src/plugins/coverage/AddCoverage.js
```

---

### ProcessCoverage — 汇总多轮覆盖率

**文件**：`src/plugins/coverage/ProcessCoverage.js`

独立脚本，读取多个 `coverage0.json`、`coverage1.json`、… 文件，
汇总成 `allcoverage.json`（含 `statementMap` 和逐测试覆盖数组）。

```bash
# 参数 1 = 分支覆盖，2 = 语句覆盖
node src/plugins/coverage/ProcessCoverage.js 1
```

---

### SpecialCoverage — 按测试记录分支覆盖

**文件**：`src/plugins/coverage/SpecialCoverage.js`

Jalangi 分析插件，配合 `AddCoverage.js` 使用：
在每轮测试的 `beginExecution` / `endExecution` 生命周期内收集 `evalCond` 和 `endExpression` 触发的分支信息，
然后调用 `Features.addCoverage()` 写入特征图。

与 mocha/QUnit 集成：在测试框架的 `beforeEach`/`afterEach` 中分别调用 `beginExecution()` 和 `endExecution()`。

---

## dsjs/ — 动态类型统计

### Dsjs — 动态类型特征统计

**文件**：`src/plugins/dsjs/Dsjs.js`

对 JavaScript 程序进行动态类型特征统计，检测：
- 数组均匀性（元素类型是否一致）
- 对象哈希化（是否变成了 hash map）
- `for-in` 使用情况
- 数组方法调用次数（`push`、`pop`、`splice` 等）
- 构造函数调用情况

在 `endExecution()` 中将统计结果生成可交互的 HTML 可视化（基于 `index.html` 模板）。

```bash
# 运行后生成 index.html，浏览器打开查看树形统计
node bin/jalangi.mjs instrument-and-run \
    --analysis src/plugins/dsjs/Dsjs.js \
    tests/octane/richards.js
```

---

## ExecutionTrace — 语句级执行跟踪

**文件**：`src/plugins/ExecutionTrace.js`

专为**逆向分析**设计的执行跟踪插件，提供语句级和函数级追踪。
是 `src/plugins/` 中功能最完整的正式分析插件。

### 核心设计

| 特性 | 说明 |
|------|------|
| **粒度** | 语句级 + 函数级，不做更细粒度追踪 |
| **变量读取** | 方案 F：由插桩器将静态 use-set 注入 `Xe` 参数，运行时从 Shadow Frame 查询，零 `readVar` 插桩 |
| **属性读写** | 方案 C：`getField`/`putField` 暂存到缓冲区，由 `endExpression` 统一合并输出 |
| **日志后端** | 支持 IndexedDB（浏览器）、WebSocket、Node.js 文件、console 四种后端，通过 `TraceLogger` 统一管理 |
| **输出格式** | 4 种格式可选：`FORMAT_FLAT`（默认平铺）、`FORMAT_TREE`（树形）、`FORMAT_BLOCK`（折叠块）、`FORMAT_PIPE`（管道符）|

### 输出格式（FORMAT_FLAT 默认）

kv 部分的输出模式由 `src/utils/traceFormatters.js` 中的 `OUTPUT_JSON_KV` 常量控制：

#### OUTPUT_JSON_KV=true（默认，离线分析推荐）

kv 部分输出为结构化 JSON 子串，`w`（writes）/ `r`（reads）/ `f`（fields）分别独立，便于程序解析：

```text
[     1] [      1:1] var x = 1 {"w":{"x":1}}
[     2] [      2:1] x += 1 {"w":{"x":2},"r":{"x":1}}
[     3] [      3:5] CALL .fromCharCode(1 args) {"a":[65],"this":"[Function String]"}
[     4] [      3:5] RETN fromCharCode {"v":"A"}
[     5] [      3:1] o += String.fromCharCode(c) {"w":{"o":"A"},"r":{"c":65}}
```

#### OUTPUT_JSON_KV=false（传统格式，人眼阅读友好）

kv 部分输出为逗号分隔的 `key=value` 文本，适合直接阅读：

```text
[     1] [      1:1] var x = 1 ; x=1
[     2] [      2:1] x += 1 ; x=2
[     3] [      3:5] CALL .fromCharCode(1 args) ; this=[Function String], arg0=65
[     4] [      3:5] RETN fromCharCode ; ="A"
[     5] [      3:1] o += String.fromCharCode(c) ; o="A", c=65
```

> 离线分析工具链（`tools/trace-parse.mjs` 等）自动兼容两种格式的混合输入。
> 详见 [Offline-Analysis-Tools.md](./Offline-Analysis-Tools.md)。

### 用法

```js
import { ExecutionTraceAnalysis } from './src/plugins/ExecutionTrace.js';

// 最简用法（Node.js，输出到文件）
J$.analysis = new ExecutionTraceAnalysis(J$, originalSourceCode, {
    nodeFile: 'jalangi-trace.ndjson',
});

// 浏览器，输出到 IndexedDB
J$.analysis = new ExecutionTraceAnalysis(J$, originalSourceCode, {
    useIdb: true,
    dbName: 'my-traces',
});

// 通过 WebSocket 实时推送到 trace-server
J$.analysis = new ExecutionTraceAnalysis(J$, originalSourceCode, {
    wsUrl: 'ws://localhost:8080',
});
```

自动配置推导（插桩器按需配置 hooks，无需手写 Config）：

```js
import { init } from './src/instrument/esnstrument.js';
const analysis = new ExecutionTraceAnalysis(J$, src, opts);
init(null, undefined, undefined, undefined, [analysis]);
```

### 生命周期方法

| 方法 | 说明 |
|------|------|
| `onReady(cb)` | 日志后端就绪后回调，Node.js 下在此之后再开始插桩执行 |
| `flush()` | 手动 flush 缓冲（不关闭 logger，可继续追踪）|
| `close()` | flush 后关闭 logger，停止记录 |

> 详细设计见 [Scope-Aware-Instrumentation.md](./Scope-Aware-Instrumentation.md)。
