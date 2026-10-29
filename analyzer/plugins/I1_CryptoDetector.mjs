/**
 * I1_CryptoDetector.mjs — 加密算法识别
 * 依赖：A3-HotPathAnalyzer（loops 表）、A8-ValuePatternDetector（value_patterns 表）
 *        以及 F3-CallGraphBuilder（call_edges 表，可选）、F1-EventIndex（fields 表，可选）
 *
 * 两路检测策略：
 *   1. 常量特征：扫描 value_patterns 表中匹配到的密码学魔术常数
 *   2. 库调用特征：扫描 call_edges.fn_name / fields.offset / writes.name，
 *      识别 Web Crypto API、Node.js crypto、CryptoJS、forge、sjcl、
 *      jsrsasign、tweetnacl、bcrypt.js、jsonwebtoken 等常见库的调用模式
 */

// ─── 库调用特征规则表 ──────────────────────────────────────────────────────────
// 每条规则：{ id, label, confidence, source, patterns[], minMatches }
//   source:   'call'   → 匹配 call_edges.fn_name
//             'field'  → 匹配 fields.offset（属性访问/调用）
//             'write'  → 匹配 writes.name（变量名）
//   patterns: 字符串数组，fn_name / offset / name 中含有任意一项即命中
//   minMatches: 至少命中几项（默认 1）

