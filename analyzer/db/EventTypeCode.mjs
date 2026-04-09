/**
 * EventTypeCode.mjs — events.type 整数编码双向映射（Phase D）
 *
 * 编码值与 EventSerializer.js 的 EVENT_TYPE 字节值保持一致，
 * 避免两套命名体系不一致导致 encodeType() 返回 0（UNKNOWN）。
 *
 *   0x00 = UNKNOWN（未知/迁移时遇到的新类型）
 *   0x01 = SCRIPT_ENTER
 *   0x02 = SCRIPT_EXIT
 *   0x03 = CALL_PRE
 *   0x04 = CALL
 *   0x05 = FUNCTION_ENTER
 *   0x06 = FUNCTION_EXIT
 *   0x07 = END_EXPR
 *   0x08 = KEY_EVENT
 *   0x09 = DICT_ENTRY
 *   0x0B = WRITE_VAR
 *   0x0C = READ_VAR_FULL
 *
 * 使用方式：
 *   import { encodeType, decodeType, TYPE } from '../db/EventTypeCode.mjs';
 *   stmtEvent.run(encodeType(event.type), ...);   // 写入
 *   const typeStr = decodeType(row.type);          // 读出
 */

/** 字符串 → 整数（与 EventSerializer.EVENT_TYPE 字节值对齐）*/
export const TYPE = Object.freeze({
    UNKNOWN:        0x00,
    SCRIPT_ENTER:   0x01,
    SCRIPT_EXIT:    0x02,
    CALL_PRE:       0x03,
    CALL:           0x04,
    FUNCTION_ENTER: 0x05,
    FUNCTION_EXIT:  0x06,
    END_EXPR:       0x07,
    KEY_EVENT:      0x08,
    DICT_ENTRY:     0x09,
    WRITE_VAR:      0x0B,
    READ_VAR_FULL:  0x0C,
});

/** 整数 → 字符串（稀疏映射，支持非连续编码值）*/
const _DECODE = {};
for (const [k, v] of Object.entries(TYPE)) _DECODE[v] = k;

/**
 * 将事件类型字符串编码为整数。
 * 未知类型返回 0（UNKNOWN），不抛出异常。
 */
export function encodeType(typeStr) {
    const code = TYPE[typeStr];
    return code !== undefined ? code : 0;
}

/**
 * 将整数编码解码为事件类型字符串。
 * 超出范围返回 'UNKNOWN'。
 */
export function decodeType(code) {
    return _DECODE[code] ?? 'UNKNOWN';
}
