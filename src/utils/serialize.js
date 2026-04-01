// JALANGI DO NOT INSTRUMENT

/**
 * @file serialize —— 将任意 JS 值序列化为人可读的单行字符串，或合法 JSON 字符串。
 *
 * 设计目标：
 *   - 无任何外部依赖，可在 Node.js 与浏览器中直接使用
 *   - 有界：字符串/容器超过阈值时截断，避免输出爆炸
 *   - 深度控制：对象/数组嵌套超过 MAX_DEPTH 层时折叠
 *   - 安全：内部 getter 抛异常时降级；循环引用用 WeakSet 显式检测
 *
 * 导出：
 *   serialize(value, depth?)    → 人可读字符串（供日志/控制台展示）
 *   serializeJson(value)        → 合法 JSON 字符串（供 trace-parse 等工具解析）
 */

export const MAX_BYTES       = 1000;
export const MAX_DEPTH       = 2;      // 对象递归深度（serialize 模式）
export const MAX_ARRAY_ITEMS = 200;    // Array 最多显示元素数（serialize 模式）
export const MAX_MAP_ITEMS   = 100;    // Map/Set 最多显示条目数

// JSON 模式专属限制
export const JSON_MAX_DEPTH       = 3;
export const JSON_MAX_ARRAY_ITEMS = 10;

// ── 防御性：从 NativeProxy 导入原生方法快照 ───────────────────────────────────
// 被分析代码可能对 Array.prototype.push / join / sort 及 Object.keys 等方法做 monkey-patch，
// 导致 serialize 内部的操作递归触发钩子，最终栈溢出。
// 所有内部操作均通过 NativeProxy 中预先捕获的原生引用进行。
import {
    $push as _push, $join as _join, $sort as _sort, $keys as _keys,
    $isArray as _isArray,
    $strSlice as _strSlice, $strReplace as _strReplace,
} from '../runtime/NativeProxy.js';

// ── 共享：plain object 判断 ───────────────────────────────────────────────────

const _ObjProto = Object.prototype;

/**
 * 判断是否是 plain object（原型为 Object.prototype 或 null）。
 * 包裹 try-catch，对任何宿主对象都安全。
 */
function _isPlainObj(v) {
    try {
        const proto = Object.getPrototypeOf(v);
        return proto === _ObjProto || proto === null;
    } catch (_e) {
        return false;
    }
}

// ── serialize（人可读模式）────────────────────────────────────────────────────

/**
 * 将任意 JS 值序列化为人可读的单行字符串。
 *
 * @param {*} v       要序列化的值
 * @param {number} [depth=0]  当前递归深度（内部递归时传入，外部调用无需传）
 * @returns {string}
 */
