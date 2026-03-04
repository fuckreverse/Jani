# 分析插件开发指南

## 概述

Jalangi2 允许开发者通过编写**分析插件（Analysis Plugin）**来监测和修改 JavaScript 程序的运行时行为。
每个分析插件是一个普通的 JavaScript 类，实现一组钩子（hook）方法。
当插桩代码执行到相应操作时，运行时会调用对应的钩子。

**插件生命周期**：

```mermaid
flowchart TD
    INIT["初始化\nnew JalangiSandbox()\nJ$.analysis = new AnalysisHost()"]
    REG["注册插件\nJ$.analysis.use(new MyAnalysis(J$))"]
    SE["onReady(cb) — 异步初始化完成\nscriptEnter — 脚本开始执行"]
    HOOKS["运行时事件循环\n每次操作触发对应钩子\nread / write / getField / binary / ..."]
    FN_LIFE["函数生命周期\nfunctionEnter → [函数体执行] → functionExit"]
    SR["scriptExit — 脚本执行完毕"]
    END["endExecution — 程序结束\n输出分析结果"]

    INIT --> REG --> SE --> HOOKS
    HOOKS --> FN_LIFE
    FN_LIFE --> HOOKS
    HOOKS --> SR --> END
```

## 快速开始

### 1. 创建分析插件类

```js
// my-analysis.js

// JALANGI DO NOT INSTRUMENT

/**
 * 示例分析：统计变量读取次数
 */
export class ReadCountAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._readCounts = {};
    }

    read(iid, name, val, isGlobal, isScriptLocal) {
        this._readCounts[name] = (this._readCounts[name] ?? 0) + 1;
        return { result: val };  // 不修改值
    }

    endExecution() {
        console.log('Variable read counts:', this._readCounts);
    }
}
```

### 2. 注册插件并运行

```js
// setup.js

import { JalangiSandbox }     from './src/runtime/JalangiSandbox.js';
import { ReadCountAnalysis }   from './my-analysis.js';

// 初始化沙盒
const J$ = globalThis.J$ = new JalangiSandbox();

// 注册分析插件
J$.analysis.use(new ReadCountAnalysis(J$));
```

## 所有可用钩子

以下所有钩子方法均可选实现，未实现的方法不影响程序语义（被动观测模式）。

```mermaid
mindmap
  root((分析钩子))
    函数调用
      invokeFunPre
      invokeFun
    属性访问
      getFieldPre
      getField
      putFieldPre
      putField
    变量读写
      read
      write
    字面量与声明
      literal
      declare
    运算
      binaryPre
      binary
      unaryPre
      unary
    条件与控制流
      conditional
      _return
      _throw
      _with
      forinObject
    函数生命周期
      functionEnter
      functionExit
    脚本生命周期
      scriptEnter
      scriptExit
      endExecution
      onReady
    其他
      endExpression
      instrumentCodePre
      instrumentCode
      runInstrumentedFunctionBody
```

### 函数调用

#### `invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid)`

函数/方法/构造器调用之**前**触发。

| 参数 | 说明 |
|------|------|
| `iid` | 指令 ID |
| `f` | 被调函数对象 |
| `base` | 接收者（this）|
| `args` | 参数列表（Array）|
| `isConstructor` | 是否 `new` 调用 |
| `isMethod` | 是否方法调用 |
| `functionIid` | 函数定义处的 iid |
| `functionSid` | 函数定义处的 sid |

**返回值**：`{ f, base, args, skip }` 或 `undefined`。
- 修改 `f` / `base` / `args` 可替换调用目标或参数
- `skip: true` 跳过函数调用（仍会触发 `invokeFun`，result 为 undefined）

#### `invokeFun(iid, f, base, args, result, isConstructor, isMethod, functionIid, functionSid)`

函数/方法/构造器调用之**后**触发。

**返回值**：`{ result }` 或 `undefined`。修改 `result` 可替换调用返回值。

---

### 属性访问

#### `getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall)`

属性读取之**前**触发（`obj.prop` 或 `obj[key]`）。

**返回值**：`{ base, offset, skip }` 或 `undefined`。

#### `getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall)`

属性读取之**后**触发，`val` 是实际读到的值。

**返回值**：`{ result }` 或 `undefined`。

#### `putFieldPre(iid, base, offset, val, isComputed, isOpAssign)`

属性写入之**前**触发。

**返回值**：`{ base, offset, val, skip }` 或 `undefined`。

