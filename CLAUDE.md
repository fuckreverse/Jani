# Jani — 项目说明（面向 AI 辅助开发）

## 项目概况

Jani 是一个 **JavaScript 动态分析框架**，核心功能是对 JS 源代码进行 AST 插桩（instrumentation），
在每个关键操作（读写变量、属性访问、函数调用、运算符、字面量等）前后注入分析钩子（`J$.R`、`J$.W`、`J$.G` 等），
从而在运行时收集程序行为数据（用于 bug 检测、覆盖率、污点分析等）。

**目标环境**：浏览器 + Node.js 均支持。整个代码库为纯 **ESM**（`"type": "module"`），
依赖 `@babel/parser ^7.29` 和 `@babel/generator ^7.29`，不依赖任何平台 API。

---

## 代码结构

```
src/instrument/   插桩器核心（解析 → 变换 → 生成）→ 详见 docs/Instrumentation-Engine.md
src/runtime/      运行时钩子框架（JalangiSandbox / HookDispatcher / SMemory 等）→ 详见 docs/Runtime-System.md
src/logger/       日志系统（RingBuffer / LogManager / 多后端）→ 详见 docs/Logger-System.md
src/preprocess/   预处理（反混淆 / 语法降级）→ 详见 docs/Preprocessing.md
src/plugins/      示例分析插件（ExecutionTrace / dlint / tutorial / coverage 等）→ 详见 docs/Analysis-Plugins.md
tools/            离线 Trace 后处理工具链（trace-parse / render / filter / call-tree 等）→ 详见 docs/Offline-Analysis-Tools.md
analyzer/         Jani Trace Analyzer（JTA）本地 Web 分析平台 → 详见 analyzer/docs/
test/             测试套件（unit / integration）→ 详见 docs/Testing-System.md
docs/             全量文档索引，见下方「文档索引」
```

### 核心模块依赖关系（`src/instrument/`）

```
Constants.js → iid.js / astUtil.js → scope.js → wrappers.js
                                                      ↓
dataflow.js   pluginAnalyzer.js  ←←←←←←←←←  esnstrument.js  （主入口）
```

`esnstrument.js` 需先调用 `init(config, analysis?, sid?, jalangiVar?, plugins?)` 再调用 `instrumentCode(options)`。
完整 API 见 [`docs/Instrumentation-Engine.md`](docs/Instrumentation-Engine.md)，Config 字段见 [`docs/Configuration.md`](docs/Configuration.md)。

---

## 开发规范

### 运行测试

```bash
npm test                                          # 全量
npm run test:unit / test:integration / test:logging  # 分组
```

**每次修改后必须全部通过再提交。** 测试体系说明见 [`docs/Testing-System.md`](docs/Testing-System.md)。

### 测试文件（活跃）

| 文件 | 内容 |
|------|------|
| `test/unit/instrument.test.mjs` | 插桩器静态输出验证（ES5～ES2022 / source map / Config）|
| `test/unit/preprocess.test.mjs` | 预处理各 Pass + API + 与插桩器集成 |
| `test/unit/logging.test.mjs` | 日志系统纯内存单测（RingBuffer / LogManager）|
| `test/unit/serialize.test.mjs` | `serialize()` 工具函数全类型覆盖 |
| `test/integration/e2e.test.mjs` | 插桩后 vm 执行语义验证（闭包 / Generator / async 等）|
| `test/integration/hooks.test.mjs` | 钩子参数验证 + observeOnly / instrumentEval |
| `test/integration/runtime.test.mjs` | 运行时框架 API 边界（HookDispatcher / SMemory / DataFlowAnalyzer）|
| `test/integration/logging.test.mjs` | 日志系统真实 IO（NodeStreamBackend / WsBackend）|
| `test/integration/execution-trace.test.mjs` | ExecutionTrace 插件完整功能（FORMAT_FLAT/TREE/BLOCK/PIPE）|
| `test/integration/dlint.test.mjs` | dlint 六条规则端到端验证 |
| `test/integration/full-pipeline.test.mjs` | 全流程端到端（预处理→插桩→vm 执行→后处理工具链，51 个测试）|

**原则**：优先修改现有测试文件；只有主题明显不同时才新建；避免重复测试同一行为。

---

## 关键设计细节（修改时需注意）

### IID（Instruction ID）

- 步长为 **8**，同一 AST 节点的多个子操作共享一段 IID
- 每次调用 `instrumentCode` 前，`IID.initialize()` 会重置计数器
- `iidSourceInfo` 记录 `iid → [startLine, startCol, endLine, endCol]`

