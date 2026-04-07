# DOC-11 · 离线 Trace 分析工具集

> 源码路径：`tools/`

---

## 1. 概述

`tools/` 目录下提供一套遵循 **Unix 哲学**（一工具一事，通过管道组合）的纯 Node.js 离线分析工具，
用于对 `ExecutionTraceAnalysis` 生成的 JTB1 二进制 trace 数据进行后处理。

### 工具一览

| 工具 | 功能 |
|------|------|
| `trace-parse.mjs` | 将 JTB1 二进制 `.bin` 文件解码为结构化 NDJSON（核心入口） |
| `trace-parse.mjs` | 兼容层：解析旧文本 trace 或 `.bin` 文件，统一输出结构化 NDJSON |
| `trace-render.mjs` | 将结构化 NDJSON 渲染为 flat / tree / block / pipe / io 展示格式 |
| `trace-filter.mjs` | 按类型、seq 范围、行号、函数名、变量等条件过滤 |
| `trace-hot-lines.mjs` | 统计代码行执行热点（Top-N 排行）|
| `trace-call-tree.mjs` | 重建函数调用树，支持深度限制与汇总统计 |
| `trace-var-timeline.mjs` | 追踪变量值的时序变化 |
| `trace-range-extract.mjs` | 按 seq 区间快速提取片段（含 context 窗口）|

### 数据流

```
ExecutionTrace 插件 / WsBackend / NodeStreamBackend
    ↓ trace.bin（JTB1 二进制格式）+ trace.smap.json（IID 源码位置映射）
trace-parse.mjs  [--smap] [--resolve-values]
    ↓ parsed.ndjson（结构化 NDJSON，JTB1 事件类型）
trace-filter.mjs  ─→  trace-render.mjs      ← 展示格式转换（flat/tree/block/pipe/io）
                  ─→  trace-hot-lines.mjs
                  ─→  trace-call-tree.mjs
                  ─→  trace-var-timeline.mjs
                  ─→  trace-range-extract.mjs
```

**设计原则**：运行时只写入最紧凑的 JTB1 二进制格式（无缓冲、不丢失数据）；
树形/缩进等展示风格完全在离线侧（`trace-render.mjs`）按需生成，可重复渲染、任意过滤后再渲染。

所有工具从 **stdin** 或文件读取，结果写到 **stdout**，统计摘要写到 **stderr**，可任意串联：

```bash
node tools/trace-parse.mjs trace.bin \
  | node tools/trace-filter.mjs --type CALL_PRE --fn decode* \
  | node tools/trace-call-tree.mjs --summary
```

---

## 2. trace-parse.mjs — 二进制解码（核心入口）

将 JTB1 二进制 `.bin` 文件解码为结构化 NDJSON，是处理链的起点。

### 选项

| 选项 | 说明 |
|------|------|
| `--smap <path>` | 加载 `.smap.json`，将 `iid` 还原为 `line:col` 和 `srcText` |
| `--resolve-values` | 追溯 `OMITTED` 省略值（需同时指定 `--smap`）|
| `--stats` | 向 stderr 输出解码统计（事件总数、类型分布等）|
| `--pretty` | 格式化输出（带缩进，调试用）|
| `--help` | 显示帮助信息 |

### 字典压缩透明解码

当 trace 文件由 `NodeStreamBackend({ usePool: true })` 或 `WsBackend({ mode: 'main', usePool: true })` 写入时，
文件中会包含 `DICT_ENTRY`（事件类型 `0x0A`）条目和 `STRING_REF` 值引用。
`trace-parse.mjs` 在解码过程中**自动维护字典状态**：

- 遇到 `DICT_ENTRY` 时将 `id → string` 写入内部字典，该事件**不输出**到 NDJSON
- 遇到 `STRING_REF` 时从字典中查找，将字段值**自动还原**为原始字符串
- 对下游工具（`trace-filter.mjs`、`trace-render.mjs` 等）完全透明，无需任何额外选项

### 输出格式

每行一个紧凑 JSON 对象，字段随事件类型而定：

| 事件类型 | 主要字段 |
|---------|---------|
| `SCRIPT_ENTER` | `type, seq, iid, file, [line, col]` |
| `SCRIPT_EXIT` | `type, seq, iid, [exception]` |
| `CALL_PRE` | `type, seq, iid, fn, args, isConstructor, isMethod, [base]` |
| `CALL` | `type, seq, iid, fn, result` |
| `FUNCTION_ENTER` | `type, seq, iid` |
| `FUNCTION_EXIT` | `type, seq, iid, [exception]` |
| `END_EXPR` | `type, seq, iid, writes:[{name,value}], reads:[{name,value}], fields:[{base,offset,isWrite,value}]` |
| `KEY_EVENT` | `type, seq, iid, level, text` |

