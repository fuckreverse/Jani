#!/usr/bin/env node
/**
 * trace-parse.mjs — 将 trace 文件转换为结构化 NDJSON
 *
 * ⚠️  迁移说明：trace-decode.mjs 已废弃并删除，所有用法请替换为本文件。
 *    旧：node tools/trace-decode.mjs trace.bin [--smap ...] [--resolve-values] [--stats]
 *    新：node tools/trace-parse.mjs  trace.bin [--smap ...] [--resolve-values] [--stats]
 *    参数完全兼容，无需修改其他选项。
 *
 * 支持两种输入格式（自动检测）：
 *   1. JTB1 二进制 trace 文件（.bin）— 直接解码，输出量小，无需正则解析
 *   2. 文本格式 trace 行（旧格式）— 手动解析器（热路径）
 *
 * 用法：
 *   node tools/trace-parse.mjs trace.bin                    # 自动检测二进制
 *   node tools/trace-parse.mjs trace.bin --smap t.smap.json # 注入源码位置
 *   node tools/trace-parse.mjs trace.bin --smap t.smap.json --resolve-values
 *   cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson
 *   node tools/trace-parse.mjs trace.ndjson > parsed.ndjson
 *   node tools/trace-parse.mjs --help
 *
 * 文本格式输入支持：
 *   - [  123] [  10:5] CALL foo(2 args) {"a":[...]}
 *   - [  124] [  10:5] RETN foo {"v":42}
 *   - [  125] [  10:5] x = 1 + 2 {"w":{"x":3}}
 *   - [    1] ▶ script: /path/to/file.js
 *   - [  999] ◀ script end
 *
 * 输出格式（每行一个紧凑 JSON 对象）：
 *   二进制模式：{"type":"SCRIPT_ENTER","seq":1,"iid":8,"file":"...","line":1,"col":0}
 *   文本模式：  {"seq":123,"line":10,"col":5,"type":"call","fn":"foo","args":2,"kv":{...}}
 *
 * 选项（通用）：
 *   --pretty          格式化输出（带缩进，调试用）
 *   --help            显示帮助
 *
 * 选项（二进制模式专用）：
 *   --smap <path>     加载 smap.json，将 iid 还原为 line:col/srcText
 *   --resolve-values  追溯 OMITTED 值（需 --smap）
 *   --stats           向 stderr 输出解码统计
 *
 * 选项（文本模式专用）：
 *   --strict          遇到无法解析的行时报错（默认跳过并警告）
 *   --raw             输出原始解析结果（含更多细节）
 *   --compact         紧凑输出（默认即紧凑，向后兼容）
 *   --workers N       并行 Worker 线程数（默认 = CPU 核心数，0 禁用多线程）
 */

import { createReadStream, readFileSync } from 'fs';
import { stdin as input } from 'process';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';

