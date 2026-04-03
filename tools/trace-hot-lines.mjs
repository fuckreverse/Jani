#!/usr/bin/env node
/**
 * trace-hot-lines.mjs — 热点代码行统计
 *
 * 用法：
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-hot-lines.mjs
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-hot-lines.mjs --top 20
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-hot-lines.mjs --by-type
 *   node tools/trace-hot-lines.mjs --help
 *
 * 输入格式：trace-decode.mjs 输出的 NDJSON（JTB1 事件类型）
 *   事件类型：CALL_PRE, CALL, FUNCTION_ENTER, FUNCTION_EXIT,
 *             END_EXPR, SCRIPT_ENTER, SCRIPT_EXIT, KEY_EVENT 等
 *
 * 输出：
 *   热点行统计表格（行号、命中次数、类型分布）
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 统计器 ─────────────────────────────────────────────────────────────

class LineStats {
    constructor() {
        // line -> { count, types: { CALL_PRE: N, END_EXPR: N, ... } }
        this.lines = new Map();
        this.total = 0;
    }

    add(record) {
        const line = record.line;
        if (line === undefined) return;

        this.total++;

        if (!this.lines.has(line)) {
            this.lines.set(line, { count: 0, types: {} });
        }

        const stats = this.lines.get(line);
        stats.count++;
        stats.types[record.type] = (stats.types[record.type] || 0) + 1;
    }

    getTop(n = 10) {
        return [...this.lines.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, n);
    }
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-hot-lines.mjs — 热点代码行统计

用法：
  node tools/trace-decode.mjs trace.bin | node tools/trace-hot-lines.mjs
  node tools/trace-decode.mjs trace.bin | node tools/trace-hot-lines.mjs --top 20
  node tools/trace-decode.mjs trace.bin | node tools/trace-hot-lines.mjs --by-type

输入格式：trace-decode.mjs 输出的 NDJSON（JTB1 事件类型）

选项：
  --top N       显示前 N 个热点行（默认 10）
  --by-type     按事件类型分组显示
  --json        输出 JSON 格式
  --help        显示帮助信息
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    const topNIdx = args.indexOf('--top');
    const topN = topNIdx >= 0 ? parseInt(args[topNIdx + 1] || '10', 10) : 10;
    const byType = args.includes('--by-type');
    const jsonOut = args.includes('--json');

    // 输入源
    const inputPath = args.find(a => !a.startsWith('--') && isNaN(parseInt(a, 10)));
    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    const stats = new LineStats();

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const record = JSON.parse(trimmed);
            stats.add(record);
        } catch {
            // 跳过无效 JSON
        }
    }

    if (jsonOut) {
        console.log(JSON.stringify({
            total: stats.total,
            uniqueLines: stats.lines.size,
            hotLines: stats.getTop(topN).map(([line, data]) => ({
                line,
                count: data.count,
                types: data.types,
            })),
        }, null, 2));
        return;
    }

    // 表格输出
    const hotLines = stats.getTop(topN);

    console.log(`\n# 热点代码行统计`);
    console.log(`# 总事件: ${stats.total}, 涉及行数: ${stats.lines.size}\n`);

    if (byType) {
        console.log('行号    | 次数    | 类型分布');
        console.log('--------|---------|---------');
    } else {
        console.log('行号    | 次数    | 占比');
        console.log('--------|---------|-------');
    }

    for (const [line, data] of hotLines) {
        const pct = ((data.count / stats.total) * 100).toFixed(1);

        if (byType) {
            const typeStr = Object.entries(data.types)
                .map(([t, c]) => `${t}:${c}`)
                .join(', ');
            console.log(
                String(line).padStart(7) + ' | ' +
                String(data.count).padStart(7) + ' | ' +
                typeStr
            );
        } else {
            console.log(
                String(line).padStart(7) + ' | ' +
                String(data.count).padStart(7) + ' | ' +
                pct + '%'
            );
        }
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
