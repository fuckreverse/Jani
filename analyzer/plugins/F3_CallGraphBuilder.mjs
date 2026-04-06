/**
 * F3_CallGraphBuilder.mjs — 配对 CALL_PRE/CALL 事件，重建调用图
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class F3CallGraphBuilder extends BasePlugin {
    static id = 'F3-CallGraphBuilder';
    static deps = ['F1-EventIndex'];
    static description = '配对 CALL_PRE/CALL 事件，重建调用图，写入 call_edges 表';
    static displayName = 'F3 · CallGraphBuilder';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM call_edges WHERE session_id = ?', [sessionId]);

        // 获取所有 CALL_PRE 和 CALL 事件（按 seq 排序）
        this.emitProgress(ctx, '读取调用事件...', 5);
        const callEvents = db.all(
            "SELECT id, type, iid, line FROM events WHERE session_id = ? AND type IN ('CALL_PRE', 'CALL') ORDER BY id ASC",
            [sessionId]
        );

        const stack = [];
        let depth = 0;
        let edgeCount = 0;
        const edges = [];

        for (const evt of callEvents) {
            if (evt.type === 'CALL_PRE') {
                // 获取参数（writes 里 name = arg0/arg1/... 或参数名）
                const args = db.all('SELECT name, value FROM writes WHERE event_id = ? AND session_id = ?', [evt.id, sessionId]);
                const argsJson = JSON.stringify(args.map(a => ({ name: a.name, value: a.value })));
                stack.push({
                    call_seq: evt.id,
                    caller_line: evt.line,
                    fn_iid: evt.iid,
                    fn_name: null, // 从 CALL 事件的 reads 里读
                    args_json: argsJson,
                    depth: depth++,
                });
            } else if (evt.type === 'CALL') {
                if (stack.length === 0) { depth = Math.max(0, depth - 1); continue; }
                const frame = stack.pop();
                depth = Math.max(0, depth - 1);

                // 获取返回值
                const retWrites = db.all('SELECT name, value FROM writes WHERE event_id = ? AND session_id = ?', [evt.id, sessionId]);
                const retEntry = retWrites.find(w => w.name === 'return') || retWrites[0];
                const returnValue = retEntry ? retEntry.value : null;

                // fn_name: 从 CALL_PRE 事件的 reads 中推断（callee 字段）
                const fnReads = db.all('SELECT name, value FROM reads WHERE event_id = ? AND session_id = ?', [frame.call_seq, sessionId]);
                const fnName = fnReads.find(r => r.name === 'callee')?.value?.replace(/^"|"$/g, '') || `fn@${frame.fn_iid || 'unknown'}`;

                edges.push([
                    sessionId,
                    frame.call_seq,
                    evt.id,
                    frame.caller_line,
                    fnName,
                    frame.fn_iid,
                    frame.args_json,
                    returnValue,
                    frame.depth,
                ]);

                edgeCount++;

                // 批量写入
                if (edges.length >= 500) {
                    db.transaction(() => {
                        for (const e of edges) {
                            db.run(
                                'INSERT INTO call_edges (session_id, call_seq, return_seq, caller_line, fn_name, fn_iid, args_json, return_value, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                e
                            );
                        }
                    });
                    edges.length = 0;
                    this.emitProgress(ctx, `已处理 ${edgeCount} 条调用...`, Math.min(90, 5 + edgeCount / 10));
                }
            }
        }

        // 写入剩余
        if (edges.length > 0) {
            db.transaction(() => {
                for (const e of edges) {
                    db.run(
                        'INSERT INTO call_edges (session_id, call_seq, return_seq, caller_line, fn_name, fn_iid, args_json, return_value, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        e
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，共 ${edgeCount} 条调用边`, 100);
        this.emitDone(ctx, { edgeCount });
    }
}
