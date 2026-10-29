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
 *       OMITTED     → 无后续（值可通过 smap.defIid 追溯）
 *       NULL        → 无后续
 *       UNDEFINED   → 无后续
 *       BOOL_T/F    → 无后续
 *       INT32       → 4 字节 i32（小端）
 *       FLOAT64     → 8 字节 f64（小端）
 *       STRING      → u16 长度 + UTF-8 字节
 *       OBJECT      → u16 长度 + UTF-8 字节
 *       FUNCTION    → u8 名称长度 + ASCII 字节（最长 255）
 *       TYPED_ARRAY → u8 类型名长度 + ASCII(类型名) + u32 元素数量 + u32 字节长度
 *                     + u16 hex摘要长度 + hex摘要字节（最多 128 字节 = 前 64B 的 hex）
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
 *                                     flags.HAS_FN_DEF_IID → [fnDefIid u32]
 *   CALL            = 0x04   payload: [fnName_str][result_val]
 *   FUNCTION_ENTER  = 0x05   无 payload
 *   FUNCTION_EXIT   = 0x06   payload: [flags.hasException → exception_val]
 *   END_EXPR        = 0x07   payload: [write_count u8]([name_str][val][val_oid u32][scope_id u32])*
 *                                     [read_count u8]([name_str][val][scope_id u32])*  ← val 可能是 OMITTED
 *                                     [field_count u8]([offset_str][isWrite u8][val][base_oid u32])*
 *                                     注：val_oid 仅 v2+ 有效；scope_id 仅 v3+ 有效（0=无作用域信息）
 *                                                       base_oid = 0 表示非对象（primitive / null / OID 未知）
 *   KEY_EVENT       = 0x08   payload: [level u8][text_str]
 *   WRITE_VAR       = 0x0B   payload: [name_str][val]
 *   READ_VAR_FULL   = 0x0C   payload: [name_str][val]
 *
 * ## 值省略（fai 优化）
 *
 *   当静态分析确定某 read-site 对应唯一 def-site 时（Decision.LIGHTWEIGHT），
 *   值编码为 VALUE_TYPE.OMITTED。
 *   后处理工具加载 smap.json 后，通过 smap[iid].defIid 追溯到对应 write 事件的值。
 *
 * ## 压缩策略
 *
 *   字典压缩（Value Pool / STRING_REF）已移除。
 *   推荐方案：在传输层或存储层使用 gzip（见 NodeStreamBackend compress 选项和
 *   WsBackend perMessageDeflate）。gzip 能自动利用流中的重复模式，压缩效果
 *   优于应用层字典，且对解码器完全透明、无有状态依赖。
 */

// ─── 原生方法快照（防止被插桩代码 monkey-patch 后触发钩子递归）─────────────────
// 必须在模块加载时立即快照，此时被分析代码尚未运行。
const _jsonStringify     = JSON.stringify;
const _objDefineProperty = Object.defineProperty;
const _objGetOwnPropDesc = Object.getOwnPropertyDescriptor;
const _objGetPrototypeOf = Object.getPrototypeOf;

// 预先快照所有内置原型上的原生 toJSON（Date 是唯一标准内置带 toJSON 的类型）。
// 被分析代码运行后可能用插桩函数替换这些原型属性；我们在此记录快照，
// 序列化时若检测到原型上的 toJSON 已非原生函数，才需要做遮蔽处理。
// key: 原型对象, value: 原生 toJSON 函数引用
const _nativeToJsonMap = new Map();
for (const proto of [
    Date.prototype,
    // 以下类型通常没有 toJSON，但防御性地记录（值为 undefined 表示无）
    // Number.prototype, Boolean.prototype 没有 toJSON，不需要
]) {
    const desc = _objGetOwnPropDesc(proto, 'toJSON');
    if (desc && typeof desc.value === 'function') {
        _nativeToJsonMap.set(proto, desc.value);
    }
}

// ─── 魔数 & 版本 ──────────────────────────────────────────────────────────────

/** 文件魔数：ASCII "JTB1" */
export const MAGIC = new Uint8Array([0x4A, 0x54, 0x42, 0x31]);
export const FORMAT_VERSION = 0x04;
/** v1: 无 write.oid；v2: END_EXPR writes 条目末尾附加 val_oid u32；v3: reads/writes 条目末尾附加 scope_id u32 */
export const FORMAT_VERSION_V1 = 0x01;
export const FORMAT_VERSION_V2 = 0x02;

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
    TRACE_END:      0x0D,
    WRITE_VAR:      0x0B,  // 单独写变量事件（低频路径，如 declare）
    READ_VAR_FULL:  0x0C,  // fai 路径的读取（含实际值）
});

/** 事件类型反向映射（用于调试/解码） */
export const EVENT_TYPE_NAME = Object.fromEntries(
    Object.entries(EVENT_TYPE).map(([k, v]) => [v, k])
);

