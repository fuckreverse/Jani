/**
 * F1_EventIndex.mjs — 流式解析 JTB1 二进制 trace 文件，写入 events/writes/reads/fields 表
 *
 * 依赖：无
 * 输入：.bin 文件（JTB1 格式）
 * 输出：events、writes、reads、fields 表
 *
 * 采用 32MB 滑动窗口流式读取，避免大文件 OOM。
 *
 * 性能优化：
 *   - BATCH_SIZE = 50000：减少事务提交次数，大幅提升写入吞吐
 *   - YIELD_EVERY_BATCHES = 10：减少事件循环让出频率
 *   - DataView 只在窗口 compact 时重建，消除热路径 GC 压力
 *   - serializeValue fast-path：基础类型跳过 try/catch（V8 JIT 友好）
 *   - stmtXxx.run(...row) spread 传参：比数组传参快
 *   - F1 运行期间临时关闭外键约束，消除每次 INSERT 的父表查找开销
 */

import { openSync, readSync, fstatSync, closeSync } from 'fs';
import { setImmediate as setImmediateAsync } from 'timers/promises';
import { resolve } from 'path';
import { createRequire } from 'module';
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { encodeType, TYPE } from '../db/EventTypeCode.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('F1-EventIndex');

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
// 窗口剩余低水位：低于此值时补充数据
const REFILL_THRESHOLD = 1 * 1024 * 1024;
// 每次 DB 事务提交的事件数：50000 条一批，大幅减少事务提交次数
const BATCH_SIZE = 50000;
// 每隔多少个 batch 让出一次事件循环（值越大吞吐越高，但每次 HTTP/WS 响应延迟越长）
const YIELD_EVERY_BATCHES = 10;

