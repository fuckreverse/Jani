-- Jani Trace Analyzer — 数据库 Schema
-- 版本：v1.1 (Phase D: type=INTEGER, 移除 line/col/src_text)
-- 说明：所有表和索引均在此定义，即使 Phase 1 暂不使用的表也包含在内

-- ─── 工作空间（项目）─────────────────────────────────────────────────────────
-- 每个 Project 绑定一份原始 JS + 插桩产物（instrumented code + smap），
-- 后续只需上传 trace log 即可创建分析会话，无需重复插桩。

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    source_file     TEXT,           -- 原始 JS 路径（服务端存储）
    preprocessed_path TEXT,         -- 预处理后 JS 路径（可为 null，表示未启用预处理）
    instrumented_path TEXT,         -- 插桩后 JS 路径
    smap_path       TEXT,           -- smap.json 路径
    status          TEXT DEFAULT 'pending',  -- pending / instrumenting / ready / failed
    instrument_options TEXT DEFAULT '{}',    -- 插桩时使用的选项（JSON）
    iid_count       INTEGER DEFAULT 0,
    error_msg       TEXT,
    updated_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC);

-- ─── 分析会话 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    created_at  INTEGER,
    source_file TEXT,
    bin_path    TEXT,
    smap_path   TEXT,
    event_count INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending',
    plugin_status TEXT DEFAULT '{}',
    project_id  TEXT    -- 关联的工作空间（可为 null）
);

-- ─── 事件流（主表）──────────────────────────────────────────────────────────
-- type 列存储整数编码（见 EventTypeCode 常量），由 API 层解码为字符串返回前端。
-- line/col/src_text 已移除，统一从 smap 表按 iid 查询，避免冗余存储。

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL,
    type        INTEGER NOT NULL,   -- 事件类型整数编码，见 EventTypeCode 映射
    iid         INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- ─── 变量写入 ────────────────────────────────────────────────────────────────
-- value_id: 引用 value_dict.id（F1 v2+ 填充）；NULL 表示旧数据或值无法字典化

CREATE TABLE IF NOT EXISTS writes (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value_id    INTEGER,        -- 引用 value_dict.(session_id, id)，通过 JOIN 获取完整值
    omitted     INTEGER DEFAULT 0
);

-- ─── 变量读取 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reads (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value_id    INTEGER,        -- 引用 value_dict.(session_id, id)，通过 JOIN 获取完整值
    omitted     INTEGER DEFAULT 0
);

-- ─── 属性读写 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fields (
id          INTEGER PRIMARY KEY,
event_id    INTEGER NOT NULL,
session_id  TEXT NOT NULL,
offset      TEXT,
is_write    INTEGER,
value_id    INTEGER,            -- 引用 value_dict.(session_id, id)，通过 JOIN 获取完整值
omitted     INTEGER DEFAULT 0,
base_oid    INTEGER             -- 运行时对象唯一 ID（OID），NULL 表示非对象或 OID 未知
);

-- ─── 源码映射 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS smap (
    session_id  TEXT NOT NULL,
    iid         INTEGER NOT NULL,
    sl INTEGER, sc INTEGER,
    el INTEGER, ec INTEGER,
    src_text    TEXT,
    def_iid     INTEGER,
    PRIMARY KEY (session_id, iid)
);

-- ─── 调用图边（F3 CallGraphBuilder 填充）────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    call_seq        INTEGER,
    return_seq      INTEGER,
    caller_line     INTEGER,
    fn_name         TEXT,
    fn_iid          INTEGER,
    args_json       TEXT,
    return_value    TEXT,
    depth           INTEGER,
    own_event_count INTEGER, -- 自身事件数：(return_seq - call_seq) 减去所有直接子调用覆盖的 SEQ 跨度
                             -- 由 F3_CallGraphBuilder 在构建调用图时一次性计算写入，O(N) 预计算
                             -- 迁移：旧数据此列为 NULL，重跑 F3 可填充
    fn_def_iid      INTEGER  -- 函数定义点 iid（J$.Fe 注入时的 iid，同一函数体每次调用相同）
                             -- 由 CALL_PRE 事件携带的 fnDefIid 字段填充（runtime 通过 WeakMap 查取）
                             -- 内建/未插桩函数此列为 NULL
);

-- ─── 污点路径（A1 TaintTracker 填充）────────────────────────────────────────

