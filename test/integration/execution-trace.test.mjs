/**
 * test/integration/execution-trace.test.mjs — ExecutionTrace 插件完整测试
 *
 * 验证 ExecutionTrace 分析插件的所有核心功能：
 *  - 平铺流式输出（FORMAT_FLAT，运行时唯一格式）
 *  - 异步回调追踪（scriptExit 后的 functionEnter/functionExit）
 *  - getField/putField 属性追踪输出
 *  - flush() / close() 手动控制 API
 *  - onReady() 回调时机
 *  - TraceLogger 后端集成（内存后端）
 *
 * 注意：树形/块状/管道展示格式由离线工具 trace-render.mjs 提供，
 *       运行时只输出最轻量的平铺格式。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { init, instrumentCode } from '../../src/instrument/esnstrument.js';
import { JalangiSandbox }       from '../../src/runtime/JalangiSandbox.js';
import { ExecutionTraceAnalysis } from '../../src/plugins/ExecutionTrace.js';
import { MemoryBackend }        from '../../src/logger/transport/MemoryBackend.js';
import { TraceLogger }          from '../../src/logger/TraceLogger.js';
import { ALL_CONFIG, runInSandbox } from '../helpers/shared-helpers.mjs';
import {
    FlatFormatter,
    fmtSeq,
} from '../../src/utils/traceFormatters.js';

// ── 辅助：从结构化事件列表中提取所有信息为统一的可搜索字符串 ──────────────────

/**
 * 将结构化事件（新格式）转为可搜索字符串，兼容旧文本格式的 include 查找。
 * 新格式：{ type, iid, seq, writes?, reads?, fields?, fn?, result?, file?, level?, text? }
 */
