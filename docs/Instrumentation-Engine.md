# DOC-02 · 插桩引擎

源码位置：`src/instrument/`

## 概述

插桩引擎是 Jani 的核心组件，负责将普通 JavaScript 源代码转换为带有分析钩子的插桩代码。
整个过程为：**解析 → 作用域分析 → 静态 def-use 分析（Pass 0）→ 单次统一插桩 Pass → 代码生成 → 输出**。

```mermaid
flowchart TD
    SRC["JavaScript 源代码"]
    PARSE["@babel/parser 解析\n支持 ES2022+ 及实验性语法"]
    AST1["File AST（含 loc 信息）"]
    SCOPE["addScopes(file)\n作用域分析（@babel/traverse）\n附 .scope（ScopeID / hasWith / hasEval / varKind）"]
    AST2["AST（含 loc / scope 信息）"]
    DU["analyzeDefUse() — Pass 0\n静态 def-use 分析"]
    DMAP["插桩决策表 Map&lt;nodeKey,'full'|'lightweight'&gt;"]
    CLONE["Pass −1（ENABLE_SAMPLING 时）\nvisitorCloneBodyPre — 克隆函数体"]
    MAIN["runInstrumentPass()\n单次 @babel/traverse\n字面量/读写/运算符/函数进出 统一处理\nreplaceAndMark 防止节点重复插桩"]
    MERGE["Pass +1（ENABLE_SAMPLING 时）\nvisitorMergeBodyPre — 合并采样函数体"]
    IAST["插桩后 AST"]
    GEN["@babel/generator 代码生成"]
    OUTPUT["插桩后 JavaScript 代码"]

    SRC --> PARSE --> AST1 --> SCOPE --> AST2
    AST2 --> DU --> DMAP
    AST2 --> CLONE
    DMAP --> MAIN
    CLONE --> MAIN --> MERGE --> IAST
    IAST --> GEN --> OUTPUT
```

## 对外 API

### `init(config, analysis?, sid?, jalangiVar?, plugins?)`

初始化插桩器，**必须在第一次调用 `instrumentCode` 之前调用**。

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `object \| null` | Jalangi Config 对象，见 [Configuration.md](./Configuration.md)；若传 `null` 且提供 `plugins`，则自动推导 Config |
| `analysis` | `object?` | 当前分析对象（可选），用于 `instrumentCodePre` / `instrumentCode` 钩子 |
| `sid` | `*?` | 当前脚本 ID（eval 场景下的 source map） |
| `jalangiVar` | `string?` | 沙盒变量名，默认 `'J$'`，可自定义避免冲突 |
| `plugins` | `Array<string\|object>?` | 插件路径或实例列表；当 `config` 为 `null` 时，自动静态分析插件所用 Hook，生成最小化 Config |

```js
import { init } from './src/instrument/esnstrument.js';

// 方式一：手动传入 Config
init({
    INSTR_READ: null,         // null = 全部插桩
    INSTR_WRITE: null,
    ENABLE_SAMPLING: false,
    // ... 其余 Config 字段
});

// 方式二：传入 plugins，自动推导 Config（config 传 null）
init(null, undefined, undefined, undefined, ['./src/plugins/dlint/CheckNaN.js']);
```

### `instrumentCode(options)`

对代码字符串进行插桩，返回插桩结果对象。

#### 参数 `options`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `code` | `string` | 必填 | 要插桩的 JS 源代码 |
| `origCodeFileName` | `string` | `'eval'` | 原始文件名（source map 用） |
| `instCodeFileName` | `string` | `'eval'` | 插桩后文件名 |
| `inlineSourceMap` | `boolean` | `false` | `true` → 将完整 iid→位置 map 内联到输出头部 |
| `inlineSource` | `boolean` | `false` | `true` → 将原始源码内联到 source map |
| `sourceType` | `'script'\|'module'` | `'script'` | ESM 模式支持顶层 await |
| `isEval` | `boolean` | `false` | 是否是 eval 动态代码 |
| `thisIid` | `number?` | — | eval 时的调用点 IID |
| `isDirect` | `boolean?` | — | eval 是否是直接调用 |
| `url` | `string?` | — | 脚本 URL（可选，写入 sourceMap） |

