#!/usr/bin/env node
/**
 * trace-decode.mjs — 将 .bin 二进制 trace 文件解码为 NDJSON 流。
 *
 * 用法：
 *   node tools/trace-decode.mjs trace.bin
 *   node tools/trace-decode.mjs trace.bin --smap trace.smap.json
 *   node tools/trace-decode.mjs trace.bin --smap trace.smap.json --resolve-values
 *   node tools/trace-decode.mjs trace.bin | node tools/trace-render.mjs --format tree
 *   node tools/trace-decode.mjs --help
 *
 * 选项：
 *   --smap <path>       加载 smap.json 文件，将 iid 还原为 line:col/srcText
 *   --resolve-values    追溯 OMITTED 值（需 --smap，通过 smap[iid].defIid 找到对应 write 事件的值）
 *   --pretty            输出带缩进的 JSON（调试用，输出量大时不建议）
 *   --stats             最后输出统计摘要到 stderr
 *   --help / -h         显示帮助
 *
 * 输出格式（NDJSON，与 trace-parse.mjs 输出兼容）：
 *   每条事件输出一行 JSON，字段说明：
 *
 *   通用字段：
 *     { type, seq, iid, line?, col?, srcText? }  （若提供了 --smap）
 *
 *   SCRIPT_ENTER:
 *     { type:'SCRIPT_ENTER', seq, iid, file, line?, col? }
 *
 *   SCRIPT_EXIT:
 *     { type:'SCRIPT_EXIT', seq, iid, exception? }
 *
 *   CALL_PRE:
 *     { type:'CALL_PRE', seq, iid, fn, isConstructor, isMethod, args:[], base?, line?, col? }
 *
 *   CALL:
 *     { type:'CALL', seq, iid, fn, result, line?, col? }
 *
 *   FUNCTION_ENTER:
 *     { type:'FUNCTION_ENTER', seq, iid, fn?, directFe }
 *
 *   FUNCTION_EXIT:
 *     { type:'FUNCTION_EXIT', seq, iid, exception? }
 *
 *   END_EXPR:
 *     { type:'END_EXPR', seq, iid, srcText?,
 *       writes?: [{name, value}],
 *       reads?: [{name, value, omitted?}],
 *       fields?: [{base, offset, isWrite, value}] }
 *
 *   KEY_EVENT:
 *     { type:'KEY_EVENT', seq, iid, level, text }
 *
 * 与 trace-parse.mjs 的差异：
 *   - 输入为 .bin 而非格式化文本，无需正则解析
 *   - 若提供 --smap，自动注入 line/col/srcText 字段（与 trace-parse 输出对齐）
 *   - 若提供 --resolve-values，追溯 OMITTED 值（值省略优化的逆操作）
 */

import { readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { stdin as input } from 'node:process';

import {
    FILE_HEADER_SIZE,
    EVENT_HEADER_SIZE,
    MAGIC,
    deserializeEvent,
} from '../src/encoding/EventSerializer.js';

// ─── 帮助信息 ─────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
trace-decode.mjs — 将 .bin 二进制 trace 文件解码为 NDJSON

用法：
  node tools/trace-decode.mjs trace.bin
  node tools/trace-decode.mjs trace.bin --smap trace.smap.json
  node tools/trace-decode.mjs trace.bin --smap trace.smap.json --resolve-values
  node tools/trace-decode.mjs trace.bin | node tools/trace-render.mjs --format tree

选项：
  --smap <path>       加载 smap.json，将 iid 还原为 line:col + srcText
  --resolve-values    追溯 OMITTED 值（需 --smap，通过 smap[iid].defIid 查找对应 write 值）
  --pretty            输出带缩进的 JSON（调试用）
  --stats             最后向 stderr 输出解码统计
  -h, --help          显示此帮助信息
`);
}

// ─── smap 工具 ─────────────────────────────────────────────────────────────────

/**
 * 从 smap.json 加载并构建 iid → 位置信息的 Map。
 * @param {string} smapPath
 * @returns {Map<number, { sl, sc, el, ec, srcText?, defIid? }>}
 */
function loadSmap(smapPath) {
    const raw = JSON.parse(readFileSync(smapPath, 'utf8'));
    const map = new Map();

    // raw.iids: { "9": [sl, sc, el, ec, srcText?, defIid?], ... }
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
 * @param {Map} smapMap
 */
function injectSmapInfo(event, smapMap) {
    const entry = smapMap.get(event.iid);
    if (!entry) return;
    event.line    = entry.sl;
    event.col     = entry.sc;
    if (entry.srcText != null) event.srcText = entry.srcText;
    if (entry.defIid  != null) event._defIid = entry.defIid;
}

// ─── 值追溯 ─────────────────────────────────────────────────────────────────────

/**
 * 追溯 OMITTED 值：
 * - 遍历已解码的 events，建立 iid → write 值的 Map。
 * - 对 OMITTED 的 reads，通过 smap[iid].defIid 找到 write 事件，填充值。
 *
 * @param {object[]} events
 * @param {Map} smapMap
 */
function resolveOmittedValues(events, smapMap) {
    // 第一遍：建立 writeIid → value 映射（从 END_EXPR 的 writes 中提取）
    const writeValues = new Map();  // iid → [{ name, value }]
    for (const ev of events) {
        if (ev.type === 'END_EXPR' && ev.writes) {
            for (const w of ev.writes) {
                // 用 iid 作为 key（一个 END_EXPR 对应一个 iid，可能有多个 writes）
                if (!writeValues.has(ev.iid)) writeValues.set(ev.iid, []);
                writeValues.get(ev.iid).push({ name: w.name, value: w.value });
            }
        }
    }

    // 第二遍：填充 OMITTED reads
    for (const ev of events) {
        if (ev.type === 'END_EXPR' && ev.reads) {
            for (const r of ev.reads) {
                if (!r.omitted) continue;

                // 通过 smapMap 找 defIid
                const entry = smapMap.get(ev.iid);
                if (!entry?.defIid) continue;

                const defIid = entry.defIid;
                const writes = writeValues.get(defIid);
                if (!writes) continue;

                // 找同名 write
                const match = writes.find(w => w.name === r.name);
                if (match !== undefined) {
                    r.value = match.value;
                    r.resolvedFromDefIid = defIid;
                    delete r.omitted;
                }
            }
        }
    }
}

// ─── 二进制解码 ─────────────────────────────────────────────────────────────────

/**
 * 检查 Buffer 是否以 JTB1 魔数开头。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isBinaryTrace(buf) {
    return buf.length >= 4
        && buf[0] === MAGIC[0]
        && buf[1] === MAGIC[1]
        && buf[2] === MAGIC[2]
        && buf[3] === MAGIC[3];
}

/**
 * 从 Buffer 中解码所有事件（流式，逐事件输出）。
 * @param {Buffer}   buf
 * @param {object}   opts  { smapMap?, resolveValues?, pretty?, stats }
 * @param {function} emit  (jsonLine: string) => void
 */
function decodeBuffer(buf, opts, emit) {
    const { smapMap, resolveValues, pretty } = opts;
    const statsCounter = { total: 0, omitted: 0 };

    const ab   = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);

    // 跳过文件头
    let offset = FILE_HEADER_SIZE;

    // 字典解压：DICT_ENTRY 事件写入此 Map，后续 STRING_REF / 0xFFFF 哨兵引用它
    const dict = new Map();

    // 如果 resolveValues，先收集所有事件到数组，然后批量处理
    const allEvents = resolveValues ? [] : null;

    while (offset + EVENT_HEADER_SIZE <= ab.byteLength) {
        let result;
        try {
            result = deserializeEvent(view, offset, dict);
        } catch (err) {
            process.stderr.write(`[trace-decode] decode error at offset ${offset}: ${err.message}\n`);
            break;
        }

        const { event, nextOffset } = result;

        // 防死循环
        if (nextOffset <= offset) break;
        offset = nextOffset;

        // DICT_ENTRY 是字典控制事件，deserializeEvent 已自动更新 dict，跳过输出
        if (event.type === 'DICT_ENTRY') continue;

        statsCounter.total++;

        // 注入 smap 信息
        if (smapMap) {
            injectSmapInfo(event, smapMap);
        }

        // 统计 omitted reads
        if (event.reads) {
            for (const r of event.reads) {
                if (r.omitted) statsCounter.omitted++;
            }
        }

        if (resolveValues) {
            allEvents.push(event);
        } else {
            // 立即输出
            emitEvent(event, pretty, emit);
        }
    }

    // 追溯 OMITTED 值
    if (resolveValues && allEvents) {
        resolveOmittedValues(allEvents, smapMap ?? new Map());
        for (const ev of allEvents) {
            emitEvent(ev, pretty, emit);
        }
    }

    return statsCounter;
}

/**
 * 输出单条事件为 JSON 行。
 * @param {object}   event
 * @param {boolean}  pretty
 * @param {function} emit
 */
function emitEvent(event, pretty, emit) {
    // 移除内部字段
    delete event._defIid;

    let line;
    try {
        line = pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event);
    } catch {
        line = JSON.stringify({ type: event.type, seq: event.seq, iid: event.iid, _error: 'serialize failed' });
    }
    emit(line);
}

// ─── 主程序 ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    // 解析选项
    const smapIdx = args.indexOf('--smap');
    const smapPath = smapIdx >= 0 ? args[smapIdx + 1] : null;

    const resolveValues = args.includes('--resolve-values');
    const pretty        = args.includes('--pretty');
    const showStats     = args.includes('--stats');

    // 获取输入文件路径（第一个非选项参数）
    const nonOptionArgs = args.filter((a, i) => {
        if (a.startsWith('--')) return false;
        const prev = args[i - 1];
        if (prev === '--smap') return false;
        return true;
    });
    const inputPath = nonOptionArgs[0] ?? null;

    // 加载 smap
    let smapMap = null;
    if (smapPath) {
        try {
            const { map } = loadSmap(smapPath);
            smapMap = map;
        } catch (err) {
            process.stderr.write(`[trace-decode] failed to load smap: ${err.message}\n`);
            process.exit(1);
        }
    }

    if (resolveValues && !smapMap) {
        process.stderr.write('[trace-decode] --resolve-values requires --smap\n');
        process.exit(1);
    }

    // 读取输入
    let buf;
    if (inputPath) {
        try {
            buf = readFileSync(inputPath);
        } catch (err) {
            process.stderr.write(`[trace-decode] failed to read file: ${err.message}\n`);
            process.exit(1);
        }
    } else {
        // 从 stdin 读取
        const chunks = [];
        for await (const chunk of input) {
            chunks.push(chunk);
        }
        buf = Buffer.concat(chunks);
    }

    // 检查魔数
    if (!isBinaryTrace(buf)) {
        process.stderr.write('[trace-decode] input does not appear to be a JTB1 binary trace file (missing magic bytes)\n');
        process.stderr.write('  If this is a NDJSON file, use trace-parse.mjs instead.\n');
        process.exit(1);
    }

    // 解码并输出
    const outLines = [];
    const emit = (line) => {
        process.stdout.write(line + '\n');
    };

    const stats = decodeBuffer(buf, {
        smapMap,
        resolveValues,
        pretty,
    }, emit);

    if (showStats) {
        process.stderr.write(`# trace-decode: total=${stats.total} omitted-reads=${stats.omitted}\n`);
    }
}

main().catch(err => {
    process.stderr.write(`[trace-decode] Fatal: ${err.message}\n${err.stack ?? ''}\n`);
    process.exit(1);
});
