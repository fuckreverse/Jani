# JTA 数据库优化设计

**版本：** v1.2
**日期：** 2026-04-09
**目标：** 最小存储空间 + 极致读写查性能

---

## 1. 现状问题总览

基于对全部 17 个插件的查询模式完整交叉验证，当前设计存在以下问题：

### 1.1 已知 Bug（数据正确性问题）

| 插件 | 位置 | 问题 | 影响 |
|------|------|------|------|
| A2_DataFlowGraph | [L115](../analyzer/plugins/A2_DataFlowGraph.mjs#L115) | `fields` 查询硬编码 `LIMIT 5000` | 超出部分的 field_write/field_read 边完全丢失，数据流图不完整 |
| A4_StringTracker | [L48](../analyzer/plugins/A4_StringTracker.mjs#L48) | `LIMIT 10000` 截断字符串 writes | 超出部分字符串事件完全丢失，编码检测不完整 |
| I2_SignatureAnalyzer | [L70](../analyzer/plugins/I2_SignatureAnalyzer.mjs#L70) | `LIMIT 50000` 截断 writes | 超出部分 writes 不参与签名追踪 |
| I2_SignatureAnalyzer | [L79](../analyzer/plugins/I2_SignatureAnalyzer.mjs#L79) | `LIMIT 20000` 截断 field writes | 超出部分字段写入不参与签名追踪 |

### 1.2 内存风险

| 插件 | 位置 | 问题 | 影响 |
|------|------|------|------|
| A5_LoopDetector | [L81-116](../analyzer/plugins/A5_LoopDetector.mjs#L81) | 全量加载 events(id,iid) + 全量 writes | 100M 事件 trace 可能触发 OOM（堆内存 ~9GB） |

### 1.3 Schema 问题

| 类别 | 问题 | 影响 |
|------|------|------|
| Schema | `events.type` 存 TEXT（~10B/行） | 100M 行浪费 ~800MB |
| Schema | `events` 有 `line/col/src_text`，与 `smap` 重复 | 浪费 2-3GB，且删除时影响面比预期更广（见 2.1 节） |
| Schema | `writes/reads/fields` 保留无用 `id` 列 | 浪费 ~2.4GB |
| Schema | `hot_iids` 与 `iid_counts` 完全重复 | 逻辑混乱，双倍写入 |
| Schema | A8/I1/I2 用 `DROP TABLE` 重建，不支持多 session 并存 | 重建会删掉所有 session 的分析结果 |

### 1.4 索引问题

| 类别 | 问题 | 影响 |
|------|------|------|
| 索引 | `idx_events_session_seq` 与主键语义重叠 | 写入多余开销 |
| 索引 | `idx_smap_session` 被主键前缀覆盖 | 写入多余开销 |
| 索引 | `idx_writes_name` / `idx_reads_name` 缺 `event_id` | A1/I2 预加载后需额外排序 |
| 索引 | `idx_events_session_type` 缺 `id`（但注意：`IN` 条件下无法消除 filesort，见 3.1 节） | 扫描行数多 |

### 1.5 查询问题

| 类别 | 问题 | 影响 |
|------|------|------|
| 查询 | 事件列表用 `LIMIT/OFFSET` 分页 | 深页线性扫描 |
| 查询 | IN 查询未带 `session_id`，索引命中退化 | 可能全表扫描 |
| 查询 | F2 的 UPDATE 用相关子查询（N×3 次） | N×3 子查询 |
| 查询 | I3 的 GROUP BY JOIN 了多余的 `events` 表 | 多余全表 JOIN |
| 查询 | 函数列表分页 COUNT 用子查询双扫描 | 每次翻页多扫一遍 `call_edges` |
| 查询 | Session delete 的 25 个 DELETE 不在事务内 | 崩溃后留孤儿数据，且 25 次独立锁 |

### 1.6 数据库配置问题

| 类别 | 问题 | 影响 |
|------|------|------|
| Pragma | 未设置 `cache_size` | 默认 2MB 页缓存，大 trace 分析频繁 I/O |
| Pragma | 未设置 `mmap_size` | 无内存映射 I/O，顺序扫描慢 |
| Pragma | 未设置 `temp_store = MEMORY` | GROUP BY/ORDER BY 的临时表写磁盘 |
| Pragma | 未设置 `wal_autocheckpoint` | 默认 1000 页（~4MB）触发检查点，F1 写入时频繁阻塞 |
| Pragma | 未设置 `busy_timeout` | 并发访问时立即报错而非重试 |
| 封装 | `db.get/all/run` 每次调用都重新 `prepare(sql)` | 路由层高频查询有额外编译开销 |

---

## 2. Schema 优化方案

### 2.1 `events` 表

**核心改动：**

1. `type TEXT` → `type INTEGER`（枚举编码）
2. 删除 `line / col / src_text`（与 `smap` 重复，F2 回填逻辑也一并删除）

```sql
-- 事件类型枚举表（一次性预填充，不随 session 变化）
CREATE TABLE IF NOT EXISTS event_types (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);
-- 预填充：
-- 0=WRITE, 1=READ, 2=GETFIELD, 3=PUTFIELD,
-- 4=CALL_PRE, 5=CALL, 6=LITERAL, 7=END_EXPR, 8=CONDITIONAL, ...

-- events 表
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    type       INTEGER NOT NULL,   -- 引用 event_types.id，1-2 字节 vs 10 字节
    iid        INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

**收益：**
- `type` 列：100M 行节省 ~800MB
- 删除 `line/col/src_text`：节省 2-3GB
- 整数比较比字符串比较快 2-3x，影响所有按 type 过滤的查询（F3、I1 等）

**注意事项：**

删除 `events.line / col / src_text` 的影响面比直觉上更广，以下插件均需改写：

| 插件 | 当前用法 | 删除后改为 |
|------|---------|-----------|
| F2_SmapLoader | UPDATE events SET line/col/src_text | 整个 UPDATE 可删除（最优解） |
| F3_CallGraphBuilder | `SELECT id, type, iid, line FROM events` → caller_line | JOIN smap ON iid |
| A2_DataFlowGraph | `SELECT id, iid, line FROM events` → dataflow_edges.line | JOIN smap ON iid |
| A3_HotPathAnalyzer | `MIN(line), MIN(src_text)` → iid_counts | JOIN smap ON iid |
| A7_ObjectMutationTracker | `JOIN events e` 取 e.line → object_timelines.line | JOIN smap ON iid |
| I1_CryptoDetector | `events.src_text LIKE '%^%'` | 改为扫 smap（见第 4 节） |
| I4_AlgorithmSummarizer | 读 iid_counts.src_text 用于报告 | 间接影响（A3 改写后自动修复） |

另外：
- F1 写入时改为写 type 整数
- 所有查询中的 `type IN ('CALL_PRE','CALL')` 改为 `type IN (4,5)`
- 可在应用层维护 `EVENT_TYPE` 常量对象做映射

### 2.2 `writes` / `reads` / `fields` 表

**核心改动：删除无用 `id` 列**

没有任何插件或 API 通过 `writes.id` / `reads.id` / `fields.id` 查询。

```sql
CREATE TABLE IF NOT EXISTS writes (
    event_id   INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    name       TEXT,
    value      TEXT,
    omitted    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reads (
    event_id   INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    name       TEXT,
    value      TEXT,
    omitted    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fields (
    event_id   INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    base       TEXT,
    offset     TEXT,
    is_write   INTEGER,
    value      TEXT,
    omitted    INTEGER DEFAULT 0
);
```

**收益：** 每行节省 8 字节，100M 行 × 3 表 = 约 2.4GB

### 2.3 合并 `hot_iids` 与 `iid_counts`

这两张表结构几乎完全相同，是历史遗留的重复。**保留 `iid_counts`，删除 `hot_iids`**，所有引用 `hot_iids` 的代码改为 `iid_counts`。

```sql
-- 保留（已存在）：
CREATE TABLE IF NOT EXISTS iid_counts (
    session_id  TEXT NOT NULL,
    iid         INTEGER NOT NULL,
    count       INTEGER DEFAULT 0,
    line        INTEGER,
    src_text    TEXT,
    PRIMARY KEY (session_id, iid)
);

-- 删除：
-- DROP TABLE IF EXISTS hot_iids;
```

**涉及改动：**
- `A3_HotPathAnalyzer.mjs`：写入目标改为 `iid_counts`
- `I3_ObfuscationDetector.mjs`：读取来源改为 `iid_counts`
- `I4_AlgorithmSummarizer.mjs`：读取来源改为 `iid_counts`
- 删除 session 时的 DELETE 列表去掉 `hot_iids`

### 2.4 `value_patterns` 表增加部分索引

I1 最常用的查询是：

```sql
SELECT * FROM value_patterns WHERE session_id=? AND matched_constant IS NOT NULL
```

当前只有 `idx_value_patterns_session ON value_patterns(session_id)`，需要回表过滤 `matched_constant IS NOT NULL`。

```sql
-- SQLite 支持部分索引（WHERE 子句）
CREATE INDEX IF NOT EXISTS idx_vp_matched
    ON value_patterns(session_id, matched_constant)
    WHERE matched_constant IS NOT NULL;
```

---

## 3. 索引优化方案

### 3.1 新增索引

```sql
-- A1/I2：二分查找需要 (session_id, name, event_id) 三列覆盖
-- 当前 idx_writes_name 只有 (session_id, name)，找到 name 后还需回表排序 event_id
-- 注意：新索引是旧索引的超集，同时删除旧的 idx_writes_name / idx_reads_name
CREATE INDEX IF NOT EXISTS idx_writes_name_eid ON writes(session_id, name, event_id);
CREATE INDEX IF NOT EXISTS idx_reads_name_eid  ON reads(session_id, name, event_id);
DROP INDEX IF EXISTS idx_writes_name;
DROP INDEX IF EXISTS idx_reads_name;
-- 效果：A1/I2 预加载时的 ORDER BY event_id 由索引直接提供，消除 filesort

-- F3：减少扫描行数（只扫 CALL_PRE/CALL 行而非全表）
-- 注意：WHERE type IN (4,5) ORDER BY id ASC 中，IN 多值条件无法通过复合索引消除 filesort
-- 此索引的收益是减少扫描范围，而非排序消除（filesort 在全量扫描场景开销可接受）
CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(session_id, type, id);

-- I4/I3/A5：iid_counts TOP-N 查询消除排序
-- "WHERE session_id=? ORDER BY count DESC LIMIT 10" 当前需要全表排序
CREATE INDEX IF NOT EXISTS idx_iid_counts_count ON iid_counts(session_id, count DESC);
-- 效果：TOP-N 直接走索引，无需全表排序

-- A5：loops 表 ORDER BY iteration_count DESC 消除排序
CREATE INDEX IF NOT EXISTS idx_loops_iter_count ON loops(session_id, iteration_count DESC);
-- 效果：A5 加载循环时直接有序，消除 filesort
```

### 3.2 删除冗余索引

```sql
-- idx_events_session_seq ON events(session_id, id)
-- events 的 id 是主键，SQLite 主键自带 B-tree
-- session_id+id 范围扫描可通过其他索引定位 session 后走主键，此索引几乎不被选中
-- 删除：减少 F1 写入时的索引维护开销
DROP INDEX IF EXISTS idx_events_session_seq;

-- idx_smap_session ON smap(session_id)
-- smap 的 PRIMARY KEY 是 (session_id, iid)，前缀已覆盖 session_id 的范围扫描
-- 删除：减少 F2 写入时的索引维护开销
DROP INDEX IF EXISTS idx_smap_session;
```

### 3.3 索引全景

完整版索引全景见第 7 节（含 value_index 新增索引和 call_edges 返回值索引）。

---

## 4. 查询模式优化

### 4.1 事件列表分页：OFFSET → 游标

**位置：** `analyzer/server/routes/sessions.mjs` — `GET /api/sessions/:id/events`

**当前（有问题）：**
```sql
SELECT ... FROM events WHERE session_id=? ... ORDER BY id ASC LIMIT ? OFFSET ?
-- OFFSET 在大表上是线性扫描，翻到第 500 页需跳过 50 万行
```

**优化后：**
```sql
-- 前端传入上一页最后一条的 id（cursor），初始为 0
SELECT ... FROM events WHERE session_id=? AND id > ? ... ORDER BY id ASC LIMIT 1000
-- 每次查询 O(1) 定位 + O(page_size) 读取，深页速度恒定
```

**API 变更：**
- 请求参数：`cursor=<last_id>`（替代 `offset=<n>`）
- 响应新增：`nextCursor: <last_id_of_page>`（为 null 表示末页）

### 4.2 批量 IN 查询补 `session_id`

**位置：** 事件详情查询中的 writes/reads/fields 批量获取

**当前（可能全表扫描）：**
```sql
SELECT event_id, name, value FROM writes WHERE event_id IN (?, ?, ..., ?)
-- 没有 session_id，索引 idx_writes_event 是 (session_id, event_id)，命中退化
```

**优化后：**
```sql
SELECT event_id, name, value FROM writes WHERE session_id=? AND event_id IN (?, ?, ..., ?)
-- (session_id, event_id) 复合索引完整命中，扫描范围缩小到当前 session
```

同理适用于 `reads` 和 `fields` 的批量 IN 查询。

### 4.3 F2 smap 回填：相关子查询 → JOIN UPDATE

**位置：** `analyzer/plugins/F2_SmapLoader.mjs`

**当前（N×3 子查询）：**
```sql
UPDATE events
SET line     = COALESCE(line, (SELECT sl FROM smap WHERE smap.session_id=events.session_id AND smap.iid=events.iid)),
    col      = COALESCE(col,  (SELECT sc FROM smap WHERE ...)),
    src_text = COALESCE(src_text, (SELECT src_text FROM smap WHERE ...))
WHERE session_id=? AND line IS NULL
-- 每行 events 执行 3 次子查询，100M 行中 1% 缺 line = 300 万次子查询
```

**注意：** 如果采用 2.1 节的方案删除 `events` 的 `line/col/src_text` 列，F2 的这个 UPDATE 就完全不需要了（最优解）。

如果暂时保留这些列，改为 JOIN UPDATE：
```sql
-- SQLite 3.33.0+ 支持 UPDATE ... FROM
UPDATE events
SET line     = COALESCE(events.line, s.sl),
    col      = COALESCE(events.col,  s.sc),
    src_text = COALESCE(events.src_text, s.src_text)
FROM smap s
WHERE events.session_id = ?
  AND events.line IS NULL
  AND s.session_id = events.session_id
  AND s.iid = events.iid
-- 单次 JOIN 替代 N×3 子查询
```

### 4.4 I3 混淆检测：去掉冗余 JOIN

**位置：** `analyzer/plugins/I3_ObfuscationDetector.mjs`

**当前（多余 JOIN）：**
```sql
SELECT w.name, COUNT(*) as cnt, COUNT(DISTINCT w.value) as distinct_vals
FROM writes w
JOIN events e ON w.event_id = e.id AND e.session_id = w.session_id
WHERE w.session_id = ? AND w.value NOT LIKE '"%"' ...
GROUP BY w.name
-- JOIN events 只是为了拿 session_id，但 writes 本身已有 session_id，JOIN 完全多余
```

**优化后：**
```sql
SELECT name, COUNT(*) as cnt, COUNT(DISTINCT value) as distinct_vals
FROM writes
WHERE session_id = ? AND value IS NOT NULL
  AND substr(value, 1, 1) != '"'
GROUP BY name
HAVING cnt >= 5 AND distinct_vals >= 3
```

### 4.5 I1 XOR 检测：events → smap

**位置：** `analyzer/plugins/I1_CryptoDetector.mjs`

当前依赖 `events.src_text`（若按 2.1 节删除该列，需改写）：

**当前：**
```sql
SELECT e.iid, e.line, COUNT(*) AS cnt
FROM events e
WHERE e.session_id=? AND e.src_text LIKE '%^%'
GROUP BY e.iid ORDER BY cnt DESC LIMIT 5
```

**优化后（查 smap，表更小）：**
```sql
SELECT s.iid, s.sl AS line, COUNT(e.id) AS cnt
FROM smap s
JOIN events e ON e.session_id=s.session_id AND e.iid=s.iid
WHERE s.session_id=? AND s.src_text LIKE '%^%'
GROUP BY s.iid ORDER BY cnt DESC LIMIT 5
```

`LIKE '%^%'` 本身无法走索引，但 smap 行数远少于 events（每个 iid 一行 vs 每次执行一行），全扫 smap 比全扫 events 快得多。

### 4.6 A3 热路径分析：分块 IN → 全量扫描

**位置：** `analyzer/plugins/A3_HotPathAnalyzer.mjs`

**当前（多次分块 IN）：**
```sql
-- 对每 900 个 hot iid 执行一次，5000 个 iid 需执行 ~6 次
SELECT iid, id FROM events WHERE session_id=? AND iid IN (?, ...) ORDER BY iid ASC, id ASC
```

**优化后（一次全量扫描）：**
```sql
-- 全量扫描一次，内存过滤 hot iid
SELECT iid, id FROM events WHERE session_id=? ORDER BY iid ASC, id ASC
```

对于 100M 事件，一次顺序 I/O 比 6 次随机 IN 查询更快（更好的预读，减少 query plan 解析开销）。F3/A1 已验证此模式有效。

### 4.7 A4/I2 的 events JOIN：去掉冗余条件 + D2 后改为 JOIN smap

**位置：** `A4_StringTracker.mjs` L42-49，`I2_SignatureAnalyzer.mjs` L63-79，L127-129

**当前（两处共同问题）：**

```sql
-- A4 / I2 中的模式：
SELECT w.event_id, w.name, w.value, e.line, e.iid
FROM writes w
JOIN events e ON w.event_id = e.id AND e.session_id = w.session_id
WHERE w.session_id = ? ...
-- 问题 1：JOIN 条件中的 e.session_id = w.session_id 是冗余的
-- （WHERE 已约束 w.session_id=?，JOIN 后 e.id 唯一确定行，无需再 filter session）
-- 问题 2：取 e.line 依赖 events.line 列，Phase D2 删除该列后查询报错
```

**优化后（去冗余 + D2 兼容）：**

```sql
-- Phase D2 之前（仅去掉冗余 JOIN 条件）：
SELECT w.event_id, w.name, w.value, e.line, e.iid
FROM writes w
JOIN events e ON w.event_id = e.id
WHERE w.session_id = ? ...

-- Phase D2 之后（events.line 已删除，改 JOIN smap）：
SELECT w.event_id, w.name, w.value, s.sl AS line, e.iid
FROM writes w
JOIN events e ON w.event_id = e.id
LEFT JOIN smap s ON s.session_id = w.session_id AND s.iid = e.iid
WHERE w.session_id = ? ...
```

同理，I2 中的 `SELECT id, line FROM events WHERE session_id = ?` 在 D2 后需改为：

```sql
SELECT e.id, s.sl AS line
FROM events e
LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
WHERE e.session_id = ?
```

---

## 5. 数据库配置优化

### 5.1 Pragma 调优

**位置：** `analyzer/db/Database.mjs` — `init()` 函数

**当前（仅 3 个 pragma）：**
```javascript
_db.pragma('journal_mode = WAL');
_db.pragma('foreign_keys = ON');
_db.pragma('synchronous = NORMAL');
```

**优化后（补充 5 个关键 pragma）：**
```javascript
_db.pragma('journal_mode = WAL');
_db.pragma('foreign_keys = ON');
_db.pragma('synchronous = NORMAL');

// 页缓存：64MB（默认 2MB，大 trace 分析时 B-tree 节点频繁换入换出）
_db.pragma('cache_size = -65536');       // 负数 = KB 单位，64MB

// 内存映射 I/O：256MB（顺序扫描 events/writes 时减少 syscall 开销）
_db.pragma('mmap_size = 268435456');

// 临时表放内存（GROUP BY/ORDER BY 的中间结果不写磁盘）
_db.pragma('temp_store = MEMORY');

// WAL 检查点阈值：10000 页（~40MB），避免 F1 批量写入时频繁触发检查点阻塞
// 默认 1000 页（~4MB）对百万级 INSERT 来说触发太频繁
_db.pragma('wal_autocheckpoint = 10000');

// 并发等待：5 秒（前端 API 与插件并发访问时，避免立即报 SQLITE_BUSY 错误）
_db.pragma('busy_timeout = 5000');
```

**各 pragma 的具体收益：**

| Pragma | 场景 | 收益 |
|--------|------|------|
| `cache_size = -65536` | A1/A5 全量预加载、A3 GROUP BY | B-tree 热节点常驻内存，减少磁盘读 |
| `mmap_size = 268435456` | F1/F3/A2 顺序全表扫描 | 操作系统页缓存直接映射，零拷贝读 |
| `temp_store = MEMORY` | I4 多个 GROUP BY + ORDER BY、A3 聚合 | 临时排序表在内存，不写 temp 文件 |
| `wal_autocheckpoint = 10000` | F1 批量 INSERT（50k/batch） | 减少检查点频率，写入吞吐提升 20-30% |
| `busy_timeout = 5000` | 前端查询与后台插件并发 | 避免误报 SQLITE_BUSY，自动重试 |

### 5.2 `db.get/all/run` 的 prepare 开销

**位置：** `analyzer/db/Database.mjs`

**当前问题：** 每次调用 `db.get/all/run` 都执行 `_db.prepare(sql)`，SQL 编译结果没有缓存。对于路由层的高频查询（事件分页、函数列表），每次请求都重新编译同一条 SQL。

```javascript
// 当前实现：每次调用都 prepare
export function all(sql, ...args) {
    const stmt = _db.prepare(sql);   // ← 每次都编译
    return stmt.all(params);
}
```

**优化方案：加 LRU 语句缓存**

```javascript
// 简单的 Map 缓存（SQL 字符串 → PreparedStatement）
const stmtCache = new Map();
const STMT_CACHE_MAX = 200;

function getStmt(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
        stmt = _db.prepare(sql);
        if (stmtCache.size >= STMT_CACHE_MAX) {
            // 删除最早插入的条目（Map 保持插入顺序）
            stmtCache.delete(stmtCache.keys().next().value);
        }
        stmtCache.set(sql, stmt);
    }
    return stmt;
}

export function all(sql, ...args) {
    const params = normalizeParams(args);
    return params.length > 0 ? getStmt(sql).all(params) : getStmt(sql).all();
}
```

**注意：** better-sqlite3 的 PreparedStatement 在 `db.close()` 后失效，需要在 `close()` 时清空缓存：
```javascript
export function close() {
    if (_db) {
        stmtCache.clear();
        _db.close();
        _db = null;
    }
}
```

### 5.3 Session delete 原子性

**位置：** `analyzer/server/routes/sessions.mjs`

**当前问题：** 25 个 DELETE 各自独立执行，无事务包裹。进程崩溃或中途报错会留下部分孤儿数据。

```javascript
// 当前：25 次独立事务
for (const table of TABLES_WITH_SESSION) {
    try { db.run(`DELETE FROM ${table} WHERE session_id = ?`, id); } catch {}
}
```

**优化后：单事务包裹**

```javascript
db.transaction(() => {
    for (const table of TABLES_WITH_SESSION) {
        try { db.run(`DELETE FROM ${table} WHERE session_id = ?`, id); } catch {}
    }
});
db.run('DELETE FROM sessions WHERE id = ?', id);
```

### 5.4 函数列表分页 COUNT 双扫描

**位置：** `analyzer/server/routes/sessions.mjs` — `GET /api/sessions/:id/functions`

**当前问题：** 主查询 + COUNT 子查询各扫一遍 `call_edges`：

```javascript
// 扫描 1：主查询
const rows = db.all(`SELECT fn_name, fn_iid, COUNT(*) AS call_count ...
    FROM call_edges WHERE ... GROUP BY fn_name, fn_iid HAVING ... LIMIT ? OFFSET ?`);

// 扫描 2：COUNT 子查询（与扫描 1 完全重复）
const totalRow = db.get(`SELECT COUNT(*) AS total FROM (
    SELECT fn_name FROM call_edges WHERE ... GROUP BY fn_name, fn_iid HAVING ...
)`);
```

**优化方案：用窗口函数合并为一次扫描**

```sql
SELECT
    fn_name, fn_iid,
    COUNT(*)           AS call_count,
    MIN(caller_line)   AS min_line,
    MIN(depth)         AS min_depth,
    MAX(depth)         AS max_depth,
    COUNT(*) OVER ()   AS total_groups   -- 窗口函数，无需第二次扫描
FROM call_edges
WHERE session_id = ? [AND fn_name LIKE ?]
GROUP BY fn_name, fn_iid
HAVING COUNT(*) >= ?
ORDER BY call_count DESC
LIMIT ? OFFSET ?
```

注意：SQLite 的窗口函数 `COUNT(*) OVER ()` 在 GROUP BY 之后计算，返回的是分组后的总行数（即函数总数），正好是分页需要的 `total`。

---

## 6. 值搜索设计（value_index）

### 6.1 问题根源

`writes.value` / `reads.value` / `fields.value` 存储的是 `JSON.stringify` 后的字符串：
- 数字 `42` → `"42"`
- 字符串 `"hello"` → `"\"hello\""`
- 对象 `{a:1}` → `"{\"a\":1}"`

对该列做值搜索只能用 `LIKE '%keyword%'`，存在三个根本性问题：
1. **无法走索引**：`LIKE '%x%'` 是全表扫描，100M 行需扫描几 GB 数据
2. **误匹配**：搜索 `"123"` 会命中所有含 `123` 的 JSON，包括 `{"abc123":"x"}`
3. **类型混淆**：数字 `42` 和字符串 `"42"` 存储形态不同，搜索须额外处理

### 6.2 解决方案：`value_index` 专用值索引表

在 F1 写入阶段，同步将原子值（数字、布尔、字符串）提取到专用索引表，以可索引的形式存储。

```sql
CREATE TABLE IF NOT EXISTS value_index (
    session_id  TEXT    NOT NULL,
    event_id    INTEGER NOT NULL,
    source      INTEGER NOT NULL,  -- 0=write 1=read 2=field_write 3=field_read
    name        TEXT,              -- 变量名 / 属性名（offset）
    val_type    INTEGER NOT NULL,  -- 0=null 1=bool 2=int 3=float 4=string
    val_num     REAL,              -- type=1/2/3 时存数值（bool→0/1，int/float→原值）
    val_str     TEXT,              -- type=4 时存字符串原文（去掉外层引号，截断到256字节）
    val_str_len INTEGER            -- 原始字符串长度（截断时用于标记是否完整）
);

-- 字符串搜索索引（部分索引，只含字符串行）
CREATE INDEX idx_vi_str   ON value_index(session_id, val_str)
    WHERE val_type = 4;

-- 数值搜索索引（部分索引，只含数值行）
CREATE INDEX idx_vi_num   ON value_index(session_id, val_num)
    WHERE val_type IN (1, 2, 3);

-- 按 event_id 反查（用于"找到 event_id 后拿完整上下文"）
CREATE INDEX idx_vi_event ON value_index(session_id, event_id);
```

**设计要点：**
- `val_type` 分离数值和字符串，两套部分索引互不干扰，体积各减半
- 数值用 `REAL` 存，支持精确匹配和范围查询（`BETWEEN ? AND ?`）
- 字符串截断到 256 字节，超长值（大对象、base64 块）不写 `val_str`，但保留 `val_str_len` 供过滤
- `source` 整数编码区分写/读/字段写/字段读，支持"只搜写入"的过滤
- CALL_PRE 的参数（`name='arg0'~'arg7'`）和返回值（`name='return'`）天然落入此表，函数 tab 值搜索可直接复用
- 使用 `DELETE WHERE session_id=?` 而非 `DROP TABLE`，支持多 session 数据并存（与 A8/I1/I2 的重建模式不同）

### 6.3 F1 写入时的提取逻辑

在 F1 的 `serializeValue` 调用旁，用同一个 `rawValue`（JS 原始值）同步提取，**零额外解析开销**：

```javascript
const VI_MAX_STR = 256;

// source 常量：与 value_index.source 列定义对应
const VI_SRC_WRITE       = 0;
const VI_SRC_READ        = 1;
const VI_SRC_FIELD_WRITE = 2;
const VI_SRC_FIELD_READ  = 3;

function extractValueIndex(sessionId, eventId, source, name, rawValue) {
    // null/undefined 不索引
    if (rawValue == null) return null;
    // 无名变量不索引（中间临时值，无搜索价值）
    if (!name) return null;

    const t = typeof rawValue;
    if (t === 'boolean') {
        return [sessionId, eventId, source, name, 1, rawValue ? 1 : 0, null, null];
    }
    if (t === 'number') {
        if (!isFinite(rawValue)) return null;  // NaN/Infinity 不索引
        return [sessionId, eventId, source, name, Number.isInteger(rawValue) ? 2 : 3, rawValue, null, null];
    }
    if (t === 'string') {
        const len = rawValue.length;
        if (len < 2) return null;  // 单字符无搜索价值
        const truncated = len > VI_MAX_STR ? rawValue.slice(0, VI_MAX_STR) : rawValue;
        return [sessionId, eventId, source, name, 4, null, truncated, len];
    }
    // object/array/function：不索引
    return null;
}

// F1 调用示例（writes 事件）：
// extractValueIndex(sessionId, eventId, VI_SRC_WRITE, varName, rawValue)

// F1 调用示例（fields 事件，根据 is_write 区分）：
// const src = event.isWrite ? VI_SRC_FIELD_WRITE : VI_SRC_FIELD_READ;
// extractValueIndex(sessionId, eventId, src, event.offset, event.val)
```

**去重控制（防止循环变量爆炸）：**

循环变量（`i=0,1,2,...,99999`）会产生大量低价值的重复数值行。用 session 级计数 Map 限制：

```javascript
// session 维度的去重计数
const viDedup = new Map(); // key: `${name}|${val_num_or_str_prefix}`, value: count
const VI_MAX_SAME = 50;    // 同一变量同一值最多索引 50 次

function shouldIndexValue(name, val) {
    const key = `${name}|${val}`;
    const cnt = (viDedup.get(key) ?? 0) + 1;
    viDedup.set(key, cnt);
    return cnt <= VI_MAX_SAME;
}
```

### 6.4 存储开销估算

100M 事件的 trace，`writes` 约 150-200M 行。过滤后：
- 跳过 null/object/无名变量：约减少 40%
- 去重控制（循环变量）：约再减少 30%
- 有效行：约 **50-80M 行**，每行 ~60 字节 → **3-5 GB**

加上两个部分索引（各约 1/2 数据量）：索引体积约 **1.5-2.5 GB**

总 `value_index` 占用：**4.5-7.5 GB**，可通过调整 `VI_MAX_SAME` 和 `VI_MAX_STR` 控制。

### 6.5 查询设计

**事件流 — 按值搜索：**

```sql
-- 字符串精确匹配（走 idx_vi_str，O(log N)）
SELECT DISTINCT vi.event_id
FROM value_index vi
WHERE vi.session_id = ? AND vi.val_type = 4 AND vi.val_str = ?
ORDER BY vi.event_id ASC LIMIT 500;

-- 字符串前缀匹配（走 idx_vi_str，能走索引范围扫描）
SELECT DISTINCT vi.event_id
FROM value_index vi
WHERE vi.session_id = ? AND vi.val_type = 4
  AND vi.val_str >= ? AND vi.val_str < ? || x'FF'
ORDER BY vi.event_id ASC LIMIT 500;

-- 数值精确匹配（走 idx_vi_num）
SELECT DISTINCT vi.event_id
FROM value_index vi
WHERE vi.session_id = ? AND vi.val_type IN (1,2,3) AND vi.val_num = ?
ORDER BY vi.event_id ASC LIMIT 500;

-- 数值范围查询（走 idx_vi_num）
SELECT DISTINCT vi.event_id
FROM value_index vi
WHERE vi.session_id = ? AND vi.val_type IN (1,2,3)
  AND vi.val_num BETWEEN ? AND ?
ORDER BY vi.event_id ASC LIMIT 500;

-- 只搜写入（source=0）
SELECT DISTINCT vi.event_id
FROM value_index vi
WHERE vi.session_id = ? AND vi.source = 0 AND vi.val_type = 4 AND vi.val_str = ?
ORDER BY vi.event_id ASC LIMIT 500;
```

**函数 tab — 按参数值搜索（通过 value_index 关联 call_edges）：**

```sql
-- 找参数包含某值的所有调用
SELECT DISTINCT ce.id, ce.fn_name, ce.call_seq, ce.return_seq, ce.args_json, ce.return_value
FROM value_index vi
JOIN call_edges ce ON ce.session_id = vi.session_id AND ce.call_seq = vi.event_id
WHERE vi.session_id = ? AND vi.val_type = 4 AND vi.val_str = ?
  AND vi.name IN ('arg0','arg1','arg2','arg3','arg4','arg5','arg6','arg7')
ORDER BY ce.call_seq ASC LIMIT 200;

-- 找 return_value 等于某值的调用（call_edges 直接加索引）
SELECT id, fn_name, fn_iid, call_seq, return_seq, args_json, return_value, depth
FROM call_edges
WHERE session_id = ? AND return_value = ?
ORDER BY call_seq ASC LIMIT 200;
```

**对 `call_edges.return_value` 补充索引：**

```sql
CREATE INDEX IF NOT EXISTS idx_call_edges_retval ON call_edges(session_id, return_value);
```

### 6.6 对现有插件的额外收益

有了 `value_index`，A4 和 A8 可以直接查此表，不再全扫 `writes`：

- **A4（StringTracker）**：`SELECT ... FROM value_index WHERE val_type=4` 替代 `writes JOIN events WHERE value LIKE '"%"'`
- **A8（ValuePatternDetector）**：`SELECT val_num, COUNT(*) FROM value_index WHERE val_type IN (1,2,3) GROUP BY val_num ORDER BY COUNT DESC LIMIT 2000` 替代全扫 `writes` 后在内存中聚合

两个插件的运行速度预计提升 3-5x。

### 6.7 实施要点

| 步骤 | 内容 |
|------|------|
| schema.sql | 新增 `value_index` 表 + 3 个索引 |
| schema.sql | 新增 `idx_call_edges_retval` |
| F1_EventIndex.mjs | 新增 `valueIndexBatch`，与 `writeBatch` 同步填充 |
| F1_EventIndex.mjs | 新增 `viDedup` Map，session 结束时清空 |
| sessions.mjs | 新增 `GET /api/sessions/:id/value-search` 端点 |
| sessions.mjs | 函数调用详情端点支持 `argValue` / `returnValue` 过滤参数 |
| EventsTab.vue | 新增值搜索输入框（类型选择：字符串/数值/范围） |
| FunctionsTab.vue | 调用列表支持按参数值 / 返回值过滤 |
| A4_StringTracker.mjs | 改为查 `value_index` |
| A8_ValuePatternDetector.mjs | 改为查 `value_index` |
| DELETE session | 清理列表加入 `value_index` |

---

## 7. 索引全景（含值搜索，最终版）

| 表 | 索引 | 用途 |
|----|------|------|
| events | PRIMARY KEY (id) | 主键查找 |
| events | (session_id, type, id) | F3 扫描 + 排序消除 |
| events | (session_id, iid) | iid 聚合 |
| writes | (session_id, name, event_id) | A1/I2 二分查找 |
| writes | (session_id, event_id) | 批量 IN 查询 |
| reads | (session_id, name, event_id) | A1/I2 二分查找 |
| reads | (session_id, event_id) | 批量 IN 查询 |
| fields | (session_id, offset) | I1 属性扫描 |
| fields | (session_id, event_id) | 批量 IN 查询 |
| smap | PRIMARY KEY (session_id, iid) | iid 映射 |
| iid_counts | PRIMARY KEY (session_id, iid) | 精确查找 |
| iid_counts | (session_id, count DESC) | TOP-N 热路径 |
| loops | (session_id, iteration_count DESC) | A5 加载循环排序消除 |
| call_edges | (session_id) | 全量扫描 |
| call_edges | (session_id, fn_name) | 函数名查找 |
| call_edges | (session_id, return_value) | 按返回值搜索 |
| value_patterns | (session_id) | 全量扫描 |
| value_patterns | (session_id, matched_constant) WHERE NOT NULL | I1 常量匹配 |
| **value_index** | **(session_id, val_str) WHERE val_type=4** | **字符串值搜索** |
| **value_index** | **(session_id, val_num) WHERE val_type IN (1,2,3)** | **数值/布尔值搜索** |
| **value_index** | **(session_id, event_id)** | **按 event 反查值** |
| var_lifetime | (session_id, name) | 变量查找 |
| object_timelines | (session_id, base_var) | 对象追踪 |
| taint_paths | (session_id) | 结果读取 |
| dataflow_edges | (session_id) | 结果读取 |
| bookmarks | (session_id, seq) | 书签查找 |
| plugin_checkpoints | UNIQUE (session_id, plugin_id) | 断点恢复 |

---

## 8. 实施路线图（完整版）

### Phase A — 无破坏性改动（可立即执行）

| 编号 | 改动 | 文件 |
|------|------|------|
| A1 | 删除冗余索引 `idx_events_session_seq` + `idx_smap_session` + `idx_writes_name` + `idx_reads_name` | schema.sql + migration |
| A2 | 新增 `idx_writes_name_eid` + `idx_reads_name_eid`（替代 A1 删除的旧索引） | schema.sql + migration |
| A3 | 新增 `idx_events_type_id`（减少扫描行数，注意不能消除 IN 多值的 filesort） | schema.sql + migration |
| A4 | 新增 `idx_iid_counts_count` | schema.sql + migration |
| A5 | 新增 `idx_loops_iter_count`（A5 加载循环排序消除） | schema.sql + migration |
| A6 | 新增 `idx_vp_matched`（部分索引） | schema.sql + migration |
| A7 | IN 查询补 `session_id` | sessions.mjs |
| A8 | I3 去掉冗余 JOIN | I3_ObfuscationDetector.mjs |
| A9 | A3 分块 IN 改全量扫描 | A3_HotPathAnalyzer.mjs |
| A10 | A4/I2 的 `JOIN events` 去掉冗余 `e.session_id = w.session_id` 条件 | A4_StringTracker.mjs, I2_SignatureAnalyzer.mjs |
| A11 | 新增 `idx_call_edges_retval`（函数 tab 按返回值搜索） | schema.sql + migration |

### Phase B — 需要 migration 的 Schema 改动

| 编号 | 改动 | 涉及文件 |
|------|------|---------|
| B1 | 合并 `hot_iids` → `iid_counts` | schema.sql + A3/I3/I4/sessions.mjs |
| B2 | 删除 `writes/reads/fields` 的 `id` 列 | schema.sql + F1 + migration |
| B3 | 事件列表分页改游标 | sessions.mjs + 前端 |
| B4 | F2 UPDATE 改 JOIN UPDATE | F2_SmapLoader.mjs |

### Phase C — 值搜索功能（新增）

| 编号 | 改动 | 涉及文件 |
|------|------|---------|
| C1 | 新增 `value_index` 表 + 3 索引 | schema.sql |
| C2 | 新增 `idx_call_edges_retval` | schema.sql |
| C3 | F1 同步填充 `value_index`（含去重逻辑） | F1_EventIndex.mjs |
| C4 | 新增值搜索 API 端点 | sessions.mjs |
| C5 | 函数调用端点支持参数/返回值过滤 | sessions.mjs |
| C6 | EventsTab 新增值搜索 UI | EventsTab.vue |
| C7 | FunctionsTab 新增参数/返回值搜索 UI | FunctionsTab.vue |
| C8 | A4/A8 改为查 `value_index` | A4/A8 插件 |
| C9 | DELETE session 清理 `value_index` | sessions.mjs |

### Phase D — 高收益但改动较大

| 编号 | 改动 | 涉及文件 |
|------|------|---------|
| D1 | `events.type` TEXT → INTEGER + `event_types` 枚举表 | schema.sql + F1 + 所有插件 + API |
| D2 | 删除 `events.line/col/src_text`，查询时 JOIN smap | schema.sql + F1 + F2(可删) + F3 + A2 + A3 + A4 + A7 + I1 + I2 + I4 + API |

D1 + D2 合并实施收益最大（节省 3-4GB，查询速度提升明显），建议在一个独立 PR 中完成。D2 的影响面比预期大（9 个插件，含 A4/I2），实施前需逐一验证每个插件的改写是否正确（改写方案见 4.7 节）。

### Phase E — Bug 修复（独立处理）

| 编号 | 改动 | 涉及文件 |
|------|------|---------|
| E1 | A2 fields 查询去掉 `LIMIT 5000`，改为全量加载或分批流式处理 | A2_DataFlowGraph.mjs |
| E2 | A5 全量 events + writes 预加载改为流式/分批，防止大 trace OOM | A5_LoopDetector.mjs |
| E3 | A8/I1/I2 的 `DROP TABLE` 重建模式改为 `DELETE WHERE session_id=?` | A8/I1/I2 插件 + schema.sql |
| E4 | A4 去掉 `LIMIT 10000`，改为全量加载（字符串写入通常远少于 10k） | A4_StringTracker.mjs |
| E5 | I2 去掉 `LIMIT 50000` / `LIMIT 20000`，改为全量加载（与 A1 一致） | I2_SignatureAnalyzer.mjs |

---

## 9. 预期收益汇总（完整版）

| 维度 | 当前 | 优化后 | 提升 |
|------|------|--------|------|
| 存储（100M 事件） | ~6-8 GB | ~2-3 GB（不含 value_index） | 节省 60-70% |
| value_index 新增占用 | — | ~4.5-7.5 GB | 以空间换搜索速度 |
| F1 写入速度 | 基准 | +20-30%（更小的行，更少的索引） | |
| F3 全量扫描 | 基准 | +30-50%（消除 filesort） | |
| A1 预加载 | 基准 | +20-40%（覆盖索引消除排序） | |
| 事件列表翻页（深页） | 秒级 | 毫秒级 | 质变 |
| I3 混淆检测 | 基准 | +30%（去掉冗余 JOIN） | |
| I1 XOR 检测 | 基准 | +5-10x（smap 远小于 events） | |
| **值搜索（当前）** | **不支持 / 全表扫描** | **毫秒级（索引命中）** | **质变** |
| **A4/A8 运行速度** | **基准** | **+3-5x（查 value_index 替代全扫 writes）** | |

---

## 10. 待决策事项

- [ ] **`VI_MAX_SAME` 阈值**：当前设 50，可根据实际 trace 特征调整（越小存储越省，但可能漏掉高频出现的有效值）
- [ ] **`VI_MAX_STR` 长度**：当前设 256 字节，base64 token 通常 300-500 字节，是否需要加大？
- [ ] **D1/D2 时机**：`events.type` 改 INTEGER + 删除 `events.line/col/src_text` 需要更新 7 个插件，是否在 Phase C 完成后一并做？
- [ ] **游标分页的前端改动量**：当前前端是否有多处使用 offset 参数，改动范围评估
- [ ] **`call_edges.args_json` 是否需要拆分**：若未来需要按参数类型/值查询，`value_index` 已通过 `name='arg0'` 覆盖，无需额外拆分
- [ ] **E2 的 A5 OOM 修复策略**：A5 全量加载 events + writes 是设计决策（需要全局视图做二分），真正的修复需要重新设计算法（如按 iid 分批处理），改动较大，是否优先处理？
- [ ] **E3 的多 session 并存问题**：A8/I1/I2 的 DROP TABLE 模式是否真的需要修复？如果业务上每次分析只有一个 session 在运行，这个问题实际上不存在
