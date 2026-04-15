# DOC-10 · Jani CLI 工具参考手册

Jani 提供两类命令行工具：**前端工具**（插桩与预处理）和**后处理工具**（离线 trace 分析）。

| 工具 | 入口文件 | 用途 |
|------|----------|------|
| `jalangi` | `bin/jalangi.mjs` | 插桩 / 运行 / 插桩并运行 |
| `preprocess` | `bin/preprocess.mjs` | 反混淆 / 语法降级（插桩前的预处理） |
| `trace-server` | ~~`tools/trace-server/server.mjs`~~ → **已集成进 JTA Server** | 浏览器端 WebSocket Trace 收集（路由 `/ws/trace`，端口 33000）|
| `trace-decode` | `tools/trace-decode.mjs` | 将 JTB1 二进制 `.bin` 文件解码为 NDJSON |
| `trace-parse` | `tools/trace-parse.mjs` | 兼容层：解析旧文本 trace 或 `.bin`，统一输出 NDJSON |
| `trace-render` | `tools/trace-render.mjs` | 将 NDJSON 渲染为 flat / tree / block / pipe 格式 |
| `trace-filter` | `tools/trace-filter.mjs` | 按类型、seq、行号、函数名、变量等条件过滤 |
| `trace-hot-lines` | `tools/trace-hot-lines.mjs` | 统计代码行执行热点（Top-N 排行）|
| `trace-call-tree` | `tools/trace-call-tree.mjs` | 重建函数调用树，支持深度限制与汇总统计 |
| `trace-var-timeline` | `tools/trace-var-timeline.mjs` | 追踪变量值的时序变化 |
| `trace-range-extract` | `tools/trace-range-extract.mjs` | 按 seq 区间快速提取片段（含 context 窗口）|

---

## 一、`jalangi` — 插桩与运行

```bash
node bin/jalangi.mjs <子命令> [通用选项] [子命令选项] <文件> [脚本参数...]
```

### 子命令

| 子命令 | 说明 |
|--------|------|
| `instrument` | 只插桩，生成插桩文件 + IID map，**不运行** |
| `run` | 只运行**已插桩**的文件，不再次插桩 |
| `instrument-and-run` | 插桩 + 立即运行（一步完成，仅支持 Node.js） |

---

### 通用选项（所有子命令均支持）

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--target <t>` | `node` | 目标环境：`node` 或 `browser` |
| `--source-type <t>` | `script` | JS 源码类型：`script` 或 `module` |
| `--sandbox-var <v>` | `J$` | 运行时沙盒全局变量名 |
| `--random-var` | — | 随机生成沙盒变量名（如 `__jal_a3f2`），防止与页面变量冲突 |
| `--debug` | — | 开启详细日志（等价于 `JALANGI_DEBUG=1`） |
| `--help / -h` | — | 显示帮助 |

---

### 子命令：`instrument`

对目标文件进行 AST 插桩，**输出插桩文件和 IID 位置 map，不执行代码**。

```bash
node bin/jalangi.mjs instrument [选项] <输入文件>
```

#### 通用输出选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--output <file>` | Node: `<input>_jalangi_.js`<br>Browser: in-place 覆盖 | 指定输出文件路径 |
| `--inline-iid` | — | 将 IID→源码位置 map 内联到插桩文件头部，无需外部 `.map.json` |
| `--inline-source` | — | 将原始源码内联到 source map（方便调试时直接看原始代码） |
| `--no-source-map` | — | 不生成 `.map.json` 文件 |
| `--vlcq-source-map` | — | 额外生成标准 Source Map v3（`<output>.js.map`），可在 DevTools 中使用 |
| `--split-runtime` | — | 运行时与插桩代码**分离输出**<br>Node: 额外生成 `.runtime.mjs`<br>Browser: 额外生成 `.runtime.js` |
| `--dry-run` | — | 只打印插桩结果预览，不写文件 |

