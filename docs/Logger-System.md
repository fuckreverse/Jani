# DOC-06 · Logger 日志系统

> 源码路径：`src/logger/`、`src/encoding/`

---

## 1. 系统概述

Jani 的日志系统服务于两类截然不同的需求：

| 需求 | 特征 | 处理方式 |
|------|------|----------|
| **诊断日志** | 低频、可读性优先（模块启停、错误告警） | `diagnostics.js` → `console.*` 直接输出，含速率限制 |
| **Trace 数据** | 高频（每个插桩钩子都可能产生）、需持久化 | `LogManager` 缓冲 → 后端异步批量写入 |

两类数据**完全隔离**：Trace 数据不走 `console`，诊断日志不写 IDB / 文件。

### 模块一览

```
src/
├── encoding/
│   └── EventSerializer.js      事件序列化协议层（JTB1 紧凑二进制格式）
└── logger/
    ├── diagnostics.js          诊断日志工厂（createDiagLogger、速率限制、Debug 开关）
    ├── LogManager.js           事件缓冲与后端分发（RingBuffer → 后端）
    ├── TraceLogger.js          Trace 数据的高层门面（按环境自动选后端）
    ├── RingBuffer.js           单线程环形缓冲区（极低开销的同步 push）
    └── transport/              所有传输后端
        ├── MemoryBackend.js    内存后端（测试用）
        ├── NodeStreamBackend.js Node.js 文件流后端（写 .bin 二进制文件 + 配套 .smap.json）
        ├── IdbBackend.js       IndexedDB 后端（原 IdbWorkerBackend，Worker 是内部实现细节）
        ├── idb.worker.js       IDB Worker 脚本（Classic Worker，internal，勿直接 import）
        ├── WsBackend.js        WebSocket 后端（三种模式合一：main / worker / sab）
        └── ws.worker.js        WS Worker 脚本（Classic Worker，internal，勿直接 import）
```

### 概念层次

```
概念层                  实现文件                 说明
─────────────────────────────────────────────────────────────────
诊断（Diagnostics）     diagnostics.js           低频系统日志，直接输出 console.*
协议（Protocol）        encoding/EventSerializer.js  JTB1 二进制 wire format，多方共享
传输（Transport）       logger/transport/         后端实现，负责序列化和 IO
Trace 门面（Facade）    logger/TraceLogger.js     高层 API，按环境选后端
```

### 层次结构与数据流

```
插桩代码 / 分析插件
        │  高频调用
        ▼
  TraceLogger.trace()   ← 初始化前 → _preInitQueue 暂存
        │ 就绪后
        ▼
   LogManager.push()
        │  push（同步，极低开销）
        ▼
    RingBuffer
        │  积累到 flushThreshold 后 scheduleAsync → _doFlush()  ← 阈值触发
        │  flushIntervalMs > 0 → setInterval → _doFlush()       ← 定时触发（WS 后端时自动启用 50ms）
        │  外部调用 flush()                                      ← 手动触发
        │  pagehide / SIGTERM → _drainAllSync() / close()       ← 退出触发
        ▼
  backend.write(batch)  ─── 可同时分发给多个后端 ───►
        ├── MemoryBackend        (测试)
        ├── NodeStreamBackend    (Node.js 文件，JTB1 二进制)
        └── WsBackend            (主线程 / Worker 线程 / SAB 三种模式)
```

---

## 2. `diagnostics.js` — 诊断日志工厂

> 原 `logger.js`，已重命名。职责不变。

### 职责

- 为各模块提供带**域名前缀**的 `error / warn / info / debug` 四级日志对象
- 内置**速率限制**（防止高频场景刷屏），按域独立计算，超限后采样输出
- 通过环境变量（Node.js）或 localStorage（浏览器）控制 `debug` 级别的开关

### 使用方式

```js
import { createDiagLogger, DOMAIN } from '../../logger/diagnostics.js';

const log = createDiagLogger(DOMAIN.BACKEND_WS);   // 或直接传字符串 'backend:ws'

log.error('连接断开:', err.message);   // 始终输出，不受速率限制
log.warn('重连中...');                 // 受宽松速率限制（默认 20 条/10s）
log.info('后端已就绪');               // 受严格速率限制（默认 10 条/10s）
log.debug('批次已发送, size=', n);    // 仅在对应域开启 debug 时输出
```

输出格式：`[Jalangi:backend:ws] 连接断开: ...`

### Debug 开关

| 环境 | 方式 | 示例 |
|------|------|------|
| Node.js | `JALANGI_DEBUG` 环境变量 | `JALANGI_DEBUG=backend:ws,backend:node node script.js` |
| 浏览器 | `localStorage.jalangiDebug` | `localStorage.jalangiDebug = 'backend:idb'` |
| 全域开启 | 值为 `1` 或 `*` | `JALANGI_DEBUG=1` |
| 前缀匹配 | `backend` 可匹配 `backend:ws` / `backend:idb` | `JALANGI_DEBUG=backend` |

### 内置域名常量 `DOMAIN`

```js
import { DOMAIN } from '../../logger/diagnostics.js';

DOMAIN.FRAMEWORK    // 'framework'     — JalangiRuntime, HookDispatcher
DOMAIN.INSTRUMENT   // 'instrument'    — esnstrument, astUtil
DOMAIN.TRACE_INFRA  // 'trace-infra'   — LogManager, TraceLogger（Trace 基础设施诊断域）
DOMAIN.BACKEND_IDB  // 'backend:idb'   — IdbBackend
DOMAIN.BACKEND_WS   // 'backend:ws'    — WsBackend
DOMAIN.BACKEND_NODE // 'backend:node'  — NodeStreamBackend
DOMAIN.BACKEND_MEM  // 'backend:mem'   — MemoryBackend（测试用，通常无需 debug）
DOMAIN.ANALYSIS     // 'analysis'      — 分析插件业务日志
```

> **注意**：原 `DOMAIN.LOGGING` 已重命名为 `DOMAIN.TRACE_INFRA`，语义更准确（表示"Trace 基础设施自身的诊断域"）。

### 速率限制配置

```js
import { setRateLimit, resetRateLimiters } from '../../logger/diagnostics.js';

// 默认值
// { warnPerWindow: 20, infoPerWindow: 10, debugPerWindow: 10,
//   windowMs: 10000, sampleEvery: 10 }

// 开发调试时放开限制
setRateLimit({ warnPerWindow: 0, infoPerWindow: 0, debugPerWindow: 0 });

// 高频分析场景收紧限制
setRateLimit({ warnPerWindow: 5, infoPerWindow: 3, windowMs: 5000, sampleEvery: 50 });

// 单测 teardown（避免窗口计数污染下一个用例）
resetRateLimiters();           // 重置所有域
resetRateLimiters('analysis'); // 只重置指定域
```

