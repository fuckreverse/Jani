# JTA 插件架构与插件清单

**版本：** v1.6  

本文档涵盖：
1. **插件架构**：接口定义、调度器设计
2. **插件清单**：Foundation / Analysis / Inference 三层所有插件

---

## 1. 插件架构

### 1.1 插件接口

```js
/**
 * 所有分析插件实现此接口
 */
class AnalysisPlugin {
    /** 插件唯一 ID */
    static id = 'plugin-id';

    /** 依赖的其他插件 ID（执行前必须已完成） */
    static deps = [];

    /** 插件描述 */
    static description = '';

    /**
     * 执行分析
     * @param {object} ctx
     * @param {string}   ctx.sessionId   当前会话 ID
     * @param {Database} ctx.db          SQLite 连接
     * @param {Function} ctx.emit        发送进度事件（供 UI 展示）
     * @returns {Promise<void>}
     */
    async run(ctx) {
        throw new Error('not implemented');
    }
}
```

### 1.2 插件调度器（Plugin Engine）

```
上传完成
   ↓
PluginEngine.schedule(sessionId, { phase: 'phase1', plugins: [F1], skipCompleted: true })
   ↓
查询 plugin_checkpoints → 跳过已完成的插件（断点恢复）
   ↓
拓扑排序（按 deps 构建 DAG）
   ↓
并发执行无依赖插件（F1、F2 同时跑）
   ↓
每个插件完成 → writeCheckpoint() 持久化到 SQLite
   ↓
依赖满足后立即触发下一批
   ↓
phase1 全部完成 → 通知 UI（type: 'all_done', phase: 'phase1'）
   ↓
自动调度 phase2（F2/F3/F4 等深度分析）在后台执行
```

调度器维护插件注册表，支持：
- **自动发现**：扫描 `plugins/` 目录自动加载
- **手动触发**：用户在 UI 中选择插件单独重跑（`POST /api/sessions/:id/re-run`）
- **断点恢复**：`skipCompleted: true`（默认）时跳过已有检查点的插件，重启或中断后自动续跑
- **强制重跑**：`POST /api/sessions/:id/re-run` 带 `forceRerun: true` 时清除检查点后全量重跑
- **分阶段调度**：Phase1（F1 基础解析）→ 会话创建完成 → Phase2（F2/F3/F4 等深度分析）自动后台执行

### 1.3 `schedule()` 选项

| 参数 | 类型 | 说明 |
|------|------|------|
| `plugins` | `string[]` | 插件 ID 列表（默认全部已注册插件）|
| `onProgress` | `Function` | 进度回调 `(event) => void` |
| `dataDir` | `string` | 会话数据目录 |
| `phase` | `string` | 阶段标记（`'phase1'`/`'phase2'`/`'manual'` 等）|
| `skipCompleted` | `boolean` | 是否跳过已完成的插件（默认 `true`，断点恢复模式）|

### 1.4 `onProgress` 事件类型

| type | 说明 |
|------|------|
| `schedule_start` | 调度开始，携带 `toRun`、`skipped` 列表 |
| `plugin_start` | 单个插件开始执行 |
| `plugin_progress` | 插件内部进度更新（如 F1 处理事件数） |
| `plugin_done` | 单个插件完成，携带 `durationMs` |
| `plugin_error` | 插件执行失败 |
| `all_done` | 当前 phase 全部插件完成 |

---

## 2. 插件清单

### 第一层：Foundation（基础数据插件）

#### F1 · EventIndex
- **依赖：** 无
- **输入：** `.bin` 文件
- **功能：** 解析二进制 trace，写入 `events / writes / reads / fields / value_dict` 表
- **输出：** 数据库填充完成
- **值字典机制：** 内存 `Map<val_text, id>` 去重，内存计数器分配 ID（避免 N+1 查询），
  `INSERT OR IGNORE` 保证幂等；`writes/reads/fields.value_id` 同步填充

#### F2 · SmapLoader
- **依赖：** 无
- **输入：** `.smap.json` 文件
- **功能：** 解析 smap，写入 `smap` 表
- **输出：** iid → 行列/srcText 映射可查

#### F3 · CallGraphBuilder
- **依赖：** F1
- **功能：** 配对 `CALL_PRE/CALL` 事件，重建调用栈，计算调用深度
- **输出：** `call_edges` 表

#### F4 · VariableLifetime
- **依赖：** F1
- **功能：** 统计每个变量的首次写入/最后读取/读写次数
- **输出：** `var_lifetime` 表（持久化到 SQLite）

#### F5 · ScriptScopeAnalyzer
- **依赖：** F1, F2
- **功能：**
  - 基于 SCRIPT_ENTER / CALL_PRE / CALL 事件重建作用域树
  - 识别变量是全局变量、闭包变量还是函数局部变量
  - 为每个变量的 write 事件标注作用域归属
  - 提高 TaintTracker（A1）和 DataFlowGraph（A2）的分析精度
- **输出：** `scopes` 表（scope_id, parent_scope_id, fn_iid, fn_name, start_seq, end_seq）；`var_lifetime.scope` 字段由本插件填充

---

### 第二层：Analysis（分析插件）

#### A1 · TaintTracker ⭐
- **依赖：** F1, F4, F5
- **功能：** 给定 source 变量（或事件），BFS 追踪数据流向
  - **正向**：source → 所有受影响变量 → 函数参数 → 返回值
  - **反向**：给定 sink 变量，反向找所有来源
