# 插桩语义审计（2026-11-03）

## 修复状态

本文记录的 9 类问题均已修复。原有 58 个审计案例现在全部等价；20 个差异归零。以下各节保留的是修复前行为和根因，便于复查。

运行独立审计或针对性回归：

```sh
npm run test:semantics
```

独立审计仍可直接运行：

```sh
node --experimental-vm-modules tools/audit-semantics.mjs
```

发现差异时退出码为 1。常规 `npm test` 已通过 `semantic-regressions.test.mjs` 自动运行审计，包含真正的模块求值和跨脚本上下文验证。

### 实现变化

- Program 不再套入 try/while，也不再抽取或重排 export。正常结束保留 Sr；异常退出由宿主 `runScript` / `runModule` 边界观测。Node 按需插桩加载器已接入同步边界。
- P/Ca/B(delete) 接收源位置的 strict 标记。非严格写入和删除使用原生 Reflect 操作，保留 setter/Proxy 自身抛出的异常。
- 标识符逻辑赋值仅在命中分支时写回；属性逻辑赋值使用每次求值独立的访问器引用和原生逻辑赋值操作符，保留短路、接收者以及 await/yield 中的引用。
- 标签模板通过 M/F 调用包装保留接收者及原生模板对象缓存。with 内标识符普通调用、可选调用和标签模板保留原生引用，并通过 nativeOperation 记录成功求值的结果。
- 函数元数据使用 WeakMap，不再自动读取业务函数的旧式 IID/SID 属性；ExecutionTrace 也不再读取任意函数的 name。已知字面量/声明单独注册名称，未知外部函数允许匿名显示。
- 匿名函数的名称推断通过原生对象属性 NamedEvaluation 保留，不引入额外的函数内名称绑定。计算属性中的函数延后注册，保留原生命名。
- 编码器不再 JSON.stringify 业务对象；TraceLogger 在入队时将业务值转换为安全快照，覆盖控制台、Worker/IDB 和二进制后端。普通对象使用稳定引用标签；TypedArray/ArrayBuffer 通过内置槽位读取保留字节预览，不读取用户 constructor/length 等属性。业务对象的 getter、toJSON 和 Proxy trap 不参与采集。
- ExecutionTrace 对对象类型的属性键使用引用标签，不再为格式化日志重复执行 ToPrimitive。
- 配置矩阵测试额外暴露并修复了两个问题：关闭 INSTR_INVOKE 时 new 被误改成普通调用；元数据前缀打断了源代码的 use strict 指令。

### 宿主接入与采集范围

自定义执行宿主应使用 `runtime.runScript(() => execute())`；异步模块加载使用 `await runtime.runModule(() => loadOrEvaluate())`。边界观察原始异常后继续抛出同一个异常值。直接执行生成的脚本也保持词法作用域和原生异常传播，但没有执行宿主边界时，异常路径不会自动发送 scriptExit；不应为了补齐该事件重新包裹 Program。异步模块边界应覆盖本次加载，不应在同一 runtime 上并发交叠多个独立顶层加载边界。

为了不执行任意业务代码，普通对象日志不再默认包含深度 JSON 内容；稳定引用标签和事件 OID 可用于关联。未知外部函数名和对象类型属性键允许保留为匿名/引用标识。with 内保留原生标识符调用，因此没有该调用位置的 F/M 钩子；现在由 nativeOperation 提供标为 result_only 的成功结果事件，已插桩函数内部的生命周期钩子仍可观测。这些限制是明确的采集边界，不表示对象属性丢失或被写成 undefined。

`semantic-regressions.test.mjs` 增加了配置矩阵、日志链路、Proxy、属性键转换次数、模板缓存、宿主异常边界与模块拒绝等验证。自增自减、super 和私有成员已经通过原生访问回调与独立引用接回读写/调用钩子；原有语义回归测试继续保留。详见 Reference-Coverage-and-Browser-Regression.md。

## 1. 模块声明被重新排序，顶层绑定被移入另一个作用域（P1）

位置：`src/instrument/wrappers.js:1043`，`wrapScriptBodyWithTryCatch`。

实现先提取所有 import/export，再把其他语句放入 try，最后拼接为 `[...moduleDecls, ...wrappedStmts]`。export 声明不是可以任意提升的纯元信息，其初始化和求值必须遵守源代码顺序。

