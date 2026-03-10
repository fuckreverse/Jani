// JALANGI DO NOT INSTRUMENT

/**
 * @file traceFormatters —— 执行 trace 的格式化策略（多种输出风格）。
 *
 * 支持四种格式（通过 createFormatter(format) 选择）：
 *
 *   FORMAT_FLAT  (8) — 平铺流式，无缩进，每事件立即输出（默认）
 *   FORMAT_TREE  (1) — Unicode 树形符号（┬ │ └），seq/rc 固定宽度对齐
 *   FORMAT_BLOCK (2) — #region/#endregion 折叠块（VS Code 任意文件可折叠）
 *   FORMAT_PIPE  (4) — ASCII pipe 符号（| 数量 = 调用深度）
 *
 * 所有 Formatter 实现相同的三个方法接口：
 *   callLine(seq, rc, depth, desc, kvStr)   → 调用行字符串
 *   retLine (seq, rc, depth, name, result)  → 返回行字符串
 *   infoLine(seq, rc, depth, srcText, kv)   → 普通 write/return/throw/纯副作用行字符串
 *
 * depth = 调用栈深度（从 1 开始；depth=1 表示顶层调用）
 *
 * 导出：
 *   FORMAT_FLAT, FORMAT_TREE, FORMAT_BLOCK, FORMAT_PIPE  — 格式常量
 *   SEQ_WIDTH, RC_WIDTH                                   — 对齐宽度常量
 *   fmtSeq(seq)      → 右对齐固定宽度 seq 字符串
 *   fmtRc(rc)        → 右对齐固定宽度 rc 字符串
 *   TreeFormatter    — Unicode 树形格式
 *   BlockFormatter   — #region/#endregion 折叠格式
 *   PipeFormatter    — ASCII pipe 格式
 *   FlatFormatter    — 平铺流式格式（默认）
 *   createFormatter(format)  → Formatter 实例
 */

// ── 格式常量 ──────────────────────────────────────────────────────────────────
export const FORMAT_TREE  = 1;
export const FORMAT_BLOCK = 2;
export const FORMAT_PIPE  = 4;
export const FORMAT_FLAT  = 8;

// seq 显示宽度（右对齐）：超过此宽度会自动溢出，不截断
export const SEQ_WIDTH = 6;
// rc（行:列）显示宽度（右对齐，含冒号）
export const RC_WIDTH  = 9;

// ── 对齐工具 ──────────────────────────────────────────────────────────────────

/** 格式化 seq：右对齐，固定 SEQ_WIDTH 位 */
export function fmtSeq(seq) {
    return String(seq).padStart(SEQ_WIDTH);
}

/** 格式化 rc（行:列）：右对齐，固定 RC_WIDTH 位 */
export function fmtRc(rc) {
    return rc.padStart(RC_WIDTH);
}

// ── Formatter 策略类 ──────────────────────────────────────────────────────────

export class TreeFormatter {
    // ┬ 表示进入（call），└ 表示退出（return），│ 是延续线
    _treePrefix(depth, tip) {
        if (depth <= 0) return tip;
        return '│ '.repeat(depth - 1) + tip;
    }

    callLine(seq, rc, depth, desc, kvStr) {
        const ind = this._treePrefix(depth, '┬ ');
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${desc}${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, depth, name, result) {
        const ind = this._treePrefix(depth, '└ ');
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}return ${name} =${result}`;
    }

    infoLine(seq, rc, depth, srcText, kv) {
        const ind = '│ '.repeat(depth);
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${ind}${srcText}${kv ? ' ; ' + kv : ''}`;
    }
}

export class BlockFormatter {
    // #region / #endregion 风格：VS Code 在任何文件中识别这两个关键字并提供折叠
    // 每层用 2 空格缩进
    _indent(depth) {
        return '  '.repeat(depth);
    }

    callLine(seq, rc, depth, desc, kvStr) {
        const ind = this._indent(depth - 1); // depth 从 1 起，depth-1 对应父层缩进
        return `[${fmtSeq(seq)}] ${ind}// #region [${fmtRc(rc)}] CALL ${desc}${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, depth, name, result) {
        const ind = this._indent(depth - 1);
        return `[${fmtSeq(seq)}] ${ind}// #endregion ${name} =${result}  [${fmtRc(rc)}]`;
    }

    infoLine(seq, rc, depth, srcText, kv) {
        const ind = this._indent(depth > 0 ? depth - 1 : 0);
        return `[${fmtSeq(seq)}] ${ind}${srcText}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
    }
}

export class PipeFormatter {
    // | 数量 = depth，纯 ASCII
    _pipes(depth) {
        return '| '.repeat(depth);
    }

    callLine(seq, rc, depth, desc, kvStr) {
        return `[${fmtSeq(seq)}] ${this._pipes(depth)}${desc} [${fmtRc(rc)}]${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, depth, name, result) {
        return `[${fmtSeq(seq)}] ${this._pipes(depth)}${name} RETN =${result}  [${fmtRc(rc)}]`;
    }

    infoLine(seq, rc, depth, srcText, kv) {
        return `[${fmtSeq(seq)}] ${this._pipes(depth)}${srcText}${kv ? ' ; ' + kv : ''}  [${fmtRc(rc)}]`;
    }
}

export class FlatFormatter {
    // 平铺流式格式：无缩进，无调用栈表示，每条事件独立一行，立即输出。
    // CALL 标记函数进入，RETN 标记函数返回；info 行直接输出源码文本。
    // depth 参数保留接口兼容但不使用。

    callLine(seq, rc, _depth, desc, kvStr) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] CALL ${desc}${kvStr ? ' ' + kvStr : ''}`;
    }

    retLine(seq, rc, _depth, name, result) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] RETN ${name} =${result}`;
    }

    infoLine(seq, rc, _depth, srcText, kv) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${srcText}${kv ? ' ; ' + kv : ''}`;
    }
}

/**
 * 根据格式代号返回对应的 Formatter 实例。
 * @param {number} format  FORMAT_TREE(1) | FORMAT_BLOCK(2) | FORMAT_PIPE(4) | FORMAT_FLAT(8)
 * @returns {TreeFormatter|BlockFormatter|PipeFormatter|FlatFormatter}
 */
export function createFormatter(format) {
    if (format === FORMAT_TREE)  return new TreeFormatter();
    if (format === FORMAT_BLOCK) return new BlockFormatter();
    if (format === FORMAT_PIPE)  return new PipeFormatter();
    return new FlatFormatter(); // 默认 FORMAT_FLAT
}
