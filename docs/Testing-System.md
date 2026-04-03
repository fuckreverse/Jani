# DOC-12 · Jani 测试体系文档

> 生成时间：2026-03
> 覆盖版本：refeat-all 分支当前状态

---

## 一、总体概况

Jani 的测试体系由 **12 个测试文件**组成，按"单元测试 → 集成测试"两层划分，均使用 Node.js 内置 `node:test` 框架（ESM，无第三方测试框架依赖）。所有测试集中在 `test/` 目录下：

```
test/
├── fixtures/
│   └── all-syntax.js           # 全语法样例（ES5~ES2022，用于 full-pipeline 集成测试）
├── helpers/
│   └── shared-helpers.mjs      # 公共辅助工具（ALL_CONFIG / instr / runInSandbox / instrAndRun / createSpy）
├── unit/
│   ├── instrument.test.mjs     # 插桩器静态输出单元测试
│   ├── preprocess.test.mjs     # 预处理模块单元测试
│   ├── logging.test.mjs        # 日志系统单元测试（纯内存，无 IO）
│   ├── native-proxy.test.mjs   # NativeProxy 原生方法快照单元测试
│   └── serialize.test.mjs      # serialize() 工具函数单元测试
└── integration/
    ├── runtime.test.mjs        # 运行时框架层集成测试
    ├── e2e.test.mjs            # 端到端动态执行语义测试
    ├── hooks.test.mjs          # 钩子调用验证 + 分析插件集成测试
    ├── logging.test.mjs        # 日志系统集成测试（含真实 IO）
    ├── execution-trace.test.mjs # ExecutionTrace 插件完整功能测试
    ├── dlint.test.mjs          # dlint 规则端到端测试
    └── full-pipeline.test.mjs  # 全流程端到端集成测试（预处理→插桩→执行→后处理工具链）
```

### 运行方式

```bash
# 运行全部测试
npm test

# 只跑单元测试
npm run test:unit

# 只跑集成测试
npm run test:integration

# 只跑日志测试
npm run test:logging
```

---

## 二、各测试文件详解

### 2.1 `test/unit/instrument.test.mjs` — 插桩器静态输出单元测试

**测试策略**：纯静态分析，只调用 `instrumentCode()` 检查输出代码字符串，**不执行**插桩后代码，不依赖运行时（`JalangiSandbox` / `vm`）。执行速度最快，用于快速验证插桩器本身的正确性。

| 测试组 | 测试数量 | 核心验证点 |
|--------|----------|-----------|
| ES5 基础语法 | 5 | `var`、函数声明、`for-in`、`try-catch`；`J$.B/W/Dc/Fi` 注入；`J$_fk{N}` 局部变量替代 `J$._tm_p` 修复 |
| ES6 语法 | 11 | 箭头函数、class（含 getter/setter/继承）、解构、模板字符串、rest/spread、Promise；`J$.T/P/Fe/B/R` 注入 |
| ES2017 async/await | 4 | async 函数结构、`J$.Aw` 包装、await 关键字保留、链式 await 多处注入 |
| ES2019 optional catch binding | 1 | 无参 `catch {}` 不崩溃 |
| ES2020 语法 | 4 | 可选链 `?.`（J$.G）、空值合并 `??`（J$.C + 独立临时变量）、BigInt、逻辑赋值 |
| ES2022 语法 | 6 | class 私有字段、私有方法、私有 getter/setter、static 初始化块、`Array.at()`、`Object.hasOwn()`、顶层 await |
| 复杂解构模式 | 5 | 嵌套数组解构（`J$.T` 包装）、默认值含函数调用、import as 重命名、rest 解构、函数参数解构 |
| 标签模板字符串 | 2 | 标签模板 `J$.Xe` + `J$.R` 插桩、嵌套模板字符串 `J$.T` |
| ESM import/export | 5 | `import`/`export` 语句不被 try-catch 包裹（ES Module 顶层限制）、多 import 顺序保持 |
| IID Source Map | 8 | `sourceMapObject` 格式、`inlineSourceMap`、多文件互不覆盖、`inlineSource` 字段 |
| VLCQ Source Map v3 | 6 | `vlcqSourceMap.version/sources/mappings`、行偏移补偿（script 1行、module 2行）、多行 `;` 分隔符 |
| 跳过插桩 | 1 | `// JALANGI DO NOT INSTRUMENT` 注释防重复插桩 |
| Config 选择性禁用 | 17 | 所有 15 个 `INSTR_*` 字段独立禁用，含 module 模式下的交叉验证 |
| 边界条件 | 8 | 语法错误（含文件名）、空代码、严格模式、`init()` 参数校验、幂等性、`isEval` 模式 |
| BUG 回归测试 | 8 | BUG1（INSTR_BINARY 回调参数类型）、BUG2（ENABLE_SAMPLING 采样）、BUG3（箭头参数作用域）、BUG4（strict arguments）、BUG5（generator yield 不被 while 破坏）、BUG6（async await 不被包裹）、BUG7（脚本异常 re-throw）、BUG8（解构 var 无 undefined 名称） |
| Guard 触发验证 | 5 | `instrumentCode()` 参数校验（非字符串 code、非法 sourceType、null options） |
| 自定义沙盒变量名 | 5 | `jalangiVar` 参数正确替换所有钩子前缀；非法变量名回退到默认 `J$` |
| 按需插桩（pluginAnalyzer）| ~25 | `buildConfigFromHooks`、`fullConfig`、`analyzePluginHooks`（文件路径/实例对象/`static usedHooks`）、`buildConfigFromPlugins` 端到端；按需 Config 实际减少插桩钩子数量 |

