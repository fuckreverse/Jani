# Jalangi2 代码评估报告

## 做得好的地方 ✅

### 1. 架构设计清晰，关注点分离良好

整个框架分为三个独立层次：

- **Instrumentation Layer**（`esnstrument.js`）：纯静态代码转换，不关心运行时
- **Runtime Layer**（`analysis.js`）：纯运行时回调分发，不关心插桩细节
- **Analysis Layer**（用户代码）：只关心业务逻辑

三层职责分明，互相解耦。

### 2. 分析接口设计非常优雅（Pre/Post Hook 模式）

每个操作都提供了 `Pre` 和 `Post` 两个回调，支持：

- 修改参数（Pre 阶段返回新值）
- 跳过操作（`skip: true`）
- 修改结果（Post 阶段返回 `{result: ...}`）
- 不返回值 = 被动观察（不影响程序语义）

这个设计极为灵活，既能做被动分析，又能实现程序语义修改。

### 3. ChainedAnalyses 的组合模式

通过拦截 `sandbox.analysis` 的 `setter`，实现了多个分析的透明组合，用户不需要感知链式机制。

### 4. `J$` 全局命名空间隔离

用全局唯一前缀 `J$` + `JALANGI DO NOT INSTRUMENT` 注释，防止框架自身被重复插桩，方案简单但有效。

### 5. bit pattern 参数编码节省了生成代码的体积

将多个布尔 flag 打包成一个整数（`createBitPattern` / `decodeBitPattern`），减少了插桩后代码的参数数量，降低运行时开销。

### 6. IID 系统设计考虑了精度

使用三个独立的 IID 计数器（`memIid`、`condIid`、`opIid`），且步长为 8，为同一 AST 节点的多个子操作预留了 IID 空间（如方法调用的 `iid+2` 用于内部 getField）。

### 7. 良好的 API 文档（`analysisCallbackTemplate.js`）

每个回调都有完整的 JSDoc，包含代码示例、参数说明、返回值语义，对分析开发者友好。

---

## 做得差的地方 ❌

### 1. `esnstrument.js` 文件体量过于庞大（2000+ 行），职责边界模糊

整个 2000 行的文件混杂了：

- AST 工具函数（`createLiteralAst`、`replaceInExpr`、`replaceInStatement`）
- IID 管理
- Scope 分析（`addScopes` 及完整的 `Scope` 类，700+ 行）
- 各种 `wrap*` 函数（30+ 个）
- 三个独立的 AST visitor（`visitorRRPre`、`visitorRRPost`、`visitorOps`）
- 函数声明提升（`hoistFunctionDeclaration`）
- 顶层 `instrumentCode` 入口

这些逻辑应该拆分为多个文件。

### 2. `replaceInStatement` / `replaceInExpr` 是性能瓶颈（重复解析模板字符串）

每次调用 `wrapGetField`、`wrapPutField` 等 30+ 个 wrap 函数，都会重新调用 `acorn.parse` 解析一个模板字符串（如 `"J$.G(J$_1, J$_2, J$_3, 0)"`），然后做 AST 替换。这些模板完全可以预解析并缓存，而不是每次调用时重新解析。

### 3. `callAsNativeConstructor` 用硬编码 if-else 列举参数个数

```js
function callAsNativeConstructor(Constructor, args) {
    if (args.length === 0) { return new Constructor(); }
    if (args.length === 1) { return new Constructor(args[0]); }
    // ... 一直到 args.length === 5
    return callAsNativeConstructorWithEval(Constructor, args); // fallback 到 eval
}
```

这是历史遗留 workaround，注释说是因为 V8 内存泄漏。但现代 JS（ES6+）可以用 `Reflect.construct(Constructor, args)` 优雅地解决，且 V8 早已修复了相关问题。

### 4. `invokeFunctionDecl` 中有重复声明的变量（实质性 bug）

```js
function invokeFunctionDecl(base, f, args, iid) {
    var newArgs = ...;
    f.apply(base, newArgs);
    var code = '(function(' + ... + ') { ' + ... + ' })';
    var code = sandbox.instrumentEvalCode(code, iid, false);  // ← 重复 var code！
```

`var code` 被声明了两次，在 strict mode 下会报错，是一个明显的 bug/typo。

### 5. SMemory 通过往对象上附加隐藏属性来实现，有严重副作用

