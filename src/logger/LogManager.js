// JALANGI DO NOT INSTRUMENT

/**
 * LogManager — Jani 日志系统的统一入口。
 *
 * 职责：
 *  1. 维护一个 RingBuffer，供 analysis 钩子同步写入事件（极低开销）
 *  2. 在合适的时机异步 flush：
 *     - 缓冲区达到 flushThreshold（通过 queueMicrotask 或 setTimeout 调度）
 *     - 外部主动调用 flush()
 *     - 页面/进程退出前调用 close()
 *  3. 将事件批次交给注册的后端（backend.write(batch)）
 *  4. 支持多后端同时运行（如同时写 IndexedDB 和 WebSocket）
 *
 * 诊断日志（直接输出到 console，不走后端）：
 *  - JALANGI_DEBUG=logging（Node.js）或 localStorage.jalangiDebug='logging'（浏览器）开启 debug 级别
 *  - error/warn 级别始终输出
 *
 * 使用方式：
 *
 *   import { LogManager } from '.../logger/LogManager.js';
 *   import { IdbBackend } from '.../logger/transport/IdbBackend.js';
 *
 *   const mgr = new LogManager({ backends: [new IdbWorkerBackend()] });
 *
 *   // 在 analysis 钩子里：
 *   mgr.push({ type: 'READ', iid, sid: J$.sid, name, value: val });
 *
 *   // 页面卸载时：
 *   window.addEventListener('beforeunload', () => mgr.close());
 *
 * 注意：LogManager 本身不感知事件格式——它只做缓冲和分发，
 * 序列化由各后端自行处理（接收原始 JS 对象数组）。
 */

import { RingBuffer } from './RingBuffer.js';
import { createDiagLogger, DOMAIN } from './diagnostics.js';

const log = createDiagLogger(DOMAIN.TRACE_INFRA);

// 判断运行环境
const IS_BROWSER = typeof window !== 'undefined' || typeof self !== 'undefined';

/** 调度一个低优先级的异步任务（浏览器用 queueMicrotask，Node.js 用 setImmediate）。 */
const scheduleAsync = (() => {
    if (!IS_BROWSER && typeof setImmediate === 'function') {
        return (fn) => setImmediate(fn);
    }
    if (typeof queueMicrotask === 'function') {
        return (fn) => queueMicrotask(fn);
    }
    return (fn) => Promise.resolve().then(fn);
})();

export class LogManager {
    /**
     * @param {object} [options]
     * @param {Array}  [options.backends=[]]        后端实例列表（均实现 write/flush/close）
     * @param {number} [options.capacity=65536]     RingBuffer 初始容量（满后自动扩容，不丢弃）
     * @param {number} [options.flushThreshold=512] 达到此数量时触发异步 flush
     * @param {number} [options.flushIntervalMs=0]  定时 flush 间隔（ms），0 = 不启用
     * @param {number} [options.drainBatchSize=1024] 每次 drain 最多取多少条
     * @param {boolean} [options.autoClose=true]    是否自动监听 unload/SIGTERM 关闭
     * @param {number} [options.forceSyncFlushThreshold=0]
     *   【验证用】累计写入达到此数量时，在 log() 调用中同步触发 _doFlush()，
     *   绕过 queueMicrotask 调度，验证主线程繁忙时数据是否能被及时发送。
     *   0 = 禁用（默认）。注意：同步 flush 会在每次插桩回调中增加毫秒级延迟。
     */
    constructor(options = {}) {
        const {
            backends        = [],
            capacity        = 65536,
            flushThreshold  = 512,
            flushIntervalMs = 0,
            drainBatchSize  = 1024,
            autoClose       = true,
            forceSyncFlushThreshold = 0,
        } = options;

        this._backends       = [...backends];
        this._drainBatchSize = drainBatchSize;
        this._ring           = new RingBuffer({ capacity, flushThreshold });

        this._flushPending   = false;   // 防止重复调度 flush
        this._closed         = false;
        this._flushTimer     = null;

        // 【验证用】强制同步 flush 计数器
        this._forceSyncFlushThreshold = forceSyncFlushThreshold > 0 ? forceSyncFlushThreshold : 0;
        this._forceSyncCounter        = 0;

        // 统计
        this.stats = {
            totalLogged:  0,
            totalFlushed: 0,
            flushErrors:  0,
            forceSyncFlushCount: 0,  // 【验证用】同步 flush 触发次数
        };

        log.debug('constructed', {
            backends:       this._backends.length,
            capacity,
            flushThreshold,
            flushIntervalMs,
            drainBatchSize,
        });

        // 定时 flush
        if (flushIntervalMs > 0) {
            this._flushTimer = setInterval(() => this._doFlush(), flushIntervalMs);
            // Node.js 下 setInterval 不阻止进程退出
            if (this._flushTimer?.unref) this._flushTimer.unref();
            log.debug(`periodic flush enabled: every ${flushIntervalMs}ms`);
        }

        if (autoClose) {
            this._bindAutoClose();
        }
    }

