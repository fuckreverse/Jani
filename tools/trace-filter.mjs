#!/usr/bin/env node
/**
 * trace-filter.mjs — 按条件过滤结构化 trace 数据
 *
 * 用法：
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --type CALL_PRE
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --seq 100-200
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --line 10
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --fn fromCharCode
 *   node tools/trace-filter.mjs --help
 *
 * 过滤条件（可组合）：
 *   --type TYPE     事件类型（JTB1 格式）：
 *                     CALL_PRE, CALL, FUNCTION_ENTER, FUNCTION_EXIT,
 *                     END_EXPR, SCRIPT_ENTER, SCRIPT_EXIT, KEY_EVENT,
 *                     WRITE_VAR, READ_VAR_FULL
 *   --seq RANGE     seq 范围，如 100-200 或 100+
 *   --line N        只保留指定行号
 *   --fn PATTERN    函数名匹配（支持 * 通配符，适用于 CALL_PRE/CALL）
 *   --has-var NAME  只保留涉及指定变量的行（适用于 END_EXPR/WRITE_VAR/READ_VAR_FULL）
 *   --has-call      只保留 CALL_PRE 事件
 *   --no-internal   过滤掉内部变量（以 _ 开头或过长的混淆变量名）
 *
 * 输出：
 *   过滤后的 NDJSON 行（可继续管道到 trace-render.mjs 等工具）
 */

import { createReadStream } from 'fs';
import { stdin as input, stdout as output } from 'process';
import { createInterface } from 'readline';

// ── 过滤器 ─────────────────────────────────────────────────────────────

/**
 * 解析范围字符串（如 "100-200" 或 "100+"）
 * @returns {{min: number, max: number | null}}
 */
function parseRange(str) {
    if (str.endsWith('+')) {
        return { min: parseInt(str, 10), max: null };
    }
    const parts = str.split('-');
    if (parts.length === 2) {
        return { min: parseInt(parts[0], 10), max: parseInt(parts[1], 10) };
    }
    return { min: parseInt(str, 10), max: parseInt(str, 10) };
}

/**
 * 匹配模式（支持 * 通配符）
 */
function matchPattern(str, pattern) {
    if (!pattern || pattern === '*') return true;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(str);
}

/**
 * 检查 END_EXPR / WRITE_VAR / READ_VAR_FULL 事件是否涉及指定变量
 */
function hasVar(record, varName) {
    // END_EXPR: writes=[{name,value}], reads=[{name,value}]
    if (record.type === 'END_EXPR') {
        if (record.writes?.some(w => w.name === varName)) return true;
        if (record.reads?.some(r => r.name === varName)) return true;
        return false;
    }
    // WRITE_VAR / READ_VAR_FULL: { name }
    if (record.type === 'WRITE_VAR' || record.type === 'READ_VAR_FULL') {
        return record.name === varName;
    }
    return false;
}

/**
 * 检查是否是内部/混淆变量名
 */
function isInternalVar(name) {
    // 单字母或短变量名不过滤
    if (name.length <= 2) return false;
    // 以 _ 开头
    if (name.startsWith('_')) return true;
    // 过长的混淆变量名（如 aB, cD 这种模式重复）
    if (/^[a-z][A-Z]([a-z][A-Z])+$/.test(name)) return true;
    return false;
}

/**
 * 过滤 END_EXPR 中的内部变量
 */
function filterInternalVarsFromRecord(record) {
    if (record.type !== 'END_EXPR') return record;

    const newRecord = { ...record };

    if (newRecord.writes?.length > 0) {
        newRecord.writes = newRecord.writes.filter(w => !isInternalVar(w.name));
    }
    if (newRecord.reads?.length > 0) {
        newRecord.reads = newRecord.reads.filter(r => !isInternalVar(r.name));
    }

    return newRecord;
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-filter.mjs — 按条件过滤结构化 trace 数据

用法：
  node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --type CALL_PRE
  node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --seq 100-200
  node tools/trace-decode.mjs trace.bin | node tools/trace-filter.mjs --fn fromCharCode

过滤条件（可组合）：
  --type TYPE       事件类型（JTB1 格式）：
                      CALL_PRE, CALL, FUNCTION_ENTER, FUNCTION_EXIT,
                      END_EXPR, SCRIPT_ENTER, SCRIPT_EXIT, KEY_EVENT,
                      WRITE_VAR, READ_VAR_FULL
  --seq RANGE       seq 范围，如 100-200 或 100+
  --line N          只保留指定行号
  --fn PATTERN      函数名匹配（支持 * 通配符，适用于 CALL_PRE/CALL）
  --has-var NAME    只保留涉及指定变量的行（适用于 END_EXPR/WRITE_VAR/READ_VAR_FULL）
  --has-call        只保留 CALL_PRE 事件（函数调用）
  --no-internal     过滤掉内部变量（以 _ 开头或混淆变量名）
  --invert          反转过滤条件

输出：
  过滤后的 NDJSON 行
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    // 解析过滤条件
    const filters = {
        type: null,
        seqRange: null,
        line: null,
        fn: null,
        hasVar: null,
        hasCall: false,
        noInternal: false,
        invert: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--type') {
            filters.type = args[++i];
        } else if (arg === '--seq') {
            filters.seqRange = parseRange(args[++i]);
        } else if (arg === '--line') {
            filters.line = parseInt(args[++i], 10);
        } else if (arg === '--fn') {
            filters.fn = args[++i];
        } else if (arg === '--has-var') {
            filters.hasVar = args[++i];
        } else if (arg === '--has-call') {
            filters.hasCall = true;
        } else if (arg === '--no-internal') {
            filters.noInternal = true;
        } else if (arg === '--invert') {
            filters.invert = true;
        }
    }

    // 输入源（排除选项参数）
    const inputPath = args.find((a, i) => {
        if (a.startsWith('--')) return false;
        // 检查前一个参数是否是选项
        const prev = args[i - 1];
        if (prev && (prev === '--type' || prev === '--seq' || prev === '--line' ||
                     prev === '--fn' || prev === '--has-var')) {
            return false;
        }
        return true;
    });

    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    let total = 0;
    let passed = 0;

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let record;
        try {
            record = JSON.parse(trimmed);
        } catch {
            continue;
        }

        total++;

        // 应用过滤条件
        let match = true;

        if (filters.type && record.type !== filters.type) {
            match = false;
        }

        if (filters.seqRange) {
            const { min, max } = filters.seqRange;
            if (record.seq < min || (max !== null && record.seq > max)) {
                match = false;
            }
        }

        if (filters.line !== null && record.line !== filters.line) {
            match = false;
        }

        // fn 匹配：适用于 CALL_PRE 和 CALL 事件的 fn 字段
        if (filters.fn && !matchPattern(record.fn || '', filters.fn)) {
            match = false;
        }

        if (filters.hasVar && !hasVar(record, filters.hasVar)) {
            match = false;
        }

        // --has-call 只保留 CALL_PRE
        if (filters.hasCall && record.type !== 'CALL_PRE') {
            match = false;
        }

        // 反转
        if (filters.invert) {
            match = !match;
        }

        if (match) {
            passed++;
            let outputRecord = record;

            // 过滤内部变量（仅对 END_EXPR 有效）
            if (filters.noInternal) {
                outputRecord = filterInternalVarsFromRecord(record);
            }

            console.log(JSON.stringify(outputRecord));
        }
    }

    console.error(`# 过滤完成: ${passed}/${total} 行通过`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
