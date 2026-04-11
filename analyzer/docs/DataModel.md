# JTA 数据模型与数据库设计

**版本：** v1.6  
**目标：** 最小存储空间 + 极致读写查性能

本文档涵盖两部分内容：
1. **数据模型**：JTA 的 Schema 设计、表结构、索引
2. **数据库优化**：性能问题分析、优化方案、查询模式

---

## 1. 核心表结构

```sql
-- 工作空间（一次插桩，多次复用）
CREATE TABLE projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    source_file     TEXT,           -- 原始 JS 路径（服务端存储）
    preprocessed_path TEXT,         -- 预处理后 JS 路径（可为 null，表示未启用预处理）
    instrumented_path TEXT,         -- 插桩后 JS 路径
    smap_path       TEXT,           -- smap.json 路径
    status          TEXT DEFAULT 'pending',  -- pending / instrumenting / ready / failed
    instrument_options TEXT DEFAULT '{}',    -- 插桩时使用的选项（JSON，含 preprocess 子对象）
    iid_count       INTEGER DEFAULT 0,
    error_msg       TEXT,
    updated_at      INTEGER
);

-- 插件检查点（断点恢复 / 进度持久化）
CREATE TABLE plugin_checkpoints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    plugin_id   TEXT NOT NULL,
    phase       TEXT,               -- 'phase1' / 'phase2' / 'manual' 等
    completed_at INTEGER,           -- Unix timestamp (ms)
    duration_ms  INTEGER,
    UNIQUE (session_id, plugin_id)  -- 每个插件只保留一条最新检查点（INSERT OR REPLACE）
);

-- 分析会话（一次 trace 对应一个 session）
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,   -- UUID
    name        TEXT,               -- 用户命名，如 "target-v2.3"
    created_at  INTEGER,            -- Unix timestamp
    source_file TEXT,               -- 原始 JS 文件名
    bin_path    TEXT,               -- .bin 文件路径
    smap_path   TEXT,               -- .smap.json 路径
    event_count INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending',  -- pending / parsing / indexing / ready / failed
    plugin_status TEXT DEFAULT '{}',     -- JSON：{ pluginId: 'pending'|'running'|'done'|'failed' }
    project_id  TEXT                     -- 关联的工作空间（可为 null）
);

-- 事件流（主表）
-- 注意：type 字段存储整数编码，见 db/EventTypeCode.mjs；line/col/src_text 已移至 smap 表
CREATE TABLE events (
    id          INTEGER PRIMARY KEY,  -- seq
    session_id  TEXT NOT NULL,
    type        INTEGER NOT NULL,     -- 事件类型整数编码（见 EventTypeCode.TYPE）
    iid         INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 变量写入
CREATE TABLE writes (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value       TEXT,     -- JSON 序列化
    value_id    INTEGER,  -- 引用 value_dict.id（F1 v2+ 填充，NULL 表示旧数据）
    omitted     INTEGER DEFAULT 0
);

-- 变量读取
CREATE TABLE reads (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value       TEXT,
    value_id    INTEGER,  -- 引用 value_dict.id（F1 v2+ 填充，NULL 表示旧数据）
    omitted     INTEGER DEFAULT 0
);

-- 属性读写（fields）
-- 注意：base 字段已移除，改用 base_oid（运行时对象唯一 ID，0 或 NULL 表示非对象）
CREATE TABLE fields (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    offset      TEXT,
    is_write    INTEGER,
    value       TEXT,
    value_id    INTEGER,  -- 引用 value_dict.id（F1 v2+ 填充，NULL 表示旧数据）
    omitted     INTEGER DEFAULT 0,
    base_oid    INTEGER   -- 运行时对象唯一 ID（OID），NULL/0 表示非对象或 OID 未知
);

-- 值字典（由 F1 EventIndex 填充，全局唯一字符串池）
-- writes/reads/fields.value_id 引用此表的 id，对重复值去重存储
-- val_type: 'num' / 'bool' / 'str' / 'null' / 'obj' / 'ta'
--   'ta' = TypedArray / ArrayBuffer，val_text 为 "[TypeName(N):MB:hexpreview]" 格式字符串
-- 典型压缩比：循环中同一数值 100k 次写入 → 字典只存 1 行
CREATE TABLE value_dict (
    id          INTEGER PRIMARY KEY,  -- 内存计数器分配，非 AUTOINCREMENT
    session_id  TEXT NOT NULL,
    val_text    TEXT NOT NULL,        -- 原始序列化字符串（同 writes/reads/fields.value）
    val_type    TEXT NOT NULL,        -- 'num' / 'bool' / 'str' / 'null' / 'obj' / 'ta'
    val_num     REAL,                 -- val_type='num' 时有效，用于数值范围查询
    UNIQUE (session_id, val_text)
);

-- 源码映射（来自 .smap.json）
CREATE TABLE smap (
    session_id  TEXT NOT NULL,
    iid         INTEGER NOT NULL,
    sl INTEGER, sc INTEGER,
    el INTEGER, ec INTEGER,
    src_text    TEXT,
    def_iid     INTEGER,
    PRIMARY KEY (session_id, iid)
);

-- 调用图边（由 CallGraphBuilder 插件填充）
CREATE TABLE call_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    call_seq        INTEGER,    -- CALL_PRE 事件的 seq
    return_seq      INTEGER,    -- CALL 事件的 seq
    caller_line     INTEGER,
    fn_name         TEXT,
    fn_iid          INTEGER,    -- 被调用函数定义处的 iid（混淆代码中函数名相同时用于区分）
    args_json       TEXT,
    return_value    TEXT,
    depth           INTEGER,    -- 调用深度
    own_event_count INTEGER     -- 自身事件数：(return_seq - call_seq) 减去子调用覆盖的 SEQ 跨度
                                -- 由 F3_CallGraphBuilder 预计算写入（O(N)）；旧数据此列为 NULL
);

-- 污点路径（由 TaintTracker 插件填充）
CREATE TABLE taint_paths (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    source_event_id INTEGER,
    sink_event_id   INTEGER,
    path_json       TEXT,      -- 完整路径的 event_id 数组
    source_var      TEXT,
    sink_var        TEXT,
    hop_count       INTEGER
);

-- 变量生命周期（由 VariableLifetime 插件填充）
CREATE TABLE var_lifetime (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    first_write_seq INTEGER,    -- 首次写入事件 seq
    last_read_seq   INTEGER,    -- 最后读取事件 seq
    write_count     INTEGER DEFAULT 0,
    read_count      INTEGER DEFAULT 0,
    scope           TEXT        -- 推断的作用域（global / closure / local），由 F5 填充
);

-- 值索引（由 F1 EventIndex 填充，供值搜索 API 使用）
-- 对每个 write/read/field 的值做类型化索引，支持按值反查事件
-- val_type: 'num' / 'bool' / 'str' / 'ta'；VI_MAX_SAME=50：同一值最多记录 50 条，防止循环变量爆炸
--   'ta' = TypedArray / ArrayBuffer，val_str 存放 "[TypeName(N):MB:hexpreview]" 格式字符串
-- 注意：value_index 与 value_dict 共存但定位不同：
--   value_dict = 去重存储（每个唯一值 1 行），writes/reads/fields.value_id 引用
--   value_index = 反查索引（每次出现 1 行，上限 50），供 value-search API 使用
CREATE TABLE value_index (
    session_id  TEXT NOT NULL,
    event_id    INTEGER NOT NULL,
    val_type    TEXT NOT NULL,   -- 'num' / 'bool' / 'str' / 'ta'
    val_num     REAL,            -- val_type='num' 时有效
    val_str     TEXT,            -- val_type='str'/'bool'/'ta' 时有效（截断至 256 字符）
    var_name    TEXT,
    source      TEXT NOT NULL,   -- 'write' / 'read' / 'field'
    PRIMARY KEY (session_id, event_id, source)
);
```

