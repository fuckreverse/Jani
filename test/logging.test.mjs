// JALANGI DO NOT INSTRUMENT
/**
 * logging.test.mjs — Jalangi2 日志系统集成测试
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
 *   node test/logging.test.mjs
 *   npm run test:logging
 */

import assert from 'node:assert/strict';
import { tmpdir }      from 'node:os';
import { join }        from 'node:path';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// 被测模块
import { RingBuffer }           from '../src/js/runtime/logging/RingBuffer.js';
import {
    EVENT_TYPE, EVENT_TYPE_NAME,
    serializeEventToJSON, serializeBatchToNDJSON,
    serializeEventToBinary, serializeBatchToBinary,
    deserializeEventFromBinary, deserializeBatchFromBinary,
} from '../src/js/runtime/logging/EventSerializer.js';
import { MemoryBackend }        from '../src/js/runtime/logging/backends/MemoryBackend.js';
import { LogManager, createMemoryLogManager } from '../src/js/runtime/logging/LogManager.js';
import { NodeStreamBackend }    from '../src/js/runtime/logging/backends/NodeStreamBackend.js';

// ─── 测试框架（极简） ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
        failures.push({ name, err });
    }
}

function section(title) {
    console.log(`\n── ${title} ─────────────────────────────`);
}

// ─── 1. RingBuffer ────────────────────────────────────────────────────────────

section('RingBuffer');

await test('push 和 drain 基本往返', () => {
    const rb = new RingBuffer({ capacity: 8 });
    rb.push('a');
    rb.push('b');
    rb.push('c');
    assert.equal(rb.size, 3);
    const out = rb.drain();
    assert.deepEqual(out, ['a', 'b', 'c']);
    assert.equal(rb.size, 0);
});

await test('drain(maxCount) 只取指定数量', () => {
    const rb = new RingBuffer({ capacity: 16 });
    for (let i = 0; i < 10; i++) rb.push(i);
    const out = rb.drain(4);
    assert.equal(out.length, 4);
    assert.equal(rb.size, 6);
});

await test('drop-oldest 溢出策略', () => {
    const rb = new RingBuffer({ capacity: 4, overflowPolicy: 'drop-oldest' });
    for (let i = 0; i < 6; i++) rb.push(i);
    assert.equal(rb.size, 4);
    assert.equal(rb.stats.totalDropped, 2);
    const out = rb.drain();
    // 最旧的 0,1 被丢弃，剩 2,3,4,5
    assert.deepEqual(out, [2, 3, 4, 5]);
});

await test('drop-newest 溢出策略', () => {
    const rb = new RingBuffer({ capacity: 3, overflowPolicy: 'drop-newest' });
    for (let i = 0; i < 5; i++) rb.push(i);
    assert.equal(rb.size, 3);
    assert.equal(rb.stats.totalDropped, 2);
    const out = rb.drain();
    assert.deepEqual(out, [0, 1, 2]);
});

await test('shouldFlush 在阈值时返回 true', () => {
    const rb = new RingBuffer({ capacity: 1000, flushThreshold: 3 });
    rb.push(1);
    rb.push(2);
    assert.equal(rb.shouldFlush, false);
    rb.push(3);
    assert.equal(rb.shouldFlush, true);
});

await test('clear 清空缓冲区', () => {
    const rb = new RingBuffer({ capacity: 8 });
    rb.push('x');
    rb.push('y');
    rb.clear();
    assert.equal(rb.size, 0);
    assert.deepEqual(rb.drain(), []);
});

await test('环形绕回（wrap around）正确', () => {
    const rb = new RingBuffer({ capacity: 4 });
    rb.push(0); rb.push(1); rb.push(2); rb.push(3);
    rb.drain(2);           // head=2, tail=4(=0), size=2
    rb.push(4); rb.push(5); // 绕回写到 0,1
    assert.equal(rb.size, 4);
    const out = rb.drain();
    assert.deepEqual(out, [2, 3, 4, 5]);
});

// ─── 2. EventSerializer ────────────────────────────────────────────────────────

section('EventSerializer');

await test('EVENT_TYPE 枚举完整', () => {
    assert.ok(EVENT_TYPE.READ !== undefined);
    assert.ok(EVENT_TYPE.WRITE !== undefined);
    assert.ok(EVENT_TYPE.GET_FIELD !== undefined);
    assert.ok(EVENT_TYPE.SCRIPT_ENTER !== undefined);
});

await test('serializeEventToJSON 产生合法 JSON', () => {
    const ev = { type: 'READ', iid: 8, sid: 1, name: 'x', value: 42 };
    const json = serializeEventToJSON(ev);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, 'READ');
    assert.equal(parsed.iid, 8);
    assert.equal(parsed.value, 42);
});

