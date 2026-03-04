#!/usr/bin/env node
// JALANGI DO NOT INSTRUMENT

/**
 * @file bin/instrument.mjs — 单文件 JS 插桩 CLI（现代化重写）
 *
 * 对单个 .js 文件进行 Jalangi2 插桩，将结果写到指定输出文件。
 * source map（iid → 源码位置）同步写为 <输出文件>.map.json。
 *
 * 用法：
 *   node bin/instrument.mjs [选项] <输入文件>
 *
 * 选项：
 *   --output <file>       输出文件路径（默认：<input>_jalangi_.js）
 *   --source-type <t>     'script'（默认）或 'module'
 *   --inline-iid          将 iid→位置 map 内联到输出文件头部
 *   --inline-source       将原始源码内联到 source map
 *   --no-source-map       不写 .map.json 文件
 *   --vlcq-source-map     额外生成标准 Source Map v3（.js.map），供调试器使用
 *   --sandbox-var <v>     沙盒变量名（默认 J$）
 *   --dry-run             只打印，不写文件
 *   --debug               详细日志
 *   --help / -h           显示帮助
 *
 * 示例：
 *   node bin/instrument.mjs src/app.js
 *   node bin/instrument.mjs --output dist/app.inst.js src/app.js
 *   node bin/instrument.mjs --inline-iid --source-type module src/app.mjs
 *   node bin/instrument.mjs --vlcq-source-map src/app.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT_DIR   = resolve(__dirname, '..');

// ── 日志 ──────────────────────────────────────────────────────────────────────

let _debug = process.env.JALANGI_DEBUG === '1';
const log = {
    debug(...a) { if (_debug) console.debug('[instrument]', ...a); },
    info(...a)  { console.log(  '[instrument]', ...a); },
    warn(...a)  { console.warn( '[instrument]', ...a); },
    error(...a) { console.error('[instrument]', ...a); },
};

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        output:         null,
        sourceType:     'script',
        inlineIid:      false,
        inlineSource:   false,
        noSourceMap:    false,
        vlcqSourceMap:  false,
        sandboxVar:     'J$',
        dryRun:         false,
        debug:          false,
        file:           null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--help': case '-h':   printHelp(); process.exit(0); break;
            case '--output':            opts.output        = argv[++i]; break;
            case '--source-type':       opts.sourceType    = argv[++i]; break;
            case '--inline-iid':        opts.inlineIid     = true;      break;
            case '--inline-source':     opts.inlineSource  = true;      break;
            case '--no-source-map':     opts.noSourceMap   = true;      break;
            case '--vlcq-source-map':   opts.vlcqSourceMap = true;      break;
            case '--sandbox-var':       opts.sandboxVar    = argv[++i]; break;
            case '--dry-run':           opts.dryRun        = true;      break;
            case '--debug':             opts.debug         = true;      break;
            default:
                if (a.startsWith('--')) { log.error(`未知选项: ${a}`); process.exit(1); }
                if (opts.file)          { log.error('只支持单个输入文件。'); process.exit(1); }
                opts.file = resolve(a);
        }
    }
    if (!opts.file) { printHelp(); process.exit(1); }
    return opts;
}

function printHelp() {
    console.log(`
用法：
  node bin/instrument.mjs [选项] <输入文件>

选项：
  --output <file>       输出文件路径（默认：<input>_jalangi_.js）
  --source-type <t>     'script'（默认）或 'module'
  --inline-iid          将 iid→位置 map 内联到输出文件头部
  --inline-source       将原始源码内联到 source map
  --no-source-map       不写 .map.json 文件
  --vlcq-source-map     额外生成标准 Source Map v3（<输出文件>.js.map），供 DevTools/VS Code 调试
  --sandbox-var <v>     沙盒变量名（默认 J$）
  --dry-run             只打印，不写文件
  --debug               输出详细日志（等价于 JALANGI_DEBUG=1）
  --help / -h           显示此帮助
    `.trim());
}

/** 默认输出文件名：foo.js → foo_jalangi_.js */
function defaultOutFile(inputPath) {
    const base = basename(inputPath);
    return resolve(dirname(inputPath), base.replace(/\.js$/, '_jalangi_.js'));
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

    const inputPath   = opts.file;
    const outPath     = opts.output ? resolve(opts.output) : defaultOutFile(inputPath);
    const mapPath     = outPath.replace(/\.js$/, '.map.json');
    // 标准 Source Map v3 路径：在输出文件名后追加 .map（如 foo_jalangi_.js → foo_jalangi_.js.map）
    const vlcqMapPath = outPath + '.map';

    // 读取源文件
    if (!existsSync(inputPath)) {
        log.error(`文件不存在: ${inputPath}`);
        process.exit(1);
    }
    const originalCode = readFileSync(inputPath, 'utf8');
    log.debug(`读取 ${inputPath} (${(originalCode.length / 1024).toFixed(1)} KB)`);

    if (originalCode.includes('// JALANGI DO NOT INSTRUMENT')) {
        log.warn(`跳过（已标记 DO NOT INSTRUMENT）: ${inputPath}`);
        process.exit(0);
    }

    // 插桩
    let result;
    try {
        result = instrumentCode({
            code:             originalCode,
            origCodeFileName: inputPath,
            instCodeFileName: outPath,
            inlineSourceMap:  opts.inlineIid,
            inlineSource:     opts.inlineSource,
            sourceType:       opts.sourceType,
            isEval:           false,
        });
    } catch (err) {
        log.error('插桩失败:', err.message);
        if (err.stack) log.error(err.stack);
        process.exit(1);
    }

    const iidCount = Object.keys(result.sourceMapObject ?? {}).filter(k => !isNaN(k)).length;
    log.debug(`插桩完成：${iidCount} IIDs, ${(result.code.length / 1024).toFixed(1)} KB`);

    if (opts.dryRun) {
        const preview = result.code.slice(0, 800) + (result.code.length > 800 ? '\n...(截断)' : '');
        console.log(`\n=== [dry-run] 输出文件: ${outPath} ===\n`);
        console.log(preview);
        if (opts.vlcqSourceMap && result.vlcqSourceMap) {
            console.log(`\n=== [dry-run] VLCQ Source Map: ${vlcqMapPath} ===`);
            const mapPreview = JSON.stringify(result.vlcqSourceMap, null, 2);
            console.log(mapPreview.slice(0, 400) + (mapPreview.length > 400 ? '\n...(截断)' : ''));
        }
        return;
    }

    // 写输出
    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    writeFileSync(outPath, result.code, 'utf8');
    if (!opts.noSourceMap && result.sourceMapString) {
        writeFileSync(mapPath, result.sourceMapString, 'utf8');
    }
    // 写标准 VLCQ source map（--vlcq-source-map 时）
    if (opts.vlcqSourceMap && result.vlcqSourceMap) {
        writeFileSync(vlcqMapPath, JSON.stringify(result.vlcqSourceMap), 'utf8');
        log.debug(`VLCQ source map 已写出: ${vlcqMapPath} (${(JSON.stringify(result.vlcqSourceMap).length / 1024).toFixed(1)} KB)`);
    }

    console.log(`✓ 插桩完成`);
    console.log(`  输入    : ${inputPath}`);
    console.log(`  输出    : ${outPath}`);
    if (!opts.noSourceMap) console.log(`  IID map    : ${mapPath}`);
    if (opts.vlcqSourceMap && result.vlcqSourceMap) console.log(`  Source map : ${vlcqMapPath}`);
    console.log(`  IID 数量: ${iidCount}`);
    console.log(`  沙盒变量: ${opts.sandboxVar}`);
}

main().catch(err => {
    log.error('致命错误:', err.message);
    if (err.stack) log.error(err.stack);
    process.exit(1);
});
