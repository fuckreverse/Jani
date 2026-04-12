/**
 * A4_StringTracker.mjs — 追踪字符串赋值，识别编码类型
 * 写入 string_events 表
 *
 * 性能优化：
 *  - 使用 rawDb prepared statement + 单事务批量写入（避免循环内重复 prepare）
 *  - 直接在 SQL 层过滤字符串类型，减少 JS 端处理量
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BASE64_RE = /^[A-Za-z0-9+/]{8,}={0,2}$/;
const HEX_RE = /^[0-9a-fA-F]{8,}$/;
const URL_ENCODED_RE = /%[0-9A-Fa-f]{2}/;

function detectEncoding(value) {
    if (!value || typeof value !== 'string') return null;
    const v = value.trim();
    if (v.length < 4) return null;
    if (URL_ENCODED_RE.test(v)) return 'url';
    if (HEX_RE.test(v)) return 'hex';
    if (BASE64_RE.test(v)) return 'base64';
    return 'plain';
}

export default class A4StringTracker extends BasePlugin {
    static id = 'A4-StringTracker';
    static deps = ['F1-EventIndex'];
    static description = '追踪字符串赋值，识别 base64/hex/url 编码，写入 string_events 表';
    static displayName = 'A4 · StringTracker';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        this.emitProgress(ctx, '清空旧数据...', 0);
        rawDb.prepare('DELETE FROM string_events WHERE session_id = ?').run(sessionId);

        this.emitProgress(ctx, '提取字符串 writes...', 5);

        // 先从 value_dict 按 val_type='str' 过滤（走 idx_vd_type 索引，避免全表 LIKE）
        // 再 JOIN writes + events + smap 取 event_id / var_name / line / iid
        // 性能：value_dict 行数 << writes 行数，且有类型索引，消除了全量 LIKE 扫描
        const strWrites = rawDb.prepare(
            `SELECT w.event_id, w.name, vd.val_text AS value, s.sl AS line, e.iid
             FROM value_dict vd
             JOIN writes w ON w.session_id = vd.session_id AND w.value_id = vd.id
             JOIN events e ON e.id = w.event_id AND e.session_id = w.session_id
             LEFT JOIN smap s ON s.session_id = w.session_id AND s.iid = e.iid
             WHERE vd.session_id = ? AND vd.val_type = 'str'`
        ).all(sessionId);

        this.emitProgress(ctx, `分析 ${strWrites.length} 个字符串写入...`, 30);

        // prepared statement + 单事务批量写入
        const stmt = rawDb.prepare(
            'INSERT INTO string_events (session_id, event_id, value, var_name, line, iid, encoding_hint) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const insertBatch = rawDb.transaction((rows) => {
            for (const row of rows) stmt.run(row);
        });

        const rows = [];
        for (const sw of strWrites) {
            // val_text 是带引号的序列化字符串（如 '"hello"'），去掉外层引号
            let rawVal = sw.value || '';
            if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
                rawVal = rawVal.slice(1, -1);
            }
            const encoding = detectEncoding(rawVal);
            rows.push([
                sessionId,
                sw.event_id,
                rawVal.substring(0, 500),
                sw.name,
                sw.line,
                sw.iid,
                encoding,
            ]);
        }

        this.emitProgress(ctx, `写入 ${rows.length} 条字符串事件...`, 70);
        if (rows.length > 0) insertBatch(rows);

        this.emitProgress(ctx, `完成，${rows.length} 个字符串事件`, 100);
        this.emitDone(ctx, { stringCount: rows.length });
    }
}