### 2.2 `test/unit/preprocess.test.mjs` — 预处理模块单元测试

**测试策略**：每个 Pass 独立隔离测试（通过 `deobOnly()` 关闭其余 Pass），验证 AST 变换的正确性与安全边界。

| 测试组 | 测试数量 | 核心验证点 |
|--------|----------|-----------|
| PreprocessPlugin 基类 | 2 | 未实现 `apply()` 产生 warning、`name/options` 存储 |
| splitSequence（逗号拆分）| 8 | 基础拆分、嵌套收敛、`for` init 提前、`return` 中提前、`if` 条件提前；函数参数/数组内逗号不拆；`while` 条件中的逗号不处理（安全限制）|
| replaceVoid（void 替换）| 6 | `void 0/false/null/''` → `undefined`；有副作用的 `void` 不替换；多处 `void 0` 全部替换 |
| foldConstants（常量折叠）| 14 | 数值/链式/字符串/混合运算；比较/全等；`typeof` 字面量；逻辑 `&&/\|\|` 短路；三元折叠；一元/位运算；含变量不折；`NaN/Infinity` 不折叠 |
| simplifyBoolean（布尔简化）| 4 | `!!x → Boolean(x)`、`!true → false`、`!false → true`；非字面量不处理 |
| expandConditional（三元展开）| 3 | 副作用三元展开为 if-else；赋值中三元/无副作用三元不展开 |
| inlineDeadCode（死代码删除）| 8 | `if(false)` 删除、`if(true)` 保留 then、`while(false)` 删除；安全：`let/const` 保留块包装，`var` 直接展开 |
| flattenIIFE（IIFE 展开）| 9 | 无参无 return 的 function/箭头函数 IIFE 展开；安全限制：含参数/`this`/提前 `return`/`break`/同名 var 冲突不展开；`let/const` 保留块包装 |
| 默认选项与组合 | 4 | 默认 Pass 组合验证；单独关闭指定 Pass |
| TranspilePlugin 语法降级 | 6 | 箭头函数/模板字符串/class/解构 → ES5；`node:current` 不降级；stats 包含 targets |
| preprocessCode() API | 11 | `preset`（deobfuscate/transpile/full/unknown）；`plugins` 优先于 `preset`；语法错误/空代码/注释保留/stats/warnings |
| 预处理→插桩集成 | 3 | 反混淆后代码可正常插桩；死代码删除后 IID 数更少；多行 source map 位置信息正确 |
| 复杂混淆模式综合 | 4 | 逗号+void+常量+死代码组合；嵌套三元折叠；`typeof` 防御代码消除；IIFE+逗号+常量综合 |
| 插件联动与顺序依赖 | 9 | `foldConstants`→`inlineDeadCode` 联动、多步联动、插件顺序影响、`expandConditional`→`inlineDeadCode`、`flattenIIFE`+`foldConstants`、`simplifyBoolean`+`inlineDeadCode`、`preset=full` 顺序、多次运行一致性 |

### 2.3 `test/unit/logging.test.mjs` — 日志系统单元测试

**测试策略**：纯内存测试，无真实文件 IO 或网络，速度极快。

| 测试组 | 测试数量 | 核心验证点 |
|--------|----------|-----------|
| RingBuffer | 7 | push/drain 基本往返、`drain(maxCount)` 限量、自动扩容（不丢弃）、扩容后环形绕回、`shouldFlush` 阈值、`clear`、wrap-around 正确性 |
| EventSerializer | 9 | `EVENT_TYPE` 枚举完整性、`createFileHeader` 魔数验证、`isBinaryTrace` 识别 JTB1、`serializeEvent`/`deserializeEvent` 二进制往返（number/string/null/boolean）、`serializeBatch`/`deserializeAll` 完整批次往返、各事件类型 type/iid/seq 完整性 |
| MemoryBackend | 5 | write/getEvents、`getEventsOfType` 过滤、`flush` noop、`close` 后 write 抛出、`clear` 清空 |
| LogManager | 8 | log 路由到后端、close 后 log 静默丢弃、flush 前不丢失、多后端同时接收、动态 addBackend/removeBackend、close 时 flush 剩余、`getStats`、`drainBatchSize` 分批控制 |
| TraceLogger | 10 | `trace()`/`key()` 写入、`key()` 多级别（info/warn/error）、pre-init 缓冲（init 前写入不丢失）、`_mgr.flush()` 落盘、`close()` 后丢弃、`scheduleFlush()` 异步调度、多次 `init()` 幂等、`nodeFile=false` 降级、trace/key 路由差异 |

