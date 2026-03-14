# Logger 日志系统

> 源码路径：`src/logger/`

---

## 1. 系统概述

Jalangi2 的日志系统服务于两类截然不同的需求：

| 需求 | 特征 | 处理方式 |
|------|------|----------|
| **诊断日志** | 低频、可读性优先（模块启停、错误告警） | `logger.js` → `console.*` 直接输出，含速率限制 |
| **Trace 数据** | 高频（每个插桩钩子都可能产生）、需持久化 | `LogManager` 缓冲 → 后端异步批量写入 |

两类数据**完全隔离**：Trace 数据不走 `console`，诊断日志不写 IDB / 文件。

### 模块一览

```
src/logger/
├── logger.js               诊断日志工厂（createLogger、速率限制、Debug 开关）
├── LogManager.js           事件缓冲与后端分发（RingBuffer → backends）
├── TraceLogger.js          Trace 数据的高层门面（按环境自动选后端）
├── RingBuffer.js           单线程环形缓冲区（极低开销的同步 push）
├── EventSerializer.js      事件序列化（NDJSON 和自定义二进制格式）
├── backends/
│   ├── MemoryBackend.js    内存后端（测试用）
│   ├── NodeStreamBackend.js Node.js 文件流后端（NDJSON 写文件）
│   ├── WsBackend.js        WebSocket 后端（主线程，含窗口背压+ACK）
│   ├── WsWorkerBackend.js  WebSocket 后端（发送放入 Web Worker）
│   └── WsSabBackend.js     WebSocket 后端（SharedArrayBuffer 零拷贝）
└── workers/
    ├── idb-worker.js       IDB Worker 脚本（Classic Worker，无 import）
    ├── ws-worker.js        WsWorkerBackend 的 Worker 脚本
    └── ws-worker-sab.js    WsSabBackend 的 Worker 脚本（读 SAB 环形缓冲区）
```

### 层次结构与数据流

```
插桩代码 / 分析插件
        │  高频调用
        ▼
  TraceLogger.trace()   ← 初始化前 → _preInitQueue 暂存
        │ 就绪后
        ▼
   LogManager.log()
        │  push（同步，极低开销）
        ▼
    RingBuffer
        │  积累到 flushThreshold 后 scheduleAsync → _doFlush()
        ▼
  backend.write(batch)  ─── 可同时分发给多个后端 ───►
        ├── MemoryBackend        (测试)
        ├── NodeStreamBackend    (Node.js 文件)
        ├── WsBackend            (主线程 WebSocket)
        ├── WsWorkerBackend      (Worker 线程 WebSocket)
        └── WsSabBackend         (SharedArrayBuffer + Worker)
```

---

## 2. `logger.js` — 诊断日志工厂

### 职责

- 为各模块提供带**域名前缀**的 `error / warn / info / debug` 四级日志对象
- 内置**速率限制**（防止高频场景刷屏），按域独立计算，超限后采样输出
- 通过环境变量（Node.js）或 localStorage（浏览器）控制 `debug` 级别的开关

### 使用方式

```js
import { createLogger, DOMAIN } from '../../logger/logger.js';

const log = createLogger(DOMAIN.BACKEND_WS);   // 或直接传字符串 'backend:ws'

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
import { DOMAIN } from '../../logger/logger.js';

DOMAIN.FRAMEWORK    // 'framework'   — JalangiRuntime, HookDispatcher
DOMAIN.INSTRUMENT   // 'instrument'  — esnstrument, astUtil
DOMAIN.LOGGING      // 'logging'     — LogManager, TraceLogger
DOMAIN.BACKEND_IDB  // 'backend:idb' — IdbWorkerBackend
DOMAIN.BACKEND_WS   // 'backend:ws'  — WsBackend / WsWorkerBackend / WsSabBackend
DOMAIN.BACKEND_NODE // 'backend:node'— NodeStreamBackend
DOMAIN.BACKEND_MEM  // 'backend:mem' — MemoryBackend
DOMAIN.ANALYSIS     // 'analysis'    — 分析插件业务日志
```

