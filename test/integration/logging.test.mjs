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
import { NodeStreamBackend } from '../../src/logger/backends/NodeStreamBackend.js';

// ════════════════════════════════════════════════════════════════════════════════
// 1. NodeStreamBackend
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
            const { WsBackend } = await import('../../src/logger/backends/WsBackend.js');
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
            const { WsBackend } = await import('../../src/logger/backends/WsBackend.js');
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
            const { WsBackend } = await import('../../src/logger/backends/WsBackend.js');
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