### CONTEXT 枚举（`astUtil.js`）

`transformAst` 遍历时为每个节点附带上下文，visitor 依赖它判断是否插桩：

- `CONTEXT.RHS` → 右值，需要插桩读取
- `CONTEXT.IGNORE` → 赋值左侧、标签、解构 key 等，不插桩
- `CONTEXT.METHOD` / `CONTEXT.GETTER` / `CONTEXT.SETTER` → 函数不当独立字面量包装

### Babel AST 与 ESTree 的主要差异

- **字面量**：独立类型（`NumericLiteral`、`StringLiteral` 等），而非统一 `Literal`
- **ClassMethod**：Babel 用 `ClassMethod`，ESTree 用 `MethodDefinition` + `FunctionExpression`
- **可选链**：`OptionalMemberExpression` / `OptionalCallExpression` 是独立类型
- **私有字段**：`property` 是 `PrivateName { id: Identifier }`，而非直接含 `name`
- **根节点**：`@babel/parser` 返回 `File { program: Program }`，需取 `.program`
- 插桩输出末尾追加 `// JALANGI DO NOT INSTRUMENT`，防止二次插桩

---

## 文档索引

| 编号 | 文档 | 对应范围 |
|------|------|---------|
| DOC-01 | [`docs/Overview.md`](docs/Overview.md) | 整体架构、钩子一览、使用方式 |
| DOC-02 | [`docs/Instrumentation-Engine.md`](docs/Instrumentation-Engine.md) | `src/instrument/` 全部模块、`init()` / `instrumentCode()` API |
| DOC-03 | [`docs/Configuration.md`](docs/Configuration.md) | Config 对象所有字段 |
| DOC-04 | [`docs/Preprocessing.md`](docs/Preprocessing.md) | `src/preprocess/` 反混淆 + 语法降级 |
| DOC-05 | [`docs/Runtime-System.md`](docs/Runtime-System.md) | `src/runtime/` 运行时框架 |
| DOC-06 | [`docs/Logger-System.md`](docs/Logger-System.md) | `src/logger/` 日志系统 + Trace Server |
| DOC-07 | [`docs/Analysis-Development.md`](docs/Analysis-Development.md) | 分析插件接口（`AnalysisTemplate`）|
| DOC-08 | [`docs/Analysis-Plugins.md`](docs/Analysis-Plugins.md) | `src/plugins/` 示例插件 |
| DOC-09 | [`docs/Scope-Aware-Instrumentation.md`](docs/Scope-Aware-Instrumentation.md) | 作用域感知插桩技术设计 |
| DOC-10 | [`docs/CLI-Reference.md`](docs/CLI-Reference.md) | CLI 工具完整参考（jalangi / preprocess / 后处理工具链）|
| DOC-11 | [`docs/Offline-Analysis-Tools.md`](docs/Offline-Analysis-Tools.md) | `tools/` 离线分析工具集（trace-parse / render / filter / hot-lines / call-tree 等）|
| DOC-12 | [`docs/Testing-System.md`](docs/Testing-System.md) | `test/` 测试体系结构、方法、TODO |
| DOC-13 | [`docs/Dynamic-Analysis-Design-Philosophy.md`](docs/Dynamic-Analysis-Design-Philosophy.md) | 动态分析框架设计哲学与核心概念 |
| DOC-14 | [`docs/Code-Issues.md`](docs/Code-Issues.md) | 已知代码问题与待修复 Bug 记录 |
| DOC-15 | [`analyzer/docs/Overview.md`](analyzer/docs/Overview.md) | `analyzer/` JTA 概览、架构图、目录结构、路线图、关键设计决策 |
| DOC-16 | [`analyzer/docs/DataModel.md`](analyzer/docs/DataModel.md) | `analyzer/` JTA 数据模型（Schema + 索引）、Database.mjs 实现、性能优化 |
| DOC-17 | [`analyzer/docs/Plugins.md`](analyzer/docs/Plugins.md) | `analyzer/` JTA 插件架构（接口 / 调度器）与 F/A/I 三层插件清单 |
| DOC-18 | [`analyzer/docs/API.md`](analyzer/docs/API.md) | `analyzer/` JTA REST API 完整参考、WebSocket 协议 |
| DOC-19 | [`analyzer/docs/WebUI.md`](analyzer/docs/WebUI.md) | `analyzer/` JTA Web UI 设计、MCP Server 设计与 Tool 列表 |

**文档同步原则**：代码变更时同步更新对应文档；只更新受影响的文档，不整体重写；以代码为准。
