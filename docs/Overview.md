# Jalangi2 概览

## 项目简介

Jalangi2 是一个面向 JavaScript 的**动态分析框架**，核心功能是对 JS 源代码进行 AST 插桩（Instrumentation），
在关键操作（读写变量、属性访问、函数调用、运算符、字面量等）前后注入分析钩子，
从而在运行时收集程序行为数据，用于 bug 检测、覆盖率统计、污点分析等场景。

**目标环境**：浏览器 + Node.js 均支持。插桩器核心（`src/instrument/`）为纯 ESM，
不依赖任何平台 API，可在两种环境中直接使用。

## 系统架构

Jalangi2 的整体流程分为三个阶段：

```
JavaScript 源代码
       │
       ▼
┌─────────────────────────────────────────────┐
│       插桩器（src/instrument/）              │
│                                             │
│  acorn.parse() → AST 变换 → astring.generate│
│                                             │
│  注入 J$.R / J$.W / J$.G / J$.P / ...       │
└─────────────────────────────────────────────┘
       │
       ▼
插桩后的 JavaScript 代码
       │
       ▼
┌─────────────────────────────────────────────┐
│       运行时沙盒（src/runtime/）             │
│                                             │
│  J$ = new JalangiSandbox()                  │
│  J$.analysis = AnalysisHost                 │
│                                             │
│  每次执行触发 → 分发给分析插件               │
└─────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│       分析插件（src/plugins/）               │
│                                             │
│  实现 read / write / getField / ... 等钩子   │
│  收集数据、检测 bug、生成报告                 │
└─────────────────────────────────────────────┘
```

## 核心模块

### 插桩器（`src/instrument/`）

| 模块 | 职责 |
|------|------|
| `esnstrument.js` | 主入口，`init()` + `instrumentCode()` 对外 API |
| `astUtil.js` | AST 遍历器与 CONTEXT 上下文枚举 |
| `scope.js` | 词法作用域分析 |
| `iid.js` | IID（Instruction ID）计数器与源码位置映射 |
| `wrappers.js` | AST 节点包装函数库，模板缓存优化 |

**模块依赖关系**：

```
Constants.js
    ↓
iid.js         astUtil.js
    ↓               ↓
    └──── wrappers.js ─── scope.js
                    ↓
            esnstrument.js（主入口）
```

### 运行时（`src/runtime/`）

| 模块 | 职责 |
|------|------|
| `JalangiRuntime.js` | 所有 J$ 钩子函数的核心实现（基类） |
| `JalangiSandbox.js` | 完整沙盒对象，继承 `JalangiRuntime`（推荐使用） |
| `AnalysisHost.js` | 多插件链式调度器，`.use()` 注册分析 |
| `SMemory.js` | Shadow Memory 影子内存服务，为对象关联唯一 ID |
| `analysisCallbackTemplate.js` | 分析插件接口模板（`AnalysisTemplate` 基类） |

## 插桩钩子一览

插桩器将以下 JavaScript 操作替换为对应的 `J$.xxx()` 钩子调用：

| 钩子 | 触发场景 | 对应分析回调 |
|------|---------|-------------|
| `J$.R(iid, name, val, flags)` | 变量读取 | `read` |
| `J$.W(iid, name, val, lhs, flags)` | 变量写入 | `write` |
| `J$.G(iid, base, offset, flags)` | 属性读取 | `getFieldPre` / `getField` |
| `J$.P(iid, base, offset, val, flags)` | 属性写入 | `putFieldPre` / `putField` |
| `J$.F(iid, f, flags)` | 函数调用 | `invokeFunPre` / `invokeFun` |
| `J$.M(iid, base, offset, flags)` | 方法调用 | `invokeFunPre` / `invokeFun` |
| `J$.T(iid, val, type, hasGS)` | 字面量创建 | `literal` |
| `J$.B(iid, op, left, right, flags)` | 二元运算 | `binaryPre` / `binary` |
| `J$.U(iid, op, left)` | 一元运算 | `unaryPre` / `unary` |
| `J$.C(iid, cond)` | 条件判断 | `conditional` |
| `J$.Fe(iid, f, dis, args)` | 函数进入 | `functionEnter` |
| `J$.Fr(iid)` | 函数退出 | `functionExit` |
| `J$.Se(iid, val, origFile)` | 脚本进入 | `scriptEnter` |
| `J$.Sr(iid)` | 脚本退出 | `scriptExit` |
| `J$.N(iid, name, val, flags)` | 变量声明初始化 | `declare` |

## 技术栈

| 依赖 | 用途 |
|------|------|
| `acorn ^8.16` | JavaScript 解析器，支持 ES2022+ |
| `astring ^1.9` | 代码生成器（替代旧版 esotope），支持 ES2022+ |

## 模块系统

本项目使用标准 **ESM**（`"type": "module"` in `package.json`），所有 `src/instrument/` 下的文件均为纯 ESM 模块，支持 `import` / `export`，无全局污染。

## 使用方式

### 1. 纯插桩（不运行）

适合预处理构建管线，或在 Node.js 中以编程方式生成插桩代码：

```js
import { init, instrumentCode } from './src/instrument/esnstrument.js';

const Config = { ENABLE_SAMPLING: false };  // 其余字段 null = 全部插桩
init(Config);

const { code, sourceMapObject } = instrumentCode({
    code:             'var x = 1; console.log(x);',
    origCodeFileName: 'example.js',
    instCodeFileName: 'example_inst.js',
    inlineSourceMap:  true,   // 将 IID→位置 map 内联到输出头部
    sourceType:       'script',
});
```

### 2. 插桩 + 运行时分析

```js
// 1. 初始化沙盒
import { JalangiSandbox } from './src/runtime/JalangiSandbox.js';
const J$ = globalThis.J$ = new JalangiSandbox();

// 2. 注册分析插件
import { MyAnalysis } from './myAnalysis.js';
J$.analysis.use(new MyAnalysis(J$));

// 3. 插桩并执行代码（通常通过 bin/jalangi.mjs）
```

### 3. 命令行工具

```bash
# 插桩单个文件
node bin/instrument.mjs input.js

# 运行分析
node bin/jalangi.mjs --analysis src/plugins/tutorial/LogAll.js target.js

# 为浏览器端插桩
node bin/instrument-for-browser.mjs input.js

# 启动 Trace Server（浏览器端事件收集）
npm run trace-server
```

## 设计亮点

1. **无全局污染**：插桩代码用 IIFE 包裹，沙盒变量名（默认 `J$`，可自定义）通过闭包传入
2. **可选 module 模式**：`sourceType: 'module'` 支持 ESM 插桩（顶层 await）
3. **模板缓存**：`wrappers.js` 中 `replaceInStatement` 对模板 acorn.parse 结果缓存，大幅提升性能
4. **IID 步长 8**：同一 AST 节点的多个子操作共享一段 IID，如方法调用 `iid+2` 为内部 getField
5. **采样模式**：`ENABLE_SAMPLING: true` 时，每个函数在"插桩版本"和"原始版本"之间动态切换