```js
const local = 2;
export function f() { return local; }
globalThis.result = f();
```

原始结果为 2；插桩后 `local` 位于 try 块内，模块顶层的 f 无法访问它，抛 ReferenceError。

```js
const local = 2;
export { local };
```

原始模块有效；插桩后在模块实例化前就抛 `SyntaxError: Export 'local' is not defined in module`。顶层 await 后再 export 同样失败。`export default local` 还会在 local 初始化前被求值。

修复方向：模块顶层保留语句顺序和词法环境，不能使用“提取导出再包裹其余代码”的结构。模块异常观测应在加载/执行边界完成，不能靠整体引入块作用域。

## 2. 普通脚本顶层 let/const 被变成块内变量（P1）

位置：同上，`_buildTryCatchWrapper` 对 script 的应用。

在同一上下文顺序执行两个脚本：

```js
// 脚本 A
let shared = 2;
// 脚本 B
$out.x = shared;
```

原始结果为 2；插桩后 B 抛 ReferenceError。顶层词法声明移动到 try 块，破坏了跨脚本可见性。这会影响网页中的多个 script，单文件测试无法暴露它。

修复方向：保留 script 的全局声明语义；仅仅把模块分支改为不包裹，无法解决普通脚本。

## 3. 非严格代码的属性操作被强制采用严格语义（P1）

位置：`src/runtime/JalangiRuntime.js:987` 的 P 和 `:1366` 的 B/delete。

```js
var o = Object.freeze({x: 1});
o.x = 2;
```

非严格原始代码静默失败，o.x 仍为 1；插桩后抛 TypeError。向数字等原始值写属性也出现相同问题。

```js
var o = {};
Object.defineProperty(o, 'x', {value: 1});
$out.x = delete o.x;
```

原始结果为 false；插桩后抛 TypeError。原因是赋值和 delete 在 class 方法内部执行，class 方法始终严格，而运行时没有携带源代码的严格性。

修复方向：不能直接用运行时方法所处的语言模式替代调用位置的语言模式。设计需要显式保留 strict/sloppy，覆盖写入失败、primitive receiver、Proxy set/deleteProperty 返回 false。不能简单吞掉所有 TypeError，因为 setter 和 Proxy 可能主动抛出业务异常。

## 4. 逻辑赋值没有保留“决定不写入”的语义（P1）

位置：`src/instrument/wrappers.js:1367`，以及运行时 Ca。

```js
const x = 1;
x ||= 2;
```

原始代码正常结束，因为不需要赋值；插桩改写为最终总会执行的赋值，抛出 const 写入 TypeError。

```js
var o = {get x() {return 1;}};
o.x ||= missing();
```

原始代码既不求值 RHS，也不调用 setter；插桩后的 Ca 返回函数接受 RHS 作为参数，在决定短路之前已经求值，抛 ReferenceError。`&&=` 和 `??=` 应按相同结构检查，修复必须覆盖变量和属性两个分支。

修复方向：短路判断、RHS 求值和写回都必须留在正确分支；把运算符映射给普通复合赋值 API 并不成立。

## 5. 带标签模板丢失接收者（P1）

位置：`src/instrument/esnstrument.js` 的 getContext 和 MemberExpression visitor。

```js
var o = {x: 2, tag() {return this.x;}};
$out.x = o.tag`a`;
```

原始结果为 2；插桩后为 undefined。tag 的成员表达式被 G 转换成普通值，原来的 Reference 丢失，this 无法绑定回 o。若方法内部访问更深的 this 属性，可能进一步抛异常。

修复方向：区分“读取函数值”和“保留调用引用”。带标签模板必须保留 native tag reference，或设计专门的调用插桩。

## 6. 获取函数元数据会执行 Proxy 的 get trap（P1）

位置：`src/runtime/JalangiRuntime.js:725` 和 `:736`。

```js
var f = new Proxy(function () {return 2;}, {
  get() {throw new Error('extra get');}
});
$out.x = f();
```

原始结果为 2；插桩后在额外读取函数元数据时抛错。即使不抛错，单次调用也可额外触发 `*J$IID*`、`*J$SID*` 的读取。本轮基线中每个属性被读取两次。

