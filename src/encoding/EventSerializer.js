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
 *       STRING_REF  → u16 字典 ID（引用已注册的字符串，3 字节 vs 原始编码）
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
 *   END_EXPR        = 0x07   payload: [write_count u8]([name_str][val])*
 *                                     [read_count u8]([name_str][val])*  ← val 可能是 OMITTED
 *                                     [field_count u8]([offset_str][isWrite u8][val][base_oid u32])*
 *                                                       base_oid = 0 表示非对象（primitive / null / OID 未知）
 *   KEY_EVENT       = 0x08   payload: [level u8][text_str]
 *   DICT_ENTRY      = 0x09   payload: [id u16][str_len u16][UTF-8 字节]
 *                             含义：将 id 注册到字典，后续 STRING_REF 可引用
 *   WRITE_VAR       = 0x0B   payload: [name_str][val]
 *   READ_VAR_FULL   = 0x0C   payload: [name_str][val]
 *
 * ## 值省略（fai 优化）
 *
 *   当静态分析确定某 read-site 对应唯一 def-site 时（Decision.LIGHTWEIGHT），
 *   值编码为 VALUE_TYPE.OMITTED。
 *   后处理工具加载 smap.json 后，通过 smap[iid].defIid 追溯到对应 write 事件的值。
 *
 * ## 值池压缩（Value Pool / Dictionary Compression）
 *
 *   高频重复的字符串（变量名、文件名、属性名等）在运行时会被反复写入 trace。
 *   StringPool 为每个首次出现的字符串分配一个 u16 ID（1..65535），
 *   并在流中插入 DICT_ENTRY 事件注册映射。后续出现同一字符串时，
 *   使用 VALUE_TYPE.STRING_REF（1 字节类型 + 2 字节 ID = 3 字节）代替完整 UTF-8 编码。
 *
 *   适用阈值：字符串长度 >= MIN_POOL_STR_LEN（默认 4）时才考虑入池，
 *   避免短字符串（如 "x"、"y"）产生额外的 DICT_ENTRY 开销。
 *
 *   使用方式（有状态版本）：
 *     const serializer = new EventSerializerWithPool();
 *     const headerBuf  = serializer.createFileHeader();
 *     const eventBuf   = serializer.serializeBatch(batch);  // 可能前置若干 DICT_ENTRY 事件
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
export const FORMAT_VERSION = 0x02;
/** v1: 无 write.oid；v2: END_EXPR writes 条目末尾附加 val_oid u32 */
export const FORMAT_VERSION_V1 = 0x01;

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
    DICT_ENTRY:     0x09,  // 字典条目：注册字符串 ID → 字符串内容
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
    STRING_REF:  0x0A,  // 字符串引用（字典压缩），2 字节 u16 ID
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
 * @param {StringPool|null} [pool=null]  字符串池（非 null 时对 string 类型做池化）
 * @returns {{ vt: number, extraBytes: number, strBytes?: Uint8Array, poolId?: number }}
 */