#### `putField(iid, base, offset, val, isComputed, isOpAssign)`

属性写入之**后**触发。

**返回值**：`{ result }` 或 `undefined`。

---

### 变量读写

#### `read(iid, name, val, isGlobal, isScriptLocal)`

变量读取之后触发。

| 参数 | 说明 |
|------|------|
| `name` | 变量名 |
| `val` | 读到的值 |
| `isGlobal` | 是否未声明的全局变量 |
| `isScriptLocal` | 是否用 `var` 声明的脚本级变量 |

**返回值**：`{ result }` 或 `undefined`。

#### `write(iid, name, val, lhs, isGlobal, isScriptLocal)`

变量写入之前触发。`lhs` 是写入前的旧值。

**返回值**：`{ result }` 或 `undefined`。

---

### 字面量与声明

#### `literal(iid, val, hasGetterSetter)`

字面量（数字/字符串/布尔/null/对象/数组/函数/正则）创建后触发。

**返回值**：`{ result }` 或 `undefined`。

#### `declare(iid, name, val, isArgument, argumentIndex, isCatchParam)`

作用域开始时，对每个局部变量/形参/函数声明触发。

**返回值**：`{ result }` 或 `undefined`。

---

### 运算

#### `binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed)`

二元运算之前触发。支持 `+`, `-`, `*`, `/`, `%`, `&`, `|`, `^`, `<<`, `>>`, `>>>`,
`<`, `>`, `<=`, `>=`, `==`, `!=`, `===`, `!==`, `instanceof`, `delete`, `in` 等。

**返回值**：`{ op, left, right, skip }` 或 `undefined`。

#### `binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed)`

二元运算之后触发。

**返回值**：`{ result }` 或 `undefined`。

#### `unaryPre(iid, op, left)` / `unary(iid, op, left, result)`

一元运算前/后触发（`!`, `-`, `+`, `~`, `typeof`, `void` 等）。

---

### 条件与控制流

#### `conditional(iid, result)`

条件判断时触发（`if`, `while`, `?:`, `&&`, `||`, `switch` 等）。

**返回值**：`{ result }` 或 `undefined`。修改 result 可控制分支走向。

#### `_return(iid, val)` / `_throw(iid, val)` / `_with(iid, val)`

`return` / `throw` / `with` 语句触发。

---

### 函数/脚本生命周期

#### `functionEnter(iid, f, dis, args)`

函数体开始执行前触发。返回值被忽略。

#### `functionExit(iid, returnVal, wrappedExceptionVal)`

函数体执行完毕后触发（正常返回或抛出异常均触发）。

**返回值**：`{ returnVal, wrappedExceptionVal, isBacktrack }` 或 `undefined`。
`isBacktrack: true` 可让控制流跳回函数体开头（用于符号执行回溯）。

#### `scriptEnter(iid, instrumentedFileName, originalFileName)` / `scriptExit(iid, wrappedExceptionVal)`

脚本级别的进入/退出钩子。

---

### 其他

#### `forinObject(iid, val)`

`for-in` 循环迭代对象时触发。

#### `endExpression(iid)`

表达式语句末尾触发（用于标记表达式结束）。

#### `endExecution()`

程序执行完毕后触发（Node.js 环境下），用于输出分析结果。

#### `onReady(cb)`

Node.js 模式下，异步初始化完成后调用 `cb` 开始执行目标程序。
在此钩子中可进行异步初始化（如加载数据库）。

---

## 修改程序行为

大多数钩子可以通过返回值修改程序的执行行为：

```js
// 示例：将所有数字加法结果偏移 1
binary(iid, op, left, right, result) {
    if (op === '+' && typeof result === 'number') {
        return { result: result + 1 };
    }
    // 不返回（或返回 undefined）= 不修改
}

// 示例：阻止某个方法调用
invokeFunPre(iid, f, base, args) {
    if (f.name === 'dangerousMethod') {
        console.warn('Blocked dangerous call at', this._sandbox.iidToLocation(iid));
        return { f, base, args, skip: true };
    }
}

// 示例：替换属性读取结果
getField(iid, base, offset, val) {
    if (base === config && offset === 'secret') {
        return { result: '***' };  // 屏蔽敏感字段
    }
}
```

## 访问源码位置

每个钩子都传入 `iid`（Instruction ID），可通过沙盒查询对应的源码位置：

```js
class MyAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
    }

    read(iid, name, val, isGlobal) {
        const loc = this._sandbox.iidToLocation(iid);
        // → "example.js:(3:5)-(3:10)"
        console.log(`Read ${name} at ${loc}`);
        return { result: val };
    }
}
```

