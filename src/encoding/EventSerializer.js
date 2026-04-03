// JALANGI DO NOT INSTRUMENT

/**
 * EventSerializer — 将 ExecutionTrace 事件序列化为紧凑二进制格式。
 *
 * ## 设计目标
 *
 *   轻运行时、重后处理：运行时只做最小信息写入，所有格式化/渲染交由后处理工具完成。
 *
 * ## 二进制格式（Jani Trace Binary v1，.bin 文件）
 *
 * ### 文件魔数
 *   前 4 字节：0x4A 0x54 0x42 0x31（ASCII "JTB1"）
 *
 * ### 事件头（12 字节，定长，小端序）
 *
 *   [0]     u8   eventType   — 事件类型（EVENT_TYPE.*）
 *   [1]     u8   flags       — 位标志（FLAGS.*）
 *   [2..5]  u32  iid         — 指令 ID（对应 smap.json 中的 iid 条目）
 *   [6..9]  u32  seq         — 事件序号（全局单调递增）
 *   [10..11] u16  payloadLen — 本事件 payload 字节数（0 = 无 payload）
 *
 * ### Payload（变长，紧跟头部）
 *
 *   payload 的内容由 eventType + flags 决定，详见各 encodeXxx 函数。
 *   payload 中的值使用 encodeValue() 编码：
 *
 *     [0]   u8  valueType  (VALUE_TYPE.*)
 *     后续字节（依 valueType）：
 *       OMITTED   → 无后续（值可通过 smap.defIid 追溯）
 *       NULL      → 无后续
 *       UNDEFINED → 无后续
 *       BOOL_T/F  → 无后续
 *       INT32     → 4 字节 i32（小端）
 *       FLOAT64   → 8 字节 f64（小端）
 *       STRING    → u16 长度 + UTF-8 字节
 *       OBJECT    → u16 长度 + JSON UTF-8 字节
 *       FUNCTION  → u8 名称长度 + ASCII 字节（最长 255）
 *
 * ### 批次格式（流式写入，NodeStreamBackend 使用）
 *
 *   文件头：[魔数 4B][版本 u8 = 0x01][保留 3B]
 *   随后：事件头12B + payloadLen字节 连续排列，直到文件末尾
 *
 * ## 事件类型
 *
 *   SCRIPT_ENTER    = 0x01   payload: [filename_str]
 *   SCRIPT_EXIT     = 0x02   payload: [flags.hasException → exception_val]
 *   CALL_PRE        = 0x03   payload: [fnName_str][argc u8][arg0_val]...[argN_val]
 *                                     flags.isConstructor / flags.isMethod
 *                                     flags.hasThis → [this_val]
 *   CALL            = 0x04   payload: [fnName_str][result_val]
 *   FUNCTION_ENTER  = 0x05   无 payload
 *   FUNCTION_EXIT   = 0x06   payload: [flags.hasException → exception_val]
 *   END_EXPR        = 0x07   payload: [write_count u8]([name_str][val])*
 *                                     [read_count u8]([name_str][val])*  ← val 可能是 OMITTED
 *                                     [field_count u8]([base_str][offset_str][isWrite u8][val])*
 *   KEY_EVENT       = 0x08   payload: [level u8][text_str]
 *
 * ## 值省略（fai 优化）
 *
 *   当静态分析确定某 read-site 对应唯一 def-site 时（Decision.LIGHTWEIGHT），
 *   值编码为 VALUE_TYPE.OMITTED。
 *   后处理工具加载 smap.json 后，通过 smap[iid].defIid 追溯到对应 write 事件的值。
 */

// ─── 魔数 & 版本 ──────────────────────────────────────────────────────────────

/** 文件魔数：ASCII "JTB1" */
export const MAGIC = new Uint8Array([0x4A, 0x54, 0x42, 0x31]);
export const FORMAT_VERSION = 0x01;

/** 文件头大小（魔数 4B + 版本 1B + 保留 3B = 8B） */
export const FILE_HEADER_SIZE = 8;

/** 事件头大小（12 字节） */
export const EVENT_HEADER_SIZE = 12;

