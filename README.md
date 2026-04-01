# Jani — JavaScript 动态分析框架

> 基于 [Samsung/jalangi2](https://github.com/Samsung/jalangi2) 核心插桩思想，经过**彻底重构**的新一代 JavaScript 动态分析框架。

---

## 简介

**Jani** 是一个面向 JavaScript 的动态分析框架，通过对 JS 源代码进行 AST 插桩（Instrumentation），在关键操作（变量读写、属性访问、函数调用、运算符、字面量等）前后注入分析钩子，从而在运行时收集程序行为数据，用于 bug 检测、代码覆盖率统计、污点分析、性能剖析等场景。

### 与原版 Jalangi2 的关系

Jani 核心插桩逻辑参考了 Samsung/jalangi2 的设计思想，但进行了较为彻底的重构：

- **全面迁移到 ESM**：`"type": "module"`，所有模块使用 `import/export`，无全局污染
- **解析器升级**：从 `acorn + astring` 完全迁移到 `@babel/parser + @babel/generator`，支持 ES2022+ 及 TypeScript/Flow 语法
- **单次统一插桩 Pass**：彻底解决旧版多 Pass 遍历在现代语法（箭头函数、逻辑赋值、Async/Await 等）上的漏插桩问题
- **作用域感知**：全新的 `scope.js` 为每个词法作用域分配唯一 `ScopeID`，精确区分同名变量
- **静态 SSA def-use 分析**：新增 `dataflow.js` 在插桩前分析，生成 FULL / LIGHTWEIGHT / DEAD 三级插桩决策表
- **Shadow Frame + 轻量读取**：运行时按 `(defScopeId, callId)` 缓存变量值，支持 `J$.Rl` 轻量读取路径，大幅降低代码膨胀
- **异步 ContextID**：全新 `J$.Aw` 恢复点钩子，彻底解决异步 log 交叉感染问题
- **统一日志系统**：独立 `src/logger/` 模块，支持 Memory / NodeStream / WebSocket / IndexedDB Worker 多后端

---

## 架构概览

整体流程分为三个阶段：**预处理 → 插桩 → 运行时分析**。

```
JavaScript 源代码
      │
      ▼ [可选] preprocessCode()
  预处理器 (src/preprocess/)
  ├── 反混淆：逗号拆分 / void替换 / 常量折叠 / 死代码删除
  └── 语法降级：@babel/preset-env → 目标版本
      │
      ▼ init(config) + instrumentCode()
  插桩器 (src/instrument/)
  ├── @babel/parser 解析 → AST
  ├── scope.js 作用域分析
  ├── dataflow.js 静态 def-use 分析（Pass 0）
  └── 单次统一插桩 Pass → @babel/generator 生成
      │
      ▼ 执行插桩后代码
  运行时沙盒 (src/runtime/)
  └── J$ = JalangiSandbox → HookDispatcher → 分析插件
```

---

## 代码结构

```
src/
  instrument/     插桩器核心（解析 → 变换 → 生成）
  runtime/        运行时钩子框架（JalangiSandbox / HookDispatcher / SMemory 等）
  logger/         日志系统（RingBuffer / LogManager / 多后端）
  preprocess/     预处理（反混淆 / 语法降级）
  plugins/        示例分析插件（dlint / datatraces 等）
  encoding/       事件序列化工具

bin/              命令行入口
  jalangi.mjs     插桩 + 运行工具
  preprocess.mjs  预处理工具

tools/
  trace-server/   浏览器端 Trace 收集服务器（WebSocket）
  trace-parse.mjs       原始 trace → 结构化 NDJSON（多线程并行，默认启用）
  trace-render.mjs      结构化 NDJSON → flat / tree / block / pipe 展示格式
  trace-filter.mjs      按类型 / seq / 行号 / 函数名 / 变量过滤
  trace-hot-lines.mjs   代码行执行热点统计（Top-N）
  trace-call-tree.mjs   函数调用树重建（支持深度限制与汇总统计）
  trace-var-timeline.mjs 变量值时序追踪
  trace-range-extract.mjs 按 seq 区间快速提取片段（含 context 窗口）

test/
  unit/           单元测试（插桩器 / 日志 / 序列化）
  integration/    集成测试（e2e / hooks / runtime / logging）

docs/             完整技术文档
```

### 插桩器核心模块（`src/instrument/`）

| 模块 | 职责 |
|------|------|
| `esnstrument.js` | 主入口，`init()` + `instrumentCode()` 对外 API |
| `astUtil.js` | AST 遍历器与 CONTEXT 上下文枚举 |
| `scope.js` | 词法作用域分析，含 ScopeID / eval / with 检测 / varKind |
| `iid.js` | IID（Instruction ID）计数器与源码位置映射 |
| `wrappers.js` | AST 节点包装函数库，使用 `@babel/types` 直接构建 AST |
| `dataflow.js` | 静态 SSA def-use 分析，生成插桩决策表（Pass 0） |
| `pluginAnalyzer.js` | 插件静态分析器，自动推导按需 Config |

**模块依赖关系**：

```
Constants.js → iid.js / astUtil.js → scope.js → wrappers.js
                                                      ↓
dataflow.js   pluginAnalyzer.js  ←←←←←←←←←  esnstrument.js
```

### 运行时模块（`src/runtime/`）

| 模块 | 职责 |
|------|------|
| `JalangiRuntime.js` | 所有 J$ 钩子函数的核心实现（基类），含 OID、ContextID、Shadow Frame |
| `JalangiSandbox.js` | 完整沙盒对象，继承 `JalangiRuntime`（推荐使用） |
| `HookDispatcher.js` | 多插件链式调度器，`.use()` 注册分析 |
| `SMemory.js` | Shadow Memory 影子内存，为对象关联唯一 ID |
| `DataFlowAnalyzer.js` | 运行时 SSA 数据流分析器，支持 backward slicing |
| `AntiDetection.js` | 反插桩对抗工具（`toString` Hook / 全局变量检测 / 异步上下文包装） |
| `NativeProxy.js` | 原生方法快照，防止 monkey-patch 导致递归栈溢出 |
| `analysisCallbackTemplate.js` | 分析插件接口模板（`AnalysisTemplate` 基类） |

---

## 关键技术

### 插桩钩子

插桩器将 JavaScript 操作替换为对应的 `J$.xxx()` 钩子调用：

| 钩子 | 触发场景 |
|------|---------|
| `J$.R(iid, name, val, flags, defScopeId?)` | 变量读取（全量路径） |
| `J$.Rl(iid, defScopeId, name)` | 变量读取（**轻量路径**，从 Shadow Frame 查值） |
| `J$.W(iid, name, val, lhs, flags, defScopeId?)` | 变量写入 |
| `J$.G(iid, base, offset, flags)` | 属性读取 |
| `J$.P(iid, base, offset, val, flags)` | 属性写入 |
| `J$.F(iid, f, flags)` | 函数调用 |
| `J$.M(iid, base, offset, flags)` | 方法调用 |
| `J$.T(iid, val, type, hasGS)` | 字面量创建 |
| `J$.B(iid, op, left, right, flags)` | 二元运算 |
| `J$.U(iid, op, left)` | 一元运算 |
| `J$.C(iid, cond)` | 条件判断 |
| `J$.Fe(iid, f, dis, args, defScopeId?)` | 函数进入 |
| `J$.Fx(iid)` | 函数退出 |
| `J$.Aw(iid, val, ctxId?)` | `await` 恢复点 |
| `J$.Se(iid, val, origFile)` / `J$.Sr(iid)` | 脚本进入/退出 |
| `J$.Dc(iid, name, val, flags)` | 变量声明初始化 |

### IID（Instruction ID）

- 步长为 **8**，同一 AST 节点的多个子操作共享一段 IID
- 每次调用 `instrumentCode` 前，`IID.initialize()` 会重置计数器
- `iidSourceInfo` 记录 `iid → [startLine, startCol, endLine, endCol]`

### 作用域感知插桩

`scope.js` 为每个词法作用域分配唯一 `ScopeID`，`J$.W` / `J$.Fe` 传递 `defScopeId`，精确区分同名变量，支持闭包追踪。

### Shadow Frame + 轻量读取

运行时按 `(defScopeId, callId)` 缓存变量值；对静态可信局部变量改用 `J$.Rl` 不传值路径，大幅降低代码膨胀。结合 `FinalizationRegistry` 自动回收闭包引用的 Shadow Frame，防止内存泄漏。

### 静态 SSA def-use 分析

`dataflow.js` 在插桩前对 AST 进行两阶段分析，生成插桩决策表（`FULL` / `LIGHTWEIGHT` / `DEAD`），指导插桩 Pass 选择最优钩子。

### 异步 ContextID

`J$.Aw` 恢复点钩子 + `newAsyncContext()` / `activateContext()` API，彻底解决异步 log 交叉感染问题，每个 Promise 链拥有独立的执行上下文 ID。

---

## 技术栈

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@babel/parser` | `^7.29` | JavaScript 解析器，支持 ES2022+、TS/Flow 及实验性语法 |
| `@babel/generator` | `^7.29` | 代码生成器，支持 Babel 原生 AST |
| `@babel/traverse` | `^7.29` | AST 遍历器，供预处理模块和插桩器共用 |
| `@babel/core` | `^7.29` | Babel 变换核心，供 `TranspilePlugin` 语法降级使用 |
| `@babel/preset-env` | `^7.29` | 按 Browserslist 目标自动选择语法降级变换 |
| `ws` | `^8.19` | WebSocket 服务，供 Trace Server 和浏览器后端使用 |

> **运行环境**：Node.js ≥ 18（原生 ESM 支持）；浏览器端插桩输出支持现代浏览器。

---

## 安装

### 要求

- **Node.js ≥ 18**（需要原生 ESM 支持）
- npm ≥ 9

### 步骤

```bash
git clone <repo-url>
cd Jani
npm install
```

---

## 使用方式

### 命令行工具

项目提供 `bin/jalangi.mjs` 和 `bin/preprocess.mjs` 两个命令行工具。

#### 插桩单个文件

```bash
# 插桩（Node.js 目标）
node bin/jalangi.mjs instrument src/app.js

# 插桩（浏览器目标，内联运行时）
node bin/jalangi.mjs instrument --target browser src/app.js

# 插桩并拆分运行时（运行时与业务代码分离）
node bin/jalangi.mjs instrument --split-runtime src/app.js
```

或使用 npm scripts：

```bash
npm run instrument -- src/app.js
npm run instrument:browser -- src/app.js
```

#### 插桩并立即运行（Node.js）

```bash
node bin/jalangi.mjs instrument-and-run \
  --analysis src/plugins/tutorial/LogAll.js \
  target.js

# npm script 方式
npm run instrument-and-run -- --analysis src/plugins/dlint/CheckNaN.js target.js
```

#### 预处理（可选，插桩前清理混淆/压缩代码）

```bash
# 默认反混淆（逗号拆分 + void替换 + 常量折叠 + 死代码删除）
node bin/preprocess.mjs data/cl.js

# 完整流程：反混淆 + 降级到 "defaults" 浏览器
node bin/preprocess.mjs --preset full --targets defaults data/cl.js

# 仅语法降级到 IE 11
node bin/preprocess.mjs --preset transpile --targets '{"ie":"11"}' data/app.js

# 输出到 stdout 预览
node bin/preprocess.mjs --stdout data/cl.js

# npm script 方式
npm run preprocess -- data/cl.js
npm run preprocess:full -- --targets defaults data/cl.js
```

#### 启动 Trace Server（浏览器端事件收集）

```bash
npm run trace-server
# 每次 WebSocket 连接写入 traces/ 目录下独立文件
```

#### 离线 Trace 后处理（`tools/` 工具链）

`ExecutionTrace` 插件产生的原始 trace 文件可通过 `tools/` 下的工具链进行离线分析，遵循 Unix 管道哲学（一工具一事，可任意串联）：

```bash
# 步骤 1：将原始 trace 解析为结构化 NDJSON（默认多线程加速）
node tools/trace-parse.mjs traces/trace_xxx.ndjson > parsed.ndjson

# 步骤 2：以树形视图查看函数调用链
cat parsed.ndjson | node tools/trace-render.mjs --format tree

# 步骤 3：找出执行最频繁的代码行（热点分析）
cat parsed.ndjson | node tools/trace-hot-lines.mjs --top 20

# 步骤 4：重建函数调用树（汇总统计）
cat parsed.ndjson | node tools/trace-call-tree.mjs --summary

# 步骤 5：追踪变量值变化轨迹
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var key,result

# 管道组合示例：只看 decode 相关调用的完整路径
cat parsed.ndjson \
  | node tools/trace-filter.mjs --type call --fn "*decode*" \
  | node tools/trace-call-tree.mjs --summary
```

完整工具文档见 [`docs/Offline-Analysis-Tools.md`](docs/Offline-Analysis-Tools.md)。

---

### 编程 API

#### 1. 纯插桩（不运行）

适合构建管线，或在 Node.js 中以编程方式生成插桩代码：

```js
import { init, instrumentCode } from './src/instrument/esnstrument.js';

// 手动传入 Config（null = 该类操作全部插桩）
init({ ENABLE_SAMPLING: false });

const { code, sourceMapObject } = instrumentCode({
    code:             'var x = 1; console.log(x);',
    origCodeFileName: 'example.js',
    instCodeFileName: 'example_inst.js',
    inlineSourceMap:  true,   // 将 IID→位置 map 内联到输出头部
    sourceType:       'script',
});
```

#### 2. 按需插桩（自动推导 Config）

```js
import { init, instrumentCode } from './src/instrument/esnstrument.js';

// config 传 null，提供 plugins 路径：自动静态分析插件所用 Hook，生成最小化 Config
init(null, undefined, undefined, undefined, ['./src/plugins/dlint/CheckNaN.js']);

const result = instrumentCode({
    code: src,
    origCodeFileName: 'foo.js',
    instCodeFileName: 'foo_inst.js',
});
```

#### 3. 插桩 + 运行时分析

```js
import { JalangiSandbox } from './src/runtime/JalangiSandbox.js';
import { init, instrumentCode } from './src/instrument/esnstrument.js';
import vm from 'node:vm';

// 1. 初始化沙盒
const J$ = globalThis.J$ = new JalangiSandbox();

// 2. 注册自定义分析插件
J$.analysis.use({
    read(iid, name, val) {
        console.log(`读取变量 ${name} = ${val}`);
        return { result: val };
    }
});

// 3. 插桩代码
init({ INSTR_READ: null });
const { code } = instrumentCode({
    code: 'var x = 42; var y = x + 1;',
    origCodeFileName: 'test.js',
    instCodeFileName: 'test_inst.js',
});

// 4. 在沙盒中执行
vm.runInNewContext(code, { J$ });
```

#### 4. 编写自定义分析插件

继承 `AnalysisTemplate` 并实现所需钩子：

```js
import { AnalysisTemplate } from './src/runtime/analysisCallbackTemplate.js';

class MyAnalysis extends AnalysisTemplate {
    read(iid, name, val, isGlobal, isScriptLocal) {
        // 变量读取时触发
        return { result: val };
    }

    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        // 变量写入时触发
        return { result: val };
    }

    getField(iid, base, offset, val, isComputed, isOpAssign) {
        // 属性读取后触发
        return { result: val };
    }

    endExecution() {
        // 程序结束时，输出分析报告
    }
}

