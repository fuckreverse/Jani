# Jani Trace Analyzer — 设计文档

**版本：** v1.0（已实现）  
**日期：** 2026-04-06  
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
│  │              SQLite（sql.js，内存 db + flush）          │  │
│  │  sessions | events | writes | reads | fields | smap   │  │
│  │  call_edges | taint_paths | var_lifetime | scopes      │  │
│  │  value_patterns | bookmarks | fn_signatures | ...      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 技术栈

| 层次 | 技术选型 | 理由 |
|---|---|---|
| 后端 | Node.js + Express | 与 Jani 同生态，无额外运行时 |
| 数据库 | SQLite（**sql.js**，WASM 纯 JS 实现） | 沙箱环境无 gcc，无法编译 better-sqlite3 原生模块；sql.js 零编译依赖，内存 db + 批次末尾 flush 写盘，性能可接受 |
| 前端 | Vue 3 + Vite | 轻量，组件化，易于实现代码编辑器集成 |
| 代码高亮 | CodeMirror 6 | 支持行高亮、标注、交互点击 |
| 图可视化 | Cytoscape.js | 适合 DAG/调用图渲染，纯前端 |
| 插件通信 | Node.js EventEmitter | 插件间解耦，支持异步 |

---

## 3. 数据模型

### 3.1 核心表结构

```sql
-- 分析会话（一次 trace 对应一个 session）
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,   -- UUID
    name        TEXT,               -- 用户命名，如 "target-v2.3"
    created_at  INTEGER,            -- Unix timestamp
    source_file TEXT,               -- 原始 JS 文件名
    bin_path    TEXT,               -- .bin 文件路径
    smap_path   TEXT,               -- .smap.json 路径
    event_count INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending',  -- pending / processing / ready / failed
    plugin_status TEXT DEFAULT '{}'      -- JSON：{ pluginId: 'pending'|'running'|'done'|'failed' }
);

-- 事件流（主表）
CREATE TABLE events (
    id          INTEGER PRIMARY KEY,  -- seq
    session_id  TEXT NOT NULL,
    type        TEXT NOT NULL,        -- END_EXPR / CALL_PRE / CALL / SCRIPT_ENTER 等
    iid         INTEGER,
    line        INTEGER,
    col         INTEGER,              -- 字符偏移量（从行首算起，与 Jani smap 的 sc 字段含义一致）
    src_text    TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 变量写入
CREATE TABLE writes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value       TEXT,     -- JSON 序列化
    omitted     INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- 变量读取
CREATE TABLE reads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value       TEXT,
    omitted     INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- 属性读写（fields）
CREATE TABLE fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    base        TEXT,
    offset      TEXT,
    is_write    INTEGER,
    value       TEXT,
    omitted     INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
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
    call_seq        INTEGER,   -- CALL_PRE 事件的 seq
    return_seq      INTEGER,   -- CALL 事件的 seq
    caller_line     INTEGER,
    fn_name         TEXT,
    fn_iid      INTEGER,   -- 被调用函数定义处的 iid（混淆代码中函数名相同时用于区分）
    args_json       TEXT,
    return_value    TEXT,
    depth           INTEGER    -- 调用深度
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

由于沙箱环境缺少 gcc，无法编译 better-sqlite3 原生模块，最终采用 **sql.js**（SQLite WASM 纯 JS 移植）。

#### 核心设计

```
内存运行模式
  ├── 数据库始终在 WASM 内存中（_db）
  ├── transaction() 内只写内存，不 export（高性能）
  ├── 每次 transaction() 后标记 _dirty = true
  └── flush() / close() 时：_db.export() → writeFileSync 写盘

API 兼容层
  ├── all(sql, ...args)   → 查询多行（返回数组）
  ├── get(sql, ...args)   → 查询单行
  ├── run(sql, ...args)   → 执行写入（不返回数据）
  ├── transaction(fn)     → 批量写入事务（内存操作，末尾 flush）
  └── getDb()             → 获取原始 sql.js db 实例（供插件直接使用）

参数规范化（normalizeParams）
  ├── db.all(sql, p1, p2)         → 展开参数形式
  └── db.all(sql, [p1, p2])       → 数组形式（两种调用方式均支持）