function measureValue(v, omit = false, pool = null) {
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
        // 字典压缩：若有 pool，尝试用 STRING_REF（3字节）代替完整编码
        if (pool !== null) {
            const id = pool.lookup(v);
            if (id !== null) {
                // 已在字典中：STRING_REF = 1(vt) + 2(id) = 3 字节，仅 extraBytes 计 2
                return { vt: VALUE_TYPE.STRING_REF, extraBytes: 2, poolId: id };
            }
        }
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
 * @param {StringPool|null} [pool=null]
 * @returns {{ bytes: number, nb: Uint8Array, poolId: number|null }}
 */
function measureStr(s, pool = null) {
    // 字典压缩：对字符串字段（变量名、文件名、属性名等）也做池化
    if (pool !== null) {
        const id = pool.lookup(s);
        if (id !== null) {
            // STRING_REF 编码：1(vt) + 2(id) = 3 字节（替代 u16+bytes）
            // 注意：measureStr 用于"名称"字段，不带 vt 字节，所以这里返回特殊标记
            return { bytes: -1, nb: null, poolId: id };
        }
    }
    const nb = encodeUtf8(s.length > 65535 ? s.slice(0, 65534) + '…' : s);
    return { bytes: 2 + nb.length, nb, poolId: null };
}

/**
 * 将值写入 DataView，返回写入后的新 offset。
 * @param {DataView} view
 * @param {number}   offset
 * @param {{ vt: number, extraBytes: number, strBytes?: Uint8Array, poolId?: number }} measured
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
        case VALUE_TYPE.STRING_REF: {
            // 2 字节 u16 ID
            view.setUint16(offset, measured.poolId, true);
            offset += 2;
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
 * 将"名称"字段（u16 + UTF-8）写入 DataView，支持 STRING_REF 压缩。
 *
 * 当 poolId 非 null 时，写入格式为 [0xFF 0xFF][u16 poolId]（4 字节），
 * 解码器通过 0xFFFF 长度哨兵识别这是一个字典引用而非字面字符串长度。
 *
 * @param {DataView} view
 * @param {number}   offset
 * @param {{ bytes: number, nb: Uint8Array|null, poolId: number|null }} measured
 * @returns {number}  新 offset
 */
function writeStr(view, offset, measured) {
    if (measured.poolId !== null) {
        // 使用 0xFFFF 作为哨兵长度，后跟 u16 字典 ID（共 4 字节）
        view.setUint16(offset, 0xFFFF, true);
        offset += 2;
        view.setUint16(offset, measured.poolId, true);
        offset += 2;
    } else {
        view.setUint16(offset, measured.nb.length, true);
        offset += 2;
        new Uint8Array(view.buffer, view.byteOffset + offset).set(measured.nb);
        offset += measured.nb.length;
    }
    return offset;
}

/**
 * 计算"名称"字段的实际字节数（writeStr 对应的 measure）。
 * poolId 非 null 时返回 4（哨兵 2B + ID 2B）。
 * @param {{ bytes: number, poolId: number|null }} measured
 * @returns {number}
 */
function strFieldBytes(measured) {
    return measured.poolId !== null ? 4 : measured.bytes;
}

/**
 * 读取一个值，返回 JS 值和新 offset。
 * @param {DataView} view
 * @param {number}   offset
 * @param {Map<number,string>|null} [dict=null]  字符串字典（解码 STRING_REF 用）
 * @returns {{ value: *, omitted: boolean, end: number }}
 */
function readValue(view, offset, dict = null) {
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
        case VALUE_TYPE.STRING_REF: {
            const id = view.getUint16(offset, true);
            offset += 2;
            value = dict ? (dict.get(id) ?? `[ref:${id}]`) : `[ref:${id}]`;
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
 * 读取"名称"字段（u16+UTF-8 或 0xFFFF 哨兵+ID 字典引用）。
 * @param {DataView} view
 * @param {number}   offset
 * @param {Map<number,string>|null} [dict=null]
 * @returns {{ str: string, end: number }}
 */
function readStr(view, offset, dict = null) {
    const len = view.getUint16(offset, true);
    offset += 2;
    if (len === 0xFFFF) {
        // 字典引用
        const id = view.getUint16(offset, true);
        offset += 2;
        const str = dict ? (dict.get(id) ?? `[ref:${id}]`) : `[ref:${id}]`;
        return { str, end: offset };
    }
    const bytes = new Uint8Array(view.buffer, offset, len);
    const str = td ? td.decode(bytes) : Buffer.from(bytes).toString('utf8');
    return { str, end: offset + len };
}

// ─── StringPool（字典压缩核心）───────────────────────────────────────────────

/**
 * 最小入池字符串长度。短字符串（如单字母变量名）入池收益低，
 * 因为 DICT_ENTRY 事件本身有 12+4 字节头开销，只有字符串足够长且出现足够频繁时才合算。
 */
const MIN_POOL_STR_LEN = 4;

/**
 * 字典最大容量（u16 ID 上限，0 保留，有效 ID 为 1..65535）。
 */
const MAX_POOL_SIZE = 65535;

/**
 * LRU 淘汰阈值：当 _map 条目数达到此值时，在下一次 register() 时
 * 淘汰最久未访问的 LRU_EVICT_COUNT 条，为新条目腾出空间。
 * 设为 MAX_POOL_SIZE * 0.9，给 ID 空间保留 10% 余量用于新条目。
 */
const LRU_EVICT_THRESHOLD = Math.floor(MAX_POOL_SIZE * 0.9);   // ~58981
const LRU_EVICT_COUNT     = Math.floor(MAX_POOL_SIZE * 0.1);   // ~6553 每次淘汰 10%

/**
 * StringPool — 字符串字典压缩状态机，带 LRU 淘汰。
 *
 * 每个 EventSerializerWithPool 实例持有一个 StringPool。
 * 使用方在序列化每个 batch 之前，调用 registerBatch() 将 batch 中所有字符串提前
 * 注册到字典，然后调用 flushDictEntries() 取出需要写出的新 DICT_ENTRY 事件列表。
 *
 * LRU 淘汰策略：
 *   - _map 中每个条目同时存在于 _lruOrder（插入顺序 Map，key=string，value=id）中
 *   - lookup/register 命中时将条目移到 _lruOrder 末尾（最近使用）
 *   - 当条目数达到 LRU_EVICT_THRESHOLD 时，批量淘汰最旧的 LRU_EVICT_COUNT 条
 *   - 被淘汰的条目 ID 不再复用（避免与流中已写出的 DICT_ENTRY 冲突），
 *     后续相同字符串会被重新 register 并分配新 ID
 *
 * 线程安全：单线程使用，不需要锁。
 */
export class StringPool {
    constructor() {
        /** string → id */
        this._map = new Map();
        /**
         * LRU 顺序追踪：insertion-order Map，key=string，最旧的在迭代器头部。
         * 命中时：delete + re-set 移到末尾。
         */
        this._lruOrder = new Map();
        /** 下一个可用 ID */
        this._nextId = 1;
        /** 本轮新注册的条目（待 flush 到流） */
        this._pending = [];
        /** 累计淘汰次数（用于调试/监控） */
        this._evictions = 0;
    }

    /** 已注册条目数 */
    get size() { return this._map.size; }

    /** 累计淘汰条目数 */
    get evictions() { return this._evictions; }

    /**
     * 查找字符串在字典中的 ID，同时更新 LRU 顺序。
     * @param {string} s
     * @returns {number|null}  字典 ID，若不在字典中返回 null
     */
    lookup(s) {
        const id = this._map.get(s);
        if (id === undefined) return null;
        // 更新 LRU：移到末尾（最近使用）
        this._lruOrder.delete(s);
        this._lruOrder.set(s, id);
        return id;
    }

    /**
     * 尝试将字符串注册到字典，返回分配的 ID。
     * 若已存在则返回现有 ID（并更新 LRU）；若字符串太短则返回 null。
     * 当条目数达到 LRU_EVICT_THRESHOLD 时先执行淘汰再分配新 ID。
     * 新注册的条目会进入 _pending 列表，等待 flushDictEntries() 取出。
     *
     * @param {string} s
     * @returns {number|null}  字典 ID，或 null（不入池）
     */
    register(s) {
        if (typeof s !== 'string') return null;
        if (s.length < MIN_POOL_STR_LEN) return null;
        const existing = this._map.get(s);
        if (existing !== undefined) {
            // 命中：更新 LRU
            this._lruOrder.delete(s);
            this._lruOrder.set(s, existing);
            return existing;
        }
        // 达到淘汰阈值：驱逐最旧的 LRU_EVICT_COUNT 条
        if (this._map.size >= LRU_EVICT_THRESHOLD) {
            this._evict(LRU_EVICT_COUNT);
        }
        // ID 耗尽（淘汰后 _nextId 继续增长，不复用旧 ID）
        if (this._nextId > MAX_POOL_SIZE) return null;
        const id = this._nextId++;
        this._map.set(s, id);
        this._lruOrder.set(s, id);
        this._pending.push({ id, str: s });
        return id;
    }

    /**
     * 淘汰最久未访问的 count 个条目。
     * @private
     */
    _evict(count) {
        let evicted = 0;
        for (const [str] of this._lruOrder) {
            if (evicted >= count) break;
            this._map.delete(str);
            this._lruOrder.delete(str);
            evicted++;
        }
        this._evictions += evicted;
    }

    /**
     * 批量预扫描：将事件批次中所有字符串字段提前注册到字典。
     * 必须在 serializeBatch 之前调用，确保序列化时 lookup() 能命中。
     *
     * @param {Array<object>} events
     */
    scanBatch(events) {
        for (const event of events) {
            this._scanEvent(event);
        }
    }

    /** @private */
    _scanStr(s) {
        if (typeof s === 'string') this.register(s);
    }

    /** @private */
    _scanValue(v) {
        if (typeof v === 'string') this._scanStr(v);
        else if (v !== null && typeof v === 'object') {
            // JSON 序列化后的字符串也可能重复（但跳过，避免提前序列化影响性能）
        }
    }

    /** @private */
    _scanEvent(event) {
        const type = event.type;
        switch (type) {
            case 'SCRIPT_ENTER':
                this._scanStr(event.file ?? '');
                break;
            case 'CALL_PRE':
                this._scanStr(event.fn ?? '');
                if (event.args) {
                    for (const a of event.args) this._scanValue(a);
                }
                break;
            case 'CALL':
                this._scanStr(event.fn ?? '');
                this._scanValue(event.result);
                break;
            case 'END_EXPR': {
                const writes = event.writes ?? [];
                const reads  = event.reads  ?? [];
                const fields = event.fields ?? [];
                for (const w of writes) {
                    this._scanStr(w.name);
                    this._scanValue(w.val);
                }
                for (const r of reads) {
                    this._scanStr(r.name);
                    this._scanValue(r.val);
                }
                for (const f of fields) {
                    this._scanStr(String(f.offset ?? ''));
                    this._scanValue(f.val);
                    // base_oid 是 u32，不走 StringPool
                }
                break;
            }
            case 'KEY_EVENT':
                this._scanStr(event.text ?? '');
                break;
            case 'WRITE_VAR':
            case 'READ_VAR_FULL':
                this._scanStr(event.name ?? '');
                this._scanValue(event.val);
                break;
        }
    }

    /**
     * 取出并清空待写出的新字典条目。
     * 返回格式与 EVENT_TYPE.DICT_ENTRY 的事件对象一致，
     * 可直接传给 _serializeDictEntry() 序列化。
     *
     * @returns {Array<{id: number, str: string}>}
     */
    flushPending() {
        if (this._pending.length === 0) return [];
        const out = this._pending;
        this._pending = [];
        return out;
    }

    /** 字典当前条目数 */
    get size() { return this._map.size; }

    /** 当前字典内容（用于调试/测试） */
    toMap() { return new Map(this._map); }
}

// ─── 事件序列化（无状态，无池化）────────────────────────────────────────────

/**
 * 计算单条事件所需的 payload 字节数，返回序列化所需的中间结构。
 * 分两步（measure + write）避免两次 TextEncoder 调用。
 *
 * @param {object} event  标准化事件对象（字段见各 EVENT_TYPE 说明）
 * @param {StringPool|null} [pool=null]  字符串池（非 null 时启用字典压缩）
 * @returns {{ payloadSize: number, _m: object }}  _m 为中间测量结果（供 writeEventPayload 使用）
 */
function measureEvent(event, pool = null) {
    const { type } = event;

    switch (type) {
        case 'SCRIPT_ENTER': {
            const fm = measureStr(event.file ?? '', pool);
            return { payloadSize: strFieldBytes(fm), _m: { fm } };
        }

        case 'SCRIPT_EXIT': {
            const hasEx = event.exception !== undefined && event.exception !== null;
            if (!hasEx) return { payloadSize: 0, _m: { hasEx } };
            const mv = measureValue(event.exception, false, pool);
            return { payloadSize: 1 + mv.extraBytes, _m: { hasEx, mv, exVal: event.exception } };
        }

        case 'CALL_PRE': {
            const fnm = measureStr((event.fn ?? '').slice(0, 255), pool);
            const args   = event.args ?? [];
            const argc   = Math.min(args.length, 8);  // 最多记录8个参数
            let argsSize = 0;
            const argMeasures = [];
            for (let i = 0; i < argc; i++) {
                const mv = measureValue(args[i], false, pool);
                argsSize += 1 + mv.extraBytes;  // valueType + extra
                argMeasures.push(mv);
            }
            const hasThis = event.isMethod && event.base !== undefined;
            let thisSize = 0;
            let thisMv;
            if (hasThis) {
                thisMv = measureValue(event.base, false, pool);
                thisSize = 1 + thisMv.extraBytes;
            }
            // fnDefIid：被调函数定义点 iid（仅插桩 JS 函数有值）
            const hasFnDefIid = event.fnDefIid !== undefined && event.fnDefIid !== null;
            const fnDefIidSize = hasFnDefIid ? 4 : 0;  // u32 = 4B
            const payloadSize = strFieldBytes(fnm) + 1 + argsSize + thisSize + fnDefIidSize;
            return { payloadSize, _m: { fnm, argc, argMeasures, args, hasThis, thisMv, base: event.base, hasFnDefIid, fnDefIid: event.fnDefIid } };
        }

        case 'CALL': {
            const fnm = measureStr((event.fn ?? '').slice(0, 255), pool);
            const mv = measureValue(event.result, false, pool);
            return { payloadSize: strFieldBytes(fnm) + 1 + mv.extraBytes, _m: { fnm, mv, result: event.result } };
        }

        case 'FUNCTION_ENTER':
            return { payloadSize: 0, _m: {} };

        case 'FUNCTION_EXIT': {
            const hasEx = !!(event.exception);
            if (!hasEx) return { payloadSize: 0, _m: { hasEx } };
            const mv = measureValue(event.exception, false, pool);
            return { payloadSize: 1 + mv.extraBytes, _m: { hasEx, mv, exVal: event.exception } };
        }

        case 'END_EXPR': {
            const writes = event.writes ?? [];
            const reads  = event.reads  ?? [];
            const fields = event.fields ?? [];
            let size = 1 + 1 + 1;  // writeCount + readCount + fieldCount (all u8)
            const wm = [], rm = [], fm = [];
            for (const w of writes) {
                const nm = measureStr(w.name, pool);
                const mv = measureValue(w.val, w.omit === true, pool);
                // v2：writes 条目末尾附加 val_oid u32（4B，0=非对象）
                size += strFieldBytes(nm) + 1 + mv.extraBytes + 4;
                wm.push({ nm, mv, val: w.val, omit: w.omit, oid: w.oid ?? 0 });
            }
            for (const r of reads) {
                const nm = measureStr(r.name, pool);
                const mv = measureValue(r.val, r.omit === true, pool);
                size += strFieldBytes(nm) + 1 + mv.extraBytes;
                rm.push({ nm, mv, val: r.val, omit: r.omit });
            }
            for (const f of fields) {
                const onm = measureStr(String(f.offset ?? ''), pool);
                const mv = measureValue(f.val, false, pool);
                // [offset_str][isWrite 1B][val(1B vt + extraBytes)][base_oid u32 4B]
                size += strFieldBytes(onm) + 1 + 1 + mv.extraBytes + 4;
                fm.push({ onm, mv, val: f.val, isWrite: f.isWrite, baseOid: f.baseOid ?? 0 });
            }
            return { payloadSize: size, _m: { writes, reads, fields, wm, rm, fm } };
        }

        case 'KEY_EVENT': {
            const level = event.level === 'error' ? 2 : event.level === 'warn' ? 1 : 0;
            const tm = measureStr(event.text ?? '', pool);
            return { payloadSize: 1 + strFieldBytes(tm), _m: { level, tm } };
        }

        case 'WRITE_VAR': {
            const nm = measureStr(event.name ?? '', pool);
            const mv = measureValue(event.val, false, pool);
            return { payloadSize: strFieldBytes(nm) + 1 + mv.extraBytes, _m: { nm, mv, val: event.val } };
        }

        case 'READ_VAR_FULL': {
            const nm = measureStr(event.name ?? '', pool);
            const mv = measureValue(event.val, false, pool);
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
            }
            for (const r of _m.rm) {
                offset = writeStr(view, offset, r.nm);
                offset = writeValue(view, offset, r.mv, r.val);
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

// ─── DICT_ENTRY 事件序列化 ────────────────────────────────────────────────────

/**
 * 将单条 DICT_ENTRY 序列化为 ArrayBuffer。
 * 格式：[12B 头][2B id][2B str_len][UTF-8 字节]
 * @param {number} id   字典 ID（u16）
 * @param {string} str  字符串内容
 * @param {number} seq  序号
 * @returns {ArrayBuffer}
 */
function serializeDictEntry(id, str, seq) {
    const nb = encodeUtf8(str.length > 65533 ? str.slice(0, 65532) + '…' : str);
    const payloadSize = 2 + 2 + nb.length;  // id(u16) + len(u16) + bytes
    const totalSize   = EVENT_HEADER_SIZE + payloadSize;
    const buf  = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    view.setUint8(0,   EVENT_TYPE.DICT_ENTRY);
    view.setUint8(1,   0);  // flags
    view.setUint32(2,  0, true);  // iid = 0（字典条目无对应 iid）
    view.setUint32(6,  seq >>> 0, true);
    view.setUint16(10, payloadSize, true);
    view.setUint16(12, id, true);
    view.setUint16(14, nb.length, true);
    new Uint8Array(buf, 16).set(nb);
    return buf;
}

// ─── 无状态公开 API（向后兼容）───────────────────────────────────────────────

/**
 * 将单条事件序列化为 ArrayBuffer（含 12 字节头 + payload）。
 * 无状态版本，不支持字典压缩。
 *
 * @param {object} event   标准化事件对象
 * @returns {ArrayBuffer}
 */
export function serializeEvent(event) {
    const { payloadSize, _m } = measureEvent(event, null);
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
        const m = measureEvent(events[i], null);
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
 * @returns {number}  版本号（0x01=旧版，0x02=支持 write.oid）
 */
export function readFileVersion(viewOrBuf) {
    const view = viewOrBuf instanceof DataView
        ? viewOrBuf
        : new DataView(viewOrBuf.buffer ?? viewOrBuf, viewOrBuf.byteOffset ?? 0);
    return view.getUint8(4);
}

// ─── 有状态序列化器（Value Pool 版本）──────────────────────────────────────────

/**
 * EventSerializerWithPool — 带字典压缩的有状态事件序列化器。
 *
 * 内部持有一个 StringPool，对 serializeBatch() 的输出自动前置必要的
 * DICT_ENTRY 事件（新字符串条目），解码器按顺序读取即可重建字典。
 *
 * 使用模式（NodeStreamBackend 集成）：
 *
 * ```js
 * const serializer = new EventSerializerWithPool();
 * // 写文件头（一次）
 * stream.write(Buffer.from(serializer.createFileHeader()));
 * // 每个 batch：
 * const buffers = serializer.serializeBatch(batch);  // ArrayBuffer[]
 * for (const buf of buffers) stream.write(Buffer.from(buf));
 * ```
 *
 * 注意：序列化器是有状态的，不要在多个文件流之间共享同一实例。
 * 每个输出文件/连接应创建独立实例。
 */
export class EventSerializerWithPool {
    /**
     * @param {object} [options]
     * @param {number} [options.minStrLen=4]  最小入池字符串长度（覆盖 MIN_POOL_STR_LEN）
     */
    constructor(options = {}) {
        this._pool    = new StringPool();
        this._dictSeq = 0;  // DICT_ENTRY 事件独立序号（不影响业务事件 seq）
        if (options.minStrLen !== undefined) {
            // 暂存选项，目前 MIN_POOL_STR_LEN 为模块常量；
            // 若需要实例级覆盖，可在此处扩展 StringPool
        }
    }

    /** 返回内部字符串池（只读，用于测试/调试） */
    get pool() { return this._pool; }

    /**
     * 创建文件头 ArrayBuffer（同无状态版本，为方便一站式调用提供）。
     * @returns {ArrayBuffer}
     */
    createFileHeader() {
        return createFileHeader();
    }

    /**
     * 将事件批次序列化为一组 ArrayBuffer（含前置字典条目和压缩后的事件流）。
     *
     * 返回值是 **ArrayBuffer 数组**（而非单个 ArrayBuffer），原因：
     * - 前置的 DICT_ENTRY 事件和业务事件分开存放，避免一次性大内存分配；
     * - 调用方（NodeStreamBackend）可以用 writev / 多次 write 依次写出。
     *
     * @param {Array<object>} events  标准化事件数组（各字段含义同 serializeBatch）
     * @returns {Array<ArrayBuffer>}  按顺序写出即可
     */
    serializeBatch(events) {
        // 1. 预扫描：将 batch 中所有字符串注册到字典（产生 pending 条目）
        this._pool.scanBatch(events);

        // 2. 取出新字典条目，序列化为 DICT_ENTRY 事件
        const pending = this._pool.flushPending();
        const result  = [];

        for (const { id, str } of pending) {
            result.push(serializeDictEntry(id, str, ++this._dictSeq));
        }

        // 3. 序列化业务事件（使用池化 measure）
        const measured = new Array(events.length);
        let totalSize = 0;
        for (let i = 0; i < events.length; i++) {
            const m = measureEvent(events[i], this._pool);
            const { typeByte, flagsByte } = computeTypeAndFlags(events[i]);
            measured[i] = { ...m, typeByte, flagsByte };
            totalSize += EVENT_HEADER_SIZE + m.payloadSize;
        }

        if (totalSize > 0) {
            const buf  = new ArrayBuffer(totalSize);
            const view = new DataView(buf);
            let offset = 0;

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

            result.push(buf);
        }

        return result;
    }

    /** 返回压缩统计信息（用于调试/基准测试） */
    getStats() {
        return {
            dictSize:   this._pool.size,
            dictEntries: this._dictSeq,
        };
    }
}

// ─── 事件反序列化 ──────────────────────────────────────────────────────────────

/**
 * 从 DataView 的指定 offset 处反序列化一条事件（含 12 字节头）。
 * 支持字典引用（DICT_ENTRY 事件会自动更新传入的 dict）。
 *
 * @param {DataView} view
 * @param {number}   offset
 * @param {Map<number,string>} [dict]  字符串字典（解码 STRING_REF / 0xFFFF 哨兵用，可复用）
 * @returns {{ event: object, nextOffset: number }}
 */
export function deserializeEvent(view, offset, dict = null, version = FORMAT_VERSION) {
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
            const r = readStr(view, pos, dict);
            event.file = r.str;
            pos = r.end;
            break;
        }

        case 'SCRIPT_EXIT': {
            if (flagsByte & FLAGS.HAS_EXCEPTION) {
                const r = readValue(view, pos, dict);
                event.exception = r.value;
                pos = r.end;
            }
            break;
        }

        case 'CALL_PRE': {
            event.isConstructor = !!(flagsByte & FLAGS.IS_CONSTRUCTOR);
            event.isMethod      = !!(flagsByte & FLAGS.IS_METHOD);
            const rfn = readStr(view, pos, dict);
            event.fn = rfn.str;
            pos = rfn.end;
            const argc = view.getUint8(pos);
            pos += 1;
            event.args = [];
            for (let i = 0; i < argc; i++) {
                const r = readValue(view, pos, dict);
                event.args.push(r.omitted ? undefined : r.value);
                pos = r.end;
            }
            if (flagsByte & FLAGS.HAS_THIS) {
                const r = readValue(view, pos, dict);
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
            const rfn = readStr(view, pos, dict);
            event.fn = rfn.str;
            pos = rfn.end;
            const r = readValue(view, pos, dict);
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
                const r = readValue(view, pos, dict);
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
                const rn = readStr(view, pos, dict);
                pos = rn.end;
                const rv = readValue(view, pos, dict);
                pos = rv.end;
                let writeOid = null;
                if (version >= 0x02) {
                    // v2：条目末尾有 val_oid u32
                    const rawOid = view.getUint32(pos, true);
                    writeOid = rawOid === 0 ? null : rawOid;
                    pos += 4;
                }
                event.writes.push({ name: rn.str, value: rv.value, omitted: rv.omitted, oid: writeOid });
            }
            for (let i = 0; i < readCount; i++) {
                const rn = readStr(view, pos, dict);
                pos = rn.end;
                const rv = readValue(view, pos, dict);
                pos = rv.end;
                event.reads.push({ name: rn.str, value: rv.value, omitted: rv.omitted });
            }
            for (let i = 0; i < fieldCount; i++) {
                // [offset_str][isWrite 1B][val][base_oid u32]
                const ro = readStr(view, pos, dict);
                pos = ro.end;
                const isWrite = view.getUint8(pos) !== 0;
                pos += 1;
                const rv = readValue(view, pos, dict);
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
            const rt = readStr(view, pos, dict);
            pos = rt.end;
            event.level = levelByte === 2 ? 'error' : levelByte === 1 ? 'warn' : 'info';
            event.text  = rt.str;
            break;
        }

        case 'DICT_ENTRY': {
            // 自动更新 dict：[id u16][str_len u16][UTF-8]
            const id     = view.getUint16(pos, true);
            pos += 2;
            const strLen = view.getUint16(pos, true);
            pos += 2;
            const bytes  = new Uint8Array(view.buffer, pos, strLen);
            const str    = td ? td.decode(bytes) : Buffer.from(bytes).toString('utf8');
            pos += strLen;
            if (dict) dict.set(id, str);
            event.id  = id;
            event.str = str;
            break;
        }

        case 'WRITE_VAR':
        case 'READ_VAR_FULL': {
            const rn = readStr(view, pos, dict);
            pos = rn.end;
            const rv = readValue(view, pos, dict);
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
 * 自动维护字典状态（支持 DICT_ENTRY 事件，解码后续 STRING_REF）。
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
    const version = ab.byteLength >= FILE_HEADER_SIZE ? readFileVersion(view) : FORMAT_VERSION;
    let offset = FILE_HEADER_SIZE;
    let index  = 0;
    const dict      = new Map();  // 字符串字典，在 DICT_ENTRY 事件中自动填充
    const seenSeqs  = dedupe ? new Set() : null;  // seq 去重集合

    while (offset + EVENT_HEADER_SIZE <= ab.byteLength) {
        const { event, nextOffset } = deserializeEvent(view, offset, dict, version);
        // 防止解析错误导致死循环：nextOffset 必须严格大于当前 offset
        if (nextOffset <= offset) break;
        offset = nextOffset;

        // seq 去重：跳过已见过的事件（重连重发场景）。
        // DICT_ENTRY 本身没有业务 seq，不参与去重，但照常传递给回调（保持向后兼容）。
        if (seenSeqs !== null && event.type !== 'DICT_ENTRY') {
            if (seenSeqs.has(event.seq)) continue;
            seenSeqs.add(event.seq);
        }

        callback(event, index++);
    }
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
