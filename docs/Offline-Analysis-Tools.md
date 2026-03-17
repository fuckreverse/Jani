# 离线 Trace 分析工具集

> 源码路径：`tools/`

---

## 1. 概述

`tools/` 目录下提供一套遵循 **Unix 哲学**（一工具一事，通过管道组合）的纯 Node.js 离线分析工具，
用于对 `ExecutionTraceAnalysis` 生成的 trace 数据进行后处理。

### 工具一览

| 工具 | 功能 |
|------|------|
| `trace-parse.mjs` | 将混合格式 trace 转换为统一结构化 NDJSON |
| `trace-filter.mjs` | 按类型、seq 范围、行号、函数名、变量等条件过滤 |
| `trace-hot-lines.mjs` | 统计代码行执行热点（Top-N 排行）|
| `trace-call-tree.mjs` | 重建函数调用树，支持深度限制与汇总统计 |
| `trace-var-timeline.mjs` | 追踪变量值的时序变化 |
| `trace-range-extract.mjs` | 按 seq 区间快速提取片段（含 context 窗口）|

### 数据流

```
ExecutionTrace 插件
    ↓ trace.ndjson（混合格式 或 纯 JSON）
trace-parse.mjs
    ↓ parsed.ndjson（统一结构化 NDJSON）
trace-filter.mjs  ─→  trace-hot-lines.mjs
                  ─→  trace-call-tree.mjs
                  ─→  trace-var-timeline.mjs
                  ─→  trace-range-extract.mjs
```

所有工具从 **stdin** 或文件读取，结果写到 **stdout**，统计摘要写到 **stderr**，可任意串联：

```bash
cat trace.ndjson \
  | node tools/trace-parse.mjs \
  | node tools/trace-filter.mjs --type call --fn decode* \
  | node tools/trace-call-tree.mjs --summary
```

---

## 2. trace-parse.mjs — 格式解析

将 `ExecutionTraceAnalysis` 的原始输出（文本格式或 JSON 格式混合）转换为统一的结构化 NDJSON，
供后续工具消费。

### 支持的输入格式

**文本格式（传统 `FORMAT_FLAT`，`OUTPUT_JSON_KV=false`）：**

```
[  123] [  10:5] CALL foo(2 args) ; this=..., arg0=...
[  124] [  10:5] RETN foo ; =42
[  125] [  10:5] x = 1 + 2 ; x=3
[    1] ▶ script: /path/to/file.js
[  999] ◀ script end
```

**JSON 格式（`OUTPUT_JSON_KV=true`，默认）：**

```
[  123] [  10:5] CALL foo(2 args) {"a":[...]}
[  124] [  10:5] RETN foo {"v":42}
[  125] [  10:5] x = 1 + 2 {"w":{"x":3},"r":{"y":1}}
```

**已结构化的 JSON 行（直接透传）：**

```json
{"seq":123,"line":10,"col":5,"type":"call","fn":"foo","args":2}
```

### 输出格式

每行一个 JSON 对象：

| 事件类型 | 字段 |
|---------|------|
| `call` | `seq, line, col, type, fn, isConstructor, args, kv` |
| `return` | `seq, line, col, type, fn, result, kv` |
| `expr` | `seq, line, col, type, src, w, r, f, kv` |
| `script_enter` | `seq, type, file` |
| `script_exit` | `seq, type, exception` |

其中 `w`（writes）、`r`（reads）、`f`（fields）是结构化的 JSON 对象，`kv` 是传统键值对（两种格式兼容）。

### 用法

```bash
# 从 stdin 读
cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson

# 直接读文件
node tools/trace-parse.mjs trace.ndjson > parsed.ndjson

# 原始解析结果（包含更多细节）
node tools/trace-parse.mjs --raw trace.ndjson

# 紧凑输出（单行 JSON，适合大文件）
node tools/trace-parse.mjs --compact trace.ndjson > parsed.ndjson

# 严格模式（遇到无法解析的行报错退出）
node tools/trace-parse.mjs --strict trace.ndjson
```

---

## 3. trace-filter.mjs — 条件过滤

对结构化 NDJSON（`trace-parse.mjs` 的输出）按多种条件过滤，条件可叠加。

### 过滤条件

| 选项 | 说明 |
|------|------|
| `--type TYPE` | 事件类型：`call` / `return` / `expr` / `script_enter` / `script_exit` |
| `--seq RANGE` | seq 范围，如 `100-200`（区间）或 `100+`（开区间）|
| `--line N` | 只保留源码第 N 行产生的事件 |
| `--fn PATTERN` | 函数名匹配，支持 `*` 通配符，如 `decode*`、`*Base64*` |
| `--has-var NAME` | 只保留涉及指定变量（读或写）的行 |
| `--has-call` | 只保留包含函数调用的行 |
| `--no-internal` | 过滤掉内部变量（以 `_` 开头或符合混淆模式的短变量名）|
| `--invert` | 反转过滤条件（相当于 NOT）|

### 用法示例

```bash
# 只看函数调用
cat parsed.ndjson | node tools/trace-filter.mjs --type call

# 提取 seq 100~200 的片段
cat parsed.ndjson | node tools/trace-filter.mjs --seq 100-200

# 找到所有涉及变量 result 的行
cat parsed.ndjson | node tools/trace-filter.mjs --has-var result

# 找名字含 decode 的函数调用，过滤内部变量
cat parsed.ndjson | node tools/trace-filter.mjs --type call --fn "*decode*" --no-internal

# 找源码第 42 行的所有事件
cat parsed.ndjson | node tools/trace-filter.mjs --line 42
```