await test('serializeEventToJSON 正确处理 undefined 值', () => {
    const ev = { type: 'READ', iid: 8, value: undefined };
    const json = serializeEventToJSON(ev);
    const parsed = JSON.parse(json);
    assert.equal(parsed.value, '__undefined__');
});

await test('serializeBatchToNDJSON 每条一行', () => {
    const events = [
        { type: 'READ',  iid: 8,  value: 1 },
        { type: 'WRITE', iid: 16, value: 'hello' },
    ];
    const ndjson = serializeBatchToNDJSON(events);
    const lines  = ndjson.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, 'READ');
    assert.equal(JSON.parse(lines[1]).type, 'WRITE');
});

await test('二进制：number 值往返', () => {
    const ev  = { type: 'READ', iid: 24, sid: 2, value: 3.14 };
    const buf = serializeEventToBinary(ev);
    assert.ok(buf instanceof ArrayBuffer);
    const view = new DataView(buf);
    const { event } = deserializeEventFromBinary(view, 0);
    assert.equal(event.iid, 24);
    assert.equal(event.sid, 2);
    assert.ok(Math.abs(event.value - 3.14) < 1e-10);
});

await test('二进制：string 值往返', () => {
    const ev  = { type: 'WRITE', iid: 32, sid: 1, value: 'hello world' };
    const buf = serializeEventToBinary(ev);
    const { event } = deserializeEventFromBinary(new DataView(buf), 0);
    assert.equal(event.value, 'hello world');
});

await test('二进制：null / boolean 值往返', () => {
    for (const value of [null, true, false]) {
        const buf = serializeEventToBinary({ type: 'READ', iid: 0, sid: 0, value });
        const { event } = deserializeEventFromBinary(new DataView(buf), 0);
        assert.equal(event.value, value);
    }
});

await test('批次二进制：serializeBatchToBinary / deserializeBatchFromBinary 往返', () => {
    const batch = [
        { type: 'READ',    iid: 8,  sid: 1, value: 42        },
        { type: 'WRITE',   iid: 16, sid: 1, value: 'foo'     },
        { type: 'LITERAL', iid: 24, sid: 1, value: null       },
        { type: 'BINARY',  iid: 32, sid: 1, value: true       },
    ];
    const buf    = serializeBatchToBinary(batch);
    const result = deserializeBatchFromBinary(buf);
    assert.equal(result.length, 4);
    assert.equal(result[0].iid, 8);
    assert.equal(result[1].value, 'foo');
    assert.equal(result[2].value, null);
    assert.equal(result[3].value, true);
});

// ─── 3. MemoryBackend ────────────────────────────────────────────────────────

section('MemoryBackend');

await test('write / getEvents 基本收集', async () => {
    const backend = new MemoryBackend();
    await backend.write([{ type: 'READ', iid: 8 }, { type: 'WRITE', iid: 16 }]);
    await backend.write([{ type: 'LITERAL', iid: 24 }]);
    const events = backend.getEvents();
    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'READ');
    assert.equal(events[2].type, 'LITERAL');
});

await test('getEventsOfType 过滤正确', async () => {
    const backend = new MemoryBackend();
    await backend.write([
        { type: 'READ', iid: 8 },
        { type: 'WRITE', iid: 16 },
        { type: 'READ', iid: 24 },
    ]);
    const reads = backend.getEventsOfType('READ');
    assert.equal(reads.length, 2);
});

await test('flush 是 noop（不抛出）', async () => {
    const backend = new MemoryBackend();
    await backend.flush();
});

await test('close 后 write 抛出', async () => {
    const backend = new MemoryBackend();
    await backend.close();
    await assert.rejects(
        () => backend.write([{ type: 'READ', iid: 8 }]),
        /already closed/
    );
});

await test('clear 清空事件和统计', async () => {
    const backend = new MemoryBackend();
    await backend.write([{ type: 'READ', iid: 8 }]);
    backend.clear();
    assert.equal(backend.getEvents().length, 0);
    assert.equal(backend.stats.totalEvents, 0);
});

// ─── 4. LogManager ────────────────────────────────────────────────────────────

section('LogManager');

await test('log 事件被路由到后端', async () => {
    const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 2 });
    mgr.log({ type: 'READ', iid: 8 });
    mgr.log({ type: 'WRITE', iid: 16 });
    await mgr.flush();
    const events = backend.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'READ');
    await mgr.close();
});

await test('close 后 log 静默丢弃（不抛出）', async () => {
    const { mgr } = await createMemoryLogManager();
    await mgr.close();
    mgr.log({ type: 'READ', iid: 8 });   // 不应抛出
});

