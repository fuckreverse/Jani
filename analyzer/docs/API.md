# JTA REST API 与 WebSocket 协议

**版本：** v1.6  

本文档是 JTA Server（默认端口 33000）所有对外接口的完整参考。

---

## 1. REST API

### 工作空间（Projects）

```
POST /api/projects
    上传原始 JS，创建工作空间，异步触发（预处理+）插桩
    body: multipart/form-data { source, name? }
    options:    JSON 字符串，支持 target/sourceType/sandboxVar/inlineIid/inlineSource/
                wsUrl/wsSab（浏览器 target 时注入 projectId）等插桩选项
    preprocess: JSON 字符串，预处理选项，见下方 preprocess 结构说明
    返回：{ projectId, status: 'instrumenting' }

GET  /api/projects
    列出所有工作空间
    返回：[{ id, name, created_at, updated_at, status, iid_count, error_msg }]

GET  /api/projects/:id
    工作空间详情 + 关联会话列表
    返回：{ ...project, sessions: [...], instrumented_size, smap_size, preprocessed_size }

DELETE /api/projects/:id
    删除工作空间（目录 + 数据库记录；关联会话的 project_id 置为 null，不删除会话本身）
    返回：{ deleted: true }

POST /api/projects/:id/fork
    复用源文件重新插桩，创建新工作空间（无需再次上传文件）
    body: { name?, options?, preprocess? }
    返回：{ projectId, status: 'instrumenting' }

GET  /api/projects/:id/progress
    查询插桩进度（轮询备选；推荐使用 WS /ws/projects/:id/progress）
    返回：{ id, status, iid_count, error_msg, updated_at }

GET  /api/projects/:id/instrumented
    下载插桩后代码（.js 文件）

GET  /api/projects/:id/preprocessed
    下载预处理后代码（`_preprocessed_.js`）；若未启用预处理，返回 404

GET  /api/projects/:id/smap
    下载 smap.json

POST /api/projects/:id/sessions
    上传 trace.bin，基于此工作空间的 smap 创建分析会话
    body: multipart/form-data { bin, name? }
    说明：工作空间必须处于 ready 状态才能上传 trace；
          会话源码文件优先使用预处理后代码（preprocessed_path），回退到原始源码
    返回：{ sessionId, status: 'parsing', projectId, smapAvailable: bool }

GET  /api/projects/:id/sessions
    列出该工作空间下的所有分析会话
    返回：[{ id, name, created_at, status, event_count, plugin_status }]
```

**preprocess 选项结构**（在 `/api/projects` POST/fork 和 `/api/instrument` POST/run 中均可使用）：
```
preprocess: {
    enabled:       boolean,          -- 是否启用预处理
    preset:        'deobfuscate' | 'normalize-arrow' | 'transpile' | 'full',
    sourceType:    'script' | 'module',
    deobfuscate?:  { replaceVoid?, foldConstants?, splitSequence?,
                     simplifyBoolean?, expandConditional? },
    normalizeArrow?: { preserveThis?, onlyExpression? },
    transpile?:    { targets: 'es2015' | 'es2017' | 'es2020' | 'es2022' }
                   -- 年份标识在后端被映射为 browserslist 查询
                   -- es2015 → chrome 49 / es2017 → chrome 58 / es2020 → chrome 80 / es2022 → chrome 103
}
```

---

### 插桩工作台

```
POST /api/instrument
    插桩源码，返回插桩后代码 + smap
    body:  { code, filename, options }
    返回:  { instrumentedCode, smapJson, mapJson }

POST /api/instrument/run
    在服务端沙箱执行插桩后代码（需 --execution-trace）
    body:  { code, filename, options, env: 'node' | 'jsdom' }
    返回:  { runId }  （立即返回，不等待执行完成；通过 WS 或轮询获取结果）

GET  /api/instrument/run/:runId
    查询运行任务状态
    返回：{ status, stdout, stderr, exitCode, sessionId, durationMs }
```

---

### 分析会话