```

#### 嵌套事务处理（`_inTransaction` 标志）

sql.js 不支持 SAVEPOINT，直接嵌套 BEGIN/COMMIT 会报错。Database.mjs 通过 `_inTransaction` 标志处理：

```
外层 transaction(fn)
  ├── _inTransaction = false → BEGIN; fn(); COMMIT; flush(); _inTransaction = false
  └── 内层 transaction(fn)（嵌套调用）
       └── _inTransaction = true → 直接执行 fn()，跳过 BEGIN/COMMIT/flush
```

同理，`run()` 和 `persist()` 在事务中也跳过 flush，避免 `cannot rollback - no transaction is active` 错误。

#### 文件位置

```
analyzer/db/Database.mjs    # sql.js 封装
analyzer/db/schema.sql      # 建表 DDL（同步执行）
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
PluginEngine.schedule(sessionId)
   ↓
拓扑排序（按 deps 构建 DAG）
   ↓
并发执行无依赖插件（F1、F2 同时跑）
   ↓
依赖满足后立即触发下一批
   ↓
全部完成 → 通知 UI
```

调度器维护插件注册表，支持：
- **自动发现**：扫描 `plugins/` 目录自动加载
- **手动触发**：用户在 UI 中选择插件单独重跑
- **增量执行**：同一 session 重新上传新 trace 时，只重跑受影响的插件

---

## 5. 分析插件清单

### 第一层：Foundation（基础数据插件）

#### F1 · EventIndex
- **依赖：** 无
- **输入：** `.bin` 文件
- **功能：** 解析二进制 trace，写入 `events / writes / reads / fields` 表
- **输出：** 数据库填充完成

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

#### A6 · FunctionSignatureInfer
- **依赖：** F1, F3
- **功能：**
  - 聚合函数所有调用记录：`(fn, args[], return)`
  - 推断：纯函数（相同输入 → 相同输出）？
  - 统计参数类型分布
- **输出：** `fn_signatures` 表

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
- **依赖：** A1, A6, A4
- **功能：**
  - 定位 HTTP 请求构造点（headers/body 的 putField）
  - 反向追踪 `sign/token/timestamp/nonce` 字段的来源
  - 还原完整签名计算路径（输入 → 中间步骤 → 最终值）
- **输出：** `signature_paths` 表 + 可读报告

#### I3 · ObfuscationDetector
- **依赖：** A2, A3, F2
- **检测：**
  - 变量名熵值（短/随机变量名 = 高熵）
  - 字符串解密函数识别（一函数多次调用返回不同字符串）
  - 控制流平坦化（大 switch + 单循环变量）
- **输出：** `obfuscation_hints` 表

#### I4 · AlgorithmSummarizer
- **依赖：** I1, A1, A5, A6
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
| 会话列表 | `/` | 所有分析会话，含状态概览 |
| 会话详情 | `/sessions/:id` | 代码视图 + 事件列表 + 分析面板 |
| **插桩工作台** | `/instrument` | 独立插桩页面，见 6.4 节 |
| 设置 | `/settings` | 数据目录、运行环境等 |

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
│  [插桩]  [下载插桩后代码]  [在服务端运行 ▶]  [清空]       │
└─────────────────────────────────────────────────────────┘
```

#### 三个核心操作

**① 插桩（立即预览）**
- 点击"插桩"按钮，后端调用 `instrumentCode()` API
- 右侧实时展示插桩后的完整代码（含 `J$.Se()`、`J$.X()` 等钩子调用）
- 同时展示 smap 信息（iid 数量、覆盖行数）

**② 下载**
- 下载插桩后 `.js` 文件
- 下载 `.map.json`（source map）
- 下载 `.smap.json`（含 srcText 的 iid 映射）

**③ 在服务端运行 ▶**
- 仅在勾选 `--execution-trace` 时可用（其他情况置灰并提示）
- 点击后：后端在 Node.js 沙箱中执行插桩后的代码
- 实时 WebSocket 推送：stdout/stderr 输出流
- 运行完成后：自动将生成的 `.bin` + `.smap.json` 导入新 session
- 弹出提示："运行完成，已创建分析会话 [查看 →]"，一键跳转到会话详情页

#### 后端 API

