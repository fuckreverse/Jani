#!/usr/bin/env node
/**
 * trace-var-timeline.mjs — 变量值时序追踪
 *
 * 用法：
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var x
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var x,y,z
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --all --limit 50
 *   node tools/trace-var-timeline.mjs --help
 *
 * 输入格式：trace-parse.mjs 输出的 NDJSON（JTB1 事件类型）
 *   - END_EXPR：写/读变量（writes=[{name,value}], reads=[{name,value,omitted?}], fields=[{base,offset,isWrite,value}]）
 *   - WRITE_VAR：单独写入变量（name, value）
 *   - READ_VAR_FULL：单独读取变量（name, value）
 *
 * 输出：
 *   变量值变化时序表（seq、行号、值）
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 变量追踪器 ─────────────────────────────────────────────────────────

class VarTimeline {
    constructor(targetVars = null, limit = 100) {
        this.targetVars = targetVars; // null 表示追踪所有
        this.limit = limit;
        this.changes = []; // [{ seq, line, var, value, type }]
    }

    shouldTrack(varName) {
        if (!this.targetVars) return true;
        return this.targetVars.has(varName);
    }

    process(record) {
        if (this.changes.length >= this.limit) return;

        const { seq, line } = record;

        // ── END_EXPR 事件（JTB1 格式）────────────────────────────────────
        if (record.type === 'END_EXPR') {
            // 处理写入（writes 数组）
            if (record.writes?.length > 0) {
                for (const w of record.writes) {
                    if (this.shouldTrack(w.name)) {
                        this.changes.push({
                            seq,
                            line,
                            var: w.name,
                            value: this.formatValue(w.value),
                            type: 'write',
                        });
                    }
                }
            }

            // 处理读取（reads 数组）
            if (record.reads?.length > 0) {
                for (const r of record.reads) {
                    if (this.shouldTrack(r.name)) {
                        this.changes.push({
                            seq,
                            line,
                            var: r.name,
                            value: r.omitted ? '<omitted>' : this.formatValue(r.value),
                            type: 'read',
                        });
                    }
                }
            }

            // 处理属性访问（fields 数组）
            if (record.fields?.length > 0) {
                for (const f of record.fields) {
                    const key = `${f.base}.${f.offset}`;
                    if (this.shouldTrack(key) || this.shouldTrack(f.offset)) {
                        this.changes.push({
                            seq,
                            line,
                            var: key,
                            value: this.formatValue(f.value),
                            type: f.isWrite ? 'field-write' : 'field-read',
                        });
                    }
                }
            }
            return;
        }

        // ── WRITE_VAR 事件 ───────────────────────────────────────────────
        if (record.type === 'WRITE_VAR') {
            if (this.shouldTrack(record.name)) {
                this.changes.push({
                    seq,
                    line,
                    var: record.name,
                    value: this.formatValue(record.value),
                    type: 'write',
                });
            }
            return;
        }

        // ── READ_VAR_FULL 事件 ──────────────────────────────────────────
        if (record.type === 'READ_VAR_FULL') {
            if (this.shouldTrack(record.name)) {
                this.changes.push({
                    seq,
                    line,
                    var: record.name,
                    value: this.formatValue(record.value),
                    type: 'read',
                });
            }
            return;
        }
    }

    formatValue(val) {
        if (val === undefined) return 'undefined';
        if (val === null) return 'null';
        if (typeof val === 'object') {
            if (val.__type === 'function') return `[Function ${val.name || 'anonymous'}]`;
            if (val.__type === 'array') return `[...${val.length}]`;
            if (val.__type === 'object') return '{...}';
            // 包含 [Function:xxx] 格式（来自二进制解码）
            return JSON.stringify(val);
        }
        if (typeof val === 'string' && val.startsWith('[Function:')) return val;
        return String(val);
    }

    getTimeline() {
        return this.changes;
    }

    groupByVar() {
        const groups = new Map();
        for (const change of this.changes) {
            if (!groups.has(change.var)) {
                groups.set(change.var, []);
            }
            groups.get(change.var).push(change);
        }
        return groups;
    }
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-var-timeline.mjs — 变量值时序追踪

用法：
  node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var x
  node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --var x,y,z
  node tools/trace-parse.mjs trace.bin | node tools/trace-var-timeline.mjs --all --limit 50

输入格式：trace-parse.mjs 输出的 NDJSON（JTB1 事件类型）

选项：
  --var NAMES   追踪指定变量（逗号分隔）
  --all         追踪所有变量
  --limit N     限制输出数量（默认 100）
  --writes      只显示写入
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

    // 解析参数
    const varIdx = args.indexOf('--var');
    const varNames = varIdx >= 0 ? args[varIdx + 1]?.split(',').map(s => s.trim()) : null;
    const trackAll = args.includes('--all');
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] || '100', 10) : 100;
    const writesOnly = args.includes('--writes');
    const jsonOut = args.includes('--json');

    const targetVars = trackAll ? null : new Set(varNames || []);

    // 输入源
    const inputPath = args.find(a => !a.startsWith('--') && isNaN(parseInt(a, 10)));
    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    const timeline = new VarTimeline(targetVars, limit);

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const record = JSON.parse(trimmed);
            timeline.process(record);
        } catch {
            // 跳过无效 JSON
        }
    }

    const changes = writesOnly
        ? timeline.getTimeline().filter(c => c.type.includes('write'))
        : timeline.getTimeline();

    if (jsonOut) {
        console.log(JSON.stringify(changes, null, 2));
        return;
    }

    if (!trackAll && varNames && varNames.length > 0) {
        console.log(`\n# 变量时序追踪: ${varNames.join(', ')}`);
    } else {
        console.log(`\n# 变量时序追踪（前 ${limit} 条）`);
    }
    console.log();

    if (changes.length === 0) {
        console.log('无匹配的变量变化记录');
        if (!trackAll && varNames) {
            console.log(`提示: 使用 --all 追踪所有变量，或检查变量名是否正确`);
        }
        return;
    }

    console.log('seq      | 行号    | 变量            | 类型        | 值');
    console.log('---------|---------|-----------------|-------------|------------------');

    for (const c of changes) {
        console.log(
            String(c.seq).padStart(7) + ' | ' +
            String(c.line || '-').padStart(7) + ' | ' +
            (c.var || '-').slice(0, 15).padEnd(15) + ' | ' +
            c.type.padEnd(11) + ' | ' +
            String(c.value).slice(0, 40)
        );
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