// ─── 事件类型常量 ─────────────────────────────────────────────────────────────

export const EVENT_TYPE = Object.freeze({
    SCRIPT_ENTER:   0x01,
    SCRIPT_EXIT:    0x02,
    CALL_PRE:       0x03,
    CALL:           0x04,
    FUNCTION_ENTER: 0x05,
    FUNCTION_EXIT:  0x06,
    END_EXPR:       0x07,
    KEY_EVENT:      0x08,
    // 保留给未来扩展
    WRITE_VAR:      0x09,  // 单独写变量事件（低频路径，如 declare）
    READ_VAR_FULL:  0x0A,  // fai 路径的读取（含实际值）
});

/** 事件类型反向映射（用于调试/解码） */
export const EVENT_TYPE_NAME = Object.fromEntries(
    Object.entries(EVENT_TYPE).map(([k, v]) => [v, k])
);

// ─── flags 位掩码 ──────────────────────────────────────────────────────────────

export const FLAGS = Object.freeze({
    HAS_EXCEPTION:  0x01,  // CALL / FUNCTION_EXIT：有异常值
    IS_CONSTRUCTOR: 0x02,  // CALL_PRE：new 调用
    IS_METHOD:      0x04,  // CALL_PRE：方法调用（base = this）
    HAS_THIS:       0x08,  // CALL_PRE：包含 this 值
    VALUE_OMITTED:  0x10,  // 通用：值已省略（可通过 smap.defIid 追溯）
    IS_WRITE:       0x20,  // field 条目：属性写入
    DIRECT_FE:      0x40,  // FUNCTION_ENTER：无 callPre 覆盖（直接调用）
});

// ─── 值类型常量 ────────────────────────────────────────────────────────────────

export const VALUE_TYPE = Object.freeze({
    OMITTED:   0x00,  // 值省略（可追溯），无后续字节
    NULL:      0x01,  // null，无后续字节
    UNDEFINED: 0x02,  // undefined，无后续字节
    BOOL_T:    0x03,  // true，无后续字节
    BOOL_F:    0x04,  // false，无后续字节
    INT32:     0x05,  // 整数，4 字节 i32（小端）— 整数优化
    FLOAT64:   0x06,  // 浮点数，8 字节 f64（小端）
    STRING:    0x07,  // 字符串，u16 长度 + UTF-8
    OBJECT:    0x08,  // 对象 JSON，u16 长度 + UTF-8
    FUNCTION:  0x09,  // 函数，u8 名称长度 + ASCII
});

// ─── 编码工具 ──────────────────────────────────────────────────────────────────

const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/**
 * 将 UTF-8 字符串编码为字节数组
 * @param {string} s
 * @returns {Uint8Array}
 */
