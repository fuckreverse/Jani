#!/usr/bin/env node
/**
 * trace-render.mjs — 将结构化 NDJSON 渲染为各种展示格式
 *
 * 接收 trace-parse.mjs 输出的结构化 NDJSON，按指定风格渲染后输出到 stdout。
 *
 * 用法：
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format block
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format pipe
 *   node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format flat
 *   node tools/trace-render.mjs --format tree parsed.ndjson
 *
 * 选项：
 *   --format FORMAT   输出格式：flat（默认）、tree、block、pipe
 *   --no-seq          不输出 seq 编号前缀
 *   --help            显示帮助信息
 *
 * 格式说明：
 *   flat   平铺流式（与原始 trace 相同的布局，无调用栈缩进）
 *   tree   Unicode 树形符号（┬ 进入 / └ 退出 / │ 延续线），按调用深度缩进
 *   block  #region/#endregion 折叠块（VS Code 任意文件可折叠）
 *   pipe   ASCII pipe 符号（| 数量 = 调用深度），纯 ASCII 适合工具链
 *
 * 注意：tree / block / pipe 格式统一以 CALL_PRE/CALL 对推导调用深度；
 *       FUNCTION_ENTER/FUNCTION_EXIT 不参与深度计算（避免双重计数），仅作附加信息输出。
 *       若上游 trace-filter 过滤掉了部分事件，深度重建可能不完整（这是预期行为）。
 *
 * 输入格式：trace-parse.mjs 输出的 NDJSON（JTB1 事件类型）
 *   事件类型：SCRIPT_ENTER, SCRIPT_EXIT, CALL_PRE, CALL, FUNCTION_ENTER,
 *             FUNCTION_EXIT, END_EXPR, KEY_EVENT, WRITE_VAR, READ_VAR_FULL
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 对齐常量 ──────────────────────────────────────────────────────────────────
const SEQ_WIDTH = 6;
const RC_WIDTH  = 9;

function fmtSeq(seq) {
    return String(seq).padStart(SEQ_WIDTH);
}

function fmtRc(rc) {
    return String(rc ?? '?:?').padStart(RC_WIDTH);
}

// ── 格式渲染器 ────────────────────────────────────────────────────────────────

/**
 * FlatRenderer — 平铺流式输出
 */
