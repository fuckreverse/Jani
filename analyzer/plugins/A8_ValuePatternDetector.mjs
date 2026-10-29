/**
 * A8_ValuePatternDetector.mjs — 魔术常数 / 固定值检测
 * 依赖：F1-EventIndex（writes 表已填充）
 *
 * 扫描所有 writes 值，检测高频值和已知密码学魔术常数，写入 value_patterns 表。
 * v2：新增 pattern_type 字段（语义类型标签），涵盖：
 *   timestamp_ms · timestamp_s · uuid · hex_str · base64_charset · custom_alphabet
 *   base64_encoded · ip_addr · url · json_obj · byte_array
 *
 * 性能优化：
 *  - 用一次批量 JOIN 替代对每个 valueStats 的 N 次 db.get
 *  - 使用 prepared statement + 单事务批量 INSERT
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

// ─── 已知密码学魔术常数映射（十进制字符串 / 十六进制字符串 → 常数名）────────

const CRYPTO_CONSTANTS = new Map([
    // ── MD5 初始向量（有符号 / 无符号两种表示）────────────────────────────────
    ['1732584193',   'MD5_INIT_A'],         // 0x67452301
    ['4023233417',   'MD5_INIT_B'],         // 0xefcdab89 (unsigned)
    ['-271733879',   'MD5_INIT_B_signed'],
    ['2562383102',   'MD5_INIT_C'],         // 0x98badcfe (unsigned)
    ['-1732584194',  'MD5_INIT_C_signed'],
    ['271733878',    'MD5_INIT_D'],         // 0x10325476

    // ── SHA-1 特有常数 ──────────────────────────────────────────────────────
    ['3275728899',   'SHA1_H4'],            // 0xc3d2e1f0 (unsigned)
    ['-1019287297',  'SHA1_H4_signed'],     // signed form
    // SHA-1 K 常数（四个轮常量）
    ['1518500249',   'SHA1_K0'],            // 0x5a827999
    ['1859775393',   'SHA1_K1'],            // 0x6ed9eba1
    ['2400959708',   'SHA1_K2'],            // 0x8f1bbcdc (unsigned)
    ['-1894007588',  'SHA1_K2_signed'],
    ['3395469782',   'SHA1_K3'],            // 0xca62c1d6 (unsigned)
    ['-899497514',   'SHA1_K3_signed'],

    // ── SHA-256 初始向量（H0~H7）──────────────────────────────────────────
    ['1779033703',   'SHA256_H0'],          // 0x6a09e667
    ['3144134277',   'SHA256_H1'],          // 0xbb67ae85 (unsigned)
    ['-1150833019',  'SHA256_H1_signed'],
    ['1013904242',   'SHA256_H2'],          // 0x3c6ef372
    ['2773480762',   'SHA256_H3'],          // 0xa54ff53a (unsigned)
    ['-1521565514',  'SHA256_H3_signed'],
    ['1359893119',   'SHA256_H4'],          // 0x510e527f
    ['2600822924',   'SHA256_H5'],          // 0x9b05688c (unsigned)
    ['-1694144372',  'SHA256_H5_signed'],
    ['528734635',    'SHA256_H6'],          // 0x1f83d9ab
    ['1541325730',   'SHA256_H7'],          // 0x5be0cd19
    // SHA-256 前 16 个 K 常数（高频出现）
    ['428170699',    'SHA256_K0'],          // 0x428a2f98
    ['1894007588',   'SHA256_K1'],          // 0x71374491
    ['2894946572',   'SHA256_K2'],          // 0xb5c0fbcf (unsigned)
    ['3275897780',   'SHA256_K3'],          // 0xe9b5dba5 (unsigned)
    ['3122155533',   'SHA256_K4'],
    ['1222224768',   'SHA256_K5'],
    ['373957723',    'SHA256_K6'],
    ['2798278063',   'SHA256_K7'],          // 0xab1c5ed5 (unsigned)

    // ── SHA-512 初始向量（64 位，JS 中拆高/低 32 位存储）──────────────────
    ['4089179400',   'SHA512_H0_lo'],
    ['-205787896',   'SHA512_H0_lo_signed'],
    ['2228188987',   'SHA512_H1_lo'],
    ['4270250539',   'SHA512_H2_lo'],
    ['-24716757',    'SHA512_H2_lo_signed'],
    ['1595546353',   'SHA512_H3_lo'],
    ['2917268177',   'SHA512_H4_lo'],
    ['-1377699119',  'SHA512_H4_lo_signed'],
    ['724688927',    'SHA512_H5_lo'],
    ['4215011691',   'SHA512_H6_lo'],
    ['-79955605',    'SHA512_H6_lo_signed'],
    ['326615417',    'SHA512_H7_lo'],

    // ── SHA-3 / Keccak 轮常数 ─────────────────────────────────────────────
    // RC0=1 太普通，不单独列入；从 RC1 开始有识别意义
    ['32898',        'KECCAK_RC1'],
    ['32907',        'KECCAK_RC2'],
    ['2147516416',   'KECCAK_RC3'],
    ['32768',        'KECCAK_RC4'],
    ['2147483649',   'KECCAK_RC5'],
    ['2147516419',   'KECCAK_RC6'],
    ['2147483777',   'KECCAK_RC7'],
    ['1088',         'KECCAK_RATE_256'],
    ['832',          'KECCAK_RATE_512'],
    // KECCAK_BLOCK_256=136, KECCAK_BLOCK_512=104 太小，不单独列入

    // ── RIPEMD-160 ────────────────────────────────────────────────────────
    ['1732584193',   'RIPEMD160_H0'],
    ['4023233417',   'RIPEMD160_H1'],
    ['2562383102',   'RIPEMD160_H2'],
    ['271733878',    'RIPEMD160_H3'],
    ['3285377520',   'RIPEMD160_H4'],
    ['1518500249',   'RIPEMD160_KL1'],
    ['1859775393',   'RIPEMD160_KL2'],
    ['2400959708',   'RIPEMD160_KL3'],
    ['2840853838',   'RIPEMD160_KL4'],
    ['1352829926',   'RIPEMD160_KR0'],
    ['1548603684',   'RIPEMD160_KR1'],
    ['1836072691',   'RIPEMD160_KR2'],
    ['2053994217',   'RIPEMD160_KR3'],

    // ── DES / 3DES ─────────────────────────────────────────────────────────
    // 注意：56/64/8/58/50/42/34/32/1/16/7 均为普通小整数，不单独列入
    // DES 的真正特征通过数组检测（DES_IP_TABLE / DES_SBOX_CANDIDATE）识别

    // ── AES ────────────────────────────────────────────────────────────────
    // 注意：AES Rcon 表值（1/2/4/8/16/27/54）全是普通小整数，不单独列入
    // AES 真正的特征通过数组检测（AES_SBOX / AES_INV_SBOX / AES_KEY_128/256）识别
    // AES_SBOX 首字节 99 也太普通，不单独列入

    // ── Blowfish ──────────────────────────────────────────────────────────
    ['608135816',    'BLOWFISH_P0'],
    ['2242054355',   'BLOWFISH_P1'],
    ['-2052912941',  'BLOWFISH_P1_signed'],
    ['3320641453',   'BLOWFISH_P2'],
    ['-974325843',   'BLOWFISH_P2_signed'],
    ['3111242100',   'BLOWFISH_P3'],
    ['-1183725196',  'BLOWFISH_P3_signed'],
    ['2420952060',   'BLOWFISH_P4'],
    ['3509652390',   'BLOWFISH_S0_0'],
    ['-785314906',   'BLOWFISH_S0_0_signed'],
    ['2564797795',   'BLOWFISH_S0_1'],
    ['-1730169501',  'BLOWFISH_S0_1_signed'],

    // ── ChaCha20 / Salsa20 ────────────────────────────────────────────────
    ['1634760805',   'CHACHA20_CONST0'],
    ['857760878',    'CHACHA20_CONST1'],
    ['2036477234',   'CHACHA20_CONST2'],
    ['1797285236',   'CHACHA20_CONST3'],
    ['1634760805',   'SALSA20_CONST0'],
    ['857760878',    'SALSA20_CONST1'],
    ['2036477234',   'SALSA20_CONST2'],
    ['1797285236',   'SALSA20_CONST3'],
    // CHACHA20_BLOCK_BYTES=64, CHACHA20_ROUNDS=20 均为普通小整数，不单独列入

    // ── CRC-32 ─────────────────────────────────────────────────────────────
    ['3988292384',   'CRC32_POLY'],
    ['-306674912',   'CRC32_POLY_signed'],
    ['79764919',     'CRC32_POLY_NORM'],
    ['4294967295',   'CRC32_INIT'],
    // CRC32_INIT_signed=-1 太普通，不列入
    // CRC32_TABLE_0=0 太普通，不列入
    ['1996959894',   'CRC32_TABLE_1'],
    ['3993919788',   'CRC32_TABLE_2'],

    // ── CRC-16 ─────────────────────────────────────────────────────────────
    ['33800',        'CRC16_POLY_CCITT'],
    ['4129',         'CRC16_POLY_IBM'],
    ['40961',        'CRC16_POLY_DNP'],

    // ── CRC-64 ─────────────────────────────────────────────────────────────
    ['3921903700',   'CRC64_POLY_LO'],

    // ── HMAC ───────────────────────────────────────────────────────────────
    // HMAC_IPAD=0x36(54), HMAC_OPAD=0x5C(92) 均为普通小整数，不单独列入
    // HMAC 通过 XOR 模式 + 哈希调用特征识别，无需魔术常数匹配

    // ── Whirlpool ──────────────────────────────────────────────────────────
    ['1819895653',   'WHIRLPOOL_RC0_HI'],
    ['3318131210',   'WHIRLPOOL_RC0_LO'],

    // ── GOST ───────────────────────────────────────────────────────────────
    // GOST_IV_ZERO=0, GOST_KEY_BITS=256, GOST_BLOCK_BITS=256 均为普通小整数，不单独列入
    // GOST 难以通过单个魔术常数识别，需要其他上下文特征

    // ── Tiger ──────────────────────────────────────────────────────────────
    ['258009956',    'TIGER_H0_LO'],
    ['2137672172',   'TIGER_H1_LO'],
    ['3370832035',   'TIGER_H2_LO'],
    ['2654435769',   'TIGER_CONST'],

    // ── Adler-32 ───────────────────────────────────────────────────────────
    ['65521',        'ADLER32_MOD'],

    // ── MurmurHash3 ────────────────────────────────────────────────────────
    ['3432918353',   'MURMUR3_C1'],
    ['-862048943',   'MURMUR3_C1_signed'],
    ['461845907',    'MURMUR3_C2'],
    ['2246822519',   'MURMUR3_FMIX1'],
    ['-2048049093',  'MURMUR3_FMIX1_signed'],
    ['3266489917',   'MURMUR3_FMIX2'],
    ['-1028477379',  'MURMUR3_FMIX2_signed'],

    // ── FNV Hash ──────────────────────────────────────────────────────────
    ['16777619',     'FNV32_PRIME'],
    ['2166136261',   'FNV32_OFFSET'],
    ['-2128831035',  'FNV32_OFFSET_signed'],

    // ── xxHash ─────────────────────────────────────────────────────────────
    ['2654435761',   'XXHASH32_P1'],
    ['2246822519',   'XXHASH32_P2'],
    ['3266489917',   'XXHASH32_P3'],
    ['668265263',    'XXHASH32_P4'],
    ['374761393',    'XXHASH32_P5'],

    // ── 十六进制字符串形式 ────────────────────────────────────────────────
    ['0x67452301',   'MD5/SHA1_INIT'],
    ['0xefcdab89',   'MD5/SHA1_INIT'],
    ['0x98badcfe',   'MD5/SHA1_INIT'],
    ['0x10325476',   'MD5/SHA1_INIT'],
    ['0xc3d2e1f0',   'SHA1_INIT'],
    ['0x6a09e667',   'SHA256_H0'],
    ['0xbb67ae85',   'SHA256_H1'],
    ['0x3c6ef372',   'SHA256_H2'],
    ['0xa54ff53a',   'SHA256_H3'],
    ['0x510e527f',   'SHA256_H4'],
    ['0x9b05688c',   'SHA256_H5'],
    ['0x1f83d9ab',   'SHA256_H6'],
    ['0x5be0cd19',   'SHA256_H7'],
    ['0x6a09e667',   'SHA512_H0_hi'],
    ['0xbb67ae85',   'SHA512_H1_hi'],
    ['0x3c6ef372',   'SHA512_H2_hi'],
    ['0xa54ff53a',   'SHA512_H3_hi'],
    ['0x510e527f',   'SHA512_H4_hi'],
    ['0x9b05688c',   'SHA512_H5_hi'],
    ['0x1f83d9ab',   'SHA512_H6_hi'],
    ['0x5be0cd19',   'SHA512_H7_hi'],
    ['0xf3bcc908',   'SHA512_H0_lo'],
    ['0x84caa73b',   'SHA512_H1_lo'],
    ['0xfe94f82b',   'SHA512_H2_lo'],
    ['0x5f1d36f1',   'SHA512_H3_lo'],
    ['0xade682d1',   'SHA512_H4_lo'],
    ['0x2b3e6c1f',   'SHA512_H5_lo'],
    ['0xfb41bd6b',   'SHA512_H6_lo'],
    ['0x137e2179',   'SHA512_H7_lo'],
    ['0x61707865',   'CHACHA20_CONST0'],
    ['0x3320646e',   'CHACHA20_CONST1'],
    ['0x79622d32',   'CHACHA20_CONST2'],
    ['0x6b206574',   'CHACHA20_CONST3'],
    ['0xedb88320',   'CRC32_POLY'],
    ['0x04c11db7',   'CRC32_POLY_NORM'],
    ['0x243f6a88',   'BLOWFISH_P0'],
    ['0x85a308d3',   'BLOWFISH_P1'],
    ['0xcc9e2d51',   'MURMUR3_C1'],
    ['0x1b873593',   'MURMUR3_C2'],
    ['0x5a827999',   'RIPEMD160_KL1'],
    ['0x6ed9eba1',   'RIPEMD160_KL2'],
    ['0x8f1bbcdc',   'RIPEMD160_KL3'],
    ['0x9e3779b9',   'TIGER_CONST'],
    ['0x01000193',   'FNV32_PRIME'],
    ['0x811c9dc5',   'FNV32_OFFSET'],
]);

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ─── 时间戳边界：延迟计算（首次调用 detectValueType 时根据配置计算）────────
let _tsBounds = null;
function getTsBounds() {
    if (_tsBounds) return _tsBounds;
    const years = cfg('plugins.A8_ValuePatternDetector.timestampWindowYears');
    const _now = Date.now();
    const msYear = 365.25 * 24 * 3600 * 1000;
    _tsBounds = {
        msMin: _now - years * msYear,
        msMax: _now + years * msYear,
        sMin:  Math.floor((_now - years * msYear) / 1000),
        sMax:  Math.ceil((_now + years * msYear) / 1000),
    };
    return _tsBounds;
}

// ─── 正则预编译（模块级，避免每次调用重建）────────────────────────────────────
const RE_UUID         = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// hex：不限制大小写，确保 MD5/SHA 常见大写输出也能命中
const RE_HEX_STR      = /^[0-9a-fA-F]+$/;
const RE_IP           = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
const RE_URL          = /^https?:\/\//i;
// URL encoded：含至少一处 %xx 编码（支持带普通字符混合的 URL 参数）
const RE_URL_ENC      = /%[0-9A-Fa-f]{2}/;
// Base64 字符集：字母+数字+[+/=]，长度至少 4，且能被 4 整除（允许末尾 1-2 个 = pad）
const RE_BASE64_ENC   = /^[A-Za-z0-9+/]+={0,2}$/;
// URL-safe Base64
const RE_BASE64_URL   = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * 检测值的语义类型标签，用于 pattern_type 字段。
 * 返回字符串枚举值（见下），或 null（无特殊语义）。
 *
 * 枚举值：
 *   timestamp      — Unix 时间戳（10 位秒 或 13 位毫秒，当前时间 ±10 年）
 *   uuid           — UUID v1-v5 格式字符串
 *   hex_str        — 纯十六进制字符串（偶数长度 ≥ 8，不含 "0x" 前缀）
 *   base64_charset — 标准 / URL-safe / 魔改 Base64 字符表（长度 64-66，无重复可见字符）
 *   custom_alphabet— 长度 64-66，所有字符唯一但非标准 Base64 字符表（自定义编码字典）
 *   base64_encoded — 看起来像 Base64 编码结果（长度 ≥ 16，mod4=0 或可 pad，高熵）
 *   ip_addr        — IPv4 地址（带或不带端口）
 *   url            — HTTP/HTTPS URL
 *   url_encoded    — 含 %xx 编码的字符串（URL 参数 / form data）
 *   json_obj       — JSON 对象/数组字符串（非空）
 *   byte_array     — 纯整数数组（16~512 个元素，每个 0-255）
 */
