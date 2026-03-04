#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * @file bin/jalangi.mjs — Jalangi2 统一命令行工具
 *
 * 用法：
 *   node bin/jalangi.mjs <子命令> [选项] <文件> [脚本参数...]
 *
 * 子命令：
 *   instrument           只插桩，输出插桩文件 + IID map（不运行）
 *   run                  只运行已插桩文件（不再次插桩）
 *   instrument-and-run   先插桩再立即运行（一步完成）
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 通用选项（所有子命令均支持）：
 *   --target <t>         目标环境: node（默认）或 browser
 *   --source-type <t>    'script'（默认）或 'module'
 *   --sandbox-var <v>    沙盒变量名（默认 J$）
 *   --random-var         随机生成沙盒变量名（如 __jal_a3f2）
 *   --debug              详细日志（等价于 JALANGI_DEBUG=1）
 *   --help / -h          显示此帮助
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * instrument 子命令选项：
 *
 *   通用（node / browser 均适用）：
 *   --output <file>      输出文件路径
 *                          node   默认：<input>_jalangi_.js
 *                          browser 默认：in-place 覆盖原文件
 *   --inline-iid         iid→位置 map 内联到输出文件头部
 *   --inline-source      原始源码内联到 source map
 *   --no-source-map      不写 .map.json / source map 文件
 *   --vlcq-source-map    额外生成标准 Source Map v3（<output>.js.map）
 *   --split-runtime      运行时与插桩代码分离输出（含 import / <script> 提示）
 *                          node    → <output>.runtime.mjs（ESM）
 *                          browser → <output>.runtime.js（IIFE）
 *   --dry-run            只打印结果，不写文件
 *
 *   浏览器专属（--target browser）：
 *   --db-name <n>        IndexedDB 数据库名（默认 jalangi-traces）
 *   --store-name <n>     ObjectStore 名（默认 execution-trace）
 *   --no-idb             不启用 IndexedDB（仅 console 输出 trace）
 *   --minify             压缩运行时 bundle（rollup + terser）
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * run 子命令选项：
 *   --analysis <file>    分析插件路径（可重复）
 *   --init-param <k:v>   传给分析的初始参数（可重复，格式 key:value）
 *   --runtime <file>     运行时 ESM 模块路径（--split-runtime 生成的 .runtime.mjs）
 *                        若未指定，自动尝试 <script>.runtime.mjs
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * instrument-and-run 子命令选项：
 *   --analysis <file>    分析插件路径（可重复）
 *   --init-param <k:v>   传给分析的初始参数（可重复，格式 key:value）
 *   --inline-iid         iid→位置 map 内联到插桩文件
 *   --inline-source      原始源码内联到 source map
 *   --no-write           不写插桩后的 .js 文件（仅内存中插桩后运行）
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 示例：
 *
 *   # 只插桩（Node，默认）
 *   node bin/jalangi.mjs instrument src/app.js
 *   node bin/jalangi.mjs instrument --output dist/app.inst.js src/app.js
 *   node bin/jalangi.mjs instrument --split-runtime src/app.js
 *   node bin/jalangi.mjs instrument --vlcq-source-map src/app.js
 *   node bin/jalangi.mjs instrument --random-var src/app.js
 *
 *   # 只插桩（浏览器，运行时内联为单一文件）
 *   node bin/jalangi.mjs instrument --target browser src/app.js
 *   node bin/jalangi.mjs instrument --target browser --minify src/app.js
 *   node bin/jalangi.mjs instrument --target browser --split-runtime src/app.js
 *
 *   # 只运行已插桩文件
 *   node bin/jalangi.mjs run tests/app_jalangi_.js
 *   node bin/jalangi.mjs run --analysis src/plugins/TraceAll.js tests/app_jalangi_.js
 *   node bin/jalangi.mjs run --runtime tests/app_jalangi_.runtime.mjs tests/app_jalangi_.js
 *
 *   # 插桩 + 立即运行（一步）
 *   node bin/jalangi.mjs instrument-and-run tests/app.js
 *   node bin/jalangi.mjs instrument-and-run --analysis src/plugins/TraceAll.js tests/app.js
 *   node bin/jalangi.mjs instrument-and-run --no-write tests/app.js arg1 arg2
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT_DIR   = resolve(__dirname, '..');
const SRC        = (...parts) => join(ROOT_DIR, 'src', ...parts);

// ── 日志 ──────────────────────────────────────────────────────────────────────

let _debug = process.env.JALANGI_DEBUG === '1';
const log = {
    debug(...a) { if (_debug) console.debug('[jalangi]', ...a); },
    info(...a)  { console.log(  '[jalangi]', ...a); },
    warn(...a)  { console.warn( '[jalangi]', ...a); },
    error(...a) { console.error('[jalangi]', ...a); },
    phase(name) {
        const t0 = Date.now();
        if (_debug) console.debug(`[jalangi] ── ${name}...`);
        return (extra = '') => {
            if (_debug) console.debug(`[jalangi] ✓ ${name} (${Date.now() - t0}ms)${extra ? ' ' + extra : ''}`);
        };
    },
};

// ── 帮助文本 ──────────────────────────────────────────────────────────────────