```
POST /api/instrument
    body: { code, filename, options: { inlineIid, inlineSource, executionTrace, noWrite, sandboxVar, sourceType, analyses[] } }
    返回: { instrumentedCode, smapJson, mapJson }

POST /api/instrument/run
    body: { code, filename, options }
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

### 6.5 插件进度展示

上传后，UI 实时显示插件执行进度：

```
✅ F1 EventIndex      (1.2s,  52,341 events)
✅ F2 SmapLoader      (0.1s,  234 iids)
✅ F3 CallGraphBuilder(0.8s,  1,203 calls)
⏳ A1 TaintTracker    (running...)
⏸  I1 CryptoDetector  (waiting for A3, A5)
```

---

## 7. API 设计（后端）

### 7.1 REST API

```
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
    上传 .bin + .smap.json（可选）+ 原始 .js（可选），创建新会话，触发插件调度
    body: multipart/form-data { bin, smap?, source? }
    说明：
      - .smap.json 为可选。缺失时 F2 SmapLoader 跳过，iid → 行列映射不可用，
        srcText 字段为空，但事件流（事件类型、writes/reads/fields）仍完整可用。
      - 原始 .js 为可选。有则显示在代码视图中，无则代码视图降级为纯事件列表。
    返回：{ sessionId, status: 'processing', smapAvailable: bool }

GET  /api/sessions
    列出所有会话

GET  /api/sessions/:id
    会话详情 + 插件执行状态

GET  /api/sessions/:id/events?line=42&type=END_EXPR&limit=100&offset=0
    查询事件（支持多维过滤）
    注意：大 trace 推荐用 seqFrom/seqTo 游标分页，避免 offset 深翻页性能问题
    游标用法：第一页 ?limit=100，下一页 ?seqFrom=<上页末尾seq+1>&limit=100

GET  /api/sessions/:id/taint?var=key&direction=forward
    触发/获取污点追踪结果

GET  /api/sessions/:id/hotpath
    热路径数据

GET  /api/sessions/:id/callgraph
    调用图数据

GET  /api/sessions/:id/crypto
    加密检测结果

GET  /api/sessions/:id/summary
    AlgorithmSummarizer 输出

GET  /api/sessions/:id/bookmarks
    列出书签

POST /api/sessions/:id/bookmarks
    创建书签 { seq, label, note }

DELETE /api/sessions/:id/bookmarks/:bid
    删除书签
```

### 7.2 WebSocket

```
WS /ws/sessions/:id/progress
    订阅插件执行进度（实时推送）
    消息格式：{ plugin, status, progress, message }

WS /ws/instrument/run/:ticket
    订阅服务端运行输出流
    消息格式：
      { type: 'stdout', data: '...' }
      { type: 'stderr', data: '...' }
      { type: 'done',   sessionId: '...', exitCode: 0 }
      { type: 'error',  message: '...' }
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
├── analyzer/                  # 🆕 JTA 主目录
│   ├── server.mjs             # Express 服务入口
│   ├── db/
│   │   ├── schema.sql         # 表结构定义
│   │   └── Database.mjs       # SQLite 封装
│   ├── engine/
│   │   ├── PluginEngine.mjs   # 调度器
│   │   └── AnalysisPlugin.mjs # 基类接口
│   ├── plugins/
│   │   ├── foundation/
│   │   │   ├── F1-EventIndex.mjs
│   │   │   ├── F2-SmapLoader.mjs
│   │   │   ├── F3-CallGraphBuilder.mjs
│   │   │   └── F4-VariableLifetime.mjs
│   │   ├── analysis/
│   │   │   ├── A1-TaintTracker.mjs
│   │   │   ├── A2-DataFlowGraph.mjs
│   │   │   ├── A3-HotPathAnalyzer.mjs
│   │   │   ├── A4-StringTracker.mjs
│   │   │   ├── A5-LoopDetector.mjs
│   │   │   ├── A6-FunctionSignatureInfer.mjs
│   │   │   └── A7-ObjectMutationTracker.mjs
│   │   └── inference/
│   │       ├── I1-CryptoDetector.mjs
│   │       ├── I2-SignatureAnalyzer.mjs
│   │       ├── I3-ObfuscationDetector.mjs
│   │       └── I4-AlgorithmSummarizer.mjs
│   └── ui/                    # Vue 3 前端
│       ├── index.html
│       ├── src/
│       │   ├── App.vue
│       │   ├── components/
│       │   │   ├── CodeViewer.vue         # CodeMirror 代码视图（只读，支持行高亮）
│       │   │   ├── CodeEditor.vue         # CodeMirror 代码编辑器（插桩工作台用）
│       │   │   ├── EventList.vue          # 事件列表
│       │   │   ├── TaintGraph.vue         # Cytoscape 污点图
│       │   │   ├── CallGraph.vue          # 调用图
│       │   │   ├── HotPath.vue            # 热路径热力图
│       │   │   ├── PluginStatus.vue       # 插件进度
│       │   │   ├── InstrumentOptions.vue  # 插桩选项面板
│       │   │   ├── RunConsole.vue         # 服务端运行输出（WS 流式）
│       │   │   ├── ValueHistory.vue       # 变量值历史时间线
│       │   │   └── BookmarkList.vue       # 书签面板
│       │   └── views/
│       │       ├── SessionList.vue
│       │       ├── SessionDetail.vue
│       │       └── InstrumentStudio.vue   # 插桩工作台（/instrument）
│       └── vite.config.js
├── mcp/                       # 🆕 MCP Server 目录
│   ├── jta-mcp-stdio.mjs      # stdio 传输（Claude Desktop / OpenClaw 本地直连）
│   ├── jta-mcp-sse.mjs        # HTTP SSE 传输（远程访问，旧版兼容）
│   ├── jta-mcp-streamable.mjs # Streamable HTTP 传输（MCP 2025-03-26 新标准）
│   ├── tools/                 # MCP Tool 定义
│   │   ├── instrument.mjs     # instrument_code / run_instrumented
│   │   ├── query.mjs          # query_events / get_hot_paths / get_call_graph
│   │   ├── analysis.mjs       # trace_taint / detect_crypto / analyze_signature / get_loop_detail
│   │   └── inference.mjs      # get_summary / run_plugin
│   └── client.mjs             # 向 JTA REST API 转发请求的 HTTP 客户端
└── docs/
    └── TraceAnalyzer-Design.md  # 本文档
