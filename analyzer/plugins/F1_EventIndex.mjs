/**
 * F1_EventIndex.mjs — 流式解析 JTB1 二进制 trace 文件，写入 events/writes/reads/fields 表
 *
 * 依赖：无
 * 输入：.bin 文件（JTB1 格式）
 * 输出：events、writes、reads、fields 表
 *
 * 采用 16MB 滑动窗口流式读取，避免大文件 OOM。
 */

import { openSync, readSync, fstatSync, closeSync } from 'fs';
import { setImmediate as setImmediateAsync } from 'timers/promises';
import { resolve } from 'path';
import { createRequire } from 'module';
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const require = createRequire(import.meta.url);
const JANI_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../');

let EventSerializer;
try {
    EventSerializer = require(resolve(JANI_ROOT, 'src/encoding/EventSerializer.js'));
} catch (e) {
    throw new Error(`F1_EventIndex: 无法加载 EventSerializer: ${e.message}`);
}

const { FILE_HEADER_SIZE, EVENT_HEADER_SIZE, deserializeEvent, isBinaryTrace } = EventSerializer;

// 滑动窗口大小：32MB，保证单个超长事件也能容纳
const WINDOW_SIZE = 32 * 1024 * 1024;
// 每次从文件追加读取的块大小：16MB
const READ_CHUNK  = 16 * 1024 * 1024;
// 窗口剩余低水位：低于此值时补充数据
const REFILL_THRESHOLD = 1 * 1024 * 1024;
// 每次 DB 事务提交的事件数（越大写入越快，但每批占用事件循环时间越长）
const BATCH_SIZE = 5000;
// 每隔多少个 batch 让出一次事件循环（给进度推送、WebSocket 心跳等机会执行）
const YIELD_EVERY_BATCHES = 1;

export default class F1EventIndex extends BasePlugin {
    static id = 'F1-EventIndex';
    static deps = [];
    static description = '流式解析 JTB1 二进制 trace 文件，写入 events/writes/reads/fields 表';
    static displayName = 'F1 · EventIndex';