function printHelp(sub = null) {
    if (!sub) {
        console.log(`
用法：
  node bin/jalangi.mjs <子命令> [选项] <文件> [脚本参数...]

子命令：
  instrument           只插桩，输出插桩文件 + IID map（不运行）
  run                  只运行已插桩文件（不再次插桩）
  instrument-and-run   先插桩再立即运行（一步完成）

通用选项：
  --target <t>         目标环境: node（默认）或 browser
  --source-type <t>    'script'（默认）或 'module'
  --sandbox-var <v>    沙盒变量名（默认 J$）
  --random-var         随机生成沙盒变量名（如 __jal_a3f2）
  --debug              详细日志（等价于 JALANGI_DEBUG=1）
  --help / -h          显示此帮助

使用 "node bin/jalangi.mjs <子命令> --help" 查看子命令详细帮助。
        `.trim());
        return;
    }

    if (sub === 'instrument') {
        console.log(`
用法：
  node bin/jalangi.mjs instrument [选项] <输入文件>

只对目标文件插桩，写出插桩文件和 IID map，不运行。

通用选项（node / browser 均适用）：
  --target <t>         node（默认）或 browser
  --source-type <t>    'script'（默认）或 'module'
  --sandbox-var <v>    沙盒变量名（默认 J$）
  --random-var         随机生成沙盒变量名（如 __jal_a3f2）
  --output <file>      输出文件路径
                         node    默认：<input>_jalangi_.js
                         browser 默认：in-place 覆盖原文件
  --inline-iid         iid→位置 map 内联到输出文件头部
  --inline-source      原始源码内联到 source map
  --no-source-map      不写 .map.json / source map 文件
  --vlcq-source-map    额外生成标准 Source Map v3（<output>.js.map）
  --split-runtime      运行时与插桩代码分离输出（含 import / <script> 提示）
                         node    → <output>.runtime.mjs（ESM）
                         browser → <output>.runtime.js（IIFE）
  --dry-run            只打印结果，不写文件
  --debug              详细日志

浏览器专属（--target browser）：
  --db-name <n>        IndexedDB 数据库名（默认 jalangi-traces）
  --store-name <n>     ObjectStore 名（默认 execution-trace）
  --no-idb             不启用 IndexedDB（仅 console 输出 trace）
  --minify             压缩运行时 bundle（rollup + terser）

示例：
  node bin/jalangi.mjs instrument src/app.js
  node bin/jalangi.mjs instrument --output dist/app.inst.js src/app.js
  node bin/jalangi.mjs instrument --split-runtime --vlcq-source-map src/app.js
  node bin/jalangi.mjs instrument --random-var --target browser src/app.js
  node bin/jalangi.mjs instrument --target browser --split-runtime --minify src/app.js
        `.trim());
        return;
    }

    if (sub === 'run') {
        console.log(`
用法：
  node bin/jalangi.mjs run [选项] <已插桩文件> [脚本参数...]

直接运行已插桩的 JS 文件，不进行任何插桩操作。
若插桩时使用了 --split-runtime，运行前需要加载对应的运行时模块。

选项：
  --analysis <file>    分析插件路径（可重复多次）
  --init-param <k:v>   传给分析的初始参数（可重复，格式 key:value）
  --runtime <file>     运行时 ESM 模块路径（--split-runtime 生成的 .runtime.mjs）
                       若未指定，自动尝试 <script 同名>.runtime.mjs
  --sandbox-var <v>    沙盒变量名（默认 J$）
  --debug              详细日志
  --help / -h          显示此帮助

示例：
  node bin/jalangi.mjs run tests/app_jalangi_.js
  node bin/jalangi.mjs run --analysis src/plugins/TraceAll.js tests/app_jalangi_.js
  node bin/jalangi.mjs run --runtime tests/app.runtime.mjs tests/app_jalangi_.js
  node bin/jalangi.mjs run tests/app_jalangi_.js -- arg1 arg2
        `.trim());
        return;
    }

    if (sub === 'instrument-and-run') {
        console.log(`
用法：
  node bin/jalangi.mjs instrument-and-run [选项] <原始文件> [脚本参数...]

对目标脚本即时插桩并在 Node 中运行（一步完成）。
通过 Module._extensions 钩子，对所有 require 的 .js 文件自动插桩。
仅支持 --target node。

选项：
  --analysis <file>    分析插件路径（可重复多次）
  --init-param <k:v>   传给分析的初始参数（可重复，格式 key:value）
  --source-type <t>    'script'（默认）
  --sandbox-var <v>    沙盒变量名（默认 J$）
  --random-var         随机生成沙盒变量名
  --inline-iid         iid→位置 map 内联到插桩文件
  --inline-source      原始源码内联到 source map
  --no-write           不写插桩后的 .js 文件（仅在内存中插桩运行）
  --debug              详细日志
  --help / -h          显示此帮助

示例：
  node bin/jalangi.mjs instrument-and-run tests/app.js
  node bin/jalangi.mjs instrument-and-run --analysis src/plugins/TraceAll.js tests/app.js
  node bin/jalangi.mjs instrument-and-run --no-write tests/app.js arg1 arg2
  node bin/jalangi.mjs instrument-and-run --init-param level:verbose tests/app.js
        `.trim());
    }
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

/**
 * 从 argv 中提取通用选项（--target, --source-type, --sandbox-var, --random-var, --debug）。
 * 未识别的参数原样保留在 remaining 数组中。
 */
function parseCommonOpts(argv) {
    const common = {
        target:     'node',
        sourceType: 'script',
        sandboxVar: 'J$',
        randomVar:  false,
        debug:      false,
    };
    const remaining = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--target':      common.target     = argv[++i]; break;
            case '--source-type': common.sourceType = argv[++i]; break;
            case '--sandbox-var': common.sandboxVar = argv[++i]; break;
            case '--random-var':  common.randomVar  = true;      break;
            case '--debug':       common.debug       = true;     break;
            default:              remaining.push(a);
        }
    }
    return { ...common, remaining };
}

