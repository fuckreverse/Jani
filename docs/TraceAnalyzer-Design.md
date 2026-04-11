# Jani Trace Analyzer — 设计文档

**版本：** v1.6（已实现）  
**日期：** 2026-04-11  
**目标：** 为 JS 动态 trace 提供一站式逆向分析平台，支持算法识别、污点追踪、签名还原等场景。

---

## 1. 背景与目标

### 1.1 问题
Jani 的插桩引擎已能产出高质量 trace（`.bin` + `.smap.json`），包含：
- 每条语句的执行事件（`END_EXPR`）
- 变量读写值（`writes[]` / `reads[]`）
- 函数调用参数与返回值（`CALL_PRE` / `CALL`）
- 对象属性读写（`fields[]`）
- 源码映射（`line:col` + `srcText`）

但后处理工具分散在命令行（`trace-parse.mjs` / `trace-render.mjs`），逆向分析时需要大量手工串联，效率低。

### 1.2 目标
构建一个 **本地 Web 分析平台**，命名为 **Jani Trace Analyzer（JTA）**：

- 上传 trace 数据后，自动解析、入库、触发分析插件
- 在 Web UI 中提供交互式分析能力（代码高亮、污点追踪、热路径等）
- 插件化架构，分析能力可按需组合、扩展
- 所有数据本地存储，适合分析含敏感逻辑的目标代码

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│              LLM（Claude / GPT / 其他 MCP 客户端）             │
└──────────┬───────────────────────────────────────────────────┘
           │ MCP tool calls（stdio / Streamable HTTP / SSE）
┌──────────▼───────────────────────────────────────────────────┐
│                MCP Server（jta-mcp-*.mjs）                    │
│  stdio 传输  |  Streamable HTTP 传输  |  SSE 传输（旧版兼容）  │
└──────────┬───────────────────────────────────────────────────┘
           │ HTTP
┌──────────▼───────────────────────────────────────────────────┐
│                     Web UI（浏览器）                           │
│   会话管理 | 代码视图 | 分析面板 | 插桩工作台 | 图可视化        │
└──────────┬───────────────────────────────────────────────────┘
           │ HTTP / WebSocket
┌──────────▼───────────────────────────────────────────────────┐
│               JTA Server（Node.js / Express）                 │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌─────────┐  │
│  │ Upload   │  │ Plugin Engine│  │ Query API│  │ Instr.  │  │
│  │ Handler  │  │ (Scheduler)  │  │ (REST/WS)│  │ Runner  │  │
│  └────┬─────┘  └──────┬───────┘  └─────┬────┘  └────┬────┘  │
│  ┌────▼───────────────▼─────────────────▼────────────▼────┐  │
│  │              SQLite（better-sqlite3，WAL 模式写磁盘）   │  │
│  │  sessions | events | writes | reads | fields | smap   │  │
│  │  call_edges | taint_paths | var_lifetime | scopes      │  │
│  │  value_dict | value_patterns | bookmarks | value_index  │  │
│  │  iid_counts | loops | object_timelines | oid_aliases   │  │
│  │  plugin_checkpoints（断点恢复 / 进度持久化）            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 技术栈

| 层次 | 技术选型 | 理由 |
|---|---|---|
| 后端 | Node.js + Express | 与 Jani 同生态，无额外运行时 |
| 数据库 | SQLite（**better-sqlite3**，原生同步 API） | 直接写磁盘，无 flush/dirty 机制；同步 API 无 IPC 开销，批量 INSERT 比 sql.js 快 4–8×；WAL 模式支持并发读 |
| Trace 收集 | 内置 `/ws/trace` WebSocket 端点 | 原独立 `trace-server` 功能已集成进 JTA Server，无需单独启动 |
| 工作空间管理 | `projects` 表 + `/api/projects` 路由 | 一次插桩，反复复用；上传原始 JS 自动触发插桩，后续上传 trace.bin 无需重新插桩 |
| 前端 | Vue 3 + Vite | 轻量，组件化，易于实现代码编辑器集成 |
| 代码高亮 | CodeMirror 6 | 支持行高亮、标注、交互点击 |
| 图可视化 | Cytoscape.js | 适合 DAG/调用图渲染，纯前端 |
| 插件通信 | Node.js EventEmitter | 插件间解耦，支持异步 |

---

## 3. 数据模型

### 3.1 核心表结构

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

### 3.2 索引

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

### 3.3 Database.mjs 实现说明

采用 **better-sqlite3**（原生 C++ 扩展，同步 API），相比原来的 sql.js 内存模式有显著性能提升。

#### 核心设计

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

#### 在线迁移（`_runMigrations`）

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

#### 文件位置

```
analyzer/db/Database.mjs        # better-sqlite3 封装（LRU stmt 缓存 + 迁移）
analyzer/db/schema.sql          # 建表 DDL（幂等，CREATE TABLE IF NOT EXISTS）
analyzer/db/EventTypeCode.mjs   # events.type 整数编码双向映射（与 EventSerializer 对齐）
```

---

### 3.4 InstrumentRunner 超时与资源策略

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

## 4. 插件架构

### 4.1 插件接口

```js
/**
 * 所有分析插件实现此接口
 */
class AnalysisPlugin {
    /** 插件唯一 ID */
    static id = 'plugin-id';

    /** 依赖的其他插件 ID（执行前必须已完成） */
    static deps = [];

    /** 插件描述 */
    static description = '';

    /**
     * 执行分析
     * @param {object} ctx
     * @param {string}   ctx.sessionId   当前会话 ID
     * @param {Database} ctx.db          SQLite 连接
     * @param {Function} ctx.emit        发送进度事件（供 UI 展示）
     * @returns {Promise<void>}
     */
    async run(ctx) {
        throw new Error('not implemented');
    }
}
```

### 4.2 插件调度器（Plugin Engine）

```
上传完成
   ↓
PluginEngine.schedule(sessionId, { phase: 'phase1', plugins: [F1], skipCompleted: true })
   ↓
查询 plugin_checkpoints → 跳过已完成的插件（断点恢复）
   ↓
拓扑排序（按 deps 构建 DAG）
   ↓
并发执行无依赖插件（F1、F2 同时跑）
   ↓
每个插件完成 → writeCheckpoint() 持久化到 SQLite
   ↓
依赖满足后立即触发下一批
   ↓
phase1 全部完成 → 通知 UI（type: 'all_done', phase: 'phase1'）
   ↓
自动调度 phase2（F2/F3/F4 等深度分析）在后台执行
```

调度器维护插件注册表，支持：
- **自动发现**：扫描 `plugins/` 目录自动加载
- **手动触发**：用户在 UI 中选择插件单独重跑（`POST /api/sessions/:id/re-run`）
- **断点恢复**：`skipCompleted: true`（默认）时跳过已有检查点的插件，重启或中断后自动续跑
- **强制重跑**：`POST /api/sessions/:id/re-run` 带 `forceRerun: true` 时清除检查点后全量重跑
- **分阶段调度**：Phase1（F1 基础解析）→ 会话创建完成 → Phase2（F2/F3/F4 等深度分析）自动后台执行

#### `schedule()` 选项

| 参数 | 类型 | 说明 |
|------|------|------|
| `plugins` | `string[]` | 插件 ID 列表（默认全部已注册插件）|
| `onProgress` | `Function` | 进度回调 `(event) => void` |
| `dataDir` | `string` | 会话数据目录 |
| `phase` | `string` | 阶段标记（`'phase1'`/`'phase2'`/`'manual'` 等）|
| `skipCompleted` | `boolean` | 是否跳过已完成的插件（默认 `true`，断点恢复模式）|

#### `onProgress` 事件类型

| type | 说明 |
|------|------|
| `schedule_start` | 调度开始，携带 `toRun`、`skipped` 列表 |
| `plugin_start` | 单个插件开始执行 |
| `plugin_progress` | 插件内部进度更新（如 F1 处理事件数） |
| `plugin_done` | 单个插件完成，携带 `durationMs` |
| `plugin_error` | 插件执行失败 |
| `all_done` | 当前 phase 全部插件完成 |

---

## 5. 分析插件清单

### 第一层：Foundation（基础数据插件）

#### F1 · EventIndex
- **依赖：** 无
- **输入：** `.bin` 文件
- **功能：** 解析二进制 trace，写入 `events / writes / reads / fields / value_dict` 表
- **输出：** 数据库填充完成
- **值字典机制：** 内存 `Map<val_text, id>` 去重，内存计数器分配 ID（避免 N+1 查询），
  `INSERT OR IGNORE` 保证幂等；`writes/reads/fields.value_id` 同步填充

#### F2 · SmapLoader
- **依赖：** 无
- **输入：** `.smap.json` 文件
- **功能：** 解析 smap，写入 `smap` 表
- **输出：** iid → 行列/srcText 映射可查

#### F3 · CallGraphBuilder
- **依赖：** F1
- **功能：** 配对 `CALL_PRE/CALL` 事件，重建调用栈，计算调用深度
- **输出：** `call_edges` 表

#### F4 · VariableLifetime
- **依赖：** F1
- **功能：** 统计每个变量的首次写入/最后读取/读写次数
- **输出：** `var_lifetime` 表（持久化到 SQLite）

#### F5 · ScriptScopeAnalyzer
- **依赖：** F1, F2
- **功能：**
  - 基于 SCRIPT_ENTER / CALL_PRE / CALL 事件重建作用域树
  - 识别变量是全局变量、闭包变量还是函数局部变量
  - 为每个变量的 write 事件标注作用域归属
  - 提高 TaintTracker（A1）和 DataFlowGraph（A2）的分析精度
- **输出：** `scopes` 表（scope_id, parent_scope_id, fn_iid, fn_name, start_seq, end_seq）；`var_lifetime.scope` 字段由本插件填充

---

### 第二层：Analysis（分析插件）

#### A1 · TaintTracker ⭐
- **依赖：** F1, F4, F5
- **功能：** 给定 source 变量（或事件），BFS 追踪数据流向
  - **正向**：source → 所有受影响变量 → 函数参数 → 返回值
  - **反向**：给定 sink 变量，反向找所有来源
- **追踪范围：** 同时覆盖三类数据源
  - 局部/全局变量：`writes` / `reads` 表（`name` 字段）
  - 对象属性：`fields` 表（`base.offset` 形式，如 `obj.key`、`arr[i]`）
  - 函数返回值：`call_edges.return_value`（追踪函数调用的返回数据流）
  - 注意：同名变量在不同作用域下视为不同节点（依赖 F5 的 `scopes` 数据区分）
- **输出：** `taint_paths` 表 + 可视化 DAG

#### A2 · DataFlowGraph
- **依赖：** F1, F3, F5
- **功能：** 构建过程内 + 过程间 def-use 图
- **输出：** 数据流图（JSON），供前端 Cytoscape 渲染