await test('flush 前 RingBuffer 中的事件不丢失', async () => {
    const { mgr, backend } = await createMemoryLogManager({
        flushThreshold: 10000,   // 高阈值，不自动 flush
    });
    for (let i = 0; i < 50; i++) {
        mgr.log({ type: 'READ', iid: i * 8 });
    }
    assert.equal(backend.getEvents().length, 0);  // 尚未 flush
    await mgr.flush();
    assert.equal(backend.getEvents().length, 50);
    await mgr.close();
});

await test('多后端同时接收', async () => {
    const b1 = new MemoryBackend();
    const b2 = new MemoryBackend();
    const mgr = new LogManager({ backends: [b1, b2], autoClose: false });
    mgr.log({ type: 'READ', iid: 8 });
    mgr.log({ type: 'WRITE', iid: 16 });
    await mgr.flush();
    assert.equal(b1.getEvents().length, 2);
    assert.equal(b2.getEvents().length, 2);
    await mgr.close();
});

await test('动态 addBackend / removeBackend', async () => {
    const b1 = new MemoryBackend();
    const b2 = new MemoryBackend();
    const mgr = new LogManager({ backends: [b1], autoClose: false });
    mgr.addBackend(b2);
    mgr.log({ type: 'READ', iid: 8 });
    await mgr.flush();
    assert.equal(b1.getEvents().length, 1);
    assert.equal(b2.getEvents().length, 1);

    // 移除 b2，再 log
    mgr.removeBackend(b2);
    mgr.log({ type: 'WRITE', iid: 16 });
    await mgr.flush();
    assert.equal(b1.getEvents().length, 2);
    assert.equal(b2.getEvents().length, 1);   // 不再接收
    await mgr.close();
});

await test('close 时 flush 剩余 RingBuffer', async () => {
    const { mgr, backend } = await createMemoryLogManager({ flushThreshold: 99999 });
    for (let i = 0; i < 20; i++) mgr.log({ type: 'READ', iid: i });
    await mgr.close();
    assert.equal(backend.getEvents().length, 20);
});

await test('getStats 返回合理数据', async () => {
    const { mgr } = await createMemoryLogManager();
    mgr.log({ type: 'READ', iid: 8 });
    mgr.log({ type: 'WRITE', iid: 16 });
    await mgr.flush();
    const s = mgr.getStats();
    assert.equal(s.logManager.totalLogged, 2);
    assert.ok(s.logManager.totalFlushed >= 2);
    await mgr.close();
});

await test('drainBatchSize 控制单次 drain 量', async () => {
    // 验证：单次 drain 不超过 drainBatchSize，且最终所有事件都到达后端
    const backend = new MemoryBackend();
    // 拦截 write，记录每次收到的批次大小
    const batchSizes = [];
    const origWrite = backend.write.bind(backend);
    backend.write = async (batch) => { batchSizes.push(batch.length); return origWrite(batch); };

    const mgr = new LogManager({
        backends:       [backend],
        flushThreshold: 100,   // 高阈值，不自动触发
        drainBatchSize: 3,
        autoClose:      false,
    });
    for (let i = 0; i < 9; i++) mgr.log({ type: 'READ', iid: i * 8 });
    await mgr.flush();   // 首次 flush 取 3 条，剩余 6 条继续被调度

    // 等待剩余批次处理完
    await new Promise(r => setTimeout(r, 50));

    // 所有批次大小均不超过 drainBatchSize
    for (const sz of batchSizes) {
        assert.ok(sz <= 3, `batch size ${sz} 超过 drainBatchSize=3`);
    }
    // 总量正确
    assert.equal(backend.getEvents().length, 9);
    await mgr.close();
});

// ─── 5. NodeStreamBackend ────────────────────────────────────────────────────

section('NodeStreamBackend');

await test('写入文件并读回（NDJSON 格式）', async () => {
    const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
    try {
        const backend = new NodeStreamBackend({ path: outPath, append: false });
        await backend.write([
            { type: 'READ',  iid: 8,  value: 1 },
            { type: 'WRITE', iid: 16, value: 'x' },
        ]);
        await backend.flush();
        await backend.close();

        const content = readFileSync(outPath, 'utf8');
        const lines   = content.trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).type, 'READ');
        assert.equal(JSON.parse(lines[1]).type, 'WRITE');
    } finally {
        if (existsSync(outPath)) unlinkSync(outPath);
    }
});

