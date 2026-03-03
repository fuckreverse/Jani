// JALANGI DO NOT INSTRUMENT

/**
 * idb-worker.js — IndexedDB 写入 Worker。
 *
 * 在独立线程中运行，接收主线程通过 postMessage 发来的事件批次，
 * 写入 IndexedDB。主线程不会被 IDB 操作阻塞。
 *
 * 消息协议（主线程 → Worker）：
 *   { cmd: 'init', dbName: string, storeName: string, version: number }
 *     → 打开/升级数据库，完成后回复 { type: 'ready' }
 *
 *   { cmd: 'write', batch: Array, batchId: number }
 *     → 批量写入，完成后回复 { type: 'ack', batchId, count }
 *       失败时回复 { type: 'error', batchId, message }
 *
 *   { cmd: 'flush' }
 *     → 确认所有进行中事务完成，回复 { type: 'flushed' }
 *
 *   { cmd: 'query', filter?: object, limit?: number }
 *     → 查询所有事件，回复 { type: 'queryResult', events: Array }
 *
 *   { cmd: 'clear' }
 *     → 清空 store，回复 { type: 'cleared' }
 *
 *   { cmd: 'close' }
 *     → 关闭数据库连接，回复 { type: 'closed' }
 *
 * 存储格式：
 *   每条事件作为一个 IDB record，key = autoIncrement。
 *   record 结构：{ ts: DOMHighResTimeStamp, ...event }
 */

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

        req.onsuccess  = (evt) => resolve(evt.target.result);
        req.onerror    = (evt) => reject(evt.target.error);
        req.onblocked  = ()    => {
            // 有其他连接阻塞了升级，等待它们关闭
            console.warn('[idb-worker] DB upgrade blocked, waiting...');
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

        tx.oncomplete = () => resolve(count);
        tx.onerror    = (evt) => reject(evt.target.error);
        tx.onabort    = (evt) => reject(new Error('Transaction aborted: ' + (evt.target.error?.message ?? 'unknown')));
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
        req.onerror = (evt) => reject(evt.target.error);
    });
}

/** 清空 store */
function clearStore() {
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req   = store.clear();
        req.onsuccess = () => resolve();
        req.onerror   = (evt) => reject(evt.target.error);
    });
}

// ─── 消息处理 ──────────────────────────────────────────────────────────────────

// 追踪进行中的事务（用于 flush 等待）
let pendingTxCount  = 0;
let flushResolvers  = [];

self.onmessage = async (evt) => {
    const msg = evt.data;

    try {
        switch (msg.cmd) {

            case 'init': {
                dbName    = msg.dbName    ?? dbName;
                storeName = msg.storeName ?? storeName;
                const ver = msg.version   ?? 1;
                db = await openDB(dbName, storeName, ver);
                self.postMessage({ type: 'ready', dbName, storeName });
                break;
            }

            case 'write': {
                if (!db) {
                    self.postMessage({ type: 'error', batchId: msg.batchId, message: 'DB not initialized' });
                    return;
                }
                pendingTxCount++;
                try {
                    const count = await writeBatch(msg.batch);
                    self.postMessage({ type: 'ack', batchId: msg.batchId, count });
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
                if (pendingTxCount === 0) {
                    self.postMessage({ type: 'flushed' });
                } else {
                    // 等待所有进行中事务完成
                    await new Promise(resolve => flushResolvers.push(resolve));
                    self.postMessage({ type: 'flushed' });
                }
                break;
            }

            case 'query': {
                if (!db) {
                    self.postMessage({ type: 'queryResult', events: [] });
                    return;
                }
                const events = await queryEvents(msg.filter ?? {}, msg.limit ?? 10000);
                self.postMessage({ type: 'queryResult', events });
                break;
            }

            case 'clear': {
                if (!db) {
                    self.postMessage({ type: 'cleared' });
                    return;
                }
                await clearStore();
                self.postMessage({ type: 'cleared' });
                break;
            }

            case 'close': {
                if (db) {
                    db.close();
                    db = null;
                }
                self.postMessage({ type: 'closed' });
                break;
            }

            default:
                console.warn('[idb-worker] Unknown command:', msg.cmd);
        }
    } catch (err) {
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
    console.error('[idb-worker] Uncaught error:', evt.message);
};