#### 浏览器专属选项（`--target browser`）

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--db-name <n>` | `jalangi-traces` | IndexedDB 数据库名 |
| `--store-name <n>` | `execution-trace` | IndexedDB ObjectStore 名 |
| `--no-idb` | — | 禁用 IndexedDB，只通过 console 输出 trace |
| `--ws-url <url>` | — | WebSocket 服务地址（如 `ws://127.0.0.1:33000/ws/trace`），配合 JTA Server 的 `/ws/trace` 端点使用；不传则禁用 WS |
| `--ws-sab` | — | 启用 SharedArrayBuffer 环形缓冲区（零拷贝模式，需服务器设置 COOP/COEP Header；不支持时自动降级为 postMessage） |
| `--minify` | — | 压缩运行时 bundle（调用 rollup + terser）|
| `--deferred-load` | — | 延迟加载模式（需配合 `--split-runtime`）：等待 IDB/WebSocket 后端 ready 后再加载插桩代码，消除启动时内存积压 |
| `--sync-flush-threshold <N>` | `0`（禁用） | 每累计 N 条 trace 事件同步调用 `ws.send()`（调试/验证用，0 = 禁用） |

---

### 子命令：`run`

**直接运行已经插桩好的文件**，不再执行任何插桩操作。

```bash
node bin/jalangi.mjs run [选项] <已插桩文件> [脚本参数...]
```

| 选项 | 说明 |
|------|------|
| `--analysis <file>` | 加载分析插件（可重复多次加载多个插件） |
| `--init-param <k:v>` | 传给分析插件的初始化参数（格式 `key:value`，可重复） |
| `--runtime <file>` | 指定运行时 ESM 模块路径（`--split-runtime` 模式生成的 `.runtime.mjs`）；未指定时自动探测 `<script 同名>.runtime.mjs` |

---

### 子命令：`instrument-and-run`

插桩 + 立即在 Node.js 中运行（**仅支持 Node.js 目标**）。通过 `Module._extensions` 钩子，对所有 `require()` 的 `.js` 文件也自动插桩。

```bash
node bin/jalangi.mjs instrument-and-run [选项] <原始文件> [脚本参数...]
```

| 选项 | 说明 |
|------|------|
| `--analysis <file>` | 加载分析插件（可重复） |
| `--init-param <k:v>` | 传给分析插件的初始化参数（可重复） |
| `--inline-iid` | IID map 内联到插桩文件 |
| `--inline-source` | 原始源码内联到 source map |
| `--no-write` | 不写插桩后的 `.js` 文件到磁盘（仅在内存中插桩并运行） |

---

## 二、`preprocess` — 预处理（反混淆 / 语法降级）

在插桩前对 JS 代码进行 AST 级处理。可以：
- **反混淆**：还原压缩代码结构，提升插桩后 trace 的可读性
- **语法降级**：将 ES2022+ 降级到目标环境，扩大插桩器适用范围

```bash
node bin/preprocess.mjs [选项] <输入文件>
```

支持用 `-` 代替文件名从 **stdin** 读取（管道模式）。

### 预设（`--preset`）

| 预设 | 说明 |
|------|------|
| `deobfuscate` | 只反混淆（**默认**） |
| `transpile` | 只语法降级 |
| `full` | 反混淆 + 语法降级 |

---

### 反混淆选项（`--preset deobfuscate` 或 `full` 时有效）

默认全部开启，加 `--no-` 前缀关闭。

| 选项 | 默认 | 说明 |
|------|------|------|
| `--split-sequence` / `--no-split-sequence` | ✅ 开启 | 拆分逗号表达式为多条语句（如 `a=1,b=2` → 两行）|
| `--replace-void` / `--no-replace-void` | ✅ 开启 | `void 0` → `undefined` |
| `--fold-constants` / `--no-fold-constants` | ✅ 开启 | 编译期常量折叠（如 `1 + 2` → `3`）|
| `--simplify-boolean` / `--no-simplify-boolean` | ✅ 开启 | `!!x` → `Boolean(x)` |
| `--inline-dead-code` / `--no-inline-dead-code` | ✅ 开启 | 删除永假/永真死代码 |
| `--expand-conditional` | ❌ 关闭 | 条件表达式 `a ? b : c` 展开为 `if-else` |
| `--flatten-iife` | ❌ 关闭 | 展开无参 IIFE（**注意**：会改变作用域，慎用）|

---

