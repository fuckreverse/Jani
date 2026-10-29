# JTA 插件架构与插件清单

**版本：** v1.7  

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

    /** 可选输入：已存在时跟踪失效；缺失时不要求执行 */
    static observes = [];

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
上传完成 → analyzeSession（一个后台任务覆盖所有阶段）
   ↓
Phase1：F1 + 可选 F2 → 等待本阶段 schedule() Promise 完成
   ↓
Phase2：F3 / F4 / A3 → Phase3 → Phase4（按 selectedPlugins 选择）
   ↓
全部阶段成功 → ready；任一阶段失败 → failed，不执行后续阶段

各阶段内部：输入指纹 → 补齐依赖 → 拓扑排序 → 串行插件事务 → 检查点
进度事件只用于展示；all_done 表示当前阶段完成，不驱动阶段衔接。
```

调度器维护插件注册表，支持：
- **自动发现**：扫描 `plugins/` 目录自动加载
- **手动触发**：用户在 UI 中选择插件单独重跑（`POST /api/sessions/:id/re-run`）
- **断点恢复**：`skipCompleted: true`（默认）时跳过已有检查点的插件，重启或中断后自动续跑
- **强制重跑**：`POST /api/sessions/:id/re-run` 带 `forceRerun: true` 时在任务执行中重跑目标插件，并使下游检查点失效
- **分阶段调度**：Phase1（F1 + 可选 F2）→ Phase2（F3/F4/A3）→ 选中的 Phase3/4；流程定义集中在 SessionAnalysis.mjs

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
  - `writes/reads/fields` 表**不再存储冗余 `value` 列**，统一通过 `value_id` JOIN `value_dict` 获取完整值
  - 同时从 `CALL_PRE` 事件读取 `fnDefIid` 字段，供 F3 填充 `call_edges.fn_def_iid`
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
- **输出：** `call_edges` 表（含 `fn_def_iid` 列，记录函数定义点 IID；支持精确区分同名但定义位置不同的函数）

#### F4 · VariableLifetime
- **依赖：** F1
- **功能：** 统计每个变量的首次写入/最后读取/读写次数
- **输出：** `var_lifetime` 表（持久化到 SQLite）

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
- **依赖：** F1
- **功能：** 构建变量级 def-use 数据流图；支持子图 BFS 查询（从指定节点出发，返回 N 跳可达子图）
- **输出：** 会话目录下的独立 SQLite 边分片及 catalog.sqlite；dataflow_graphs 保存原子发布指针。旧会话兼容 dataflow_edges 表。子图结果供前端 Cytoscape 渲染。

#### A3 · HotPathAnalyzer（v3）
- **依赖：** F1
- **功能：**
  - 按 iid 统计执行次数，输出热力图数据
  - **函数边界感知**循环检测：每次循环检测在单次函数调用的 own-event 窗口内进行，避免将子函数内重复执行的 iid 误判为本函数循环
  - **自适应阈值**循环分段：median 间距 × SPLIT_FACTOR 分割 + MERGE_FACTOR 合并
  - **嵌套循环识别**：帧内局部推导被包含循环的父子关系
  - `loops` 表写入 `call_edge_id`/`fn_name`（循环所属函数调用帧）、`loop_depth`（嵌套深度）、`body_size`（循环体 iid 数）
- **输出：** `iid_counts` 表 + `loops` 表

#### A5 · LoopDetector（v2）
- **依赖：** A3
- **功能：**
  - 识别每个循环的迭代变量（如 `i`）
  - 展开每轮迭代的变量 **读/写快照**（writes + reads 双快照，v2 新增）
  - 支持迭代间变量变化高亮和跳转事件流查看循环起始位置
- **输出：** `loop_iterations` 表

#### A7 · ObjectMutationTracker
- **依赖：** F1
- **功能：**
  - 按 `(base_oid, offset)` 重建对象属性的变化时间线
  - 识别"配置对象"（大量 putField 且结构稳定）
  - 支持按对象名和属性名模糊搜索，以及读/写操作类型过滤
- **输出：** `object_timelines` 表

#### A8 · ValuePatternDetector
- **依赖：** F1
- **功能：**
  - 扫描所有 writes，检测反复出现的固定字节模式（魔术常数、固定 IV、固定 key）
  - 检测整数常量集合是否匹配已知密码学常数（AES S-box、MD5/SHA 初始向量等）
  - 为每个高频值标注**语义类型标签**：`crypto_constant`（密码学常数）、`int_array`、`string`、`timestamp` 等
  - 计算字符串值的 **Shannon 熵**（识别高随机性内容，如密文/密钥）
- **输出：** `value_patterns` 表（含 `pattern_type` 语义标签和 `entropy` 熵值字段）

---

### 第三层：Inference（推理插件）

#### I1 · CryptoDetector ⭐
- **依赖：** A3, A5, A8
- **检测规则：**
  - **魔术常数特征**：AES/DES/3DES/RC4/MD5/SHA1/SHA256/SHA512/SHA3/Blowfish/ChaCha20/RIPEMD-160/CRC32 等 20+ 算法魔术常数匹配
  - **库调用特征**：Web Crypto API / Node.js crypto / CryptoJS / forge / sjcl / jsonwebtoken / TweetNaCl / bcrypt.js / elliptic / @noble 等
  - 综合 A8（ValuePatternDetector）的值层面检测结果进行最终算法判定
- **输出：** `crypto_hints` 表（iid, algorithm, confidence, evidence）

#### I2 · SignatureAnalyzer ⭐
- **依赖：** F1；可选观察 F2 的源码映射。它自行反向追踪 reads/writes，不依赖需要查询参数的 A1。
- **功能：**
  - 定位 HTTP 请求构造点（headers/body 的 putField）
  - 反向追踪 `sign/token/timestamp/nonce` 字段的来源
  - 还原完整签名计算路径（输入 → 中间步骤 → 最终值）
- **输出：** `signature_paths` 表 + 可读报告

#### I3 · ObfuscationDetector
- **依赖：** F1, A3
- **检测维度（8 类）：**
  1. `short_var` — 短/混淆风格变量名（`_0x...` 或 ≤ 3 字符）
  2. `high_entropy_name` — 高 Shannon 熵变量名（随机混淆命名）
  3. `string_decoder` — 字符串解密函数（多次调用返回不同字符串 + 参数全整数索引加强验证）
  4. `obfuscated_control_flow` — 控制流混淆（CFF/VMP 统一，大 switch + 循环变量）
  5. `deep_call_stack` — 深调用栈（CFF/VMP dispatch 调用极深）
  6. `string_pool` — 字符串池（大数组只读变量，经典字符串池混淆）
  7. `dynamic_eval` — 动态代码执行（`eval`/`Function` 构造器调用）
  8. `var_reuse` — 变量名重用率异常（同名变量频繁写入且值域极分散）
- **输出：** `obfuscation_hints` 表（含 `hint_type`、`description`、`confidence`、`fn_name` 字段）

#### I4 · AlgorithmSummarizer
- **依赖：** A3、I3；可选观察 F3/F4/A5/A7/A2/I1，已运行的输入变化时汇总检查点失效。
- **功能：** 汇总所有 Inference 结论，生成人类可读摘要
  - 整合加密检测、签名分析、混淆检测、循环、值模式结果生成 Markdown 报告
  - 报告内容包含：算法判定、置信度、关联似乎可相证的数据流路径
- **输出：** `analysis_summary` 表（JSON 报告 + Markdown 文本）

#### I5 · WebApiDetector ★
- **依赖：** F1, F3
- **功能：** 检测运行时对浏览器宿主对象（BOM/DOM）的属性访问与方法调用
  - **检测范围**：document / window / navigator / location / localStorage / sessionStorage / XMLHttpRequest / fetch / performance / console / URL / Worker / EventSource / WebSocket / Canvas / AudioContext / WebGL / IndexedDB / Notification / Geolocation 等 20+ 类宿主对象
  - **三级置信度**：
    - `confirmed` — `fields.base_oid` 通过 `oid_aliases` 精确匹配已知宿主对象变量名
    - `propagated` — 同一 OID 曾被 inferred 路径确认，后续访问传播此结论
    - `inferred` — 仅靠高专属性属性名/方法名启发式匹配
  - **属性名选定原则**：只收录命名高度专属的属性名，排除所有通用方法名（`open/close/send/get/set` 等）防止误报
- **输出：** `web_api_calls` 表（session_id, event_id, call_edge_id, category, host_obj, property_name, access_type, confidence_level, receiver_var, args_json, return_value, line, src_text）

---

## 3. 插件进度展示（ProgressDrawer）

上传后，UI 实时显示插件执行进度。`ProgressDrawer.vue` 是一个侧边抽屉组件，提供：

- **总体进度条**：已完成插件数 / 总插件数
- **分阶段进度**：Phase1（基础解析）/ Phase2（深度分析）分组展示
- **插件状态列表**：每个插件的运行状态和耗时

```
✅ F1 EventIndex       (1.2s,  52,341 events)
✅ F2 SmapLoader       (0.1s,  234 iids)
✅ F3 CallGraphBuilder (0.8s,  1,203 calls)
⏳ A1 TaintTracker     (running...)
⏸  I1 CryptoDetector  (waiting for A3, A5)
⏸  I5 WebApiDetector  (waiting for F1, F3)
⬛ F4 VariableLifetime (skipped，已完成)
```

**触发方式：**
- 上传新 trace 后自动打开
- 在会话列表页点击进行中会话旁的"⚡ 进度"按钮手动打开
- 会话详情页顶部内联进度条实时更新（不需要打开侧边抽屉）

**WebSocket 初始化消息**（`type: 'init'`）现在额外携带 `checkpoints` 字段，
供抽屉初次打开时立即显示历史已完成插件的状态，无需等待下一轮事件推送。

## 调度可靠性更新

默认由后台 worker 串行执行写任务。每个插件的输出及检查点在同一事务提交；失败回滚并阻断依赖。
进度通知只有提交后才发送 plugin_done。检查点必须未过期且输入/实现/配置指纹一致。
重跑保留最后一次已提交结果，session failed 表示本次请求未全部成功。

## 有界图处理

A2 使用源 SQLite 游标和最近定义索引生成边；默认每批 1,000 条、每片 100,000 条。
A1 污点分析按当前前沿查索引，不再把全会话读写加载到 Map。两者保留语句级分析精度。
图读取器按目录定位邻接文件并限制打开句柄，详见 [Disk-Sharded-Graph.md](Disk-Sharded-Graph.md)。

## 接入新分析模块前的执行契约

- `analyzeSession()` 将整条阶段流程作为一个队列任务，其他同会话任务在流程结束前被拒绝；不同会话仍按 SQLite 单写者规则排队。
- `runSinglePlugin()` 与批量调度共用输入指纹、依赖检查、事务和失效规则；仅强制重跑目标插件，查询参数只传给目标插件。
- `deps` 是必需输入；`observes` 是可选输入。两者参与排序与下游失效。可选输入不存在时不自动生成，已有但过期时会先重建。
- F2 重跑使消费源码映射的插件失效，再沿依赖关系传播；I4 的可选产物失效同样传播。
- `ctx.onCommit(fn)` 用于提交后的资源释放，`ctx.onRollback(fn)` 用于失败清理；提交后的清理失败记录日志，不撤销已经提交的结果。
- 预处理、插桩、源码运行、分析 worker 共用 `runner.maxConcurrency` 活动预算与 `runner.maxQueue` 等待预算；分析另受 `analysis.maxQueue` 待处理会话上限约束。
- 关闭数据库前等待 `drainAnalysis()`，确保 worker 已退出、队列已释放且文件清理完成。
