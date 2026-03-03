# 插桩引擎

源码位置：`src/instrument/`

## 概述

插桩引擎是 Jalangi2 的核心组件，负责将普通 JavaScript 源代码转换为带有分析钩子的插桩代码。
整个过程分为四步：**解析 → AST 变换 → 代码生成 → 输出**。

```
JavaScript 源代码
       │
       ▼  acorn.parse()（支持 ES2022+）
AST（带 loc/scope 信息）
       │
       ▼  Pass 0（可选）：visitorCloneBodyPre — 采样模式克隆函数体
       │  Pass 1：visitorRRPre（前序）+ visitorRRPost（后序）— 主插桩
       │  Pass 2：visitorOps（后序）— 运算符/控制流插桩
       │  Pass 3（可选）：visitorMergeBodyPre — 采样模式合并
       ▼
插桩后 AST
       │
       ▼  hoistFunctionDeclaration() — 函数声明提升（Firefox 兼容）
       │
       ▼  astring.generate()（支持 ES2022+）
插桩后 JavaScript 代码（含 IIFE 包裹 / module 绑定）
```

## 对外 API

### `init(config, analysis?, sid?, jalangiVar?)`

初始化插桩器，**必须在第一次调用 `instrumentCode` 之前调用**。

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `object` | Jalangi Config 对象，见 [Configuration.md](./Configuration.md) |
| `analysis` | `object?` | 当前分析对象（可选），用于 `instrumentCodePre` / `instrumentCode` 钩子 |
| `sid` | `*?` | 当前脚本 ID（eval 场景下的 source map） |
| `jalangiVar` | `string?` | 沙盒变量名，默认 `'J$'`，可自定义避免冲突 |

```js
import { init } from './src/instrument/esnstrument.js';

init({
    INSTR_READ: null,         // null = 全部插桩
    INSTR_WRITE: null,
    ENABLE_SAMPLING: false,
    // ... 其余 Config 字段
});
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
    code:            string,   // 插桩后的代码字符串
    instAST:         object,   // 插桩后的 AST（可用于调试）
    sourceMapObject: object,   // iid → [startLine, startCol, endLine, endCol] 映射
    sourceMapString: string,   // sourceMapObject 的 JSON 字符串
}
```

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

### 变量读写

```js
// 原始代码
x

// 插桩后
J$.R(iid, 'x', x, flags)
```

```js
// 原始代码
x = expr

// 插桩后
J$.W(iid, 'x', J$.R(iid2, 'x', x, flags), expr, flags)
```

### 属性读写

```js
// 原始代码：点表达式
obj.prop

// 插桩后
J$.G(iid, obj, 'prop', flags)
```

```js
// 原始代码：计算属性
obj[key]

// 插桩后
J$.G(iid, obj, J$.R(iid2, 'key', key, flags), flags)
```

```js
// 原始代码
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
```

```js
// 原始代码：方法调用
obj.method(args)

// 插桩后
J$.M(iid, obj, 'method', flags)(args)
```

### 字面量

```js
// 原始代码
42
'hello'
{}
[]
function() {}

// 插桩后（分别）
J$.T(iid, 42, J$.N_LOG_NUMBER_LIT, false)
J$.T(iid, 'hello', J$.N_LOG_STRING_LIT, false)
J$.T(iid, {}, J$.N_LOG_OBJECT_LIT, false)
J$.T(iid, [], J$.N_LOG_ARRAY_LIT, false)
J$.T(iid, function() { J$.Fe(iid2, ...); ... J$.Fr(iid3); }, J$.N_LOG_FUNCTION_LIT, false)
```

### 二元/一元运算

```js
// 原始代码
a + b
!x

// 插桩后
J$.B(iid, '+', a, b, flags)
J$.U(iid, '!', x)
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

每个（非箭头）函数体自动注入：

```js
function foo(a, b) {
    // 插桩后头部
    J$.Fe(iid, foo, this, arguments);
    try {
        // ... 原函数体（插桩后）
        return J$.Rt(iid2, returnVal);
    } finally {
        J$.Fr(iid3);
    }
}
```

> **注意**：箭头函数（`ArrowFunctionExpression`）没有独立的 `arguments` / `this`，
> 不注入 `J$.Fe` / `J$.Fr`，但仍然插桩其体内的所有表达式。

## IID（指令 ID）系统

每次 `instrumentCode` 调用前，`iid.js` 的 `initialize()` 会重置三个独立计数器：

| 计数器 | 用途 | 初始值 |
|--------|------|--------|
| `memIid` | 主计数器（R/W/G/P/F/M/T/N/Fe/Fr/Se/Sr） | `9`（eval: `13`） |
| `condIid` | 条件/switch 计数器（C/C1/C2） | `8`（eval: `12`） |
| `opIid` | 运算符计数器（B/U） | `10`（eval: `14`） |

**步长为 8**：同一 AST 节点的多个子操作共享一段 IID 空间：
- 方法调用：`iid`（主调用）、`iid+2`（内部 getField）

**源码位置映射**：每个 IID 对应一个 `[startLine, startCol, endLine, endCol]` 元组，
存储在 `iidSourceInfo` 对象中，最终作为 `sourceMapObject` 返回或内联到代码头部。

## 作用域分析

插桩前，`scope.js` 的 `addScopes()` 会对 AST 进行一遍预扫描，
为每个作用域节点（Program / Function / CatchClause）附加 `.scope` 属性：

```js
scope.vars = {
    'x':   'var',    // var 声明
    'a':   'arg',    // 函数参数
    'foo': 'defun',  // 函数声明（function foo() {}）
    'bar': 'lambda', // 函数表达式（var bar = function() {}）
    'e':   'catch',  // catch 子句参数
}
```

插桩时，`wrappers.js` 通过 `getScope().isGlobal(name)` 判断变量是否为全局变量，
从而在 `J$.R` / `J$.W` 调用中设置 `isGlobal` 标志位。

## 输出格式

### script 模式

```js
// 输出结构（精简版）
(globalThis.J$ = globalThis.J$ || {});
J$.smap = J$.smap || {};
J$.smap["example_inst.js"] = { nBranches: 4, originalCodeFileName: "example.js", ... };
J$.iids = { nBranches: 4, originalCodeFileName: "example.js", ... };
(function(J$){
    // 插桩后的代码体
    // ...
}(typeof J$!=='undefined'?J$:{}));
// JALANGI DO NOT INSTRUMENT
```

### module 模式

```js
(globalThis.J$ = globalThis.J$ || {});
J$.smap = J$.smap || {};
J$.smap["example_inst.js"] = { ... };
J$.iids = { ... };
const J$ = globalThis.J$;
// 插桩后的代码体
// JALANGI DO NOT INSTRUMENT
```

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

## 模板缓存优化

`wrappers.js` 中的 `replaceInStatement(templateStr, ...args)` 函数：

1. 第一次调用时，用 `acorn.parse` 解析模板字符串并缓存 AST
2. 后续调用通过 `deepCloneAndReplace` 深拷贝缓存的 AST，替换占位符
3. 占位符格式：`J$_1`、`J$_2`（RP 前缀 = `"J$_"`，可随沙盒变量名变化）

这种方式避免了每次注入钩子都重新 parse，大幅提升大文件插桩性能。

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
