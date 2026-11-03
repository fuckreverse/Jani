# Trace 分析的语义与质量

## 依赖模型

`DependencyIndex.mjs` 是 A1 污点追踪、A2 数据流图、I2 签名切片的共同依赖入口。
查询按 session、动态 binding、事件位置和对象属性建立索引，不按值相等搜索来源；对象属性值的比较仅用于否定过时的来源，不用于创造来源。

| 边 | 来源 | 能说明什么 |
| --- | --- | --- |
| assign | 同一动态 binding 的最近一次写入 | 变量定义到读取；旧 trace 只能退回静态 scope |
| copy | 同一语句中的读写组合 | 保守关联，不证明表达式内的精确传播 |
| call_arg | 每个实参独立的求值事件与形参绑定 | 支持嵌套调用、展开参数、rest 和默认值；实参内部仍是语句级 |
| call_ret | CALL 结果到调用者当前表达式 | 不再连接“返回后的第一次无关读取” |
| return_value | return 表达式、退出、调用结果或 await 恢复 | 已观测的返回来源；异步返回不会冒充同步 Promise 结果 |
| field_read | 同一 OID、同一属性最近的写入，并检查观测值是否一致 | 别名共享身份；覆盖、删除和冲突观测终止旧定义 |
| control | 实际条件事件与所选词法区域、表达式选择 | 保守控制关系，不是完整程序依赖图 |
| await_resume | 同一次 await 的挂起与恢复 | 区分交错调用；可用时连接被等待函数的 return |
| exception_value | 实际 throw、异常退出与 await 拒绝 | 将抛出的数据连接到 catch 路径 |
| async_schedule | 已知原生调度器注册与回调入口 | 定时器、微任务和 Promise 回调的因果来源 |

记录器为每次调用保留独立的语句缓冲。await 挂起时保存缓冲，恢复时取回；参数、
返回值、属性和控制关系因此不依赖“调用区间内的读取顺序”。原生调用抛错也会清理
相应调用元数据。原生同步回调与其外层调用分开记录。

箭头函数（包括表达式体）与 async 函数通过观察型 try/catch/finally 作用域记录返回和退出，
不在 finally 中替换原生返回值，也不改变箭头函数的词法 this/arguments。声明初始化单独
结束，避免把提升的函数定义和第一条业务语句合并为同一来源。

挂起记录在恢复/拒绝时移除，活动观察帧在完成时移除。调度注册使用由原生回调闭包持有的
对象作为 WeakMap key；完成、取消或永不执行的回调不会因一个全局数字注册表而永久保留。
异步完成恢复当时的执行上下文，不会重新激活已经返回的同步调用者。

`delete` 成功后写入删除屏障（fields.is_write=2），阻止后续读取继续沿用已删除属性的
旧定义。原型链查找、getter/setter、Proxy 和未插桩代码导致的变更仍可能需要专门模型。
不通过读取原型或再次执行访问器来猜测来源，以免改变被分析程序的行为。观测到属性值
与旧写入不符后，即便后来再次读到旧值，也不会继续沿用旧写入。每个属性写入区间的
失效位置只扫描一次，并在 SQLite 临时表中缓存；生产分析连接使用文件临时存储，避免
热点属性读取引发重复的全区间扫描。

## 精度和截断

这是**语句级动态切片，带独立实参边界**。不同实参不再共享全部输入；默认表达式、
展开项和 rest 参数按实际位置连接。单个实参内部的多个读写、逗号表达式仍可能存在
保守的多对多关联，不能解读为完整的表达式级污点标签。
签名结果的 path_json 是 BFS 发现的依赖事件集合；真正的分支关系保存在 analysis.edges，
不能把 BFS 列表直接解读成一条线性的执行路径。

maxHops 限制深度，maxNodes 限制规模。达到上限且还有未探索依赖时返回 truncated=true；
叶节点不会让其他分支提前停止。A2 的复制边数量限制也会在检查点摘要中标出。
A1/A2/I2 的摘要提供 precision 和 truncated；A1/I2 的结果保存 analysis_json。
POST taint 同时返回 analysis，因此零条路径时仍能检查质量。A2 的 v2 磁盘边带 evidence；
v1 磁盘图和旧主库图继续可读。