### 用法

```bash
# 基本解码
node tools/trace-parse.mjs trace.bin

# 注入 smap，还原源码位置（line/col/srcText）
node tools/trace-parse.mjs trace.bin --smap trace.smap.json

# 追溯省略值 + 统计输出
node tools/trace-parse.mjs trace.bin --smap trace.smap.json --resolve-values --stats

# 管道到 render
node tools/trace-parse.mjs trace.bin --smap trace.smap.json | node tools/trace-render.mjs --format tree
```

---

## 3. trace-parse.mjs — 格式解析（兼容层）

`trace-parse.mjs` 兼容两种输入格式，自动检测：

1. **JTB1 二进制文件（`.bin`）**：内置 JTB1 解码器，支持 `--smap` 选项
2. **旧文本格式 trace 行**：手动解析器（热路径，无正则），输出统一结构化 NDJSON

`trace-parse.mjs` 是统一入口，`.bin` 和旧文本格式均可直接使用；旧文本格式由专用解析路径处理。

### 支持的文本输入格式

**标准格式（JSON kv，`ExecutionTrace` 默认输出）：**

```
[     1] [     1:1] ▶ script: /path/to/file.js
[     2] [    10:5] CALL foo(2 args) {"a":[...]}
[     3] [    10:5] RETN foo {"v":42}
[     4] [    10:1] x = 1 + 2 {"w":{"x":3},"r":{"y":1}}
[     5] [    11:1] ◀ script end
```

**兼容：传统文本 kv 格式（`OUTPUT_JSON_KV=false` 历史输出）：**

```
[  123] [  10:5] CALL foo(2 args) ; this=..., arg0=...
[  124] [  10:5] RETN foo ; =42
[  125] [  10:5] x = 1 + 2 ; x=3
```

### 输出事件类型（文本模式）

| 事件类型 | 字段 |
|---------|------|
| `CALL_PRE` | `seq, line, col, type, fn, isConstructor, args, kv` |
| `CALL` | `seq, line, col, type, fn, result, kv` |
| `END_EXPR` | `seq, line, col, type, src, w, r, f, kv` |
| `SCRIPT_ENTER` | `seq, type, file` |
| `SCRIPT_EXIT` | `seq, type, exception` |

### 选项

| 选项 | 说明 |
|------|------|
| `--smap <path>` | （二进制模式）加载 smap.json，将 iid 还原为 line:col/srcText |
| `--resolve-values` | （二进制模式）追溯 OMITTED 值（需 --smap）|
| `--stats` | （二进制模式）向 stderr 输出解码统计 |
| `--strict` | （文本模式）遇到无法解析的行时报错退出（默认跳过并计入统计）|
| `--pretty` | 格式化输出（带缩进，调试用）|
| `--workers N` | （文本模式）并行 Worker 线程数；默认自动取 CPU 核心数；`0` 禁用多线程 |
| `--help` | 显示帮助信息 |

### 字典压缩透明解码（二进制模式）

在二进制模式（`.bin` 文件）下，`trace-parse.mjs` 内置字典维护逻辑：
自动识别并处理 `DICT_ENTRY` 事件和 `STRING_REF` 引用，对用户完全透明。

### 用法

```bash
# 解码 JTB1 二进制文件（自动检测）
node tools/trace-parse.mjs trace.bin > parsed.ndjson

# 注入 smap
node tools/trace-parse.mjs trace.bin --smap trace.smap.json > parsed.ndjson

# 处理旧文本格式
cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson
node tools/trace-parse.mjs trace.ndjson > parsed.ndjson
```

---

## 4. trace-render.mjs — 展示格式渲染

将结构化 NDJSON（`trace-parse.mjs` 的输出）渲染为人类可读的展示格式。

### 格式说明

| 格式 | 说明 | 适用场景 |
|------|------|----------|
| `flat`（默认）| 平铺流式，无缩进 | 管道组合、程序消费 |
| `tree` | Unicode 树形符号（┬ 进入 / └ 退出 / │ 延续线）| 人眼阅读调用链 |
| `block` | `#region`/`#endregion` 折叠块（对应 CALL_PRE/CALL 事件对）；`FUNCTION_ENTER`/`FUNCTION_EXIT` 以注释行内嵌 | VS Code 中打开可折叠查看 |
| `pipe` | ASCII `|` 符号（数量 = 调用深度）| 纯 ASCII 终端/工具链 |
| `io` | 语句级输入/输出变量快照：`; {"o":{写变量},"i":{读变量}}` | 数据流分析、逐语句追踪变量变化 |