function detectValueType(value) {
    if (value === null || value === undefined) return null;
    let str = String(value).trim();
    if (str === '') return null;

    const ts = getTsBounds();

    // ── val_text 解包：value_dict 存储的字符串型值带 JSON 引号（"hello"）────
    // 检测前先还原为真实字符串内容，避免引号干扰长度/字符集检测
    if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
        try { str = JSON.parse(str); } catch { /* 解析失败保持原值 */ }
    }
    if (typeof str !== 'string') str = String(str);
    if (str === '') return null;

    // ── 数值型特判（时间戳）────────────────────────────────────────────────
    // 用配置化的时间窗口边界
    const numVal = Number(str);
    if (!isNaN(numVal) && isFinite(numVal) && String(numVal) === str) {
        // 13 位毫秒时间戳（先判，范围更窄）
        if (numVal >= ts.msMin && numVal <= ts.msMax) return 'timestamp';
        // 10 位秒时间戳
        if (numVal >= ts.sMin  && numVal <= ts.sMax)  return 'timestamp';
        return null; // 普通数字，无语义
    }

    // ── URL（含协议头）──────────────────────────────────────────────────────
    if (RE_URL.test(str)) return 'url';

    // ── URL encoded（含 %xx 编码，可混合普通字符）──────────────────────────
    // 放在 URL 后面，避免 http://foo.com?a=%20 被归到 url_encoded
    if (RE_URL_ENC.test(str)) return 'url_encoded';

    // ── IP 地址 ────────────────────────────────────────────────────────────
    if (RE_IP.test(str)) {
        const parts = str.split(':')[0].split('.').map(Number);
        if (parts.every(p => p >= 0 && p <= 255)) return 'ip_addr';
    }

    // ── UUID ────────────────────────────────────────────────────────────────
    if (str.length === 36 && RE_UUID.test(str)) return 'uuid';

        // ── JSON 对象/数组（字符串形式，非空）─────────────────────────────────
    if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
        try {
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed)) {
                const len = parsed.length;
                const byteArrMin = cfg('plugins.A8_ValuePatternDetector.byteArrayMinLen');
                const byteArrMax = cfg('plugins.A8_ValuePatternDetector.byteArrayMaxLen');
                if (len >= byteArrMin && len <= byteArrMax) {
                    const allBytes = parsed.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);
                    if (allBytes) return 'byte_array';
                }
            }
            return 'json_obj';
        } catch { /* not valid JSON */ }
    }

    // ── 字符串型检测 ────────────────────────────────────────────────────────
    const len = str.length;

    // Base64 字符表：64 个唯一可见字符，总长度在 64~70 之间
    // 宽松范围：允许末尾附带 padding / 分隔符等额外字节，假阳性优于假阴性
    // 不做任何字符剥离，直接按唯一可见字符数判定
    if (len >= 64 && len <= 70) {
        const visibleChars = str.split('').filter(c => c >= '\x21' && c <= '\x7E');
        const unique = new Set(visibleChars).size;
        if (unique === 64) return 'base64_charset';
    }

    // 纯十六进制字符串（偶数长度 ≥ 8，不含 "0x"，大小写均支持）
    if (len >= 8 && len % 2 === 0 && RE_HEX_STR.test(str)) return 'hex_str';

    // Base64 编码结果（长度 ≥ 16，mod4=0，符合 Base64 字符集，字符集多样性足够高）
    if (len >= 16) {
        const isStdB64 = RE_BASE64_ENC.test(str) && (len % 4 === 0);
        const isUrlB64 = RE_BASE64_URL.test(str) && str.indexOf('=') === -1;
        if (isStdB64 || isUrlB64) {
            const unique = new Set(str.replace(/=/g, '')).size;
            if (unique >= 20) return 'base64_encoded';
        }
    }

    return null;
}