// ─── flags 位掩码 ──────────────────────────────────────────────────────────────

export const FLAGS = Object.freeze({
    HAS_EXCEPTION:    0x01,  // CALL / FUNCTION_EXIT：有异常值
    IS_CONSTRUCTOR:   0x02,  // CALL_PRE：new 调用
    IS_METHOD:        0x04,  // CALL_PRE：方法调用（base = this）
    HAS_THIS:         0x08,  // CALL_PRE：包含 this 值
    VALUE_OMITTED:    0x10,  // 通用：值已省略（可通过 smap.defIid 追溯）
    IS_WRITE:         0x20,  // field 条目：属性写入
    DIRECT_FE:        0x40,  // FUNCTION_ENTER：无 callPre 覆盖（直接调用）
    HAS_FN_DEF_IID:   0x80,  // CALL_PRE：payload 末尾附有函数定义点 iid（u32，4B）
});

// ─── 值类型常量 ────────────────────────────────────────────────────────────────

export const VALUE_TYPE = Object.freeze({
    OMITTED:     0x00,  // 值省略（可追溯），无后续字节
    NULL:        0x01,  // null，无后续字节
    UNDEFINED:   0x02,  // undefined，无后续字节
    BOOL_T:      0x03,  // true，无后续字节
    BOOL_F:      0x04,  // false，无后续字节
    INT32:       0x05,  // 整数，4 字节 i32（小端）— 整数优化
    FLOAT64:     0x06,  // 浮点数，8 字节 f64（小端）
    STRING:      0x07,  // 字符串，u16 长度 + UTF-8
    OBJECT:      0x08,  // 对象 JSON，u16 长度 + UTF-8
    FUNCTION:    0x09,  // 函数，u8 名称长度 + ASCII
    TYPED_ARRAY: 0x0B,  // TypedArray/ArrayBuffer：u8 类型名长度 + ASCII(类型名) +
                        //   u32 元素数量 + u32 字节长度 + u16 hex摘要长度 + hex摘要字节（最多128字节）
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
    if (offset + len > view.byteLength) throw new RangeError('Truncated string');
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, len);
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
    if (offset + len > view.byteLength) throw new RangeError('Truncated string');
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, len);
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
    // TypedArray / ArrayBuffer 特殊处理（必须在 typeof 'object' 分支之前检测）
    if (t === 'object' && v !== null && _isTypedArrayOrBuffer(v)) {
        return _measureTypedArray(v);
    }
    if (t === 'string') {
        const nb = encodeUtf8(v.length > 65000 ? v.slice(0, 64999) + '…' : v);
        return { vt: VALUE_TYPE.STRING, extraBytes: 2 + nb.length, strBytes: nb };
    }
    // 对象：使用快照的原生 JSON.stringify。
    // 若对象原型链上的 toJSON 已被插桩代码替换（不再是原生函数），
    // 临时在实例上遮蔽它，防止 JSON.stringify 调用插桩函数触发 Jalangi 钩子递归。
    // 性能优化：
    //   - 大多数对象是 plain object / Array，原型链上根本没有 toJSON → 零额外开销
    //   - 只有 Date 等对象才需要检查；且只有当原型上的 toJSON 被替换后才需要遮蔽
    //   - 检查路径：直接走 proto → _nativeToJsonMap 查表，O(1)，无 getOwnPropertyDescriptor
    let s;
    try {
        let shielded = false;
        if (v !== null && typeof v === 'object') {
            const proto = _objGetPrototypeOf(v);
            const native = proto !== null ? _nativeToJsonMap.get(proto) : undefined;
            if (native !== undefined) {
                // 该原型本来有原生 toJSON；检查当前实例或原型上的 toJSON 是否还是原生版本
                const ownDesc = _objGetOwnPropDesc(v, 'toJSON');
                const current = ownDesc ? ownDesc.value : proto.toJSON;  // proto.toJSON 此时可能是插桩版
                if (current !== native && ownDesc === undefined) {
                    // 原型上的 toJSON 已被替换为插桩版，且实例上没有自有遮蔽 → 需要遮蔽
                    try {
                        _objDefineProperty(v, 'toJSON', { value: native, configurable: true, writable: true });
                        shielded = true;
                    } catch { /* frozen/sealed 对象无法遮蔽，序列化可能仍会调用插桩 toJSON，catch 兜底 */ }
                }
            }
        }
        s = _jsonStringify(v);
        if (shielded) {
            try { delete v.toJSON; } catch { /* 忽略 */ }
        }
    } catch { s = '[object]'; }
    if (s === undefined) s = '[object]';
    const nb = encodeUtf8(s.length > 65000 ? s.slice(0, 64999) + '…' : s);
    return { vt: VALUE_TYPE.OBJECT, extraBytes: 2 + nb.length, strBytes: nb };
}

/**
 * 检测对象是否为 TypedArray 或 ArrayBuffer。
 * @param {*} v
 * @returns {boolean}
 */