速率限制的工作机制：
1. **error 级别**：完全绕过速率限制，始终输出
2. **滑动窗口**：窗口内超过上限后开始跳过，窗口结束后自动重置（不会"永久封禁"）
3. **采样输出**：超限后每跳过 `sampleEvery` 条输出一次，附带"已跳过 N 条"提示

---

## 3. `RingBuffer.js` — 环形缓冲区

### 设计目标

- `push()` 操作为 O(1) 同步写入，对应单次 `Array` 写入量级，适合在插桩钩子里直接调用
- `drain()` 批量取出，供后端异步消费
- **不丢弃**：满容量时自动翻倍扩容（上限由 `maxCapacity` 控制）

### 接口

```js
import { RingBuffer } from '../../logger/RingBuffer.js';

const buf = new RingBuffer({
    capacity:       65536,    // 初始容量
    flushThreshold: 512,      // shouldFlush 属性触发阈值
    maxCapacity:    Infinity, // 扩容上限
});

buf.push(event);            // 同步写入
buf.size;                   // 当前积压数
buf.shouldFlush;            // 是否达到 flush 建议阈值
const batch = buf.drain();  // 取出全部（或 drain(1024) 最多 1024 条）
buf.clear();                // 丢弃所有（慎用）
buf.getStats();             // 统计摘要
```

### 扩容策略

- 每次满时容量翻倍（`capacity * 2`）
- 扩容时将旧数据按顺序复制到新数组（处理环绕分段）
- `stats.totalResizes` 记录扩容次数，可观测

---

## 4. `LogManager.js` — 事件缓冲与分发

### 职责

1. 维护一个 `RingBuffer`，供分析钩子同步写入事件（极低开销）
2. 在合适时机异步 flush：达到 `flushThreshold` 时通过 `queueMicrotask` / `setImmediate` 调度
3. 将事件批次分发给所有注册的后端（`backend.write(batch)`）
4. 支持多后端同时运行
5. 自动监听 `pagehide` / `SIGTERM` / `SIGINT` 执行关闭序列（可通过 `autoClose: false` 禁用）

### 构造参数

```js
import { LogManager } from '../../logger/LogManager.js';

const mgr = new LogManager({
    backends:                  [backend1, backend2],  // 后端列表
    capacity:                  65536,   // RingBuffer 初始容量
    flushThreshold:            512,     // 积累多少条触发异步 flush
    flushIntervalMs:           0,       // 定时 flush 间隔（ms），0 = 禁用；见下文「定时 flush」
    drainBatchSize:            1024,    // 每次 drain 最多取多少条
    autoClose:                 true,    // 是否自动绑定关闭钩子（pagehide/SIGTERM/SIGINT）
    forceSyncFlushThreshold:   0,       // 【验证用】累计 N 条后在 push() 中同步 flush（0 = 禁用）
});
```

### 定时 flush（`flushIntervalMs`）

当 `flushIntervalMs > 0` 时，`LogManager` 会启动一个 `setInterval` 定期调用 `_doFlush()`：

- **用途**：适合有 WebSocket 后端的场景。JS 密集执行期间事件不断写入 RingBuffer，但主线程不空闲——`queueMicrotask` 可能迟迟得不到执行；定时器保证每隔一定间隔（如 50ms）强制 drain 一次，避免 trace 数据全部积压到脚本结束后才一次性发送。
- **Node.js 下自动 unref**：定时器调用了 `.unref()`，不会阻止 Node.js 进程退出。
- **由 `TraceLogger` 自动管理**：`TraceLogger._doInit()` 检测到有 WebSocket 后端时，自动设置 `flushIntervalMs: 50`（用户可通过 `logManagerOptions.flushIntervalMs` 覆盖）；无 WS 后端时默认 0（禁用定时 flush）。
- **关闭时**：`mgr.close()` 会调用 `clearInterval` 取消定时器，再做最终 drain。

```
有 WS 后端 → flushIntervalMs = 50ms（自动设置）
无 WS 后端 → flushIntervalMs = 0（禁用，避免不必要的系统调用）
```

### 自动关闭钩子（`autoClose: true`）

`autoClose` 为 `true`（默认）时，`LogManager` 在构造时自动绑定退出信号钩子，确保程序退出前不丢数据：

| 环境 | 钩子 | 行为 |
|------|------|------|
| 浏览器 | `pagehide` + `beforeunload` | 先同步 `_drainAllSync()`（`writeSync`），再 fire-and-forget `close()` |
| Node.js | `process.exit` | 同步 `_drainAllSync()`（最后防线，无 await） |
| Node.js | `SIGTERM` / `SIGINT` | 异步 `await close()`（完整 flush + 关闭后端） |

> **浏览器 `pagehide` 处理策略**：`pagehide`（比 `beforeunload` 更可靠，bfcache 下也会触发）时：
> 1. 同步调用 `_drainAllSync()`：将 RingBuffer 剩余事件通过 `writeSync()` 推送给 Worker（WsBackend），Worker 会在同步帧内完成 `ws.send()`
> 2. Fire-and-forget `close()`：给 Worker 时间把 `_sendQueue` 中的数据实际发出；页面生命周期延长约 600ms
>
> 对于纯异步后端（IDB），`pagehide` 时数据仍可能部分丢失——建议在 `endExecution` 中显式调用 `await tracer.close()`。

### 主要 API

```js
// 推入一条事件（同步，分析钩子里调用）
mgr.push({ type: 'READ', iid, sid, name, value });

// 主动 flush（await 可确保写入完成）
await mgr.flush();

// 关闭：flush 剩余数据 → 关闭所有后端
await mgr.close();

// 动态增减后端
mgr.addBackend(newBackend);
mgr.removeBackend(oldBackend);

// 获取统计
const stats = mgr.getStats();
// { logManager: { totalLogged, totalFlushed, flushErrors, forceSyncFlushCount },
//   ringBuffer:  { totalPushed, totalDrained, totalDropped, totalResizes, flushCount,
//                  currentSize, capacity, initialCapacity } }
```

> **注意**：原 `mgr.log()` 方法已重命名为 `mgr.push()`，语义更准确（往 RingBuffer 里推事件）。

### 便捷工厂函数