```sql
-- 书签/标注（用户手动标记）
CREATE TABLE bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,  -- 对应事件的 seq
    label       TEXT,              -- 书签标题
    note        TEXT,              -- 详细注释
    created_at  INTEGER
);

-- 服务端运行任务（由 InstrumentRunner 管理）
CREATE TABLE run_tasks (
    id          TEXT PRIMARY KEY,   -- runId（UUID）
    created_at  INTEGER,
    status      TEXT DEFAULT 'running',  -- running / done / failed / timeout
    code        TEXT,               -- 原始源码
    filename    TEXT,
    env         TEXT DEFAULT 'node', -- node / jsdom
    stdout      TEXT,               -- 运行输出（完成后写入）
    stderr      TEXT,
    exit_code   INTEGER,
    duration_ms INTEGER,
    session_id  TEXT,               -- 成功时自动创建的 Session ID（关联 sessions 表）
    error_msg   TEXT                -- 失败原因（超时/异常等）
);
```

---

## 2. 索引

```sql
CREATE INDEX idx_events_session_type ON events(session_id, type);
CREATE INDEX idx_events_iid          ON events(session_id, iid);
CREATE INDEX idx_writes_name         ON writes(session_id, name);
CREATE INDEX idx_reads_name          ON reads(session_id, name);
CREATE INDEX idx_fields_offset       ON fields(session_id, offset);
CREATE INDEX idx_call_edges_session  ON call_edges(session_id);
CREATE INDEX idx_taint_session       ON taint_paths(session_id);
CREATE INDEX idx_var_lifetime_name   ON var_lifetime(session_id, name);

-- value_dict 索引（由 _runMigrations 创建，不在 schema.sql 中定义，
-- 避免旧数据库升级时因列不存在而报错；value_id 列通过 ALTER TABLE ADD COLUMN 添加后才创建）
CREATE UNIQUE INDEX idx_vd_session_text ON value_dict(session_id, val_text); -- 查重
CREATE INDEX idx_vd_num  ON value_dict(session_id, val_num) WHERE val_type='num'; -- 数值范围查询
CREATE INDEX idx_vd_type ON value_dict(session_id, val_type); -- 按类型过滤

-- value_id 反查索引（由 _runMigrations 在 ALTER TABLE ADD COLUMN 之后创建）
CREATE INDEX idx_writes_value_id ON writes(session_id, value_id);
CREATE INDEX idx_reads_value_id  ON reads(session_id, value_id);
CREATE INDEX idx_fields_value_id ON fields(session_id, value_id);

-- 新增索引（由 _runMigrations 在线迁移时创建）
-- 优化 own-events 子调用排除查询（列顺序：depth 前置覆盖 WHERE depth=?+1 AND session_id=? 条件）
CREATE INDEX IF NOT EXISTS idx_call_edges_depth ON call_edges(session_id, depth, call_seq, return_seq);

-- 优化 object_timelines 时间窗口过滤（seqFrom/seqTo 参数）
CREATE INDEX IF NOT EXISTS idx_obj_timeline_seq ON object_timelines(session_id, seq);

-- TypedArray 部分索引（只含 val_type='ta' 的行，用于 TypedArray 值搜索）
CREATE INDEX IF NOT EXISTS idx_vi_ta ON value_index(session_id, val_str)
    WHERE val_type = 'ta';
```