#### 返回值

```ts
{
    code:            string,          // 插桩后的代码字符串
    instAST:         object,          // 插桩后的 AST（可用于调试）
    sourceMapObject: IidSourceMap,    // Jalangi 自有格式：iid → [startLine, startCol, endLine, endCol] + 元数据
    sourceMapString: string,          // sourceMapObject 的 JSON 字符串
    vlcqSourceMap:   VlcqSourceMap | null,  // 标准 v3 source map（可写为 .js.map，供 DevTools 调试器使用）
}
```

其中 `vlcqSourceMap` 是由 `@babel/generator` 生成的标准 VLCQ 格式 source map（v3），包含 `version`、`sources`、`mappings`、`sourcesContent` 等字段，可直接写入 `.js.map` 文件。  
仅在代码被实际插桩时有值（若代码包含 `// JALANGI DO NOT INSTRUMENT` 则为 `null`）。

#### 示例

```js
import { init, instrumentCode } from './src/instrument/esnstrument.js';

init({ ENABLE_SAMPLING: false });

const result = instrumentCode({
    code:             'var x = 1 + 2; console.log(x);',
    origCodeFileName: 'example.js',
    instCodeFileName: 'example_inst.js',
    inlineSourceMap:  true,
    sourceType:       'script',
});

console.log(result.code);           // 插桩后代码
console.log(result.sourceMapObject); // IID → 位置映射
```

### `instrumentEvalCode(code, iid, isDirect)`

eval 插桩的快捷包装，自动内联 source map 和原始代码。

```js
import { instrumentEvalCode } from './src/instrument/esnstrument.js';

const instrCode = instrumentEvalCode('var x = 1;', 42, true);
```

## 插桩变换详解

### 变量读写（统一 Pass 处理）

变量读取有**两条路径**，插桩器在静态分析阶段决定走哪条：

**全量读取路径**（全局变量、含 `eval`/`with` 的作用域、`catch` 参数、`arguments`）：

```js
// 原始代码
x

// 插桩后（全量路径 — 含 scopeId 参数）
J$.R(iid, 'x', x, flags, defScopeId)
// 其中：flags = bitPattern(isGlobal, isScriptLocal)；全局变量无 defScopeId
```

**轻量读取路径**（静态可确认的局部变量：非全局、无 eval/with、非 catch 参数、非 arguments、**非箭头函数形参**）：

```js
// 原始代码
x

// 插桩后（轻量路径 — 不传 value，运行时从 Shadow Frame 查值）
J$.Rl(iid, defScopeId, 'x')
```

变量写入（带 `scopeId` 参数，供运行时更新 Shadow Frame）：

```js
// 原始代码
x = expr

// 插桩后
J$.W(iid, 'x', expr, x, flags, defScopeId)
// 其中：flags = bitPattern(isGlobal, isScriptLocal, isDeclaration)
```

**读取路径决策流程**：

```mermaid
flowchart TD
    Q1{"作用域含 eval 或 with?"}
    Q2{"是全局变量?"}
    Q3{"是 catch 参数\n或 arguments?"}
    Q4{"能静态确定\n定义作用域?"}
    FULL["全量路径\nJ$.R(iid, name, val, flags, defScopeId)"]
    LIGHT["轻量路径\nJ$.Rl(iid, defScopeId, name)"]

    Q1 -->|"是"| FULL
    Q1 -->|"否"| Q2
    Q2 -->|"是"| FULL
    Q2 -->|"否"| Q3
    Q3 -->|"是"| FULL
    Q3 -->|"否"| Q4
    Q4 -->|"否"| FULL
    Q4 -->|"是"| Q5{{"是箭头函数形参?\ndefScope.isArrow"}}
    Q5 -->|"是"| FULL
    Q5 -->|"否"| LIGHT
```

### 属性读写

```js
// 原始代码：点表达式
obj.prop
// 插桩后
J$.G(iid, obj, 'prop', flags)  // flags[3]=isOptional=0

// 原始代码：计算属性
obj[key]
// 插桩后
J$.G(iid, obj, J$.R(iid2, 'key', key, flags), flags)

// 原始代码：可选链属性读取
obj?.prop
// 插桩后（isOptional=true 编入 flags 第 4 位）
J$.G(iid, obj, 'prop', flags)  // flags[3]=isOptional=1
// 运行时：若 obj 为 null/undefined，直接短路返回 undefined，不触发 getFieldPre/getField

// 原始代码：属性写入
obj.prop = val
// 插桩后
J$.P(iid, obj, 'prop', val, flags)
```

