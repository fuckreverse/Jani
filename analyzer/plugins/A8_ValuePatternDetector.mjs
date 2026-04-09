/**
 * A8_ValuePatternDetector.mjs — 魔术常数 / 固定值检测
 * 依赖：F1-EventIndex（writes 表已填充）
 *
 * 扫描所有 writes 值，检测高频值和已知密码学魔术常数，写入 value_patterns 表。
 *
 * 性能优化：
 *  - 用一次批量 JOIN 替代对每个 valueStats 的 N 次 db.get
 *  - 使用 prepared statement + 单事务批量 INSERT
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
    static id = 'A8-ValuePatternDetector';
    static deps = ['F1-EventIndex'];
    static description = '检测高频魔术常数和密码学特征值，写入 value_patterns 表';
    static displayName = 'A8 · ValuePatternDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

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

        // 按 value 分组统计（TOP 2000 高频值）
        const valueStats = db.all(
            `SELECT value, COUNT(*) AS count, MIN(event_id) AS first_seq
             FROM writes
             WHERE session_id = ? AND value IS NOT NULL
             GROUP BY value
             ORDER BY count DESC
             LIMIT 2000`,
            [sessionId]
        );

        this.emitProgress(ctx, `分析 ${valueStats.length} 个唯一值...`, 25);

        // 循环/临时变量名黑名单：这些变量名出现的值不应被标记为密码学常数
        // （即使值本身在常数表中，循环变量恰好取到该值只是巧合）
        const LOOP_VAR_NAMES = new Set([
            'i', 'j', 'k', 'l', 'm', 'n', 't', 'x', 'y', 'z',
            'idx', 'cnt', 'len', 'num', 'val', 'ret', 'tmp', 'res',
            'result', 'count', 'index', 'value', 'offset', 'pos',
        ]);

        // 过滤出需要获取 detail 的 value
        const needDetail = [];
        const matchedMap = new Map(); // value → matched constant name
        for (const vs of valueStats) {
            const matched = detectConstant(vs.value);
            matchedMap.set(vs.value, matched);
            if (vs.count >= 2 || matched) {
                needDetail.push(vs);
            }
        }

        this.emitProgress(ctx, `批量加载 ${needDetail.length} 个值的详情...`, 40);

        // ── 一次批量 JOIN 获取所有 detail，代替 N 次单行 db.get ──────────────
        // 用 first_seq (MIN event_id) 直接 JOIN events，不需要多余查询
        // first_seq 就是 writes 里的 MIN(event_id)，只需要再 JOIN 一次取 iid/line/name
        const detailMap = new Map(); // value → {iid, name, line}

        // 构建临时 value→first_seq 映射，分批 JOIN
        const CHUNK = 900;
        const firstSeqIds = needDetail.map(vs => vs.first_seq).filter(Boolean);
        // event_id → {iid, line}
        const eventMetaMap = new Map();
        for (let i = 0; i < firstSeqIds.length; i += CHUNK) {
            const chunk = firstSeqIds.slice(i, i + CHUNK);
            const ph = chunk.map(() => '?').join(',');
            const rows = rawDb.prepare(
                `SELECT id, iid, line FROM events WHERE session_id = ? AND id IN (${ph})`
            ).all(sessionId, ...chunk);
            for (const r of rows) eventMetaMap.set(r.id, { iid: r.iid, line: r.line });
        }

        // writes.event_id=first_seq → name
        const writeNameMap = new Map(); // event_id → name
        for (let i = 0; i < firstSeqIds.length; i += CHUNK) {
            const chunk = firstSeqIds.slice(i, i + CHUNK);
            const ph = chunk.map(() => '?').join(',');
            const rows = rawDb.prepare(
                `SELECT event_id, name FROM writes WHERE session_id = ? AND event_id IN (${ph})`
            ).all(sessionId, ...chunk);
            for (const r of rows) {
                if (!writeNameMap.has(r.event_id)) writeNameMap.set(r.event_id, r.name);
            }
        }

        for (const vs of needDetail) {
            const evMeta = eventMetaMap.get(vs.first_seq);
            detailMap.set(vs.value, {
                iid:  evMeta?.iid  ?? null,
                line: evMeta?.line ?? null,
                name: writeNameMap.get(vs.first_seq) ?? null,
            });
        }

        this.emitProgress(ctx, `写入模式...`, 70);

        // 组装写入数据
        const toInsert = [];
        for (const vs of needDetail) {
            let matched    = matchedMap.get(vs.value);
            const detail   = detailMap.get(vs.value);
            const varName  = detail?.name ?? null;

            // 循环/临时变量名过滤：如果首次出现的变量名在黑名单中，
            // 说明该值很可能是普通的循环变量（如 i=1,2,4,8...），不标记为密码学常数
            if (matched && varName && LOOP_VAR_NAMES.has(varName)) {
                matched = null;
            }

            // 仍需写入：有常数匹配、或出现次数 >= 2
            if (!matched && vs.count < 2) continue;

            toInsert.push([
                sessionId,
                String(vs.value).substring(0, 64),
                vs.count,
                vs.first_seq,
                detail?.iid  ?? null,
                varName,
                detail?.line ?? null,
                matched ?? null,
            ]);
        }

        if (toInsert.length > 0) {
            const stmt = rawDb.prepare(
                'INSERT INTO value_patterns (session_id, value_hash, count, first_seq, iid, var_name, line, matched_constant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            const insertBatch = rawDb.transaction((batch) => {
                for (const row of batch) stmt.run(...row);
            });
            for (let i = 0; i < toInsert.length; i += 2000) {
                insertBatch(toInsert.slice(i, i + 2000));
            }
        }

        this.emitProgress(ctx, `完成，${toInsert.length} 个模式`, 100);
        this.emitDone(ctx, { patternCount: toInsert.length });
    }
}
