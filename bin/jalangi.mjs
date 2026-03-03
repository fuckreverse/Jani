#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * @file bin/jalangi.mjs — 动态插桩并运行 Node.js 脚本（现代化重写）
 *
 * 对目标脚本的每一个 require'd .js 文件**即时插桩**后运行，
 * 同时加载指定的 Jalangi2 分析插件。
 *
 * 用法：
 *   node bin/jalangi.mjs [选项] <script> [script 参数...]
 *
 * 选项：
 *   --analysis <file>     分析插件路径（可重复）
 *   --init-param <k:v>    传给分析的初始参数（可重复，格式 key:value）
 *   --inline-iid          将 iid→位置 map 内联到插桩文件
 *   --inline-source       将原始源码内联到 source map
 *   --sandbox-var <v>     沙盒变量名（默认 J$）
 *   --no-write            不写插桩后的 .js 文件（只在内存中插桩）
 *   --debug               详细日志（等价于 JALANGI_DEBUG=1）
 *   --help / -h           显示帮助
 *
 * 示例：
 *   node bin/jalangi.mjs --analysis src/plugins/TraceAll.js tests/unit/simple.js
 *   node bin/jalangi.mjs --analysis myAnalysis.js -- myScript.js arg1 arg2
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT_DIR   = resolve(__dirname, '..');

// ── 日志 ──────────────────────────────────────────────────────────────────────

let _debug = process.env.JALANGI_DEBUG === '1';
const log = {
    debug(...a) { if (_debug) console.debug('[jalangi]', ...a); },
    info(...a)  { console.log(  '[jalangi]', ...a); },
    warn(...a)  { console.warn( '[jalangi]', ...a); },
    error(...a) { console.error('[jalangi]', ...a); },
};

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        analyses:     [],
        initParams:   {},
        inlineIid:    false,
        inlineSource: false,
        sandboxVar:   'J$',
        noWrite:      false,
        debug:        false,
        script:       null,
        scriptArgs:   [],
    };
    let i = 0;
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { i++; break; }
        switch (a) {
            case '--help': case '-h':   printHelp(); process.exit(0); break;
            case '--analysis':          opts.analyses.push(resolve(argv[++i])); break;
            case '--init-param': {
                const kv  = argv[++i];
                const idx = kv.indexOf(':');
                if (idx < 0) { log.error(`--init-param 格式应为 key:value，得到: ${kv}`); process.exit(1); }
                opts.initParams[kv.slice(0, idx)] = kv.slice(idx + 1);
                break;
            }
            case '--inline-iid':        opts.inlineIid    = true;      break;
            case '--inline-source':     opts.inlineSource = true;      break;
            case '--sandbox-var':       opts.sandboxVar   = argv[++i]; break;
            case '--no-write':          opts.noWrite      = true;      break;
            case '--debug':             opts.debug        = true;      break;
            default:
                if (a.startsWith('--')) { log.error(`未知选项: ${a}`); process.exit(1); }
                opts.script = resolve(a);
                opts.scriptArgs = argv.slice(i + 1);
                i = argv.length; // stop parsing
        }
    }
    if (i < argv.length && !opts.script) {
        opts.script = resolve(argv[i++]);
        opts.scriptArgs = argv.slice(i);
    }
    if (!opts.script) { printHelp(); process.exit(1); }
    return opts;
}

function printHelp() {
    console.log(`
用法：
  node bin/jalangi.mjs [选项] <script> [script 参数...]

选项：
  --analysis <file>     分析插件路径（可重复）
  --init-param <k:v>    传给分析的初始参数（可重复，格式 key:value）
  --inline-iid          将 iid→位置 map 内联到插桩文件
  --inline-source       将原始源码内联到 source map
  --sandbox-var <v>     沙盒变量名（默认 J$）
  --no-write            不写插桩后的 .js 文件（只在内存中插桩运行）
  --debug               输出详细日志（等价于 JALANGI_DEBUG=1）
  --help / -h           显示此帮助
    `.trim());
}

// ── 文件名辅助 ────────────────────────────────────────────────────────────────

const FILESUFFIX = '_jalangi_';

function makeInstFilename(name) {
    return name.replace(/\.js$/, `${FILESUFFIX}.js`);
}
function makeMapFilename(name) {
    return makeInstFilename(name).replace(/\.js$/, '.map.json');
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.debug) _debug = true;

    log.debug('options:', JSON.stringify(opts, null, 2));

    // 加载插桩器
    const { init, instrumentCode } = await import(
        `${ROOT_DIR}/src/instrument/esnstrument.js`
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
    }, null, null, opts.sandboxVar);

    // 设置全局沙盒变量（分析通过 global[sandboxVar] 访问）
    const sandboxName = opts.sandboxVar;
    if (!global[sandboxName]) global[sandboxName] = {};
    const sandbox = global[sandboxName];
    sandbox.initParams = opts.initParams;

    // 加载分析插件（CommonJS require，分析文件通常仍是 CJS）
    const _require = createRequire(pathToFileURL(opts.script));
    for (const analysisPath of opts.analyses) {
        log.debug(`加载分析插件: ${analysisPath}`);
        _require(analysisPath);
    }

    // 注入 Module._extensions 钩子（对所有 require'd .js 文件即时插桩）
    const Module = (await import('module')).default;
    const _origExtension = Module._extensions['.js'];

    Module._extensions['.js'] = (mod, filename) => {
        // 跳过 node_modules、已插桩文件、和本框架自身
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
                inlineSourceMap:  opts.inlineIid,
                inlineSource:     opts.inlineSource,
                sourceType:       'script',
            });
        } catch (err) {
            log.warn(`插桩失败，跳过 (${filename}): ${err.message}`);
            return _origExtension(mod, filename);
        }

        if (!opts.noWrite) {
            const instDir = dirname(instFilename);
            if (!existsSync(instDir)) mkdirSync(instDir, { recursive: true });
            writeFileSync(instFilename, result.code, 'utf8');
            if (result.sourceMapString) {
                writeFileSync(makeMapFilename(filename), result.sourceMapString, 'utf8');
            }
        }

        mod._compile(result.code, instFilename);
    };

    // 运行目标脚本
    const scriptPath = opts.script;
    process.argv = [process.argv[0], scriptPath, ...opts.scriptArgs];

    log.debug(`运行: ${scriptPath}`);
    process.on('exit', () => {
        if (typeof sandbox.endExecution === 'function') {
            sandbox.endExecution();
        }
    });

    if (sandbox.analysis?.onReady) {
        sandbox.analysis.onReady(() => Module.Module.runMain(scriptPath, null, true));
    } else {
        Module.Module.runMain(scriptPath, null, true);
    }
}

main().catch(err => {
    log.error('致命错误:', err.message);
    if (err.stack) log.error(err.stack);
    process.exit(1);
});
