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
 *   --source-type <t>  'script'（默认）或 'module'
 *   --no-idb           不启用 IndexedDB（仅 console 输出 trace）
 *   --dry-run          只打印结果，不写文件
 *   --help / -h        显示本帮助
 *
 * 示例：
 *   npm run trace:instrument -- src/app.js
 *   npm run trace:instrument -- --output dist/app.traced.js src/app.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { rollup } from 'rollup';

// ── 路径常量 ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT_DIR   = resolve(__dirname, '..');
const SRC        = (...parts) => join(ROOT_DIR, 'src', 'js', ...parts);

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        output:     null,
        dbName:     'jalangi-traces',
        storeName:  'execution-trace',
        sourceType: 'script',
        useIdb:     true,
        dryRun:     false,
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
            case '--dry-run':     opts.dryRun     = true;      break;
            default:
                if (a.startsWith('--')) { console.error(`未知选项: ${a}`); process.exit(1); }
                if (opts.file) { console.error('只支持单个目标文件。'); process.exit(1); }
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
  --dry-run           只打印，不写文件
  --help / -h         显示此帮助
    `.trim());
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
    // idb-worker.js 内联为字符串（classic worker，不经过 rollup）
    const idbWorkerSrc = readFileSync(
        SRC('runtime', 'logging', 'workers', 'idb-worker.js'),
        'utf8'
    ).replace(/^\/\/ JALANGI DO NOT INSTRUMENT\s*\n?/m, '').trim();

    // 虚拟入口 ID
    const ENTRY_ID = '\0jalangi-entry';

    // 虚拟入口：纯静态 import，无动态 import，rollup 可完全分析
    //
    // 关键：TraceLogger / LogManager 里有动态 import，
    // 我们通过 plugin（resolveDynamicImport）把它们都重定向到真实路径，
    // 这样 rollup 会把这些模块当成普通静态依赖内联进来。
    // WsBackend / NodeStreamBackend / MemoryBackend 重定向到空 stub，
    // 由 treeshake 消除（不在 bundle 里）。
    const entryCode = `
// 静态导入所有运行时依赖
import { APPLY, CALL, HAS_OWN_PROPERTY, HAS_OWN_PROPERTY_CALL,
         JALANGI_VAR, SPECIAL_PROP, SPECIAL_PROP2, SPECIAL_PROP3, SPECIAL_PROP4,
         SPECIAL_PROP_SID, SPECIAL_PROP_IID, UNKNOWN, HOP, hasGetterSetter
} from '${SRC('Constants.js')}';
import { createRuntime    } from '${SRC('runtime', 'analysis.js')}';
import { createIidToLocation } from '${SRC('runtime', 'iidToLocation.js')}';
import { IdbWorkerBackend } from '${SRC('runtime', 'logging', 'backends', 'IdbWorkerBackend.js')}';
import { RingBuffer       } from '${SRC('runtime', 'logging', 'RingBuffer.js')}';
import { LogManager       } from '${SRC('runtime', 'logging', 'LogManager.js')}';
import { TraceLogger      } from '${SRC('runtime', 'logging', 'TraceLogger.js')}';
import { ExecutionTraceAnalysis } from '${SRC('sample_analyses', 'ExecutionTrace.js')}';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
var J$ = globalThis.J$ = globalThis.J$ || {};

J$.Constants = {
    APPLY, CALL, HAS_OWN_PROPERTY, HAS_OWN_PROPERTY_CALL,
    JALANGI_VAR, SPECIAL_PROP, SPECIAL_PROP2, SPECIAL_PROP3, SPECIAL_PROP4,
    SPECIAL_PROP_SID, SPECIAL_PROP_IID, UNKNOWN, HOP, hasGetterSetter
};
J$.smap = J$.smap || {};
J$.sid  = 0;

createRuntime(J$);
createIidToLocation(J$);