#### A3 · HotPathAnalyzer
- **依赖：** F1, F2
- **功能：** 
  - 按 iid 统计执行次数，输出热力图数据
  - 检测循环：同一 iid 在连续 seq 中重复出现
  - 标注循环边界（起始 seq、终止 seq、迭代次数）
- **输出：** `hot_iids` 视图 + `loops` 表

#### A4 · StringTracker
- **依赖：** F1
- **功能：**
  - 过滤所有字符串类型的 writes
  - 追踪字符串拼接链（`'a' + b` → `'ab'`）
  - 标记疑似编码操作（base64 字符集、hex 字符集）
- **输出：** `string_events` 视图

#### A5 · LoopDetector
- **依赖：** A3
- **功能：**
  - 识别每个循环的迭代变量（如 `i`）
  - 展开每轮迭代的变量快照
  - 可视化：迭代 × 变量值的二维表格
- **输出：** `loop_iterations` 表

#### A7 · ObjectMutationTracker
- **依赖：** F1
- **功能：**
  - 按 `(base, offset)` 重建对象属性的变化时间线
  - 识别"配置对象"（大量 putField 且结构稳定）
- **输出：** `object_timelines` 表

#### A8 · ValuePatternDetector
- **依赖：** F1
- **功能：**
  - 扫描所有 writes，检测反复出现的固定字节模式（魔术常数、固定 IV、固定 key）
  - 检测整数常量集合是否匹配已知密码学常数（AES S-box、MD5/SHA 初始向量等）
  - 输出每个高频值的出现次数、所在行、关联变量名
- **输出：** `value_patterns` 表（value_hash, count, first_seq, iid, matched_constant）

---

### 第三层：Inference（推理插件）

#### I1 · CryptoDetector ⭐
- **依赖：** A3, A5, A4, A8
- **检测规则：**
  - **AES**：16/32 字节数组 key + S-box 查表模式（特定整数常量集合）
  - **MD5/SHA**：魔术常数检测（`0x67452301`, `0xEFCDAB89` 等）
  - **XOR 流密码**：大量 XOR 操作 + 循环 + 固定 key
  - **Base64**：字符集 `A-Za-z0-9+/=` 的映射操作
  - **RC4**：256 字节 S-box 初始化模式
  - 综合 A8（ValuePatternDetector）的值层面检测结果进行最终算法判定
- **输出：** `crypto_hints` 表（iid, algorithm, confidence, evidence）

#### I2 · SignatureAnalyzer ⭐
- **依赖：** A1, A4
- **功能：**
  - 定位 HTTP 请求构造点（headers/body 的 putField）
  - 反向追踪 `sign/token/timestamp/nonce` 字段的来源
  - 还原完整签名计算路径（输入 → 中间步骤 → 最终值）
- **输出：** `signature_paths` 表 + 可读报告

#### I3 · ObfuscationDetector
- **依赖：** A2, A3, F2
- **检测：**
  - 变量名熵值（短/随机变量名 = 高熵）
  - 字符串解密函数识别（一函数多次调用返回不同字符串，`fn_name` 字段记录供 UI 跳转）
  - 控制流混淆（大 switch + 单循环变量；高事件密度提示）
- **输出：** `obfuscation_hints` 表（含 `hint_type`、`description`、`confidence`、`fn_name` 字段）

#### I4 · AlgorithmSummarizer
- **依赖：** I1, A1, A5
- **功能：** 汇总所有 Inference 结论，生成人类可读摘要
  - 示例："函数 `_0x1a2b` 是 AES-128 加密，key 来自变量 `secret`（第 42 行赋值），被 `sign()` 调用"
  - 可选：接入 LLM 做进一步语义解释
- **输出：** `analysis_summary`（JSON 报告 + Markdown 文本）

---

## 6. Web UI 设计

### 6.1 页面导航结构

JTA 包含以下独立页面：

| 页面 | 路由 | 说明 |
|---|---|---|
| **工作空间列表** | `/workspaces` | 管理工作空间（Projects），上传 JS + 自动插桩；`WorkspaceList.vue` |
| **工作空间详情** | `/workspaces/:id` | 工作空间详情 + 插桩状态 + 关联会话列表；`WorkspaceDetail.vue` |
| 会话列表 | `/sessions` | 所有分析会话，含状态概览；含进度抽屉（`ProgressDrawer`）|
| 会话详情 | `/sessions/:id` | 代码视图 + 事件列表 + 分析面板；含内联进度条 |
| **插桩工作台** | `/instrument` | 独立插桩页面，见 6.4 节 |
| **Trace 监控** | `/trace` | WebSocket Trace 收集状态监控，见 6.6 节 |
| **空间分析** | `/storage` | 扫描 data 目录、统计各类文件占用、提供一键清理建议；`StorageAnalyzer.vue` |
| **Trace 对比** | `/diff` | 多会话执行行为差异对比页面；`TraceDiff.vue` |

---

### 6.2 会话详情页布局

```
┌─────────────────────────────────────────────────────────┐
│  导航栏：[会话列表] [插桩工作台] [设置]                    │
├──────────┬──────────────────────────┬───────────────────┤
│          │                          │                   │
│  会话面板 │      代码视图             │   分析面板         │
│          │  （CodeMirror，显示       │                   │
│  • 会话1 │   原始 JS，行高亮）        │  ┌─────────────┐ │
│  • 会话2 │                          │  │ 污点追踪    │ │
│  • ...   │  点击某行 →              │  │ 热路径图    │ │
│          │  右侧面板显示             │  │ 调用图      │ │
│          │  该行的所有 trace 事件    │  │ 加密检测    │ │
│          │                          │  │ 签名分析    │ │
│          │                          │  └─────────────┘ │
├──────────┴──────────────────────────┴───────────────────┤
│  事件列表（按 seq 排序，可过滤 type/变量名/行号）           │
│  [seq] [type] [line:col] [srcText] [writes] [reads]     │
└─────────────────────────────────────────────────────────┘
```

### 6.3 核心交互

**点击代码行 → 查看 trace**  
点击源码某行，右侧事件列表过滤显示该行所有执行事件，包含每次执行时变量的值。

**点击变量名 → 追踪数据流**  
点击事件列表中的变量名，触发 TaintTracker，可视化显示该变量的完整前向/后向数据流 DAG。

**热路径视图**  
源码行背景色深浅表示执行频率（热力图），快速定位循环核心。

**调用图**  
Cytoscape 渲染，节点=函数，边=调用关系，支持缩放/展开/搜索。

**点击变量名 → 查看值历史**  
在事件列表中点击某个变量名，弹出"值历史"面板：显示该变量在整个 trace 过程中的所有取值变化（seq + line:col + 旧值 → 新值），以时间线形式展示，便于快速定位关键赋值点。

**事件过滤**  
- 按 type 过滤（只看 END_EXPR / 只看 CALL）
- 按变量名搜索（`writes.name = 'key'`）
- 按 seq 范围（查看某时间窗口）
- 按值内容搜索（value 包含某字符串）

**事件书签与标注**  
用户可对任意事件（seq）添加书签和文字注释（如"此处是 key 初始化"），书签持久化存储，在代码视图和事件列表中均有标记。支持书签列表面板，快速跳转。

### 6.4 插桩工作台（Instrumenter Studio）

独立页面，路由 `/instrument`，将命令行插桩能力完整搬到 Web UI。

#### 布局

```
┌─────────────────────────────────────────────────────────┐
│  导航栏：[会话列表] [插桩工作台] [设置]                    │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│   源码编辑区              │   插桩后代码（只读）           │
│   （CodeMirror，可编辑）  │   （CodeMirror，语法高亮）    │
│                          │                              │
│   支持：粘贴 / 上传文件   │   点击"插桩"后实时更新        │
│                          │                              │
├──────────────────────────┴──────────────────────────────┤
│  ⚙ 预处理（可选，可折叠）                                │
│  ☐ 启用   Preset: [反混淆 ▼]  源码类型: [script ▼]      │
│  ▶ 反混淆选项（replaceVoid / foldConstants / ...）       │
│  ▶ 箭头函数规范化选项                                     │
│  ▶ 语法降级目标（ES2015 / ES2017 / ES2020 / ES2022）     │
├──────────────────────────────────────────────────────────┤
│  插桩选项                                                │
│  ☐ --inline-iid      iid→位置 map 内联到插桩文件         │
│  ☐ --inline-source   原始源码内联到 source map           │
│  ☐ --execution-trace 启用 ExecutionTrace 插件            │
│  ☐ --no-write        仅内存插桩（不写出文件）             │
│  沙盒变量名: [J$______]   源码类型: [script ▼]           │
│  分析插件: [LogAll.js ×] [+ 添加]                        │
│  执行环境: [Node.js ▼]                                   │
│    - Node.js（纯 Node.js，适合无 DOM 依赖的脚本）          │
│    - JSDOM（模拟浏览器 window/document/XMLHttpRequest，  │
│             适合网页 JS）                                 │
│    - 仅插桩（不运行，只生成插桩后代码）                    │
├─────────────────────────────────────────────────────────┤
│  [插桩]  [下载插桩后代码]  [⬇ 下载预处理代码]            │
│  [在服务端运行 ▶]  [清空]                                │
└─────────────────────────────────────────────────────────┘
```

#### 五个核心操作

**① 插桩（立即预览）**
- 点击"插桩"按钮，后端调用 `instrumentCode()` API
- 若启用预处理，后端先对源码做 AST 变换，再将变换后的代码送入插桩器
- 右侧实时展示插桩后的完整代码（含 `J$.Se()`、`J$.X()` 等钩子调用）；若预处理已开启，右侧标题区显示"⚙ 已预处理"徽标
- 同时展示 smap 信息（iid 数量、覆盖行数）
- 后端始终通过 `--output <path>` 显式指定输出路径，避免 `--target browser` 时的 in-place 覆盖问题

**② 复制插桩后代码**
- 点击"复制"按钮将插桩后代码复制到剪贴板（使用 `navigator.clipboard.writeText`，fallback `execCommand('copy')`）
- 按钮有 2 秒视觉反馈（绿色 ✓ 状态）

**③ 下载**
- 下载插桩后 `.js` 文件
- 下载预处理后 `_preprocessed_.js` 文件（仅在启用预处理时出现）
- 下载 `.map.json`（source map）
- 下载 `.smap.json`（含 srcText 的 iid 映射）

**④ 在服务端运行 ▶**
- 仅在勾选 `--execution-trace` 时可用（其他情况置灰并提示）
- 点击后：后端在 Node.js 沙箱中执行插桩后的代码（若启用预处理，预处理在插桩前自动执行）
- 实时 WebSocket 推送：stdout/stderr 输出流
- 运行完成后：自动将生成的 `.bin` + `.smap.json` 导入新 session
- 弹出提示："运行完成，已创建分析会话 [查看 →]"，一键跳转到会话详情页

