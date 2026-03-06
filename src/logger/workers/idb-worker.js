// JALANGI DO NOT INSTRUMENT

/**
 * @module idb-worker
 *
 * idb-worker.js — IndexedDB 写入 Worker（ESM Module Worker）。
 *
 * 此文件以 `{ type: 'module' }` 方式被 IdbWorkerBackend 加载，
 * 因此是一个 ES 模块（Module Worker）。不需要 `export` 导出，
 * 因为 Worker 入口点本身不需要对外暴露任何接口——
 * 所有通信通过 `self.onmessage` / `self.postMessage` 进行。
 *
 * 在独立线程中运行，接收主线程通过 postMessage 发来的事件批次，
 * 写入 IndexedDB。主线程不会被 IDB 操作阻塞。
 *
 * 消息协议（主线程 → Worker）：
 *   { cmd: 'init', dbName: string, storeName: string, version: number, debugDomain?: string|null }
 *     → 打开/升级数据库，完成后回复 { type: 'ready' }
 *
 *   { cmd: 'write', batch: Array, batchId: number }
 *     → 批量写入，完成后回复 { type: 'ack', batchId, count }
 *       失败时回复 { type: 'error', batchId, message, stack }
 *
 *   { cmd: 'flush', reqId: number }
 *     → 确认所有进行中事务完成，回复 { type: 'flushed', reqId }
 *
 *   { cmd: 'query', reqId: number, filter?: object, limit?: number }
 *     → 查询所有事件，回复 { type: 'queryResult', reqId, events: Array }
 *
 *   { cmd: 'clear', reqId: number }
 *     → 清空 store，回复 { type: 'cleared', reqId }
 *
 *   { cmd: 'close', reqId: number }
 *     → 关闭数据库连接，回复 { type: 'closed', reqId }
 *
 * 存储格式：
 *   每条事件作为一个 IDB record，key = autoIncrement。
 *   record 结构：{ ts: DOMHighResTimeStamp, ...event }
 *
 * 诊断日志：
 *   Worker 内使用 console.debug/warn/error 直接输出到浏览器 DevTools Console。
 *   通过 init 消息中的 debugDomain 字段控制 debug 级别开关
 *   （由 IdbWorkerBackend 根据 isDebugEnabled('backend:idb') 决定是否传入）；
 *   warn/error 始终输出。
 *
 * 注意：Worker 内无法直接 import src/logger/logger.js（Worker 上下文路径问题），
 * 因此使用内联的轻量 dbg 对象，行为与 createLogger 一致。
 */

// ── 诊断日志工具（Worker 内，直接到 console）──────────────────────────────────
//
// debug 开关由主线程在 init 消息中传入（debugDomain 非 null 即开启）；
// 初始化前默认关闭，以减少噪声。
let _debugEnabled = false;

const dbg = {
    debug(...args) {
        if (_debugEnabled) console.debug('[Jalangi:backend:idb]', ...args);
    },
    warn(...args)  { console.warn( '[Jalangi:backend:idb]', ...args); },
    error(...args) { console.error('[Jalangi:backend:idb]', ...args); },
};

// ─── IndexedDB 辅助 ────────────────────────────────────────────────────────────

let db      = null;
let dbName  = 'jalangi-traces';
let storeName = 'events';

/** 打开（或升级）数据库 */
function openDB(name, store, version = 1) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);

        req.onupgradeneeded = (evt) => {
            const database = evt.target.result;
            // 如果 store 不存在则创建
            if (!database.objectStoreNames.contains(store)) {
                dbg.debug(`onupgradeneeded v${evt.oldVersion}→v${evt.newVersion}: creating objectStore "${store}"`);
                const os = database.createObjectStore(store, {
                    keyPath:       'id',
                    autoIncrement: true,
                });
                // 按事件类型建索引（便于查询）
                os.createIndex('type',  'type',  { unique: false });
                os.createIndex('iid',   'iid',   { unique: false });
                os.createIndex('sid',   'sid',   { unique: false });
                // 时间戳索引（便于按时间范围查询）
                os.createIndex('ts',    'ts',    { unique: false });
            }
        };

        req.onsuccess  = (evt) => { resolve(evt.target.result); };
        req.onerror    = (evt) => {
            dbg.error(`openDB error for "${name}":`, evt.target.error?.message ?? evt.target.error);
            reject(evt.target.error);
        };
        req.onblocked  = () => {
            // 有其他连接阻塞了升级，等待它们关闭
            dbg.warn(`DB upgrade blocked for "${name}" — another connection is still open`);
        };
    });
}

/** 批量写入一批事件（单个事务） */
function writeBatch(batch) {
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const ts    = typeof performance !== 'undefined' ? performance.now() : Date.now();

        let count = 0;
        for (const event of batch) {
            // 添加时间戳，不修改原始事件（浅拷贝）
            store.put({ ts, ...event });
            count++;
        }

        tx.oncomplete = () => { resolve(count); };
        tx.onerror    = (evt) => {
            dbg.error('writeBatch transaction error:', evt.target.error?.message ?? evt.target.error);
            reject(evt.target.error);
        };
        tx.onabort    = (evt) => {
            const reason = evt.target.error?.message ?? 'unknown';
            dbg.error('writeBatch transaction aborted:', reason);
            reject(new Error('Transaction aborted: ' + reason));
        };
    });
}