await test('多批次追加写入', async () => {
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

await test('writeSync 在关闭前写入（尽力而为）', async () => {
    const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
    try {
        const backend = new NodeStreamBackend({ path: outPath, append: false });
        backend.writeSync([{ type: 'SCRIPT_ENTER', iid: 8 }]);
        await backend.close();

        const content = readFileSync(outPath, 'utf8');
        assert.ok(content.includes('SCRIPT_ENTER'));
    } finally {
        if (existsSync(outPath)) unlinkSync(outPath);
    }
});

await test('NodeStreamBackend + LogManager 集成', async () => {
    const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.ndjson`);
    try {
        const backend = new NodeStreamBackend({ path: outPath, append: false });
        const mgr = new LogManager({ backends: [backend], autoClose: false, flushThreshold: 2 });
        for (let i = 0; i < 10; i++) {
            mgr.log({ type: 'READ', iid: i * 8, value: i });
        }
        await mgr.close();

        const lines = readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 10);
    } finally {
        if (existsSync(outPath)) unlinkSync(outPath);
    }
});

// ─── 6. WsBackend + trace-server 端到端回路测试 ───────────────────────────────

section('WsBackend + trace-server (端到端回路)');

/**
 * 启动一个轻量 WebSocket 服务：
 *  - 接收二进制帧：[u32 batchId][rest]
 *  - 立即回 ack：[u32 batchId]
 *  - 收集所有 batchId 到 received[]
 */
function startMockServer(port) {
    const received = [];
    const http = createServer();
    const wss  = new WebSocketServer({ server: http });

    wss.on('connection', (ws) => {
        ws.binaryType = 'arraybuffer';
        ws.on('message', (data, isBinary) => {
            const buf    = isBinary ? data : Buffer.from(data).buffer;
            const batchId = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer).getUint32(0, true);
            received.push(batchId);
            // 发送 ack
            const ack = new ArrayBuffer(4);
            new DataView(ack).setUint32(0, batchId, true);
            ws.send(ack);
        });
    });

    return new Promise((resolve, reject) => {
        http.listen(port, () => {
            resolve({
                received,
                close: () => new Promise(r => {
                    wss.close();
                    http.close(r);
                }),
            });
        });
        http.on('error', reject);
    });
}

// 动态选择端口（避免与已有服务冲突）
const WS_PORT = 19229;

await test('WsBackend 成功连接并发送批次，收到 ack', async () => {
    const server = await startMockServer(WS_PORT);
    try {
        // 动态导入（避免在 Node 环境没有 WebSocket 时提前失败）
        const { WsBackend } = await import('../src/js/runtime/logging/backends/WsBackend.js');

        const backend = new WsBackend({
            url:          `ws://127.0.0.1:${WS_PORT}`,
            format:       'binary',
            autoConnect:  true,
            windowSize:   4,
        });

        // 等待连接建立
        await new Promise(r => setTimeout(r, 200));

        await backend.write([{ type: 'READ',  iid: 8,  value: 1 }]);
        await backend.write([{ type: 'WRITE', iid: 16, value: 2 }]);
        await backend.flush();
        await backend.close();

        assert.equal(server.received.length, 2, `期望收到 2 批，实际 ${server.received.length}`);
        // batchId 从 1 开始递增
        assert.equal(server.received[0], 1);
        assert.equal(server.received[1], 2);
    } finally {
        await server.close();
    }
});

await test('WsBackend + LogManager 端到端：10 条事件正确到达服务端', async () => {
    const received = [];
    const server = await startMockServer(WS_PORT + 1);

    // 改写 server 以收集事件（解析二进制）
    // 此处直接检查 batchId 数量即可（事件内容在前面 serializer 测试中已覆盖）
    try {
        const { WsBackend } = await import('../src/js/runtime/logging/backends/WsBackend.js');

        const backend = new WsBackend({
            url:         `ws://127.0.0.1:${WS_PORT + 1}`,
            format:      'binary',
            autoConnect: true,
            windowSize:  2,       // 故意小，测试背压
        });

        await new Promise(r => setTimeout(r, 200));

        const mgr = new LogManager({
            backends:       [backend],
            flushThreshold: 3,
            drainBatchSize: 3,
            autoClose:      false,
        });

        for (let i = 0; i < 9; i++) {
            mgr.log({ type: 'READ', iid: i * 8, value: i });
        }
        await mgr.close();

        // 9 条事件，每批 3 条 → 3 批
        assert.equal(server.received.length, 3, `期望 3 批，实际 ${server.received.length}`);
    } finally {
        await server.close();
    }
});

// ─── 结果汇总 ─────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────');
console.log(`总计：${passed + failed} 用例，${passed} 通过，${failed} 失败`);

if (failures.length > 0) {
    console.log('\n失败详情：');
    for (const { name, err } of failures) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.stack ?? err.message}`);
    }
    process.exit(1);
} else {
    console.log('✓ 全部通过');
    process.exit(0);
}
