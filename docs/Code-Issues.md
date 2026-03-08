# 代码问题说明

本文档记录在代码审查（2026-03）过程中发现的代码问题、潜在 Bug 和冗余代码，
供后续修复参考。**本文档仅做描述，不含代码修改。**

---

## 目录

- [ISSUE-01：`replaceInStatement` / `replaceInExpr` 残留代码未清理](#issue-01)
- [ISSUE-02：`_with` Hook 映射到 `INSTR_CONDITIONAL` 而非专属 Config 字段](#issue-02)
- [ISSUE-03：`wrapPutField` 的 `isOpAssign` 标志始终为 `false`](#issue-03)
- [ISSUE-04：`C2` 中的 switch case 修改逻辑疑似有误](#issue-04)
- [ISSUE-05：`TypedArrayBackend.js` 占位但未实现，CLAUDE.md 仍有引用](#issue-05)
- [ISSUE-06：`JalangiRuntime.js` 中多处 `TODO-*` 注释标记尚未清理](#issue-06)
- [ISSUE-07：`wrappers.js` 中 `Config.INSTR_PUTFIELD` 细粒度控制参数顺序不一致](#issue-07)
- [ISSUE-08：`instrumentLoad` 中 `isScriptLocal` 命名令人误导（代码逻辑正确）](#issue-08)
- [ISSUE-09：`RegExpLiteral` 的 `flags` 字段未包含 `sticky`/`unicode` 等新标志](#issue-09)
- [ISSUE-10：`esnstrument.js` 同时从两处导出 `pluginAnalyzer` 函数，可能造成模块边界混乱](#issue-10)
- [HOOK-01：内部工具函数（`I`/`L`/`_`/`Ra`）混入 Hook 命名空间无区分](#hook-01)
- [HOOK-02：单字母 Hook 缩写语义不透明（`H`/`N`/`T`/`A`/`S`/`Wi`/`X1`）](#hook-02)
- [HOOK-03：`_` Hook 名称占用 JS 约定"忽略/私有"符号，插桩产物可读性极差](#hook-03)
- [HOOK-04：`INSTR_CONDITIONAL` 包含 `Wi`（with），语义跨类；`Aw` 无独立 Config](#hook-04)
- [HOOK-05：`Fr` 字面像"函数返回"，实为"函数退出"，与 `Rt` 职责区分不直觉](#hook-05)
- [CALLBACK-01：`invokeFun` 是动词短语，无法自然暗示"调用之后"的 Post 语义](#callback-01)
- [CALLBACK-02：Pre/Post 存在与否在不同操作间不一致，无文档说明原因](#callback-02)
- [CALLBACK-03：三种命名风格并存，无统一规范](#callback-03)
- [CALLBACK-04：`_return`/`_throw`/`_with` 保留字加下划线，公开 API 有"私有"语义干扰](#callback-04)
- [CALLBACK-05：`forinObject` 的 `Object` 后缀冗余，与其他回调命名粒度不一致](#callback-05)
- [CALLBACK-06：Enter/Exit 与 Pre/Post 两套边界命名体系并存，无文档说明区分依据](#callback-06)

---

<a id="issue-01"></a>
## ISSUE-01：`replaceInStatement` / `replaceInExpr` 残留代码未清理

**文件**：`src/instrument/wrappers.js`（第 241-308 行）

**问题描述**：

`wrappers.js` 中保留了旧版字符串模板解析引擎的两个函数 `replaceInStatement` 和 `replaceInExpr`。
这两个函数依赖 `@babel/parser` 动态 parse 模板字符串，并通过 `deepCloneAndReplace` 进行
占位符替换，曾是旧版插桩的核心机制。

在 Phase 4 重构后，所有实际插桩函数（`wrapRead`、`wrapWrite`、`wrapLiteral` 等）已完全迁移至
`@babel/types` 直接构建 AST 节点，`replaceInStatement`/`replaceInExpr` **不再有任何内部调用方**。

**当前状态**：

```js
// wrappers.js 第 241 行注释：
// ─── 模板引擎（replaceInStatement / replaceInExpr）─────────────────────────────
// 当前所有 wrap 函数已迁移至 @babel/types 直接构建，此处保留供外部代码引用。
```

- `replaceInStatement` 和 `replaceInExpr` 没有出现在 `export` 语句中
- `src/utils/api.js` 中有一条注释提到这两个函数，但 `api.js` 是旧式未 ESM 化的文件，
  与现代插桩器无关

**副作用**：

1. 这两个函数引用了 `_templateCache`、`deepCloneAndReplace` 和 `RP` 等变量，
   意味着相关基础设施（模板缓存、占位符替换机制）也需要保留，增加了代码复杂度
2. `deepCloneAndReplace` 函数同时被这两个残留函数引用，如果清理则可一并清理

**建议**：

移除 `replaceInStatement`、`replaceInExpr` 及相关基础设施（`deepCloneAndReplace`），
或改为明确的注释说明"仅保留供向后兼容参考，内部不使用"并加上 `@deprecated` JSDoc 标记。

---

<a id="issue-02"></a>
## ISSUE-02：`_with` Hook 映射到 `INSTR_CONDITIONAL`

**文件**：`src/instrument/pluginAnalyzer.js`（第 106 行）

**问题描述**：

在 `HOOK_TO_CONFIG_FIELDS` 映射表中，`_with` hook（对应 JS `with` 语句）被映射到
`INSTR_CONDITIONAL`：

```js
// pluginAnalyzer.js
_with: ['INSTR_CONDITIONAL'],
```

从 `wrappers.js` 的 `wrapWith()` 实现来看，`with` 语句的插桩确实使用了 `INSTR_CONDITIONAL`
控制开关（`Config.INSTR_CONDITIONAL`），所以映射在技术上是"正确"的。

但从语义上，`_with` 与"条件判断"（`INSTR_CONDITIONAL` 控制 `if`/`while`/`?:`/`switch` 等）
关系不大，反而更接近 `with` 语句的作用域扩展语义。这导致：

1. 如果分析插件只实现了 `_with` hook，`pluginAnalyzer` 会开启 `INSTR_CONDITIONAL`，
   从而**意外地启用**条件判断（`J$.C`）的插桩，产生不期望的钩子调用
2. 相反，如果只实现了 `conditional` hook（不关心 `with`），`with` 语句会被插桩，
   产生多余的 `J$.Wi` 钩子调用

**建议**：

考虑以下两种方案之一：
1. 为 `with` 语句添加独立的 Config 字段 `INSTR_WITH`（最干净）
2. 将 `wrapWith` 改为使用 `INSTR_TRY_CATCH_ARGUMENTS` 控制（`with` 修改作用域链，
   与需要 try-catch 的语义更相关），并更新 `HOOK_TO_CONFIG_FIELDS`

---

<a id="issue-03"></a>
## ISSUE-03：`wrapPutField` 的 `isOpAssign` 标志始终为 `false`

**文件**：`src/instrument/wrappers.js`（第 344 行）

**问题描述**：

`wrapPutField` 函数生成 `J$.P` 调用时，flags 参数的构建如下：

```js
t.numericLiteral(createBitPattern(isComputed, false))
//                                              ^^^^  isOpAssign 始终传 false
```

`isOpAssign` 标志表示"这是一个属性复合赋值操作（如 `obj.x += 1`）"，
但在 `wrapPutField` 中硬编码为 `false`。

实际上，普通属性赋值（`obj.x = val`）确实 `isOpAssign=false`，这是正确的。
属性复合赋值（`obj.x += val`）走的是 `wrapModAssign`（生成 `J$.A`），而非 `wrapPutField`。

**潜在影响**：

`putFieldPre` / `putField` 分析插件收到的 `isOpAssign` 参数在普通赋值场景中始终为 `false`，
这与当前代码逻辑一致（复合赋值不走 `wrapPutField`）。

但这与 `Analysis-Development.md` 中 `putFieldPre(iid, base, offset, val, isComputed, isOpAssign)` 
的文档描述形成歧义：文档暗示 `isOpAssign` 可能为 `true`，但实际上通过 `wrapPutField` 生成的
`J$.P` 调用中该标志永远是 `false`。

**建议**：

更新 `Analysis-Development.md` 中 `putFieldPre` 和 `putField` 的文档，明确说明
`isOpAssign` 在 `J$.P` 路径下始终为 `false`，属性复合赋值（`J$.A`）不会触发这两个钩子。

---

<a id="issue-04"></a>
## ISSUE-04：`C2` 中的 switch case 修改逻辑疑似有误

**文件**：`src/runtime/JalangiRuntime.js`（第 1375-1389 行）

**问题描述**：

`C2` 方法（switch case 标签比较）中，当分析插件通过 `conditional` 钩子返回修改后的 `result` 时，
有一段逻辑处理返回值：

```js
if (analysis?.conditional) {
    const aret = analysis.conditional(iid, result);
    if (aret) {
        if (result && !aret.result) {
            right = !right;         // ← 翻转 right？语义不明
        } else if (result && aret.result) {
            right = this.#switchLeft; // ← 若结果为 true 则让 right = switchLeft 以触发匹配
        }
    }
}
return (this.#lastComputedValue = right);
```

**问题分析**：

1. `result = this.B(iid+1, '===', switchLeft, right, ...)` 是比较结果（`true`/`false`），
   但后续修改的是 `right`（case 标签值），而非直接返回修改后的布尔值
2. `right = !right` 的语义不清晰：`right` 是 case 标签的原始值，`!right` 是其逻辑非，
   与"翻转比较结果"无关
3. 这与 `C()` 方法（普通条件）的处理方式不一致：`C()` 直接使用 `aret.result` 作为条件值

**与 `C()` 方法的对比**：

```js
// C()：直接用分析插件修改后的结果
C(iid, left) {
    const aret = analysis.conditional(iid, left);
    if (aret) left = aret.result;
    return left;
}

// C2()：通过修改 right 来间接影响匹配结果（语义混乱）
C2(iid, right) {
    let result = this.B(iid+1, '===', switchLeft, right, ...);
    if (aret) {
        if (result && !aret.result) right = !right;   // ← 语义混乱
        ...
    }
    return right;
}
```

**建议**：

重新审查 `C2` 中的分析插件返回值处理逻辑，考虑是否应该直接返回 `aret.result`（布尔值），
而非通过修改 `right` 来间接影响 `===` 的比较结果。

---

<a id="issue-05"></a>
## ISSUE-05：`TypedArrayBackend.js` 占位但未实现，CLAUDE.md 仍有引用

**文件**：`CLAUDE.md`（项目说明），`docs/README.md`，`docs/Runtime-System.md`，`docs/Overview.md`

**问题描述**：

`TypedArrayBackend.js`（`src/logger/backends/TypedArrayBackend.js`）在多处文档中
被描述为已实现的后端，但实际上该文件**不存在**于代码库中。

`docs/Scope-Aware-Instrumentation.md` 第 779 行有明确的设计决策说明：

> **结论**：`TypedArrayBackend.js`（`SharedArrayBuffer + Float64Array` 方案）**不再需要实现**。
> 现有 logger 系统已通过架构层面的设计解决了同等问题，且实用性更好。

但这个结论没有同步到 `CLAUDE.md` 中的 "日志系统" 表格，该表格仍将其列为已有模块：

```markdown
| `TypedArrayBackend` | `backends/TypedArrayBackend.js` | 高性能 TypedArray 后端（零 GC）|
```

**影响**：

1. `CLAUDE.md` 中的日志系统模块表格给读者造成误导
2. `docs/README.md` 的目录结构中列出了不存在的文件
3. 如果开发者尝试导入该文件，会在运行时报模块未找到错误

**建议**：

1. 从 `CLAUDE.md` 的日志系统表格中移除 `TypedArrayBackend` 条目（已在 `docs/` 文档中修正）
2. 从 `docs/README.md` 的目录结构中移除或标注该文件
3. 或者按 `Scope-Aware-Instrumentation.md` 的设计决策正式记录"该功能由现有架构覆盖，不再需要实现"

---

<a id="issue-06"></a>
## ISSUE-06：`JalangiRuntime.js` 中多处 `TODO-*` 注释标记尚未清理

**文件**：`src/runtime/JalangiRuntime.js`

**问题描述**：

`JalangiRuntime.js` 中存在大量以 `TODO-11`、`TODO-12`、`TODO-13`、`TODO-14`、`TODO-15` 标记的注释，
这些注释是重构开发阶段的任务标记，但对应的功能**已全部实现完成**：

| 标记 | 功能 | 实现状态 |
|------|------|---------|
| `TODO-11` | Shadow Frame 机制 | ✅ 已实现（`#shadowFrameMap`/`#shadowSet`/`#shadowLookup`/`#shadowClear`）|
| `TODO-12` | 轻量读取 `J$.Rl` | ✅ 已实现（`Rl()` 方法）|
| `TODO-13` | CallID 机制 | ✅ 已实现（`#callIdCounter`/`#callIdStack`/`Fe`/`Fr`）|
| `TODO-14` | 对象 OID 机制 | ✅ 已实现（`#oidMap`/`getOid`/`getObjectVersion`）|
| `TODO-15` | 异步 ContextID | ✅ 已实现（`Aw`/`newAsyncContext`/`activateContext`/`currentContextId`）|

**附加问题**：

同时存在 `BUG-RT-03` 和 `BUG-objectmethod-closure` 注释，这些是已修复的 Bug 的历史注释。
已修复的 Bug 注释保留在代码中会增加阅读负担。

**建议**：

1. 清理所有 `TODO-XX` 前缀注释，将其改为正常的功能描述注释
2. 考虑将 `BUG-RT-03`、`BUG-objectmethod-closure` 等已修复 Bug 的注释改为纯功能描述
3. 或保留这些注释作为历史背景，但去掉 `TODO-`/`BUG-` 前缀，避免工具误识别为待处理项

---

<a id="issue-07"></a>
## ISSUE-07：`wrappers.js` 中 `Config.INSTR_PUTFIELD` 细粒度控制参数顺序不一致

**文件**：`src/instrument/wrappers.js`

**问题描述**：

不同的 `Config.INSTR_*` 细粒度控制函数收到的参数不统一：

```js
// wrapRead: Config.INSTR_READ(name, node)
//   name 是 StringLiteral AST 节点（不是字符串）
if (!Config.INSTR_READ || Config.INSTR_READ(name, node))

// wrapGetField: Config.INSTR_GETFIELD(offset.value, node)
//   第一个参数是字符串（非计算属性）或 null（计算属性）
if (!Config.INSTR_GETFIELD || Config.INSTR_GETFIELD(node.computed ? null : offset.value, node))

// wrapPutField: Config.INSTR_PUTFIELD(offset.value, node)
//   第一个参数是字符串或 null
if (!Config.INSTR_PUTFIELD || Config.INSTR_PUTFIELD(isComputed ? null : offset.value, node))

// wrapModAssign: Config.INSTR_PROPERTY_BINARY_ASSIGNMENT(op, offset.value, node)
//   三个参数：运算符、属性名、节点
if (!Config.INSTR_PROPERTY_BINARY_ASSIGNMENT || Config.INSTR_PROPERTY_BINARY_ASSIGNMENT(op, node.computed ? null : offset.value, node))
```

`wrapRead` 的 `name` 参数是 **AST 节点**（`StringLiteral`），而其他函数的第一个参数是**字符串值**或 `null`，
这对编写细粒度控制函数的用户非常不友好（需要知道 `name.value` 才能获取变量名字符串）。

**影响**：

`Configuration.md` 中说细粒度控制函数接收"AST 节点对象"，但实际上 `INSTR_GETFIELD`、`INSTR_PUTFIELD`
的第一个参数是属性名字符串（非计算属性时），而 `INSTR_READ` 的第一个参数是 AST 节点。
这个不一致性在文档中没有得到明确说明。

**建议**：

1. 将 `INSTR_READ` 的细粒度控制函数签名改为与其他字段一致，即传字符串而非 AST 节点：
   `Config.INSTR_READ(nameStr, node)` 其中 `nameStr = name.value`
2. 或者在 `Configuration.md` 中明确说明每个 Config 字段的细粒度控制函数签名（当前文档
   只说"接收 Babel AST 节点"，不够精确）

---

<a id="issue-08"></a>
## ISSUE-08：`instrumentLoad` 中 `isScriptLocal` 命名令人误导（代码逻辑正确）

**文件**：`src/instrument/wrappers.js`（第 1296-1301 行）

**问题描述**：

在 `instrumentLoad` 函数中，已声明变量走全量路径的调用：

```js
// 已声明变量（非全局/轻量）的兜底路径
return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isGlobal, defScope?.id);
//                                                           ^^^^^  ^^^^^^^
//                                                           isGlobal=false(硬编码) isScriptLocal=isGlobal(变量)

// 全局变量路径（hasVar=false，即完全未声明的全局变量）
return wrapRead(ast, createLiteralAst(ast.name), ast, false, true, false);
//                                                        ^^^^  ^^^^
//                                                        isGlobal=true, isScriptLocal=false
```

第 6 个参数名为 `isScriptLocal`，但传入的是名为 `isGlobal` 的局部变量（`_scope.isGlobal(ast.name)`）。

**代码逻辑实际上是正确的**，原因如下：

- `_scope.isGlobal(name)` 的语义：**只在没有父作用域的顶层（Program）声明的变量**才返回 `true`
  - 即 `var` 声明在脚本顶层的变量（脚本级变量，`isScriptLocal = true`）
  - 未声明全局变量（`hasVar=false`）不会进入此分支
- 因此在第一条路径中：
  - 若 `isGlobal=true` → 该变量是顶层 `var` 声明（脚本级），`isScriptLocal=true` 正确
  - 若 `isGlobal=false` → 该变量是局部变量，`isScriptLocal=false` 正确

**潜在混淆点**：

变量名 `isGlobal` 在这里被当作 `isScriptLocal` 使用，导致读者误以为"第 5 个参数传 `false`（=非全局）但第 6 个传 `isGlobal`（可能为 `true`）"是矛盾的。实际上此处 `isGlobal=true` 等价于"是顶层 `var` 声明"，即 `isScriptLocal=true`。

**建议**：

添加注释说明变量语义的双重用途，或引入 `isTopLevelVar` 等更明确的中间变量：

```js
// hasVar=true 分支：isGlobal 此处等价于 isScriptLocal（顶层 var 声明）
const isScriptLocal = isGlobal;
return wrapRead(ast, createLiteralAst(ast.name), ast, false, false, isScriptLocal, defScope?.id);
```

---

<a id="issue-09"></a>
## ISSUE-09：`RegExpLiteral` 的 `flags` 字段未包含 `sticky`/`unicode` 等新标志

**文件**：`src/instrument/esnstrument.js`（第 106-115 行）

**问题描述**：

`JSONStringifyHandler` 中序列化 RegExp 时，只保留了 3 个传统标志：

```js
function regExpToJSON() {
    return {
        type:       'J$.AST.REGEXP',
        value:      this.source,
        glb:        this.global,
        ignoreCase: this.ignoreCase,
        multiline:  this.multiline,
    };
}

function JSONParseHandler(key, value) {
    if (typeof value === 'object' && value?.type === 'J$.AST.REGEXP') {
        const flags = `${value.glb ? 'g' : ''}${value.ignoreCase ? 'i' : ''}${value.multiline ? 'm' : ''}`;
        return RegExp(value.value, flags);
    }
```

ES6+ 引入了更多 RegExp 标志：
- `s`（dotAll）
- `u`（unicode）
- `y`（sticky）
- `d`（hasIndices，ES2022）
- `v`（unicodeSets，ES2024）

**影响**：

当源代码包含 `/pattern/uy`（sticky + unicode）等正则表达式时，经过 JSON 序列化/反序列化后，
`sticky` 和 `unicode` 标志会丢失，导致 IID 缓存中还原的正则表达式行为与原始不同。

这个问题影响 `inlineSourceMap` 功能中 JSON 缓存的正则表达式还原。

**建议**：

扩展序列化逻辑以包含所有 RegExp 标志，或改用 `this.flags`（字符串，包含所有标志）替代逐个字段序列化：

```js
function regExpToJSON() {
    return {
        type:   'J$.AST.REGEXP',
        value:  this.source,
        flags:  this.flags,  // 直接序列化完整 flags 字符串
    };
}
```

---

<a id="issue-10"></a>
## ISSUE-10：`esnstrument.js` 同时导出 `pluginAnalyzer` 函数，模块职责混乱

**文件**：`src/instrument/esnstrument.js`（第 1154 行）

**问题描述**：

`esnstrument.js` 的导出语句为：

```js
export { init, instrumentCode, instrumentEvalCode, analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig };
```

其中 `analyzePluginHooks`、`buildConfigFromHooks`、`buildConfigFromPlugins`、`fullConfig`
这四个函数实际上来自 `pluginAnalyzer.js` 模块（通过 `import` 引入），
`esnstrument.js` 只是将它们重新导出。

**潜在问题**：

1. `esnstrument.js` 的职责应该是"插桩主入口"，但它额外承担了 `pluginAnalyzer.js` 的公开 API 导出
2. 这导致两个导入路径都可以使用这些函数：
   - `import { buildConfigFromPlugins } from 'esnstrument.js'`（通过再导出）
   - `import { buildConfigFromPlugins } from 'pluginAnalyzer.js'`（直接导入）
3. `CLAUDE.md` 和 `docs/` 中有些示例用前者，有些用后者，不统一

**当前状态**：

`esnstrument.js` 第 49 行导入这些函数：
```js
import { analyzePluginHooks, buildConfigFromHooks, buildConfigFromPlugins, fullConfig } from './pluginAnalyzer.js';
```
然后在第 1154 行再导出，使 `esnstrument.js` 成为这些函数的"聚合入口"。

**建议**：

明确文档约定：推荐使用哪个导入路径。
- 方案 A：统一从 `esnstrument.js` 导入（作为插桩器的聚合公开 API），`pluginAnalyzer.js` 成为内部实现
- 方案 B：保留两个路径都可用，但在文档中明确推荐直接导入 `pluginAnalyzer.js`（职责更清晰）
- 方案 C：从 `esnstrument.js` 移除 `pluginAnalyzer` 函数的再导出，只从 `pluginAnalyzer.js` 导入

---

<a id="hook-01"></a>
## HOOK-01：内部工具函数（`I`/`L`/`_`/`Ra`）混入 Hook 命名空间无区分

**文件**：`src/runtime/JalangiRuntime.js`

**问题描述**：

以下四个标识符与其余 Hook 性质完全不同——它们不对应任何 JS 语义操作，而是框架内部的
状态读取器或流程辅助件，却与语义 Hook（`R`/`W`/`G`/`P` 等）共用同一命名空间，没有任何区分标记：

| 符号 | 实际用途 | 性质 |
|---|---|---|
| `I(val)` | 透传，`val => val`，占位用 | 内部工具 |
| `L()` | 读取 `#lastComputedValue`（最后计算值）| 内部状态读取器 |
| `_()` | 读取 `#lastVal`（上一个条件值，供 `&&`/`||`/`??` 短路使用）| 内部状态读取器 |
| `Ra()` | 从 `#returnStack` 弹出 `Rt` 存入的返回值，在 `finally` 块中使用 | 流程协同件 |

`Ra` 尤其容易造成误解：名称上像一个语义 Hook，实际上是 `Rt`（return 语句）与 `finally` 包装的
内部协同机制，没有对应的分析器回调，也不对应任何 JS 语法节点。

**影响**：

外部开发者阅读 Hook 列表时，无法区分"可被分析插件感知的语义事件"与"框架内部运作细节"，
也无法判断哪些 Hook 有对应的 `analysisCallbackTemplate` 回调，哪些没有。

**建议**：

1. 将 `I`/`L`/`_`/`Ra` 在文档和代码注释中明确标注为 `@internal`，与语义 Hook 区分
2. 或将内部工具迁移到私有方法（`#L()`、`#Ra()` 等），不再暴露在公开 Hook 命名空间

---

<a id="hook-02"></a>
## HOOK-02：单字母 Hook 缩写语义不透明（`H`/`N`/`T`/`A`/`S`/`Wi`/`X1`）

**文件**：`src/runtime/JalangiRuntime.js`、`src/instrument/wrappers.js`

**问题描述**：

当前 Hook 体系大量使用 1～2 个字母的缩写，以下几个在没有文档辅助的情况下含义极度不透明：

| Hook | 实际含义 | 容易误解为 |
|---|---|---|
| `H` | for-in 循环对象包装（Hash 的缩写）| HashMap / Header / Handler |
| `N` | 变量声明初始化（旧版 `N_LOG` 遗留）| Number / Null / New |
| `T` | 字面量（数字/字符串/函数/对象/正则）| Template / Type / Throw |
| `A` | 复合赋值 `+=`/`-=` 等（Assignment）| Array / Apply / Await |
| `S` | 采样判断（Sampling）| Script / String / Switch |
| `Wi` | with 语句 | Window interface |
| `X1` | 表达式语句结束标记 | 含义不明 |

`S` 与同名前缀的 `Se`/`Sr`（Script Enter/Exit）产生视觉混淆——在插桩代码中 `J$.S`、`J$.Se`、
`J$.Sr` 三行并排，第一个 `S` 的含义与后两个完全不同，但外观极为相似。

**建议**：

在 `JalangiRuntime.js` 的每个 Hook 方法上，补充 JSDoc 注释，
明确说明 Hook 名称的缩写来源及对应的 JS 语义操作，方便阅读插桩产物的开发者快速定位。

---

<a id="hook-03"></a>
## HOOK-03：`_` Hook 名称占用 JS 约定"忽略/私有"符号，插桩产物可读性极差

**文件**：`src/runtime/JalangiRuntime.js`、`src/instrument/wrappers.js`

**问题描述**：

`_()` 在 JS 生态中是约定俗成的"忽略/私有"语义符号（Lodash、underscore.js、私有变量命名惯例），
而 Jalangi2 将其用于"返回上一个条件值"这一非常具体的功能。

`_()` 在插桩产物中出现于 `&&`/`||`/`??` 短路求值的重写位置，形如：

```js
// 原始代码：a && b
J$.C(iid1, a) ? b : J$._()
```

这里 `J$._()` 的语义是"把 `a` 的原始值取回来作为整个表达式的结果"，
放在 `?:` 的 false 分支。第一次阅读插桩产物的开发者几乎无法理解这一行的含义，
且 `_` 给人的第一印象是"占位符/无意义"，与其实际承担的"恢复短路值"功能完全相反。

**建议**：

考虑将 `_()` 重命名为语义更清晰的内部名称，如 `Lv()`（Last Value）或直接标注为 internal。

---

<a id="hook-04"></a>
## HOOK-04：`INSTR_CONDITIONAL` 包含 `Wi`（with），语义跨类；`Aw` 无独立 Config

**文件**：`src/instrument/pluginAnalyzer.js`、`src/instrument/wrappers.js`

**问题描述**：

此问题是 ISSUE-02 在命名层面的延伸。`INSTR_CONDITIONAL` 控制的 Hook 包括：
`C`（条件判断）、`C1`（switch 判别式）、`C2`（case 比较）、**`Wi`（with 语句）**。

`with` 语句与"条件判断"在 JS 语义上毫无关联，将其归入 `INSTR_CONDITIONAL` 反映了
Hook 分类体系与 Config 字段命名之间的不对应。

此外，`Aw`（await 恢复点，`J$.Aw`）没有对应的 Config 开关（如 `INSTR_AWAIT`），
导致 await 插桩目前无法被独立开/关，与其他所有 Hook 均有对应 Config 开关的设计不一致。

**建议**：

1. 为 `with` 语句添加独立的 Config 字段 `INSTR_WITH`（与 ISSUE-02 建议一致）
2. 为 `Aw` 添加 `INSTR_AWAIT` Config 字段，使 async/await 插桩可独立控制

---

<a id="hook-05"></a>
## HOOK-05：`Fr` 字面像"函数返回"，实为"函数退出"，与 `Rt` 职责区分不直觉

**文件**：`src/runtime/JalangiRuntime.js`

**问题描述**：

Hook 命名：
- `Fe`：Function Enter（函数入口）
- `Fr`：Function Return/Exit（函数退出）
- `Rt`：Return statement（return 语句）

`Fr` 中的 `r` 来自 Return，但 `Fr` 实际执行的是"函数退出"逻辑：弹出 callId 栈、执行
`finally` 清理、恢复 sid、可能重抛异常——这些是"退出"（Exit）的语义，而非"返回"（Return）。

"函数返回"已经有专用的 `Rt` Hook，导致 `Fr` 与 `Rt` 的职责边界对初次阅读者不清晰：
两者都与 return 有关，但 `Rt` 对应 return 语句本身，`Fr` 对应函数体执行完毕的收尾。

**建议**：

将 `Fr` 的注释和文档中明确标注其语义为"函数退出/Function Exit"（非 Return），
或考虑在下一次 Hook 命名重构时改为 `Fx`（Function eXit）与 `Fe` 对称。

---

<a id="callback-01"></a>
## CALLBACK-01：`invokeFun` 是动词短语，无法自然暗示"调用之后"的 Post 语义

**文件**：`src/runtime/analysisCallbackTemplate.js`

**问题描述**：

整套回调接口中，所有有 Pre 版本的回调，"Post"版本的命名规律是去掉 `Pre` 后缀：

| Pre | Post（隐含）|
|---|---|
| `getFieldPre` | `getField` |
| `putFieldPre` | `putField` |
| `binaryPre` | `binary` |
| `unaryPre` | `unary` |
| `invokeFunPre` | `invokeFun` |

前四对中，Post 版本的名称是名词短语（"得到字段"、"放置字段"、"二元/一元运算"），
隐含"操作已完成/结果已产生"的 Post 语义，读者可以自然推断。

但 `invokeFun`（"调用函数"）是**动词短语**，既可以是"去调用"（Pre），
也可以是"调用完了"（Post），存在歧义，与名词短语风格的其他 Post 回调不一致。

**建议**：

考虑将 `invokeFun` 改为名词短语风格，如 `functionCall`（对应 Pre 为 `functionCallPre`），
使其与 `getField`/`putField` 等命名风格统一。

---

<a id="callback-02"></a>
## CALLBACK-02：Pre/Post 存在与否在不同操作间不一致，无文档说明原因

**文件**：`src/runtime/analysisCallbackTemplate.js`

**问题描述**：

不同操作类型的 Pre/Post 覆盖情况不对等：

| 操作 | Pre 回调 | Post 回调 |
|---|---|---|
| 属性读 | `getFieldPre` ✓ | `getField` ✓ |
| 属性写 | `putFieldPre` ✓ | `putField` ✓ |
| 二元运算 | `binaryPre` ✓ | `binary` ✓ |
| 一元运算 | `unaryPre` ✓ | `unary` ✓ |
| 函数调用 | `invokeFunPre` ✓ | `invokeFun` ✓ |
| 变量读 | 无 `readPre` ✗ | `read` ✓（Post only）|
| 变量写 | `write` ✓（Pre only）| 无 `writePost` ✗ |
| 条件判断 | 无 `conditionalPre` ✗ | `conditional` ✓（Post only）|
| 字面量 | 无 `literalPre` ✗ | `literal` ✓（Post only）|

`read` 只有 Post，`write` 只有 Pre，`conditional`/`literal` 只有 Post。
这种不对称在当前文档中没有任何说明，分析插件作者必须通过阅读运行时源码才能知道：
哪些操作可以"拦截前修改参数"，哪些只能"观测结果"。

从语义上，缺失的回调有其合理性（如 `readPre` 在读取前值未知，拦截意义不大），
但这些设计决策应在 `analysisCallbackTemplate.js` 或 `Analysis-Development.md` 中明确说明。

**建议**：

在 `Analysis-Development.md` 中为每个操作类型说明是否有 Pre/Post，以及仅提供单向回调的原因。

---

<a id="callback-03"></a>
## CALLBACK-03：三种命名风格并存于同一回调接口，无统一规范

**文件**：`src/runtime/analysisCallbackTemplate.js`

**问题描述**：

整套回调接口中，同时存在三种截然不同的命名风格：

**风格 A：动名词 + 对象名词**（多数方法）
```
getField / getFieldPre / putField / putFieldPre
invokeFun / invokeFunPre
functionEnter / functionExit
scriptEnter / scriptExit
```

**风格 B：纯动词**（少数方法）
```
read / write / declare / conditional
```

**风格 C：例外/特殊**
```
_return / _throw / _with        ← 保留字被迫加下划线前缀
forinObject                     ← 动词 + In + 对象名词，孤例
runInstrumentedFunctionBody     ← 极长，描述框架内部行为而非 JS 语义事件
endExpression / endExecution    ← end + 名词，与 Enter/Exit 体系不统一
awaitResume                     ← 动词 + Resume，孤例
```

三种风格共存且没有边界规律（不是按操作类型划分），导致插件作者编写代码时需要靠记忆
而非规律来拼写方法名。

**建议**：

在 `Analysis-Development.md` 中明确说明命名约定，或在下一次 API 重构时统一为一种风格
（推荐：动名词短语，与 `getField`/`putField` 对齐）。

---

<a id="callback-04"></a>
## CALLBACK-04：`_return`/`_throw`/`_with` 保留字加下划线，公开 API 有"私有"语义干扰

**文件**：`src/runtime/analysisCallbackTemplate.js`

**问题描述**：

`_return`/`_throw`/`_with` 三个回调方法名是 JS 保留字（`return`、`throw`、`with`），
因此被迫加了下划线前缀以避免语法错误。

在现代 JS/TS 生态中，下划线前缀有约定俗成的"私有/内部/已弃用"语义隐含
（尽管 ESM class 已有 `#` 私有字段，下划线的这层含义仍被广泛认知）。
将其用于公开的、供插件实现者覆盖的方法名，会给阅读者带来"这三个方法是特殊的/不推荐使用的"的错误印象。

当前 ESM class 语法下，有几种更清晰的命名方案可规避保留字问题而无需下划线：

| 当前 | 可选方案（示例）|
|---|---|
| `_return` | `onReturn` / `returnStmt` / `handleReturn` |
| `_throw` | `onThrow` / `throwStmt` / `handleThrow` |
| `_with` | `onWith` / `withStmt` / `handleWith` |

**建议**：

在下一次 API 重构时，将这三个回调改为不含下划线前缀的清晰命名，
并在过渡期通过 `@deprecated` 注释保留旧名称向后兼容。

---

<a id="callback-05"></a>
## CALLBACK-05：`forinObject` 的 `Object` 后缀冗余，与其他回调命名粒度不一致

**文件**：`src/runtime/analysisCallbackTemplate.js`

**问题描述**：

其他回调均不在名称中重复说明操作对象的类型：

- `read`（不叫 `readVariable`）
- `getField`（不叫 `getFieldOfObject`）
- `declare`（不叫 `declareVariable`）

但 `forinObject` 带了 `Object` 后缀。for-in 语句的迭代目标本来就是对象，
`Object` 后缀没有增加额外信息，仅增加了名称长度和不一致性。

此外，`forin` 本身也不符合风格 A（动名词短语）或风格 B（纯动词）的任何一种，
是整套接口中独一无二的"动词 + 介词 + 名词"组合。

**建议**：

考虑将 `forinObject` 改为 `forin` 或与其他回调风格对齐的名称（如 `forIn`）。

---

<a id="callback-06"></a>
## CALLBACK-06：Enter/Exit 与 Pre/Post 两套边界命名体系并存，无文档说明区分依据

**文件**：`src/runtime/analysisCallbackTemplate.js`

**问题描述**：

回调接口中存在两套语义相近但命名风格不同的"操作边界"体系：

| 体系 | 方法 | 语义 |
|---|---|---|
| Pre/Post | `getFieldPre` / `getField` | 属性读取之前 / 之后 |
| Pre/Post | `putFieldPre` / `putField` | 属性写入之前 / 之后 |
| Pre/Post | `invokeFunPre` / `invokeFun` | 函数调用之前 / 之后 |
| Enter/Exit | `functionEnter` / `functionExit` | 函数体开始执行 / 执行完毕 |
| Enter/Exit | `scriptEnter` / `scriptExit` | 脚本开始执行 / 执行完毕 |

从语义上，`functionEnter` ≈ "函数的 Pre"，`functionExit` ≈ "函数的 Post"。
两套命名的并存有一定合理性：Pre/Post 强调对同一数据操作的前后时机；
Enter/Exit 强调执行边界（有上下文切换语义，不仅仅是"某操作的前后"）。
但这个区分在任何文档中都没有说明，对插件作者来说只是"命名不统一"的表现。

**建议**：

在 `Analysis-Development.md` 中明确说明两套体系的设计意图和区分依据，
使插件作者理解这不是命名疏忽而是有意为之的语义区分。

---

## 摘要表

| 编号 | 严重程度 | 类型 | 文件 | 建议优先级 |
|------|---------|------|------|---------|
| ISSUE-01 | 低 | 冗余代码 | `src/instrument/wrappers.js` | P3（可选清理）|
| ISSUE-02 | 中 | 逻辑缺陷 | `src/instrument/pluginAnalyzer.js` | P2（影响按需 Config 精度）|
| ISSUE-03 | 低 | 文档/代码不一致 | `src/instrument/wrappers.js` | P3（更新文档即可）|
| ISSUE-04 | 中 | 潜在 Bug | `src/runtime/JalangiRuntime.js` | P2（switch case 语义修改可能有误）|
| ISSUE-05 | 中 | 幽灵文件 | `CLAUDE.md`，多处文档 | P2（已在 docs/ 修正，需同步 CLAUDE.md）|
| ISSUE-06 | 低 | 注释清理 | `src/runtime/JalangiRuntime.js` | P3（可选清理）|
| ISSUE-07 | 低 | API 不一致 | `src/instrument/wrappers.js` | P3（影响自定义细粒度控制的用户）|
| ISSUE-08 | 低 | 命名混淆 | `src/instrument/wrappers.js` | P3（逻辑正确，仅需添加注释说明）|
| ISSUE-09 | 中 | 功能缺陷 | `src/instrument/esnstrument.js` | P2（新 RegExp 标志丢失）|
| ISSUE-10 | 低 | 模块职责 | `src/instrument/esnstrument.js` | P3（文档约定即可）|
| HOOK-01 | 中 | 命名设计 | `src/runtime/JalangiRuntime.js` | P3（文档/注释说明）|
| HOOK-02 | 中 | 命名设计 | `src/runtime/JalangiRuntime.js`、`wrappers.js` | P3（补充 JSDoc）|
| HOOK-03 | 高 | 命名设计 | `src/runtime/JalangiRuntime.js`、`wrappers.js` | P2（重命名 `_`）|
| HOOK-04 | 中 | 配置设计 | `src/instrument/pluginAnalyzer.js`、`wrappers.js` | P2（新增 `INSTR_WITH`/`INSTR_AWAIT`）|
| HOOK-05 | 低 | 命名设计 | `src/runtime/JalangiRuntime.js` | P3（注释说明）|
| CALLBACK-01 | 高 | 命名设计 | `src/runtime/analysisCallbackTemplate.js` | P2（重命名 `invokeFun`）|
| CALLBACK-02 | 中 | 文档缺失 | `src/runtime/analysisCallbackTemplate.js` | P3（补充文档说明）|
| CALLBACK-03 | 中 | 命名设计 | `src/runtime/analysisCallbackTemplate.js` | P3（文档约定或重构时统一）|
| CALLBACK-04 | 中 | 命名设计 | `src/runtime/analysisCallbackTemplate.js` | P2（重命名，去掉下划线前缀）|
| CALLBACK-05 | 低 | 命名设计 | `src/runtime/analysisCallbackTemplate.js` | P3（重命名 `forinObject`）|
| CALLBACK-06 | 低 | 文档缺失 | `src/runtime/analysisCallbackTemplate.js` | P3（补充文档说明）|