### 选项

| 选项 | 说明 |
|------|------|
| `--format FORMAT` | 输出格式：`flat`（默认）/ `tree` / `block` / `pipe` / `io` |
| `--no-seq` | 不输出 seq 编号前缀 |
| `--help` | 显示帮助信息 |

### 示例

```bash
# 默认 flat 格式
node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs

# 树形格式（适合人眼阅读调用链）
node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree

# 生成 VS Code 可折叠的 block 格式
node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format block > trace.log

# ASCII pipe 格式
node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format pipe

# io 格式（语句输入/输出变量）— 建议配合 --smap 以还原源码位置
node tools/trace-parse.mjs trace.bin --smap trace.smap.json | node tools/trace-render.mjs --format io

# 只看语句行（过滤掉函数调用噪音），再以 io 格式渲染
node tools/trace-parse.mjs trace.bin --smap trace.smap.json \
  | node tools/trace-filter.mjs --type END_EXPR \
  | node tools/trace-render.mjs --format io

# 先过滤再渲染（只看 decode 相关调用的树形视图）
node tools/trace-parse.mjs trace.bin --smap trace.smap.json \
  | node tools/trace-filter.mjs --fn "*decode*" \
  | node tools/trace-render.mjs --format tree
```

**输出样例（tree 格式）：**

```
[     1] [     1:1] ▶ script: /path/to/file.js
[     2] [    10:5] ┬ CALL main(0 args)
[     3] [    15:3] │ ┬ CALL decode(1 args) ; arg0="hello"
[     4] [    20:5] │ │ x=104
[     5] [    15:3] │ └ RETN decode ; =104
[     6] [    10:5] └ RETN main ; =undefined
```

> **注意**：`tree` / `block` / `pipe` 格式根据 `CALL_PRE`/`CALL` 事件对实时推导调用深度。
> 若输入已被 `trace-filter` 过滤（破坏了 CALL_PRE/CALL 配对），层次可能不完整，这是预期行为。

### io 格式详解

`io` 格式专为**语句级数据流分析**设计，重点展示每条表达式语句执行时的变量**输入快照**和**输出快照**：

#### 行格式

```
[  seq] [ row:col] <源码文本> ; {"o":{写变量名:值,...},"i":{读变量名:值,...}}
```

#### 字段含义

| 字段 | 来源 | 说明 |
|------|------|------|
| `o`（output）| `END_EXPR.writes` | 语句执行**后**写入的变量（赋值目标），含属性写入 |
| `i`（input）| `END_EXPR.reads` | 语句执行**前**读取的变量（参与计算的输入），排除已出现在 `o` 中的变量名 |

属性访问（`fields`）按方向分流：`isWrite=true` 归入 `o`，`isWrite=false` 归入 `i`；
属性的 key 形如 `"base.offset"`（如 `"obj.length"`）。

#### 示例输出

```
[     1] [     1:1] ▶ script: /path/to/file.js
[     2] [     3:1] const a = 1               ; {"o":{"a":1},"i":{}}
[     3] [     4:1] const b = 2               ; {"o":{"b":2},"i":{}}
[     4] [     5:1] const c = a + b           ; {"o":{"c":3},"i":{"a":1,"b":2}}
[     5] [     6:5] CALL console.log(1 args)  ; arg0=3
[     6] [     6:5] RETN console.log          ; =undefined
[     7] [     7:1] obj.x = c * 2             ; {"o":{"obj.x":6},"i":{"obj":{},"c":3}}
```

#### 与其他格式的对比

| 格式 | 对 END_EXPR 的处理 | 调用深度缩进 |
|------|-------------------|------------|
| `flat` | `src {"w":{写},"r":{读}}` — 原始结构 | 无 |
| `tree` | `src ; 写=值, 读=值` — 扁平文本 | 有（Unicode 树线） |
| `io` | `src ; {"o":{写},"i":{读}}` — 区分输入/输出 | 无 |

#### 适用场景

- **数据流污点分析**：追踪某变量值如何从输入传播到输出
- **逐语句调试**：快速定位某变量被赋值或读取的语句
- **与 `trace-filter.mjs` 组合**：先过滤 `--type END_EXPR`，再以 `io` 格式渲染，排除函数调用噪音
- **与 `trace-var-timeline.mjs` 互补**：`io` 按语句展示上下文，`trace-var-timeline` 按变量展示历史

---

## 5. trace-filter.mjs — 条件过滤

对结构化 NDJSON（`trace-parse.mjs` 的输出）按多种条件过滤，条件可叠加。

