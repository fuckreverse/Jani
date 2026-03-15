// JALANGI DO NOT INSTRUMENT

/**
 * @file Jani 默认配置。
 *
 * 所有字段的默认值在此定义：
 *  - 布尔型字段（DEBUG / WARN 等）：false
 *  - 插桩选择器（INSTR_READ 等）：null/undefined 表示"全部插桩"
 *    设为函数 (name, ast) => boolean 可细粒度控制
 *  - ENABLE_SAMPLING：false（不启用采样模式）
 *
 * 使用方式：
 *   import { Config } from './Config.js';
 *   // 或覆盖某些字段：
 *   import { makeConfig } from './Config.js';
 *   const cfg = makeConfig({ INSTR_READ: false });
 */

/** 默认配置对象（只读）。 */
export const Config = Object.freeze({
    DEBUG:                  false,
    WARN:                   false,
    SERIOUS_WARN:           false,
    /** 日志缓冲区大小上限（略小于 2^16，为低层开销预留空间）。 */
    MAX_BUF_SIZE:           64000,
    LOG_ALL_READS_AND_BRANCHES: false,

    // ── 插桩选择器 ────────────────────────────────────────────────────────────
    // null / undefined 表示"全部插桩"；
    // 设为函数 (name, ast) => boolean 可细粒度控制。

    ENABLE_SAMPLING:        false,
    INSTR_INIT:             null,
    INSTR_READ:             null,
    INSTR_WRITE:            null,
    INSTR_GETFIELD:         null,
    INSTR_PUTFIELD:         null,
    INSTR_BINARY:           null,
    INSTR_PROPERTY_BINARY_ASSIGNMENT: null,
    INSTR_UNARY:            null,
    INSTR_LITERAL:          null,
    INSTR_CONDITIONAL:      null,
    INSTR_TRY_CATCH_ARGUMENTS: null,
    INSTR_END_EXPRESSION:   null,
});

/**
 * 创建一个自定义配置对象（浅合并默认值）。
 *
 * @param {object} [overrides={}]  要覆盖的字段
 * @returns {object}  合并后的配置（普通对象，非冻结）
 *
 * @example
 * const cfg = makeConfig({ INSTR_READ: (name, ast) => name !== 'x' });
 */
export function makeConfig(overrides = {}) {
    return { ...Config, ...overrides };
}
