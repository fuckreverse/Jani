// JALANGI DO NOT INSTRUMENT

/**
 * MemoryBackend — 将所有事件保存在内存数组中。
 *
 * 用途：
 *  - 单元测试和集成测试
 *  - 轻量场景（事件量少，只需事后查询）
 *  - 作为其他后端的参考实现
 *
 * 实现 LogBackend 接口：
 *  - write(batch: Array): Promise<void>   接收一批事件
 *  - flush(): Promise<void>               确保所有数据落盘（内存后端为 noop）
 *  - close(): Promise<void>              关闭后端（内存后端为 noop）
 *  - getEvents(): Array                   返回所有已接收事件（测试专用）
 *  - clear(): void                        清空事件（测试专用）
 */
export class MemoryBackend {
    constructor() {
        this._events = [];
        this._closed = false;
        // 统计
        this.stats = { batchCount: 0, totalEvents: 0 };
    }

    /**
     * 接收一批事件并保存到内存。
     * @param {Array} batch  事件对象数组
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) throw new Error('MemoryBackend: already closed');
        for (const ev of batch) this._events.push(ev);
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
    }

    /** noop — 内存后端无需 flush */
    async flush() {}

    /** noop — 内存后端无需关闭 */
    async close() {
        this._closed = true;
    }

    /** 返回所有已收集的事件（测试用） */
    getEvents() {
        return this._events.slice();
    }

    /** 清空事件数组（测试用） */
    clear() {
        this._events = [];
        this.stats   = { batchCount: 0, totalEvents: 0 };
    }

    /** 返回指定类型的事件（测试用快捷方法） */
    getEventsOfType(type) {
        return this._events.filter(e => e.type === type);
    }
}