    async run(ctx) {
        const { sessionId } = ctx;

        const session = db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (!session.bin_path) throw new Error(`Session ${sessionId} has no bin_path`);

        this.emitProgress(ctx, '检查 .bin 文件...', 0);

        // 用小 buffer 验证文件头，避免大文件整体读入
        const fd = openSync(session.bin_path, 'r');
        const fileSize = fstatSync(fd).size;
        const headerBuf = Buffer.alloc(8);
        readSync(fd, headerBuf, 0, 8, 0);
        if (!isBinaryTrace(headerBuf)) {
            closeSync(fd);
            throw new Error(`文件 "${session.bin_path}" 不是有效的 JTB1 trace 文件`);
        }

        this.emitProgress(ctx, '清理旧数据...', 2);
        db.run('DELETE FROM fields WHERE session_id = ?', sessionId);
        db.run('DELETE FROM reads  WHERE session_id = ?', sessionId);
        db.run('DELETE FROM writes WHERE session_id = ?', sessionId);
        db.run('DELETE FROM events WHERE session_id = ?', sessionId);

        this.emitProgress(ctx, '流式解析事件...', 5);

        // 预编译 INSERT 语句（sql.js：stmt.run([params]) = bind+step+reset 一体）
        const rawDb = db.raw();
        const insertEvent = rawDb.prepare(
            'INSERT OR IGNORE INTO events (id, session_id, type, iid, line, col, src_text) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const insertWrite = rawDb.prepare(
            'INSERT INTO writes (event_id, session_id, name, value, omitted) VALUES (?, ?, ?, ?, ?)'
        );
        const insertRead = rawDb.prepare(
            'INSERT INTO reads (event_id, session_id, name, value, omitted) VALUES (?, ?, ?, ?, ?)'
        );
        const insertField = rawDb.prepare(
            'INSERT INTO fields (event_id, session_id, base, offset, is_write, value, omitted) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );

        // 批量写入（手动 BEGIN/COMMIT 事务，不通过 db.transaction() 以避免 flush）
        const flushTx = (evts, wrs, rds, flds) => {
            rawDb.run('BEGIN');
            try {
                for (const e of evts) insertEvent.run(e);
                for (const w of wrs)  insertWrite.run(w);
                for (const r of rds)  insertRead.run(r);
                for (const f of flds) insertField.run(f);
                rawDb.run('COMMIT');
            } catch (e) {
                try { rawDb.run('ROLLBACK'); } catch (_) {}
                throw e;
            }
        };

        // ── 滑动窗口状态 ──────────────────────────────────────────────────────
        // window: 始终保持 WINDOW_SIZE 大小的 Buffer
        // windowStart: window[0] 在文件中的字节偏移
        // windowLen: window 内有效数据的字节数
        // relOffset: 当前事件在 window 中的偏移（相对于 window[0]）
        const window = Buffer.alloc(WINDOW_SIZE);
        let windowStart = FILE_HEADER_SIZE; // 跳过文件头
        let windowLen = 0;
        let filePos = FILE_HEADER_SIZE;     // 下次从文件读的位置
        let relOffset = 0;                  // window 内当前偏移

        // 初始填充
        const initRead = Math.min(WINDOW_SIZE, fileSize - filePos);
        if (initRead > 0) {
            windowLen = readSync(fd, window, 0, initRead, filePos);
            filePos += windowLen;
        }

        // ── 批次缓冲 ──────────────────────────────────────────────────────────
        let eventBatch = [];
        let writeBatch = [];
        let readBatch  = [];
        let fieldBatch = [];
        let totalEvents = 0;
        let batchCount  = 0;
        const dict = new Map();

        const flush = () => {
            if (eventBatch.length === 0) return;
            flushTx(eventBatch, writeBatch, readBatch, fieldBatch);
            eventBatch = [];
            writeBatch = [];
            readBatch  = [];
            fieldBatch = [];
        };

        // ── 主解析循环 ────────────────────────────────────────────────────────
        while (true) {
            // 剩余可用字节
            const remaining = windowLen - relOffset;

            // 补充数据：剩余低于阈值且文件还有数据
            if (remaining < REFILL_THRESHOLD && filePos < fileSize) {
                // 把未处理部分移到 window 头部
                if (relOffset > 0) {
                    window.copyWithin(0, relOffset, windowLen);
                    windowLen -= relOffset;
                    windowStart += relOffset;
                    relOffset = 0;
                }
                // 填满 window
                const toRead = Math.min(WINDOW_SIZE - windowLen, fileSize - filePos);
                if (toRead > 0) {
                    const n = readSync(fd, window, windowLen, toRead, filePos);
                    windowLen += n;
                    filePos += n;
                }
            }

            // 再次检查是否有足够数据解析事件头
            if (windowLen - relOffset < EVENT_HEADER_SIZE) break;

            // 构建 DataView（只覆盖 window 有效部分）
            const ab = window.buffer.slice(
                window.byteOffset,
                window.byteOffset + windowLen
            );
            const view = new DataView(ab);

            let result;
            try {
                result = deserializeEvent(view, relOffset, dict);
            } catch (e) {
                console.warn(`F1_EventIndex: decode error at file offset ${windowStart + relOffset}: ${e.message}`);
                break;
            }

            if (!result || result.nextOffset <= relOffset) break;

            const advance = result.nextOffset - relOffset;
            relOffset = result.nextOffset;

            const { event } = result;
            if (event.type === 'DICT_ENTRY') continue;

            totalEvents++;
            const eventId = event.seq;

            eventBatch.push([
                eventId,
                sessionId,
                event.type,
                event.iid ?? null,
                event.line ?? null,
                event.col  ?? null,
                event.srcText ?? event.src_text ?? null,
            ]);

            if (event.writes?.length > 0) {
                for (const w of event.writes) {
                    writeBatch.push([eventId, sessionId, w.name ?? null, serializeValue(w.value), w.omitted ? 1 : 0]);
                }
            }
            if (event.reads?.length > 0) {
                for (const r of event.reads) {
                    readBatch.push([eventId, sessionId, r.name ?? null, serializeValue(r.value), r.omitted ? 1 : 0]);
                }
            }
            if (event.fields?.length > 0) {
                for (const f of event.fields) {
                    fieldBatch.push([
                        eventId, sessionId,
                        f.base ?? null, f.offset ?? null,
                        f.isWrite ? 1 : 0,
                        serializeValue(f.value),
                        f.omitted ? 1 : 0,
                    ]);
                }
            }

            if (eventBatch.length >= BATCH_SIZE) {
                flush();
                batchCount++;
                const pct = Math.min(95, Math.floor(((windowStart + relOffset) / fileSize) * 90) + 5);
                this.emitProgress(ctx, `已处理 ${totalEvents} 条事件...`, pct);
                // 每 YIELD_EVERY_BATCHES 个 batch 让出事件循环一次，
                // 防止长时间同步占用主线程导致 WebSocket/HTTP 请求无法响应。
                if (batchCount % YIELD_EVERY_BATCHES === 0) {
                    await setImmediateAsync();
                }
            }
        }

        flush();
        closeSync(fd);

        // 释放预编译语句（sql.js 用 free()）
        insertEvent.free();
        insertWrite.free();
        insertRead.free();
        insertField.free();

        db.run('UPDATE sessions SET event_count = ? WHERE id = ?', totalEvents, sessionId);

        this.emitProgress(ctx, `完成，共 ${totalEvents} 条事件`, 100);
        this.emitDone(ctx, { eventCount: totalEvents });
    }
}

function serializeValue(value) {
    if (value === undefined) return null;
    if (value === null) return 'null';
    try { return JSON.stringify(value); } catch { return String(value); }
}