### 2.4 `test/unit/native-proxy.test.mjs` — NativeProxy 原生方法快照单元测试

**测试策略**：验证所有导出的原生方法快照正确性，并测试 monkey-patch 防护能力（通过临时修改原型链后验证快照不受影响）。

| 测试组 | 测试数量 | 核心验证点 |
|--------|----------|-----------|
| Array 方法快照 | 8 | `$push`（含 monkey-patch 防护）、`$pop`、`$slice`、`$splice`、`$filter`、`$map`、`$shift`、`$from` |
| Object 方法快照 | 8 | `$assign`、`$keys`、`$values`、`$entries`、`$create`、`$freeze`（ESM 严格模式抛 TypeError）、`$hasOwn`、`$getOwnPropertyNames`、`$defineProperty`（不可写抛 TypeError）、`$getOwnPropertyDescriptor` |
| String 方法快照 | 5 | `$strSlice`（含 monkey-patch 防护）、`$strSplit`、`$strTrim`、`$strIncludes`、`$join` |
| Function 方法快照 | 4 | `$funcApply`、`$funcCall`、`$funcBind`、`$getPrototypeOf` |
| Map/Set/WeakMap/WeakSet 快照 | 10 | `MapGet/Set/Has/Delete`、`SetAdd/Has/Delete`、`WeakMapGet/Set/Has`、`WeakSetAdd/Has` |
| JSON 方法快照 | 4 | `$stringify`（普通/循环引用）、`$parse`、循环引用可控（`replacer` 参数） |
| 递归防护与边界 | 8 | 修改 `Array.prototype` 不影响快照（多个方法测试）、`undefined/null` 边界、`Set.add` 多次添加去重 |

### 2.5 `test/unit/serialize.test.mjs` — serialize() 工具函数单元测试

**测试策略**：对 `src/utils/serialize.js` 的纯函数单元测试，验证各类型的序列化输出格式。

| 测试组 | 覆盖类型 |
|--------|---------|
| 原始类型 | null/undefined/boolean/number/bigint/symbol |
| string | 普通字符串、转义（`\\`/`"`/`\n`/`\r`）、截断（MAX_BYTES）|
| Error | 普通/无 message/子类/超长 message/自定义 name |
| Date/RegExp/Promise | 有效/无效 Date；flags；Promise 占位符 |
| Map/Set | 空/普通/MAX_MAP_ITEMS 截断/MAX_BYTES 截断 |
| Array | 空/基本类型/嵌套/MAX_ARRAY_ITEMS 截断/MAX_BYTES 截断/深度折叠 |
| 普通对象 | 空/单层/key 排序稳定/各属性类型/深度折叠/字节截断 |
| getter 异常降级 | Proxy 拦截 ownKeys 时降级为 toString |
| function | 具名/匿名/箭头/class/内置函数 |
| 嵌套混合结构 | 对象含数组、数组含对象、Map value 为对象、Set 含 Error |
| 边界与回归 | 字符串换行转义、多次调用稳定性、0 falsy 边界、空 key、Object.create(null) |

### 2.6 `test/integration/runtime.test.mjs` — 运行时框架层集成测试

**测试策略**：直接调用运行时 API 验证框架组件隔离行为，以及通过插桩真实程序进行端到端验证。

