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
 *      - [  123] [  10:5] CALL foo(2 args) {"a":[...]}
 *      - [  124] [  10:5] RETN foo {"v":42}
 *      - [  125] [  10:5] x = 1 + 2 {"w":{"x":3}}
 *      - [    1] ▶ script: /path/to/file.js
 *      - [  999] ◀ script end
 *
 * 输出格式（每行一个紧凑 JSON 对象）：
 *   {"seq":123,"line":10,"col":5,"type":"call","fn":"foo","args":2,"kv":{...}}
 *   {"seq":124,"line":10,"col":5,"type":"return","fn":"foo","result":42}
 *   {"seq":125,"line":10,"col":5,"type":"expr","src":"x = 1 + 2","w":{"x":3}}
 *   {"seq":1,"type":"script_enter","file":"/path/to/file.js"}
 *   {"seq":999,"type":"script_exit"}
 *
 * 选项：
 *   --strict    遇到无法解析的行时报错（默认跳过并警告）
 *   --raw       输出原始解析结果（包含更多细节）
 *   --compact   紧凑输出（默认即紧凑，保留此选项向后兼容）
 *   --pretty    格式化输出（带缩进，调试用）
 *   --workers N 并行 Worker 线程数（默认 auto = CPU 核心数，0 禁用多线程）
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';

// ── 快速手动解析器（热路径，不使用正则）──────────────────────────────────────

/**
 * 从字符串 pos 处开始跳过空格，返回新的位置
 */
function skipSpaces(s, pos) {
    while (pos < s.length && s.charCodeAt(pos) === 32) pos++;
    return pos;
}

/**
 * 从 pos 处开始读取连续数字，返回 { val, end }
 */
function readInt(s, pos) {
    let val = 0;
    const start = pos;
    while (pos < s.length) {
        const c = s.charCodeAt(pos);
        if (c < 48 || c > 57) break;
        val = val * 10 + (c - 48);
        pos++;
    }
    return pos > start ? { val, end: pos } : null;
}

/**
 * 找 expr 行末尾 JSON 后缀的起始位置（快速路径：lastIndexOf(' {')）
 */
function findJsonSuffix(s) {
    let end = s.length - 1;
    while (end >= 0 && s.charCodeAt(end) <= 32) end--;
    if (end < 0 || s.charCodeAt(end) !== 125 /* } */) return -1;
    const spaceIdx = s.lastIndexOf(' {');
    if (spaceIdx > 0) return spaceIdx + 1;
    return -1;
}

/**
 * 解析单行 trace 文本（手动解析，无正则热路径）
 */
function parseLine(line) {
    const len = line.length;
    if (len === 0) return null;

    // ── 已是 JSON 行 ──────────────────────────────────────────────────
    if (line.charCodeAt(0) === 123 /* { */) {
        try { return JSON.parse(line); } catch { /* fall through */ }
    }

    // ── 必须以 `[` 开头 ───────────────────────────────────────────────
    if (line.charCodeAt(0) !== 91 /* [ */) return null;

    // 解析 [seq]
    let pos = 1;
    pos = skipSpaces(line, pos);
    const seqRes = readInt(line, pos);
    if (!seqRes) return null;
    const seq = seqRes.val;
    pos = skipSpaces(line, seqRes.end);
    if (pos >= len || line.charCodeAt(pos) !== 93 /* ] */) return null;
    pos++;
    pos = skipSpaces(line, pos);

    // ── 脚本进入/退出 ─────────────────────────────────────────────────
    if (line.charCodeAt(pos) === 9654 /* ▶ */) {
        const scriptPrefix = '\u25B6 script:';
        if (line.startsWith(scriptPrefix, pos)) {
            return { seq, type: 'script_enter', file: line.slice(pos + scriptPrefix.length).trim() };
        }
        return null;
    }
    if (line.charCodeAt(pos) === 9668 /* ◀ */) {
        return { seq, type: 'script_exit', exception: line.indexOf('exception:', pos) >= 0 };
    }

    // ── 解析 [line:col] ───────────────────────────────────────────────
    if (pos >= len || line.charCodeAt(pos) !== 91 /* [ */) {
        return { seq, type: 'unknown', raw: line.slice(pos) };
    }
    pos++;
    pos = skipSpaces(line, pos);
    const lineRes = readInt(line, pos);
    if (!lineRes) return null;
    const lineNum = lineRes.val;
    pos = skipSpaces(line, lineRes.end);
    if (pos >= len || line.charCodeAt(pos) !== 58 /* : */) return null;
    pos++;
    pos = skipSpaces(line, pos);
    const colRes = readInt(line, pos);
    if (!colRes) return null;
    const colNum = colRes.val;
    pos = skipSpaces(line, colRes.end);
    if (pos >= len || line.charCodeAt(pos) !== 93 /* ] */) return null;
    pos++;
    pos = skipSpaces(line, pos);

    return parseContent(seq, lineNum, colNum, line.slice(pos));
}