// value_index 配置
const VI_MAX_SAME = 50;   // 同一值最多记录 50 条（防止循环变量爆炸）
const VI_MAX_STR  = 256;  // 字符串截断长度

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
        db.run('DELETE FROM value_index WHERE session_id = ?', sessionId);
        db.run('DELETE FROM fields WHERE session_id = ?', sessionId);
        db.run('DELETE FROM reads  WHERE session_id = ?', sessionId);
        db.run('DELETE FROM writes WHERE session_id = ?', sessionId);
        db.run('DELETE FROM events WHERE session_id = ?', sessionId);

        this.emitProgress(ctx, '流式解析事件...', 5);

        const rawDb = db.raw();

        // 临时关闭外键约束：F1 是纯批量写入，不需要每次 INSERT 都查父表
        rawDb.pragma('foreign_keys = OFF');

        // prepare() 在循环外只做一次，避免重复编译 SQL
        const stmtEvent = rawDb.prepare(
            'INSERT OR IGNORE INTO events (id, session_id, type, iid) VALUES (?, ?, ?, ?)'
        );
        const stmtWrite = rawDb.prepare(
            'INSERT INTO writes (event_id, session_id, name, value, omitted) VALUES (?, ?, ?, ?, ?)'
        );
        const stmtRead = rawDb.prepare(
            'INSERT INTO reads (event_id, session_id, name, value, omitted) VALUES (?, ?, ?, ?, ?)'
        );
        const stmtField = rawDb.prepare(
            'INSERT INTO fields (event_id, session_id, base, offset, is_write, value, omitted) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const stmtVI = rawDb.prepare(
            'INSERT OR IGNORE INTO value_index (session_id, event_id, val_type, val_num, val_str, var_name, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );

        // value_index 去重计数器：val_key → count（防止同一值无限写入）
        const viCount = new Map(); // `${val_type}:${val_key}` → number

        // better-sqlite3 原生事务：spread 传参比数组传参快（跳过内部类型判断）
        const flushTx = rawDb.transaction((evts, wrs, rds, flds, vis) => {
            for (const e of evts) stmtEvent.run(...e);
            for (const w of wrs)  stmtWrite.run(...w);
            for (const r of rds)  stmtRead.run(...r);
            for (const f of flds) stmtField.run(...f);
            for (const v of vis)  stmtVI.run(...v);
        });

        // ── 滑动窗口状态 ──────────────────────────────────────────────────────
        const window = Buffer.alloc(WINDOW_SIZE);
        let windowStart = FILE_HEADER_SIZE; // 跳过文件头
        let windowLen   = 0;
        let filePos     = FILE_HEADER_SIZE; // 下次从文件读的位置
        let relOffset   = 0;               // window 内当前偏移

        // 初始填充
        const initRead = Math.min(WINDOW_SIZE, fileSize - filePos);
        if (initRead > 0) {
            windowLen = readSync(fd, window, 0, initRead, filePos);
            filePos += windowLen;
        }

        // DataView 复用：只在窗口 compact（relOffset 归零）后重建，消除热路径 GC 压力
        let view = new DataView(window.buffer, window.byteOffset, windowLen);

        // ── 批次缓冲 ──────────────────────────────────────────────────────────
        let eventBatch = [];
        let writeBatch = [];
        let readBatch  = [];
        let fieldBatch = [];
        let viBatch    = [];
        let totalEvents = 0;
        let batchCount  = 0;
        const dict = new Map();

        // 速率统计
        const startTime = Date.now();
        let lastReportTime = startTime;
        let lastReportEvents = 0;

        const flush = () => {
            if (eventBatch.length === 0) return;
            flushTx(eventBatch, writeBatch, readBatch, fieldBatch, viBatch);
            eventBatch = [];
            writeBatch = [];
            readBatch  = [];
            fieldBatch = [];
            viBatch    = [];
        };

        /** 尝试将一个值加入 value_index 批次（去重 + 类型化） */
        const pushVI = (eventId, rawVal, varName, source) => {
            if (rawVal == null || rawVal === 'null' || rawVal === 'undefined') return;
            const t = typeof rawVal === 'string' ? rawVal : String(rawVal);
            let val_type, val_num, val_str;
            if (t === 'true' || t === 'false') {
                val_type = 'bool'; val_num = null; val_str = t;
            } else {
                const n = Number(t);
                if (!isNaN(n) && t.trim() !== '') {
                    val_type = 'num'; val_num = n; val_str = null;
                } else {
                    // 字符串：去掉 JSON 引号包裹
                    let s = t;
                    if (s.startsWith('"') && s.endsWith('"')) {
                        try { s = JSON.parse(s); } catch { /* keep raw */ }
                    }
                    if (s.length === 0 || s.length > VI_MAX_STR) return; // 太短或太长不索引
                    val_type = 'str'; val_num = null; val_str = s.substring(0, VI_MAX_STR);
                }
            }
            const key = `${val_type}:${val_type === 'num' ? val_num : val_str}`;
            const cnt = viCount.get(key) ?? 0;
            if (cnt >= VI_MAX_SAME) return;
            viCount.set(key, cnt + 1);
            viBatch.push([sessionId, eventId, val_type, val_num, val_str, varName ?? null, source]);
        };

        // ── 主解析循环 ────────────────────────────────────────────────────────
        while (true) {
            const remaining = windowLen - relOffset;

            // 补充数据：剩余低于阈值且文件还有数据
            if (remaining < REFILL_THRESHOLD && filePos < fileSize) {
                if (relOffset > 0) {
                    // compact：把未处理部分移到头部，然后重建 DataView
                    window.copyWithin(0, relOffset, windowLen);
                    windowLen  -= relOffset;
                    windowStart += relOffset;
                    relOffset   = 0;
                    // 窗口地址未变但有效长度改变，重建 DataView
                    view = new DataView(window.buffer, window.byteOffset, windowLen);
                }
                const toRead = Math.min(WINDOW_SIZE - windowLen, fileSize - filePos);
                if (toRead > 0) {
                    const n = readSync(fd, window, windowLen, toRead, filePos);
                    windowLen += n;
                    filePos   += n;
                    // 数据追加后更新 DataView 有效长度
                    view = new DataView(window.buffer, window.byteOffset, windowLen);
                }
            }

            if (windowLen - relOffset < EVENT_HEADER_SIZE) break;

            let result;
            try {
                result = deserializeEvent(view, relOffset, dict);
            } catch (e) {
                log.warn({ err: e, fileOffset: windowStart + relOffset, sessionId },
                    `Decode error at file offset ${windowStart + relOffset}: ${e.message}`);
                break;
            }

            if (!result || result.nextOffset <= relOffset) break;

            relOffset = result.nextOffset;

            const { event } = result;
            if (event.type === 'DICT_ENTRY') continue;  // 不写入 events 表

            totalEvents++;
            const eventId = event.seq;

            eventBatch.push([
                eventId,
                sessionId,
                encodeType(event.type),  // INTEGER 编码，节省存储 + 加速比较
                event.iid ?? null,
            ]);

            if (event.writes?.length > 0) {
                for (const w of event.writes) {
                    const sv = serializeValue(w.value);
                    writeBatch.push([eventId, sessionId, w.name ?? null, sv, w.omitted ? 1 : 0]);
                    if (!w.omitted) pushVI(eventId, sv, w.name, 'write');
                }
            }
            if (event.reads?.length > 0) {
                for (const r of event.reads) {
                    const sv = serializeValue(r.value);
                    readBatch.push([eventId, sessionId, r.name ?? null, sv, r.omitted ? 1 : 0]);
                    if (!r.omitted) pushVI(eventId, sv, r.name, 'read');
                }
            }

            // CALL_PRE 事件：把 event.fn（被调函数名）写入 reads 表（name='callee'）
            // F3_CallGraphBuilder 依赖此字段来识别函数名；若缺失则降级为 fn@<iid>
            if (event.type === 'CALL_PRE') {
                if (event.fn) {
                    readBatch.push([eventId, sessionId, 'callee', JSON.stringify(event.fn), 0]);
                }
                // 把参数列表写入 writes 表（name='arg0','arg1',...），F3 读取 args 时依赖此数据
                if (event.args?.length > 0) {
                    const argc = Math.min(event.args.length, 8);
                    for (let i = 0; i < argc; i++) {
                        const v = event.args[i];
                        writeBatch.push([eventId, sessionId, `arg${i}`, serializeValue(v), v === undefined ? 1 : 0]);
                    }
                }
            }

            // CALL 事件：把返回值写入 writes 表（name='return'）
            // F3_CallGraphBuilder 依赖此字段（retMap）填充 call_edges.return_value
            if (event.type === 'CALL') {
                // result===undefined 表示被 omitted（值太大被截断），仍写一行以标记存在
                const omitted = event.result === undefined ? 1 : 0;
                writeBatch.push([eventId, sessionId, 'return', serializeValue(event.result), omitted]);
            }
            if (event.fields?.length > 0) {
                for (const f of event.fields) {
                    fieldBatch.push([
                        eventId, sessionId,
                        f.base   ?? null, f.offset ?? null,
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

                // 计算瞬时速率（近期 N 批的平均）
                const now = Date.now();
                const dtMs = now - lastReportTime;
                const dtEvents = totalEvents - lastReportEvents;
                const eventsPerSec = dtMs > 0 ? Math.round(dtEvents / dtMs * 1000) : 0;
                lastReportTime   = now;
                lastReportEvents = totalEvents;

                const elapsed = ((now - startTime) / 1000).toFixed(1);
                const rateStr = eventsPerSec > 0
                    ? ` | ${(eventsPerSec / 1000).toFixed(0)}k ev/s`
                    : '';
                this.emitProgress(ctx,
                    `已处理 ${(totalEvents / 1000).toFixed(0)}k 条事件${rateStr} | 耗时 ${elapsed}s`,
                    pct,
                    { eventsPerSec, totalEvents, elapsedMs: now - startTime }
                );

                if (batchCount % YIELD_EVERY_BATCHES === 0) {
                    await setImmediateAsync();
                }
            }
        }

        flush();
        closeSync(fd);

        // 恢复外键约束
        rawDb.pragma('foreign_keys = ON');

        db.run('UPDATE sessions SET event_count = ? WHERE id = ?', totalEvents, sessionId);

        this.emitProgress(ctx, `完成，共 ${totalEvents} 条事件`, 100);
        this.emitDone(ctx, { eventCount: totalEvents });
    }
}

/**
 * 将运行时值序列化为 JSON 字符串存入 DB。
 * fast-path：基础类型直接 JSON.stringify，跳过 try/catch（V8 JIT 友好）。
 * 仅 object/function 类型才走 try/catch 防止循环引用抛出。
 */
function serializeValue(value) {
    if (value === undefined) return null;
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return JSON.stringify(value);
    if (t === 'string') return JSON.stringify(value);
    // object / function / symbol — 可能循环引用，走 try/catch
    try { return JSON.stringify(value); } catch { return String(value); }
}