| 测试组 | 核心验证点 |
|--------|-----------|
| HOOKS 常量 | 非空冻结数组、包含所有预期 15 个钩子名 |
| HookDispatcher 构造 | 所有 hook 方法存在、无插件时返回 undefined |
| use() 注册 | 链式调用、执行顺序、未实现 hook 不触发、重复注册重复调用 |
| 链式值传递 | 最后插件决定返回值、前插件修改后插件看到新值、无返回时传原始值、`args` 替换整体参数 |
| 异常处理 | 插件抛异常 rethrow、异常后不调用后续插件 |
| 实例独立性 | 两个 HookDispatcher 互不影响 |
| SMemory/SMemoryPlugin | 构造、必要 hook 方法、`functionExit` 返回格式、被 `use()` 接受 |
| LogAllAnalysis | 构造、readVar/binary 返回格式、onReady 同步调用 |
| 端到端三层组合 | `HookDispatcher + SMemoryPlugin + LogAllAnalysis` scriptEnter/functionEnter/readVar |
| JalangiSandbox API 边界 | `getOid`/`getObjectVersion`/`getShadowStats`/`newAsyncContext`/`activateContext`/`instrumentEvalEnabled`/`instrumentEvalCode`/`use()` 链式 |
| DataFlowAnalyzer 边界 | `processWrite + backwardSlice`、processRead 不存在变量、多跳链排序、processCallReturn 建立依赖、reset 清空 |
| AntiDetection — Function.toString Hook | `installToStringHook`（幂等）、`registerOriginalCode` 注册后 toString 返回原始代码、未注册函数透传真实体、`uninstallToStringHook` 卸载、非函数类型静默忽略 |
| AntiDetection — 全局泄露检测 | 正常情况无泄露、模拟泄露 `__jalangi2` 被检测 |
| AntiDetection — 异步上下文包装 | 无运行时时透传原回调、有运行时时返回包装函数、包装后激活上下文、`this` 绑定与参数正确传递 |
| AntiDetection — 性能基准 | `benchmarkCallOverhead` 返回 `avgUs`/`acceptable`、空函数调用耗时极小 |
| DataFlowAnalyzer — 复杂场景 | 跨帧数据流传播、`processPutField` 属性写入依赖、大规模链式 slice 性能、独立变量 slice 自身、`processCallReturn` 返回值依赖、循环依赖检测不死循环 |
| **DataFlowAnalyzer 端到端** | 插桩真实代码→收集 writeVar/readVar 日志→喂给 DFA→验证 backwardSlice 结果（简单赋值链、跨函数传播）|
| **SMemory — getShadowObjectOfObject** | 首次调用创建影子对象、同一对象复用、不同对象独立、影子对象属性写入隔离、嵌套对象影子独立性 |
| **SMemory — 影子帧生命周期** | `initialize` 向当前帧注册变量、`functionEnter/Return` 帧入栈出栈、`scriptEnter/Return` 脚本级帧管理、帧切换后变量隔离 |
| **SMemory — 影子对象与函数** | 函数对象可关联影子对象、`getShadowObjectOfFunction` 正确返回、函数调用后影子状态保持 |

### 2.7 `test/integration/e2e.test.mjs` — 端到端动态执行语义测试

**测试策略**：通过"插桩 + `vm` 沙盒执行"，验证插桩前后程序语义完全一致（结果正确性）。是整个测试体系中覆盖最广、测试用例最多的文件。

| 测试组 | 核心验证点 |
|--------|-----------|
| 基础语义 | var/算术/字符串/函数调用/递归/对象属性/数组操作 |
| ES6+ 语义 | 箭头函数/class 实例化与继承/try-catch/for-in/解构（对象、数组、嵌套、带默认值、函数参数解构）/模板字符串/switch/rest/for-of（数组、字符串、Map） |
| ES2020 运算符 | 可选链 `?.` + 空值合并 `??`；逻辑赋值 `&&=/||=/??=` |
| async/await 语义 | Promise.resolve 基本语义、await 透传 resolved value、`awaitResume` 钩子（iid/contextId/val）、多次 async 调用 contextId 独立、`INSTR_AWAIT=()=>false` 禁用后语义正确 |
| 闭包 Shadow Frame（7种） | 基础计数器、工厂多实例、嵌套三层闭包、闭包写回外层、递归闭包、回调闭包、IIFE 闭包 |
| Generator 运行时语义 | `next()` 逐步 yield、`next(value)` 注入值、`return()` 提前终止、for-of 消费、闭包变量保持 |
| Promise 并发 | `Promise.all` 多任务 contextId 独立、聚合结果语义、`Promise.race` 胜出语义、reject fast-fail 语义 |
| ES2022 class 私有字段与继承 | `#n++` 语义、私有字段读取、`super()` 调用语义、`new.target.name`、static method |
| Symbol.iterator 自定义迭代协议 | computed key `[Symbol.iterator]` for-of 结果、状态闭包累积 |
| 插桩语义边界（Bug 回归） | spread/嵌套解构/前置++/后置++/delete+in/instanceof/Object.freeze(fn)/多层 for-in 不污染/observeOnly/callHook 保护/Config 禁用/const-let TDZ 修复/块内函数声明（blockDefun）/命名函数表达式（lambda） |
| ExecutionTraceAnalysis | writeVar trace 显示真实源码片段、多行 loc 坐标、inlineSource:false 降级占位符、逗号表达式 trace 合并、属性读写追踪 |

### 2.8 `test/integration/hooks.test.mjs` — 钩子调用验证 + 分析插件集成测试

**测试策略**：通过 `createSpy()` 工厂构建观察插件，验证钩子参数的正确性；通过分析插件修改/拦截运行时行为，验证框架的可扩展性。

