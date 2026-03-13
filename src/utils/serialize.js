// JALANGI DO NOT INSTRUMENT

/**
 * @file serialize —— 将任意 JS 值序列化为人可读的单行字符串。
 *
 * 设计目标：
 *   - 无任何外部依赖，可在 Node.js 与浏览器中直接使用
 *   - 有界：字符串/容器超过阈值时截断，避免输出爆炸
 *   - 深度控制：对象/数组嵌套超过 MAX_DEPTH 层时折叠为 …
 *   - 安全：内部 getter 抛异常时降级为 Object.prototype.toString
 *
 * 导出：
 *   serialize(value, depth?)  → string
 */

export const MAX_BYTES       = 1000;
export const MAX_DEPTH       = 2;      // 对象递归深度
export const MAX_ARRAY_ITEMS = 200;    // Array 最多显示元素数
export const MAX_MAP_ITEMS   = 100;    // Map/Set 最多显示条目数

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
        const q = isTruncated ? v.slice(0, MAX_BYTES) : v;
        const escaped = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
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
            const truncatedMsg = msg.length > MAX_BYTES ? msg.slice(0, MAX_BYTES) + '…' : msg;
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
                    entries.push(`…(+${v.size - MAX_MAP_ITEMS})`);
                    break;
                }
                const kStr = serialize(key, depth + 1);
                const vStr = serialize(val, depth + 1);
                const entry = `${kStr}=>${vStr}`;
                total += entry.length + 1;
                if (total > MAX_BYTES) {
                    entries.push(`…(+${v.size - i})`);
                    break;
                }
                entries.push(entry);
                i++;
            }
            return `Map(${entries.join(',')})`;
        }
        // Set
        if (v instanceof Set) {
            if (v.size === 0) return 'Set(0)';
            const items = [];
            let i = 0;
            let total = 4; // "Set(" length
            for (const item of v) {
                if (i >= MAX_MAP_ITEMS) {
                    items.push(`…(+${v.size - MAX_MAP_ITEMS})`);
                    break;
                }
                const itemStr = serialize(item, depth + 1);
                total += itemStr.length + 1;
                if (total > MAX_BYTES) {
                    items.push(`…(+${v.size - i})`);
                    break;
                }
                items.push(itemStr);
                i++;
            }
            return `Set(${items.join(',')})`;
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
                    items.push(`…(+${v.length - MAX_ARRAY_ITEMS})`);
                    break;
                }
                const itemStr = depth >= MAX_DEPTH ? '…' : serialize(v[i], depth + 1);
                total += itemStr.length + 1;
                if (total > MAX_BYTES) {
                    items.push(`…(+${v.length - i})`);
                    break;
                }
                items.push(itemStr);
            }
            return `[${items.join(',')}]`;
        }
        // Plain Object
        try {
            const keys = Object.keys(v);
            if (keys.length === 0) return '{}';
            // 排序 keys 保证输出一致性
            keys.sort();
            const parts = [];
            let total = 2; // "{}" length
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (total >= MAX_BYTES) { parts.push('…'); break; }
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
                parts.push(entry);
            }
            const s = `{${parts.join(',')}}`;
            if (s.length > MAX_BYTES) return s.slice(0, MAX_BYTES) + '…';
            return s;
        } catch {
            return Object.prototype.toString.call(v);
        }
    }
    return String(v);
}
