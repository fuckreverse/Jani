// JALANGI DO NOT INSTRUMENT

/**
 * NodeStreamBackend — Node.js 文件流日志后端（二进制格式）。
 *
 * 将事件批次序列化为紧凑二进制格式（JTB1，见 EventSerializer.js），
 * 通过 Node.js fs.WriteStream 写入 .bin 文件。
 * WriteStream 内置了操作系统级别的写缓冲和背压机制（drain 事件），
 * 非常适合高吞吐写文件场景。
 *
 * 支持两种输出目标：
 *  1. 文件路径（默认：'jalangi-trace.bin'）
 *  2. 已有的 Writable Stream（传入 options.stream）
 *
 * 使用方式（Node.js analysis 中）：
 *
 *   import { NodeStreamBackend } from '.../logger/transport/NodeStreamBackend.js';
 *   const backend = new NodeStreamBackend({ path: 'my-trace.bin' });
 *   // 与 LogManager 配合：
 *   const mgr = new LogManager({ backends: [backend] });
 *
 * 启用字典压缩（Value Pool）：
 *
 *   const backend = new NodeStreamBackend({ path: 'my-trace.bin', usePool: true });
 *   // 高频字符串（变量名、文件名、属性名）自动被字典压缩，通常可减少 30-50% trace 体积。
 *
 * 输出格式（二进制 JTB1）：
 *   文件 = [魔数 8B 文件头][事件1: 12B头 + payload][事件2: 12B头 + payload]...
 *   可用 trace-parse.mjs 解码：
 *     node tools/trace-parse.mjs trace.bin --smap trace.smap.json
 *
 * smap.json 写出：
 *   若构造时提供了 smap（通过 setSmap(smapObj) 或 options.smap），
 *   在 close() 时自动写出与 .bin 配对的 .smap.json 文件。
 */

import { createWriteStream, writeFileSync } from 'node:fs';
import {
    serializeBatch,
    createFileHeader,
    EventSerializerWithPool,
} from '../../encoding/EventSerializer.js';
import { createDiagLogger, DOMAIN } from '../diagnostics.js';

const log = createDiagLogger(DOMAIN.BACKEND_NODE);

export class NodeStreamBackend {
    /**
     * @param {object} [options]
     * @param {string}  [options.path='jalangi-trace.bin']  输出文件路径（.bin）
     * @param {import('node:stream').Writable} [options.stream]  直接传入 Writable（优先于 path）
     * @param {boolean} [options.append=false]   是否追加模式（二进制 trace 不支持追加，默认覆盖）
     * @param {number}  [options.highWaterMark=65536]  WriteStream 缓冲上限（字节）
     * @param {boolean} [options.autoFlush=false]  每批后调用 flush（降低延迟但增加 syscall）
     * @param {object|null} [options.smap=null]  初始 smap 对象（可在 close 时自动写出 .smap.json）
     * @param {boolean} [options.usePool=false]  启用字典压缩（Value Pool），减少重复字符串开销
     */
    constructor(options = {}) {
        const {
            path          = 'jalangi-trace.bin',
            stream        = null,
            append        = false,
            highWaterMark = 65536,
            autoFlush     = false,
            smap          = null,
            usePool       = false,
        } = options;

        this._path      = path;
        this._autoFlush = autoFlush;
        this._closed    = false;
        this._smap      = smap;

        // 字典压缩
        this._usePool   = usePool;
        this._poolSerializer = usePool ? new EventSerializerWithPool() : null;

        // 统计
        this.stats = { batchCount: 0, totalEvents: 0, bytesWritten: 0, errors: 0 };

        if (stream) {
            this._stream  = stream;
            this._managed = false;   // 外部流，不由我们关闭
        } else {
            this._stream  = createWriteStream(path, {
                flags:        append ? 'a' : 'w',
                highWaterMark,
            });
            this._managed = true;
        }

        this._stream.on('error', (err) => {
            this.stats.errors++;
            log.error('stream error:', err.message);
        });

        this._drainable    = true;
        this._drainPromise = null;
        this._drainResolve = null;

        this._stream.on('drain', () => {
            this._drainable = true;
            if (this._drainResolve) {
                const r = this._drainResolve;
                this._drainResolve = null;
                r();
            }
        });

        // 写文件头（魔数 + 版本）
        this._writeFileHeader();
    }

    // ── 文件头写入 ─────────────────────────────────────────────────────────────