function _isTypedArrayOrBuffer(v) {
    if (v instanceof ArrayBuffer) return true;
    // TypedArray：具有 buffer 属性 + BYTES_PER_ELEMENT 属性且不是 DataView
    return (ArrayBuffer.isView(v) && !(v instanceof DataView));
}

/**
 * 计算 TypedArray/ArrayBuffer 的编码大小。
 * 格式：u8(类型名len) + ASCII(类型名) + u32(element_count) + u32(byte_length) +
 *       u16(hex_len) + ASCII(hex摘要，最多128字符 = 64字节数据)
 * @param {TypedArray|ArrayBuffer} v
 * @returns {{ vt: number, extraBytes: number, _taInfo: object }}
 */
function _measureTypedArray(v) {
    let typeName, elementCount, byteLength, bufferRef, bufferOffset;
    if (v instanceof ArrayBuffer) {
        typeName     = 'ArrayBuffer';
        elementCount = 0;
        byteLength   = v.byteLength;
        bufferRef    = v;
        bufferOffset = 0;
    } else {
        typeName     = v.constructor?.name ?? 'TypedArray';
        elementCount = v.length;
        byteLength   = v.byteLength;
        bufferRef    = v.buffer;
        bufferOffset = v.byteOffset;
    }
    // 截取前 64 字节做 hex 摘要（128 个 hex 字符）
    const previewBytes  = Math.min(byteLength, 64);
    const hexStr        = _bufToHex(bufferRef, bufferOffset, previewBytes);
    const hexBytes      = encodeUtf8(hexStr);   // hex 只含 ASCII，length == hexStr.length
    const typeNameBytes = encodeUtf8(typeName.slice(0, 255));
    // 1(typeName_len) + typeName.len + 4(element_count) + 4(byte_length) + 2(hex_len) + hex.len
    const extraBytes = 1 + typeNameBytes.length + 4 + 4 + 2 + hexBytes.length;
    return {
        vt: VALUE_TYPE.TYPED_ARRAY,
        extraBytes,
        _taInfo: { typeNameBytes, elementCount, byteLength, hexBytes },
    };
}

/**
 * 将 ArrayBuffer 的部分字节转为 hex 字符串（小写）。
 * @param {ArrayBuffer} buf
 * @param {number} byteOffset
 * @param {number} length
 * @returns {string}
 */
function _bufToHex(buf, byteOffset, length) {
    try {
        const view = new Uint8Array(buf, byteOffset, length);
        let hex = '';
        for (let i = 0; i < view.length; i++) {
            hex += view[i].toString(16).padStart(2, '0');
        }
        return hex;
    } catch { return ''; }
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
        case VALUE_TYPE.TYPED_ARRAY: {
            const { typeNameBytes, elementCount, byteLength, hexBytes } = measured._taInfo;
            // u8 类型名长度
            view.setUint8(offset, typeNameBytes.length);
            offset += 1;
            // ASCII 类型名
            new Uint8Array(view.buffer, view.byteOffset + offset, typeNameBytes.length).set(typeNameBytes);
            offset += typeNameBytes.length;
            // u32 元素数量
            view.setUint32(offset, elementCount >>> 0, true);
            offset += 4;
            // u32 字节长度
            view.setUint32(offset, byteLength >>> 0, true);
            offset += 4;
            // u16 hex摘要长度 + hex字节
            view.setUint16(offset, hexBytes.length, true);
            offset += 2;
            new Uint8Array(view.buffer, view.byteOffset + offset, hexBytes.length).set(hexBytes);
            offset += hexBytes.length;
            break;
        }
    }
    return offset;
}

/**
 * 将"名称"字段（u16 + UTF-8）写入 DataView。
 * @param {DataView} view
 * @param {number}   offset
 * @param {{ bytes: number, nb: Uint8Array }} measured
 * @returns {number}  新 offset
 */
function writeStr(view, offset, measured) {
    view.setUint16(offset, measured.nb.length, true);
    offset += 2;
    new Uint8Array(view.buffer, view.byteOffset + offset).set(measured.nb);
    offset += measured.nb.length;
    return offset;
}

/**
 * 计算"名称"字段的实际字节数。
 * @param {{ bytes: number }} measured
 * @returns {number}
 */
function strFieldBytes(measured) {
    return measured.bytes;
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
        case VALUE_TYPE.TYPED_ARRAY: {
            // 读取类型名（u8 len + ASCII）
            const typeNameLen = view.getUint8(offset);
            offset += 1;
            const typeNameBytes = new Uint8Array(view.buffer, view.byteOffset + offset, typeNameLen);
            const typeName = String.fromCharCode(...typeNameBytes);
            offset += typeNameLen;
            // 读取元素数量和字节长度
            const elementCount = view.getUint32(offset, true);
            offset += 4;
            const byteLength = view.getUint32(offset, true);
            offset += 4;
            // 读取 hex 摘要
            const hexLen = view.getUint16(offset, true);
            offset += 2;
            const hexBytes = new Uint8Array(view.buffer, view.byteOffset + offset, hexLen);
            const hexPreview = String.fromCharCode(...hexBytes);
            offset += hexLen;
            // 组合成可读字符串：[Uint8Array(256):1024B:aabbccdd...]
            value = `[${typeName}(${elementCount}):${byteLength}B:${hexPreview}]`;
            break;
        }
        default:
            value = undefined;
    }
    return { value, omitted, end: offset };
}

