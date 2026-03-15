# 预处理模块（src/preprocess/）

预处理模块在插桩前对 JavaScript 源代码进行 AST 级变换，目标是在**不改变逻辑语义**的前提下：

1. **反混淆**：将压缩/混淆代码恢复为可读结构，提升插桩后 Trace 的行列信息质量
2. **语法降级**：将 ESNext / ES2022+ 语法降级为目标环境支持的版本，扩大插桩器的适用范围
3. **插桩覆盖率提升**：将箭头函数等插桩器有已知盲区的语法形式转换为等价的标准形式

## 为什么需要预处理

Jani 的插桩器按 IID 记录每个操作对应的 **行列号**。对于压缩代码来说：

- `a=1,b=2,c=3;` 是一行里的逗号表达式，插桩后三个操作的 IID 全在同一行，Trace 无法定位
- `void 0` 大量出现在混淆代码中，增加视觉噪音
- 三元表达式 `a?b:c` 嵌套导致插桩块很难阅读

预处理后：

```js
// 原始（混淆）
a = 1, b = 2, c = a + b;
var x = void 0;
var y = 1 + 2 + 3;

// 预处理后
a = 1;
b = 2;
c = a + b;
var x = undefined;
var y = 6;
```

插桩后的 Trace 就可以按行精确定位每条操作。

## 模块结构

```
src/preprocess/
  PreprocessPlugin.js      ← 插件基类（所有插件继承此类）
  index.js                 ← 主入口：preprocessCode(code, options) → { code, stats, warnings }
  plugins/
    DeobfuscatePlugin.js   ← 反混淆插件（7 个可独立开关的 Pass）
    TranspilePlugin.js     ← 语法降级插件（@babel/preset-env 包装）
    NormalizeArrowPlugin.js ← 箭头函数标准化插件（补全 functionEnter/Exit 覆盖）
```

## 快速上手

### 编程方式

```js
import { preprocessCode, DeobfuscatePlugin, TranspilePlugin, NormalizeArrowPlugin }
    from './src/preprocess/index.js';

// 方式一：默认反混淆（快捷）
const { code, stats } = await preprocessCode(rawCode);

// 方式二：使用预设
const { code } = await preprocessCode(rawCode, { preset: 'full' });

// 方式三：补全箭头函数插桩覆盖率
const { code } = await preprocessCode(rawCode, { preset: 'normalize-arrow' });

// 方式四：手动组合插件
const { code } = await preprocessCode(rawCode, {
    plugins: [
        new NormalizeArrowPlugin(),
        new DeobfuscatePlugin({ splitSequence: true, foldConstants: true }),
        new TranspilePlugin({ targets: { ie: '11' } }),
    ],
    sourceType: 'module',
});
```

### 命令行

```bash
# 默认反混淆（写出 <input>_preprocessed.js）
node bin/preprocess.mjs data/cl.js

# 反混淆 + 语法降级
node bin/preprocess.mjs --preset full --targets defaults data/cl.js

# 仅语法降级（IE 11）
node bin/preprocess.mjs --preset transpile --targets '{"ie":"11"}' data/app.js

# 额外开启 IIFE 展开 + 条件表达式展开
node bin/preprocess.mjs --flatten-iife --expand-conditional data/cl.js

# 输出到 stdout 预览，不写文件
node bin/preprocess.mjs --stdout data/cl.js | head -50

# 查看帮助
node bin/preprocess.mjs --help
```

## `preprocessCode()` API

```ts
preprocessCode(code: string, options?: {
    // 预设（与 plugins 互斥，plugins 优先）
    preset?: 'deobfuscate' | 'transpile' | 'normalize-arrow' | 'full';

    // 手动插件列表
    plugins?: PreprocessPlugin[];

    // 各插件选项（配合 preset 使用）
    deobfuscate?: DeobfuscateOptions;
    transpile?: TranspileOptions;
    normalizeArrow?: NormalizeArrowOptions;

    sourceType?: 'script' | 'module';  // 默认 'script'
    comments?: boolean;                // 是否保留注释，默认 true
    compact?: boolean;                 // 紧凑输出，默认 false
}): Promise<{
    code:     string;    // 处理后的代码
    stats:    object;    // 每个插件的统计 { [pluginName]: { [key]: number } }
    warnings: string[];  // 解析警告或插件错误
}>
```