export function serialize(v, depth = 0) {
    const t = typeof v;
    if (v === null)        return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'function')  return `[Function ${v.name || '(anonymous)'}]`;
    if (t === 'symbol')    return v.toString();
    if (t === 'bigint')    return `${v}n`;
    if (t === 'boolean')   return v ? 'true' : 'false';
    if (t === 'number')    return String(v);
    if (t === 'string') {
        const isTruncated = v.length > MAX_BYTES;
        const q = isTruncated ? _strSlice(v, 0, MAX_BYTES) : v;
        const escaped = _strReplace(_strReplace(_strReplace(_strReplace(q, /\\/g, '\\\\'), /"/g, '\\"'), /\n/g, '\\n'), /\r/g, '\\r');
        const suffix = isTruncated ? ` (+${v.length - MAX_BYTES})` : '';
        return `"${escaped}"${suffix}`;
    }
    if (t === 'object') {
        // TypedArray / DataView — must check BEFORE the generic object path.
        // Object.keys(largeTypedArray) creates an array whose length equals the
        // TypedArray length; for lengths >= 2^32-1 that throws
        // "RangeError: Invalid array length" in V8 (Chrome) / SpiderMonkey
        // because the engine internally calls Array.push while collecting keys.
        if (ArrayBuffer.isView(v)) {
            if (v instanceof DataView) {
                return `DataView(${v.byteLength})`;
            }
            // Int8Array, Uint8Array, Float32Array, BigInt64Array, …
            const ctor = v.constructor?.name ?? 'TypedArray';
            return `${ctor}[${v.length}]`;
        }
        // ArrayBuffer — similarly unsafe to pass through Object.keys
        if (v instanceof ArrayBuffer) {
            return `ArrayBuffer(${v.byteLength})`;
        }
        // Error
        if (v instanceof Error) {
            const name = v.name || 'Error';
            const msg  = v.message ? String(v.message) : '';
            const truncatedMsg = msg.length > MAX_BYTES ? _strSlice(msg, 0, MAX_BYTES) + '…' : msg;
            return `${name}: ${truncatedMsg}`;
        }
        // Date
        if (v instanceof Date) {
            const ms = v.getTime();
            if (Number.isNaN(ms)) return 'Date(Invalid)';
            return `Date(${v.toISOString()})`;
        }
        // RegExp
        if (v instanceof RegExp) {
            return v.toString();
        }
        // Map
        if (v instanceof Map) {
            if (v.size === 0) return 'Map(0)';
            const entries = [];
            let i = 0;
            let total = 5; // "Map(" length
            for (const [key, val] of v) {
                if (i >= MAX_MAP_ITEMS) {
                    _push(entries, `…(+${v.size - MAX_MAP_ITEMS})`);
                    break;
                }
                const kStr = serialize(key, depth + 1);
                const vStr = serialize(val, depth + 1);
                const entry = `${kStr}=>${vStr}`;
                total += entry.length + 1;
                if (total > MAX_BYTES) {
                    _push(entries, `…(+${v.size - i})`);
                    break;
                }
                _push(entries, entry);
                i++;
            }
            return `Map(${_join(entries, ',')})`;
        }
        // Set
        if (v instanceof Set) {
            if (v.size === 0) return 'Set(0)';
            const items = [];
            let i = 0;
            let total = 4; // "Set(" length
            for (const item of v) {
                if (i >= MAX_MAP_ITEMS) {
                    _push(items, `…(+${v.size - MAX_MAP_ITEMS})`);
                    break;
                }
                const itemStr = serialize(item, depth + 1);
                total += itemStr.length + 1;
                if (total > MAX_BYTES) {
                    _push(items, `…(+${v.size - i})`);
                    break;
                }
                _push(items, itemStr);
                i++;
            }
            return `Set(${_join(items, ',')})`;
        }
        // Promise
        if (v instanceof Promise) {
            return `Promise(<${v.then ? 'pending' : 'resolved'}>)`;
        }
        // Array
        if (Array.isArray(v)) {
            if (v.length === 0) return '[]';
            const items = [];
            let total = 2; // "[]" length
            for (let i = 0; i < v.length; i++) {
                if (i >= MAX_ARRAY_ITEMS) {
                    _push(items, `…(+${v.length - MAX_ARRAY_ITEMS})`);
                    break;
                }
                const itemStr = depth >= MAX_DEPTH ? '…' : serialize(v[i], depth + 1);
                total += itemStr.length + 1;
                if (total > MAX_BYTES) {
                    _push(items, `…(+${v.length - i})`);
                    break;
                }
                _push(items, itemStr);
            }
            return `[${_join(items, ',')}]`;
        }
        // Plain Object（含宿主对象兜底）
        try {
            const keys = _keys(v);
            if (keys.length === 0) return '{}';
            // 排序 keys 保证输出一致性
            _sort(keys);
            const parts = [];
            let total = 2; // "{}" length
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (total >= MAX_BYTES) { _push(parts, '…'); break; }
                let vStr;
                const vv = v[k];
                const vt = typeof vv;
                if (vv === null)             vStr = 'null';
                else if (vt === 'undefined') vStr = 'undefined';
                else if (vt === 'function')  vStr = '[Function]';
                else if (vt === 'object')    vStr = depth >= MAX_DEPTH ? '{…}' : serialize(vv, depth + 1);
                else if (vt === 'string')    vStr = serialize(vv, depth + 1);
                else if (vt === 'symbol')    vStr = vv.toString();
                else if (vt === 'bigint')    vStr = `${vv}n`;
                else                         vStr = String(vv);
                const entry = `${k}:${vStr}`;
                total += entry.length + 1;
                _push(parts, entry);
            }
            const s = `{${_join(parts, ',')}}`;
            if (s.length > MAX_BYTES) return _strSlice(s, 0, MAX_BYTES) + '…';
            return s;
        } catch {
            return Object.prototype.toString.call(v);
        }
    }
    return String(v);
}

// ── serializeJson（合法 JSON 模式）───────────────────────────────────────────

/**
 * 将任意 JS 值安全序列化为合法 JSON 字符串。
 *
 * 与 serialize() 的区别：
 *   - 输出是合法 JSON（可直接 JSON.parse 还原）
 *   - 不依赖 JSON.stringify 的属性自动枚举，避免宿主对象 getter 的 Illegal invocation
 *   - 用 WeakSet 显式检测循环引用
 *   - 非 plain object（DOM 元素、宿主对象等）降级为 serialize() 结果的 JSON 字符串字面量
 *
 * @param {*} v   要序列化的值
 * @returns {string}  合法 JSON 字符串
 */
export function serializeJson(v) {
    return _serializeJsonCore(v, new WeakSet(), 0);
}

/**
 * serializeJson 内部递归实现。
 * @param {*}        v     当前值
 * @param {WeakSet}  seen  已访问对象集合（循环引用检测）
 * @param {number}   depth 当前递归深度
 * @returns {string}  JSON 片段字符串（不含外层包装，可直接拼接）
 */
function _serializeJsonCore(v, seen, depth) {
    // ── 基础类型 ──────────────────────────────────────────────────────────────
    if (v === null)      return 'null';
    if (v === undefined) return 'null'; // JSON.stringify 省略 undefined 值，顶层统一降级为 null
    const t = typeof v;
    if (t === 'boolean')  return v ? 'true' : 'false';
    if (t === 'number')   return isFinite(v) ? String(v) : '"' + String(v) + '"';
    if (t === 'bigint')   return '"' + String(v) + 'n"';
    if (t === 'symbol')   return '"' + v.toString() + '"';
    if (t === 'function') return '"[Function ' + (v.name || 'anonymous') + ']"';
    if (t === 'string') {
        // 截断后用 JSON.stringify 处理转义（仅对字符串调用，安全）
        const s = v.length > MAX_BYTES ? _strSlice(v, 0, MAX_BYTES) + '…' : v;
        return JSON.stringify(s);
    }

    // ── object ────────────────────────────────────────────────────────────────
    if (t === 'object') {
        // 循环引用
        if (seen.has(v)) return '"[Circular]"';

        // 深度超限 → 委托 serialize() 折叠，再包成 JSON 字符串字面量
        if (depth >= JSON_MAX_DEPTH) {
            return _fallbackToSerialize(v);
        }

        // 数组（_isArray 不访问 getter，安全）
        if (_isArray(v)) {
            if (v.length > JSON_MAX_ARRAY_ITEMS) {
                return '"[...' + v.length + ' items]"';
            }
            seen.add(v);
            const parts = [];
            for (let i = 0; i < v.length; i++) {
                let item;
                try { item = v[i]; } catch (_e) { item = undefined; }
                _push(parts, _serializeJsonCore(item, seen, depth + 1));
            }
            seen.delete(v);
            return '[' + _join(parts, ',') + ']';
        }

        // 只对 plain object 手动枚举属性（每次属性读取单独 try-catch）；
        // 非 plain object（宿主对象、Date、RegExp、DOM 元素等）不枚举，
        // 直接降级为 serialize() 字符串，避免任何 getter 副作用。
        if (!_isPlainObj(v)) {
            return _fallbackToSerialize(v);
        }

        // plain object：手动枚举，每次属性读取独立 try-catch
        seen.add(v);
        let keys;
        try { keys = _keys(v); } catch (_e) { seen.delete(v); return '"[Object]"'; }

        const parts = [];
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            let val;
            try { val = v[k]; } catch (_e) { val = '[getter error]'; }
            // 与 JSON.stringify 行为一致：跳过值为 undefined 的属性（不输出该 key）
            if (val === undefined) continue;
            const ks = JSON.stringify(String(k));
            _push(parts, ks + ':' + _serializeJsonCore(val, seen, depth + 1));
        }
        seen.delete(v);
        return '{' + _join(parts, ',') + '}';
    }

    // fallback（理论上不会到达）
    return JSON.stringify(String(v));
}

/**
 * 将值委托给 serialize() 得到人可读字符串，
 * 再用 JSON.stringify 包成合法 JSON 字符串字面量。
 * 整个过程包裹 try-catch，不会抛出。
 */
function _fallbackToSerialize(v) {
    try {
        return JSON.stringify(serialize(v));
    } catch (_e) {
        return '"[Object]"';
    }
}