function encodeUtf8(s) {
    if (te) return te.encode(s);
    // Node.js fallback
    const buf = Buffer.from(s, 'utf8');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * 从 DataView 指定偏移处读取 UTF-8 字符串（u16 长度前缀）
 * @param {DataView} view
 * @param {number}   offset
 * @returns {{ str: string, end: number }}
 */
function readUtf8u16(view, offset) {
    const len = view.getUint16(offset, true);
    offset += 2;
    const bytes = new Uint8Array(view.buffer, offset, len);
    const str = td ? td.decode(bytes) : Buffer.from(bytes).toString('utf8');
    return { str, end: offset + len };
}

/**
 * 从 DataView 指定偏移处读取 UTF-8 字符串（u8 长度前缀）
 * @param {DataView} view
 * @param {number}   offset
 * @returns {{ str: string, end: number }}
 */
function readUtf8u8(view, offset) {
    const len = view.getUint8(offset);
    offset += 1;
    const bytes = new Uint8Array(view.buffer, offset, len);
    const str = td ? td.decode(bytes) : Buffer.from(bytes).toString('utf8');
    return { str, end: offset + len };
}

/**
 * 计算将一个值编码为 VALUE_TYPE 序列所需的字节数（不含 valueType 字节本身）。
 * @param {*} v
 * @param {boolean} [omit=false]  是否省略值（LIGHTWEIGHT 路径）
 * @returns {{ vt: number, extraBytes: number, strBytes?: Uint8Array }}
 */
function measureValue(v, omit = false) {
    if (omit) return { vt: VALUE_TYPE.OMITTED, extraBytes: 0 };
    if (v === null)      return { vt: VALUE_TYPE.NULL,      extraBytes: 0 };
    if (v === undefined) return { vt: VALUE_TYPE.UNDEFINED, extraBytes: 0 };
    if (v === true)      return { vt: VALUE_TYPE.BOOL_T,    extraBytes: 0 };
    if (v === false)     return { vt: VALUE_TYPE.BOOL_F,    extraBytes: 0 };
    const t = typeof v;
    if (t === 'number') {
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
            return { vt: VALUE_TYPE.INT32, extraBytes: 4 };
        }
        return { vt: VALUE_TYPE.FLOAT64, extraBytes: 8 };
    }
    if (t === 'function') {
        const name = v.name ?? '';
        const nb   = encodeUtf8(name.slice(0, 255));
        return { vt: VALUE_TYPE.FUNCTION, extraBytes: 1 + nb.length, strBytes: nb };
    }
    if (t === 'string') {
        const nb = encodeUtf8(v.length > 256 ? v.slice(0, 255) + '…' : v);
        return { vt: VALUE_TYPE.STRING, extraBytes: 2 + nb.length, strBytes: nb };
    }
    // 对象
    let s;
    try { s = JSON.stringify(v); } catch { s = '[object]'; }
    if (s === undefined) s = '[object]';
    const nb = encodeUtf8(s.length > 256 ? s.slice(0, 255) + '…' : s);
    return { vt: VALUE_TYPE.OBJECT, extraBytes: 2 + nb.length, strBytes: nb };
}

/**
 * 计算字符串编码为 u16+UTF8 所需字节数。
 * @param {string} s
 * @returns {{ bytes: number, nb: Uint8Array }}
 */
function measureStr(s) {
    const nb = encodeUtf8(s.length > 65535 ? s.slice(0, 65534) + '…' : s);
    return { bytes: 2 + nb.length, nb };
}

/**
 * 将值写入 DataView，返回写入后的新 offset。
 * @param {DataView} view
 * @param {number}   offset
 * @param {{ vt: number, extraBytes: number, strBytes?: Uint8Array }} measured
 * @param {*}        v
 * @returns {number}  新 offset
 */
function writeValue(view, offset, measured, v) {
    view.setUint8(offset, measured.vt);
    offset += 1;
    switch (measured.vt) {
        case VALUE_TYPE.OMITTED:
        case VALUE_TYPE.NULL:
        case VALUE_TYPE.UNDEFINED:
        case VALUE_TYPE.BOOL_T:
        case VALUE_TYPE.BOOL_F:
            break;
        case VALUE_TYPE.INT32:
            view.setInt32(offset, v | 0, true);
            offset += 4;
            break;
        case VALUE_TYPE.FLOAT64:
            view.setFloat64(offset, v, true);
            offset += 8;
            break;
        case VALUE_TYPE.FUNCTION: {
            const nb = measured.strBytes;
            view.setUint8(offset, nb.length);
            offset += 1;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(nb);
            offset += nb.length;
            break;
        }
        case VALUE_TYPE.STRING:
        case VALUE_TYPE.OBJECT: {
            const nb = measured.strBytes;
            view.setUint16(offset, nb.length, true);
            offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(nb);
            offset += nb.length;
            break;
        }
    }
    return offset;
}

/**
 * 读取一个值，返回 JS 值和新 offset。
 * @param {DataView} view
 * @param {number}   offset
 * @returns {{ value: *, omitted: boolean, end: number }}
 */
