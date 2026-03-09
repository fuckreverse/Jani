// JALANGI DO NOT INSTRUMENT
/**
 * test/logging.test.mjs — Jalangi2 日志系统集成测试
 *
 * 覆盖：
 *  1. RingBuffer — push/drain/overflow/stats
 *  2. EventSerializer — NDJSON / Binary 序列化往返
 *  3. MemoryBackend — write/flush/close/getEvents
 *  4. LogManager — log/flush/close/多后端/背压/autoFlush
 *  5. NodeStreamBackend — 写文件、背压、writeSync
 *  6. WsBackend + trace-server — 端到端 WebSocket 回路测试
 *
 * 运行：
 *   node --test test/logging.test.mjs
 *   npm run test:logging
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir }      from 'node:os';
import { join }        from 'node:path';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// 被测模块
import { RingBuffer }           from '../src/logger/RingBuffer.js';
import {
    EVENT_TYPE,
    serializeEventToJSON, serializeBatchToNDJSON,
    serializeEventToBinary, serializeBatchToBinary,
    deserializeEventFromBinary, deserializeBatchFromBinary,
} from '../src/logger/EventSerializer.js';
import { MemoryBackend }        from '../src/logger/backends/MemoryBackend.js';
import { LogManager, createMemoryLogManager } from '../src/logger/LogManager.js';
import { NodeStreamBackend }    from '../src/logger/backends/NodeStreamBackend.js';

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
    test('log 事件被路由到后端', async () => {
        const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 2 });
        mgr.log({ type: 'READ',  iid: 8  });
        mgr.log({ type: 'WRITE', iid: 16 });
        await mgr.flush();
        assert.equal(backend.getEvents().length,   2);
        assert.equal(backend.getEvents()[0].type, 'READ');
        await mgr.close();
    });

    test('close 后 log 静默丢弃（不抛出）', async () => {
        const { mgr } = await createMemoryLogManager();
        await mgr.close();
        mgr.log({ type: 'READ', iid: 8 }); // 不应抛出
    });

    test('flush 前 RingBuffer 中的事件不丢失', async () => {
        const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 10000 });
        for (let i = 0; i < 50; i++) mgr.log({ type: 'READ', iid: i * 8 });
        assert.equal(backend.getEvents().length, 0);  // 尚未 flush
        await mgr.flush();
        assert.equal(backend.getEvents().length, 50);
        await mgr.close();
    });

    test('多后端同时接收', async () => {
        const b1 = new MemoryBackend();
        const b2 = new MemoryBackend();
        const mgr = new LogManager({ backends: [b1, b2], autoClose: false });
        mgr.log({ type: 'READ',  iid: 8  });
        mgr.log({ type: 'WRITE', iid: 16 });
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
        mgr.log({ type: 'READ', iid: 8 });
        await mgr.flush();
        assert.equal(b1.getEvents().length, 1);
        assert.equal(b2.getEvents().length, 1);

        mgr.removeBackend(b2);
        mgr.log({ type: 'WRITE', iid: 16 });
        await mgr.flush();
        assert.equal(b1.getEvents().length, 2);
        assert.equal(b2.getEvents().length, 1); // 移除后不再接收
        await mgr.close();
    });

    test('close 时 flush 剩余 RingBuffer', async () => {
        const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 99999 });
        for (let i = 0; i < 20; i++) mgr.log({ type: 'READ', iid: i });
        await mgr.close();
        assert.equal(backend.getEvents().length, 20);
    });

    test('getStats 返回合理数据', async () => {
        const { mgr } = await createMemoryLogManager();
        mgr.log({ type: 'READ',  iid: 8  });
        mgr.log({ type: 'WRITE', iid: 16 });
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
        for (let i = 0; i < 9; i++) mgr.log({ type: 'READ', iid: i * 8 });
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
// 5. NodeStreamBackend
// ════════════════════════════════════════════════════════════════════════════════

describe('NodeStreamBackend', () => {
    test('写入文件并读回（NDJSON 格式）', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            await backend.write([
                { type: 'READ',  iid: 8,  value: 1   },
                { type: 'WRITE', iid: 16, value: 'x' },
            ]);
            await backend.flush();
            await backend.close();

            const lines = readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean);
            assert.equal(lines.length, 2);
            assert.equal(JSON.parse(lines[0]).type, 'READ');
            assert.equal(JSON.parse(lines[1]).type, 'WRITE');
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('多批次追加写入', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            for (let i = 0; i < 5; i++) {
                await backend.write([{ type: 'READ', iid: i * 8, value: i }]);
            }
            await backend.close();

            const lines = readFileSync(outPath, 'utf8').trim().split('\n');
            assert.equal(lines.length, 5);
            for (let i = 0; i < 5; i++) {
                assert.equal(JSON.parse(lines[i]).iid, i * 8);
            }
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('writeSync 在关闭前写入（尽力而为）', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            backend.writeSync([{ type: 'SCRIPT_ENTER', iid: 8 }]);
            await backend.close();
            assert.ok(readFileSync(outPath, 'utf8').includes('SCRIPT_ENTER'));
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('NodeStreamBackend + LogManager 集成', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            const mgr     = new LogManager({ backends: [backend], autoClose: false, flushThreshold: 2 });
            for (let i = 0; i < 10; i++) mgr.log({ type: 'READ', iid: i * 8, value: i });
            await mgr.close();

            const lines = readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean);
            assert.equal(lines.length, 10);
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6. WsBackend + trace-server 端到端回路测试
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 启动一个轻量 WebSocket mock 服务：
 *  - 接收二进制帧：[u32 batchId][rest]，回二进制 ack
 *  - 接收文本帧（NDJSON）：{batchId, events:[...]}，回 JSON ack
 *  - 收集所有 batchId 到 received[]，收集事件到 events[]
 */
