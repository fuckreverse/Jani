#!/usr/bin/env node
/**
 * trace-filter.mjs — 按条件过滤结构化 trace 数据
 *
 * 用法：
 *   cat parsed.ndjson | node tools/trace-filter.mjs --type call
 *   cat parsed.ndjson | node tools/trace-filter.mjs --seq 100-200
 *   cat parsed.ndjson | node tools/trace-filter.mjs --line 10
 *   cat parsed.ndjson | node tools/trace-filter.mjs --fn fromCharCode
 *   cat parsed.ndjson | node tools/trace-filter.mjs --help
 *
 * 过滤条件（可组合）：
 *   --type TYPE     事件类型：call, return, expr, script_enter, script_exit
 *   --seq RANGE     seq 范围，如 100-200 或 100+
 *   --line N        只保留指定行号
 *   --fn PATTERN    函数名匹配（支持 * 通配符）
 *   --has-var NAME  只保留涉及指定变量的行
 *   --has-call      只保留包含函数调用的行
 *   --no-internal   过滤掉内部变量（以 _ 开头或过长的混淆变量名）
 *
 * 输出：
 *   过滤后的 NDJSON 行
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
 * 检查是否涉及指定变量
 */
function hasVar(record, varName) {
    const kv = record.kv || {};
    if (varName in kv) return true;
    if (record.w && varName in record.w) return true;
    if (record.r && varName in record.r) return true;
    return false;
}

/**
 * 检查是否是内部/混淆变量名
 */
function isInternalVar(name) {
    // 单字母或短变量名
    if (name.length <= 2) return false;
    // 以 _ 开头
    if (name.startsWith('_')) return true;
    // 过长的混淆变量名（如 aB, cD 这种模式重复）
    if (/^[a-z][A-Z]([a-z][A-Z])+$/.test(name)) return true;
    return false;
}

/**
 * 过滤记录中的内部变量
 */
function filterInternalVars(record) {
    const newRecord = { ...record };

    if (newRecord.kv) {
        const newKv = {};
        for (const [k, v] of Object.entries(newRecord.kv)) {
            if (!isInternalVar(k)) {
                newKv[k] = v;
            }
        }
        if (Object.keys(newKv).length > 0) {
            newRecord.kv = newKv;
        } else {
            delete newRecord.kv;
        }
    }

    if (newRecord.w) {
        const newW = {};
        for (const [k, v] of Object.entries(newRecord.w)) {
            if (!isInternalVar(k)) {
                newW[k] = v;
            }
        }
        if (Object.keys(newW).length > 0) {
            newRecord.w = newW;
        } else {
            delete newRecord.w;
        }
    }

    if (newRecord.r) {
        const newR = {};
        for (const [k, v] of Object.entries(newRecord.r)) {
            if (!isInternalVar(k)) {
                newR[k] = v;
            }
        }
        if (Object.keys(newR).length > 0) {
            newRecord.r = newR;
        } else {
            delete newRecord.r;
        }
    }

    return newRecord;
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-filter.mjs — 按条件过滤结构化 trace 数据

用法：
  cat parsed.ndjson | node tools/trace-filter.mjs --type call
  cat parsed.ndjson | node tools/trace-filter.mjs --seq 100-200
  cat parsed.ndjson | node tools/trace-filter.mjs --fn fromCharCode

过滤条件（可组合）：
  --type TYPE       事件类型：call, return, expr, script_enter, script_exit
  --seq RANGE       seq 范围，如 100-200 或 100+
  --line N          只保留指定行号
  --fn PATTERN      函数名匹配（支持 * 通配符）
  --has-var NAME    只保留涉及指定变量的行
  --has-call        只保留包含函数调用的行
  --no-internal     过滤掉内部变量（以 _ 开头或过长的混淆变量名）
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

        if (filters.fn && !matchPattern(record.fn || '', filters.fn)) {
            match = false;
        }

        if (filters.hasVar && !hasVar(record, filters.hasVar)) {
            match = false;
        }

        if (filters.hasCall && record.type !== 'call') {
            match = false;
        }

        // 反转
        if (filters.invert) {
            match = !match;
        }

        if (match) {
            passed++;
            let outputRecord = record;

            // 过滤内部变量
            if (filters.noInternal) {
                outputRecord = filterInternalVars(record);
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