// 注册插件
J$.analysis.use(new MyAnalysis(J$));
```

---

## 运行测试

```bash
# 全量测试
npm test

# 仅单元测试（插桩器 + 日志）
npm run test:unit

# 仅集成测试（e2e / hooks / runtime / logging）
npm run test:integration

# 仅日志系统测试
npm run test:logging
```

---

## 内置分析插件

`src/plugins/` 目录下包含多个示例和实用分析插件：

| 插件 | 说明 |
|------|------|
| `dlint/CheckNaN.js` | 检测 NaN 污染（NaN 参与运算或被当作正常值使用） |
| `dlint/ConcatUndefinedToString.js` | 检测 `undefined` 被拼接到字符串 |
| `dlint/FunCalledWithMoreArguments.js` | 检测函数调用时传入过多参数 |
| `tutorial/LogAll.js` | 打印所有触发的钩子（用于调试和学习） |
| `datatraces/` | 数据流追踪分析 |

---

## 文档

详细文档见 `docs/` 目录：

| 文档 | 内容 |
|------|------|
| [`docs/Overview.md`](docs/Overview.md) | 整体架构、钩子一览、使用方式 |
| [`docs/Instrumentation-Engine.md`](docs/Instrumentation-Engine.md) | 插桩引擎全部模块、`init()` / `instrumentCode()` API |
| [`docs/Configuration.md`](docs/Configuration.md) | Config 对象所有字段 |
| [`docs/Preprocessing.md`](docs/Preprocessing.md) | 预处理器（反混淆 + 语法降级） |
| [`docs/Runtime-System.md`](docs/Runtime-System.md) | 运行时框架（JalangiSandbox / HookDispatcher / SMemory） |
| [`docs/Logger-System.md`](docs/Logger-System.md) | 日志系统 + Trace Server |
| [`docs/Analysis-Development.md`](docs/Analysis-Development.md) | 分析插件接口（`AnalysisTemplate`） |
| [`docs/Analysis-Plugins.md`](docs/Analysis-Plugins.md) | 示例插件详解 |
| [`docs/Scope-Aware-Instrumentation.md`](docs/Scope-Aware-Instrumentation.md) | 作用域感知插桩技术设计 |
| [`docs/Testing-System.md`](docs/Testing-System.md) | 测试体系结构与方法 |
| [`docs/Offline-Analysis-Tools.md`](docs/Offline-Analysis-Tools.md) | `tools/` 离线 Trace 分析工具链（trace-parse / render / filter / call-tree 等）|

---

## License

本项目基于 [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0.html) 发布。

原始 Jalangi2（Samsung/jalangi2）由 Samsung Research America 开发，版权归原作者所有。