const LIB_RULES = [
    // ── Web Crypto API（浏览器 SubtleCrypto）──────────────────────────────
    {
        id: 'WebCrypto',
        label: 'Web Crypto API (SubtleCrypto)',
        confidence: 0.97,
        source: 'call',
        patterns: [
            'subtle.encrypt', 'subtle.decrypt', 'subtle.sign', 'subtle.verify',
            'subtle.digest', 'subtle.generateKey', 'subtle.importKey',
            'subtle.exportKey', 'subtle.deriveKey', 'subtle.deriveBits',
            'subtle.wrapKey', 'subtle.unwrapKey',
            'crypto.subtle',
        ],
        minMatches: 1,
    },
    {
        id: 'WebCrypto_field',
        label: 'Web Crypto API (SubtleCrypto)',
        confidence: 0.95,
        source: 'field',
        patterns: [
            'subtle', 'getRandomValues',
            'encrypt', 'decrypt', 'sign', 'verify', 'digest',
            'generateKey', 'importKey', 'exportKey', 'deriveKey', 'deriveBits',
        ],
        minMatches: 2,   // 至少 2 个不同属性才报告，避免误报
        labelSuffix: true,
    },

    // ── Node.js crypto 模块 ────────────────────────────────────────────────
    {
        id: 'NodeCrypto',
        label: 'Node.js crypto',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'createHash', 'createHmac', 'createCipher', 'createDecipher',
            'createCipheriv', 'createDecipheriv', 'createSign', 'createVerify',
            'createDiffieHellman', 'createECDH', 'pbkdf2', 'pbkdf2Sync',
            'scrypt', 'scryptSync', 'randomBytes', 'randomFill',
            'publicEncrypt', 'privateDecrypt', 'privateEncrypt', 'publicDecrypt',
            'generateKeyPair', 'generateKeyPairSync', 'createSecretKey',
            'hkdf', 'hkdfSync',
            'crypto.createHash', 'crypto.createHmac', 'crypto.randomBytes',
        ],
        minMatches: 1,
    },

    // ── CryptoJS ───────────────────────────────────────────────────────────
    {
        id: 'CryptoJS',
        label: 'CryptoJS',
        confidence: 0.93,
        source: 'call',
        patterns: [
            'CryptoJS.AES.encrypt', 'CryptoJS.AES.decrypt',
            'CryptoJS.MD5', 'CryptoJS.SHA1', 'CryptoJS.SHA256',
            'CryptoJS.SHA512', 'CryptoJS.SHA3', 'CryptoJS.RIPEMD160',
            'CryptoJS.HmacMD5', 'CryptoJS.HmacSHA1', 'CryptoJS.HmacSHA256',
            'CryptoJS.HmacSHA512',
            'CryptoJS.TripleDES.encrypt', 'CryptoJS.TripleDES.decrypt',
            'CryptoJS.RC4.encrypt', 'CryptoJS.Rabbit.encrypt',
            'CryptoJS.DES.encrypt', 'CryptoJS.DES.decrypt',
            'CryptoJS.enc.Base64', 'CryptoJS.enc.Hex', 'CryptoJS.enc.Utf8',
            'CryptoJS.lib.WordArray',
            'WordArray.create', 'WordArray.concat',
        ],
        minMatches: 1,
    },
    {
        id: 'CryptoJS_field',
        label: 'CryptoJS',
        confidence: 0.88,
        source: 'field',
        patterns: [
            'CryptoJS', 'WordArray', 'sigBytes', 'words',
            'enc', 'lib', 'algo', 'mode', 'pad',
            'BlockCipher', 'SerializableCipher', 'PasswordBasedCipher',
            'Pkcs7', 'ZeroPadding', 'NoPadding', 'Iso97971',
        ],
        minMatches: 3,
    },

    // ── forge (node-forge) ──────────────────────────────────────────────────
    {
        id: 'forge',
        label: 'node-forge',
        confidence: 0.93,
        source: 'call',
        patterns: [
            'forge.pki.rsa', 'forge.pki.privateKeyFromPem',
            'forge.pki.publicKeyFromPem', 'forge.pki.certificateFromPem',
            'forge.md.sha256.create', 'forge.md.sha1.create',
            'forge.md.md5.create', 'forge.md.sha512.create',
            'forge.hmac.create', 'forge.cipher.createCipher',
            'forge.cipher.createDecipher',
            'forge.random.getBytesSync', 'forge.random.getBytes',
            'forge.util.encode64', 'forge.util.decode64',
            'forge.util.bytesToHex', 'forge.util.hexToBytes',
            'forge.pki.createCertificate', 'forge.pki.createCaStore',
            'forge.tls',
        ],
        minMatches: 1,
    },
    {
        id: 'forge_field',
        label: 'node-forge',
        confidence: 0.85,
        source: 'field',
        patterns: [
            'forge', 'pki', 'md', 'hmac', 'tls', 'asn1',
            'createCipher', 'createDecipher', 'getBytesSync',
        ],
        minMatches: 3,
    },

    // ── sjcl (Stanford Javascript Crypto Library) ─────────────────────────
    {
        id: 'sjcl',
        label: 'SJCL (Stanford Crypto)',
        confidence: 0.93,
        source: 'call',
        patterns: [
            'sjcl.encrypt', 'sjcl.decrypt',
            'sjcl.hash.sha256.hash', 'sjcl.hash.sha512.hash',
            'sjcl.hash.sha1.hash', 'sjcl.hash.sha3_256.hash',
            'sjcl.mac.hmac',
            'sjcl.codec.base64.fromBits', 'sjcl.codec.base64.toBits',
            'sjcl.codec.hex.fromBits', 'sjcl.codec.hex.toBits',
            'sjcl.codec.utf8String.fromBits',
            'sjcl.cipher.aes', 'sjcl.mode.ccm', 'sjcl.mode.gcm',
            'sjcl.misc.pbkdf2', 'sjcl.misc.scrypt', 'sjcl.misc.hkdf',
            'sjcl.random.randomWords',
        ],
        minMatches: 1,
    },
    {
        id: 'sjcl_field',
        label: 'SJCL (Stanford Crypto)',
        confidence: 0.87,
        source: 'field',
        patterns: ['sjcl', 'bn', 'ecc', 'codec', 'misc'],
        minMatches: 2,
    },

    // ── jsrsasign ─────────────────────────────────────────────────────────
    {
        id: 'jsrsasign',
        label: 'jsrsasign',
        confidence: 0.93,
        source: 'call',
        patterns: [
            'KJUR.crypto.Signature', 'KJUR.crypto.MessageDigest',
            'KJUR.crypto.Mac', 'KJUR.asn1',
            'KJUR.jws.JWS.sign', 'KJUR.jws.JWS.verify',
            'KJUR.jws.JWS.verifyJWT',
            'RSAKey', 'KEYUTIL.getKey', 'KEYUTIL.generateKeypair',
            'X509.getPublicKeyFromCertHex', 'X509.getPublicKeyInfoPropOfCertPEM',
            'hextob64', 'b64tohex', 'strtohex',
        ],
        minMatches: 1,
    },
    {
        id: 'jsrsasign_field',
        label: 'jsrsasign',
        confidence: 0.85,
        source: 'field',
        patterns: ['KJUR', 'KEYUTIL', 'RSAKey', 'X509', 'hextob64', 'b64tohex'],
        minMatches: 1,
    },

    // ── TweetNaCl / libsodium-wrappers ───────────────────────────────────
    {
        id: 'tweetnacl',
        label: 'TweetNaCl / libsodium',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'nacl.box', 'nacl.secretbox', 'nacl.sign', 'nacl.hash',
            'nacl.box.keyPair', 'nacl.sign.keyPair',
            'nacl.randomBytes', 'nacl.verify',
            'nacl.secretbox.open', 'nacl.box.open',
            // libsodium-wrappers
            'sodium.crypto_secretbox_easy', 'sodium.crypto_box_easy',
            'sodium.crypto_sign', 'sodium.crypto_sign_open',
            'sodium.crypto_hash', 'sodium.crypto_generichash',
            'sodium.crypto_pwhash', 'sodium.crypto_kx_keypair',
            'sodium.randombytes_buf',
        ],
        minMatches: 1,
    },
    {
        id: 'tweetnacl_field',
        label: 'TweetNaCl / libsodium',
        confidence: 0.88,
        source: 'field',
        patterns: ['nacl', 'sodium', 'secretbox', 'crypto_secretbox', 'crypto_box'],
        minMatches: 1,
    },

    // ── bcrypt.js / bcryptjs ──────────────────────────────────────────────
    {
        id: 'bcrypt',
        label: 'bcrypt.js',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'bcrypt.hash', 'bcrypt.hashSync',
            'bcrypt.compare', 'bcrypt.compareSync',
            'bcrypt.genSalt', 'bcrypt.genSaltSync',
            'bcryptjs.hash', 'bcryptjs.hashSync',
            'bcryptjs.compare', 'bcryptjs.compareSync',
        ],
        minMatches: 1,
    },

    // ── jsonwebtoken ──────────────────────────────────────────────────────
    {
        id: 'jwt',
        label: 'jsonwebtoken',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'jwt.sign', 'jwt.verify', 'jwt.decode',
            'jsonwebtoken.sign', 'jsonwebtoken.verify',
            'jose.jwtVerify', 'jose.SignJWT',
            'jws.sign', 'jws.verify',
        ],
        minMatches: 1,
    },
    {
        id: 'jwt_field',
        label: 'jsonwebtoken',
        confidence: 0.88,
        source: 'field',
        patterns: ['jwt', 'jwtSecret', 'accessToken', 'refreshToken', 'Bearer'],
        minMatches: 2,
    },

    // ── elliptic（EC 曲线）────────────────────────────────────────────────
    {
        id: 'elliptic',
        label: 'elliptic (EC crypto)',
        confidence: 0.93,
        source: 'call',
        patterns: [
            'ec.genKeyPair', 'ec.keyFromPrivate', 'ec.keyFromPublic',
            'key.sign', 'key.verify', 'ec.verify',
            'BN.fromBuffer', 'BN.toBuffer',
            'elliptic.ec', 'elliptic.eddsa',
            'secp256k1.sign', 'secp256k1.verify', 'secp256k1.publicKeyCreate',
        ],
        minMatches: 1,
    },
    {
        id: 'elliptic_field',
        label: 'elliptic (EC crypto)',
        confidence: 0.85,
        source: 'field',
        patterns: [
            'secp256k1', 'p256', 'p384', 'p521', 'ed25519', 'curve25519',
            'ec', 'eddsa', 'genKeyPair', 'keyFromPrivate',
        ],
        minMatches: 2,
    },

    // ── crypto-js / crypto-browserify ────────────────────────────────────
    {
        id: 'crypto_browserify',
        label: 'crypto-browserify',
        confidence: 0.88,
        source: 'call',
        patterns: [
            'createHash', 'createHmac', 'createCipheriv', 'createDecipheriv',
            'pbkdf2Sync', 'randomBytes', 'createSign', 'createVerify',
        ],
        minMatches: 2,   // 这些单独出现不稀奇，至少 2 个才报
    },

    // ── asmcrypto.js / asmcrypto ────────────────────────────────────────
    {
        id: 'asmcrypto',
        label: 'asmcrypto.js',
        confidence: 0.90,
        source: 'call',
        patterns: [
            'AES_CBC.encrypt', 'AES_CBC.decrypt',
            'AES_GCM.encrypt', 'AES_GCM.decrypt',
            'AES_CCM.encrypt', 'AES_CCM.decrypt',
            'SHA256.hash', 'SHA512.hash', 'SHA1.hash',
            'HMAC_SHA256.mac', 'HMAC_SHA512.mac',
            'RSA.encrypt', 'RSA.decrypt', 'RSA.sign', 'RSA.verify',
            'PBKDF2_HMAC_SHA256.generate',
        ],
        minMatches: 1,
    },

    // ── openpgp.js ────────────────────────────────────────────────────────
    {
        id: 'openpgp',
        label: 'OpenPGP.js',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'openpgp.encrypt', 'openpgp.decrypt',
            'openpgp.sign', 'openpgp.verify',
            'openpgp.generateKey', 'openpgp.readKey',
            'openpgp.readMessage', 'openpgp.createMessage',
            'openpgp.readCleartextMessage',
        ],
        minMatches: 1,
    },
    {
        id: 'openpgp_field',
        label: 'OpenPGP.js',
        confidence: 0.88,
        source: 'field',
        patterns: ['openpgp', 'armoredKey', 'armoredMessage', 'pgp'],
        minMatches: 1,
    },

    // ── crypto-hash / hash.js ─────────────────────────────────────────────
    {
        id: 'hashjs',
        label: 'hash.js',
        confidence: 0.88,
        source: 'call',
        patterns: [
            'hash.sha256', 'hash.sha512', 'hash.sha1', 'hash.sha224',
            'hash.ripemd160', 'hash.hmac',
        ],
        minMatches: 1,
    },

    // ── Web 浏览器内置（非 Crypto 的相关 API）────────────────────────────
    {
        id: 'btoa_atob',
        label: 'Base64 (btoa/atob)',
        confidence: 0.88,
        source: 'call',
        patterns: ['btoa', 'atob'],
        minMatches: 1,
    },
    {
        id: 'TextEncoder',
        label: 'TextEncoder/TextDecoder',
        confidence: 0.80,
        source: 'call',
        patterns: [
            'TextEncoder', 'TextDecoder',
            'textEncoder.encode', 'textDecoder.decode',
        ],
        minMatches: 1,
    },

    // ── Node.js Buffer ─────────────────────────────────────────────────────
    {
        id: 'node_buffer',
        label: 'Node.js Buffer',
        confidence: 0.80,
        source: 'call',
        patterns: [
            'Buffer.from', 'Buffer.alloc', 'Buffer.allocUnsafe',
            'Buffer.concat', 'Buffer.compare',
            'buf.toString', 'buf.readUInt32', 'buf.writeUInt32',
        ],
        minMatches: 2,
    },

    // ── crypto-random-string / uuid ───────────────────────────────────────
    {
        id: 'uuid',
        label: 'UUID / random-string',
        confidence: 0.75,
        source: 'call',
        patterns: [
            'uuid.v4', 'uuid.v1', 'uuidv4', 'uuidv1',
            'uuid()', 'v4()', 'randomUUID',
            'crypto.randomUUID',
        ],
        minMatches: 1,
    },

    // ── argon2 / scrypt（密码哈希）─────────────────────────────────────────
    {
        id: 'argon2',
        label: 'argon2 / scrypt',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'argon2.hash', 'argon2.verify', 'argon2.hashRaw',
            'argon2id', 'argon2i', 'argon2d',
            'scrypt', 'scryptSync',
        ],
        minMatches: 1,
    },

    // ── noble-hashes / noble-curves ───────────────────────────────────────
    {
        id: 'noble',
        label: '@noble/hashes & @noble/curves',
        confidence: 0.93,
        source: 'call',
        patterns: [
            'sha256.create', 'sha512.create', 'sha3_256.create',
            'blake3.create', 'blake2b.create', 'blake2s.create',
            'hmac.create',
            'secp256k1.sign', 'secp256k1.verify',
            'p256.sign', 'p384.sign', 'ed25519.sign',
            'x25519.getSharedSecret',
            'utils.bytesToHex', 'utils.hexToBytes',
        ],
        minMatches: 1,
    },

    // ── jose / jose-browser-runtime ──────────────────────────────────────
    {
        id: 'jose',
        label: 'jose (JWT/JWE/JWK)',
        confidence: 0.95,
        source: 'call',
        patterns: [
            'jose.jwtVerify', 'jose.SignJWT', 'jose.jwtDecrypt',
            'jose.EncryptJWT', 'jose.generateKeyPair',
            'jose.importJWK', 'jose.exportJWK', 'jose.importSPKI',
            'jose.importPKCS8', 'jose.importX509',
            'new SignJWT', 'new EncryptJWT',
        ],
        minMatches: 1,
    },

    // ── passport.js（认证框架，不是加密但出现表示在做身份验证）──────────
    {
        id: 'passport',
        label: 'passport.js (auth)',
        confidence: 0.80,
        source: 'call',
        patterns: [
            'passport.authenticate', 'passport.initialize',
            'passport.use', 'passport.serializeUser',
            'passport.deserializeUser',
        ],
        minMatches: 1,
    },

    // ── HTTP 签名（aws4 / aws-signature）──────────────────────────────────
    {
        id: 'aws_sig',
        label: 'AWS Signature / aws4',
        confidence: 0.92,
        source: 'call',
        patterns: [
            'aws4.sign', 'aws4.request',
            'getSignedHeaders', 'getSignature',
            'createHmac',   // 连续出现多次时可能是 AWS SigV4
            'hmac.digest',
        ],
        minMatches: 1,
    },
    {
        id: 'aws_sig_field',
        label: 'AWS Signature / aws4',
        confidence: 0.85,
        source: 'field',
        patterns: [
            'Authorization', 'X-Amz-Signature', 'X-Amz-Date',
            'AWS4-HMAC-SHA256', 'SignedHeaders', 'Credential',
        ],
        minMatches: 2,
    },
];

