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
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';

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
        wsUrl:      undefined,
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
            case '--ws-url':      opts.wsUrl      = argv[++i]; break;
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
  --ws-url <url>      同时将 trace 推送到 WebSocket 服务（如 ws://localhost:9229/trace）
  --dry-run           只打印，不写文件
  --help / -h         显示此帮助
    `.trim());
}

// ── ESM → 内联代码转换 ────────────────────────────────────────────────────────

/**
 * 将一个 ESM 源文件转换为可直接内联到 IIFE 作用域中的代码片段：
 *  - 去掉 `// JALANGI DO NOT INSTRUMENT` 行
 *  - 去掉所有 `import ...` 语句（单行，依赖手动排序）
 *  - `export function foo` → `function foo`
 *  - `export class Foo`   → `class Foo`
 *  - `export const/let/var x` → `const/let/var x`
 *  - `export { ... }` 块 → 删除
 *  - `export default <expr>` → 删除（或转为具名变量）
 */
function inlineEsm(src) {
    return src
        // 去掉 DO NOT INSTRUMENT 标记行
        .replace(/^\/\/ JALANGI DO NOT INSTRUMENT\s*\n?/m, '')
        // 去掉单行 import 语句（支持多种格式）
        .replace(/^import\s[^;]+?['"][^'"]+['"]\s*;?\s*$/gm, '')
        // export async function → async function
        .replace(/^export\s+(async\s+function)/gm, '$1')
        // export function → function
        .replace(/^export\s+function\b/gm, 'function')
        // export class → class
        .replace(/^export\s+class\b/gm, 'class')
        // export const/let/var → const/let/var
        .replace(/^export\s+(const|let|var)\b/gm, '$1')
        // 去掉 export { ... }; 块（单行或末尾）
        .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
        // 去掉 export default（保留表达式本身，不做转变量——如需可扩展）
        .replace(/^export\s+default\s+/gm, '// (export default) ')
        .trim();
}

// ── 运行时 Bundle 生成 ────────────────────────────────────────────────────────

/**
 * 把所有运行时模块按依赖顺序内联到一个 IIFE 中。
 *
 * 依赖顺序（从底层到顶层）：
 *   Constants → analysis → iidToLocation
 *   → RingBuffer → [IDB worker 作为 Blob] → IdbWorkerBackend → LogManager
 *   → TraceLogger → ExecutionTrace
 *   → Bootstrap（创建 J$、安装 analysis）
 */