## `DeobfuscatePlugin` — 反混淆

### 变换 Pass 一览

| Pass | 默认 | 说明 | 示例 |
|------|------|------|------|
| `splitSequence` | ✅ | 逗号表达式拆分 | `a=1,b=2` → `a=1; b=2` |
| `replaceVoid` | ✅ | void 常量替换 | `void 0` → `undefined` |
| `foldConstants` | ✅ | 编译期常量折叠 | `1+2+3` → `6`，`"foo"+"bar"` → `"foobar"` |
| `simplifyBoolean` | ✅ | 布尔简化 | `!!x` → `Boolean(x)`，`!true` → `false` |
| `inlineDeadCode` | ✅ | 死代码删除 | `if(false){dead()}` → 删除 |
| `expandConditional` | ❌ | 三元展开 if-else | `cond?fn1():fn2()` → `if(cond){fn1()}else{fn2()}` |
| `flattenIIFE` | ❌ | 无参 IIFE 展开 | `(function(){a;b;})()` → `a; b;` |

> `expandConditional` 和 `flattenIIFE` 默认关闭，因为会改变控制流结构或作用域，需要谨慎使用。

### 详细说明

#### `splitSequence`（逗号表达式拆分）

处理以下场景：
- **语句级**：`a=1, b=2;` → `a=1; b=2;`
- **for 初始化**：`for(a=1,i=0;...)` → `a=1; for(i=0;...)`
- **if 条件**：`if(x=getX(), x>0)` → `x=getX(); if(x>0)`
- **return 语句**：`return (a=1, b=2, a+b)` → `a=1; b=2; return a+b;`

不处理：函数参数、数组/对象字面量内的逗号（这些是正常语法）。

#### `foldConstants`（常量折叠）

使用后序遍历（`exit` 访问器），确保先折叠叶节点：

| 类型 | 示例 |
|------|------|
| 数值运算 | `1+2+3` → `6`，`10*3-5` → `25` |
| 字符串拼接 | `"foo"+"bar"` → `"foobar"` |
| 比较 | `5>3` → `true`，`1===2` → `false` |
| typeof | `typeof 42` → `"number"`，`typeof undefined` → `"undefined"` |
| 逻辑短路 | `false && expr` → `false`，`true \|\| expr` → `true` |
| 三元折叠 | `true ? "yes" : "no"` → `"yes"` |
| 位运算 | `0xff & 0x0f` → `15` |

注意：`1/0`（除以零结果为 Infinity）不折叠，含变量的表达式不折叠。

#### `flattenIIFE`（无参 IIFE 展开）

条件：
- ✅ 无参数的 `function` 或箭头函数 IIFE
- ❌ 含 `this` 引用的普通函数 IIFE（避免改变 `this` 绑定）
- ❌ 含参数的 IIFE

### 选项

```js
new DeobfuscatePlugin({
    splitSequence:    true,   // 逗号表达式拆分（默认开启）
    replaceVoid:      true,   // void 0 → undefined（默认开启）
    foldConstants:    true,   // 常量折叠（默认开启）
    simplifyBoolean:  true,   // 布尔简化（默认开启）
    inlineDeadCode:   true,   // 死代码删除（默认开启）
    expandConditional:false,  // 三元展开 if-else（默认关闭）
    flattenIIFE:      false,  // IIFE 展开（默认关闭）
})
```

## `NormalizeArrowPlugin` — 箭头函数标准化

将**满足安全条件的**箭头函数转换为等价的普通 `function` 表达式，使插桩器能为其注入 `J$.Fe` / `J$.Fx`（`functionEnter` / `functionExit`）钩子。

### 动机

Jani 插桩器对 `ArrowFunctionExpression` 有已知限制：不注入 `J$.Fe`/`J$.Fx`，不添加 try-catch 包裹。这导致箭头函数内的异常无法被 `J$.Ex` 捕获，分析插件也收不到 `functionEnter`/`functionExit` 回调，在跨函数数据流追踪时出现盲区。

预处理将满足条件的箭头函数转为普通函数，可完全消除这一盲区。

### 安全条件

插件会**严格跳过**以下任意一种情况（有任意一项即保留为箭头函数）：