// ── 二进制解码依赖 ──────────────────────────────────────────────────────────────
import {
    FILE_HEADER_SIZE,
    FORMAT_VERSION,
    EVENT_HEADER_SIZE,
    MAGIC,
    deserializeEvent,
    isBinaryTrace,
    isGzipTrace,
    gunzipTraceAsync,
} from '../src/encoding/EventSerializer.js';

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
            return { seq, type: 'SCRIPT_ENTER', file: line.slice(pos + scriptPrefix.length).trim() };
        }
        return null;
    }
    if (line.charCodeAt(pos) === 9668 /* ◀ */) {
        return { seq, type: 'SCRIPT_EXIT', exception: line.indexOf('exception:', pos) >= 0 };
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
        // 注意：文本格式的 CALL 行实际对应 JTB1 中的 CALL_PRE（调用前），
        // 输出统一使用 JTB1 类型名以兼容下游工具链
        return { seq, line: lineNum, col: colNum, type: 'CALL_PRE', fn, isConstructor: isNew, args: args > 0 ? Array(args).fill(undefined) : [], kv };
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
                    // RETN 对应 JTB1 中的 CALL（调用后返回结果）
                    return { seq, line: lineNum, col: colNum, type: 'CALL', fn, result: kvObj.v, kv: kvObj };
                } catch { /* fall through */ }
            }
            if (rest.charCodeAt(0) === 59) {
                const eqIdx = rest.indexOf('=', 1);
                if (eqIdx >= 0) {
                    return { seq, line: lineNum, col: colNum, type: 'CALL', fn, result: parseValue(rest.slice(eqIdx + 1).trim()) };
                }
            }
            return { seq, line: lineNum, col: colNum, type: 'CALL', fn, raw: rest };
        }
        return { seq, line: lineNum, col: colNum, type: 'CALL', fn };
    }

    // ── expr ──────────────────────────────────────────────────────────
    const jsonPos = findJsonSuffix(content);
    if (jsonPos > 0) {
        const srcText = content.slice(0, jsonPos).trimEnd();
        try {
            const kvObj = JSON.parse(content.slice(jsonPos));
            // 文本模式的 expr 对应 JTB1 中的 END_EXPR
            const rec = { seq, line: lineNum, col: colNum, type: 'END_EXPR', srcText, src: srcText };
            if (kvObj.w) rec.w = kvObj.w;
            if (kvObj.r) rec.r = kvObj.r;
            if (kvObj.f) rec.f = kvObj.f;
            if (Object.keys(kvObj).length > 0) rec.kv = kvObj;
            return rec;
        } catch { /* fall through */ }
    }

    const semiIdx = content.lastIndexOf(';');
    if (semiIdx > 0) {
        return { seq, line: lineNum, col: colNum, type: 'END_EXPR', srcText: content.slice(0, semiIdx).trim(), src: content.slice(0, semiIdx).trim(), kv: parseKv(content.slice(semiIdx + 1).trim()) };
    }

    const srcText = content.trim();
    if (srcText) return { seq, line: lineNum, col: colNum, type: 'END_EXPR', srcText, src: srcText };
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

// ── 二进制模式：smap 工具 ─────────────────────────────────────────────────────

/**
 * 从 smap.json 加载并构建 iid → 位置信息的 Map。
 * @param {string} smapPath
 * @returns {{ map: Map, meta: object }}
 */
function loadSmap(smapPath) {
    const raw = JSON.parse(readFileSync(smapPath, 'utf8'));
    const map = new Map();

    if (raw.iids && typeof raw.iids === 'object') {
        for (const [key, arr] of Object.entries(raw.iids)) {
            if (!Array.isArray(arr) || arr.length < 4) continue;
            const iid = Number(key);
            map.set(iid, {
                sl: arr[0], sc: arr[1], el: arr[2], ec: arr[3],
                srcText: arr[4] != null ? arr[4] : undefined,
                defIid:  arr[5] != null ? Number(arr[5]) : undefined,
            });
        }
    }

    return { map, meta: { originalFile: raw.originalFile, instrumentedFile: raw.instrumentedFile } };
}

/**
 * 将 smap 位置信息注入事件对象（就地修改）。
 * @param {object} event
 * @param {Map}    smapMap
 */
function injectSmapInfo(event, smapMap) {
    const entry = smapMap.get(event.iid);
    if (!entry) return;
    event.line = entry.sl;
    event.col  = entry.sc;
    if (entry.srcText != null) event.srcText = entry.srcText;
    if (entry.defIid  != null) event._defIid = entry.defIid;
}

/**
 * 第一遍扫描：从 DataView 中提取所有 END_EXPR write 值，建立 iid → writes 映射。
 * 只保留 write 数据（内存占用远小于全量事件），其他事件类型直接跳过。
 *
 * v3 格式新增：每个 write 条目包含 scopeId（来自 w.scopeId），
 * 用于在 resolveEventOmitted 中区分同名变量（同一函数多次调用的不同帧）。
 *
 * @param {DataView} view
 * @returns {Map<number, Array<{name: string, value: *, scopeId: number|null}>>}  iid → writes
 */