```js
import { createMemoryLogManager, createLogManager } from '../../logger/LogManager.js';

// 测试用：MemoryBackend
const { mgr, backend } = await createMemoryLogManager();

// 根据后端类型名称创建（自动 import 对应模块）
const mgr = await createLogManager('idb',         { dbName: 'my-db' });
const mgr = await createLogManager('ws',          { url: 'ws://localhost:9229/trace' });
const mgr = await createLogManager('node-stream', { path: 'trace.bin' });
const mgr = await createLogManager('memory');
```

### 关闭时序

```
mgr.close()
  ├─ 停止定时 flush
  ├─ _drainAll()         ← 循环 drain 直到 RingBuffer 为空
  │    ├─ _doFlush() × N
  │    └─ backend.flush() （等待后端侧的缓冲落盘）
  └─ backend.close() × N  （关闭所有后端连接）
```

### 同步降级（`forceSyncFlushThreshold`）

用于**验证高负载场景**下数据是否能及时发送。设置后每累计 N 条调用 `_doFlushSync()`，
在当前调用栈中同步完成 drain 和 `backend.writeSync()`，绕过 `queueMicrotask` 调度。
生产环境不建议开启（增加插桩回调延迟）。

---

## 5. `TraceLogger.js` — Trace 数据高层门面

### 职责

- 统一浏览器 / Node.js 两种环境的 Trace 写入接口
- 按环境自动选择合适的后端（IDB、WebSocket、文件流）
- 区分两类日志：
  - **普通 trace**（高频）：走 `LogManager` 缓冲后端
  - **重点事件**（低频）：直接同步输出到 `console`，同时写入后端便于搜索边界
- **pre-init 缓冲**：`init()` 完成前产生的事件暂存，就绪后自动 replay，脚本加载阶段事件不丢失
- KEY 事件直接使用 `console.*` 输出（不走诊断日志速率限制，KEY 事件本身就是低频的）

### 构造参数

```js
import { TraceLogger } from '../../logger/TraceLogger.js';

// 浏览器（IDB + WebSocket）
const logger = new TraceLogger({
    // 浏览器选项
    useIdb:      true,                        // 是否启用 IndexedDB 后端
    dbName:      'jalangi-traces',
    storeName:   'execution-trace',
    wsUrl:       'ws://localhost:33000/ws/trace', // 可选：同时推送到 JTA Server（或独立 trace-server 的 ws://localhost:9229/trace）
    wsSab:       false,    // 是否使用 SharedArrayBuffer 模式（需 COOP/COEP header）
    wsWorker:    true,     // 是否将 WebSocket 放入 Web Worker（推荐）
    wsFormat:    'binary', // 'binary'（高吞吐）或 'ndjson'（可读性）

    // Node.js 选项
    nodeFile:    'jalangi-trace.bin',  // false = 只用控制台；文件后缀应为 .bin
    nodeConsole: false,

    // 通用选项
    keyToConsole:      true,
    logManagerOptions: {},  // 透传给 LogManager（如 forceSyncFlushThreshold）
});

await logger.init();  // 异步初始化（可不 await，事件自动缓冲）
```

### WebSocket 后端选择逻辑

```
wsUrl 已设置？
  ├─ wsSab=true → WsBackend(mode='sab')     零拷贝（需 COOP/COEP）
  ├─ wsWorker=true（默认）→ WsBackend(mode='worker')   Worker 线程发送
  └─ wsWorker=false     → WsBackend(mode='main')     主线程，调试用

SAB 条件不满足时自动降级到 worker 模式（控制台 warn 提示）
```

### 定时 flush 自动策略

`TraceLogger._doInit()` 在创建 `LogManager` 时，会根据**是否存在 WebSocket 后端**自动设置 `flushIntervalMs`：

| 场景 | `flushIntervalMs` | 原因 |
|------|-------------------|------|
| 浏览器 + `wsUrl` 已设置 | `50`（ms）| 主线程密集执行时 `queueMicrotask` 可能延迟；定时 50ms flush 确保数据实时推送 |
| 其他场景（无 WS 后端）| `0`（禁用）| Node.js 文件后端/IDB 不需要低延迟推送；关闭定时器减少系统调用 |

用户可通过 `logManagerOptions.flushIntervalMs` 覆盖默认值：

```js
const tracer = new TraceLogger({
    wsUrl: 'ws://localhost:33000/ws/trace',
    logManagerOptions: { flushIntervalMs: 100 },  // 覆盖为 100ms
});
```

### 主要 API

```js
// 写普通 trace（高频路径，走 LogManager）
logger.trace({ type: 'END_EXPR', iid: 8, seq: 42, writes: [], reads: [], fields: [] });

// 写重点事件（低频，同步输出到控制台 + 写入后端）
logger.key('info',  '▶ script: foo.js');
logger.key('error', '✗ throw ; exception=...');

// 调度一次 flush（异步回调产生少量 trace 时防止积压）
logger.scheduleFlush();

// 结束时 flush + 关闭
await logger.close();

// 调试属性
logger.isReady;         // 后端是否已就绪
logger.preInitQueueSize; // pre-init 队列长度（0 表示已 replay）
```

### smap 注入

`TraceLogger` 暴露了 `setSmap(smapObj)` 方法，会透传给底层 `NodeStreamBackend`，
在 `close()` 时自动将 smap 写出为与 `.bin` 配对的 `.smap.json` 文件：

```js
// 在 instrument-and-run 模式中，由 loader 钩子注入 smap
logger.setSmap(buildSmapJson(sourceMapObject));
// close() 时自动生成 trace.smap.json（与 trace.bin 同目录）
await logger.close();
```

### Pre-init 缓冲机制

```
new TraceLogger(...)  →  _preInitQueue = []

logger.trace(ev)  [init 尚未完成]  →  _preInitQueue.push({ kind:'trace', event: ev })
logger.key(...)   [init 尚未完成]  →  _preInitQueue.push({ kind:'key', ... })

_doInit() 完成  →  _flushPreInitQueue()
                      ├─ 遍历队列，将所有事件 replay 到 _mgr.push()
                      └─ _preInitQueue = null  （标记已完成）
```

---

## 6. `encoding/EventSerializer.js` — 事件序列化协议层

> **重要**：`EventSerializer.js` 位于 `src/encoding/`，作为独立的**协议层**，
> 不属于任何单一传输方式。它是 Jalangi 事件的标准 wire format，供以下模块共同依赖：
> - `src/logger/transport/NodeStreamBackend.js`（文件端序列化）
> - `src/logger/transport/WsBackend.js`（发送端序列化）
> - `tools/trace-server/server.mjs`（接收端反序列化）
> - 离线分析模块、跨语言消费工具等