/** 查询 store 中的事件 */
function queryEvents(filter = {}, limit = 10000) {
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const results = [];

        let req;
        if (filter.type) {
            // 按类型索引查询
            req = store.index('type').openCursor(IDBKeyRange.only(filter.type));
        } else {
            req = store.openCursor();
        }

        req.onsuccess = (evt) => {
            const cursor = evt.target.result;
            if (cursor && results.length < limit) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        req.onerror = (evt) => {
            dbg.error('queryEvents error:', evt.target.error?.message ?? evt.target.error);
            reject(evt.target.error);
        };
    });
}

/** 清空 store */
function clearStore() {
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req   = store.clear();
        req.onsuccess = () => { resolve(); };
        req.onerror   = (evt) => {
            dbg.error('clearStore error:', evt.target.error?.message ?? evt.target.error);
            reject(evt.target.error);
        };
    });
}

// ─── 消息处理 ──────────────────────────────────────────────────────────────────

// 追踪进行中的事务（用于 flush 等待）
let pendingTxCount  = 0;
let flushResolvers  = [];

// 统计
let _totalBatches = 0;
let _totalEvents  = 0;
let _totalErrors  = 0;

self.onmessage = async (evt) => {
    const msg = evt.data;

    try {
        switch (msg.cmd) {

            case 'init': {
                // 读取主线程传来的 debug 开关
                if (msg.debugDomain != null) _debugEnabled = true;
                dbName    = msg.dbName    ?? dbName;
                storeName = msg.storeName ?? storeName;
                const ver = msg.version   ?? 1;
                db = await openDB(dbName, storeName, ver);
                dbg.debug(`Worker ready: db="${dbName}" store="${storeName}" v${ver}`);
                self.postMessage({ type: 'ready', dbName, storeName });
                break;
            }

            case 'write': {
                if (!db) {
                    dbg.error(`write batchId=${msg.batchId}: DB not initialized`);
                    self.postMessage({ type: 'error', batchId: msg.batchId, message: 'DB not initialized' });
                    return;
                }
                const batchSize = msg.batch?.length ?? 0;
                pendingTxCount++;
                _totalBatches++;
                _totalEvents += batchSize;
                try {
                    const count = await writeBatch(msg.batch);
                    self.postMessage({ type: 'ack', batchId: msg.batchId, count });
                } catch (writeErr) {
                    _totalErrors++;
                    dbg.error(`write failed batchId=${msg.batchId}:`, writeErr?.message ?? writeErr);
                    self.postMessage({
                        type:    'error',
                        batchId: msg.batchId,
                        message: writeErr?.message ?? String(writeErr),
                        stack:   writeErr?.stack,
                    });
                } finally {
                    pendingTxCount--;
                    // 如果有等待 flush 的 resolve，检查是否都完成了
                    if (pendingTxCount === 0 && flushResolvers.length > 0) {
                        for (const r of flushResolvers) r();
                        flushResolvers = [];
                    }
                }
                break;
            }

            case 'flush': {
                if (pendingTxCount > 0) {
                    // 等待所有进行中事务完成
                    await new Promise(resolve => flushResolvers.push(resolve));
                }
                self.postMessage({ type: 'flushed', reqId: msg.reqId });
                break;
            }

            case 'query': {
                if (!db) {
                    dbg.warn('query: DB not initialized — returning empty');
                    self.postMessage({ type: 'queryResult', reqId: msg.reqId, events: [] });
                    break;
                }
                const events = await queryEvents(msg.filter ?? {}, msg.limit ?? 10000);
                self.postMessage({ type: 'queryResult', reqId: msg.reqId, events });
                break;
            }

            case 'clear': {
                if (!db) {
                    dbg.warn('clear: DB not initialized — nothing to clear');
                    self.postMessage({ type: 'cleared', reqId: msg.reqId });
                    break;
                }
                await clearStore();
                self.postMessage({ type: 'cleared', reqId: msg.reqId });
                break;
            }

            case 'close': {
                if (db) { db.close(); db = null; }
                dbg.debug(`close: batches=${_totalBatches} events=${_totalEvents} errors=${_totalErrors}`);
                self.postMessage({ type: 'closed', reqId: msg.reqId });
                break;
            }

            default:
                dbg.warn('unknown command:', msg.cmd);
        }
    } catch (err) {
        _totalErrors++;
        dbg.error(`error in cmd="${msg.cmd}":`, err?.message ?? String(err), err?.stack ?? '');
        self.postMessage({
            type:    'error',
            batchId: msg.batchId,
            message: err?.message ?? String(err),
            stack:   err?.stack,
        });
    }
};

// Worker 错误兜底
self.onerror = (evt) => {
    console.error('[Jalangi:backend:idb] Uncaught Worker error:', evt.message, `(${evt.filename}:${evt.lineno})`);
};
