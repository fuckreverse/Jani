/**
 * Database.mjs — SQLite 封装（better-sqlite3，同步 API，直接写磁盘）
 *
 * 接口与原 sql.js 版本完全兼容：
 *   init(path)         — 初始化（现在是同步的，但保留 async 签名向后兼容）
 *   get(sql, ...args)  — 查询单行
 *   all(sql, ...args)  — 查询多行
 *   run(sql, ...args)  — 执行写操作
 *   exec(sql)          — 执行多条语句（DDL/schema）
 *   transaction(fn)    — 事务（同步回调）
 *   raw()              — 获取原始 better-sqlite3 Database 实例
 *   flush()            — 空操作（better-sqlite3 直接写磁盘，无需手动 flush）
 *   close()            — 关闭数据库
 *
 * 优势（相对 sql.js）：
 *   - 直接写磁盘，无 flush/dirty 机制，无崩溃丢数据风险
 *   - 同进程内同步 API，无 IPC 开销，批量 INSERT 比 sql.js 快 4-8x
 *   - 无需全局互斥锁（better-sqlite3 的同步 API 是线程安全的）
 *   - WAL 模式：允许并发读，写入不阻塞读请求
 *   - LRU prepared statement 缓存：200 条，消除热路径重复 compile
 */

import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let _db = null;

// ── LRU prepared statement 缓存 ─────────────────────────────────────────────
// 容量 200：覆盖所有插件的热路径 SQL，消除重复 compile 开销
const STMT_CACHE_SIZE = 200;
const _stmtCache = new Map(); // sql → PreparedStatement（LRU 顺序）

function _getStmt(sql) {
    if (_stmtCache.has(sql)) {
        // 命中：移到末尾（最近使用）
        const stmt = _stmtCache.get(sql);
        _stmtCache.delete(sql);
        _stmtCache.set(sql, stmt);
        return stmt;
    }
    // 未命中：编译并插入
    const stmt = _db.prepare(sql);
    if (_stmtCache.size >= STMT_CACHE_SIZE) {
        // 淘汰最久未使用（Map 迭代顺序 = 插入顺序，第一个即 LRU）
        _stmtCache.delete(_stmtCache.keys().next().value);
    }
    _stmtCache.set(sql, stmt);
    return stmt;
}

/** 规范化参数：支持 fn(sql, p1, p2) 和 fn(sql, [p1, p2]) 两种调用方式 */
function normalizeParams(args) {
    if (args.length === 0) return [];
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
}

/**
 * 初始化数据库
 * @param {string} path - SQLite 文件路径
 * @returns {Promise<void>} 保留 async 签名以向后兼容
 */
export async function init(path) {
    if (_db) return;

    mkdirSync(dirname(path), { recursive: true });

    const Database = require('better-sqlite3');
    _db = new Database(path);

    // WAL 模式：并发读不阻塞写，显著提升高并发场景性能
    _db.pragma('journal_mode = WAL');
    // 外键约束
    _db.pragma('foreign_keys = ON');
    // 适当放宽同步策略（WAL 模式下 NORMAL 足够安全，比 FULL 快）
    _db.pragma('synchronous = NORMAL');
    // 页缓存：~64MB（-16000 表示 KB 单位，负值）
    _db.pragma('cache_size = -16000');
    // mmap：128MB，顺序扫描大表时减少系统调用
    _db.pragma('mmap_size = 134217728');
    // 临时表存内存，避免磁盘 I/O
    _db.pragma('temp_store = MEMORY');
    // WAL 自动 checkpoint：每 10000 页触发，减少 WAL 文件膨胀
    _db.pragma('wal_autocheckpoint = 10000');
    // 忙等超时：5 秒，避免并发写时立即失败
    _db.pragma('busy_timeout = 5000');

    // 建表（幂等 — CREATE TABLE IF NOT EXISTS）
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    _db.exec(schema);

    // 在线迁移：添加新列（旧 db 文件升级）
    _runMigrations(_db);
}