**设计原则**：轻运行时，重后处理。运行时只写最小信息，所有格式化 / 渲染交由后处理工具完成。

### 序列化安全：防 monkey-patch 递归

`EventSerializer.js` 在**模块加载时立即快照原生方法**，以防止被分析代码对内置函数的 monkey-patch 触发 Jalangi 钩子递归（StackOverflow）：

```
模块加载时（被分析代码运行之前）：
  _jsonStringify     = JSON.stringify       ← 快照 JSON.stringify
  _objDefineProperty = Object.defineProperty
  _objGetOwnPropDesc = Object.getOwnPropertyDescriptor
  _objGetPrototypeOf = Object.getPrototypeOf
  _nativeToJsonMap   = { Date.prototype → 原生 toJSON }  ← 快照原型上的原生 toJSON
```

**问题场景**：被分析代码可能把 `Date.prototype.toJSON` 替换为插桩版函数。当 `serializeBatch()` 调用 `JSON.stringify(someDate)` 时，`stringify` 内部会调用 `date.toJSON()`——若此时是插桩函数，则触发 Jalangi 的 `call` 钩子 → `serializer.serializeBatch()` → 再次调用 `JSON.stringify` → 无限递归。

**解决方案**（在 `measureValue` 中）：
1. 用快照的 `_objGetPrototypeOf` 获取对象原型
2. 查 `_nativeToJsonMap`：该原型本来是否有原生 `toJSON`
3. 若有且已被替换（检测到 `proto.toJSON !== nativeToJson`），临时在**实例**上遮蔽（`_objDefineProperty` 写入原生版本）
4. 调用快照的 `_jsonStringify(v)` 序列化（使用原生 `JSON.stringify`）
5. 删除实例上的临时遮蔽

**性能优化**：
- 大多数 plain object / Array 原型链上根本没有 `toJSON`，直接跳过，零额外开销
- 只有 `Date` 等内置类型才进入检查路径，且只在原型 `toJSON` 已被替换后才遮蔽
- 所有检查路径（`_nativeToJsonMap.get`、`_objGetOwnPropDesc`）均为 O(1)

> **注意**：此快照必须在模块加载时立即执行（模块顶层代码）。若被分析代码在 `EventSerializer.js` 导入之前就修改了这些原型，快照将捕获到已被修改的版本——但实际上 Jalangi 总是在分析代码运行之前导入基础设施模块，因此这个时序是安全的。

### JTB1 二进制格式（Jani Trace Binary v1）

文件后缀：`.bin`

#### 文件头（8 字节）

```
[0..3]  u8×4  魔数  0x4A 0x54 0x42 0x31（ASCII "JTB1"）
[4]     u8    版本  0x01
[5..7]  保留  3 字节
```

#### 事件头（12 字节，定长，小端序）

```
[0]      u8   eventType   — 事件类型（EVENT_TYPE.*）
[1]      u8   flags       — 位标志（FLAGS.*，见下文）
[2..5]   u32  iid         — 指令 ID（对应 smap.json 中的 iid 条目）
[6..9]   u32  seq         — 事件序号（全局单调递增）
[10..11] u16  payloadLen  — 本事件 payload 字节数（0 = 无 payload）
```

事件头之后紧跟 `payloadLen` 字节的可变 payload，再之后是下一条事件。

#### 事件类型（EVENT_TYPE）

| 值 | 名称 | Payload 概述 |
|----|------|-------------|
| `0x01` | `SCRIPT_ENTER` | `[filename u16+UTF8]` |
| `0x02` | `SCRIPT_EXIT` | 若有异常：`[exception_val]` |
| `0x03` | `CALL_PRE` | `[fnName u16+UTF8][argc u8][arg0_val]...[argN_val][this_val?]` |
| `0x04` | `CALL` | `[fnName u16+UTF8][result_val]` |
| `0x05` | `FUNCTION_ENTER` | 无 |
| `0x06` | `FUNCTION_EXIT` | 若有异常：`[exception_val]` |
| `0x07` | `END_EXPR` | `[wCount u8][rCount u8][fCount u8]` 后跟三组条目 |
| `0x08` | `KEY_EVENT` | `[level u8][text u16+UTF8]` |
| `0x0B` | `WRITE_VAR` | `[name u16+UTF8][val]` |
| `0x0C` | `READ_VAR_FULL` | `[name u16+UTF8][val]` |

`END_EXPR` 是最高频的事件类型，编码了一条表达式语句的所有读写操作：
- **writes**：`[name u16+UTF8][val]` × wCount
- **reads**：`[name u16+UTF8][val]` × rCount（val 可能是 `OMITTED`）
- **fields**：`[base u16+UTF8][offset u16+UTF8][isWrite u8][val]` × fCount

#### flags 位掩码（FLAGS）

| 位 | 名称 | 含义 |
|----|------|------|
| `0x01` | `HAS_EXCEPTION` | `CALL` / `FUNCTION_EXIT`：有异常值 |
| `0x02` | `IS_CONSTRUCTOR` | `CALL_PRE`：new 调用 |
| `0x04` | `IS_METHOD` | `CALL_PRE`：方法调用 |
| `0x08` | `HAS_THIS` | `CALL_PRE`：包含 this 值 |
| `0x10` | `VALUE_OMITTED` | 通用：值已省略（可通过 smap.defIid 追溯） |
| `0x20` | `IS_WRITE` | field 条目：属性写入 |
| `0x40` | `DIRECT_FE` | `FUNCTION_ENTER`：无 callPre 覆盖 |

#### 值编码（VALUE_TYPE）

每个值在 payload 中用 1 字节 valueType + 可变字节数编码：

| 值 | 名称 | 后续字节 |
|----|------|---------|
| `0x00` | `OMITTED` | 无（值可通过 smap.defIid 追溯） |
| `0x01` | `NULL` | 无 |
| `0x02` | `UNDEFINED` | 无 |
| `0x03` | `BOOL_T` | 无（true） |
| `0x04` | `BOOL_F` | 无（false） |
| `0x05` | `INT32` | 4 字节 i32（小端）— 整数优化 |
| `0x06` | `FLOAT64` | 8 字节 f64（小端） |
| `0x07` | `STRING` | u16 长度 + UTF-8 字节（最长 256 字符，超限截断加 `…`） |
| `0x08` | `OBJECT` | u16 长度 + JSON UTF-8 字节（最长 256 字符） |
| `0x09` | `FUNCTION` | u8 名称长度 + ASCII 字节（最长 255） |
| `0x0B` | `TYPED_ARRAY` | `[u8 nameLen][nameBytes][u32 byteLen][u32 elemCount][u8[min(byteLen,64)] rawBytes]`<br>解码后显示为 `[TypeName(N):MB:hexpreview]` 字符串，例如 `[Uint8Array(8):8B:deadbeef01020304]`；超过 64 字节时 hex 摘要截断到前 64 字节（128 个 hex 字符）；`ArrayBuffer` 元素数显示为 0 |