**⑤ 预处理选项面板（`PreprocessOptions.vue`，可折叠）**
- 独立组件 `PreprocessOptions.vue`，通过 `ref` 方式嵌入 `InstrumentStudio`
- 提供四种 **Preset**：
  - `deobfuscate`：反混淆（逗号表达式拆分 + void 替换 + 常量折叠）
  - `normalize-arrow`：箭头函数规范化（改善 Jalangi this 追踪）
  - `transpile`：语法降级（Babel preset-env，iid 更细粒度）
  - `full`：全流程（箭头规范化 → 反混淆 → 语法降级）
- 反混淆子选项：`replaceVoid`、`foldConstants`、`splitSequence`（语义等价，安全绿点）；`simplifyBoolean`、`expandConditional`（结构改变，默认关闭）
- 语法降级目标：`es2015`（Chrome ≥49）/ `es2017`（Chrome ≥58）/ `es2020`（Chrome ≥80）/ `es2022`（Chrome ≥103）；后端将年份标识映射为 browserslist 查询

#### 后端 API

```
POST /api/instrument
    body: { code, filename, options: { inlineIid, inlineSource, executionTrace, noWrite,
            sandboxVar, sourceType, analyses[], wsUrl?, wsSab? }, preprocess? }
    preprocess: { enabled, preset, sourceType, deobfuscate?, normalizeArrow?, transpile? }
    返回: { instrumentedCode, smapJson, mapJson, preprocessedCode?, preprocessStats?, preprocessWarnings? }
    说明：始终通过 --output 显式指定输出文件路径，browser target 不会 in-place 覆盖源文件

POST /api/instrument/run
    body: { code, filename, options, env, preprocess? }
    返回: WebSocket ticket，通过 WS 推流 stdout/stderr + 完成后 sessionId
```

#### 闭环流程图

```
粘贴/上传源码
      ↓
选择插桩选项
      ↓
点击"插桩" → 右侧预览插桩后代码
      ↓
点击"在服务端运行" → WebSocket 实时输出
      ↓
运行完成 → 自动创建 Session → 触发分析插件
      ↓
跳转会话详情页 → 代码视图 + 污点追踪 + 热路径...
```

---

### 6.5 插件进度展示（ProgressDrawer）

上传后，UI 实时显示插件执行进度。`ProgressDrawer.vue` 是一个侧边抽屉组件，提供：

- **总体进度条**：已完成插件数 / 总插件数
- **分阶段进度**：Phase1（基础解析）/ Phase2（深度分析）分组展示
- **插件状态列表**：每个插件的运行状态和耗时

```
✅ F1 EventIndex      (1.2s,  52,341 events)
✅ F2 SmapLoader      (0.1s,  234 iids)
✅ F3 CallGraphBuilder(0.8s,  1,203 calls)
⏳ A1 TaintTracker    (running...)
⏸  I1 CryptoDetector  (waiting for A3, A5)
⬛ F4 VariableLifetime (skipped，已完成)
```

**触发方式：**
- 上传新 trace 后自动打开
- 在会话列表页点击进行中会话旁的"⚡ 进度"按钮手动打开
- 会话详情页顶部内联进度条实时更新（不需要打开侧边抽屉）

**WebSocket 初始化消息**（`type: 'init'`）现在额外携带 `checkpoints` 字段，
供抽屉初次打开时立即显示历史已完成插件的状态，无需等待下一轮事件推送。

### 6.6 Trace 监控页面（TraceMonitor）

路由 `/trace`，监控 JTA Server 内置的 WebSocket Trace 收集端点（`/ws/trace`）的实时状态：

| 显示项 | 说明 |
|--------|------|
| 当前活跃连接数 | 正在收集 trace 的浏览器标签页数量 |
| 已接收批次 | 累计接收的 WebSocket 消息批次 |
| 已接收事件数 | 累计接收的 trace 事件数 |
| 已接收数据量 | 累计接收的字节数（自动换算为 KB/MB/GB） |
| 服务运行时间 | JTA Server 已运行时长 |
| Trace 文件列表 | 按时间排序，显示文件名、大小、修改时间，可一键导入为分析会话 |

**Trace 文件命名规则：** `trace_YYYYMMDD_HHmmss_mmm_NNN.bin`（包含时间戳和序号）

JTA Server 启动时**默认保留**旧 trace 文件，需显式传 `--clear-traces` 参数才会清空目录中的旧 `.bin` / `.smap.json` 文件。`--no-clear-traces` 参数已废弃（向后兼容保留，无实际效果）。

---

## 7. API 设计（后端）

### 7.1 REST API