### 语法降级选项（`--preset transpile` 或 `full` 时有效）

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--targets <t>` | `"defaults"` | Browserslist 目标，支持字符串（`"defaults"`）或 JSON（`'{"node":"12"}'`）|
| `--loose` | — | 宽松模式，生成更简洁的降级代码 |
| `--to-commonjs` | — | 将 ESM `import/export` 转为 CommonJS `require/exports` |
| `--no-modules` | — | 保留 ESM `import/export`（默认行为；仅在需要显式关闭 `--to-commonjs` 时有用）|
| `--transpile-debug` | — | 打印 `@babel/preset-env` 选择的变换列表（调试用）|

---

### 输出选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--output <file>` | `<input>_preprocessed.js` | 输出文件路径 |
| `--stdout` | — | 输出到 stdout（不写文件，适合管道组合）|
| `--source-type <t>` | `script` | `script` 或 `module` |
| `--no-comments` | — | 去除所有注释 |
| `--dry-run` | — | 只打印统计和预览，不写文件 |
| `--stats` | — | 打印详细的变换统计信息 |

---

## 三、`trace-server` — 浏览器 Trace 收集服务器

> ⚠️ **已集成**：独立的 `tools/trace-server/server.mjs` 已停止维护，其功能完整迁移到 **JTA Server**（`analyzer/server.mjs`）中。
> 新的 Trace 收集端点为 `ws://localhost:33000/ws/trace`，随 JTA Server 启动自动可用，无需单独启动进程。

### 新的使用方式

```bash
# 启动 JTA Server（同时提供 trace 收集 + 分析 UI）
node analyzer/server.mjs [--port 33000] [--traces-dir ./traces] [--no-clear-traces]
```

### JTA Server 启动参数（与 Trace 收集相关）

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--port <number>` | `33000` | HTTP/WS 监听端口 |
| `--traces-dir <dir>` | `./traces`（相对 cwd）| Trace 文件输出目录 |
| `--no-clear-traces` | — | 启动时不清空 traces 目录（默认清空 `.bin` 和 `.smap.json`）|

### 输出文件命名

每个 WebSocket 连接生成一个独立 `.bin` 文件（JTB1 二进制格式）：

```
traces/trace_<YYYYMMDD>_<HHmmss>_<ms>_<NNN>.bin
```

### HTTP 端点（Trace 相关）

| 端点 | 说明 |
|------|------|
| `GET /api/trace/stats` | 收集统计：连接数、批次数、事件数、字节数、运行时间 |
| `GET /api/trace/files` | 列出 traces 目录中的 `.bin` 文件（按 mtime 倒序）|
| `POST /api/trace/import` | 将指定 `.bin` 文件导入为新分析会话 |
| `GET /api/health` | 服务健康检查 |

### WebSocket 端点

| 端点 | 说明 |
|------|------|
| `ws://localhost:33000/ws/trace` | Trace 收集（原 `ws://localhost:9229/trace`）|
| `ws://localhost:33000/ws/sessions/:id/progress` | 分析进度推送 |
| `ws://localhost:33000/ws/instrument/run/:ticket` | 服务端运行输出流 |

---

## 四、后处理工具链

后处理工具是一套遵循 **Unix 哲学**（一工具一事，管道组合）的纯 Node.js 工具，用于对 trace 数据进行离线分析。所有工具从 **stdin** 或文件读取，结果写到 **stdout**，统计摘要写到 **stderr**。

### 数据流

```
ExecutionTrace 插件 / WsBackend / NodeStreamBackend
    ↓ trace.bin（JTB1 二进制）+ trace.smap.json（IID 源码位置映射）
trace-decode.mjs  [--smap] [--resolve-values]
    ↓ 结构化 NDJSON（每行一个 JSON 对象）
trace-filter.mjs  ─→  trace-render.mjs       ← flat/tree/block/pipe
                  ─→  trace-hot-lines.mjs
                  ─→  trace-call-tree.mjs
                  ─→  trace-var-timeline.mjs
                  ─→  trace-range-extract.mjs
```

---

### `trace-decode` — 二进制解码（核心入口）

将 JTB1 二进制 `.bin` 文件解码为结构化 NDJSON，是后处理链的起点。

```bash
node tools/trace-decode.mjs [选项] [trace.bin]
```

支持从 stdin 读取（省略文件名时从 stdin 读）。

| 选项 | 说明 |
|------|------|
| `--smap <path>` | 加载 `.smap.json`，将 `iid` 还原为 `line:col` 和 `srcText` |
| `--resolve-values` | 追溯 `OMITTED` 省略值（需同时指定 `--smap`） |
| `--stats` | 向 stderr 输出解码统计（事件总数、omitted 数量）|
| `--pretty` | 格式化 JSON 输出（带缩进，调试用；输出量大时不建议使用）|
| `--help / -h` | 显示帮助信息 |