| 条件 | 原因 |
|------|------|
| 函数体内引用 `this` | 箭头函数的 `this` 词法绑定，转换后指向会变 |
| 函数体内引用 `arguments` | 箭头函数透传外层 `arguments`，转换后变为自身的 |
| 函数体内引用 `super` | 箭头函数的 `super` 词法绑定，普通函数无词法 `super` |
| 函数体内引用 `new.target` | 箭头函数的 `new.target` 透传外层，普通函数独立 |
| 位于类体内（ClassMethod / ClassProperty 等） | 类体上下文复杂，保守拒绝 |
| `async` 箭头函数（默认） | 默认不处理，可通过 `includeAsync: true` 开启 |

检查只在**当前箭头函数的直接作用域**内进行，不穿透嵌套函数边界（嵌套的 `FunctionExpression` / `ArrowFunctionExpression` / `ObjectMethod` / `ClassMethod` 内部的引用不会影响外层箭头的判断）。

### 转换规则

| 箭头形式 | 转换为 |
|---------|--------|
| `x => expr`（表达式体）| `function(x) { return expr; }` |
| `(x, y) => { stmts }` | `function(x, y) { stmts }` |
| 带默认参数 / 解构 / rest 参数 | 参数原样保留，仅改变函数类型 |

### 选项

```js
new NormalizeArrowPlugin({
    includeAsync: false,  // 是否转换 async 箭头函数（默认关闭）
})
```

### 示例

```js
// 输入
var double = x => x * 2;
arr.map(item => item.name);
const sum = (a, b) => { return a + b; };

// 输出（全部满足安全条件，均转换）
var double = function(x) { return x * 2; };
arr.map(function(item) { return item.name; });
const sum = function(a, b) { return a + b; };
```

```js
// 含 this 的箭头函数保留（不转换）
var obj = {
    method: function() {
        var fn = () => this.value;  // ← 保留，含 this
        return fn();
    }
};
```

## `TranspilePlugin` — 语法降级

基于 `@babel/preset-env` 将现代 JS 语法降级到指定目标版本。

### 常见降级变换

| 语法 | 降级为 |
|------|--------|
| 箭头函数 | `function` |
| `class` | prototype 链 + 辅助函数 |
| 模板字符串 | 字符串拼接 |
| 解构赋值 | 临时变量 |
| 展开运算符 | `apply` / `concat` |
| `for-of` | 普通 `for` |
| 可选链 `?.` | 三元判断 |
| 空值合并 `??` | 短路或 |
| 逻辑赋值 `&&=` / `||=` / `??=` | 展开形式 |

### 选项

```js
new TranspilePlugin({
    targets:     'defaults',     // Browserslist 字符串或对象，默认 "defaults"
    loose:       false,          // 宽松模式（更简单但略有差异的降级代码）
    modules:     false,          // false=保留 ESM；'commonjs'=转为 CJS
    useBuiltIns: false,          // Polyfill 注入：false / 'usage' / 'entry'
    corejs:      undefined,      // core-js 版本（配合 useBuiltIns）
    exclude:     [],             // 排除特定变换
    include:     [],             // 强制包含特定变换
    debug:       false,          // 打印 preset-env 选择的变换列表
})
```

**`targets` 示例**：

```js
'defaults'                              // 市场占有率 > 0.5% 的浏览器
'last 2 Chrome versions'                // 最近 2 个 Chrome 版本
'last 2 versions, not IE 11'           // 近两版本，排除 IE 11
{ node: 'current' }                     // 当前 Node.js 版本
{ ie: '11' }                           // IE 11（最大兼容）
{ browsers: 'last 2 Chrome versions' } // 对象形式
```

## 编写自定义预处理插件

继承 `PreprocessPlugin`，实现 `apply(ast, babelApi)` 方法：

