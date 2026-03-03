# Jalangi2 — 项目说明（面向 AI 辅助开发）

## 项目概况

Jalangi2 是一个 **JavaScript 动态分析框架**，核心功能是对 JS 源代码进行 AST 插桩（instrumentation），
在每个关键操作（读写变量、属性访问、函数调用、运算符、字面量等）前后注入分析钩子（`J$.R`、`J$.W`、`J$.G` 等），
从而在运行时收集程序行为数据（用于 bug 检测、覆盖率、污点分析等）。

**目标环境**：浏览器 + Node.js 均支持。插桩器核心（`src/instrument/`）为纯 ESM，
不依赖任何平台 API，可在两种环境中直接使用。

### 当前重构状态（2026-03）

插桩器核心（`src/instrument/`）已完成**全面现代化重构**：

- **模块系统**：从旧式 IIFE + 全局 `J$` 对象迁移到标准 **ESM**（`import` / `export`）
- **语法**：全部使用 `const` / `let`，箭头函数，模板字符串，`class`，可选链 `?.`，空值合并 `??`，rest/spread
- **无全局污染**：不再向 `window` / `globalThis` 写入任何属性
- **依赖**：`acorn ^8.16`（解析，支持 ES2022+），`astring ^1.9`（代码生成，替代旧版 esotope）
- **package.json**：已加 `"type": "module"`

### 核心模块依赖关系

```
Constants.js          ← 无依赖，纯常量
    ↓
iid.js                ← 无依赖，IID 计数器与源码位置映射
astUtil.js            ← Constants.js
    ↓
scope.js              ← Constants.js + astUtil.js
    ↓
wrappers.js           ← Constants.js + iid.js（需 init(config) 注入 Config）
    ↓
esnstrument.js        ← 所有上述模块 + acorn + astring
                        （需 init(config, analysis?, sid?) 后才能调用 instrumentCode）
```

### 尚未迁移的文件（仍为旧式 IIFE / CommonJS）

| 文件 | 说明 |
|------|------|
| `src/runtime/analysis.js` | 运行时分析基类，含 Node.js 专有代码 |
| `src/runtime/SMemory.js` | Shadow Memory，含 Node.js 专有代码 |
| `src/commands/` | Node.js CLI 工具，可保留接口但待清理 |

---

## 开发规范

### 每次修改后必须运行单测

```bash
node test/instrument.test.mjs
# 或
npm test
```

所有用例全部通过后再提交。

### 单测文件约定

所有测试文件统一放在 `test/` 目录下：

| 文件 | 状态 | 内容 |
|------|------|------|
| `test/instrument.test.mjs` | ✅ 当前主测试 | 插桩器端到端集成测试，覆盖 ES5～ES2022、source map、Config 禁用等（当前 56 个用例）|
| `test/_legacy_astring.js` | ⚠️ 废弃（保留备查） | 重构前验证 astring 本身的临时脚本，用 CommonJS + 旧式全局加载 |
| `test/_legacy_class_debug.js` | ⚠️ 废弃（保留备查） | 重构前调试 class 插桩的单次脚本，用 CommonJS |
| `test/_legacy_modern_syntax.js` | ⚠️ 废弃（保留备查） | 重构前现代语法冒烟测试，已合并进主测试 |
| `test/_legacy_apiTests.js` | ⚠️ 废弃（保留备查） | 依赖 `src/utils/api.js`（尚未 ESM 化） |
| `test/_legacy_instDirTests.js` | ⚠️ 废弃（保留备查） | 依赖 `src/commands/instrument`（尚未 ESM 化） |

**原则**：
1. **优先修改 `test/instrument.test.mjs`**，不要为每个小改动新建文件
2. 只有当测试主题与现有文件**明显不同**（如新增 runtime 测试、Config 测试）时，才新建文件
3. 每个测试用例要有明确注释说明测试目标，失败时信息要有诊断价值
4. 避免重复：同一行为只在一处测试
5. 废弃的测试文件等 runtime 迁移完成后统一清理

