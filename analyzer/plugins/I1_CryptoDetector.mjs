/**
 * I1_CryptoDetector.mjs — 加密算法识别
 * 依赖：A3-HotPathAnalyzer（loops 表）、A8-ValuePatternDetector（value_patterns 表）
 *
 * 综合 A3/A8 结果检测算法类型（AES/MD5/SHA/XOR/Base64/RC4），写入 crypto_hints 表。
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class I1CryptoDetector extends BasePlugin {
    static id = 'I1-CryptoDetector';
    static deps = ['A3-HotPathAnalyzer', 'A8-ValuePatternDetector'];
    static description = '综合 A3/A8 检测加密算法（AES/MD5/SHA/XOR/Base64/RC4）';
    static displayName = 'I1 · CryptoDetector';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '清空旧数据...', 0);

        // 迁移兼容：确保表有 line、fn_name 列
        try {
            db.exec(`
                DROP TABLE IF EXISTS crypto_hints;
                CREATE TABLE IF NOT EXISTS crypto_hints (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id  TEXT NOT NULL,
                    algorithm   TEXT,
                    confidence  REAL,
                    evidence    TEXT,
                    iid         INTEGER,
                    line        INTEGER,
                    fn_name     TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_crypto_hints_session ON crypto_hints(session_id);
            `);
        } catch (e) {
            db.run('DELETE FROM crypto_hints WHERE session_id = ?', [sessionId]);
        }

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
            const xorEvents = db.all(
                `SELECT e.iid, e.line, COUNT(*) AS cnt
                 FROM events e
                 WHERE e.session_id = ? AND e.src_text LIKE '%^%'
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

        this.emitProgress(ctx, `写入 ${hints.length} 个加密提示...`, 85);

        if (hints.length > 0) {
            db.transaction(() => {
                for (const h of hints) {
                    db.run(
                        'INSERT INTO crypto_hints (session_id, algorithm, confidence, evidence, iid, line, fn_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [sessionId, h.algorithm, h.confidence, h.evidence, h.iid, h.line, h.fn_name]
                    );
                }
            });
        }

        this.emitProgress(ctx, `完成，检测到 ${hints.length} 个算法特征`, 100);
        this.emitDone(ctx, {
            hintCount: hints.length,
            algorithms: hints.map(h => h.algorithm),
        });
    }
}
