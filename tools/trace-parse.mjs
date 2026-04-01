#!/usr/bin/env node
/**
 * trace-parse.mjs — 将文本 trace 转换为结构化 NDJSON
 *
 * 用法：
 *   cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson
 *   node tools/trace-parse.mjs trace.ndjson > parsed.ndjson
 *   node tools/trace-parse.mjs --help
 *
 * 输入格式支持：
 *   1. 原始 JSON 行（直接透传）
 *   2. 文本格式 trace 行：
 *      - [  123] [  10:5] CALL foo(2 args) ; this=..., arg0=...
 *      - [  124] [  10:5] RETN foo ; =42
 *      - [  125] [  10:5] x = 1 + 2 ; x=3
 *      - [    1] ▶ script: /path/to/file.js
 *      - [  999] ◀ script end
 *
 * 输出格式（每行一个 JSON 对象）：
 *   {"seq":123,"line":10,"col":5,"type":"call","fn":"foo","args":2,"kv":{...}}
 *   {"seq":124,"line":10,"col":5,"type":"return","fn":"foo","result":42}
 *   {"seq":125,"line":10,"col":5,"type":"expr","src":"x = 1 + 2","w":{"x":3}}
 *   {"seq":1,"type":"script_enter","file":"/path/to/file.js"}
 *   {"seq":999,"type":"script_exit"}
 *
 * 选项：
 *   --strict    遇到无法解析的行时报错（默认跳过并警告）
 *   --raw       输出原始解析结果（包含更多细节）
 *   --compact   紧凑输出（无缩进）
 */

import { createReadStream } from 'fs';
import { stdin as input, stdout as output } from 'process';
import { URL } from 'url';
import { createInterface } from 'readline';

// ── 解析器 ─────────────────────────────────────────────────────────────

/**
 * 解析单行 trace 文本
 * @param {string} line
 * @returns {object|null} 解析结果，null 表示无法解析
 */
function parseLine(line) {
    if (!line || !line.trim()) return null;

    // 尝试直接解析为 JSON（已结构化的行）
    if (line.startsWith('{')) {
        try {
            return JSON.parse(line);
        } catch {
            // 不是有效 JSON，继续尝试文本解析
        }
    }

    // 统一格式：[seq] [line:col] 内容
    // 或特殊格式：[seq] ▶ script: ...  /  [seq] ◀ script end

    // 匹配 seq
    const seqMatch = line.match(/^\[\s*(\d+)\]\s*/);
    if (!seqMatch) return null;

    const seq = parseInt(seqMatch[1], 10);
    const rest = line.slice(seqMatch[0].length);

    // 脚本进入/退出
    if (rest.startsWith('▶ script:')) {
        const file = rest.slice('▶ script:'.length).trim();
        return { seq, type: 'script_enter', file };
    }
    if (rest.startsWith('◀ script')) {
        const isException = rest.includes('exception:');
        return { seq, type: 'script_exit', exception: isException };
    }

    // 匹配位置 [line:col]
    const posMatch = rest.match(/^\[\s*(\d+):(\d+)\]\s*/);
    if (!posMatch) {
        // 无位置信息的行（可能是 key 行）
        return { seq, type: 'unknown', raw: rest };
    }

    const lineNum = parseInt(posMatch[1], 10);
    const colNum = parseInt(posMatch[2], 10);
    const content = rest.slice(posMatch[0].length);

    // 解析内容
    return parseContent(seq, lineNum, colNum, content);
}

/**
 * 解析 trace 内容部分
 */
