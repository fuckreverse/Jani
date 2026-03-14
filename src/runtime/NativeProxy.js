// JALANGI DO NOT INSTRUMENT

/**
 * @file NativeProxy —— 运行时原生方法快照。
 *
 * ## 背景
 * 被分析代码可能对内置方法做 monkey-patch（或利用 anti-analysis 技术将
 * Array.prototype.push 替换为 Array.prototype.push 的插桩版本），
 * 导致运行时内部（JalangiRuntime / HookDispatcher / ExecutionTrace 等）
 * 调用这些方法时触发钩子，形成无限递归，最终栈溢出。
 *
 * ## 解决方案
 * 在模块加载时（最早时机，分析代码尚未运行）捕获所有原生方法的引用，
 * 运行时内部**所有**的内置方法调用都通过此文件导出的快照进行，
 * 彻底绕过用户代码对原型链的任何修改。
 *
 * ## 使用方式
 * ```js
 * import * as N from './NativeProxy.js';
 * // 替代 arr.push(x)  → N.$push(arr, x)
 * // 替代 fn.apply(t, a) → N.$apply(fn, t, a)
 * // 替代 Object.keys(o) → N.$keys(o)
 * ```
 *
 * @module NativeProxy
 */

// ── Function ──────────────────────────────────────────────────────────────────
const _apply  = Function.prototype.apply;
const _call   = Function.prototype.call;
const _bind   = Function.prototype.bind;

/** fn.apply(thisArg, argsArray) */
export const $apply  = (fn, thisArg, args)         => _apply.call(fn, thisArg, args);
/** fn.call(thisArg, ...args) */
export const $call   = (fn, thisArg, ...args)       => _call.apply(fn, [thisArg, ...args]);
/** fn.bind(thisArg, ...args) */
export const $bind   = (fn, thisArg, ...args)       => _apply.call(_bind, fn, [thisArg, ...args]);

// ── Array.prototype ───────────────────────────────────────────────────────────
const _arrPush    = Array.prototype.push;
const _arrPop     = Array.prototype.pop;
const _arrShift   = Array.prototype.shift;
const _arrUnshift = Array.prototype.unshift;
const _arrSlice   = Array.prototype.slice;
const _arrSplice  = Array.prototype.splice;
const _arrMap     = Array.prototype.map;
const _arrFilter  = Array.prototype.filter;
const _arrJoin    = Array.prototype.join;
const _arrForEach = Array.prototype.forEach;
const _arrIndexOf = Array.prototype.indexOf;
const _arrIncludes = Array.prototype.includes;
const _arrFind    = Array.prototype.find;
const _arrFindIndex = Array.prototype.findIndex;
const _arrSome    = Array.prototype.some;
const _arrEvery   = Array.prototype.every;
const _arrReduce  = Array.prototype.reduce;
const _arrSort    = Array.prototype.sort;
const _arrConcat  = Array.prototype.concat;
const _arrFlat    = Array.prototype.flat;
const _arrReverse = Array.prototype.reverse;
const _arrFill    = Array.prototype.fill;
const _arrFrom    = Array.from;
const _arrIsArray = Array.isArray;

export const $push     = (arr, ...items)        => _apply.call(_arrPush,    arr, items);
export const $pop      = (arr)                  => _call.call(_arrPop,     arr);
export const $shift    = (arr)                  => _call.call(_arrShift,   arr);
export const $unshift  = (arr, ...items)        => _apply.call(_arrUnshift, arr, items);
export const $slice    = (arr, start, end)      => _call.call(_arrSlice,   arr, start, end);
export const $splice   = (arr, start, del, ...items) => _apply.call(_arrSplice, arr, [start, del, ...items]);
export const $map      = (arr, fn, thisArg)     => _call.call(_arrMap,     arr, fn, thisArg);
export const $filter   = (arr, fn, thisArg)     => _call.call(_arrFilter,  arr, fn, thisArg);
export const $join     = (arr, sep)             => _call.call(_arrJoin,    arr, sep);
export const $forEach  = (arr, fn, thisArg)     => _call.call(_arrForEach, arr, fn, thisArg);
export const $indexOf  = (arr, val, fromIndex)  => _call.call(_arrIndexOf, arr, val, fromIndex);
export const $includes = (arr, val, fromIndex)  => _call.call(_arrIncludes, arr, val, fromIndex);
export const $find     = (arr, fn, thisArg)     => _call.call(_arrFind,    arr, fn, thisArg);
export const $findIndex = (arr, fn, thisArg)    => _call.call(_arrFindIndex, arr, fn, thisArg);
export const $some     = (arr, fn, thisArg)     => _call.call(_arrSome,    arr, fn, thisArg);
export const $every    = (arr, fn, thisArg)     => _call.call(_arrEvery,   arr, fn, thisArg);
export const $reduce   = (arr, fn, init)        => _call.call(_arrReduce,  arr, fn, init);
export const $sort     = (arr, fn)              => _call.call(_arrSort,    arr, fn);
export const $concat   = (arr, ...rest)         => _apply.call(_arrConcat,  arr, rest);
export const $flat     = (arr, depth)           => _call.call(_arrFlat,    arr, depth);
export const $reverse  = (arr)                  => _call.call(_arrReverse, arr);
export const $fill     = (arr, val, start, end) => _call.call(_arrFill,    arr, val, start, end);
export const $from     = (iterable, mapFn)      => _arrFrom(iterable, mapFn);
export const $isArray  = (val)                  => _arrIsArray(val);

