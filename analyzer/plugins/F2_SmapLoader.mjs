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

        // 支持两种格式：
        //   新格式（buildSmapJson 输出）：{ version, iids: { "8": [...], ... }, ... }
        //   旧格式（直接导出 sourceInfo）：{ "8": [...], "16": [...], ... }（iid 作为顶层 key）
        let iids = smapData.iids;
        if (!iids || typeof iids !== 'object') {
            // 尝试旧格式：检测顶层是否有数字 key（代表 iid）且对应值为数组
            const NON_IID_KEYS = new Set([
                'nBranches', 'originalCodeFileName', 'instrumentedCodeFileName',
                'url', 'evalSid', 'evalIid', 'code', 'version',
            ]);
            const firstNumericEntry = Object.entries(smapData).find(
                ([k, v]) => !NON_IID_KEYS.has(k) && !isNaN(Number(k)) && Array.isArray(v)
            );
            if (firstNumericEntry) {
                // 旧格式：过滤出所有 iid-like 条目（数字 key + 数组值）
                iids = Object.fromEntries(
                    Object.entries(smapData).filter(
                        ([k, v]) => !NON_IID_KEYS.has(k) && !isNaN(Number(k)) && Array.isArray(v)
                    )
                );
                this.emitProgress(ctx, '检测到旧格式 .map.json，自动兼容处理...', 5);
            } else {
                this.emitProgress(ctx, '.smap.json 中无 iids 字段，跳过', 100);
                this.emitDone(ctx, { skipped: true, reason: 'no iids' });
                return;
            }
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

        // Phase D：events 表已无 line/col/src_text 列，smap 是唯一来源，无需回填。

        this.emitProgress(ctx, `完成，共 ${count} 个 iid 条目`, 100);
        this.emitDone(ctx, { smapCount: count });
    }
}