```
POST /api/sessions
    上传 .bin + .smap.json（可选）+ 原始 .js（可选），创建新会话
    body: multipart/form-data { bin, smap?, source?, name? }
    说明：
      - 创建时先执行 Phase1（F1 EventIndex），会话立即返回；Phase2（F3/F4/A3）自动后台调度
      - .smap.json 为可选。缺失时 F2 SmapLoader 跳过，iid → 行列映射不可用，
        srcText 字段为空，但事件流（事件类型、writes/reads/fields）仍完整可用。
      - 原始 .js 为可选。有则显示在代码视图中，无则代码视图降级为纯事件列表。
      - 上传文件大小限制：1 GB
    返回：{ sessionId, status: 'parsing', smapAvailable: bool }

GET  /api/sessions
    列出所有会话（含 project_id 字段）

GET  /api/sessions/:id
    会话详情 + 插件执行状态 + 文件信息（fileInfo: binFile/smapFile/sourceFile）+ smapCount

DELETE /api/sessions/:id
    删除会话及所有关联数据（文件 + 数据库各表的 session_id 行）
    返回：{ deleted: true }

GET  /api/sessions/:id/checkpoints
    查询插件断点恢复状态
    返回：{ checkpoints: [{ plugin_id, phase, completed_at, duration_ms }] }

GET  /api/sessions/:id/event-types
    返回该会话所有事件类型及其数量
    返回：{ types: [{ type, cnt }] }

POST /api/sessions/:id/re-run
    重新运行分析插件（支持断点续跑或强制重跑）
    body: { forceRerun?: boolean, phase?: 'phase1'|'phase2'|'phase3'|'phase4', plugins?: string[] }
    说明：
      - forceRerun=true 时清除检查点后全量重跑
      - forceRerun=false（默认）时跳过已完成的插件（断点续跑）
      - 也可传 plugins 数组指定具体插件 ID 列表
    返回：{ status: 'scheduled', plugins, phase, forceRerun }

GET  /api/sessions/:id/events?line=42&type=END_EXPR&types=CALL_PRE,CALL&limit=100&cursor=<last_seq>
    查询事件（支持多维过滤）
    分页机制（混合策略）：
      游标分页（普通浏览）：传 cursor=<上页末尾 seq>，后端 id > cursor，O(log N) B-tree 定位
        第一页：不传 cursor（或 cursor=0）；响应包含 nextCursor 供下一页使用
        响应：{ events, count, hasMore, nextCursor: <末页为 null> }
      seqFrom 定位（跨 Tab 跳转）：传 seqFrom=<目标 seq>，后端 id >= seqFrom，直接定位
        前端 EventsTab 跨 Tab 跳转专用；跳转后若翻页，游标从当前页末尾重新计算
      offset 分页（向后兼容）：cursor 未传时生效；不推荐用于深页
    types 参数：多类型过滤（逗号分隔），优先于 type（向后兼容）
    events.type 为整数编码（Phase D），API 响应已自动解码为字符串
    事件对象 fields 数组项：base 字段已改为 baseOid（运行时对象 ID，null 表示未知）

GET  /api/sessions/:id/functions?search=&minCalls=1&minEvents=&maxEvents=&hideBuiltin=0&sortBy=call_count&limit=100&offset=0
    查询函数调用统计（聚合 call_edges 按 fn_name + fn_iid 分组）
    返回：{ functions: [{ fn_name, fn_iid, call_count, event_count, avg_own_event_count, min_line, ... }], total }
    hideBuiltin=1：过滤 JS 内建函数名
    sortBy=event_count：按平均自身事件数排序（衡量函数复杂度）
    minEvents/maxEvents：按 own_event_count 范围过滤（对旧数据降级为 return_seq-call_seq 近似）

GET  /api/sessions/:id/functions/:fnName/calls?limit=200&offset=0&fnIid=&callSeq=
    查询某函数所有调用记录（含参数、返回值、SEQ 范围）
    fnIid：按 fn_iid 精确过滤，区分同名不同位置的函数
    callSeq：自动定位到包含该调用的分页（前端无需手动翻页）
    返回：{ calls: [{ id, call_seq, return_seq, depth, args, return_value, ... }], total, offset }

GET  /api/sessions/:id/calls/:callId/own-events?limit=50&offset=0
    查询单次调用自身事件流（排除子调用事件），支持分页
    返回：{ events: [...], total, ownEventCount }

GET  /api/sessions/:id/functions/:fnName/callers?fnIid=&limit=100&offset=0
    反向调用图：查询调用了指定函数的所有调用者（按调用次数降序）
    fnIid：同名不同位置的函数精确 iid 过滤（可选）
    实现：以 call_edges 的 depth/call_seq/return_seq 字段做 CTE 父帧关联，O(log N) 索引扫描
    返回：{
      callers: [{ callerFnName, callerFnIid, callCount, calleeMinLine,
                  callerMinDepth, callerMaxDepth, callerMinLine }],
      total,
      totalCalls   -- 目标函数被调用总次数（用于前端显示百分比）
    }
    说明：顶层调用（depth=0）的调用者 callerFnName = '(top-level)'

GET  /api/sessions/:id/call-stack?callSeq=N&returnSeq=M&depth=D
    查询某次函数调用的完整调用栈（祖先帧列表，按深度升序）
    返回：{ stack: [{ fnName, fnIid, callerLine, depth, args, returnValue, callSeq, returnSeq }] }

GET  /api/sessions/:id/events/:seq/owner-fn
    查询某个事件所属的最近函数帧（包含该 seq 的 depth 最大的 call_edge）
    返回：{ call: { fnName, fnIid, callerLine, depth, callSeq, returnSeq, ... } } 或 null

GET  /api/sessions/:id/flamegraph?seqFrom=&seqTo=&maxDepth=20&minSelf=0
    生成 Speedscope 兼容的火焰图 JSON（可直接导入 speedscope.app）
    seqFrom/seqTo：时间窗口过滤（可选，不传则覆盖全量 trace）
    maxDepth：最大调用深度（默认 20）；minSelf：过滤 self time 过小的函数（默认 0，不过滤）
    实现：查询 call_edges → Node.js 端重建调用树 → 计算 total/self time → 拼装 Speedscope JSON
    返回：Speedscope $schema 格式 JSON，profiles[0] 为 sampled profile

GET  /api/sessions/:id/cfg?rootFn=&depth=3&minCount=10&foldLoops=true&includeIids=true
    动态控制流图（Dynamic CFG）— 基于真实执行数据的函数调用拓扑图
    rootFn：以指定函数名为根（仅返回其子树），不填返回完整 CFG
    depth：展开深度（默认 3，最大 8）
    minCount：iid_counts 执行次数阈值，过滤低频节点（默认 10）
    foldLoops：是否折叠循环块（默认 true）
    includeIids：是否显示热点 IID 节点（默认 true）
    返回：{
      nodes: [{ id, type: 'function'|'loop'|'hotspot', fnName?, fnIid?, callCount?,
                minLine?, hasLoop?, iid?, totalIters?, count?, srcText?, isRoot? }],
      edges: [{ source, target, count, type: 'call'|'loop' }],
      stats: { nodeCount, edgeCount, fnCount, hotspotCount, loopCount }
    }

GET  /api/sessions/:id/fn-cfg?fnName=&maxCalls=20
    IDA 风格单函数内部控制流图（基本块 + 块间跳转边）
    fnName：目标函数名（必填）
    maxCalls：采样调用次数上限（默认 20，最大 100）
    实现：采样 N 次调用 → union 自身事件的 iid 序列 → 按行号分块 → 统计块间 iid 转移频率 → 构建边
    返回：{
      fnName, totalCalls, sampledCalls,
      blocks: [{ id, iids, lines, srcTexts, execCounts, presence, subCalls, isEntry }],
      edges:  [{ source, target, count, type: 'sequential'|'branch'|'loop_back' }],
      stats:  { blockCount, edgeCount, iidCount }
    }

GET  /api/sessions/:id/value-search?num=0.5&str=foo&strLike=*secret*&varName=key&source=write&limit=200
    按值搜索 value_index 表，返回匹配的 event_id 列表
    支持：num（精确数值）/ numMin+numMax（数值范围）/ str（精确字符串）/ strLike（通配符，* 匹配任意）/ varName（按变量名过滤）
    返回：{ matches: [{ event_id, val_type, val_num, val_str, var_name, source }], count }

GET  /api/sessions/:id/value-search/events?num=0.5&varName=key&offset=0&limit=50
    值搜索 + 事件详情合并接口（一次请求完成"按值找事件"并返回完整事件数据）
    解决原方案"取 min/max 范围 + 前端二次过滤"的分页不准问题
    参数与 value-search 相同，额外支持 offset/limit 分页
    返回：{ events: [...], total, count, hasMore }

GET  /api/sessions/:id/value-dict/stats
    值字典统计信息（value_dict 表）
    返回：{ total, byType: { num, str, bool, null, obj }, topValues: [{ val_text, val_type, refCount }] }
    refCount = 该值在 writes+reads+fields 中被引用的总次数

GET  /api/sessions/:id/value-dict?type=num&text=foo&numMin=0&numMax=100&offset=0&limit=50&withRefCount=false
    查询值字典条目，支持：
      type（按 val_type 过滤）/ text（精确文本匹配）/ numMin+numMax（数值范围，仅 type=num）
      offset+limit（分页）/ withRefCount=true（附带引用计数，需 JOIN writes/reads/fields，较慢）
    返回：{ entries: [{ id, val_text, val_type, val_num, refCount? }], total, hasMore }

GET  /api/sessions/:id/taint?var=key&direction=forward
    触发/获取污点追踪结果

GET  /api/sessions/:id/hot-iids
    热路径数据（iid 执行次数统计）

GET  /api/sessions/:id/call-graph
    调用图数据

GET  /api/sessions/:id/loop-iterations?seqFrom=&seqTo=&limit=200&offset=0
    循环迭代快照数据（A5 LoopDetector 输出）
    seqFrom/seqTo：时间窗口过滤，只返回循环起始 seq 在该范围内的记录（可选）
    返回：{ iterations: [{ loopIid, round, seq, vars }], total }

GET  /api/sessions/:id/value-patterns?seqFrom=&seqTo=&limit=200&offset=0
    值模式检测结果（A8 ValuePatternDetector 输出，35+ 魔术常数）
    seqFrom/seqTo：时间窗口过滤，只返回 event_id 在该范围内的记录（可选）
    返回：{ patterns: [{ event_id, name, value, matched_constant, category }], total }

GET  /api/sessions/:id/strings?seqFrom=&seqTo=&limit=500&offset=0
    字符串追踪结果（A4 StringTracker 输出）
    seqFrom/seqTo：时间窗口过滤（可选）
    返回：{ strings: [{ event_id, name, value, length }], total }

GET  /api/sessions/:id/object-timelines?seqFrom=&seqTo=&limit=200&offset=0
    对象属性变化时间线（A7 ObjectMutationTracker 输出）
    seqFrom/seqTo：时间窗口过滤，只返回 seq 在该范围内的记录（可选）
    返回：{ timelines: [{ base_var, seq, mutation_type, offset, value, src_text }], total }

GET  /api/sessions/:id/dataflow?seqFrom=&seqTo=&limit=200&offset=0
    数据流边（A2 DataFlowGraph 输出）
    seqFrom/seqTo：时间窗口过滤，只返回 from_seq 在该范围内的记录（可选）
    返回：{ edges: [{ from_seq, to_seq, var_name, from_line, to_line }], total }

GET  /api/sessions/:id/crypto-hints
    加密检测结果

GET  /api/sessions/:id/summary
    AlgorithmSummarizer 输出

GET  /api/sessions/:id/bookmarks
    列出书签

POST /api/sessions/:id/bookmarks
    创建书签 { seq, label, note }

DELETE /api/sessions/:id/bookmarks/:bid
    删除书签
```