// ── Object ────────────────────────────────────────────────────────────────────
const _objKeys                = Object.keys;
const _objValues              = Object.values;
const _objEntries             = Object.entries;
const _objAssign              = Object.assign;
const _objCreate              = Object.create;
const _objFreeze              = Object.freeze;
const _objDefineProperty      = Object.defineProperty;
const _objGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _objGetOwnPropertyNames = Object.getOwnPropertyNames;
const _objGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const _objGetPrototypeOf      = Object.getPrototypeOf;
const _objSetPrototypeOf      = Object.setPrototypeOf;
const _objHasOwn              = Object.hasOwn ?? ((obj, key) => _apply.call(_objHasOwnProp, obj, [key]));
const _objHasOwnProp          = Object.prototype.hasOwnProperty;
const _objToString            = Object.prototype.toString;

export const $keys        = (obj)                          => _objKeys(obj);
export const $values      = (obj)                          => _objValues(obj);
export const $entries     = (obj)                          => _objEntries(obj);
export const $assign      = (target, ...sources)           => _apply.call(_objAssign, Object, [target, ...sources]);
export const $create      = (proto, props)                 => _objCreate(proto, props);
export const $freeze      = (obj)                          => _objFreeze(obj);
export const $defineProperty = (obj, key, desc)            => _objDefineProperty(obj, key, desc);
export const $getOwnPropertyDescriptor = (obj, key)        => _objGetOwnPropertyDescriptor(obj, key);
export const $getOwnPropertyNames = (obj)                  => _objGetOwnPropertyNames(obj);
export const $getOwnPropertySymbols = (obj)                => _objGetOwnPropertySymbols(obj);
export const $getPrototypeOf = (obj)                       => _objGetPrototypeOf(obj);
export const $setPrototypeOf = (obj, proto)                => _objSetPrototypeOf(obj, proto);
export const $hasOwn      = (obj, key)                     => _apply.call(_objHasOwnProp, obj, [key]);
export const $toString    = (obj)                          => _call.call(_objToString, obj);

// ── WeakMap ───────────────────────────────────────────────────────────────────
const _wmHas = WeakMap.prototype.has;
const _wmGet = WeakMap.prototype.get;
const _wmSet = WeakMap.prototype.set;
const _wmDel = WeakMap.prototype.delete;

export const $wmHas = (wm, key)       => _call.call(_wmHas, wm, key);
export const $wmGet = (wm, key)       => _call.call(_wmGet, wm, key);
export const $wmSet = (wm, key, val)  => _call.call(_wmSet, wm, key, val);
export const $wmDel = (wm, key)       => _call.call(_wmDel, wm, key);

// ── Map ───────────────────────────────────────────────────────────────────────
const _mapHas     = Map.prototype.has;
const _mapGet     = Map.prototype.get;
const _mapSet     = Map.prototype.set;
const _mapDel     = Map.prototype.delete;
const _mapKeys    = Map.prototype.keys;
const _mapValues  = Map.prototype.values;
const _mapEntries = Map.prototype.entries;
const _mapForEach = Map.prototype.forEach;
const _mapSize    = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;

export const $mapHas     = (m, key)         => _call.call(_mapHas,     m, key);
export const $mapGet     = (m, key)         => _call.call(_mapGet,     m, key);
export const $mapSet     = (m, key, val)    => _call.call(_mapSet,     m, key, val);
export const $mapDel     = (m, key)         => _call.call(_mapDel,     m, key);
export const $mapKeys    = (m)              => _call.call(_mapKeys,    m);
export const $mapValues  = (m)              => _call.call(_mapValues,  m);
export const $mapEntries = (m)              => _call.call(_mapEntries, m);
export const $mapForEach = (m, fn)          => _call.call(_mapForEach, m, fn);
export const $mapSize    = (m)              => _call.call(_mapSize,    m);