function readValue(view, offset) {
    const vt = view.getUint8(offset);
    offset += 1;
    let value;
    let omitted = false;
    switch (vt) {
        case VALUE_TYPE.OMITTED:
            omitted = true;
            value = undefined;
            break;
        case VALUE_TYPE.NULL:
            value = null;
            break;
        case VALUE_TYPE.UNDEFINED:
            value = undefined;
            break;
        case VALUE_TYPE.BOOL_T:
            value = true;
            break;
        case VALUE_TYPE.BOOL_F:
            value = false;
            break;
        case VALUE_TYPE.INT32:
            value = view.getInt32(offset, true);
            offset += 4;
            break;
        case VALUE_TYPE.FLOAT64:
            value = view.getFloat64(offset, true);
            offset += 8;
            break;
        case VALUE_TYPE.FUNCTION: {
            const r = readUtf8u8(view, offset);
            value = `[Function:${r.str}]`;
            offset = r.end;
            break;
        }
        case VALUE_TYPE.STRING: {
            const r = readUtf8u16(view, offset);
            value = r.str;
            offset = r.end;
            break;
        }
        case VALUE_TYPE.OBJECT: {
            const r = readUtf8u16(view, offset);
            try { value = JSON.parse(r.str); } catch { value = r.str; }
            offset = r.end;
            break;
        }
        default:
            value = undefined;
    }
    return { value, omitted, end: offset };
}

// ─── 事件序列化 ────────────────────────────────────────────────────────────────

/**
 * 计算单条事件所需的 payload 字节数，返回序列化所需的中间结构。
 * 分两步（measure + write）避免两次 TextEncoder 调用。
 *
 * @param {object} event  标准化事件对象（字段见各 EVENT_TYPE 说明）
 * @returns {{ payloadSize: number, _m: object }}  _m 为中间测量结果（供 writeEventPayload 使用）
 */
function measureEvent(event) {
    const { type, iid = 0, seq = 0 } = event;

    switch (type) {
        case 'SCRIPT_ENTER': {
            const { bytes: fnb, nb: fnBytes } = measureStr(event.file ?? '');
            return { payloadSize: fnb, _m: { fnBytes } };
        }

        case 'SCRIPT_EXIT': {
            const hasEx = event.exception !== undefined && event.exception !== null;
            if (!hasEx) return { payloadSize: 0, _m: { hasEx } };
            const mv = measureValue(event.exception);
            return { payloadSize: 1 + mv.extraBytes, _m: { hasEx, mv, exVal: event.exception } };
        }

        case 'CALL_PRE': {
            const fnName = (event.fn ?? '').slice(0, 255);
            const { bytes: fnb, nb: fnBytes } = measureStr(fnName);
            const args   = event.args ?? [];
            const argc   = Math.min(args.length, 8);  // 最多记录8个参数
            let argsSize = 0;
            const argMeasures = [];
            for (let i = 0; i < argc; i++) {
                const mv = measureValue(args[i]);
                argsSize += 1 + mv.extraBytes;  // valueType + extra
                argMeasures.push(mv);
            }
            const hasThis = event.isMethod && event.base !== undefined;
            let thisSize = 0;
            let thisMv;
            if (hasThis) {
                thisMv = measureValue(event.base);
                thisSize = 1 + thisMv.extraBytes;
            }
            // payload = fnName(u16+bytes) + argc(u8) + args + [this]
            const payloadSize = fnb + 1 + argsSize + thisSize;
            return { payloadSize, _m: { fnBytes, argc, argMeasures, args, hasThis, thisMv, base: event.base } };
        }

        case 'CALL': {
            const fnName = (event.fn ?? '').slice(0, 255);
            const { bytes: fnb, nb: fnBytes } = measureStr(fnName);
            const mv = measureValue(event.result);
            return { payloadSize: fnb + 1 + mv.extraBytes, _m: { fnBytes, mv, result: event.result } };
        }

        case 'FUNCTION_ENTER':
            return { payloadSize: 0, _m: {} };

        case 'FUNCTION_EXIT': {
            const hasEx = !!(event.exception);
            if (!hasEx) return { payloadSize: 0, _m: { hasEx } };
            const mv = measureValue(event.exception);
            return { payloadSize: 1 + mv.extraBytes, _m: { hasEx, mv, exVal: event.exception } };
        }

        case 'END_EXPR': {
            // writes: [{name, val, omit?}]
            // reads:  [{name, val, omit?}]
            // fields: [{base, offset, val, isWrite}]
            const writes = event.writes ?? [];
            const reads  = event.reads  ?? [];
            const fields = event.fields ?? [];
            let size = 1 + 1 + 1;  // writeCount + readCount + fieldCount (all u8)
            const wm = [], rm = [], fm = [];
            for (const w of writes) {
                const { bytes: nb, nb: nameBytes } = measureStr(w.name);
                const mv = measureValue(w.val, w.omit === true);
                size += nb + 1 + mv.extraBytes;
                wm.push({ nameBytes, mv, val: w.val, omit: w.omit });
            }
            for (const r of reads) {
                const { bytes: nb, nb: nameBytes } = measureStr(r.name);
                const mv = measureValue(r.val, r.omit === true);
                size += nb + 1 + mv.extraBytes;
                rm.push({ nameBytes, mv, val: r.val, omit: r.omit });
            }
            for (const f of fields) {
                const { bytes: bnb, nb: baseBytes } = measureStr(f.base ?? '');
                const { bytes: onb, nb: offsetBytes } = measureStr(String(f.offset ?? ''));
                const mv = measureValue(f.val);
                size += bnb + onb + 1 + 1 + mv.extraBytes;  // base + offset + isWrite(u8) + val
                fm.push({ baseBytes, offsetBytes, mv, val: f.val, isWrite: f.isWrite });
            }
            return { payloadSize: size, _m: { writes, reads, fields, wm, rm, fm } };
        }

        case 'KEY_EVENT': {
            const level = event.level === 'error' ? 2 : event.level === 'warn' ? 1 : 0;
            const { bytes: tnb, nb: textBytes } = measureStr(event.text ?? '');
            return { payloadSize: 1 + tnb, _m: { level, textBytes } };
        }

        case 'WRITE_VAR': {
            const { bytes: nb, nb: nameBytes } = measureStr(event.name ?? '');
            const mv = measureValue(event.val);
            return { payloadSize: nb + 1 + mv.extraBytes, _m: { nameBytes, mv, val: event.val } };
        }

        case 'READ_VAR_FULL': {
            const { bytes: nb, nb: nameBytes } = measureStr(event.name ?? '');
            const mv = measureValue(event.val);
            return { payloadSize: nb + 1 + mv.extraBytes, _m: { nameBytes, mv, val: event.val } };
        }

        default:
            return { payloadSize: 0, _m: {} };
    }
}

