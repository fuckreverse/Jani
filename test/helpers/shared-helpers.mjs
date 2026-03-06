/**
 * test/helpers/shared-helpers.mjs
 *
 * 所有测试文件共享的工具函数与常量，避免重复定义。
 *
 * 导出：
 *   ALL_CONFIG      — 全量插桩 Config（所有钩子均开启）
 *   instr()         — 快捷插桩 helper（script 模式）
 *   runInSandbox()  — 在 Node.js vm 隔离沙盒中执行插桩后代码
 *   instrAndRun()   — 插桩 + 执行一步完成，返回 { out, vars, J$, sandbox }
 *   createSpy()     — 创建记录钩子调用的 Spy 插件
 */

import { init, instrumentCode } from '../../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../../src/runtime/JalangiSandbox.js';
import vm from 'vm';

// ─── 全量 Config（所有钩子均开启）─────────────────────────────────────────────

export const ALL_CONFIG = Object.freeze({
    INSTR_READ:               null,
    INSTR_WRITE:              null,
    INSTR_GETFIELD:           null,
    INSTR_PUTFIELD:           null,
    INSTR_BINARY:             null,
    INSTR_UNARY:              null,
    INSTR_LITERAL:            null,
    INSTR_INIT:               null,
    INSTR_END_EXPRESSION:     null,
    INSTR_CONDITIONAL:        null,
    INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_AWAIT:              null,   // await 恢复点插桩
    ENABLE_SAMPLING:          false,
});

// 初始化一次（各测试文件 import 后可直接使用；需要不同 Config 时自行调用 init()）
init({ ...ALL_CONFIG });

// ─── 快捷插桩 helper ───────────────────────────────────────────────────────────

/**
 * script 模式快捷插桩，封装常用默认参数。
 * @param {string} code   原始 JS 代码
 * @param {object} opts   可选参数覆盖（file, inlineSourceMap, inlineSource, sourceType, isEval）
 */
export function instr(code, opts = {}) {
    return instrumentCode({
        code,
        origCodeFileName: opts.file ?? 'test.js',
        instCodeFileName: opts.file ? opts.file.replace('.js', '_inst.js') : 'test_inst.js',
        inlineSourceMap:  opts.inlineSourceMap ?? false,
        inlineSource:     opts.inlineSource    ?? false,
        sourceType:       opts.sourceType      ?? 'script',
        isEval:           opts.isEval          ?? false,
    });
}

// ─── vm 沙盒执行 ───────────────────────────────────────────────────────────────

/**
 * 在 Node.js vm 沙盒中执行插桩后代码。
 *
 * 安全策略：
 *  - vm.createContext() 创建隔离上下文，与宿主进程内存空间隔离
 *  - 沙盒中只注入最小必要全局量（J$、console、Error、Math、Object、Array、…）
 *  - 不注入 process、require、__dirname 等 Node.js 全局，防止逃逸
 *  - vm.runInContext() 设置 timeout，防止死循环
 *
 * @param {string}  instrCode      插桩后代码字符串（来自 instrumentCode().code）
 * @param {object}  J$instance     JalangiSandbox 或轻量 stub 实例
 * @param {object}  [extraGlobals] 额外注入到沙盒的全局变量（测试用）
 * @param {number}  [timeoutMs=2000]  执行超时（毫秒）
 * @returns {object} 上下文对象（可从中读取沙盒内的变量）
 */
export function runInSandbox(instrCode, J$instance, extraGlobals = {}, timeoutMs = 2000) {
    const sandbox = vm.createContext({
        J$: J$instance,
        console,
        Error, TypeError, RangeError, ReferenceError, SyntaxError,
        Math, JSON, Date,
        Object, Array, Function, String, Number, Boolean, Symbol,
        RegExp, Map, Set, WeakMap, WeakSet,
        Promise, Proxy, Reflect,
        parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        undefined,
        NaN,
        Infinity,
        ...extraGlobals,
    });
    vm.runInContext(instrCode, sandbox, { timeout: timeoutMs });
    return sandbox;
}

/**
 * 一步完成"插桩 + 沙盒执行"，返回 { out, vars, J$, sandbox }。
 *
 * 注意：插桩后的 script 代码直接展开（不含 IIFE），var 声明会提升到 vm sandbox
 * 的全局作用域，但 vm sandbox 与 Node.js 全局是隔离的。通过以下方式导出结果：
 *   - sourceCode 末尾添加 "$out.变量名 = 变量名" 赋值语句
 *   - 或者通过注册 write 钩子来捕获变量写入值
 *
 * 沙盒中已预注入 `$out = {}` 对象，可在 sourceCode 中直接使用。
 *
 * @param {string} sourceCode    原始 JS 代码（末尾可追加 "$out.x=x;" 来导出结果）
 * @param {object} [extraGlobals]  额外注入到沙盒的全局变量
 * @returns {{ out: object, vars: object, J$: JalangiSandbox, sandbox: object }}
 *   out   — $out 容器（sourceCode 中显式写入的结果）
 *   vars  — write 钩子收集到的所有变量写入记录（key=变量名, value=最后写入值）
 *   J$    — 运行时 sandbox 实例
 */
export function instrAndRun(sourceCode, extraGlobals = {}) {
    init({ ...ALL_CONFIG });
    const { code } = instrumentCode({
        code:             sourceCode,
        origCodeFileName: 'dyn-test.js',
        instCodeFileName: 'dyn-test_inst.js',
        inlineSourceMap:  true,
    });
    const J$inst = new JalangiSandbox();
    const vars = {};
    J$inst.analysis.use({
        write(_iid, name, val) { vars[name] = val; }
    });
    const $out = {};
    const sandbox = runInSandbox(code, J$inst, { $out, ...extraGlobals });
    return { out: $out, vars, J$: J$inst, sandbox };
}

// ─── Spy 插件工厂 ───────────────────────────────────────────────────────────────

/**
 * 创建一个 Spy 插件：记录所有指定 hook 的调用信息。
 * @param {...string} hookNames  要监控的 hook 名
 * @returns {{ plugin: object, calls: Map<string, Array> }}
 */
export function createSpy(...hookNames) {
    const calls = new Map();
    const plugin = {};
    for (const name of hookNames) {
        calls.set(name, []);
        plugin[name] = function (...args) {
            calls.get(name).push(args);
        };
    }
    return { plugin, calls };
}
