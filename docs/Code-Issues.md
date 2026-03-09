# 代码问题说明

本文档记录在代码审查（2026-03）过程中发现的、尚未解决的代码问题、潜在 Bug 和设计缺陷，
供后续修复参考。**本文档仅做描述，不含代码修改。**

---

## Issue #1 — ExecutionTrace：脚本退出后从外部调用注册函数时 trace 不写入 IndexedDB

**文件**：`src/plugins/ExecutionTrace.js`、`src/logger/TraceLogger.js`

**状态**：已知 Bug，待修复

### 问题描述

典型场景：一段被插桩的脚本（如 `jd-sec.js`）执行完毕时，只做了全局函数注册（如
`window.xxx = function() { ... }`）；脚本主体执行结束后，外部代码（页面逻辑、其他
脚本、`<script>` 标签）再调用这个注册的函数。

**期望行为**：被调用函数内部的所有执行路径均已插桩，调用结果应当有 trace 数据写入 IndexedDB。

**实际行为**：没有 trace 数据写入 IndexedDB（IDB store只有脚本主体阶段的记录，到sceipt end后就再也没有信息了）。

### 根本原因分析

问题根源在 `TraceLogger` 的异步初始化与 `scheduleFlush` 机制的组合行为：

#### 1. `TraceLogger.init()` 是异步的，且不保证在外部调用发生前完成

`ExecutionTrace` 构造函数里调用：

```js
this._loggerReady = this._logger.init();
```

`_doInit()` 内部需要动态 `import`（`IdbWorkerBackend.js`）并等待 IndexedDB
连接建立（`idb.init()`），这是一个异步过程。在浏览器中，整个脚本加载 → 执行 → 退出
的过程可以非常快（毫秒级），此时 `_doInit()` 很可能**尚未完成**。

在 `_doInit()` 完成之前，`TraceLogger.trace()` 会将事件写入 `_preInitQueue`（内存缓冲
队列）；`_doInit()` 完成后，`_flushPreInitQueue()` 会把队列 replay 到 `LogManager`。
这部分逻辑**适用于脚本主体阶段**，因为 `_doInit()` 早晚会完成，replay 会执行。

#### 2. 脚本退出后立即发生的外部调用：`_doInit()` 可能已完成，也可能未完成

如果 `_doInit()` 在外部调用发生时**已完成**（`_preInitQueue === null`，`_mgr` 已就绪），
那么 `trace()` 会直接调用 `_mgr.log()`，数据进入 `RingBuffer`。

此时数据落入 IDB 的关键路径是：`RingBuffer` 积累到 flush 阈值（默认 512 条）
→ 自动 flush → `IdbWorkerBackend.write()`。

对于仅调用一次被注册函数（产生少量 trace 的场景），`call` / `functionExit` 钩子里
调用了 `this._logger.scheduleFlush?.()`:

```js
this._logger.scheduleFlush?.();
```

`scheduleFlush()` 用 `queueMicrotask` 调度一次 flush。问题在于：**这次
`queueMicrotask` 回调触发时，`_mgr` 是否仍然有效**？

#### 3. `endExecution` 不关闭 logger，但也没有保证异步 flush 完成

`endExecution()` 有意不关闭 logger（为了支持后续异步回调），但它也没有在脚本
退出时主动等待 `scheduleFlush` 结果或调用 `flush()`。如果整个页面生命周期里
外部调用的函数产生的 trace 量始终低于 512 条，且没有其他触发 flush 的时机，
这些数据会一直停留在 `RingBuffer` 里，永远不会写入 IDB。

#### 4. 如果 `_doInit()` 在外部调用时**尚未完成**（`_preInitQueue !== null`）

此时 `trace()` 会把事件追加到 `_preInitQueue`。`_doInit()` 完成后
`_flushPreInitQueue()` 确实会 replay，**但这取决于 `_doInit()` 最终完成**。

在某些浏览器环境下，若页面在 `_doInit()` 完成前就卸载（或者 IDB 初始化失败），
整个队列中的事件将被静默丢弃。

### 触发条件汇总

| 条件 | 是否触发 Bug |
|------|-------------|
| 脚本主体阶段（`scriptEnter` → `scriptExit`）| ✗（pre-init queue 保证 replay）|
| 脚本退出后，外部调用量少（< 512 条 trace），IDB 初始化已完成 | ✅ **触发**（RingBuffer 不足以自动 flush，scheduleFlush 窗口过窄）|
| 脚本退出后，外部调用量大（≥ 512 条 trace）| ✗（RingBuffer 满自动 flush）|
| 脚本退出后，IDB 初始化尚未完成时外部调用发生 | ✅ **触发**（依赖 _doInit 完成时机不确定）|

### 相关代码位置

| 位置 | 说明 |
|------|------|
| `ExecutionTrace.js` L302 | `this._loggerReady = this._logger.init()` — 构造时发起异步初始化 |
| `ExecutionTrace.js` L392 | `this._logger.scheduleFlush?.()` — call 后异步调度 flush（窗口过窄）|
| `ExecutionTrace.js` L509 | `this._logger.scheduleFlush?.()` — functionExit 后异步调度 flush（同上）|
| `ExecutionTrace.js` L636–654 | `endExecution()` — 不关闭 logger，也不主动 flush |
| `TraceLogger.js` L272–281 | `trace()` — init 未完成时写 `_preInitQueue`，完成后直接写 `_mgr` |
| `TraceLogger.js` L323–337 | `scheduleFlush()` — `queueMicrotask` 调度，可能在 `_mgr` 尚未就绪时被调度 |
| `TraceLogger.js` L239–258 | `_flushPreInitQueue()` — replay 入口，依赖 `_doInit` 完成 |

### 预期修复方向（仅描述，不含实现）

1. **`scheduleFlush` 时机问题**：每次外部调用（`functionExit` / `call`）结束后，
   除了 `scheduleFlush`，还应确保 `_doInit` 已完成再调度，或者在 `scheduleFlush`
   里先 await `_loggerReady`。

2. **RingBuffer 低水位 flush**：在 `scheduleFlush` 里，或 `LogManager` 层面增加一个
   "空闲超时 flush"机制（如 500ms 无新事件则自动 flush），避免少量异步 trace 永久
   积压在 RingBuffer。

3. **`endExecution` 主动 flush**：脚本主体退出时，`endExecution` 可以主动调用
   `this._logger.scheduleFlush?.()` 或者 `this.flush()`（在 `_loggerReady` 之后）,
   尽早将主体阶段数据落盘，并为后续异步调用建立好初始化完成的保证。

4. **`IdbWorkerBackend` 初始化竞态**：考虑在 `trace()` 中增加对 `_loggerReady` 的
   检测逻辑：若 `_doInit()` 已经完成（`_preInitQueue === null` 且 `_mgr` 已就绪），
   走快路径；若尚未完成，写 `_preInitQueue`。当前代码已有此逻辑，但 `scheduleFlush`
   没有正确等待 `_loggerReady` 完成再执行。
