/**
 * test/unit/native-proxy.test.mjs — NativeProxy 原生方法快照单元测试
 *
 * 验证所有导出的原生方法快照的正确性,确保即使用户代码修改了原型链,
 * 运行时内部仍能安全调用原生方法。
 *
 * 测试策略:
 *  1. monkey-patch 防护测试:先修改原型链,再调用快照方法,确保结果不受影响
 *  2. 覆盖范围测试:验证所有主要原生方法均有快照导出
 *  3. 边界条件测试:null/undefined/空数组/空对象等边界输入
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as N from '../../src/runtime/NativeProxy.js';

// ════════════════════════════════════════════════════════════════════════════════
// Array 方法快照
// ════════════════════════════════════════════════════════════════════════════════

describe('Array 方法快照', () => {
    test('$push — 数组 push 快照', () => {
        const arr = [1, 2];
        N.$push(arr, 3);
        assert.deepEqual(arr, [1, 2, 3]);
    });

    test('$push — monkey-patch 防护', () => {
        const arr = [1];
        // 污染原型链
        const orig = Array.prototype.push;
        Array.prototype.push = function() { throw new Error('patched!'); };
        try {
            // 快照方法应不受影响
            N.$push(arr, 2);
            assert.deepEqual(arr, [1, 2], '快照 push 应正常工作');
        } finally {
            Array.prototype.push = orig; // 恢复
        }
    });

    test('$pop — 数组 pop 快照', () => {
        const arr = [1, 2, 3];
        const val = N.$pop(arr);
        assert.equal(val, 3);
        assert.deepEqual(arr, [1, 2]);
    });

    test('$slice — 数组 slice 快照', () => {
        const arr = [1, 2, 3, 4];
        const sub = N.$slice(arr, 1, 3);
        assert.deepEqual(sub, [2, 3]);
    });

    test('$map — 数组 map 快照', () => {
        const arr = [1, 2, 3];
        const doubled = N.$map(arr, x => x * 2);
        assert.deepEqual(doubled, [2, 4, 6]);
    });

    test('$filter — 数组 filter 快照', () => {
        const arr = [1, 2, 3, 4];
        const even = N.$filter(arr, x => x % 2 === 0);
        assert.deepEqual(even, [2, 4]);
    });

    test('$join — 数组 join 快照', () => {
        const arr = ['a', 'b', 'c'];
        const str = N.$join(arr, '-');
        assert.equal(str, 'a-b-c');
    });

    test('$splice — 数组 splice 快照', () => {
        const arr = [1, 2, 3, 4];
        const removed = N.$splice(arr, 1, 2, 'a', 'b');
        assert.deepEqual(removed, [2, 3]);
        assert.deepEqual(arr, [1, 'a', 'b', 4]);
    });

    test('$isArray — 类型判断快照', () => {
        assert.ok(N.$isArray([1, 2]));
        assert.ok(!N.$isArray({ 0: 1, length: 1 }));
        assert.ok(!N.$isArray('string'));
    });

    test('$from — Array.from 快照', () => {
        const arr = N.$from('abc');
        assert.deepEqual(arr, ['a', 'b', 'c']);
    });

    test('$reduce — 数组 reduce 快照', () => {
        const arr = [1, 2, 3, 4];
        const sum = N.$reduce(arr, (acc, x) => acc + x, 0);
        assert.equal(sum, 10);
    });

    test('$indexOf — 数组 indexOf 快照', () => {
        const arr = ['a', 'b', 'c', 'b'];
        assert.equal(N.$indexOf(arr, 'b'), 1);
        assert.equal(N.$indexOf(arr, 'b', 2), 3);
        assert.equal(N.$indexOf(arr, 'x'), -1);
    });

    test('$includes — 数组 includes 快照', () => {
        const arr = [1, 2, 3];
        assert.ok(N.$includes(arr, 2));
        assert.ok(!N.$includes(arr, 4));
    });

    test('$concat — 数组 concat 快照', () => {
        const arr1 = [1, 2];
        const arr2 = [3, 4];
        const merged = N.$concat(arr1, arr2, [5]);
        assert.deepEqual(merged, [1, 2, 3, 4, 5]);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Object 方法快照
// ════════════════════════════════════════════════════════════════════════════════

describe('Object 方法快照', () => {
    test('$keys — Object.keys 快照', () => {
        const obj = { a: 1, b: 2, c: 3 };
        const keys = N.$keys(obj);
        assert.deepEqual(keys.sort(), ['a', 'b', 'c']);
    });

    test('$keys — monkey-patch 防护', () => {
        const orig = Object.keys;
        Object.keys = function() { throw new Error('patched!'); };
        try {
            const keys = N.$keys({ x: 1 });
            assert.deepEqual(keys, ['x']);
        } finally {
            Object.keys = orig;
        }
    });

    test('$values — Object.values 快照', () => {
        const obj = { a: 1, b: 2 };
        const vals = N.$values(obj);
        assert.deepEqual(vals.sort(), [1, 2]);
    });

    test('$entries — Object.entries 快照', () => {
        const obj = { a: 1, b: 2 };
        const entries = N.$entries(obj);
        assert.deepEqual(entries.length, 2);
        assert.ok(entries.some(e => e[0] === 'a' && e[1] === 1));
        assert.ok(entries.some(e => e[0] === 'b' && e[1] === 2));
    });

    test('$assign — Object.assign 快照', () => {
        const target = { a: 1 };
        const result = N.$assign(target, { b: 2 }, { c: 3 });
        assert.deepEqual(result, { a: 1, b: 2, c: 3 });
        assert.equal(result, target, '应返回 target 引用');
    });

    test('$create — Object.create 快照', () => {
        const proto = { x: 10 };
        const obj = N.$create(proto);
        assert.equal(N.$getPrototypeOf(obj), proto);
        assert.equal(obj.x, 10, '应继承原型属性');
    });

    test('$freeze — Object.freeze 快照', () => {
        const obj = { x: 1 };
        N.$freeze(obj);
        // ESM 严格模式下修改冻结对象会抗出 TypeError
        assert.throws(() => { obj.x = 2; }, TypeError, '冻结对象应不可修改');
    });

    test('$hasOwn — Object.hasOwn 快照', () => {
        const obj = { a: 1 };
        assert.ok(N.$hasOwn(obj, 'a'));
        assert.ok(!N.$hasOwn(obj, 'toString'), 'toString 是继承属性');
    });

    test('$getOwnPropertyNames — 获取自有属性名', () => {
        const obj = { a: 1, b: 2 };
        const names = N.$getOwnPropertyNames(obj);
        assert.deepEqual(names.sort(), ['a', 'b']);
    });

    test('$defineProperty — 定义属性描述符', () => {
        const obj = {};
        N.$defineProperty(obj, 'x', { value: 42, writable: false });
        assert.equal(obj.x, 42);
        // ESM 严格模式下修改不可写属性会抛出 TypeError
        assert.throws(() => { obj.x = 100; }, TypeError, '不可写属性应报 TypeError');
    });

    test('$getOwnPropertyDescriptor — 获取属性描述符', () => {
        const obj = {};
        N.$defineProperty(obj, 'x', { value: 10, writable: true, enumerable: false });
        const desc = N.$getOwnPropertyDescriptor(obj, 'x');
        assert.equal(desc.value, 10);
        assert.ok(!desc.enumerable);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// String 方法快照
// ════════════════════════════════════════════════════════════════════════════════

describe('String 方法快照', () => {
    test('$strSlice — 字符串 slice 快照', () => {
        const s = 'hello world';
        assert.equal(N.$strSlice(s, 0, 5), 'hello');
        assert.equal(N.$strSlice(s, 6), 'world');
    });

    test('$strSplit — 字符串 split 快照', () => {
        const s = 'a,b,c';
        const arr = N.$strSplit(s, ',');
        assert.deepEqual(arr, ['a', 'b', 'c']);
    });

    test('$strSplit — monkey-patch 防护', () => {
        const orig = String.prototype.split;
        String.prototype.split = function() { throw new Error('patched!'); };
        try {
            const arr = N.$strSplit('x-y', '-');
            assert.deepEqual(arr, ['x', 'y']);
        } finally {
            String.prototype.split = orig;
        }
    });

    test('$strTrim — 字符串 trim 快照', () => {
        const s = '  hello  ';
        assert.equal(N.$strTrim(s), 'hello');
    });

    test('$strReplace — 字符串 replace 快照', () => {
        const s = 'hello world';
        assert.equal(N.$strReplace(s, 'world', 'jalangi'), 'hello jalangi');
    });

    test('$strIncludes — 字符串 includes 快照', () => {
        const s = 'hello world';
        assert.ok(N.$strIncludes(s, 'world'));
        assert.ok(!N.$strIncludes(s, 'foo'));
    });

    test('$strIndexOf — 字符串 indexOf 快照', () => {
        const s = 'hello';
        assert.equal(N.$strIndexOf(s, 'l'), 2);
        assert.equal(N.$strIndexOf(s, 'x'), -1);
    });

    test('$strStartsWith — 字符串 startsWith 快照', () => {
        const s = 'hello world';
        assert.ok(N.$strStartsWith(s, 'hello'));
        assert.ok(!N.$strStartsWith(s, 'world'));
    });

    test('$strEndsWith — 字符串 endsWith 快照', () => {
        const s = 'hello world';
        assert.ok(N.$strEndsWith(s, 'world'));
        assert.ok(!N.$strEndsWith(s, 'hello'));
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Function 方法快照
// ════════════════════════════════════════════════════════════════════════════════

describe('Function 方法快照', () => {
    test('$apply — Function.prototype.apply 快照', () => {
        function sum(a, b) { return a + b; }
        const result = N.$apply(sum, null, [3, 4]);
        assert.equal(result, 7);
    });

    test('$call — Function.prototype.call 快照', () => {
        function greet(name) { return `Hello, ${name}!`; }
        const result = N.$call(greet, null, 'Jalangi');
        assert.equal(result, 'Hello, Jalangi!');
    });

    test('$bind — Function.prototype.bind 快照', () => {
        function multiply(a, b) { return a * b; }
        const double = N.$bind(multiply, null, 2);
        assert.equal(double(5), 10);
    });

    test('$apply — monkey-patch 防护', () => {
        const fn = x => x * 2;
        const orig = Function.prototype.apply;
        Function.prototype.apply = function() { throw new Error('patched!'); };
        try {
            const result = N.$apply(fn, null, [5]);
            assert.equal(result, 10);
        } finally {
            Function.prototype.apply = orig;
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Map/Set 方法快照
// ════════════════════════════════════════════════════════════════════════════════

describe('Map/Set 方法快照', () => {
    test('$mapSet / $mapGet — Map 基本操作', () => {
        const map = new Map();
        N.$mapSet(map, 'key1', 'value1');
        N.$mapSet(map, 'key2', 'value2');
        assert.equal(N.$mapGet(map, 'key1'), 'value1');
        assert.equal(N.$mapSize(map), 2);
    });

    test('$mapHas / $mapDel — Map 检查与删除', () => {
        const map = new Map([['a', 1]]);
        assert.ok(N.$mapHas(map, 'a'));
        N.$mapDel(map, 'a');
        assert.ok(!N.$mapHas(map, 'a'));
    });

    test('$setAdd / $setHas — Set 基本操作', () => {
        const set = new Set();
        N.$setAdd(set, 1);
        N.$setAdd(set, 2);
        assert.ok(N.$setHas(set, 1));
        assert.ok(!N.$setHas(set, 3));
        assert.equal(N.$setSize(set), 2);
    });

    test('$setDel — Set 删除元素', () => {
        const set = new Set([1, 2, 3]);
        N.$setDel(set, 2);
        assert.ok(!N.$setHas(set, 2));
        assert.equal(N.$setSize(set), 2);
    });

    test('$wmSet / $wmGet — WeakMap 基本操作', () => {
        const wm = new WeakMap();
        const key = {};
        N.$wmSet(wm, key, 'value');
        assert.equal(N.$wmGet(wm, key), 'value');
        assert.ok(N.$wmHas(wm, key));
    });

    test('$wmDel — WeakMap 删除', () => {
        const wm = new WeakMap();
        const key = {};
        N.$wmSet(wm, key, 123);
        N.$wmDel(wm, key);
        assert.ok(!N.$wmHas(wm, key));
    });

    test('$wsAdd / $wsHas — WeakSet 基本操作', () => {
        const ws = new WeakSet();
        const obj = {};
        N.$wsAdd(ws, obj);
        assert.ok(N.$wsHas(ws, obj));
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// JSON 方法快照
// ════════════════════════════════════════════════════════════════════════════════

describe('JSON 方法快照', () => {
    test('$jsonStringify — 序列化对象', () => {
        const obj = { a: 1, b: 'text' };
        const json = N.$jsonStringify(obj);
        assert.equal(json, '{"a":1,"b":"text"}');
    });

    test('$jsonParse — 解析 JSON 字符串', () => {
        const json = '{"x":10,"y":20}';
        const obj = N.$jsonParse(json);
        assert.deepEqual(obj, { x: 10, y: 20 });
    });

    test('$jsonStringify — monkey-patch 防护', () => {
        const orig = JSON.stringify;
        JSON.stringify = function() { throw new Error('patched!'); };
        try {
            const json = N.$jsonStringify({ x: 1 });
            assert.equal(json, '{"x":1}');
        } finally {
            JSON.stringify = orig;
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 边界条件与健壮性
// ════════════════════════════════════════════════════════════════════════════════

describe('边界条件', () => {
    test('$push — 空数组', () => {
        const arr = [];
        N.$push(arr, 1);
        assert.deepEqual(arr, [1]);
    });

    test('$keys — 空对象', () => {
        const keys = N.$keys({});
        assert.deepEqual(keys, []);
    });

    test('$slice — 越界索引', () => {
        const arr = [1, 2];
        const sub = N.$slice(arr, 10, 20);
        assert.deepEqual(sub, []);
    });

    test('$strSlice — 负数索引', () => {
        const s = 'hello';
        assert.equal(N.$strSlice(s, -3), 'llo');
    });

    test('$filter — 空数组', () => {
        const arr = [];
        const result = N.$filter(arr, x => x > 0);
        assert.deepEqual(result, []);
    });

    test('$reduce — 单元素数组', () => {
        const arr = [5];
        const sum = N.$reduce(arr, (a, b) => a + b, 0);
        assert.equal(sum, 5);
    });

    test('$create — null 原型对象', () => {
        const obj = N.$create(null);
        assert.equal(N.$getPrototypeOf(obj), null);
        assert.equal(obj.toString, undefined, '没有继承 Object.prototype');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 综合递归防护测试
// ════════════════════════════════════════════════════════════════════════════════

describe('递归调用防护', () => {
    test('多层 monkey-patch 叠加', () => {
        const origPush = Array.prototype.push;
        const origJoin = Array.prototype.join;
        const origKeys = Object.keys;

        try {
            // 三层污染
            Array.prototype.push = function() { throw new Error('push patched!'); };
            Array.prototype.join = function() { throw new Error('join patched!'); };
            Object.keys = function() { throw new Error('keys patched!'); };

            // 所有快照方法应仍正常工作
            const arr = [1];
            N.$push(arr, 2);
            assert.deepEqual(arr, [1, 2]);

            const str = N.$join(arr, ',');
            assert.equal(str, '1,2');

            const keys = N.$keys({ a: 1 });
            assert.deepEqual(keys, ['a']);
        } finally {
            Array.prototype.push = origPush;
            Array.prototype.join = origJoin;
            Object.keys = origKeys;
        }
    });

    test('运行时内部调用不触发用户 hook', () => {
        let hookCalled = 0;
        const orig = Array.prototype.push;
        Array.prototype.push = function(...args) {
            hookCalled++;
            return orig.apply(this, args);
        };

        try {
            const arr = [];
            // 用户代码调用 push,会触发 hook
            arr.push(1);
            assert.equal(hookCalled, 1);

            // 快照调用不触发 hook
            N.$push(arr, 2);
            assert.equal(hookCalled, 1, '快照 push 不应触发用户 hook');
            assert.deepEqual(arr, [1, 2]);
        } finally {
            Array.prototype.push = orig;
        }
    });
});