/**
 * 空操作：better-sqlite3 直接写磁盘，无需手动 flush。
 * 保留此函数签名以向后兼容调用方（PluginEngine 等）。
 */
export function flush() {
    // no-op: better-sqlite3 writes directly to disk
}

/**
 * 查询单行，返回普通 JS 对象或 undefined
 */
export function get(sql, ...args) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    const params = normalizeParams(args);
    const stmt = _getStmt(sql);
    return params.length > 0 ? stmt.get(params) : stmt.get();
}

/**
 * 查询多行，返回普通 JS 对象数组
 */
export function all(sql, ...args) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    const params = normalizeParams(args);
    const stmt = _getStmt(sql);
    return params.length > 0 ? stmt.all(params) : stmt.all();
}

/**
 * 执行写操作（INSERT / UPDATE / DELETE 等）
 * 支持两种调用方式：
 *   run(sql, p1, p2, p3)  → params = [p1, p2, p3]
 *   run(sql, [p1, p2, p3]) → params = [p1, p2, p3]
 */
export function run(sql, ...args) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    const params = normalizeParams(args);
    const stmt = _getStmt(sql);
    return params.length > 0 ? stmt.run(params) : stmt.run();
}

/**
 * 执行多条语句（不带参数，用于批量 DDL / schema）
 * 注意：exec 不走 statement 缓存（DDL 不需要复用）
 */
export function exec(sql) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    _db.exec(sql);
}

/**
 * 事务：批量操作，自动 BEGIN/COMMIT/ROLLBACK
 * @param {Function} fn - 同步函数
 */
export function transaction(fn) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    return _db.transaction(fn)();
}

/**
 * 获取原始 better-sqlite3 Database 实例（供需要批量 prepare/step 的插件使用）
 */
export function raw() {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    return _db;
}

/**
 * 关闭数据库
 */
export function close() {
    if (_db) {
        _stmtCache.clear();
        _db.close();
        _db = null;
    }
}

