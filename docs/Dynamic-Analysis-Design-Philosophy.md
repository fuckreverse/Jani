# DOC-13 · 现代 JavaScript 动态分析框架设计哲学与核心概念

在构建高性能的动态分析工具（如 Jalangi2 的演进版本）时，业界逐渐形成了一套成熟的设计哲学和专有概念。本文档总结了这些核心思路，旨在为后续的架构重构提供理论基础。

## 一、 核心设计哲学 (Core Design Philosophies)

### 1. 轻运行时，重后处理 (Lightweight Runtime, Heavy Post-processing)
*   **理念**：目标程序在执行时（运行时）应当尽可能少地做计算。运行时只负责“无脑”地记录最基础的事件流，所有复杂的逻辑（如构建调用栈、分析数据流、检测内存泄漏、生成覆盖率报告）全部推迟到离线的后处理阶段（Post-processing）。
*   **目的**：极大地降低 **Overhead（运行时开销）**，避免因为插桩代码执行过慢而导致目标程序超时，或者因为改变了异步事件的时序而引发 **Heisenbug（海森堡 Bug，指在观察时就会消失或改变行为的 Bug）**。

### 2. 混合分析 (Hybrid Analysis: Static + Dynamic)
*   **理念**：纯动态分析开销太大，纯静态分析准确率太低（尤其在 JS 这种高度动态的语言中）。现代工具倾向于在插桩阶段（静态）尽可能多地提取信息（如 AST 结构、变量作用域、Use-Def 关系），并生成静态元数据文件。运行时（动态）只记录静态分析无法确定的信息（如分支走向、实际的变量值）。
*   **目的**：通过静态信息辅助，大幅减少运行时需要记录的数据量。

### 3. 无状态化运行时 (Stateless Runtime)
*   **理念**：运行时的 Hook 函数（如 `J$.R`, `J$.W`）内部不维护复杂的全局状态（如当前在哪个函数内、变量的历史值是什么）。它仅仅作为一个 **Event Emitter（事件发射器）**，触发后立刻将数据写入缓冲区。
*   **目的**：减少运行时的内存占用（避免 OOM）和垃圾回收（GC）压力。

### 4. 确定性推导 (Deterministic Deduction)
*   **理念**：如果一个状态可以通过“初始状态 + 确定的操作序列”推导出来，那么就不需要在日志中记录这个状态。例如，如果记录了所有的写操作（Write）和控制流分支（Branch），那么很多读操作（Read）的值就可以在后处理时被完美推导出来。

---

## 二、 关键技术名词解析 (Key Technical Terms)

### 1. Hydrate (注水还原)
*   **概念**：前端框架（如 React/Vue）中常指将服务端渲染的静态 HTML 附加上动态交互能力。在动态分析中，它指的是**“静态元数据 + 动态极简日志 = 完整执行上下文”**的过程。
*   **应用**：运行时日志里只有 `[Event: Read, IID: 1024]`。后处理工具读取日志时，查阅静态元数据文件，发现 `IID: 1024` 对应 `src/app.js` 的第 10 行，操作是读取变量 `user`。这个将干瘪的 ID 还原为丰富上下文的过程就是 Hydrate。

### 2. Use-Def Chain (使用-定义链)
*   **概念**：编译原理和静态数据流分析中的经典概念。它记录了程序中某个变量的“定义（赋值）”位置和所有“使用（读取）”位置之间的映射关系。
*   **应用**：如果在插桩时静态建立了 Use-Def 链，后处理时只要看到某个变量被使用，就能直接追溯到它最近一次被定义的地方，从而知道它的值，而无需在运行时记录这次读取的值。

### 3. Phi Node ($\phi$ 节点)
*   **概念**：来源于 **SSA (Static Single Assignment, 静态单赋值)** 形式。当程序的控制流发生分支（如 `if-else`）并再次汇聚时，如果两个分支都对同一个变量赋了值，编译器会插入一个虚拟的 $\phi$ 节点来决定最终采用哪个分支的值。
*   **应用**：在优化 Trace 体积时，普通的读操作可以不记录值（通过 Use-Def 追溯），但当遇到 $\phi$ 节点（即变量的值取决于运行时走了哪个分支，存在不确定性）时，就必须在日志中记录实际的值或记录控制流走向。

### 4. Value Pool / Dictionary Compression (值池 / 字典压缩)
*   **概念**：一种数据压缩策略。在运行时，程序可能会成千上万次地读取同一个长字符串或同一个对象引用。
*   **应用**：在内存中维护一个字典（Map）。第一次遇到字符串 `"hello_world_long_string"` 时，分配一个短 ID（如 `1`），并在日志中记录 `[NewString, ID: 1, Value: "hello..."]`。后续再遇到这个字符串，日志中只记录 `[Ref, ID: 1]`。这能将 Trace 体积缩小几个数量级。