// ── Set ───────────────────────────────────────────────────────────────────────
const _setHas  = Set.prototype.has;
const _setAdd  = Set.prototype.add;
const _setDel  = Set.prototype.delete;
const _setKeys = Set.prototype.keys;
const _setForEach = Set.prototype.forEach;
const _setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;

export const $setHas  = (s, val)   => _call.call(_setHas,     s, val);
export const $setAdd  = (s, val)   => _call.call(_setAdd,     s, val);
export const $setDel  = (s, val)   => _call.call(_setDel,     s, val);
export const $setKeys = (s)        => _call.call(_setKeys,    s);
export const $setForEach = (s, fn) => _call.call(_setForEach, s, fn);
export const $setSize = (s)        => _call.call(_setSize,    s);

// ── WeakSet ───────────────────────────────────────────────────────────────────
const _wsHas = WeakSet.prototype.has;
const _wsAdd = WeakSet.prototype.add;
const _wsDel = WeakSet.prototype.delete;

export const $wsHas = (ws, val) => _call.call(_wsHas, ws, val);
export const $wsAdd = (ws, val) => _call.call(_wsAdd, ws, val);
export const $wsDel = (ws, val) => _call.call(_wsDel, ws, val);

// ── WeakRef ───────────────────────────────────────────────────────────────────
const _wrDeref = typeof WeakRef !== 'undefined' ? WeakRef.prototype.deref : null;
export const $wrDeref = (wr) => _wrDeref ? _call.call(_wrDeref, wr) : wr?.deref?.();

// ── String ────────────────────────────────────────────────────────────────────
const _strSlice    = String.prototype.slice;
const _strIncludes = String.prototype.includes;
const _strIndexOf  = String.prototype.indexOf;
const _strSplit    = String.prototype.split;
const _strTrim     = String.prototype.trim;
const _strMatch    = String.prototype.match;
const _strReplace  = String.prototype.replace;
const _strStartsWith = String.prototype.startsWith;
const _strEndsWith   = String.prototype.endsWith;

export const $strSlice    = (s, start, end)    => _call.call(_strSlice,    s, start, end);
export const $strIncludes = (s, search, pos)   => _call.call(_strIncludes, s, search, pos);
export const $strIndexOf  = (s, search, pos)   => _call.call(_strIndexOf,  s, search, pos);
export const $strSplit    = (s, sep, limit)    => _call.call(_strSplit,    s, sep, limit);
export const $strTrim     = (s)                => _call.call(_strTrim,     s);
export const $strMatch    = (s, re)            => _call.call(_strMatch,    s, re);
export const $strReplace  = (s, search, rep)   => _call.call(_strReplace,  s, search, rep);
export const $strStartsWith = (s, search, pos) => _call.call(_strStartsWith, s, search, pos);
export const $strEndsWith   = (s, search, len) => _call.call(_strEndsWith,   s, search, len);

// ── Number / Math ─────────────────────────────────────────────────────────────
export const $numberIsFinite  = Number.isFinite;
export const $numberIsInteger = Number.isInteger;
export const $numberIsNaN     = Number.isNaN;
export const $mathMax         = Math.max;
export const $mathMin         = Math.min;
export const $mathFloor       = Math.floor;
export const $mathCeil        = Math.ceil;
export const $mathAbs         = Math.abs;

// ── JSON ──────────────────────────────────────────────────────────────────────
export const $jsonStringify = JSON.stringify;
export const $jsonParse     = JSON.parse;

// ── Symbol ────────────────────────────────────────────────────────────────────
export const $symbolIterator = Symbol.iterator;
export const $symbolFor      = Symbol.for;

// ── Reflect ───────────────────────────────────────────────────────────────────
export const $reflectApply       = typeof Reflect !== 'undefined' ? Reflect.apply  : null;
export const $reflectConstruct   = typeof Reflect !== 'undefined' ? Reflect.construct : null;
export const $reflectOwnKeys     = typeof Reflect !== 'undefined' ? Reflect.ownKeys  : null;
export const $reflectHas         = typeof Reflect !== 'undefined' ? Reflect.has      : null;
export const $reflectGet         = typeof Reflect !== 'undefined' ? Reflect.get      : null;
export const $reflectSet         = typeof Reflect !== 'undefined' ? Reflect.set      : null;
export const $reflectDefineProperty = typeof Reflect !== 'undefined' ? Reflect.defineProperty : null;

// ── Promise ───────────────────────────────────────────────────────────────────
export const $promiseResolve = Promise.resolve.bind(Promise);
export const $promiseReject  = Promise.reject.bind(Promise);
export const $promiseAll     = Promise.all.bind(Promise);