```
# ── 工作空间（Projects）─────────────────────────────────
POST /api/projects
    上传原始 JS，创建工作空间，异步触发（预处理+）插桩
    body: multipart/form-data { source, name? }
    options:    JSON 字符串，支持 target/sourceType/sandboxVar/inlineIid/inlineSource/
                wsUrl/wsSab（浏览器 target 时注入 projectId）等插桩选项
    preprocess: JSON 字符串，预处理选项，见下方 preprocess 结构说明
    返回：{ projectId, status: 'instrumenting' }

GET  /api/projects
    列出所有工作空间
    返回：[{ id, name, created_at, updated_at, status, iid_count, error_msg }]

GET  /api/projects/:id
    工作空间详情 + 关联会话列表
    返回：{ ...project, sessions: [...], instrumented_size, smap_size, preprocessed_size }

DELETE /api/projects/:id
    删除工作空间（目录 + 数据库记录；关联会话的 project_id 置为 null，不删除会话本身）
    返回：{ deleted: true }

POST /api/projects/:id/fork
    复用源文件重新插桩，创建新工作空间（无需再次上传文件）
    body: { name?, options?, preprocess? }
    返回：{ projectId, status: 'instrumenting' }

GET  /api/projects/:id/progress
    查询插桩进度（轮询备选；推荐使用 WS /ws/projects/:id/progress）
    返回：{ id, status, iid_count, error_msg, updated_at }

GET  /api/projects/:id/instrumented
    下载插桩后代码（.js 文件）

GET  /api/projects/:id/preprocessed
    下载预处理后代码（`_preprocessed_.js`）；若未启用预处理，返回 404

GET  /api/projects/:id/smap
    下载 smap.json

POST /api/projects/:id/sessions
    上传 trace.bin，基于此工作空间的 smap 创建分析会话
    body: multipart/form-data { bin, name? }
    说明：工作空间必须处于 ready 状态才能上传 trace；
          会话源码文件优先使用预处理后代码（preprocessed_path），回退到原始源码
    返回：{ sessionId, status: 'parsing', projectId, smapAvailable: bool }

GET  /api/projects/:id/sessions
    列出该工作空间下的所有分析会话
    返回：[{ id, name, created_at, status, event_count, plugin_status }]

# preprocess 选项结构（在 /api/projects POST/fork 和 /api/instrument POST/run 中均可使用）
preprocess: {
    enabled:       boolean,          -- 是否启用预处理
    preset:        'deobfuscate' | 'normalize-arrow' | 'transpile' | 'full',
    sourceType:    'script' | 'module',
    deobfuscate?:  { replaceVoid?, foldConstants?, splitSequence?,
                     simplifyBoolean?, expandConditional? },
    normalizeArrow?: { preserveThis?, onlyExpression? },
    transpile?:    { targets: 'es2015' | 'es2017' | 'es2020' | 'es2022' }
                   -- 年份标识在后端被映射为 browserslist 查询
                   -- es2015 → chrome 49 / es2017 → chrome 58 / es2020 → chrome 80 / es2022 → chrome 103
}

# ── 插桩工作台 ──────────────────────────────────────────
POST /api/instrument
    插桩源码，返回插桩后代码 + smap
    body:  { code, filename, options }
    返回:  { instrumentedCode, smapJson, mapJson }

POST /api/instrument/run
    在服务端沙箱执行插桩后代码（需 --execution-trace）
    body:  { code, filename, options, env: 'node' | 'jsdom' }
    返回:  { runId }  （立即返回，不等待执行完成；通过 WS 或轮询获取结果）

GET  /api/instrument/run/:runId
    查询运行任务状态
    返回：{ status, stdout, stderr, exitCode, sessionId, durationMs }

# ── 分析会话 ────────────────────────────────────────────
POST /api/sessions
    上传 .bin + .smap.json（可选）+ 原始 .js（可选），创建新会话
    body: multipart/form-data { bin, smap?, source?, name? }
    说明：
      - 创建时先执行 Phase1（F1 EventIndex），会话立即返回；Phase2（F3/F4/A3）自动后台调度
      - .smap.json 为可选。缺失时 F2 SmapLoader 跳过，iid → 行列映射不可用，
        srcText 字段为空，但事件流（事件类型、writes/reads/fields）仍完整可用。
      - 原始 .js 为可选。有则显示在代码视图中，无则代码视图降级为纯事件列表。
      - 上传文件大小限制：1 GB
    返回：{ sessionId, status: 'parsing', smapAvailable: bool }

GET  /api/sessions
    列出所有会话（含 project_id 字段）

GET  /api/sessions/:id
    会话详情 + 插件执行状态 + 文件信息（fileInfo: binFile/smapFile/sourceFile）+ smapCount

DELETE /api/sessions/:id
    删除会话及所有关联数据（文件 + 数据库各表的 session_id 行）
    返回：{ deleted: true }

GET  /api/sessions/:id/checkpoints
    查询插件断点恢复状态
    返回：{ checkpoints: [{ plugin_id, phase, completed_at, duration_ms }] }

GET  /api/sessions/:id/event-types
    返回该会话所有事件类型及其数量
    返回：{ types: [{ type, cnt }] }

POST /api/sessions/:id/re-run
    重新运行分析插件（支持断点续跑或强制重跑）
    body: { forceRerun?: boolean, phase?: 'phase1'|'phase2'|'phase3'|'phase4', plugins?: string[] }
    说明：
      - forceRerun=true 时清除检查点后全量重跑
      - forceRerun=false（默认）时跳过已完成的插件（断点续跑）
      - 也可传 plugins 数组指定具体插件 ID 列表
    返回：{ status: 'scheduled', plugins, phase, forceRerun }

GET  /api/sessions/:id/events?line=42&type=END_EXPR&types=CALL_PRE,CALL&limit=100&cursor=<last_seq>
    查询事件（支持多维过滤）
    分页机制（混合策略）：
      游标分页（普通浏览）：传 cursor=<上页末尾 seq>，后端 id > cursor，O(log N) B-tree 定位
        第一页：不传 cursor（或 cursor=0）；响应包含 nextCursor 供下一页使用
        响应：{ events, count, hasMore, nextCursor: <末页为 null> }
      seqFrom 定位（跨 Tab 跳转）：传 seqFrom=<目标 seq>，后端 id >= seqFrom，直接定位
        前端 EventsTab 跨 Tab 跳转专用；跳转后若翻页，游标从当前页末尾重新计算
      offset 分页（向后兼容）：cursor 未传时生效；不推荐用于深页
    types 参数：多类型过滤（逗号分隔），优先于 type（向后兼容）
    events.type 为整数编码（Phase D），API 响应已自动解码为字符串
    事件对象 fields 数组项：base 字段已改为 baseOid（运行时对象 ID，null 表示未知）

GET  /api/sessions/:id/functions?search=&minCalls=1&minEvents=&maxEvents=&hideBuiltin=0&sortBy=call_count&limit=100&offset=0
    查询函数调用统计（聚合 call_edges 按 fn_name + fn_iid 分组）
    返回：{ functions: [{ fn_name, fn_iid, call_count, event_count, avg_own_event_count, min_line, ... }], total }
    hideBuiltin=1：过滤 JS 内建函数名
    sortBy=event_count：按平均自身事件数排序（衡量函数复杂度）
    minEvents/maxEvents：按 own_event_count 范围过滤（对旧数据降级为 return_seq-call_seq 近似）

GET  /api/sessions/:id/functions/:fnName/calls?limit=200&offset=0&fnIid=&callSeq=
    查询某函数所有调用记录（含参数、返回值、SEQ 范围）
    fnIid：按 fn_iid 精确过滤，区分同名不同位置的函数
    callSeq：自动定位到包含该调用的分页（前端无需手动翻页）
    返回：{ calls: [{ id, call_seq, return_seq, depth, args, return_value, ... }], total, offset }

GET  /api/sessions/:id/calls/:callId/own-events?limit=50&offset=0
    查询单次调用自身事件流（排除子调用事件），支持分页
    返回：{ events: [...], total, ownEventCount }

GET  /api/sessions/:id/functions/:fnName/callers?fnIid=&limit=100&offset=0
    反向调用图：查询调用了指定函数的所有调用者（按调用次数降序）
    fnIid：同名不同位置的函数精确 iid 过滤（可选）
    实现：以 call_edges 的 depth/call_seq/return_seq 字段做 CTE 父帧关联，O(log N) 索引扫描
    返回：{
      callers: [{ callerFnName, callerFnIid, callCount, calleeMinLine,
                  callerMinDepth, callerMaxDepth, callerMinLine }],
      total,
      totalCalls   -- 目标函数被调用总次数（用于前端显示百分比）
    }
    说明：顶层调用（depth=0）的调用者 callerFnName = '(top-level)'

GET  /api/sessions/:id/call-stack?callSeq=N&returnSeq=M&depth=D
    查询某次函数调用的完整调用栈（祖先帧列表，按深度升序）
    返回：{ stack: [{ fnName, fnIid, callerLine, depth, args, returnValue, callSeq, returnSeq }] }

GET  /api/sessions/:id/events/:seq/owner-fn
    查询某个事件所属的最近函数帧（包含该 seq 的 depth 最大的 call_edge）
    返回：{ call: { fnName, fnIid, callerLine, depth, callSeq, returnSeq, ... } } 或 null

GET  /api/sessions/:id/flamegraph?seqFrom=&seqTo=&maxDepth=20&minSelf=0
    生成 Speedscope 兼容的火焰图 JSON（可直接导入 speedscope.app）
    seqFrom/seqTo：时间窗口过滤（可选，不传则覆盖全量 trace）
    maxDepth：最大调用深度（默认 20）；minSelf：过滤 self time 过小的函数（默认 0，不过滤）
    实现：查询 call_edges → Node.js 端重建调用树 → 计算 total/self time → 拼装 Speedscope JSON
    返回：Speedscope $schema 格式 JSON，profiles[0] 为 sampled profile

GET  /api/sessions/:id/cfg?rootFn=&depth=3&minCount=10&foldLoops=true&includeIids=true
    动态控制流图（Dynamic CFG）— 基于真实执行数据的函数调用拓扑图
    rootFn：以指定函数名为根（仅返回其子树），不填返回完整 CFG
    depth：展开深度（默认 3，最大 8）
    minCount：iid_counts 执行次数阈值，过滤低频节点（默认 10）
    foldLoops：是否折叠循环块（默认 true）
    includeIids：是否显示热点 IID 节点（默认 true）
    返回：{
      nodes: [{ id, type: 'function'|'loop'|'hotspot', fnName?, fnIid?, callCount?,
                minLine?, hasLoop?, iid?, totalIters?, count?, srcText?, isRoot? }],
      edges: [{ source, target, count, type: 'call'|'loop' }],
      stats: { nodeCount, edgeCount, fnCount, hotspotCount, loopCount }
    }

GET  /api/sessions/:id/fn-cfg?fnName=&maxCalls=20
    IDA 风格单函数内部控制流图（基本块 + 块间跳转边）
    fnName：目标函数名（必填）
    maxCalls：采样调用次数上限（默认 20，最大 100）
    实现：采样 N 次调用 → union 自身事件的 iid 序列 → 按行号分块 → 统计块间 iid 转移频率 → 构建边
    返回：{
      fnName, totalCalls, sampledCalls,
      blocks: [{ id, iids, lines, srcTexts, execCounts, presence, subCalls, isEntry }],
      edges:  [{ source, target, count, type: 'sequential'|'branch'|'loop_back' }],
      stats:  { blockCount, edgeCount, iidCount }
    }

GET  /api/sessions/:id/value-search?num=0.5&str=foo&strLike=*secret*&varName=key&source=write&limit=200
    按值搜索 value_index 表，返回匹配的 event_id 列表
    支持：num（精确数值）/ numMin+numMax（数值范围）/ str（精确字符串）/ strLike（通配符，* 匹配任意）/ varName（按变量名过滤）
    返回：{ matches: [{ event_id, val_type, val_num, val_str, var_name, source }], count }

GET  /api/sessions/:id/value-search/events?num=0.5&varName=key&offset=0&limit=50
    值搜索 + 事件详情合并接口（一次请求完成"按值找事件"并返回完整事件数据）
    解决原方案"取 min/max 范围 + 前端二次过滤"的分页不准问题
    参数与 value-search 相同，额外支持 offset/limit 分页
    返回：{ events: [...], total, count, hasMore }

GET  /api/sessions/:id/value-dict/stats
    值字典统计信息（value_dict 表）
    返回：{ total, byType: { num, str, bool, null, obj }, topValues: [{ val_text, val_type, refCount }] }
    refCount = 该值在 writes+reads+fields 中被引用的总次数

GET  /api/sessions/:id/value-dict?type=num&text=foo&numMin=0&numMax=100&offset=0&limit=50&withRefCount=false
    查询值字典条目，支持：
      type（按 val_type 过滤）/ text（精确文本匹配）/ numMin+numMax（数值范围，仅 type=num）
      offset+limit（分页）/ withRefCount=true（附带引用计数，需 JOIN writes/reads/fields，较慢）
    返回：{ entries: [{ id, val_text, val_type, val_num, refCount? }], total, hasMore }

GET  /api/sessions/:id/taint?var=key&direction=forward
    触发/获取污点追踪结果

GET  /api/sessions/:id/hot-iids
    热路径数据（iid 执行次数统计）

GET  /api/sessions/:id/call-graph
    调用图数据

GET  /api/sessions/:id/loop-iterations?seqFrom=&seqTo=&limit=200&offset=0
    循环迭代快照数据（A5 LoopDetector 输出）
    seqFrom/seqTo：时间窗口过滤，只返回循环起始 seq 在该范围内的记录（可选）
    返回：{ iterations: [{ loopIid, round, seq, vars }], total }

GET  /api/sessions/:id/value-patterns?seqFrom=&seqTo=&limit=200&offset=0
    值模式检测结果（A8 ValuePatternDetector 输出，35+ 魔术常数）
    seqFrom/seqTo：时间窗口过滤，只返回 event_id 在该范围内的记录（可选）
    返回：{ patterns: [{ event_id, name, value, matched_constant, category }], total }

GET  /api/sessions/:id/strings?seqFrom=&seqTo=&limit=500&offset=0
    字符串追踪结果（A4 StringTracker 输出）
    seqFrom/seqTo：时间窗口过滤（可选）
    返回：{ strings: [{ event_id, name, value, length }], total }

GET  /api/sessions/:id/object-timelines?seqFrom=&seqTo=&limit=200&offset=0
    对象属性变化时间线（A7 ObjectMutationTracker 输出）
    seqFrom/seqTo：时间窗口过滤，只返回 seq 在该范围内的记录（可选）
    返回：{ timelines: [{ base_var, seq, mutation_type, offset, value, src_text }], total }

GET  /api/sessions/:id/dataflow?seqFrom=&seqTo=&limit=200&offset=0
    数据流边（A2 DataFlowGraph 输出）
    seqFrom/seqTo：时间窗口过滤，只返回 from_seq 在该范围内的记录（可选）
    返回：{ edges: [{ from_seq, to_seq, var_name, from_line, to_line }], total }

GET  /api/sessions/:id/crypto-hints
    加密检测结果

GET  /api/sessions/:id/summary
    AlgorithmSummarizer 输出

GET  /api/sessions/:id/bookmarks
    列出书签

POST /api/sessions/:id/bookmarks
    创建书签 { seq, label, note }

DELETE /api/sessions/:id/bookmarks/:bid
    删除书签

# ── Trace 收集 ──────────────────────────────────────────
GET  /api/trace/stats
    获取 WebSocket Trace 收集统计（连接数、批次数、事件数、字节数、运行时间）
    返回：{ connections, batchesReceived, eventsReceived, bytesReceived, uptime, tracesDir }

GET  /api/trace/files?q=xxx&offset=0&limit=100
    列出 traces 目录中的 .bin 文件（支持搜索和分页）
    返回：{ files: [{ name, alias, projectId, projectName, size, mtime }], total, offset, limit }

PUT  /api/trace/files/:name
    设置 trace 文件别名（不改磁盘文件名）
    body: { alias: 'my-trace-name' }
    返回：{ ok: true, name, alias }

DELETE /api/trace/files/:name
    删除 trace 文件（同时删除对应 .smap.json 及别名/映射记录）
    返回：{ ok: true, deleted: name }

POST /api/trace/files/batch-delete
    批量删除 trace 文件
    body: { names: ['trace_xxx.bin', ...] }
    返回：{ deleted: [...], errors: [...] }

GET  /api/trace/files/:name/download
    下载 trace 文件（二进制流）

POST /api/trace/import
    将 traces 目录中的 .bin 文件导入为新分析会话
    body: { filename: 'trace_xxx.bin', name?: 'session-name', projectId?: '...' }
    说明：指定 projectId 时自动关联工作空间的 smap 和源码
    返回：{ sessionId }

GET  /api/health
    健康检查
    返回：{ status: 'ok', version, uptime }

# ── 空间分析 ─────────────────────────────────────────────
GET  /api/storage/stats
    扫描 data 目录（uploads / sessions / projects），统计各分类文件占用，生成清理建议
    返回：{
        summary: {
            totalSize, totalSizeStr,
            breakdown: {
                uploads:  { size, sizeStr, count },
                sessions: { size, sizeStr, count },
                projects: { size, sizeStr, count },
                database: { size, sizeStr }
            }
        },
        uploads:  [{ type, path, name, size, sizeStr, mtime, ageStr, orphan }],
        sessions: [{ type, id, path, name, size, sizeStr, fileCount, status, eventCount,
                     projectId, createdAt, mtime, ageStr, orphan }],
        projects: [{ type, id, path, name, size, sizeStr, fileCount, status, iidCount,
                     createdAt, mtime, ageStr, orphan }],
        suggestions: [{
            id, priority: 'high'|'medium'|'low'|'info', category, title, description,
            savedSize, savedSizeStr,
            items: [{ path, name?, id?, size, sizeStr, ageStr }]
        }]
    }
    清理建议 ID 说明：
        orphan-uploads   — 孤立 uploads 临时文件（未被任何 session/project 引用）
        orphan-sessions  — 孤立 session 目录（目录存在但 DB 无记录）
        orphan-projects  — 孤立 project 目录（同上）
        failed-projects  — 插桩失败的工作空间
        old-sessions     — 30 天未使用的大型会话（>1MB）
        all-clean        — 无需清理（info 级别正面提示）

POST /api/storage/delete
    批量删除：uploads 孤立文件、session 目录、project 目录
    body: { items: [{ type: 'upload'|'session_dir'|'project_dir', path, id? }] }
    安全约束：path 必须在 data/ 目录内；不可删除 DB 文件本身
    删除 session_dir 时同步删除 DB 中对应 sessions + plugin_checkpoints 记录
    删除 project_dir 时同步删除 DB 中对应 projects 记录并将关联 sessions.project_id 置 null
    返回：{ results: [{ ok, path, type, freedSize?, error? }], freed, freedStr, successCount, errorCount }

# ── 多会话对比分析 ───────────────────────────────────────────
# 所有接口均为 POST，body 中传 sessionIds 数组（2~8 个会话 ID）
# 性能原则：多 session 数据用 IN 子句单次查询 + GROUP BY session_id 聚合，不串行 N 次查询

POST /api/compare/sessions
    对比多个 Session 的整体指标（事件数、函数数、调用数、循环、最大深度、热点 IID）
    body: { sessionIds: string[] }   -- 2~8 个 sessionId
    返回：{
      sessions: [{ sessionId, name, createdAt, eventCount, typeDist, fnCount, callCount,
                   loopCount, totalIters, maxDepth, hotIids: [{iid, count, line, src_text}] }],
      divergence: [{ sessionId, name, deltaEvents, deltaFns, deltaCalls,
                     typeDelta: { [type]: {base, curr, delta, pct} },
                     deltaLoops, deltaIters, deltaDepth }]  -- 基准为 sessions[0]
    }

POST /api/compare/functions
    对比多个 Session 的函数调用分布（按调用次数排序，可隐藏内建函数）
    body: { sessionIds: string[], limit?: number, hideBuiltin?: boolean }
    返回：{
      sessions: [{ sessionId, name }],
      functions: [{ fnName, sessions: { [sessionId]: { callCount, eventCount, minLine } } }]
    }

POST /api/compare/hot-iids
    对比多个 Session 的热点 IID（Top-N 执行次数）
    body: { sessionIds: string[], topN?: number }
    返回：{
      sessions: [{ sessionId, name }],
      iids: [{ iid, line, src_text, counts: { [sessionId]: number } }]
    }

POST /api/compare/events
    对比多个 Session 的事件类型分布
    body: { sessionIds: string[] }
    返回：{
      sessions: [{ sessionId, name }],
      types: [{ type, counts: { [sessionId]: number } }]
    }

POST /api/compare/loops
    对比多个 Session 的循环执行情况（循环数、总迭代次数）
    body: { sessionIds: string[] }
    返回：{
      sessions: [{ sessionId, name }],
      loops: [{ iid, line, iterCounts: { [sessionId]: number } }]
    }
```