## 使用 Shadow Memory

如果需要追踪对象的元数据（如对象 ID、分配点等），可以使用 `SMemory`：

```js
import { SMemory, SMemoryPlugin } from './src/runtime/SMemory.js';

const smemory = new SMemory(J$);
J$.analysis.use(new SMemoryPlugin(smemory));
J$.analysis.use(new MyAnalysis(smemory, J$));

// 在分析插件中
class MyAnalysis {
    constructor(smemory, sandbox) {
        this._mem = smemory;
        this._sandbox = sandbox;
    }

    getField(iid, base, offset, val) {
        const shadow = this._mem.getShadowObjectOfObject(base);
        const id = this._mem.getIDFromShadowObjectOrFrame(shadow);
        console.log(`Read ${offset} from object #${id}`);
        return { result: val };
    }
}
```

## 链式注册多个分析

```js
import { AnalysisHost }            from './src/runtime/AnalysisHost.js';
import { SMemory, SMemoryPlugin }  from './src/runtime/SMemory.js';
import { TraceAllAnalysis }        from './src/plugins/pldi16/TraceAll.js';
import { MyCustomAnalysis }        from './my-analysis.js';

const smemory = new SMemory(J$);
J$.smemory = smemory;

J$.analysis = new AnalysisHost()
    .use(new SMemoryPlugin(smemory))    // 先注册 SMemory，确保后续插件可用
    .use(new TraceAllAnalysis(J$))
    .use(new MyCustomAnalysis(J$));
```

## 完整示例：NaN 检测分析

以下是一个完整的 NaN 检测分析，检测 NaN 传播问题：

```js
// check-nan.js
// JALANGI DO NOT INSTRUMENT

export class CheckNaNAnalysis {
    constructor(sandbox) {
        this._sandbox = sandbox;
        this._nanLocations = [];
    }

    binary(iid, op, left, right, result) {
        if (typeof result === 'number' && isNaN(result)
                && !isNaN(left) && !isNaN(right)) {
            const loc = this._sandbox.iidToLocation(iid);
            this._nanLocations.push({
                op, left, right, loc,
                message: `NaN produced by ${left} ${op} ${right} at ${loc}`,
            });
        }
        return { result };
    }

    read(iid, name, val, isGlobal) {
        if (typeof val === 'number' && isNaN(val) && isGlobal) {
            const loc = this._sandbox.iidToLocation(iid);
            this._nanLocations.push({
                name, loc,
                message: `NaN read from global ${name} at ${loc}`,
            });
        }
        return { result: val };
    }

    endExecution() {
        if (this._nanLocations.length > 0) {
            console.warn(`[CheckNaN] Found ${this._nanLocations.length} NaN issues:`);
            for (const item of this._nanLocations) {
                console.warn('  -', item.message);
            }
        } else {
            console.log('[CheckNaN] No NaN issues found.');
        }
    }
}
```

## 内置示例分析

| 插件 | 路径 | 说明 |
|------|------|------|
| `LogAllAnalysis` | `src/plugins/tutorial/LogAll.js` | 记录所有运行时事件 |
| `TraceAllAnalysis` | `src/plugins/pldi16/TraceAll.js` | 完整执行跟踪（含 SMemory）|
| `BranchCoverageAnalysis` | `src/plugins/tutorial/BranchCoverage.js` | 分支覆盖率统计 |
| `BacktrackLoopAnalysis` | `src/plugins/tutorial/BacktrackLoop.js` | 回溯循环示例 |
| `CheckNaN` | `src/plugins/dlint/CheckNaN.js` | NaN 检测 |
| `UndefinedOffset` | `src/plugins/dlint/UndefinedOffset.js` | undefined 属性访问检测 |

详见 [Sample-Analyses.md](./Sample-Analyses.md)。

## 注意事项

1. **文件头部需加 `// JALANGI DO NOT INSTRUMENT`**，防止分析插件自身被插桩
2. 钩子方法**不需要全部实现**，只实现需要的即可
3. 若不修改值，可以直接不返回（返回 `undefined`），或返回原值
4. `functionEnter` 和 `scriptEnter` 的**返回值被忽略**
5. 若需要异步初始化，在 `onReady(cb)` 中完成后调用 `cb()`
6. 使用 Shadow Memory 时，**必须先注册 `SMemoryPlugin`**，再注册依赖它的分析
