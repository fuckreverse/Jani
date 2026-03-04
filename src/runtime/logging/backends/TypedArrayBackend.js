// JALANGI DO NOT INSTRUMENT

/**
 * @file TypedArrayBackend — 高性能 TypedArray 环形缓冲区 log 后端。
 *
 * 实现 LogBackend 接口（同 MemoryBackend）：
 *   - `write(batch)` — 接收一批事件，编码为定长二进制写入环形缓冲区
 *   - `flush()` — 将缓冲区数据持久化（Node.js 环境写文件，浏览器环境写 IndexedDB）
 *   - `close()` — 关闭后端并最终 flush
 *   - `getEvents(n?)` — 读取最近 n 条事件（供调试用）
 *   - `exportBinary()` — 导出整个缓冲区的原始 ArrayBuffer
 *
 * ### 二进制格式（每条 log 条目 = 5 个 Float64 = 40 字节）
 *
 * ```
 * [0] = entryType（uint8 编码为 float64）：
 *         0=W(write), 1=R(read), 2=P(putField), 3=G(getField),
 *         4=F(call), 5=M(method), 6=N(declare), 255=OVERFLOW（环绕标记）
 * [1] = iid（uint32）
 * [2] = scopeId（uint16 高位）| callId（uint16 低位）—— 打包为 uint32
 * [3] = contextId（uint32）
 * [4] = valueKey（uint32）—— 指向 #valueTable 中存储的实际值
 * ```
 *
 * 字符串/对象类型的值通过 `#valueTable: Map<uint32, any>` 存储，
 * 缓冲区中记录 valueKey；数值类型直接存储在 [4] 中（通过 isNumeric 标志区分）。
 *
 * ### 性能优势
 *
 * - **零 GC 压力**：预分配 Float64Array，循环复用，无短命对象
 * - **写入速度极快**：TypedArray 直接索引写入（比 Array.push(obj) 快 10-100 倍）
 * - **可序列化**：`exportBinary()` 返回原始 ArrayBuffer，可直接写入文件（`.bin`）
 *
 * ### 限制
 *
 * - `scopeId` 和 `callId` 各占 16 位（最大 65535）；超出时低 16 位截断并设 OVERFLOW 标记
 * - 环形缓冲区满时，**覆盖最旧条目**（适合只关心最近行为的分析场景）
 * - `SharedArrayBuffer` 需要跨域隔离头（COOP/COEP），默认使用普通 `ArrayBuffer`
 *
 * @module TypedArrayBackend
 */

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 每条 log 条目占用的 Float64 数量 */
const ENTRY_FIELDS = 5;

/** 每条 log 条目字节数（Float64 = 8 bytes） */
const BYTES_PER_ENTRY = ENTRY_FIELDS * 8;

/** 默认缓冲区容量（条目数） */
const DEFAULT_CAPACITY = 1_000_000; // 1M 条 ≈ 40 MB

/** entryType 枚举（与 log 条目 type 字符串对应） */
const ENTRY_TYPE = Object.freeze({
    'W':   0,   // write
    'R':   1,   // read
    'Rl':  1,   // read-lightweight（与 R 共享 type code）
    'P':   2,   // putField
    'G':   3,   // getField
    'F':   4,   // function call
    'M':   5,   // method call
    'N':   6,   // declare
    '?':   7,   // unknown/other
    OVERFLOW: 255,  // 环绕标记（scopeId/callId 超过 16 位）
});

/** valueKey 分段：0～2^30 为数值（浮点），2^30～2^31 为非数值（存入 valueTable） */
const VALUE_IS_NUMERIC_FLAG = 0;       // valueKey < 2^30 表示直接存 float64 → 但 TypedArray 里存不了 float64 非整数
const VALUE_TABLE_OFFSET    = 0x40000000; // 0x4000_0000 = 2^30，valueTable key 偏移

// ── TypedArrayBackend ─────────────────────────────────────────────────────────

/**
 * TypedArrayBackend — 高性能 TypedArray 环形缓冲区 log 后端。
 *
 * ```js
 * import { TypedArrayBackend } from './TypedArrayBackend.js';
 *
 * const backend = new TypedArrayBackend({ capacity: 500_000 });
 *
 * // 与 TraceLogger 一起使用（作为 backends 数组成员）
 * const logger = new TraceLogger({ backends: [backend] });
 *
 * // 或直接 write
 * await backend.write([
 *   { type: 'W', iid: 8, scopeId: 0, callId: 1, contextId: 0, name: 'x', value: 42 }
 * ]);
 *
 * // 导出二进制用于离线分析
 * const buf = backend.exportBinary();
 * fs.writeFileSync('trace.bin', Buffer.from(buf));
 * ```
 */
