#!/usr/bin/env node
/**
 * trace-range-extract.mjs — seq 区间快速提取
 *
 * 用法：
 *   cat parsed.ndjson | node tools/trace-range-extract.mjs 100-200
 *   cat parsed.ndjson | node tools/trace-range-extract.mjs 100+
 *   cat parsed.ndjson | node tools/trace-range-extract.mjs --before 50 --after 50 100
 *   cat parsed.ndjson | node tools/trace-range-extract.mjs --help
 *
 * 输出：
 *   指定范围内的 trace 行
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-range-extract.mjs — seq 区间快速提取

用法：
  cat parsed.ndjson | node tools/trace-range-extract.mjs 100-200
  cat parsed.ndjson | node tools/trace-range-extract.mjs 100+
  cat parsed.ndjson | node tools/trace-range-extract.mjs --before 50 --after 50 100

选项：
  --before N    提取目标 seq 之前 N 条记录
  --after N     提取目标 seq 之后 N 条记录
  --context N   等同于 --before N --after N
  --src         输出原始文本格式（非 JSON）
  --help        显示帮助信息

区间格式：
  100-200       seq 从 100 到 200
  100+          seq 从 100 到末尾
  100           只提取 seq=100
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    // 解析参数
    const beforeIdx = args.indexOf('--before');
    const before = beforeIdx >= 0 ? parseInt(args[beforeIdx + 1] || '10', 10) : 0;

    const afterIdx = args.indexOf('--after');
    const after = afterIdx >= 0 ? parseInt(args[afterIdx + 1] || '10', 10) : 0;

    const contextIdx = args.indexOf('--context');
    const context = contextIdx >= 0 ? parseInt(args[contextIdx + 1] || '10', 10) : 0;

    const srcFormat = args.includes('--src');

    // 获取区间参数（最后一个非选项参数）
    const nonOptionArgs = args.filter((a, i) => {
        if (a.startsWith('--')) return false;
        const prev = args[i - 1];
        if (prev && (prev === '--before' || prev === '--after' || prev === '--context')) {
            return false;
        }
        return true;
    });

    const rangeArg = nonOptionArgs[nonOptionArgs.length - 1];

    if (!rangeArg) {
        console.error('Error: 需要指定 seq 区间');
        printHelp();
        process.exit(1);
    }

    // 解析区间
    let minSeq, maxSeq;
    if (rangeArg.includes('+')) {
        minSeq = parseInt(rangeArg, 10);
        maxSeq = Infinity;
    } else if (rangeArg.includes('-')) {
        const [min, max] = rangeArg.split('-');
        minSeq = parseInt(min, 10);
        maxSeq = parseInt(max, 10);
    } else {
        // 单个 seq，结合 context
        const targetSeq = parseInt(rangeArg, 10);
        if (context > 0) {
            minSeq = targetSeq - context;
            maxSeq = targetSeq + context;
        } else {
            minSeq = targetSeq - before;
            maxSeq = targetSeq + after;
        }
    }

    // 输入源
    const inputPath = args.find(a => !a.startsWith('--') && a !== rangeArg && isNaN(parseInt(a, 10)));

    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    let extracted = 0;
    let total = 0;

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        total++;

        try {
            const record = JSON.parse(trimmed);
            const seq = record.seq;

            if (seq !== undefined && seq >= minSeq && seq <= maxSeq) {
                extracted++;
                if (srcFormat) {
                    // 还原为简化的文本格式
                    const lineNum = record.line || '?';
                    const col = record.col || '?';
                    let content;

                    switch (record.type) {
                        case 'call':
                            content = `CALL ${record.fn}(${record.args} args)`;
                            break;
                        case 'return':
                            content = `RETN ${record.fn} ; =${record.result ?? '?'}`;
                            break;
                        case 'script_enter':
                            content = `▶ script: ${record.file}`;
                            break;
                        case 'script_exit':
                            content = '◀ script end';
                            break;
                        default:
                            content = record.src || JSON.stringify(record.kv || {});
                    }

                    console.log(`[${String(seq).padStart(6)}] [${String(lineNum).padStart(5)}:${String(col).padStart(3)}] ${content}`);
                } else {
                    console.log(trimmed);
                }
            }
        } catch {
            // 跳过无效 JSON
        }
    }

    console.error(`# 提取完成: ${extracted}/${total} 条记录 (seq ${minSeq}-${maxSeq === Infinity ? '∞' : maxSeq})`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