#### 值省略（FAI 优化）

当静态分析确定某 read-site 对应唯一 def-site 时（`Decision.LIGHTWEIGHT`），
值编码为 `VALUE_TYPE.OMITTED`（1 字节），节省写入开销。
后处理工具加载 `.smap.json` 后，通过 `smap[iid].defIid` 追溯到对应 write 事件的实际值。

### 主要 API

```js
import {
    // 序列化
    serializeEvent,       // 单条事件 → ArrayBuffer（含 12B 头 + payload）
    serializeBatch,       // 事件数组 → ArrayBuffer（紧密排列，无分隔符）
    createFileHeader,     // 创建 8 字节文件头（含魔数和版本）

    // 反序列化
    deserializeEvent,     // 从 DataView offset 处读取一条事件
    deserializeAll,       // 整个 Buffer → 事件数组（跳过文件头）
    iterateBinary,        // 遍历整个 Buffer，逐条调用回调

    // 工具
    isBinaryTrace,        // 检查 Buffer 是否以 JTB1 魔数开头

    // 常量
    EVENT_TYPE, EVENT_TYPE_NAME, FLAGS, VALUE_TYPE,
    MAGIC, FORMAT_VERSION, FILE_HEADER_SIZE, EVENT_HEADER_SIZE,
} from '../../encoding/EventSerializer.js';
```

**使用示例**（NodeStreamBackend 写入端）：

```js
import { serializeBatch, createFileHeader } from '../../encoding/EventSerializer.js';

// 文件开头写一次头
stream.write(Buffer.from(createFileHeader()));

// 每批事件追加写入
const batch = [
    { type: 'SCRIPT_ENTER', iid: 8,  seq: 1, file: 'foo.js' },
    { type: 'END_EXPR',     iid: 16, seq: 2, writes: [{ name: 'x', val: 42 }], reads: [], fields: [] },
];
stream.write(Buffer.from(serializeBatch(batch)));
```

**使用示例**（后处理读取端）：

```js
import { isBinaryTrace, deserializeAll } from '../../encoding/EventSerializer.js';
import { readFileSync } from 'node:fs';

const raw = readFileSync('trace.bin');
if (!isBinaryTrace(raw)) throw new Error('not a JTB1 file');

const events = deserializeAll(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
for (const ev of events) {
    if (ev.type === 'END_EXPR') {
        for (const w of ev.writes) console.log(`WRITE ${w.name} = ${w.value}`);
    }
}
```

### 压缩策略

应用层字典压缩（Value Pool / `STRING_REF`）已移除。推荐在**传输层或存储层**使用 gzip，对解码器完全透明、无有状态依赖：

- **NodeStreamBackend**：设置 `compress: true`（或路径以 `.bin.gz` 结尾），写盘时对整个 JTB1 字节流进行 gzip 压缩
- **WsBackend**（main/worker 模式）：WebSocket 本身支持 `perMessageDeflate`，由浏览器/框架层自动协商

gzip 能自动利用流中的重复模式，压缩效果与应用层字典相当，且无需在读写两侧维护任何共享状态。

### 体积对比

| 格式 | 典型字节/条事件 | 备注 |
|------|----------------|------|
| JTB1 二进制（无 gzip）| 12～30 B | 无分隔符，整数用 i32，常量值无附加字节 |
| JTB1 二进制（gzip 压缩）| 3～10 B（等效）| gzip 自动利用流中重复模式，典型压缩比 3～6× |
| NDJSON（旧格式） | 100～300 B | 每条一行 JSON，字段名全文本 |

---

## 7. `.smap.json` — Source Map 文件

`.smap.json` 是与 `.bin` 配对的位置信息文件，在**离线后处理阶段**将 iid 映射回源码位置。

### 文件命名规则

- `trace.bin` → `trace.smap.json`（同目录，`.bin` 后缀替换为 `.smap.json`）
- 其他后缀 → 追加 `.smap.json`（如 `trace.dat` → `trace.dat.smap.json`）

### 生成方式

由插桩器的 `buildSmapJson(sourceMapObject)` 函数生成，包含：
- 每个 iid 对应的源码位置（`[startLine, startCol, endLine, endCol]`）
- 可选：`defIid`（该 read-site 对应的 def-site iid，用于 FAI 值省略追溯）
- 源文件名、原始源码（可选）

### 写出方式

`NodeStreamBackend` 在 `close()` 时自动写出：

```js
const backend = new NodeStreamBackend({ path: 'trace.bin' });
backend.setSmap(buildSmapJson(sourceMapObject));  // 注入 smap
await backend.close();  // 自动写出 trace.smap.json
```

在 `instrument-and-run` 模式中，loader 钩子插桩后立即调用 `tracer.setSmap()` 注入当前文件的 smap，
实现 `.bin` 和 `.smap.json` 的自动配对。

### 格式示例

```json
{
  "file": "foo.js",
  "iids": {
    "8":  [1, 0, 1, 5],
    "16": [2, 4, 2, 9],
    "24": { "loc": [3, 0, 3, 7], "defIid": 8 }
  }
}
```

---

## 8. 后端接口规范（LogBackend）

所有后端实现以下接口（非强制继承，duck typing）：

```ts
interface LogBackend {
    // 批量写入事件（必须）
    write(batch: object[]): Promise<void>;

    // 等待缓冲落盘（必须，可实现为 noop）
    flush(): Promise<void>;

    // 关闭后端（必须，可实现为 noop）
    close(): Promise<void>;

    // 同步写入（可选，实现后 LogManager._doFlushSync() 会优先调用）
    // 语义：尽力写入，无法保证完成，用于 beforeunload / process.exit
    writeSync?(batch: object[]): void;
}
```

---

## 9. 各后端详解

### 9.1 `MemoryBackend`（`transport/MemoryBackend.js`）

最简单的后端，所有事件保存在内存数组中，**仅用于测试**。

```js
import { MemoryBackend } from '../../logger/transport/MemoryBackend.js';

const backend = new MemoryBackend();
// 写入后查询
const all      = backend.getEvents();
const reads    = backend.getEventsOfType('READ');
backend.clear();  // 清空
```