### 速率限制配置

```js
import { setRateLimit, resetRateLimiters } from '../../logger/logger.js';

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
    flushIntervalMs:           0,       // 定时 flush 间隔（0 = 禁用）
    drainBatchSize:            1024,    // 每次 drain 最多取多少条
    autoClose:                 true,    // 是否自动绑定关闭钩子
    forceSyncFlushThreshold:   0,       // 【验证用】累计 N 条后在 log() 中同步 flush（0 = 禁用）
});
```

### 主要 API

```js
// 写入一条事件（同步，分析钩子里调用）
mgr.log({ type: 'READ', iid, sid, name, value });

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

### 便捷工厂函数

```js
import { createMemoryLogManager, createLogManager } from '../../logger/LogManager.js';

// 测试用：MemoryBackend
const { mgr, backend } = await createMemoryLogManager();

// 根据后端类型名称创建（自动 import 对应模块）
const mgr = await createLogManager('idb',         { dbName: 'my-db' });
const mgr = await createLogManager('ws',          { url: 'ws://localhost:9229/trace' });
const mgr = await createLogManager('node-stream', { path: 'trace.ndjson' });
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

### 构造参数

```js
import { TraceLogger } from '../../logger/TraceLogger.js';

// 浏览器（IDB + WebSocket）
const logger = new TraceLogger({
    // 浏览器选项
    useIdb:      true,                        // 是否启用 IndexedDB 后端
    dbName:      'jalangi-traces',
    storeName:   'execution-trace',
    wsUrl:       'ws://localhost:9229/trace', // 可选：同时推送到 WebSocket
    wsSab:       false,    // 是否使用 SharedArrayBuffer 模式（需 COOP/COEP header）
    wsWorker:    true,     // 是否将 WebSocket 放入 Web Worker（推荐）
    wsFormat:    'binary', // 'binary'（高吞吐）或 'ndjson'（可读性）

    // Node.js 选项
    nodeFile:    'jalangi-trace.ndjson',  // false = 只用控制台
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
  ├─ wsSab=true 且 WsSabBackend.isSupported() → WsSabBackend（零拷贝）
  ├─ wsWorker=true（默认）                    → WsWorkerBackend（Worker 发送）
  └─ wsWorker=false                           → WsBackend（主线程，调试用）

不满足 SAB 条件时自动降级（控制台 warn 提示）
```

### 主要 API

```js
// 写普通 trace（高频路径，走 LogManager）
logger.trace({ type: 'trace', seq: 42, text: '[1:5] const x ...' });

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

### Pre-init 缓冲机制

```
new TraceLogger(...)  →  _preInitQueue = []

logger.trace(ev)  [init 尚未完成]  →  _preInitQueue.push({ kind:'trace', event: ev })
logger.key(...)   [init 尚未完成]  →  _preInitQueue.push({ kind:'key', ... })

_doInit() 完成  →  _flushPreInitQueue()
                      ├─ 遍历队列，将所有事件 replay 到 _mgr
                      └─ _preInitQueue = null  （标记已完成）
```

---

## 6. `EventSerializer.js` — 事件序列化

支持两种序列化格式，后端根据 `format` 选项选择：

### NDJSON 格式

```
每条事件 → 一行 JSON（'\n' 分隔）
```

适合：`NodeStreamBackend`（文件分析）、`WsBackend`（调试，可读性优先）

```js
import { serializeBatchToNDJSON, serializeEventToJSON } from '../../logger/EventSerializer.js';