CREATE TABLE IF NOT EXISTS taint_paths (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    source_event_id INTEGER,
    sink_event_id   INTEGER,
    path_json       TEXT,
    source_var      TEXT,
    sink_var        TEXT,
    hop_count       INTEGER
);

-- ─── 变量生命周期（F4 VariableLifetime 填充）────────────────────────────────

CREATE TABLE IF NOT EXISTS var_lifetime (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    first_write_seq INTEGER,
    last_read_seq   INTEGER,
    write_count     INTEGER DEFAULT 0,
    read_count      INTEGER DEFAULT 0,
    scope           TEXT
);

-- ─── 作用域（F5 ScriptScopeAnalyzer 填充）───────────────────────────────────

CREATE TABLE IF NOT EXISTS scopes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    scope_id        INTEGER,
    parent_scope_id INTEGER,
    fn_iid          INTEGER,
    fn_name         TEXT,
    start_seq       INTEGER,
    end_seq         INTEGER
);

-- ─── 书签/标注（用户手动标记）───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    label       TEXT,
    note        TEXT,
    created_at  INTEGER
);

-- ─── 服务端运行任务（InstrumentRunner 管理）─────────────────────────────────

CREATE TABLE IF NOT EXISTS run_tasks (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER,
    status      TEXT DEFAULT 'running',
    code        TEXT,
    filename    TEXT,
    env         TEXT DEFAULT 'node',
    stdout      TEXT,
    stderr      TEXT,
    exit_code   INTEGER,
    duration_ms INTEGER,
    session_id  TEXT,
    error_msg   TEXT
);

-- ─── 循环（A3/A5 填充）──────────────────────────────────────────────────────
-- v2 新增字段（A3 改进版）：
--   src_text      — 循环首行源码（来自 smap），便于 UI 直接展示，无需二次 JOIN
--   median_gap    — 循环 iid 命中的中位数间距（衡量循环体体积，A3 自适应阈值依据）
--   loop_depth    — 嵌套深度（0 = 顶层，1 = 外层循环内的循环，...）
--   parent_loop_id — 直接父循环的 id（NULL = 顶层）
-- v3 新增字段（A3 函数边界感知版）：
--   call_edge_id  — 产生该循环的函数调用帧 id（引用 call_edges.id）；
--                   NULL 表示在顶层脚本执行中检测到的循环（无函数帧）
--   fn_name       — 所属函数名（冗余自 call_edges.fn_name，避免 JOIN，UI 直接展示）

CREATE TABLE IF NOT EXISTS loops (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    iid             INTEGER,
    start_seq       INTEGER,
    end_seq         INTEGER,
    iteration_count INTEGER,
    line            INTEGER,
    src_text        TEXT,       -- 循环首行源码片段（v2 新增）
    median_gap      INTEGER,    -- iid 命中间距中位数（v2 新增，单位：events）
    loop_depth      INTEGER DEFAULT 0,  -- 嵌套深度（v2 新增）
    parent_loop_id  INTEGER,    -- 直接父循环 id（v2 新增，NULL=顶层）
    call_edge_id    INTEGER,    -- 所属函数调用帧（v3 新增，NULL=顶层脚本）
    fn_name         TEXT        -- 所属函数名（v3 新增，冗余副本供 UI 直接展示）
);

-- ─── 循环迭代快照（A5 LoopDetector 填充）────────────────────────────────────

CREATE TABLE IF NOT EXISTS loop_iterations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    loop_id         INTEGER NOT NULL,
    iteration_idx   INTEGER NOT NULL,
    start_seq       INTEGER,
    end_seq         INTEGER,
    vars_snapshot   TEXT
);

-- ─── 字符串事件（A4 StringTracker 填充）─────────────────────────────────────
-- Phase 4 重构：增加 var_name / line / iid / encoding_hint 列

CREATE TABLE IF NOT EXISTS string_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    event_id        INTEGER,
    value           TEXT,
    var_name        TEXT,
    line            INTEGER,
    iid             INTEGER,
    encoding_hint   TEXT    -- 'base64' / 'hex' / 'url' / 'plain' / null
);
CREATE INDEX IF NOT EXISTS idx_str_events_session ON string_events(session_id);

-- ─── 函数签名推断（A6 FunctionSignatureInfer 填充）──────────────────────────
-- Phase 4 重构：列名对齐 + 增加 sample_args / sample_return