### 9.2 `NodeStreamBackend`（`transport/NodeStreamBackend.js`）

Node.js 专用，通过 `fs.WriteStream` 将事件序列化为 **JTB1 二进制格式** 写入 `.bin` 文件。
可选：在 `close()` 时自动将 smap 写出为配对的 `.smap.json`。

```js
import { NodeStreamBackend } from '../../logger/transport/NodeStreamBackend.js';

const backend = new NodeStreamBackend({
    path:          'jalangi-trace.bin',   // 输出文件路径（.bin）
    stream:        null,                  // 或传入已有 Writable（优先于 path）
    append:        false,                 // 二进制 trace 不支持追加，固定覆盖
    highWaterMark: 65536,                 // WriteStream 缓冲上限（字节）
    autoFlush:     false,                 // 每批后调用 flush（增加 syscall）
    smap:          null,                  // 初始 smap 对象（可后续通过 setSmap 更新）
    compress:      false,                 // gzip 压缩（输出 .bin.gz），或路径以 .bin.gz 结尾时自动启用
    gzipLevel:     6,                     // gzip 压缩级别 1（最快）~ 9（最小）
});
```

**smap 注入**：

```js
backend.setSmap(smapObj);   // 注入 smap（可在 write 之后、close 之前任意时刻调用）
await backend.close();      // 自动写出 jalangi-trace.smap.json
```

**文件格式**：

```
[8B 文件头: 魔数 JTB1 + 版本]
[12B 事件头 + payloadLen 字节 payload]   ← 事件 1
[12B 事件头 + payloadLen 字节 payload]   ← 事件 2
...
```

背压处理：`write()` 检测 `stream.writableNeedDrain`，背压时等待 `drain` 事件。

### 9.3 `WsBackend`（`transport/WsBackend.js`）

统一的 WebSocket 后端，通过 `mode` 参数切换三种内部实现。

```js
import { WsBackend } from '../../logger/transport/WsBackend.js';

// 主线程模式（调试用）
const backend = new WsBackend({ url, mode: 'main',   format: 'binary' });

// Worker 模式（默认，推荐高频 trace）
const backend = new WsBackend({ url, mode: 'worker', format: 'binary' });

// SAB 模式（零拷贝，需 COOP/COEP；不满足时自动降级 worker）
const backend = new WsBackend({ url, mode: 'sab',    format: 'binary', slotDataBytes: 65536 });
```

**三种模式对比**：

| 模式 | 原实现 | 主线程开销 | 依赖 | 适用场景 |
|------|--------|-----------|------|----------|
| `main` | `WsBackend` | 高（`ws.send` 在主线程） | 无 | 调试、低频 |
| `worker` | `WsWorkerBackend` | 极低（`postMessage` 微秒级） | Web Worker | 高频 trace（推荐） |
| `sab` | `WsSabBackend` | 最低（`Atomics.store` 纳秒级） | COOP/COEP + SAB | 极高频，主线程繁忙 |

**背压控制（滑动窗口 ACK）**：
- 服务端每收到一批次返回 ACK（二进制：4 字节 batchId；或 JSON：`{ type:'ack', batchId }`）
- `main` / `worker` 模式维护 `_inFlight` Map，未收 ACK 的批次数达到 `windowSize` 时暂停发送
- `sab` 模式通过 SAB 环形缓冲区槽位计数实现背压（满时 `write()` 等待或超时丢弃）

**SAB 内存布局**：
```
[元数据区 16B]
  Int32[0] writeSeq  — 主线程写入序号（单调递增）
  Int32[1] readSeq   — Worker 读取序号（单调递增）
  Int32[2] ctrl      — 0=运行, 1=关闭请求
  Int32[3] _pad

[数据槽区 slotCount × (4 + slotDataBytes)]
  每槽: [u32 byteLength][...数据（最多 slotDataBytes 字节）]
```

**SAB 支持检测**：

```js
WsBackend.isSabSupported()  // → boolean
```

### 9.4 `IdbBackend`（`transport/IdbBackend.js`）

> 原 `IdbWorkerBackend`，已去掉"Worker"后缀（Worker 是内部实现细节）。

浏览器专用，通过 Web Worker 持有 IndexedDB 连接，主线程通过 `postMessage` 批量写入事件。

```js
import { IdbBackend } from '../../logger/transport/IdbBackend.js';

const backend = new IdbBackend({
    dbName:    'jalangi-traces',
    storeName: 'execution-trace',
});
await backend.init();  // 等待 Worker 启动 + IDB 连接就绪
```

---

## 10. Worker 脚本

两个 Worker 脚本均为 **Classic Worker**（无 `import`，自包含），原因是 Blob URL 不支持 Module Worker。
它们是对应后端类的**内部实现细节**，不应直接 import，也不应被外部模块依赖。

| 文件 | 对应后端 | 功能 |
|------|----------|------|
| `transport/idb.worker.js` | `IdbBackend` | 持有 IDB 连接，接收 `writeVar` 批次写入 IndexedDB；支持 `flush`/`query`/`clear`/`close` |
| `transport/ws.worker.js` | `WsBackend(worker/sab)` | 合并了原 `ws-worker.js` 和 `ws-worker-sab.js`，通过初始化消息的 `mode` 字段区分行为 |

### Worker 加载策略

源码中通过 `new URL('./idb.worker.js', import.meta.url)` 等引用 Worker 脚本。
在浏览器 bundle 场景下，Rollup 插件会将此表达式替换为预创建的 Blob URL，
避免 Module Worker 不支持 `blob:` URL 导致的问题。

### `idb.worker.js` 消息协议

```
主线程 → Worker                              Worker → 主线程
─────────────────────────────────────────────────────────────
{ cmd: 'init', dbName, storeName,           { type: 'ready' }
  version, debugDomain? }

{ cmd: 'writeVar', batch, batchId }         { type: 'ack', batchId, count }
                                            { type: 'error', batchId, message, stack }

{ cmd: 'flush', reqId }                     { type: 'flushed', reqId }

{ cmd: 'query', reqId, filter?, limit? }    { type: 'queryResult', reqId, events }

{ cmd: 'clear', reqId }                     { type: 'cleared', reqId }

{ cmd: 'close', reqId }                     { type: 'closed', reqId }
```

**IDB 存储格式**：每条事件为一条 IDB record，结构 `{ id (autoIncrement), ts (DOMHighResTimeStamp), ...event }`；
带有 `type`、`iid`、`sid`、`ts` 四个索引，支持按类型/位置/时间查询。

---

## 11. 在分析插件中使用日志系统