/**
 * 将事件 payload 写入 DataView（从 offset 开始），返回新 offset。
 * @param {DataView} view
 * @param {number}   offset
 * @param {string}   type
 * @param {object}   _m  来自 measureEvent 的中间结果
 * @returns {number}
 */
function writePayload(view, offset, type, _m) {
    switch (type) {
        case 'SCRIPT_ENTER': {
            view.setUint16(offset, _m.fnBytes.length, true);
            offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(_m.fnBytes);
            offset += _m.fnBytes.length;
            break;
        }

        case 'SCRIPT_EXIT': {
            if (_m.hasEx) {
                offset = writeValue(view, offset, _m.mv, _m.exVal);
            }
            break;
        }

        case 'CALL_PRE': {
            // fnName (u16 + bytes)
            view.setUint16(offset, _m.fnBytes.length, true);
            offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(_m.fnBytes);
            offset += _m.fnBytes.length;
            // argc
            view.setUint8(offset, _m.argc);
            offset += 1;
            // args
            for (let i = 0; i < _m.argc; i++) {
                offset = writeValue(view, offset, _m.argMeasures[i], _m.args[i]);
            }
            // this（可选）
            if (_m.hasThis) {
                offset = writeValue(view, offset, _m.thisMv, _m.base);
            }
            break;
        }

        case 'CALL': {
            view.setUint16(offset, _m.fnBytes.length, true);
            offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(_m.fnBytes);
            offset += _m.fnBytes.length;
            offset = writeValue(view, offset, _m.mv, _m.result);
            break;
        }

        case 'FUNCTION_ENTER':
            break;

        case 'FUNCTION_EXIT': {
            if (_m.hasEx) {
                offset = writeValue(view, offset, _m.mv, _m.exVal);
            }
            break;
        }

        case 'END_EXPR': {
            view.setUint8(offset, _m.writes.length);   offset += 1;
            view.setUint8(offset, _m.reads.length);    offset += 1;
            view.setUint8(offset, _m.fields.length);   offset += 1;
            for (const w of _m.wm) {
                view.setUint16(offset, w.nameBytes.length, true);  offset += 2;
                new Uint8Array(view.buffer, view.byteOffset + offset).set(w.nameBytes);
                offset += w.nameBytes.length;
                offset = writeValue(view, offset, w.mv, w.val);
            }
            for (const r of _m.rm) {
                view.setUint16(offset, r.nameBytes.length, true);  offset += 2;
                new Uint8Array(view.buffer, view.byteOffset + offset).set(r.nameBytes);
                offset += r.nameBytes.length;
                offset = writeValue(view, offset, r.mv, r.val);
            }
            for (const f of _m.fm) {
                view.setUint16(offset, f.baseBytes.length, true);  offset += 2;
                new Uint8Array(view.buffer, view.byteOffset + offset).set(f.baseBytes);
                offset += f.baseBytes.length;
                view.setUint16(offset, f.offsetBytes.length, true);  offset += 2;
                new Uint8Array(view.buffer, view.byteOffset + offset).set(f.offsetBytes);
                offset += f.offsetBytes.length;
                view.setUint8(offset, f.isWrite ? 1 : 0);  offset += 1;
                offset = writeValue(view, offset, f.mv, f.val);
            }
            break;
        }

        case 'KEY_EVENT': {
            view.setUint8(offset, _m.level);
            offset += 1;
            view.setUint16(offset, _m.textBytes.length, true);
            offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(_m.textBytes);
            offset += _m.textBytes.length;
            break;
        }

        case 'WRITE_VAR':
        case 'READ_VAR_FULL': {
            view.setUint16(offset, _m.nameBytes.length, true);  offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset).set(_m.nameBytes);
            offset += _m.nameBytes.length;
            offset = writeValue(view, offset, _m.mv, _m.val);
            break;
        }
    }
    return offset;
}

