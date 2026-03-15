#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * @file bin/preprocess.mjs — Jani JS 预处理工具
 *
 * 在插桩前对 JS 源代码进行 AST 级预处理，目标是在不改变逻辑的前提下：
 *   1. 将混淆/压缩代码恢复为更可读的结构，提升插桩 Trace 的可读性
 *   2. 将新式语法降级为旧版本，扩大插桩器的适用范围
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 用法：
 *   node bin/preprocess.mjs [选项] <输入文件>
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 预设（--preset）：
 *   deobfuscate    仅反混淆（默认）
 *   transpile      仅语法降级
 *   full           反混淆 + 语法降级
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 反混淆选项（--preset deobfuscate / full 时有效）：
 *   --split-sequence          逗号表达式拆分为多条语句（默认开启）
 *   --no-split-sequence       关闭逗号表达式拆分
 *   --replace-void            void 0 → undefined（默认开启）
 *   --no-replace-void         关闭 void 替换
 *   --fold-constants          编译期常量折叠（默认开启）
 *   --no-fold-constants       关闭常量折叠
 *   --simplify-boolean        布尔简化 !!x → Boolean(x)（默认开启）
 *   --no-simplify-boolean     关闭布尔简化
 *   --expand-conditional      条件表达式 ? : 展开为 if-else（默认关闭）
 *   --inline-dead-code        删除永假/永真死代码（默认开启）
 *   --no-inline-dead-code     关闭死代码删除
 *   --flatten-iife            无参 IIFE 展开（默认关闭，会改变作用域）
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 语法降级选项（--preset transpile / full 时有效）：
 *   --targets <t>             Browserslist 目标，如 "defaults"、"last 2 Chrome versions"
 *                             或 JSON 对象 '{"node":"12"}' （默认 "defaults"）
 *   --loose                   宽松模式，生成更简洁的降级代码
 *   --no-modules              保留 ESM import/export（默认）
 *   --to-commonjs             将 ESM 转为 CommonJS
 *   --transpile-debug         输出 preset-env 选择的变换列表
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 输出选项：
 *   --output <file>           输出文件路径（默认：<input>_preprocessed.js）
 *   --stdout                  输出到 stdout（不写文件）
 *   --source-type <t>         'script'（默认）或 'module'
 *   --no-comments             去除所有注释
 *   --dry-run                 只打印统计，不写文件
 *   --stats                   总是打印详细统计
 *   --debug                   详细日志
 *   --help / -h               显示此帮助
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 示例：
 *
 *   # 反混淆（默认）
 *   node bin/preprocess.mjs data/cl.js
 *   node bin/preprocess.mjs --output data/cl-clean.js data/cl.js
 *
 *   # 仅语法降级到 ES5
 *   node bin/preprocess.mjs --preset transpile --targets '{"ie":"11"}' data/app.js
 *
 *   # 完整流程：反混淆 + 降级 + 展开 IIFE
 *   node bin/preprocess.mjs --preset full --flatten-iife --targets defaults data/cl.js
 *
 *   # 只做逗号拆分，输出到 stdout 查看效果
 *   node bin/preprocess.mjs --no-fold-constants --no-replace-void --stdout data/cl.js
 *
 *   # 接管 stdin（管道用法）
 *   cat data/cl.js | node bin/preprocess.mjs --stdout -
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, basename }                          from 'path';
import { fileURLToPath }                                       from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT_DIR   = resolve(__dirname, '..');
const SRC        = (...parts) => [ROOT_DIR, 'src', ...parts].join('/');

// ── 日志 ──────────────────────────────────────────────────────────────────────

let _debug = process.env.JALANGI_DEBUG === '1';
const log = {
    debug(...a) { if (_debug) console.error('[preprocess]', ...a); },
    info(...a)  { console.error('[preprocess]', ...a); },
    warn(...a)  { console.error('[preprocess] ⚠', ...a); },
    error(...a) { console.error('[preprocess] ✗', ...a); },
};