function collectWriteValues(view) {
    const writeValues = new Map();
    let offset = FILE_HEADER_SIZE;
    // 读取文件版本号，传给 deserializeEvent 以正确解析 scope_id 字段
    const fileVersion = view.byteLength >= FILE_HEADER_SIZE
        ? view.getUint8(4)
        : 0x01;

    while (offset + EVENT_HEADER_SIZE <= view.byteLength) {
        let result;
        try {
            result = deserializeEvent(view, offset, fileVersion);
        } catch {
            throw new Error(`Invalid trace at byte ${offset}`);
        }
        const { event, nextOffset } = result;
        if (nextOffset <= offset) break;
        offset = nextOffset;

        if (event.type !== 'END_EXPR' || !event.writes) continue;

        for (const w of event.writes) {
            if (!writeValues.has(event.iid)) writeValues.set(event.iid, []);
            // 保存 scopeId，供 resolveEventOmitted 精确匹配使用
            writeValues.get(event.iid).push({
                name:    w.name,
                value:   w.value,
                scopeId: w.scopeId ?? null,
            });
        }
    }

    return writeValues;
}

/**
 * 对单条事件就地回填 omitted reads（流式，无需全量缓存）。
 *
 * Bug 修复（递归/循环场景）：
 *   同一 iid（如函数参数赋值点）可能对应多条 write 记录（每次调用一条）。
 *   v3 格式新增 scopeId 字段后，优先用 (scopeId + name) 精确匹配；
 *   scopeId 不可用时降级为仅按 name 匹配（取最后一条，与调用顺序最近）。
 *
 * @param {object} event
 * @param {Map}    smapMap
 * @param {Map}    writeValues   由 collectWriteValues() 预先构建
 */
function resolveEventOmitted(event, smapMap, writeValues) {
    if (event.type !== 'END_EXPR' || !event.reads) return;
    for (const r of event.reads) {
        if (!r.omitted) continue;
        const entry = smapMap.get(event.iid);
        if (!entry?.defIid) continue;
        const writes = writeValues.get(entry.defIid);
        if (!writes) continue;

        let match;
        if (r.scopeId != null) {
            // v3 路径：精确匹配 (scopeId + name)，区分不同调用帧的同名变量
            match = writes.find(w => w.scopeId === r.scopeId && w.name === r.name);
        }
        if (match === undefined) {
            // 降级路径：仅按 name 匹配（取最后一条，与最近一次调用最接近）
            // 注：findLast 在 Node.js 18+ 支持，回退到 for 循环保证兼容性
            for (let i = writes.length - 1; i >= 0; i--) {
                if (writes[i].name === r.name) { match = writes[i]; break; }
            }
        }
        if (match !== undefined) {
            r.value = match.value;
            r.resolvedFromDefIid = entry.defIid;
            delete r.omitted;
        }
    }
}

/**
 * 解码 JTB1 二进制 Buffer，逐事件调用 emit()。
 *
 * 当 resolveValues=true 时采用两遍流式策略，避免全量事件驻留内存：
 *   第一遍：仅提取 END_EXPR write 值，建立 iid → writes 映射（内存 O(write 事件数)）
 *   第二遍：正常流式解码并 emit，遇到 omitted read 时就地回填
 *
 * @param {Buffer}   buf
 * @param {object}   opts  { smapMap?, resolveValues?, pretty? }
 * @param {function} emit  (jsonLine: string) => void
 * @returns {{ total: number, omitted: number }}
 */