**输出事件类型及字段**：

| 事件类型 | 主要字段 |
|---------|---------|
| `SCRIPT_ENTER` | `type, seq, iid, file, [line, col]` |
| `SCRIPT_EXIT` | `type, seq, iid, [exception]` |
| `CALL_PRE` | `type, seq, iid, fn, args, isConstructor, isMethod, [base, line, col]` |
| `CALL` | `type, seq, iid, fn, result, [line, col]` |
| `FUNCTION_ENTER` | `type, seq, iid, [fn], directFe` |
| `FUNCTION_EXIT` | `type, seq, iid, [exception]` |
| `END_EXPR` | `type, seq, iid, [srcText], [writes:[{name,value}]], [reads:[{name,value}]], [fields:[{base,offset,isWrite,value}]]` |
| `KEY_EVENT` | `type, seq, iid, level, text` |

```bash
# 基本解码
node tools/trace-decode.mjs trace.bin

# 注入 smap，还原源码位置（line/col/srcText）
node tools/trace-decode.mjs trace.bin --smap trace.smap.json

# 追溯省略值 + 统计输出
node tools/trace-decode.mjs trace.bin --smap trace.smap.json --resolve-values --stats

# 管道到 render
node tools/trace-decode.mjs trace.bin --smap trace.smap.json | node tools/trace-render.mjs --format tree
```

---

### `trace-parse` — 格式解析（兼容层）

兼容两种输入格式，自动检测：JTB1 二进制文件（委托 `trace-decode` 逻辑）和旧文本格式 trace。对于 `.bin` 文件建议直接使用 `trace-decode`。

```bash
node tools/trace-parse.mjs [选项] [trace.bin | trace.ndjson]
```

| 选项 | 说明 |
|------|------|
| `--smap <path>` | （二进制模式）加载 smap.json，将 iid 还原为 line:col/srcText |
| `--resolve-values` | （二进制模式）追溯 OMITTED 值（需 --smap）|
| `--stats` | （二进制模式）向 stderr 输出解码统计 |
| `--strict` | （文本模式）遇到无法解析的行时报错退出（默认跳过并计入统计）|
| `--pretty` | 格式化 JSON 输出（带缩进，调试用）|
| `--workers N` | （文本模式）并行 Worker 线程数；默认自动取 CPU 核心数；`0` 禁用多线程 |
| `--help / -h` | 显示帮助信息 |

---

### `trace-render` — 展示格式渲染

将结构化 NDJSON（`trace-decode` 的输出）渲染为人类可读的展示格式。

```bash
node tools/trace-decode.mjs trace.bin | node tools/trace-render.mjs [选项]
# 或直接指定文件
node tools/trace-render.mjs [选项] parsed.ndjson
```

| 选项 | 说明 |
|------|------|
| `--format FORMAT` | 输出格式：`flat`（默认）/ `tree` / `block` / `pipe` / `io` |
| `--no-seq` | 不输出 seq 编号前缀 |
| `--help` | 显示帮助信息 |

**格式说明**：

| 格式 | 说明 | 适用场景 |
|------|------|----------|
| `flat`（默认）| 平铺流式，无缩进 | 管道组合、程序消费 |
| `tree` | Unicode 树形符号（┬ 进入 / └ 退出 / │ 延续线）| 人眼阅读调用链 |
| `block` | `#region`/`#endregion` 折叠块 | VS Code 中打开可折叠查看 |
| `pipe` | ASCII `|` 符号（数量 = 调用深度）| 纯 ASCII 终端/工具链 |
| `io` | `[seq] [row:col] [src] ; {o:{写变量}, i:{读变量}}` | 数据流分析、机器消费 |

> **注意**：`tree` / `block` / `pipe` 格式根据 `CALL_PRE`/`CALL` 事件对实时推导调用深度。若输入已被 `trace-filter` 过滤（破坏了 CALL_PRE/CALL 配对），层次可能不完整，这是预期行为。

**输出样例（tree 格式）**：