/**
 * 从命中的调用/字段列表中，归并同一规则下的所有命中条目
 * 返回 { ruleId → [{ fnName, line, cnt }] }
 */
function matchLibRules(callFnCounts, fieldOffsets, source) {
    const matched = {};
    const data = source === 'call' ? callFnCounts : fieldOffsets;
    for (const rule of LIB_RULES) {
        if (rule.source !== source) continue;
        const hits = [];
        for (const item of data) {
            const key = source === 'call' ? item.fn_name : item.offset;
            if (!key) continue;
            const lk = key.toLowerCase();
            if (rule.patterns.some(p => lk === p.toLowerCase() || lk.includes(p.toLowerCase()))) {
                hits.push(item);
            }
        }
        if (hits.length >= (rule.minMatches ?? 1)) {
            matched[rule.id] = { rule, hits };
        }
    }
    return matched;
}
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

export default class I1CryptoDetector extends BasePlugin {
    static observes = ['F2-SmapLoader'];
    static id = 'I1-CryptoDetector';
    static deps = ['A3-HotPathAnalyzer', 'A8-ValuePatternDetector'];
    static description = '两路检测：①魔术常数特征（MD5/SHA1/SHA256/SHA512/SHA3/AES/RC4/DES/3DES/Blowfish/ChaCha20/RIPEMD-160/CRC32/CRC16/Tiger/Whirlpool/MurmurHash3/FNV/xxHash/Adler32 等）② 库调用特征（Web Crypto API/Node.js crypto/CryptoJS/forge/sjcl/jsrsasign/TweetNaCl/bcrypt.js/jsonwebtoken/elliptic/OpenPGP.js/@noble/argon2 等）';
    static displayName = 'I1 · CryptoDetector';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);

        db.run('DELETE FROM crypto_hints WHERE session_id = ?', [sessionId]);

        this.emitProgress(ctx, '读取 value_patterns...', 10);

        // 仅加载有已知密码学常数匹配的模式
        const patterns = db.all(
            'SELECT * FROM value_patterns WHERE session_id = ? AND matched_constant IS NOT NULL',
            [sessionId]
        );

        // 判断是否有循环
        const loopRow = db.get(
            'SELECT COUNT(*) AS cnt FROM loops WHERE session_id = ?',
            [sessionId]
        );
        const hasLoops = (loopRow?.cnt ?? 0) > 0;

        const hints = [];

        // ── MD5 ─────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 MD5...', 20);
        const md5Patterns = patterns.filter(p =>
            p.matched_constant?.startsWith('MD5_INIT') ||
            p.matched_constant === 'MD5/SHA1_INIT'
        );
        if (md5Patterns.length >= 2) {
            hints.push({
                algorithm: 'MD5',
                confidence: Math.min(0.5 + md5Patterns.length * 0.1, 0.95),
                evidence: JSON.stringify(md5Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: md5Patterns[0].iid,
                line: md5Patterns[0].line,
                fn_name: null,
            });
        }

        // ── SHA1 ─────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 SHA1...', 30);
        const sha1Patterns = patterns.filter(p =>
            p.matched_constant?.includes('SHA1') ||
            p.matched_constant === 'MD5/SHA1_INIT'
        );
        // SHA1 需要至少 SHA1_H4 + 共享的初始向量
        const hasSha1H4 = sha1Patterns.some(p =>
            p.matched_constant?.startsWith('SHA1_H4') ||
            p.matched_constant?.includes('SHA1_INIT')
        );
        if (sha1Patterns.length >= 2 && hasSha1H4) {
            hints.push({
                algorithm: 'SHA1',
                confidence: Math.min(0.5 + sha1Patterns.length * 0.1, 0.90),
                evidence: JSON.stringify(sha1Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: sha1Patterns[0].iid,
                line: sha1Patterns[0].line,
                fn_name: null,
            });
        }

        // ── SHA-256 ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 SHA256...', 40);
        const sha256Patterns = patterns.filter(p =>
            p.matched_constant?.startsWith('SHA256_')
        );
        if (sha256Patterns.length >= 2) {
            hints.push({
                algorithm: 'SHA256',
                confidence: Math.min(0.5 + sha256Patterns.length * 0.1, 0.92),
                evidence: JSON.stringify(sha256Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: sha256Patterns[0].iid,
                line: sha256Patterns[0].line,
                fn_name: null,
            });
        }

        // ── AES ──────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 AES...', 50);
        const aesPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('AES_KEY')
        );
        if (aesPatterns.length > 0 && hasLoops) {
            hints.push({
                algorithm: aesPatterns[0].matched_constant === 'AES_KEY_256' ? 'AES-256' : 'AES-128',
                confidence: 0.70,
                evidence: JSON.stringify(aesPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: aesPatterns[0].iid,
                line: aesPatterns[0].line,
                fn_name: null,
            });
        }

        // ── RC4 ──────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 RC4...', 55);
        const rc4Patterns = patterns.filter(p =>
            p.matched_constant === 'RC4_SBOX_CANDIDATE'
        );
        if (rc4Patterns.length > 0 && hasLoops) {
            hints.push({
                algorithm: 'RC4',
                confidence: 0.75,
                evidence: JSON.stringify(rc4Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: rc4Patterns[0].iid,
                line: rc4Patterns[0].line,
                fn_name: null,
            });
        }

        // ── Base64 ───────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 Base64...', 60);
        const b64Patterns = patterns.filter(p =>
            p.matched_constant === 'BASE64_CHARSET'
        );
        if (b64Patterns.length > 0) {
            hints.push({
                algorithm: 'Base64',
                confidence: 0.90,
                evidence: JSON.stringify(b64Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: b64Patterns[0].iid,
                line: b64Patterns[0].line,
                fn_name: null,
            });
        }

        // ── XOR ──────────────────────────────────────────────────────────────
        // 检测 src_text 中含有 ^ 操作的高频 iid（循环 XOR 是流密码/哈希的特征）
        this.emitProgress(ctx, '检测 XOR 模式...', 70);
        if (hasLoops) {
            // src_text 已从 events 移除（Phase D），改从 smap 按 iid 查询
            // 使用 LEFT JOIN 保留 iid=NULL 的事件（INNER JOIN 会漏掉无源码映射的事件）
            const xorEvents = db.all(
                `SELECT e.iid, s.sl AS line, COUNT(*) AS cnt
                 FROM events e
                 LEFT JOIN smap s ON s.session_id = e.session_id AND s.iid = e.iid
                 WHERE e.session_id = ? AND s.src_text LIKE '%^%'
                 GROUP BY e.iid
                 ORDER BY cnt DESC
                 LIMIT 5`,
                [sessionId]
            );
            if (xorEvents.length > 0) {
                const topXor = xorEvents[0];
                hints.push({
                    algorithm: 'XOR',
                    confidence: 0.60,
                    evidence: JSON.stringify([{
                        iid: topXor.iid,
                        line: topXor.line,
                        xorCount: topXor.cnt,
                    }]),
                    iid: topXor.iid,
                    line: topXor.line,
                    fn_name: null,
                });
            }
        }

        // ── SHA-512 ───────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 SHA-512...', 72);
        const sha512Patterns = patterns.filter(p =>
            p.matched_constant?.startsWith('SHA512_')
        );
        if (sha512Patterns.length >= 2) {
            hints.push({
                algorithm: 'SHA-512',
                confidence: Math.min(0.55 + sha512Patterns.length * 0.08, 0.92),
                evidence: JSON.stringify(sha512Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: sha512Patterns[0].iid,
                line: sha512Patterns[0].line,
                fn_name: null,
            });
        }

        // ── SHA-3 / Keccak ───────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 SHA-3/Keccak...', 73);
        const sha3Patterns = patterns.filter(p =>
            p.matched_constant?.startsWith('KECCAK_')
        );
        // RC0=1 已移除（太普通），现在任意一个 Keccak 大数值常数即可触发
        if (sha3Patterns.length >= 1) {
            hints.push({
                algorithm: 'SHA-3/Keccak',
                confidence: Math.min(0.5 + sha3Patterns.length * 0.1, 0.90),
                evidence: JSON.stringify(sha3Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: sha3Patterns[0].iid,
                line: sha3Patterns[0].line,
                fn_name: null,
            });
        }

        // ── RIPEMD-160 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 RIPEMD-160...', 74);
        const ripemdPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('RIPEMD160_')
        );
        if (ripemdPatterns.length >= 2) {
            hints.push({
                algorithm: 'RIPEMD-160',
                confidence: Math.min(0.5 + ripemdPatterns.length * 0.1, 0.90),
                evidence: JSON.stringify(ripemdPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: ripemdPatterns[0].iid,
                line: ripemdPatterns[0].line,
                fn_name: null,
            });
        }

        // ── DES / 3DES ────────────────────────────────────────────────────────
        // 注意：DES_IP_PERM_*/DES_E_EXP_*/DES_P_PERM_* 单值已移除（均为小整数误报源）
        // 现在只通过数组级特征（DES_IP_TABLE 64元素置换表 / DES_SBOX_CANDIDATE）识别
        this.emitProgress(ctx, '检测 DES/3DES...', 75);
        const desPatterns = patterns.filter(p =>
            p.matched_constant === 'DES_SBOX_CANDIDATE' ||
            p.matched_constant === 'DES_IP_TABLE'
        );
        // 必须命中到数组级特征才报告（单个小数值常数已无法匹配）
        if (desPatterns.length >= 1) {
            // 判断是否有多个 S-box 特征（3DES 会有更多调用次数）
            const sboxCount = desPatterns.filter(p =>
                p.matched_constant === 'DES_SBOX_CANDIDATE'
            ).length;
            hints.push({
                algorithm: sboxCount >= 3 ? '3DES' : 'DES',
                confidence: Math.min(0.50 + desPatterns.length * 0.15, 0.88),
                evidence: JSON.stringify(desPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: desPatterns[0].iid,
                line: desPatterns[0].line,
                fn_name: null,
            });
        }

        // ── Blowfish ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 Blowfish...', 76);
        const blowfishPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('BLOWFISH_')
        );
        if (blowfishPatterns.length >= 2) {
            hints.push({
                algorithm: 'Blowfish',
                confidence: Math.min(0.5 + blowfishPatterns.length * 0.1, 0.90),
                evidence: JSON.stringify(blowfishPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: blowfishPatterns[0].iid,
                line: blowfishPatterns[0].line,
                fn_name: null,
            });
        }

        // ── ChaCha20 / Salsa20 ────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 ChaCha20/Salsa20...', 77);
        const chachaPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('CHACHA20_') ||
            p.matched_constant?.startsWith('SALSA20_') ||
            p.matched_constant === 'CHACHA20_STATE'
        );
        if (chachaPatterns.length >= 2) {
            // 如果有完整 state 或者 4 个常量都命中，高置信度
            const hasState = chachaPatterns.some(p => p.matched_constant === 'CHACHA20_STATE');
            hints.push({
                algorithm: 'ChaCha20/Salsa20',
                confidence: hasState ? 0.92 : Math.min(0.5 + chachaPatterns.length * 0.12, 0.90),
                evidence: JSON.stringify(chachaPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: chachaPatterns[0].iid,
                line: chachaPatterns[0].line,
                fn_name: null,
            });
        }

        // ── CRC-32 ────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 CRC-32...', 78);
        const crc32Patterns = patterns.filter(p =>
            p.matched_constant?.startsWith('CRC32_')
        );
        if (crc32Patterns.length >= 1) {
            const hasTable = crc32Patterns.some(p => p.matched_constant === 'CRC32_TABLE');
            hints.push({
                algorithm: 'CRC-32',
                confidence: hasTable ? 0.92 : Math.min(0.50 + crc32Patterns.length * 0.1, 0.85),
                evidence: JSON.stringify(crc32Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: crc32Patterns[0].iid,
                line: crc32Patterns[0].line,
                fn_name: null,
            });
        }

        // ── CRC-16 ────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 CRC-16...', 78);
        const crc16Patterns = patterns.filter(p =>
            p.matched_constant?.startsWith('CRC16_')
        );
        if (crc16Patterns.length >= 1) {
            hints.push({
                algorithm: 'CRC-16',
                confidence: Math.min(0.45 + crc16Patterns.length * 0.1, 0.80),
                evidence: JSON.stringify(crc16Patterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: crc16Patterns[0].iid,
                line: crc16Patterns[0].line,
                fn_name: null,
            });
        }

        // ── Tiger ─────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 Tiger...', 79);
        const tigerPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('TIGER_')
        );
        if (tigerPatterns.length >= 2) {
            hints.push({
                algorithm: 'Tiger',
                confidence: Math.min(0.5 + tigerPatterns.length * 0.1, 0.88),
                evidence: JSON.stringify(tigerPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: tigerPatterns[0].iid,
                line: tigerPatterns[0].line,
                fn_name: null,
            });
        }

        // ── Whirlpool ─────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 Whirlpool...', 79);
        const whirlpoolPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('WHIRLPOOL_')
        );
        if (whirlpoolPatterns.length >= 1) {
            hints.push({
                algorithm: 'Whirlpool',
                confidence: Math.min(0.45 + whirlpoolPatterns.length * 0.12, 0.85),
                evidence: JSON.stringify(whirlpoolPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: whirlpoolPatterns[0].iid,
                line: whirlpoolPatterns[0].line,
                fn_name: null,
            });
        }

        // ── MurmurHash3 ───────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 MurmurHash3...', 80);
        const murmurPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('MURMUR3_')
        );
        if (murmurPatterns.length >= 2) {
            hints.push({
                algorithm: 'MurmurHash3',
                confidence: Math.min(0.5 + murmurPatterns.length * 0.15, 0.90),
                evidence: JSON.stringify(murmurPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: murmurPatterns[0].iid,
                line: murmurPatterns[0].line,
                fn_name: null,
            });
        }

        // ── FNV Hash ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 FNV Hash...', 80);
        const fnvPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('FNV32_')
        );
        if (fnvPatterns.length >= 1) {
            hints.push({
                algorithm: 'FNV-32',
                confidence: Math.min(0.50 + fnvPatterns.length * 0.15, 0.88),
                evidence: JSON.stringify(fnvPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: fnvPatterns[0].iid,
                line: fnvPatterns[0].line,
                fn_name: null,
            });
        }

        // ── xxHash ────────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 xxHash...', 81);
        const xxhashPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('XXHASH32_')
        );
        if (xxhashPatterns.length >= 2) {
            hints.push({
                algorithm: 'xxHash32',
                confidence: Math.min(0.5 + xxhashPatterns.length * 0.12, 0.88),
                evidence: JSON.stringify(xxhashPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: xxhashPatterns[0].iid,
                line: xxhashPatterns[0].line,
                fn_name: null,
            });
        }

        // ── Adler-32 ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '检测 Adler-32...', 81);
        const adlerPatterns = patterns.filter(p =>
            p.matched_constant?.startsWith('ADLER32_')
        );
        if (adlerPatterns.length >= 1) {
            hints.push({
                algorithm: 'Adler-32',
                confidence: Math.min(0.40 + adlerPatterns.length * 0.15, 0.80),
                evidence: JSON.stringify(adlerPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: adlerPatterns[0].iid,
                line: adlerPatterns[0].line,
                fn_name: null,
            });
        }

        // ── HMAC ──────────────────────────────────────────────────────────────
        // 注意：HMAC_IPAD(54)/HMAC_OPAD(92) 已从 A8 常数表中删除（均为普通小整数误报源）
        // HMAC 通过第二路库调用特征识别（NodeCrypto.createHmac / aws4.sign 等），
        // 此处魔术常数路径已无效，跳过。

        // ═══════════════════════════════════════════════════════════════════
        // ── 第二路：库调用特征检测 ──────────────────────────────────────────
        // ═══════════════════════════════════════════════════════════════════
        this.emitProgress(ctx, '扫描库调用特征（call_edges）...', 83);

        // 1. 获取调用频率统计（all fn_name from call_edges，按调用次数降序）
        const _fnNameQueryLimit = cfg('plugins.I1_CryptoDetector.fnNameQueryLimit');
        let callFnCounts = [];
        try {
            callFnCounts = db.all(
                `SELECT fn_name, COUNT(*) AS cnt, MIN(caller_line) AS line
                 FROM call_edges
                 WHERE session_id = ? AND fn_name IS NOT NULL
                 GROUP BY fn_name
                 ORDER BY cnt DESC
                 LIMIT ?`,
                [sessionId, _fnNameQueryLimit]
            );
        } catch { /* call_edges 可能未运行 */ }

        // 2. 获取 fields 表中出现的 offset（属性访问名）
        const _fieldOffsetLimit = cfg('plugins.I1_CryptoDetector.fnNameQueryLimit');
        let fieldOffsets = [];
        try {
            fieldOffsets = db.all(
                `SELECT offset, COUNT(*) AS cnt, MIN(event_id) AS first_event_id
                 FROM fields
                 WHERE session_id = ? AND offset IS NOT NULL
                 GROUP BY offset
                 ORDER BY cnt DESC
                 LIMIT ?`,
                [sessionId, _fieldOffsetLimit]
            );
        } catch { /* fields 可能为空 */ }

        // 3. 匹配 call 规则
        const callMatches = matchLibRules(callFnCounts, null, 'call');
        // 4. 匹配 field 规则
        const fieldMatches = matchLibRules(null, fieldOffsets, 'field');

        // 5. 合并两路结果，同一逻辑库只报告一次（call 优先，置信度高）
        const reportedLibIds = new Set();
        const allLibMatches = { ...callMatches };
        for (const [id, m] of Object.entries(fieldMatches)) {
            // field 规则 id 通常带 _field 后缀，对应同名 call 规则
            const baseId = id.replace('_field', '');
            if (!allLibMatches[baseId]) {
                allLibMatches[id] = m;
            }
        }

        for (const [id, { rule, hits }] of Object.entries(allLibMatches)) {
            const baseId = id.replace('_field', '');
            if (reportedLibIds.has(baseId)) continue;
            reportedLibIds.add(baseId);

            // 取第一个命中点的行号作为定位
            const firstHit = hits[0];
            const line = firstHit?.line ?? firstHit?.caller_line ?? null;
            const evidence = JSON.stringify(hits.slice(0, 6).map(h => ({
                fn: rule.source === 'call' ? h.fn_name : h.offset,
                cnt: h.cnt,
                line: h.line ?? h.caller_line ?? null,
            })));

            hints.push({
                algorithm: rule.label,
                confidence: rule.confidence,
                evidence,
                iid: null,
                line,
                fn_name: rule.source === 'call' ? firstHit?.fn_name : null,
            });
        }

        // ── AES S-box（独立标识，有别于密钥长度检测）────────────────────────
        this.emitProgress(ctx, '检测 AES S-box...', 84);
        const aesSboxPatterns = patterns.filter(p =>
            p.matched_constant === 'AES_SBOX' ||
            p.matched_constant === 'AES_INV_SBOX' ||
            p.matched_constant === 'SHA256_K_TABLE'
        );
        if (aesSboxPatterns.length > 0 && !aesPatterns.length) {
            // 仅当前面没检测到 AES key 时才单独报告 S-box 特征
            hints.push({
                algorithm: 'AES (S-box)',
                confidence: 0.80,
                evidence: JSON.stringify(aesSboxPatterns.map(p => ({
                    constant: p.matched_constant,
                    line: p.line,
                    var: p.var_name,
                }))),
                iid: aesSboxPatterns[0].iid,
                line: aesSboxPatterns[0].line,
                fn_name: null,
            });
        }

        this.emitProgress(ctx, `写入 ${hints.length} 个加密提示...`, 85);

        if (hints.length > 0) {
            const rawDb = db.raw();
            const stmt = rawDb.prepare(
                'INSERT INTO crypto_hints (session_id, algorithm, confidence, evidence, iid, line, fn_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            rawDb.transaction(() => {
                for (const h of hints) {
                    stmt.run(sessionId, h.algorithm, h.confidence, h.evidence, h.iid, h.line, h.fn_name);
                }
            })();
        }

        this.emitProgress(ctx, `完成，检测到 ${hints.length} 个算法特征`, 100);

        // 按置信度排序
        const sortedHints = [...hints].sort((a, b) => b.confidence - a.confidence);
        const topConf     = sortedHints.length > 0 ? Math.round((sortedHints[0].confidence ?? 0) * 100) : 0;
        const uniqueAlgos = [...new Set(hints.map(h => h.algorithm).filter(Boolean))];

        this.emitDone(ctx, {
            hintCount:     hints.length,
            algCount:      uniqueAlgos.length,
            topConf,
            algorithms:    uniqueAlgos,
            topAlgorithms: sortedHints
                .slice(0, 5)
                .map(h => `${h.algorithm}(${(h.confidence * 100).toFixed(0)}%)`),
        });
    }
}
