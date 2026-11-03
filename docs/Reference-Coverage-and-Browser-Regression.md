# 引用覆盖与真实浏览器回归

本轮完成优先的两项后续工作：恢复此前为保持语义而跳过的部分观测，以及验证真实 Chrome 中的执行和存储链路。原有 58 项语义审计继续作为验收基线。

## 覆盖恢复

| 操作 | 当前采集 | 保留的原生语义 |
| --- | --- | --- |
| 标识符自增自减 | R/W，含写入的新数值 | ToNumeric、BigInt、字符串转换、后置旧数值、const 错误 |
| 普通属性自增自减 | G/P，原始接收者 | base/key 求值次数、getter/setter 次数、严格性 |
| super 属性读写、复合赋值、自增自减 | G/P，通过词法回调访问 | 真实父类属性查找、派生接收者、super 前的 this 未初始化错误 |
| super / 私有方法普通调用与标签模板 | G/M 调用链路 | this、私有品牌检查、模板缓存 |
| 私有字段读写、自增自减 | G/P，属性标签为 #name | 原生品牌检查及异常顺序 |
| super() | nativeOperation 成功结果 | 派生构造器初始化、new.target |
| with 内动态标识符调用、标签模板、自增自减 | nativeOperation 成功结果 | 原生环境绑定和接收者，不重复提取函数 |

`nativeOperation` 是观测钩子，返回值不修改程序结果。记录为 END_EXPR，包含 `(native-result)` 值、`analysis.kind='native_operation'`、具体 operation 及 `coverage='result_only'`。它不会伪造 callPre、参数或函数身份；失败操作不会产生成功结果事件，可选调用短路返回 undefined 的事件也不表示已调用。

这种方式不是对所有 JavaScript 动态引用的完整建模。with 对象的 Proxy / Symbol.unscopables 行为、恶意遮蔽运行时标识符等仍需进一步专门验证，不能根据本轮普通 with 对象案例断言其全面等价。

修复同时覆盖了两项相关问题：

- Rl 只有在写入、初始化和函数帧同步完整时才启用；只读配置使用真实读取，避免从未写入的影子缓存返回 undefined。
- M/Lr/Ca 向 G 传递正确的四位属性访问标志，避免把 methodCall 与 optional 等标志错位。

## 自动化验证

```sh
npm run test:semantics
npm run test:browser
npm test
npm test --prefix analyzer
```

新增 `test/integration/reference-coverage.test.mjs` 的 42 项验证，包含钩子次数/值/接收者断言和 full/read/write/none 配置矩阵。浏览器测试独立于默认 npm test；缺少 Chrome 时明确失败，不静默跳过。可通过 `CHROME_BINARY` 指定 Chrome/Chromium 路径。

本机最终验证：Node 单元/集成测试 930 项通过；分析器 81 项通过；真实 Chrome 端到端测试通过。浏览器测试不是 VM 模拟，而是启动隔离临时 profile 的实际 Chrome，通过 localhost 加载 CLI 打包出的运行时；测试结束关闭浏览器、HTTP/WebSocket 服务并删除临时文件。

原始和插桩页面分别执行同一批业务脚本，比较：

1. 多个 classic script 共享顶层 let/class。
2. DOM 创建、属性写入和 click 监听器。
3. ESM import/export、live binding、顶层 await。
4. Worker 内实际加载独立运行时和插桩代码，执行 super 与 BigInt。
5. getter、toJSON、Proxy 和计算属性键无额外业务访问。
6. IndexedDB Worker 实际写入并查询事件。
7. WebSocket Worker 实际发送二进制事件，服务端解码并确认 ACK。
8. result_only 标记和对象引用标签经过真实存储链路保留。

一次本机运行中主页面写入 185 条 IDB 事件，观察到 20 次属性读取、16 次属性写入和 16 次调用；断言验证事件确实存在，不将这些计数当作稳定协议。

Worker 夹具使用 ready 握手后才发送输入；初次验证发现先发输入、后在日志初始化完成时安装 onmessage 会丢失消息，这是测试宿主的初始化竞态，已通过握手消除，没有用延时掩盖。

## 仍需独立推进

- 同一 runtime 并发顶层 runModule 边界，目前仍要求不交叠。
- 更广的生成式差分测试、跨 realm 和动态 eval/Function 组合。
- Firefox/WebKit、DOM 事件的精确调度依赖、独立 Worker 会话合并。
- 普通对象深度内容的可选快照方案；当前默认稳定引用标识，避免读取用户 getter/Proxy。

执行、日志与分析器的兼容修改需要同步提交；新增回归也验证 native_result 事件可经二进制导入后建立依赖索引。