class FlatRenderer {
    render(record, depth) {
        const seq = record.seq ?? '';
        const rc  = record.line != null ? `${record.line}:${record.col ?? 0}` : '?:?';

        switch (record.type) {
            // ── JTB1 格式事件类型 ──────────────────────────────────────────
            case 'CALL_PRE': {
                const desc = _callPreDesc(record);
                const kv   = _callPreKv(record);
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] CALL ${desc}${kv ? ' ' + kv : ''}`;
            }
            case 'CALL': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? JSON.stringify(record.result) : '?';
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] RETN ${name} {"v":${v}}`;
            }
            case 'FUNCTION_ENTER': {
                const fn = record.fn ?? '(anonymous)';
                const direct = record.directFe ? ' (direct)' : '';
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] FUNC_ENTER ${fn}${direct}`;
            }
            case 'FUNCTION_EXIT': {
                const ex = record.exception != null
                    ? ` (exception: ${JSON.stringify(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] FUNC_EXIT${ex}`;
            }
            case 'END_EXPR': {
                const src = record.srcText ?? record.src ?? `(iid=${record.iid})`;
                const kv  = _endExprKv(record);
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${src}${kv ? ' ' + kv : ''}`;
            }
            case 'SCRIPT_ENTER':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'SCRIPT_EXIT': {
                const ex = record.exception != null
                    ? ` (exception: ${JSON.stringify(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            case 'KEY_EVENT': {
                const level = record.level ?? 'info';
                return `[${fmtSeq(seq)}] [${level.toUpperCase()}] ${record.text ?? ''}`;
            }
            case 'WRITE_VAR':
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] WRITE ${record.name} = ${serialize(record.value)}`;
            case 'READ_VAR_FULL':
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] READ  ${record.name} = ${serialize(record.value)}`;
            default:
                return JSON.stringify(record);
        }
    }
}

/**
 * TreeRenderer — Unicode 树形符号
 *   ┬ 进入（CALL_PRE）
 *   └ 退出（CALL）
 *   │ 延续线
 */
class TreeRenderer {
    _prefix(depth, tip) {
        if (depth <= 0) return tip;
        return '│ '.repeat(depth - 1) + tip;
    }

    render(record, depth) {
        const seq = record.seq ?? '';
        const rc  = record.line != null ? `${record.line}:${record.col ?? 0}` : '?:?';

        switch (record.type) {
            case 'CALL_PRE': {
                const desc = _callPreDesc(record);
                const kv   = _callPreKv(record);
                const ind  = this._prefix(depth, '┬ ');
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${desc}${kv ? ' ; ' + kv : ''}`;
            }
            case 'CALL': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? serialize(record.result) : '?';
                const ind  = this._prefix(depth, '└ ');
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}return ${name} ; =${v}`;
            }
            case 'FUNCTION_ENTER': {
                const fn  = record.fn ?? '(anonymous)';
                const ind = this._prefix(depth, '→ ');
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${fn} enter`;
            }
            case 'FUNCTION_EXIT': {
                const ind = this._prefix(depth, '← ');
                const ex  = record.exception != null ? ` (exception)` : '';
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}exit${ex}`;
            }
            case 'END_EXPR': {
                const src = record.srcText ?? record.src ?? `(iid=${record.iid})`;
                const kv  = _endExprKvFlat(record);
                const ind = '│ '.repeat(depth);
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${src}${kv ? ' ; ' + kv : ''}`;
            }
            case 'SCRIPT_ENTER':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'SCRIPT_EXIT': {
                const ex = record.exception != null
                    ? ` (exception: ${serialize(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            case 'KEY_EVENT': {
                const level = record.level ?? 'info';
                return `[${fmtSeq(seq)}] [${level.toUpperCase()}] ${record.text ?? ''}`;
            }
            default:
                return JSON.stringify(record);
        }
    }
}

/**
 * BlockRenderer — #region/#endregion 折叠块
 * VS Code 在任何文件中识别这两个关键字并提供折叠
 */
class BlockRenderer {
    _indent(depth) {
        return '  '.repeat(Math.max(depth - 1, 0));
    }

    render(record, depth) {
        const seq = record.seq ?? '';
        const rc  = record.line != null ? `${record.line}:${record.col ?? 0}` : '?:?';

        switch (record.type) {
            case 'CALL_PRE': {
                const desc = _callPreDesc(record);
                const kv   = _callPreKv(record);
                const ind  = this._indent(depth);
                return `[${fmtSeq(seq)}] ${ind}// #region [${fmtRc(rc)}] CALL ${desc}${kv ? ' ; ' + kv : ''}`;
            }
            case 'CALL': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? serialize(record.result) : '?';
                const ind  = this._indent(depth);
                return `[${fmtSeq(seq)}] ${ind}// #endregion ${name} ; =${v}  [${fmtRc(rc)}]`;
            }
            case 'FUNCTION_ENTER': {
                const fn  = record.fn ?? '(anonymous)';
                const ind = this._indent(depth);
                return `[${fmtSeq(seq)}] ${ind}//   → ${fn} enter  [${fmtRc(rc)}]`;
            }
            case 'FUNCTION_EXIT': {
                const ind = this._indent(depth);
                const ex  = record.exception != null ? ` (exception)` : '';
                return `[${fmtSeq(seq)}] ${ind}//   ← exit${ex}  [${fmtRc(rc)}]`;
            }
            case 'END_EXPR': {
                const src = record.srcText ?? record.src ?? `(iid=${record.iid})`;
                const kv  = _endExprKvFlat(record);
                const ind = '  '.repeat(Math.max(depth - 1, 0));
                return `[${fmtSeq(seq)}] ${ind}${src}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
            }
            case 'SCRIPT_ENTER':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'SCRIPT_EXIT': {
                const ex = record.exception != null
                    ? ` (exception: ${serialize(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            case 'KEY_EVENT': {
                const level = record.level ?? 'info';
                return `[${fmtSeq(seq)}] [${level.toUpperCase()}] ${record.text ?? ''}`;
            }
            default:
                return JSON.stringify(record);
        }
    }
}

/**
 * PipeRenderer — ASCII pipe 符号（| 数量 = 调用深度）
 * 纯 ASCII，适合工具链和终端管道
 */
class PipeRenderer {
    _pipes(depth) {
        return '| '.repeat(depth);
    }

    render(record, depth) {
        const seq = record.seq ?? '';
        const rc  = record.line != null ? `${record.line}:${record.col ?? 0}` : '?:?';

        switch (record.type) {
            case 'CALL_PRE': {
                const desc = _callPreDesc(record);
                const kv   = _callPreKv(record);
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${desc} [${fmtRc(rc)}]${kv ? ' ; ' + kv : ''}`;
            }
            case 'CALL': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? serialize(record.result) : '?';
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${name} RETN ; =${v}  [${fmtRc(rc)}]`;
            }
            case 'FUNCTION_ENTER': {
                const fn = record.fn ?? '(anonymous)';
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${fn} ENTER  [${fmtRc(rc)}]`;
            }
            case 'FUNCTION_EXIT': {
                const ex = record.exception != null ? ' (exception)' : '';
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}FUNC_EXIT${ex}  [${fmtRc(rc)}]`;
            }
            case 'END_EXPR': {
                const src = record.srcText ?? record.src ?? `(iid=${record.iid})`;
                const kv  = _endExprKvFlat(record);
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${src}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
            }
            case 'SCRIPT_ENTER':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'SCRIPT_EXIT': {
                const ex = record.exception != null
                    ? ` (exception: ${serialize(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            case 'KEY_EVENT': {
                const level = record.level ?? 'info';
                return `[${fmtSeq(seq)}] [${level.toUpperCase()}] ${record.text ?? ''}`;
            }
            default:
                return JSON.stringify(record);
        }
    }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 将值序列化为简短字符串（用于树形/pipe/block 展示） */
function serialize(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') {
        const s = val.length > 32 ? val.slice(0, 31) + '…' : val;
        return JSON.stringify(s);
    }
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
        return String(val);
    }
    if (Array.isArray(val)) return `[…${val.length}]`;
    if (typeof val === 'object') return '{…}';
    if (typeof val === 'function') return `[Function${val.name ? ' ' + val.name : ''}]`;
    return String(val);
}

/** 从 CALL_PRE 记录生成描述字符串 */
function _callPreDesc(record) {
    const name = record.fn ?? '(anonymous)';
    const n    = record.args?.length ?? 0;
    if (record.isConstructor) return `new ${name}(${n} args)`;
    return `${name}(${n} args)`;
}

/** 从 CALL_PRE 记录生成 kv 字符串 */
function _callPreKv(record) {
    const parts = [];
    if (record.base !== undefined) parts.push(`this=${serialize(record.base)}`);
    if (Array.isArray(record.args)) {
        record.args.slice(0, 5).forEach((v, i) => parts.push(`arg${i}=${serialize(v)}`));
        if (record.args.length > 5) parts.push('...');
    }
    return parts.join(', ');
}

/**
 * 从 END_EXPR 记录生成 kv JSON 字符串（用于 flat 格式）
 * END_EXPR 格式：writes=[{name, value}], reads=[{name, value}], fields=[{base, offset, isWrite, value}]
 */
function _endExprKv(record) {
    const obj = {};
    if (record.writes?.length > 0) {
        obj.w = {};
        for (const w of record.writes) obj.w[w.name] = w.value;
    }
    if (record.reads?.length > 0) {
        obj.r = {};
        for (const r of record.reads) {
            if (!r.omitted) obj.r[r.name] = r.value;
        }
    }
    if (record.fields?.length > 0) {
        obj.f = record.fields.map(f => ({
            base: f.base,
            offset: f.offset,
            isWrite: f.isWrite,
            val: f.value,
        }));
    }
    return Object.keys(obj).length > 0 ? JSON.stringify(obj) : '';
}

/** 从 END_EXPR 记录生成扁平文本 kv 字符串（用于 tree/block/pipe 格式，更易读） */
function _endExprKvFlat(record) {
    const parts = [];

    // 写入变量
    if (record.writes?.length > 0) {
        for (const w of record.writes) {
            parts.push(`${w.name}=${serialize(w.value)}`);
        }
    }

    // 读取变量（只显示未被 write 覆盖的）
    if (record.reads?.length > 0) {
        const written = new Set((record.writes ?? []).map(w => w.name));
        for (const r of record.reads) {
            if (!written.has(r.name)) {
                if (r.omitted) {
                    parts.push(`${r.name}=<omitted>`);
                } else {
                    parts.push(`${r.name}=${serialize(r.value)}`);
                }
            }
        }
    }

    // 属性访问
    if (record.fields?.length > 0) {
        for (const f of record.fields) {
            const key = `${f.base}.${f.offset}`;
            const arrow = f.isWrite ? '←' : '→';
            parts.push(`${key}${arrow}${serialize(f.value)}`);
        }
    }

    let str = parts.join(', ');
    if (str.length > 120) str = str.slice(0, 119) + '…';
    return str;
}

/** 根据格式名创建渲染器 */
function createRenderer(format) {
    switch (format) {
        case 'tree':  return new TreeRenderer();
        case 'block': return new BlockRenderer();
        case 'pipe':  return new PipeRenderer();
        default:      return new FlatRenderer();
    }
}

// ── 深度追踪器 ─────────────────────────────────────────────────────────────────
//
// 统一使用 CALL_PRE/CALL 事件对维护当前调用深度，供渲染器使用。
//
// 设计原则：
//   - CALL_PRE 表示"即将进入调用"，深度在渲染后 +1
//   - CALL 表示"调用已返回"，深度先 -1 再渲染
//   - FUNCTION_ENTER / FUNCTION_EXIT 不参与深度计算：
//     它们是被调者视角，不覆盖 native 函数，且与 CALL_PRE/CALL 总是成对出现在同一调用内，
//     两套事件混用会导致深度双重计数（bug 根源）。
//
// 注意：若输入流经过 trace-filter 过滤，可能缺少部分配对，深度可能偏差（符合预期）。

class DepthTracker {
    constructor() {
        this._depth = 0;
    }

    /** 在渲染前调用，返回此事件应使用的深度 */
    depthFor(record) {
        // 进入调用：CALL_PRE — 先用当前深度渲染，再递增
        if (record.type === 'CALL_PRE') {
            const d = this._depth;
            this._depth++;
            return d;
        }
        // 退出调用：CALL — 先递减，再用新深度渲染
        if (record.type === 'CALL') {
            this._depth = Math.max(0, this._depth - 1);
            return this._depth;
        }
        // FUNCTION_ENTER / FUNCTION_EXIT 不影响深度，作为附加信息按当前深度渲染
        return this._depth;
    }
}

// ── 主程序 ─────────────────────────────────────────────────────────────────────

function printHelp() {
    process.stdout.write(`
trace-render.mjs — 将结构化 NDJSON 渲染为各种展示格式

用法：
  node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs
  node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree
  node tools/trace-render.mjs --format block parsed.ndjson

选项：
  --format FORMAT   输出格式（默认 flat）
                      flat   平铺流式
                      tree   Unicode 树形符号（┬ / └ / │）
                      block  #region/#endregion 折叠块（VS Code 可折叠）
                      pipe   ASCII pipe 符号（| 数量 = 调用深度）
  --no-seq          不输出 seq 编号前缀（保留选项，目前始终输出 seq）
  --help            显示帮助信息

输入格式：
  trace-parse.mjs 输出的 NDJSON（JTB1 事件类型）
  事件类型：SCRIPT_ENTER, SCRIPT_EXIT, CALL_PRE, CALL,
            FUNCTION_ENTER, FUNCTION_EXIT, END_EXPR, KEY_EVENT

示例：
  # 以树形格式查看完整调用链
  node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format tree

  # 带 smap 解析源码位置后渲染
  node tools/trace-parse.mjs trace.bin --smap trace.smap.json | node tools/trace-render.mjs --format tree

  # 先过滤再渲染
  node tools/trace-parse.mjs trace.bin \\
    | node tools/trace-filter.mjs --type CALL_PRE \\
    | node tools/trace-render.mjs --format pipe

  # 生成 VS Code 可折叠的 block 格式
  node tools/trace-parse.mjs trace.bin | node tools/trace-render.mjs --format block > trace.log

注意：
  tree / block / pipe 格式统一以 CALL_PRE/CALL 配对实时推导调用深度。
  FUNCTION_ENTER/FUNCTION_EXIT 不参与深度计算，按当前深度平铺输出。
  若输入已被 trace-filter 过滤（破坏了配对），层次可能不完整，这是预期行为。
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    const fmtIdx = args.indexOf('--format');
    const format = fmtIdx >= 0 ? (args[fmtIdx + 1] ?? 'flat') : 'flat';

    const validFormats = ['flat', 'tree', 'block', 'pipe'];
    if (!validFormats.includes(format)) {
        process.stderr.write(`错误：未知格式 "${format}"，可选值：${validFormats.join('、')}\n`);
        process.exit(1);
    }

    // 输入源：非 -- 开头、且不是 --format 的参数值的第一个参数视为文件路径
    const skipNext = new Set();
    if (fmtIdx >= 0) skipNext.add(fmtIdx + 1);
    const inputPath = args.find((a, i) => !a.startsWith('--') && !skipNext.has(i));

    const rl = createInterface({
        input: inputPath ? createReadStream(inputPath) : input,
        crlfDelay: Infinity,
    });

    const renderer = createRenderer(format);
    const tracker  = new DepthTracker();
    let total = 0;
    let rendered = 0;

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        total++;

        let record;
        try {
            record = JSON.parse(trimmed);
        } catch {
            // 无效 JSON：尝试原样透传（如果是文本行）
            process.stdout.write(trimmed + '\n');
            continue;
        }

        const depth = tracker.depthFor(record);
        const out   = renderer.render(record, depth);
        process.stdout.write(out + '\n');
        rendered++;
    }

    process.stderr.write(`# trace-render: 共处理 ${total} 条记录，输出 ${rendered} 行（格式：${format}）\n`);
}

main().catch(err => {
    process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
});