const text = serializeBatchToNDJSON(events);  // 返回多行 NDJSON 字符串
```

文件可直接用 `jq` 分析：
```bash
jq 'select(.type=="READ")' jalangi-trace.ndjson
```

### 二进制格式

每条事件编码为固定 16 字节头部 + 可选变长负载：

```
字节偏移  长度  内容
[0]       u8   事件类型（EVENT_TYPE.*）
[1]       u8   flags（保留）
[2..5]    u32  iid（小端）
[6..9]    u32  sid（小端）
[10]      u8   值类型（null/undefined/bool/number/string/object/function）
[11]      u8   保留
[12..15]  u32  变长负载长度
[16..]         变长负载（number=8字节 float64，string/object/function=UTF-8字节）
```

批次格式（多条合并）：`[u32 count][u32 size0][event0][u32 size1][event1]...`

适合：`WsWorkerBackend` / `WsSabBackend`（高吞吐，约 16 字节/条 vs NDJSON 的 100~300 字节/条）

```js
import { serializeBatchToBinary, deserializeBatchFromBinary } from '../../logger/EventSerializer.js';
import { EVENT_TYPE } from '../../logger/EventSerializer.js';

const buf    = serializeBatchToBinary(events);   // → ArrayBuffer
const events = deserializeBatchFromBinary(buf);  // 反序列化（服务端/测试用）
```

---

## 7. 后端接口规范（LogBackend）

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

## 8. 各后端详解

### 8.1 `MemoryBackend`

最简单的后端，所有事件保存在内存数组中，**仅用于测试**。

```js
import { MemoryBackend } from '../../logger/backends/MemoryBackend.js';

const backend = new MemoryBackend();
// 写入后查询
const all      = backend.getEvents();
const reads    = backend.getEventsOfType('READ');
backend.clear();  // 清空
```

### 8.2 `NodeStreamBackend`

Node.js 专用，通过 `fs.WriteStream` 将事件序列化为 NDJSON 写入文件。

```js
import { NodeStreamBackend } from '../../logger/backends/NodeStreamBackend.js';

const backend = new NodeStreamBackend({
    path:          'jalangi-trace.ndjson',  // 或传入 stream: existingWritable
    append:        true,           // false = 覆盖
    highWaterMark: 65536,          // WriteStream 缓冲上限（字节）
    autoFlush:     false,          // 每批后调用 flush（增加 syscall）
});
```

背压处理：`write()` 检测 `stream.writableNeedDrain`，背压时等待 `drain` 事件。

### 8.3 `WsBackend`（主线程 WebSocket）

在**主线程**中持有 WebSocket 连接，适合低频场景或调试用途。

```js
import { WsBackend } from '../../logger/backends/WsBackend.js';

const backend = new WsBackend({
    url:              'ws://127.0.0.1:9229/trace',
    format:           'binary',   // 'binary' | 'ndjson'
    windowSize:       4,          // 未确认批次数上限（背压窗口）
    maxRetries:       10,         // 最大重连次数（-1 = 永远重连）
    retryBaseMs:      500,        // 初始重连等待（ms），指数退避
    retryMaxMs:       30000,
    connectTimeoutMs: 10000,
    autoConnect:      true,
    replayOnReconnect: true,      // 重连后重发未确认批次
});
```

**背压控制（滑动窗口 ACK）**：
- 服务端每收到一批次返回 ACK（二进制：4 字节 batchId；或 JSON：`{ type:'ack', batchId }`）
- 主线程维护 `_inFlight` Map，未收 ACK 的批次数达到 `windowSize` 时暂停发送

**自动重连（指数退避）**：
- 连接断开后按 `retryBaseMs × 2^n` 等待重连，最大等待 `retryMaxMs`
- 重连成功后可自动重发所有未确认的批次

### 8.4 `WsWorkerBackend`（Worker 线程 WebSocket）

将 WebSocket 的 `send()` 操作迁移到 **Web Worker 独立线程**，主线程只需 `postMessage`。

```
主线程                               ws-worker.js (Worker)
  │  postMessage({cmd:'write', data})        │
  │ ─────────────────────────────────────►  │
  │  [立即返回，微秒级]                      │  ws.send(data)
  │                                          │ ──────────────► 服务端
  │  ◄─────────────────────────────────────  │
  │  onmessage({type:'ack', batchId})        │  服务端 ack → Worker → postMessage