/**
 * 计算 EVENT_TYPE 字节和 flags 字节。
 * @param {object} event
 * @returns {{ typeByte: number, flagsByte: number }}
 */
function computeTypeAndFlags(event) {
    const typeByte = EVENT_TYPE[event.type] ?? 0xFF;
    let flagsByte = 0;

    if (event.type === 'SCRIPT_EXIT' || event.type === 'FUNCTION_EXIT') {
        if (event.exception !== undefined && event.exception !== null) {
            flagsByte |= FLAGS.HAS_EXCEPTION;
        }
    }
    if (event.type === 'CALL_PRE') {
        if (event.isConstructor) flagsByte |= FLAGS.IS_CONSTRUCTOR;
        if (event.isMethod)      flagsByte |= FLAGS.IS_METHOD;
        if (event.isMethod && event.base !== undefined) flagsByte |= FLAGS.HAS_THIS;
    }
    if (event.type === 'FUNCTION_ENTER' && event.directFe) {
        flagsByte |= FLAGS.DIRECT_FE;
    }

    return { typeByte, flagsByte };
}

/**
 * 将单条事件序列化为 ArrayBuffer（含 12 字节头 + payload）。
 *
 * @param {object} event   标准化事件对象
 * @returns {ArrayBuffer}
 */
export function serializeEvent(event) {
    const { payloadSize, _m } = measureEvent(event);
    const { typeByte, flagsByte } = computeTypeAndFlags(event);
    const totalSize = EVENT_HEADER_SIZE + payloadSize;

    const buf  = new ArrayBuffer(totalSize);
    const view = new DataView(buf);

    // 写头部（12 字节）
    view.setUint8(0, typeByte);
    view.setUint8(1, flagsByte);
    view.setUint32(2, (event.iid ?? 0) >>> 0, true);
    view.setUint32(6, (event.seq ?? 0) >>> 0, true);
    view.setUint16(10, payloadSize, true);

    // 写 payload
    writePayload(view, EVENT_HEADER_SIZE, event.type, _m);

    return buf;
}