---

## 4. trace-hot-lines.mjs — 热点行统计

统计哪些代码行被执行次数最多（CPU 热点分析、循环体定位）。

### 选项

| 选项 | 说明 |
|------|------|
| `--top N` | 显示前 N 个热点行（默认 10）|
| `--by-type` | 在统计中展示事件类型分布（call / expr / return）|
| `--json` | 输出 JSON 格式，便于程序消费 |

### 示例

```bash
# 默认 Top-10 热点行
cat parsed.ndjson | node tools/trace-hot-lines.mjs

# Top-20，展示类型分布
cat parsed.ndjson | node tools/trace-hot-lines.mjs --top 20 --by-type

# JSON 输出（接入其他工具）
cat parsed.ndjson | node tools/trace-hot-lines.mjs --json > hot.json
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

## 5. trace-call-tree.mjs — 调用树重建

根据 `call` / `return` 事件对，重建函数调用树结构，展示执行路径和深度。

### 选项

| 选项 | 说明 |
|------|------|
| `--depth N` | 限制显示深度（默认无限制）|
| `--json` | 输出 JSON 树结构，便于程序消费 |
| `--summary` | 只显示汇总统计（高频调用函数排行）|

### 示例

```bash
# 完整调用树
cat parsed.ndjson | node tools/trace-call-tree.mjs

# 限制深度为 4 层
cat parsed.ndjson | node tools/trace-call-tree.mjs --depth 4

# 只看汇总（高频调用函数）
cat parsed.ndjson | node tools/trace-call-tree.mjs --summary

# 结合 filter，只看 decode 相关路径
cat parsed.ndjson \
  | node tools/trace-filter.mjs --fn "*decode*" \
  | node tools/trace-call-tree.mjs --summary
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

## 6. trace-var-timeline.mjs — 变量时序追踪

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
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var key

# 追踪多个变量
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var x,y,result

# 只看写入（赋值轨迹）
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var key --writes

# 追踪所有变量，取前 200 条
cat parsed.ndjson | node tools/trace-var-timeline.mjs --all --limit 200
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

## 7. trace-range-extract.mjs — 区间提取

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
cat parsed.ndjson | node tools/trace-range-extract.mjs 1000-2000

# 提取 seq=5000 前后各 100 条（共 201 条上下文）
cat parsed.ndjson | node tools/trace-range-extract.mjs --context 100 5000

# 提取 seq=5000 前 50 条、后 200 条
cat parsed.ndjson | node tools/trace-range-extract.mjs --before 50 --after 200 5000

# 以文本格式查看（更易人眼阅读）
cat parsed.ndjson | node tools/trace-range-extract.mjs --context 20 --src 5000
```

---

## 8. 典型分析流程

### 混淆代码逆向分析

```bash
# 步骤 1：解析原始 trace
node tools/trace-parse.mjs --compact trace.ndjson > parsed.ndjson

# 步骤 2：找热点行，定位关键函数
cat parsed.ndjson | node tools/trace-hot-lines.mjs --top 20

# 步骤 3：看热点行附近的调用树
cat parsed.ndjson | node tools/trace-filter.mjs --line 231 \
  | node tools/trace-call-tree.mjs --depth 3

# 步骤 4：追踪关键变量的变化轨迹
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var key,result --writes

# 步骤 5：在可疑 seq 附近提取上下文
cat parsed.ndjson | node tools/trace-range-extract.mjs --context 30 8421
```

### 定位高频函数

```bash
# 只看函数调用，汇总统计
cat parsed.ndjson \
  | node tools/trace-filter.mjs --type call --no-internal \
  | node tools/trace-call-tree.mjs --summary
```

### 跟踪属性赋值链

```bash
# 找所有涉及属性 "width" 的语句
cat parsed.ndjson | node tools/trace-filter.mjs --has-var width

# 配合时序追踪查看变化过程
cat parsed.ndjson | node tools/trace-var-timeline.mjs --var width
```

---

## 9. OUTPUT_JSON_KV 与工具兼容性

`ExecutionTraceAnalysis` 通过 `OUTPUT_JSON_KV`（`src/utils/traceFormatters.js`）控制 trace kv 部分的格式：

| 模式 | 格式 | 说明 |
|------|------|------|
| `OUTPUT_JSON_KV=true`（默认）| `srcText {"w":{...},"r":{...},"f":[...]}` | 结构化 JSON，离线工具优先推荐 |
| `OUTPUT_JSON_KV=false` | `srcText ; x=1, y=2` | 传统文本，人眼阅读友好 |

`trace-parse.mjs` 自动兼容两种格式的混合输入（同一文件中可以同时出现两种格式），
转换后的统一结构：
- `w`：变量写入字典（`{ varName: value, ... }`）
- `r`：变量读取字典（`{ varName: value, ... }`）
- `f`：属性访问数组（`[{ base, offset, val, isComputed, isWrite }, ...]`）
- `kv`：传统键值对（两种格式统一回退到此字段）

后续工具（`filter`、`var-timeline` 等）同时支持 `w/r/f` 和 `kv` 字段，无需关心原始格式。