```

**与 WsBackend 的核心差异**：
- 主线程高负载时，`postMessage` 几乎不阻塞（写入 Worker 消息队列，微秒级）
- `ws.send()` 在 Worker 的事件循环中执行，不受主线程阻塞影响

```js
import { WsWorkerBackend } from '../../logger/backends/WsWorkerBackend.js';

const backend = new WsWorkerBackend({
    url:         'ws://127.0.0.1:9229/trace',
    format:      'binary',
    windowSize:  16,   // Worker 侧的 in-flight 窗口
    autoConnect: true,
});
await backend.connect();
```

**数据传输零拷贝**：`ArrayBuffer` 通过 `Transferable` 传入 Worker，不做结构化克隆拷贝。

### 8.5 `WsSabBackend`（SharedArrayBuffer 零拷贝）

最高性能的 WebSocket 后端，主线程通过 **Atomics 原子操作**直接写入共享环形缓冲区，
Worker 通过 `Atomics.waitAsync` 等待新数据并调用 `ws.send()`。

**要求**：页面需开启 COOP + COEP 响应头：
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
不满足时 `WsSabBackend.isSupported()` 返回 `false`，`TraceLogger` 会自动降级到 `WsWorkerBackend`。

**与 WsWorkerBackend 的差异**：

| 维度 | WsWorkerBackend | WsSabBackend |
|------|----------------|--------------|
| 主→Worker 通信 | `postMessage`（结构化克隆，微秒级但有拷贝） | `Atomics.store` + `Atomics.notify`（真原子写，纳秒级） |
| 依赖 JS 事件循环 | 是（Worker 的 `onmessage`） | 否（Worker 用 `Atomics.waitAsync` 解耦） |
| 适用场景 | 高频 trace，通用 | 极高频 trace，主线程极度繁忙 |
| 背压保证 | 无（队列积压） | 有（缓冲区满时 write() 等待或丢弃） |

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

```js
import { WsSabBackend } from '../../logger/backends/WsSabBackend.js';

if (!WsSabBackend.isSupported()) {
    console.warn('SAB not available, use WsWorkerBackend instead');
}

const backend = new WsSabBackend({
    url:                  'ws://127.0.0.1:9229/trace',
    format:               'binary',
    slotCount:            64,      // 环形缓冲区槽数
    slotDataBytes:        65536,   // 每槽最大字节数（64KB ≈ 256 条二进制事件）
    backpressureTimeoutMs: 200,    // write() 等待空槽超时（超时则丢弃并记录 warn）
});
```

---

## 9. Worker 脚本

三个 Worker 脚本均为 **Classic Worker**（无 `import`，自包含），原因是 Blob URL 不支持 Module Worker。

| 文件 | 对应后端 | 功能 |
|------|----------|------|
| `idb-worker.js` | `IdbWorkerBackend` | 持有 IDB 连接，接收 `writeVar` 批次写入 IndexedDB；支持 `flush`/`query`/`clear`/`close` |
| `ws-worker.js` | `WsWorkerBackend` | 持有 WebSocket 连接，接收已序列化的数据帧直接 `ws.send()`；转发服务端 ACK 回主线程 |
| `ws-worker-sab.js` | `WsSabBackend` | 轮询读取 SAB 环形缓冲区，调用 `ws.send()` 发送，消费后递增 `readSeq` 并 `Atomics.notify` 唤醒等待的主线程 |

### Worker 加载策略

源码中通过 `new URL('../workers/xxx.js', import.meta.url)` 引用 Worker 脚本。
在浏览器 bundle 场景下，`bin/jalangi.mjs` 的 Rollup 插件会将此表达式替换为预创建的 Blob URL，
避免 Module Worker 不支持 `blob:` URL 导致的 15 秒超时问题。

### `idb-worker.js` 消息协议

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

## 10. 在分析插件中使用日志系统

### 最简使用（只需诊断日志）

```js
import { createLogger, DOMAIN } from '../../logger/logger.js';