控制区域需要配套 smap；表达式选择关系直接随事件记录。if/while/for 的词法区域
近似不等于基于 CFG 后支配关系的完整控制依赖。switch、异常边和隐式信息流没有完整建模。

调度器通过原生函数身份识别，不按函数名识别。支持 setTimeout、setInterval、
setImmediate、queueMicrotask、Promise.then/catch/finally。回调包装保留 this、参数、
返回值和异常；注册表中的自定义调度器、事件监听和其他 realm 的原生函数不自动识别。
Promise 的 then/catch 空处理器透传、finally 的原值保留、回调返回 Promise 的吸收，以及
已记录 throw 的拒绝路径有来源连接。all/race/any/allSettled 的成员与胜出关系仍没有精确模型，
其原生结果采用保守输入依赖。

## 循环和算法识别

A3 的热点是 IID 频次，**不是耗时**。循环候选来自重复 IID 的自适应分段；命中数不是
经源码循环事件证明的迭代数。现代 trace 按调用身份分组，旧 trace 回退到调用区间。
A3 显式依赖 F3，避免缺少调用图时静默退化。A3/A5 共用执行事件筛选规则，实参、
声明、调度等辅助事件不会被当成原始指令的又一次执行。

A5 以相邻命中构成不重叠区间 `[hit[j], hit[j+1]-1]`，最后截止候选结束位置；快照排除
其他调用实例，同名但 binding 不同的变量分开命名。达到循环、迭代或读取变量数量上限
时报告截断。A6 默认随分析流程运行，其变量角色仍是数值序列启发式。

加密常数、库调用、字段名、混淆模式都只是线索。confidence 是未校准的证据评分，
不是算法存在的概率。I4 的 JSON 和 Markdown 报告包含质量说明、完整性状态、截断插件、
证据语义和模型边界。

## 兼容与重分析

分析元数据使用 JTB1 v4 已有的可扩展 JSON 尾部，原有二进制 payload 不变。
旧 v1–v4 trace 可以导入；缺少调用、分支和异步来源时不再靠位置猜测补边。
如需新增能力，应重新插桩并采集 trace，再重新分析。插件、共享依赖模块和质量模块的
变更纳入检查点指纹，已有结果会在重分析时失效。

## 验证

`test/analysis-semantics.test.mjs` 从真实插桩、运行、二进制序列化、导入到分析验证语义，
并用小型手工图检验有界切片和迭代区间。覆盖参数顺序、解构/默认参数、返回消费、
跨会话、作用域、别名、覆盖/删除、分支、短路、并发 await、调度回调、异常与循环实例，并验证百次 async/Promise 调用完成后的状态释放。
既有存储测试继续检验分片事务、取消/回滚和 48 MiB JS 堆预算下的十万条边构图。

## 参考工具的定位

- [Jalangi](https://people.eecs.berkeley.edu/~ksen/papers/jalangi-tool.pdf)：运行时语义事件与动态分析。
- [WALA](https://github.com/wala/WALA)：指针、数据流与程序切片模型，主要是静态分析。
- [GraalVM Insight](https://www.graalvm.org/jdk17/tools/graalvm-insight/)：调用边界与运行时值。
- [rr](https://rr-project.org/)：确定性回放与反向调试；本项目没有实现确定性回放。
- [Perfetto](https://perfetto.dev/docs/quickstart/trace-analysis)：可查询 trace 和跨执行指标。
- [Go diagnostics](https://go.dev/doc/diagnostics)：运行时调度及并发诊断。
- [Callgrind](https://valgrind.org/docs/manual/cl-manual.html)：区分频次、工作量和实际性能。

本次侧重提升 JS 逆向和因果分析可信度，没有新增 CPU 计时、堆分析或确定性回放产品。