/**
 * 读取"名称"字段（u16+UTF-8）。
 * @param {DataView} view
 * @param {number}   offset
 * @returns {{ str: string, end: number }}
 */
function readStr(view, offset) {
    const len = view.getUint16(offset, true);
    offset += 2;
    if (offset + len > view.byteLength) throw new RangeError('Truncated string');
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, len);
    const str = td ? td.decode(bytes) : Buffer.from(bytes).toString('utf8');
    return { str, end: offset + len };
}

// ─── 事件序列化 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 计算单条事件所需的 payload 字节数，返回序列化所需的中间结构。
 * 分两步（measure + write）避免两次 TextEncoder 调用。
 *
 * @param {object} event  标准化事件对象（字段见各 EVENT_TYPE 说明）
 * @returns {{ payloadSize: number, _m: object }}  _m 为中间测量结果（供 writeEventPayload 使用）
 */
function measureEvent(event) {
    const result = measureEventPayload(event);
    const metadata = { scriptId: event.scriptId, callId: event.callId,
        parentCallId: event.parentCallId, contextId: event.contextId, callPairId: event.callPairId,
        writeBindings: event.writes?.map(w => w.bindingId ?? null),
        readBindings: event.reads?.map(r => r.bindingId ?? null) };
    _objDefineProperty(metadata, 'toJSON', { value: undefined });
    if (metadata.writeBindings) _objDefineProperty(metadata.writeBindings, 'toJSON', { value: undefined });
    if (metadata.readBindings) _objDefineProperty(metadata.readBindings, 'toJSON', { value: undefined });
    const meta = measureStr(_jsonStringify(metadata));
    result.payloadSize += strFieldBytes(meta);
    result._m.meta = meta;
    return result;
}