| 测试组 | 核心验证点 |
|--------|-----------|
| Spy 钩子参数验证 | write（变量名/val）、read（变量名/val）、binary（op/操作数/result）、getField（base/offset/val）、putField（offset/val）、functionEnter/functionExit 触发、call 记录结果、literal 对象字面量、conditional 三元、scriptEnter/scriptExit 各一次、forIn（被枚举对象）、unary（op/参数/result）、declare（isArgument/argumentIndex）、returnStmt（val） |
| 端到端分析插件 | binary 结果修改、write 结果修改（污点模拟）、getField 重写、putFieldPre 前置修改写入值、putField 后置观察、多插件链式顺序、NaN 检测插件、callPre skip 跳过函数、_throw 观测异常、iidToLocation 解析位置 |
| observeOnly 模式 | `observeOnly=false` 默认可修改值、`=true` 返回值被忽略、钩子仍被调用、write/callPre skip/getField/多插件链 + 链式传值均被阻断；`HookDispatcher` 直接实例化 |
| instrumentEval 选项 | 默认不插桩 eval（直透）、不触发 `instrumentCodePre`、`=true` 标志设置与真实插桩函数注入、运行时切换 `instrumentEvalEnabled`、new Function 默认不插桩 |
| 框架层语义保证（L2 修复） | observeOnly 下 isBacktrack=true 被忽略（不死循环）、WeakMap 替代属性（freeze 兼容）、函数 ownPropertyNames 不含 J$ 属性、Reflect.construct newTarget 修复（instanceof 正确） |

### 2.9 `test/integration/logging.test.mjs` — 日志系统集成测试

**测试策略**：含真实 IO 测试，在系统临时目录写 `.bin` 文件并读回验证，使用 `isBinaryTrace` 检查 JTB1 魔数、`deserializeAll` 验证事件完整性；以及启动 mock WebSocket 服务器做端到端回路测试。

| 测试组 | 核心验证点 |
|--------|-----------|
| NodeStreamBackend | JTB1 二进制格式写文件读回（`isBinaryTrace` 验证魔数 + `deserializeAll` 反序列化）、多批次写入（5 条事件 iid 顺序正确）、`writeSync`（beforeclose 尽力写）、与 LogManager 集成（10 条事件） |
| NodeStreamBackend smap | `setSmap` 注入 smap → `close()` 自动写出 `.smap.json`，内容可读回验证 |
| WsBackend + trace-server 回路 | 成功连接并发送批次收到 ack（JTB1 二进制格式，batchId 从 1 开始）、与 LogManager 集成 9 条事件分 3 批、JTB1 多种事件类型批次正确发送并可 `deserializeAll` 反序列化验证 |

### 2.10 `test/integration/execution-trace.test.mjs` — ExecutionTrace 插件完整功能测试

**测试策略**：通过插桩 + `vm` 沙盒执行 + `TraceLogger`（内存后端），验证 `ExecutionTraceAnalysis` 的输出格式、API 行为和各种场景下的追踪正确性。包含 Formatter 单元测试和端到端格式验证。

| 测试组 | 测试数量 | 核心验证点 |
|--------|----------|-----------|
| 基本功能（FORMAT_FLAT） | 5 | scriptEnter/scriptExit 事件、变量写入追踪 `x=10`、函数调用 CALL/RETN、returnStmt 追踪、throwStmt 追踪 |
| 属性访问追踪 | 2 | `getField` 追踪 `obj.prop`、`putField` 追踪属性写入 |
| 异步根帧 | 2 | scriptExit 后调用函数推入异步根帧、flush 手动刷新异步帧缓冲行 |
| 手动控制 API | 3 | `_mgr.flush()` 强制落盘不关闭、`close()` flush 后丢弃后续写入、`onReady()` 回调时机 |
| endExpression 聚合 | 2 | write+read 聚合到同一行、纯副作用语句输出源码位置 |
| 源码片段提取 | 2 | `inlineSource=true` 显示真实源码、多行语句截取首行 |
| 复杂场景 | 3 | 递归函数多层调用栈追踪、闭包变量追踪、try-catch 异常追踪 |
| 性能与规模 | 2 | 深度嵌套 100 层函数调用、500 次循环 |
| 边界条件 | 3 | 空脚本、只有注释、无 sourceCode 时降级到 iid 显示、已初始化 TraceLogger 传入 |
| **createFormatter 工厂** | 4 | FORMAT_TREE 返回 TreeFormatter、FORMAT_BLOCK 返回 BlockFormatter、FORMAT_PIPE 返回 PipeFormatter、FORMAT_FLAT 返回 FlatFormatter |
| **TreeFormatter 单元测试** | 4 | writeLine 格式（含 `←`）、readLine 格式（含 `→`）、callLine 格式（含 `┬`）、returnLine 格式（含 `└`）|
| **BlockFormatter 单元测试** | 4 | writeLine 格式（含 `WRITE`）、readLine 格式（含 `READ`）、callLine 格式（含 `#region`）、returnLine 格式（含 `#endregion`）|
| **PipeFormatter 单元测试** | 4 | writeLine 格式（含 `WRITE`）、readLine 格式（含 `READ`）、callLine 格式（含 `|`）、returnLine 格式（含 `RETN`）|
| **FORMAT_TREE 端到端** | 2 | 函数调用/返回行包含 `┬/└` 符号、嵌套调用包含多个 `│` 缩进 |
| **FORMAT_BLOCK 端到端** | 2 | 函数调用行包含 `#region`、返回行包含 `#endregion`、嵌套调用 region 正确嵌套 |
| **FORMAT_PIPE 端到端** | 2 | 函数调用时有 `|` 符号、返回时有 `RETN`、嵌套时有多个 `|` |

