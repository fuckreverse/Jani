/**
 * A4_StringTracker.mjs — 追踪字符串赋值，识别编码类型
 * 写入 string_events 表
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

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM string_events WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '提取字符串 writes...', 5);

        // 找所有 value 是字符串类型（以双引号包裹）的 write
        const strWrites = db.all(
            `SELECT w.event_id, w.name, w.value, e.line, e.iid
             FROM writes w
             JOIN events e ON w.event_id = e.id AND e.session_id = w.session_id
             WHERE w.session_id = ?
               AND w.value IS NOT NULL
               AND w.value LIKE '"%"'
             LIMIT 10000`,
            [sessionId]
        );

        this.emitProgress(ctx, `分析 ${strWrites.length} 个字符串写入...`, 30);

        const rows = [];
        for (const sw of strWrites) {
            // 去除首尾引号
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

        if (rows.length > 0) {
            db.transaction(() => {
                for (const row of rows) {
                    db.run(
                        'INSERT INTO string_events (session_id, event_id, value, var_name, line, iid, encoding_hint) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        row
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，${rows.length} 个字符串事件`, 100);
        this.emitDone(ctx, { stringCount: rows.length });
    }
}