function measureEventPayload(event) {
    const { type } = event;

    switch (type) {
        case 'SCRIPT_ENTER': {
            const fm = measureStr(event.file ?? '');
            return { payloadSize: strFieldBytes(fm), _m: { fm } };
        }

        case 'SCRIPT_EXIT': {
            const hasEx = event.exception !== undefined && event.exception !== null;
            if (!hasEx) return { payloadSize: 0, _m: { hasEx } };
            const mv = measureValue(event.exception, false);
            return { payloadSize: 1 + mv.extraBytes, _m: { hasEx, mv, exVal: event.exception } };
        }

        case 'CALL_PRE': {
            const fnm = measureStr((event.fn ?? '').slice(0, 255));
            const args   = event.args ?? [];
            const argc   = Math.min(args.length, 8);  // 最多记录8个参数
            let argsSize = 0;
            const argMeasures = [];
            for (let i = 0; i < argc; i++) {
                const mv = measureValue(args[i], false);
                argsSize += 1 + mv.extraBytes;  // valueType + extra
                argMeasures.push(mv);
            }
            const hasThis = event.isMethod && event.base !== undefined;
            let thisSize = 0;
            let thisMv;
            if (hasThis) {
                thisMv = measureValue(event.base, false);
                thisSize = 1 + thisMv.extraBytes;
            }
            // fnDefIid：被调函数定义点 iid（仅插桩 JS 函数有值）
            const hasFnDefIid = event.fnDefIid !== undefined && event.fnDefIid !== null;
            const fnDefIidSize = hasFnDefIid ? 4 : 0;  // u32 = 4B
            const payloadSize = strFieldBytes(fnm) + 1 + argsSize + thisSize + fnDefIidSize;
            return { payloadSize, _m: { fnm, argc, argMeasures, args, hasThis, thisMv, base: event.base, hasFnDefIid, fnDefIid: event.fnDefIid } };
        }

        case 'CALL': {
            const fnm = measureStr((event.fn ?? '').slice(0, 255));
            const mv = measureValue(event.result, false);
            return { payloadSize: strFieldBytes(fnm) + 1 + mv.extraBytes, _m: { fnm, mv, result: event.result } };
        }

        case 'TRACE_END':
        case 'FUNCTION_ENTER':
            return { payloadSize: 0, _m: {} };

        case 'FUNCTION_EXIT': {
            const hasEx = !!(event.exception);
            if (!hasEx) return { payloadSize: 0, _m: { hasEx } };
            const mv = measureValue(event.exception, false);
            return { payloadSize: 1 + mv.extraBytes, _m: { hasEx, mv, exVal: event.exception } };
        }

        case 'END_EXPR': {
            const writes = event.writes ?? [];
            const reads  = event.reads  ?? [];
            const fields = event.fields ?? [];
            if ([writes, reads, fields].some(items => items.length > 255)) throw new RangeError('Too many entries in END_EXPR');
            let size = 1 + 1 + 1;  // writeCount + readCount + fieldCount (all u8)
            const wm = [], rm = [], fm = [];
            for (const w of writes) {
                const nm = measureStr(w.name);
                const mv = measureValue(w.val, w.omit === true);
                // v2：writes 条目末尾附加 val_oid u32（4B，0=非对象）
                // v3：writes 条目末尾再附加 scope_id u32（4B，0=无作用域信息）
                size += strFieldBytes(nm) + 1 + mv.extraBytes + 4 + 4;
                wm.push({ nm, mv, val: w.val, omit: w.omit, oid: w.oid ?? 0, scopeId: w.scopeId ?? 0 });
            }
            for (const r of reads) {
                const nm = measureStr(r.name);
                const mv = measureValue(r.val, r.omit === true);
                // v3：reads 条目末尾附加 scope_id u32（4B，0=无作用域信息）
                size += strFieldBytes(nm) + 1 + mv.extraBytes + 4;
                rm.push({ nm, mv, val: r.val, omit: r.omit, scopeId: r.scopeId ?? 0 });
            }
            for (const f of fields) {
                const onm = measureStr(String(f.offset ?? ''));
                const mv = measureValue(f.val, false);
                // [offset_str][isWrite 1B][val(1B vt + extraBytes)][base_oid u32 4B]
                size += strFieldBytes(onm) + 1 + 1 + mv.extraBytes + 4;
                fm.push({ onm, mv, val: f.val, isWrite: f.isWrite, baseOid: f.baseOid ?? 0 });
            }
            return { payloadSize: size, _m: { writes, reads, fields, wm, rm, fm } };
        }

        case 'KEY_EVENT': {
            const level = event.level === 'error' ? 2 : event.level === 'warn' ? 1 : 0;
            const tm = measureStr(event.text ?? '');
            return { payloadSize: 1 + strFieldBytes(tm), _m: { level, tm } };
        }

        case 'WRITE_VAR': {
            const nm = measureStr(event.name ?? '');
            const mv = measureValue(event.val, false);
            return { payloadSize: strFieldBytes(nm) + 1 + mv.extraBytes, _m: { nm, mv, val: event.val } };
        }

        case 'READ_VAR_FULL': {
            const nm = measureStr(event.name ?? '');
            const mv = measureValue(event.val, false);
            return { payloadSize: strFieldBytes(nm) + 1 + mv.extraBytes, _m: { nm, mv, val: event.val } };
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
            offset = writeStr(view, offset, _m.fm);
            break;
        }

        case 'SCRIPT_EXIT': {
            if (_m.hasEx) {
                offset = writeValue(view, offset, _m.mv, _m.exVal);
            }
            break;
        }

        case 'CALL_PRE': {
            offset = writeStr(view, offset, _m.fnm);
            view.setUint8(offset, _m.argc);
            offset += 1;
            for (let i = 0; i < _m.argc; i++) {
                offset = writeValue(view, offset, _m.argMeasures[i], _m.args[i]);
            }
            if (_m.hasThis) {
                offset = writeValue(view, offset, _m.thisMv, _m.base);
            }
            if (_m.hasFnDefIid) {
                view.setUint32(offset, _m.fnDefIid >>> 0, true);  // 小端 u32
                offset += 4;
            }
            break;
        }

        case 'CALL': {
            offset = writeStr(view, offset, _m.fnm);
            offset = writeValue(view, offset, _m.mv, _m.result);
            break;
        }

        case 'TRACE_END':
        case 'FUNCTION_ENTER':
            break;

        case 'FUNCTION_EXIT': {
            if (_m.hasEx) {
                offset = writeValue(view, offset, _m.mv, _m.exVal);
            }
            break;
        }

        case 'END_EXPR': {
            view.setUint8(offset, _m.wm.length);   offset += 1;
            view.setUint8(offset, _m.rm.length);   offset += 1;
            view.setUint8(offset, _m.fm.length);   offset += 1;
            for (const w of _m.wm) {
                offset = writeStr(view, offset, w.nm);
                offset = writeValue(view, offset, w.mv, w.val);
                // v2: writes 条目末尾附加 val_oid u32（0=非对象）
                view.setUint32(offset, (w.oid ?? 0) >>> 0, true);  offset += 4;
                // v3: writes 条目末尾附加 scope_id u32（0=无作用域信息）
                view.setUint32(offset, (w.scopeId ?? 0) >>> 0, true);  offset += 4;
            }
            for (const r of _m.rm) {
                offset = writeStr(view, offset, r.nm);
                offset = writeValue(view, offset, r.mv, r.val);
                // v3: reads 条目末尾附加 scope_id u32（0=无作用域信息）
                view.setUint32(offset, (r.scopeId ?? 0) >>> 0, true);  offset += 4;
            }
            for (const f of _m.fm) {
                // [offset_str][isWrite 1B][val][base_oid u32 小端，0=null]
                offset = writeStr(view, offset, f.onm);
                view.setUint8(offset, f.isWrite ? 1 : 0);  offset += 1;
                offset = writeValue(view, offset, f.mv, f.val);
                view.setUint32(offset, f.baseOid >>> 0, true);  offset += 4;
            }
            break;
        }

        case 'KEY_EVENT': {
            view.setUint8(offset, _m.level);
            offset += 1;
            offset = writeStr(view, offset, _m.tm);
            break;
        }

        case 'WRITE_VAR':
        case 'READ_VAR_FULL': {
            offset = writeStr(view, offset, _m.nm);
            offset = writeValue(view, offset, _m.mv, _m.val);
            break;
        }
    }
    return writeStr(view, offset, _m.meta);
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
                if (event.isConstructor)                         flagsByte |= FLAGS.IS_CONSTRUCTOR;
                if (event.isMethod)                              flagsByte |= FLAGS.IS_METHOD;
                if (event.isMethod && event.base !== undefined)  flagsByte |= FLAGS.HAS_THIS;
                if (event.fnDefIid !== undefined && event.fnDefIid !== null) flagsByte |= FLAGS.HAS_FN_DEF_IID;
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
    if (payloadSize > 65535) throw new RangeError('Event payload exceeds 65535 bytes');
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
 * 无状态版本，不支持字典压缩。
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
        if (m.payloadSize > 65535) throw new RangeError('Event payload exceeds 65535 bytes');
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

/**
 * 从文件头读取格式版本号（字节偏移 4）。
 * 调用方需先确认魔数正确（isBinaryTrace）。
 * @param {DataView|Buffer} viewOrBuf
 * @returns {number}  版本号（0x01=旧版，0x02=支持 write.oid，0x03=支持 scope_id）
 */
export function readFileVersion(viewOrBuf) {
    const view = viewOrBuf instanceof DataView
        ? viewOrBuf
        : new DataView(viewOrBuf.buffer ?? viewOrBuf, viewOrBuf.byteOffset ?? 0);
    return view.getUint8(4);
}

// ─── 事件反序列化 ──────────────────────────────────────────────────────────────

/**
 * 从 DataView 的指定 offset 处反序列化一条事件（含 12 字节头）。
 *
 * @param {DataView} view
 * @param {number}   offset
 * @param {number}   [version]  格式版本号（0x01 = v1, 0x02 = v2）
 * @returns {{ event: object, nextOffset: number }}
 */
export function deserializeEvent(view, offset, version = FORMAT_VERSION) {
    const typeByte  = view.getUint8(offset);
    const flagsByte = view.getUint8(offset + 1);
    const iid       = view.getUint32(offset + 2, true);
    const seq       = view.getUint32(offset + 6, true);
    const payloadLen = view.getUint16(offset + 10, true);
    const payloadStart = offset + EVENT_HEADER_SIZE;
    const payloadEnd   = payloadStart + payloadLen;
    if (payloadEnd > view.byteLength) throw new RangeError('Truncated event payload');
    // Bound every value/string decoder to this record, never the following event.
    view = new DataView(view.buffer, view.byteOffset, payloadEnd);

    const typeName = EVENT_TYPE_NAME[typeByte] ?? 'UNKNOWN';
    let pos = payloadStart;

    const event = { type: typeName, iid, seq };

    switch (typeName) {
        case 'SCRIPT_ENTER': {
            const r = readStr(view, pos);
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
            const rfn = readStr(view, pos);
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
            if (flagsByte & FLAGS.HAS_FN_DEF_IID) {
                event.fnDefIid = view.getUint32(pos, true);  // 小端 u32
                pos += 4;
            }
            break;
        }

        case 'CALL': {
            const rfn = readStr(view, pos);
            event.fn = rfn.str;
            pos = rfn.end;
            const r = readValue(view, pos);
            event.result = r.omitted ? undefined : r.value;
            pos = r.end;
            break;
        }

        case 'TRACE_END': break;

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
                const rn = readStr(view, pos);
                pos = rn.end;
                const rv = readValue(view, pos);
                pos = rv.end;
                let writeOid = null;
                if (version >= 0x02) {
                    // v2：条目末尾有 val_oid u32
                    const rawOid = view.getUint32(pos, true);
                    writeOid = rawOid === 0 ? null : rawOid;
                    pos += 4;
                }
                let writeScopeId = null;
                if (version >= 0x03) {
                    // v3：条目末尾有 scope_id u32（0=无作用域信息）
                    const rawScopeId = view.getUint32(pos, true);
                    writeScopeId = rawScopeId === 0 ? null : rawScopeId;
                    pos += 4;
                }
                event.writes.push({ name: rn.str, value: rv.value, omitted: rv.omitted, oid: writeOid, scopeId: writeScopeId });
            }
            for (let i = 0; i < readCount; i++) {
                const rn = readStr(view, pos);
                pos = rn.end;
                const rv = readValue(view, pos);
                pos = rv.end;
                let readScopeId = null;
                if (version >= 0x03) {
                    // v3：条目末尾有 scope_id u32（0=无作用域信息）
                    const rawScopeId = view.getUint32(pos, true);
                    readScopeId = rawScopeId === 0 ? null : rawScopeId;
                    pos += 4;
                }
                event.reads.push({ name: rn.str, value: rv.value, omitted: rv.omitted, scopeId: readScopeId });
            }
            for (let i = 0; i < fieldCount; i++) {
                // [offset_str][isWrite 1B][val][base_oid u32]
                const ro = readStr(view, pos);
                pos = ro.end;
                const isWrite = view.getUint8(pos) !== 0;
                pos += 1;
                const rv = readValue(view, pos);
                pos = rv.end;
                const raw = view.getUint32(pos, true);
                const baseOid = raw === 0 ? null : raw;
                pos += 4;
                event.fields.push({ offset: ro.str, isWrite, value: rv.value, omitted: rv.omitted, baseOid });
            }
            break;
        }

        case 'KEY_EVENT': {
            const levelByte = view.getUint8(pos);
            pos += 1;
            const rt = readStr(view, pos);
            pos = rt.end;
            event.level = levelByte === 2 ? 'error' : levelByte === 1 ? 'warn' : 'info';
            event.text  = rt.str;
            break;
        }

        case 'WRITE_VAR':
        case 'READ_VAR_FULL': {
            const rn = readStr(view, pos);
            pos = rn.end;
            const rv = readValue(view, pos);
            pos = rv.end;
            event.name  = rn.str;
            event.value = rv.value;
            break;
        }
    }

    if (version >= 4) {
        const metadata = readStr(view, pos);
        pos = metadata.end;
        const meta = JSON.parse(metadata.str);
        for (const key of ['scriptId', 'callId', 'parentCallId', 'contextId', 'callPairId']) {
            if (meta[key] !== undefined) event[key] = meta[key];
        }
        event.writes?.forEach((w, i) => { if (meta.writeBindings?.[i] != null) w.bindingId = meta.writeBindings[i]; });
        event.reads?.forEach((r, i) => { if (meta.readBindings?.[i] != null) r.bindingId = meta.readBindings[i]; });
    }
    if (typeName === 'UNKNOWN') throw new Error(`Unknown event type ${typeByte}`);
    if (pos !== payloadEnd) throw new Error(`Event payload length mismatch: ${pos} != ${payloadEnd}`);
    return { event, nextOffset: payloadEnd };
}