function buildRuntimeBundle(opts) {
    const read = (p) => readFileSync(p, 'utf8');

    // ── 1. Constants ──────────────────────────────────────────────────────────
    const constantsCode = inlineEsm(read(SRC('Constants.js')));

    // ── 2. analysis（createRuntime） ──────────────────────────────────────────
    const analysisCode = inlineEsm(read(SRC('runtime', 'analysis.js')));

    // ── 3. iidToLocation ──────────────────────────────────────────────────────
    const iidToLocCode = inlineEsm(read(SRC('runtime', 'iidToLocation.js')));

    // ── 4. RingBuffer ─────────────────────────────────────────────────────────
    const ringBufCode = inlineEsm(read(SRC('runtime', 'logging', 'RingBuffer.js')));

    // ── 5. IDB Worker（内联为 Blob，type:'classic' 兼容所有浏览器）─────────────
    //
    // idb-worker.js 本身没有任何 import，可以直接作为 classic worker 使用。
    let idbWorkerCode = read(SRC('runtime', 'logging', 'workers', 'idb-worker.js'))
        .replace(/^\/\/ JALANGI DO NOT INSTRUMENT\s*\n?/m, '')
        .trim();

    // ── 6. IdbWorkerBackend ───────────────────────────────────────────────────
    //
    // 原代码默认用 `new URL('../workers/idb-worker.js', import.meta.url)`
    // bundle 里没有 import.meta.url，改为使用预先构造好的 __idbWorkerUrl。
    let idbBackendCode = inlineEsm(read(SRC('runtime', 'logging', 'backends', 'IdbWorkerBackend.js')));
    idbBackendCode = idbBackendCode
        .replace(
            /workerUrl\s*=\s*new URL\s*\([^)]+\)/,
            'workerUrl = __idbWorkerUrl'
        )
        .replace(
            /new Worker\(this\._workerUrl,\s*\{[^}]*\}\)/,
            "new Worker(this._workerUrl)"
        );

    // ── 7. LogManager ─────────────────────────────────────────────────────────
    // LogManager 里的两个工厂函数（createMemoryLogManager / createLogManager）
    // 有动态 import，bundle 中用不到，替换掉
    let logMgrCode = inlineEsm(read(SRC('runtime', 'logging', 'LogManager.js')));
    logMgrCode = logMgrCode
        .replace(
            /async function createMemoryLogManager[\s\S]*?^}/m,
            '// createMemoryLogManager (removed in bundle)'
        )
        .replace(
            /async function createLogManager[\s\S]*?^}/m,
            '// createLogManager (removed in bundle)'
        );

    // ── 8. TraceLogger ────────────────────────────────────────────────────────
    //
    // TraceLogger 里有动态 import（在 _doInit 中），bundle 里直接替换：
    //   - 浏览器分支：IdbWorkerBackend / WsBackend 已在作用域里，直接用
    //   - Node.js 分支：浏览器环境不会走，删掉即可
    //   - LogManager：已在作用域里
    let traceLoggerCode = inlineEsm(read(SRC('runtime', 'logging', 'TraceLogger.js')));
    traceLoggerCode = traceLoggerCode
        // 替换：const { IdbWorkerBackend } = await import(...)
        .replace(
            /const\s*\{\s*IdbWorkerBackend\s*\}\s*=\s*await\s+import\s*\([^)]+\)\s*;/g,
            '// IdbWorkerBackend already in scope'
        )
        // 替换：const { WsBackend } = await import(...)
        .replace(
            /const\s*\{\s*WsBackend\s*\}\s*=\s*await\s+import\s*\([^)]+\)\s*;/g,
            '// WsBackend not available in browser bundle'
        )
        // 替换：const { NodeStreamBackend } = await import(...)
        .replace(
            /const\s*\{\s*NodeStreamBackend\s*\}\s*=\s*await\s+import\s*\([^)]+\)\s*;/g,
            '// NodeStreamBackend not available in browser bundle'
        )
        // 替换：const { LogManager } = await import(...)
        .replace(
            /const\s*\{\s*LogManager\s*\}\s*=\s*await\s+import\s*\([^)]+\)\s*;/g,
            '// LogManager already in scope'
        );

    // ── 9. ExecutionTrace ─────────────────────────────────────────────────────
    //
    // ExecutionTrace 现在通过 TraceLogger（已在作用域）来管理日志，
    // 只需去掉 `import { TraceLogger } from ...` 这一行即可，无需其他改动。
    const execTraceCode = inlineEsm(read(SRC('sample_analyses', 'ExecutionTrace.js')));

    // ── 拼装 IIFE ─────────────────────────────────────────────────────────────
    return `\
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Jalangi2 Runtime Bundle (auto-generated ${new Date().toISOString().slice(0,10)})  ║
// ║  Do NOT edit this file manually.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
(function () {
'use strict';

// ─── IDB Worker: 内联为 Blob URL（classic worker，兼容所有浏览器）─────────────
var __idbWorkerSrc  = ${JSON.stringify(idbWorkerCode)};
var __idbWorkerBlob = (typeof Blob !== 'undefined')
    ? new Blob([__idbWorkerSrc], { type: 'application/javascript' })
    : null;
var __idbWorkerUrl  = __idbWorkerBlob
    ? URL.createObjectURL(__idbWorkerBlob)
    : null;

// ─── Constants ────────────────────────────────────────────────────────────────
${constantsCode}

// ─── Runtime hooks (createRuntime) ────────────────────────────────────────────
${analysisCode}

// ─── iidToLocation ────────────────────────────────────────────────────────────
${iidToLocCode}

// ─── RingBuffer ───────────────────────────────────────────────────────────────
${ringBufCode}

// ─── IdbWorkerBackend ─────────────────────────────────────────────────────────
${idbBackendCode}

// ─── LogManager ───────────────────────────────────────────────────────────────
${logMgrCode}

// ─── TraceLogger ──────────────────────────────────────────────────────────────
${traceLoggerCode}

// ─── ExecutionTrace ───────────────────────────────────────────────────────────
${execTraceCode}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
var J$ = globalThis.J$ = globalThis.J$ || {};

// Constants 模块的所有导出挂到 J$.Constants
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
    ${opts.wsUrl ? `wsUrl: ${JSON.stringify(opts.wsUrl)},` : '// wsUrl: undefined (disabled)'}
});

}());
// ── End of Jalangi2 Runtime Bundle ────────────────────────────────────────────
`;
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

    // ── 构建运行时 bundle ─────────────────────────────────────────────────────
    const runtimeBundle = buildRuntimeBundle(opts);

    // ── 拼接最终输出 ──────────────────────────────────────────────────────────
    //
    // 结构：
    //   1. 运行时 IIFE（设置 globalThis.J$，安装所有钩子和 analysis）
    //   2. 插桩后的目标代码（直接调用 J$.R / J$.W / ... 等）
    //
    const finalCode = runtimeBundle + '\n' + result.code;

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