### 函数调用

```js
// 原始代码：普通函数调用
func(args)
// 插桩后
J$.F(iid, func, flags)(args)

// 原始代码：方法调用
obj.method(args)
// 插桩后
J$.M(iid, obj, 'method', flags)(args)
```

### 字面量

```js
// 原始代码 → 插桩后
42            → J$.T(iid, 42, J$.N_LOG_NUMBER_LIT, false)
42n           → J$.T(iid, 42n, J$.N_LOG_BIGINT_LIT, false)
'hello'       → J$.T(iid, 'hello', J$.N_LOG_STRING_LIT, false)
{}            → J$.T(iid, {}, J$.N_LOG_OBJECT_LIT, false)
[]            → J$.T(iid, [], J$.N_LOG_ARRAY_LIT, false)
function() {} → J$.T(iid, function() { J$.Fe(iid2, ...); ... J$.Fx(iid3); }, J$.N_LOG_FUNCTION_LIT, false)
```

### 二元/一元运算

```js
a + b  →  J$.B(iid, '+', a, b, flags)
!x     →  J$.U(iid, '!', x)
```

### 条件表达式

```js
// 原始代码
if (cond) { ... }
while (cond) { ... }
cond ? a : b

// 插桩后（test 部分）
if (J$.C(iid, cond)) { ... }
```

### 函数进入/退出

每个（非箭头）函数体自动注入。`J$.Fe` 第五个参数 `defScopeId` 为函数定义点的静态作用域 ID，供运行时创建 Shadow Frame：

```js
function foo(a, b) {
    // 插桩后头部（defScopeId = 函数所在 Scope 的 id，由插桩器静态注入）
    J$.Fe(iid, foo, this, arguments, defScopeId);
    try {
        // ... 原函数体（插桩后）
        return J$.Rt(iid2, returnVal);
    } finally {
        J$.Fx(iid3);
    }
}
```

> **注意**：箭头函数（`ArrowFunctionExpression`）没有独立的 `arguments` / `this`，
> 不注入 `J$.Fe` / `J$.Fx`，但仍然插桩其体内的所有表达式。

## IID（指令 ID）系统

每次 `instrumentCode` 调用前，`iid.js` 的 `initialize()` 会重置三个独立计数器：

| 计数器 | 用途 | 初始值 |
|--------|------|--------|
| `memIid` | 主计数器（R/W/G/P/F/M/T/Dc/Fe/Fx/Se/Sr） | `9`（eval: `13`） |
| `condIid` | 条件/switch 计数器（C/C1/C2） | `8`（eval: `12`） |
| `opIid` | 运算符计数器（B/U） | `10`（eval: `14`） |

**步长为 8**：同一 AST 节点的多个子操作共享一段 IID 空间：
- 方法调用：`iid`（主调用）、`iid+2`（内部 getField）

**源码位置映射**：每个 IID 对应一个 `[startLine, startCol, endLine, endCol]` 元组，
存储在 `iidSourceInfo` 对象中，最终作为 `sourceMapObject` 返回或内联到代码头部。

## 作用域分析

插桩前，`scope.js` 的 `addScopes(file, jalangiVar)` 会对 AST 进行一遍预扫描，
为每个作用域节点（Program / Function / CatchClause）附加 `.scope` 属性。

> **注意**：`addScopes` 接受 `@babel/parser` 返回的 **`File` 节点**（`{ type: 'File', program: Program }`），
> 内部使用 `@babel/traverse` 遍历，不再接受裸 `Program` 节点。

#### `arguments` 重命名

`addScopes` 会对函数参数中出现的 `arguments` 标识符进行**就地 AST 重命名**：将其改为
`${jalangiVar}_arguments`（如默认的 `J$_arguments`），同时在作用域表中以新名称注册。
目的是防止插桩产生的 `arguments` 引用与用户传入的 `arguments` 形参互相遮蔽。

