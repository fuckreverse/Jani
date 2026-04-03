#!/usr/bin/env node
/**
 * trace-call-tree.mjs — 重建调用树
 *
 * 用法：
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --depth 5
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --json
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --max-nodes 10000
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --stream
 *   node tools/trace-call-tree.mjs --help
 *
 * 输入格式：trace-parse.mjs 输出的 NDJSON（JTB1 事件类型）
 *   - CALL_PRE 事件：函数调用开始（含 fn 字段）
 *   - CALL 事件：函数调用结束（含 fn、result 字段）
 *
 * 输出：
 *   树形调用图（带缩进和统计）
 *
 * 内存控制选项：
 *   --max-nodes N   方案 A：建树上限（默认 50000），超限后只统计不建树，处理完后输出警告
 *   --stream        方案 B：流式输出，每个顶层调用配对完成后立即序列化输出并释放内存
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 调用树节点 ────────────────────────────────────────────────────────────

class CallNode {
    constructor(fn, line, callSeq) {
        this.fn = fn;
        this.line = line;
        this.callSeq = callSeq;
        this.returnSeq = null;
        this.result = undefined;
        this.children = [];
        this.parent = null;
        this.stats = {
            calls: 0,
            totalDepth: 0,
        };
    }

    addChild(node) {
        node.parent = this;
        this.children.push(node);
    }

    toJSON() {
        return {
            fn: this.fn,
            line: this.line,
            callSeq: this.callSeq,
            returnSeq: this.returnSeq,
            result: this.result,
            children: this.children.length > 0 ? this.children.map(c => c.toJSON()) : undefined,
        };
    }
}

// ── 方案 A：带 --max-nodes 上限的构建器 ──────────────────────────────────

class CallTreeBuilder {
    /**
     * @param {number} maxNodes  建树节点上限（0 = 不限）
     */
    constructor(maxNodes = 50000) {
        this.maxNodes = maxNodes;
        this.root = new CallNode('<root>', 0, 0);
        this.current = this.root;
        this.allNodes = [];
        this._pendingByIid = new Map();

        // 超限状态
        this._limitReached = false;
        this._skippedCalls = 0;       // 超限后被跳过的 CALL_PRE 数量
        this._skipDepth = 0;          // 超限后还未配对的嵌套层级（用于忽略子 CALL）
    }

    get limitReached() { return this._limitReached; }
    get skippedCalls() { return this._skippedCalls; }

    process(record) {
        if (record.type === 'CALL_PRE') {
            // 已超限：进入跳过模式
            if (this._limitReached) {
                this._skippedCalls++;
                this._skipDepth++;
                return;
            }

            const node = new CallNode(
                record.fn ?? '(anonymous)',
                record.line ?? 0,
                record.seq
            );
            this.current.addChild(node);
            this.current = node;
            this.allNodes.push(node);
            if (record.iid != null) {
                this._pendingByIid.set(record.iid, node);
            }

            // 检查是否触达上限
            if (this.maxNodes > 0 && this.allNodes.length >= this.maxNodes) {
                this._limitReached = true;
            }
        } else if (record.type === 'CALL') {
            // 超限跳过模式：等待对称关闭
            if (this._limitReached && this._skipDepth > 0) {
                this._skipDepth--;
                return;
            }

            // 正常配对逻辑（与原版一致）
            let node = null;
            if (record.iid != null && this._pendingByIid.has(record.iid)) {
                node = this._pendingByIid.get(record.iid);
                this._pendingByIid.delete(record.iid);
            }

            if (node && this.current !== this.root) {
                let cur = this.current;
                while (cur !== this.root && cur !== node) {
                    cur.returnSeq = record.seq;
                    cur = cur.parent || this.root;
                }
                if (cur === node) {
                    cur.returnSeq = record.seq;
                    cur.result = record.result;
                    this.current = cur.parent || this.root;
                } else {
                    if (this.current !== this.root) {
                        this.current.returnSeq = record.seq;
                        this.current = this.current.parent || this.root;
                    }
                }
            } else if (this.current !== this.root) {
                this.current.returnSeq = record.seq;
                if (record.result !== undefined) {
                    this.current.result = record.result;
                }
                this.current = this.current.parent || this.root;
            }
        }
    }

    computeStats() {
        const stack = [{ node: this.root, depth: 0 }];
        while (stack.length > 0) {
            const { node, depth } = stack.pop();
            node.stats.calls = node.children.length;
            node.stats.totalDepth = depth;
            for (const child of node.children) {
                stack.push({ node: child, depth: depth + 1 });
            }
        }
    }

    formatTree(node = this.root, depth = 0, maxDepth = Infinity) {
        const lines = [];
        const stack = [{ node, depth }];
        while (stack.length > 0) {
            const { node: cur, depth: d } = stack.pop();
            if (d > maxDepth) continue;

            if (cur !== this.root) {
                const indent  = '  '.repeat(d - 1);
                const retSeq  = cur.returnSeq ? `→${cur.returnSeq}` : '';
                const result  = cur.result !== undefined ? ` =${JSON.stringify(cur.result)}` : '';
                lines.push(`${indent}${cur.fn}() [L${cur.line}] [${cur.callSeq}${retSeq}]${result}`);
            }

            for (let i = cur.children.length - 1; i >= 0; i--) {
                stack.push({ node: cur.children[i], depth: d + 1 });
            }
        }
        return lines;
    }

    getSummary() {
        const fnCounts = new Map();
        const fnDepths = new Map();

        for (const node of this.allNodes) {
            const fn = node.fn;
            fnCounts.set(fn, (fnCounts.get(fn) || 0) + 1);

            let depth = 0;
            let p = node.parent;
            while (p && p !== this.root) {
                depth++;
                p = p.parent;
            }
            fnDepths.set(fn, Math.max(fnDepths.get(fn) || 0, depth));
        }

        return {
            totalCalls: this.allNodes.length,
            uniqueFns: fnCounts.size,
            topFns: [...fnCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([fn, count]) => ({ fn, count, maxDepth: fnDepths.get(fn) })),
        };
    }
}

