#!/usr/bin/env node
/**
 * trace-render.mjs — 将结构化 NDJSON 渲染为各种展示格式
 *
 * 接收 trace-parse.mjs 输出的结构化 NDJSON，按指定风格渲染后输出到 stdout。
 *
 * 用法：
 *   cat parsed.ndjson | node tools/trace-render.mjs
 *   cat parsed.ndjson | node tools/trace-render.mjs --format tree
 *   cat parsed.ndjson | node tools/trace-render.mjs --format block
 *   cat parsed.ndjson | node tools/trace-render.mjs --format pipe
 *   cat parsed.ndjson | node tools/trace-render.mjs --format flat
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
 * 注意：tree / block / pipe 格式需要完整的 call/return 对才能正确重建层次；
 *       若上游 trace-filter 过滤掉了部分事件，深度重建可能不完整（这是预期行为）。
 */

import { createReadStream } from 'fs';
import { stdin as input } from 'process';
import { createInterface } from 'readline';

// ── 对齐常量（与运行时 traceFormatters.js 保持一致）─────────────────────────
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
 * FlatRenderer — 原样输出（保持 trace-parse 结构化后的文本表示）
 * 对于已有 text 字段的记录直接透传；否则重新格式化。
 */
class FlatRenderer {
    render(record, depth) {
        const seq = record.seq ?? '';
        const rc  = record.line != null ? `${record.line}:${record.col ?? 0}` : '?:?';

        switch (record.type) {
            case 'call': {
                const desc = _callDesc(record);
                const kv   = _callKv(record);
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] CALL ${desc}${kv ? ' ' + kv : ''}`;
            }
            case 'return': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? JSON.stringify(record.result) : '?';
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] RETN ${name} {"v":${v}}`;
            }
            case 'expr': {
                const src = record.src ?? `(seq=${seq})`;
                const kv  = _exprKv(record);
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${src}${kv ? ' ' + kv : ''}`;
            }
            case 'script_enter':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'script_exit': {
                const ex = record.exception != null
                    ? ` (exception: ${JSON.stringify(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            default:
                return record._raw ?? JSON.stringify(record);
        }
    }
}

/**
 * TreeRenderer — Unicode 树形符号
 *   ┬ 进入（call）
 *   └ 退出（return）
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
            case 'call': {
                const desc = _callDesc(record);
                const kv   = _callKv(record);
                const ind  = this._prefix(depth, '┬ ');
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${desc}${kv ? ' ; ' + kv : ''}`;
            }
            case 'return': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? serialize(record.result) : '?';
                const ind  = this._prefix(depth, '└ ');
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}return ${name} ; =${v}`;
            }
            case 'expr': {
                const src = record.src ?? `(seq=${seq})`;
                const kv  = _exprKvFlat(record);
                const ind = '│ '.repeat(depth);
                return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${src}${kv ? ' ; ' + kv : ''}`;
            }
            case 'script_enter':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'script_exit': {
                const ex = record.exception != null
                    ? ` (exception: ${serialize(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            default:
                return record._raw ?? JSON.stringify(record);
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
            case 'call': {
                const desc = _callDesc(record);
                const kv   = _callKv(record);
                const ind  = this._indent(depth);
                return `[${fmtSeq(seq)}] ${ind}// #region [${fmtRc(rc)}] CALL ${desc}${kv ? ' ; ' + kv : ''}`;
            }
            case 'return': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? serialize(record.result) : '?';
                const ind  = this._indent(depth);
                return `[${fmtSeq(seq)}] ${ind}// #endregion ${name} ; =${v}  [${fmtRc(rc)}]`;
            }
            case 'expr': {
                const src = record.src ?? `(seq=${seq})`;
                const kv  = _exprKvFlat(record);
                const ind = '  '.repeat(Math.max(depth - 1, 0));
                return `[${fmtSeq(seq)}] ${ind}${src}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
            }
            case 'script_enter':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'script_exit': {
                const ex = record.exception != null
                    ? ` (exception: ${serialize(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            default:
                return record._raw ?? JSON.stringify(record);
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
            case 'call': {
                const desc = _callDesc(record);
                const kv   = _callKv(record);
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${desc} [${fmtRc(rc)}]${kv ? ' ; ' + kv : ''}`;
            }
            case 'return': {
                const name = record.fn ?? '(anonymous)';
                const v    = record.result !== undefined ? serialize(record.result) : '?';
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${name} RETN ; =${v}  [${fmtRc(rc)}]`;
            }
            case 'expr': {
                const src = record.src ?? `(seq=${seq})`;
                const kv  = _exprKvFlat(record);
                return `[${fmtSeq(seq)}] ${this._pipes(depth)}${src}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
            }
            case 'script_enter':
                return `[${fmtSeq(seq)}] ▶ script: ${record.file ?? '?'}`;
            case 'script_exit': {
                const ex = record.exception != null
                    ? ` (exception: ${serialize(record.exception)})`
                    : '';
                return `[${fmtSeq(seq)}] ◀ script end${ex}`;
            }
            default:
                return record._raw ?? JSON.stringify(record);
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

/** 从 call 记录生成描述字符串 */
function _callDesc(record) {
    const name = record.fn ?? '(anonymous)';
    const n    = record.args ?? 0;
    if (record.isConstructor) return `new ${name}(${n} args)`;
    return `${name}(${n} args)`;
}

/** 从 call 记录生成 kv 字符串（用于 flat 格式：保留 JSON） */
function _callKv(record) {
    if (!record.kv && !record.a) return '';
    if (record.kv && typeof record.kv === 'object') {
        return JSON.stringify(record.kv);
    }
    // 兼容旧格式
    const parts = [];
    if (record.this !== undefined) parts.push(`this=${serialize(record.this)}`);
    if (Array.isArray(record.a)) {
        record.a.slice(0, 5).forEach((v, i) => parts.push(`arg${i}=${serialize(v)}`));
        if (record.a.length > 5) parts.push('...');
    }
    return parts.join(', ');
}

/** 从 expr 记录生成 kv JSON 字符串（用于 flat 格式） */
function _exprKv(record) {
    const obj = {};
    if (record.w && Object.keys(record.w).length > 0) obj.w = record.w;
    if (record.r && Object.keys(record.r).length > 0) obj.r = record.r;
    if (record.f && record.f.length > 0) obj.f = record.f;
    if (record.kv && typeof record.kv === 'object' && Object.keys(record.kv).length > 0) {
        return JSON.stringify(record.kv);
    }
    return Object.keys(obj).length > 0 ? JSON.stringify(obj) : '';
}

/** 从 expr 记录生成扁平文本 kv 字符串（用于 tree/block/pipe 格式，更易读） */
function _exprKvFlat(record) {
    const parts = [];

    // 写入变量
    const w = record.w;
    if (w && typeof w === 'object') {
        for (const [k, v] of Object.entries(w)) {
            parts.push(`${k}=${serialize(v)}`);
        }
    }

    // 读取变量
    const r = record.r;
    if (r && typeof r === 'object') {
        const written = new Set(w ? Object.keys(w) : []);
        for (const [k, v] of Object.entries(r)) {
            if (!written.has(k)) parts.push(`${k}=${serialize(v)}`);
        }
    }

    // 属性访问
    const f = record.f;
    if (Array.isArray(f)) {
        for (const fi of f) {
            const key = fi.isComputed ? `[${fi.offset}]` : `.${fi.offset}`;
            parts.push(`${fi.base}${key}=${serialize(fi.val)}`);
        }
    }

    // 兼容旧 kv 字符串格式
    if (!parts.length && record.kv) {
        if (typeof record.kv === 'string') return record.kv;
        if (typeof record.kv === 'object') {
            for (const [k, v] of Object.entries(record.kv)) {
                parts.push(`${k}=${serialize(v)}`);
            }
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
// 从 call/return 事件对实时维护当前调用深度，供渲染器使用。
// 注意：若输入流经过 trace-filter 过滤，可能缺少部分配对，深度可能偏差（符合预期）。

class DepthTracker {
    constructor() {
        this._depth = 0;
    }

    /** 在渲染前调用，返回此事件应使用的深度 */
    depthFor(record) {
        if (record.type === 'call') {
            const d = this._depth;
            this._depth++;
            return d;
        }
        if (record.type === 'return') {
            this._depth = Math.max(0, this._depth - 1);
            return this._depth;
        }
        return this._depth;
    }
}

// ── 主程序 ─────────────────────────────────────────────────────────────────────

function printHelp() {
    process.stdout.write(`
trace-render.mjs — 将结构化 NDJSON 渲染为各种展示格式

用法：
  cat parsed.ndjson | node tools/trace-render.mjs
  cat parsed.ndjson | node tools/trace-render.mjs --format tree
  node tools/trace-render.mjs --format block parsed.ndjson

选项：
  --format FORMAT   输出格式（默认 flat）
                      flat   平铺流式（与原始 trace 相同的布局）
                      tree   Unicode 树形符号（┬ / └ / │）
                      block  #region/#endregion 折叠块（VS Code 可折叠）
                      pipe   ASCII pipe 符号（| 数量 = 调用深度）
  --no-seq          不输出 seq 编号前缀（仅供参考，目前保留 seq）
  --help            显示帮助信息

示例：
  # 以树形格式查看完整调用链
  cat trace.ndjson | node tools/trace-parse.mjs | node tools/trace-render.mjs --format tree

  # 只看 decode 相关调用的调用树
  cat trace.ndjson \\
    | node tools/trace-parse.mjs \\
    | node tools/trace-filter.mjs --fn "*decode*" \\
    | node tools/trace-render.mjs --format tree

  # 生成 VS Code 可折叠的 block 格式
  cat trace.ndjson | node tools/trace-parse.mjs | node tools/trace-render.mjs --format block > trace.log

注意：
  tree / block / pipe 格式根据 call/return 配对实时推导调用深度。
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