/**
 * 遍历整个二进制 trace Buffer，逐条调用回调。
 * 跳过文件头（FILE_HEADER_SIZE 字节）。
 *
 * @param {ArrayBuffer|Buffer} buf
 * @param {function(event: object, index: number): void} callback
 * @param {object} [options]
 * @param {boolean} [options.dedupe=false]  按 seq 去重（过滤重连重发的重复事件）
 */
export function iterateBinary(buf, callback, options = {}) {
    const { dedupe = false } = options;
    const ab   = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);
    if (ab.byteLength < FILE_HEADER_SIZE || !isBinaryTrace(ab)) throw new Error('Invalid trace header');
    const version = readFileVersion(view);
    if (version < 1 || version > FORMAT_VERSION) throw new Error(`Unsupported trace version ${version}`);
    let offset = FILE_HEADER_SIZE;
    let index  = 0;
    const seenSeqs  = dedupe ? new Set() : null;  // seq 去重集合

    while (offset + EVENT_HEADER_SIZE <= ab.byteLength) {
        const { event, nextOffset } = deserializeEvent(view, offset, version);
        // 防止解析错误导致死循环：nextOffset 必须严格大于当前 offset
        if (nextOffset <= offset) break;
        offset = nextOffset;

        if (seenSeqs !== null) {
            if (seenSeqs.has(event.seq)) continue;
            seenSeqs.add(event.seq);
        }

        callback(event, index++);
    }
    if (offset !== ab.byteLength) throw new Error('Truncated event header');
}

