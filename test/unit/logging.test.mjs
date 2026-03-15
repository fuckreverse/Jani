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