---

## 3. Database.mjs 实现说明

采用 **better-sqlite3**（原生 C++ 扩展，同步 API），相比原来的 sql.js 内存模式有显著性能提升。

### 3.1 核心设计

```
直接写磁盘模式
  ├── WAL 模式（journal_mode = WAL）：并发读不阻塞写
  ├── 同步写策略（synchronous = NORMAL）：比 FULL 快，WAL 下足够安全
  ├── 页缓存 64MB（cache_size = -16000）
  ├── mmap 128MB（mmap_size = 134217728）：减少大表顺序扫描的系统调用
  └── flush() 为空操作（better-sqlite3 直接写磁盘，无需手动 flush）

LRU prepared statement 缓存
  ├── 容量 200 条：覆盖所有插件热路径 SQL
  ├── 命中 → 移到末尾（LRU 队尾）
  └── 淘汰 → 驱逐最久未使用的（Map 迭代顺序 = 插入顺序，第一项即 LRU）

API 兼容层（与原 sql.js 版本完全兼容）
  ├── all(sql, ...args)   → 查询多行（返回数组）
  ├── get(sql, ...args)   → 查询单行
  ├── run(sql, ...args)   → 执行写入（不返回数据）
  ├── transaction(fn)     → 批量写入事务（better-sqlite3 同步回调）
  ├── exec(sql)           → 执行多条语句（DDL/schema）
  └── raw()               → 获取原始 better-sqlite3 Database 实例（供插件直接使用）

参数规范化（normalizeParams）
  ├── db.all(sql, p1, p2)         → 展开参数形式
  └── db.all(sql, [p1, p2])       → 数组形式（两种调用方式均支持）
```

