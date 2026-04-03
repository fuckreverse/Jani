#!/usr/bin/env node
/**
 * trace-call-tree.mjs — 重建调用树
 *
 * 用法：
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs --depth 5
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs --json
 *   node tools/trace-call-tree.mjs --help
 *
 * 输入格式：trace-decode.mjs 输出的 NDJSON（JTB1 事件类型）
 *   - CALL_PRE 事件：函数调用开始（含 fn 字段）
 *   - CALL 事件：函数调用结束（含 fn、result 字段）
 *
 * 输出：
 *   树形调用图（带缩进和统计）
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 调用树构建器 ─────────────────────────────────────────────────────────

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

class CallTreeBuilder {
    constructor() {
        this.root = new CallNode('<root>', 0, 0);
        this.current = this.root;
        this.allNodes = [];
        // iid → pending CallNode（用于匹配 CALL_PRE 和 CALL 配对）
        this._pendingByIid = new Map();
    }

    process(record) {
        // CALL_PRE：函数调用开始
        if (record.type === 'CALL_PRE') {
            const node = new CallNode(
                record.fn ?? '(anonymous)',
                record.line ?? 0,
                record.seq
            );
            this.current.addChild(node);
            this.current = node;
            this.allNodes.push(node);
            // 记录 iid 用于后续 CALL 配对
            if (record.iid != null) {
                this._pendingByIid.set(record.iid, node);
            }
        }
        // CALL：函数调用结束（返回值）
        else if (record.type === 'CALL') {
            // 尝试通过 iid 精确匹配 CALL_PRE
            let node = null;
            if (record.iid != null && this._pendingByIid.has(record.iid)) {
                node = this._pendingByIid.get(record.iid);
                this._pendingByIid.delete(record.iid);
            }

            if (node && this.current !== this.root) {
                // 通过堆栈找到对应的 CallNode
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
                    // 未找到匹配节点，退出当前帧
                    if (this.current !== this.root) {
                        this.current.returnSeq = record.seq;
                        this.current = this.current.parent || this.root;
                    }
                }
            } else if (this.current !== this.root) {
                // 无法精确匹配，按深度退出
                this.current.returnSeq = record.seq;
                if (record.result !== undefined) {
                    this.current.result = record.result;
                }
                this.current = this.current.parent || this.root;
            }
        }
    }

    computeStats() {
        // 迭代版（避免深递归爆栈）
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
        // 迭代版（避免深递归爆栈）
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

            // 逆序压栈，保证先进先出顺序
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

            // 计算深度
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

// ── 主程序 ─────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-call-tree.mjs — 重建调用树

用法：
  node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs
  node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs --depth 5
  node tools/trace-decode.mjs trace.bin | node tools/trace-call-tree.mjs --json

输入格式：trace-decode.mjs 输出的 NDJSON（JTB1 事件类型）

选项：
  --depth N     限制显示深度（默认无限制）
  --json        输出 JSON 格式
  --summary     只显示汇总统计
  --help        显示帮助信息
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

    // 输入源
    const inputPath = args.find(a => !a.startsWith('--') && isNaN(parseInt(a, 10)));
    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    const builder = new CallTreeBuilder();

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const record = JSON.parse(trimmed);
            builder.process(record);
        } catch {
            // 跳过无效 JSON
        }
    }

    builder.computeStats();

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
