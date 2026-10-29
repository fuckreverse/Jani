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
    EVENT_TYPE, VALUE_TYPE, FORMAT_VERSION,
    serializeEvent, serializeBatch, deserializeEvent, deserializeAll,
    createFileHeader, isBinaryTrace, FILE_HEADER_SIZE,
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
        assert.equal(bytes[4], FORMAT_VERSION); // version (当前为 0x02, v2 支持 write.oid)
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

    // ── VALUE_TYPE.TYPED_ARRAY (0x0B) 编解码测试 ──────────────────────────────

    test('VALUE_TYPE 枚举含 TYPED_ARRAY = 0x0B', () => {
        assert.equal(VALUE_TYPE.TYPED_ARRAY, 0x0B);
    });

    test('TYPED_ARRAY：Uint8Array 编解码往返', () => {
        const arr = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 1, 2, 3, 4]);
        const ev = {
            type: 'END_EXPR', iid: 48, seq: 10,
            writes: [{ name: 'buf', val: arr, omit: false }],
            reads:  [],
            fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        assert.equal(event.writes.length, 1);
        assert.equal(event.writes[0].name, 'buf');
        // 解码结果应包含类型名、元素数和字节数
        const decoded = event.writes[0].value;
        assert.ok(typeof decoded === 'string', '解码值应为字符串');
        assert.ok(decoded.startsWith('[Uint8Array(8):8B:'), `应包含类型和大小：${decoded}`);
        // hex 摘要：deadbeef01020304
        assert.ok(decoded.includes('deadbeef01020304'), `应包含 hex 摘要：${decoded}`);
    });

    test('TYPED_ARRAY：Float64Array 编解码往返', () => {
        const arr = new Float64Array([3.14, 2.71]);
        const ev = {
            type: 'END_EXPR', iid: 56, seq: 11,
            writes: [{ name: 'floats', val: arr, omit: false }],
            reads:  [], fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        const decoded = event.writes[0].value;
        assert.ok(decoded.startsWith('[Float64Array(2):16B:'), `类型名应为 Float64Array：${decoded}`);
    });

    test('TYPED_ARRAY：ArrayBuffer 编解码往返', () => {
        const ab = new ArrayBuffer(6);
        new Uint8Array(ab).set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
        const ev = {
            type: 'END_EXPR', iid: 64, seq: 12,
            writes: [{ name: 'rawBuf', val: ab, omit: false }],
            reads:  [], fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        const decoded = event.writes[0].value;
        assert.ok(decoded.startsWith('[ArrayBuffer(0):6B:'), `ArrayBuffer 应无元素数：${decoded}`);
        assert.ok(decoded.includes('010203040506'), `hex 摘要应正确：${decoded}`);
    });

    test('TYPED_ARRAY：空 TypedArray 编解码', () => {
        const arr = new Int32Array(0);
        const ev = {
            type: 'END_EXPR', iid: 72, seq: 13,
            writes: [{ name: 'empty', val: arr, omit: false }],
            reads:  [], fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        const decoded = event.writes[0].value;
        assert.ok(decoded.startsWith('[Int32Array(0):0B:'), `空数组应为 0 元素 0 字节：${decoded}`);
    });

    test('TYPED_ARRAY：超过 64 字节时 hex 摘要截断到前 128 字符', () => {
        // 128 字节的 Uint8Array，hex 摘要只取前 64 字节 = 128 个 hex 字符
        const arr = new Uint8Array(128).fill(0xAB);
        const ev = {
            type: 'END_EXPR', iid: 80, seq: 14,
            writes: [{ name: 'big', val: arr, omit: false }],
            reads:  [], fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        const decoded = event.writes[0].value;
        // 格式：[Uint8Array(128):128B:abab...（128个hex字符）]
        assert.ok(decoded.startsWith('[Uint8Array(128):128B:'), `大数组应含正确元数据：${decoded}`);
        // hex 摘要 = 前 64 字节 × 2 字符/字节 = 128 字符
        const hexPart = decoded.slice(decoded.indexOf(':', decoded.indexOf(':') + 1) + 1).replace(']', '');
        // 第三个冒号之后的 hex 字符串长度应为 128
        const parts = decoded.slice(1, -1).split(':');  // 去掉 [ 和 ]
        // parts = ['Uint8Array(128)', '128B', 'abab...']
        assert.equal(parts[2].length, 128, `hex 摘要应恰好 128 字符，实际：${parts[2].length}`);
        assert.ok(parts[2] === 'ab'.repeat(64), `hex 摘要应为 64 个 ab：${parts[2].slice(0, 10)}...`);
    });

    test('TYPED_ARRAY：DataView 不被识别为 TypedArray（走 OBJECT 路径）', () => {
        // DataView 不应触发 TYPED_ARRAY 编码，应 fallback 到 OBJECT (JSON)
        const dv = new DataView(new ArrayBuffer(4));
        const ev = {
            type: 'END_EXPR', iid: 88, seq: 15,
            writes: [{ name: 'dv', val: dv, omit: false }],
            reads:  [], fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        const decoded = event.writes[0].value;
        // DataView 走 OBJECT 路径，序列化后不含 TypedArray 格式
        assert.ok(!decoded?.startsWith?.('[DataView'), `DataView 不应走 TYPED_ARRAY 路径：${decoded}`);
    });

    test('TYPED_ARRAY：与其他值类型混合的批次往返', () => {
        const arr = new Uint32Array([100, 200, 300]);
        const ev = {
            type: 'END_EXPR', iid: 96, seq: 16,
            writes: [
                { name: 'num',   val: 42,   omit: false },
                { name: 'typed', val: arr,  omit: false },
                { name: 'str',   val: 'hi', omit: false },
            ],
            reads:  [],
            fields: [],
        };
        const buf = serializeEvent(ev);
        const { event } = deserializeEvent(new DataView(buf), 0);
        assert.equal(event.writes[0].value, 42,  '数字值应正确');
        assert.ok(event.writes[1].value.startsWith('[Uint32Array(3):12B:'), 'TypedArray 值应正确');
        assert.equal(event.writes[2].value, 'hi', '字符串值应正确');
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
        const keyEvent = events.find(e => e.type === 'KEY_EVENT');
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
        const levels = events.filter(e => e.type === 'KEY_EVENT').map(e => e.level);
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
        const keyEvents   = events.filter(e => e.type === 'KEY_EVENT');

        assert.ok(traceEvents.length > 0, '应有 trace 类型事件');
        assert.ok(keyEvents.length > 0, '应有 key 类型事件');
        assert.equal(keyEvents[0].level, 'warn', 'key 事件应保留级别');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// （字典压缩相关测试已删除，usePool/StringPool/EventSerializerWithPool 已移除）
// ════════════════════════════════════════════════════════════════════════════════

// END OF FILE

describe('Trace integrity regressions', () => {
    test('finite ring capacity rejects newest without corrupting unread events', () => {
        const rb = new RingBuffer({ capacity: 2, maxCapacity: 2 });
        assert.equal(rb.push(1), true); assert.equal(rb.push(2), true);
        assert.equal(rb.push(3), false);
        assert.deepEqual(rb.drain(), [1, 2]);
        assert.equal(rb.getStats().totalDropped, 1);
        assert.equal(rb.push(4), true); assert.deepEqual(rb.drain(), [4]);
    });
    test('v4 identities roundtrip through an offset DataView', () => {
        const source = { type: 'END_EXPR', seq: 2, callId: 17, contextId: 23, scriptId: 1,
            writes: [{ name: 'x', val: 'hello', scopeId: 4, bindingId: '1:4:17' }] };
        const encoded = new Uint8Array(serializeEvent(source));
        const bytes = new Uint8Array(encoded.length + 9); bytes.set(encoded, 9);
        const { event } = deserializeEvent(new DataView(bytes.buffer, 9), 0);
        assert.equal(event.writes[0].value, 'hello');
        assert.equal(event.writes[0].bindingId, '1:4:17'); assert.equal(event.contextId, 23);
    });
    test('truncated records and count overflow are rejected', () => {
        const bytes = serializeEvent({ type: 'CALL', seq: 1, fn: 'test', result: 1 });
        assert.throws(() => deserializeEvent(new DataView(bytes.slice(0, -1)), 0), /Truncated/);
        assert.throws(() => serializeEvent({type:'END_EXPR',writes:Array.from({length:256},()=>({name:'x',val:1}))}), /Too many/);
    });
    test('legacy v3 record remains readable', () => {
        const bytes = new ArrayBuffer(12);
        const view = new DataView(bytes); view.setUint8(0, EVENT_TYPE.SCRIPT_EXIT); view.setUint32(6, 1, true);
        assert.equal(deserializeEvent(view, 0, 3).event.type, 'SCRIPT_EXIT');
    });
});

describe('Async logging delivery', () => {
    test('flush waits for in-flight writes and preserves batch ordering', async () => {
        const delivered=[]; let release;
        const gate=new Promise(resolve=>{release=resolve;});
        const manager=new LogManager({autoClose:false,drainBatchSize:1,flushThreshold:1,
            backends:[{async write(batch){if(batch[0]===1) await gate;delivered.push(...batch);}}]});
        manager.push(1); const first=manager._doFlush();
        manager.push(2); let finished=false; const flushed=manager.flush().then(()=>{finished=true;});
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(finished,false); release(); await first; await flushed;
        assert.deepEqual(delivered,[1,2]); await manager.close();
    });
    test('explicit flush surfaces backend failure without throwing from program hooks', async () => {
        const manager=new LogManager({autoClose:false,backends:[{async write(){throw new Error('disk unavailable');}}]});
        assert.doesNotThrow(()=>manager.push({seq:1}));
        await assert.rejects(manager.flush(),/disk unavailable/);
        await assert.rejects(manager.close(),/disk unavailable/);
    });
});