### 3.2 在线迁移（`_runMigrations`）

旧 DB 文件升级时自动执行列添加（ALTER TABLE ... ADD COLUMN 等），保证向后兼容：

```
迁移项（按执行顺序）：
  - sessions 表：添加 project_id 列
  - projects 表：添加 preprocessed_path 列
  - writes/reads/fields 表：去除 AUTOINCREMENT + FOREIGN KEY（重建表，提升批量 INSERT 性能）
  - events 表迁移：将旧 TEXT 类型的 type 列转为 INTEGER（重建表）
  - call_edges 表：添加 own_event_count 列
  - obfuscation_hints 表：添加 fn_name 列
  - object_timelines 表：添加 src_text 列
  - value_dict 表：CREATE TABLE IF NOT EXISTS（新表，幂等）
  - writes/reads/fields 表：ALTER TABLE ADD COLUMN value_id INTEGER（旧数据 NULL）
  - value_dict 索引：idx_vd_session_text / idx_vd_num / idx_vd_type
  - value_id 索引：idx_writes_value_id / idx_reads_value_id / idx_fields_value_id
    （必须在 value_id 列添加之后创建，避免旧库升级报"no such column: value_id"）
  - oid_aliases 表：CREATE TABLE IF NOT EXISTS（新表，幂等）
  - 索引 idx_call_edges_depth：CREATE INDEX IF NOT EXISTS（depth 前置覆盖索引，优化 own-events 子调用排除查询）
  - 索引 idx_obj_timeline_seq：CREATE INDEX IF NOT EXISTS（object_timelines 时间窗口过滤）
  - 索引 idx_vi_ta：CREATE INDEX IF NOT EXISTS（value_index 中 TypedArray 部分索引）
```

### 3.3 文件位置

```
analyzer/db/Database.mjs        # better-sqlite3 封装（LRU stmt 缓存 + 迁移）
analyzer/db/schema.sql          # 建表 DDL（幂等，CREATE TABLE IF NOT EXISTS）
analyzer/db/EventTypeCode.mjs   # events.type 整数编码双向映射（与 EventSerializer 对齐）
```

---

## 4. InstrumentRunner 超时与资源策略

服务端运行任意 JS 存在执行时间不可控的风险，采用以下默认策略：

| 策略项 | 默认值 | 说明 |
|---|---|---|
| 单次运行超时 | **30 秒** | 超时后 SIGKILL 子进程，任务状态置为 `timeout` |
| 最大并发运行数 | **3** | 超出则排队等待，防止资源耗尽 |
| 运行结果保留 | **随 Session 持久化** | `run_tasks` 表永久保留（可手动删除） |
| stdout/stderr 截断 | **最多 1 MB** | 防止超大输出撑爆 SQLite |
| 无限循环检测 | **CPU 监控 + 超时兜底** | 超时是最终兜底，不单独检测无限循环 |

超时场景下行为：
- 子进程被强制终止，不产生 `.bin` 文件
- `run_tasks.status` = `'timeout'`，`error_msg` = `'execution timed out after 30s'`
- Session 不会被创建

---

## 5. 性能优化设计

> 以下内容来自数据库优化设计文档（Database-Optimization），记录了已识别的问题和已实施的优化方案。

### 5.1 已知问题（历史记录）

#### Bug（数据正确性问题）