### 最简使用（只需诊断日志）

```js
import { createDiagLogger, DOMAIN } from '../../logger/diagnostics.js';

const log = createDiagLogger(DOMAIN.ANALYSIS);

export function read(iid, name, val, isGlobal, isScriptLocal) {
    log.debug('read', name, '=', val);
    return { result: val };
}
```

### 使用 TraceLogger 收集 Trace 数据（浏览器）

```js
import { TraceLogger } from '../../logger/TraceLogger.js';

const tracer = new TraceLogger({
    wsUrl:    'ws://localhost:33000/ws/trace',  // JTA Server；独立 trace-server 用 ws://localhost:9229/trace
    wsWorker: true,
});
tracer.init();  // 不 await，事件自动缓冲

let seq = 0;

export function read(iid, name, val) {
    tracer.trace({
        type: 'END_EXPR', iid, seq: seq++,
        writes: [], reads: [{ name, val }], fields: [],
    });
    return { result: val };
}

export function endExecution() {
    tracer.key('info', `=== 执行结束，共 ${seq} 条事件 ===`);
    return tracer.close();  // 返回 Promise
}
```

### 使用 TraceLogger 收集 Trace 数据（Node.js）

```js
import { TraceLogger } from '../../logger/TraceLogger.js';

const tracer = new TraceLogger({ nodeFile: 'my-trace.bin' });
await tracer.init();

export function write(iid, name, val) {
    tracer.trace({
        type: 'END_EXPR', iid, seq: 0,
        writes: [{ name, val }], reads: [], fields: [],
    });
    return { result: val };
}

export async function endExecution() {
    await tracer.close();
    // 生成 my-trace.bin 和（如有 smap）my-trace.smap.json
}
```

---

## 12. 典型配置场景

### 场景一：Node.js 单次分析，结果存文件

```js
const tracer = new TraceLogger({ nodeFile: 'trace.bin' });
await tracer.init();
// ... 分析运行 ...
await tracer.close();
// 解码文件：node tools/trace-parse.mjs trace.bin --smap trace.smap.json
```

### 场景二：浏览器高频插桩，实时传输到 JTA Server / trace server

```js
// 方式 A：JTA Server（推荐，端口 33000，含 UI 可直接触发分析）
// 服务端：npm run analyzer
const tracer = new TraceLogger({
    wsUrl:    'ws://localhost:33000/ws/trace',
    wsWorker: true,     // 推荐：Worker 线程发送，不阻塞主线程
    wsFormat: 'binary', // 高吞吐（JTB1）
});
tracer.init();

// 方式 B：独立 trace server（轻量，无 UI）
// 服务端：node tools/trace-server/server.mjs
const tracer = new TraceLogger({
    wsUrl:    'ws://localhost:9229/trace',
    wsWorker: true,
    wsFormat: 'binary',
});
tracer.init();
```

### 场景三：极高频 + SharedArrayBuffer（需 COOP/COEP）

```js
const tracer = new TraceLogger({
    wsUrl:   'ws://localhost:33000/ws/trace',
    wsSab:   true,   // 使用 SAB 零拷贝（WsBackend 内部 mode='sab'）
    // 若环境不支持 SAB，自动降级到 worker 模式
});
tracer.init();
```

### 场景四：仅浏览器内 IndexedDB 存储，不传输

```js
const tracer = new TraceLogger({
    useIdb:    true,
    dbName:    'my-analysis',
    storeName: 'trace-events',
    // 无 wsUrl，不建立 WebSocket 连接
});
await tracer.init();
```

### 场景五：测试（内存后端）

```js
import { createMemoryLogManager } from '../../logger/LogManager.js';

const { mgr, backend } = await createMemoryLogManager();

mgr.push({ type: 'END_EXPR', iid: 8, seq: 1, writes: [{ name: 'x', val: 42 }], reads: [], fields: [] });
await mgr.flush();

const events = backend.getEvents();
assert.strictEqual(events[0].type, 'END_EXPR');
```

---

## 13. 注意事项 & 常见问题

### `forceSyncFlushThreshold` 的用途

LogManager 的 `forceSyncFlushThreshold` 选项是**验证工具**，不是生产配置。
它让每 N 条事件在插桩回调内同步 flush，用于验证"主线程繁忙时数据是否能及时发送"。
生产环境中，异步 flush（`queueMicrotask`）才是正确选择，同步 flush 会增加毫秒级延迟。

### WsBackend SAB 模式的 `slotDataBytes` 选择

每个槽的大小决定单个 batch 序列化后的最大字节数：
- `binary` 格式（JTB1）：约 12～30 字节/条，256 条 ≈ 4～8KB，64KB 默认值足够
- `ndjson` 格式：约 100～300 字节/条，32 条 ≈ 6KB，建议设为 `2 * 1024 * 1024`（2MB）

`TraceLogger` 已针对 `ndjson` 格式自动放大 `slotDataBytes`，无需手动配置。

### NodeStreamBackend 不支持追加模式

二进制 JTB1 格式要求文件头位于文件开头，因此**不支持** `append: true`（总是覆盖写）。
如需合并多次运行的 trace，应在后处理阶段拼接，而非直接追加文件。

### .smap.json 写出失败

`_writeSmapJson()` 内部使用 `writeFileSync` 同步写出，写出失败只打印 `log.error` 日志而不抛出异常。
可通过 `JALANGI_DEBUG=backend:node` 开启调试日志查看详情。

### 页面刷新时数据丢失问题

浏览器 `beforeunload` / `pagehide` 时，异步后端（IDB）可能来不及写入。
解决方案：
1. 在 `endExecution` 中调用 `await tracer.close()`
2. 对于 WebSocket 后端，`writeSync()` 会尽力发送（fire-and-forget）
3. 对于 IDB 后端，考虑使用 `navigator.sendBeacon` 或 `fetch` + `keepalive`

### 单测中速率限制干扰

单测中多个用例共享速率状态，可能导致"第一个用例消耗完配额，后续用例日志被抑制"。
解决：在每个用例的 `afterEach` / `teardown` 中调用 `resetRateLimiters()`。

### 迁移指南（从旧版本）