/**
 * 将整个二进制 trace Buffer 反序列化为事件数组。
 * @param {ArrayBuffer|Buffer} buf
 * @param {object} [options]
 * @param {boolean} [options.dedupe=false]  按 seq 去重（过滤重连重发的重复事件）
 * @returns {Array<object>}
 */
export function deserializeAll(buf, options = {}) {
    const events = [];
    iterateBinary(buf, ev => events.push(ev), options);
    return events;
}

// ─── .bin.gz 支持（Node.js 环境）────────────────────────────────────────────

/**
 * 检测 Buffer/ArrayBuffer/Uint8Array 是否为 gzip 格式（魔数 1f 8b）。
 * @param {ArrayBuffer|Buffer|Uint8Array} buf
 * @returns {boolean}
 */
export function isGzipTrace(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B;
}

/**
 * 将 gzip 压缩的 trace Buffer 同步解压（Node.js 环境）。
 * 若当前环境无 zlib（浏览器）则抛出错误。
 *
 * @param {Buffer} buf  gzip 压缩的 Buffer
 * @returns {Buffer}    解压后的 Buffer
 */
export function gunzipTraceSync(buf) {
    // Node.js 环境：通过全局缓存使用 zlib.gunzipSync
    // 该缓存由 _initNodeZlib() 在模块加载后填充（见模块末尾）
    if (globalThis.__jalangiGunzipSync) {
        return globalThis.__jalangiGunzipSync(buf);
    }
    throw new Error('gunzipTraceSync: zlib not available. Call initNodeZlib() first or use gunzipTraceAsync().');
}