    /**
     * 在文件流开始时写入 JTB1 文件头（8 字节）。
     * @private
     */
    _writeFileHeader() {
        const headerBuf = this._poolSerializer
            ? this._poolSerializer.createFileHeader()
            : createFileHeader();
        const nodeBuffer = Buffer.from(headerBuf);
        this._stream.write(nodeBuffer);
        this.stats.bytesWritten += nodeBuffer.length;
    }

    // ── smap 管理 ─────────────────────────────────────────────────────────────

    /**
     * 设置（或更新）smap 对象。将在 close() 时自动写出为 .smap.json 文件。
     * @param {object} smapObj  buildSmapJson() 返回的 smap 对象
     */
    setSmap(smapObj) {
        this._smap = smapObj;
    }

    // ── LogBackend 接口 ────────────────────────────────────────────────────────

    /**
     * 批量写入事件到文件（二进制格式）。
     * 如果底层 stream 背压，等待 drain 再继续。
     * @param {Array} batch
     * @returns {Promise<void>}
     */
    async write(batch) {
        if (this._closed) throw new Error('NodeStreamBackend: already closed');

        if (!this._drainable) {
            await this._waitDrain();
        }

        this._writeBatch(batch);

        if (this._autoFlush) {
            await this.flush();
        }
    }

    /**
     * 同步写入（用于 process.exit 场景，尽力而为）。
     * @param {Array} batch
     */
    writeSync(batch) {
        if (this._closed) return;
        this._writeBatch(batch);
    }

    /**
     * 内部：序列化并写入一个 batch（同步）。
     * 支持有 pool 和无 pool 两种路径。
     * @param {Array} batch
     * @private
     */
    _writeBatch(batch) {
        this.stats.batchCount++;
        this.stats.totalEvents += batch.length;

        if (this._poolSerializer) {
            // 有状态字典压缩路径：返回 ArrayBuffer[]
            const buffers = this._poolSerializer.serializeBatch(batch);
            for (const arrBuf of buffers) {
                const nodeBuf = Buffer.from(arrBuf);
                this.stats.bytesWritten += nodeBuf.length;
                const ok = this._stream.write(nodeBuf);
                if (!ok) this._drainable = false;
            }
        } else {
            // 无状态路径（向后兼容）
            const arrBuf = serializeBatch(batch);
            const nodeBuf = Buffer.from(arrBuf);
            this.stats.bytesWritten += nodeBuf.length;
            const ok = this._stream.write(nodeBuf);
            if (!ok) this._drainable = false;
        }
    }

    /**
     * 等待底层 stream 将所有缓冲数据写入 OS。
     * @returns {Promise<void>}
     */
    flush() {
        return new Promise((resolve, reject) => {
            const needDrain = this._stream.writableNeedDrain !== undefined
                ? this._stream.writableNeedDrain
                : !this._drainable;

            if (!needDrain) {
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
     * 关闭文件流（flush 后关闭），并写出 .smap.json（如有）。
     * @returns {Promise<void>}
     */
    close() {
        if (this._closed) return Promise.resolve();
        this._closed = true;

        return new Promise((resolve, reject) => {
            const done = () => {
                this._writeSmapJson();
                resolve();
            };
            if (!this._managed) {
                this.flush().then(done, reject);
                return;
            }
            this._stream.end((err) => {
                if (err) { reject(err); } else { done(); }
            });
        });
    }

    /**
     * 返回字典压缩统计信息（仅在 usePool=true 时有意义）。
     * @returns {{ dictSize: number, dictEntries: number }|null}
     */
    getPoolStats() {
        return this._poolSerializer ? this._poolSerializer.getStats() : null;
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

    /**
     * 在 close 时写出 .smap.json 文件（与 .bin 配对）。
     * 文件名：将 .bin 后缀替换为 .smap.json，或追加 .smap.json。
     * @private
     */
    _writeSmapJson() {
        if (!this._smap) return;
        if (!this._managed || !this._path) return;

        let smapPath = this._path;
        if (smapPath.endsWith('.bin')) {
            smapPath = smapPath.slice(0, -4) + '.smap.json';
        } else {
            smapPath = smapPath + '.smap.json';
        }

        try {
            const json = JSON.stringify(this._smap, null, 2);
            writeFileSync(smapPath, json, 'utf8');
            log.debug(`smap.json written to ${smapPath}`);
        } catch (err) {
            log.error(`failed to write smap.json to ${smapPath}:`, err.message);
        }
    }
}
