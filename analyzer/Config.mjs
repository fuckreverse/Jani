/**
 * Config.mjs — JTA 统一配置门面
 *
 * 用法：
 *   import { cfg } from './Config.mjs';
 *   const timeout = cfg('runner.timeoutMs');          // 读单个键
 *   const { port } = cfg('server');                   // 读子对象
 *   const all = cfg();                                // 读全量配置
 *
 * 加载优先级（高到低）：
 *   1. 环境变量  JTA_<UPPER_SNAKE_KEY>  （如 JTA_SERVER_PORT=8080）
 *   2. 用户配置文件  analyzer/config.json  （不存在则跳过）
 *   3. 默认配置文件  analyzer/config.default.json  （始终存在）
 *
 * 环境变量映射规则：
 *   键路径 "server.port"  →  JTA_SERVER_PORT
 *   键路径 "plugins.A1_TaintTracker.maxHops"  →  JTA_PLUGINS_A1_TAINTTRACKER_MAXHOPS
 *   所有点号替换为 _，再全部大写，前缀 JTA_
 *
 * 热重载：
 *   调用 reload() 可重新从磁盘读取 config.json（不影响已持有引用的调用方，
 *   调用方下次调用 cfg() 时取到新值）。
 *
 * 扩展点（未来 UI 配置面板）：
 *   目前配置从文件读取。后续可在此模块中替换为从数据库 / HTTP API 读取，
 *   调用方代码无需改动。
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CFG_PATH = resolve(__dirname, 'config.default.json');
const USER_CFG_PATH    = resolve(__dirname, 'config.json');

// ── 深度合并：将 src 的属性覆盖到 dst，返回新对象 ─────────────────────────
function deepMerge(dst, src) {
    if (src === null || typeof src !== 'object') return src;
    const result = { ...dst };
    for (const key of Object.keys(src)) {
        if (
            typeof src[key] === 'object' && src[key] !== null &&
            !Array.isArray(src[key]) &&
            typeof dst[key] === 'object' && dst[key] !== null
        ) {
            result[key] = deepMerge(dst[key], src[key]);
        } else {
            result[key] = src[key];
        }
    }
    return result;
}

// ── 按点路径取嵌套值 ────────────────────────────────────────────────────────
function getByPath(obj, path) {
    if (!path) return obj;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur === undefined || cur === null) return undefined;
        cur = cur[p];
    }
    return cur;
}

// ── 按点路径设嵌套值（深拷贝保护原对象）──────────────────────────────────────
function setByPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === undefined || typeof cur[parts[i]] !== 'object') {
            cur[parts[i]] = {};
        }
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

// ── 将点路径键转换为环境变量名 ─────────────────────────────────────────────
// "server.port" → "JTA_SERVER_PORT"
// "plugins.A1_TaintTracker.maxHops" → "JTA_PLUGINS_A1_TAINTTRACKER_MAXHOPS"
function pathToEnvKey(path) {
    return 'JTA_' + path.replace(/\./g, '_').toUpperCase();
}

// ── 递归收集所有叶节点路径 ───────────────────────────────────────────────────
function collectLeafPaths(obj, prefix = '') {
    const paths = [];
    for (const key of Object.keys(obj)) {
        if (key.startsWith('_')) continue; // 跳过注释字段
        const fullPath = prefix ? `${prefix}.${key}` : key;
        const val = obj[key];
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            paths.push(...collectLeafPaths(val, fullPath));
        } else {
            paths.push(fullPath);
        }
    }
    return paths;
}

// ── 自动类型转换（环境变量全是字符串，需还原为原始类型）──────────────────────
function coerce(envVal, originalVal) {
    if (typeof originalVal === 'number') {
        const n = Number(envVal);
        return isNaN(n) ? originalVal : n;
    }
    if (typeof originalVal === 'boolean') {
        return envVal === 'true' || envVal === '1';
    }
    return envVal; // string
}

// ── 核心状态 ─────────────────────────────────────────────────────────────────

let _config = null;

function _load() {
    // 1. 读默认配置
    let merged = JSON.parse(readFileSync(DEFAULT_CFG_PATH, 'utf8'));

    // 2. 用户配置文件（可选）
    if (existsSync(USER_CFG_PATH)) {
        try {
            const user = JSON.parse(readFileSync(USER_CFG_PATH, 'utf8'));
            merged = deepMerge(merged, user);
        } catch (e) {
            console.warn(`[Config] 无法解析 config.json，跳过：${e.message}`);
        }
    }

    // 3. 环境变量覆盖（所有叶节点路径）
    const leafPaths = collectLeafPaths(merged);
    for (const path of leafPaths) {
        const envKey = pathToEnvKey(path);
        const envVal = process.env[envKey];
        if (envVal !== undefined) {
            const original = getByPath(merged, path);
            setByPath(merged, path, coerce(envVal, original));
        }
    }

    return merged;
}

function _ensureLoaded() {
    if (!_config) _config = _load();
}

// ── 公共 API ────────────────────────────────────────────────────────────────

/**
 * 读取配置值。
 *
 * @param {string} [path]  点分隔路径，如 "runner.timeoutMs"；不传则返回全量配置对象。
 * @returns {*}  对应的配置值；路径不存在时返回 undefined。
 *
 * @example
 * cfg('runner.timeoutMs')         // → 30000
 * cfg('plugins.A1_TaintTracker')  // → { maxHops: 10, maxNodes: 500 }
 * cfg()                           // → { server: {...}, runner: {...}, ... }
 */
export function cfg(path) {
    _ensureLoaded();
    return getByPath(_config, path);
}

/**
 * 重新从磁盘加载配置（适用于 config.json 被外部修改后的热重载）。
 */
export function reload() {
    _config = _load();
}

/**
 * 返回当前完整配置的深拷贝（安全，防止调用方意外修改内部状态）。
 */
export function snapshot() {
    _ensureLoaded();
    return JSON.parse(JSON.stringify(_config));
}

/**
 * 返回配置文件路径信息（调试用）。
 */
export function configPaths() {
    return {
        default: DEFAULT_CFG_PATH,
        user: USER_CFG_PATH,
        userExists: existsSync(USER_CFG_PATH),
    };
}