---

### Trace 收集

```
GET  /api/trace/stats
    获取 WebSocket Trace 收集统计（连接数、批次数、事件数、字节数、运行时间）
    返回：{ connections, batchesReceived, eventsReceived, bytesReceived, uptime, tracesDir }

GET  /api/trace/files?q=xxx&offset=0&limit=100
    列出 traces 目录中的 .bin 文件（支持搜索和分页）
    返回：{ files: [{ name, alias, projectId, projectName, size, mtime }], total, offset, limit }

PUT  /api/trace/files/:name
    设置 trace 文件别名（不改磁盘文件名）
    body: { alias: 'my-trace-name' }
    返回：{ ok: true, name, alias }

DELETE /api/trace/files/:name
    删除 trace 文件（同时删除对应 .smap.json 及别名/映射记录）
    返回：{ ok: true, deleted: name }

POST /api/trace/files/batch-delete
    批量删除 trace 文件
    body: { names: ['trace_xxx.bin', ...] }
    返回：{ deleted: [...], errors: [...] }

GET  /api/trace/files/:name/download
    下载 trace 文件（二进制流）

POST /api/trace/import
    将 traces 目录中的 .bin 文件导入为新分析会话
    body: { filename: 'trace_xxx.bin', name?: 'session-name', projectId?: '...' }
    说明：指定 projectId 时自动关联工作空间的 smap 和源码
    返回：{ sessionId }

GET  /api/health
    健康检查
    返回：{ status: 'ok', version, uptime }
```