### 7.2 WebSocket

```
WS /ws/projects/:id/progress
    订阅工作空间插桩进度（实时推送）
    连接后立即推送当前状态快照
    消息格式：
      { type: 'init', projectId, status, iid_count, error_msg }
      { type: 'instrument_start', projectId }
      { type: 'preprocess_start', projectId }          -- 预处理阶段开始（仅启用预处理时）
      { type: 'preprocess_done',  projectId }          -- 预处理阶段完成
      { type: 'instrument_done', projectId, iidCount, smapAvailable, preprocessingApplied }
      { type: 'error', projectId, message }

WS /ws/sessions/:id/progress
    订阅插件执行进度（实时推送）
    连接后立即推送 init 消息（含 pluginStatus + checkpoints）
    消息格式：
      { type: 'init', sessionId, status, pluginStatus, checkpoints }
      { type: 'schedule_start', phase, plugins, toRun, skipped }
      { type: 'plugin_start', plugin, phase }
      { type: 'plugin_progress', plugin, message, progress }
      { type: 'plugin_done', plugin, phase, durationMs }
      { type: 'plugin_error', plugin, message }
      { type: 'all_done', phase, toRun, skipped }
      { type: 'phase_start', sessionId, phase, plugins }

WS /ws/instrument/run/:runId  （也支持 /ws/run/:runId，两条路径均可）
    订阅服务端运行输出流
    消息格式：
      { type: 'stdout', data: '...' }
      { type: 'stderr', data: '...' }
      { type: 'done',   sessionId: '...', exitCode: 0 }
      { type: 'error',  message: '...' }

WS /ws/trace
    浏览器端 Trace 收集（原 trace-server 功能，已集成进 JTA Server）
    可携带查询参数 ?projectId=xxx 自动关联工作空间
    协议：二进制帧 [u32 batchId LE][事件流 bytes]
    响应：ACK 帧 [u32 batchId LE]（4 字节）
    说明：文件保存到 TRACES_DIR，收集完成后可通过 /api/trace/import 导入
```

---

## 8. 目录结构

```
Jani/
├── bin/
│   └── jalangi.mjs           # 现有插桩入口
├── tools/
│   ├── trace-parse.mjs        # 现有 CLI
│   └── trace-render.mjs       # 现有 CLI
├── analyzer/                  # JTA 主目录
│   ├── server.mjs             # Express 服务入口（默认端口 33000；内置 /ws/trace Trace 收集）
│   ├── PluginEngine.mjs       # 插件调度器（含断点恢复、分阶段调度）
│   ├── InstrumentRunner.mjs   # 服务端沙箱运行（WS 推流输出）
│   ├── logger.mjs             # 日志封装（pino）
│   ├── db/
│   │   ├── schema.sql         # 表结构定义（含 projects / plugin_checkpoints 等全部表）
│   │   ├── Database.mjs       # SQLite 封装（better-sqlite3，LRU stmt 缓存 + 在线迁移）
│   │   └── EventTypeCode.mjs  # events.type 整数编码双向映射（与 EventSerializer 字节值对齐）
│   ├── plugins/               # 所有分析插件（平铺，无子目录）
│   │   ├── BasePlugin.mjs     # 插件基类
│   │   ├── F1_EventIndex.mjs  # 基础：事件索引 + 值索引（BATCH_SIZE=5000，yield 让出事件循环）
│   │   ├── F2_SmapLoader.mjs
│   │   ├── F3_CallGraphBuilder.mjs  # 调用图 + own_event_count 预计算
│   │   ├── F4_VariableLifetime.mjs
│   │   ├── A1_TaintTracker.mjs
│   │   ├── A2_DataFlowGraph.mjs
│   │   ├── A3_HotPathAnalyzer.mjs
│   │   ├── A4_StringTracker.mjs
│   │   ├── A5_LoopDetector.mjs
│   │   ├── A7_ObjectMutationTracker.mjs
│   │   ├── A8_ValuePatternDetector.mjs
│   │   ├── I1_CryptoDetector.mjs
│   │   ├── I2_SignatureAnalyzer.mjs
│   │   ├── I3_ObfuscationDetector.mjs
│   │   └── I4_AlgorithmSummarizer.mjs
│   ├── routes/
│   │   ├── sessions.mjs       # 会话路由入口（组合子模块 + 导出 createSession）
│   │   ├── sessions/          # 会话 API 子模块
│   │   │   ├── core.mjs       # 会话 CRUD + 插件分阶段调度（re-run / delete / checkpoints）
│   │   │   ├── events.mjs     # 事件查询 API（event-types / events / value-search）
│   │   │   ├── functions.mjs  # 函数调用 API（functions / calls / call-graph / call-stack）
│   │   │   ├── analysis.mjs   # 分析结果 API（hot-iids / taint / dataflow / summary 等）
│   │   │   └── utils.mjs      # 共享工具（safeParseJson / groupBy / BUILTIN_FN_NAMES）
│   │   ├── instrument.mjs     # 插桩 API（显式 --output，支持 wsUrl/wsSab，支持预处理）
│   │   ├── projects.mjs       # 工作空间 API（上传/插桩/fork/下载/关联会话，支持预处理）
│   │   ├── storage.mjs        # 空间分析 API（stats 统计 + delete 批量清理）
│   │   └── compare.mjs        # 多会话对比 API（sessions/functions/hot-iids/events/loops）
│   └── ui/                    # Vue 3 前端
│       ├── index.html
│       ├── src/
│       │   ├── App.vue        # 顶部导航（工作空间 / 会话 / 插桩工作台 / Trace 监控 / 空间分析）
│       │   ├── main.js        # 路由注册（/workspaces / /sessions / /instrument / /trace / /storage）
│       │   ├── components/
│       │   │   └── session/   # 会话详情标签页组件
│       │   │       ├── CryptoTab.vue       # 加密检测标签页
│       │   │       ├── DataflowTab.vue     # 数据流图标签页
│   │   │       ├── EventsTab.vue       # 事件列表标签页（含值搜索、跨Tab跳转）
│   │   │       #   普通模式：游标分页（cursorStack，O(log N) B-tree 定位，深页恒速）
│   │   │       #   值搜索模式：offset 分页（结果集有限，随机翻页需求高）
│   │   │       #   跨Tab跳转：seqFrom 精确定位（无需估算页码）
│   │   │       ├── FileInfoBar.vue     # 文件信息栏
│   │   │       ├── FunctionsTab.vue    # 函数列表标签页（事件数过滤、内建函数隐藏、调用定位、被谁调用子面板、内嵌火焰图）
│   │   │       ├── CallDetail.vue      # 函数调用详情面板（调用栈 / 事件流，由 FunctionsTab 使用）
│       │   │       ├── LoopsTab.vue        # 循环分析标签页
│       │   │       ├── ObfuscationTab.vue  # 混淆检测标签页
│       │   │       ├── ObjMutTab.vue       # 对象变异标签页
│       │   │       ├── PatternsTab.vue     # 值模式标签页
│       │   │       ├── SessionCard.vue     # 会话卡片组件
│       │   │       ├── SessionHeader.vue   # 会话头部信息
│       │   │       ├── SignaturesTab.vue   # 签名分析标签页
│       │   │       ├── StringsTab.vue      # 字符串追踪标签页
│       │   │       ├── SummaryTab.vue      # 算法摘要标签页
│       │   │       ├── CfgTab.vue          # 控制流图标签页（Dynamic CFG + fn-cfg，Cytoscape 渲染）
│       │   │       ├── UploadDialog.vue    # 上传 trace 对话框
│       │   │       ├── ImportFromTraceDialog.vue   # 从 trace 目录导入对话框
│       │   │       └── DeleteConfirmDialog.vue      # 删除确认对话框
│       │   ├── composables/
│       │   │   └── useSessionUtils.js     # 会话工具函数
│       │   └── views/
│       │       ├── WorkspaceList.vue       # 工作空间列表（/workspaces）
│       │       ├── WorkspaceDetail.vue     # 工作空间详情（/workspaces/:id）
│       │       ├── ForkModal.vue           # 重新插桩（Fork）弹窗组件（由 WorkspaceDetail 使用）
│       │       ├── SessionList.vue         # 会话列表（/sessions）
│       │       ├── SessionDetail.vue       # 会话详情（/sessions/:id，多标签页分析）
│       │       ├── InstrumentStudio.vue    # 插桩工作台（/instrument）
│       │       ├── InstrumentOptions.vue   # 插桩选项面板（嵌入式组件）
│       │       ├── PreprocessOptions.vue   # 预处理选项面板（嵌入式组件，可折叠）
│       │       ├── ProgressDrawer.vue      # 分析进度侧边抽屉
│       │       ├── TraceMonitor.vue        # Trace 收集状态监控（/trace）
│       │       ├── StorageAnalyzer.vue     # 空间分析页（/storage）
│       │       └── TraceDiff.vue           # Trace 对比页（/diff），多会话执行行为差异对比
│       └── vite.config.js               # Vite 代理端口 → 33000
│   ├── data/                  # 运行时生成的数据目录
│   │   ├── jta.db             # SQLite 数据库（主库）
│   │   ├── projects/          # 工作空间目录（每个 uuid 一个子目录）
│   │   ├── sessions/          # 会话目录（每个 uuid 一个子目录）
│   │   └── uploads/           # multer 临时上传目录
│   └── traces/                # trace 文件目录（WebSocket 收集输出）
│       ├── _aliases.json      # trace 文件别名映射
│       └── _project_map.json  # trace 文件 → projectId 映射
└── docs/
    └── TraceAnalyzer-Design.md  # 本文档
```

