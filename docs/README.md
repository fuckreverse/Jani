# Jani 文档

Jani 是一个面向 JavaScript 的**动态分析框架**，通过 AST 插桩在运行时收集程序行为数据，
支持 bug 检测、覆盖率统计、污点分析等多种动态分析场景。

## 文档目录

| 文档 | 内容简介 |
|------|---------|
| [Overview.md](./Overview.md) | 项目概况、系统架构、快速上手 |
| [Instrumentation-Engine.md](./Instrumentation-Engine.md) | 插桩器核心原理与 API 参考 |
| [Preprocessing.md](./Preprocessing.md) | 预处理模块（反混淆 + 语法降级）|
| [Runtime-System.md](./Runtime-System.md) | 运行时沙盒、J$ 对象与钩子函数 |
| [Analysis-Development.md](./Analysis-Development.md) | 编写自定义分析插件的完整指南 |
| [Configuration.md](./Configuration.md) | Config 配置字段参考 |
| [Analysis-Plugins.md](./Analysis-Plugins.md) | 分析插件介绍（tutorial / dlint / coverage / dsjs 等）|
| [Scope-Aware-Instrumentation.md](./Scope-Aware-Instrumentation.md) | 作用域感知插桩技术设计文档 |
| [Offline-Analysis-Tools.md](./Offline-Analysis-Tools.md) | `tools/` 离线分析工具集（trace-parse / filter / hot-lines / call-tree 等）|

## 快速开始

### 安装依赖

```bash
npm install
```

### 运行测试

```bash
npm test
# 或
node test/instrument.test.mjs
```

### 以编程方式插桩

```js
import { init, instrumentCode } from './src/instrument/esnstrument.js';

const Config = {
    INSTR_READ: null, INSTR_WRITE: null, INSTR_GETFIELD: null, INSTR_PUTFIELD: null,
    INSTR_BINARY: null, INSTR_UNARY: null, INSTR_LITERAL: null, INSTR_INIT: null,
    INSTR_CONDITIONAL: null, INSTR_TRY_CATCH_ARGUMENTS: null, INSTR_END_EXPRESSION: null,
    INSTR_INVOKE: null, INSTR_RETURN: null, INSTR_THROW: null, INSTR_FORIN: null,
    INSTR_AWAIT: null, INSTR_PROPERTY_BINARY_ASSIGNMENT: null,
    ENABLE_SAMPLING: false,
};
init(Config);

const result = instrumentCode({
    code: 'var x = 1 + 2;',
    origCodeFileName: 'example.js',
    instCodeFileName: 'example_inst.js',
    inlineSourceMap: false,
    sourceType: 'script',
});
console.log(result.code);
```

### 自动推导 Config（推荐）

```js
import { init, instrumentCode } from './src/instrument/esnstrument.js';

// 不传 config，改传 plugins：自动静态分析插件所用 Hook，生成最小化 Config
init(null, undefined, undefined, undefined, ['./src/plugins/dlint/CheckNaN.js']);

const result = instrumentCode({
    code: 'var x = 1 + 2;',
    origCodeFileName: 'example.js',
    instCodeFileName: 'example_inst.js',
});
console.log(result.code);
```

## 目录结构概览

```
src/
  types.d.ts           ← 共享基础类型声明（JalangiConfig、IAnalysisPlugin、LogEntry 等）
  instrument/          ← 插桩器核心（纯 ESM，无平台依赖）
    esnstrument.js     ← 主入口：init() + instrumentCode()
    astUtil.js         ← AST 遍历与上下文枚举（CONTEXT）
    scope.js           ← 词法作用域分析（Scope 类，ScopeID）
    iid.js             ← IID 计数器与源码位置映射
    wrappers.js        ← AST 节点包装函数库（模板缓存优化）
    dataflow.js        ← 静态 SSA def-use 分析（Pass 0，决策表）
    pluginAnalyzer.js  ← 插件静态分析器（按需 Config 推导）
    instrument.d.ts    ← 插桩器公开 API 类型声明
  preprocess/          ← 预处理模块（反混淆 + 语法降级）
    PreprocessPlugin.js← 插件基类
    index.js           ← 主入口：preprocessCode(code, options)
    plugins/
      DeobfuscatePlugin.js ← 反混淆（逗号拆分/void替换/常量折叠/死代码删除等）
      TranspilePlugin.js   ← 语法降级（@babel/preset-env 包装）
  runtime/             ← 运行时系统（含 Node.js 专有代码）
    JalangiRuntime.js  ← 运行时钩子实现（基类）
    JalangiSandbox.js  ← 完整沙盒对象（推荐使用）
    HookDispatcher.js    ← 多插件链式调度器
    SMemory.js         ← Shadow Memory 影子内存服务
    analysisCallbackTemplate.js ← 分析插件接口模板
    DataFlowAnalyzer.js         ← 运行时 SSA 数据流分析器
    AntiDetection.js            ← 反插桩对抗工具
    NativeProxy.js              ← 原生方法快照（防 monkey-patch 递归栈溢出）
    runtime.d.ts       ← 运行时公开 API 类型声明
  logger/              ← 统一日志系统（instrument + runtime 共用）
    logger.js          ← createLogger(domain) 工厂 + DOMAIN 常量 + debug 开关
    LogManager.js      ← 日志管理器，协调 RingBuffer 与后端
    TraceLogger.js     ← trace 事件门面（高频走缓冲，key 事件直输出）
    RingBuffer.js      ← 环形缓冲区（无锁暂存）
    EventSerializer.js ← 事件序列化器
    backends/
      MemoryBackend.js
      NodeStreamBackend.js
      WsBackend.js
      IdbWorkerBackend.js
    workers/
      idb-worker.js    ← IndexedDB Worker（Blob URL 内联）
  plugins/             ← 示例分析插件
  Constants.js         ← 全局常量
test/
  unit/
    instrument.test.mjs  ← 插桩器端到端集成测试（312 个用例）
    preprocess.test.mjs  ← 预处理模块单元测试（78 个用例）
  integration/           ← 运行时集成测试
docs/                  ← 项目文档
bin/
  jalangi.mjs          ← 插桩/运行 CLI 统一入口
  preprocess.mjs       ← 预处理 CLI 工具
```