---

### 空间分析

```
GET  /api/storage/stats
    扫描 data 目录（uploads / sessions / projects），统计各分类文件占用，生成清理建议
    返回：{
        summary: {
            totalSize, totalSizeStr,
            breakdown: {
                uploads:  { size, sizeStr, count },
                sessions: { size, sizeStr, count },
                projects: { size, sizeStr, count },
                database: { size, sizeStr }
            }
        },
        uploads:  [{ type, path, name, size, sizeStr, mtime, ageStr, orphan }],
        sessions: [{ type, id, path, name, size, sizeStr, fileCount, status, eventCount,
                     projectId, createdAt, mtime, ageStr, orphan }],
        projects: [{ type, id, path, name, size, sizeStr, fileCount, status, iidCount,
                     createdAt, mtime, ageStr, orphan }],
        suggestions: [{
            id, priority: 'high'|'medium'|'low'|'info', category, title, description,
            savedSize, savedSizeStr,
            items: [{ path, name?, id?, size, sizeStr, ageStr }]
        }]
    }
    清理建议 ID 说明：
        orphan-uploads   — 孤立 uploads 临时文件（未被任何 session/project 引用）
        orphan-sessions  — 孤立 session 目录（目录存在但 DB 无记录）
        orphan-projects  — 孤立 project 目录（同上）
        failed-projects  — 插桩失败的工作空间
        old-sessions     — 30 天未使用的大型会话（>1MB）
        all-clean        — 无需清理（info 级别正面提示）

POST /api/storage/delete
    批量删除：uploads 孤立文件、session 目录、project 目录
    body: { items: [{ type: 'upload'|'session_dir'|'project_dir', path, id? }] }
    安全约束：path 必须在 data/ 目录内；不可删除 DB 文件本身
    删除 session_dir 时同步删除 DB 中对应 sessions + plugin_checkpoints 记录
    删除 project_dir 时同步删除 DB 中对应 projects 记录并将关联 sessions.project_id 置 null
    返回：{ results: [{ ok, path, type, freedSize?, error? }], freed, freedStr, successCount, errorCount }
```

