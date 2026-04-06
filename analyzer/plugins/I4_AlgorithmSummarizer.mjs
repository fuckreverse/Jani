/**
 * I4_AlgorithmSummarizer.mjs — 算法汇总报告
 * 汇总所有已完成插件的分析结果，生成 JSON + Markdown 报告
 * 写入 analysis_summary 表
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';

export default class I4AlgorithmSummarizer extends BasePlugin {
    static id = 'I4-AlgorithmSummarizer';
    static deps = [
        'A3-HotPathAnalyzer',
        'A6-FunctionSignatureInfer',
        'I3-ObfuscationDetector',
    ];
    static description = '汇总所有分析结果，生成 JSON + Markdown 算法报告，写入 analysis_summary 表';
    static displayName = 'I4 · AlgorithmSummarizer';

    async run(ctx) {
        const { sessionId } = ctx;

        this.emitProgress(ctx, '汇总分析结果...', 0);

        // ── 会话基本信息 ────────────────────────────────────────────────────
        const session = db.get(
            'SELECT name, event_count, source_file, plugin_status FROM sessions WHERE id = ?',
            [sessionId]
        );

        // ── 事件统计 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '统计事件分布...', 10);
        const eventStats = db.all(
            'SELECT type, COUNT(*) as cnt FROM events WHERE session_id = ? GROUP BY type ORDER BY cnt DESC',
            [sessionId]
        );

        // ── 热路径 ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取热路径...', 20);
        const topHotIids = db.all(
            'SELECT iid, count, line, src_text FROM iid_counts WHERE session_id = ? ORDER BY count DESC LIMIT 10',
            [sessionId]
        );
        const loops = db.all(
            'SELECT iid, start_seq, end_seq, iteration_count, line FROM loops WHERE session_id = ? ORDER BY iteration_count DESC LIMIT 10',
            [sessionId]
        );

        // ── 调用图 ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '分析调用图...', 30);
        const callGraphStats = db.get(
            'SELECT COUNT(*) as total_calls, COUNT(DISTINCT fn_name) as unique_fns, MAX(depth) as max_depth FROM call_edges WHERE session_id = ?',
            [sessionId]
        );
        const topCalledFns = db.all(
            'SELECT fn_name, COUNT(*) as call_count FROM call_edges WHERE session_id = ? GROUP BY fn_name ORDER BY call_count DESC LIMIT 10',
            [sessionId]
        );

        // ── 函数签名 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取函数签名...', 40);
        const fnSigStats = db.get(
            'SELECT COUNT(*) as total, SUM(is_pure) as pure_count FROM fn_signatures WHERE session_id = ?',
            [sessionId]
        );
        const pureFunctions = db.all(
            'SELECT fn_name, fn_iid, call_count, arg_types, return_types FROM fn_signatures WHERE session_id = ? AND is_pure = 1 ORDER BY call_count DESC LIMIT 20',
            [sessionId]
        );

        // ── 字符串追踪 ──────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取字符串统计...', 50);
        const strStats = db.all(
            'SELECT encoding_hint, COUNT(*) as cnt FROM string_events WHERE session_id = ? GROUP BY encoding_hint ORDER BY cnt DESC',
            [sessionId]
        );
        const interestingStrings = db.all(
            `SELECT value, var_name, line, encoding_hint FROM string_events
             WHERE session_id = ? AND encoding_hint IN ('base64', 'hex')
             ORDER BY line ASC LIMIT 20`,
            [sessionId]
        );

        // ── 数据流 ──────────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取数据流统计...', 60);
        const dfStats = db.get(
            'SELECT COUNT(*) as total FROM dataflow_edges WHERE session_id = ?',
            [sessionId]
        );
        const dfByType = db.all(
            'SELECT edge_type, COUNT(*) as cnt FROM dataflow_edges WHERE session_id = ? GROUP BY edge_type ORDER BY cnt DESC',
            [sessionId]
        );

        // ── 对象变异 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取对象变异统计...', 65);
        const objMutStats = db.get(
            'SELECT COUNT(*) as total FROM object_timelines WHERE session_id = ? AND is_write = 1',
            [sessionId]
        );
        const topMutatedObjects = db.all(
            `SELECT base_var, COUNT(*) as mutation_count
             FROM object_timelines
             WHERE session_id = ? AND is_write = 1
             GROUP BY base_var
             ORDER BY mutation_count DESC LIMIT 10`,
            [sessionId]
        );

        // ── 加密检测 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取加密检测结果...', 70);
        const cryptoHints = db.all(
            'SELECT algorithm, confidence, fn_name, line FROM crypto_hints WHERE session_id = ? ORDER BY confidence DESC',
            [sessionId]
        );

        // ── 混淆检测 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '读取混淆检测结果...', 75);
        const obfHints = db.all(
            'SELECT hint_type, description, confidence FROM obfuscation_hints WHERE session_id = ? ORDER BY confidence DESC',
            [sessionId]
        );

        // ── 变量生命周期（高价值变量）────────────────────────────────────────
        this.emitProgress(ctx, '读取关键变量...', 80);
        const keyVars = db.all(
            `SELECT name, write_count, read_count, first_write_seq, last_read_seq
             FROM var_lifetime
             WHERE session_id = ?
             ORDER BY (write_count + read_count) DESC LIMIT 20`,
            [sessionId]
        );

        // ── 构建报告 ────────────────────────────────────────────────────────
        this.emitProgress(ctx, '生成报告...', 90);

        // 判断是否有混淆
        const isObfuscated = obfHints.length > 0;
        const obfScore = obfHints.length > 0
            ? obfHints.reduce((s, h) => s + (h.confidence || 0), 0) / obfHints.length
            : 0;

        // 判断是否有加密
        const hasCrypto = cryptoHints.length > 0;

        // 判断算法类型
        const algorithmTags = [];
        if (hasCrypto) {
            for (const h of cryptoHints) {
                if (!algorithmTags.includes(h.algorithm)) algorithmTags.push(h.algorithm);
            }
        }
        if (loops.length > 0) algorithmTags.push('循环密集型');
        if (isObfuscated) algorithmTags.push('混淆代码');
        if (interestingStrings.length > 0) algorithmTags.push('编码字符串');

        const report = {
            sessionId,
            sessionName: session ? session.name : null,
            generatedAt: Date.now(),
            overview: {
                eventCount: session ? (session.event_count || 0) : 0,
                eventTypeDistribution: eventStats,
                algorithmTags,
                isObfuscated,
                obfuscationScore: Math.round(obfScore * 100),
                hasCrypto,
                cryptoAlgorithms: algorithmTags.filter(t => !['循环密集型', '混淆代码', '编码字符串'].includes(t)),
            },
            hotPaths: {
                topIids: topHotIids,
                loops: loops.slice(0, 5),
            },
            callGraph: {
                totalCalls: callGraphStats ? callGraphStats.total_calls : 0,
                uniqueFunctions: callGraphStats ? callGraphStats.unique_fns : 0,
                maxCallDepth: callGraphStats ? callGraphStats.max_depth : 0,
                topCalledFunctions: topCalledFns,
            },
            functionSignatures: {
                total: fnSigStats ? fnSigStats.total : 0,
                pureCount: fnSigStats ? fnSigStats.pure_count : 0,
                pureFunctions,
            },
            dataFlow: {
                totalEdges: dfStats ? dfStats.total : 0,
                edgesByType: dfByType,
            },
            stringAnalysis: {
                byEncoding: strStats,
                interestingStrings,
            },
            objectMutations: {
                totalMutations: objMutStats ? objMutStats.total : 0,
                topMutatedObjects,
            },
            cryptoHints,
            obfuscationHints: obfHints,
            keyVariables: keyVars,
        };

        // ── 生成 Markdown ────────────────────────────────────────────────────
        const md = generateMarkdown(report);

        // ── 写入数据库 ───────────────────────────────────────────────────────
        db.run(
            `INSERT OR REPLACE INTO analysis_summary (session_id, generated_at, summary_json, summary_md)
             VALUES (?, ?, ?, ?)`,
            [sessionId, Date.now(), JSON.stringify(report), md]
        );

        this.emitProgress(ctx, '报告生成完成', 100);
        this.emitDone(ctx, {
            algorithmTags,
            isObfuscated,
            hasCrypto,
            eventCount: report.overview.eventCount,
        });
    }
}

function generateMarkdown(report) {
    const lines = [];
    lines.push(`# JTA 算法分析报告`);
    lines.push(`\n**会话：** ${report.sessionName || report.sessionId}`);
    lines.push(`**生成时间：** ${new Date(report.generatedAt).toLocaleString('zh-CN')}`);

    // 概览
    lines.push(`\n## 📊 概览`);
    lines.push(`- **总事件数：** ${(report.overview.eventCount || 0).toLocaleString('zh-CN')}`);
    if (report.overview.algorithmTags.length > 0) {
        lines.push(`- **识别标签：** ${report.overview.algorithmTags.map(t => `\`${t}\``).join(' · ')}`);
    }
    if (report.overview.isObfuscated) {
        lines.push(`- **混淆评分：** ${report.overview.obfuscationScore}% （⚠️ 疑似混淆）`);
    }
    if (report.overview.hasCrypto) {
        lines.push(`- **加密算法：** ${report.overview.cryptoAlgorithms.join(', ')}`);
    }

    // 事件分布
    if (report.overview.eventTypeDistribution.length > 0) {
        lines.push(`\n## 🔢 事件类型分布`);
        for (const e of report.overview.eventTypeDistribution.slice(0, 8)) {
            lines.push(`- \`${e.type}\`: ${e.cnt}`);
        }
    }

    // 热路径
    if (report.hotPaths.topIids.length > 0) {
        lines.push(`\n## 🔥 热路径 Top 10`);
        lines.push(`| iid | 执行次数 | 行号 | 源码 |`);
        lines.push(`|-----|---------|------|------|`);
        for (const h of report.hotPaths.topIids) {
            const src = h.src_text ? h.src_text.substring(0, 40).replace(/\|/g, '\\|') : '';
            lines.push(`| ${h.iid} | ${h.count} | ${h.line ?? '—'} | \`${src}\` |`);
        }
    }

    // 循环
    if (report.hotPaths.loops.length > 0) {
        lines.push(`\n## 🔁 检测到的循环`);
        for (const l of report.hotPaths.loops) {
            lines.push(`- iid=${l.iid} 行=${l.line ?? '—'} 迭代=${l.iteration_count} 次（SEQ ${l.start_seq}→${l.end_seq}）`);
        }
    }

    // 调用图
    lines.push(`\n## 📞 调用图统计`);
    lines.push(`- 总调用次数：${report.callGraph.totalCalls}`);
    lines.push(`- 唯一函数数：${report.callGraph.uniqueFunctions}`);
    lines.push(`- 最大调用深度：${report.callGraph.maxCallDepth}`);
    if (report.callGraph.topCalledFunctions.length > 0) {
        lines.push(`\n**调用频率 Top 10：**`);
        for (const f of report.callGraph.topCalledFunctions) {
            lines.push(`- \`${f.fn_name || '(anonymous)'}\`: ${f.call_count} 次`);
        }
    }

    // 函数签名
    if (report.functionSignatures.total > 0) {
        lines.push(`\n## 🔍 函数签名推断`);
        lines.push(`- 分析函数数：${report.functionSignatures.total}`);
        lines.push(`- 纯函数数：${report.functionSignatures.pureCount}`);
        if (report.functionSignatures.pureFunctions.length > 0) {
            lines.push(`\n**纯函数列表（前10个）：**`);
            for (const f of report.functionSignatures.pureFunctions.slice(0, 10)) {
                lines.push(`- \`${f.fn_name || '(anonymous)'}\` 调用 ${f.call_count} 次`);
            }
        }
    }

    // 数据流
    if (report.dataFlow.totalEdges > 0) {
        lines.push(`\n## 🔗 数据流图`);
        lines.push(`- 总边数：${report.dataFlow.totalEdges}`);
        for (const e of report.dataFlow.edgesByType) {
            lines.push(`  - \`${e.edge_type}\`: ${e.cnt} 条`);
        }
    }

    // 字符串分析
    lines.push(`\n## 🔤 字符串分析`);
    for (const s of report.stringAnalysis.byEncoding) {
        lines.push(`- \`${s.encoding_hint || 'plain'}\`: ${s.cnt} 个`);
    }
    if (report.stringAnalysis.interestingStrings.length > 0) {
        lines.push(`\n**可疑编码字符串（前10）：**`);
        for (const s of report.stringAnalysis.interestingStrings.slice(0, 10)) {
            const val = s.value ? s.value.substring(0, 60) : '';
            lines.push(`- \`${val}\` (${s.encoding_hint}) 行=${s.line ?? '—'} 变量=${s.var_name || '—'}`);
        }
    }

    // 对象变异
    if (report.objectMutations.totalMutations > 0) {
        lines.push(`\n## 🔄 对象属性变异`);
        lines.push(`- 总变异次数：${report.objectMutations.totalMutations}`);
        if (report.objectMutations.topMutatedObjects.length > 0) {
            lines.push(`\n**变异最频繁的对象：**`);
            for (const o of report.objectMutations.topMutatedObjects) {
                lines.push(`- \`${o.base_var}\`: ${o.mutation_count} 次`);
            }
        }
    }

    // 加密检测
    if (report.cryptoHints.length > 0) {
        lines.push(`\n## 🔐 加密算法检测`);
        for (const h of report.cryptoHints) {
            lines.push(`- **${h.algorithm}** 置信度=${(h.confidence * 100).toFixed(0)}%` +
                (h.fn_name ? ` 函数=${h.fn_name}` : '') +
                (h.line ? ` 行=${h.line}` : ''));
        }
    }

    // 混淆检测
    if (report.obfuscationHints.length > 0) {
        lines.push(`\n## 🕵️ 混淆检测`);
        for (const h of report.obfuscationHints) {
            lines.push(`- **[${h.hint_type}]** ${h.description} （置信度 ${(h.confidence * 100).toFixed(0)}%）`);
        }
    }

    // 关键变量
    if (report.keyVariables.length > 0) {
        lines.push(`\n## 📌 高频变量 Top 20`);
        lines.push(`| 变量名 | 写入次数 | 读取次数 |`);
        lines.push(`|--------|---------|---------|`);
        for (const v of report.keyVariables) {
            lines.push(`| \`${v.name}\` | ${v.write_count} | ${v.read_count} |`);
        }
    }

    lines.push(`\n---`);
    lines.push(`*由 Jani Trace Analyzer (JTA) 自动生成*`);

    return lines.join('\n');
}