### 插桩器使用方式（快速参考）

```js
import { init, instrumentCode } from '../src/instrument/esnstrument.js';
// 在测试文件 test/ 目录下路径前缀为 ../src/
// 在项目根目录脚本中路径前缀为 ./src/

// 1. 必须先初始化（传入 Config 对象）
const Config = { ENABLE_SAMPLING: false /* 其余字段 null 表示"全部插桩" */ };
init(Config);

// 2. 调用插桩
const result = instrumentCode({
    code:             '<JS 源代码字符串>',
    origCodeFileName: 'foo.js',        // 原始文件名（source map 用）
    instCodeFileName: 'foo_inst.js',   // 插桩后文件名
    inlineSourceMap:  false,           // true → 将完整 iid→位置 map 内联到输出头部
    inlineSource:     false,           // true → 将原始源码内联到 source map
    sourceType:       'script',        // 'script'（默认）或 'module'（支持顶层 await）
    isEval:           false,
    url:              undefined,
});
// result.code            → 插桩后的代码字符串
// result.sourceMapObject → iid → [line, col, endLine, endCol] 映射
```

### Config 字段说明

Config 对象控制哪些操作被插桩。字段为 `null` / `undefined` 表示**全部插桩**该类型；
设为函数 `(ast) => boolean` 可细粒度控制：

| 字段 | 控制范围 |
|------|---------|
| `INSTR_READ` | 变量读取 |
| `INSTR_WRITE` | 变量写入 |
| `INSTR_GETFIELD` | 属性读取 |
| `INSTR_PUTFIELD` | 属性写入 |
| `INSTR_BINARY` | 二元运算 |
| `INSTR_UNARY` | 一元运算 |
| `INSTR_LITERAL` | 字面量 |
| `INSTR_INIT` | 变量声明初始化 |
| `INSTR_CONDITIONAL` | 条件表达式 / switch |
| `INSTR_TRY_CATCH_ARGUMENTS` | 函数/脚本 try-catch 包裹 |
| `INSTR_END_EXPRESSION` | 表达式语句末尾标记 |
| `ENABLE_SAMPLING` | 是否启用采样模式 |

---

## 关键设计细节（修改时需注意）

### IID（Instruction ID）

- 步长为 **8**，同一 AST 节点的多个子操作共享一段 IID（如方法调用的 `iid+2` 是内部 getField）
- 每次调用 `instrumentCode` 前，`IID.initialize()` 会重置计数器
- `iidSourceInfo` 记录 `iid → [startLine, startCol, endLine, endCol]`

### CONTEXT 枚举（astUtil.js）

`transformAst` 在遍历时为每个节点附带上下文，visitor 依赖它判断是否插桩：

- `CONTEXT.RHS` → 右值，需要插桩读取
- `CONTEXT.IGNORE` → 赋值左侧、标签、解构 key 等，不插桩
- `CONTEXT.METHOD` → `MethodDefinition.value`，不把 FunctionExpression 当独立字面量包装
- `CONTEXT.GETTER` / `CONTEXT.SETTER` → getter/setter 内的函数，同上

### 模板缓存（wrappers.js）

`replaceInStatement(templateStr, ...args)` 第一次会 `acorn.parse` 模板字符串并缓存，
后续通过 `deepCloneAndReplace` 深拷贝复用，避免重复 parse 开销。
占位符约定：模板中用 `J$_1`、`J$_2` … 作占位符（`RP` 前缀 = `"J$_"`）。

### `astring` 注意事项

- `astring.generate(ast)` 不支持带 `loc`/`start`/`end` 以外的自定义字段（会忽略），行为正常
- 插桩产生的 `// JALANGI DO NOT INSTRUMENT` 注释追加在输出代码末尾，防止二次插桩