### 5. Binary Protocol (二进制协议)
*   **概念**：放弃 JSON 等文本格式，使用紧凑的二进制字节流（如基于 `ArrayBuffer` 和 `DataView`）来记录日志。
*   **应用**：JSON 包含大量冗余字符（`"`, `:`, `{`, `}`），且序列化耗费 CPU。二进制格式（如 `[1 byte 类型][4 bytes IID][N bytes 负载]`）不仅体积小，而且在 C++/Rust 编写的后处理工具中解析速度极快。

---

## 三、 运行时安全与稳定性设计 (Runtime Safety Design)

### 1. Native Snapshot（原生方法快照）—— 最早时机捕获，最晚时机使用

*   **问题根源（你遇到的那个 Bug）**：动态分析框架在运行时内部也需要调用 `Array.prototype.push`、`Map.prototype.set` 等内置方法来维护自己的数据结构（比如调用栈、事件队列）。但被分析的目标代码可能对这些方法做了 **Monkey-Patch（猴子补丁）**，将原方法替换成了插桩后的版本。当分析框架调用 `arr.push(x)` 时，实际上触发了插桩的钩子 `J$.M(..., "push", ...)`，而这个钩子又调用了分析框架内部的方法，于是形成**无限递归（Infinite Recursion）**，最终栈溢出（Stack Overflow）。

*   **解决方案 —— Native Snapshot（原生快照）**：在整个分析框架的模块加载阶段（ES Module 的顶层作用域），在任何用户代码有机会运行之前，立即捕获所有需要用到的原生方法的引用并存入私有变量：
    ```js
    // 在模块顶层（只执行一次）
    const _arrPush = Array.prototype.push;
    const _mapSet  = Map.prototype.set;
    // 后续所有内部调用都走快照，绕过原型链
    export const $push = (arr, ...items) => _arrPush.apply(arr, items);
    ```
    此后，运行时内部所有的内置方法调用都通过这个快照进行，**彻底与目标代码的原型链污染隔离**。

*   **推论设计原则 —— "框架代码必须在目标代码之前加载"**：这意味着在设计加载顺序时，分析框架（`NativeProxy.js`、`JalangiRuntime.js` 等）必须作为 ES Module 被最先 `import`，确保快照在目标代码运行前已经固化。

*   **延伸：JALANGI DO NOT INSTRUMENT 哨兵**：框架代码本身不应被自己插桩。在每个运行时文件头部加注释 `// JALANGI DO NOT INSTRUMENT`，插桩器在处理时跳过这些文件，防止"自我插桩引发递归"。

### 2. Reentrancy Guard（重入保护）

*   **问题**：当钩子函数本身执行时（比如 `readVar` 钩子在把数据写入日志时），这段写入操作也会触发 `getField`/`putField` 等钩子，再次进入分析框架，形成递归。
*   **解决方案**：在每个 Hook 的入口处检查一个 **Reentrancy Flag（重入标志）**。若已在钩子执行中，则立即返回（或切换到轻量路径），不再递归触发。
    ```js
    let _inHook = false;
    function readVar(iid, name, val) {
        if (_inHook) return { result: val }; // 重入保护
        _inHook = true;
        try { /* 分析逻辑 */ }
        finally { _inHook = false; }
    }
    ```
*   **推论**：分析框架应尽可能不产生任何会被插桩的代码路径（如调用用户定义的函数），否则重入保护的范围会越来越难控制。

### 3. Transparent Instrumentation（透明插桩）

*   **核心思想**：一个设计良好的动态分析框架对目标程序应当"完全透明"，即插桩框架的存在不应改变目标程序的**任何可观察行为**（除了执行速度变慢）。
*   **包含以下子目标**：
    1. **语义不变性（Semantic Transparency）**：目标程序的计算结果、副作用、输出不变。
    2. **身份不变性（Identity Transparency）**：`fn.toString()` 返回的应是原始代码，而非插桩后的代码。
    3. **全局不可见性（Global Transparency）**：`typeof J$` 不应被目标代码感知到（`J$` 不应泄露到目标代码的 `globalThis`）。
    4. **时序透明（Timing Transparency）**：异步事件的相对顺序不应被改变（是最难做到的一点）。

### 4. 异步边界问题与 Context ID（Async Boundary）

*   **问题**：JavaScript 的异步模型（`setTimeout`、`Promise`、`async/await`）会打断同步的调用栈。传统的调用栈跟踪（Call Stack Tracking）在 `await` 或 `setTimeout` 回调处会"断链"，无法知道这个回调是在哪个"逻辑上下文"中产生的。
*   **解决方案 —— Context ID（上下文 ID）**：在每个异步边界（`Promise.then`、`setTimeout`、`async function` 的每个 `await` 点）分配一个唯一的 `ContextID`，并随着异步回调一同传递。后处理工具通过 ContextID 把分散在不同时间点的日志事件重新"穿针引线"，还原完整的异步逻辑执行链。
*   **推论**：这要求在插桩阶段就对所有的异步边界点做特殊处理（如将 `await expr` 改写为 `J$.Aw(iid, await expr)`），而不能等到运行时再"发现"它们。

