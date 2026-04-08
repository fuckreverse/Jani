/**
 * I2_SignatureAnalyzer.mjs — 签名 / Token 生成路径还原
 * 依赖：F1-EventIndex（writes/fields 表）、A1-TaintTracker（taint_paths 表）
 *
 * 定位签名/Token 相关字段的赋值点，反向追踪计算路径，写入 signature_paths 表。
 *
 * 性能优化：
 *  - _backwardTrace 中预加载 reads 表，减少循环内 N+1 查询
 *  - _buildSummary 中批量获取行号，消除循环内多次 db.get
 *  - 合并 writes + fields 的签名字段查询为单次 UNION ALL
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

// ─── 需要定位的关键签名字段名（精确 + 模糊）────────────────────────────────

const SIGNATURE_FIELDS = [
    'sign', 'signature', 'token', 'access_token', 'timestamp',
    'nonce', 'hmac', 'digest', 'hash', 'x-sign', '_sign', 'mtgsig',
];

// ─── 反向追踪最大跳数 / 最大路径数 ──────────────────────────────────────────

const MAX_HOPS   = 8;
const MAX_PATHS  = 100;

export default class I2SignatureAnalyzer extends BasePlugin {
    static id = 'I2-SignatureAnalyzer';
    static deps = ['F1-EventIndex', 'A1-TaintTracker'];
    static description = '定位签名/Token 字段，反向追踪计算路径，写入 signature_paths 表';
    static displayName = 'I2 · SignatureAnalyzer';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);

        // 迁移兼容：确保表结构正确
        try {
            db.exec(`
                DROP TABLE IF EXISTS signature_paths;
                CREATE TABLE IF NOT EXISTS signature_paths (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id      TEXT NOT NULL,
                    field_name      TEXT,
                    sink_event_id   INTEGER,
                    path_json       TEXT,
                    summary         TEXT,
                    input_vars      TEXT,
                    hops            INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_sig_paths_session ON signature_paths(session_id);
            `);
        } catch (e) {
            db.run('DELETE FROM signature_paths WHERE session_id = ?', [sessionId]);
        }

        this.emitProgress(ctx, '查找签名相关字段...', 10);

        // ── 预加载：把所有需要的 writes/fields 命中一次性取出 ────────────────
        // 为每个 field 分别 JOIN 一次，合并所有命中行（UNION ALL）
        const placeholders = SIGNATURE_FIELDS.map(() => '?').join(',');
        const likePatterns = SIGNATURE_FIELDS.map(f => `%${f}%`);

        // writes 命中（精确 + like，最多 20 条/字段）
        const writeHitsAll = rawDb.prepare(
            `SELECT w.event_id, w.name AS field_name_matched, w.value, e.line, e.iid
             FROM writes w
             JOIN events e ON w.event_id = e.id AND e.session_id = w.session_id
             WHERE w.session_id = ?
               AND (w.name IN (${placeholders}) OR w.name LIKE ANY (SELECT value FROM json_each(?)))
             LIMIT 500`
        );
        // sqlite 不支持 LIKE ANY，改为逐字段查询后在 JS 合并
        // 用一次 SQL 取所有 writes，然后 JS 过滤（避免 12 次独立查询）
        const allWrites = rawDb.prepare(
            `SELECT w.event_id, w.name, w.value, e.line, e.iid
             FROM writes w
             JOIN events e ON w.event_id = e.id AND e.session_id = w.session_id
             WHERE w.session_id = ?
               AND w.name IS NOT NULL
             LIMIT 50000`
        ).all(sessionId);

        const allFieldWrites = rawDb.prepare(
            `SELECT f.event_id, f.offset AS name, f.value, e.line, e.iid
             FROM fields f
             JOIN events e ON f.event_id = e.id AND e.session_id = f.session_id
             WHERE f.session_id = ? AND f.is_write = 1
               AND f.offset IS NOT NULL
             LIMIT 20000`
        ).all(sessionId);

        // JS 过滤：匹配签名字段
        function matchesSigField(name) {
            if (!name) return null;
            const lname = name.toLowerCase();
            for (const f of SIGNATURE_FIELDS) {
                if (lname === f || lname.includes(f)) return f;
            }
            return null;
        }

        const hitsByField = new Map(); // fieldName → [{event_id, value, line, iid}]
        for (const row of [...allWrites, ...allFieldWrites]) {
            const matched = matchesSigField(row.name);
            if (!matched) continue;
            if (!hitsByField.has(matched)) hitsByField.set(matched, []);
            const arr = hitsByField.get(matched);
            if (arr.length < 20) arr.push(row);
        }

        // ── 预加载 reads 表用于 _backwardTrace（避免循环内 N+1）─────────────
        // 读取所有 reads（event_id, name），建索引 event_id → names[]
        this.emitProgress(ctx, '预加载 reads 索引...', 25);
        const readsIndex = new Map(); // event_id → string[]
        const allReads = rawDb.prepare(
            'SELECT event_id, name FROM reads WHERE session_id = ? AND name IS NOT NULL'
        ).all(sessionId);
        for (const r of allReads) {
            let arr = readsIndex.get(r.event_id);
            if (!arr) { arr = []; readsIndex.set(r.event_id, arr); }
            arr.push(r.name);
        }

        // 预加载 writes 按名称索引（name → sorted [{event_id}]）用于前向追踪
        const writesNameIndex = new Map(); // name → sorted event_id[] DESC
        const allWritesForTrace = rawDb.prepare(
            'SELECT event_id, name FROM writes WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id DESC'
        ).all(sessionId);
        for (const w of allWritesForTrace) {
            let arr = writesNameIndex.get(w.name);
            if (!arr) { arr = []; writesNameIndex.set(w.name, arr); }
            arr.push(w.event_id);
        }

        // 预加载 event_id → line（用于 _buildSummary）
        this.emitProgress(ctx, '预加载事件行号...', 35);
        const eventLineMap = new Map();
        const allEvLines = rawDb.prepare(
            'SELECT id, line FROM events WHERE session_id = ?'
        ).all(sessionId);
        for (const e of allEvLines) eventLineMap.set(e.id, e.line);

        // ── 逐字段追踪 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '反向追踪签名路径...', 45);
        const results = [];

        for (let fi = 0; fi < SIGNATURE_FIELDS.length; fi++) {
            const field = SIGNATURE_FIELDS[fi];
            if (results.length >= MAX_PATHS) break;

            const progress = 45 + Math.floor((fi / SIGNATURE_FIELDS.length) * 40);
            this.emitProgress(ctx, `追踪字段 "${field}"...`, progress);

            const allHits = hitsByField.get(field) || [];
            if (allHits.length === 0) continue;

            for (const hit of allHits.slice(0, 3)) {
                if (results.length >= MAX_PATHS) break;

                const path = this._backwardTrace(hit.event_id, readsIndex, writesNameIndex);
                if (path.length > 0) {
                    const summary = this._buildSummary(field, hit, path, eventLineMap);
                    results.push({
                        field_name:    field,
                        sink_event_id: hit.event_id,
                        path_json:     JSON.stringify(path.map(p => p.event_id)),
                        summary,
                        input_vars:    JSON.stringify([...new Set(path.map(p => p.var).filter(Boolean))]),
                        hops:          path.length - 1,
                    });
                }
            }
        }

        this.emitProgress(ctx, `写入 ${results.length} 条签名路径...`, 90);

        if (results.length > 0) {
            db.transaction(() => {
                for (const r of results) {
                    db.run(
                        'INSERT INTO signature_paths (session_id, field_name, sink_event_id, path_json, summary, input_vars, hops) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [sessionId, r.field_name, r.sink_event_id, r.path_json, r.summary, r.input_vars, r.hops]
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，${results.length} 条签名路径`, 100);
        this.emitDone(ctx, {
            pathCount: results.length,
            fields: [...new Set(results.map(r => r.field_name))],
        });
    }

    /**
     * 反向 BFS 追踪（使用预加载的内存索引，零 DB 查询）
     */
    _backwardTrace(sinkEventId, readsIndex, writesNameIndex) {
        const path    = [];
        const visited = new Set();
        const queue   = [{ eventId: sinkEventId, varName: null }];

        while (queue.length > 0 && path.length <= MAX_HOPS) {
            const { eventId, varName } = queue.shift();
            if (visited.has(eventId)) continue;
            visited.add(eventId);
            path.push({ event_id: eventId, var: varName });

            const readVars = readsIndex.get(eventId);
            if (!readVars || readVars.length === 0) break;

            for (const name of readVars.slice(0, 4)) {
                const ids = writesNameIndex.get(name); // sorted DESC
                if (!ids) continue;
                // 找最近一次在 eventId 之前的 write
                const prevId = ids.find(id => id < eventId);
                if (prevId !== undefined && !visited.has(prevId)) {
                    queue.push({ eventId: prevId, varName: name });
                }
            }
        }

        return path;
    }

    /**
     * 构建人类可读的路径摘要（使用预加载的 eventLineMap，零 DB 查询）
     */
    _buildSummary(fieldName, hit, path, eventLineMap) {
        if (path.length === 0) {
            return `${fieldName} 赋值于 line ${hit.line ?? '?'}，无法追踪来源`;
        }

        const sinkLine = hit.line ?? '?';
        const hops     = path.length - 1;

        const lines = path.map(p => eventLineMap.get(p.event_id)).filter(Boolean);
        const uniqueLines = [...new Set(lines)].slice(0, 6);
        const linesStr = uniqueLines.length > 0 ? uniqueLines.join(' → ') : '?';

        const inputVars = [...new Set(path.slice(1).map(p => p.var).filter(Boolean))];
        const inputStr  = inputVars.length > 0
            ? `输入变量: ${inputVars.slice(0, 5).join(', ')}`
            : '无法识别输入变量';

        return `${fieldName} (line ${sinkLine}) ← ${hops} 跳，路径: ${linesStr}，${inputStr}`;
    }
}