function startMockServer(port) {
    const received = [];
    const events   = [];
    const http = createServer();
    const wss  = new WebSocketServer({ server: http });

    wss.on('connection', (ws) => {
        ws.binaryType = 'arraybuffer';
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                // 二进制帧：[u32 batchId][serializeBatchToBinary output]
                const buf     = data instanceof Buffer
                    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                    : data;
                const batchId = new DataView(buf).getUint32(0, true);
                received.push(batchId);
                const ack = new ArrayBuffer(4);
                new DataView(ack).setUint32(0, batchId, true);
                ws.send(ack);
            } else {
                // 文本帧：NDJSON { batchId, events: [...] }
                const msg = JSON.parse(data.toString());
                received.push(msg.batchId);
                for (const ev of (msg.events ?? [])) events.push(ev);
                ws.send(JSON.stringify({ type: 'ack', batchId: msg.batchId }));
            }
        });
    });

    return new Promise((resolve, reject) => {
        http.listen(port, () => {
            resolve({
                received,
                events,
                close: () => new Promise(r => { wss.close(); http.close(r); }),
            });
        });
        http.on('error', reject);
    });
}

const WS_PORT = 19229;

describe('WsBackend + trace-server 端到端回路', () => {
    test('WsBackend 成功连接并发送批次，收到 ack', async () => {
        const server = await startMockServer(WS_PORT);
        try {
            const { WsBackend } = await import('../src/logger/backends/WsBackend.js');
            const backend = new WsBackend({
                url:         `ws://127.0.0.1:${WS_PORT}`,
                format:      'binary',
                autoConnect: true,
                windowSize:  4,
            });

            await new Promise(r => setTimeout(r, 200));
            await backend.write([{ type: 'READ',  iid: 8,  value: 1 }]);
            await backend.write([{ type: 'WRITE', iid: 16, value: 2 }]);
            await backend.flush();
            await backend.close();

            assert.equal(server.received.length, 2, `期望收到 2 批，实际 ${server.received.length}`);
            assert.equal(server.received[0], 1);
            assert.equal(server.received[1], 2);
        } finally {
            await server.close();
        }
    });

    test('WsBackend + LogManager 端到端：9 条事件分 3 批到达', async () => {
        const server = await startMockServer(WS_PORT + 1);
        try {
            const { WsBackend } = await import('../src/logger/backends/WsBackend.js');
            const backend = new WsBackend({
                url:         `ws://127.0.0.1:${WS_PORT + 1}`,
                format:      'binary',
                autoConnect: true,
                windowSize:  2,   // 故意小，测试背压
            });

            await new Promise(r => setTimeout(r, 200));

            const mgr = new LogManager({
                backends:       [backend],
                flushThreshold: 3,
                drainBatchSize: 3,
                autoClose:      false,
            });
            for (let i = 0; i < 9; i++) mgr.log({ type: 'READ', iid: i * 8, value: i });
            await mgr.close();

            // 9 条事件，每批 3 条 → 3 批
            assert.equal(server.received.length, 3, `期望 3 批，实际 ${server.received.length}`);
        } finally {
            await server.close();
        }
    });

    // ExecutionTrace 使用 ndjson 格式（{type:'trace', seq, text} 无法用二进制编码）
    test('WsBackend ndjson 格式：文本帧正确发送和 ack，字段完整保留', async () => {
        const server = await startMockServer(WS_PORT + 2);
        try {
            const { WsBackend } = await import('../src/logger/backends/WsBackend.js');
            const backend = new WsBackend({
                url:         `ws://127.0.0.1:${WS_PORT + 2}`,
                format:      'ndjson',   // ExecutionTrace 实际使用的格式
                autoConnect: true,
                windowSize:  4,
            });

            await new Promise(r => setTimeout(r, 200));

            // 模拟 ExecutionTrace 写入的事件（type 不在 EVENT_TYPE 枚举里）
            const traceBatch = [
                { type: 'trace', seq: 1, text: '[  1] [1:1] CALL foo(0 args)' },
                { type: 'trace', seq: 2, text: '[  2] [2:3] x=42' },
                { type: 'key',   level: 'info', text: '▶ script: test.js' },
            ];
            await backend.write(traceBatch);
            await backend.flush();
            await backend.close();

            assert.equal(server.received.length, 1, `期望 1 批，实际 ${server.received.length}`);
            assert.equal(server.events.length, 3, `期望 3 条事件，实际 ${server.events.length}`);
            // 验证字段完整（ndjson 不会丢失 seq/text/level）
            assert.equal(server.events[0].type,  'trace');
            assert.equal(server.events[0].seq,   1);
            assert.equal(server.events[0].text,  '[  1] [1:1] CALL foo(0 args)');
            assert.equal(server.events[2].type,  'key');
            assert.equal(server.events[2].level, 'info');
        } finally {
            await server.close();
        }
    });
});