// ── 方案 B：流式构建器（--stream） ────────────────────────────────────────
//
// 策略：维护一个调用栈（callStack），而不是完整树。
// 当栈深度从 1→0（即顶层调用配对完成）时，立即序列化该顶层节点并摘除引用，
// 从而让 GC 及时回收。
//
// 注意：--stream 模式只输出 NDJSON（每行一个完整顶层调用的 JSON），
// 不支持 --depth 文本树格式（因为每个顶层调用单独输出）。
//

class StreamingCallTreeBuilder {
    /**
     * @param {(node: CallNode) => void} onTopLevelComplete  顶层调用完成时的回调
     */
    constructor(onTopLevelComplete) {
        this._onComplete = onTopLevelComplete;
        this._stack = [];           // 当前调用栈（CallNode[]）
        this._pendingByIid = new Map();

        // 统计（不依赖全量节点保留）
        this._totalCalls = 0;
        this._fnCounts = new Map();
        this._fnMaxDepth = new Map();
    }

    get totalCalls() { return this._totalCalls; }
    get fnCounts() { return this._fnCounts; }
    get fnMaxDepth() { return this._fnMaxDepth; }

    process(record) {
        if (record.type === 'CALL_PRE') {
            const node = new CallNode(
                record.fn ?? '(anonymous)',
                record.line ?? 0,
                record.seq
            );

            // 挂到父节点（栈顶）或作为顶层根
            if (this._stack.length > 0) {
                const parent = this._stack[this._stack.length - 1];
                parent.addChild(node);
            }

            this._stack.push(node);
            this._totalCalls++;

            // 统计
            const fn = node.fn;
            this._fnCounts.set(fn, (this._fnCounts.get(fn) || 0) + 1);
            const depth = this._stack.length - 1;
            this._fnMaxDepth.set(fn, Math.max(this._fnMaxDepth.get(fn) || 0, depth));

            if (record.iid != null) {
                this._pendingByIid.set(record.iid, node);
            }
        } else if (record.type === 'CALL') {
            if (this._stack.length === 0) return;

            // 精确匹配
            let targetNode = null;
            if (record.iid != null && this._pendingByIid.has(record.iid)) {
                targetNode = this._pendingByIid.get(record.iid);
                this._pendingByIid.delete(record.iid);
            }

            // 找到目标节点在栈中的位置，处理所有中间未关闭帧
            if (targetNode) {
                const idx = this._stack.lastIndexOf(targetNode);
                if (idx >= 0) {
                    // 关闭 idx 到栈顶之间的所有帧（未正常返回的嵌套调用）
                    for (let i = this._stack.length - 1; i > idx; i--) {
                        this._stack[i].returnSeq = record.seq;
                    }
                    // 关闭目标帧
                    targetNode.returnSeq = record.seq;
                    targetNode.result = record.result;
                    this._stack.length = idx; // 弹出 idx 及以上所有帧
                } else {
                    // 找不到，按栈顶处理
                    const top = this._stack.pop();
                    top.returnSeq = record.seq;
                    if (record.result !== undefined) top.result = record.result;
                }
            } else {
                const top = this._stack.pop();
                top.returnSeq = record.seq;
                if (record.result !== undefined) top.result = record.result;
            }

            // 栈空 → 顶层调用完成，触发回调并释放引用
            if (this._stack.length === 0 && targetNode) {
                // targetNode 就是顶层根（idx === 0）
                const root = targetNode;
                this._onComplete(root);
                // 断开 parent 引用，让 GC 回收整棵子树
                root.parent = null;
            } else if (this._stack.length === 0) {
                // 非精确匹配路径，刚弹出的就是顶层
                // （由于我们已经 pop 了，需要从 _onComplete 参数的角度重新拿）
                // 这里通过记录来处理
            }
        }
    }