---

## 9. 开发路线图

### Phase 1：基础骨架（MVP）✅ 已完成
- [x] `analyzer/server.mjs`：Express + 文件上传（1 GB 限制，默认端口 33000）
- [x] `db/schema.sql` + `Database.mjs`（sql.js 实现，见 3.3 节；含 `plugin_checkpoints` 表）
- [x] `PluginEngine.mjs`：拓扑排序 + 并发执行 + **断点恢复** + **分阶段调度**
- [x] F1 EventIndex + F2 SmapLoader
- [x] 基础 REST API（上传 / 查询事件）
- [x] UI：会话列表 + 事件列表 + 插件状态面板（Vue 3 + Vite，`ui/dist/` 已构建）
- [x] **插桩工作台（完整）**：源码编辑 + 选项面板 + 插桩预览 + **复制按钮** + 服务端运行闭环（`/api/instrument` + `/api/instrument/run`）
- [x] **ProgressDrawer**：实时分析进度侧边抽屉，上传后自动打开
- [x] **TraceMonitor 页面**（`/trace`）：WebSocket Trace 收集状态监控，含文件列表和一键导入
- [x] **Trace Server 集成**：原独立 `trace-server` 已集成进 JTA Server（`/ws/trace` 端点）
- [x] 端到端验证：插桩 → 上传 → Foundation 插件全部 done（`GET /api/health` + `GET /api/sessions` 正常响应）

### Phase 2：核心分析 ✅ 已完成
- [x] F3 CallGraphBuilder
- [x] F4 VariableLifetime（持久化到 SQLite）
- [x] A1 TaintTracker（正向 + 反向，覆盖 writes/reads/fields/call_edges.return_value）
- [x] A2 DataFlowGraph
- [x] A3 HotPathAnalyzer
- [x] A4 StringTracker
- [x] UI：SessionDetail 多标签页（事件流 / 调用图 / 数据流图 / 对象变异）

### Phase 3：高级分析 ✅ 已完成
- [x] A5 LoopDetector（`loop_iterations` 表）
- [x] A8 ValuePatternDetector（`value_patterns` 表，35+ 魔术常数）
- [x] I1 CryptoDetector（`crypto_hints` 表，置信度 0~1）
- [x] I2 SignatureAnalyzer（`signature_paths` 表，反向 BFS）
- [x] UI：新增密码学常数高亮、置信度进度条、签名路径列表标签页
- [x] 后端 API：`/run-phase3`，A5/A8/I1/I2 全部 done

### Phase 4：推理与报告 ✅ 已完成
- [x] A7 ObjectMutationTracker（`object_timelines` 表）
- [x] I3 ObfuscationDetector（`obfuscation_hints` 表，含控制流混淆检测）
- [x] I4 AlgorithmSummarizer（`analysis_summary`，Markdown 报告）
- [x] 后端 API：`/run-phase4`，A2/A4/A7/I3/I4 全部 done
- [x] 完整流程端到端验证通过（2026-04-05，7 行测试文件，15 条事件，全部插件 done）
- **注：** A6 FunctionSignatureInfer 已在后续重构中移除（见 Phase 8）

> **当前状态：** JTA 服务运行在 `http://localhost:33000`，全部分析插件已完工，工作空间管理、预处理集成、空间分析功能均已实装。

### Phase 5：工作空间管理 ✅ 已完成
- [x] `db/schema.sql` 新增 `projects` 表
- [x] `routes/projects.mjs`：工作空间 CRUD + fork + 关联会话
- [x] `server.mjs` 集成 `/ws/projects/:id/progress` WS 端点
- [x] `ui/views/WorkspaceList.vue`：工作空间列表 + 新建弹窗
- [x] `ui/views/WorkspaceDetail.vue`：详情 + 插桩状态 + 关联会话 + 上传 trace
- [x] Trace 文件管理扩展：别名、删除、批量删除、下载
- [x] `/api/trace/import` 支持 `projectId` 参数自动关联 smap 和源码
- [x] `trace-server` 收集时通过 `?projectId=xxx` 自动记录来源工作空间

### Phase 6：预处理集成 + 空间分析 ✅ 已完成
- [x] `routes/instrument.mjs`：`/api/instrument` + `/api/instrument/run` 支持可选预处理（`preprocess` 字段）
- [x] `routes/projects.mjs`：`POST /api/projects` + `POST /api/projects/:id/fork` 支持预处理选项；`GET /api/projects/:id/preprocessed` 端点下载预处理后代码；`GET /api/projects/:id` 返回 `preprocessed_size`；创建会话时优先使用预处理后代码（`preprocessed_path`）
- [x] `db/Database.mjs`：迁移脚本自动为 `projects` 表添加 `preprocessed_path` 列
- [x] `db/schema.sql`：`projects` 表新增 `preprocessed_path` 字段
- [x] `routes/storage.mjs`（新文件）：`GET /api/storage/stats` 空间统计 + `POST /api/storage/delete` 批量清理；安全约束：路径限 data/ 目录，不可删除 DB 文件
- [x] `server.mjs`：挂载 `/api/storage` 路由
- [x] `ui/views/PreprocessOptions.vue`（新文件）：预处理选项面板，支持 4 种 Preset（deobfuscate / normalize-arrow / transpile / full）、反混淆子开关、语法降级目标选择
- [x] `ui/views/InstrumentStudio.vue`：集成 `PreprocessOptions`，传递 preprocess 参数至 `/api/instrument` 和 `/api/instrument/run`；新增"⚙ 已预处理"标识和"下载预处理代码"按钮
- [x] `ui/views/StorageAnalyzer.vue`（新文件）：空间分析页，展示空间占用总览、按类别分级清理建议，支持一键执行清理
- [x] `ui/src/App.vue`：导航栏新增"空间分析"链接
- [x] `ui/src/main.js`：注册 `/storage` 路由

### Phase 7：MCP Server
- [ ] `mcp/client.mjs`：JTA REST API HTTP 封装
- [ ] `mcp/tools/` 所有 Tool 定义（参数 schema + 结果格式化）
- [ ] `mcp/jta-mcp-stdio.mjs`：stdio 传输，供本地 Claude Desktop / OpenClaw 使用
- [ ] `mcp/jta-mcp-sse.mjs`：HTTP SSE 传输，供远程 LLM 访问
- [ ] 配置示例：Claude Desktop `claude_desktop_config.json` 片段

### Phase 8：数据库优化重构 ✅ 已完成
- [x] **SQLite 后端切换**：`sql.js`（内存 WASM）→ `better-sqlite3`（原生同步 C++）
  - 批量 INSERT 速度提升 4–8×；WAL 模式支持并发读；直接写磁盘，无需手动 flush
  - 同步 API 消除异步回调层，大幅简化插件代码
- [x] **LRU Prepared Statement 缓存**：容量 200 条，覆盖所有插件热路径 SQL，消除重复编译开销
- [x] **在线迁移（Online Migration）**：`Database.mjs` 启动时自动检测缺失列并 `ALTER TABLE ADD COLUMN`，数据库向后兼容，旧会话无需重建
- [x] **Schema 优化**：
  - `events.type`：`TEXT` → `INTEGER`（引入 `EventTypeCode.mjs` 整数编码双向映射）
  - `events` 表移除 `line`、`col`、`src_text` 列（改由 smap 动态查询，减少 DB 体积）
  - `fields` 表 `base` 字段改为 `base_oid`（运行时对象唯一 ID，取代序列化后的 base 值，精确追踪对象属性）
  - `call_edges` 表新增 `own_event_count`（记录函数调用自身的事件数，供 FunctionsTab 排序过滤）
- [x] **`value_index` 表**：新增事件值类型化索引表，由 F1 EventIndex 填充，支持 `/api/sessions/:id/value-search` 值搜索 API
- [x] **新增 API**：
  - `GET /api/sessions/:id/functions`（函数列表，支持事件数过滤、内建函数隐藏）
  - `GET /api/sessions/:id/functions/:fnName/calls`（函数调用详情）
  - `GET /api/sessions/:id/calls/:callId/own-events`（函数自身事件流）
  - `GET /api/sessions/:id/call-stack`（调用栈快照）
  - `GET /api/sessions/:id/events/:seq/owner-fn`（事件所属函数）
  - `GET /api/sessions/:id/value-search`（按值搜索 `value_index`）
  - `GET /api/sessions/:id/value-search/events`（值搜索 + 事件详情合并）