### 过滤条件

| 选项 | 说明 |
|------|------|
| `--type TYPE` | 事件类型（JTB1 格式）：`CALL_PRE` / `CALL` / `FUNCTION_ENTER` / `FUNCTION_EXIT` / `END_EXPR` / `SCRIPT_ENTER` / `SCRIPT_EXIT` / `KEY_EVENT` / `WRITE_VAR` / `READ_VAR_FULL` |
| `--seq RANGE` | seq 范围，如 `100-200`（区间）或 `100+`（开区间）|
| `--line N` | 只保留源码第 N 行产生的事件（需配合 `--smap` 解码）|
| `--fn PATTERN` | 函数名匹配，支持 `*` 通配符，如 `decode*`、`*Base64*`（适用于 `CALL_PRE`/`CALL`）|
| `--has-var NAME` | 只保留涉及指定变量（读或写）的行（适用于 `END_EXPR`/`WRITE_VAR`/`READ_VAR_FULL`）|
| `--has-call` | 只保留 `CALL_PRE` 事件 |
| `--no-internal` | 过滤掉内部变量（以 `_` 开头或符合混淆模式的短变量名）|
| `--invert` | 反转过滤条件（相当于 NOT）|

### 用法示例

```bash
# 只看函数调用前置事件
node tools/trace-parse.mjs trace.bin | node tools/trace-filter.mjs --type CALL_PRE

# 提取 seq 100~200 的片段
node tools/trace-parse.mjs trace.bin | node tools/trace-filter.mjs --seq 100-200

# 找到所有涉及变量 result 的行
node tools/trace-parse.mjs trace.bin | node tools/trace-filter.mjs --has-var result

# 找名字含 decode 的函数调用，过滤内部变量
node tools/trace-parse.mjs trace.bin | node tools/trace-filter.mjs --type CALL_PRE --fn "*decode*" --no-internal

# 找函数 fact 的递归调用
node tools/trace-parse.mjs trace.bin | node tools/trace-filter.mjs --fn fact
```

---

## 6. trace-hot-lines.mjs — 热点行统计

统计哪些代码行被执行次数最多（CPU 热点分析、循环体定位）。

### 选项

| 选项 | 说明 |
|------|------|
| `--top N` | 显示前 N 个热点行（默认 10）|
| `--by-type` | 在统计中展示事件类型分布 |
| `--json` | 输出 JSON 格式，便于程序消费 |

### 示例

```bash
# 默认 Top-10 热点行
node tools/trace-parse.mjs trace.bin --smap trace.smap.json | node tools/trace-hot-lines.mjs

# Top-5，展示类型分布
node tools/trace-parse.mjs trace.bin | node tools/trace-hot-lines.mjs --top 5 --by-type
```

**输出样例：**

```
# 热点代码行统计
# 总事件: 84231, 涉及行数: 512

行号    | 次数    | 占比
--------|---------|-------
    231 |   12048 | 14.3%
     89 |    8721 | 10.3%
    ...
```

---

## 7. trace-call-tree.mjs — 调用树重建

根据 `CALL_PRE` / `CALL` 事件对，重建函数调用树结构，展示执行路径和深度。

### 选项

| 选项 | 说明 |
|------|------|
| `--depth N` | 限制显示深度（默认无限制）|
| `--json` | 输出 JSON 树结构，便于程序消费 |
| `--summary` | 只显示汇总统计（高频调用函数排行）|

### 示例

```bash
# 完整调用树
node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs

# 限制深度为 4 层
node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --depth 4

# JSON 结构输出
node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --json

# 只看 fact 函数的调用子树
node tools/trace-parse.mjs trace.bin \
  | node tools/trace-filter.mjs --fn fact \
  | node tools/trace-call-tree.mjs
```

**输出样例：**

```
# 调用树统计
# 总调用: 3421, 独立函数: 87

调用树:
  main() [L1] [1→3421]
    init() [L10] [2→50]
    decode() [L25] [51→3400]
      fromCharCode() [L30] [52→100]
      ...
```

---

## 8. trace-var-timeline.mjs — 变量时序追踪

追踪指定变量（或所有变量）的值随时间（seq）变化的轨迹，支持读写区分和属性访问。

### 选项

| 选项 | 说明 |
|------|------|
| `--var NAMES` | 追踪指定变量，逗号分隔，如 `--var x,result,key` |
| `--all` | 追踪所有变量（建议配合 `--limit` 限制输出量）|
| `--limit N` | 限制输出记录数（默认 100）|
| `--writes` | 只显示写入操作（过滤读取）|
| `--json` | 输出 JSON 格式 |

