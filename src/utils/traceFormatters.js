// JALANGI DO NOT INSTRUMENT

/**
 * @file traceFormatters —— 执行 trace 的格式化策略。
 *
 * 运行时只使用 FORMAT_FLAT（平铺流式，无缩进，每事件立即输出）。
 * 其他展示风格（tree / block / pipe）由离线工具 trace-render.mjs 负责转换。
 *
 * 导出：
 *   SEQ_WIDTH, RC_WIDTH                — 对齐宽度常量
 *   fmtSeq(seq)    → 右对齐固定宽度 seq 字符串
 *   fmtRc(rc)      → 右对齐固定宽度 rc 字符串
 *   FlatFormatter  — 平铺流式格式（运行时唯一格式）
 */

// ── 对齐宽度常量 ──────────────────────────────────────────────────────────────
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

// ── FlatFormatter ─────────────────────────────────────────────────────────────
//
// 运行时唯一使用的格式：平铺流式，无缩进，每条事件独立一行，立即输出。
// 统一格式：[seq] [line:col] 描述 {json}
//
// 输出示例：
//   [     1] [     1:1] CALL foo(2 args) {"a":[...]}
//   [     2] [     1:1] RETN foo {"v":42}
//   [     3] [     2:1] x = 1 + 2 {"w":{"x":3},"r":{"y":1}}

export class FlatFormatter {
    callLine(seq, rc, _depth, desc, kvStr) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] CALL ${desc}${kvStr ? ' ; ' + kvStr : ''}`;
    }

    callLineJson(seq, rc, _depth, desc, kvJson) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] CALL ${desc} ${kvJson}`;
    }

    retLine(seq, rc, _depth, name, result) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] RETN ${name} ; =${result}`;
    }

    retLineJson(seq, rc, _depth, name, kvJson) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] RETN ${name} ${kvJson}`;
    }

    infoLine(seq, rc, _depth, srcText, kv) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${srcText}${kv ? ' ; ' + kv : ''}`;
    }

    infoLineJson(seq, rc, _depth, srcText, kvJson) {
        return `[${fmtSeq(seq)}] [${fmtRc(rc)}] ${srcText} ${kvJson}`;
    }
}
