/**
 * A1_TaintTracker.mjs — BFS 污点追踪
 * 由 API POST /api/sessions/:id/taint 手动触发
 *
 * 性能优化：
 *  - 预加载该 session 的全量 writes/reads 索引到内存
 *  - BFS 期间零 DB 查询，完全内存化
 *  - 写入使用 rawDb prepared statement + 单事务
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

const MAX_HOPS  = () => cfg('plugins.A1_TaintTracker.maxHops');
const MAX_NODES = () => cfg('plugins.A1_TaintTracker.maxNodes');

export default class A1TaintTracker extends BasePlugin {
    static id = 'A1-TaintTracker';
    static deps = ['F1-EventIndex', 'F4-VariableLifetime'];
    static description = 'BFS 污点追踪（正向/反向），写入 taint_paths 表';
    static displayName = 'A1 · TaintTracker';

    async run(ctx) {
        const { sessionId, sourceVar, sourceEventId, direction = 'forward' } = ctx;
        const rawDb = db.raw();
        const _maxHops  = MAX_HOPS();
        const _maxNodes = MAX_NODES();

        if (!sourceVar && !sourceEventId) {
            throw new Error('A1-TaintTracker: sourceVar or sourceEventId required');
        }

        this.emitProgress(ctx, `开始${direction === 'forward' ? '正向' : '反向'}污点追踪...`, 0);

        // 清除旧数据
        if (sourceVar) {
            rawDb.prepare('DELETE FROM taint_paths WHERE session_id = ? AND source_var = ?').run(sessionId, sourceVar);
        }

        // ── 预加载 writes 索引：name → [{event_id}] ASC ──────────────────────
        this.emitProgress(ctx, '预加载 writes 索引...', 5);
        const writesNameIndex = new Map(); // name → event_id[] (ASC)
        const writesEventIndex = new Map(); // event_id → name[]
        {
            const rows = rawDb.prepare(
                'SELECT event_id, name FROM writes WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC'
            ).all(sessionId);
            for (const r of rows) {
                let byName = writesNameIndex.get(r.name);
                if (!byName) { byName = []; writesNameIndex.set(r.name, byName); }
                byName.push(r.event_id);

                let byEvt = writesEventIndex.get(r.event_id);
                if (!byEvt) { byEvt = []; writesEventIndex.set(r.event_id, byEvt); }
                byEvt.push(r.name);
            }
        }

        // ── 预加载 reads 索引：name → event_id[] ASC，event_id → name[] ──────
        this.emitProgress(ctx, '预加载 reads 索引...', 10);
        const readsNameIndex  = new Map(); // name → event_id[] (ASC)
        const readsEventIndex = new Map(); // event_id → name[]
        {
            const rows = rawDb.prepare(
                'SELECT event_id, name FROM reads WHERE session_id = ? AND name IS NOT NULL ORDER BY event_id ASC'
            ).all(sessionId);
            for (const r of rows) {
                let byName = readsNameIndex.get(r.name);
                if (!byName) { byName = []; readsNameIndex.set(r.name, byName); }
                byName.push(r.event_id);

                let byEvt = readsEventIndex.get(r.event_id);
                if (!byEvt) { byEvt = []; readsEventIndex.set(r.event_id, byEvt); }
                byEvt.push(r.name);
            }
        }

        this.emitProgress(ctx, `索引已加载，开始 BFS...`, 15);

        const paths = direction === 'forward'
            ? this._forwardBFS(sessionId, sourceVar, sourceEventId, ctx, writesNameIndex, writesEventIndex, readsNameIndex)
            : this._backwardBFS(sessionId, sourceVar, sourceEventId, ctx, writesNameIndex, readsNameIndex, readsEventIndex);

        // ── 写入 taint_paths（prepared statement + 单事务）──────────────────
        const stmt = rawDb.prepare(
            `INSERT INTO taint_paths (session_id, source_event_id, sink_event_id, path_json, source_var, sink_var, hop_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        rawDb.transaction(() => {
            for (const path of paths) {
                stmt.run(
                    sessionId,
                    path.sourceEventId,
                    path.sinkEventId,
                    JSON.stringify(path.eventIds),
                    sourceVar ?? null,
                    path.sinkVar ?? null,
                    path.eventIds.length - 1,
                );
            }
        })();

        this.emitProgress(ctx, `追踪完成，发现 ${paths.length} 条路径`, 100);
        this.emitDone(ctx, { pathCount: paths.length, paths });
    }

    /**
     * 正向 BFS（零 DB 查询，完全内存化）
     */
    _forwardBFS(sessionId, sourceVar, sourceEventId, ctx, writesNameIndex, writesEventIndex, readsNameIndex) {
        const paths   = [];
        const visited = new Set();

        // 起点：sourceVar 的所有 write 事件
        let frontier = [];
        if (sourceVar) {
            const writeEvts = writesNameIndex.get(sourceVar) || [];
            frontier = writeEvts.map(eid => ({ eventId: eid, var: sourceVar, pathSoFar: [eid] }));
        } else if (sourceEventId) {
            frontier = [{ eventId: sourceEventId, var: null, pathSoFar: [sourceEventId] }];
        }

        for (let hop = 0; hop < _maxHops && frontier.length > 0 && visited.size < _maxNodes; hop++) {
            const nextFrontier = [];

            for (const node of frontier) {
                const key = `${node.eventId}:${node.var}`;
                if (visited.has(key)) continue;
                visited.add(key);

                // 该事件写了哪些变量
                const writtenVars = writesEventIndex.get(node.eventId) || [];
                for (const varName of writtenVars) {
                    if (!varName) continue;
                    // 找后续 read 该变量的事件（event_id > node.eventId）
                    const allReadEvts = readsNameIndex.get(varName) || [];
                    // 二分找第一个 > node.eventId
                    let lo = 0, hi = allReadEvts.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >>> 1;
                        if (allReadEvts[mid] <= node.eventId) lo = mid + 1;
                        else hi = mid;
                    }
                    for (let i = lo; i < allReadEvts.length; i++) {
                        const reId = allReadEvts[i];
                        const newPath = [...node.pathSoFar, reId];
                        paths.push({
                            sourceEventId: node.pathSoFar[0],
                            sinkEventId:   reId,
                            sinkVar:       varName,
                            eventIds:      newPath,
                        });
                        nextFrontier.push({ eventId: reId, var: varName, pathSoFar: newPath });
                        if (paths.length >= _maxNodes * 10) break; // 安全上限
                    }
                }
            }

            frontier = nextFrontier;
            this.emitProgress(ctx, `hop ${hop + 1}，已发现 ${paths.length} 条路径`, Math.min(90, 15 + hop * 8));
        }

        return paths;
    }

    /**
     * 反向 BFS（零 DB 查询，完全内存化）
     */
    _backwardBFS(sessionId, sourceVar, sourceEventId, ctx, writesNameIndex, readsNameIndex, readsEventIndex) {
        const paths   = [];
        const visited = new Set();

        let frontier = [];
        if (sourceVar) {
            const readEvts = readsNameIndex.get(sourceVar) || [];
            frontier = readEvts.map(eid => ({ eventId: eid, var: sourceVar, pathSoFar: [eid] }));
        } else if (sourceEventId) {
            frontier = [{ eventId: sourceEventId, var: null, pathSoFar: [sourceEventId] }];
        }

        for (let hop = 0; hop < _maxHops && frontier.length > 0 && visited.size < _maxNodes; hop++) {
            const nextFrontier = [];

            for (const node of frontier) {
                const key = `${node.eventId}:${node.var}`;
                if (visited.has(key)) continue;
                visited.add(key);

                // 该事件读了哪些变量
                const readVars = readsEventIndex.get(node.eventId) || [];
                for (const varName of readVars) {
                    if (!varName) continue;
                    // 找在 node.eventId 之前 write 该变量的事件
                    const allWriteEvts = writesNameIndex.get(varName) || [];
                    // 二分找最后一个 < node.eventId
                    let lo = 0, hi = allWriteEvts.length - 1, lastIdx = -1;
                    while (lo <= hi) {
                        const mid = (lo + hi) >>> 1;
                        if (allWriteEvts[mid] < node.eventId) { lastIdx = mid; lo = mid + 1; }
                        else hi = mid - 1;
                    }
                    // 取最近的若干写（最多3个，避免路径爆炸）
                    for (let i = Math.max(0, lastIdx - 2); i <= lastIdx; i++) {
                        if (i < 0) continue;
                        const weId = allWriteEvts[i];
                        const newPath = [weId, ...node.pathSoFar];
                        paths.push({
                            sourceEventId: weId,
                            sinkEventId:   node.pathSoFar[node.pathSoFar.length - 1],
                            sinkVar:       sourceVar,
                            eventIds:      newPath,
                        });
                        nextFrontier.push({ eventId: weId, var: varName, pathSoFar: newPath });
                        if (paths.length >= _maxNodes * 10) break;
                    }
                }
            }

            frontier = nextFrontier;
            this.emitProgress(ctx, `hop ${hop + 1}，已发现 ${paths.length} 条路径`, Math.min(90, 15 + hop * 8));
        }

        return paths;
    }
}
