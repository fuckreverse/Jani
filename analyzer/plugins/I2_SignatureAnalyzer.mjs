/**
 * I2_SignatureAnalyzer.mjs — 签名 / Token 生成路径还原
 * 依赖：F1-EventIndex（writes/fields 表）、A1-TaintTracker（taint_paths 表）
 *
 * 定位签名/Token 相关字段的赋值点，反向追踪计算路径，写入 signature_paths 表。
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

// ─── 需要定位的关键签名字段名（精确 + 模糊）────────────────────────────────

const SIGNATURE_FIELDS = [
    'sign', 'signature', 'token', 'access_token', 'timestamp',
    'nonce', 'hmac', 'digest', 'hash', 'x-sign', '_sign', 'mtgsig',
];

// ─── 反向追踪最大跳数 / 最大路径数 ──────────────────────────────────────────

const MAX_HOPS = 8;
const MAX_PATHS = 100;

export default class I2SignatureAnalyzer extends BasePlugin {
    static id = 'I2-SignatureAnalyzer';
    static deps = ['F1-EventIndex', 'A1-TaintTracker'];
    static description = '定位签名/Token 字段，反向追踪计算路径，写入 signature_paths 表';
    static displayName = 'I2 · SignatureAnalyzer';

    async run(ctx) {
        const { sessionId } = ctx;

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

        const results = [];
        let fieldIdx = 0;

        for (const field of SIGNATURE_FIELDS) {
            if (results.length >= MAX_PATHS) break;

            const progress = 10 + Math.floor((fieldIdx / SIGNATURE_FIELDS.length) * 65);
            this.emitProgress(ctx, `扫描字段 "${field}"...`, progress);

            // 1. 在 writes 表中查找（精确名称 + 模糊匹配）
            const writeHits = db.all(
                `SELECT w.event_id, w.value, e.line, e.iid
                 FROM writes w
                 JOIN events e ON w.event_id = e.id
                 WHERE w.session_id = ? AND (w.name = ? OR w.name LIKE ?)
                 LIMIT 20`,
                [sessionId, field, `%${field}%`]
            );

            // 2. 在 fields 表中查找（属性写入，如 obj.sign = ...）
            const fieldHits = db.all(
                `SELECT f.event_id, f.value, e.line, e.iid
                 FROM fields f
                 JOIN events e ON f.event_id = e.id
                 WHERE f.session_id = ? AND f.offset = ? AND f.is_write = 1
                 LIMIT 20`,
                [sessionId, field]
            );

            const allHits = [...writeHits, ...fieldHits];
            if (allHits.length === 0) {
                fieldIdx++;
                continue;
            }

            // 对每个命中点，做反向 BFS 追踪来源（最多追踪前 3 个命中）
            for (const hit of allHits.slice(0, 3)) {
                if (results.length >= MAX_PATHS) break;

                const path = this._backwardTrace(sessionId, hit.event_id);
                if (path.length > 0) {
                    const summary = this._buildSummary(field, hit, path, sessionId);
                    results.push({
                        field_name: field,
                        sink_event_id: hit.event_id,
                        path_json: JSON.stringify(path.map(p => p.event_id)),
                        summary,
                        input_vars: JSON.stringify(
                            [...new Set(path.map(p => p.var).filter(Boolean))]
                        ),
                        hops: path.length - 1,
                    });
                }
            }

            fieldIdx++;
        }

        this.emitProgress(ctx, `写入 ${results.length} 条签名路径...`, 80);

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
     * 反向 BFS 追踪：从 sink 事件出发，沿读取链向前查找数据来源
     *
     * 策略：
     *   1. 查询 sink 事件的 reads（这些是该赋值的输入变量）
     *   2. 对每个输入变量，找到最近一次写入该变量的事件（在 sink 之前）
     *   3. 递归追踪，最多 MAX_HOPS 跳
     *
     * @param {string} sessionId
     * @param {number} sinkEventId
     * @returns {{ event_id: number, var: string|null }[]}
     */
    _backwardTrace(sessionId, sinkEventId) {
        const path = [];
        const visited = new Set();

        // BFS 队列：{ eventId, varName }
        const queue = [{ eventId: sinkEventId, varName: null }];

        while (queue.length > 0 && path.length <= MAX_HOPS) {
            const { eventId, varName } = queue.shift();
            if (visited.has(eventId)) continue;
            visited.add(eventId);

            path.push({ event_id: eventId, var: varName });

            // 查询该事件读取了哪些变量
            const readVars = db.all(
                'SELECT name FROM reads WHERE session_id = ? AND event_id = ? AND name IS NOT NULL',
                [sessionId, eventId]
            );

            if (readVars.length === 0) break;

            // 对每个读取变量，找最近一次写入（在当前事件之前）
            for (const rv of readVars.slice(0, 4)) { // 每跳最多追 4 个分支
                if (!rv.name) continue;

                const prevWrite = db.get(
                    `SELECT w.event_id, w.name
                     FROM writes w
                     JOIN events e ON w.event_id = e.id
                     WHERE w.session_id = ? AND w.name = ? AND w.event_id < ?
                     ORDER BY w.event_id DESC
                     LIMIT 1`,
                    [sessionId, rv.name, eventId]
                );

                if (prevWrite && !visited.has(prevWrite.event_id)) {
                    queue.push({ eventId: prevWrite.event_id, varName: rv.name });
                }
            }
        }

        return path;
    }

    /**
     * 构建人类可读的路径摘要
     */
    _buildSummary(fieldName, hit, path, sessionId) {
        if (path.length === 0) {
            return `${fieldName} 赋值于 line ${hit.line ?? '?'}，无法追踪来源`;
        }

        const sinkLine = hit.line ?? '?';
        const hops = path.length - 1;

        // 收集路径中的行号
        const lines = [];
        for (const p of path) {
            try {
                const ev = db.get(
                    'SELECT line FROM events WHERE id = ? AND session_id = ?',
                    [p.event_id, sessionId]
                );
                if (ev?.line) lines.push(ev.line);
            } catch { /* ignore */ }
        }

        const uniqueLines = [...new Set(lines)].slice(0, 6);
        const linesStr = uniqueLines.length > 0 ? uniqueLines.join(' → ') : '?';

        const inputVars = [...new Set(path.slice(1).map(p => p.var).filter(Boolean))];
        const inputStr = inputVars.length > 0
            ? `输入变量: ${inputVars.slice(0, 5).join(', ')}`
            : '无法识别输入变量';

        return `${fieldName} (line ${sinkLine}) ← ${hops} 跳，路径: ${linesStr}，${inputStr}`;
    }
}
