# Jani Trace Analyzer (JTA)

本地 Web 分析平台，用于分析 Jani 动态插桩生成的 `.bin` trace 文件。

## 技术栈

- **后端**：Node.js + Express + sql.js（SQLite WASM）+ ws
- **前端**：Vue 3 + Vite + vue-router
- **数据库**：SQLite（`data/jta.db`，通过 sql.js WASM 实现，零编译依赖）
- **工作空间管理**：`projects` 表 + `/api/projects` 路由

## 快速启动

### 1. 安装后端依赖

```bash
cd analyzer
npm install
```

### 2. 安装前端依赖并构建

```bash
cd analyzer/ui
npm install
npm run build
```

### 3. 启动服务

```bash
cd analyzer
node server.mjs
```

服务启动后访问 [http://localhost:33000](http://localhost:33000)

### 启动选项

```bash
node server.mjs --port 8080                  # 自定义端口（默认 33000）
node server.mjs --db /tmp/jta.db             # 自定义数据库路径
node server.mjs --traces-dir /tmp/traces     # 自定义 trace 目录
node server.mjs --clear-traces               # 启动时清空 traces 目录中的旧文件
```

> `--no-clear-traces` 已废弃（向后兼容保留，无实际效果）。默认行为是保留旧文件。

## 开发模式

前端热更新（需要先启动后端服务）：

```bash
# 终端 1：启动后端
cd analyzer
node server.mjs

# 终端 2：启动前端开发服务器
cd analyzer/ui
npm run dev     # http://localhost:5173
```

## API 概览

### 工作空间（Projects）

| 方法   | 路径                                      | 说明                                  |
|--------|-------------------------------------------|---------------------------------------|
| POST   | `/api/projects`                           | 上传原始 JS，创建工作空间，异步触发插桩 |
| GET    | `/api/projects`                           | 列出所有工作空间                      |
| GET    | `/api/projects/:id`                       | 工作空间详情 + 关联会话列表           |
| DELETE | `/api/projects/:id`                       | 删除工作空间                          |
| POST   | `/api/projects/:id/fork`                  | 复用源文件重新插桩，创建新工作空间    |
| GET    | `/api/projects/:id/instrumented`          | 下载插桩后代码                        |
| GET    | `/api/projects/:id/smap`                  | 下载 smap.json                        |
| POST   | `/api/projects/:id/sessions`              | 上传 trace.bin，基于已有 smap 创建会话 |

### 分析会话（Sessions）

| 方法   | 路径                                      | 说明                          |
|--------|-------------------------------------------|-------------------------------|
| POST   | `/api/sessions`                           | 上传 `.bin` 创建新会话（独立，不关联工作空间）|
| GET    | `/api/sessions`                           | 列出所有会话                  |
| GET    | `/api/sessions/:id`                       | 获取会话详情 + 插件状态       |
| DELETE | `/api/sessions/:id`                       | 删除会话及所有关联数据        |
| GET    | `/api/sessions/:id/events`                | 查询事件（支持分页 + 过滤）   |
| GET    | `/api/sessions/:id/checkpoints`           | 查询插件断点恢复状态          |
| POST   | `/api/sessions/:id/re-run`                | 重新运行分析插件              |

### 插桩工作台（Instrument）

| 方法   | 路径                                      | 说明                          |
|--------|-------------------------------------------|-------------------------------|
| POST   | `/api/instrument`                         | 插桩源码，返回插桩后代码      |
| POST   | `/api/instrument/run`                     | 在服务端运行代码              |
| GET    | `/api/instrument/run/:runId`              | 查询运行任务状态              |

### Trace 收集

| 方法   | 路径                                      | 说明                          |
|--------|-------------------------------------------|-------------------------------|
| GET    | `/api/trace/stats`                        | WebSocket Trace 收集统计      |
| GET    | `/api/trace/files`                        | 列出 traces 目录中的 .bin 文件 |
| PUT    | `/api/trace/files/:name`                  | 设置 trace 文件别名           |
| DELETE | `/api/trace/files/:name`                  | 删除 trace 文件               |
| POST   | `/api/trace/files/batch-delete`           | 批量删除 trace 文件           |
| GET    | `/api/trace/files/:name/download`         | 下载 trace 文件               |
| POST   | `/api/trace/import`                       | 导入 trace 文件为新会话       |

### WebSocket

| 路径                                           | 说明                          |
|------------------------------------------------|-------------------------------|
| `ws://localhost:33000/ws/projects/:id/progress` | 订阅工作空间插桩进度         |
| `ws://localhost:33000/ws/sessions/:id/progress` | 订阅插件执行进度             |
| `ws://localhost:33000/ws/instrument/run/:runId` | 订阅运行实时输出             |
| `ws://localhost:33000/ws/trace`                | Trace 收集（可选 ?projectId=xxx 关联工作空间）|

### 使用示例

```bash
# 创建工作空间（上传原始 JS）
curl -X POST http://localhost:33000/api/projects \
  -F "source=@target.js" \
  -F "name=my-project" \
  -F 'options={"target":"browser"}'

# 上传 trace 到工作空间
curl -X POST http://localhost:33000/api/projects/<projectId>/sessions \
  -F "bin=@trace.bin" \
  -F "name=my-session"

# 直接上传 Session（不关联工作空间）
curl -X POST http://localhost:33000/api/sessions \
  -F "bin=@trace.bin" \
  -F "smap=@trace.smap.json" \
  -F "name=my-trace"

# 查询事件
curl "http://localhost:33000/api/sessions/<id>/events?type=END_EXPR&limit=100"
curl "http://localhost:33000/api/sessions/<id>/events?line=42"
curl "http://localhost:33000/api/sessions/<id>/events?varName=key"
```

## 目录结构

```
analyzer/
├── data/                    # 数据目录（运行时生成）
│   ├── jta.db               # SQLite 数据库（sql.js WASM）
│   ├── projects/            # 工作空间目录（每个 uuid 一个子目录）
│   ├── sessions/            # 会话目录（每个 uuid 一个子目录）
│   └── uploads/             # multer 临时上传目录
├── db/
│   ├── schema.sql           # 完整 SQLite 建表 SQL（含 projects / plugin_checkpoints 等全部表）
│   └── Database.mjs         # SQLite 封装（sql.js WASM，内存 db + flush 写盘）
├── plugins/                 # 分析插件（共 17 个）
│   ├── BasePlugin.mjs       # 插件基类
│   ├── F1_EventIndex.mjs    # Foundation：解析 .bin → events/writes/reads/fields 表
│   ├── F2_SmapLoader.mjs    # Foundation：解析 .smap.json → smap 表
│   ├── F3_CallGraphBuilder.mjs  # Foundation：重建调用图 → call_edges 表
│   ├── F4_VariableLifetime.mjs  # Foundation：变量生命周期 → var_lifetime 表
│   ├── A1_TaintTracker.mjs  # Analysis：污点追踪 → taint_paths 表
│   ├── A2_DataFlowGraph.mjs # Analysis：数据流图
│   ├── A3_HotPathAnalyzer.mjs   # Analysis：热路径 + 循环检测
│   ├── A4_StringTracker.mjs # Analysis：字符串追踪
│   ├── A5_LoopDetector.mjs  # Analysis：循环迭代展开
│   ├── A6_FunctionSignatureInfer.mjs  # Analysis：函数签名推断
│   ├── A7_ObjectMutationTracker.mjs   # Analysis：对象变异追踪
│   ├── A8_ValuePatternDetector.mjs    # Analysis：值模式检测（密码学常数）
│   ├── I1_CryptoDetector.mjs  # Inference：加密算法检测
│   ├── I2_SignatureAnalyzer.mjs       # Inference：签名路径还原
│   ├── I3_ObfuscationDetector.mjs     # Inference：混淆检测
│   └── I4_AlgorithmSummarizer.mjs     # Inference：算法综合摘要
├── routes/
│   ├── sessions.mjs         # 会话 REST API（含断点恢复、re-run、delete、checkpoints）
│   ├── instrument.mjs       # 插桩工作台 REST API
│   └── projects.mjs         # 工作空间 REST API（上传/插桩/fork/下载/关联会话）
├── traces/                  # trace 文件目录（WebSocket 收集输出）
│   ├── _aliases.json        # trace 文件别名映射
│   └── _project_map.json    # trace 文件 → projectId 映射
├── ui/                      # 前端（Vue 3 + Vite，已构建到 ui/dist/）
│   ├── src/
│   │   ├── App.vue          # 顶部导航（工作空间 / 会话 / 插桩工作台 / Trace 监控）
│   │   ├── main.js          # 路由注册
│   │   ├── components/session/  # 会话详情各标签页组件
│   │   └── views/
│   │       ├── WorkspaceList.vue     # 工作空间列表（/workspaces）
│   │       ├── WorkspaceDetail.vue   # 工作空间详情（/workspaces/:id）
│   │       ├── SessionList.vue       # 会话列表（/sessions）
│   │       ├── SessionDetail.vue     # 会话详情（/sessions/:id）
│   │       ├── InstrumentStudio.vue  # 插桩工作台（/instrument）
│   │       ├── InstrumentOptions.vue # 插桩选项面板（嵌入式组件）
│   │       ├── ProgressDrawer.vue    # 分析进度侧边抽屉
│   │       └── TraceMonitor.vue      # Trace 收集监控（/trace）
│   └── vite.config.js       # Vite 代理 → 33000
├── InstrumentRunner.mjs     # 服务端沙箱运行（WS 推流输出，30s 超时，3 并发）
├── PluginEngine.mjs         # 插件调度器（拓扑排序 + 并发执行 + 断点恢复 + 分阶段调度）
├── logger.mjs               # 日志封装
├── package.json
├── README.md
└── server.mjs               # Express + WebSocket 服务入口（默认端口 33000）
```

## 分析插件清单

### 第一层：Foundation（基础数据）

| 插件 ID            | 文件                         | 输出表               | 说明                               |
|--------------------|------------------------------|----------------------|------------------------------------|
| F1-EventIndex      | `F1_EventIndex.mjs`          | events/writes/reads/fields | 解析 .bin 事件流         |
| F2-SmapLoader      | `F2_SmapLoader.mjs`          | smap                 | 解析 .smap.json，iid→行列映射      |
| F3-CallGraphBuilder| `F3_CallGraphBuilder.mjs`    | call_edges           | 重建调用图，计算调用深度           |
| F4-VariableLifetime| `F4_VariableLifetime.mjs`    | var_lifetime         | 变量首写/末读/读写次数统计         |

### 第二层：Analysis（分析）

| 插件 ID                  | 文件                              | 输出表                | 说明                               |
|--------------------------|-----------------------------------|-----------------------|------------------------------------|
| A1-TaintTracker ⭐       | `A1_TaintTracker.mjs`             | taint_paths           | 污点追踪（正向/反向，含属性/返回值）|
| A2-DataFlowGraph         | `A2_DataFlowGraph.mjs`            | —（JSON）             | 过程内+过程间数据流图              |
| A3-HotPathAnalyzer       | `A3_HotPathAnalyzer.mjs`          | hot_iids/loops        | 热路径热力图 + 循环检测            |
| A4-StringTracker         | `A4_StringTracker.mjs`            | string_events         | 字符串追踪 + 编码操作标记          |
| A5-LoopDetector          | `A5_LoopDetector.mjs`             | loop_iterations       | 循环迭代展开，迭代变量快照         |
| A6-FunctionSignatureInfer| `A6_FunctionSignatureInfer.mjs`   | fn_signatures         | 函数签名推断（纯函数/参数类型）    |
| A7-ObjectMutationTracker | `A7_ObjectMutationTracker.mjs`    | object_timelines      | 对象属性变化时间线                 |
| A8-ValuePatternDetector  | `A8_ValuePatternDetector.mjs`     | value_patterns        | 魔术常数检测（AES/MD5/SHA 等 35+） |

### 第三层：Inference（推理）

| 插件 ID               | 文件                           | 输出表             | 说明                               |
|-----------------------|--------------------------------|--------------------|------------------------------------|
| I1-CryptoDetector ⭐  | `I1_CryptoDetector.mjs`        | crypto_hints       | 加密算法检测（AES/RC4/Base64 等）  |
| I2-SignatureAnalyzer ⭐| `I2_SignatureAnalyzer.mjs`     | signature_paths    | 签名路径还原（反向 BFS）           |
| I3-ObfuscationDetector| `I3_ObfuscationDetector.mjs`   | obfuscation_hints  | 混淆检测（控制流平坦化/字符串解密）|
| I4-AlgorithmSummarizer| `I4_AlgorithmSummarizer.mjs`   | analysis_summary   | 综合算法摘要（Markdown 报告）      |