/**
 * 将事件批次序列化为单个 ArrayBuffer（事件紧密排列，无分隔符）。
 * 用于 NodeStreamBackend 的批次写入。
 *
 * @param {Array<object>} events
 * @returns {ArrayBuffer}
 */
export function serializeBatch(events) {
    // 第一遍：measure 所有事件
    const measured = new Array(events.length);
    let totalSize = 0;
    for (let i = 0; i < events.length; i++) {
        const m = measureEvent(events[i]);
        const { typeByte, flagsByte } = computeTypeAndFlags(events[i]);
        measured[i] = { ...m, typeByte, flagsByte };
        totalSize += EVENT_HEADER_SIZE + m.payloadSize;
    }

    const buf  = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    let offset = 0;

    // 第二遍：写入
    for (let i = 0; i < events.length; i++) {
        const { payloadSize, _m, typeByte, flagsByte } = measured[i];
        const ev = events[i];

        view.setUint8(offset,     typeByte);
        view.setUint8(offset + 1, flagsByte);
        view.setUint32(offset + 2, (ev.iid ?? 0) >>> 0, true);
        view.setUint32(offset + 6, (ev.seq ?? 0) >>> 0, true);
        view.setUint16(offset + 10, payloadSize, true);
        offset += EVENT_HEADER_SIZE;

        offset = writePayload(view, offset, ev.type, _m);
    }

    return buf;
}

/**
 * 创建文件头 ArrayBuffer（8 字节）。
 * @returns {ArrayBuffer}
 */
export function createFileHeader() {
    const buf  = new ArrayBuffer(FILE_HEADER_SIZE);
    const view = new DataView(buf);
    view.setUint8(0, MAGIC[0]);
    view.setUint8(1, MAGIC[1]);
    view.setUint8(2, MAGIC[2]);
    view.setUint8(3, MAGIC[3]);
    view.setUint8(4, FORMAT_VERSION);
    view.setUint8(5, 0);  // 保留
    view.setUint16(6, 0, true);  // 保留
    return buf;
}

/**
 * 检查 Buffer/ArrayBuffer 是否以 JTB1 魔数开头。
 * @param {ArrayBuffer|Buffer|Uint8Array} buf
 * @returns {boolean}
 */
export function isBinaryTrace(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return bytes.length >= 4
        && bytes[0] === 0x4A
        && bytes[1] === 0x54
        && bytes[2] === 0x42
        && bytes[3] === 0x31;
}

// ─── 事件反序列化 ──────────────────────────────────────────────────────────────

/**
 * 从 DataView 的指定 offset 处反序列化一条事件（含 12 字节头）。
 *
 * @param {DataView} view
 * @param {number}   offset
 * @returns {{ event: object, nextOffset: number }}
 */
