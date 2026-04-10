/**
 * sessions/utils.mjs — 共享工具函数与常量
 */

// ── JSON 解析工具 ────────────────────────────────────────────────────────────

export function safeParseJson(str, fallback = null) {
    if (str === null || str === undefined) return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch { return fallback ?? str; }
}

// ── 分组工具 ─────────────────────────────────────────────────────────────────

export function groupBy(arr, key) {
    const map = {};
    for (const item of arr) {
        const k = item[key];
        if (!map[k]) map[k] = [];
        map[k].push(item);
    }
    return map;
}

// ── 常见 JS 内建 / 原生方法名列表（用于 hideBuiltin 过滤）─────────────────────

export const BUILTIN_FN_NAMES = new Set([
    // String.prototype
    'charAt','charCodeAt','codePointAt','indexOf','lastIndexOf',
    'slice','substring','substr','trim','trimStart','trimEnd','trimLeft','trimRight',
    'split','replace','replaceAll','match','matchAll','search',
    'includes','startsWith','endsWith','repeat','padStart','padEnd',
    'toUpperCase','toLowerCase','toLocaleLowerCase','toLocaleUpperCase',
    'normalize','localeCompare','toString','valueOf','concat','at',
    // Array.prototype
    'push','pop','shift','unshift','splice','concat','join','reverse','sort',
    'map','filter','reduce','reduceRight','forEach','find','findIndex',
    'findLast','findLastIndex','some','every','flat','flatMap',
    'includes','indexOf','lastIndexOf','fill','copyWithin','entries','keys','values',
    'at','toString','toReversed','toSorted','toSpliced','with',
    // Math
    'floor','ceil','round','abs','max','min','pow','sqrt','log','log2','log10',
    'exp','sign','trunc','cbrt','hypot','random','sin','cos','tan',
    'asin','acos','atan','atan2','sinh','cosh','tanh','clz32','fround','imul',
    // Number / global
    'parseInt','parseFloat','isNaN','isFinite','isInteger','isSafeInteger',
    'toFixed','toPrecision','toExponential',
    // Object
    'hasOwnProperty','isPrototypeOf','propertyIsEnumerable',
    'getOwnPropertyNames','getOwnPropertyDescriptor','getPrototypeOf',
    'assign','keys','values','entries','freeze','seal','create','defineProperty',
    // JSON
    'parse','stringify',
    // Promise / async
    'then','catch','finally','resolve','reject','all','allSettled','race','any',
    // Misc
    'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
    'apply','call','bind','hasOwn','set','get','delete','has','clear',
    'add','size','entries','forEach',
]);