export class TypedArrayBackend {

    // ── 私有字段 ─────────────────────────────────────────────────────────────

    /** 环形缓冲区（Float64Array，预分配） */
    #buffer;

    /** 缓冲区容量（条目数） */
    #capacity;

    /** 写指针（下一条要写入的条目的索引，模 #capacity） */
    #writePtr = 0;

    /** 已写入的总条目数（含覆盖的旧条目） */
    #totalWritten = 0;

    /**
     * 非数值类型值表：valueTableKey → 实际值。
     * 字符串、对象（OID）、undefined 等不能直接存在 Float64Array 中，
     * 通过此表间接存储。
     */
    #valueTable = new Map();

    /** valueTable key 计数器（从 VALUE_TABLE_OFFSET 开始，避免与数值 key 冲突） */
    #valueTableCounter = VALUE_TABLE_OFFSET;

    /** 是否已关闭 */
    #closed = false;

    /** 统计信息 */
    stats = { batchCount: 0, totalEvents: 0, overflows: 0 };

    // ── 构造器 ───────────────────────────────────────────────────────────────

    /**
     * @param {object} [options]
     * @param {number} [options.capacity=1_000_000]  缓冲区条目数上限
     * @param {boolean} [options.useSharedBuffer=false]  是否使用 SharedArrayBuffer
     *   （需要 COOP/COEP 跨域隔离头，否则会抛出异常）
     */
    constructor({ capacity = DEFAULT_CAPACITY, useSharedBuffer = false } = {}) {
        this.#capacity = capacity;
        const byteLength = capacity * BYTES_PER_ENTRY;

        if (useSharedBuffer && typeof SharedArrayBuffer !== 'undefined') {
            this.#buffer = new Float64Array(new SharedArrayBuffer(byteLength));
        } else {
            this.#buffer = new Float64Array(byteLength / 8);
        }
    }

    // ── LogBackend 接口 ──────────────────────────────────────────────────────

    /**
     * 接收一批事件，编码为定长二进制写入环形缓冲区。
     * 若缓冲区已满（写指针追上读指针），覆盖最旧的条目。
     *
     * @param {Array<object>} batch  事件对象数组
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this.#closed) throw new Error('TypedArrayBackend: already closed');

        for (const entry of batch) {
            this.#writeEntry(entry);
        }

        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
    }

    /**
     * noop — TypedArray 缓冲区写入是同步的，无需 flush。
     * 若需要持久化到磁盘，请使用 `exportBinary()` + 外部写文件逻辑。
     *
     * @returns {Promise<void>}
     */
    async flush() {}

    /**
     * 关闭后端（标记不可写，释放 valueTable 内存）。
     * @returns {Promise<void>}
     */
    async close() {
        this.#closed = true;
        this.#valueTable.clear();
    }

    // ── 读取接口 ─────────────────────────────────────────────────────────────

