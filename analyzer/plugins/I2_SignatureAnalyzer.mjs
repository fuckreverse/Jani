/**
 * I2_SignatureAnalyzer.mjs — 签名 / Token 生成路径还原
 * 依赖：F1-EventIndex（writes/fields/reads 表）
 *
 * 定位签名/Token 相关字段的赋值点，反向追踪计算路径，写入 signature_paths 表。
 *
 * 使用共享的磁盘索引依赖切片；按动态 binding 和对象属性隔离来源。
 * 候选命中与切片均受配置限制，摘要显式报告截断。
 */
import BasePlugin from './BasePlugin.mjs';
import Database from 'better-sqlite3';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';
import { DependencyIndex, sliceDependencies } from '../DependencyIndex.mjs';

// ─── 需要定位的关键签名字段名（精确 + 模糊）────────────────────────────────

const SIGNATURE_FIELDS = [
    'sign', 'signature', 'token', 'access_token', 'timestamp',
    'nonce', 'hmac', 'digest', 'hash', 'x-sign', '_sign', 'mtgsig',
];

export default class I2SignatureAnalyzer extends BasePlugin {
    static observes = ['F2-SmapLoader'];
    static id = 'I2-SignatureAnalyzer';
    static deps = ['F1-EventIndex'];
    static description = '定位签名/Token 字段，反向追踪计算路径，写入 signature_paths 表';
    static displayName = 'I2 · SignatureAnalyzer';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();
        const dependencyDb=rawDb.name===':memory:' ? rawDb : new Database(rawDb.name,{readonly:true,fileMustExist:true});
        if(dependencyDb!==rawDb){dependencyDb.pragma('cache_size = -4096');dependencyDb.pragma('temp_store = FILE');}
        try {

        // 在 run() 入口捕获配置
        const _maxHops = cfg('plugins.I2_SignatureAnalyzer.maxHops');
        const _maxPaths = cfg('plugins.I2_SignatureAnalyzer.maxPaths');

        this.emitProgress(ctx, '清空旧数据...', 0);

        db.run('DELETE FROM signature_paths WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '查找签名相关字段...', 10);

        // ── 预加载：把所有需要的 writes/fields 命中一次性取出 ────────────────
        // 用一次 SQL 取所有 writes，然后 JS 侧过滤（避免逐字段多次查询）
        // line 已从 events 移除（Phase D），改 JOIN smap 获取
        const allWrites = rawDb.prepare(
            `SELECT w.event_id, w.name, vd.val_text AS value, s.sl AS line, e.iid
             FROM writes w
             LEFT JOIN value_dict vd ON vd.session_id = w.session_id AND vd.id = w.value_id
             JOIN events e ON w.event_id = e.id AND w.session_id = e.session_id
             LEFT JOIN smap s ON s.session_id = w.session_id AND s.iid = e.iid
             WHERE w.session_id = ?
               AND w.name IS NOT NULL`
        ).iterate(sessionId);

        const allFieldWrites = rawDb.prepare(
            `SELECT f.event_id, f.offset AS name, vd.val_text AS value, s.sl AS line, e.iid
             FROM fields f
             LEFT JOIN value_dict vd ON vd.session_id = f.session_id AND vd.id = f.value_id
             JOIN events e ON f.event_id = e.id AND f.session_id = e.session_id
             LEFT JOIN smap s ON s.session_id = f.session_id AND s.iid = e.iid
             WHERE f.session_id = ? AND f.is_write = 1
               AND f.offset IS NOT NULL`
        ).iterate(sessionId);

        // JS 过滤：匹配签名字段
        function matchesSigField(name) {
            if (!name) return null;
            const lname = name.toLowerCase();
            for (const f of SIGNATURE_FIELDS) {
                if (lname === f || lname.includes(f)) return f;
            }
            return null;
        }

        let candidatesTruncated=false;
        const hitsByField = new Map(); // fieldName → [{event_id, value, line, iid}]
        function* candidates(){yield* allWrites;yield* allFieldWrites;}
        for (const row of candidates()) {
            const matched = matchesSigField(row.name);
            if (!matched) continue;
            if (!hitsByField.has(matched)) hitsByField.set(matched, []);
            const arr = hitsByField.get(matched);
            if (arr.length < _maxPaths) arr.push(row); else candidatesTruncated=true;
        }

        const index = new DependencyIndex(dependencyDb,sessionId);
        let truncated=candidatesTruncated;
        const eventLine=rawDb.prepare(`SELECT s.sl FROM events e LEFT JOIN smap s ON s.session_id=e.session_id AND s.iid=e.iid WHERE e.session_id=? AND e.id=?`);
        const eventLineMap = { get: id => eventLine.get(sessionId,id)?.sl };
        // ── 逐字段追踪 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '反向追踪签名路径...', 45);
        const results = [];

        for (let fi = 0; fi < SIGNATURE_FIELDS.length; fi++) {
            const field = SIGNATURE_FIELDS[fi];
            if (results.length >= _maxPaths) break;

            const progress = 45 + Math.floor((fi / SIGNATURE_FIELDS.length) * 40);
            this.emitProgress(ctx, `追踪字段 "${field}"...`, progress);

            const allHits = hitsByField.get(field) || [];
            if (allHits.length === 0) continue;

            for (const hit of allHits) {
                if (results.length >= _maxPaths) break;

                const slice = sliceDependencies(index,[hit.event_id],{maxHops:_maxHops,maxNodes:cfg('plugins.A1_TaintTracker.maxNodes')});
                truncated ||= slice.truncated;
                const path = slice.nodes.map(n=>({event_id:n.eventId,var:n.varName}));
                if (path.length > 0) {
                    const summary = this._buildSummary(field, hit, path, eventLineMap) + (slice.truncated ? '；结果已截断' : '') + '；语句级依赖切片（含保守控制依赖）';
                    results.push({
                        field_name:    field,
                        sink_event_id: hit.event_id,
                        path_json:     JSON.stringify(path.map(p => p.event_id)),
                        summary,
                        input_vars:    JSON.stringify([...new Set(path.map(p => p.var).filter(Boolean))]),
                        hops:          Math.max(...slice.nodes.map(n=>n.depth)),
                        analysis_json: JSON.stringify({precision:slice.precision,truncated:slice.truncated,edges:slice.edges}),
                    });
                }
            }
        }

        truncated ||= [...hitsByField.values()].reduce((n,hits)=>n+hits.length,0)>results.length;
        this.emitProgress(ctx, `写入 ${results.length} 条签名路径...`, 90);

        if (results.length > 0) {
            db.transaction(() => {
                for (const r of results) {
                    db.run(
                        'INSERT INTO signature_paths (session_id, field_name, sink_event_id, path_json, summary, input_vars, hops, analysis_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [sessionId, r.field_name, r.sink_event_id, r.path_json, r.summary, r.input_vars, r.hops, r.analysis_json]
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，${results.length} 条签名路径`, 100);
        const fieldNames = [...new Set(results.map(r => r.field_name))].filter(Boolean);
        this.emitDone(ctx, {
            sigCount: results.length,
            fieldNames,
            precision: 'statement-level', truncated,
        });
        } finally { if(dependencyDb!==rawDb)dependencyDb.close(); }
    }

    /**
     * 构建人类可读的切片摘要（只查询切片涉及的源码位置）
     */
    _buildSummary(fieldName, hit, path, eventLineMap) {
        if (path.length === 0) {
            return `${fieldName} 赋值于 line ${hit.line ?? '?'}，无法追踪来源`;
        }

        const sinkLine = hit.line ?? '?';
        const dependencies = Math.max(0,path.length - 1);

        const lines = path.map(p => eventLineMap.get(p.event_id)).filter(Boolean);
        const uniqueLines = [...new Set(lines)].slice(0, 6);
        const linesStr = uniqueLines.length > 0 ? uniqueLines.join(' → ') : '?';

        const inputVars = [...new Set(path.slice(1).map(p => p.var).filter(Boolean))];
        const inputStr  = inputVars.length > 0
            ? `输入变量: ${inputVars.slice(0, 5).join(', ')}`
            : '无法识别输入变量';

        return `${fieldName} (line ${sinkLine}) ← ${dependencies} 个依赖事件，涉及行: ${linesStr}，${inputStr}`;
    }
}