### 2.11 `test/integration/dlint.test.mjs` — dlint 规则端到端测试

**测试策略**：为每条 dlint 规则编写真实触发测试，通过插桩 + `vm` 执行后检查规则的违规计数，验证规则的实际检测能力。

| 测试组 | 测试数量 | 核心验证点 |
|--------|----------|-----------|
| CheckNaN | 4 | `NaN === x` 触发警告、正常比较不触发、多次运算累计计数、规则实例独立 |
| CompareFunctionWithPrimitives | 4 | 函数与数字比较触发、函数与函数比较不触发、多次触发计数、实例独立 |
| ConcatUndefinedToString | 4 | `undefined + "str"` 触发、正常字符串拼接不触发、多次触发、实例独立 |
| FunCalledWithMoreArguments | 4 | 实参多于形参触发、参数匹配不触发、多次触发累计、实例独立 |
| ShadowProtoProperty | 4 | 对象属性遮蔽原型属性触发、无遮蔽不触发、多次遮蔽计数、实例独立 |
| UndefinedOffset | 4 | 用 `undefined` 作属性键触发、正常属性键不触发、多次触发计数、实例独立 |
| 综合规则联用 | 4 | 同一代码段触发多条不同规则、规则互不干扰、复合场景多规则 |

### 2.12 `test/integration/full-pipeline.test.mjs` — 全流程端到端集成测试

**测试策略**：以 `test/fixtures/all-syntax.js`（覆盖 ES5~ES2022 全部语法的综合样例）为输入，完整执行"预处理 → CLI 插桩 → API 插桩 + vm 执行 → 后处理工具链"全流程，并验证每一步的中间产物格式和语义正确性。当前仅覆盖 Node.js 后端。

**关键设计**：
- Step 3 通过 API（`init` + `instrumentCode` + `JalangiSandbox` + `TraceLogger`）在当前进程内完成插桩与执行，保证 trace.bin 稳定写出；
- `vm.createContext` 不注入 `Array/Object` 等内置构造函数，避免跨 context 的 `instanceof` 失败；
- API 生成的 `smap` 与 CLI 生成的 `smap` iid 独立，各自保存以供后续 `--smap` 注入使用。

| 测试步骤（Step）| 测试数量 | 核心验证点 |
|----------------|----------|-----------|
| Step 0: 前置条件 | 3 | 样例文件含所有关键语法节点、`jalangi --help` exit 0、后处理工具文件存在 |
| Step 1: 预处理 | 2 | `preprocessCode` API 成功运行写出文件、预处理后保留关键结构且不含插桩钩子 |
| Step 2: CLI 插桩 | 4 | `jalangi instrument` exit 0、插桩文件含 `J$.` 和防重插桩标记、`smap.json` 含数字 IID 键和 `[sl,sc,el,ec]` 数组、`node --check` 语法检查通过 |
| Step 3: API 插桩 + vm 执行 | 2 | 语义正确性全量验证（**51 个断言**，覆盖 ES5~ES2022 各特性）、trace.bin JTB1 魔数与规模验证 |
| Step 4: trace-decode | 6 | 解码 NDJSON exit 0、事件条数与类型（含 FUNCTION_EXIT）、`--smap` 注入行号、`--stats` total 与行数一致 |
| Step 5: trace-render | 7 | flat/tree/pipe/block 四种格式 exit 0 且有内容、行数数量级一致（允许 3×+100 差异）、block 含 `#region` |
| Step 6: trace-filter | 4 | `--type CALL_PRE` 过滤纯净、`--has-call` 与 `--type CALL_PRE` 条数一致、`--fn fact` ≥5 次递归调用、`--seq` 范围过滤后事件数减少且 seq 合规 |
| Step 7: trace-hot-lines | 3 | 统计有输出、`--top 5` 行数不超过全量+5、`--by-type` exit 0 |
| Step 8: trace-call-tree | 4 | 文本格式 exit 0 且含内容、`--json` 输出可解析为合法 JSON、调用树含样例函数名、`--depth 2` exit 0 |
| Step 9: 完整管道连通性 | 5 | decode\|filter\|render 三段管道 exit 0、fact 调用树管道、seq 严格单调递增（跳过元数据事件）、CALL_PRE/CALL 数量级一致、FUNCTION_ENTER > 0 |
| Step 10: 插桩配置变体 | 6 | `--inline-iid` 内联 iid map、`--no-source-map` 不产生 `.map.json`、`--dry-run` 不写文件、`--random-var` 使用 `__jal_` 前缀、`--split-runtime` 生成 `.runtime.mjs`、`--vlcq-source-map` 产生标准 Source Map v3 |
| Step 11: 边缘案例与容错 | 5 | 无效魔数文件非零退出并报错、`--pretty` 输出含换行、`SCRIPT_ENTER` 有 iid 正整数、`--no-internal` 过滤后行数不超原始、`instrument-and-run --no-write` 处理简单脚本 exit 0 |