```
[     1] [     1:1] ▶ script: /path/to/file.js
[     2] [    10:5] ┬ CALL main(0 args)
[     3] [    15:3] │ ┬ CALL decode(1 args) ; arg0="hello"
[     4] [    20:5] │ │ x=104
[     5] [    15:3] │ └ RETN decode ; =104
[     6] [    10:5] └ RETN main ; =undefined
```

---

### `trace-filter` — 条件过滤

对结构化 NDJSON 按多种条件过滤，条件可叠加。

```bash
node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs [选项]
```

| 选项 | 说明 |
|------|------|
| `--type TYPE` | 事件类型：`CALL_PRE` / `CALL` / `FUNCTION_ENTER` / `FUNCTION_EXIT` / `END_EXPR` / `SCRIPT_ENTER` / `SCRIPT_EXIT` / `KEY_EVENT` / `WRITE_VAR` / `READ_VAR_FULL` |
| `--seq RANGE` | seq 范围，如 `100-200`（区间）或 `100+`（开区间）|
| `--line N` | 只保留源码第 N 行产生的事件（需配合 `--smap` 解码）|
| `--fn PATTERN` | 函数名匹配，支持 `*` 通配符，如 `decode*`、`*Base64*`（适用于 `CALL_PRE`/`CALL`）|
| `--has-var NAME` | 只保留涉及指定变量（读或写）的行（适用于 `END_EXPR`/`WRITE_VAR`/`READ_VAR_FULL`）|
| `--has-call` | 只保留 `CALL_PRE` 事件 |
| `--no-internal` | 过滤掉内部变量（以 `_` 开头或符合混淆模式的短变量名）|
| `--invert` | 反转过滤条件（相当于 NOT）|

```bash
# 只看函数调用前置事件
node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --type CALL_PRE

# 提取 seq 100~200 的片段
node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --seq 100-200

# 找到所有涉及变量 result 的行
node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --has-var result

# 找名字含 decode 的函数调用，过滤内部变量
node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --fn "*decode*" --no-internal
```

---

### `trace-hot-lines` — 热点行统计

统计哪些代码行被执行次数最多（CPU 热点分析、循环体定位）。

```bash
node tools/trace-decode.mjs trace.bin --smap trace.smap.json | node tools/trace-hot-lines.mjs [选项]
```

| 选项 | 说明 |
|------|------|
| `--top N` | 显示前 N 个热点行（默认 10）|
| `--by-type` | 在统计中展示事件类型分布 |
| `--json` | 输出 JSON 格式，便于程序消费 |
| `--help` | 显示帮助信息 |

---

### `trace-call-tree` — 调用树重建

根据 `CALL_PRE` / `CALL` 事件对，重建函数调用树结构。

```bash
node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs [选项]
```

| 选项 | 说明 |
|------|------|
| `--depth N` | 限制显示深度（默认无限制）|
| `--json` | 输出 JSON 树结构，便于程序消费 |
| `--summary` | 只显示汇总统计（高频调用函数排行）|
| `--help` | 显示帮助信息 |

```bash
# 完整调用树
node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs

# 限制深度为 4 层
node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs --depth 4

# 只看 fact 函数的调用子树
node tools/trace-decode.mjs trace.bin \
  | node tools/trace-filter.mjs --fn fact \
  | node tools/trace-call-tree.mjs
```

---

### `trace-var-timeline` — 变量时序追踪

追踪指定变量（或所有变量）的值随时间（seq）变化的轨迹，支持读写区分。

```bash
node tools/trace-decode.mjs trace.bin | node tools/trace-var-timeline.mjs [选项]
```

| 选项 | 说明 |
|------|------|
| `--var NAMES` | 追踪指定变量，逗号分隔，如 `--var x,result,key` |
| `--all` | 追踪所有变量（建议配合 `--limit` 限制输出量）|
| `--limit N` | 限制输出记录数（默认 100）|
| `--writes` | 只显示写入操作（过滤读取）|
| `--json` | 输出 JSON 格式 |
| `--help` | 显示帮助信息 |

```bash
# 追踪变量 key 的全部读写历史
node tools/trace-decode.mjs trace.bin | node tools/trace-var-timeline.mjs --var key

# 只看写入（赋值轨迹）
node tools/trace-decode.mjs trace.bin | node tools/trace-var-timeline.mjs --var key --writes
```

---

### `trace-range-extract` — 区间提取

按 seq 编号快速提取 trace 片段，支持上下文窗口。

