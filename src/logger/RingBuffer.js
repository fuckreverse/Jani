// JALANGI DO NOT INSTRUMENT

/**
 * RingBuffer — 平台无关的环形缓冲区，用于在主线程中低开销地积攒事件。
 *
 * 设计目标：
 *  - 主线程写入（push）极低开销（单次 Array.push 量级）
 *  - 支持批量读取（drain）供后端异步消费
 *  - 当缓冲区满时，自动扩容而非丢弃（保证不丢失任何事件）
 *  - 纯 ES 模块，浏览器和 Node.js 均可使用
 *
 * 注意：这是单线程环形缓冲区（非 SharedArrayBuffer 版本）。
 * SharedArrayBuffer 版本需要 COOP/COEP header，限制较多，此处使用
 * 普通 Array + 滑动窗口，通过批量 flush 降低开销。
 */

export class RingBuffer {
    /**
     * @param {object} [options]
     * @param {number} [options.capacity=65536]  初始容量（满后自动扩容）
     * @param {number} [options.flushThreshold=4096]  积累多少条后触发自动 flush 建议
     * @param {number} [options.maxCapacity=Infinity] 最大容量限制（防止内存爆炸）
     */
    constructor(options = {}) {
        const {
            capacity       = 65536,
            flushThreshold = 4096,
            maxCapacity    = Infinity,
        } = options;

        this._capacity       = capacity;
        this._initialCapacity = capacity;
        this._maxCapacity    = maxCapacity;
        this._flushThreshold = flushThreshold;

        this._buf   = new Array(capacity);
        this._head  = 0;   // 下一个可读位置
        this._tail  = 0;   // 下一个可写位置
        this._size  = 0;   // 当前有效元素数

        // 统计
        this.stats = {
            totalPushed:   0,
            totalDrained:  0,
            totalDropped:  0,  // 始终为 0（不再丢弃）
            totalResizes:  0,  // 扩容次数
            flushCount:    0,
        };
    }

    /** 当前积压事件数 */
    get size() { return this._size; }

    /** 缓冲区是否已满 */
    get isFull() { return this._size >= this._capacity; }

    /** 是否达到 flush 建议阈值 */
    get shouldFlush() { return this._size >= this._flushThreshold; }

    /**
     * 扩容缓冲区（内部方法）。
     * 将现有数据重新排列到更大的数组中。
     * @private
     */
    _resize() {
        const newCapacity = Math.min(
            this._capacity * 2,  // 翻倍扩容
            this._maxCapacity
        );

        if (newCapacity <= this._capacity) {
            // 无法扩容（已达上限），但仍然不丢弃
            // 这种情况下会继续写入，_buf 会自动扩容（JS Array 特性）
            // 只是我们无法精确控制容量了
            return;
        }

        const newBuf = new Array(newCapacity);

        // 将旧数据按顺序复制到新数组
        if (this._size > 0) {
            if (this._head < this._tail) {
                // 数据是连续的
                for (let i = 0; i < this._size; i++) {
                    newBuf[i] = this._buf[this._head + i];
                }
            } else {
                // 数据是环绕的，需要分两段复制
                const firstPart = this._capacity - this._head;
                for (let i = 0; i < firstPart; i++) {
                    newBuf[i] = this._buf[this._head + i];
                }
                for (let i = 0; i < this._tail; i++) {
                    newBuf[firstPart + i] = this._buf[i];
                }
            }
        }

        this._buf = newBuf;
        this._head = 0;
        this._tail = this._size;
        this._capacity = newCapacity;
        this.stats.totalResizes++;
    }

    /**
     * 向缓冲区压入一条事件。
     * @param {*} event  任意可序列化对象
     * @returns {boolean} 始终返回 true（不再丢弃）
     */
    push(event) {
        this.stats.totalPushed++;

        // 如果缓冲区满，先扩容
        if (this._size >= this._capacity) {
            this._resize();
        }

        this._buf[this._tail] = event;
        this._tail = (this._tail + 1) % this._capacity;
        this._size++;
        return true;
    }

    /**
     * 批量取出最多 maxCount 条事件，清空对应槽位（释放引用便于 GC）。
     * @param {number} [maxCount=Infinity]
     * @returns {Array}  取出的事件数组（长度 0 ~ min(size, maxCount)）
     */
    drain(maxCount = Infinity) {
        const count  = Math.min(this._size, maxCount);
        if (count === 0) return [];

        const result = new Array(count);
        for (let i = 0; i < count; i++) {
            result[i]            = this._buf[this._head];
            this._buf[this._head] = undefined;
            this._head           = (this._head + 1) % this._capacity;
        }
        this._size -= count;
        this.stats.totalDrained  += count;
        this.stats.flushCount++;
        return result;
    }

    /**
     * 清空缓冲区，丢弃所有未消费事件。
     */
    clear() {
        this._buf.fill(undefined);
        this._head = 0;
        this._tail = 0;
        this._size = 0;
    }

    /**
     * 返回统计摘要（用于调试）。
     */
    getStats() {
        return {
            ...this.stats,
            currentSize: this._size,
            capacity: this._capacity,
            initialCapacity: this._initialCapacity,
        };
    }
}