// ── 帮助文本 ──────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
用法：
  node bin/preprocess.mjs [选项] <输入文件>

预设：
  --preset deobfuscate   仅反混淆（默认）
  --preset transpile     仅语法降级
  --preset full          反混淆 + 语法降级

反混淆选项（默认均开启，前缀 --no- 关闭）：
  --split-sequence       逗号表达式拆分
  --replace-void         void 0 → undefined
  --fold-constants       编译期常量折叠
  --simplify-boolean     !!x → Boolean(x)
  --inline-dead-code     死代码删除

反混淆选项（默认关闭）：
  --expand-conditional   条件表达式展开为 if-else
  --flatten-iife         无参 IIFE 展开（改变作用域，慎用）

语法降级选项（--preset transpile/full 时有效）：
  --targets <t>          Browserslist 目标（默认 "defaults"）
  --loose                宽松模式
  --to-commonjs          将 ESM import/export → CommonJS require/exports
  --transpile-debug      打印 preset-env 选择的变换列表

输出选项：
  --output <file>        输出文件（默认 <input>_preprocessed.js）
  --stdout               输出到 stdout
  --source-type <t>      'script'（默认）或 'module'
  --no-comments          去除注释
  --dry-run              只统计，不写文件
  --stats                打印详细统计
  --debug                详细日志
  --help / -h            显示此帮助