### 示例

```bash
# 追踪变量 key 的全部读写历史
node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var key

# 追踪多个变量
node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var x,y,result

# 只看写入（赋值轨迹）
node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var key --writes
```

**输出样例：**

```
# 变量时序追踪: key

seq      | 行号    | 变量            | 类型        | 值
---------|---------|-----------------|-------------|------------------
      51 |      25 | key             | write       | "hello"
     102 |      30 | key             | read        | "hello"
     203 |      42 | key             | write       | "world"
```

---

## 9. trace-range-extract.mjs — 区间提取

按 seq 编号快速提取 trace 片段，支持上下文窗口，适合在发现异常后定位上下文。

### 区间格式

| 格式 | 含义 |
|------|------|
| `100-200` | seq 100 到 200 |
| `100+` | seq 100 到末尾 |
| `100` | 只取 seq=100 这一条 |

### 选项

| 选项 | 说明 |
|------|------|
| `--before N` | 目标 seq 之前 N 条记录 |
| `--after N` | 目标 seq 之后 N 条记录 |
| `--context N` | 等同于 `--before N --after N` |
| `--src` | 输出简化的文本格式（非 JSON）|

### 示例

```bash
# 提取 seq 1000~2000 的片段
node tools/trace-parse.mjs trace.bin | node tools/trace-range-extract.mjs 1000-2000

# 提取 seq=5000 前后各 100 条（共 201 条上下文）
node tools/trace-parse.mjs trace.bin | node tools/trace-range-extract.mjs --context 100 5000

# 以文本格式查看（更易人眼阅读）
node tools/trace-parse.mjs trace.bin | node tools/trace-range-extract.mjs --context 20 --src 5000
```

---

## 10. 典型分析流程

### 混淆代码逆向分析

```bash
# 步骤 1：解码二进制 trace，注入源码位置
node tools/trace-parse.mjs trace.bin --smap trace.smap.json > parsed.ndjson

# 步骤 2：找热点行，定位关键函数
cat parsed.ndjson | node tools/trace-hot-lines.mjs --top 20

# 步骤 3：以树形视图查看调用链
cat parsed.ndjson | node tools/trace-filter.mjs --fn "*decode*" \
  | node tools/trace-render.mjs --format tree

# 步骤 4：追踪关键变量的变化轨迹
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var key,result --writes

# 步骤 5：在可疑 seq 附近提取上下文，用 block 格式便于在 VS Code 中折叠查看
cat parsed.ndjson | node tools/trace-range-extract.mjs --context 30 8421 \
  | node tools/trace-render.mjs --format block > context.log
```

### 定位高频函数

```bash
# 只看函数调用，汇总统计
node tools/trace-parse.mjs trace.bin \
  | node tools/trace-filter.mjs --type CALL_PRE --no-internal \
  | node tools/trace-call-tree.mjs --summary
```

### 跟踪属性赋值链

```bash
# 找所有涉及属性 "width" 的语句（需 END_EXPR 事件）
node tools/trace-parse.mjs trace.bin | node tools/trace-filter.mjs --has-var width

# 配合时序追踪查看变化过程
node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var width
```

### 三段管道：decode → filter → render

```bash
# fact 递归调用树
node tools/trace-parse.mjs trace.bin --smap trace.smap.json \
  | node tools/trace-filter.mjs --fn fact \
  | node tools/trace-render.mjs --format tree
```

---

## 11. 运行时格式与离线工具兼容性

`ExecutionTraceAnalysis` 运行时通过 `NodeStreamBackend` 将事件序列化为 **JTB1 二进制格式**写入 `.bin` 文件，配套输出 `.smap.json`（IID → 源码位置映射）。

在浏览器端通过 `WsBackend` 将事件流实时推送给 `trace-server`，服务端落地为相同格式的 `.bin` 文件。

`trace-parse.mjs` 将二进制事件解码为统一结构化 NDJSON，事件类型为 JTB1 枚举（`CALL_PRE`/`CALL`/`END_EXPR` 等），供下游工具统一消费：

- `writes`/`reads`/`fields`：结构化变量读写数组（`END_EXPR` 事件）
- `fn`/`args`/`result`：函数调用信息（`CALL_PRE`/`CALL` 事件）
- `line`/`col`/`srcText`：源码位置（注入 `--smap` 后可用）

后续工具（`filter`、`var-timeline`、`render` 等）均基于 JTB1 结构化字段工作，**不依赖旧文本格式**。

**树形/缩进展示**不再由运行时负责，统一由 `trace-render.mjs` 在离线侧按需渲染。