/** 解析 instrument 子命令专有选项（不含通用选项） */
function parseInstrumentOpts(argv) {
    const opts = {
        output:        null,
        inlineIid:     false,
        inlineSource:  false,
        noSourceMap:   false,
        vlcqSourceMap: false,
        splitRuntime:  false,
        dryRun:        false,
        analyses:      [],      // --analysis 插件路径（用于按需插桩 Config 推导）
        // 浏览器专属
        dbName:        'jalangi-traces',
        storeName:     'execution-trace',
        useIdb:        true,
        minify:        false,
        // 输入文件
        file:          null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--help': case '-h':   return null;
            case '--output':            opts.output        = argv[++i]; break;
            case '--inline-iid':        opts.inlineIid     = true;      break;
            case '--inline-source':     opts.inlineSource  = true;      break;
            case '--no-source-map':     opts.noSourceMap   = true;      break;
            case '--vlcq-source-map':   opts.vlcqSourceMap = true;      break;
            case '--split-runtime':     opts.splitRuntime  = true;      break;
            case '--dry-run':           opts.dryRun        = true;      break;
            case '--analysis':          opts.analyses.push(resolve(argv[++i])); break;
            case '--db-name':           opts.dbName        = argv[++i]; break;
            case '--store-name':        opts.storeName     = argv[++i]; break;
            case '--no-idb':            opts.useIdb        = false;     break;
            case '--minify':            opts.minify        = true;      break;
            default:
                if (a.startsWith('--')) { log.error(`未知选项: ${a}`); process.exit(1); }
                if (opts.file)          { log.error('只支持单个输入文件。'); process.exit(1); }
                opts.file = resolve(a);
        }
    }
    if (!opts.file) return null;
    return opts;
}

/** 解析 run 子命令专有选项 */
function parseRunOpts(argv) {
    const opts = {
        analyses:    [],
        initParams:  {},
        runtime:     null,   // 运行时模块路径（--split-runtime 生成的 .runtime.mjs）
        script:      null,
        scriptArgs:  [],
    };
    let i = 0;
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { i++; break; }
        switch (a) {
            case '--help': case '-h': return null;
            case '--analysis':        opts.analyses.push(resolve(argv[++i])); break;
            case '--runtime':         opts.runtime = resolve(argv[++i]); break;
            case '--init-param': {
                const kv  = argv[++i];
                const idx = kv.indexOf(':');
                if (idx < 0) { log.error(`--init-param 格式应为 key:value，得到: ${kv}`); process.exit(1); }
                opts.initParams[kv.slice(0, idx)] = kv.slice(idx + 1);
                break;
            }
            default:
                if (a.startsWith('--')) { log.error(`未知选项: ${a}`); process.exit(1); }
                opts.script = resolve(a);
                opts.scriptArgs = argv.slice(i + 1);
                i = argv.length;
        }
    }
    if (i < argv.length && !opts.script) {
        opts.script = resolve(argv[i++]);
        opts.scriptArgs = argv.slice(i);
    }
    if (!opts.script) return null;
    return opts;
}

/** 解析 instrument-and-run 子命令专有选项 */
function parseInstrumentAndRunOpts(argv) {
    const opts = {
        analyses:     [],
        initParams:   {},
        inlineIid:    false,
        inlineSource: false,
        noWrite:      false,
        script:       null,
        scriptArgs:   [],
    };
    let i = 0;
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { i++; break; }
        switch (a) {
            case '--help': case '-h': return null;
            case '--analysis':        opts.analyses.push(resolve(argv[++i])); break;
            case '--init-param': {
                const kv  = argv[++i];
                const idx = kv.indexOf(':');
                if (idx < 0) { log.error(`--init-param 格式应为 key:value，得到: ${kv}`); process.exit(1); }
                opts.initParams[kv.slice(0, idx)] = kv.slice(idx + 1);
                break;
            }
            case '--inline-iid':    opts.inlineIid    = true; break;
            case '--inline-source': opts.inlineSource = true; break;
            case '--no-write':      opts.noWrite      = true; break;
            default:
                if (a.startsWith('--')) { log.error(`未知选项: ${a}`); process.exit(1); }
                opts.script = resolve(a);
                opts.scriptArgs = argv.slice(i + 1);
                i = argv.length;
        }
    }
    if (i < argv.length && !opts.script) {
        opts.script = resolve(argv[i++]);
        opts.scriptArgs = argv.slice(i);
    }
    if (!opts.script) return null;
    return opts;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** foo.js → foo_jalangi_.js */