    getSummary() {
        return {
            totalCalls: this._totalCalls,
            uniqueFns: this._fnCounts.size,
            topFns: [...this._fnCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([fn, count]) => ({ fn, count, maxDepth: this._fnMaxDepth.get(fn) })),
        };
    }
}

// ── 主程序 ────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-call-tree.mjs — 重建调用树

用法：
  node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs
  node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --depth 5
  node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --json
  node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --max-nodes 10000
  node tools/trace-parse.mjs trace.bin | node tools/trace-call-tree.mjs --stream

输入格式：trace-parse.mjs 输出的 NDJSON（JTB1 事件类型）

选项：
  --depth N       限制显示深度（默认无限制）
  --json          输出 JSON 格式（方案 A，全树序列化）
  --summary       只显示汇总统计
  --max-nodes N   方案 A：建树节点上限（默认 50000，0 = 不限），超限后只统计不建树
  --stream        方案 B：流式输出 NDJSON，每个顶层调用配对完成后立即输出并释放内存
  --help          显示帮助信息

内存控制说明：
  默认模式（方案 A）：全量建树，超过 --max-nodes 后停止建树，只维护统计信息，
                       输出结束时打印警告说明有多少调用被截断。
  --stream（方案 B）：流式模式，内存恒定 O(最大调用深度)，输出为 NDJSON，
                       每行是一个完整的顶层调用 JSON 对象，适合超大 trace 文件。
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    const depthIdx = args.indexOf('--depth');
    const maxDepth = depthIdx >= 0 ? parseInt(args[depthIdx + 1] || '5', 10) : Infinity;
    const jsonOut = args.includes('--json');
    const summaryOnly = args.includes('--summary');
    const streamMode = args.includes('--stream');

    const maxNodesIdx = args.indexOf('--max-nodes');
    const maxNodes = maxNodesIdx >= 0
        ? parseInt(args[maxNodesIdx + 1] || '50000', 10)
        : 50000;

    // 输入源
    const inputPath = args.find(a => !a.startsWith('--') && isNaN(parseInt(a, 10)));
    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    // ── 方案 B：流式模式 ──
    if (streamMode) {
        let topLevelCount = 0;

        const builder = new StreamingCallTreeBuilder((rootNode) => {
            // 每个顶层调用完成后立即输出一行 NDJSON
            process.stdout.write(JSON.stringify(rootNode.toJSON()) + '\n');
            topLevelCount++;
            // 摘除引用，帮助 GC
            rootNode.children = [];
        });

        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                builder.process(JSON.parse(trimmed));
            } catch {
                // 跳过无效 JSON
            }
        }

        // 收尾：如果栈不为空（trace 提前截断），输出剩余帧
        // （内部栈对外不直接可访问，通过 getSummary 只输出统计）
        const summary = builder.getSummary();
        process.stderr.write(
            `\n# [stream] 顶层调用: ${topLevelCount}, 总调用: ${summary.totalCalls}, 独立函数: ${summary.uniqueFns}\n`
        );
        return;
    }

    // ── 方案 A：带上限的全量建树 ──
    const builder = new CallTreeBuilder(maxNodes);

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            builder.process(JSON.parse(trimmed));
        } catch {
            // 跳过无效 JSON
        }
    }

    builder.computeStats();

    // 超限警告（输出到 stderr，不污染 stdout）
    if (builder.limitReached) {
        process.stderr.write(
            `\n⚠️  [max-nodes] 建树节点数已达上限 ${maxNodes}，` +
            `后续 ${builder.skippedCalls} 次调用未建树（仅统计已建部分）。\n` +
            `   使用 --max-nodes 0 取消限制，或 --stream 改用流式模式。\n\n`
        );
    }

    if (jsonOut) {
        console.log(JSON.stringify(builder.root.toJSON(), null, 2));
        return;
    }

    const summary = builder.getSummary();

    console.log(`\n# 调用树统计`);
    console.log(`# 总调用: ${summary.totalCalls}, 独立函数: ${summary.uniqueFns}\n`);

    if (summaryOnly) {
        console.log('高频调用函数:');
        console.log('函数名            | 调用次数 | 最大深度');
        console.log('------------------|----------|----------');
        for (const { fn, count, maxDepth: d } of summary.topFns) {
            console.log(
                fn.slice(0, 18).padEnd(18) + ' | ' +
                String(count).padStart(8) + ' | ' +
                String(d).padStart(8)
            );
        }
        return;
    }

    console.log('调用树:');
    const treeLines = builder.formatTree(builder.root, 0, maxDepth);
    for (const l of treeLines) {
        console.log(l);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
