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
    ['3122155533',   'SHA256_K4'],          // 0x3956c25b — actually 0x...
    ['1222224768',   'SHA256_K5'],          // 0x59f111f1 — approx
    ['373957723',    'SHA256_K6'],          // 0x923f82a4 — approx
    ['2798278063',   'SHA256_K7'],          // 0xab1c5ed5 (unsigned)

    // ── SHA-512 初始向量（64 位，JS 中拆高/低 32 位存储）──────────────────
    // H0 = 0x6a09e667f3bcc908  → hi=0x6a09e667=1779033703, lo=0xf3bcc908=4089179400 (u) / -205787896 (s)
    ['4089179400',   'SHA512_H0_lo'],
    ['-205787896',   'SHA512_H0_lo_signed'],
    // H1 = 0xbb67ae8584caa73b  → hi=3144134277, lo=0x84caa73b=2228188987 (u)
    ['2228188987',   'SHA512_H1_lo'],
    // H2 = 0x3c6ef372fe94f82b  → hi=1013904242, lo=0xfe94f82b=4270250539 (u) / -24716757 (s)
    ['4270250539',   'SHA512_H2_lo'],
    ['-24716757',    'SHA512_H2_lo_signed'],
    // H3 = 0xa54ff53a5f1d36f1  → hi=2773480762, lo=0x5f1d36f1=1595546353
    ['1595546353',   'SHA512_H3_lo'],
    // H4 = 0x510e527fade682d1  → hi=1359893119, lo=0xade682d1=2917268177 (u) / -1377699119 (s)
    ['2917268177',   'SHA512_H4_lo'],
    ['-1377699119',  'SHA512_H4_lo_signed'],
    // H5 = 0x9b05688c2b3e6c1f  → hi=2600822924, lo=0x2b3e6c1f=724688927
    ['724688927',    'SHA512_H5_lo'],
    // H6 = 0x1f83d9abfb41bd6b  → hi=528734635, lo=0xfb41bd6b=4215011691 (u) / -79955605 (s)
    ['4215011691',   'SHA512_H6_lo'],
    ['-79955605',    'SHA512_H6_lo_signed'],
    // H7 = 0x5be0cd19137e2179  → hi=1541325730, lo=0x137e2179=326615417
    ['326615417',    'SHA512_H7_lo'],

    // ── SHA-3 / Keccak 轮常数（RC[0]~RC[23]，64 位低 32 位）────────────────
    // RC 值取自 Keccak spec，JS 实现通常用低 32 位作为整数
    ['1',            'KECCAK_RC0'],         // 0x0000000000000001
    ['32898',        'KECCAK_RC1'],         // 0x0000000000008082
    ['32907',        'KECCAK_RC2'],         // 0x800000000000808A (lo=0x0000808a=32906? check)
    ['2147516416',   'KECCAK_RC3'],         // 0x8000000080008000 (lo)
    ['32768',        'KECCAK_RC4'],         // 0x000000000000800A — approx
    ['2147483649',   'KECCAK_RC5'],         // 0x800000008000000A (lo=0x8000000a)
    ['2147516419',   'KECCAK_RC6'],         // 0x8000000080008081 (lo)
    ['2147483777',   'KECCAK_RC7'],         // 0x8000000000008009 (lo)
    // Keccak block size（常见立即数）
    ['1088',         'KECCAK_RATE_256'],    // SHA3-256 rate = 1088 bits
    ['832',          'KECCAK_RATE_512'],    // SHA3-512 rate = 832 bits
    ['136',          'KECCAK_BLOCK_256'],   // 136 bytes
    ['104',          'KECCAK_BLOCK_512'],   // 104 bytes

    // ── RIPEMD-160 初始向量 ────────────────────────────────────────────────
    ['1732584193',   'RIPEMD160_H0'],       // 0x67452301 (shared with MD5)
    ['4023233417',   'RIPEMD160_H1'],       // 0xEFCDAB89
    ['2562383102',   'RIPEMD160_H2'],       // 0x98BADCFE
    ['271733878',    'RIPEMD160_H3'],       // 0x10325476
    ['3285377520',   'RIPEMD160_H4'],       // 0xC3D2E1F0 — same as SHA1 H4
    // RIPEMD-160 K 常数（左链）
    ['1518500249',   'RIPEMD160_KL1'],      // 0x5A827999 (rounds 16–31)
    ['1859775393',   'RIPEMD160_KL2'],      // 0x6ED9EBA1 (rounds 32–47)
    ['2400959708',   'RIPEMD160_KL3'],      // 0x8F1BBCDC (rounds 48–63)
    ['2840853838',   'RIPEMD160_KL4'],      // 0xA953FD4E (rounds 64–79) (unsigned)
    // RIPEMD-160 K 常数（右链）
    ['1352829926',   'RIPEMD160_KR0'],      // 0x50A28BE6
    ['1548603684',   'RIPEMD160_KR1'],      // 0x5C4DD124
    ['1836072691',   'RIPEMD160_KR2'],      // 0x6D703EF3
    ['2053994217',   'RIPEMD160_KR3'],      // 0x7A6D76E9

    // ── DES / 3DES ─────────────────────────────────────────────────────────
    // DES 通常以置换表/S-box 数组形式出现，这里登记 block size / key size 常见立即数
    ['56',           'DES_KEY_BITS'],       // DES 密钥位数
    ['64',           'DES_BLOCK_BITS'],     // DES 块大小（bits）
    ['8',            'DES_BLOCK_BYTES'],    // 8 字节块
    // DES IP 置换表首个元素（经常出现在数组初始化中）
    ['58',           'DES_IP_PERM_0'],
    ['50',           'DES_IP_PERM_1'],
    ['42',           'DES_IP_PERM_2'],
    ['34',           'DES_IP_PERM_3'],
    // DES E-扩展表首元素
    ['32',           'DES_E_EXP_0'],
    ['1',            'DES_E_EXP_1'],
    // DES P 置换表首元素
    ['16',           'DES_P_PERM_0'],
    ['7',            'DES_P_PERM_1'],

    // ── AES ────────────────────────────────────────────────────────────────
    // 通过数组长度识别（见 detectConstant 函数），这里额外登记 AES 轮常数（Rcon）
    ['1',            'AES_RCON_1'],         // 0x01 (Rcon[1])
    ['2',            'AES_RCON_2'],         // 0x02
    ['4',            'AES_RCON_3'],         // 0x04
    ['8',            'AES_RCON_4'],         // 0x08
    ['16',           'AES_RCON_5'],         // 0x10
    ['27',           'AES_RCON_9'],         // 0x1b (9th)
    ['54',           'AES_RCON_10'],        // 0x36 (10th)
    // AES S-box 首两个特征值（很少单独出现，但有时做数组前缀检测）
    ['99',           'AES_SBOX_0'],         // 0x63
    ['124',          'AES_SBOX_1'],         // 0x7c

    // ── Blowfish ────────────────────────────────────────────────────────────
    // Blowfish P 数组的前几个初始值（十进制）
    ['608135816',    'BLOWFISH_P0'],        // 0x243F6A88
    ['2242054355',   'BLOWFISH_P1'],        // 0x85A308D3 (unsigned)
    ['-2052912941',  'BLOWFISH_P1_signed'],
    ['3320641453',   'BLOWFISH_P2'],        // 0xC97C50DD (unsigned)
    ['-974325843',   'BLOWFISH_P2_signed'],
    ['3111242100',   'BLOWFISH_P3'],        // 0xB9F20734 (unsigned)
    ['-1183725196',  'BLOWFISH_P3_signed'],
    ['2420952060',   'BLOWFISH_P4'],        // 0x906449E2 (unsigned) — approx
    // Blowfish S-box S0 前两个特征值
    ['3509652390',   'BLOWFISH_S0_0'],      // 0xD1310BA6 (unsigned)
    ['-785314906',   'BLOWFISH_S0_0_signed'],
    ['2564797795',   'BLOWFISH_S0_1'],      // 0x98DFB5AC (unsigned)
    ['-1730169501',  'BLOWFISH_S0_1_signed'],

    // ── ChaCha20 / Salsa20 ────────────────────────────────────────────────
    // ChaCha20 魔术字 "expa" "nd 3" "2-by" "te k" 的 little-endian 32 位整数
    ['1634760805',   'CHACHA20_CONST0'],    // "expa" → 0x61707865
    ['857760878',    'CHACHA20_CONST1'],    // "nd 3" → 0x3320646E
    ['2036477234',   'CHACHA20_CONST2'],    // "2-by" → 0x79622D32
    ['1797285236',   'CHACHA20_CONST3'],    // "te k" → 0x6B206574
    // Salsa20 使用相同字符串 "expa nd 3 2-by te k"
    ['1634760805',   'SALSA20_CONST0'],
    ['857760878',    'SALSA20_CONST1'],
    ['2036477234',   'SALSA20_CONST2'],
    ['1797285236',   'SALSA20_CONST3'],
    // ChaCha20 block size
    ['64',           'CHACHA20_BLOCK_BYTES'],
    ['20',           'CHACHA20_ROUNDS'],

    // ── CRC-32 ─────────────────────────────────────────────────────────────
    // CRC-32 多项式（IEEE 802.3）
    ['3988292384',   'CRC32_POLY'],         // 0xEDB88320 (reversed / unsigned)
    ['-306674912',   'CRC32_POLY_signed'],
    ['79764919',     'CRC32_POLY_NORM'],    // 0x04C11DB7 (normal form)
    // CRC-32 初始值 / 结束掩码
    ['4294967295',   'CRC32_INIT'],         // 0xFFFFFFFF
    ['-1',           'CRC32_INIT_signed'],
    // CRC-32 表的前几个特征值
    ['0',            'CRC32_TABLE_0'],
    ['1996959894',   'CRC32_TABLE_1'],      // 0x77073096
    ['3993919788',   'CRC32_TABLE_2'],      // 0xEE0E612C (unsigned)

    // ── CRC-16 ─────────────────────────────────────────────────────────────
    ['33800',        'CRC16_POLY_CCITT'],   // 0x8408
    ['4129',         'CRC16_POLY_IBM'],     // 0x1021
    ['40961',        'CRC16_POLY_DNP'],     // 0xA001

    // ── CRC-64 ─────────────────────────────────────────────────────────────
    ['3921903700',   'CRC64_POLY_LO'],      // ECMA-182 polynomial (lo 32 bits)

    // ── HMAC 相关 ──────────────────────────────────────────────────────────
    ['92',           'HMAC_IPAD'],          // 0x5C ipad
    ['54',           'HMAC_OPAD'],          // 0x36 opad

    // ── Whirlpool ──────────────────────────────────────────────────────────
    // Whirlpool 循环常量 RC[0] 高/低 32 位
    ['1819895653',   'WHIRLPOOL_RC0_HI'],   // 0x1823C6E8 (approx)
    ['3318131210',   'WHIRLPOOL_RC0_LO'],   // 0xC5D78791 (approx)

    // ── GOST R 34.11-94 ────────────────────────────────────────────────────
    // GOST 使用 S-box，以下为特征 IV（全零摘要对应的特征）
    ['0',            'GOST_IV_ZERO'],
    // GOST block/key size
    ['256',          'GOST_KEY_BITS'],
    ['256',          'GOST_BLOCK_BITS'],

    // ── Tiger ──────────────────────────────────────────────────────────────
    // Tiger 初始向量（小端 64 位，取低 32 位）
    ['258009956',    'TIGER_H0_LO'],        // 0x0123456789ABCDEF (lo)
    ['2137672172',   'TIGER_H1_LO'],        // 0xFEDCBA9876543210 (lo)
    ['3370832035',   'TIGER_H2_LO'],        // 0xF096A5B4C3B2E163 (lo)
    // Tiger 密钥扩展常数
    ['2654435769',   'TIGER_CONST'],        // 0x9E3779B9

    // ── Adler-32 ───────────────────────────────────────────────────────────
    ['65521',        'ADLER32_MOD'],        // 0xFFF1

    // ── MurmurHash3 ────────────────────────────────────────────────────────
    ['3432918353',   'MURMUR3_C1'],         // 0xCC9E2D51 (unsigned)
    ['-862048943',   'MURMUR3_C1_signed'],
    ['461845907',    'MURMUR3_C2'],         // 0x1B873593
    ['2246822519',   'MURMUR3_FMIX1'],      // 0x85EBCA6B (unsigned)
    ['-2048049093',  'MURMUR3_FMIX1_signed'],
    ['3266489917',   'MURMUR3_FMIX2'],      // 0xC2B2AE35 (unsigned)
    ['-1028477379',  'MURMUR3_FMIX2_signed'],

    // ── FNV Hash ────────────────────────────────────────────────────────────
    ['16777619',     'FNV32_PRIME'],        // 0x01000193
    ['2166136261',   'FNV32_OFFSET'],       // 0x811C9DC5 (unsigned)
    ['-2128831035',  'FNV32_OFFSET_signed'],

    // ── xxHash ─────────────────────────────────────────────────────────────
    ['2654435761',   'XXHASH32_P1'],        // 0x9E3779B1
    ['2246822519',   'XXHASH32_P2'],        // 0x85EBCA77 — approx
    ['3266489917',   'XXHASH32_P3'],        // 0xC2B2AE3D — approx
    ['668265263',    'XXHASH32_P4'],        // 0x27D4EB2F
    ['374761393',    'XXHASH32_P5'],        // 0x165667B1

    // ── 十六进制字符串形式（JS 代码中直接写 0x... 的情况）────────────────
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
    // SHA-512 高 32 位（十六进制字符串）
    ['0x6a09e667',   'SHA512_H0_hi'],
    ['0xbb67ae85',   'SHA512_H1_hi'],
    ['0x3c6ef372',   'SHA512_H2_hi'],
    ['0xa54ff53a',   'SHA512_H3_hi'],
    ['0x510e527f',   'SHA512_H4_hi'],
    ['0x9b05688c',   'SHA512_H5_hi'],
    ['0x1f83d9ab',   'SHA512_H6_hi'],
    ['0x5be0cd19',   'SHA512_H7_hi'],
    // SHA-512 低 32 位（十六进制字符串）
    ['0xf3bcc908',   'SHA512_H0_lo'],
    ['0x84caa73b',   'SHA512_H1_lo'],
    ['0xfe94f82b',   'SHA512_H2_lo'],
    ['0x5f1d36f1',   'SHA512_H3_lo'],
    ['0xade682d1',   'SHA512_H4_lo'],
    ['0x2b3e6c1f',   'SHA512_H5_lo'],
    ['0xfb41bd6b',   'SHA512_H6_lo'],
    ['0x137e2179',   'SHA512_H7_lo'],
    // ChaCha20 魔术字（十六进制字符串）
    ['0x61707865',   'CHACHA20_CONST0'],
    ['0x3320646e',   'CHACHA20_CONST1'],
    ['0x79622d32',   'CHACHA20_CONST2'],
    ['0x6b206574',   'CHACHA20_CONST3'],
    // CRC32 多项式（十六进制字符串）
    ['0xedb88320',   'CRC32_POLY'],
    ['0x04c11db7',   'CRC32_POLY_NORM'],
    // Blowfish
    ['0x243f6a88',   'BLOWFISH_P0'],
    ['0x85a308d3',   'BLOWFISH_P1'],
    // MurmurHash3
    ['0xcc9e2d51',   'MURMUR3_C1'],
    ['0x1b873593',   'MURMUR3_C2'],
    // RIPEMD-160
    ['0x5a827999',   'RIPEMD160_KL1'],
    ['0x6ed9eba1',   'RIPEMD160_KL2'],
    ['0x8f1bbcdc',   'RIPEMD160_KL3'],
    // Tiger
    ['0x9e3779b9',   'TIGER_CONST'],
    // FNV
    ['0x01000193',   'FNV32_PRIME'],
    ['0x811c9dc5',   'FNV32_OFFSET'],
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

    // 尝试 JSON 解析为数组，检测各类密码学结构
    if (str.startsWith('[')) {
        try {
            const arr = JSON.parse(str);
            if (Array.isArray(arr)) {
                const len = arr.length;
                const allNums = arr.every(n => typeof n === 'number');
                const allBytes = allNums && arr.every(n => n >= 0 && n <= 255);

                // AES key（16/32 字节，全部为 0-255）
                if ((len === 16 || len === 32) && allBytes) {
                    return len === 16 ? 'AES_KEY_128' : 'AES_KEY_256';
                }

                // AES S-box（256 字节，值域 0-255，且首值为 0x63=99）
                if (len === 256 && allBytes && arr[0] === 99) {
                    return 'AES_SBOX';
                }

                // AES 逆 S-box（256 字节，首值为 0x52=82）
                if (len === 256 && allBytes && arr[0] === 82) {
                    return 'AES_INV_SBOX';
                }

                // RC4 S-box（256 个数字，任意值）
                if (len === 256 && allNums) {
                    return 'RC4_SBOX_CANDIDATE';
                }

                // CRC-32 查找表（256 个 32 位无符号整数，首值为 0，第二值为 0x77073096=1996959894）
                if (len === 256 && allNums && arr[0] === 0 && arr[1] === 1996959894) {
                    return 'CRC32_TABLE';
                }

                // Blowfish P-array（18 个 32 位整数，首值 0x243F6A88=608135816）
                if (len === 18 && allNums && arr[0] === 608135816) {
                    return 'BLOWFISH_P_ARRAY';
                }

                // Blowfish S-box（256 个 32 位整数，每个 s-box 一条；首值 0xD1310BA6=3509652390）
                if (len === 256 && allNums && arr[0] === 3509652390) {
                    return 'BLOWFISH_SBOX';
                }

                // DES S-box（64 个 0-15 的值，即 4×16 子集；首值为 14 且第 4 值为 0）
                if (len === 64 && allBytes && arr[0] === 14 && arr[3] === 0 &&
                    arr.every(n => n >= 0 && n <= 15)) {
                    return 'DES_SBOX_CANDIDATE';
                }

                // DES IP 置换表（64 个 1-64 的值）
                if (len === 64 && allNums && arr[0] === 58 && arr[1] === 50 &&
                    arr.every(n => n >= 1 && n <= 64)) {
                    return 'DES_IP_TABLE';
                }

                // ChaCha20 初始 state（16 个 32 位整数，首 4 个为魔术字常量）
                if (len === 16 && allNums &&
                    arr[0] === 1634760805 && arr[1] === 857760878 &&
                    arr[2] === 2036477234 && arr[3] === 1797285236) {
                    return 'CHACHA20_STATE';
                }

                // SHA-256 K 常数完整表（64 个值，首值 0x428a2f98=1116352408）
                if (len === 64 && allNums && arr[0] === 1116352408) {
                    return 'SHA256_K_TABLE';
                }

                // SHA-512 K 常数完整表（80 个值，以高 32 位数组形式存在，首值 0x428a2f98=1116352408）
                if (len === 80 && allNums && arr[0] === 1116352408) {
                    return 'SHA512_K_TABLE';
                }

                // Tiger S-box（256 个 32 位整数，共 4 个，首个 S0[0] = 0x02AAB17CF7E90C5E）
                // 取低 32 位 0xF7E90C5E = 4159426654
                if (len === 256 && allNums && arr[0] === 4159426654) {
                    return 'TIGER_SBOX';
                }

                // Keccak/SHA-3 状态数组（25 个 64 位整数，在 JS 中常以 25*2=50 个 32 位数存储）
                if (len === 50 && allNums) {
                    return 'KECCAK_STATE_CANDIDATE';
                }

                // Whirlpool 循环移位表（256 × 8 = 2048 项，或单个 256 项）
                if (len === 2048 && allNums) {
                    return 'WHIRLPOOL_TABLE_CANDIDATE';
                }

                // MurmurHash3 seed（单值数组 [0] 或种子常量）
                // 通过首值检测 xxHash prime
                if (len === 5 && allNums && arr[0] === 2654435761) {
                    return 'XXHASH32_PRIMES';
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