CREATE TABLE IF NOT EXISTS fn_signatures (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    fn_name         TEXT,
    fn_iid          INTEGER,
    call_count      INTEGER DEFAULT 0,
    is_pure         INTEGER DEFAULT 0,
    arg_types       TEXT,               -- JSON: 各参数类型分布
    return_types    TEXT,               -- JSON: 返回类型分布
    sample_args     TEXT,               -- JSON: 最近一次调用的参数
    sample_return   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fn_sig_session ON fn_signatures(session_id);

-- ─── 对象变更时间线（A7 ObjectMutationTracker 填充）─────────────────────────
-- Phase 4 重构：列名对齐（base→base_var, offset→offset_key, seq→change_seq 等）

CREATE TABLE IF NOT EXISTS object_timelines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    base_var        TEXT,   -- '#<oid>' 或 '<varName> (#<oid>)'（有别名时）
    offset_key      TEXT,
    change_seq      INTEGER,
    old_value       TEXT,
    new_value       TEXT,
    line            INTEGER,
    is_write        INTEGER DEFAULT 1,
    src_text        TEXT    -- 该行源码片段（来自 smap.src_text，方向五补充）
);
CREATE INDEX IF NOT EXISTS idx_obj_timeline_session ON object_timelines(session_id, base_var);
-- 时间窗口过滤：change_seq 范围查询
CREATE INDEX IF NOT EXISTS idx_obj_timeline_seq    ON object_timelines(session_id, change_seq);

-- ─── OID 别名（F1 EventIndex 填充，方向三：OID→变量名映射）──────────────────
-- 记录 OID 对应的变量名（一个 OID 可有多个变量名，取最早出现的）

CREATE TABLE IF NOT EXISTS oid_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    oid         INTEGER NOT NULL,   -- 运行时对象 OID
    var_name    TEXT NOT NULL,      -- 持有该 OID 的变量名
    event_id    INTEGER NOT NULL    -- 首次观察到此绑定的事件 id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oid_aliases_oid_var ON oid_aliases(session_id, oid, var_name);
CREATE INDEX IF NOT EXISTS idx_oid_aliases_session ON oid_aliases(session_id, oid);

-- ─── 值模式（A8 ValuePatternDetector 填充）──────────────────────────────────

CREATE TABLE IF NOT EXISTS value_patterns (
id              INTEGER PRIMARY KEY AUTOINCREMENT,
session_id      TEXT NOT NULL,
value_hash      TEXT,
count           INTEGER DEFAULT 0,
first_seq       INTEGER,
iid             INTEGER,
var_name        TEXT,
line            INTEGER,
matched_constant TEXT,
value_dict_id   INTEGER,  -- 引用 value_dict.id，A8 v2 填充，可直接查完整原始值
pattern_type    TEXT,      -- 语义类型标签（A8 v3）：timestamp_ms/timestamp_s/uuid/hex_str/
                           -- base64_charset/custom_alphabet/base64_encoded/ip_addr/url/json_obj/byte_array
entropy         REAL       -- Shannon 熵值（A8 v4）：字符串型值计算，高熵（>4.5）暗示加密/压缩；NULL 表示非字符串型
);

-- ─── 加密检测（I1 CryptoDetector 填充）──────────────────────────────────────

CREATE TABLE IF NOT EXISTS crypto_hints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    algorithm   TEXT,
    confidence  REAL,
    evidence    TEXT,
    iid         INTEGER,
    line        INTEGER,
    fn_name     TEXT
);

-- ─── 签名路径（I2 SignatureAnalyzer 填充）───────────────────────────────────

CREATE TABLE IF NOT EXISTS signature_paths (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    field_name      TEXT,
    sink_event_id   INTEGER,
    path_json       TEXT,
    summary         TEXT,
    input_vars      TEXT,
    hops            INTEGER
);

-- ─── 混淆检测（I3 ObfuscationDetector 填充）─────────────────────────────────
-- Phase 4 重构：增加 description / line 列

CREATE TABLE IF NOT EXISTS obfuscation_hints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    hint_type       TEXT,   -- 'short_var' / 'string_decoder' / 'obfuscated_control_flow' / 'high_entropy_name'
    description     TEXT,
    iid             INTEGER,
    line            INTEGER,
    confidence      REAL,
    fn_name         TEXT    -- 仅 string_decoder 类型填充，用于前端跳转到函数面板
);
CREATE INDEX IF NOT EXISTS idx_obf_hints_session ON obfuscation_hints(session_id);