- [x] **A6 FunctionSignatureInfer 移除**：功能冗余，依赖该插件的 `I2`/`I4` 已更新依赖关系
- [x] **EventSerializer 增强**：屏蔽对象 `toJSON` 方法防止插桩代码递归调用；`fields` 序列化切换到 `base_oid`
- [x] **`value_dict` 表**：值字典去重表，由 F1 EventIndex v2 填充
  - `writes/reads/fields` 各新增 `value_id INTEGER` 列（外键引用 `value_dict.id`）
  - 旧数据 `value_id = NULL`（向后兼容），新会话完整填充
  - 内存 `Map<val_text, id>` + 局部计数器，零额外 DB 查询；`INSERT OR IGNORE` 批量幂等写入
  - 三条新 API：`GET /api/sessions/:id/value-dict`（条目查询） + `GET /api/sessions/:id/value-dict/stats`（统计）
  - `_runMigrations` 自动升级旧库（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`）
  - value_dict / value_id 索引仅在 `_runMigrations` 中创建，避免 `schema.sql` 执行时"列不存在"报错

### Phase 9：代码质量重构 ✅ 已完成
- [x] **`routes/sessions.mjs` 拆分**（原 ~1967 行 → 5 个子模块）：
  - `sessions/core.mjs`：会话 CRUD + 插件分阶段调度（re-run / delete / checkpoints）
  - `sessions/events.mjs`：事件查询 API（event-types / events / value-search / **value-dict**）
  - `sessions/functions.mjs`：函数调用 API（functions / calls / call-graph / call-stack / owner-fn）
  - `sessions/analysis.mjs`：分析结果 API（hot-iids / taint / dataflow / strings / object-timelines / summary 等）
  - `sessions/utils.mjs`：共享工具函数（`safeParseJson` / `groupBy` / `BUILTIN_FN_NAMES`）
  - `sessions.mjs` 保留为入口文件，组合子路由并导出 `createSession`
- [x] **`WorkspaceDetail.vue` 拆分**：Fork Modal 逻辑提取为独立组件 `ForkModal.vue`（props + emits 接口）
- [x] **`FunctionsTab.vue` 拆分**：函数调用详情面板（调用栈 / 事件流）提取为独立组件 `CallDetail.vue`

### Phase 10：高级可视化与多维分析 ✅ 已完成
- [x] **值字典（value_dict）**：全局唯一字符串池，`writes/reads/fields.value_id` 引用去重存储
  - 内存 `Map<val_text, id>` 零额外查询，`INSERT OR IGNORE` 批量幂等写入
  - 三条 API：`GET /value-dict`（条目查询）、`GET /value-dict/stats`（统计）
  - `_runMigrations` 自动升级旧库（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`）
- [x] **TypedArray 支持**：`EventSerializer` 增加 TypedArray/ArrayBuffer 编解码；`value_dict` 和 `value_index` 新增 `val_type='ta'`；新增 `idx_vi_ta` 部分索引优化查询
- [x] **事件列表游标分页**：普通模式由 offset 分页改为游标分页（`cursor=<last_seq>`，O(log N) B-tree 定位），彻底消除深页线性扫描问题；跨 Tab 跳转使用 `seqFrom` 精确定位；值搜索模式保留 offset 分页
- [x] **火焰图接口**（`GET /flamegraph`）：Speedscope 格式 JSON，可直接导入 speedscope.app；支持 `seqFrom/seqTo` 时间窗口过滤和 `minSelf` 阈值
- [x] **反向调用图**（`GET /functions/:fnName/callers`）：CTE 父帧关联，O(log N) 索引扫描；`FunctionsTab.vue` 新增"被谁调用"子面板，含调用次数占比和调用者跳转
- [x] **内嵌火焰图组件**（`FunctionsTab.vue`）：支持渲染、缩放、下钻及导出 Speedscope JSON
- [x] **动态控制流图**（`GET /cfg`）：函数调用拓扑图，支持循环节点标注、热点 IID 节点、深度过滤、根函数子树视角；Cytoscape.js 渲染
- [x] **单函数内部 CFG**（`GET /fn-cfg`）：IDA 风格基本块划分，采样多次调用取 union 路径，块间 iid 转移频率统计；`CfgTab.vue` 新增控制流图标签页
- [x] **多会话对比分析**（`POST /api/compare/*`）：5 个对比维度（整体指标 / 函数分布 / 热点 IID / 事件类型 / 循环），所有维度均用 `IN + GROUP BY session_id` 单次查询，支持 2~8 个会话并发对比；分歧计算（delta/pct）纯 JS 层实现
- [x] **Trace 对比页面**（`TraceDiff.vue`，路由 `/diff`）：多会话执行行为差异可视化，导航栏新增入口
- [x] **`routes/compare.mjs`（新文件）**：多对比 API 全部实现，内建函数黑名单预拼 SQL 供 LRU 缓存

---

## 10. 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据库 | SQLite（**better-sqlite3**） | 零部署、本地、点查快；原生 C++ 扩展，同步 API 无异步开销；WAL 模式直接写磁盘，批量 INSERT 比 sql.js 快 4–8×；污点链 BFS 在 Node.js 层处理 |
| 本地 vs 服务化 | 本地运行 | 目标代码可能含敏感逻辑，不适合上传到服务器 |
| 插件并发 | 拓扑排序后并发执行无依赖插件 | 充分利用 I/O 等待时间 |
| 污点追踪粒度 | 变量名级别（非字节级） | JS 动态 trace 的天然粒度，足够逆向分析使用 |
| 前端框架 | Vue 3 | 生态好，CodeMirror/Cytoscape 集成成熟 |
| 大 trace 处理 | 流式导入（批量 INSERT） | 百万级事件不 OOM |
| 插桩工作台运行方式 | 服务端 Node.js 沙箱 + WS 推流 | 本地运行无需额外环境，stdout/stderr 实时可见 |
| 插桩结果展示 | 直接展示插桩后代码 | 直观，便于理解钩子插入位置 |
| 插桩页入口 | 独立路由 `/instrument` | 与会话分析页解耦，功能专注 |
| MCP 传输协议 | stdio + HTTP SSE 双实现 | stdio 供本地直连，SSE 供远程 LLM 访问，覆盖所有场景 |
| MCP 权限控制 | 暂不实现 | 本地工具，无需隔离；后续按需添加 |
| MCP 传输标准 | Streamable HTTP（主）+ SSE（兼容）+ stdio（本地） | 覆盖新旧客户端，符合 MCP 2025-03-26 规范 |
| value_dict 与 value_index 共存 | value_dict = 去重存储；value_index = 反查索引 | 两者定位不同：value_dict 节省存储（重复值只存一份）并支持 JOIN 聚合；value_index 保留精确的"值→事件"映射，上限 50 防爆炸，供 value-search API 使用 |
| value_id 索引创建时机 | 不放 schema.sql，改放 `_runMigrations`（ALTER TABLE 之后） | 旧数据库升级时 `value_id` 列通过 ALTER TABLE 添加；若提前在 schema.sql 建索引，exec(schema) 会因列不存在报"SqliteError: no such column"而启动失败 |
| F4 VariableLifetime | 持久化到 SQLite | 避免跨会话重跑插件时数据丢失 |
| JS 执行环境 | Node.js + JSDOM 可选 | 目标 JS 可能依赖浏览器环境，纯 Node.js 无法运行 |
| .smap.json 必填性 | 可选（降级处理） | 缺失时跳过 F2，iid 映射不可用，但事件流仍完整 |
| TaintTracker 追踪范围 | writes + reads + fields + call return | 覆盖变量/属性/函数返回值，obj.key 和 arr[i] 不遗漏 |
| InstrumentRunner 超时 | 30s kill + 3 并发 + 1MB 输出截断 | 防止恶意或无限循环代码耗尽资源 |
| 上传文件大小限制 | 1 GB | 支持大型 JS 文件（原 200 MB 不够用） |
| 断点恢复 | `plugin_checkpoints` SQLite 表 | 插件完成后立即持久化，重启/崩溃后续跑无需重跑已完成插件 |
| 分阶段执行 | Phase1（F1）先跑，Phase2（F3/F4/A3）后台跑 | 会话快速创建（Phase1 完成即可），大 trace 深度分析不阻塞上传响应 |
| Trace 收集集成 | trace-server 合并进 JTA Server（`/ws/trace`） | 简化部署，减少端口和进程管理；端口统一为 33000 |
| WebSocket 多路径 | `wss.on('connection')` 内按 `pathname` 分发 | 单个 WS Server 支持 `/ws/projects/:id/progress` + `/ws/sessions/:id/progress` + `/ws/instrument/run/:runId` + `/ws/trace` |
| F1 EventIndex 让出事件循环 | 每 `YIELD_EVERY_BATCHES` 批调用 `setImmediate` | 防止长时间同步处理阻塞主线程，使 WebSocket/HTTP 请求能及时响应 |
| 插桩 browser target 输出 | 始终传 `--output <path>` | browser target 默认 in-place 覆盖源文件，显式指定路径确保后端能读到 `_jalangi_.js` |
| 工作空间（Projects）设计 | 一次插桩产物持久化到 `data/projects/`，复用 smap | 目标代码只需插桩一次，多次采集 trace 时直接复用，避免重复插桩 |
| 工作空间 fork | 复制源文件后重新插桩，不复制产物 | 允许以不同插桩选项重新生成 smap，同时沿用已有源码，无需重新上传 |
| Trace 文件清空策略 | 默认保留，需显式 `--clear-traces` 才清空 | 避免启动时误删正在分析的 trace 文件；原 `--no-clear-traces` 参数已废弃 |
| Trace 文件别名 | `_aliases.json` 元数据文件，不改磁盘文件名 | 文件名含时间戳已具唯一性，别名仅用于 UI 展示，不影响文件系统 |
| Trace 文件→工作空间映射 | `_project_map.json` + WS `?projectId=` 参数 | 浏览器端收集的 trace 自动与工作空间关联，导入时无需手动指定 smap |
| 预处理管线集成 | 插桩前可选运行 `preprocessCode()`，产物 `_preprocessed_.js` 持久化到工作空间目录 | 反混淆/语法降级后 iid 粒度更细，trace 分析效果更好；预处理代码同时作为会话源码定位的首选文件 |
| 预处理 transpile 目标映射 | 前端 `esXXXX` 年份标识，后端映射为 browserslist 查询（`chrome 49/58/80/103`） | 用户无需了解 browserslist 语法；年份标识直观表达降级程度 |
| 预处理默认关闭 | `preprocess.enabled = false`，UI 有明确开关 | 预处理会改变代码结构，对不需要的用户不应静默生效 |
| 空间分析安全约束 | 删除 path 必须在 `data/` 目录内，不可删除 DB 文件，删除前二次检查 upload 引用 | 防止路径穿越攻击；不可逆操作须保守处理 |
| 空间清理级联 | 删除 session_dir 时同步清理 DB + checkpoints；删除 project_dir 时 sessions.project_id 置 null 而非级联删除会话 | 会话数据有独立价值，仅解除工作空间关联，不连带删除 |
| 游标分页策略 | 普通事件浏览用 `cursor=last_seq`（O(log N) B-tree 扫）；值搜索用 offset（结果集有限，随机翻页需求高）；跨 Tab 跳转用 `seqFrom`（精确定位，无需估算） | 三种场景性能需求不同，混合策略兼顾速度与正确性；游标分页消除百万行 trace 深页卡顿 |
| TypedArray 编解码格式 | `"[TypeName(N):MB:hexpreview]"` 文本格式写入 DB | 保留完整类型信息和大小，十六进制预览可视，不破坏 SQLite 文本索引 |
| 反向调用图实现 | CTE + `call_seq ≤ X ≤ return_seq AND depth = child.depth-1` 父帧关联；顶层调用 `fn_name = '(top-level)'` | 利用已有 `idx_call_edges_stack` 索引，避免 N² 全表关联；单次 SQL 返回全部调用者 |
| 动态 CFG 节点类型 | 三类节点：function（函数）/ loop（循环块）/ hotspot（热点 IID），Cytoscape 统一渲染 | 异构图结构可在同一视图展示调用关系、循环和热点，逆向分析时一眼看清执行重心 |
| 单函数 CFG 基本块划分 | 按行号聚类（相邻行号差 ≤ LINE_GAP=3），采样多次调用取 union iid 集合 | 无需静态分析，纯动态数据；采样 union 确保覆盖不同执行路径；行号差阈值过滤无关 iid |
| 多会话对比查询优化 | 所有维度用 `IN(${ph})` 一次查询 + `GROUP BY session_id` 聚合，最多 6 次 SQL（原来 6N 次） | N=8 会话时性能提升 8×；预拼 BUILTIN_NOT_IN_SQL 常量供 LRU 缓存 |
| 对比页 `/diff` 分歧计算 | delta/pct 纯 JS 层计算（以 sessions[0] 为基准），不下推 SQL | 计算量 O(N × |types|)，远小于 DB 往返时延；保持 SQL 结构简单，LRU 友好 |