此重命名处理覆盖以下所有参数形式：

| 参数形式 | 示例 | 是否重命名 |
|---------|------|-----------|
| 简单标识符 | `function f(arguments)` | ✅ 重命名 |
| 解构对象参数 | `function f({arguments})` | ✅ 重命名（BUG-2 修复）|
| 解构数组参数 | `function f([arguments])` | ✅ 重命名（BUG-2 修复）|
| 嵌套解构 / 默认值 / RestElement | `function f({a: {arguments}})` | ✅ 重命名（BUG-2 修复）|

**`wrappers.js` 中的对应处理**：`createCallAsFunEnterStatement`（生成 `J$.Fe` 调用）和
`syncDefuns`（生成 `J$.Dc` arguments 初始化）均会检查当前作用域是否存在 `${_jalangiVar}_arguments`
变量——若存在，则使用重命名后的标识符，而非硬编码的 `arguments`（BUG-11A 修复）。

> **重要**：`J$.Dc(iid, "arguments", ...)` 和 `J$.Fe(iid, f, this, ...)` 中的
> **名称字符串**始终使用原始 `"arguments"`，只有 **AST 标识符节点**（变量读取部分）使用重命名后的名称。
> 这保证了运行时 Shadow Frame 通过标准名称 `"arguments"` 查找，不受重命名影响。

### Scope 对象结构

```js
// scope.vars：变量名 → 声明类型（string）
scope.vars = {
    'x':   'var',    // var 声明
    'a':   'arg',    // 函数参数
    'foo': 'defun',  // 函数声明（function foo() {}）
    'bar': 'lambda', // 函数表达式（var bar = function() {}）
    'e':   'catch',  // catch 子句参数
}

// scope.varKinds：变量名 → 声明关键字（用于 const dead-read 消除等优化）
scope.varKinds = {
    'x':   'var',   // var 声明
    'y':   'let',   // let 声明
    'z':   'const', // const 声明（值不可变，可做 dead-read 消除）
}
```

### Scope 关键属性

| 属性/方法 | 说明 |
|-----------|------|
| `scope.id` | 本作用域的唯一整数 ID（每次 `instrumentCode` 重置，跨调用单调递增） |
| `scope.hasEval_` / `scope.usesEval()` | 作用域链内出现过 `eval` 标识符时为 `true`，禁用轻量读取路径 |
| `scope.hasWith_` / `scope.usesWith()` | 作用域链内出现过 `with` 语句时为 `true`，禁用轻量读取路径 |
| `scope.hasVar(name)` | 查询作用域链中是否存在该变量 |
| `scope.hasOwnVar(name)` | 仅查询本层作用域（用于 `_findDefScope` 遍历） |
| `scope.isGlobal(name)` | 判断变量是否为全局变量（设置 `isGlobal` 标志） |
| `scope.getVarKind(name)` | 获取变量的声明关键字（`'var'`/`'let'`/`'const'` 或 `undefined`） |

### 轻量路径判断（`instrumentLoad` 决策流程）

`wrappers.js` 的 `instrumentLoad` 优先查询 `dataflow.js` 生成的静态决策表，再结合安全兜底条件判断是否走轻量路径：

```
1. 查 _instrDecisions（静态决策表）：
   - decision === 'lightweight' 且满足安全兜底条件 → J$.Rl
   - decision === 'full' → J$.R
   - decision === null（决策表无记录，如闭包变量）→ 退化为 fallback 判断（见下）

2. Fallback 保守判断（决策表无记录时）：
   满足以下全部条件 → J$.Rl，否则 J$.R：
   - defScope !== null（能静态确定定义点）
   - !isGlobal（不是全局变量）
   - !scope.usesEval()（作用域链无 eval）
   - !scope.usesWith()（作用域链无 with）
   - defScope.hasOwnVar(name) !== 'catch'（不是 catch 参数）
   - name !== 'arguments'（不是 arguments 对象）

3. 安全兜底条件（decision === 'lightweight' 时仍需满足）：
   - defScope !== null
   - !isGlobal
   - defScope.hasOwnVar(name) !== 'catch'
   - name !== 'arguments'
   - !defScope.isArrow（箭头函数形参强制走全量路径）
```

