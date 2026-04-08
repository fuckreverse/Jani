-- Jani Trace Analyzer — 数据库 Schema
-- 版本：v1.0
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

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    iid         INTEGER,
    line        INTEGER,
    col         INTEGER,
    src_text    TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- ─── 变量写入 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS writes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value       TEXT,
    omitted     INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- ─── 变量读取 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    name        TEXT,
    value       TEXT,
    omitted     INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- ─── 属性读写 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fields (
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
    depth           INTEGER
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

-- ─── 热路径（A3 HotPathAnalyzer 填充）───────────────────────────────────────

CREATE TABLE IF NOT EXISTS hot_iids (
    session_id  TEXT NOT NULL,
    iid         INTEGER NOT NULL,
    count       INTEGER DEFAULT 0,
    line        INTEGER,
    col         INTEGER,
    src_text    TEXT,
    PRIMARY KEY (session_id, iid)
);

-- ─── 循环（A3/A5 填充）──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loops (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    iid             INTEGER,
    start_seq       INTEGER,
    end_seq         INTEGER,
    iteration_count INTEGER,
    line            INTEGER
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
    base_var        TEXT,
    offset_key      TEXT,
    change_seq      INTEGER,
    old_value       TEXT,
    new_value       TEXT,
    line            INTEGER,
    is_write        INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_obj_timeline_session ON object_timelines(session_id, base_var);

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
    matched_constant TEXT
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
    hint_type       TEXT,   -- 'short_var' / 'string_decoder' / 'flat_control_flow' / 'high_entropy_name'
    description     TEXT,
    iid             INTEGER,
    line            INTEGER,
    confidence      REAL
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
CREATE INDEX IF NOT EXISTS idx_df_session ON dataflow_edges(session_id);

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
CREATE INDEX IF NOT EXISTS idx_writes_name         ON writes(session_id, name);
CREATE INDEX IF NOT EXISTS idx_reads_name          ON reads(session_id, name);
CREATE INDEX IF NOT EXISTS idx_fields_offset       ON fields(session_id, offset);
CREATE INDEX IF NOT EXISTS idx_call_edges_session  ON call_edges(session_id);
CREATE INDEX IF NOT EXISTS idx_taint_session       ON taint_paths(session_id);
CREATE INDEX IF NOT EXISTS idx_var_lifetime_name   ON var_lifetime(session_id, name);
CREATE INDEX IF NOT EXISTS idx_bookmarks_session   ON bookmarks(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_tasks_status    ON run_tasks(status);
CREATE INDEX IF NOT EXISTS idx_smap_session        ON smap(session_id);

-- ─── 插件检查点（断点恢复支持）───────────────────────────────────────────────
-- 每个插件成功完成后写入一条记录；重新调度时跳过已有记录的插件
-- phase: 'phase1' / 'phase3' / 'phase4' / 'manual'

CREATE TABLE IF NOT EXISTS plugin_checkpoints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    plugin_id   TEXT NOT NULL,
    phase       TEXT,
    completed_at INTEGER NOT NULL,
    duration_ms  INTEGER,
    UNIQUE (session_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq  ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_loop_iter_session   ON loop_iterations(session_id, loop_id);
CREATE INDEX IF NOT EXISTS idx_value_patterns_session ON value_patterns(session_id);
CREATE INDEX IF NOT EXISTS idx_crypto_hints_session ON crypto_hints(session_id);
CREATE INDEX IF NOT EXISTS idx_sig_paths_session   ON signature_paths(session_id);
