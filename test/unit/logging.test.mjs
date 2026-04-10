// JALANGI DO NOT INSTRUMENT
/**
 * test/unit/logging.test.mjs — 日志系统单元测试（纯内存，无 IO）
 *
 * 覆盖：
 *  1. RingBuffer — push/drain/overflow/stats
 *  2. EventSerializer — NDJSON / Binary 序列化往返
 *  3. MemoryBackend — write/flush/close/getEvents
 *  4. LogManager — log/flush/close/多后端/背压/autoFlush
 *
 * 运行：
 *   node --test test/unit/logging.test.mjs
 *   npm run test:unit
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// 被测模块
import { RingBuffer }           from '../../src/logger/RingBuffer.js';
import {
    EVENT_TYPE,
    serializeEvent, serializeBatch, deserializeEvent, deserializeAll,
    createFileHeader, isBinaryTrace, FILE_HEADER_SIZE,
    StringPool, EventSerializerWithPool,
} from '../../src/encoding/EventSerializer.js';
import { MemoryBackend }        from '../../src/logger/transport/MemoryBackend.js';
import { LogManager, createMemoryLogManager } from '../../src/logger/LogManager.js';
import { TraceLogger }          from '../../src/logger/TraceLogger.js';

// ════════════════════════════════════════════════════════════════════════════════
// 1. RingBuffer
// ════════════════════════════════════════════════════════════════════════════════

describe('RingBuffer', () => {
    test('push 和 drain 基本往返', () => {
        const rb = new RingBuffer({ capacity: 8 });
        rb.push('a'); rb.push('b'); rb.push('c');
        assert.equal(rb.size, 3);
        const out = rb.drain();
        assert.deepEqual(out, ['a', 'b', 'c']);
        assert.equal(rb.size, 0);
    });

    test('drain(maxCount) 只取指定数量', () => {
        const rb = new RingBuffer({ capacity: 16 });
        for (let i = 0; i < 10; i++) rb.push(i);
        const out = rb.drain(4);
        assert.equal(out.length, 4);
        assert.equal(rb.size, 6);
    });

    test('自动扩容：超过容量时不丢弃，而是扩容', () => {
        const rb = new RingBuffer({ capacity: 4 });
        for (let i = 0; i < 10; i++) rb.push(i);
        // 不丢弃，size 应该等于实际 push 数量
        assert.equal(rb.size, 10);
        assert.equal(rb.stats.totalDropped, 0);
        // 扩容至少发生一次
        assert.ok(rb.stats.totalResizes >= 1);
        // 所有数据完整保留
        assert.deepEqual(rb.drain(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    test('扩容后环形绕回仍然正确', () => {
        const rb = new RingBuffer({ capacity: 4 });
        // 填满后触发扩容
        for (let i = 0; i < 6; i++) rb.push(i);
        assert.ok(rb.stats.totalResizes >= 1);
        // 验证数据完整性
        assert.deepEqual(rb.drain(), [0, 1, 2, 3, 4, 5]);
    });

    test('shouldFlush 在阈值时返回 true', () => {
        const rb = new RingBuffer({ capacity: 1000, flushThreshold: 3 });
        rb.push(1); rb.push(2);
        assert.equal(rb.shouldFlush, false);
        rb.push(3);
        assert.equal(rb.shouldFlush, true);
    });

    test('clear 清空缓冲区', () => {
        const rb = new RingBuffer({ capacity: 8 });
        rb.push('x'); rb.push('y');
        rb.clear();
        assert.equal(rb.size, 0);
        assert.deepEqual(rb.drain(), []);
    });

    test('环形绕回（wrap around）正确', () => {
        const rb = new RingBuffer({ capacity: 4 });
        rb.push(0); rb.push(1); rb.push(2); rb.push(3);
        rb.drain(2);            // head=2, tail=4(=0), size=2
        rb.push(4); rb.push(5); // 绕回写到 0,1
        assert.equal(rb.size, 4);
        assert.deepEqual(rb.drain(), [2, 3, 4, 5]);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. EventSerializer
// ════════════════════════════════════════════════════════════════════════════════

describe('EventSerializer', () => {
    test('EVENT_TYPE 枚举完整', () => {
        // 新格式：EVENT_TYPE 包含 SCRIPT_ENTER、END_EXPR、CALL_PRE 等
        assert.ok(EVENT_TYPE.SCRIPT_ENTER !== undefined);
        assert.ok(EVENT_TYPE.SCRIPT_EXIT  !== undefined);
        assert.ok(EVENT_TYPE.CALL_PRE     !== undefined);
        assert.ok(EVENT_TYPE.CALL         !== undefined);
        assert.ok(EVENT_TYPE.END_EXPR     !== undefined);
    });

    test('createFileHeader 产生正确魔数', () => {
        const header = createFileHeader();
        const bytes = new Uint8Array(header);
        assert.equal(bytes[0], 0x4A); // J
        assert.equal(bytes[1], 0x54); // T
        assert.equal(bytes[2], 0x42); // B
        assert.equal(bytes[3], 0x31); // 1
        assert.equal(bytes[4], 0x01); // version
        assert.equal(header.byteLength, FILE_HEADER_SIZE);
    });

    test('isBinaryTrace 正确识别 JTB1 文件', () => {
        const header = new Uint8Array(createFileHeader());
        assert.ok(isBinaryTrace(header));
        assert.ok(!isBinaryTrace(new Uint8Array([0x7B, 0x22, 0x74, 0x79]))); // JSON {
        assert.ok(!isBinaryTrace(new Uint8Array([]))); // 空
    });

    test('serializeBatch / deserializeAll 完整批次往返', () => {
        const batch = [
            { type: 'SCRIPT_ENTER', iid: 8,  seq: 1, file: 'a.js' },
            { type: 'END_EXPR',     iid: 16, seq: 2, writes: [{ name: 'x', val: 42 }], reads: [], fields: [] },
            { type: 'CALL_PRE',     iid: 24, seq: 3, fn: 'foo', args: [1, 'two'], isConstructor: false, isMethod: false },
            { type: 'SCRIPT_EXIT',  iid: 32, seq: 4 },
        ];
        // serializeBatch 产生连续事件流（无文件头）
        const batchBuf = serializeBatch(batch);
        // 拼接文件头 + 事件流才能用 deserializeAll
        const headerBuf = createFileHeader();
        const combined = new Uint8Array(headerBuf.byteLength + batchBuf.byteLength);
        combined.set(new Uint8Array(headerBuf), 0);
        combined.set(new Uint8Array(batchBuf), headerBuf.byteLength);
        const events = deserializeAll(combined.buffer);
        assert.equal(events.length, 4);
        assert.equal(events[0].type, 'SCRIPT_ENTER');
        assert.equal(events[0].file, 'a.js');
        assert.equal(events[1].type, 'END_EXPR');
        assert.equal(events[1].writes[0].value, 42);
        assert.equal(events[2].type, 'CALL_PRE');
        assert.equal(events[2].fn, 'foo');
        assert.equal(events[3].type, 'SCRIPT_EXIT');
    });

    test('JTB1 二进制：serializeEvent/deserializeEvent SCRIPT_ENTER 往返', () => {
        const buf = serializeEvent({ type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'test.js' });
        assert.ok(buf instanceof ArrayBuffer);
        // deserializeEvent 需要跳过头部（从 offset=0 开始，不含文件魔数）
        const { event } = deserializeEvent(new DataView(buf), 0);
        assert.equal(event.type, 'SCRIPT_ENTER');
        assert.equal(event.iid,  8);
        assert.equal(event.seq,  1);
        assert.equal(event.file, 'test.js');
    });

    test('JTB1 二进制：END_EXPR 含 writes/reads 往返', () => {
        const ev = {
            type: 'END_EXPR', iid: 24, seq: 2,
            writes: [{ name: 'x', val: 42,    omit: false }],
            reads:  [{ name: 'y', val: 3.14,  omit: false }],
            fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        assert.equal(event.type,            'END_EXPR');
        assert.equal(event.iid,             24);
        assert.equal(event.writes.length,   1);
        assert.equal(event.writes[0].name,  'x');
        assert.equal(event.writes[0].value, 42);
        assert.equal(event.reads.length,    1);
        assert.equal(event.reads[0].name,   'y');
        assert.ok(Math.abs(event.reads[0].value - 3.14) < 1e-10);
    });

    test('JTB1 二进制：OMITTED 值往返', () => {
        const ev = {
            type: 'END_EXPR', iid: 32, seq: 3,
            writes: [],
            reads:  [{ name: 'z', val: undefined, omit: true }],
            fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        assert.equal(event.reads[0].name,    'z');
        assert.equal(event.reads[0].omitted, true);
    });

    test('JTB1 二进制：CALL_PRE 含 args 往返', () => {
        const ev = {
            type: 'CALL_PRE', iid: 40, seq: 4,
            fn: 'add', isConstructor: false, isMethod: false,
            args: [1, 'hello', null, true],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        assert.equal(event.type, 'CALL_PRE');
        assert.equal(event.fn,   'add');
        assert.equal(event.args[0], 1);
        assert.equal(event.args[1], 'hello');
        assert.equal(event.args[2], null);
        assert.equal(event.args[3], true);
    });

    test('JTB1 二进制：各事件类型 type/iid/seq 正确保存', () => {
        const batch = [
            { type: 'SCRIPT_ENTER',   iid: 8,  seq: 1, file: 'a.js' },
            { type: 'END_EXPR',       iid: 16, seq: 2, writes: [{ name: 'x', val: 42 }], reads: [], fields: [] },
            { type: 'CALL_PRE',       iid: 24, seq: 3, fn: 'foo', args: [], isConstructor: false, isMethod: false },
            { type: 'CALL',           iid: 24, seq: 4, fn: 'foo', result: 99 },
            { type: 'FUNCTION_ENTER', iid: 32, seq: 5 },
            { type: 'FUNCTION_EXIT',  iid: 32, seq: 6 },
            { type: 'SCRIPT_EXIT',    iid: 40, seq: 7 },
        ];
        for (const ev of batch) {
            const buf = serializeEvent(ev);
            const { event } = deserializeEvent(new DataView(buf), 0);
            assert.equal(event.type, ev.type, `type mismatch for ${ev.type}`);
            assert.equal(event.iid,  ev.iid,  `iid mismatch for ${ev.type}`);
            assert.equal(event.seq,  ev.seq,  `seq mismatch for ${ev.type}`);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3. MemoryBackend
// ════════════════════════════════════════════════════════════════════════════════

describe('MemoryBackend', () => {
    test('write / getEvents 基本收集', async () => {
        const backend = new MemoryBackend();
        await backend.write([{ type: 'READ', iid: 8 }, { type: 'WRITE', iid: 16 }]);
        await backend.write([{ type: 'LITERAL', iid: 24 }]);
        const events = backend.getEvents();
        assert.equal(events.length,    3);
        assert.equal(events[0].type,   'READ');
        assert.equal(events[2].type,   'LITERAL');
    });

    test('getEventsOfType 过滤正确', async () => {
        const backend = new MemoryBackend();
        await backend.write([
            { type: 'READ',  iid: 8  },
            { type: 'WRITE', iid: 16 },
            { type: 'READ',  iid: 24 },
        ]);
        assert.equal(backend.getEventsOfType('READ').length, 2);
    });

    test('flush 是 noop（不抛出）', async () => {
        await new MemoryBackend().flush();
    });

    test('close 后 write 抛出 already closed', async () => {
        const backend = new MemoryBackend();
        await backend.close();
        await assert.rejects(
            () => backend.write([{ type: 'READ', iid: 8 }]),
            /already closed/
        );
    });

    test('clear 清空事件和统计', async () => {
        const backend = new MemoryBackend();
        await backend.write([{ type: 'READ', iid: 8 }]);
        backend.clear();
        assert.equal(backend.getEvents().length, 0);
        assert.equal(backend.stats.totalEvents,  0);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. LogManager
// ════════════════════════════════════════════════════════════════════════════════

describe('LogManager', () => {
    test('push 事件被路由到后端', async () => {
        const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 2 });
        mgr.push({ type: 'READ',  iid: 8  });
        mgr.push({ type: 'WRITE', iid: 16 });
        await mgr.flush();
        assert.equal(backend.getEvents().length,   2);
        assert.equal(backend.getEvents()[0].type, 'READ');
        await mgr.close();
    });

    test('close 后 push 静默丢弃（不抛出）', async () => {
        const { mgr } = await createMemoryLogManager();
        await mgr.close();
        mgr.push({ type: 'READ', iid: 8 }); // 不应抛出
    });

    test('flush 前 RingBuffer 中的事件不丢失', async () => {
        const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 10000 });
        for (let i = 0; i < 50; i++) mgr.push({ type: 'READ', iid: i * 8 });
        assert.equal(backend.getEvents().length, 0);  // 尚未 flush
        await mgr.flush();
        assert.equal(backend.getEvents().length, 50);
        await mgr.close();
    });

    test('多后端同时接收', async () => {
        const b1 = new MemoryBackend();
        const b2 = new MemoryBackend();
        const mgr = new LogManager({ backends: [b1, b2], autoClose: false });
        mgr.push({ type: 'READ',  iid: 8  });
        mgr.push({ type: 'WRITE', iid: 16 });
        await mgr.flush();
        assert.equal(b1.getEvents().length, 2);
        assert.equal(b2.getEvents().length, 2);
        await mgr.close();
    });

    test('动态 addBackend / removeBackend', async () => {
        const b1  = new MemoryBackend();
        const b2  = new MemoryBackend();
        const mgr = new LogManager({ backends: [b1], autoClose: false });
        mgr.addBackend(b2);
        mgr.push({ type: 'READ', iid: 8 });
        await mgr.flush();
        assert.equal(b1.getEvents().length, 1);
        assert.equal(b2.getEvents().length, 1);

        mgr.removeBackend(b2);
        mgr.push({ type: 'WRITE', iid: 16 });
        await mgr.flush();
        assert.equal(b1.getEvents().length, 2);
        assert.equal(b2.getEvents().length, 1); // 移除后不再接收
        await mgr.close();
    });

    test('close 时 flush 剩余 RingBuffer', async () => {
        const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 99999 });
        for (let i = 0; i < 20; i++) mgr.push({ type: 'READ', iid: i });
        await mgr.close();
        assert.equal(backend.getEvents().length, 20);
    });

    test('getStats 返回合理数据', async () => {
        const { mgr } = await createMemoryLogManager();
        mgr.push({ type: 'READ',  iid: 8  });
        mgr.push({ type: 'WRITE', iid: 16 });
        await mgr.flush();
        const s = mgr.getStats();
        assert.equal(s.logManager.totalLogged, 2);
        assert.ok(s.logManager.totalFlushed >= 2);
        await mgr.close();
    });

    test('drainBatchSize 控制单次 drain 量', async () => {
        const backend    = new MemoryBackend();
        const batchSizes = [];
        const origWrite  = backend.write.bind(backend);
        backend.write = async (batch) => { batchSizes.push(batch.length); return origWrite(batch); };

        const mgr = new LogManager({
            backends:       [backend],
            flushThreshold: 100,
            drainBatchSize: 3,
            autoClose:      false,
        });
        for (let i = 0; i < 9; i++) mgr.push({ type: 'READ', iid: i * 8 });
        await mgr.flush();
        await new Promise(r => setTimeout(r, 50));

        for (const sz of batchSizes) {
            assert.ok(sz <= 3, `batch size ${sz} 超过 drainBatchSize=3`);
        }
        assert.equal(backend.getEvents().length, 9);
        await mgr.close();
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. TraceLogger — 统一日志门面
// ════════════════════════════════════════════════════════════════════════════════

describe('TraceLogger', () => {
    /**
     * 辅助函数：创建带 MemoryBackend 的 TraceLogger
     */
    async function createTestLogger(extraOptions = {}) {
        const backend = new MemoryBackend();
        const logger = new TraceLogger({
            nodeConsole: false,
            nodeFile: false,
            keyToConsole: false,
            logManagerOptions: {
                backends: [backend],
                forceSyncFlushThreshold: 1, // 每次 push 立即 flush（测试用）
            },
            ...extraOptions,
        });
        await logger.init();
        return { logger, backend };
    }

    test('trace() — 写入普通 trace 行', async () => {
        const { logger, backend } = await createTestLogger();

        logger.trace({ type: 'trace', seq: 1, text: 'test trace line' });
        await logger._mgr.flush(); // TraceLogger 通过 _mgr.flush() 刷新

        const events = backend.getEvents();
        assert.ok(events.length >= 1, '应有至少 1 条事件');
        const traceEvent = events.find(e => e.text === 'test trace line');
        assert.ok(traceEvent, '应找到写入的 trace 事件');
        assert.equal(traceEvent.seq, 1);
    });

    test('key() — 写入重要事件到后端', async () => {
        const { logger, backend } = await createTestLogger();

        logger.key('info', '▶ script: test.js');
        await logger._mgr.flush();

        const events = backend.getEvents();
        const keyEvent = events.find(e => e.type === 'key');
        assert.ok(keyEvent, '应找到 key 事件');
        assert.equal(keyEvent.level, 'info');
        assert.ok(keyEvent.text.includes('test.js'));
    });

    test('key() — 不同级别（info/warn/error）', async () => {
        const { logger, backend } = await createTestLogger();

        logger.key('info', 'info message');
        logger.key('warn', 'warn message');
        logger.key('error', 'error message');
        await logger._mgr.flush();

        const events = backend.getEvents();
        const levels = events.filter(e => e.type === 'key').map(e => e.level);
        assert.ok(levels.includes('info'), '应有 info 级别');
        assert.ok(levels.includes('warn'), '应有 warn 级别');
        assert.ok(levels.includes('error'), '应有 error 级别');
    });

    test('pre-init 缓冲 — init 前写入不丢失', async () => {
        const backend = new MemoryBackend();
        const logger = new TraceLogger({
            nodeConsole: false,
            nodeFile: false,
            keyToConsole: false,
            logManagerOptions: {
                backends: [backend],
            },
        });

        // 不 await init，先写入
        logger.trace({ type: 'trace', seq: 1, text: 'pre-init trace 1' });
        logger.trace({ type: 'trace', seq: 2, text: 'pre-init trace 2' });
        logger.key('info', 'pre-init key event');

        // 再初始化
        await logger.init();
        await logger._mgr.flush();

        const events = backend.getEvents();
        const texts = events.map(e => e.text);
        assert.ok(texts.includes('pre-init trace 1'), '初始化前写入不应丢失');
        assert.ok(texts.includes('pre-init trace 2'), '初始化前写入不应丢失');
    });

    test('flush() — 将缓冲事件写入后端', async () => {
        const { logger, backend } = await createTestLogger();

        for (let i = 0; i < 5; i++) {
            logger.trace({ type: 'trace', seq: i, text: `line ${i}` });
        }

        await logger._mgr.flush();

        const events = backend.getEvents();
        assert.ok(events.length >= 5, 'flush 后应写入所有事件');
    });

    test('close() — 关闭后 trace 静默丢弃', async () => {
        const { logger, backend } = await createTestLogger();

        logger.trace({ type: 'trace', seq: 1, text: 'before close' });
        await logger._mgr.flush();

        const beforeCount = backend.getEvents().length;

        await logger.close();

        // 关闭后写入
        logger.trace({ type: 'trace', seq: 2, text: 'after close' });
        await new Promise(r => setTimeout(r, 50)); // 等待一小段时间

        const afterCount = backend.getEvents().length;
        assert.equal(afterCount, beforeCount, '关闭后事件应被丢弃');
    });

    test('scheduleFlush() — 异步调度 flush', async () => {
        const { logger, backend } = await createTestLogger();

        logger.trace({ type: 'trace', seq: 1, text: 'async flush test' });

        if (typeof logger.scheduleFlush === 'function') {
            logger.scheduleFlush();
            // 等待微任务执行
            await new Promise(r => setTimeout(r, 50));

            const events = backend.getEvents();
            assert.ok(events.length > 0, 'scheduleFlush 后应有事件');
        } else {
            // 如果不支持 scheduleFlush，手动 flush 验证
            await logger._mgr.flush();
            const events = backend.getEvents();
            assert.ok(events.length > 0, '应有 trace 事件');
        }
    });

    test('多次调用 init() 幂等', async () => {
        const { logger, backend } = await createTestLogger();

        // 重复 init 不应出错
        const ready1 = logger.init();
        const ready2 = logger.init();
        assert.equal(ready1, ready2, '多次 init() 应返回相同 Promise');

        await ready1;
        // 已初始化后继续 trace 应正常
        logger.trace({ type: 'trace', seq: 1, text: 'after dup init' });
        await logger._mgr.flush();
        assert.ok(backend.getEvents().length > 0, '重复 init 后应能正常工作');
    });

    test('nodeFile=false 时不创建文件后端', async () => {
        // 应降级到 MemoryBackend（通过 logManagerOptions.backends）
        const { logger, backend } = await createTestLogger({ nodeFile: false });

        logger.trace({ type: 'trace', seq: 1, text: 'no file mode' });
        await logger._mgr.flush();

        const events = backend.getEvents();
        assert.ok(events.length > 0, 'nodeFile=false 时 MemoryBackend 应仍可用');
    });

    test('trace/key 路由差异 — trace 走后端 key 带级别', async () => {
        const { logger, backend } = await createTestLogger();

        logger.trace({ type: 'trace', seq: 1, text: 'regular trace' });
        logger.key('warn', 'important warning');
        await logger._mgr.flush();

        const events = backend.getEvents();
        const traceEvents = events.filter(e => e.type === 'trace');
        const keyEvents   = events.filter(e => e.type === 'key');

        assert.ok(traceEvents.length > 0, '应有 trace 类型事件');
        assert.ok(keyEvents.length > 0, '应有 key 类型事件');
        assert.equal(keyEvents[0].level, 'warn', 'key 事件应保留级别');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. Value Pool / Dictionary Compression
// ════════════════════════════════════════════════════════════════════════════════

describe('StringPool', () => {
    test('首次注册返回新 ID，再次注册返回相同 ID', () => {
        const pool = new StringPool();
        const id1 = pool.register('myVariable');
        const id2 = pool.register('myVariable');
        assert.ok(id1 !== null, '长度 >= 4 的字符串应被注册');
        assert.equal(id1, id2, '相同字符串应返回相同 ID');
    });

    test('太短的字符串（< 4 字符）不入池', () => {
        const pool = new StringPool();
        assert.equal(pool.register('x'),   null, '单字符不入池');
        assert.equal(pool.register('ab'),  null, '双字符不入池');
        assert.equal(pool.register('abc'), null, '三字符不入池');
        assert.equal(pool.register('abcd'), 1,   '四字符应入池，返回 ID 1');
    });

    test('lookup 未注册字符串返回 null', () => {
        const pool = new StringPool();
        assert.equal(pool.lookup('unknown'), null, '未注册字符串应返回 null');
    });

    test('lookup 已注册字符串返回正确 ID', () => {
        const pool = new StringPool();
        const id = pool.register('hello');
        assert.equal(pool.lookup('hello'), id, '已注册字符串 lookup 应返回 ID');
    });

    test('不同字符串分配不同 ID（单调递增）', () => {
        const pool = new StringPool();
        const ids = ['alpha', 'beta', 'gamma', 'delta'].map(s => pool.register(s));
        assert.deepEqual(ids, [1, 2, 3, 4], '应分配连续 ID 1..4');
    });

    test('flushPending 返回新注册条目并清空队列', () => {
        const pool = new StringPool();
        pool.register('firstStr');
        pool.register('secondStr');
        const pending1 = pool.flushPending();
        assert.equal(pending1.length, 2, '首次 flush 应有 2 条');
        assert.equal(pending1[0].str, 'firstStr');
        assert.equal(pending1[1].str, 'secondStr');

        // 第二次 flush：无新条目
        const pending2 = pool.flushPending();
        assert.equal(pending2.length, 0, '无新注册时 flush 应为空');
    });

    test('flushPending 后再次注册新字符串，再 flush 只返回新条目', () => {
        const pool = new StringPool();
        pool.register('oldStr123');
        pool.flushPending();                 // 清空旧队列

        pool.register('newStr456');
        const pending = pool.flushPending();
        assert.equal(pending.length, 1, '只有新条目应出现');
        assert.equal(pending[0].str, 'newStr456');
    });

    test('scanBatch 自动注册 END_EXPR 事件中的变量名（>= 4 字符）', () => {
        const pool = new StringPool();
        pool.scanBatch([{
            type: 'END_EXPR', iid: 8, seq: 1,
            writes: [{ name: 'counter', val: 1 }],
            reads:  [{ name: 'counter', val: 1 }],
            // offset 需 >= 4 字符才会入池；base_oid 是 u32，不走 StringPool
            fields: [{ offset: 'propName', val: 2, baseOid: 3 }],
        }]);
        assert.ok(pool.lookup('counter')  !== null, 'counter 应已注册');
        assert.ok(pool.lookup('propName') !== null, 'propName 应已注册');
        // base_oid 是数字，不会入池
        assert.equal(pool.lookup('obj'), null, 'obj（3字符）不应入池');
    });

    test('size 属性反映当前字典大小', () => {
        const pool = new StringPool();
        assert.equal(pool.size, 0, '初始应为 0');
        pool.register('firstEntry');
        pool.register('secondEntry');
        assert.equal(pool.size, 2, '注册 2 条后应为 2');
    });
});

describe('EventSerializerWithPool — 序列化与反序列化往返', () => {
    /**
     * 辅助：将 EventSerializerWithPool 产生的 ArrayBuffer[] 和文件头拼成单个 buf，
     * 然后用 deserializeAll 解码。
     */
    function serializeAndDecode(serializer, batches) {
        const parts = [serializer.createFileHeader()];
        for (const batch of batches) {
            const bufs = serializer.serializeBatch(batch);
            parts.push(...bufs);
        }
        let totalSize = 0;
        for (const p of parts) totalSize += p.byteLength;
        const combined = new Uint8Array(totalSize);
        let pos = 0;
        for (const p of parts) {
            combined.set(new Uint8Array(p), pos);
            pos += p.byteLength;
        }
        return deserializeAll(combined.buffer);
    }

    test('基本 SCRIPT_ENTER 往返（含字典注册）', () => {
        const serializer = new EventSerializerWithPool();
        const events = serializeAndDecode(serializer, [[
            { type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'myScript.js' },
        ]]);
        // 过滤掉 DICT_ENTRY 事件
        const scriptEnter = events.filter(e => e.type === 'SCRIPT_ENTER');
        assert.equal(scriptEnter.length, 1, '应有 1 条 SCRIPT_ENTER');
        assert.equal(scriptEnter[0].file, 'myScript.js', 'file 字段应正确还原');
    });

    test('DICT_ENTRY 事件正确插入且字符串可解码', () => {
        const serializer = new EventSerializerWithPool();
        const events = serializeAndDecode(serializer, [[
            { type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'myScript.js' },
        ]]);
        const dictEntries = events.filter(e => e.type === 'DICT_ENTRY');
        assert.ok(dictEntries.length >= 1, '应有至少 1 条 DICT_ENTRY');
        const entry = dictEntries.find(e => e.str === 'myScript.js');
        assert.ok(entry, 'myScript.js 应出现在 DICT_ENTRY 中');
    });

    test('第二次 batch 中相同字符串不产生新 DICT_ENTRY', () => {
        const serializer = new EventSerializerWithPool();

        // 第一批：file 注册到字典
        const batch1 = [{ type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'myScript.js' }];
        const batch2 = [{ type: 'SCRIPT_ENTER', iid: 8, seq: 2, file: 'myScript.js' }];

        const events = serializeAndDecode(serializer, [batch1, batch2]);
        const dictEntries = events.filter(e => e.type === 'DICT_ENTRY' && e.str === 'myScript.js');
        assert.equal(dictEntries.length, 1, '相同字符串只应有 1 条 DICT_ENTRY');

        // 两条 SCRIPT_ENTER 的 file 字段都应正确还原
        const scriptEnters = events.filter(e => e.type === 'SCRIPT_ENTER');
        assert.equal(scriptEnters.length, 2, '应有 2 条 SCRIPT_ENTER');
        assert.equal(scriptEnters[0].file, 'myScript.js');
        assert.equal(scriptEnters[1].file, 'myScript.js');
    });

    test('END_EXPR 事件中变量名通过字典压缩后正确还原', () => {
        const serializer = new EventSerializerWithPool();
        const events = serializeAndDecode(serializer, [[
            {
                type: 'END_EXPR', iid: 16, seq: 1,
                writes: [{ name: 'myCounter', val: 42 }],
                reads:  [{ name: 'myCounter', val: 42 }],
                fields: [{ offset: 'myProp', isWrite: false, val: 'hello', baseOid: 7 }],
            },
        ]]);
        const endExprs = events.filter(e => e.type === 'END_EXPR');
        assert.equal(endExprs.length, 1, '应有 1 条 END_EXPR');
        const ev = endExprs[0];
        assert.equal(ev.writes[0].name,      'myCounter', 'writes 变量名应还原');
        assert.equal(ev.writes[0].value,     42,          'writes 值应还原');
        assert.equal(ev.reads[0].name,       'myCounter', 'reads 变量名应还原');
        assert.equal(ev.fields[0].offset,    'myProp',    'fields offset 应还原');
        assert.equal(ev.fields[0].baseOid,   7,           'fields baseOid 应还原');
        assert.equal(ev.fields[0].isWrite,   false,       'fields isWrite 应还原');
    });

    test('多批次高频重复字符串 — 字典不重复增长', () => {
        const serializer = new EventSerializerWithPool();
        const batches = [];
        for (let i = 0; i < 5; i++) {
            batches.push([{
                type: 'END_EXPR', iid: (i + 1) * 8, seq: i + 1,
                writes: [{ name: 'loopCounter', val: i }],
                reads:  [],
                fields: [],
            }]);
        }
        const events = serializeAndDecode(serializer, batches);
        const dictEntries = events.filter(e => e.type === 'DICT_ENTRY' && e.str === 'loopCounter');
        assert.equal(dictEntries.length, 1, 'loopCounter 只应有 1 条 DICT_ENTRY，不管重复多少次');

        const endExprs = events.filter(e => e.type === 'END_EXPR');
        assert.equal(endExprs.length, 5, '应有 5 条 END_EXPR');
        for (let i = 0; i < 5; i++) {
            assert.equal(endExprs[i].writes[0].name,  'loopCounter', `第${i}条变量名应正确`);
            assert.equal(endExprs[i].writes[0].value, i,             `第${i}条值应为 ${i}`);
        }
    });

    test('getStats 正确反映字典大小和 DICT_ENTRY 数量', () => {
        const serializer = new EventSerializerWithPool();
        serializer.serializeBatch([
            { type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'alpha.js' },
        ]);
        serializer.serializeBatch([
            { type: 'SCRIPT_ENTER', iid: 8, seq: 2, file: 'beta.js' },
        ]);
        const stats = serializer.getStats();
        assert.equal(stats.dictSize,    2, '字典应有 2 个唯一字符串');
        assert.equal(stats.dictEntries, 2, '应发出 2 条 DICT_ENTRY 事件');
    });

    test('CALL_PRE 函数名通过字典压缩后正确还原', () => {
        const serializer = new EventSerializerWithPool();
        const events = serializeAndDecode(serializer, [[
            { type: 'CALL_PRE', iid: 8, seq: 1, fn: 'calculateTotal', args: [1, 2], isConstructor: false, isMethod: false },
            { type: 'CALL',     iid: 8, seq: 2, fn: 'calculateTotal', result: 3 },
        ]]);
        const callPre = events.filter(e => e.type === 'CALL_PRE');
        const call    = events.filter(e => e.type === 'CALL');
        assert.equal(callPre.length, 1, '应有 1 条 CALL_PRE');
        assert.equal(call.length,    1, '应有 1 条 CALL');
        assert.equal(callPre[0].fn, 'calculateTotal', 'CALL_PRE fn 应正确还原');
        assert.equal(call[0].fn,    'calculateTotal', 'CALL fn 应正确还原');
        assert.equal(call[0].result, 3, 'CALL result 应正确还原');

        // calculateTotal 只应有 1 条 DICT_ENTRY
        const dictEntries = events.filter(e => e.type === 'DICT_ENTRY' && e.str === 'calculateTotal');
        assert.equal(dictEntries.length, 1, 'calculateTotal 只应有 1 条 DICT_ENTRY');
    });

    test('压缩后 trace 体积比无压缩小（重复字符串场景）', () => {
        // 构造 20 个重复的 END_EXPR 事件（同一变量名 longVariableName）
        const REPEATS = 20;
        const batch = Array.from({ length: REPEATS }, (_, i) => ({
            type: 'END_EXPR', iid: (i + 1) * 8, seq: i + 1,
            writes: [{ name: 'longVariableName', val: i }],
            reads:  [{ name: 'longVariableName', val: i }],
            fields: [],
        }));

        // 无压缩
        const uncompressedBuf = serializeBatch(batch);

        // 有压缩
        const serializer = new EventSerializerWithPool();
        const compressedBufs = serializer.serializeBatch(batch);
        let compressedSize = 0;
        for (const b of compressedBufs) compressedSize += b.byteLength;

        assert.ok(
            compressedSize < uncompressedBuf.byteLength,
            `压缩后（${compressedSize}B）应小于无压缩（${uncompressedBuf.byteLength}B）`
        );
    });

    test('serializeBatch 返回 ArrayBuffer 数组（非单个 ArrayBuffer）', () => {
        const serializer = new EventSerializerWithPool();
        const result = serializer.serializeBatch([
            { type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'test.js' },
        ]);
        assert.ok(Array.isArray(result), '应返回数组');
        assert.ok(result.length > 0,     '数组不应为空');
        for (const buf of result) {
            assert.ok(buf instanceof ArrayBuffer, '数组元素应是 ArrayBuffer');
        }
    });
});