```bash
node tools/trace-decode.mjs trace.bin | node tools/trace-range-extract.mjs [选项] <RANGE>
```

**区间格式**：

| 格式 | 含义 |
|------|------|
| `100-200` | seq 100 到 200 |
| `100+` | seq 100 到末尾 |
| `100` | 只取 seq=100 这一条 |

| 选项 | 说明 |
|------|------|
| `--before N` | 目标 seq 之前 N 条记录 |
| `--after N` | 目标 seq 之后 N 条记录 |
| `--context N` | 等同于 `--before N --after N` |
| `--src` | 输出简化的文本格式（非 JSON）|
| `--help` | 显示帮助信息 |

```bash
# 提取 seq 1000~2000 的片段
node tools/trace-decode.mjs trace.bin | node tools/trace-range-extract.mjs 1000-2000

# 提取 seq=5000 前后各 100 条（共 201 条上下文）
node tools/trace-decode.mjs trace.bin | node tools/trace-range-extract.mjs --context 100 5000
```

---

## 五、常见组合用法

### 场景 1：快速分析 Node.js 脚本（一步到位）

最简单的方式，插桩 + 运行 + 应用分析插件，一条命令完成：

```bash
node bin/jalangi.mjs instrument-and-run \
  --analysis src/plugins/tutorial/LogAll.js \
  target/app.js arg1 arg2
```

**适合**：调试、快速验证、开发分析插件时。

---

### 场景 2：分离插桩与运行（稳定可复现）

先插桩一次，反复用不同分析插件运行，不用每次重新插桩：

```bash
# 第一步：插桩
node bin/jalangi.mjs instrument target/app.js

# 第二步：用插件 A 分析
node bin/jalangi.mjs run \
  --analysis src/plugins/tutorial/LogAll.js \
  target/app_jalangi_.js

# 第三步：换插件 B 重新分析
node bin/jalangi.mjs run \
  --analysis src/plugins/DataTraces.js \
  --init-param level:verbose \
  target/app_jalangi_.js
```

**适合**：需要多轮分析、或插桩耗时较长时。

---

### 场景 3：反混淆后插桩（混淆代码处理）

```bash
# 第一步：反混淆
node bin/preprocess.mjs \
  --output target/app-clean.js \
  target/app.min.js

# 第二步：插桩 + 运行
node bin/jalangi.mjs instrument-and-run \
  --analysis src/plugins/tutorial/LogAll.js \
  target/app-clean.js
```

**适合**：分析压缩/混淆 JS（如 App 的 JS 业务代码），提升 trace 可读性。

---

### 场景 4：完整预处理流程（混淆 + 降级）

```bash
# 第一步：完整预处理（反混淆 + 语法降级到 Node 12）
node bin/preprocess.mjs \
  --preset full \
  --targets '{"node":"12"}' \
  --flatten-iife \
  --output target/app-clean.js \
  target/app.min.js

# 第二步：插桩 + 运行
node bin/jalangi.mjs instrument-and-run \
  --analysis src/plugins/tutorial/LogAll.js \
  target/app-clean.js
```

---

### 场景 5：浏览器插桩 + 本地 Trace 收集

```bash
# 第一步：启动 JTA Server（已内置 trace 收集）
node analyzer/server.mjs --port 33000 --traces-dir ./traces

# 第二步：为浏览器生成插桩文件（内联模式）
node bin/jalangi.mjs instrument \
  --target browser \
  --ws-url ws://127.0.0.1:33000/ws/trace \
  --output dist/app.inst.js \
  src/app.js

# 第三步：把 dist/app.inst.js 替换掉网页中的 app.js 引用，刷新浏览器即可
# trace 事件会自动通过 WebSocket 发到 JTA Server，保存为 ./traces/trace_*.bin

# 第四步：离线分析 trace
node tools/trace-decode.mjs traces/trace_*.bin | node tools/trace-render.mjs --format tree

# 或在 JTA UI（http://localhost:33000/trace）中一键导入 trace 文件
```

---

### 场景 6：浏览器插桩 + 运行时分离（split 模式，适合大文件）

