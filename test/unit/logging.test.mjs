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
    serializeEventToJSON, serializeBatchToNDJSON,
    serializeEventToBinary, serializeBatchToBinary,
    deserializeEventFromBinary, deserializeBatchFromBinary,
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
        assert.ok(EVENT_TYPE.READ        !== undefined);
        assert.ok(EVENT_TYPE.WRITE       !== undefined);
        assert.ok(EVENT_TYPE.GET_FIELD   !== undefined);
        assert.ok(EVENT_TYPE.SCRIPT_ENTER !== undefined);
    });

    test('serializeEventToJSON 产生合法 JSON', () => {
        const json   = serializeEventToJSON({ type: 'READ', iid: 8, sid: 1, name: 'x', value: 42 });
        const parsed = JSON.parse(json);
        assert.equal(parsed.type,  'READ');
        assert.equal(parsed.iid,   8);
        assert.equal(parsed.value, 42);
    });

    test('serializeEventToJSON 正确处理 undefined 值', () => {
        const parsed = JSON.parse(serializeEventToJSON({ type: 'READ', iid: 8, value: undefined }));
        assert.equal(parsed.value, '__undefined__');
    });

    test('serializeBatchToNDJSON 每条一行', () => {
        const ndjson = serializeBatchToNDJSON([
            { type: 'READ',  iid: 8,  value: 1 },
            { type: 'WRITE', iid: 16, value: 'hello' },
        ]);
        const lines = ndjson.trim().split('\n');
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).type, 'READ');
        assert.equal(JSON.parse(lines[1]).type, 'WRITE');
    });

    test('二进制：number 值往返', () => {
        const buf = serializeEventToBinary({ type: 'READ', iid: 24, sid: 2, value: 3.14 });
        assert.ok(buf instanceof ArrayBuffer);
        const { event } = deserializeEventFromBinary(new DataView(buf), 0);
        assert.equal(event.iid, 24);
        assert.equal(event.sid, 2);
        assert.ok(Math.abs(event.value - 3.14) < 1e-10);
    });

    test('二进制：string 值往返', () => {
        const buf = serializeEventToBinary({ type: 'WRITE', iid: 32, sid: 1, value: 'hello world' });
        const { event } = deserializeEventFromBinary(new DataView(buf), 0);
        assert.equal(event.value, 'hello world');
    });

    test('二进制：null / boolean 值往返', () => {
        for (const value of [null, true, false]) {
            const buf = serializeEventToBinary({ type: 'READ', iid: 0, sid: 0, value });
            const { event } = deserializeEventFromBinary(new DataView(buf), 0);
            assert.equal(event.value, value);
        }
    });

    test('批次二进制：serializeBatchToBinary / deserializeBatchFromBinary 往返', () => {
        const batch = [
            { type: 'READ',    iid: 8,  sid: 1, value: 42    },
            { type: 'WRITE',   iid: 16, sid: 1, value: 'foo' },
            { type: 'LITERAL', iid: 24, sid: 1, value: null  },
            { type: 'BINARY',  iid: 32, sid: 1, value: true  },
        ];
        const result = deserializeBatchFromBinary(serializeBatchToBinary(batch));
        assert.equal(result.length,    4);
        assert.equal(result[0].iid,    8);
        assert.equal(result[1].value,  'foo');
        assert.equal(result[2].value,  null);
        assert.equal(result[3].value,  true);
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
