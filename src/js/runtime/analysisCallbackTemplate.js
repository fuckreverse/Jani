// JALANGI DO NOT INSTRUMENT

/**
 * @file Jalangi2 分析插件模板。
 *
 * 复制本文件并删除不需要的回调，即可编写自定义分析。
 *
 * 所有回调均可以"什么都不返回"，此时执行行为不受影响（被动观测模式）。
 * 若需要修改执行行为，可从回调中返回含特定字段的对象：
 *  - putFieldPre / invokeFunPre：返回 { skip: true } 可跳过对应操作
 *  - write / read / getField 等：返回 { result: newVal } 可替换结果值
 *  - functionExit / scriptExit：返回 { isBacktrack: true } 可重新执行函数/脚本体
 *
 * 新式写法（推荐）：
 *   export class MyAnalysis { ... }
 *   // 通过 host.use(new MyAnalysis()) 注册
 *
 * 向后兼容写法（旧式 --analysis 命令行）：
 *   sandbox.analysis = new MyAnalysis();
 */

/**
 * Jalangi2 分析插件基础模板。
 *
 * 本类展示了所有可用的钩子方法及其参数说明。
 * 实际分析只需继承或直接实例化，并只保留需要的方法。
 *
 * @example
 * import { AnalysisTemplate } from './analysisCallbackTemplate.js';
 * class MyAnalysis extends AnalysisTemplate {
 *     read(iid, name, val, isGlobal, isScriptLocal) {
 *         console.log(`Read ${name} = ${val}`);
 *     }
 * }
 */
export class AnalysisTemplate {

    // ── 函数调用 ────────────────────────────────────────────────────────────

