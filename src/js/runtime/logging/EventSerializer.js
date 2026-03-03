// JALANGI DO NOT INSTRUMENT

/**
 * EventSerializer — 将 Jalangi 事件对象序列化为紧凑格式。
 *
 * 支持两种格式：
 *
 * 1. NDJSON（默认，调试友好）
 *    每条事件序列化为一行 JSON + '\n'，多条事件拼接为一个字符串块。
 *    适合：WsBackend（文本帧）、NodeStreamBackend（日志文件）
 *
 * 2. Binary（紧凑，高吞吐）
 *    自定义二进制编码，每条事件占 ~16 字节固定头 + 可选变长负载。
 *    头部格式（小端序）：
 *      [0]    u8   事件类型（EVENT_TYPE.*）
 *      [1]    u8   flags（含有效字段位掩码）
 *      [2..5] u32  iid
 *      [6..9] u32  sid
 *      [10]   u8   值类型（VALUE_TYPE.*）
 *      [11]   u8   保留
 *      [12..15] u32 变长负载长度（0 = 无负载）
 *      [16..]  变长负载（UTF-8 字符串或 f64 8字节）
 *    适合：WsBackend（二进制帧）、IdbWorkerBackend
 *
 * 事件类型枚举（EVENT_TYPE）与 JalangiRuntime.js 钩子一一对应：
 *   read / write / getField / putField / binary / unary / literal
 *   declare / invokeFun / functionEnter / functionExit
 *   scriptEnter / scriptExit / conditional / endExpression
 */

// ─── 事件类型常量 ─────────────────────────────────────────────────────────────

export const EVENT_TYPE = Object.freeze({
    READ:            0x01,
    WRITE:           0x02,
    GET_FIELD:       0x03,
    PUT_FIELD:       0x04,
    BINARY:          0x05,
    UNARY:           0x06,
    LITERAL:         0x07,
    DECLARE:         0x08,
    INVOKE_FUN_PRE:  0x09,
    INVOKE_FUN:      0x0A,
    FUNCTION_ENTER:  0x0B,
    FUNCTION_EXIT:   0x0C,
    SCRIPT_ENTER:    0x0D,
    SCRIPT_EXIT:     0x0E,
    CONDITIONAL:     0x0F,
    END_EXPRESSION:  0x10,
});

// 反向映射（用于反序列化）
export const EVENT_TYPE_NAME = Object.fromEntries(
    Object.entries(EVENT_TYPE).map(([k, v]) => [v, k])
);

// ─── 值类型常量（二进制编码时描述 payload 格式）────────────────────────────

const VALUE_TYPE = Object.freeze({
    NONE:      0x00,
    NULL:      0x01,
    UNDEFINED: 0x02,
    BOOL_T:    0x03,
    BOOL_F:    0x04,
    NUMBER:    0x05,   // 负载 = 8 字节 float64
    STRING:    0x06,   // 负载 = UTF-8 字节
    OBJECT:    0x07,   // 负载 = JSON 字符串（回退）
    FUNCTION:  0x08,   // 负载 = 函数名（可为空串）
});

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** 将 JS 值分类为 VALUE_TYPE，并返回用于负载的原始数据 */
function classifyValue(v) {
    if (v === null)      return { type: VALUE_TYPE.NULL,      payload: null };
    if (v === undefined) return { type: VALUE_TYPE.UNDEFINED, payload: null };
    const t = typeof v;
    if (t === 'boolean') return { type: v ? VALUE_TYPE.BOOL_T : VALUE_TYPE.BOOL_F, payload: null };
    if (t === 'number')  return { type: VALUE_TYPE.NUMBER,  payload: v };
    if (t === 'string')  return { type: VALUE_TYPE.STRING,  payload: v };
    if (t === 'function') {
        return { type: VALUE_TYPE.FUNCTION, payload: v.name ?? '' };
    }
    // 对象：尝试简单 JSON，失败则用 '[object]'
    let s;
    try { s = JSON.stringify(v); } catch { s = '[object]'; }
    return { type: VALUE_TYPE.OBJECT, payload: s };
}

/** 安全地将值转为 JSON-safe 形式（用于 NDJSON 格式） */
function safeValue(v) {
    if (v === undefined)  return '__undefined__';
    if (v === null)       return null;
    const t = typeof v;
    if (t === 'boolean' || t === 'number' || t === 'string') return v;
    if (t === 'function') return `[Function:${v.name ?? ''}]`;
    try { return JSON.parse(JSON.stringify(v)); } catch { return '[object]'; }
}

// ─── NDJSON 序列化 ─────────────────────────────────────────────────────────────

/**
 * 将单条事件序列化为 JSON 字符串（不含换行）。
 * @param {object} event  LogManager 压入的事件对象
 * @returns {string}
 */
export function serializeEventToJSON(event) {
    // 对值字段做安全处理，避免循环引用导致 JSON.stringify 崩溃
    const safe = {};
    for (const key of Object.keys(event)) {
        const v = event[key];
        safe[key] = safeValue(v);
    }
    return JSON.stringify(safe);
}

/**
 * 将事件数组序列化为 NDJSON 文本块（每条一行，最后无多余换行）。
 * @param {Array} events
 * @returns {string}
 */
export function serializeBatchToNDJSON(events) {
    const lines = new Array(events.length);
    for (let i = 0; i < events.length; i++) {
        lines[i] = serializeEventToJSON(events[i]);
    }
    return lines.join('\n') + '\n';
}

