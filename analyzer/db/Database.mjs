/**
 * Database.mjs — SQLite 封装（sql.js，内存 db + 批次结束后写盘）
 *
 * 持久化策略：
 * - 数据库始终在 WASM 内存中运行（sql.js），无挂载路径限制
 * - 每次 transaction() 执行后标记 dirty
 * - `flush()` 主动将内存 db export 到磁盘（供插件完成后调用）
 * - `close()` 时自动 flush
 *
 * 高性能保证：
 * - transaction() 内不做 export，只写内存
 * - 大量插入时，调用方只需在批次末尾调用一次 flush()
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let _db = null;
let _dbPath = null;
let _dirty = false;

/** 规范化参数：支持 fn(sql, p1, p2) 和 fn(sql, [p1, p2]) 两种调用方式 */
function normalizeParams(args) {
    if (args.length === 0) return [];
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
}

/**
 * 初始化数据库
 * @param {string} path - SQLite 文件路径
 */
export async function init(path) {
    if (_db) return;

    _dbPath = path;
    mkdirSync(dirname(path), { recursive: true });

    const SQL = require('sql.js');
    const sqlJs = await SQL();

    // 若磁盘已有 db 文件，加载它；否则新建
    let fileBuffer;
    if (existsSync(path)) {
        fileBuffer = readFileSync(path);
    }
    _db = fileBuffer ? new sqlJs.Database(fileBuffer) : new sqlJs.Database();

    // 建表（幂等 — CREATE TABLE IF NOT EXISTS）
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    _db.run(schema);

    // ── 在线迁移：添加新列（旧 db 文件升级）────────────────────────────────
    _runMigrations(_db);

    _dirty = false;
}

/**
 * 将内存 db 持久化到磁盘（不影响正在进行的事务）
 */
export function flush() {
    if (!_db || !_dbPath || !_dirty) return;
    const data = _db.export();
    writeFileSync(_dbPath, Buffer.from(data));
    _dirty = false;
}

/**
 * 查询单行，返回普通 JS 对象或 undefined
 */
export function get(sql, ...args) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    const params = normalizeParams(args);
    const stmt = _db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
}

/**
 * 查询多行，返回普通 JS 对象数组
 */
export function all(sql, ...args) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    const params = normalizeParams(args);
    const stmt = _db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
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
    if (params.length > 0) {
        _db.run(sql, params);  // sql.js 第二个参数必须是数组
    } else {
        _db.run(sql);
    }
    _dirty = true;
}

/**
 * 执行多条语句（不带参数，用于批量 DDL / schema）
 */
export function exec(sql) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    _db.run(sql);
    _dirty = true;
}

/**
 * 事务：批量操作，自动 BEGIN/COMMIT/ROLLBACK
 * 注意：事务内不调用 flush()，保持高吞吐
 * @param {Function} fn - 同步函数
 */
export function transaction(fn) {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    _db.run('BEGIN');
    try {
        const result = fn();
        _db.run('COMMIT');
        _dirty = true;
        return result;
    } catch (e) {
        try { _db.run('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    }
}

/**
 * 获取原始 sql.js Database 实例（供需要批量 prepare/step 的插件使用）
 */
export function raw() {
    if (!_db) throw new Error('Database not initialized. Call init() first.');
    return _db;
}

/**
 * 关闭数据库（先 flush 再关闭）
 */
export function close() {
    if (_db) {
        flush();
        _db.close();
        _db = null;
    }
}

// ── 在线迁移（幂等）──────────────────────────────────────────────────────────
function _runMigrations(db) {
    // 列出 sessions 表的现有列
    const sessionsCols = new Set();
    try {
        const stmt = db.prepare('PRAGMA table_info(sessions)');
        while (stmt.step()) {
            const row = stmt.getAsObject();
            sessionsCols.add(row.name);
        }
        stmt.free();
    } catch { /* table may not exist yet */ }

    if (sessionsCols.size > 0 && !sessionsCols.has('project_id')) {
        db.run('ALTER TABLE sessions ADD COLUMN project_id TEXT');
    }
}