全量路径 `J$.R` 携带 `defScopeId` 参数供运行时同步 Shadow Frame。

## 静态 Def-Use 分析（`dataflow.js`）

`src/instrument/dataflow.js` 实现了 **Pass 0 静态 SSA def-use 分析**，
在 `addScopes()` 之后、`transformAst()` 之前对原始 AST 执行，产出**插桩决策表**。

### 决策类型

| 决策 | 说明 | 对应插桩钩子 |
|------|------|-----------|
| `'full'` | 全量插桩（全局变量、含 eval/with、catch 参数等） | `J$.R(...)` |
| `'lightweight'` | 轻量插桩（静态确认的局部变量） | `J$.Rl(...)` |
| `'dead'` | 可省略的 dead read（当前保守实现降级为 lightweight，保留供未来扩展） | — |

### 分析算法（两阶段）

```mermaid
flowchart TD
    SCOPE_NODE["作用域节点\n(Program / Function / ClassMethod)"]
    PHASE1["阶段 1：Def-Sites 收集\n扫描 AssignmentExpression / UpdateExpression\n构建 Map&lt;name, DefInfo&gt;\n记录赋值点数量、是否条件分支、声明类型、hasMutation"]
    PHASE2["阶段 2：Use-Sites 决策\n遍历所有 RHS 上下文的 Identifier\n（自行判断 IGNORE 上下文，不依赖 _isRHS 标注）"]
    UNSAFE{"含 eval / with\n或是全局变量?"}
    DEFINFO["查 DefInfo\n(阶段 1 产出)"]
    NODEF{"未在此作用域\n声明?\n（闭包引用）"}
    FALLBACK["不记录决策\n→ instrumentLoad fallback 判断"]
    FULL["Decision.FULL\n→ J$.R(...)"]
    LIGHT["Decision.LIGHTWEIGHT\n→ J$.Rl(...)"]
    RECURSE["递归处理\n所有子作用域"]

    SCOPE_NODE --> PHASE1 --> PHASE2
    PHASE2 --> UNSAFE
    UNSAFE -->|"是"| FULL
    UNSAFE -->|"否"| DEFINFO
    DEFINFO --> NODEF
    NODEF -->|"是（来自父作用域）"| FALLBACK
    NODEF -->|"否"| LIGHT
    PHASE2 --> RECURSE
```

**阶段 1：Def-Sites 收集**

对每个函数作用域，扫描所有 `AssignmentExpression`、`UpdateExpression` 和变量声明，
构建 `Map<name, DefInfo>`，记录：
- 赋值点数量、是否在条件分支内、声明类型（`const`/`let`/`var`/`param`）
- `hasMutation`：作用域内是否有以该变量为对象的属性写入（`obj.prop = ...`），若有则无论声明类型均强制 `'full'`（轻量路径感知不到对象属性变动）

> **`_isRHS` 时序注意**：`dataflow.js` 在 `transformAst` 之前运行（Pass 0），此时节点上还没有 `_isRHS` 标注。模块内部通过 `_isIgnoreContext(parent, key, child)` 自行重现 `astUtil.js` 的 IGNORE 上下文判断，避免对赋值左侧、声明 id、标签等非 RHS 位置生成错误决策。

**阶段 2：Use-Sites 决策**

对每个 RHS 上下文的 Identifier：
- 作用域含 `eval`/`with` 或变量是全局变量 → `'full'`
- 变量来自父作用域（闭包引用）→ **不记录到决策表**，交由 `instrumentLoad` 的 fallback 逻辑处理
- `hasMutation = true` → `'full'`
- `const` 声明 / 无重赋值的 `param` → `'lightweight'`
- 有重赋值/多 def-site/条件赋值 → `'lightweight'`

### 使用方式

```js
import { analyzeDefUse, Decision } from './src/instrument/dataflow.js';

// 通常由 esnstrument.js 的 transformString 自动调用
const decisions = analyzeDefUse(ast);     // ast 已经过 addScopes 处理

// 查询某个 use-site 的决策
// nodeKey = `${scopeId}:${name}:${line}:${col}`
const key = `0:x:2:8`;
const decision = decisions.get(key);      // → 'full' | 'lightweight' | undefined
```