export function deserializeEvent(view, offset) {
    const typeByte  = view.getUint8(offset);
    const flagsByte = view.getUint8(offset + 1);
    const iid       = view.getUint32(offset + 2, true);
    const seq       = view.getUint32(offset + 6, true);
    const payloadLen = view.getUint16(offset + 10, true);
    const payloadStart = offset + EVENT_HEADER_SIZE;
    const payloadEnd   = payloadStart + payloadLen;

    const typeName = EVENT_TYPE_NAME[typeByte] ?? 'UNKNOWN';
    let pos = payloadStart;

    const event = { type: typeName, iid, seq };

    switch (typeName) {
        case 'SCRIPT_ENTER': {
            const r = readUtf8u16(view, pos);
            event.file = r.str;
            pos = r.end;
            break;
        }

        case 'SCRIPT_EXIT': {
            if (flagsByte & FLAGS.HAS_EXCEPTION) {
                const r = readValue(view, pos);
                event.exception = r.value;
                pos = r.end;
            }
            break;
        }

        case 'CALL_PRE': {
            event.isConstructor = !!(flagsByte & FLAGS.IS_CONSTRUCTOR);
            event.isMethod      = !!(flagsByte & FLAGS.IS_METHOD);
            const rfn = readUtf8u16(view, pos);
            event.fn = rfn.str;
            pos = rfn.end;
            const argc = view.getUint8(pos);
            pos += 1;
            event.args = [];
            for (let i = 0; i < argc; i++) {
                const r = readValue(view, pos);
                event.args.push(r.omitted ? undefined : r.value);
                pos = r.end;
            }
            if (flagsByte & FLAGS.HAS_THIS) {
                const r = readValue(view, pos);
                event.base = r.value;
                pos = r.end;
            }
            break;
        }

        case 'CALL': {
            const rfn = readUtf8u16(view, pos);
            event.fn = rfn.str;
            pos = rfn.end;
            const r = readValue(view, pos);
            event.result = r.omitted ? undefined : r.value;
            pos = r.end;
            break;
        }

        case 'FUNCTION_ENTER': {
            event.directFe = !!(flagsByte & FLAGS.DIRECT_FE);
            break;
        }

        case 'FUNCTION_EXIT': {
            if (flagsByte & FLAGS.HAS_EXCEPTION) {
                const r = readValue(view, pos);
                event.exception = r.value;
                pos = r.end;
            }
            break;
        }

        case 'END_EXPR': {
            const writeCount = view.getUint8(pos);
            const readCount  = view.getUint8(pos + 1);
            const fieldCount = view.getUint8(pos + 2);
            pos += 3;
            event.writes = [];
            event.reads  = [];
            event.fields = [];
            for (let i = 0; i < writeCount; i++) {
                const rn = readUtf8u16(view, pos);
                pos = rn.end;
                const rv = readValue(view, pos);
                pos = rv.end;
                event.writes.push({ name: rn.str, value: rv.value, omitted: rv.omitted });
            }
            for (let i = 0; i < readCount; i++) {
                const rn = readUtf8u16(view, pos);
                pos = rn.end;
                const rv = readValue(view, pos);
                pos = rv.end;
                event.reads.push({ name: rn.str, value: rv.value, omitted: rv.omitted });
            }
            for (let i = 0; i < fieldCount; i++) {
                const rb = readUtf8u16(view, pos);
                pos = rb.end;
                const ro = readUtf8u16(view, pos);
                pos = ro.end;
                const isWrite = view.getUint8(pos) !== 0;
                pos += 1;
                const rv = readValue(view, pos);
                pos = rv.end;
                event.fields.push({ base: rb.str, offset: ro.str, isWrite, value: rv.value, omitted: rv.omitted });
            }
            break;
        }

        case 'KEY_EVENT': {
            const levelByte = view.getUint8(pos);
            pos += 1;
            const rt = readUtf8u16(view, pos);
            pos = rt.end;
            event.level = levelByte === 2 ? 'error' : levelByte === 1 ? 'warn' : 'info';
            event.text  = rt.str;
            break;
        }

        case 'WRITE_VAR':
        case 'READ_VAR_FULL': {
            const rn = readUtf8u16(view, pos);
            pos = rn.end;
            const rv = readValue(view, pos);
            pos = rv.end;
            event.name  = rn.str;
            event.value = rv.value;
            break;
        }
    }

    return { event, nextOffset: payloadEnd };
}

/**
 * 遍历整个二进制 trace Buffer，逐条调用回调。
 * 跳过文件头（FILE_HEADER_SIZE 字节）。
 *
 * @param {ArrayBuffer|Buffer} buf
 * @param {function(event: object, index: number): void} callback
 */
export function iterateBinary(buf, callback) {
    const ab   = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);
    let offset = FILE_HEADER_SIZE;
    let index  = 0;

    while (offset + EVENT_HEADER_SIZE <= ab.byteLength) {
        const { event, nextOffset } = deserializeEvent(view, offset);
        callback(event, index++);
        offset = nextOffset;
        // 防止解析错误导致死循环
        if (nextOffset <= offset && nextOffset !== offset) break;
    }
}

/**
 * 将整个二进制 trace Buffer 反序列化为事件数组。
 * @param {ArrayBuffer|Buffer} buf
 * @returns {Array<object>}
 */
export function deserializeAll(buf) {
    const events = [];
    iterateBinary(buf, ev => events.push(ev));
    return events;
}