-- ─── 分析摘要（I4 AlgorithmSummarizer 填充）─────────────────────────────────
-- Phase 4 重构：列名对齐

CREATE TABLE IF NOT EXISTS analysis_summary (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL UNIQUE,
    generated_at    INTEGER,
    summary_json    TEXT,
    summary_md      TEXT
);

-- ─── Web API 调用（I5 WebApiDetector 填充）──────────────────────────────────
-- 记录运行时对 BOM/DOM 接口的访问与调用，含两级置信度推断：
--   confidence_level: 'confirmed' = oid_aliases 精确匹配 + 属性名命中
--                     'inferred'  = 仅通过属性名/函数名启发式推断
-- category: 'window' / 'document' / 'navigator' / 'location' / 'storage' /
--           'xhr' / 'fetch' / 'timing' / 'observer' / 'event' / 'canvas' / 'other'
-- access_type: 'call' (方法调用) / 'read' (属性读取) / 'write' (属性写入)

CREATE TABLE IF NOT EXISTS web_api_calls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    event_id        INTEGER NOT NULL,   -- 对应 events.id（字段访问事件 seq）
    call_edge_id    INTEGER,            -- 关联的 call_edges.id（若紧接着有调用）
    category        TEXT NOT NULL,      -- 宿主对象分类
    host_obj        TEXT NOT NULL,      -- 推断的宿主对象名（'document'/'window' 等）
    property_name   TEXT NOT NULL,      -- 属性名 / 方法名
    access_type     TEXT NOT NULL,      -- 'call' / 'read' / 'write'
    confidence_level TEXT NOT NULL,     -- 'confirmed' / 'inferred'
    receiver_var    TEXT,               -- oid_aliases 中找到的变量名（confirmed 时有值）
    args_json       TEXT,               -- 若 access_type='call'，来自 call_edges.args_json
    return_value    TEXT,               -- 若 access_type='call'，来自 call_edges.return_value
    line            INTEGER,            -- 来自 smap.sl
    src_text        TEXT                -- 来自 smap.src_text
);
CREATE INDEX IF NOT EXISTS idx_web_api_session     ON web_api_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_web_api_category    ON web_api_calls(session_id, category);
CREATE INDEX IF NOT EXISTS idx_web_api_host        ON web_api_calls(session_id, host_obj);
CREATE INDEX IF NOT EXISTS idx_web_api_property    ON web_api_calls(session_id, property_name);
CREATE INDEX IF NOT EXISTS idx_web_api_access_type ON web_api_calls(session_id, access_type);

-- ─── A2: 数据流图边（Phase 4 新增）─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dataflow_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    from_event_id   INTEGER,
    to_event_id     INTEGER,
    from_var        TEXT,
    to_var          TEXT,
    edge_type       TEXT,   -- assign / call_arg / call_ret / field_read / field_write
    iid             INTEGER,
    line            INTEGER
);
-- 主查询索引
CREATE INDEX IF NOT EXISTS idx_df_session         ON dataflow_edges(session_id);
-- 子图 BFS：从 from_event_id 出发找下游 / from_var 搜索
CREATE INDEX IF NOT EXISTS idx_df_from_event      ON dataflow_edges(session_id, from_event_id);
-- 子图 BFS：从 to_event_id 出发找上游（backward slice）/ to_var 搜索
CREATE INDEX IF NOT EXISTS idx_df_to_event        ON dataflow_edges(session_id, to_event_id);
-- 变量名搜索（covering: session_id + from_var/to_var）
CREATE INDEX IF NOT EXISTS idx_df_from_var        ON dataflow_edges(session_id, from_var);
CREATE INDEX IF NOT EXISTS idx_df_to_var          ON dataflow_edges(session_id, to_var);
-- edge_type 过滤（统计/筛选）
CREATE INDEX IF NOT EXISTS idx_df_edge_type       ON dataflow_edges(session_id, edge_type);

-- ─── 值字典（F1 EventIndex 填充，全局唯一字符串池）──────────────────────────
-- 将 writes/reads/fields 中的 value 文本去重存储，每个 session 独立字典。
-- writes/reads/fields.value_id 引用此表的 id，减少重复字符串存储。
-- val_type: 'num' / 'bool' / 'str' / 'null' / 'obj' / 'ta'（TypedArray/ArrayBuffer）
-- val_num:  数值（val_type='num' 时有效，方便数值范围查询）
-- 典型压缩比：循环场景下同一个数值 100k 次写入 → 只存 1 行

