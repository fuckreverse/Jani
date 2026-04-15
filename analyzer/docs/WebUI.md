# JTA Web UI 设计与 MCP Server

**版本：** v1.7  

本文档涵盖两部分内容：
1. **Web UI 设计**：页面导航、布局、交互说明
2. **MCP Server 设计**：架构、协议、Tool 列表

---

## 1. Web UI 设计

### 1.1 页面导航结构

JTA 包含以下独立页面：

| 页面 | 路由 | 说明 |
|---|---|---|
| **工作空间列表** | `/workspaces` | 管理工作空间（Projects），上传 JS + 自动插桩；`WorkspaceList.vue` |
| **工作空间详情** | `/workspaces/:id` | 工作空间详情 + 插桩状态 + 关联会话列表；`WorkspaceDetail.vue` |
| 会话列表 | `/sessions` | 所有分析会话，含状态概览；含进度抽屉（`ProgressDrawer`）|
| 会话详情 | `/sessions/:id` | 代码视图 + 事件列表 + 分析面板；含内联进度条 |
| **插桩工作台** | `/instrument` | 独立插桩页面，见 1.4 节 |
| **Trace 监控** | `/trace` | WebSocket Trace 收集状态监控，见 1.5 节 |
| **空间分析** | `/storage` | 扫描 data 目录、统计各类文件占用、提供一键清理建议；`StorageAnalyzer.vue` |
| **Trace 对比** | `/diff` | 多会话执行行为差异对比页面；`TraceDiff.vue` |

---

### 1.2 会话详情页布局

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

### 1.3 核心交互

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

### 1.4 插桩工作台（Instrumenter Studio）

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

### 1.5 Trace 监控页面（TraceMonitor）

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

### 1.6 配置 Composable（`useConfig.js`）

前端通过统一的 `useConfig()` composable 从后端获取运行时配置，避免在多个组件中重复请求 `/api/config`。

#### 使用方式

```js
import { useConfig } from '@/composables/useConfig.js';

// 在 <script setup> 中调用
const { api: apiCfg, ui: uiCfg } = useConfig();

// 以响应式方式读取配置
const pageSize = ref(apiCfg.value?.defaultPageSize ?? 100);
const refreshMs = uiCfg.value?.sessionListRefreshMs ?? 5000;
```

#### 设计特性

| 特性 | 说明 |
|------|------|
| **单例懒加载** | 首次调用时触发 `GET /api/config`，后续调用直接复用同一 Promise 和 reactive ref |
| **响应式** | `api` 和 `ui` 均为 Vue `ref`，配置加载后自动触发依赖该值的计算属性/侦听器更新 |
| **默认值回退** | 加载前（`null`）或加载失败时，组件使用 `?? 默认值` 表达式提供兜底值，不会出现 `undefined` 报错 |
| **覆盖配置** | 后端 `config.json` 或环境变量修改后，重启服务即生效；前端下次刷新页面时读到新值 |

#### 哪些 UI 组件使用了 `useConfig`

| 组件 | 配置项 |
|------|--------|
| `SessionList.vue` | `ui.sessionListRefreshMs`（会话列表自动刷新间隔） |
| `SessionDetail.vue` | `ui.wsReconnectMs`（WS 重连间隔）、`ui.sessionDetailRefreshMs`（进度轮询间隔） |
| `TraceMonitor.vue` | `ui.traceMonitorPollMs`（轮询间隔）、`ui.traceMonitorHistoryMax`（历史最大条数）、`ui.traceMonitorPageSize`（文件列表页大小） |
| `WebApiTab.vue` | `api.webApiDefaultLimit`（分页大小） |
| `PatternsTab.vue` | `api.valuePatternsLimit`（分页大小） |
| `ObjMutTab.vue` | `api.objectTimelinesMaxPageSize`（分页大小） |
| `CfgTab.vue` | `api.loopIterationsMaxLimit`（循环迭代抽屉分页大小） |
| `LoopsTab.vue` | `api.loopStatsLimit`（循环列表大小）、`api.loopIterationsMaxLimit`（迭代记录大小） |
| `CallDetail.vue` | `api.defaultPageSize`（事件分页大小） |

---

## 2. MCP Server 设计

### 2.1 目标

将 JTA 的全部分析能力通过 **MCP（Model Context Protocol）** 暴露给 LLM，使大语言模型可以自主驱动插桩、运行、分析的完整逆向流程，无需人工操作 UI。

### 2.2 整体架构

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

### 2.3 传输协议

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

### 2.4 MCP Tools 完整列表

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

### 2.5 LLM 自动化逆向分析示例流程

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

### 2.6 依赖

```json
{
  "@modelcontextprotocol/sdk": "^1.x"
}
```

MCP SDK 同时支持 stdio 和 SSE 传输，两个入口文件共享同一套 Tool 定义，只在传输层不同。