function decodeBinaryBuffer(buf, opts, emit) {
    const { smapMap, resolveValues, pretty } = opts;
    const stats = { total: 0, omitted: 0 };

    const ab   = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);
    if (buf.length < FILE_HEADER_SIZE || !isBinaryTrace(buf)) throw new Error('Invalid trace magic/header');

    // ── 第一遍（仅在 resolveValues 时）：提取所有 write 值 ──────────────────
    let writeValues = null;
    if (resolveValues) {
        writeValues = collectWriteValues(view);
    }

    // ── 第二遍（或唯一一遍）：流式解码并输出 ───────────────────────────────
    // 读取文件版本号，确保与 collectWriteValues（第一遍）使用相同版本解析
    const fileVersion = ab.byteLength >= FILE_HEADER_SIZE
        ? new DataView(ab).getUint8(4)
        : 0x01;
    if (fileVersion < 1 || fileVersion > FORMAT_VERSION) throw new Error(`Unsupported trace version ${fileVersion}`);
    let offset = FILE_HEADER_SIZE;

    while (offset + EVENT_HEADER_SIZE <= ab.byteLength) {
        let result;
        try {
            result = deserializeEvent(view, offset, fileVersion);
        } catch (err) {
            process.stderr.write(`[trace-parse] decode error at offset ${offset}: ${err.message}\n`);
            throw new Error(`Invalid trace at byte ${offset}`);
        }
        const { event, nextOffset } = result;
        if (nextOffset <= offset) break;
        offset = nextOffset;

        stats.total++;

        if (smapMap) injectSmapInfo(event, smapMap);

        // 统计 omitted（回填前计数）
        if (event.reads) {
            for (const r of event.reads) { if (r.omitted) stats.omitted++; }
        }

        // 就地回填 omitted reads（流式，无需缓存整个事件数组）
        if (resolveValues && writeValues) {
            resolveEventOmitted(event, smapMap ?? new Map(), writeValues);
        }

        emitBinaryEvent(event, pretty, emit);
    }

    if (offset !== ab.byteLength) throw new Error(`Truncated event at byte ${offset}`);
    return stats;
}

/**
 * 将单条事件（内部字段已清理）序列化为 JSON 行并调用 emit。
 */
function emitBinaryEvent(event, pretty, emit) {
    delete event._defIid;
    let line;
    try {
        line = pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event);
    } catch {
        line = JSON.stringify({ type: event.type, seq: event.seq, iid: event.iid, _error: 'serialize failed' });
    }
    emit(line);
}

/**
 * 二进制模式主流程：读取整个 buffer，解码并输出 NDJSON。
 * 自动识别 .bin.gz（gzip 压缩格式），解压后再解码。
 * @param {string|null} inputPath
 * @param {object}      opts
 */
async function runBinaryMode(inputPath, opts) {
    const { smapPath, resolveValues, pretty, showStats } = opts;

    // 加载 smap
    let smapMap = null;
    if (smapPath) {
        try {
            const { map } = loadSmap(smapPath);
            smapMap = map;
        } catch (err) {
            process.stderr.write(`[trace-parse] failed to load smap: ${err.message}\n`);
            process.exit(1);
        }
    }
    if (resolveValues && !smapMap) {
        process.stderr.write('[trace-parse] --resolve-values requires --smap\n');
        process.exit(1);
    }

    // 读取 buffer
    let buf;
    if (inputPath) {
        try { buf = readFileSync(inputPath); }
        catch (err) {
            process.stderr.write(`[trace-parse] failed to read file: ${err.message}\n`);
            process.exit(1);
        }
    } else {
        const chunks = [];
        for await (const chunk of input) chunks.push(chunk);
        buf = Buffer.concat(chunks);
    }

    // 自动解压 .bin.gz
    if (isGzipTrace(buf)) {
        try {
            process.stderr.write('[trace-parse] detected gzip trace, decompressing...\n');
            buf = await gunzipTraceAsync(buf);
        } catch (err) {
            process.stderr.write(`[trace-parse] failed to decompress: ${err.message}\n`);
            process.exit(1);
        }
    }

    const emit = (line) => process.stdout.write(line + '\n');
    const stats = decodeBinaryBuffer(buf, { smapMap, resolveValues, pretty }, emit);

    if (showStats) {
        process.stderr.write(`# trace-parse (binary): total=${stats.total} omitted-reads=${stats.omitted}\n`);
    }
}

// ── 主程序 ─────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-parse.mjs — 将 trace 文件转换为结构化 NDJSON（支持二进制和文本格式）