/**
 * 解析 trace 内容部分
 */
function parseContent(seq, lineNum, colNum, content) {
    const clen = content.length;
    if (clen === 0) return null;

    const c0 = content.charCodeAt(0);

    // ── CALL ──────────────────────────────────────────────────────────
    if (c0 === 67 && content.charCodeAt(1) === 65 && content.charCodeAt(2) === 76 &&
        content.charCodeAt(3) === 76 && content.charCodeAt(4) === 32) {

        let pos = 5;
        let isNew = false;
        if (content.startsWith('new ', pos)) { isNew = true; pos += 4; }
        if (pos < clen && content.charCodeAt(pos) === 46) pos++;

        let fnEnd = pos;
        while (fnEnd < clen && content.charCodeAt(fnEnd) !== 40) fnEnd++;
        if (fnEnd >= clen) return { seq, line: lineNum, col: colNum, type: 'unknown', raw: content };
        let fn = content.slice(pos, fnEnd);

        if (fn === '' && content.charCodeAt(fnEnd) === 40) {
            const anonEnd = content.indexOf(')', fnEnd);
            if (anonEnd > fnEnd) { fn = content.slice(fnEnd + 1, anonEnd); fnEnd = anonEnd + 1; }
        }
        if (fn === 'anonymous' || fn === '') fn = 'anonymous';

        pos = fnEnd + 1; // skip `(`
        pos = skipSpaces(content, pos);
        const argsRes = readInt(content, pos);
        const args = argsRes ? argsRes.val : 0;
        if (argsRes) pos = argsRes.end;
        const rp = content.indexOf(')', pos);
        if (rp < 0) return { seq, line: lineNum, col: colNum, type: 'unknown', raw: content };
        pos = skipSpaces(content, rp + 1);

        let kv = {};
        if (pos < clen) {
            const tail = content.slice(pos);
            if (tail.charCodeAt(0) === 123) { try { kv = JSON.parse(tail); } catch { /* ignore */ } }
            else if (tail.charCodeAt(0) === 59) { kv = parseKv(tail.slice(1).trim()); }
        }
        return { seq, line: lineNum, col: colNum, type: 'call', fn, isConstructor: isNew, args, kv };
    }

    // ── RETN ──────────────────────────────────────────────────────────
    if (c0 === 82 && content.charCodeAt(1) === 69 && content.charCodeAt(2) === 84 &&
        content.charCodeAt(3) === 78 && content.charCodeAt(4) === 32) {

        let pos = 5;
        const nameStart = pos;
        while (pos < clen && content.charCodeAt(pos) !== 32) pos++;
        const fn = content.slice(nameStart, pos);
        pos = skipSpaces(content, pos);

        if (pos < clen) {
            const rest = content.slice(pos);
            if (rest.charCodeAt(0) === 123) {
                try {
                    const kvObj = JSON.parse(rest);
                    return { seq, line: lineNum, col: colNum, type: 'return', fn, result: kvObj.v, kv: kvObj };
                } catch { /* fall through */ }
            }
            if (rest.charCodeAt(0) === 59) {
                const eqIdx = rest.indexOf('=', 1);
                if (eqIdx >= 0) {
                    return { seq, line: lineNum, col: colNum, type: 'return', fn, result: parseValue(rest.slice(eqIdx + 1).trim()) };
                }
            }
            return { seq, line: lineNum, col: colNum, type: 'return', fn, raw: rest };
        }
        return { seq, line: lineNum, col: colNum, type: 'return', fn };
    }

    // ── expr ──────────────────────────────────────────────────────────
    const jsonPos = findJsonSuffix(content);
    if (jsonPos > 0) {
        const srcText = content.slice(0, jsonPos).trimEnd();
        try {
            const kvObj = JSON.parse(content.slice(jsonPos));
            const rec = { seq, line: lineNum, col: colNum, type: 'expr', src: srcText };
            if (kvObj.w) rec.w = kvObj.w;
            if (kvObj.r) rec.r = kvObj.r;
            if (kvObj.f) rec.f = kvObj.f;
            if (Object.keys(kvObj).length > 0) rec.kv = kvObj;
            return rec;
        } catch { /* fall through */ }
    }

    const semiIdx = content.lastIndexOf(';');
    if (semiIdx > 0) {
        return { seq, line: lineNum, col: colNum, type: 'expr', src: content.slice(0, semiIdx).trim(), kv: parseKv(content.slice(semiIdx + 1).trim()) };
    }

    const srcText = content.trim();
    if (srcText) return { seq, line: lineNum, col: colNum, type: 'expr', src: srcText };
    return null;
}