// ─── 二进制序列化 ──────────────────────────────────────────────────────────────

const HEADER_SIZE = 16;  // 字节

/**
 * 将单条事件序列化为 ArrayBuffer（二进制格式）。
 * @param {object} event
 * @returns {ArrayBuffer}
 */
export function serializeEventToBinary(event) {
    const { type, iid = 0, sid = 0, value } = event;
    const eventTypeByte = EVENT_TYPE[type] ?? 0xFF;

    const { type: vType, payload } = classifyValue(value);

    // 计算 payload 字节数
    let payloadBytes = null;
    let payloadLen   = 0;

    if (vType === VALUE_TYPE.NUMBER) {
        payloadLen = 8;
    } else if (vType === VALUE_TYPE.STRING || vType === VALUE_TYPE.OBJECT || vType === VALUE_TYPE.FUNCTION) {
        if (te) {
            payloadBytes = te.encode(payload ?? '');
        } else {
            // Node.js fallback
            payloadBytes = Buffer.from(payload ?? '', 'utf8');
        }
        payloadLen = payloadBytes.byteLength ?? payloadBytes.length;
    }

    const buf = new ArrayBuffer(HEADER_SIZE + payloadLen);
    const view = new DataView(buf);

    view.setUint8(0,  eventTypeByte);
    view.setUint8(1,  0);                 // flags（保留）
    view.setUint32(2, iid >>> 0, true);   // 小端
    view.setUint32(6, sid >>> 0, true);
    view.setUint8(10, vType);
    view.setUint8(11, 0);                 // 保留
    view.setUint32(12, payloadLen, true);

    if (payloadLen > 0) {
        if (vType === VALUE_TYPE.NUMBER) {
            view.setFloat64(HEADER_SIZE, payload, true);
        } else if (payloadBytes) {
            const dest = new Uint8Array(buf, HEADER_SIZE);
            dest.set(payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes.buffer ?? payloadBytes));
        }
    }

    return buf;
}

/**
 * 将事件数组序列化为单个合并的 ArrayBuffer（头部 4 字节 = 事件数量）。
 * 格式：[u32 count][u32 size0][buf0][u32 size1][buf1]...
 * @param {Array} events
 * @returns {ArrayBuffer}
 */
export function serializeBatchToBinary(events) {
    // 第一遍：序列化每条，收集 ArrayBuffer
    const bufs = events.map(serializeEventToBinary);

    // 计算总大小：4（count）+ 每条 4（长度前缀）+ 每条数据
    let total = 4;
    for (const b of bufs) total += 4 + b.byteLength;

    const out  = new ArrayBuffer(total);
    const view = new DataView(out);
    let offset = 0;

    view.setUint32(offset, bufs.length, true);
    offset += 4;

    for (const b of bufs) {
        view.setUint32(offset, b.byteLength, true);
        offset += 4;
        new Uint8Array(out, offset).set(new Uint8Array(b));
        offset += b.byteLength;
    }

    return out;
}

// ─── 二进制反序列化（用于服务端 / 测试）──────────────────────────────────────

const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/**
 * 从 ArrayBuffer 偏移处反序列化一条事件。
 * @param {DataView} view
 * @param {number}   offset
 * @returns {{ event: object, nextOffset: number }}
 */
export function deserializeEventFromBinary(view, offset) {
    const eventTypeByte = view.getUint8(offset);
    // flags             = view.getUint8(offset + 1);
    const iid           = view.getUint32(offset + 2, true);
    const sid           = view.getUint32(offset + 6, true);
    const vType         = view.getUint8(offset + 10);
    const payloadLen    = view.getUint32(offset + 12, true);
    const dataOffset    = offset + HEADER_SIZE;

    let value;
    switch (vType) {
        case VALUE_TYPE.NULL:      value = null;      break;
        case VALUE_TYPE.UNDEFINED: value = undefined; break;
        case VALUE_TYPE.BOOL_T:    value = true;      break;
        case VALUE_TYPE.BOOL_F:    value = false;     break;
        case VALUE_TYPE.NUMBER:
            value = view.getFloat64(dataOffset, true);
            break;
        case VALUE_TYPE.STRING:
        case VALUE_TYPE.OBJECT:
        case VALUE_TYPE.FUNCTION: {
            const raw = new Uint8Array(view.buffer, dataOffset, payloadLen);
            value = td ? td.decode(raw) : Buffer.from(raw).toString('utf8');
            break;
        }
        default: value = undefined;
    }

    return {
        event: {
            type:  EVENT_TYPE_NAME[eventTypeByte] ?? 'UNKNOWN',
            iid,
            sid,
            value,
        },
        nextOffset: dataOffset + payloadLen,
    };
}

/**
 * 反序列化 serializeBatchToBinary 产生的批次 ArrayBuffer。
 * @param {ArrayBuffer} buf
 * @returns {Array<object>}  事件数组
 */
export function deserializeBatchFromBinary(buf) {
    const view   = new DataView(buf);
    const count  = view.getUint32(0, true);
    const events = new Array(count);
    let offset   = 4;

    for (let i = 0; i < count; i++) {
        const size    = view.getUint32(offset, true);
        offset       += 4;
        const subView = new DataView(buf, offset, size);
        // 重建一个完整的 DataView（共享 buffer）
        const { event } = deserializeEventFromBinary(new DataView(buf), offset);
        events[i] = event;
        offset   += size;
    }

    return events;
}