用法：
  node tools/trace-parse.mjs trace.bin                        # 二进制模式（自动检测）
  node tools/trace-parse.mjs trace.bin --smap trace.smap.json # 注入源码位置
  node tools/trace-parse.mjs trace.bin --smap trace.smap.json --resolve-values
  cat trace.ndjson | node tools/trace-parse.mjs > parsed.ndjson
  node tools/trace-parse.mjs trace.ndjson > parsed.ndjson

通用选项：
  --pretty          格式化输出（带缩进，调试用）
  --help            显示帮助信息

二进制模式选项：
  --smap <path>     加载 smap.json，将 iid 还原为 line:col + srcText
  --resolve-values  追溯 OMITTED 值（需 --smap，通过 smap[iid].defIid 找对应 write 值）
  --stats           向 stderr 输出解码统计

文本模式选项：
  --strict          遇到无法解析的行时报错（默认跳过并警告）
  --raw             输出原始解析结果（包含更多细节）
  --compact         紧凑输出（默认即紧凑，保留此选项向后兼容）
  --workers N       并行 Worker 数（默认 = CPU 核心数，0 = 禁用多线程）
`);
}

async function main() {
    if (!isMainThread) return; // Worker 不执行 main

    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) { printHelp(); process.exit(0); }

    const pretty  = args.includes('--pretty');
    const strict  = args.includes('--strict');

    // 解析带参数的选项（--workers N / --smap <path>）
    const skipNext = new Set();
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workers' || args[i] === '--smap') { skipNext.add(i + 1); i++; }
    }
    const inputPath = args.find((a, i) => !a.startsWith('--') && !skipNext.has(i)) ?? null;

    if (inputPath) {
        const { promises: fsp } = await import('fs');
        try { await fsp.access(inputPath); }
        catch { console.error(`Error: 文件不存在: ${inputPath}`); process.exit(1); }
    }

    // ── 自动检测二进制格式 ───────────────────────────────────────────────────
    // 策略：
    //   如果指定了文件路径，读取前 4 字节检测魔数。
    //   如果是 stdin，先缓存少量字节检测。若是二进制则进入 runBinaryMode。
    const smapIdx    = args.indexOf('--smap');
    const smapPath   = smapIdx >= 0 ? args[smapIdx + 1] : null;
    const resolveValues = args.includes('--resolve-values');
    const showStats  = args.includes('--stats');

    let isBinary = false;

    if (inputPath) {
        // 文件路径已知：读取前 4 字节检测魔数（JTB1 或 gzip 1f8b）
        try {
            const fd = await (await import('fs')).promises.open(inputPath, 'r');
            const hdr = Buffer.alloc(4);
            await fd.read(hdr, 0, 4, 0);
            await fd.close();
            // .bin（JTB1 魔数）或 .bin.gz（gzip 魔数）均视为二进制模式
            isBinary = isBinaryTrace(hdr) || isGzipTrace(hdr)
                || inputPath.endsWith('.bin.gz') || inputPath.endsWith('.bin');
        } catch { /* 若读取失败，fallback 到文本模式 */ }
    } else {
        // stdin：无法提前知道格式，暂不自动检测（用户可通过 --smap 等选项暗示使用二进制模式，或显式检测）
        // 如果用户传了 --smap 或 --resolve-values，说明期望二进制模式
        // 实际上 stdin 二进制模式需要把所有数据先缓存，因此统一由 runBinaryMode 处理
        isBinary = (smapPath !== null || resolveValues);
    }

    if (isBinary) {
        // ── 二进制模式 ──────────────────────────────────────────────────
        await runBinaryMode(inputPath, { smapPath, resolveValues, pretty, showStats });
        return;
    }

    // ── 文本模式（原有路径）─────────────────────────────────────────────────
    const workerIdx  = args.indexOf('--workers');
    const numCores   = cpus().length;
    const numWorkers = workerIdx >= 0
        ? parseInt(args[workerIdx + 1] ?? String(numCores), 10)
        : numCores;

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