### 保守近似原则

宁可错判成 `lightweight`，也不错判成 `dead`：
- 变量被传入函数（可能被修改）→ `lightweight`
- 变量在 `try` 块内 → `lightweight`
- 作用域内有任何 `eval` 或 `with` → `full`
- 变量作为对象被做属性写入（`hasMutation`）→ `full`
- 闭包引用（变量来自父作用域）→ 不记录，交 fallback 判断

## 插件静态分析器（`pluginAnalyzer.js`）

`src/instrument/pluginAnalyzer.js` 提供**自动推导按需 Config** 的能力，
避免手动为每个插件维护 Config 对象。

### 对外 API

| 函数 | 说明 |
|------|------|
| `analyzePluginHooks(plugins)` | 从插件路径或实例提取使用的 Hook 名称集合 `Set<string>` |
| `buildConfigFromHooks(usedHooks)` | 根据 Hook 集合构建最小化 Config 对象 |
| `buildConfigFromPlugins(plugins)` | 两者的组合快捷函数 |
| `fullConfig()` | 返回全量插桩的 Config（所有字段均为 `null`）|

```mermaid
flowchart LR
    PLUGINS["插件列表\n(路径字符串 / 实例对象)"]
    ANALYZE["analyzePluginHooks()\n静态 AST 扫描或运行时反射\n提取 Hook 方法名"]
    HOOKS["Set&lt;hookName&gt;\ne.g. {'binary', 'read'}"]
    BUILD["buildConfigFromHooks()\n已使用 Hook → 对应 Config 字段 = null\n未使用 Hook → 对应 Config 字段 = () => false"]
    CONFIG["最小化 Config 对象"]

    PLUGINS --> ANALYZE --> HOOKS --> BUILD --> CONFIG
```

**Hook → Config 字段映射（摘要）**：

| Hook | 需要开启的 Config 字段 |
|------|---------------------|
| `read` | `INSTR_READ` |
| `write` | `INSTR_WRITE` |
| `getFieldPre` / `getField` | `INSTR_GETFIELD` |
| `putFieldPre` / `putField` | `INSTR_PUTFIELD`, `INSTR_PROPERTY_BINARY_ASSIGNMENT` |
| `binaryPre` / `binary` | `INSTR_BINARY` |
| `unaryPre` / `unary` | `INSTR_UNARY` |
| `literal` | `INSTR_LITERAL` |
| `declare` | `INSTR_INIT`, `INSTR_TRY_CATCH_ARGUMENTS` |
| `conditional` | `INSTR_CONDITIONAL` |
| `functionEnter` / `functionExit` | `INSTR_TRY_CATCH_ARGUMENTS` |
| `scriptEnter` / `scriptExit` | `INSTR_TRY_CATCH_ARGUMENTS` |
| `endExpression` | `INSTR_END_EXPRESSION` |
| `callPre` / `call` | `INSTR_INVOKE` |
| `returnStmt` | `INSTR_RETURN` |
| `throwStmt` | `INSTR_THROW` |
| `forIn` | `INSTR_FORIN` |
| `awaitResume` | `INSTR_AWAIT` |

> **注意**：`withStmt` hook 在 `pluginAnalyzer.js` 中映射到 `INSTR_WITH`（独立的 with 语句控制开关）。

### 示例

```js
import { buildConfigFromPlugins } from './src/instrument/pluginAnalyzer.js';
import { init, instrumentCode }  from './src/instrument/esnstrument.js';

// 自动分析插件，推导最小化 Config
const config = buildConfigFromPlugins(['./src/plugins/dlint/CheckNaN.js']);
init(config);

// 或通过 init() 直接传入 plugins（config 传 null）
init(null, undefined, undefined, undefined, ['./src/plugins/dlint/CheckNaN.js']);
```

## 输出格式

### script 模式

```js
// 输出结构（精简版）
// 第 1 行：smap 注入头（script 模式 = 1 行头）
(globalThis.J$=globalThis.J$||{});J$.smap=J$.smap||{};J$.smap["example_inst.js"]={nBranches:4,...};J$.iids={nBranches:4,...};
// 第 2 行起：插桩后的代码体（直接输出，不再用 IIFE 包裹）
var x = J$.B(9, '+', J$.T(17, 1, 22, false), J$.T(25, 2, 22, false), 0);
// JALANGI DO NOT INSTRUMENT
```

