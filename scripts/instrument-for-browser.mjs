#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * @file instrument-for-browser.mjs
 *
 * 对目标 JS 文件插桩，输出**单个自包含文件**：
 *   [Jalangi2 运行时 IIFE] + [插桩后的目标代码]
 *
 * 直接替换网页中原始的 <script src="...">，无需加载任何其他文件。
 * trace 日志通过 IndexedDB 持久化（Web Worker 异步写入）。
 *
 * 运行时 bundle 通过 **rollup** 打包生成，不再手工 inline + 正则替换。
 * 使用一个虚拟入口模块，通过纯静态 import 把所有运行时模块拉入，
 * rollup 完全静态分析，无动态 import，无正则替换，无歧义。
 *
 * 用法：
 *   node scripts/instrument-for-browser.mjs [选项] <目标文件>
 *
 * 选项：
 *   --output <file>    输出文件路径（默认：in-place 覆盖原文件）
 *   --db-name <name>   IndexedDB 数据库名（默认：jalangi-traces）
 *   --store-name <n>   IndexedDB ObjectStore 名（默认：execution-trace）
 *   --source-type <t>  'script'（默认）或 'module'（支持顶层 await）
 *   --no-idb           不启用 IndexedDB（仅 console 输出 trace）
 *   --minify           压缩运行时 bundle（去注释、混淆变量名、压缩代码体积）
 *   --sandbox-var <v>  自定义沙盒变量名（默认 J$），用于避免与页面已有同名变量冲突
 *   --random-var       随机生成沙盒变量名（如 __jal_a3f2），等价于 --sandbox-var 的随机版
 *   --dry-run          只打印结果，不写文件
 *   --debug            输出详细构建日志（等价于 JALANGI_DEBUG=1）
 *   --help / -h        显示本帮助
 *
 * 示例：
 *   npm run trace:instrument -- src/app.js
 *   npm run trace:instrument -- --output dist/app.traced.js src/app.js
 *   npm run trace:instrument -- --minify src/app.js
 *   npm run trace:instrument -- --sandbox-var myJalangi src/app.js
 *   npm run trace:instrument -- --random-var src/app.js
 *   npm run trace:instrument -- --debug src/app.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { rollup } from 'rollup';
import terser from '@rollup/plugin-terser';

// ── 路径常量 ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT_DIR   = resolve(__dirname, '..');
const SRC        = (...parts) => join(ROOT_DIR, 'src', 'js', ...parts);

// ── 诊断日志工具（直接输出到 console）────────────────────────────────────────
//
// debug 级别：由 --debug 参数或 JALANGI_DEBUG=1 环境变量开启。
// error/warn 级别：始终输出。
//
// 在 parseArgs 之前，先读取环境变量；--debug 参数在 parseArgs 之后设置。

let _debugEnabled = process.env.JALANGI_DEBUG === '1';

const log = {
    debug(...args) {
        if (_debugEnabled) console.debug('[instrument]', ...args);
    },
    info(...args)  { console.log(  '[instrument]', ...args); },
    warn(...args)  { console.warn( '[instrument]', ...args); },
    error(...args) { console.error('[instrument]', ...args); },
    /** 阶段计时：返回 done 函数，调用时打印耗时 */
    phase(name) {
        const t0 = Date.now();
        if (_debugEnabled) console.debug(`[instrument] ── ${name}...`);
        return (extra = '') => {
            if (_debugEnabled) console.debug(`[instrument] ✓ ${name} (${Date.now() - t0}ms)${extra ? ' ' + extra : ''}`);
        };
    },
};

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        output:     null,
        dbName:     'jalangi-traces',
        storeName:  'execution-trace',
        sourceType: 'script',
        useIdb:     true,
        minify:     false,
        sandboxVar: null,    // null → 使用默认 'J$'；字符串 → 自定义或随机生成的名字
        dryRun:     false,
        debug:      false,
        file:       null,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--help': case '-h': printHelp(); process.exit(0); break;
            case '--output':      opts.output     = argv[++i]; break;
            case '--db-name':     opts.dbName     = argv[++i]; break;
            case '--store-name':  opts.storeName  = argv[++i]; break;
            case '--source-type': opts.sourceType = argv[++i]; break;
            case '--no-idb':      opts.useIdb     = false;     break;
            case '--minify':      opts.minify     = true;      break;
            case '--sandbox-var': opts.sandboxVar = argv[++i]; break;
            case '--random-var':  opts.sandboxVar = _randomVarName(); break;
            case '--dry-run':     opts.dryRun     = true;      break;
            case '--debug':       opts.debug       = true;     break;
            default:
                if (a.startsWith('--')) { log.error(`未知选项: ${a}`); process.exit(1); }
                if (opts.file) { log.error('只支持单个目标文件。'); process.exit(1); }
                opts.file = resolve(a);
        }
    }

    if (!opts.file) { printHelp(); process.exit(1); }
    return opts;
}

