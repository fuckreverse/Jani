// JALANGI DO NOT INSTRUMENT

/**
 * NodeStreamBackend — Node.js 文件流日志后端。
 *
 * 将事件批次序列化为 NDJSON，通过 Node.js fs.WriteStream 写入文件。
 * WriteStream 内置了操作系统级别的写缓冲和背压机制（drain 事件），
 * 非常适合高吞吐写文件场景。
 *
 * 支持两种输出目标：
 *  1. 文件路径（默认：'jalangi-trace.ndjson'）
 *  2. 已有的 Writable Stream（传入 options.stream）
 *
 * 使用方式（Node.js analysis 中）：
 *
 *   import { NodeStreamBackend } from '.../logger/backends/NodeStreamBackend.js';
 *   const backend = new NodeStreamBackend({ path: 'my-trace.ndjson' });
 *   // 与 LogManager 配合：
 *   const mgr = new LogManager({ backends: [backend] });
 *
 * 输出格式：
 *   每条事件为一行 JSON（NDJSON 标准）。
 *   文件可直接用 jq 分析：  jq 'select(.type=="READ")' my-trace.ndjson
 */

import { createWriteStream } from 'node:fs';
import { serializeBatchToNDJSON } from '../EventSerializer.js';
import { createLogger, DOMAIN } from '../logger.js';

const log = createLogger(DOMAIN.BACKEND_NODE);

export class NodeStreamBackend {
    /**
     * @param {object} [options]
     * @param {string}  [options.path='jalangi-trace.ndjson']  输出文件路径
     * @param {import('node:stream').Writable} [options.stream]  直接传入 Writable（优先于 path）
     * @param {boolean} [options.append=true]  是否追加模式（false = 覆盖）
     * @param {number}  [options.highWaterMark=65536]  WriteStream 缓冲上限（字节）
     * @param {boolean} [options.autoFlush=false]  每批后调用 flush（降低延迟但增加 syscall）
     */
    constructor(options = {}) {
        const {
            path          = 'jalangi-trace.ndjson',
            stream        = null,
            append        = true,
            highWaterMark = 65536,
            autoFlush     = false,
        } = options;

        this._autoFlush = autoFlush;
        this._closed    = false;

        // 统计
        this.stats = { batchCount: 0, totalEvents: 0, bytesWritten: 0, errors: 0 };

        if (stream) {
            this._stream  = stream;
            this._managed = false;   // 外部流，不由我们关闭
        } else {
            this._stream  = createWriteStream(path, {
                flags:         append ? 'a' : 'w',
                encoding:      'utf8',
                highWaterMark,
            });
            this._managed = true;
        }

        this._stream.on('error', (err) => {
            this.stats.errors++;
            log.error('stream error:', err.message);
        });

        // 背压：记录 stream 是否可写
        this._drainable = true;
        this._drainPromise = null;

        this._stream.on('drain', () => {
            this._drainable = true;
            if (this._drainResolve) {
                const r = this._drainResolve;
                this._drainResolve = null;
                r();
            }
        });
    }

    // ── LogBackend 接口 ────────────────────────────────────────────────────────

    /**
     * 批量写入事件到文件。
     * 如果底层 stream 背压，等待 drain 再继续。
     * @param {Array} batch
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) throw new Error('NodeStreamBackend: already closed');

        // 等待上一次 drain（背压控制）
        if (!this._drainable) {
            await this._waitDrain();
        }

        const text = serializeBatchToNDJSON(batch);
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;
        this.stats.bytesWritten += Buffer.byteLength(text, 'utf8');

        // stream.write 返回 false 时代表需要等待 drain
        const ok = this._stream.write(text);
        if (!ok) {
            this._drainable = false;
        }

        if (this._autoFlush) {
            await this.flush();
        }
    }

    /**
     * 同步写入（用于 beforeunload / process.exit 场景）。
     * 注意：Node.js fs.WriteStream 没有真正的同步写入，
     * 此方法触发写入但不等待完成（尽力而为）。
     * @param {Array} batch
     */
    writeSync(batch) {
        if (this._closed) return;
        const text = serializeBatchToNDJSON(batch);
        this._stream.write(text);
    }

    /**
     * 等待底层 stream 将所有缓冲数据写入 OS（非 fsync，只是清空用户空间缓冲）。
     * @returns {Promise<void>}
     */
    flush() {
        return new Promise((resolve, reject) => {
            if (!this._stream.writableNeedDrain) {
                resolve();
                return;
            }
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (err) => { cleanup(); reject(err); };
            const cleanup = () => {
                this._stream.off('drain', onDrain);
                this._stream.off('error', onError);
            };
            this._stream.once('drain', onDrain);
            this._stream.once('error', onError);
        });
    }

    /**
     * 关闭文件流（flush 后关闭）。
     * @returns {Promise<void>}
     */
    close() {
        if (this._closed) return Promise.resolve();
        this._closed = true;

        return new Promise((resolve, reject) => {
            const done = () => resolve();
            if (!this._managed) {
                // 外部 stream，不关闭，只 flush
                this.flush().then(done, reject);
                return;
            }
            // 等待写入完成后关闭
            this._stream.end((err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    // ── 内部方法 ──────────────────────────────────────────────────────────────

    _waitDrain() {
        if (this._drainPromise) return this._drainPromise;
        this._drainPromise = new Promise(resolve => {
            this._drainResolve = () => {
                this._drainPromise = null;
                resolve();
            };
        });
        return this._drainPromise;
    }
}