CREATE TABLE IF NOT EXISTS value_dict (
    id          INTEGER NOT NULL,  -- session 内局部 id，从 1 开始，跨 session 可重复
    session_id  TEXT NOT NULL,
    val_text    TEXT NOT NULL,   -- 原始序列化字符串（同 writes/reads/fields.value）
    val_type    TEXT NOT NULL,   -- 'num' / 'bool' / 'str' / 'null' / 'obj' / 'ta'
    val_num     REAL,            -- val_type='num' 时有效，用于数值范围查询
    PRIMARY KEY (session_id, id),
    UNIQUE (session_id, val_text)
);
-- 按 session + val_text 查找：F1 写入时查重
CREATE INDEX IF NOT EXISTS idx_vd_session_text ON value_dict(session_id, val_text);
-- 按 session + val_num 范围查询：数值搜索
CREATE INDEX IF NOT EXISTS idx_vd_num ON value_dict(session_id, val_num) WHERE val_type = 'num';
-- 按 val_type 过滤：列出某 session 的所有字符串值 / 数值等
CREATE INDEX IF NOT EXISTS idx_vd_type ON value_dict(session_id, val_type);

-- ─── 值索引（F1 EventIndex 填充，供值搜索 API 使用）────────────────────────
-- 对每个 write/read/field 的值做类型化索引，支持按值反查事件
-- val_type: 'num' / 'bool' / 'str' / 'ta'（TypedArray/ArrayBuffer）
-- VI_MAX_SAME=50：同一值最多记录 50 条，防止循环变量爆炸

CREATE TABLE IF NOT EXISTS value_index (
    session_id  TEXT NOT NULL,
    event_id    INTEGER NOT NULL,
    val_type    TEXT NOT NULL,   -- 'num' / 'bool' / 'str' / 'ta'
    val_num     REAL,            -- val_type='num' 时有效
    val_str     TEXT,            -- val_type='str'/'bool'/'ta' 时有效（截断至 256 字符）
    var_name    TEXT,
    source      TEXT NOT NULL,   -- 'write' / 'read' / 'field'
    PRIMARY KEY (session_id, event_id, source)
);
CREATE INDEX IF NOT EXISTS idx_vi_num     ON value_index(session_id, val_num) WHERE val_type = 'num';
CREATE INDEX IF NOT EXISTS idx_vi_str     ON value_index(session_id, val_str) WHERE val_type = 'str';
-- TypedArray 类型过滤：列出某 session 所有 TypedArray 事件
CREATE INDEX IF NOT EXISTS idx_vi_ta      ON value_index(session_id, val_str) WHERE val_type = 'ta';
-- var_name 过滤：按变量名反查事件（P1 值追踪增强）
CREATE INDEX IF NOT EXISTS idx_vi_varname ON value_index(session_id, var_name);

-- ─── 索引 ────────────────────────────────────────────────────────────────────

-- ─── iid 执行计数（A3 HotPathAnalyzer 填充，热力图数据）────────────────────────

CREATE TABLE IF NOT EXISTS iid_counts (
    session_id  TEXT NOT NULL,
    iid         INTEGER NOT NULL,
    count       INTEGER DEFAULT 0,
    line        INTEGER,
    src_text    TEXT,
    PRIMARY KEY (session_id, iid)
);

CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);
CREATE INDEX IF NOT EXISTS idx_events_iid          ON events(session_id, iid);
-- 覆盖索引：name + event_id，消除 A2/A5 的回表查询
CREATE INDEX IF NOT EXISTS idx_writes_name_eid     ON writes(session_id, name, event_id);
CREATE INDEX IF NOT EXISTS idx_reads_name_eid      ON reads(session_id, name, event_id);
-- 保留旧名称索引（向后兼容，迁移时会自动创建新版）
CREATE INDEX IF NOT EXISTS idx_writes_name         ON writes(session_id, name);
CREATE INDEX IF NOT EXISTS idx_writes_event        ON writes(session_id, event_id);
CREATE INDEX IF NOT EXISTS idx_reads_name          ON reads(session_id, name);
CREATE INDEX IF NOT EXISTS idx_reads_event         ON reads(session_id, event_id);
CREATE INDEX IF NOT EXISTS idx_fields_offset       ON fields(session_id, offset);
CREATE INDEX IF NOT EXISTS idx_fields_event        ON fields(session_id, event_id);
-- 注意：idx_writes_value_id / idx_reads_value_id / idx_fields_value_id
-- 由 Database.mjs _runMigrations() 在 value_id 列迁移完成后创建，不在此处定义
-- （原因：旧数据库升级时 schema.sql 先于 ALTER TABLE 执行，此处创建索引会因列不存在而报错）
CREATE INDEX IF NOT EXISTS idx_call_edges_session  ON call_edges(session_id);
CREATE INDEX IF NOT EXISTS idx_call_edges_fn_name  ON call_edges(session_id, fn_name);
CREATE INDEX IF NOT EXISTS idx_call_edges_retval   ON call_edges(session_id, return_value);
CREATE INDEX IF NOT EXISTS idx_taint_session       ON taint_paths(session_id);
CREATE INDEX IF NOT EXISTS idx_var_lifetime_name   ON var_lifetime(session_id, name);
CREATE INDEX IF NOT EXISTS idx_bookmarks_session   ON bookmarks(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_tasks_status    ON run_tasks(status);
-- events 按 type + id：I4 事件分布统计 + 游标分页
CREATE INDEX IF NOT EXISTS idx_events_type_id      ON events(session_id, type, id);
-- iid_counts 按 count 降序：A3/I3/I4 取 Top-N 热点
CREATE INDEX IF NOT EXISTS idx_iid_counts_count    ON iid_counts(session_id, count DESC);
-- loops 按迭代次数降序：A5 取高频循环
CREATE INDEX IF NOT EXISTS idx_loops_iter_count    ON loops(session_id, iteration_count DESC);
-- value_patterns 按 matched_constant 过滤：I1 密码学检测
CREATE INDEX IF NOT EXISTS idx_vp_matched          ON value_patterns(session_id, matched_constant);
-- value_patterns 按 pattern_type 过滤：A8 v3 语义类型标签
CREATE INDEX IF NOT EXISTS idx_vp_pattern_type     ON value_patterns(session_id, pattern_type);
-- 调用栈查询：按 call_seq/return_seq 范围查找祖先帧（owner-fn + call-stack API）
CREATE INDEX IF NOT EXISTS idx_call_edges_stack    ON call_edges(session_id, call_seq, return_seq, depth);
-- own-events 子调用查询：depth 前置，消除 (session_id, depth=N, call_seq>=X, return_seq<=Y) 的全扫
-- 比 idx_call_edges_stack 更适合 depth 等值过滤场景（call_seq/return_seq 范围过滤作为 covering）
CREATE INDEX IF NOT EXISTS idx_call_edges_depth    ON call_edges(session_id, depth, call_seq, return_seq);

-- ─── 插件检查点（断点恢复支持）───────────────────────────────────────────────
-- 每个插件成功完成后写入一条记录；重新调度时跳过已有记录的插件
-- phase: 'phase1' / 'phase3' / 'phase4' / 'manual'

CREATE TABLE IF NOT EXISTS plugin_checkpoints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    plugin_id    TEXT NOT NULL,
    phase        TEXT,
    completed_at INTEGER NOT NULL,
    duration_ms  INTEGER,
    is_stale     INTEGER DEFAULT 0,  -- 1 = 上游数据已更新，本插件结果可能过期
    summary_json TEXT,               -- emitDone() 的统计摘要（JSON）
    UNIQUE (session_id, plugin_id)
);
-- loop_iterations 核心查询索引：(session_id, loop_id, iteration_idx) covering ORDER BY
CREATE INDEX IF NOT EXISTS idx_loop_iter_session   ON loop_iterations(session_id, loop_id, iteration_idx);
-- loop_iterations 按 start_seq 范围过滤（seqFrom/seqTo 参数）
CREATE INDEX IF NOT EXISTS idx_loop_iter_start_seq ON loop_iterations(session_id, start_seq);
CREATE INDEX IF NOT EXISTS idx_value_patterns_session ON value_patterns(session_id);
CREATE INDEX IF NOT EXISTS idx_crypto_hints_session ON crypto_hints(session_id);
CREATE INDEX IF NOT EXISTS idx_sig_paths_session   ON signature_paths(session_id);