    // ── 公共 API ──────────────────────────────────────────────────────────────

    /**
     * 推入一条事件到缓冲区（同步，极低开销）。
     *
     * @param {object} event  任意可序列化对象，建议字段：
     *   { type: string, iid: number, sid: number, ...其他钩子特有字段 }
     */
    push(event) {
        if (this._closed) return;
        this._ring.push(event);
        this.stats.totalLogged++;

        // 【验证用】强制同步 flush：主线程繁忙时绕过 queueMicrotask 直接发送
        if (this._forceSyncFlushThreshold > 0) {
            this._forceSyncCounter++;
            if (this._forceSyncCounter >= this._forceSyncFlushThreshold) {
                this._forceSyncCounter = 0;
                this.stats.forceSyncFlushCount++;
                log.debug(`[forceSyncFlush] #${this.stats.forceSyncFlushCount} triggered at totalLogged=${this.stats.totalLogged}`);
                this._doFlushSync(); // 完全同步：无任何 await，ws.send() 在本调用栈中完成
                return; // 已 flush，跳过下方的 scheduleAsync
            }
        }

        if (!this._flushPending && this._ring.shouldFlush) {
            this._flushPending = true;
            scheduleAsync(() => this._doFlush());
        }
    }

    /**
     * 立即 flush 所有积压事件到后端（返回 Promise，await 可确保写入完成）。
     * 可以在 analysis.endExecution 或 beforeunload 中调用。
     */
    async flush() {
        log.debug(`flush() called — ring.size=${this._ring.size}`);
        await this._doFlush();
    }

    /**
     * 关闭 LogManager：flush 剩余事件 → 关闭所有后端。
     * 之后调用 log() 的事件会被静默丢弃。
     */
    async close() {
        if (this._closed) {
            log.debug('close() called but already closed — skipping');
            return;
        }
        this._closed = true;
        log.debug(`close() — ring.size=${this._ring.size} totalLogged=${this.stats.totalLogged}`);

        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }

        await this._drainAll();

        const closeResults = await Promise.allSettled(this._backends.map(b => b.close?.()));
        for (let i = 0; i < closeResults.length; i++) {
            const r = closeResults[i];
            if (r.status === 'rejected') {
                log.error(`backend[${i}] close() failed:`, r.reason?.message ?? r.reason, r.reason?.stack ?? '');
            } else {
                log.debug(`backend[${i}] closed`);
            }
        }

