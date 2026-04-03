# Jani CLI 工具参考手册

Jani 提供三个命令行工具，覆盖从代码预处理到插桩运行的完整流程：

| 工具 | 入口文件 | 用途 |
|------|----------|------|
| `jalangi` | `bin/jalangi.mjs` | 插桩 / 运行 / 插桩并运行 |
| `preprocess` | `bin/preprocess.mjs` | 反混淆 / 语法降级（插桩前的预处理） |
| `trace-server` | `tools/trace-server/server.mjs` | 浏览器端 WebSocket Trace 收集服务器 |

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
| `--ws-url <url>` | — | WebSocket 服务地址（如 `ws://127.0.0.1:9229/trace`），配合 `trace-server` 使用 |
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

用于浏览器端插桩场景：浏览器通过 WebSocket 将 trace 事件实时上传，`trace-server` 接收并写入本地文件。

```bash
node tools/trace-server/server.mjs [选项]
```

### 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--port <number>` | `9229` | WebSocket 监听端口 |
| `--out <dir>` | `traces` | 输出目录，每个连接写入独立文件 |
| `--format <mode>` | `binary` | 接收格式：`binary` 或 `ndjson` |
| `--text-only` / `--no-text-only` | ✅ 开启 | trace 类型事件只写入 `text` 字段（可读性强）；`--no-text-only` 则全部输出为 NDJSON（适合 `jq` 分析）|
| `--clear` / `--no-clear` | ✅ 开启 | 启动时清空输出目录中的 `.ndjson` 文件 |
| `--max-payload <MB>` | `0`（无限制）| 最大消息体积（MB）|
| `--verbose` | — | 打印每个 batch 的接收日志 |

### 输出文件命名

每个 WebSocket 连接生成一个独立文件：
```
traces/trace_<YYYYMMDD>_<HHmmss>_<ms>_<seq>.ndjson
```

---

## 四、常见组合用法

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
# 第一步：启动 trace-server（先启动！）
node tools/trace-server/server.mjs \
  --port 9229 \
  --out ./traces \
  --format ndjson

# 第二步：为浏览器生成插桩文件（内联模式）
node bin/jalangi.mjs instrument \
  --target browser \
  --ws-url ws://127.0.0.1:9229/trace \
  --output dist/app.inst.js \
  src/app.js

# 第三步：把 dist/app.inst.js 替换掉网页中的 app.js 引用，刷新浏览器即可
# trace 事件会自动通过 WebSocket 发到 trace-server，保存在 ./traces/ 目录
```

---

### 场景 6：浏览器插桩 + 运行时分离（split 模式，适合大文件）

```bash
# 第一步：生成分离的运行时 + 插桩代码
node bin/jalangi.mjs instrument \
  --target browser \
  --split-runtime \
  --ws-url ws://127.0.0.1:9229/trace \
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
  --ws-url ws://127.0.0.1:9229/trace \
  src/app.js
# 输出（文件名翻转）：
#   src/app.js          ← 运行时 IIFE（替换原始文件，HTML 无需修改！）
#   src/app_jalangi_.js ← 插桩代码（由运行时在后端 ready 后自动加载）
```

**优势**：等 WebSocket/IDB 后端初始化完成后再加载插桩代码，彻底消除启动阶段 trace 队列内存积压。

---

### 场景 8：只预览，不写文件

```bash
# 查看插桩效果（不写磁盘）
node bin/jalangi.mjs instrument --dry-run src/app.js

# 查看反混淆效果（输出到 stdout）
node bin/preprocess.mjs --stdout src/app.min.js | head -100

# 预处理 dry-run + 统计
node bin/preprocess.mjs --dry-run --stats src/app.min.js
```

---

### 场景 9：传入脚本参数

```bash
# 给目标脚本传递参数（在 -- 后面的都是脚本参数）
node bin/jalangi.mjs instrument-and-run target/app.js -- --config ./my.json

# run 子命令同理
node bin/jalangi.mjs run target/app_jalangi_.js -- --config ./my.json
```

---

### 场景 10：防止沙盒变量名冲突

```bash
# 使用随机变量名（适合分析有全局变量 J$ 的页面）
node bin/jalangi.mjs instrument --random-var src/app.js

# 或者手动指定变量名
node bin/jalangi.mjs instrument --sandbox-var __myJal src/app.js
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

# trace-server 帮助
node tools/trace-server/server.mjs --help
```