---

## 三、测试基础设施

### 3.1 `test/helpers/shared-helpers.mjs`

所有测试文件共享的工具层，避免重复代码：

| 导出 | 说明 |
|------|------|
| `ALL_CONFIG` | 全量 Config 常量（所有 `INSTR_*` 均为 `null`，`ENABLE_SAMPLING: false`） |
| `instr(code, opts)` | 快捷 script 模式插桩，返回 `instrumentCode()` 结果 |
| `runInSandbox(code, J$, extra, timeout)` | 在 `vm.createContext()` 隔离沙盒中执行插桩代码；注入最小必要全局量（无 `process/require`）；默认 2s 超时 |
| `instrAndRun(code, extra)` | 一步完成插桩+执行，预注入 `$out={}`，返回 `{ out, vars, J$, sandbox }` |
| `createSpy(...hookNames)` | 创建 Spy 插件，返回 `{ plugin, calls: Map<string, Array[]> }` |

### 3.2 测试框架说明

- **测试框架**：Node.js 内置 `node:test`（`describe/test/before/after`），无第三方依赖
- **断言库**：`node:assert/strict`（严格相等断言）
- **异步支持**：集成测试中直接使用 `async test()`，`await` 异步操作
- **隔离机制**：每个 `describe` 通过 `before/after` 钩子恢复全局 Config，防止测试间污染
- **vm 沙盒**：`runInSandbox` 使用 `vm.createContext` 提供严格隔离，防止插桩代码逃逸到宿主进程

---

## 四、当前覆盖薄弱点与后续 TODO

### 4.1 运行时核心模块（`src/runtime/`）

| 模块 | 现状 | 建议补充 |
|------|------|---------|
| `JalangiRuntime.js`（基类）| 通过 `JalangiSandbox` 间接覆盖，无直接测试 | 补充 `JalangiRuntime` 低层钩子方法（`R/W/G/P/B/U/T/F/M/Fe/Fx/Se/Sr`）的参数和返回值验证 |
| `SMemory.js`（Shadow Memory）| **已完整覆盖**：构造、hook 方法、`getShadowObjectOfObject`、影子对象创建/关联、影子帧生命周期（`functionEnter/Return`、`scriptEnter/Return`）| — |
| `DataFlowAnalyzer.js` | **已完整覆盖**：边界测试 + 复杂场景（跨帧传播、putField、callReturn、循环依赖）+ **端到端真实程序 backward slice** | — |
| `AntiDetection.js` | toString Hook、全局泄露检测、异步上下文包装、性能基准均已覆盖 | 补充：`installToStringHook` 在并发场景下的安全性 |
| `NativeProxy.js` | 所有主要原生方法快照均已覆盖（含 monkey-patch 防护）| — |
| `HookDispatcher.js` | 链式传值、observeOnly 已覆盖 | 补充：`setContext` 上下文切换钩子、`endExecution` 触发时机 |

### 4.2 插桩器边界（`src/instrument/`）

| 方向 | 建议 |
|------|------|
| 更多 ES2022+ 语法 | `using` 关键字（明确资源管理）、`Error.cause`、`at()` 用于 string/TypedArray |
| 大型脚本性能 | 万行级代码的插桩耗时基准测试（目前无性能基准） |
| IID 步长验证 | 明确验证 IID 步长为 8，同一节点多操作的 iid 偏移关系 |
| sourceType 混用 | 同一 init() 实例先 script 后 module 的 Config 隔离性 |

### 4.3 预处理模块（`src/preprocess/`）

| 方向 | 建议 |
|------|------|
| `flattenIIFE` 更多场景 | 多层嵌套 IIFE、Arrow + return 值（目前只测 void）、立即调用箭头函数有返回值的拦截 |
| `foldConstants` 负数折叠 | `-5 + 3` → `-2`；混合正负数链式折叠 |
| `splitSequence` 边界 | `do-while` 条件、`switch` 中的逗号、逗号嵌套在赋值右侧 |
| 自定义插件 | 用户继承 `PreprocessPlugin` 并覆写 `apply()` 的端到端流程 |
| `sourceMap` 保留 | 预处理后 VLCQ source map 位置信息的正确性 |

