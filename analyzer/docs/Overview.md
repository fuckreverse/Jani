# Jani Trace Analyzer — 概览与路线图

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

## 3. 目录结构

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
│   ├── docs/                  # JTA 设计文档（本目录）
│   │   ├── Overview.md        # 概览、架构、路线图、关键设计决策（本文件）
│   │   ├── DataModel.md       # 数据模型（Schema + 索引 + DB 实现 + 性能优化）
│   │   ├── Plugins.md         # 插件架构与插件清单
│   │   ├── API.md             # REST API + WebSocket 完整参考
│   │   └── WebUI.md           # Web UI 设计 + MCP Server 设计
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
│       │   │       ├── EventsTab.vue       # 事件列表标签页（含值搜索、跨Tab跳转）
│       │   │       #   普通模式：游标分页（cursorStack，O(log N) B-tree 定位，深页恒速）
│       │   │       #   值搜索模式：offset 分页（结果集有限，随机翻页需求高）
│       │   │       #   跨Tab跳转：seqFrom 精确定位（无需估算页码）
│       │   │       ├── FileInfoBar.vue     # 文件信息栏
│       │   │       ├── FunctionsTab.vue    # 函数列表标签页（事件数过滤、内建函数隐藏、调用定位、被谁调用子面板、内嵌火焰图）
│       │   │       ├── CallDetail.vue      # 函数调用详情面板（调用栈 / 事件流，由 FunctionsTab 使用）
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
    └── （插桩器核心文档，见 docs/README.md）
```

---

## 4. 开发路线图

### Phase 1：基础骨架（MVP）✅ 已完成
- [x] `analyzer/server.mjs`：Express + 文件上传（1 GB 限制，默认端口 33000）
- [x] `db/schema.sql` + `Database.mjs`（sql.js 实现，见 DataModel.md §3.3；含 `plugin_checkpoints` 表）
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
- [x] **新增 API**：函数列表、函数调用详情、自身事件流、调用栈快照、事件所属函数、值搜索、值搜索+事件详情合并
- [x] **A6 FunctionSignatureInfer 移除**：功能冗余，依赖该插件的 `I2`/`I4` 已更新依赖关系
- [x] **EventSerializer 增强**：屏蔽对象 `toJSON` 方法防止插桩代码递归调用；`fields` 序列化切换到 `base_oid`
- [x] **`value_dict` 表**：值字典去重表，由 F1 EventIndex v2 填充；内存 `Map<val_text, id>` + 局部计数器，零额外 DB 查询

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

## 5. 关键设计决策

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

## 6. 文档索引

| 文件 | 内容 |
|------|------|
| [Overview.md](./Overview.md) | 本文件：概览、架构、目录结构、路线图、关键设计决策 |
| [DataModel.md](./DataModel.md) | 数据模型（Schema + 索引）、Database.mjs 实现、性能优化设计 |
| [Plugins.md](./Plugins.md) | 插件架构（接口 / 调度器）、全部插件清单（F/A/I 三层） |
| [API.md](./API.md) | REST API 完整参考、WebSocket 协议 |
| [WebUI.md](./WebUI.md) | Web UI 页面设计、交互说明、MCP Server 设计与 Tool 列表 |