```

---

## 9. 开发路线图

### Phase 1：基础骨架（MVP）✅ 已完成
- [x] `analyzer/server.mjs`：Express + 文件上传
- [x] `db/schema.sql` + `Database.mjs`（sql.js 实现，见 3.3 节）
- [x] `PluginEngine.mjs`：拓扑排序 + 并发执行
- [x] F1 EventIndex + F2 SmapLoader
- [x] 基础 REST API（上传 / 查询事件）
- [x] UI：会话列表 + 事件列表 + 插件状态面板（Vue 3 + Vite，`ui/dist/` 已构建）
- [x] **插桩工作台（完整）**：源码编辑 + 选项面板 + 插桩预览 + 服务端运行闭环（`/api/instrument` + `/api/instrument/run`）
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
- [x] A6 FunctionSignatureInfer（`fn_signatures` 表）
- [x] A7 ObjectMutationTracker（`object_timelines` 表）
- [x] I3 ObfuscationDetector（`obfuscation_hints` 表）
- [x] I4 AlgorithmSummarizer（`analysis_summary`，Markdown 报告）
- [x] 后端 API：`/run-phase4`，A2/A4/A6/A7/I3/I4 全部 done
- [x] 完整流程端到端验证通过（2026-04-05，7 行测试文件，15 条事件，全部插件 done）

> **当前状态：** JTA 服务运行在 `http://localhost:3000`，全部 4 个阶段 17 个分析插件已完工。

### Phase 5：MCP Server
- [ ] `mcp/client.mjs`：JTA REST API HTTP 封装
- [ ] `mcp/tools/` 所有 Tool 定义（参数 schema + 结果格式化）
- [ ] `mcp/jta-mcp-stdio.mjs`：stdio 传输，供本地 Claude Desktop / OpenClaw 使用
- [ ] `mcp/jta-mcp-sse.mjs`：HTTP SSE 传输，供远程 LLM 访问
- [ ] 配置示例：Claude Desktop `claude_desktop_config.json` 片段

---

## 10. 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据库 | SQLite（sql.js） | 零部署、本地、点查快；sql.js 因沙箱无 gcc 替换 better-sqlite3；污点链 BFS 在 Node.js 层处理 |
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
| F4 VariableLifetime | 持久化到 SQLite | 避免跨会话重跑插件时数据丢失 |
| JS 执行环境 | Node.js + JSDOM 可选 | 目标 JS 可能依赖浏览器环境，纯 Node.js 无法运行 |
| .smap.json 必填性 | 可选（降级处理） | 缺失时跳过 F2，iid 映射不可用，但事件流仍完整 |
| TaintTracker 追踪范围 | writes + reads + fields + call return | 覆盖变量/属性/函数返回值，obj.key 和 arr[i] 不遗漏 |
| InstrumentRunner 超时 | 30s kill + 3 并发 + 1MB 输出截断 | 防止恶意或无限循环代码耗尽资源 |

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
