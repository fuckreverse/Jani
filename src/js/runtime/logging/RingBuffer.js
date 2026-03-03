// JALANGI DO NOT INSTRUMENT

/**
 * RingBuffer — 平台无关的环形缓冲区，用于在主线程中低开销地积攒事件。
 *
 * 设计目标：
 *  - 主线程写入（push）极低开销（单次 Array.push 量级）
 *  - 支持批量读取（drain）供后端异步消费
 *  - 当缓冲区满时，根据策略丢弃最旧数据（保证不阻塞主线程）
 *  - 纯 ES 模块，浏览器和 Node.js 均可使用
 *
 * 注意：这是单线程环形缓冲区（非 SharedArrayBuffer 版本）。
 * SharedArrayBuffer 版本需要 COOP/COEP header，限制较多，此处使用
 * 普通 Array + 滑动窗口，通过批量 flush 降低开销。
 */

export class RingBuffer {
    /**
     * @param {object} [options]
     * @param {number} [options.capacity=65536]  最多容纳多少条事件（超出后丢弃最旧）
     * @param {number} [options.flushThreshold=4096]  积累多少条后触发自动 flush 建议
     * @param {'drop-oldest'|'drop-newest'} [options.overflowPolicy='drop-oldest']
     */
    constructor(options = {}) {
        const {
            capacity       = 65536,
            flushThreshold = 4096,
            overflowPolicy = 'drop-oldest',
        } = options;

        this._capacity       = capacity;
        this._flushThreshold = flushThreshold;
        this._overflowPolicy = overflowPolicy;

        // 使用两个指针 + 固定长度数组模拟环形队列
        // 为了避免 GC 压力，预分配数组（空槽填 undefined）
        this._buf   = new Array(capacity);
        this._head  = 0;   // 下一个可读位置
        this._tail  = 0;   // 下一个可写位置
        this._size  = 0;   // 当前有效元素数

        // 统计
        this.stats = {
            totalPushed:   0,
            totalDrained:  0,
            totalDropped:  0,
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
     * 向缓冲区压入一条事件。
     * @param {*} event  任意可序列化对象
     * @returns {boolean} true = 成功入队；false = 触发了溢出丢弃
     */
    push(event) {
        this.stats.totalPushed++;

        if (this._size >= this._capacity) {
            if (this._overflowPolicy === 'drop-newest') {
                // 直接丢弃新来的
                this.stats.totalDropped++;
                return false;
            }
            // drop-oldest：覆盖最旧的槽，head 前移
            this._buf[this._tail] = event;
            this._tail = (this._tail + 1) % this._capacity;
            this._head = (this._head + 1) % this._capacity;
            this.stats.totalDropped++;
            return false;
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
            result[i]          = this._buf[this._head];
            this._buf[this._head] = undefined;   // 释放引用
            this._head         = (this._head + 1) % this._capacity;
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
        return { ...this.stats, currentSize: this._size, capacity: this._capacity };
    }
}