> **注意**：script 模式不再使用 IIFE（`(function(J$){...}(...))`）包裹。
> 插桩后代码直接输出，`J$` 通过头部 `globalThis.J$` 初始化单例。

### module 模式

```js
// 第 1 行：smap 注入头
(globalThis.J$=globalThis.J$||{});J$.smap=J$.smap||{};J$.smap["example_inst.js"]={...};J$.iids={...};
// 第 2 行：const 绑定（把全局单例绑定到模块内作用域）
const J$ = globalThis.J$;
// 第 3 行起：插桩后的代码体
// ...
// JALANGI DO NOT INSTRUMENT
```

> **注意**：module 模式无法用 `var` 赋全局，却需要 `J$` 在整个模块作用域内可用。
> 因此头部附加一行 `const J$ = globalThis.J$` 将全局单例绑定到模块内。

### `// JALANGI DO NOT INSTRUMENT`

输出末尾自动追加此注释，防止已插桩的代码被二次插桩。
`instrumentCode` 在处理前会检查代码是否包含此注释，如果包含则直接跳过插桩。

## AST 遍历上下文（CONTEXT 枚举）

`astUtil.js` 中的 `CONTEXT` 枚举告知 visitor 当前节点的语义环境：

| 枚举值 | 场景 | 插桩行为 |
|--------|------|---------|
| `CONTEXT.RHS` | 右值（读取）| 插桩 R/G/T 等 |
| `CONTEXT.IGNORE` | 赋值左侧、标签名、解构 key | **不插桩** |
| `CONTEXT.METHOD` | class 方法的 FunctionExpression | 不包装为独立字面量 |
| `CONTEXT.GETTER` | getter 函数体 | 不包装为独立字面量 |
| `CONTEXT.SETTER` | setter 函数体 | 不包装为独立字面量 |
| `CONTEXT.TYPEOF` | `typeof x` 的操作数 | 插桩 R（不触发 ReferenceError）|
| `CONTEXT.OEXP` | ObjectExpression 属性列表 | 特殊处理 |
| `CONTEXT.PARAMS` | 函数形参 | 不插桩 |

## AST 直接构建（Phase 4 重构）

`wrappers.js` 中所有包装函数均已迁移为使用 **`@babel/types` 工厂函数直接构建 AST 节点**，
彻底消除了旧版字符串模板解析方案（`replaceInStatement` / `replaceInExpr`）的运行时 parse 开销。

### 核心辅助函数

| 函数 | 作用 |
|------|------|
| `memberExpr(obj, prop)` | 构建 `J$.xxx` 形式的 `MemberExpression` |
| `callExpr(callee, args)` | 构建 `CallExpression` |
| `jalangiCall(name, args)` | 构建 `J$.name(args)` 调用表达式 |
| `transferLoc(dst, src)` | 将源节点的位置信息复制到目标节点 |
| `replaceAndMark(path, newNode)` | 替换节点并打 `__j_instrumented` 标记，防止二次插桩 |

### 各 wrap 函数使用的构建方式

所有高频插桩函数（`wrapRead`、`wrapWrite`、`wrapLiteral`、`wrapGetField`、`wrapPutField`、
`wrapMethodCall`、`wrapAwait`、`createCallAsFunEnterStatement`、`wrapForIn`、
`wrapScriptBodyWithTryCatch`、`wrapFunBodyWithTryCatch`）均已改为 `@babel/types` 直接构建。

> `replaceInStatement` / `replaceInExpr` 保留在文件末尾作为**参考实现**，
> 已无任何内部调用方，可在将来清理。

## 采样模式（ENABLE_SAMPLING）

当 `Config.ENABLE_SAMPLING = true` 时，插桩器对每个函数体生成两个版本：

```js
function foo() {
    if (!J$.S(iid, arguments.callee)) {
        // 原始未插桩代码（bodyOrig）
    } else {
        // 插桩后代码
    }
}
```

`J$.S(iid, callee)` 由运行时决定是否对该次调用执行插桩版本，
实现基于采样率的性能优化。
