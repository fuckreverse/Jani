/**
 * A8_ValuePatternDetector.mjs — 魔术常数 / 固定值检测
 * 依赖：F1-EventIndex（writes 表已填充）
 *
 * 扫描所有 writes 值，检测高频值和已知密码学魔术常数，写入 value_patterns 表。
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

// ─── 已知密码学魔术常数映射（十进制字符串 / 十六进制字符串 → 常数名）────────

const CRYPTO_CONSTANTS = new Map([
    // MD5 初始向量（有符号/无符号两种表示）
    ['1732584193',   'MD5_INIT_A'],         // 0x67452301
    ['4023233417',   'MD5_INIT_B'],         // 0xefcdab89 (unsigned)
    ['-271733879',   'MD5_INIT_B_signed'],
    ['2562383102',   'MD5_INIT_C'],         // 0x98badcfe (unsigned)
    ['-1732584194',  'MD5_INIT_C_signed'],
    ['271733878',    'MD5_INIT_D'],         // 0x10325476
    // SHA1 特有常数（H4）
    ['3275728899',   'SHA1_H4'],            // 0xc3d2e1f0 (unsigned)
    ['1359893119',   'SHA1_H4_alt'],        // sometimes seen as signed fragment
    // SHA-256 初始向量
    ['1779033703',   'SHA256_H0'],          // 0x6a09e667
    ['3144134277',   'SHA256_H1'],          // 0xbb67ae85 (unsigned)
    ['-1150833019',  'SHA256_H1_signed'],
    ['1013904242',   'SHA256_H2'],          // 0x3c6ef372
    ['2773480762',   'SHA256_H3'],          // 0xa54ff53a (unsigned)
    ['-1521565514',  'SHA256_H3_signed'],
    ['1359893119',   'SHA256_H4'],          // 0x510e527f (unsigned) — also 0x51...
    ['2600822924',   'SHA256_H5'],          // 0x9b05688c (unsigned)
    ['528734635',    'SHA256_H6'],          // 0x1f83d9ab
    ['1541325730',   'SHA256_H7'],          // 0x5be0cd19
    // 十六进制字符串形式（JS 代码中直接写 0x... 的情况）
    ['0x67452301',   'MD5/SHA1_INIT'],
    ['0xefcdab89',   'MD5/SHA1_INIT'],
    ['0x98badcfe',   'MD5/SHA1_INIT'],
    ['0x10325476',   'MD5/SHA1_INIT'],
    ['0xc3d2e1f0',   'SHA1_INIT'],
    ['0x6a09e667',   'SHA256_H0'],
    ['0xbb67ae85',   'SHA256_H1'],
    ['0x3c6ef372',   'SHA256_H2'],
    ['0xa54ff53a',   'SHA256_H3'],
]);

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 检测单个值是否匹配已知密码学常数
 * @param {*} value
 * @returns {string|null} 常数名，或 null
 */
function detectConstant(value) {
    if (value === null || value === undefined) return null;

    const str = String(value).trim().replace(/^"|"$/g, '');

    // 直接匹配整数/十六进制字符串
    if (CRYPTO_CONSTANTS.has(str)) return CRYPTO_CONSTANTS.get(str);

    // Base64 字符集
    if (str === BASE64_CHARS || str === BASE64_CHARS + '=') return 'BASE64_CHARSET';

    // 尝试 JSON 解析为数组，检测 AES key 长度 / RC4 S-box
    if (str.startsWith('[')) {
        try {
            const arr = JSON.parse(str);
            if (Array.isArray(arr)) {
                if ((arr.length === 16 || arr.length === 32) &&
                    arr.every(n => typeof n === 'number' && n >= 0 && n <= 255)) {
                    return arr.length === 16 ? 'AES_KEY_128' : 'AES_KEY_256';
                }
                if (arr.length === 256 &&
                    arr.every(n => typeof n === 'number')) {
                    return 'RC4_SBOX_CANDIDATE';
                }
            }
        } catch { /* not valid JSON array */ }
    }

    return null;
}

export default class A8ValuePatternDetector extends BasePlugin {
    static id = 'A8-ValuePatternDetector';
    static deps = ['F1-EventIndex'];
    static description = '检测高频魔术常数和密码学特征值，写入 value_patterns 表';
    static displayName = 'A8 · ValuePatternDetector';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);

        // 迁移兼容：确保表有 var_name、line 列
        try {
            db.exec(`
                DROP TABLE IF EXISTS value_patterns;
                CREATE TABLE IF NOT EXISTS value_patterns (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id      TEXT NOT NULL,
                    value_hash      TEXT,
                    count           INTEGER DEFAULT 0,
                    first_seq       INTEGER,
                    iid             INTEGER,
                    var_name        TEXT,
                    line            INTEGER,
                    matched_constant TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_value_patterns_session ON value_patterns(session_id);
            `);
        } catch (e) {
            db.run('DELETE FROM value_patterns WHERE session_id = ?', [sessionId]);
        }

        this.emitProgress(ctx, '扫描 writes 值...', 5);

        // 按 value 分组统计（TOP 2000 高频值 + 可能的魔术常数）
        const valueStats = db.all(
            `SELECT value, COUNT(*) AS count, MIN(event_id) AS first_seq
             FROM writes
             WHERE session_id = ? AND value IS NOT NULL
             GROUP BY value
             ORDER BY count DESC
             LIMIT 2000`,
            [sessionId]
        );

        this.emitProgress(ctx, `分析 ${valueStats.length} 个唯一值...`, 30);

        const toInsert = [];
        for (const vs of valueStats) {
            const matched = detectConstant(vs.value);

            // 保留条件：出现 >= 2 次，或匹配到已知密码学常数
            if (vs.count < 2 && !matched) continue;

            // 获取 iid / line / var_name（只取第一次出现）
            const detail = db.get(
                `SELECT e.iid, e.line, w.name
                 FROM writes w
                 JOIN events e ON w.event_id = e.id
                 WHERE w.session_id = ? AND w.value = ?
                 LIMIT 1`,
                [sessionId, vs.value]
            );

            toInsert.push([
                sessionId,
                String(vs.value).substring(0, 64), // value_hash（截取前 64 字符作指纹）
                vs.count,
                vs.first_seq,
                detail?.iid ?? null,
                detail?.name ?? null,
                detail?.line ?? null,
                matched ?? null,
            ]);
        }

        this.emitProgress(ctx, `写入 ${toInsert.length} 条模式...`, 70);

        if (toInsert.length > 0) {
            db.transaction(() => {
                for (const row of toInsert) {
                    db.run(
                        'INSERT INTO value_patterns (session_id, value_hash, count, first_seq, iid, var_name, line, matched_constant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        row
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，${toInsert.length} 个模式`, 100);
        this.emitDone(ctx, { patternCount: toInsert.length });
    }
}