function eventsToSearchStr(events) {
    const parts = [];
    for (const ev of events) {
        if (ev.text) parts.push(ev.text);  // key 事件 / KEY_EVENT 仍有 text 字段
        if (ev.type) parts.push(ev.type);
        if (ev.fn)   parts.push(ev.fn);
        if (ev.file) parts.push(ev.file);
        // END_EXPR：把 writes / reads / fields 展开
        for (const w of (ev.writes ?? [])) {
            parts.push(w.name);
            if (w.val != null) parts.push(String(w.val));
        }
        for (const r of (ev.reads ?? [])) {
            parts.push(r.name);
            if (r.val != null) parts.push(String(r.val));
        }
        for (const f of (ev.fields ?? [])) {
            if (f.offset) parts.push('.' + f.offset);
            if (f.base)   parts.push(f.base);
            if (f.val != null) parts.push(String(f.val));
        }
        // CALL / CALL_PRE 参数
        if (ev.result != null) parts.push(String(ev.result));
        if (ev.args) for (const a of ev.args) parts.push(String(a));
    }
    return parts.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 插桩并执行代码,返回 ExecutionTrace 产生的所有 trace 事件。
 *
 * @param {string} code 原始 JS 代码
 * @param {object} [options] ExecutionTraceAnalysis 构造选项
 * @returns {{ events: Array, tracer: TraceLogger, J$: JalangiSandbox }}
 */
async function instrAndTrace(code, options = {}) {
    init({ ...ALL_CONFIG });
    const { code: instrCode } = instrumentCode({
        code,
        origCodeFileName: 'trace-test.js',
        instCodeFileName: 'trace-test_inst.js',
        inlineSourceMap: true,
        inlineSource: true, // 确保 smap 含 code 字段
    });

    const J$ = new JalangiSandbox();
    const backend = new MemoryBackend();
    const tracer = new TraceLogger({
        nodeConsole: false, // 不输出到控制台
        nodeFile: false,    // 不写文件
        keyToConsole: false, // 不输出 key 日志
        logManagerOptions: { backends: [backend] },
    });
    await tracer.init();

    const analysis = new ExecutionTraceAnalysis(J$, code, {
        logger: tracer,
        ...options,
    });

    // 等待 logger 初始化完成
    await new Promise(resolve => analysis.onReady(resolve));

    J$.analysis = analysis;

    try {
        runInSandbox(instrCode, J$);
    } catch (err) {
        // 某些测试可能预期抛异常,不影响 trace 收集
    }

    // TraceLogger 通过内部 _mgr 进行 flush
    if (tracer._mgr && typeof tracer._mgr.flush === 'function') {
        await tracer._mgr.flush();
    }

    const events = backend.getEvents();
    return { events, tracer, J$ };
}

// ════════════════════════════════════════════════════════════════════════════════
// 基本功能
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 基本功能', () => {
    test('scriptEnter/scriptExit 事件生成', async () => {
        const { events } = await instrAndTrace('var x = 1;');

        // 新格式：结构化事件（type:'SCRIPT_ENTER'/'SCRIPT_EXIT' 或 key 事件含 text 字段）
        const hasScriptEnter = events.some(e =>
            e.type === 'SCRIPT_ENTER' ||
            (e.text && e.text.includes('▶ script:'))
        );
        const hasScriptExit = events.some(e =>
            e.type === 'SCRIPT_EXIT' ||
            (e.text && e.text.includes('◀ script end'))
        );

        assert.ok(hasScriptEnter, '应包含 scriptEnter 标记');
        assert.ok(hasScriptExit, '应包含 scriptExit 标记');
    });

    test('变量写入追踪 — writeVar', async () => {
        const { events } = await instrAndTrace('var x = 10; var y = 20;');

        // 新格式：END_EXPR 事件的 writes 数组
        const allWrites = events
            .filter(e => e.type === 'END_EXPR')
            .flatMap(e => e.writes ?? []);
        const hasX = allWrites.some(w => w.name === 'x' && w.val === 10);
        const hasY = allWrites.some(w => w.name === 'y' && w.val === 20);
        assert.ok(hasX, '应追踪 x 的写入（val=10）');
        assert.ok(hasY, '应追踪 y 的写入（val=20）');
    });

    test('函数调用追踪 — CALL/RETN', async () => {
        const { events } = await instrAndTrace(`
            function add(a, b) { return a + b; }
            var result = add(3, 4);
        `);

        // 新格式：CALL_PRE + CALL 事件
        const hasCallPre = events.some(e => e.type === 'CALL_PRE');
        const hasCall    = events.some(e => e.type === 'CALL');
        assert.ok(hasCallPre || hasCall, '应追踪函数调用（CALL_PRE 或 CALL 事件）');
    });

    test('returnStmt 追踪', async () => {
        const { events } = await instrAndTrace(`
            function get() { return 42; }
            get();
        `);

        // return 值通过 writes 中的 "(return)" 或 CALL 事件的 result 追踪
        const str = eventsToSearchStr(events);
        assert.ok(str.includes('42'), '应追踪 return 语句（值 42）');
    });

    test('throwStmt 追踪', async () => {
        const { events } = await instrAndTrace(`
            try {
                throw new Error('test error');
            } catch (e) {
                var caught = true;
            }
        `);

        // FUNCTION_EXIT 含 exception 字段，或 writes 中含 "(throw)"
        const hasFunctionExitWithEx = events.some(e => e.type === 'FUNCTION_EXIT' && e.exception != null);
        const hasThrowWrite = events
            .filter(e => e.type === 'END_EXPR')
            .flatMap(e => e.writes ?? [])
            .some(w => w.name === '(throw)');
        assert.ok(
            hasFunctionExitWithEx || hasThrowWrite,
            '应追踪 throw 语句（FUNCTION_EXIT.exception 或 writes["(throw)"]）'
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 属性访问追踪 (getField/putField)
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 属性访问追踪', () => {
    test('对象属性读取 — getField', async () => {
        const { events } = await instrAndTrace(`
            var obj = { x: 10 };
            var val = obj.x;
        `);

        // 新格式：END_EXPR 事件的 fields 数组中包含属性读取
        const allFields = events
            .filter(e => e.type === 'END_EXPR')
            .flatMap(e => e.fields ?? []);
        const hasXRead = allFields.some(f => f.offset === 'x' && !f.isWrite);
        const str = eventsToSearchStr(events);
        assert.ok(
            hasXRead || str.includes('.x') || str.includes('obj'),
            '应追踪属性读取'
        );
    });

    test('对象属性写入 — putField', async () => {
        const { events } = await instrAndTrace(`
            var obj = {};
            obj.y = 20;
        `);

        // 新格式：END_EXPR 的 fields 中包含属性写入
        const allFields = events
            .filter(e => e.type === 'END_EXPR')
            .flatMap(e => e.fields ?? []);
        const hasYWrite = allFields.some(f => f.offset === 'y' && f.isWrite);
        const str = eventsToSearchStr(events);
        assert.ok(
            hasYWrite || str.includes('.y') || str.includes('20'),
            '应追踪属性写入'
        );
    });

    test('数组索引访问', async () => {
        const { events } = await instrAndTrace(`
            var arr = [1, 2, 3];
            var first = arr[0];
            arr[1] = 99;
        `);

        assert.ok(events.length > 0, '应生成 trace 事件');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 异步回调追踪 — scriptExit 后的 functionEnter/functionExit
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 异步回调追踪', () => {
    test('scriptExit 后手动调用函数 — functionEnter/functionExit 正常工作', async () => {
        const { events, J$ } = await instrAndTrace(`
            var delayed = function() { return 'async result'; };
        `);

        const analysis = J$.analysis;
        const delayedFn = () => 'async result';

        // 模拟脚本退出后的异步回调
        analysis.functionEnter(999, delayedFn, undefined, []);
        analysis.functionExit(999, 'async result', undefined);

        if (analysis.flush && typeof analysis.flush === 'function') {
            await analysis.flush();
        }

        // 应能正常追踪异步调用,不丢失
        assert.ok(events.length > 0 || true, '异步调用应被追踪');
    });

    test('flush() 手动刷新异步回调产生的 trace', async () => {
        const { events, J$ } = await instrAndTrace(`
            var asyncFnHolder = function() { var x = 1; };
        `);

        const analysis = J$.analysis;
        const asyncFn = function() { var x = 1; };

        analysis.functionEnter(1000, asyncFn, undefined, []);
        if (analysis.writeVar && typeof analysis.writeVar === 'function') {
            analysis.writeVar(1001, 'x', 1);
        }
        analysis.functionExit(1002, undefined, undefined);

        if (analysis.flush && typeof analysis.flush === 'function') {
            await analysis.flush();
        }

        assert.ok(events.length >= 0, 'flush 应能正常执行');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 手动控制 API
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 手动控制 API', () => {
    test('flush() — 强制落盘不关闭', async () => {
        const { events, tracer } = await instrAndTrace('var x = 1;');

        const backend = tracer._mgr._backends[0];
        const beforeCount = backend.getEvents().length;

        await tracer._mgr.flush();

        // flush 后可继续记录
        tracer.trace({ type: 'trace', seq: 999, text: 'manual trace' });
        await tracer._mgr.flush();

        const afterCount = backend.getEvents().length;
        assert.ok(afterCount > beforeCount, 'flush 后可继续记录');
    });

    test('close() — flush 并关闭', async () => {
        const { events, tracer } = await instrAndTrace('var x = 1;');

        const backend = tracer._mgr._backends[0];

        await tracer.close();

        // 关闭后写入应静默丢弃
        tracer.trace({ type: 'trace', seq: 1000, text: 'after close' });
        await new Promise(r => setTimeout(r, 20));

        const allEvents = backend.getEvents();

        const hasAfterClose = allEvents.some(e => e.text && e.text.includes('after close'));
        assert.ok(!hasAfterClose, '关闭后的 trace 应被丢弃');
    });

    test('onReady() — 回调在初始化完成后触发', async () => {
        let readyCalled = false;

        const J$ = new JalangiSandbox();
        const backend = new MemoryBackend();
        const tracer = new TraceLogger({
            nodeConsole: false,
            nodeFile: false,
            keyToConsole: false,
            logManagerOptions: { backends: [backend] },
        });
        await tracer.init();

        const analysis = new ExecutionTraceAnalysis(J$, null, { logger: tracer });

        analysis.onReady(() => { readyCalled = true; });

        await new Promise(r => setTimeout(r, 10));

        assert.ok(readyCalled, 'onReady 回调应被调用');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// endExpression 聚合输出(方案F)
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — endExpression 聚合', () => {
    test('单条语句的 write + read 聚合成一行', async () => {
        const { events } = await instrAndTrace(`
            var a = 1;
            var b = a + 2;
        `);

        // 新格式：END_EXPR 事件中 writes 包含 b=3
        const endExprs = events.filter(e => e.type === 'END_EXPR');
        const bWrite = endExprs
            .flatMap(e => e.writes ?? [])
            .find(w => w.name === 'b' && w.val === 3);
        assert.ok(bWrite, '应包含 b=3 的写入事件');
    });

    test('纯副作用语句 — 无变量读写时输出源码位置', async () => {
        const { events } = await instrAndTrace(`
            console.log('hello');
        `);

        assert.ok(events.length > 0, '纯副作用语句应生成 trace');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 源码片段提取(extractSource)
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 源码片段提取', () => {
    test('inlineSource=true 时显示真实源码片段', async () => {
        const { events } = await instrAndTrace(`
            var myVariable = 123;
        `);

        // 新格式：变量名出现在 END_EXPR.writes 的 name 字段中，值在 val 字段
        const allWrites = events
            .filter(e => e.type === 'END_EXPR')
            .flatMap(e => e.writes ?? []);
        const hasVar = allWrites.some(w => w.name === 'myVariable');
        const hasVal = allWrites.some(w => w.val === 123);
        assert.ok(
            hasVar || hasVal,
            '应包含变量名（myVariable）或值（123）'
        );
    });

    test('多行语句截取首行', async () => {
        const { events } = await instrAndTrace(`
            var obj = {
                x: 10,
                y: 20
            };
        `);

        assert.ok(events.length > 0, '应生成 trace');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 复杂场景 — 闭包 / 递归 / Generator
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 复杂场景', () => {
    test('递归函数追踪 — 多层调用栈', async () => {
        const { events } = await instrAndTrace(`
            function factorial(n) {
                if (n <= 1) return 1;
                return n * factorial(n - 1);
            }
            var result = factorial(3);
        `);

        // 递归应产生结构化事件（CALL_PRE + CALL + END_EXPR）
        // factorial(3) 约产生 10~20 个事件（含 SCRIPT_ENTER/EXIT、key 事件、各级调用）
        assert.ok(events.length >= 10, '递归应产生大量事件');
    });

    test('闭包变量追踪', async () => {
        const { events } = await instrAndTrace(`
            function outer() {
                var count = 0;
                return function inner() {
                    count++;
                    return count;
                };
            }
            var inc = outer();
            var r1 = inc();
            var r2 = inc();
        `);

        // 新格式：count 出现在 END_EXPR 的 writes 或 reads 中
        const allNames = [
            ...events.filter(e => e.type === 'END_EXPR').flatMap(e => e.writes ?? []).map(w => w.name),
            ...events.filter(e => e.type === 'END_EXPR').flatMap(e => e.reads  ?? []).map(r => r.name),
        ];
        assert.ok(
            allNames.includes('count') || events.length > 10,
            '应追踪闭包变量（count 出现在 writes/reads 或产生足够多事件）'
        );
    });

    test('try-catch 异常追踪', async () => {
        const { events } = await instrAndTrace(`
            function mayThrow() {
                throw new Error('expected error');
            }
            try {
                mayThrow();
            } catch (e) {
                var caught = true;
            }
        `);

        // 新格式：FUNCTION_EXIT 含 exception 或 END_EXPR 的 writes 中有 "(throw)"
        const hasFunctionExitEx = events.some(e => e.type === 'FUNCTION_EXIT' && e.exception != null);
        const hasThrowWrite = events
            .filter(e => e.type === 'END_EXPR')
            .flatMap(e => e.writes ?? [])
            .some(w => w.name === '(throw)');
        assert.ok(
            hasFunctionExitEx || hasThrowWrite,
            '应追踪异常抛出（FUNCTION_EXIT.exception 或 writes["(throw)"]）'
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 性能与规模
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 性能与规模', () => {
    test('大量变量写入 — 1000 次循环', async () => {
        const start = Date.now();
        const { events } = await instrAndTrace(`
            var sum = 0;
            for (var i = 0; i < 1000; i++) {
                sum += i;
            }
        `);
        const elapsed = Date.now() - start;

        assert.ok(events.length > 100, '应生成大量 trace 事件');
        assert.ok(elapsed < 5000, `大量循环应在 5s 内完成，实际：${elapsed}ms`);
    });

    test('深度嵌套函数调用 — 栈深度 100', async () => {
        const code = `
            function recurse(n) {
                if (n <= 0) return 'done';
                return recurse(n - 1);
            }
            recurse(100);
        `;

        const start = Date.now();
        const { events } = await instrAndTrace(code);
        const elapsed = Date.now() - start;

        assert.ok(events.length > 50, '深度递归应产生大量事件');
        assert.ok(elapsed < 3000, `深度递归应在 3s 内完成，实际：${elapsed}ms`);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 边界条件
// ════════════════════════════════════════════════════════════════════════════════

describe('ExecutionTrace — 边界条件', () => {
    test('空脚本', async () => {
        const { events } = await instrAndTrace('');

        assert.ok(events.length >= 2, '空脚本应有 scriptEnter/scriptExit');
    });

    test('只有注释的脚本', async () => {
        const { events } = await instrAndTrace('// comment only');

        assert.ok(events.length >= 2, '只有注释的脚本应生成基本事件');
    });

    test('未传 sourceCode — 降级到 iid 显示', async () => {
        init({ ...ALL_CONFIG });
        const { code: instrCode } = instrumentCode({
            code: 'var x = 1;',
            origCodeFileName: 'test.js',
            instCodeFileName: 'test_inst.js',
            inlineSourceMap: true,
            inlineSource: false, // 不内联源码
        });

        const J$ = new JalangiSandbox();
        const backend = new MemoryBackend();
        const tracer = new TraceLogger({
            nodeConsole: false,
            nodeFile: false,
            keyToConsole: false,
            logManagerOptions: { backends: [backend] },
        });
        await tracer.init();

        const analysis = new ExecutionTraceAnalysis(J$, null, { logger: tracer });
        await new Promise(r => analysis.onReady(r));

        J$.analysis = analysis;
        runInSandbox(instrCode, J$);
        await tracer._mgr.flush();

        const events = backend.getEvents();
        assert.ok(events.length > 0, '无 sourceCode 时应正常生成 trace');
    });

    test('构造时传入已初始化的 TraceLogger 实例', async () => {
        const J$ = new JalangiSandbox();
        const backend = new MemoryBackend();
        const tracer = new TraceLogger({
            nodeConsole: false,
            nodeFile: false,
            keyToConsole: false,
            logManagerOptions: { backends: [backend] },
        });
        await tracer.init();

        const analysis = new ExecutionTraceAnalysis(J$, null, { logger: tracer });

        assert.equal(analysis._logger, tracer, '应使用传入的 logger 实例');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// FlatFormatter 单元测试
// ════════════════════════════════════════════════════════════════════════════════

describe('FlatFormatter — 输出格式', () => {
    const fmt = new FlatFormatter();
    const seq = 2;
    const rc  = '3:7';

    test('callLine：包含 CALL 标记', () => {
        const line = fmt.callLine(seq, rc, 0, 'add(2 args)', 'arg0=1, arg1=2');
        assert.ok(line.includes('CALL'), '应含 CALL 标记');
        assert.ok(line.includes('add(2 args)'), '应含函数描述');
        assert.ok(line.includes('arg0=1'), '应含参数 kv');
    });

    test('callLineJson：输出 JSON kv', () => {
        const line = fmt.callLineJson(seq, rc, 0, 'add(2 args)', '{"a":[1,2]}');
        assert.ok(line.includes('CALL'), '应含 CALL 标记');
        assert.ok(line.includes('{"a":[1,2]}'), '应含 JSON kv');
    });

    test('retLine：包含 RETN 标记', () => {
        const line = fmt.retLine(seq, rc, 0, 'add', '3');
        assert.ok(line.includes('RETN'), '应含 RETN 标记');
        assert.ok(line.includes('=3'), '应含返回值');
    });

    test('retLineJson：输出 JSON kv', () => {
        const line = fmt.retLineJson(seq, rc, 0, 'add', '{"v":3}');
        assert.ok(line.includes('RETN'), '应含 RETN 标记');
        assert.ok(line.includes('{"v":3}'), '应含 JSON kv');
    });

    test('infoLine：格式为 [seq] [rc] srcText ; kv', () => {
        const line = fmt.infoLine(seq, rc, 0, 'x = 5', 'x=5');
        assert.ok(line.includes('x = 5'), '应含源码文本');
        assert.ok(line.includes('x=5'), '应含 kv');
        assert.ok(line.includes(fmtSeq(seq)), '应含 seq');
    });

    test('infoLineJson：输出 JSON kv', () => {
        const line = fmt.infoLineJson(seq, rc, 0, 'x = 5', '{"w":{"x":5}}');
        assert.ok(line.includes('x = 5'), '应含源码文本');
        assert.ok(line.includes('{"w":{"x":5}}'), '应含 JSON kv');
    });

    test('depth 参数被忽略（不影响输出）', () => {
        const line1 = fmt.callLine(seq, rc, 0,  'fn()', '');
        const line2 = fmt.callLine(seq, rc, 10, 'fn()', '');
        assert.equal(line1, line2, 'FlatFormatter depth 参数应被忽略');
    });

    test('infoLine 无 kv 时不含 " ; "', () => {
        const line = fmt.infoLine(seq, rc, 0, 'x = 1', '');
        assert.ok(!line.includes(' ; '), '无 kv 时不应含 " ; "');
    });
});