### 5. ObserveOnly 模式（只观察，不干预）

*   **问题**：在某些场景（如 Trace 记录、Coverage 统计），分析插件只需要"看"到事件，绝对不能修改程序的返回值或执行路径。但如果某个插件的钩子方法不小心 `return { result: someWrongValue }`，就会静默地破坏目标程序的语义，极难排查。
*   **解决方案**：在 Hook 分发器（Dispatcher）层面提供一个 `observeOnly` 模式。在此模式下，分发器仍然依次调用所有插件的钩子（插件能"看"到所有事件），但**完全忽略所有钩子的返回值**（`result`、`skip`、`isBacktrack` 等字段全部丢弃）。这是一种"框架级语义保证"，无论插件代码写得多糟，都不会影响目标程序。

---

## 四、 分析正确性基础 (Analysis Correctness Fundamentals)

### 1. Instrumentation Coverage（插桩覆盖率）—— 全量 vs 选择性

*   **全量插桩（Full Instrumentation）**：对所有操作（读、写、属性访问、函数调用、运算符、字面量）都注入钩子。精度最高，开销也最大。
*   **选择性插桩（Selective Instrumentation）**：只对感兴趣的操作类型插桩（如只插桩 `putField`）。开销低，但可能产生**漏报（False Negative）**。
*   **推论 —— Config-driven 插桩**：框架应提供细粒度的 Config 开关（如 `INSTR_READ`、`INSTR_WRITE`、`INSTR_GETFIELD`），让每种分析需求自由裁剪插桩范围，避免"为了一个分析目的而支付所有钩子的开销"。

### 2. FAI（Flow-Ambiguous Information，定义不确定性）

*   **概念**：当一个变量的值来自多个可能的"定义"（由于控制流分支或间接赋值），静态分析无法在编译期确定它的唯一来源，这个变量就处于 FAI 状态。
*   **与你的设计的关系**：在"利用 Use-Def 跳过读操作记录"的优化中，FAI 是必须记录实际值的情况。只有当一个变量的 Use-Def 链唯一确定时，读操作才可以被安全省略。
*   **处理策略**：FAI 变量降级为"必须记录实际值"，非 FAI 变量（链路清晰的局部变量）可以走优化路径省略记录。

### 3. Shadow Memory（影子内存）

*   **概念**：为目标程序中的每一个变量/对象/属性，在分析框架内部维护一个"影子（Shadow）"状态，用于存储分析工具关心的元信息（如污点标记、最后修改的 IID、变量的类型历史等）。目标程序看不到影子内存，它只在分析框架内部存在。
*   **应用**：污点分析（Taint Analysis）用影子内存标记哪些值来自不可信来源；类型分析用影子内存记录变量历史上出现过的所有类型。
*   **与 Native Snapshot 的关系**：影子内存的存储容器（通常是 `WeakMap`）本身也需要通过 Native Snapshot 来操作，否则 `WeakMap.prototype.set` 被 Monkey-Patch 后影子内存本身就会触发钩子。

### 4. 分析的可组合性（Analysis Composability）

*   **问题**：实际工程中往往需要同时运行多个分析（如：Trace + Taint + Coverage），但每个分析都可能对同一个钩子（如 `readVar`）感兴趣，且可能彼此依赖（Coverage 分析需要 SMemory 提供的对象 ID 信息）。
*   **解决方案 —— Chain of Responsibility（责任链）**：设计一个 Hook 分发器（`HookDispatcher`），将多个分析插件串联成一条责任链。每个插件按顺序接收钩子事件，可以修改传递给下一个插件的参数，也可以直接透传。
*   **核心规范**：每个插件通过返回值（如 `{ result: newValue }`）来表达"我想修改这个值"；若返回 `undefined` 则表示"我不干预，传递原值"。这样多个插件可以同时运行而互不冲突。

---

## 五、 架构演进方向总结

从传统的 Jalangi2 架构向现代高性能架构演进，核心路径如下：

1. **日志格式**：`Fat JSON (含行列号、变量名)` $\rightarrow$ `Thin JSON (仅含 IID)` $\rightarrow$ `Binary Stream (二进制流)`
2. **映射关系**：`运行时内存持有 SourceMap` $\rightarrow$ `完全剥离，生成独立的 .meta 静态文件`
3. **数据记录**：`记录所有读写的值` $\rightarrow$ `仅记录写操作和控制流，读操作靠后处理推导`
4. **分析逻辑**：`运行时维护状态机` $\rightarrow$ `运行时仅 Emit 事件，后处理工具（Trace Server）负责重放和分析`