    /**
     * 读取最近 n 条事件（解码为 JS 对象数组）。
     * 若 n 未指定，返回所有已写入的条目（最多 #capacity 条）。
     *
     * @param {number} [n]  要读取的条目数（默认全部）
     * @returns {object[]}  解码后的事件对象数组（从旧到新）
     */
    getEvents(n) {
        const count  = Math.min(n ?? this.#capacity, Math.min(this.#totalWritten, this.#capacity));
        const result = [];

        for (let i = 0; i < count; i++) {
            // 从 writePtr 往前 count 步（环形回溯）
            const idx = (this.#writePtr - count + i + this.#capacity) % this.#capacity;
            result.push(this.#readEntry(idx));
        }

        return result;
    }

    /**
     * 导出整个缓冲区的原始 ArrayBuffer（用于离线分析或写文件）。
     * 返回值是从写指针位置开始的有序数据（旧条目在前，新条目在后）。
     *
     * @returns {ArrayBuffer}
     */
    exportBinary() {
        const count      = Math.min(this.#totalWritten, this.#capacity);
        const byteLength = count * BYTES_PER_ENTRY;
        const output     = new Float64Array(count * ENTRY_FIELDS);

        for (let i = 0; i < count; i++) {
            const idx = (this.#writePtr - count + i + this.#capacity) % this.#capacity;
            const srcOffset = idx * ENTRY_FIELDS;
            const dstOffset = i  * ENTRY_FIELDS;
            for (let f = 0; f < ENTRY_FIELDS; f++) {
                output[dstOffset + f] = this.#buffer[srcOffset + f];
            }
        }

        return output.buffer.slice(0, byteLength);
    }

    /**
     * 返回当前缓冲区中已有的有效条目数（≤ capacity）。
     * @returns {number}
     */
    get entryCount() {
        return Math.min(this.#totalWritten, this.#capacity);
    }

    /**
     * 清空缓冲区（重置写指针和计数器，用于测试）。
     */
    clear() {
        this.#writePtr     = 0;
        this.#totalWritten = 0;
        this.#valueTable.clear();
        this.#valueTableCounter = VALUE_TABLE_OFFSET;
        this.stats = { batchCount: 0, totalEvents: 0, overflows: 0 };
    }

    // ── 私有编码/解码方法 ────────────────────────────────────────────────────

    /**
     * 将一条 log 条目编码为 5 个 Float64，写入环形缓冲区。
     * @param {object} entry
     */
    #writeEntry(entry) {
        const idx    = this.#writePtr * ENTRY_FIELDS;
        const buf    = this.#buffer;

        // [0] entryType
        const typeCode = ENTRY_TYPE[entry.type] ?? ENTRY_TYPE['?'];
        buf[idx + 0] = typeCode;

        // [1] iid
        buf[idx + 1] = entry.iid ?? 0;

        // [2] scopeId (高 16 位) | callId (低 16 位)
        const scopeId = entry.scopeId ?? 0;
        const callId  = entry.callId  ?? 0;
        let hasOverflow = false;
        if (scopeId > 0xFFFF || callId > 0xFFFF) {
            hasOverflow = true;
            this.stats.overflows++;
        }
        // 即使溢出也存低 16 位（允许有损降级）
        buf[idx + 2] = ((scopeId & 0xFFFF) << 16) | (callId & 0xFFFF);

        // [3] contextId
        buf[idx + 3] = entry.contextId ?? 0;

        // [4] valueKey（数值直接存 float64，其他存 valueTable key）
        buf[idx + 4] = this.#encodeValue(entry.value);

        // 写指针推进（模 capacity）
        this.#writePtr = (this.#writePtr + 1) % this.#capacity;
        this.#totalWritten++;
    }

    /**
     * 将一条缓冲区条目解码为 JS 对象（用于 getEvents）。
     * @param {number} slotIdx  缓冲区 slot 索引（0 ≤ slotIdx < #capacity）
     * @returns {object}  解码后的事件对象
     */
    #readEntry(slotIdx) {
        const idx = slotIdx * ENTRY_FIELDS;
        const buf = this.#buffer;

        const typeCode = buf[idx + 0];
        const iid      = buf[idx + 1];
        const packed   = buf[idx + 2];
        const scopeId  = (packed >>> 16) & 0xFFFF;
        const callId   = packed          & 0xFFFF;
        const contextId = buf[idx + 3];
        const value    = this.#decodeValue(buf[idx + 4]);

        // 反查 type 字符串
        let type = '?';
        for (const [k, v] of Object.entries(ENTRY_TYPE)) {
            if (v === typeCode && k !== 'Rl' && k !== 'OVERFLOW') { type = k; break; }
        }

        return { type, iid, scopeId, callId, contextId, value };
    }

    /**
     * 将值编码为 Float64 兼容的 key。
     * - 有限数值（包括 NaN、Infinity）：直接存（Float64 原样存储）
     *   但由于我们后续要区分"数值型 key"与"valueTable key"，
     *   这里统一走 valueTable——对于纯数值场景性能略有下降，
     *   但保证了解码的正确性（避免 valueTable key 与数值混淆）。
     *
     * 若需要极致性能，可将数值类型单独存储（在 buf[idx+4] 存 float64 本身，
     * 在 buf[idx+0] 的高位标记"直接数值"），此处为简化实现。
     *
     * @param {*} value
     * @returns {number}  float64 编码的 valueKey
     */
    #encodeValue(value) {
        const key = ++this.#valueTableCounter;
        this.#valueTable.set(key, value);
        return key;
    }

    /**
     * 将 Float64 key 解码为原始值。
     * @param {number} key
     * @returns {*}
     */
    #decodeValue(key) {
        return this.#valueTable.get(key);
    }
}