        log.debug('close() complete', {
            totalLogged:  this.stats.totalLogged,
            totalFlushed: this.stats.totalFlushed,
            flushErrors:  this.stats.flushErrors,
        });
    }

    /**
     * 添加一个后端（动态挂载，不影响已在进行的 flush）。
     * @param {object} backend
     */
    addBackend(backend) {
        this._backends.push(backend);
        log.debug(`addBackend — total backends: ${this._backends.length}`);
    }

    /**
     * 移除一个后端（不会关闭它）。
     * @param {object} backend
     */
    removeBackend(backend) {
        const idx = this._backends.indexOf(backend);
        if (idx !== -1) {
            this._backends.splice(idx, 1);
            log.debug(`removeBackend[${idx}] — total backends: ${this._backends.length}`);
        } else {
            log.warn('removeBackend: backend not found');
        }
    }

    /** 返回当前 RingBuffer 统计 + LogManager 统计 */
    getStats() {
        return {
            logManager: { ...this.stats },
            ringBuffer: this._ring.getStats(),
        };
    }

    // ── 内部方法 ──────────────────────────────────────────────────────────────

    /**
     * 【验证用】完全同步 flush：drain RingBuffer → 调用各后端的 writeSync()（若有）。
     * 无任何 await，整条调用链在当前执行栈中同步完成。
     * 对于不支持 writeSync 的后端，降级为 write()（fire-and-forget）。
     */
    _doFlushSync() {
        if (this._ring.size === 0) return;
        if (this._backends.length === 0) {
            this._ring.drain();
            return;
        }
        const batch = this._ring.drain(this._drainBatchSize);
        if (batch.length === 0) return;
        this.stats.totalFlushed += batch.length;
        for (const backend of this._backends) {
            try {
                if (typeof backend.writeSync === 'function') {
                    backend.writeSync(batch);  // 真同步路径
                } else {
                    // 降级：fire-and-forget，数据仍会发送，只是无法保证同步完成
                    backend.write(batch).catch(err => {
                        log.error('_doFlushSync fallback write error:', err.message);
                    });
                }
            } catch (err) {
                this.stats.flushErrors++;
                log.error('_doFlushSync error:', err.message, err.stack ?? '');
            }
        }
    }

    /**
     * 从 RingBuffer 取出一批事件，分发给所有后端。
     * 这是异步的，不会阻塞主线程中 log() 的调用。
     */
    async _doFlush() {
        this._flushPending = false;

        if (this._ring.size === 0) return;
        if (this._backends.length === 0) {
            const dropped = this._ring.size;
            this._ring.drain();
            log.warn(`_doFlush: no backends configured, dropped ${dropped} events`);
            return;
        }

        const batch = this._ring.drain(this._drainBatchSize);
        if (batch.length === 0) return;

        this.stats.totalFlushed += batch.length;
        log.debug(`_doFlush: writing batch of ${batch.length} events to ${this._backends.length} backend(s) (totalFlushed=${this.stats.totalFlushed})`);

        const results = await Promise.allSettled(
            this._backends.map(b => b.write(batch))
        );
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'rejected') {
                this.stats.flushErrors++;
                log.error(
                    `backend[${i}] write failed (batch=${batch.length}, totalErrors=${this.stats.flushErrors}):`,
                    r.reason?.message ?? r.reason
                );
                if (r.reason?.stack) {
                    log.error('stack trace:', r.reason.stack);
                }
            }
        }

        if (this._ring.size > 0) {
            log.debug(`_doFlush: ring still has ${this._ring.size} events, scheduling next flush`);
            scheduleAsync(() => this._doFlush());
        }
    }

    /** 持续 drain 直到 RingBuffer 清空（用于 close 时） */
    async _drainAll() {
        let rounds = 0;
        while (this._ring.size > 0) {
            rounds++;
            await this._doFlush();
        }
        if (rounds > 0) log.debug(`_drainAll done in ${rounds} round(s)`);
        const flushResults = await Promise.allSettled(this._backends.map(b => b.flush?.()));
        for (let i = 0; i < flushResults.length; i++) {
            const r = flushResults[i];
            if (r.status === 'rejected') {
                log.error(`backend[${i}] flush() failed:`, r.reason?.message ?? r.reason, r.reason?.stack ?? '');
            }
        }
    }

    /** 绑定自动关闭钩子 */
    _bindAutoClose() {
        if (IS_BROWSER) {
            // pagehide 比 beforeunload 更可靠（在 bfcache 下也会触发）
            const handler = () => {
                log.debug('auto-close: page unload — draining sync');
                    this._drainAllSync();
            };
            if (typeof addEventListener === 'function') {
                addEventListener('pagehide',     handler, { once: true });
                addEventListener('beforeunload', handler, { once: true });
            }
        } else {
            const handler = async () => {
                log.debug('auto-close: process signal — closing');
                await this.close();
            };
            process.once('exit',    () => {
                log.debug('auto-close: process exit — draining sync');
                this._drainAllSync();
            });
            process.once('SIGTERM', handler);
            process.once('SIGINT',  handler);
        }
    }

    /**
     * 同步清空 RingBuffer（浏览器 beforeunload 中使用）。
     * 此时无法 await，只能触发后端的同步写入（后端若支持 writeSync 则调用）。
     * 对于 IndexedDB 等纯异步后端，数据可能丢失部分。
     */
    _drainAllSync() {
        if (this._ring.size === 0) return;
        const batch = this._ring.drain();
        log.debug(`_drainAllSync: ${batch.length} events`);
        for (const backend of this._backends) {
            try {
                if (typeof backend.writeSync === 'function') {
                    backend.writeSync(batch);
                } else {
                    backend.write(batch).catch((err) => {
                        log.error('_drainAllSync: async write failed:', err.message);
                    });
                }
            } catch (e) {
                log.error('_drainAllSync: backend error:', e.message);
            }
        }
    }
}

// ─── 便捷工厂函数 ──────────────────────────────────────────────────────────────

/**
 * 创建一个使用 MemoryBackend 的 LogManager（用于测试）。
 */
export async function createMemoryLogManager(options = {}) {
    const { MemoryBackend } = await import('./transport/MemoryBackend.js');
    const backend = new MemoryBackend();
    const mgr = new LogManager({ ...options, backends: [backend], autoClose: false });
    return { mgr, backend };
}

/**
 * 根据环境自动选择后端，创建推荐配置的 LogManager。
 *
 * @param {'idb'|'ws'|'node-stream'|'memory'} backendType
 * @param {object} backendOptions  传给后端构造函数的选项
 * @param {object} managerOptions  传给 LogManager 的选项
 */
export async function createLogManager(backendType, backendOptions = {}, managerOptions = {}) {
    let BackendClass;
    switch (backendType) {
        case 'idb':
        case 'indexeddb': {
            const mod = await import('./transport/IdbBackend.js');
            BackendClass = mod.IdbBackend;
            break;
        }
        case 'ws':
        case 'websocket': {
            const mod = await import('./transport/WsBackend.js');
            BackendClass = mod.WsBackend;
            break;
        }
        case 'node-stream':
        case 'file': {
            const mod = await import('./transport/NodeStreamBackend.js');
            BackendClass = mod.NodeStreamBackend;
            break;
        }
        case 'memory':
        default: {
            const mod = await import('./transport/MemoryBackend.js');
            BackendClass = mod.MemoryBackend;
            break;
        }
    }
    const backend = new BackendClass(backendOptions);
    return new LogManager({ ...managerOptions, backends: [backend] });
}