function defaultNodeOutFile(inputPath) {
    const base = basename(inputPath);
    return resolve(dirname(inputPath), base.replace(/\.js$/, '_jalangi_.js'));
}

const FILESUFFIX = '_jalangi_';

function makeInstFilename(name) {
    return name.replace(/\.js$/, `${FILESUFFIX}.js`);
}
function makeMapFilename(name) {
    return makeInstFilename(name).replace(/\.js$/, '.map.json');
}

/** 生成安全的随机 JS 标识符：__jal_XXXXXX */
function randomVarName() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    return `__jal_${suffix}`;
}

/** 确保目标文件的父目录存在 */
function ensureDir(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 加载并初始化插桩器，返回 instrumentCode 函数。
 *
 * @param {string}   sandboxVar    沙盒变量名
 * @param {string[]} [analyses]    分析插件路径列表。
 *                                  若提供，则静态分析插件所用 Hook 并生成按需 Config（最小化插桩）。
 *                                  若不提供或为空，则使用全量 Config（与旧版行为一致）。
 */
async function loadInstrumenter(sandboxVar, analyses) {
    const instrModule = await import(`${ROOT_DIR}/src/instrument/esnstrument.js`);
    const { init, instrumentCode, buildConfigFromPlugins, fullConfig } = instrModule;

    let config;
    if (analyses && analyses.length > 0) {
        log.debug(`按需插桩模式：分析 ${analyses.length} 个插件...`);
        config = buildConfigFromPlugins(analyses);
        const enabledFields = Object.entries(config)
            .filter(([k, v]) => v === null)
            .map(([k]) => k);
        log.debug(`启用的 Config 字段: ${enabledFields.join(', ')}`);
    } else {
        config = fullConfig();
        log.debug('全量插桩模式（未指定分析插件）');
    }

    init(config, null, null, sandboxVar);
    return instrumentCode;
}

// ── rollup 运行时打包（浏览器专用）───────────────────────────────────────────

/**
 * 用 rollup 将所有运行时 ESM 模块打包成一个自包含的 IIFE 字符串。
 * @param {object} opts  包含 sandboxVar, useIdb, dbName, storeName, minify
 */
async function buildBrowserRuntimeBundle(opts) {
    const { rollup }              = await import('rollup');
    const { default: terser }     = await import('@rollup/plugin-terser');

    const doneReadWorker = log.phase('读取 idb-worker.js');
    const idbWorkerSrc = readFileSync(
        SRC('runtime', 'logging', 'workers', 'idb-worker.js'), 'utf8'
    ).replace(/^\/\/ JALANGI DO NOT INSTRUMENT\s*\n?/m, '').trim();
    doneReadWorker(`(${(idbWorkerSrc.length / 1024).toFixed(1)} KB)`);

    const ENTRY_ID   = '\0jalangi-entry';
    const sandboxVar = opts.sandboxVar;

    const entryCode = `
import { JalangiSandbox } from '${SRC('runtime', 'JalangiSandbox.js')}';
import { ExecutionTraceAnalysis } from '${SRC('plugins', 'ExecutionTrace.js')}';

var ${sandboxVar} = globalThis.${sandboxVar} = new JalangiSandbox();

${sandboxVar}.analysis.use(new ExecutionTraceAnalysis(${sandboxVar}, null, {
    useIdb:    ${opts.useIdb},
    dbName:    ${JSON.stringify(opts.dbName)},
    storeName: ${JSON.stringify(opts.storeName)},
}));
`;

    const DYNAMIC_IMPORT_MAP = {
        './backends/IdbWorkerBackend.js':  SRC('runtime', 'logging', 'backends', 'IdbWorkerBackend.js'),
        './LogManager.js':                 SRC('runtime', 'logging', 'LogManager.js'),
        '../plugins/ExecutionTrace.js':    '\0stub:ExecutionTrace',
        './backends/WsBackend.js':         '\0stub:WsBackend',
        './backends/NodeStreamBackend.js': '\0stub:NodeStreamBackend',
        './backends/MemoryBackend.js':     '\0stub:MemoryBackend',
    };

    const rollupWarnings = [];
    const plugins = [
        {
            name: 'jalangi-virtual-entry',
            resolveId(id) { if (id === ENTRY_ID) return id; },
            load(id)      { if (id === ENTRY_ID) return entryCode; },
        },
        {
            name: 'jalangi-patch-idb-worker-url',
            transform(code, id) {
                if (!id.includes('IdbWorkerBackend')) return null;
                const patched = code.replace(
                    /new URL\s*\(\s*['"][^'"]+['"]\s*,\s*import\.meta\.url\s*\)/g,
                    '__idbWorkerUrl'
                );
                return patched !== code ? { code: patched, map: null } : null;
            },
        },
        {
            name: 'jalangi-resolve-dynamic-imports',
            resolveDynamicImport(specifier) {
                if (typeof specifier !== 'string') return null;
                const mapped = DYNAMIC_IMPORT_MAP[specifier];
                if (mapped) log.debug(`resolve-dynamic-import: "${specifier}" → "${mapped}"`);
                return mapped ?? null;
            },
            load(id) {
                const stubs = {
                    '\0stub:WsBackend':         'export const WsBackend = undefined;',
                    '\0stub:NodeStreamBackend': 'export const NodeStreamBackend = undefined;',
                    '\0stub:MemoryBackend':     'export const MemoryBackend = undefined;',
                    '\0stub:ExecutionTrace':    'export const ExecutionTraceAnalysis = undefined;',
                };
                return stubs[id] ?? null;
            },
        },
        ...(opts.minify ? [terser({ compress: { passes: 2 }, mangle: true, format: { comments: false } })] : []),
    ];

    const doneRollup = log.phase('rollup build');
    const bundle = await rollup({
        input: ENTRY_ID, plugins, external: [],
        onwarn(warning) {
            if (warning.code === 'UNRESOLVED_IMPORT') log.warn('[rollup] UNRESOLVED_IMPORT:', warning.message);
            else { rollupWarnings.push(warning); log.debug('[rollup]', warning.code, warning.message); }
        },
    });
    doneRollup();

    const doneGen = log.phase('rollup generate IIFE');
    const { output } = await bundle.generate({
        format: 'iife', name: '__jalangi__', inlineDynamicImports: true,
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
    doneGen(`(${(bundleCode.length / 1024).toFixed(1)} KB, ${output[0].moduleIds?.length ?? '?'} modules)`);
    if (rollupWarnings.length > 0) log.debug(`rollup: ${rollupWarnings.length} non-critical warning(s) suppressed`);

    return bundleCode;
}

/** 生成 Node 侧 split-runtime ESM 模块内容 */
function buildNodeRuntimeESM(sandboxVar) {
    return `// JALANGI DO NOT INSTRUMENT
// Jalangi2 运行时 — Node ESM 模块（由 jalangi instrument --split-runtime 生成）
// 在运行插桩文件之前通过 import 引入，确保全局沙盒变量 ${sandboxVar} 已初始化。

import { JalangiSandbox } from '${SRC('runtime', 'JalangiSandbox.js')}';

if (!globalThis['${sandboxVar}']) {
    globalThis['${sandboxVar}'] = new JalangiSandbox();
}
export const ${sandboxVar} = globalThis['${sandboxVar}'];
`;
}

// ── 子命令：instrument ────────────────────────────────────────────────────────

async function cmdInstrument(common, instrArgs) {
    const instrOpts = parseInstrumentOpts(instrArgs);
    if (!instrOpts) {
        printHelp('instrument');
        process.exit(instrArgs.some(a => a === '--help' || a === '-h') ? 0 : 1);
    }

    if (common.debug) _debug = true;
    log.debug('common:', JSON.stringify(common, null, 2));
    log.debug('instrOpts:', JSON.stringify(instrOpts, null, 2));

    const target = common.target;
    if (!['node', 'browser'].includes(target)) {
        log.error(`--target 必须是 node 或 browser，得到: ${target}`);
        process.exit(1);
    }

    // 沙盒变量名（--random-var 优先级高于 --sandbox-var）
    const sandboxVar = common.randomVar ? randomVarName() : common.sandboxVar;

    // ── 读取源文件 ────────────────────────────────────────────────────────────
    const inputPath = instrOpts.file;
    if (!existsSync(inputPath)) { log.error(`文件不存在: ${inputPath}`); process.exit(1); }

    const originalCode = readFileSync(inputPath, 'utf8');
    log.debug(`读取 ${inputPath} (${(originalCode.length / 1024).toFixed(1)} KB)`);

    if (originalCode.includes('// JALANGI DO NOT INSTRUMENT')) {
        log.warn(`跳过（已标记 DO NOT INSTRUMENT）: ${inputPath}`);
        process.exit(0);
    }

    // ── 确定输出路径 ──────────────────────────────────────────────────────────
    let outPath;
    if (instrOpts.output) {
        outPath = resolve(instrOpts.output);
    } else if (target === 'node') {
        outPath = defaultNodeOutFile(inputPath);
    } else {
        outPath = inputPath; // 浏览器默认 in-place 覆盖
    }

    const mapPath     = outPath.replace(/\.js$/, '.map.json');
    const vlcqMapPath = outPath + '.map';

    // ── 加载并执行插桩 ────────────────────────────────────────────────────────
    const doneLoad = log.phase('加载插桩器');
    const instrumentCode = await loadInstrumenter(sandboxVar, instrOpts.analyses);
    doneLoad();

    const doneInstr = log.phase('插桩目标代码');
    let result;
    try {
        result = instrumentCode({
            code:             originalCode,
            origCodeFileName: inputPath,
            instCodeFileName: outPath,
            // 浏览器内联模式（非 split）默认把 iid map 也内联进输出文件
            inlineSourceMap: (target === 'browser' && !instrOpts.splitRuntime)
                ? true
                : instrOpts.inlineIid,
            inlineSource: (target === 'browser' && !instrOpts.splitRuntime)
                ? true
                : instrOpts.inlineSource,
            sourceType: common.sourceType,
            isEval:     false,
        });
    } catch (err) {
        log.error('插桩失败:', err.message);
        if (err.stack) log.error(err.stack);
        process.exit(1);
    }
    const iidCount = Object.keys(result.sourceMapObject ?? {}).filter(k => !isNaN(k)).length;
    doneInstr(`(${iidCount} IIDs, ${(result.code.length / 1024).toFixed(1)} KB)`);

    // ── 按 target / splitRuntime 生成最终输出 ─────────────────────────────────
    if (target === 'node') {
        await _writeNodeOutput({ instrOpts, inputPath, outPath, mapPath, vlcqMapPath, result, iidCount, sandboxVar });
    } else {
        await _writeBrowserOutput({ instrOpts, inputPath, outPath, result, iidCount, sandboxVar });
    }
}

async function _writeNodeOutput({ instrOpts, inputPath, outPath, mapPath, vlcqMapPath, result, iidCount, sandboxVar }) {
    const runtimePath = outPath.replace(/\.js$/, '.runtime.mjs');
    const runtimeCode = instrOpts.splitRuntime ? buildNodeRuntimeESM(sandboxVar) : null;

    if (instrOpts.dryRun) {
        const preview = result.code.slice(0, 800) + (result.code.length > 800 ? '\n...(截断)' : '');
        console.log(`\n=== [dry-run] 插桩输出: ${outPath} ===\n`);
        console.log(preview);
        if (runtimeCode) {
            console.log(`\n=== [dry-run] 运行时输出: ${runtimePath} ===\n`);
            console.log(runtimeCode);
        }
        return;
    }

    ensureDir(outPath);
    writeFileSync(outPath, result.code, 'utf8');

    if (!instrOpts.noSourceMap && result.sourceMapString) {
        writeFileSync(mapPath, result.sourceMapString, 'utf8');
    }
    if (instrOpts.vlcqSourceMap && result.vlcqSourceMap) {
        writeFileSync(vlcqMapPath, JSON.stringify(result.vlcqSourceMap), 'utf8');
    }
    if (runtimeCode) {
        ensureDir(runtimePath);
        writeFileSync(runtimePath, runtimeCode, 'utf8');
    }

    console.log(`✓ 插桩完成（Node）`);
    console.log(`  输入      : ${inputPath}`);
    console.log(`  输出      : ${outPath}`);
    if (!instrOpts.noSourceMap && result.sourceMapString) console.log(`  IID map   : ${mapPath}`);
    if (instrOpts.vlcqSourceMap && result.vlcqSourceMap)  console.log(`  Source map: ${vlcqMapPath}`);
    if (runtimeCode) {
        console.log(`  运行时    : ${runtimePath}`);
        console.log(`\n  运行方式（先加载运行时，再运行插桩文件）：`);
        console.log(`    node --import '${runtimePath}' ${outPath}`);
    }
    console.log(`  IID 数量  : ${iidCount}`);
    console.log(`  沙盒变量  : ${sandboxVar}`);
}

async function _writeBrowserOutput({ instrOpts, inputPath, outPath, result, iidCount, sandboxVar }) {
    if (instrOpts.splitRuntime) {
        // 运行时 IIFE 单独输出，插桩代码引用它
        const runtimePath    = outPath.replace(/\.js$/, '.runtime.js');
        const runtimeRelPath = basename(runtimePath);
        const mapPath        = outPath.replace(/\.js$/, '.map.json');
        const vlcqMapPath    = outPath + '.map';

        log.info('正在用 rollup 打包浏览器运行时（split 模式）...');
        let runtimeBundle;
        try {
            runtimeBundle = await buildBrowserRuntimeBundle({ ...instrOpts, sandboxVar });
        } catch (err) {
            log.error('rollup 打包失败:', err.message);
            if (err.stack) log.error(err.stack);
            process.exit(1);
        }

        const instrCode = `// 请先加载运行时: <script src="${runtimeRelPath}"></script>\n` + result.code;

        if (instrOpts.dryRun) {
            console.log(`\n=== [dry-run] 运行时: ${runtimePath} (${(runtimeBundle.length / 1024).toFixed(1)} KB) ===`);
            console.log(runtimeBundle.slice(0, 400) + '\n...(截断)');
            console.log(`\n=== [dry-run] 插桩代码: ${outPath} ===`);
            console.log(instrCode.slice(0, 400) + '\n...(截断)');
            return;
        }

        ensureDir(runtimePath);
        writeFileSync(runtimePath, runtimeBundle, 'utf8');
        ensureDir(outPath);
        writeFileSync(outPath, instrCode, 'utf8');
        if (!instrOpts.noSourceMap && result.sourceMapString) writeFileSync(mapPath, result.sourceMapString, 'utf8');
        if (instrOpts.vlcqSourceMap && result.vlcqSourceMap)  writeFileSync(vlcqMapPath, JSON.stringify(result.vlcqSourceMap), 'utf8');

        console.log(`✓ 插桩完成（Browser，split 模式）`);
        console.log(`  输入      : ${inputPath}`);
        console.log(`  插桩代码  : ${outPath}`);
        console.log(`  运行时    : ${runtimePath}`);
        if (!instrOpts.noSourceMap && result.sourceMapString) console.log(`  IID map   : ${mapPath}`);
        if (instrOpts.vlcqSourceMap && result.vlcqSourceMap)  console.log(`  Source map: ${vlcqMapPath}`);
        console.log(`  IID 数量  : ${iidCount}`);
        console.log(`  沙盒变量  : ${sandboxVar}`);
        console.log(`\n  HTML 使用方式（注意顺序）：`);
        console.log(`    <script src="${runtimeRelPath}"></script>`);
        console.log(`    <script src="${basename(outPath)}"></script>`);
    } else {
        // 默认：运行时 IIFE + 插桩代码合并为单一文件
        const mapPath     = outPath.replace(/\.js$/, '.map.json');
        const vlcqMapPath = outPath + '.map';

        log.info('正在用 rollup 打包运行时...');
        let runtimeBundle;
        try {
            runtimeBundle = await buildBrowserRuntimeBundle({ ...instrOpts, sandboxVar });
        } catch (err) {
            log.error('rollup 打包失败:', err.message);
            if (err.stack) log.error(err.stack);
            process.exit(1);
        }

        const header = `\
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Jalangi2 Runtime Bundle (auto-generated ${new Date().toISOString().slice(0,10)})  ║
// ║  Do NOT edit this file manually.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
`;
        const finalCode = header + runtimeBundle + '\n' + result.code;

        if (instrOpts.dryRun) {
            const preview = finalCode.slice(0, 1000) + (finalCode.length > 1000 ? '\n...(截断)' : '');
            console.log(`\n=== [dry-run] 输出文件: ${outPath} (${finalCode.length} chars) ===\n`);
            console.log(preview);
            return;
        }

        ensureDir(outPath);
        writeFileSync(outPath, finalCode, 'utf8');
        if (!instrOpts.noSourceMap && result.sourceMapString) writeFileSync(mapPath, result.sourceMapString, 'utf8');
        if (instrOpts.vlcqSourceMap && result.vlcqSourceMap)  writeFileSync(vlcqMapPath, JSON.stringify(result.vlcqSourceMap), 'utf8');

        console.log(`✓ 插桩完成（Browser，内联模式）`);
        console.log(`  源文件    : ${inputPath}`);
        console.log(`  输出      : ${outPath}`);
        if (!instrOpts.noSourceMap && result.sourceMapString) console.log(`  IID map   : ${mapPath}`);
        if (instrOpts.vlcqSourceMap && result.vlcqSourceMap)  console.log(`  Source map: ${vlcqMapPath}`);
        console.log(`  IID 数量  : ${iidCount}`);
        console.log(`  沙盒变量  : ${sandboxVar}${sandboxVar === 'J$' ? ' (默认)' : ''}`);
        console.log(`  总大小    : ${(finalCode.length / 1024).toFixed(1)} KB${instrOpts.minify ? ' (已压缩)' : ''}`);
        if (instrOpts.useIdb) console.log(`  IDB       : ${instrOpts.dbName} / ${instrOpts.storeName}`);
        console.log(`\n直接替换网页中原始的 <script src="..."> 标签即可。`);
    }
}

// ── 子命令：run ───────────────────────────────────────────────────────────────

async function cmdRun(common, runArgs) {
    const runOpts = parseRunOpts(runArgs);
    if (!runOpts) {
        printHelp('run');
        process.exit(runArgs.some(a => a === '--help' || a === '-h') ? 0 : 1);
    }

    if (common.debug) _debug = true;
    log.debug('common:', JSON.stringify(common, null, 2));
    log.debug('runOpts:', JSON.stringify(runOpts, null, 2));

    const sandboxVar  = common.randomVar ? randomVarName() : common.sandboxVar;
    const scriptPath  = runOpts.script;

    // ── 确定运行时模块路径 ────────────────────────────────────────────────────
    let runtimePath = runOpts.runtime;
    if (!runtimePath) {
        // 自动探测：<script 同名>.runtime.mjs
        const autoRuntime = scriptPath.replace(/\.js$/, '.runtime.mjs');
        if (existsSync(autoRuntime)) {
            runtimePath = autoRuntime;
            log.debug(`自动探测到运行时: ${runtimePath}`);
        }
    }

    // ── 加载运行时模块（若有） ────────────────────────────────────────────────
    if (runtimePath) {
        if (!existsSync(runtimePath)) {
            log.error(`运行时模块不存在: ${runtimePath}`);
            process.exit(1);
        }
        log.debug(`加载运行时: ${runtimePath}`);
        await import(pathToFileURL(runtimePath).href);
    } else {
        // 未找到运行时，初始化一个空沙盒，避免插桩代码调用 J$.xxx 报错
        if (!global[sandboxVar]) global[sandboxVar] = {};
        log.debug(`未找到运行时，初始化空沙盒: ${sandboxVar}`);
    }

    // ── 设置沙盒 initParams ───────────────────────────────────────────────────
    const sandbox = global[sandboxVar] ?? {};
    sandbox.initParams = runOpts.initParams;
    if (!global[sandboxVar]) global[sandboxVar] = sandbox;

    // ── 加载分析插件 ──────────────────────────────────────────────────────────
    const _require = createRequire(pathToFileURL(scriptPath));
    for (const analysisPath of runOpts.analyses) {
        log.debug(`加载分析插件: ${analysisPath}`);
        _require(analysisPath);
    }

    // ── 直接运行已插桩文件 ────────────────────────────────────────────────────
    if (!existsSync(scriptPath)) { log.error(`文件不存在: ${scriptPath}`); process.exit(1); }

    process.argv = [process.argv[0], scriptPath, ...runOpts.scriptArgs];
    log.debug(`运行已插桩文件: ${scriptPath}`);

    process.on('exit', () => {
        if (typeof sandbox.endExecution === 'function') sandbox.endExecution();
    });

    const Module = (await import('module')).default;
    if (sandbox.analysis?.onReady) {
        sandbox.analysis.onReady(() => Module.Module.runMain(scriptPath, null, true));
    } else {
        Module.Module.runMain(scriptPath, null, true);
    }
}

// ── 子命令：instrument-and-run ────────────────────────────────────────────────

async function cmdInstrumentAndRun(common, iarArgs) {
    const iarOpts = parseInstrumentAndRunOpts(iarArgs);
    if (!iarOpts) {
        printHelp('instrument-and-run');
        process.exit(iarArgs.some(a => a === '--help' || a === '-h') ? 0 : 1);
    }

    if (common.target === 'browser') {
        log.error('instrument-and-run 仅支持 --target node（浏览器不支持 Node.js 运行）');
        process.exit(1);
    }

    if (common.debug) _debug = true;
    log.debug('common:', JSON.stringify(common, null, 2));
    log.debug('iarOpts:', JSON.stringify(iarOpts, null, 2));

    const sandboxVar = common.randomVar ? randomVarName() : common.sandboxVar;

    // ── 加载插桩器 ────────────────────────────────────────────────────────────
    const instrumentCode = await loadInstrumenter(sandboxVar, iarOpts.analyses);

    // ── 设置全局沙盒 ──────────────────────────────────────────────────────────
    if (!global[sandboxVar]) global[sandboxVar] = {};
    const sandbox = global[sandboxVar];
    sandbox.initParams = iarOpts.initParams;

    // ── 加载分析插件 ──────────────────────────────────────────────────────────
    const _require = createRequire(pathToFileURL(iarOpts.script));
    for (const analysisPath of iarOpts.analyses) {
        log.debug(`加载分析插件: ${analysisPath}`);
        _require(analysisPath);
    }

    // ── Module._extensions 钩子（对所有 require 的 .js 自动插桩）─────────────
    const Module = (await import('module')).default;
    const _origExtension = Module._extensions['.js'];

    Module._extensions['.js'] = (mod, filename) => {
        if (
            filename.includes('node_modules') ||
            filename.includes(FILESUFFIX) ||
            filename.startsWith(ROOT_DIR + '/src/instrument/') ||
            filename.startsWith(ROOT_DIR + '/src/runtime/') ||
            filename.startsWith(ROOT_DIR + '/bin/')
        ) {
            return _origExtension(mod, filename);
        }

        const code = readFileSync(filename, 'utf8');
        if (code.includes('// JALANGI DO NOT INSTRUMENT')) {
            log.debug(`跳过 (DO NOT INSTRUMENT): ${filename}`);
            return _origExtension(mod, filename);
        }

        const instFilename = makeInstFilename(filename);
        log.debug(`插桩: ${filename}`);

        let result;
        try {
            result = instrumentCode({
                code,
                isEval:           false,
                origCodeFileName: filename,
                instCodeFileName: instFilename,
                inlineSourceMap:  iarOpts.inlineIid,
                inlineSource:     iarOpts.inlineSource,
                sourceType:       common.sourceType,
            });
        } catch (err) {
            log.warn(`插桩失败，跳过 (${filename}): ${err.message}`);
            return _origExtension(mod, filename);
        }

        if (!iarOpts.noWrite) {
            ensureDir(instFilename);
            writeFileSync(instFilename, result.code, 'utf8');
            if (result.sourceMapString) {
                writeFileSync(makeMapFilename(filename), result.sourceMapString, 'utf8');
            }
        }

        mod._compile(result.code, instFilename);
    };

    // ── 运行目标脚本 ──────────────────────────────────────────────────────────
    const scriptPath = iarOpts.script;
    process.argv = [process.argv[0], scriptPath, ...iarOpts.scriptArgs];
    log.debug(`插桩并运行: ${scriptPath}`);

    process.on('exit', () => {
        if (typeof sandbox.endExecution === 'function') sandbox.endExecution();
    });

    if (sandbox.analysis?.onReady) {
        sandbox.analysis.onReady(() => Module.Module.runMain(scriptPath, null, true));
    } else {
        Module.Module.runMain(scriptPath, null, true);
    }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);

    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printHelp();
        process.exit(0);
    }

    const sub = argv[0];
    const VALID_SUBS = ['instrument', 'run', 'instrument-and-run'];
    if (!VALID_SUBS.includes(sub)) {
        log.error(`未知子命令: ${sub}`);
        log.error(`可用子命令: ${VALID_SUBS.join(', ')}`);
        log.error('使用 --help 查看完整帮助');
        process.exit(1);
    }

    // 从剩余参数中提取通用选项
    const { remaining, ...common } = parseCommonOpts(argv.slice(1));

    if (sub === 'instrument') {
        await cmdInstrument(common, remaining);
    } else if (sub === 'run') {
        await cmdRun(common, remaining);
    } else if (sub === 'instrument-and-run') {
        await cmdInstrumentAndRun(common, remaining);
    }
}

main().catch(err => {
    log.error('致命错误:', err.message);
    if (err.stack) log.error(err.stack);
    process.exit(1);
});