// ── 在线迁移（幂等）──────────────────────────────────────────────────────────
function _runMigrations(db) {
    // 获取 sessions 表的现有列
    const sessionsCols = new Set();
    try {
        const rows = db.pragma('table_info(sessions)');
        for (const row of rows) sessionsCols.add(row.name);
    } catch { /* table may not exist yet */ }

    if (sessionsCols.size > 0 && !sessionsCols.has('project_id')) {
        db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT');
    }

    // 获取 projects 表的现有列
    const projectsCols = new Set();
    try {
        const rows = db.pragma('table_info(projects)');
        for (const row of rows) projectsCols.add(row.name);
    } catch { /* table may not exist yet */ }

    if (projectsCols.size > 0 && !projectsCols.has('preprocessed_path')) {
        db.exec('ALTER TABLE projects ADD COLUMN preprocessed_path TEXT');
    }

    // ── 性能迁移：writes/reads/fields 去掉 AUTOINCREMENT + FOREIGN KEY ────────
    // SQLite 中 AUTOINCREMENT 需要维护 sqlite_sequence 表，每次 INSERT 有额外开销。
    // FOREIGN KEY 在批量写入时会对每行做父表查找。两者对 F1 的百万级 INSERT 有显著影响。
    // 迁移策略：重命名旧表 → 创建新表（显式 DDL）→ 迁移数据 → 重建索引 → 删除旧表。
    // 幂等判断：检查表是否仍带有 AUTOINCREMENT（通过 sqlite_master 的 sql 字段）。
    const tblDefs = {
        writes: `CREATE TABLE writes (
            id         INTEGER PRIMARY KEY,
            event_id   INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            name       TEXT,
            value      TEXT,
            omitted    INTEGER DEFAULT 0
        )`,
        reads: `CREATE TABLE reads (
            id         INTEGER PRIMARY KEY,
            event_id   INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            name       TEXT,
            value      TEXT,
            omitted    INTEGER DEFAULT 0
        )`,
        fields: `CREATE TABLE fields (
            id         INTEGER PRIMARY KEY,
            event_id   INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            base       TEXT,
            offset     TEXT,
            is_write   INTEGER,
            value      TEXT,
            omitted    INTEGER DEFAULT 0
        )`,
    };
    const tblIndexes = {
        writes: 'CREATE INDEX IF NOT EXISTS idx_writes_name ON writes(session_id, name)',
        reads:  'CREATE INDEX IF NOT EXISTS idx_reads_name  ON reads(session_id, name)',
        fields: 'CREATE INDEX IF NOT EXISTS idx_fields_offset ON fields(session_id, offset)',
    };

    for (const tbl of ['writes', 'reads', 'fields']) {
        try {
            const meta = db.prepare(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
            ).get(tbl);
            if (!meta) continue; // 表不存在，schema 初始化时会创建新版本
            if (!meta.sql.toUpperCase().includes('AUTOINCREMENT')) continue; // 已是新版本

            // 表仍带 AUTOINCREMENT，执行重建（在事务内完成）
            db.exec(`
                ALTER TABLE ${tbl} RENAME TO _${tbl}_old;
                ${tblDefs[tbl]};
                INSERT INTO ${tbl} SELECT * FROM _${tbl}_old;
                DROP TABLE _${tbl}_old;
                ${tblIndexes[tbl]};
            `);
        } catch (e) {
            // 迁移失败不阻断启动，旧版本表仍可正常使用
            console.warn(`[Database] migrate ${tbl} failed (non-fatal):`, e.message);
        }
    }

    // ── 性能迁移：为 writes/reads/fields 补充 event_id 索引 ─────────────────
    // 这些索引对 F3/A2 等按 event_id 查询的插件至关重要，没有它们会全表扫描
    const eventIdIndexes = [
        ['idx_writes_event',       'writes',     'session_id, event_id'],
        ['idx_reads_event',        'reads',       'session_id, event_id'],
        ['idx_fields_event',       'fields',      'session_id, event_id'],
        ['idx_call_edges_fn_name', 'call_edges',  'session_id, fn_name'],
    ];
    for (const [idxName, tbl, cols] of eventIdIndexes) {
        try {
            const exists = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
            ).get(idxName);
            if (!exists) {
                db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tbl}(${cols})`);
            }
        } catch (e) {
            console.warn(`[Database] create index ${idxName} failed (non-fatal):`, e.message);
        }
    }

    // ── 性能迁移：新增复合覆盖索引（Phase A 优化）──────────────────────────
    const newIndexes = [
        // 覆盖索引：name + event_id，消除 A2/A5 的回表查询
        ['idx_writes_name_eid',    'writes',      'session_id, name, event_id'],
        ['idx_reads_name_eid',     'reads',       'session_id, name, event_id'],
        // events 按 type + id 排序：I4 事件分布统计 + 游标分页
        ['idx_events_type_id',     'events',      'session_id, type, id'],
        // iid_counts 按 count 降序：A3/I3/I4 取 Top-N 热点
        ['idx_iid_counts_count',   'iid_counts',  'session_id, count DESC'],
        // loops 按迭代次数降序：A5 取高频循环
        ['idx_loops_iter_count',   'loops',       'session_id, iteration_count DESC'],
        // value_patterns 按 matched_constant 过滤：I1 密码学检测
        ['idx_vp_matched',         'value_patterns', 'session_id, matched_constant'],
        // call_edges 按 return_value：I3 字符串解密函数检测
        ['idx_call_edges_retval',  'call_edges',  'session_id, return_value'],
        // 调用栈查询：owner-fn + call-stack API 的范围查询（call_seq <= N AND return_seq >= N）
        ['idx_call_edges_stack',   'call_edges',  'session_id, call_seq, return_seq, depth'],
        // var_name 过滤：按变量名反查事件（P1 值追踪增强）
        ['idx_vi_varname',         'value_index', 'session_id, var_name'],
    ];
    for (const [idxName, tbl, cols] of newIndexes) {
        try {
            const exists = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
            ).get(idxName);
            if (!exists) {
                db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tbl}(${cols})`);
            }
        } catch (e) {
            console.warn(`[Database] create index ${idxName} failed (non-fatal):`, e.message);
        }
    }

    // ── call_edges.own_event_count 列迁移 ────────────────────────────────────
    // 新增列：自身事件数（F3 预计算），旧数据库中不存在，需在线 ALTER
    try {
        const callEdgesCols = new Set(
            db.pragma('table_info(call_edges)').map(r => r.name)
        );
        if (callEdgesCols.size > 0 && !callEdgesCols.has('own_event_count')) {
            db.exec('ALTER TABLE call_edges ADD COLUMN own_event_count INTEGER');
        }
    } catch (e) {
        console.warn('[Database] add call_edges.own_event_count failed (non-fatal):', e.message);
    }

    // ── 清理旧的低效索引 ──────────────────────────────────────────────────────
    // idx_events_session_seq 被 idx_events_type_id + PK 覆盖，冗余
    // idx_smap_session 被 smap PRIMARY KEY (session_id, iid) 覆盖，冗余
    const dropIndexes = ['idx_events_session_seq', 'idx_smap_session'];
    for (const idxName of dropIndexes) {
        try {
            db.exec(`DROP INDEX IF EXISTS ${idxName}`);
        } catch (e) {
            console.warn(`[Database] drop index ${idxName} failed (non-fatal):`, e.message);
        }
    }

    // ── Phase D 迁移：events 表重建（type TEXT→INTEGER，删除 line/col/src_text）──
    // 幂等判断：检查 events.type 列是否仍为 TEXT（旧版本）。
    // 迁移策略：重命名旧表 → 创建新表 → 迁移数据（type 转整数）→ 重建索引 → 删除旧表。
    try {
        const evMeta = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
        ).get();
        if (evMeta) {
            // 旧版本 type 列定义含 "TEXT"；新版本含 "INTEGER"
            const needMigrate = /\btype\b[^,)]*\bTEXT\b/i.test(evMeta.sql);
            if (needMigrate) {
                db.exec(`
                    ALTER TABLE events RENAME TO _events_old;
                    CREATE TABLE events (
                        id         INTEGER PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        type       INTEGER NOT NULL,
                        iid        INTEGER,
                        FOREIGN KEY (session_id) REFERENCES sessions(id)
                    );
                    INSERT INTO events (id, session_id, type, iid)
                    SELECT id, session_id,
                        CASE type
                            WHEN 'SCRIPT_ENTER'   THEN 1
                            WHEN 'SCRIPT_EXIT'    THEN 2
                            WHEN 'CALL_PRE'       THEN 3
                            WHEN 'CALL'           THEN 4
                            WHEN 'FUNCTION_ENTER' THEN 5
                            WHEN 'FUNCTION_EXIT'  THEN 6
                            WHEN 'END_EXPR'       THEN 7
                            WHEN 'KEY_EVENT'      THEN 8
                            WHEN 'DICT_ENTRY'     THEN 9
                            WHEN 'WRITE_VAR'      THEN 11
                            WHEN 'READ_VAR_FULL'  THEN 12
                            ELSE 0
                        END,
                        iid
                    FROM _events_old;
                    DROP TABLE _events_old;
                    CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);
                    CREATE INDEX IF NOT EXISTS idx_events_iid ON events(session_id, iid);
                    CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(session_id, type, id);
                `);
                console.log('[Database] migrated events table: type TEXT -> INTEGER, removed line/col/src_text');
            }
        }
    } catch (e) {
        console.warn('[Database] migrate events table failed (non-fatal):', e.message);
    }

    // ── obfuscation_hints.fn_name 列迁移 ─────────────────────────────────────
    // I3 v2：string_decoder 类型新增 fn_name，用于前端跳转函数面板
    try {
        const obfCols = new Set(
            db.pragma('table_info(obfuscation_hints)').map(r => r.name)
        );
        if (obfCols.size > 0 && !obfCols.has('fn_name')) {
            db.exec('ALTER TABLE obfuscation_hints ADD COLUMN fn_name TEXT');
        }
    } catch (e) {
        console.warn('[Database] add obfuscation_hints.fn_name failed (non-fatal):', e.message);
    }
}