```bash
# 第一步：生成分离的运行时 + 插桩代码
node bin/jalangi.mjs instrument \
  --target browser \
  --split-runtime \
  --ws-url ws://127.0.0.1:33000/ws/trace \
  --minify \
  src/app.js
# 输出：
#   src/app.runtime.js  ← 压缩后的运行时 IIFE，加到 <head> 最前面
#   src/app.inst.js     ← 插桩代码

# 第二步：在 HTML 中按顺序引入
# <script src="app.runtime.js"></script>
# <script src="app.inst.js"></script>
```

---

### 场景 7：浏览器插桩 + 延迟加载（deferred-load，高频 trace 场景）

```bash
node bin/jalangi.mjs instrument \
  --target browser \
  --split-runtime \
  --deferred-load \
  --ws-url ws://127.0.0.1:33000/ws/trace \
  src/app.js
# 输出（文件名翻转）：
#   src/app.js          ← 运行时 IIFE（替换原始文件，HTML 无需修改！）
#   src/app_jalangi_.js ← 插桩代码（由运行时在后端 ready 后自动加载）
```

**优势**：等 WebSocket/IDB 后端初始化完成后再加载插桩代码，彻底消除启动阶段 trace 队列内存积压。

---

### 场景 8：离线 trace 分析（完整后处理流程）

```bash
# 步骤 1：解码二进制 trace，注入源码位置
node tools/trace-decode.mjs trace.bin --smap trace.smap.json > parsed.ndjson

# 步骤 2：找热点行，定位关键函数
cat parsed.ndjson | node tools/trace-hot-lines.mjs --top 20

# 步骤 3：以树形视图查看调用链（只看 decode 相关函数）
cat parsed.ndjson | node tools/trace-filter.mjs --fn "*decode*" \
  | node tools/trace-render.mjs --format tree

# 步骤 4：追踪关键变量的变化轨迹
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var key,result --writes

# 步骤 5：在可疑 seq 附近提取上下文，用 block 格式便于在 VS Code 中折叠查看
cat parsed.ndjson | node tools/trace-range-extract.mjs --context 30 8421 \
  | node tools/trace-render.mjs --format block > context.log
```

---

### 场景 9：只预览，不写文件

```bash
# 查看插桩效果（不写磁盘）
node bin/jalangi.mjs instrument --dry-run src/app.js

# 查看反混淆效果（输出到 stdout）
node bin/preprocess.mjs --stdout src/app.min.js | head -100

# 预处理 dry-run + 统计
node bin/preprocess.mjs --dry-run --stats src/app.min.js
```

---

### 场景 10：传入脚本参数

```bash
# 给目标脚本传递参数（在 -- 后面的都是脚本参数）
node bin/jalangi.mjs instrument-and-run target/app.js -- --config ./my.json

# run 子命令同理
node bin/jalangi.mjs run target/app_jalangi_.js -- --config ./my.json
```

---

### 场景 11：防止沙盒变量名冲突

```bash
# 使用随机变量名（适合分析有全局变量 J$ 的页面）
node bin/jalangi.mjs instrument --random-var src/app.js

# 或者手动指定变量名
node bin/jalangi.mjs instrument --sandbox-var __myJal src/app.js
```

---

### 场景 12：三段管道（decode → filter → render）

```bash
# fact 递归调用树（含 smap 源码位置）
node tools/trace-decode.mjs trace.bin --smap trace.smap.json \
  | node tools/trace-filter.mjs --fn fact \
  | node tools/trace-render.mjs --format tree

# 定位高频函数（只看函数调用，汇总统计）
node tools/trace-decode.mjs trace.bin \
  | node tools/trace-filter.mjs --type CALL_PRE --no-internal \
  | node tools/trace-call-tree.mjs --summary
```

---

## 附：快速参数速查

```bash
# jalangi 帮助
node bin/jalangi.mjs --help
node bin/jalangi.mjs instrument --help
node bin/jalangi.mjs run --help
node bin/jalangi.mjs instrument-and-run --help

# preprocess 帮助
node bin/preprocess.mjs --help

# JTA Server 帮助（已内置 trace 收集，无独立 trace-server）
node analyzer/server.mjs --help

# 后处理工具帮助
node tools/trace-decode.mjs --help
node tools/trace-parse.mjs --help
node tools/trace-render.mjs --help
node tools/trace-filter.mjs --help
node tools/trace-hot-lines.mjs --help
node tools/trace-call-tree.mjs --help
node tools/trace-var-timeline.mjs --help
node tools/trace-range-extract.mjs --help
```