function parseContent(seq, line, col, content) {
    // CALL .method(N args) ; kv          ← 旧格式（分号分隔）
    // CALL funcName(N args) {"a":[...]}  ← 新格式（直接 JSON）
    // CALL new ClassName(N args) ; kv
    // CALL (anonymous)(N args) ; kv
    // 注意：CALL 可能出现在文本开头（原始 FlatFormatter 格式）
    const callMatch = content.match(
        /^CALL\s+(?:(new)\s+)?(?:\.)?([^\s(]+|\(anonymous\))\((\d+)\s*args\)\s*(.*)?$/
    );
    if (callMatch) {
        const [, isNew, fn, argsStr, tail] = callMatch;
        const tailTrimmed = (tail ?? '').trim();
        let kv = {};
        // 新格式：tail 直接是 JSON 对象
        if (tailTrimmed.startsWith('{')) {
            try { kv = JSON.parse(tailTrimmed); } catch { kv = {}; }
        } else if (tailTrimmed.startsWith(';')) {
            // 旧格式：; key=val, key=val
            kv = parseKv(tailTrimmed.slice(1).trim());
        }
        return {
            seq,
            line,
            col,
            type: 'call',
            fn: fn.replace(/^\(|\)$/g, ''), // 去掉 (anonymous) 的括号
            isConstructor: !!isNew,
            args: parseInt(argsStr, 10),
            kv,
        };
    }

    // RETN name ; =result
    // RETN name {"v":result}
    const retMatch = content.match(/^RETN\s+(\S+)\s+(.+)$/);
    if (retMatch) {
        const [, fn, rest] = retMatch;
        // 尝试解析 JSON 格式的 kv
        if (rest.startsWith('{')) {
            try {
                const kvObj = JSON.parse(rest);
                return { seq, line, col, type: 'return', fn, result: kvObj.v, kv: kvObj };
            } catch {}
        }
        // 传统格式 ; =result
        const resultMatch = rest.match(/^;\s*=(.+)$/);
        if (resultMatch) {
            return { seq, line, col, type: 'return', fn, result: parseValue(resultMatch[1]) };
        }
        return { seq, line, col, type: 'return', fn, raw: rest };
    }

    // 普通表达式语句：srcText ; kv  或  srcText {"w":...,"r":...}
    // 分隔符可能是 ; 或直接是 JSON 对象
    const jsonMatch = content.match(/^(.+?)\s+(\{.+\})\s*$/);
    if (jsonMatch) {
        const [, srcText, jsonStr] = jsonMatch;
        try {
            const kvObj = JSON.parse(jsonStr);
            return {
                seq,
                line,
                col,
                type: 'expr',
                src: srcText.trim(),
                w: kvObj.w,
                r: kvObj.r,
                f: kvObj.f,
                kv: kvObj,
            };
        } catch {}
    }

    // 传统格式：srcText ; kv
    const semiIdx = content.lastIndexOf(';');
    if (semiIdx > 0) {
        const srcText = content.slice(0, semiIdx).trim();
        const kvStr = content.slice(semiIdx + 1).trim();
        const kv = parseKv(kvStr);
        return { seq, line, col, type: 'expr', src: srcText, kv };
    }

    // 无 kv 的表达式
    const srcText = content.trim();
    if (srcText) {
        return { seq, line, col, type: 'expr', src: srcText };
    }

    return { seq, line, col, type: 'unknown', raw: content };
}

/**
 * 解析传统 kv 字符串（逗号分隔的 key=value）
 * @param {string} kvStr
 * @returns {object}
 */
function parseKv(kvStr) {
    if (!kvStr) return {};

    const result = {};
    // 按逗号分割，但要注意值中可能包含逗号（如数组）
    // 使用简单的状态机解析
    let key = '';
    let value = '';
    let inValue = false;
    let depth = 0; // 嵌套深度（括号、花括号）
    let inString = false;
    let escape = false;

    for (let i = 0; i < kvStr.length; i++) {
        const c = kvStr[i];

        if (!inValue) {
            if (c === '=') {
                inValue = true;
                continue;
            }
            key += c;
        } else {
            if (escape) {
                value += c;
                escape = false;
                continue;
            }

            if (c === '\\') {
                escape = true;
                continue;
            }

            if (c === '"' || c === "'") {
                inString = !inString;
                value += c;
                continue;
            }

            if (!inString) {
                if (c === '[' || c === '{' || c === '(') depth++;
                if (c === ']' || c === '}' || c === ')') depth--;

                if (c === ',' && depth === 0) {
                    result[key.trim()] = parseValue(value.trim());
                    key = '';
                    value = '';
                    inValue = false;
                    continue;
                }
            }

            value += c;
        }
    }

    // 最后一个 kv 对
    if (key.trim()) {
        result[key.trim()] = parseValue(value.trim());
    }

    return result;
}

/**
 * 解析值字符串为 JS 值
 */
function parseValue(str) {
    if (!str) return undefined;

    // 尝试 JSON 解析
    try {
        return JSON.parse(str);
    } catch {}

    // 特殊值
    if (str === 'undefined') return undefined;
    if (str === 'null') return null;
    if (str === 'true') return true;
    if (str === 'false') return false;
    if (str === 'NaN') return NaN;
    if (str === 'Infinity') return Infinity;
    if (str === '-Infinity') return -Infinity;

    // 数字
    if (/^-?\d+(\.\d+)?$/.test(str)) {
        return parseFloat(str);
    }

    // 字符串（去掉引号）
    if ((str.startsWith('"') && str.endsWith('"')) ||
        (str.startsWith("'") && str.endsWith("'"))) {
        return str.slice(1, -1);
    }

    // 函数
    if (str.startsWith('[Function')) {
        return { __type: 'function', name: str.match(/\s+(\w+)?\]?$/)?.[1] || 'anonymous' };
    }

    // 数组简写 […N]
    if (str.startsWith('[…')) {
        const len = parseInt(str.match(/\d+/)?.[0] || '0', 10);
        return { __type: 'array', length: len, preview: str };
    }

    // 对象简写 {…}
    if (str === '{…}' || str === '{}') {
        return { __type: 'object' };
    }

    // 其他情况保持字符串
    return str;
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-parse.mjs — 将文本 trace 转换为结构化 NDJSON

用法：
  cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson
  node tools/trace-parse.mjs trace.ndjson > parsed.ndjson

选项：
  --strict    遇到无法解析的行时报错（默认跳过并警告）
  --raw       输出原始解析结果（包含更多细节）
  --compact   紧凑输出（无缩进）
  --help      显示帮助信息
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    const strict = args.includes('--strict');
    const raw = args.includes('--raw');
    const compact = args.includes('--compact');

    // 输入源
    let inputPath = args.find(a => !a.startsWith('--'));

    // 如果输入是文件，检查是否存在
    if (inputPath) {
        const fs = await import('fs');
        try {
            await fs.promises.access(inputPath);
        } catch {
            console.error(`Error: 文件不存在: ${inputPath}`);
            process.exit(1);
        }
    }

    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    let lineNum = 0;
    let parsed = 0;
    let skipped = 0;

    for await (const line of rl) {
        lineNum++;
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const result = parseLine(trimmed);
            if (result) {
                parsed++;
                if (raw) {
                    console.log(JSON.stringify(result));
                } else {
                    // 标准化输出格式
                    const out = normalizeOutput(result);
                    console.log(compact ? JSON.stringify(out) : JSON.stringify(out, null, 2));
                }
            } else {
                skipped++;
                if (strict) {
                    console.error(`Error: 无法解析第 ${lineNum} 行: ${trimmed}`);
                    process.exit(1);
                }
            }
        } catch (err) {
            skipped++;
            if (strict) {
                console.error(`Error: 解析第 ${lineNum} 行时出错: ${err.message}`);
                process.exit(1);
            }
        }
    }

    // 输出统计信息到 stderr
    console.error(`# 解析完成: ${parsed} 行, 跳过 ${skipped} 行`);
}

/**
 * 标准化输出格式（简化常用字段）
 */
function normalizeOutput(result) {
    // 如果已经是 JSON 格式的 trace 行，直接返回
    if (result.type === 'key' || result.type === 'trace') {
        return result;
    }

    return result;
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
