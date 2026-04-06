/**
 * A1_TaintTracker.mjs — BFS 污点追踪
 * 由 API POST /api/sessions/:id/taint 手动触发
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

const MAX_HOPS = 10;
const MAX_NODES = 500;

export default class A1TaintTracker extends BasePlugin {
    static id = 'A1-TaintTracker';
    static deps = ['F1-EventIndex', 'F4-VariableLifetime'];
    static description = 'BFS 污点追踪（正向/反向），写入 taint_paths 表';
    static displayName = 'A1 · TaintTracker';

    async run(ctx) {
        const { sessionId, sourceVar, sourceEventId, direction = 'forward' } = ctx;

        if (!sourceVar && !sourceEventId) {
            throw new Error('A1-TaintTracker: sourceVar or sourceEventId required');
        }

        this.emitProgress(ctx, `开始${direction === 'forward' ? '正向' : '反向'}污点追踪...`, 0);

        // 清除该 session 的旧污点路径（如果 sourceVar 相同）
        if (sourceVar) {
            db.run('DELETE FROM taint_paths WHERE session_id = ? AND source_var = ?', [sessionId, sourceVar]);
        }

        const paths = direction === 'forward'
            ? await this._forwardBFS(sessionId, sourceVar, sourceEventId, ctx)
            : await this._backwardBFS(sessionId, sourceVar, sourceEventId, ctx);

        // 写入 taint_paths
        db.transaction(() => {
            for (const path of paths) {
                db.run(
                    `INSERT INTO taint_paths (session_id, source_event_id, sink_event_id, path_json, source_var, sink_var, hop_count)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        sessionId,
                        path.sourceEventId,
                        path.sinkEventId,
                        JSON.stringify(path.eventIds),
                        sourceVar ?? null,
                        path.sinkVar ?? null,
                        path.eventIds.length - 1,
                    ]
                );
            }
        });

        this.emitProgress(ctx, `追踪完成，发现 ${paths.length} 条路径`, 100);
        this.emitDone(ctx, { pathCount: paths.length, paths });
    }

    async _forwardBFS(sessionId, sourceVar, sourceEventId, ctx) {
        const paths = [];
        const visited = new Set();

        // 起点：sourceVar 的所有 write 事件
        let frontier = [];
        if (sourceVar) {
            const writeEvts = db.all(
                'SELECT event_id FROM writes WHERE session_id = ? AND name = ?',
                [sessionId, sourceVar]
            );
            frontier = writeEvts.map(w => ({ eventId: w.event_id, var: sourceVar, pathSoFar: [w.event_id] }));
        } else if (sourceEventId) {
            frontier = [{ eventId: sourceEventId, var: null, pathSoFar: [sourceEventId] }];
        }

        for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && visited.size < MAX_NODES; hop++) {
            const nextFrontier = [];

            for (const node of frontier) {
                const key = `${node.eventId}:${node.var}`;
                if (visited.has(key)) continue;
                visited.add(key);

                // 找该事件的 write 变量，再找哪些事件 read 了这些变量
                const writtenVars = db.all('SELECT name FROM writes WHERE event_id = ? AND session_id = ?', [node.eventId, sessionId]);

                for (const wv of writtenVars) {
                    if (!wv.name) continue;
                    // 找后续 read 该变量的事件（seq > node.eventId）
                    const readEvts = db.all(
                        'SELECT event_id FROM reads WHERE session_id = ? AND name = ? AND event_id > ?',
                        [sessionId, wv.name, node.eventId]
                    );

                    for (const re of readEvts) {
                        const newPath = [...node.pathSoFar, re.event_id];
                        paths.push({
                            sourceEventId: node.pathSoFar[0],
                            sinkEventId: re.event_id,
                            sinkVar: wv.name,
                            eventIds: newPath,
                        });
                        nextFrontier.push({ eventId: re.event_id, var: wv.name, pathSoFar: newPath });
                    }
                }
            }

            frontier = nextFrontier;
            this.emitProgress(ctx, `hop ${hop + 1}，已发现 ${paths.length} 条路径`, Math.min(90, 10 + hop * 10));
        }

        return paths;
    }

    async _backwardBFS(sessionId, sourceVar, sourceEventId, ctx) {
        const paths = [];
        const visited = new Set();

        let frontier = [];
        if (sourceVar) {
            const readEvts = db.all(
                'SELECT event_id FROM reads WHERE session_id = ? AND name = ?',
                [sessionId, sourceVar]
            );
            frontier = readEvts.map(r => ({ eventId: r.event_id, var: sourceVar, pathSoFar: [r.event_id] }));
        } else if (sourceEventId) {
            frontier = [{ eventId: sourceEventId, var: null, pathSoFar: [sourceEventId] }];
        }

        for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && visited.size < MAX_NODES; hop++) {
            const nextFrontier = [];

            for (const node of frontier) {
                const key = `${node.eventId}:${node.var}`;
                if (visited.has(key)) continue;
                visited.add(key);

                // 找该事件之前 write 了同名变量的事件
                const readVars = db.all('SELECT name FROM reads WHERE event_id = ? AND session_id = ?', [node.eventId, sessionId]);

                for (const rv of readVars) {
                    if (!rv.name) continue;
                    const writeEvts = db.all(
                        'SELECT event_id FROM writes WHERE session_id = ? AND name = ? AND event_id < ?',
                        [sessionId, rv.name, node.eventId]
                    );

                    for (const we of writeEvts) {
                        const newPath = [we.event_id, ...node.pathSoFar];
                        paths.push({
                            sourceEventId: we.event_id,
                            sinkEventId: node.pathSoFar[node.pathSoFar.length - 1],
                            sinkVar: sourceVar,
                            eventIds: newPath,
                        });
                        nextFrontier.push({ eventId: we.event_id, var: rv.name, pathSoFar: newPath });
                    }
                }
            }

            frontier = nextFrontier;
            this.emitProgress(ctx, `hop ${hop + 1}，已发现 ${paths.length} 条路径`, Math.min(90, 10 + hop * 10));
        }

        return paths;
    }
}