J$.analysis = new ExecutionTraceAnalysis(J$, null, {
    useIdb:    ${opts.useIdb},
    dbName:    ${JSON.stringify(opts.dbName)},
    storeName: ${JSON.stringify(opts.storeName)},
});
`;

    // 模块路径 → 真实文件路径（用于动态 import 重定向）
    const DYNAMIC_IMPORT_MAP = {
        './backends/IdbWorkerBackend.js':  SRC('runtime', 'logging', 'backends', 'IdbWorkerBackend.js'),
        './LogManager.js':                 SRC('runtime', 'logging', 'LogManager.js'),
        // 下面三个不打进浏览器 bundle，用 stub 替代
        './backends/WsBackend.js':         '\0stub:WsBackend',
        './backends/NodeStreamBackend.js': '\0stub:NodeStreamBackend',
        './backends/MemoryBackend.js':     '\0stub:MemoryBackend',
    };

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
                return mapped ?? null;
            },
            load(id) {
                // stub 模块：空导出，rollup 会 tree-shake 掉使用它们的代码
                if (id === '\0stub:WsBackend')
                    return 'export const WsBackend = undefined;';
                if (id === '\0stub:NodeStreamBackend')
                    return 'export const NodeStreamBackend = undefined;';
                if (id === '\0stub:MemoryBackend')
                    return 'export const MemoryBackend = undefined;';
            },
        },
    ];

    const bundle = await rollup({
        input:    ENTRY_ID,
        plugins,
        external: [],   // 不外置任何模块
        onwarn(warning) {
            // 只显示未解析 import 的警告（其余静默）
            if (warning.code === 'UNRESOLVED_IMPORT') {
                console.warn('[rollup]', warning.message);
            }
        },
    });

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
    return output[0].code;
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    // 动态导入插桩器
    const { init, instrumentCode } = await import(
        `${ROOT_DIR}/src/js/instrument/esnstrument.js`
    );

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
    });

    const inputPath = opts.file;
    const outPath   = opts.output ? resolve(opts.output) : inputPath;

    // ── 读目标文件 ────────────────────────────────────────────────────────────
    const originalCode = readFileSync(inputPath, 'utf8');

    if (originalCode.includes('// JALANGI DO NOT INSTRUMENT')) {
        console.warn(`⊘ 跳过（已标记 DO NOT INSTRUMENT）: ${inputPath}`);
        process.exit(0);
    }

    // ── 插桩目标代码 ──────────────────────────────────────────────────────────
    const result = instrumentCode({
        code:             originalCode,
        origCodeFileName: inputPath,
        instCodeFileName: outPath,
        inlineSourceMap:  true,
        inlineSource:     true,
        sourceType:       opts.sourceType,
        isEval:           false,
    });

    // ── 用 rollup 构建运行时 bundle ───────────────────────────────────────────
    console.log('正在用 rollup 打包运行时...');
    const runtimeBundle = await buildRuntimeBundle(opts);

    // ── 拼接最终输出 ──────────────────────────────────────────────────────────
    //
    // 结构：
    //   1. 文件头注释
    //   2. 运行时 IIFE（设置 globalThis.J$，安装所有钩子和 analysis）
    //   3. 插桩后的目标代码（直接调用 J$.R / J$.W / ... 等）
    //
    const header = `\
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Jalangi2 Runtime Bundle (auto-generated ${new Date().toISOString().slice(0,10)})  ║
// ║  Do NOT edit this file manually.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
`;
    const finalCode = header + runtimeBundle + '\n' + result.code;

    // ── 写出 ──────────────────────────────────────────────────────────────────
    if (opts.dryRun) {
        const preview = finalCode.slice(0, 1000) + (finalCode.length > 1000 ? '\n...(截断)' : '');
        console.log(`\n=== [dry-run] 输出文件: ${outPath} (${finalCode.length} chars) ===\n`);
        console.log(preview);
    } else {
        const outDir = dirname(outPath);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        writeFileSync(outPath, finalCode, 'utf8');

        const iidCount = Object.keys(result.sourceMapObject ?? {})
            .filter(k => !isNaN(k)).length;

        console.log(`✓ 插桩完成`);
        console.log(`  源文件  : ${inputPath}`);
        console.log(`  输出    : ${outPath}`);
        console.log(`  IID 数量: ${iidCount}`);
        console.log(`  总大小  : ${(finalCode.length / 1024).toFixed(1)} KB`);
        if (opts.useIdb) {
            console.log(`  IDB     : ${opts.dbName} / ${opts.storeName}`);
        }
        console.log(`\n直接替换网页中原始的 <script src="..."> 标签即可。`);
    }
}

main().catch(err => {
    console.error('[instrument-for-browser] 致命错误:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