### 4.4 日志系统（`src/logger/`、`src/encoding/`）

| 模块 | 现状 | 建议补充 |
|------|------|---------|
| `TraceLogger.js` | `trace/key`路由、pre-init 缓冲、flush/close、scheduleFlush、幂等 init 均已覆盖 | 补充：`isDebugEnabled` 域控制、`setSmap` 透传到 `NodeStreamBackend` |
| `LogManager.js` 背压 | 只测了 `drainBatchSize`，无背压 reject 测试 | 补充：写满时的阻塞/丢弃行为 |
| `NodeStreamBackend` | JTB1 二进制写入（魔数验证 + 反序列化）、多批次、writeSync、LogManager 集成、setSmap 写出 `.smap.json` 均已覆盖 | 补充：背压（大 batch 阻塞 drain 事件）、autoFlush=true 路径 |
| `WsWorkerBackend.js` / `WsSabBackend.js` | **完全未覆盖** | 需要 Worker 环境；建议补充 mock Worker 的单元测试 |
| `IdbWorkerBackend.js` | **完全未覆盖** | 需要 IndexedDB 环境（浏览器）；暂缓 |
| `EventSerializer` 边界 | 已覆盖：JTB1 魔数、serializeEvent/serializeBatch/deserializeAll 往返（常见值类型）、isBinaryTrace、VALUE_TYPE.OMITTED（省略值） | 补充：超长字符串截断、非 ASCII 字符（CJK）、FLOAT64 精度保持、负数 iid |
| `WsBackend` 重连/断线 | 未覆盖 | 补充：连接中断后的重试行为、窗口满时的背压 |

### 4.5 端到端分析插件（`src/plugins/`）

| 插件 | 现状 | 建议补充 |
|------|------|---------|
| `ExecutionTrace.js` | **已完整覆盖**：基本功能、属性追踪、手动 API、复杂场景、性能 + **FORMAT_TREE/FORMAT_BLOCK/FORMAT_PIPE 输出格式验证（单元测试 + 端到端）** | — |
| `dlint/*`（6 条规则）| CheckNaN/CompareFunctionWithPrimitives/ConcatUndefinedToString/FunCalledWithMoreArguments/ShadowProtoProperty/UndefinedOffset 均已覆盖 | 补充：更多边界规则（如无限循环检测等） |
| `tutorial/LogAll.js` | runtime.test.mjs 中验证返回格式 | 补充：完整端到端 LogAll 输出验证 |
| `DataFlowAnalysis`（运行时）| **已完整覆盖**：边界 API 测试 + **真实程序端到端 backward slice 验证** | — |

### 4.6 测试质量与工程化

| 方向 | 建议 |
|------|------|
| **性能基准** | 目前无任何性能测试，建议为插桩器和 LogManager 添加基准测试（`node:test` 支持自定义 reporter）|
| **错误消息质量** | 部分 `assert.ok()` 失败时消息不够清晰，建议统一改为带描述的断言 |
| **vm 超时覆盖** | `instrAndRun` 默认 2s，对于复杂异步用例可能不够；建议为 async 测试单独设置更长超时 |
| **浏览器环境** | 当前测试全部在 Node.js 下运行，插桩器声称支持浏览器，但无浏览器端自动化测试（Playwright/Puppeteer）|
| **测试数据驱动** | ES 语法覆盖测试（instrument.test.mjs）存在大量重复结构，可考虑 `test.each()` 表格驱动 |
| **覆盖率报告** | 目前未配置 `c8`/`istanbul` 等覆盖率工具，建议添加并设置最低覆盖率门槛 |

---

## 五、测试数量汇总

| 文件 | 类型 | 约测试数 |
|------|------|---------|
| `unit/instrument.test.mjs` | 单元 | ~115 |
| `unit/preprocess.test.mjs` | 单元 | ~79 |
| `unit/logging.test.mjs` | 单元 | ~39 |
| `unit/native-proxy.test.mjs` | 单元 | ~57 |
| `unit/serialize.test.mjs` | 单元 | ~45 |
| `integration/runtime.test.mjs` | 集成 | ~70 |
| `integration/e2e.test.mjs` | 集成/端到端 | ~70 |
| `integration/hooks.test.mjs` | 集成 | ~40 |
| `integration/logging.test.mjs` | 集成（IO）| ~8 |
| `integration/execution-trace.test.mjs` | 集成 | ~40 |
| `integration/dlint.test.mjs` | 集成 | ~33 |
| `integration/full-pipeline.test.mjs` | 集成/全流程 | ~51 |
| **合计** | | **~507** |