---

### 多会话对比分析

所有接口均为 POST，body 中传 `sessionIds` 数组（2~8 个会话 ID）。  
**性能原则**：多 session 数据用 `IN` 子句单次查询 + `GROUP BY session_id` 聚合，不串行 N 次查询。

```
POST /api/compare/sessions
    对比多个 Session 的整体指标（事件数、函数数、调用数、循环、最大深度、热点 IID）
    body: { sessionIds: string[] }   -- 2~8 个 sessionId
    返回：{
      sessions: [{ sessionId, name, createdAt, eventCount, typeDist, fnCount, callCount,
                   loopCount, totalIters, maxDepth, hotIids: [{iid, count, line, src_text}] }],
      divergence: [{ sessionId, name, deltaEvents, deltaFns, deltaCalls,
                     typeDelta: { [type]: {base, curr, delta, pct} },
                     deltaLoops, deltaIters, deltaDepth }]  -- 基准为 sessions[0]
    }

POST /api/compare/functions
    对比多个 Session 的函数调用分布（按调用次数排序，可隐藏内建函数）
    body: { sessionIds: string[], limit?: number, hideBuiltin?: boolean }
    返回：{
      sessions: [{ sessionId, name }],
      functions: [{ fnName, sessions: { [sessionId]: { callCount, eventCount, minLine } } }]
    }

POST /api/compare/hot-iids
    对比多个 Session 的热点 IID（Top-N 执行次数）
    body: { sessionIds: string[], topN?: number }
    返回：{
      sessions: [{ sessionId, name }],
      iids: [{ iid, line, src_text, counts: { [sessionId]: number } }]
    }

POST /api/compare/events
    对比多个 Session 的事件类型分布
    body: { sessionIds: string[] }
    返回：{
      sessions: [{ sessionId, name }],
      types: [{ type, counts: { [sessionId]: number } }]
    }

POST /api/compare/loops
    对比多个 Session 的循环执行情况（循环数、总迭代次数）
    body: { sessionIds: string[] }
    返回：{
      sessions: [{ sessionId, name }],
      loops: [{ iid, line, iterCounts: { [sessionId]: number } }]
    }
```