/**
 * 将 gzip 压缩的 trace Buffer 异步解压（Node.js 环境）。
 * 返回 Promise<Buffer>，在浏览器中可使用 DecompressionStream。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} buf
 * @returns {Promise<Buffer>}
 */
export async function gunzipTraceAsync(buf) {
    // Node.js 环境：使用 zlib
    if (typeof process !== 'undefined' && process.versions?.node) {
        const { gunzip } = await import('node:zlib');
        const { promisify } = await import('node:util');
        const gunzipP = promisify(gunzip);
        const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        return gunzipP(nodeBuf);
    }

    // 浏览器环境：使用 DecompressionStream（Chrome 80+, Firefox 113+）
    if (typeof DecompressionStream !== 'undefined') {
        const ds  = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        const inputBuf = buf instanceof ArrayBuffer ? buf : (buf instanceof Uint8Array ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
        writer.write(inputBuf);
        writer.close();
        const chunks = [];
        let totalLen = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLen += value.byteLength;
        }
        const out = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        return out;
    }

    throw new Error('gunzipTraceAsync: no decompression API available');
}

/**
 * 遍历 trace Buffer（支持自动解压 .bin.gz）。
 * Node.js 环境同步完成；浏览器需先用 gunzipTraceAsync 解压再调用 iterateBinary。
 *
 * @param {ArrayBuffer|Buffer} buf         原始 buffer（可以是 .bin 或 .bin.gz）
 * @param {function}           callback    (event, index) => void
 * @param {object}             [options]
 * @param {boolean}            [options.dedupe=false]  按 seq 去重
 */
export function iterateBinaryAuto(buf, callback, options = {}) {
    if (isGzipTrace(buf)) {
        if (!globalThis.__jalangiGunzipSync) {
            throw new Error('iterateBinaryAuto: gzip detected but sync decompression unavailable. Use iterateBinaryAutoAsync() instead.');
        }
        const nodeBuf = Buffer.isBuffer(buf) ? buf
            : Buffer.from(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const decompressed = globalThis.__jalangiGunzipSync(nodeBuf);
        iterateBinary(decompressed, callback, options);
        return;
    }
    iterateBinary(buf, callback, options);
}

/**
 * 异步版本的 iterateBinaryAuto，同时支持 Node.js 和浏览器环境。
 *
 * @param {ArrayBuffer|Buffer} buf
 * @param {function}           callback    (event, index) => void
 * @param {object}             [options]
 * @param {boolean}            [options.dedupe=false]  按 seq 去重
 * @returns {Promise<void>}
 */
export async function iterateBinaryAutoAsync(buf, callback, options = {}) {
    let resolved = buf;
    if (isGzipTrace(buf)) {
        resolved = await gunzipTraceAsync(buf);
    }
    iterateBinary(resolved, callback, options);
}

/**
 * 异步版本的 deserializeAll，同时支持 .bin 和 .bin.gz。
 *
 * @param {ArrayBuffer|Buffer} buf
 * @param {object}             [options]
 * @param {boolean}            [options.dedupe=false]  按 seq 去重
 * @returns {Promise<Array<object>>}
 */
export async function deserializeAllAsync(buf, options = {}) {
    const events = [];
    await iterateBinaryAutoAsync(buf, ev => events.push(ev), options);
    return events;
}

// ─── Node.js 环境初始化（ESM 顶层 await 注入 gunzipSync）──────────────────────

// 在 Node.js 环境中，模块加载时异步初始化 gunzipSync 到 globalThis。
// 这样 gunzipTraceSync / iterateBinaryAuto 无需 createRequire 即可同步使用。
if (typeof process !== 'undefined' && process.versions?.node) {
    // 不阻塞模块加载；首次读取 .bin.gz 文件前 await 完成即可
    import('node:zlib').then(({ gunzipSync }) => {
        globalThis.__jalangiGunzipSync = gunzipSync;
    }).catch(() => { /* 极端情况下 zlib 不可用，忽略 */ });
}