| 旧 API | 新 API | 说明 |
|--------|--------|------|
| `import ... from 'logger/logger.js'` | `import ... from 'logger/diagnostics.js'` | 文件重命名 |
| `createLogger(domain)` | `createDiagLogger(domain)` | 函数重命名 |
| `DOMAIN.LOGGING` | `DOMAIN.TRACE_INFRA` | 常量重命名 |
| `mgr.log(event)` | `mgr.push(event)` | 方法重命名 |
| `import ... from 'logger/backends/MemoryBackend.js'` | `import ... from 'logger/transport/MemoryBackend.js'` | 目录重组 |
| `import ... from 'logger/backends/WsBackend.js'` | `import ... from 'logger/transport/WsBackend.js'` | 目录重组，三变一 |
| `new WsWorkerBackend(opts)` | `new WsBackend({ ...opts, mode: 'worker' })` | 合并入 WsBackend |
| `new WsSabBackend(opts)` | `new WsBackend({ ...opts, mode: 'sab' })` | 合并入 WsBackend |
| `import ... from 'logger/EventSerializer.js'` | `import ... from 'encoding/EventSerializer.js'` | 移至独立模块 |
| `NodeStreamBackend({ path: 'x.ndjson' })` | `NodeStreamBackend({ path: 'x.bin' })` | 格式由 NDJSON 改为 JTB1 二进制 |
| `serializeBatchToNDJSON(events)` | `serializeBatch(events)` | NDJSON 已废弃，改用 JTB1 二进制 |
| `serializeBatchToBinary(events)` | `serializeBatch(events)` | 旧 batch 格式已删除，改为流式排列 |

> **注**：旧版 `serializeBatchToNDJSON`、`serializeBatchToBinary`、`deserializeBatchFromBinary`、`serializeEventToJSON`、`deserializeEventFromBinary` 等废弃 API 已从代码库完全移除。

---

## 14. 扩展：自定义后端

实现 `LogBackend` 接口即可：

```js
class MyCustomBackend {
    constructor(options) {
        this._options = options;
        this.stats = { batchCount: 0, totalEvents: 0 };
    }

    async write(batch) {
        // 将 batch 写入你的目标存储
        for (const ev of batch) {
            // 处理每条事件...
        }
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
    }

    async flush() {
        // 确保缓冲落盘（如有）
    }

    async close() {
        // 关闭连接/资源
    }

    // 可选：同步写入（用于 beforeunload 等不能 await 的场景）
    writeSync(batch) {
        // 尽力写入，不保证完成
    }
}

// 使用
import { LogManager } from '../../logger/LogManager.js';
const mgr = new LogManager({ backends: [new MyCustomBackend({ ... })] });
```

---

## 15. Trace 接收服务

### 集成到 JTA Server（推荐）

Trace 接收功能已集成到 **JTA Server**（`analyzer/server.mjs`），使用统一端口 **33000**，WebSocket 端点为 `/ws/trace`：

```bash
# 启动 JTA Server（同时提供 HTTP API、WebSocket 分析进度 + Trace 接收）
npm run analyzer

# 浏览器端 TraceLogger 连接
const tracer = new TraceLogger({
    wsUrl: 'ws://localhost:33000/ws/trace',
    wsWorker: true,
});
```

JTA Server 收到的 `.bin` 文件写入 `analyzer/data/uploads/` 目录，可在 JTA UI 中直接触发分析。

### 独立 Trace Server（`tools/trace-server/server.mjs`）

如需在不启动完整 JTA 的情况下独立接收 trace，可使用轻量独立服务器：

> 依赖 `src/encoding/EventSerializer.js` 进行 JTB1 二进制帧解析。

```bash
# 默认启动（端口 9229，输出目录 traces/，启动时清空目录中的旧 .bin 文件）
npm run trace-server

# 自定义端口和输出目录
node tools/trace-server/server.mjs --port 9230 --out my-traces

# 保留历史文件（不清空）
node tools/trace-server/server.mjs --no-clear

# 查看所有选项
node tools/trace-server/server.mjs --help
```

#### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port <number>` | `9229` | WebSocket 监听端口 |
| `--out <dir>` | `traces` | 输出**目录**路径（每个连接写入独立 `.bin` 文件） |
| `--clear` | 开启 | 启动时删除输出目录中的所有 `.bin` 和 `.smap.json` 文件；`--no-clear` 跳过清空 |
| `--max-payload <MB>` | `0`（无限制）| 最大单条消息体积（MB） |
| `--verbose` | 关闭 | 打印每个 batch 的接收日志（含目标文件名） |
| `--help` | — | 显示帮助信息 |

### 传输协议（两种服务通用）

客户端（`WsBackend`）发送二进制帧，格式为：

```
[u32 batchId LE][JTB1 事件流（无文件头，直接事件序列）]
```

服务端收到后回复 ACK（4 字节 `u32 batchId LE`）。

### 每连接独立文件（会话隔离）

每个 WebSocket 连接对应一个独立的输出 `.bin` 文件，不同会话（页面刷新、多个 Tab、多次分析）的数据**不会混写**到同一文件中。

**文件命名格式**：

```
traces/trace_<YYYYMMDD>_<HHmmss>_<ms>_<seq>.bin
```

示例：

```
traces/trace_20260314_153042_123_001.bin   ← 第 1 个连接
traces/trace_20260314_153043_456_002.bin   ← 第 2 个连接（页面刷新后）
```

**文件格式**：服务端首次写入时生成 JTB1 文件头（8B），随后将每批收到的事件流追加到文件中：

```
[8B 文件头：魔数 JTB1 + 版本]
[12B 事件头 + payload]   ← 批次 1 事件
[12B 事件头 + payload]   ← 批次 2 事件
...
```

### 后处理

收到的 `.bin` 文件可直接用后处理工具链分析：

```bash
# 解码并以树形格式渲染
node tools/trace-parse.mjs traces/trace_*.bin | node tools/trace-render.mjs --format tree

# 过滤特定事件类型
node tools/trace-parse.mjs traces/trace_*.bin | node tools/trace-filter.mjs --type CALL_PRE

# 带 smap 解析源码位置
node tools/trace-parse.mjs traces/trace_*.bin --smap traces/trace_*.smap.json

# io 格式查看语句级输入/输出变量
node tools/trace-parse.mjs traces/trace_*.bin --smap traces/trace_*.smap.json \
  | node tools/trace-render.mjs --format io
```

## v4 完整性约束

有限 RingBuffer 达到上限时拒绝新事件并统计 totalDropped，不覆盖未读事件；
LogManager 默认最多积压 1,048,576 条（可配置 maxCapacity）。异步批次按顺序写入；显式 flush/close 会抛出后端错误。
ExecutionTrace.close 发出 TRACE_END；endExecution 不表示异步任务全部结束。
JTB1 v4 在 payload 尾部追加长度前缀 JSON 元数据，携带动态身份与读写绑定 ID；新版保留 v1–v3 解码。
