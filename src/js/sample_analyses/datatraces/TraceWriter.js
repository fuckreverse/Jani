// JALANGI DO NOT INSTRUMENT

/**
 * @file TraceWriter —— 高性能缓冲日志写入器（Node.js 写文件 / 浏览器通过 WebSocket 发送）。
 *
 * 用法：
 *   const tw = new TraceWriter(sandbox, 'trace.log');
 *   tw.logToFile('some line\n');
 *   tw.stopTracing();
 */

export class TraceWriter {
    /**
     * @param {object} sandbox  J$ 运行时对象（提供 Constants / Config）
     * @param {string} traceFileName  输出文件名（Node.js 环境）或 WebSocket 频道名
     */
    constructor(sandbox, traceFileName) {
        this._constants   = sandbox.Constants;
        this._config      = sandbox.Config;
        this._fileName    = traceFileName;

        this._bufferSize  = 0;
        this._buffer      = [];
        this._traceWfh    = undefined;
        this._tracingDone = false;

        // 浏览器 WebSocket 相关
        this._socket       = null;
        this._isOpen       = false;
        this._trying       = false;
        this._cb           = undefined;
        this._remoteBuffer = [];

        // Node.js fs（按需 require，避免浏览器中报错）
        if (!this._constants.isBrowser) {
            // 动态 import 在构造函数里不方便，用 createRequire
            this._fs = this._requireFs();
        }
    }

    _requireFs() {
        try {
            // package.json 设了 "type":"module" 所以需要用 createRequire
            const { createRequire } = await import('module').catch(() => ({}));
            if (createRequire) {
                return createRequire(import.meta.url)('fs');
            }
        } catch { /* ignore */ }
        // fallback: 旧环境
        try { return require('fs'); } catch { return undefined; }
    }

    _getFileHandle() {
        if (this._traceWfh === undefined && this._fs) {
            this._traceWfh = this._fs.openSync(this._fileName, 'w');
        }
        return this._traceWfh;
    }

    logToFile(line) {
        if (this._tracingDone) return;
        const maxBuf = this._config.MAX_BUF_SIZE;
        const len    = line.length;
        let start = 0;
        let end   = len < maxBuf ? len : maxBuf;
        while (start < len) {
            const chunk  = line.slice(start, end);
            const curLen = end - start;
            if (this._bufferSize + curLen > maxBuf) this.flush();
            this._buffer.push(chunk);
            this._bufferSize += curLen;
            start = end;
            end   = (end + maxBuf < len) ? end + maxBuf : len;
        }
    }

    flush() {
        if (!this._constants.isBrowser) {
            if (this._fs) {
                const fh = this._getFileHandle();
                for (const chunk of this._buffer) this._fs.writeSync(fh, chunk);
            }
        } else {
            const msg = this._buffer.join('');
            if (msg.length > 1) this.remoteLog(msg);
        }
        this._bufferSize = 0;
        this._buffer     = [];
    }

    onflush(callback) {
        if (this._remoteBuffer.length === 0) {
            callback?.();
        } else {
            this._cb = callback;
            this._tryRemoteLog();
        }
    }

    remoteLog(message) {
        if (message.length > this._config.MAX_BUF_SIZE) {
            throw new Error('message too big!!!');
        }
        this._remoteBuffer.push(message);
        this._openSocketIfNotOpen();
        if (this._isOpen) this._tryRemoteLog();
    }

    stopTracing() {
        this._tracingDone = true;
        this.flush();
    }

    _openSocketIfNotOpen() {
        if (!this._socket) {
            console.log('Opening connection');
            this._socket = new WebSocket('ws://127.0.0.1:8080', 'log-protocol');
            this._socket.onopen    = () => this._tryRemoteLog();
            this._socket.onmessage = () => this._tryRemoteLog2();
        }
    }

    _tryRemoteLog2() {
        this._trying = false;
        this._remoteBuffer.shift();
        if (this._remoteBuffer.length === 0) {
            this._cb?.();
            this._cb = undefined;
        }
        this._tryRemoteLog();
    }

    _tryRemoteLog() {
        this._isOpen = true;
        if (!this._trying && this._remoteBuffer.length > 0) {
            this._trying = true;
            this._socket.send(this._remoteBuffer[0]);
        }
    }
}
