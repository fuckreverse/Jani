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
    返回：{ checkpoints: [{ plugin_id, phase, completed_at, duration_ms, is_stale }] }
    is_stale=true：上游数据已更新，该插件的分析结果可能过期，需重跑

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

GET  /api/sessions/:id/functions?search=&minCalls=1&minEvents=&maxEvents=&hideBuiltin=0&sortBy=call_count&limit=100&offset=0&fnDefIid=&line=
    查询函数调用统计（聚合 call_edges 按 fn_name + fn_def_iid 分组）
    返回：{ functions: [{ fn_name, fn_iid, fn_def_iid, call_count, event_count, avg_own_event_count, min_line, ... }], total }
    hideBuiltin=1：过滤 JS 内建函数名
    sortBy=event_count：按平均自身事件数排序（衡量函数复杂度）
    minEvents/maxEvents：按 own_event_count 范围过滤（对旧数据降级为 return_seq-call_seq 近似）
    fnDefIid：按函数定义点 iid 精确过滤（同一函数体每次调用相同，可唯一定位函数体）
    line：按调用点行号精确过滤（caller_line = N）
    search：函数名模糊搜索（LIKE %keyword%）

GET  /api/sessions/:id/functions/:fnName/calls?limit=200&offset=0&fnDefIid=&callSeq=
    查询某函数所有调用记录（含参数、返回值、SEQ 范围）
    fnDefIid：按函数定义点 iid 精确过滤，唯一定位函数体（替代旧的 fnIid 参数）
    callSeq：自动定位到包含该调用的分页（前端无需手动翻页）
    返回：{ calls: [{ id, call_seq, return_seq, depth, args, return_value, fn_def_iid, ... }], total, offset }

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