    /**
     * 函数/方法/构造器调用之前触发。
     *
     * @param {number}   iid           - 指令 ID
     * @param {Function} f             - 被调函数对象
     * @param {object}   base          - 接收者（this）
     * @param {Array}    args          - 参数列表
     * @param {boolean}  isConstructor - 是否 new 调用
     * @param {boolean}  isMethod      - 是否方法调用
     * @param {number}   functionIid   - 函数定义处的 iid
     * @param {number}   functionSid   - 函数定义处的 sid
     * @returns {{ f, base, args, skip }|undefined}
     */
    invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid) {
        return { f, base, args, skip: false };
    }

    /**
     * 函数/方法/构造器调用之后触发。
     *
     * @param {number}   iid           - 指令 ID
     * @param {Function} f             - 被调函数对象
     * @param {object}   base          - 接收者（this）
     * @param {Array}    args          - 参数列表
     * @param {*}        result        - 调用返回值
     * @param {boolean}  isConstructor - 是否 new 调用
     * @param {boolean}  isMethod      - 是否方法调用
     * @param {number}   functionIid   - 函数定义处的 iid
     * @param {number}   functionSid   - 函数定义处的 sid
     * @returns {{ result }|undefined}
     */
    invokeFun(iid, f, base, args, result, isConstructor, isMethod, functionIid, functionSid) {
        return { result };
    }

    // ── 字面量 ──────────────────────────────────────────────────────────────

    /**
     * 字面量（函数/对象/数组/数字/字符串/布尔/正则/null/NaN/Infinity/undefined）创建后触发。
     *
     * @param {number}  iid            - 指令 ID
     * @param {*}       val            - 字面量值
     * @param {boolean} hasGetterSetter - 是否含 getter/setter 的对象字面量
     * @returns {{ result }|undefined}
     */
    literal(iid, val, hasGetterSetter) {
        return { result: val };
    }

    // ── for-in ──────────────────────────────────────────────────────────────

    /**
     * for-in 循环迭代对象时触发。
     *
     * @param {number} iid - 指令 ID
     * @param {*}      val - 被迭代的对象
     * @returns {{ result }|undefined}
     */
    forinObject(iid, val) {
        return { result: val };
    }

    // ── 变量声明 ────────────────────────────────────────────────────────────

    /**
     * 作用域开始时，对每个局部变量/形参/函数声明/arguments/catch 参数触发。
     *
     * @param {number}  iid           - 指令 ID
     * @param {string}  name          - 变量名
     * @param {*}       val           - 初始值
     * @param {boolean} isArgument    - 是否为 arguments 或形参
     * @param {number}  argumentIndex - 形参索引（-1 表示非形参）
     * @param {boolean} isCatchParam  - 是否为 catch 参数
     * @returns {{ result }|undefined}
     */
    declare(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        return { result: val };
    }

    // ── 属性访问 ────────────────────────────────────────────────────────────

    /**
     * 属性读取之前触发（getField Pre）。
     *
     * @param {number}        iid          - 指令 ID
     * @param {*}             base         - 基对象
     * @param {string|*}      offset       - 属性名
     * @param {boolean}       isComputed   - 是否计算属性（o[p]）
     * @param {boolean}       isOpAssign   - 是否复合赋值（o.p += e）
     * @param {boolean}       isMethodCall - 是否方法调用（o.p()）
     * @returns {{ base, offset, skip }|undefined}
     */
    getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall) {
        return { base, offset, skip: false };
    }

    /**
     * 属性读取之后触发（getField Post）。
     *
     * @param {number}   iid          - 指令 ID
     * @param {*}        base         - 基对象
     * @param {string|*} offset       - 属性名
     * @param {*}        val          - 读取的值 base[offset]
     * @param {boolean}  isComputed   - 是否计算属性
     * @param {boolean}  isOpAssign   - 是否复合赋值
     * @param {boolean}  isMethodCall - 是否方法调用
     * @returns {{ result }|undefined}
     */
    getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall) {
        return { result: val };
    }

    /**
     * 属性写入之前触发（putField Pre）。
     *
     * @param {number}   iid        - 指令 ID
     * @param {*}        base       - 基对象
     * @param {*}        offset     - 属性名
     * @param {*}        val        - 要写入的值
     * @param {boolean}  isComputed - 是否计算属性
     * @param {boolean}  isOpAssign - 是否复合赋值
     * @returns {{ base, offset, val, skip }|undefined}
     */
    putFieldPre(iid, base, offset, val, isComputed, isOpAssign) {
        return { base, offset, val, skip: false };
    }

    /**
     * 属性写入之后触发（putField Post）。
     *
     * @param {number}   iid        - 指令 ID
     * @param {*}        base       - 基对象
     * @param {*}        offset     - 属性名
     * @param {*}        val        - 写入的值
     * @param {boolean}  isComputed - 是否计算属性
     * @param {boolean}  isOpAssign - 是否复合赋值
     * @returns {{ result }|undefined}
     */
    putField(iid, base, offset, val, isComputed, isOpAssign) {
        return { result: val };
    }

    // ── 变量读写 ────────────────────────────────────────────────────────────

    /**
     * 变量读取之后触发。
     *
     * @param {number}  iid           - 指令 ID
     * @param {string}  name          - 变量名
     * @param {*}       val           - 读取的值
     * @param {boolean} isGlobal      - 是否未用 var 声明的全局变量
     * @param {boolean} isScriptLocal - 是否用 var 声明的全局作用域变量
     * @returns {{ result }|undefined}
     */
    read(iid, name, val, isGlobal, isScriptLocal) {
        return { result: val };
    }

    /**
     * 变量写入之前触发。
     *
     * @param {number}  iid           - 指令 ID
     * @param {string}  name          - 变量名
     * @param {*}       val           - 要写入的值
     * @param {*}       lhs           - 写入前的旧值
     * @param {boolean} isGlobal      - 是否未用 var 声明的全局变量
     * @param {boolean} isScriptLocal - 是否用 var 声明的全局作用域变量
     * @returns {{ result }|undefined}
     */
    write(iid, name, val, lhs, isGlobal, isScriptLocal) {
        return { result: val };
    }

    // ── 控制流 ──────────────────────────────────────────────────────────────

    /**
     * return 语句执行前触发。
     * @param {number} iid - 指令 ID
     * @param {*}      val - 返回值
     * @returns {{ result }|undefined}
     */
    _return(iid, val) {
        return { result: val };
    }

    /**
     * throw 语句执行前触发。
     * @param {number} iid - 指令 ID
     * @param {*}      val - 抛出的值
     * @returns {{ result }|undefined}
     */
    _throw(iid, val) {
        return { result: val };
    }

    /**
     * with 语句执行时触发。
     * @param {number} iid - 指令 ID
     * @param {*}      val - with 的参数值
     * @returns {{ result }|undefined}
     */
    _with(iid, val) {
        return { result: val };
    }

    // ── 函数进出 ────────────────────────────────────────────────────────────

    /**
     * 函数体开始执行前触发。
     * @param {number}   iid  - 指令 ID
     * @param {Function} f    - 正在执行的函数
     * @param {*}        dis  - this 值
     * @param {Array}    args - 参数列表
     */
    functionEnter(iid, f, dis, args) {
        // 返回值被忽略
    }

    /**
     * 函数体执行完毕后触发。
     *
     * @param {number} iid                - 指令 ID
     * @param {*}      returnVal          - 函数返回值
     * @param {object|undefined} wrappedExceptionVal - 未捕获异常（含 exception 字段）
     * @returns {{ returnVal, wrappedExceptionVal, isBacktrack }|undefined}
     *   isBacktrack=true 可让控制流跳回函数体开头（MultiSE 符号执行用）
     */
    functionExit(iid, returnVal, wrappedExceptionVal) {
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    // ── 脚本进出 ────────────────────────────────────────────────────────────

    /**
     * 脚本开始执行前触发。
     * @param {number} iid                  - 指令 ID
     * @param {string} instrumentedFileName - 插桩后脚本路径
     * @param {string} originalFileName     - 原始脚本路径
     */
    scriptEnter(iid, instrumentedFileName, originalFileName) {
        // 返回值被忽略
    }

    /**
     * 脚本执行完毕后触发。
     *
     * @param {number} iid                - 指令 ID
     * @param {object|undefined} wrappedExceptionVal - 未捕获异常
     * @returns {{ wrappedExceptionVal, isBacktrack }|undefined}
     */
    scriptExit(iid, wrappedExceptionVal) {
        return { wrappedExceptionVal, isBacktrack: false };
    }

    // ── 运算 ────────────────────────────────────────────────────────────────

    /**
     * 二元运算之前触发（+, -, *, /, %, &, |, ^, <<, >>, >>>, <, >, <=, >=,
     *   ==, !=, ===, !==, instanceof, delete, in）。
     *
     * @param {number}  iid                    - 指令 ID
     * @param {string}  op                     - 运算符
     * @param {*}       left                   - 左操作数
     * @param {*}       right                  - 右操作数
     * @param {boolean} isOpAssign             - 是否复合赋值（x op= e）
     * @param {boolean} isSwitchCaseComparison - 是否 switch-case 比较
     * @param {boolean} isComputed             - 是否 delete x[p]
     * @returns {{ op, left, right, skip }|undefined}
     */
    binaryPre(iid, op, left, right, isOpAssign, isSwitchCaseComparison, isComputed) {
        return { op, left, right, skip: false };
    }

    /**
     * 二元运算之后触发。
     *
     * @param {number}  iid                    - 指令 ID
     * @param {string}  op                     - 运算符
     * @param {*}       left                   - 左操作数
     * @param {*}       right                  - 右操作数
     * @param {*}       result                 - 运算结果
     * @param {boolean} isOpAssign             - 是否复合赋值
     * @param {boolean} isSwitchCaseComparison - 是否 switch-case 比较
     * @param {boolean} isComputed             - 是否 delete x[p]
     * @returns {{ result }|undefined}
     */
    binary(iid, op, left, right, result, isOpAssign, isSwitchCaseComparison, isComputed) {
        return { result };
    }

    /**
     * 一元运算之前触发（+, -, ~, !, typeof, void）。
     *
     * @param {number} iid  - 指令 ID
     * @param {string} op   - 运算符
     * @param {*}      left - 操作数
     * @returns {{ op, left, skip }|undefined}
     */
    unaryPre(iid, op, left) {
        return { op, left, skip: false };
    }

    /**
     * 一元运算之后触发。
     *
     * @param {number} iid    - 指令 ID
     * @param {string} op     - 运算符
     * @param {*}      left   - 操作数
     * @param {*}      result - 运算结果
     * @returns {{ result }|undefined}
     */
    unary(iid, op, left, result) {
        return { result };
    }

    /**
     * 条件判断之后触发（if-else、switch-case、while、for、||、&&、?:）。
     *
     * @param {number} iid    - 指令 ID
     * @param {*}      result - 条件表达式的值
     * @returns {{ result }|undefined}
     */
    conditional(iid, result) {
        return { result };
    }

    // ── eval 插桩 ────────────────────────────────────────────────────────────

    /**
     * eval/Function 字符串被插桩之前触发。
     *
     * @param {number}  iid      - 指令 ID
     * @param {*}       code     - 要插桩的代码字符串
     * @param {boolean} isDirect - 是否直接调用 eval
     * @returns {{ code, skip }|undefined}
     */
    instrumentCodePre(iid, code, isDirect) {
        return { code, skip: false };
    }

    /**
     * eval/Function 字符串被插桩之后触发。
     *
     * @param {number} iid      - 指令 ID
     * @param {*}      newCode  - 插桩后的代码
     * @param {object} newAst   - 插桩后的 AST
     * @param {boolean} isDirect - 是否直接调用 eval
     * @returns {{ result }|undefined}
     */
    instrumentCode(iid, newCode, newAst, isDirect) {
        return { result: newCode };
    }

    // ── 其他 ─────────────────────────────────────────────────────────────────

    /**
     * 表达式语句执行完毕、值被丢弃时触发。
     * @param {number} iid - 指令 ID
     */
    endExpression(iid) {
        // 返回值被忽略
    }

    /**
     * 执行结束时触发（Node.js：进程退出；浏览器：Alt-Shift-T）。
     */
    endExecution() {
        // 返回值被忽略
    }

    /**
     * 仅在 Config.ENABLE_SAMPLING = true 时生效。
     * 在函数体执行前调用：返回 true 则执行插桩版本，false 则执行原始版本。
     *
     * @param {number}   iid         - 指令 ID
     * @param {Function} f           - 函数对象
     * @param {number}   functionIid - 函数定义处的 iid
     * @param {number}   functionSid - 函数定义处的 sid
     * @returns {boolean}
     */
    runInstrumentedFunctionBody(iid, f, functionIid, functionSid) {
        return false;
    }

    /**
     * Node.js 模式下，异步初始化完成后调用 cb 启动目标程序。
     * 浏览器下此回调不生效。
     *
     * @param {Function} cb - 启动程序的回调
     */
    onReady(cb) {
        cb();
    }
}
