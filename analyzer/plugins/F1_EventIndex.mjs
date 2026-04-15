/**
 * F1_EventIndex.mjs — 流式解析 JTB1 二进制 trace 文件，写入 events/writes/reads/fields 表
 *
 * 依赖：无
 * 输入：.bin 文件（JTB1 格式）
 * 输出：events、writes、reads、fields、value_dict 表
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
 *   - value_dict：内存 Map 分配局部 ID，避免 N+1 查询；INSERT OR IGNORE 保证幂等
 */

import { openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { setImmediate as setImmediateAsync } from 'timers/promises';
import { resolve } from 'path';
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
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

const { FILE_HEADER_SIZE, EVENT_HEADER_SIZE, deserializeEvent, isBinaryTrace, readFileVersion } = EventSerializer;

// 滑动窗口大小：来自配置
const WINDOW_SIZE         = () => cfg('plugins.F1_EventIndex.windowSize');
// 窗口剩余低水位：来自配置
const REFILL_THRESHOLD    = () => cfg('plugins.F1_EventIndex.refillThreshold');
// 每次 DB 事务提交的事件数：来自配置
const BATCH_SIZE          = () => cfg('plugins.F1_EventIndex.batchSize');
// 每隔多少个 batch 让出一次事件循环：来自配置
const YIELD_EVERY_BATCHES = () => cfg('plugins.F1_EventIndex.yieldEveryBatches');

// value_index 配置：来自配置
const VI_MAX_SAME = () => cfg('plugins.F1_EventIndex.viMaxSame');
const VI_MAX_STR  = () => cfg('plugins.F1_EventIndex.viMaxStr');

export default class F1EventIndex extends BasePlugin {
    static id = 'F1-EventIndex';
    static deps = [];
    static description = '流式解析 JTB1 二进制 trace 文件，写入 events/writes/reads/fields 表';
    static displayName = 'F1 · EventIndex';

    async run(ctx) {
        const { sessionId } = ctx;

        // ── 从配置读取所有运行参数（一次性，避免热循环中重复调用 cfg()）───────
        const _windowSize         = WINDOW_SIZE();
        const _refillThreshold    = REFILL_THRESHOLD();
        const _batchSize          = BATCH_SIZE();
        const _yieldEveryBatches  = YIELD_EVERY_BATCHES();
        const _viMaxSame          = VI_MAX_SAME();
        const _viMaxStr           = VI_MAX_STR();

        const session = db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (!session.bin_path) throw new Error(`Session ${sessionId} has no bin_path`);

        this.emitProgress(ctx, '检查 .bin 文件...', 0);

        // ── 支持 .bin.gz：自动解压为临时文件，解析完后删除 ──────────────────
        let binPath = session.bin_path;
        let tmpBinPath = null;
        if (binPath.endsWith('.bin.gz')) {
            this.emitProgress(ctx, '解压 .bin.gz 文件...', 1);
            log.info({ binPath, sessionId }, 'Decompressing .bin.gz trace file...');
            const compressed = readFileSync(binPath);
            const decompressed = gunzipSync(compressed);
            // 写入临时文件（复用目录，文件名加 _tmp_f1 后缀）
            tmpBinPath = binPath.replace(/\.bin\.gz$/, `._tmp_f1_${sessionId}.bin`);
            writeFileSync(tmpBinPath, decompressed);
            binPath = tmpBinPath;
            log.info({ tmpBinPath, size: decompressed.byteLength }, 'Decompressed to temp file');
        }

        // 用小 buffer 验证文件头，避免大文件整体读入
        const fd = openSync(binPath, 'r');
        const fileSize = fstatSync(fd).size;
        const headerBuf = Buffer.alloc(8);
        readSync(fd, headerBuf, 0, 8, 0);
        if (!isBinaryTrace(headerBuf)) {
            closeSync(fd);
            // 清理临时解压文件（如有）
            if (tmpBinPath) { try { unlinkSync(tmpBinPath); } catch { /* ignore */ } }
            throw new Error(`文件 "${session.bin_path}" 不是有效的 JTB1 trace 文件`);
        }

        // 读取格式版本号（字节偏移4，v1=0x01 无 write.oid，v2=0x02 有 write.oid）
        const fileVersion = readFileVersion ? readFileVersion(headerBuf) : 0x01;
        log.info({ sessionId, fileVersion }, `Trace 文件格式版本: v${fileVersion}`);

        this.emitProgress(ctx, '清理旧数据...', 2);
        db.run('DELETE FROM oid_aliases  WHERE session_id = ?', sessionId);
        db.run('DELETE FROM value_index WHERE session_id = ?', sessionId);
        db.run('DELETE FROM value_dict  WHERE session_id = ?', sessionId);
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
        // value_dict：INSERT OR IGNORE，id 由内存计数器分配，避免 N+1 查询
        const stmtVD = rawDb.prepare(
            'INSERT OR IGNORE INTO value_dict (id, session_id, val_text, val_type, val_num) VALUES (?, ?, ?, ?, ?)'
        );
        const stmtWrite = rawDb.prepare(
            'INSERT INTO writes (event_id, session_id, name, value_id, omitted) VALUES (?, ?, ?, ?, ?)'
        );
        const stmtRead = rawDb.prepare(
            'INSERT INTO reads (event_id, session_id, name, value_id, omitted) VALUES (?, ?, ?, ?, ?)'
        );
        const stmtField = rawDb.prepare(
            'INSERT INTO fields (event_id, session_id, offset, is_write, value_id, omitted, base_oid) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const stmtVI = rawDb.prepare(
            'INSERT OR IGNORE INTO value_index (session_id, event_id, val_type, val_num, val_str, var_name, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        // oid_aliases：INSERT OR IGNORE，同一 (session, oid, var_name) 只记录最早的那条
        const stmtOidAlias = rawDb.prepare(
            'INSERT OR IGNORE INTO oid_aliases (session_id, oid, var_name, event_id) VALUES (?, ?, ?, ?)'
        );

        // value_index 去重计数器：val_key → count（防止同一值无限写入）
        const viCount = new Map(); // `${val_type}:${val_key}` → number

        // ── 值字典（内存局部字典，session 级别唯一）────────────────────────────
        // key: serialized value text（即 serializeValue 的返回值）
        // val: 局部 INTEGER id（递增，从 1 开始）
        // 通过内存 Map 完全避免 SELECT 查询，INSERT OR IGNORE 保证冲突时不覆盖
        const vdMap = new Map(); // val_text → value_id
        let vdNextId = 1;

        /**
         * 将一个序列化值字符串写入值字典，返回其 id。
         * - null 值（undefined→null 的序列化）直接返回 null，不入字典
         * - 热路径：Map.get 命中时 O(1)，无任何 DB 操作
         *
         * @param {string|null} sv - serializeValue() 的返回值
         * @param {Array}       vdBatch - 当前批次 value_dict INSERT 缓冲
         * @returns {number|null} value_id or null
         */
        const internValue = (sv, vdBatch) => {
            if (sv === null) return null;
            let id = vdMap.get(sv);
            if (id !== undefined) return id;
            // 新值：分配局部 ID，推入 vdBatch
            id = vdNextId++;
            vdMap.set(sv, id);
            // 解析类型和数值，与 pushVI 逻辑保持一致
            let val_type, val_num;
            if (sv === 'null') {
                val_type = 'null'; val_num = null;
            } else if (sv === 'true' || sv === 'false') {
                val_type = 'bool'; val_num = null;
            } else {
                const n = Number(sv);
                if (!isNaN(n) && sv.trim() !== '') {
                    val_type = 'num'; val_num = n;
                } else if (sv.startsWith('"[') && /^"\[(?:Uint8Array|Int8Array|Uint16Array|Int16Array|Uint32Array|Int32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|ArrayBuffer)\(/.test(sv)) {
                    // TypedArray 格式：'"[Uint8Array(N):MB:hexpreview]"'
                    val_type = 'ta'; val_num = null;
                } else if (sv.startsWith('"') || sv.startsWith('{') || sv.startsWith('[')) {
                    val_type = sv.startsWith('"') ? 'str' : 'obj'; val_num = null;
                } else {
                    val_type = 'str'; val_num = null;
                }
            }
            vdBatch.push([id, sessionId, sv, val_type, val_num]);
            return id;
        };

        // better-sqlite3 原生事务：spread 传参比数组传参快（跳过内部类型判断）
        let oidAliasBatch = [];
        const flushTx = rawDb.transaction((evts, wrs, rds, flds, vis, oas, vds) => {
            // value_dict 必须先写，writes/reads/fields 引用其 id（外键关系，此处不启用约束）
            for (const v of vds)  stmtVD.run(...v);
            for (const e of evts) stmtEvent.run(...e);
            for (const w of wrs)  stmtWrite.run(...w);
            for (const r of rds)  stmtRead.run(...r);
            for (const f of flds) stmtField.run(...f);
            for (const v of vis)  stmtVI.run(...v);
            for (const o of oas)  stmtOidAlias.run(...o);
        });

        // ── 滑动窗口状态 ──────────────────────────────────────────────────────
        const window = Buffer.alloc(_windowSize);
        let windowStart = FILE_HEADER_SIZE; // 跳过文件头
        let windowLen   = 0;
        let filePos     = FILE_HEADER_SIZE; // 下次从文件读的位置
        let relOffset   = 0;               // window 内当前偏移

        // 初始填充
        const initRead = Math.min(_windowSize, fileSize - filePos);
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
        let vdBatch    = [];  // value_dict INSERT 缓冲（当 flush 时写入）
        let totalEvents = 0;
        let batchCount  = 0;
        // 速率统计
        const startTime = Date.now();
        let lastReportTime = startTime;
        let lastReportEvents = 0;

        const flush = () => {
            if (eventBatch.length === 0 && vdBatch.length === 0) return;
            flushTx(eventBatch, writeBatch, readBatch, fieldBatch, viBatch, oidAliasBatch, vdBatch);
            eventBatch    = [];
            writeBatch    = [];
            readBatch     = [];
            fieldBatch    = [];
            viBatch       = [];
            oidAliasBatch = [];
            vdBatch       = [];
            // 注意：vdMap 和 vdNextId 不重置，跨 batch 保持内存字典完整性
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
                } else if (t.startsWith('"[') && /^"\[(?:Uint8Array|Int8Array|Uint16Array|Int16Array|Uint32Array|Int32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|ArrayBuffer)\(/.test(t)) {
                    // TypedArray 格式：'"[TypeName(N):byteLength B:hexpreview]"'
                    // 解包 JSON 引号后，截断到 VI_MAX_STR 存入 val_str，类型标记为 'ta'
                    let s = t;
                    try { s = JSON.parse(t); } catch { /* keep raw */ }
                    val_type = 'ta'; val_num = null; val_str = s.substring(0, _viMaxStr);
                } else {
                    // 字符串：去掉 JSON 引号包裹
                    let s = t;
                    if (s.startsWith('"') && s.endsWith('"')) {
                        try { s = JSON.parse(s); } catch { /* keep raw */ }
                    }
                    if (s.length === 0) return; // 空字符串不索引
                    val_type = 'str'; val_num = null; val_str = s.substring(0, _viMaxStr);
                }
            }
            const key = `${val_type}:${val_type === 'num' ? val_num : val_str}`;
            const cnt = viCount.get(key) ?? 0;
            if (cnt >= _viMaxSame) return;
            viCount.set(key, cnt + 1);
            viBatch.push([sessionId, eventId, val_type, val_num, val_str, varName ?? null, source]);
        };

        // ── 主解析循环 ────────────────────────────────────────────────────────
        while (true) {
            const remaining = windowLen - relOffset;

            // 补充数据：剩余低于阈值且文件还有数据
            if (remaining < _refillThreshold && filePos < fileSize) {
                if (relOffset > 0) {
                    // compact：把未处理部分移到头部，然后重建 DataView
                    window.copyWithin(0, relOffset, windowLen);
                    windowLen  -= relOffset;
                    windowStart += relOffset;
                    relOffset   = 0;
                    // 窗口地址未变但有效长度改变，重建 DataView
                    view = new DataView(window.buffer, window.byteOffset, windowLen);
                }
                const toRead = Math.min(_windowSize - windowLen, fileSize - filePos);
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
                result = deserializeEvent(view, relOffset, fileVersion);
            } catch (e) {
                log.warn({ err: e, fileOffset: windowStart + relOffset, sessionId },
                    `Decode error at file offset ${windowStart + relOffset}: ${e.message}`);
                break;
            }

            if (!result || result.nextOffset <= relOffset) break;

            relOffset = result.nextOffset;

            const { event } = result;
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
                    const vid = internValue(sv, vdBatch);
                    writeBatch.push([eventId, sessionId, w.name ?? null, vid, w.omitted ? 1 : 0]);
                    if (!w.omitted) pushVI(eventId, sv, w.name, 'write');
                    // 方向三：v2 格式时，write.oid != null 表示写入值是对象引用
                    // 记录到 oid_aliases 表（UNIQUE，同一变量只记最早出现的）
                    if (w.oid != null && w.name && w.name !== '(return)' && w.name !== '(throw)') {
                        oidAliasBatch.push([sessionId, w.oid, w.name, eventId]);
                    }
                }
            }
            if (event.reads?.length > 0) {
                for (const r of event.reads) {
                    const sv = serializeValue(r.value);
                    const vid = internValue(sv, vdBatch);
                    readBatch.push([eventId, sessionId, r.name ?? null, vid, r.omitted ? 1 : 0]);
                    if (!r.omitted) pushVI(eventId, sv, r.name, 'read');
                }
            }

            // CALL_PRE 事件：把 event.fn（被调函数名）写入 reads 表（name='callee'）
            // F3_CallGraphBuilder 依赖此字段来识别函数名；若缺失则降级为 fn@<iid>
            if (event.type === 'CALL_PRE') {
                if (event.fn) {
                    const sv = JSON.stringify(event.fn);
                    const vid = internValue(sv, vdBatch);
                    readBatch.push([eventId, sessionId, 'callee', vid, 0]);
                }
                // fnDefIid：函数定义点 iid（同一函数体每次调用相同），存入 reads 表（name='callee_def_iid'）
                // F3_CallGraphBuilder 依赖此字段填充 call_edges.fn_def_iid，用于唯一标识函数体
                if (event.fnDefIid !== undefined && event.fnDefIid !== null) {
                    const sv = String(event.fnDefIid);
                    const vid = internValue(sv, vdBatch);
                    readBatch.push([eventId, sessionId, 'callee_def_iid', vid, 0]);
                }
                // 把参数列表写入 writes 表（name='arg0','arg1',...），F3 读取 args 时依赖此数据
                if (event.args?.length > 0) {
                    const argc = Math.min(event.args.length, 8);
                    for (let i = 0; i < argc; i++) {
                        const v = event.args[i];
                        const sv = serializeValue(v);
                        const vid = internValue(sv, vdBatch);
                        writeBatch.push([eventId, sessionId, `arg${i}`, vid, v === undefined ? 1 : 0]);
                    }
                }
            }

            // CALL 事件：把返回值写入 writes 表（name='return'）
            // F3_CallGraphBuilder 依赖此字段（retMap）填充 call_edges.return_value
            if (event.type === 'CALL') {
                // result===undefined 表示被 omitted（值太大被截断），仍写一行以标记存在
                const omitted = event.result === undefined ? 1 : 0;
                const sv = serializeValue(event.result);
                const vid = internValue(sv, vdBatch);
                writeBatch.push([eventId, sessionId, 'return', vid, omitted]);
            }
            if (event.fields?.length > 0) {
                for (const f of event.fields) {
                    const sv = serializeValue(f.value);
                    const vid = internValue(sv, vdBatch);
                    fieldBatch.push([
                        eventId, sessionId,
                        f.offset ?? null,
                        f.isWrite ? 1 : 0,
                        vid,
                        f.omitted ? 1 : 0,
                        f.baseOid ?? null,
                    ]);
                }
            }

            if (eventBatch.length >= _batchSize) {
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

                if (batchCount % _yieldEveryBatches === 0) {
                    await setImmediateAsync();
                }
            }
        }

        flush();
        closeSync(fd);

        // 清理临时解压文件（如有）
        if (tmpBinPath) {
            try { unlinkSync(tmpBinPath); } catch (e) {
                log.warn({ tmpBinPath, err: e }, 'Failed to delete temp decompressed file');
            }
        }

        // 恢复外键约束
        rawDb.pragma('foreign_keys = ON');

        db.run('UPDATE sessions SET event_count = ? WHERE id = ?', totalEvents, sessionId);

        this.emitProgress(ctx, `完成，共 ${totalEvents} 条事件`, 100);

        // 补充分项计数（数据已写入 DB，一次聚合查询）
        let writeCount = 0, readCount = 0, fieldCount = 0, valueDictCnt = 0;
        try {
            const rows = rawDb.prepare(`
                SELECT 'wr' k, COUNT(*) v FROM writes     WHERE session_id = ?
                UNION ALL
                SELECT 'rd', COUNT(*)    FROM reads       WHERE session_id = ?
                UNION ALL
                SELECT 'fd', COUNT(*)    FROM fields      WHERE session_id = ?
                UNION ALL
                SELECT 'vd', COUNT(*)    FROM value_dict  WHERE session_id = ?
            `).all(sessionId, sessionId, sessionId, sessionId);
            const m = Object.fromEntries(rows.map(r => [r.k, r.v]));
            writeCount   = m.wr ?? 0;
            readCount    = m.rd ?? 0;
            fieldCount   = m.fd ?? 0;
            valueDictCnt = m.vd ?? 0;
        } catch { /* 非致命，保持默认 0 */ }

        this.emitDone(ctx, { eventCount: totalEvents, writeCount, readCount, fieldCount, valueDictCnt });
    }
}

/**
 * 将运行时值序列化为 JSON 字符串存入 DB。
 * fast-path：基础类型直接 JSON.stringify，跳过 try/catch（V8 JIT 友好）。
 * 仅 object/function 类型才走 try/catch 防止循环引用抛出。
 *
 * TYPED_ARRAY 特殊处理：readValue() 解码后返回格式为 "[TypeName(N):MB:hexpreview]" 的字符串，
 * 此处直接 JSON.stringify 包裹（加引号）存入 DB，保留可读性。
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