原因是 WeakMap 未命中时回退到普通属性读取；`getPropSafe` 只检查 null，并不保证访问没有副作用。不能通过 try/catch 恢复已经发生的 trap 副作用。

修复方向：运行时自有元数据使用旁路存储；兼容旧属性的路径需要明确策略，不能在所有业务函数调用中自动触发。ExecutionTrace 的 `f?.name` 也有同类风险，单独移除 IID/SID 回退仍不能保证启用插件后无额外读取。

## 7. with 中的直接函数调用丢失接收者（P2）

位置：getContext 的 Identifier/CallExpression 处理、wrapFunCall 与运行时 F。

```js
var o = {x: 3, f() {return this.x;}};
with (o) {$out.x = f();}
```

原始结果为 3；插桩后为 undefined。with 的对象环境绑定有自己的调用接收者语义，不能把所有标识符调用统一当作 `this = undefined`。

修复方向：在动态对象环境中保留原生调用引用，或明确降级。修改 F 为一律绑定 globalThis 同样不正确。

## 8. 匿名函数的名称推断被 J$.T 包装打断（P2）

位置：FunctionExpression/ArrowFunctionExpression visitor 和 `wrapLiteral`。

```js
var f = function () {};
var a = () => {};
$out.names = [f.name, a.name];
```

原始结果为 `['f', 'a']`；插桩后为 `['', '']`。变量赋值和对象属性中的匿名函数也已复现。名称可能参与框架注册、依赖注入或业务分发，不能视为纯展示差异。

修复方向：保留 NamedEvaluation。直接给所有匿名函数加函数名也可能引入新的函数内部名称绑定，不能仅为了补 `.name` 改变词法解析。需要覆盖默认参数、计算属性、解构默认值和导出默认函数等上下文。

## 9. 日志序列化会执行业务 getter/toJSON（P1）

位置：`src/encoding/EventSerializer.js:278` 的 `_jsonStringify(v)`；函数分支还直接读取 v.name。

直接调用：

```js
let calls = 0;
const value = {get x() {calls++; return 2;}};
serializeEvent({type: 'CALL', iid: 1, result: value});
// calls 变为 1
```

自定义 toJSON 同样被执行一次。这里测试的是编码器本身；是否、何时影响业务，取决于实际日志后端何时序列化。若同步编码，可能在业务中途修改状态；若延迟编码，则仍可能在稍后执行本不应执行的业务行为。

上一轮修复的是 runtime T 的属性扫描，并没有修复此处。捕获 JSON.stringify 抛出的异常，只能避免部分异常外溢，不能撤销计数器修改、网络调用、对象变异等副作用。

修复方向：在线采集默认记录引用身份与原始值，避免任意对象的深度序列化。描述符读取也不能保证任意 Proxy 无副作用；“完整对象快照”与“任意对象完全无可观察访问”不能同时默认承诺。

## 已通过的范围与未覆盖范围

本轮 8 组 async/generator 案例通过：async return/finally、await reject/catch、并发 async、带默认参数的 async、generator return/finally、generator throw/catch、yield 与 ??、async generator 与 for-await。普通脚本另有一批闭包、类字段、参数、eval 等基础案例通过。

这些是有限样本，不能外推为所有异步场景安全。尚未完整验证浏览器 DOM/宿主对象、跨 realm、所有按需配置组合、完整日志后端下的异步调度与回调替换、所有动态 eval/Function 路径、全量语法与值组合。现有单元/集成测试通过，不等于语义等价证明。

## 后续扩展顺序（上述修复已完成）

1. 模块/脚本整体包装：恢复顶层作用域和执行顺序。
2. 逻辑赋值与 strict/sloppy：消除额外 RHS 求值、写回和 TypeError。
3. runtime/插件/编码器的隐式业务对象访问：明确无副作用的采集边界。
4. 带标签模板、with 等 Reference 语义，以及匿名函数命名。
5. 将审计用例转为修复后的持续回归测试，并扩展各配置和真实日志后端。

避免把“所有异常吞掉”作为修复，也避免用“暂不插桩”掩盖数据完整性问题；确需跳过时，应明确记录覆盖缺口。