```js
function createShadowObject(val) {
    // 直接在目标对象上附加 *J$O*、*J$A* 等属性
    val[SPECIAL_PROP_SOBJECT] = Object.create(null);
    ...
}
```

这个方案存在以下问题：

- 对 DOM 对象或冻结对象（`Object.freeze`）失效，只能用 `try/catch` 静默忽略
- 污染对象的 `Object.getOwnPropertyNames` 结果
- 无法追踪 `null`、`undefined`、原始值
- `JSON.stringify` 等在某些情况下行为可能受影响

更好的方案是使用 `WeakMap` 存储 shadow 信息，完全无侵入。

### 6. ECMAScript 版本支持已经过时

```js
var newAst = acorn.parse(code, {locations: true, ecmaVersion: 6 });
```

`ecmaVersion: 6` 对应 ES2015，但当前已是 ES2023+。箭头函数、`async/await`、`class`、`??`（空值合并）、`?.`（可选链）、`#` 私有字段、顶层 `await` 等现代语法都无法被正确插桩。

### 7. ChainedAnalyses 的链式逻辑有两个设计缺陷

**缺陷一：使用了已废弃的 `arguments.callee`**

```js
fun = self[field] = function () {
    var thisFun = arguments.callee;  // 在 strict mode 下抛异常
    ...
    for (var i = 0; i < len; i++) {
        ret1 = thisFun.afs[i].apply(thisFun.afThis[i], args);
    }
```

**缺陷二：多分析链式调用时，前一个分析的修改对后一个不可见**

`args` 数组不会在链式调用中更新，因此如果分析 A 修改了 `base` 或 `args` 的某个值，分析 B 仍然收到原始值，而非 A 修改后的值。这使得多分析组合时的语义不一致。

### 8. 全局状态污染（`acorn`、`esotope` 作为全局变量）

```js
// 在 jalangi.js 中，注意没有 var/let/const
acorn = require("acorn");
esotope = require("esotope");
```

`api.js` 中有注释承认这个问题：

```js
// TODO making globals here is kind of gross, but esnstrument relies on it
```

这是一个已知但长期未解决的架构债务。

### 9. `api.js` 中使用了已废弃的 `Buffer` 构造函数

```js
function convertToString(buffer_parts, bufferLength) {
    var buf = new Buffer(bufferLength);  // Node.js 6+ 已废弃
```

应使用 `Buffer.alloc()` 或直接 `Buffer.concat(buffer_parts)`。

### 10. `Config.js` 的设计使配置无法跨 analysis 实例隔离

`Config` 直接挂在全局 `J$` 对象上，是单例。在 `api.js` 的 `setupConfig` / `clearConfig` 中，不得不在每次调用前后手动设置/清除，这在异步或并发场景下不安全。

---

## 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构设计 | ⭐⭐⭐⭐ | 三层分离很好，但 `esnstrument.js` 太臃肿 |
| API 设计 | ⭐⭐⭐⭐⭐ | Pre/Post hook 模式堪称经典 |
| ES 现代特性支持 | ⭐⭐ | 停留在 ES6，无法处理现代 JS |
| 代码质量 | ⭐⭐⭐ | 有重复声明 bug、`arguments.callee` 等 |
| 性能 | ⭐⭐⭐ | 模板重复解析、SMemory 附加属性方式有问题 |
| 可扩展性 | ⭐⭐⭐⭐ | 插件化分析很好，但全局状态难以隔离 |

---

## 核心重构建议

1. **拆分 `esnstrument.js`**：将 scope 分析、IID 管理、wrap 函数库、instrumentation pipeline 各自独立成文件
2. **SMemory 改用 `WeakMap`**：完全无侵入地存储 shadow 信息，解决 frozen 对象和 DOM 对象问题
3. **升级 `ecmaVersion`**：支持到当前 ES 标准（使用最新版 `acorn`，设置 `ecmaVersion: "latest"`）
4. **解决全局变量污染**：将 `acorn`/`esotope` 的依赖通过参数注入或模块封装传入
5. **修复 `ChainedAnalyses`**：去掉 `arguments.callee`，改用命名函数或闭包；修复链式值传递逻辑
6. **用 `Reflect.construct` 替代 `callAsNativeConstructor`**
7. **预缓存 AST 模板**：避免 `replaceInExpr` 每次重新 `acorn.parse` 模板字符串