```js
import { PreprocessPlugin } from './src/preprocess/PreprocessPlugin.js';

export class MyPlugin extends PreprocessPlugin {
    constructor(options = {}) {
        super('MyPlugin', options);
    }

    apply(ast, babelApi) {
        const { traverse, types: t } = babelApi;
        let count = 0;

        traverse(ast, {
            // 示例：将所有 console.log 改为 console.debug
            CallExpression(path) {
                const callee = path.node.callee;
                if (
                    t.isMemberExpression(callee) &&
                    t.isIdentifier(callee.object, { name: 'console' }) &&
                    t.isIdentifier(callee.property, { name: 'log' })
                ) {
                    callee.property = t.identifier('debug');
                    count++;
                }
            },
        });

        return { consoleLogReplaced: count };
    }
}

// 使用
const { code } = await preprocessCode(src, {
    plugins: [new MyPlugin()],
});
```

`apply()` 的参数：
- `ast`：Babel `File` 对象（`babelParser.parse()` 返回值），**原地修改**
- `babelApi.traverse`：`@babel/traverse` 遍历函数
- `babelApi.types`：`@babel/types` 工具库（`t.isXxx`、`t.xxxLiteral()` 等）
- `babelApi.generator`：`@babel/generator` 代码生成函数（仅 `TranspilePlugin` 需要）

返回值：`{ [statKey]: number }` 统计对象，会收集到 `preprocessCode()` 的 `stats` 中。

## 与插桩器集成

### 补全 functionEnter/Exit 覆盖率

```js
import { preprocessCode, NormalizeArrowPlugin } from './src/preprocess/index.js';
import { init, instrumentCode }                  from './src/instrument/esnstrument.js';
import { fullConfig }                            from './src/instrument/pluginAnalyzer.js';

const rawCode = readFileSync('app.js', 'utf8');

// 第一步：将箭头函数转为普通函数
const { code: normalizedCode, stats } = await preprocessCode(rawCode, {
    plugins: [new NormalizeArrowPlugin()],
    sourceType: 'module',
});
console.log(`箭头函数转换: ${stats.NormalizeArrowPlugin.arrowNormalized} 个`);

// 第二步：插桩（转换后的 function 会收到 J$.Fe/J$.Fx 回调）
init(fullConfig());
const { code: instrCode } = instrumentCode({
    code:             normalizedCode,
    origCodeFileName: 'app.js',
    instCodeFileName: 'app_inst.js',
    sourceType:       'module',
});
```

### 反混淆后插桩

```js
import { preprocessCode, DeobfuscatePlugin } from './src/preprocess/index.js';
import { init, instrumentCode }               from './src/instrument/esnstrument.js';
import { fullConfig }                         from './src/instrument/pluginAnalyzer.js';

const rawCode = readFileSync('cl.js', 'utf8');

// 第一步：预处理（反混淆）
const { code: cleanCode, stats } = await preprocessCode(rawCode, {
    plugins: [new DeobfuscatePlugin()],
    sourceType: 'module',
});
console.log(`逗号拆分: ${stats.DeobfuscatePlugin.sequenceSplit} 处`);

// 第二步：插桩
init(fullConfig());
const { code: instrCode, sourceMapObject } = instrumentCode({
    code:             cleanCode,
    origCodeFileName: 'cl.js',
    instCodeFileName: 'cl_inst.js',
    sourceType:       'module',
});
```

## CLI 完整选项

```
node bin/preprocess.mjs [选项] <输入文件>

预设：
  --preset deobfuscate      仅反混淆（默认）
  --preset transpile        仅语法降级
  --preset normalize-arrow  仅箭头函数标准化
  --preset full             箭头标准化 + 反混淆 + 语法降级

反混淆开关（默认均开启，--no-<name> 关闭）：
  --split-sequence       逗号表达式拆分
  --replace-void         void 0 → undefined
  --fold-constants       编译期常量折叠
  --simplify-boolean     !!x → Boolean(x)
  --inline-dead-code     死代码删除

反混淆扩展（默认关闭）：
  --expand-conditional   条件表达式 ? : 展开为 if-else
  --flatten-iife         无参 IIFE 展开

箭头函数标准化选项（默认关闭）：
  --include-async        同时转换 async 箭头函数

语法降级选项：
  --targets <t>          Browserslist 目标（默认 "defaults"）
  --loose                宽松模式
  --to-commonjs          ESM → CommonJS

输出选项：
  --output <file>        输出文件（默认 <input>_preprocessed.js）
  --stdout               输出到 stdout
  --source-type <t>      script（默认）/ module
  --no-comments          去除注释
  --dry-run              只预览，不写文件
  --stats                打印详细统计
```