---

## 11. MCP Server 设计

### 11.1 目标

将 JTA 的全部分析能力通过 **MCP（Model Context Protocol）** 暴露给 LLM，使大语言模型可以自主驱动插桩、运行、分析的完整逆向流程，无需人工操作 UI。

### 11.2 整体架构

```
LLM（Claude / GPT / 其他 MCP 兼容客户端）
           ↓ MCP tool calls
    ┌──────┴──────┐
    │             │
jta-mcp-stdio  jta-mcp-sse       ← 两种传输，同一套 Tool 实现
    │             │
    └──────┬──────┘
           ↓ HTTP
   JTA REST API（Express）        ← 所有逻辑在这里
           ↓
   SQLite + Plugin Engine
```

MCP Server 是**纯适配层**：负责 Tool 定义、参数校验、HTTP 转发、结果格式化。业务逻辑全部在 JTA 侧实现，不重复。

### 11.3 传输协议

#### stdio 传输（`jta-mcp-stdio.mjs`）
- 启动方式：`node mcp/jta-mcp-stdio.mjs --jta-url http://localhost:3000`
- 适用场景：Claude Desktop、OpenClaw（本地直连）
- 配置示例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "jta": {
      "command": "node",
      "args": ["/path/to/Jani/mcp/jta-mcp-stdio.mjs", "--jta-url", "http://localhost:3000"]
    }
  }
}
```

#### HTTP SSE 传输（`jta-mcp-sse.mjs`）
- 启动方式：`node mcp/jta-mcp-sse.mjs --port 4000 --jta-url http://localhost:3000`
- 适用场景：远程 LLM、OpenClaw 远程调用、其他支持 MCP HTTP SSE 的客户端
- 端点：`GET /sse`（事件流）、`POST /messages`（Tool 调用）
- 无鉴权（本地工具，按需后续添加）

#### Streamable HTTP 传输（`jta-mcp-streamable.mjs`）
- 启动方式：`node mcp/jta-mcp-streamable.mjs --port 4001 --jta-url http://localhost:3000`
- 适用场景：遵循 MCP 2025-03-26 规范的客户端（新版 Claude Desktop、Cursor 等）
- 端点：`POST /mcp`（单一端点，支持流式响应）
- 说明：Streamable HTTP 是 MCP 官方最新标准，HTTP SSE 作为旧版兼容保留

### 11.4 MCP Tools 完整列表

#### 插桩类

```
instrument_code
  描述：对 JS 源码执行插桩，返回插桩后代码和 smap
  参数：
    code        string   JS 源码
    filename    string   文件名（用于 source map）
    inlineIid   boolean  是否内联 iid（默认 false）
    inlineSource boolean 是否内联源码（默认 false）
    sandboxVar  string   沙盒变量名（默认 "J$"）
  返回：{ instrumentedCode, smapJson, mapJson, iidCount }

run_instrumented
  描述：在服务端 Node.js 沙箱中执行插桩后的代码，自动开启 ExecutionTrace，完成后创建分析会话（立即返回不等待）
  参数：
    code        string   原始 JS 源码（服务端自动插桩）
    filename    string   文件名
    traceFile   string   输出 .bin 路径（默认自动生成）
    env         string   执行环境："node"（默认）或 "jsdom"（模拟浏览器）
  返回：{ runId }

get_run_status
  描述：查询服务端运行任务的状态和结果
  参数：
    runId       string   run_instrumented 返回的 runId
  返回：{ status: 'running'|'done'|'failed', stdout, stderr, exitCode, sessionId, durationMs }
```

#### 查询类

```
query_events
  描述：查询分析会话中的 trace 事件
  参数：
    sessionId   string   会话 ID
    line        integer  过滤行号（可选）
    type        string   事件类型（END_EXPR / CALL_PRE / CALL，可选）
    varName     string   变量名过滤（writes 或 reads 中包含该变量，可选）
    seqFrom     integer  起始 seq（可选）
    seqTo       integer  结束 seq（可选）
    limit       integer  最大返回数（默认 50）
  返回：events[]（seq, type, line:col, srcText, writes, reads）

get_hot_paths
  描述：获取执行频次最高的代码位置（热路径）
  参数：
    sessionId   string
    topN        integer  返回前 N 条（默认 20）
  返回：[{ iid, line, col, srcText, count }]

get_call_graph
  描述：获取函数调用图
  参数：
    sessionId   string
    rootFn      string   以指定函数为根节点（可选，不填返回完整图）
    depth       integer  展开层数（默认 3）
  返回：{ nodes: [{ fn, callCount }], edges: [{ caller, callee, count }] }

get_source
  描述：获取指定 iid 对应的源码片段及上下文
  参数：
    sessionId   string
    iid         integer  目标 iid
    context     integer  上下文行数（默认 3，即前后各 3 行）
  返回：{ iid, line, col, srcText, contextLines: [{ lineNo, text, isTarget }] }

manage_bookmarks
  描述：列出、创建或删除书签标注
  参数：
    action      string   "list" | "create" | "delete"
    sessionId   string
    seq         integer  （create 时必填）
    label       string   （create 时可选）
    note        string   （create 时可选）
    bookmarkId  integer  （delete 时必填）
  返回：书签列表 或 { ok: true }
```

#### 分析类

```
trace_taint
  描述：对指定变量进行污点追踪，返回数据流 DAG
  参数：
    sessionId   string
    varName     string   目标变量名
    direction   string   "forward"（正向）或 "backward"（反向）
    startSeq    integer  起始事件 seq（可选，不填从首次出现开始）
  返回：{ nodes: [{ seq, line, srcText, varName, value }], edges: [{ from, to }], hopCount }

detect_crypto
  描述：检测 trace 中的加密算法特征
  参数：
    sessionId   string
  返回：[{ algorithm, confidence, evidence: [{ iid, line, srcText, reason }] }]

analyze_signature
  描述：反向还原签名/token 的生成路径
  参数：
    sessionId   string
    targetVar   string   签名字段名（如 "sign"、"token"，可选，不填自动推断）
  返回：{ signatureVar, inputVars: [], computationPath: [], finalValue }

get_loop_detail
  描述：获取指定循环每轮迭代的变量快照
  参数：
    sessionId   string
    iid         integer  循环体 iid（从 get_hot_paths 结果中获取）
  返回：{ loopVar, iterations: [{ round, vars: { name: value } }], totalRounds }
```

#### 推理类

```
get_summary
  描述：获取 AlgorithmSummarizer 的综合分析摘要报告
  参数：
    sessionId   string
  返回：{ markdown, findings: [{ type, confidence, description, evidence }] }

run_plugin
  描述：手动触发指定分析插件（重跑或首次运行）
  参数：
    sessionId   string
    pluginId    string   插件 ID（如 "A1-TaintTracker"、"I1-CryptoDetector"）
  返回：{ status, durationMs, outputSummary }

list_sessions
  描述：列出所有分析会话
  参数：无
  返回：[{ sessionId, name, createdAt, eventCount, plugins: { id, status } }]
```

### 11.5 LLM 自动化逆向分析示例流程

```
用户：帮我分析 target.js 的签名算法

LLM 调用：
  1. run_instrumented(code=<target.js内容>, filename="target.js")
     → sessionId = "abc123", exitCode = 0

  2. get_hot_paths(sessionId="abc123", topN=10)
     → 发现第 87 行执行了 12,400 次（循环核心）

  3. get_loop_detail(sessionId="abc123", iid=<第87行iid>)
     → 看到 key 数组每轮 XOR 变换

  4. detect_crypto(sessionId="abc123")
     → [{ algorithm: "RC4", confidence: 0.91, evidence: [...] }]

  5. analyze_signature(sessionId="abc123")
     → signatureVar="sign", inputVars=["timestamp","nonce","body"]

  6. get_summary(sessionId="abc123")
     → 完整 Markdown 报告

LLM 返回用户：
  "该 JS 使用 RC4 流密码生成签名，key 来自第 23 行的硬编码数组，
   输入为 timestamp + nonce + body 的拼接，具体步骤如下：..."
```

### 11.6 依赖

```json
{
  "@modelcontextprotocol/sdk": "^1.x"
}
```

MCP SDK 同时支持 stdio 和 SSE 传输，两个入口文件共享同一套 Tool 定义，只在传输层不同。