function printHelp() {
    console.log(`
用法：
  node scripts/instrument-for-browser.mjs [选项] <目标文件>

选项：
  --output <file>     输出文件路径（默认：in-place 覆盖原文件）
  --db-name <name>    IndexedDB 数据库名（默认：jalangi-traces）
  --store-name <n>    ObjectStore 名（默认：execution-trace）
  --source-type <t>   'script'（默认）或 'module'
  --no-idb            不启用 IndexedDB（仅 console 输出）
  --minify            压缩运行时 bundle（去注释、混淆变量名、压缩代码体积）
  --sandbox-var <v>   自定义沙盒变量名（默认 J$），避免与页面变量冲突
  --random-var        随机生成沙盒变量名（如 __jal_a3f2）
  --dry-run           只打印，不写文件
  --debug             输出详细构建日志（等价于 JALANGI_DEBUG=1）
  --help / -h         显示此帮助
    `.trim());
}

/**
 * 生成一个安全的随机 JS 标识符：__jal_XXXXXX
 * 用于 --random-var 模式，防止沙盒变量名与页面现有变量冲突。
 */
function _randomVarName() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 6; i++) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `__jal_${suffix}`;
}

// ── 运行时 Bundle 生成（Rollup）────────────────────────────────────────────────

/**
 * 用 rollup 将所有运行时 ESM 模块打包成一个自包含的 IIFE 字符串。
 *
 * 策略：用一个虚拟入口模块，把所有需要的模块用**静态 import** 直接引入，
 * 完全避免动态 import（rollup 只做静态分析，没有 code-splitting 问题）。
 *
 * 对于 TraceLogger 中的动态 import，用 plugin 把它们重定向到真实模块路径，
 * 等价于静态 import，rollup 会把它们内联到单个 chunk 中。
 *
 * idb-worker.js 以 JSON 字符串内联（它是 classic Worker，需要独立 URL）。
 *
 * @param {object} opts  parseArgs 返回的选项
 * @returns {Promise<string>}  打包后的 IIFE 字符串
 */
