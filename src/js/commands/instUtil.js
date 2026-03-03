// JALANGI DO NOT INSTRUMENT

/*
 * Copyright 2013 Samsung Information Systems America, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file instUtil —— 浏览器注入辅助工具（Node.js-only）。
 *
 * 提供将 Jalangi 运行时脚本拼成 HTML `<script>` 标签字符串的工具函数，
 * 供 HTTP 代理服务器（rewriting-proxy）或 CLI 命令 instrument.js 使用。
 *
 * 注意：本文件强依赖 Node.js 内置模块（fs/path/url），不能在浏览器中使用。
 */

// 动态 import Node.js 内置模块（ESM 方式）
import { readFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { parse as urlParse } from 'url';
import { createRequire } from 'module';

// 仍需 CJS require 的遗留模块（headers/footers 尚未迁移到 ESM）
const require = createRequire(import.meta.url);

// 默认 header 源文件列表（浏览器注入用）
export let headerSources = [
    'node_modules/acorn/dist/acorn.js',
];

let _headersSet   = false;
let _headerCode   = '';

/**
 * 追加 analysis-specific 的 headerSources（来自 ../headers.js），只执行一次。
 */
export function setHeaders() {
    if (!_headersSet) {
        try {
            const extra = require('../browser/headers').headerSources;
            headerSources = headerSources.concat(extra);
        } catch {
            // ../headers.js 不存在时跳过（核心测试场景不需要）
        }
        _headersSet = true;
    }
}

/**
 * 生成 initParams 的内联 `<script>` 代码。
 *
 * @param {string[]} [initParams] - 形如 "key:value" 的字符串数组
 * @returns {string}
 */
export function genInitParamsCode(initParams) {
    const obj = {};
    if (initParams) {
        for (const keyVal of initParams) {
            const idx = keyVal.indexOf(':');
            if (idx < 0) throw new Error(`invalid initParam "${keyVal}"`);
            obj[keyVal.slice(0, idx)] = keyVal.slice(idx + 1);
        }
    }
    return `<script>J$.initParams = ${JSON.stringify(obj)};</script>`;
}

/**
 * 将 AST handler 的结果追加到插桩结果代码头部。
 *
 * @param {{ code: string, instAST?: object }} instResult
 * @param {Function|null} astHandler
 * @param {{ Constants: { JALANGI_VAR: string } }} sandbox
 * @returns {string}
 */
export function applyASTHandler(instResult, astHandler, sandbox) {
    if (astHandler && instResult.instAST) {
        const info = astHandler(instResult.instAST);
        if (info) {
            instResult.code = `${sandbox.Constants.JALANGI_VAR}.ast_info = ${JSON.stringify(info)};\n${instResult.code}`;
        }
    }
    return instResult.code;
}

/**
 * 读取所有 headerSources 的文件内容，拼成一个字符串（Node.js 内联用）。
 *
 * @param {string} [root] - 可选的根路径前缀
 * @returns {string}
 */
export function getHeaderCode(root) {
    if (!_headerCode) {
        for (let src of headerSources) {
            if (root) src = join(root, src);
            _headerCode += readFileSync(src, 'utf8');
        }
    }
    return _headerCode;
}

/**
 * 生成 headerSources 的 `<script src="...">` 标签字符串。
 *
 * @param {string} [root]
 * @returns {string}
 */
export function getHeaderCodeAsScriptTags(root) {
    let ret = '';
    for (let src of headerSources) {
        if (root) src = join(root, src);
        src = resolve(src);
        ret += `<script src="${src}"></script>`;
    }
    return ret;
}

/**
 * 生成用于浏览器内联注入的完整 `<script>` 标签字符串。
 *
 * @param {string[]|null} analyses        - 分析插件路径列表
 * @param {string[]|null} initParams      - initParams（"key:value" 数组）
 * @param {string[]}      extraAppScripts - 额外脚本路径列表
 * @param {string}        EXTRA_SCRIPTS_DIR
 * @param {string|null}   jalangiRoot
 * @param {string|null}   cdn             - CDN 地址（使用 CDN 时跳过本地文件读取）
 * @returns {string}
 */
export function getInlinedScripts(analyses, initParams, extraAppScripts, EXTRA_SCRIPTS_DIR, jalangiRoot, cdn) {
    if (!_headerCode) {
        if (cdn) {
            _headerCode += `<script type="text/javascript" src="${cdn}/jalangi.js"></script>`;
        } else {
            for (let src of headerSources) {
                if (jalangiRoot) src = join(jalangiRoot, src);
                _headerCode += `<script type="text/javascript">`;
                _headerCode += readFileSync(src, 'utf8');
                _headerCode += `</script>`;
            }
        }

        if (analyses) {
            const initParamsCode = genInitParamsCode(initParams);
            if (initParamsCode) _headerCode += initParamsCode;

            if (cdn) {
                _headerCode += `<script type="text/javascript" src="${cdn}/analyses.js"></script>`;
            } else {
                for (let src of analyses) {
                    src = resolve(src);
                    _headerCode += `<script type="text/javascript">`;
                    _headerCode += readFileSync(src, 'utf8');
                    _headerCode += `</script>`;
                }
            }
        }

        if (extraAppScripts.length > 0) {
            if (cdn) {
                _headerCode += `<script type="text/javascript" src="${cdn}/extras.js"></script>`;
            } else {
                for (const script of extraAppScripts) {
                    const scriptSrc = join(EXTRA_SCRIPTS_DIR, basename(script));
                    _headerCode += `<script type="text/javascript">`;
                    _headerCode += readFileSync(scriptSrc, 'utf8');
                    _headerCode += `</script>`;
                }
            }
        }
    }
    return _headerCode;
}

/**
 * 生成 footer 脚本的 `<script>` 标签字符串。
 *
 * @param {string|null} jalangiRoot
 * @returns {string}
 */
export function getFooterString(jalangiRoot) {
    let footerSources;
    try {
        footerSources = require('../browser/footers').footerSources;
    } catch {
        return '';
    }

    let code = '';
    for (let src of footerSources) {
        if (jalangiRoot) src = join(jalangiRoot, src);
        if (src.endsWith('.js')) {
            code += `<script type="text/javascript">`;
            code += readFileSync(src, 'utf8');
            code += `</script>`;
        } else {
            code += readFileSync(src, 'utf8');
        }
    }
    return code;
}

const INLINE_REGEXP = /#(inline|event-handler|js-url)/;

/**
 * URL 是否代表内联脚本（来自 rewriting-proxy 的标记）。
 * @param {string} url
 * @returns {boolean}
 */
export function isInlineScript(url) {
    return INLINE_REGEXP.test(url);
}

/**
 * 根据 URL 生成一个脚本文件名。
 * @param {string} url
 * @returns {string}
 */
export function createFilenameForScript(url) {
    console.log(`url: ${url}`);
    const parsed = urlParse(url);
    if (INLINE_REGEXP.test(url)) {
        return parsed.hash.slice(1) + '.js';
    }
    const pathname = parsed.pathname ?? '';
    return pathname.slice(pathname.lastIndexOf('/') + 1);
}
