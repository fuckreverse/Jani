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
        │  积累到 flushThreshold 后 scheduleAsync → _doFlush()
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
    flushIntervalMs:           0,       // 定时 flush 间隔（0 = 禁用）
    drainBatchSize:            1024,    // 每次 drain 最多取多少条
    autoClose:                 true,    // 是否自动绑定关闭钩子
    forceSyncFlushThreshold:   0,       // 【验证用】累计 N 条后在 push() 中同步 flush（0 = 禁用）
});
```

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
    wsUrl:       'ws://localhost:9229/trace', // 可选：同时推送到 WebSocket
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
| `0x0A` | `DICT_ENTRY` | `[dictSeq u32][id u16][str u16+UTF8]`（字典压缩条目，见下文）|
| `0x0B` | `WRITE_VAR` | `[name u16+UTF8][val]` |
| `0x0C` | `READ_VAR_FULL` | `[name u16+UTF8][val]` |

`END_EXPR` 是最高频的事件类型，编码了一条表达式语句的所有读写操作：
- **writes**：`[name u16+UTF8][val]` × wCount
- **reads**：`[name u16+UTF8][val]` × rCount（val 可能是 `OMITTED`）
- **fields**：`[base u16+UTF8][offset u16+UTF8][isWrite u8][val]` × fCount

`DICT_ENTRY` 是字典压缩条目（见下文「字典压缩」节），在使用 `EventSerializerWithPool` 时，
每个首次出现的高频字符串会先以 `DICT_ENTRY` 形式写入字典，后续出现则替换为 `VALUE_TYPE.STRING_REF`（2 字节 ID）引用，大幅压缩重复字符串的体积。

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
| `0x0A` | `STRING_REF` | u16 字典 ID（需在对应 `DICT_ENTRY` 中查找实际字符串） |

#### 值省略（FAI 优化）

当静态分析确定某 read-site 对应唯一 def-site 时（`Decision.LIGHTWEIGHT`），
值编码为 `VALUE_TYPE.OMITTED`（1 字节），节省写入开销。
后处理工具加载 `.smap.json` 后，通过 `smap[iid].defIid` 追溯到对应 write 事件的实际值。

### 主要 API

```js
import {
    // 序列化（无状态）
    serializeEvent,       // 单条事件 → ArrayBuffer（含 12B 头 + payload）
    serializeBatch,       // 事件数组 → ArrayBuffer（紧密排列，无分隔符）
    createFileHeader,     // 创建 8 字节文件头（含魔数和版本）

    // 序列化（有状态，字典压缩）
    StringPool,               // 字符串池（追踪高频字符串，生成 DICT_ENTRY 事件）
    EventSerializerWithPool,  // 有状态序列化器，自动插入 DICT_ENTRY 并用 STRING_REF 引用

    // 反序列化
    deserializeEvent,     // 从 DataView offset 处读取一条事件；可传 dict Map 用于 STRING_REF 解码
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

### 字典压缩（Value Pool / Dictionary Compression）

当同一字符串（变量名、属性名、文件名等）在 trace 中频繁重复出现时，可启用 **字典压缩** 模式，
将重复字符串替换为 2 字节的整数 ID（`VALUE_TYPE.STRING_REF`），显著减少文件体积。

#### 工作原理

1. **写入侧**（`EventSerializerWithPool`）：
   - 每个 `serializeBatch()` 调用前，`StringPool` 扫描本批次事件，统计字符串出现频次
   - 满足阈值（默认：长度 ≥ 4 字节、至少出现过 2 次）的字符串注册到池，分配全局唯一 ID
   - 新注册的字符串在当前批次**前**以 `DICT_ENTRY` 事件（`EVENT_TYPE = 0x0A`）写入
   - 后续事件中该字符串的字段（name、base、offset 等）以 `VALUE_TYPE.STRING_REF`（1B 类型 + 2B ID）编码，代替原来的 `u16+UTF-8` 字节序列

2. **读取侧**（`deserializeEvent` + `dict` 参数）：
   - 解码时维护一个 `Map<id, string>` 字典
   - 遇到 `DICT_ENTRY` 事件时将 `id → str` 写入字典（该事件不输出为用户可见事件）
   - 遇到 `STRING_REF` 时从字典中查找，还原为原始字符串
   - 离线工具（`trace-parse.mjs`）自动处理字典，对用户完全透明

#### 使用方式

**写入侧（NodeStreamBackend 启用压缩）**：

```js
const backend = new NodeStreamBackend({
    path:    'jalangi-trace.bin',
    usePool: true,   // 启用字典压缩（EventSerializerWithPool）
});
```

**写入侧（WsBackend 主线程模式启用压缩）**：

```js
// 仅 mode='main' 支持 usePool；mode='worker'/'sab' 不支持（帧通信限制）
const backend = new WsBackend({ url, mode: 'main', format: 'binary', usePool: true });
// 查看压缩统计
console.log(backend.getPoolStats()); // { dictSize, totalStrings, totalRefs, savedBytes, ... }
```

**读取侧（手动解码，支持字典）**：

```js
import { deserializeEvent, EVENT_TYPE } from '../../encoding/EventSerializer.js';
import { readFileSync } from 'node:fs';

const buf = readFileSync('trace.bin');
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const dict = new Map();   // 维护字典状态
let offset = 8;           // 跳过文件头
while (offset < view.byteLength) {
    const { event, nextOffset } = deserializeEvent(view, offset, dict);
    offset = nextOffset;
    if (event.type === 'DICT_ENTRY') continue; // 字典条目已自动写入 dict，跳过输出
    // 此时 event 中所有字符串字段已自动还原
    console.log(event);
}
```

#### 压缩效果

字典压缩对高频重复字符串（如变量名 `myLongVarName`、属性名 `prototype`）效果最显著。
典型场景（有效字符串长度 8 字节、出现 100 次）：
- 未压缩：每次 `2B(len) + 8B(data)` = 10 字节，合计 1000 字节
- 压缩后：`DICT_ENTRY` 一次 `~14B` + 每次引用 `1B(type) + 2B(id)` = 3 字节，合计 ~314 字节，节省约 69%

### 体积对比

| 格式 | 典型字节/条事件 | 备注 |
|------|----------------|------|
| JTB1 二进制（无压缩）| 12～30 B | 无分隔符，整数用 i32，常量值无附加字节 |
| JTB1 二进制（usePool=true）| 9～20 B | 高频字符串以 3B `STRING_REF` 代替，节省约 30～60% |
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
    usePool:       false,                 // 启用字典压缩（EventSerializerWithPool），减少重复字符串体积
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

// 主线程模式（调试用；支持 usePool 字典压缩）
const backend = new WsBackend({ url, mode: 'main',   format: 'binary', usePool: false });

// Worker 模式（默认，推荐高频 trace；不支持 usePool）
const backend = new WsBackend({ url, mode: 'worker', format: 'binary' });

// SAB 模式（零拷贝，需 COOP/COEP；不满足时自动降级 worker；不支持 usePool）
const backend = new WsBackend({ url, mode: 'sab',    format: 'binary', slotDataBytes: 65536 });
```

**三种模式对比**：

| 模式 | 原实现 | 主线程开销 | 依赖 | 适用场景 | usePool |
|------|--------|-----------|------|----------|---------|
| `main` | `WsBackend` | 高（`ws.send` 在主线程） | 无 | 调试、低频 | ✅ 支持 |
| `worker` | `WsWorkerBackend` | 极低（`postMessage` 微秒级） | Web Worker | 高频 trace（推荐） | ❌ 不支持 |
| `sab` | `WsSabBackend` | 最低（`Atomics.store` 纳秒级） | COOP/COEP + SAB | 极高频，主线程繁忙 | ❌ 不支持 |

> **注**：`usePool` 仅对 `mode='main'` 有效；`worker`/`sab` 模式通过帧通信传输序列化后的数据，
> 无法在跨帧传输中维护有状态的字典，因此不支持字典压缩。

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
    wsUrl:    'ws://localhost:9229/trace',
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

### 场景二：浏览器高频插桩，实时传输到 trace server

```js
// 服务端：node tools/trace-server/server.mjs
const tracer = new TraceLogger({
    wsUrl:    'ws://localhost:9229/trace',
    wsWorker: true,     // 推荐：Worker 线程发送，不阻塞主线程
    wsFormat: 'binary', // 高吞吐（JTB1）
});
tracer.init();
```

### 场景三：极高频 + SharedArrayBuffer（需 COOP/COEP）

```js
const tracer = new TraceLogger({
    wsUrl:   'ws://localhost:9229/trace',
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

## 15. Trace Server（`tools/trace-server/server.mjs`）

Trace Server 是一个独立的 Node.js WebSocket 服务器，负责接收来自浏览器端 `WsBackend` 推送的 JTB1 二进制事件批次，并将其持久化到本地 `.bin` 文件。

> 依赖 `src/encoding/EventSerializer.js` 进行 JTB1 二进制帧解析。

### 启动

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

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port <number>` | `9229` | WebSocket 监听端口 |
| `--out <dir>` | `traces` | 输出**目录**路径（每个连接写入独立 `.bin` 文件） |
| `--clear` | 开启 | 启动时删除输出目录中的所有 `.bin` 和 `.smap.json` 文件；`--no-clear` 跳过清空 |
| `--max-payload <MB>` | `0`（无限制）| 最大单条消息体积（MB） |
| `--verbose` | 关闭 | 打印每个 batch 的接收日志（含目标文件名） |
| `--help` | — | 显示帮助信息 |

### 传输协议

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

### HTTP 端点

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查，返回 `{ status: 'ok', ...stats }` |
| `GET /stats` | 统计信息（连接数、批次数、事件数、字节数、错误数）|

### 后处理

收到的 `.bin` 文件可直接用后处理工具链分析：

```bash
# 解码并以树形格式渲染
node tools/trace-parse.mjs traces/trace_*.bin | node tools/trace-render.mjs --format tree

# 过滤特定事件类型
node tools/trace-parse.mjs traces/trace_*.bin | node tools/trace-filter.mjs --type CALL_PRE

# 带 smap 解析源码位置
node tools/trace-parse.mjs traces/trace_*.bin --smap traces/trace_*.smap.json
```