GET  /api/sessions/:id/calls/:callId/annotated-source
    返回某次调用的函数源码，并附加本次调用内的动态执行数据
    包含：每行执行次数（本次调用 SEQ 区间内 GROUP BY iid）、每行读写变量值（去重，最多 6 个/行）
    实现：排除子调用内部事件（复用 queryDirectChildren + makeIsInsideChild），准确统计函数体内事件
    返回：{
      fnName, startLine, lines: [{ line, srcText, execCount,
        writes: [{ name, val_text }], reads: [{ name, val_text }] }],
      signature: null
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

GET  /api/sessions/:id/loop-iterations?seqFrom=&seqTo=&loopId=&loopsOnly=0&limit=100&offset=0
    循环迭代快照数据（A5 LoopDetector 输出）
    seqFrom/seqTo：时间窗口过滤，只返回循环起始 start_seq 在该范围内的记录（可选）
    loopId：按循环 id 精确过滤（只返回指定循环的迭代记录）
    loopsOnly=1：只返回循环列表（跳过迭代查询，初始加载时节省耗时）
    返回：{
      loops: [{ id, iid, start_seq, end_seq, iteration_count, line, src_text, median_gap,
               loop_depth, parent_loop_id, call_edge_id, fn_name }],
      iterations: [{ id, loop_id, iteration_idx, start_seq, end_seq, vars_snapshot }],
      count, total, offset
    }
    vars_snapshot 格式（v2）：{ v: 2, w: { name: val }, r: { name: lastReadVal } }
      v = 版本号；w = 每次迭代的写操作最终值；r = 读操作最后一次读取值

GET  /api/sessions/:id/value-patterns?seqFrom=&seqTo=&limit=100&offset=0&patternType=&valueSearch=&varName=&onlyCrypto=&minCount=&lenMin=&lenMax=
    值模式检测结果（A8 ValuePatternDetector 输出，35+ 魔术常数 + 语义类型标签）
    seqFrom/seqTo：时间窗口过滤，只返回 first_seq 在该范围内的记录（可选）
    patternType：按语义类型标签精确过滤：
        timestamp_ms / timestamp_s / uuid / hex_str / base64_charset /
        custom_alphabet / base64_encoded / ip_addr / url / json_obj / byte_array
    valueSearch：按值内容（value_hash 字段）模糊搜索
    varName：按变量名过滤
    onlyCrypto：'1' 时只返回匹配密码学常数的记录
    minCount：最小出现次数过滤
    lenMin/lenMax：值文本长度范围过滤
    返回：{ patterns: [{ id, value_hash, count, first_seq, iid, var_name, line, matched_constant, pattern_type, entropy }], total }

GET  /api/sessions/:id/value-patterns/:patternId/full-value
    获取值模式的完整原始值（通过 value_dict_id 直接查询，A8 v2 起支持）
    返回：{ fullValue: '...', patternId: N }

GET  /api/sessions/:id/value-index-search?q=keyword
    在 value_dict 表里搜索字符串型值（降级兜底搜索），至少 2 字符
    按出现次数降序排列，最多返回 50 条唯一值
    返回：{ results: [{ value_dict_id, val_text, occurrence_count }] }

GET  /api/sessions/:id/plugin-stats
    返回每个分析插件的产出统计摘要，用于概览页展示
    直接读取 plugin_checkpoints.summary_json（分析阶段已保存）
    返回：{
      stats: { [pluginId]: { ...统计数据 } },
      perf:  { [pluginId]: { durationMs, completedAt, isStale, phase } }
    }

GET  /api/sessions/:id/web-api?category=&host_obj=&access_type=&confidence_level=&search=&limit=500&offset=0
    Web API 调用检测结果（I5 WebApiDetector 输出）
    category：宿主对象分类过滤（window/document/navigator/location/storage/xhr/fetch/timing/observer/event/canvas/other）
    host_obj：推断的宿主对象名过滤
    access_type：访问类型过滤（call/read/write）
    confidence_level：置信度过滤（confirmed/propagated/inferred）
    search：属性名关键字搜索（LIKE %search%）
    返回：{
      items: [{ id, event_id, category, host_obj, property_name, access_type,
                confidence_level, receiver_var, args_json, return_value, line, src_text }],
      total, hasMore,
      summary: [{ category, host_obj, access_type, confidence_level, cnt }]
    }

GET  /api/sessions/:id/object-timelines?seqFrom=&seqTo=&limit=200&offset=0
    对象属性变化时间线（A7 ObjectMutationTracker 输出）
    seqFrom/seqTo：时间窗口过滤，只返回 seq 在该范围内的记录（可选）
    返回：{ timelines: [{ base_var, seq, mutation_type, offset, value, src_text }], total }

GET  /api/sessions/:id/dataflow?seqFrom=&seqTo=&edgeType=&varName=&varExact=&limit=200&offset=0
    数据流边（A2 DataFlowGraph v2 输出）
    seqFrom/seqTo：时间窗口过滤，只返回 from_event_id 在该范围内的记录（可选）
    edgeType：边类型过滤（assign/call_arg/call_ret/field_write/field_read）
    varName：变量名模糊搜索（LIKE %keyword%）
    varExact：精确变量名过滤
    返回：{ edges: [{ from_event_id, to_event_id, from_var, to_var, edge_type, from_line, to_line }], total }

GET  /api/sessions/:id/dataflow/vars?prefix=&limit=100
    返回所有出现在数据流边中的唯一变量名（前缀搜索）
    prefix：变量名前缀过滤（可选，利用 idx_df_from_var/idx_df_to_var 索引）
    排除 '#' 开头的匿名/内部变量
    返回：{ vars: ['varA', 'varB', ...] }

GET  /api/sessions/:id/dataflow/subgraph?varName=&eventId=&direction=both&hops=3&maxNodes=80
    N-hop 数据流子图（以指定变量名或 event_id 为中心，BFS 展开）
    varName：起始变量名（从该变量的所有边出发）
    eventId：起始事件 ID（从该事件的边出发）
    direction：展开方向（forward=下游 / backward=上游 / both，默认 both）
    hops：最大跳数（默认 3，最大 6）
    maxNodes：最大节点数上限（默认 80，最大 200）
    返回：{
      nodes: [{ id, type: 'var'|'event', label, varName?, eventId? }],
      edges: [{ source, target, edgeType, ...原始 dataflow_edges 字段 }],
      stats: { nodeCount, edgeCount, truncated }
    }

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
    可携带查询参数 ?projectId=xxx&sid=<uuid> 自动关联工作空间和复用会话文件
    协议：二进制帧 [u32 batchId LE][事件流 bytes]
    响应：ACK 帧 [u32 batchId LE]（4 字节）
    说明：文件保存到 TRACES_DIR，收集完成后可通过 /api/trace/import 导入
    会话文件复用：WsBackend 构造时自动生成 UUID 作为 sessionId，通过 ?sid= 拼入 URL
      同一 sid 的多次连接（断线重连）共享同一 .bin 文件，追加写入
      会话无活跃连接且超过空闲超时（默认 30s）后自动关闭文件
```