async function buildRuntimeBundle(opts) {
    const doneReadWorker = log.phase('读取 idb-worker.js');
    // idb-worker.js 内联为字符串（classic worker，不经过 rollup）
    const idbWorkerSrc = readFileSync(
        SRC('runtime', 'logging', 'workers', 'idb-worker.js'),
        'utf8'
    ).replace(/^\/\/ JALANGI DO NOT INSTRUMENT\s*\n?/m, '').trim();
    doneReadWorker(`(${(idbWorkerSrc.length / 1024).toFixed(1)} KB)`);

    // 虚拟入口 ID
    const ENTRY_ID = '\0jalangi-entry';

    // 虚拟入口：纯静态 import，无动态 import，rollup 可完全分析
    //
    // 关键：TraceLogger / LogManager / JalangiSandbox 里有动态 import，
    // 我们通过 plugin（resolveDynamicImport）把它们都重定向到真实路径，
    // 这样 rollup 会把这些模块当成普通静态依赖内联进来。
    // WsBackend / NodeStreamBackend / MemoryBackend 重定向到空 stub，
    // 由 treeshake 消除（不在 bundle 里）。
    // 确定最终使用的沙盒变量名（命令行指定 > 随机生成 > 默认 J$）
    const sandboxVar = opts.sandboxVar ?? 'J$';
    const entryCode = `
import { JalangiSandbox } from '${SRC('runtime', 'JalangiSandbox.js')}';
import { ExecutionTraceAnalysis } from '${SRC('sample_analyses', 'ExecutionTrace.js')}';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
var ${sandboxVar} = globalThis.${sandboxVar} = new JalangiSandbox();

// 注册 ExecutionTrace 分析插件
${sandboxVar}.analysis.use(new ExecutionTraceAnalysis(${sandboxVar}, null, {
    useIdb:    ${opts.useIdb},
    dbName:    ${JSON.stringify(opts.dbName)},
    storeName: ${JSON.stringify(opts.storeName)},
}));
`;

    // 模块路径 → 真实文件路径（用于动态 import 重定向）
    const DYNAMIC_IMPORT_MAP = {
        './backends/IdbWorkerBackend.js':           SRC('runtime', 'logging', 'backends', 'IdbWorkerBackend.js'),
        './LogManager.js':                          SRC('runtime', 'logging', 'LogManager.js'),
        // JalangiSandbox.#registerExecutionTrace 中的动态 import（此处已在入口静态导入，stub 掉避免重复）
        '../sample_analyses/ExecutionTrace.js':     '\0stub:ExecutionTrace',
        // 下面三个不打进浏览器 bundle，用 stub 替代
        './backends/WsBackend.js':                  '\0stub:WsBackend',
        './backends/NodeStreamBackend.js':           '\0stub:NodeStreamBackend',
        './backends/MemoryBackend.js':              '\0stub:MemoryBackend',
    };

    // 收集 rollup 警告，最后统一输出（避免和阶段日志混在一起）
    const rollupWarnings = [];

    const plugins = [
        // ── Plugin 1: 虚拟入口 ────────────────────────────────────────────────
        {
            name: 'jalangi-virtual-entry',
            resolveId(id) { if (id === ENTRY_ID) return id; },
            load(id)      { if (id === ENTRY_ID) return entryCode; },
        },

        // ── Plugin 2: import.meta.url → __idbWorkerUrl ────────────────────────
        // IdbWorkerBackend 默认参数用 `new URL('...', import.meta.url)`，
        // bundle 里改为 IIFE intro 中创建的 __idbWorkerUrl。
        {
            name: 'jalangi-patch-idb-worker-url',
            transform(code, id) {
                if (!id.includes('IdbWorkerBackend')) return null;
                const patched = code.replace(
                    /new URL\s*\(\s*['"][^'"]+['"]\s*,\s*import\.meta\.url\s*\)/g,
                    '__idbWorkerUrl'
                );
                if (patched !== code) {
                    log.debug('patch-idb-worker-url: patched import.meta.url in', id);
                }
                return patched !== code ? { code: patched, map: null } : null;
            },
        },

        // ── Plugin 3: 动态 import() → 真实模块路径（静态内联） ───────────────
        // TraceLogger._doInit / LogManager 工厂函数里有动态 import。
        // resolveDynamicImport 钩子把它们重定向到真实路径，
        // rollup 随后像处理普通静态依赖一样把它们打包进来。
        {
            name: 'jalangi-resolve-dynamic-imports',
            resolveDynamicImport(specifier) {
                if (typeof specifier !== 'string') return null;
                const mapped = DYNAMIC_IMPORT_MAP[specifier];
                if (mapped) log.debug(`resolve-dynamic-import: "${specifier}" → "${mapped}"`);
                return mapped ?? null;
            },
            load(id) {
                // stub 模块：空导出，rollup 会 tree-shake 掉使用它们的代码
                if (id === '\0stub:WsBackend') {
                    log.debug('load stub: WsBackend');
                    return 'export const WsBackend = undefined;';
                }
                if (id === '\0stub:NodeStreamBackend') {
                    log.debug('load stub: NodeStreamBackend');
                    return 'export const NodeStreamBackend = undefined;';
                }
                if (id === '\0stub:MemoryBackend') {
                    log.debug('load stub: MemoryBackend');
                    return 'export const MemoryBackend = undefined;';
                }
                if (id === '\0stub:ExecutionTrace') {
                    // JalangiSandbox.#registerExecutionTrace 的动态 import 路径，
                    // 入口已静态导入过，此处 stub 掉避免 rollup 重复打包
                    log.debug('load stub: ExecutionTrace (already statically imported in entry)');
                    return 'export const ExecutionTraceAnalysis = undefined;';
                }
            },
        },

        // ── Plugin 4: 压缩（仅 --minify 时启用）─────────────────────────────
        ...(opts.minify ? [terser({
            compress: { passes: 2 },
            mangle:   true,
            format:   { comments: false },
        })] : []),
    ];

    const doneRollupBuild = log.phase('rollup build');
    const bundle = await rollup({
        input:    ENTRY_ID,
        plugins,
        external: [],   // 不外置任何模块
        onwarn(warning) {
            if (warning.code === 'UNRESOLVED_IMPORT') {
                // 未解析 import 是实质性问题，始终输出
                log.warn('[rollup] UNRESOLVED_IMPORT:', warning.message);
            } else {
                // 其他警告只在 debug 模式下显示
                rollupWarnings.push(warning);
                log.debug('[rollup]', warning.code, warning.message);
            }
        },
    });
    doneRollupBuild();

    const doneRollupGen = log.phase('rollup generate IIFE');
    const { output } = await bundle.generate({
        format:               'iife',
        name:                 '__jalangi__',
        inlineDynamicImports: true,   // 把所有动态 import 内联到单个 chunk
        // IIFE 内最前面注入 Blob Worker URL（__idbWorkerUrl 被 IdbWorkerBackend 用到）
        intro: [
            '// ─── IDB Worker: 内联为 Blob URL（classic worker，兼容所有浏览器）',
            `var __idbWorkerSrc  = ${JSON.stringify(idbWorkerSrc)};`,
            `var __idbWorkerBlob = (typeof Blob !== 'undefined')`,
            `    ? new Blob([__idbWorkerSrc], { type: 'application/javascript' })`,
            `    : null;`,
            `var __idbWorkerUrl  = __idbWorkerBlob ? URL.createObjectURL(__idbWorkerBlob) : null;`,
        ].join('\n'),
    });

    await bundle.close();
    const bundleCode = output[0].code;
    doneRollupGen(`(${(bundleCode.length / 1024).toFixed(1)} KB, ${output[0].moduleIds?.length ?? '?'} modules)`);

    if (rollupWarnings.length > 0) {
        log.debug(`rollup: ${rollupWarnings.length} non-critical warning(s) suppressed (use --debug to see all)`);
    }

    return bundleCode;
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    // 同步 debug 标志（--debug 参数优先）
    if (opts.debug) _debugEnabled = true;

    log.debug('options:', JSON.stringify(opts, null, 2));
    log.debug('ROOT_DIR:', ROOT_DIR);

    // 动态导入插桩器
    const doneLoadInstrumenter = log.phase('加载插桩器 esnstrument.js');
    const { init, instrumentCode } = await import(
        `${ROOT_DIR}/src/js/instrument/esnstrument.js`
    );
    doneLoadInstrumenter();

    // 确定沙盒变量名（与 buildRuntimeBundle 保持一致）
    const sandboxVar = opts.sandboxVar ?? 'J$';
    init({
        ENABLE_SAMPLING:           false,
        INSTR_READ:                null,
        INSTR_WRITE:               null,
        INSTR_GETFIELD:            null,
        INSTR_PUTFIELD:            null,
        INSTR_BINARY:              null,
        INSTR_UNARY:               null,
        INSTR_LITERAL:             null,
        INSTR_INIT:                null,
        INSTR_CONDITIONAL:         null,
        INSTR_TRY_CATCH_ARGUMENTS: null,
        INSTR_END_EXPRESSION:      null,
    }, null, null, sandboxVar);

    const inputPath = opts.file;
    const outPath   = opts.output ? resolve(opts.output) : inputPath;

    // ── 读目标文件 ────────────────────────────────────────────────────────────
    const doneRead = log.phase(`读取目标文件: ${inputPath}`);
    const originalCode = readFileSync(inputPath, 'utf8');
    doneRead(`(${(originalCode.length / 1024).toFixed(1)} KB, ${originalCode.split('\n').length} 行)`);

    if (originalCode.includes('// JALANGI DO NOT INSTRUMENT')) {
        log.warn(`跳过（已标记 DO NOT INSTRUMENT）: ${inputPath}`);
        process.exit(0);
    }

    // ── 插桩目标代码 ──────────────────────────────────────────────────────────
    const doneInstr = log.phase('插桩目标代码');
    let result;
    try {
        result = instrumentCode({
            code:             originalCode,
            origCodeFileName: inputPath,
            instCodeFileName: outPath,
            inlineSourceMap:  true,
            inlineSource:     true,
            sourceType:       opts.sourceType,
            isEval:           false,
        });
    } catch (err) {
        log.error('插桩失败:', err.message);
        if (err.stack) log.error('Stack trace:\n' + err.stack);
        process.exit(1);
    }
    const iidCount = Object.keys(result.sourceMapObject ?? {}).filter(k => !isNaN(k)).length;
    doneInstr(`(${iidCount} IIDs, ${(result.code.length / 1024).toFixed(1)} KB)`);

    // ── 用 rollup 构建运行时 bundle ───────────────────────────────────────────
    log.info('正在用 rollup 打包运行时...');
    let runtimeBundle;
    try {
        runtimeBundle = await buildRuntimeBundle(opts);
    } catch (err) {
        log.error('rollup 打包失败:', err.message);
        if (err.stack) log.error('Stack trace:\n' + err.stack);
        process.exit(1);
    }

    // ── 拼接最终输出 ──────────────────────────────────────────────────────────
    //
    // 结构：
    //   1. 文件头注释
    //   2. 运行时 IIFE（设置 globalThis.J$，安装所有钩子和 analysis）
    //   3. 插桩后的目标代码（直接调用 J$.R / J$.W / ... 等）
    //
    const doneConcatenate = log.phase('拼接最终输出');
    const header = `\
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Jalangi2 Runtime Bundle (auto-generated ${new Date().toISOString().slice(0,10)})  ║
// ║  Do NOT edit this file manually.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
`;
    const finalCode = header + runtimeBundle + '\n' + result.code;
    doneConcatenate(`(total ${(finalCode.length / 1024).toFixed(1)} KB)`);

    // ── 写出 ──────────────────────────────────────────────────────────────────
    if (opts.dryRun) {
        const preview = finalCode.slice(0, 1000) + (finalCode.length > 1000 ? '\n...(截断)' : '');
        console.log(`\n=== [dry-run] 输出文件: ${outPath} (${finalCode.length} chars) ===\n`);
        console.log(preview);
    } else {
        const doneWrite = log.phase(`写出: ${outPath}`);
        const outDir = dirname(outPath);
        if (!existsSync(outDir)) {
            log.debug(`创建目录: ${outDir}`);
            mkdirSync(outDir, { recursive: true });
        }
        writeFileSync(outPath, finalCode, 'utf8');
        doneWrite(`(${(finalCode.length / 1024).toFixed(1)} KB)`);

        console.log(`✓ 插桩完成`);
        console.log(`  源文件  : ${inputPath}`);
        console.log(`  输出    : ${outPath}`);
        console.log(`  IID 数量: ${iidCount}`);
        console.log(`  沙盒变量: ${sandboxVar}${sandboxVar === 'J$' ? ' (默认)' : ''}`);
        console.log(`  总大小  : ${(finalCode.length / 1024).toFixed(1)} KB${opts.minify ? ' (已压缩)' : ''}`);
        if (opts.useIdb) {
            console.log(`  IDB     : ${opts.dbName} / ${opts.storeName}`);
        }
        console.log(`\n直接替换网页中原始的 <script src="..."> 标签即可。`);
        if (!opts.minify) {
            console.log(`  提示: 使用 --minify 可压缩运行时 bundle，显著减小文件体积`);
        }
        if (!opts.debug && !_debugEnabled) {
            console.log(`  提示: 使用 --debug 或 JALANGI_DEBUG=1 可查看详细构建日志`);
        }
    }
}

main().catch(err => {
    log.error('致命错误:', err.message);
    if (err.stack) log.error('Stack trace:\n' + err.stack);
    process.exit(1);
});