---

## 2. WebSocket

```
WS /ws/projects/:id/progress
    订阅工作空间插桩进度（实时推送）
    连接后立即推送当前状态快照
    消息格式：
      { type: 'init', projectId, status, iid_count, error_msg }
      { type: 'instrument_start', projectId }
      { type: 'preprocess_start', projectId }          -- 预处理阶段开始（仅启用预处理时）
      { type: 'preprocess_done',  projectId }          -- 预处理阶段完成
      { type: 'instrument_done', projectId, iidCount, smapAvailable, preprocessingApplied }
      { type: 'error', projectId, message }

WS /ws/sessions/:id/progress
    订阅插件执行进度（实时推送）
    连接后立即推送 init 消息（含 pluginStatus + checkpoints）
    消息格式：
      { type: 'init', sessionId, status, pluginStatus, checkpoints }
      { type: 'schedule_start', phase, plugins, toRun, skipped }
      { type: 'plugin_start', plugin, phase }
      { type: 'plugin_progress', plugin, message, progress }
      { type: 'plugin_done', plugin, phase, durationMs }
      { type: 'plugin_error', plugin, message }
      { type: 'all_done', phase, toRun, skipped }
      { type: 'phase_start', sessionId, phase, plugins }

WS /ws/instrument/run/:runId  （也支持 /ws/run/:runId，两条路径均可）
    订阅服务端运行输出流
    消息格式：
      { type: 'stdout', data: '...' }
      { type: 'stderr', data: '...' }
      { type: 'done',   sessionId: '...', exitCode: 0 }
      { type: 'error',  message: '...' }

WS /ws/trace
    浏览器端 Trace 收集（原 trace-server 功能，已集成进 JTA Server）
    可携带查询参数 ?projectId=xxx 自动关联工作空间
    协议：二进制帧 [u32 batchId LE][事件流 bytes]
    响应：ACK 帧 [u32 batchId LE]（4 字节）
    说明：文件保存到 TRACES_DIR，收集完成后可通过 /api/trace/import 导入
```
