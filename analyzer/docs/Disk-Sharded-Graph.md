# 磁盘分片数据流图

A2 不再把整个会话的 events/writes/reads/fields 装入 JavaScript 数组和 Map。
它使用源数据库索引逐条扫描，产生的边用固定大小缓冲写入独立 SQLite 分片。
A1 污点追踪也改为按当前前沿查询磁盘索引，不再预加载全会话读写索引。

## 磁盘布局

```text
data/sessions/<sessionId>/dataflow/<generation UUID>/
  catalog.sqlite
  edges-1.sqlite
  edges-2.sqlite
  ...
```

每个分片默认最多 100,000 条边，按该版本内递增的 edge ID 分区。
每条边只存储一次。跨事件区间的依赖边无需把两个端点放在同一个文件。

catalog.sqlite 保存：

- shards：文件序号、边数、首尾 edge ID。
- locations：`(kind, node, direction, shard)` 唯一索引；节点可以是事件 ID 或变量名。
- variables：唯一变量名，用于变量建议接口。
- stats：按边类型聚合的统计。
- metadata：存储版本及边数。

例如事件 10 与事件 900,000 的依赖边存于第 7 个文件时，目录会分别记录
事件 10 的 forward 邻接与事件 900,000 的 backward 邻接都位于 shard 7。
查询先查目录，只打开匹配分片，再通过文件内部的 from/to 事件或变量索引取限定数量的边。
单个 reader 使用 LRU，默认最多同时打开 4 个分片；请求结束关闭全部句柄。

## 有界构图和查询

- 构图默认最多缓冲 1,000 条边；源记录使用 SQLite iterator，最近定义使用 binding_id 或旧 scope_id 覆盖索引。
- 源读取连接使用 4 MiB 页缓存、关闭 mmap、临时排序落盘；目录和分片连接各使用 1 MiB 页缓存。
- 构图只保持当前扫描行、当前事件的 copy 数量和当前写入批次，不保持全会话索引。
- 无过滤分页用目录中的计数跳过无关分片；精确变量过滤通过邻接目录裁剪候选分片。其他过滤逐片计算总数并读取所需页，不加载整个图。模糊搜索和精确总数可能扫描多个文件，时间仍随数据量增长。
- 子图 BFS 严格限制节点、边、跳数和每个节点的邻接读取数量。节点、边或邻接上限导致省略结果时返回 `stats.truncated=true`；跳数决定本次查询范围。
- A1 每次只查当前事件的读写和相邻定义，前沿与路径数量受 maxNodes/maxHops 限制。

分片改善图构建和查询的内存行为。磁盘容量、索引查询耗时、F1 导入及其他插件仍有各自的资源边界；
JS 堆限制不等于进程 RSS 上限。此实现保留原有语句级数据流语义，不能作为完整 SSA 分析使用。

## 原子发布、失败和兼容

主数据库新增 dataflow_graphs 表，保存每个 session 当前 generation 的路径、版本、边数和分片数。
A2 先写完并关闭全部文件，再在插件事务内切换这个指针，与插件检查点一起提交。
读取器固定自己打开的 generation，重建时可以继续读取原来的不可变文件。

异常回滚恢复旧指针并清理新目录。每个 generation 保存创建者记录，reader 在取得指针时创建租约；
文件生命周期锁使取得租约与回收互斥，但不持有 SQLite 写锁，因此保留 WAL 快照读取行为。
新版本提交后回收无 reader 的旧代，最后一个 reader 关闭时再次回收；仍被 reader 使用的旧代继续可读。
worker 超时或取消后，主线程等待其退出，再按任务拥有者清理未发布目录及残留租约；当前已提交版本始终保留。
服务启动时也扫描遗留 generation，回收死亡进程的产物与旧格式的无引用目录。
清理失败记录日志，后续任务或启动时重试。没有创建者信息的异常锁目录保守等待 30 秒后才可恢复。
中断任务重新运行时从源事件重新构建，不续写半成品分片。

旧会话没有 dataflow_graphs 记录时，接口继续读取主数据库 dataflow_edges 表。
重新运行 A2 后，发布分片图并在同一事务中删除该会话的旧表边记录。
缺失或损坏的已发布文件会明确报错，不静默返回空图；缺失 catalog 的检查点会失效，需要重建。

## 配置和使用

默认配置：

```json
{
  "graph": {
    "shardEdgeLimit": 100000,
    "batchSize": 1000,
    "maxOpenShards": 4
  }
}
```

在 analyzer/config.json 覆盖即可；对应环境变量为 JTA_GRAPH_SHARDEDGELIMIT、
JTA_GRAPH_BATCHSIZE、JTA_GRAPH_MAXOPENSHARDS。

新分析运行 A2 时自动使用分片存储。旧会话可在 UI 中重跑 A2，或调用已有接口：

```sh
curl -X POST http://localhost:33000/api/sessions/SESSION_ID/re-run \
  -H 'Content-Type: application/json' \
  -d '{"plugins":["A2-DataFlowGraph"],"forceRerun":true}'
```

GET /dataflow、GET /dataflow/vars、GET /dataflow/subgraph 的路径、过滤参数和返回结构保持兼容。
分页顺序是该版本内的 edge ID，重建后不保证 edge ID 与前一版本一致。
I4 汇总报告也从目录统计读取边数，已迁移的会话无需保留主表边副本。
MCP get_dataflow、get_dataflow_vars、get_dataflow_subgraph 使用相同接口。

## 可复现验证

```sh
npm test
npm test --prefix analyzer
LOG_LEVEL=error node --max-old-space-size=48 analyzer/benchmark-graph.mjs 1000000
```

独立图基准用 SQLite 流式生成源记录，不先生成巨型 JS 数组；使用临时数据库并在结束后删除。
百万边合成用例实测：

| 项目 | 结果 |
|---|---:|
| 源事件 | 2,000,000 |
| 输出边 | 1,000,000 |
| 输出分片 | 10 |
| 构图耗时 | 约 21.6 秒 |
| 最大 JS 写入缓冲 | 1,000 条边 |
| 完成时 JS 堆 | 约 24.7 MiB |
| 进程 RSS | 约 129.4 MiB |
| 图文件总大小 | 约 173.3 MiB |
| 查询最后一个节点打开的分片 | 1 |

测试覆盖跨分片正反向遍历、过滤与跨片分页、LRU、节点上限、重开持久化图、旧表兼容、
动态绑定隔离、HTTP 接口、worker 发布、失败回滚及 48 MiB JS 堆预算下的大图构建。
基准是合成单机用例，不代表所有 Trace 的吞吐；大量变量、属性和调用边会改变磁盘大小与耗时。

最终回归结果：核心 782 项、后端 32 项全部通过，`git diff --check` 通过。

## 优化前后实测

同条件三轮对照：20 万条边，峰值 RSS 从 615.3 MiB 降至 100.8 MiB，构图从 2.053 s 增至 4.374 s。
48 MiB JS 堆限制下，原内存实现 OOM，分片实现成功。完整方法、查询延迟和原始数据见
[Graph-Sharding-Benchmark.md](Graph-Sharding-Benchmark.md)。