const log = createLogger(DOMAIN.ANALYSIS);

export function read(iid, name, val, isGlobal, isScriptLocal) {
    log.debug('read', name, '=', val);
    return { result: val };
}
```

### 使用 TraceLogger 收集 Trace 数据（浏览器）

```js
import { TraceLogger } from '../../logger/TraceLogger.js';

const tracer = new TraceLogger({
    wsUrl:    'ws://localhost:9229/trace',
    wsWorker: true,
});
tracer.init();  // 不 await，事件自动缓冲

let seq = 0;

export function read(iid, name, val) {
    tracer.trace({ type: 'READ', iid, name, value: val, seq: seq++ });
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

const tracer = new TraceLogger({ nodeFile: 'my-trace.ndjson' });
await tracer.init();

export function write(iid, name, val) {
    tracer.trace({ type: 'WRITE', iid, name, value: val });
    return { result: val };
}

export async function endExecution() {
    await tracer.close();
}
```

---

## 11. 典型配置场景

### 场景一：Node.js 单次分析，结果存文件

```js
const tracer = new TraceLogger({ nodeFile: 'trace.ndjson' });
await tracer.init();
// ... 分析运行 ...
await tracer.close();
// 分析文件：jq 'select(.type=="READ")' trace.ndjson
```

### 场景二：浏览器高频插桩，实时传输到 trace server

```js
// 服务端：node tools/trace-server/server.mjs
const tracer = new TraceLogger({
    wsUrl:    'ws://localhost:9229/trace',
    wsWorker: true,     // 推荐：Worker 线程发送，不阻塞主线程
    wsFormat: 'binary', // 高吞吐
});
tracer.init();
```

### 场景三：极高频 + SharedArrayBuffer（需 COOP/COEP）

```js
const tracer = new TraceLogger({
    wsUrl:   'ws://localhost:9229/trace',
    wsSab:   true,   // 使用 SAB 零拷贝
    // 若环境不支持 SAB，自动降级到 WsWorkerBackend
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

// 后续查询（通过 IdbWorkerBackend）
const idbBackend = /* 从 tracer 内部获取或单独创建 */;
const reads = await idbBackend.query({ type: 'READ' }, 1000);
```

### 场景五：测试（内存后端）

```js
import { createMemoryLogManager } from '../../logger/LogManager.js';

const { mgr, backend } = await createMemoryLogManager();

mgr.log({ type: 'READ', iid: 8, sid: 1, name: 'x', value: 42 });
await mgr.flush();

const events = backend.getEvents();
assert.strictEqual(events[0].type, 'READ');
```

---

## 12. 注意事项 & 常见问题

### `forceSyncFlushThreshold` 的用途

LogManager 的 `forceSyncFlushThreshold` 选项是**验证工具**，不是生产配置。
它让每 N 条事件在插桩回调内同步 flush，用于验证"主线程繁忙时数据是否能及时发送"。
生产环境中，异步 flush（`queueMicrotask`）才是正确选择，同步 flush 会增加毫秒级延迟。

### WsSabBackend 的 `slotDataBytes` 选择

每个槽的大小决定单个 batch 序列化后的最大字节数：
- `binary` 格式：约 16 字节/条，256 条 ≈ 4KB，64KB 默认值足够
- `ndjson` 格式：约 100～300 字节/条，32 条 ≈ 6KB，建议设为 `2 * 1024 * 1024`（2MB）

`TraceLogger` 已针对 `ndjson` 格式自动放大 `slotDataBytes`，无需手动配置。

### 页面刷新时数据丢失问题

浏览器 `beforeunload` / `pagehide` 时，异步后端（IDB）可能来不及写入。
解决方案：
1. 在 `endExecution` 中调用 `await tracer.close()`
2. 对于 WebSocket 后端，`writeSync()` 会尽力发送（fire-and-forget）
3. 对于 IDB 后端，考虑使用 `navigator.sendBeacon` 或 `fetch` + `keepalive`

### 单测中速率限制干扰

单测中多个用例共享速率状态，可能导致"第一个用例消耗完配额，后续用例日志被抑制"。
解决：在每个用例的 `afterEach` / `teardown` 中调用 `resetRateLimiters()`。

---

## 13. 扩展：自定义后端

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

## 14. Trace Server（`tools/trace-server/server.mjs`）

Trace Server 是一个独立的 Node.js WebSocket 服务器，负责接收来自浏览器端 `WsBackend` 推送的事件批次，并将其持久化到本地文件。

### 启动

```bash
# 默认启动（端口 9229，输出目录 traces/，启动时清空目录中的旧 .ndjson 文件）
npm run trace-server

# 自定义端口和输出目录
node tools/trace-server/server.mjs --port 9230 --out my-traces

# 保留历史文件（不清空）
node tools/trace-server/server.mjs --no-clear

# 输出完整 NDJSON（默认只保存 trace 事件的 text 字段）
node tools/trace-server/server.mjs --no-text-only

# 查看所有选项
node tools/trace-server/server.mjs --help
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port <number>` | `9229` | WebSocket 监听端口 |
| `--out <dir>` | `traces` | 输出**目录**路径（每个连接写入独立文件） |
| `--format <mode>` | `binary` | 接收格式：`binary`（高吞吐）或 `ndjson` |
| `--text-only` | 开启 | trace 类型事件只写 `text` 字段；`--no-text-only` 输出完整 JSON |
| `--clear` | 开启 | 启动时删除输出目录中的所有 `.ndjson` 文件；`--no-clear` 跳过清空 |
| `--max-payload <MB>` | `0`（无限制）| 最大单条消息体积（MB） |
| `--verbose` | 关闭 | 打印每个 batch 的接收日志（含目标文件名） |
| `--help` | — | 显示帮助信息 |

### 每连接独立文件（会话隔离）

每个 WebSocket 连接对应一个独立的输出文件，不同会话（页面刷新、多个 Tab、多次分析）的数据**不会混写**到同一文件中。

**文件命名格式**：

```
traces/trace_<YYYYMMDD>_<HHmmss>_<ms>_<seq>.ndjson
```

示例：

```
traces/trace_20260314_153042_123_001.ndjson   ← 第 1 个连接
traces/trace_20260314_153043_456_002.ndjson   ← 第 2 个连接（页面刷新后）
```

**连接生命周期与文件对应关系**：

```
客户端连接  → 创建新文件，打印文件路径
           →   [server] Client connected: ::1 (total: 1)
           →   [server]   → Writing to: /path/to/traces/trace_20260314_153042_123_001.ndjson
数据传输中  → 事件写入对应文件
客户端断开  → 关闭文件流，打印事件总数
           →   [server] Client disconnected: ::1 (code=1001, active: 0)
           →   [server]   → Trace saved: /path/.../trace_20260314_153042_123_001.ndjson (1234 events)
```

### HTTP 端点

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查，返回 `{ status: 'ok', ...stats }` |
| `GET /stats` | 统计信息（连接数、批次数、事件数、字节数、错误数）|

### 输出格式

**默认（`--text-only`，推荐）**：`trace` 类型事件只写入 `text` 字段的纯文本，
其他类型事件（如 `key`）仍写为 JSON 行。可直接用 `grep` / `cat` 阅读。

**`--no-text-only`**：所有事件统一输出为 NDJSON（一行一个 JSON 对象），可用 `jq` 直接分析：

```bash
# 过滤 read 事件
cat traces/trace_*.ndjson | jq 'select(.type == "read")'
```
