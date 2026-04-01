#!/usr/bin/env node
/**
 * trace-call-tree.mjs — 重建调用树
 *
 * 用法：
 *   cat parsed.ndjson | node tools/trace-call-tree.mjs
 *   cat parsed.ndjson | node tools/trace-call-tree.mjs --depth 5
 *   cat parsed.ndjson | node tools/trace-call-tree.mjs --json
 *   cat parsed.ndjson | node tools/trace-call-tree.mjs --help
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
            children: this.children.length > 0 ? this.children.map(c => c.toJSON()) : undefined,
        };
    }
}

class CallTreeBuilder {
    constructor() {
        this.root = new CallNode('<root>', 0, 0);
        this.current = this.root;
        this.allNodes = [];
    }

    process(record) {
        if (record.type === 'call') {
            const node = new CallNode(record.fn, record.line, record.seq);
            this.current.addChild(node);
            this.current = node;
            this.allNodes.push(node);
        } else if (record.type === 'return') {
            if (this.current !== this.root) {
                this.current.returnSeq = record.seq;
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
        // 栈帧：{ node, depth }；使用逆序入栈保证子节点按原顺序输出
        const stack = [{ node, depth }];
        while (stack.length > 0) {
            const { node: cur, depth: d } = stack.pop();
            if (d > maxDepth) continue;

            if (cur !== this.root) {
                const indent  = '  '.repeat(d - 1);
                const retSeq  = cur.returnSeq ? `→${cur.returnSeq}` : '';
                lines.push(`${indent}${cur.fn}() [L${cur.line}] [${cur.callSeq}${retSeq}]`);
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

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-call-tree.mjs — 重建调用树

用法：
  cat parsed.ndjson | node tools/trace-call-tree.mjs
  cat parsed.ndjson | node tools/trace-call-tree.mjs --depth 5
  cat parsed.ndjson | node tools/trace-call-tree.mjs --json

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
