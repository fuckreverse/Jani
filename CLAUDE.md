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

| 文档 | 对应范围 |
|------|---------|
| [`docs/Overview.md`](docs/Overview.md) | 整体架构、钩子一览、使用方式 |
| [`docs/Instrumentation-Engine.md`](docs/Instrumentation-Engine.md) | `src/instrument/` 全部模块、`init()` / `instrumentCode()` API |
| [`docs/Configuration.md`](docs/Configuration.md) | Config 对象所有字段 |
| [`docs/Preprocessing.md`](docs/Preprocessing.md) | `src/preprocess/` 反混淆 + 语法降级 |
| [`docs/Runtime-System.md`](docs/Runtime-System.md) | `src/runtime/` 运行时框架 |
| [`docs/Logger-System.md`](docs/Logger-System.md) | `src/logger/` 日志系统 + Trace Server |
| [`docs/Analysis-Development.md`](docs/Analysis-Development.md) | 分析插件接口（`AnalysisTemplate`）|
| [`docs/Analysis-Plugins.md`](docs/Analysis-Plugins.md) | `src/plugins/` 示例插件 |
| [`docs/Scope-Aware-Instrumentation.md`](docs/Scope-Aware-Instrumentation.md) | 作用域感知插桩技术设计 |
| [`docs/Testing-System.md`](docs/Testing-System.md) | `test/` 测试体系结构、方法、TODO |

**文档同步原则**：代码变更时同步更新对应文档；只更新受影响的文档，不整体重写；以代码为准。
