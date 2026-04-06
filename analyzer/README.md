# Jani Trace Analyzer (JTA)

本地 Web 分析平台，用于分析 Jani 动态插桩生成的 `.bin` trace 文件。

## 技术栈

- **后端**：Node.js + Express + better-sqlite3 + ws
- **前端**：Vue 3 + Vite + vue-router
- **数据库**：SQLite（`data/jta.db`）

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

服务启动后访问 [http://localhost:3000](http://localhost:3000)

### 选项

```bash
node server.mjs --port 8080        # 自定义端口
node server.mjs --db /tmp/jta.db   # 自定义数据库路径
```

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

| 方法   | 路径                                | 说明                          |
|--------|-------------------------------------|-------------------------------|
| POST   | `/api/sessions`                     | 上传 `.bin` 创建新会话        |
| GET    | `/api/sessions`                     | 列出所有会话                  |
| GET    | `/api/sessions/:id`                 | 获取会话详情                  |
| GET    | `/api/sessions/:id/events`          | 查询事件（支持分页 + 过滤）   |
| POST   | `/api/instrument`                   | 插桩源码，返回插桩后代码      |
| POST   | `/api/instrument/run`               | 在服务端运行代码              |
| GET    | `/api/instrument/run/:runId`        | 查询运行任务状态              |

### WebSocket

| 路径                                      | 说明                  |
|-------------------------------------------|-----------------------|
| `ws://localhost:3000/ws/sessions/:id/progress` | 订阅插件执行进度  |
| `ws://localhost:3000/ws/instrument/run/:runId` | 订阅运行实时输出  |

### 上传 Session

```bash
curl -X POST http://localhost:3000/api/sessions \
  -F "bin=@trace.bin" \
  -F "smap=@trace.smap.json" \
  -F "name=my-trace"
```

### 查询事件

```bash
# 查询 END_EXPR 类型事件（第 1 页，每页 100 条）
curl "http://localhost:3000/api/sessions/<id>/events?type=END_EXPR&limit=100&offset=0"

# 过滤行号
curl "http://localhost:3000/api/sessions/<id>/events?line=42"

# 过滤变量名
curl "http://localhost:3000/api/sessions/<id>/events?varName=x"
```

## 目录结构

```
analyzer/
├── data/                    # 数据目录（运行时生成）
│   ├── jta.db               # SQLite 数据库
│   ├── sessions/            # 会话文件（.bin / .smap.json / .js）
│   └── uploads/             # multer 临时上传目录
├── db/
│   ├── schema.sql           # 完整 SQLite 建表 SQL
│   └── Database.mjs         # SQLite 封装（better-sqlite3）
├── plugins/
│   ├── BasePlugin.mjs       # 插件基类
│   ├── F1_EventIndex.mjs    # 解析 .bin → events 表
│   └── F2_SmapLoader.mjs    # 解析 .smap.json → smap 表
├── routes/
│   ├── sessions.mjs         # 会话 REST API
│   └── instrument.mjs       # 插桩工作台 REST API
├── ui/                      # 前端（Vue 3 + Vite）
│   ├── src/
│   │   ├── App.vue          # 路由入口 + 顶部导航
│   │   ├── main.js          # Vue 应用入口
│   │   └── views/
│   │       ├── SessionList.vue       # 会话列表页
│   │       ├── SessionDetail.vue     # 会话详情页（事件列表）
│   │       └── InstrumentStudio.vue  # 插桩工作台
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── InstrumentRunner.mjs     # 服务端运行插桩代码
├── PluginEngine.mjs         # 插件调度器（拓扑排序 + 并发执行）
├── package.json
├── README.md
└── server.mjs               # Express + WebSocket 服务入口
```

## Phase 1 已实现的插件

| 插件 ID       | 文件                    | 说明                             |
|---------------|-------------------------|----------------------------------|
| F1-EventIndex | `plugins/F1_EventIndex` | 解析 JTB1 .bin → events/writes/reads/fields |
| F2-SmapLoader | `plugins/F2_SmapLoader` | 解析 .smap.json → smap 表        |
