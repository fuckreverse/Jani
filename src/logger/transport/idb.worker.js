// JALANGI DO NOT INSTRUMENT

/**
 * @module idb.worker
 *
 * IndexedDB 写入 Worker（Classic Worker，完全自包含，无 import）。
 * 由 IdbBackend 通过 postMessage 驱动，在独立线程中执行 IDB 操作。
 *
 * 消息协议（主线程 → Worker）：
 *   { cmd: 'init', dbName, storeName, version, debugDomain? }
 *     → { type: 'ready' }
 *   { cmd: 'writeVar', batch: Array, batchId: number }
 *     → { type: 'ack', batchId, count } | { type: 'error', batchId, message, stack }
 *   { cmd: 'flush', reqId }
 *     → { type: 'flushed', reqId }
 *   { cmd: 'query', reqId, filter?, limit? }
 *     → { type: 'queryResult', reqId, events: Array }
 *   { cmd: 'clear', reqId }
 *     → { type: 'cleared', reqId }
 *   { cmd: 'close', reqId }
 *     → { type: 'closed', reqId }
 *
 * 存储格式：每条事件为一个 IDB record，结构：{ ts: DOMHighResTimeStamp, ...event }
 */

// debug 开关由主线程 init 消息中的 debugDomain 字段控制。
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
            if (!database.objectStoreNames.contains(store)) {
                dbg.debug(`onupgradeneeded v${evt.oldVersion}→v${evt.newVersion}: creating objectStore "${store}"`);
                const os = database.createObjectStore(store, {
                    keyPath:       'id',
                    autoIncrement: true,
                });
                os.createIndex('type',  'type',  { unique: false });
                os.createIndex('iid',   'iid',   { unique: false });
                os.createIndex('sid',   'sid',   { unique: false });
                os.createIndex('ts',    'ts',    { unique: false });
            }
        };

        req.onsuccess  = (evt) => { resolve(evt.target.result); };
        req.onerror    = (evt) => {
            dbg.error(`openDB error for "${name}":`, evt.target.error?.message ?? evt.target.error);
            reject(evt.target.error);
        };
        req.onblocked  = () => {
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
                if (msg.debugDomain != null) _debugEnabled = true;
                dbName    = msg.dbName    ?? dbName;
                storeName = msg.storeName ?? storeName;
                const ver = msg.version   ?? 1;
                db = await openDB(dbName, storeName, ver);
                dbg.debug(`Worker ready: db="${dbName}" store="${storeName}" v${ver}`);
                self.postMessage({ type: 'ready', dbName, storeName });
                break;
            }

            case 'writeVar': {
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
                    if (pendingTxCount === 0 && flushResolvers.length > 0) {
                        for (const r of flushResolvers) r();
                        flushResolvers = [];
                    }
                }
                break;
            }

            case 'flush': {
                if (pendingTxCount > 0) {
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

self.onerror = (evt) => {
    console.error('[Jalangi:backend:idb] Uncaught Worker error:', evt.message, `(${evt.filename}:${evt.lineno})`);
};