| 插件 | 位置 | 问题 | 影响 |
|------|------|------|------|
| A2_DataFlowGraph | L115 | `fields` 查询硬编码 `LIMIT 5000` | 超出部分的 field_write/field_read 边完全丢失，数据流图不完整 |
| A4_StringTracker | L48 | `LIMIT 10000` 截断字符串 writes | 超出部分字符串事件完全丢失，编码检测不完整 |
| I2_SignatureAnalyzer | L70 | `LIMIT 50000` 截断 writes | 超出部分 writes 不参与签名追踪 |
| I2_SignatureAnalyzer | L79 | `LIMIT 20000` 截断 field writes | 超出部分字段写入不参与签名追踪 |

#### 内存风险

| 插件 | 位置 | 问题 | 影响 |
|------|------|------|------|
| A5_LoopDetector | L81-116 | 全量加载 events(id,iid) + 全量 writes | 100M 事件 trace 可能触发 OOM（堆内存 ~9GB） |

### 5.2 Schema 优化（已实施）

| 优化项 | 旧设计 | 新设计 | 收益 |
|--------|--------|--------|------|
| `events.type` | TEXT（~10B/行） | INTEGER（4B/行） | 100M 行节省 ~600MB |
| `events` 去冗余列 | 有 `line/col/src_text` | 移除，改由 smap 动态 JOIN | 节省 2-3GB |
| `writes/reads/fields` 去 AUTOINCREMENT | 有 AUTOINCREMENT | 移除，普通 INTEGER PK | 批量 INSERT 性能提升 |
| `call_edges.own_event_count` | 无 | 预计算列 | 函数复杂度排序 O(1) 查询 |
| `value_dict` 去重表 | 无 | 内存 Map + `INSERT OR IGNORE` | 循环重复值只存 1 行 |
| `base` → `base_oid` | 序列化字符串 | 运行时对象唯一 ID（整数） | 精确追踪对象属性，支持 OID 别名合并 |

### 5.3 索引优化策略

#### 覆盖索引原则

```sql
-- 错误示例：idx_events_session_type 缺 id，排序时需 filesort
SELECT id FROM events WHERE session_id=? AND type=? ORDER BY id LIMIT 100

-- 正确：前置 depth 覆盖 WHERE depth=?+1 AND session_id=?，消除回表
CREATE INDEX idx_call_edges_depth ON call_edges(session_id, depth, call_seq, return_seq);
```

#### 部分索引（Partial Index）

```sql
-- 只对 val_type='ta' 建索引，节省空间，加速 TypedArray 查询
CREATE INDEX idx_vi_ta ON value_index(session_id, val_str) WHERE val_type = 'ta';

-- 只对 val_type='num' 建数值索引，支持范围查询
CREATE INDEX idx_vd_num ON value_dict(session_id, val_num) WHERE val_type='num';
```

### 5.4 查询模式优化

#### 游标分页（Cursor Pagination）

**问题**：深页 `OFFSET N` 导致 O(N) 全表扫描，百万行 trace 深翻页极慢。

**方案**：

```sql
-- 旧（offset 分页）：OFFSET=500000 需扫描 500000 行
SELECT * FROM events WHERE session_id=? ORDER BY id LIMIT 100 OFFSET 500000

-- 新（游标分页）：B-tree 直接定位 cursor 位置，O(log N)
SELECT * FROM events WHERE session_id=? AND id > :cursor ORDER BY id LIMIT 100
-- cursor = 上一页末尾的 id，下一次直接跳转
```

**三种场景分策略**：

| 场景 | 机制 | 理由 |
|------|------|------|
| 普通事件浏览 | `cursor=last_seq`，O(log N) B-tree | 顺序翻页，无需随机定位 |
| 跨 Tab 跳转 | `seqFrom=<目标 seq>`，精确定位 | 需要直接跳到指定行，无需估算页码 |
| 值搜索 | `offset` 分页 | 结果集有限（上限 50），随机翻页需求高 |

#### 批量 INSERT 事务

```js
// F1 EventIndex 每 BATCH_SIZE=5000 条事件一个事务
db.transaction(() => {
    for (const event of batch) {
        db.run('INSERT INTO events ...', ...);
    }
})();
// 比逐条 INSERT 快 100x+
```

