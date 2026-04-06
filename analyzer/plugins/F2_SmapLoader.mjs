/**
 * F2_SmapLoader.mjs — 解析 .smap.json，写入 smap 表
 *
 * 依赖：无
 * 输入：.smap.json 文件
 * 输出：smap 表（iid → sl/sc/el/ec/srcText/defIid 映射）
 */

import { readFileSync } from 'fs';
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const BATCH_SIZE = 1000;

export default class F2SmapLoader extends BasePlugin {
    static id = 'F2-SmapLoader';
    static deps = [];
    static description = '解析 .smap.json，写入 smap 表（iid → 行列/srcText 映射）';
    static displayName = 'F2 · SmapLoader';

    async run(ctx) {
        const { sessionId } = ctx;

        const session = db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);

        if (!session.smap_path) {
            this.emitProgress(ctx, '无 .smap.json，跳过 F2', 100);
            this.emitDone(ctx, { skipped: true, reason: 'no smap_path' });
            return;
        }

        this.emitProgress(ctx, '读取 .smap.json...', 0);

        let smapData;
        try {
            smapData = JSON.parse(readFileSync(session.smap_path, 'utf8'));
        } catch (e) {
            throw new Error(`无法读取 .smap.json "${session.smap_path}": ${e.message}`);
        }

        const iids = smapData.iids;
        if (!iids || typeof iids !== 'object') {
            this.emitProgress(ctx, '.smap.json 中无 iids 字段，跳过', 100);
            this.emitDone(ctx, { skipped: true, reason: 'no iids' });
            return;
        }

        this.emitProgress(ctx, '写入 smap 表...', 10);

        // 清空旧数据
        db.run('DELETE FROM smap WHERE session_id = ?', sessionId);

        const entries = Object.entries(iids);
        let count = 0;

        // 分批写入
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE);
            db.transaction(() => {
                for (const [key, arr] of batch) {
                    if (!Array.isArray(arr) || arr.length < 4) continue;
                    const iid     = Number(key);
                    const sl      = arr[0] ?? null;
                    const sc      = arr[1] ?? null;
                    const el      = arr[2] ?? null;
                    const ec      = arr[3] ?? null;
                    const srcText = arr[4] != null ? String(arr[4]) : null;
                    const defIid  = arr[5] != null ? Number(arr[5]) : null;
                    db.run(
                        `INSERT OR REPLACE INTO smap (session_id, iid, sl, sc, el, ec, src_text, def_iid)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [sessionId, iid, sl, sc, el, ec, srcText, defIid]
                    );
                    count++;
                }
            });
            const progress = Math.min(95, Math.floor((i / entries.length) * 85) + 10);
            this.emitProgress(ctx, `已处理 ${Math.min(i + BATCH_SIZE, entries.length)} / ${entries.length} iids`, progress);
        }

        // 用 smap 数据回填 events 表中缺失的 line/col/src_text（correlated UPDATE）
        this.emitProgress(ctx, '更新事件行列信息...', 96);

        db.run(
            `UPDATE events
             SET line     = COALESCE(line,     (SELECT sl       FROM smap WHERE smap.session_id = events.session_id AND smap.iid = events.iid)),
                 col      = COALESCE(col,      (SELECT sc       FROM smap WHERE smap.session_id = events.session_id AND smap.iid = events.iid)),
                 src_text = COALESCE(src_text, (SELECT src_text FROM smap WHERE smap.session_id = events.session_id AND smap.iid = events.iid))
             WHERE session_id = ? AND line IS NULL`,
            [sessionId]
        );

        this.emitProgress(ctx, `完成，共 ${count} 个 iid 条目`, 100);
        this.emitDone(ctx, { iidCount: count });
    }
}