示例：
  node bin/preprocess.mjs data/cl.js
  node bin/preprocess.mjs --preset full --targets defaults data/cl.js
  node bin/preprocess.mjs --stdout --no-fold-constants data/cl.js
  node bin/preprocess.mjs --preset transpile --targets '{"ie":"11"}' data/app.js
    `.trim());
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        // 预设
        preset:             'deobfuscate',

        // 反混淆开关
        splitSequence:      true,
        replaceVoid:        true,
        foldConstants:      true,
        simplifyBoolean:    true,
        expandConditional:  false,
        inlineDeadCode:     true,
        flattenIife:        false,

        // 降级
        targets:            'defaults',
        loose:              false,
        modules:            false,  // false = 保留 ESM
        transpileDebug:     false,

        // 输出
        output:             null,
        toStdout:           false,
        sourceType:         'script',
        comments:           true,
        dryRun:             false,
        showStats:          false,

        // 输入
        file:               null,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--help': case '-h':
                printHelp(); process.exit(0); break;
            case '--preset':
                opts.preset = argv[++i]; break;

            // 反混淆
            case '--split-sequence':        opts.splitSequence     = true;  break;
            case '--no-split-sequence':     opts.splitSequence     = false; break;
            case '--replace-void':          opts.replaceVoid       = true;  break;
            case '--no-replace-void':       opts.replaceVoid       = false; break;
            case '--fold-constants':        opts.foldConstants     = true;  break;
            case '--no-fold-constants':     opts.foldConstants     = false; break;
            case '--simplify-boolean':      opts.simplifyBoolean   = true;  break;
            case '--no-simplify-boolean':   opts.simplifyBoolean   = false; break;
            case '--expand-conditional':    opts.expandConditional = true;  break;
            case '--no-expand-conditional': opts.expandConditional = false; break;
            case '--inline-dead-code':      opts.inlineDeadCode    = true;  break;
            case '--no-inline-dead-code':   opts.inlineDeadCode    = false; break;
            case '--flatten-iife':          opts.flattenIife       = true;  break;
            case '--no-flatten-iife':       opts.flattenIife       = false; break;

            // 降级
            case '--targets': {
                const raw = argv[++i];
                // 支持 JSON 格式 {"node":"12"} 或普通字符串 "defaults"
                try { opts.targets = JSON.parse(raw); }
                catch (_) { opts.targets = raw; }
                break;
            }
            case '--loose':          opts.loose          = true;       break;
            case '--to-commonjs':    opts.modules        = 'commonjs'; break;
            case '--no-modules':     opts.modules        = false;      break;
            case '--transpile-debug':opts.transpileDebug = true;       break;

            // 输出
            case '--output':         opts.output     = resolve(argv[++i]); break;
            case '--stdout':         opts.toStdout   = true; break;
            case '--source-type':    opts.sourceType = argv[++i]; break;
            case '--no-comments':    opts.comments   = false; break;
            case '--dry-run':        opts.dryRun     = true; break;
            case '--stats':          opts.showStats  = true; break;
            case '--debug':
                opts.debug = true;
                _debug = true;
                break;

            default:
                if (a.startsWith('--')) {
                    log.error(`未知选项: ${a}`);
                    process.exit(1);
                }
                opts.file = (a === '-') ? '-' : resolve(a);
        }
    }

    return opts;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 生成默认输出路径：foo.js → foo_preprocessed.js */
function defaultOutPath(inputPath) {
    const b = basename(inputPath);
    return resolve(dirname(inputPath), b.replace(/\.js$/, '_preprocessed.js'));
}

function ensureDir(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 打印统计表格 */
function printStats(stats, warnings) {
    const allStats = Object.entries(stats);
    if (allStats.length === 0 && warnings.length === 0) return;

    console.error('\n── 统计 ──────────────────────────────────────');
    for (const [plugin, pluginStats] of allStats) {
        console.error(`  ${plugin}:`);
        for (const [k, v] of Object.entries(pluginStats)) {
            if (v !== 0) console.error(`    ${k}: ${v}`);
        }
    }
    if (warnings.length > 0) {
        console.error(`\n  ⚠ 警告 (${warnings.length}):`);
        for (const w of warnings) console.error(`    · ${w}`);
    }
    console.error('──────────────────────────────────────────────\n');
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);

    if (argv.length === 0) {
        printHelp();
        process.exit(0);
    }

    const opts = parseArgs(argv);

    if (!opts.file) {
        log.error('请指定输入文件（或 - 表示 stdin）');
        process.exit(1);
    }

    // ── 验证 preset ───────────────────────────────────────────────────────────
    const VALID_PRESETS = ['deobfuscate', 'transpile', 'full'];
    if (!VALID_PRESETS.includes(opts.preset)) {
        log.error(`未知 preset: "${opts.preset}"，可用值: ${VALID_PRESETS.join(' | ')}`);
        process.exit(1);
    }

    // ── 读取源代码 ────────────────────────────────────────────────────────────
    let code;
    if (opts.file === '-') {
        // 从 stdin 读
        const chunks = [];
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        code = chunks.join('');
    } else {
        if (!existsSync(opts.file)) {
            log.error(`文件不存在: ${opts.file}`);
            process.exit(1);
        }
        code = readFileSync(opts.file, 'utf8');
    }
    log.debug(`读取 ${opts.file === '-' ? 'stdin' : opts.file} (${(code.length / 1024).toFixed(1)} KB)`);

    // ── 构建插件列表 ──────────────────────────────────────────────────────────
    const { DeobfuscatePlugin } = await import(SRC('preprocess', 'plugins', 'DeobfuscatePlugin.js'));
    const { TranspilePlugin   } = await import(SRC('preprocess', 'plugins', 'TranspilePlugin.js'));

    const plugins = [];

    if (opts.preset === 'deobfuscate' || opts.preset === 'full') {
        plugins.push(new DeobfuscatePlugin({
            splitSequence:    opts.splitSequence,
            replaceVoid:      opts.replaceVoid,
            foldConstants:    opts.foldConstants,
            simplifyBoolean:  opts.simplifyBoolean,
            expandConditional:opts.expandConditional,
            inlineDeadCode:   opts.inlineDeadCode,
            flattenIIFE:      opts.flattenIife,
        }));
    }

    if (opts.preset === 'transpile' || opts.preset === 'full') {
        plugins.push(new TranspilePlugin({
            targets:    opts.targets,
            loose:      opts.loose,
            modules:    opts.modules,
            debug:      opts.transpileDebug,
        }));
    }

    // ── 执行预处理 ────────────────────────────────────────────────────────────
    const { preprocessCode } = await import(SRC('preprocess', 'index.js'));

    log.debug(`运行插件: ${plugins.map(p => p.name).join(', ')}`);
    const t0 = Date.now();

    let result;
    try {
        result = await preprocessCode(code, {
            plugins,
            sourceType: opts.sourceType,
            comments:   opts.comments,
            compact:    false,
        });
    } catch (err) {
        log.error(`预处理失败: ${err.message}`);
        if (_debug && err.stack) log.error(err.stack);
        process.exit(1);
    }

    const elapsed = Date.now() - t0;
    log.debug(`预处理完成 (${elapsed}ms, ${(result.code.length / 1024).toFixed(1)} KB)`);

    // ── 输出结果 ──────────────────────────────────────────────────────────────
    if (opts.toStdout) {
        process.stdout.write(result.code);
        if (opts.showStats) printStats(result.stats, result.warnings);
        return;
    }

    if (opts.dryRun) {
        const preview = result.code.slice(0, 1000) + (result.code.length > 1000 ? '\n...(截断)' : '');
        console.log('\n=== [dry-run] 预处理结果预览 ===\n');
        console.log(preview);
        printStats(result.stats, result.warnings);
        return;
    }

    // 写文件
    const outPath = opts.output ?? defaultOutPath(opts.file === '-' ? 'stdin.js' : opts.file);
    ensureDir(outPath);
    writeFileSync(outPath, result.code, 'utf8');

    // 计算变化量
    const origLines = code.split('\n').length;
    const newLines  = result.code.split('\n').length;
    const sizeDiff  = result.code.length - code.length;

    console.log(`✓ 预处理完成`);
    console.log(`  输入      : ${opts.file === '-' ? '(stdin)' : opts.file}`);
    console.log(`  输出      : ${outPath}`);
    console.log(`  原始大小  : ${(code.length / 1024).toFixed(1)} KB (${origLines} 行)`);
    console.log(`  输出大小  : ${(result.code.length / 1024).toFixed(1)} KB (${newLines} 行)`);
    console.log(`  大小变化  : ${sizeDiff >= 0 ? '+' : ''}${(sizeDiff / 1024).toFixed(1)} KB`);
    console.log(`  耗时      : ${elapsed}ms`);
    console.log(`  Preset    : ${opts.preset}`);

    if (result.warnings.length > 0) {
        console.log(`  ⚠ 警告    : ${result.warnings.length} 条（--stats 查看详情）`);
    }

    // 打印每个插件的统计
    for (const [pluginName, pluginStats] of Object.entries(result.stats)) {
        const nonZero = Object.entries(pluginStats).filter(([, v]) => v !== 0);
        if (nonZero.length > 0) {
            console.log(`  [${pluginName}]`);
            for (const [k, v] of nonZero) {
                const label = _statLabel(k);
                console.log(`    ${label}: ${v}`);
            }
        }
    }

    if (opts.showStats) printStats(result.stats, result.warnings);
}

/** 统计字段的中文标签 */
function _statLabel(key) {
    const MAP = {
        sequenceSplit:           '逗号表达式拆分',
        voidReplaced:            'void 0 替换',
        constantsFolded:         '常量折叠',
        booleanSimplified:       '布尔简化',
        conditionalExpanded:     '条件表达式展开',
        deadCodeRemoved:         '死代码删除',
        iifeFlattened:           'IIFE 展开',
        transformedTopLevelNodes:'降级后顶层节点数',
        targets:                 '降级目标',
    };
    return MAP[key] ?? key;
}

main().catch(err => {
    log.error('致命错误:', err.message);
    if (err.stack) log.error(err.stack);
    process.exit(1);
});