#### `setImmediate` 让出事件循环

```js
// F1 处理大 trace 时，每 YIELD_EVERY_BATCHES 批调用 setImmediate
// 防止长时间同步处理阻塞主线程，使 WS/HTTP 请求能及时响应
if (batchIdx % YIELD_EVERY_BATCHES === 0) {
    await new Promise(resolve => setImmediate(resolve));
}
```

### 5.5 多会话对比查询优化

**问题**：N 个会话逐个查询需要 6N 次 SQL，N=8 时 48 次查询。

**方案**：`IN` 子句 + `GROUP BY session_id` 单次查询聚合：

```sql
-- 旧：串行 N 次
SELECT COUNT(*) FROM events WHERE session_id = 'A'
SELECT COUNT(*) FROM events WHERE session_id = 'B'
...

-- 新：IN + GROUP BY，一次 SQL
SELECT session_id, COUNT(*) as cnt
FROM events
WHERE session_id IN ('A', 'B', 'C', ...)
GROUP BY session_id
```

分歧计算（delta/pct）在 Node.js 层完成，不下推 SQL，保持 SQL 简单利于 LRU 缓存命中。

### 5.6 数据库配置

```sql
PRAGMA journal_mode = WAL;          -- WAL 模式：并发读不阻塞写
PRAGMA synchronous = NORMAL;        -- 比 FULL 快，WAL 下足够安全
PRAGMA cache_size = -16000;         -- 页缓存 64MB（负数单位=KB）
PRAGMA mmap_size = 134217728;       -- mmap 128MB，减少顺序扫描系统调用
PRAGMA temp_store = MEMORY;         -- 临时表放内存，加速排序/聚合
```

### 5.7 值字典（value_dict）压缩设计

**问题**：循环中同一个值重复写入 N 次，`writes.value` 存 N 份相同字符串，浪费大量空间。

**方案**：全局唯一字符串池 + 引用计数

```
写入时：
  内存 Map<val_text, id> 查重
  命中 → 直接返回已有 id
  未命中 → 计数器 +1 得新 id，INSERT OR IGNORE 写入 value_dict
  writes/reads/fields.value_id = id

查询时：
  JOIN value_dict ON writes.value_id = value_dict.id
  或直接读 writes.value（旧数据兼容，value_id=NULL 时降级）
```

**典型压缩比**：循环中同一数值 100k 次写入 → value_dict 只存 1 行，writes 只存 value_id（整数 4B）而非原始字符串。

---

## 6. 各插件查询模式参考

### Foundation 层查询模式

| 插件 | 主要查询 | 关键索引 |
|------|---------|---------|
| F1 EventIndex | 批量 INSERT events/writes/reads/fields/value_dict/value_index | 无（写入） |
| F2 SmapLoader | 批量 INSERT smap | 无（写入） |
| F3 CallGraphBuilder | 顺序扫描 events WHERE type IN (CALL_PRE, CALL) | idx_events_session_type |
| F4 VariableLifetime | 顺序扫描 writes/reads GROUP BY name | idx_writes_name, idx_reads_name |

### Analysis 层查询模式

| 插件 | 主要查询 | 关键索引 |
|------|---------|---------|
| A1 TaintTracker | BFS writes/reads/fields WHERE name=? | idx_writes_name, idx_reads_name |
| A3 HotPathAnalyzer | GROUP BY iid COUNT(*) | idx_events_iid |
| A5 LoopDetector | JOIN loops + writes WHERE loopIid=? | iid_counts 表 |
| A7 ObjectMutationTracker | fields WHERE base_oid=? ORDER BY event_id | idx_fields_offset |
| A8 ValuePatternDetector | writes GROUP BY value HAVING count > threshold | idx_writes_name |

### Inference 层查询模式

| 插件 | 主要查询 | 关键索引 |
|------|---------|---------|
| I1 CryptoDetector | JOIN value_patterns + iid_counts | value_patterns.iid |
| I2 SignatureAnalyzer | 反向 BFS from taint_paths | idx_taint_session |
| I3 ObfuscationDetector | call_edges GROUP BY fn_name HAVING count > N | idx_call_edges_session |
