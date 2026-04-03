// JALANGI DO NOT INSTRUMENT
/**
 * test/integration/logging.test.mjs — 日志系统集成测试（含真实 IO）
 *
 * 覆盖：
 *  1. NodeStreamBackend — 写文件、背压、writeSync、与 LogManager 集成
 *  2. WsBackend + mock trace-server — 端到端 WebSocket 回路测试
 *
 * 运行：
 *   node --test test/integration/logging.test.mjs
 *   npm run test:integration
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir }      from 'node:os';
import { join }        from 'node:path';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// 被测模块
import { LogManager }        from '../../src/logger/LogManager.js';
import { NodeStreamBackend } from '../../src/logger/transport/NodeStreamBackend.js';
import {
    deserializeAll, isBinaryTrace, MAGIC, FILE_HEADER_SIZE,
} from '../../src/encoding/EventSerializer.js';

// ════════════════════════════════════════════════════════════════════════════════
// 1. NodeStreamBackend
// ════════════════════════════════════════════════════════════════════════════════

describe('NodeStreamBackend', () => {
    test('写入文件并读回（JTB1 二进制格式）', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.bin`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            await backend.write([
                { type: 'SCRIPT_ENTER', iid: 8,  seq: 1, file: 'a.js' },
                { type: 'SCRIPT_EXIT',  iid: 16, seq: 2 },
            ]);
            await backend.flush();
            await backend.close();

            const buf = readFileSync(outPath);
            // 文件头应以 JTB1 魔数开头
            assert.ok(isBinaryTrace(buf), '文件应以 JTB1 魔数开头');
            // 反序列化所有事件
            const events = deserializeAll(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            assert.equal(events.length, 2, `期望 2 条事件，实际 ${events.length}`);
            assert.equal(events[0].type, 'SCRIPT_ENTER');
            assert.equal(events[1].type, 'SCRIPT_EXIT');
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('多批次写入', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.bin`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            for (let i = 0; i < 5; i++) {
                await backend.write([{ type: 'END_EXPR', iid: (i + 1) * 8, seq: i + 1, writes: [], reads: [], fields: [] }]);
            }
            await backend.close();

            const buf = readFileSync(outPath);
            assert.ok(isBinaryTrace(buf), '文件应以 JTB1 魔数开头');
            const events = deserializeAll(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            assert.equal(events.length, 5, `期望 5 条事件，实际 ${events.length}`);
            for (let i = 0; i < 5; i++) {
                assert.equal(events[i].iid, (i + 1) * 8, `第 ${i} 条 iid 不匹配`);
            }
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('writeSync 在关闭前写入（尽力而为）', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.bin`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            backend.writeSync([{ type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'sync.js' }]);
            await backend.close();

            const buf = readFileSync(outPath);
            assert.ok(isBinaryTrace(buf), '文件应以 JTB1 魔数开头');
            const events = deserializeAll(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            assert.ok(events.length >= 1, 'writeSync 写入的事件应能读回');
            assert.equal(events[0].type, 'SCRIPT_ENTER');
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('NodeStreamBackend + LogManager 集成', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.bin`);
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            const mgr     = new LogManager({ backends: [backend], autoClose: false, flushThreshold: 2 });
            for (let i = 0; i < 10; i++) {
                mgr.push({ type: 'END_EXPR', iid: (i + 1) * 8, seq: i + 1, writes: [], reads: [], fields: [] });
            }
            await mgr.close();

            const buf = readFileSync(outPath);
            assert.ok(isBinaryTrace(buf), '文件应以 JTB1 魔数开头');
            const events = deserializeAll(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            assert.equal(events.length, 10, `期望 10 条事件，实际 ${events.length}`);
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
        }
    });

    test('setSmap — close 时写出 .smap.json', async () => {
        const outPath = join(tmpdir(), `jalangi-test-${Date.now()}.bin`);
        const smapPath = outPath.replace('.bin', '.smap.json');
        try {
            const backend = new NodeStreamBackend({ path: outPath, append: false });
            backend.setSmap({ iids: { 8: [1, 0, 1, 10] }, file: 'test.js' });
            await backend.write([{ type: 'SCRIPT_ENTER', iid: 8, seq: 1, file: 'test.js' }]);
            await backend.close();

            assert.ok(existsSync(smapPath), `.smap.json 文件应被创建: ${smapPath}`);
            const smap = JSON.parse(readFileSync(smapPath, 'utf8'));
            assert.equal(smap.file, 'test.js', 'smap 内容应正确');
        } finally {
            if (existsSync(outPath)) unlinkSync(outPath);
            if (existsSync(smapPath)) unlinkSync(smapPath);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. WsBackend + trace-server 端到端回路测试
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
                // 二进制帧：[u32 batchId][JTB1 事件流 serializeBatch output]
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
            const { WsBackend } = await import('../../src/logger/transport/WsBackend.js');
            const backend = new WsBackend({
                url:         `ws://127.0.0.1:${WS_PORT}`,
                format:      'binary',
                mode:        'main',   // Node.js 环境无 Worker，使用主线程模式
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
            const { WsBackend } = await import('../../src/logger/transport/WsBackend.js');
            const backend = new WsBackend({
                url:         `ws://127.0.0.1:${WS_PORT + 1}`,
                format:      'binary',
                mode:        'main',   // Node.js 环境无 Worker，使用主线程模式
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
            for (let i = 0; i < 9; i++) mgr.push({ type: 'READ', iid: i * 8, value: i });
            await mgr.close();

            // 9 条事件，每批 3 条 → 3 批
            assert.equal(server.received.length, 3, `期望 3 批，实际 ${server.received.length}`);
        } finally {
            await server.close();
        }
    });

    // JTB1 二进制格式：验证多种事件类型批次能正确通过 WsBackend 传输
    test('WsBackend JTB1 二进制格式：多种事件类型批次正确发送和 ack', async () => {
        const { deserializeAll, createFileHeader } =
            await import('../../src/encoding/EventSerializer.js');

        // 这个测试需要额外捕获原始二进制帧，所以启动一个自定义 server
        const capturedFrames = [];
        const http3 = createServer();
        const wss3  = new WebSocketServer({ server: http3 });
        const received3 = [];
        wss3.on('connection', (ws) => {
            ws.binaryType = 'arraybuffer';
            ws.on('message', (data, isBinary) => {
                if (!isBinary) return;
                const buf = data instanceof Buffer
                    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                    : data;
                const batchId = new DataView(buf).getUint32(0, true);
                received3.push(batchId);
                capturedFrames.push(buf.slice(4)); // 跳过 u32 batchId
                const ack = new ArrayBuffer(4);
                new DataView(ack).setUint32(0, batchId, true);
                ws.send(ack);
            });
        });
        const port3 = WS_PORT + 2;
        await new Promise((resolve, reject) => { http3.listen(port3, resolve); http3.on('error', reject); });

        try {
            const { WsBackend } = await import('../../src/logger/transport/WsBackend.js');
            const backend = new WsBackend({
                url:         `ws://127.0.0.1:${port3}`,
                format:      'binary',  // JTB1 二进制格式（唯一支持的格式）
                mode:        'main',    // Node.js 环境无 Worker，使用主线程模式
                autoConnect: true,
                windowSize:  4,
            });

            await new Promise(r => setTimeout(r, 200));

            // 写入 JTB1 标准事件类型
            const batch = [
                { type: 'SCRIPT_ENTER',  iid: 8,  seq: 1, file: 'test.js' },
                { type: 'END_EXPR',      iid: 16, seq: 2, writes: [{ name: 'x', val: 42 }], reads: [], fields: [] },
                { type: 'SCRIPT_EXIT',   iid: 24, seq: 3 },
            ];
            await backend.write(batch);
            await backend.flush();
            await backend.close();

            assert.equal(received3.length, 1, `期望 1 批，实际 ${received3.length}`);
            assert.equal(capturedFrames.length, 1, '应捕获到 1 帧');

            // 验证接收到的事件流能用 deserializeAll 正确解析（拼上 JTB1 文件头）
            const headerBuf = new Uint8Array(createFileHeader());
            const frameBuf  = new Uint8Array(capturedFrames[0]);
            const combined  = new Uint8Array(headerBuf.byteLength + frameBuf.byteLength);
            combined.set(headerBuf, 0);
            combined.set(frameBuf, headerBuf.byteLength);
            const events = deserializeAll(combined.buffer);
            assert.equal(events.length, 3, `期望 3 条事件，实际 ${events.length}`);
            assert.equal(events[0].type, 'SCRIPT_ENTER');
            assert.equal(events[0].file, 'test.js');
            assert.equal(events[1].type, 'END_EXPR');
            assert.equal(events[1].writes[0].value, 42);
            assert.equal(events[2].type, 'SCRIPT_EXIT');
        } finally {
            await new Promise(r => { wss3.close(); http3.close(r); });
        }
    });
});