/**
 * 计算字符串的 Shannon 熵（bits/char）。
 * 仅对字符串型值有意义；数值/数组等返回 null。
 * 高熵（> 4.5）暗示加密、压缩或随机数据。
 * 公式：H = -Σ p_i * log2(p_i)
 */
function shannonEntropy(value) {
    if (value === null || value === undefined) return null;
    const str = String(value);
    const len = str.length;
    if (len === 0) return null;
    // 纯数字或 JSON 数字 → 不计算熵（无意义）
    if (!isNaN(Number(str)) && isFinite(Number(str))) return null;
    // 字节数组形式：以数组整体特征为主，字符串熵意义不大
    if (str.startsWith('[') && str.endsWith(']')) return null;
    const freq = new Map();
    for (let i = 0; i < len; i++) {
        const c = str[i];
        freq.set(c, (freq.get(c) ?? 0) + 1);
    }
    let h = 0;
    for (const cnt of freq.values()) {
        const p = cnt / len;
        h -= p * Math.log2(p);
    }
    // 保留 3 位小数
    return Math.round(h * 1000) / 1000;
}

function detectConstant(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim().replace(/^"|"$/g, '');
    if (CRYPTO_CONSTANTS.has(str)) return CRYPTO_CONSTANTS.get(str);
    if (str === BASE64_CHARS || str === BASE64_CHARS + '=') return 'BASE64_CHARSET';
    if (str.startsWith('[')) {
        try {
            const arr = JSON.parse(str);
            if (Array.isArray(arr)) {
                const len = arr.length;
                const allNums = arr.every(n => typeof n === 'number');
                const allBytes = allNums && arr.every(n => n >= 0 && n <= 255);
                if ((len === 16 || len === 32) && allBytes) return len === 16 ? 'AES_KEY_128' : 'AES_KEY_256';
                if (len === 256 && allBytes && arr[0] === 99) return 'AES_SBOX';
                if (len === 256 && allBytes && arr[0] === 82) return 'AES_INV_SBOX';
                if (len === 256 && allNums) return 'RC4_SBOX_CANDIDATE';
                if (len === 256 && allNums && arr[0] === 0 && arr[1] === 1996959894) return 'CRC32_TABLE';
                if (len === 18 && allNums && arr[0] === 608135816) return 'BLOWFISH_P_ARRAY';
                if (len === 256 && allNums && arr[0] === 3509652390) return 'BLOWFISH_SBOX';
                if (len === 64 && allBytes && arr[0] === 14 && arr[3] === 0 && arr.every(n => n >= 0 && n <= 15)) return 'DES_SBOX_CANDIDATE';
                if (len === 64 && allNums && arr[0] === 58 && arr[1] === 50 && arr.every(n => n >= 1 && n <= 64)) return 'DES_IP_TABLE';
                if (len === 16 && allNums && arr[0] === 1634760805 && arr[1] === 857760878 && arr[2] === 2036477234 && arr[3] === 1797285236) return 'CHACHA20_STATE';
                if (len === 64 && allNums && arr[0] === 1116352408) return 'SHA256_K_TABLE';
                if (len === 80 && allNums && arr[0] === 1116352408) return 'SHA512_K_TABLE';
                if (len === 256 && allNums && arr[0] === 4159426654) return 'TIGER_SBOX';
                // Keccak state: 5×5×2=50 uint32，首元素须非零（全零初始态不算特征）
                if (len === 50 && allNums && arr[0] !== 0) return 'KECCAK_STATE_CANDIDATE';
                // Whirlpool 查找表：2048 个 uint64（拆成两个 32 位），首元素须为大值
                if (len === 2048 && allNums && arr[0] > 0x10000000) return 'WHIRLPOOL_TABLE_CANDIDATE';
                if (len === 5 && allNums && arr[0] === 2654435761) return 'XXHASH32_PRIMES';
            }
        } catch { /* not valid JSON array */ }
    }
    return null;
}