- **追踪范围：** 同时覆盖三类数据源
  - 局部/全局变量：`writes` / `reads` 表（`name` 字段）
  - 对象属性：`fields` 表（`base.offset` 形式，如 `obj.key`、`arr[i]`）
  - 函数返回值：`call_edges.return_value`（追踪函数调用的返回数据流）
  - 注意：同名变量在不同作用域下视为不同节点（依赖 F5 的 `scopes` 数据区分）
- **输出：** `taint_paths` 表 + 可视化 DAG

#### A2 · DataFlowGraph
- **依赖：** F1, F3, F5
- **功能：** 构建过程内 + 过程间 def-use 图
- **输出：** 数据流图（JSON），供前端 Cytoscape 渲染

#### A3 · HotPathAnalyzer
- **依赖：** F1, F2
- **功能：** 
  - 按 iid 统计执行次数，输出热力图数据
  - 检测循环：同一 iid 在连续 seq 中重复出现
  - 标注循环边界（起始 seq、终止 seq、迭代次数）
- **输出：** `hot_iids` 视图 + `loops` 表

#### A4 · StringTracker
- **依赖：** F1
- **功能：**
  - 过滤所有字符串类型的 writes
  - 追踪字符串拼接链（`'a' + b` → `'ab'`）
  - 标记疑似编码操作（base64 字符集、hex 字符集）
- **输出：** `string_events` 视图

#### A5 · LoopDetector
- **依赖：** A3
- **功能：**
  - 识别每个循环的迭代变量（如 `i`）
  - 展开每轮迭代的变量快照
  - 可视化：迭代 × 变量值的二维表格
- **输出：** `loop_iterations` 表

#### A7 · ObjectMutationTracker
- **依赖：** F1
- **功能：**
  - 按 `(base, offset)` 重建对象属性的变化时间线
  - 识别"配置对象"（大量 putField 且结构稳定）
- **输出：** `object_timelines` 表

#### A8 · ValuePatternDetector
- **依赖：** F1
- **功能：**
  - 扫描所有 writes，检测反复出现的固定字节模式（魔术常数、固定 IV、固定 key）
  - 检测整数常量集合是否匹配已知密码学常数（AES S-box、MD5/SHA 初始向量等）
  - 输出每个高频值的出现次数、所在行、关联变量名
- **输出：** `value_patterns` 表（value_hash, count, first_seq, iid, matched_constant）

---

### 第三层：Inference（推理插件）

#### I1 · CryptoDetector ⭐
- **依赖：** A3, A5, A4, A8
- **检测规则：**
  - **AES**：16/32 字节数组 key + S-box 查表模式（特定整数常量集合）
  - **MD5/SHA**：魔术常数检测（`0x67452301`, `0xEFCDAB89` 等）
  - **XOR 流密码**：大量 XOR 操作 + 循环 + 固定 key
  - **Base64**：字符集 `A-Za-z0-9+/=` 的映射操作
  - **RC4**：256 字节 S-box 初始化模式
  - 综合 A8（ValuePatternDetector）的值层面检测结果进行最终算法判定
- **输出：** `crypto_hints` 表（iid, algorithm, confidence, evidence）

#### I2 · SignatureAnalyzer ⭐
- **依赖：** A1, A4
- **功能：**
  - 定位 HTTP 请求构造点（headers/body 的 putField）
  - 反向追踪 `sign/token/timestamp/nonce` 字段的来源
  - 还原完整签名计算路径（输入 → 中间步骤 → 最终值）
- **输出：** `signature_paths` 表 + 可读报告

#### I3 · ObfuscationDetector
- **依赖：** A2, A3, F2
- **检测：**
  - 变量名熵值（短/随机变量名 = 高熵）
  - 字符串解密函数识别（一函数多次调用返回不同字符串，`fn_name` 字段记录供 UI 跳转）
  - 控制流混淆（大 switch + 单循环变量；高事件密度提示）
- **输出：** `obfuscation_hints` 表（含 `hint_type`、`description`、`confidence`、`fn_name` 字段）

#### I4 · AlgorithmSummarizer
- **依赖：** I1, A1, A5
- **功能：** 汇总所有 Inference 结论，生成人类可读摘要
  - 示例："函数 `_0x1a2b` 是 AES-128 加密，key 来自变量 `secret`（第 42 行赋值），被 `sign()` 调用"
  - 可选：接入 LLM 做进一步语义解释
- **输出：** `analysis_summary`（JSON 报告 + Markdown 文本）

---

## 3. 插件进度展示（ProgressDrawer）

上传后，UI 实时显示插件执行进度。`ProgressDrawer.vue` 是一个侧边抽屉组件，提供：

- **总体进度条**：已完成插件数 / 总插件数
- **分阶段进度**：Phase1（基础解析）/ Phase2（深度分析）分组展示
- **插件状态列表**：每个插件的运行状态和耗时

```
✅ F1 EventIndex      (1.2s,  52,341 events)
✅ F2 SmapLoader      (0.1s,  234 iids)
✅ F3 CallGraphBuilder(0.8s,  1,203 calls)
⏳ A1 TaintTracker    (running...)
⏸  I1 CryptoDetector  (waiting for A3, A5)
⬛ F4 VariableLifetime (skipped，已完成)
```

**触发方式：**
- 上传新 trace 后自动打开
- 在会话列表页点击进行中会话旁的"⚡ 进度"按钮手动打开
- 会话详情页顶部内联进度条实时更新（不需要打开侧边抽屉）

**WebSocket 初始化消息**（`type: 'init'`）现在额外携带 `checkpoints` 字段，
供抽屉初次打开时立即显示历史已完成插件的状态，无需等待下一轮事件推送。