function parseKv(kvStr) {
    if (!kvStr) return {};
    const result = {};
    let key = '', value = '', inValue = false, depth = 0, inString = false, escape = false;
    for (let i = 0; i < kvStr.length; i++) {
        const c = kvStr[i];
        if (!inValue) {
            if (c === '=') { inValue = true; continue; }
            key += c;
        } else {
            if (escape) { value += c; escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"' || c === "'") { inString = !inString; value += c; continue; }
            if (!inString) {
                if (c === '[' || c === '{' || c === '(') depth++;
                if (c === ']' || c === '}' || c === ')') depth--;
                if (c === ',' && depth === 0) {
                    result[key.trim()] = parseValue(value.trim());
                    key = ''; value = ''; inValue = false;
                    continue;
                }
            }
            value += c;
        }
    }
    if (key.trim()) result[key.trim()] = parseValue(value.trim());
    return result;
}

function parseValue(str) {
    if (!str) return undefined;
    try { return JSON.parse(str); } catch {}
    if (str === 'undefined') return undefined;
    if (str === 'null') return null;
    if (str === 'true') return true;
    if (str === 'false') return false;
    if (str === 'NaN') return NaN;
    if (str === 'Infinity') return Infinity;
    if (str === '-Infinity') return -Infinity;
    if (/^-?\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    if ((str.startsWith('"') && str.endsWith('"')) ||
        (str.startsWith("'") && str.endsWith("'"))) return str.slice(1, -1);
    if (str.startsWith('[Function')) {
        return { __type: 'function', name: str.match(/\s+(\w+)?\]?$/)?.[1] || 'anonymous' };
    }
    if (str.startsWith('[…')) {
        return { __type: 'array', length: parseInt(str.match(/\d+/)?.[0] || '0', 10), preview: str };
    }
    if (str === '{…}' || str === '{}') return { __type: 'object' };
    return str;
}

// ── Worker 线程逻辑 ──────────────────────────────────────────────────────────

if (!isMainThread) {
    // Worker：接收行数组，返回序列化后的字符串数组
    const pretty = workerData?.pretty ?? false;
    parentPort.on('message', ({ lines, batchId }) => {
        const out = [];
        let skipped = 0;
        for (const line of lines) {
            try {
                const result = parseLine(line);
                if (result) {
                    out.push(pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
                } else {
                    skipped++;
                }
            } catch {
                skipped++;
            }
        }
        parentPort.postMessage({ batchId, out, skipped });
    });
    // 停止信号
    parentPort.on('close', () => process.exit(0));
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-parse.mjs — 将文本 trace 转换为结构化 NDJSON

用法：
  cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson
  node tools/trace-parse.mjs trace.ndjson > parsed.ndjson

选项：
  --strict      遇到无法解析的行时报错（默认跳过并警告）
  --raw         输出原始解析结果（包含更多细节）
  --compact     紧凑输出（默认即紧凑，保留此选项向后兼容）
  --pretty      格式化输出（带缩进，调试用）
  --workers N   并行 Worker 数（默认 = CPU 核心数，0 = 禁用多线程）
  --help        显示帮助信息
`);
}

async function main() {
    if (!isMainThread) return; // Worker 不执行 main

    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) { printHelp(); process.exit(0); }

    const strict  = args.includes('--strict');
    const pretty  = args.includes('--pretty');
    // --workers N
    const workerIdx = args.indexOf('--workers');
    const numCores  = cpus().length;
    const numWorkers = workerIdx >= 0
        ? parseInt(args[workerIdx + 1] ?? String(numCores), 10)
        : numCores;

    // 跳过 --workers N 的 N，以及其他带参数的选项值
    const skipNext = new Set();
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workers') { skipNext.add(i + 1); i++; }
    }
    const inputPath = args.find((a, i) => !a.startsWith('--') && !skipNext.has(i));

    if (inputPath) {
        const { promises: fsp } = await import('fs');
        try { await fsp.access(inputPath); }
        catch { console.error(`Error: 文件不存在: ${inputPath}`); process.exit(1); }
    }

    const stream = inputPath
        ? createReadStream(inputPath, { highWaterMark: 512 * 1024 })
        : input;

    // ── 单线程模式（--workers 0）────────────────────────────────────────
    if (numWorkers <= 0) {
        await runSingleThread(stream, pretty, strict);
        return;
    }

    // ── 多线程模式 ───────────────────────────────────────────────────────
    await runMultiThread(stream, pretty, strict, numWorkers);
}

// ── 单线程实现 ────────────────────────────────────────────────────────────

async function runSingleThread(stream, pretty, strict) {
    const OUT_BATCH = 2048;
    const outLines  = [];
    let parsed = 0, skipped = 0, lineNum = 0, leftover = '';

    function flushOut() {
        if (outLines.length > 0) { process.stdout.write(outLines.join('\n') + '\n'); outLines.length = 0; }
    }

    for await (const chunk of stream) {
        const text = leftover + chunk.toString('utf8');
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) !== 10) continue;
            lineNum++;
            const end  = (i > 0 && text.charCodeAt(i - 1) === 13) ? i - 1 : i;
            const line = text.slice(start, end);
            start = i + 1;
            if (line.length === 0) continue;
            const trimmed = (line.charCodeAt(0) <= 32 || line.charCodeAt(line.length - 1) <= 32) ? line.trim() : line;
            if (trimmed.length === 0) continue;
            try {
                const result = parseLine(trimmed);
                if (result) {
                    parsed++;
                    outLines.push(pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
                    if (outLines.length >= OUT_BATCH) flushOut();
                } else {
                    skipped++;
                    if (strict) { flushOut(); console.error(`Error: 无法解析第 ${lineNum} 行: ${trimmed}`); process.exit(1); }
                }
            } catch (err) {
                skipped++;
                if (strict) { flushOut(); console.error(`Error: 解析第 ${lineNum} 行时出错: ${err.message}`); process.exit(1); }
            }
        }
        leftover = text.slice(start);
    }
    if (leftover.trim().length > 0) {
        try {
            const r = parseLine(leftover.trim());
            if (r) { parsed++; outLines.push(pretty ? JSON.stringify(r, null, 2) : JSON.stringify(r)); }
            else skipped++;
        } catch { skipped++; }
    }
    flushOut();
    console.error(`# 解析完成: ${parsed} 行, 跳过 ${skipped} 行`);
}

// ── 多线程实现 ────────────────────────────────────────────────────────────

async function runMultiThread(stream, pretty, strict, numWorkers) {
    const __filename = fileURLToPath(import.meta.url);

    // 创建 Worker 池
    const workers = [];
    for (let i = 0; i < numWorkers; i++) {
        const w = new Worker(__filename, { workerData: { pretty } });
        workers.push(w);
    }

    // 结果缓存（按 batchId 顺序写出）
    const resultMap  = new Map(); // batchId → out[]
    let nextWrite    = 0;        // 下一个要写出的 batchId
    let totalParsed  = 0;
    let totalSkipped = 0;

    // 预分配 Worker → Promise 映射（空闲队列）
    const idle = workers.slice(); // 初始全部空闲
    const pending = []; // { batchId, resolve } 等待 Worker 结果

    // 建立 Worker 消息监听
    for (const w of workers) {
        w.on('message', ({ batchId, out, skipped }) => {
            totalSkipped += skipped;
            totalParsed  += out.length;
            resultMap.set(batchId, out);
            // 写出所有已就绪的连续批次
            while (resultMap.has(nextWrite)) {
                const lines = resultMap.get(nextWrite);
                resultMap.delete(nextWrite);
                if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
                nextWrite++;
            }
            // 通知等待的发送方该 Worker 空闲了
            idle.push(w);
            if (pending.length > 0) {
                const { resolve } = pending.shift();
                resolve();
            }
        });
        w.on('error', err => console.error('Worker error:', err));
    }

    // 等待空闲 Worker
    function waitForIdleWorker() {
        if (idle.length > 0) return Promise.resolve();
        return new Promise(resolve => pending.push({ resolve }));
    }

    // 切行并批量派发
    const BATCH_LINES = 8192; // 每批行数
    let batchId   = 0;
    let leftover  = '';
    let batch     = [];

    async function dispatchBatch(lines) {
        if (lines.length === 0) return;
        const id = batchId++;
        await waitForIdleWorker();
        const w = idle.pop();
        w.postMessage({ lines, batchId: id });
    }

    for await (const chunk of stream) {
        const text = leftover + chunk.toString('utf8');
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) !== 10) continue;
            const end  = (i > 0 && text.charCodeAt(i - 1) === 13) ? i - 1 : i;
            const line = text.slice(start, end);
            start = i + 1;
            if (line.length === 0) continue;
            const trimmed = (line.charCodeAt(0) <= 32 || line.charCodeAt(line.length - 1) <= 32) ? line.trim() : line;
            if (trimmed.length === 0) continue;
            batch.push(trimmed);
            if (batch.length >= BATCH_LINES) {
                await dispatchBatch(batch);
                batch = [];
            }
        }
        leftover = text.slice(start);
    }

    // 尾部
    if (leftover.trim().length > 0) batch.push(leftover.trim());
    if (batch.length > 0) await dispatchBatch(batch);

    // 等待所有已派发的批次完成（batchId 个批次，nextWrite 要追上 batchId）
    const totalBatches = batchId;
    if (nextWrite < totalBatches) {
        await new Promise(resolve => {
            // 重新包装 message handler，等所有批次写完
            const origCheck = () => {
                if (nextWrite >= totalBatches) resolve();
            };
            // 在每次写出后检查
            for (const w of workers) {
                const orig = w.rawListeners('message')[0];
                w.removeAllListeners('message');
                w.on('message', msg => {
                    orig(msg);
                    origCheck();
                });
            }
            origCheck(); // 可能已经满足
        });
    }

    // 关闭 Workers
    for (const w of workers) w.terminate();

    console.error(`# 解析完成: ${totalParsed} 行, 跳过 ${totalSkipped} 行`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