export default class A8ValuePatternDetector extends BasePlugin {
    static observes = ['F2-SmapLoader'];
    static id = 'A8-ValuePatternDetector';
    static deps = ['F1-EventIndex'];
    static description = '检测高频魔术常数和密码学特征值，写入 value_patterns 表';
    static displayName = 'A8 · ValuePatternDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        // 在 run() 入口捕获配置
        const _plainMinLen = cfg('plugins.A8_ValuePatternDetector.plainStringMinLen');
        const _insertBatchSize = cfg('plugins.A8_ValuePatternDetector.insertBatchSize');

        this.emitProgress(ctx, '清空旧数据...', 0);
        db.run('DELETE FROM value_patterns WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '扫描 value_dict...', 5);

        // ── 直接扫 value_dict（唯一值表，无需聚合 writes 全表）──────────────────
        // value_dict 每个唯一值只有一行，数据量远小于 writes 表，扫描极快。
        // count/first_seq/iid/var_name/line 需要回查 writes/events/smap，
        // 对分析意义有限但性能代价巨大，已去掉，直接填 NULL。
        const allValues = db.all(
            `SELECT id AS value_id, val_text AS value, val_type
             FROM value_dict
             WHERE session_id = ?`,
            [sessionId]
        );

        this.emitProgress(ctx, `检测 ${allValues.length} 个唯一值的模式...`, 20);

        const toInsert = [];
        for (const vd of allValues) {
            const matched     = detectConstant(vd.value);
            const patternType = detectValueType(vd.value);

            // 无特征的普通字符串：val_type='str'，去掉 JSON 引号后长度 >= _plainMinLen
            // 写入 pattern_type='plain'，供值面板"全量字符串"浏览
            let finalType = patternType;
            if (!matched && !patternType && vd.val_type === 'str') {
                // val_text 对字符串是 JSON 序列化形式（带引号），解码取真实字符串内容
                let rawStr = vd.value;
                try { rawStr = JSON.parse(vd.value); } catch { /* 保持原始 */ }
                if (typeof rawStr === 'string' && rawStr.length >= _plainMinLen) {
                    finalType = 'plain';
                }
            }

            // 无特征且不是有效普通字符串（数字/布尔/null/短字符串）→ 跳过
            if (!matched && !finalType) continue;

            const entropy = shannonEntropy(vd.value);
            toInsert.push([
                sessionId,
                vd.value,       // val_text：完整原始值
                null,           // count：不再计算（需要全表扫 writes，性能代价过高）
                null,           // first_seq：同上
                null,           // iid
                null,           // var_name
                null,           // line
                matched ?? null,
                vd.value_id,    // value_dict_id：直接引用，full-value 一跳搞定
                finalType,
                entropy,
            ]);
        }

        this.emitProgress(ctx, `写入 ${toInsert.length} 个模式...`, 80);

        if (toInsert.length > 0) {
            const stmt = rawDb.prepare(
                'INSERT INTO value_patterns (session_id, value_hash, count, first_seq, iid, var_name, line, matched_constant, value_dict_id, pattern_type, entropy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            const insertBatch = rawDb.transaction((batch) => {
                for (const row of batch) stmt.run(...row);
            });
            for (let i = 0; i < toInsert.length; i += _insertBatchSize) {
                insertBatch(toInsert.slice(i, i + _insertBatchSize));
            }
        }

        this.emitProgress(ctx, `完成，${toInsert.length} 个模式`, 100);

        // 统计密码学常数匹配数（matched_constant 在 toInsert 的 index 7）
        const cryptoMatchCount = toInsert.filter(r => r[7] != null && r[7] !== '').length;
        this.emitDone(ctx, { patternCount: toInsert.length, cryptoMatchCount });
    }
}
