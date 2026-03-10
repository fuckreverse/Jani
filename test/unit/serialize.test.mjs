/**
 * test/unit/serialize.test.mjs — serialize() 单元测试
 *
 * 覆盖范围：
 *   - 原始类型：null / undefined / boolean / number / bigint / symbol / string
 *   - 字符串转义：反斜杠、双引号、\n、\r
 *   - 字符串截断（超过 MAX_BYTES）
 *   - 特殊数字：NaN / Infinity / -Infinity / -0
 *   - Error（含子类、无 message、超长 message）
 *   - Date（正常 / Invalid）
 *   - RegExp（含 flags）
 *   - Promise
 *   - Map（空 / 普通 / 超过 MAX_MAP_ITEMS / 超过 MAX_BYTES）
 *   - Set（空 / 普通 / 超过 MAX_MAP_ITEMS / 超过 MAX_BYTES）
 *   - Array（空 / 普通 / 超过 MAX_ARRAY_ITEMS / 超过 MAX_BYTES / 深度截断）
 *   - 普通对象（空 / 普通 / 嵌套 / key 排序 / 超过 MAX_BYTES / 深度截断）
 *   - 对象属性特殊类型：null / undefined / function / symbol / bigint / object
 *   - getter 抛异常降级
 *   - 函数（有名 / 匿名 / 箭头函数 / class）
 *   - 深度参数行为（depth >= MAX_DEPTH 时数组/对象折叠）
 *   - 输出一致性（key 排序稳定）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    serialize,
    MAX_BYTES,
    MAX_DEPTH,
    MAX_ARRAY_ITEMS,
    MAX_MAP_ITEMS,
} from '../../src/utils/serialize.js';

// ════════════════════════════════════════════════════════════════════════════════
// 原始类型
// ════════════════════════════════════════════════════════════════════════════════

describe('原始类型', () => {
    test('null', () => {
        assert.equal(serialize(null), 'null');
    });

    test('undefined', () => {
        assert.equal(serialize(undefined), 'undefined');
    });

    test('boolean true/false', () => {
        assert.equal(serialize(true),  'true');
        assert.equal(serialize(false), 'false');
    });

    test('number 普通', () => {
        assert.equal(serialize(0),    '0');
        assert.equal(serialize(42),   '42');
        assert.equal(serialize(-1),   '-1');
        assert.equal(serialize(3.14), '3.14');
    });

    test('number 特殊值：NaN / Infinity / -Infinity / -0', () => {
        assert.equal(serialize(NaN),       'NaN');
        assert.equal(serialize(Infinity),  'Infinity');
        assert.equal(serialize(-Infinity), '-Infinity');
        // -0 的 String() 结果为 '0'
        assert.equal(serialize(-0), '0');
    });

    test('bigint', () => {
        assert.equal(serialize(0n),    '0n');
        assert.equal(serialize(123n),  '123n');
        assert.equal(serialize(-99n),  '-99n');
    });

    test('symbol', () => {
        assert.equal(serialize(Symbol('foo')),          'Symbol(foo)');
        assert.equal(serialize(Symbol()),               'Symbol()');
        assert.equal(serialize(Symbol.iterator),        'Symbol(Symbol.iterator)');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 字符串
// ════════════════════════════════════════════════════════════════════════════════

describe('string', () => {
    test('普通短字符串', () => {
        assert.equal(serialize('hello'), '"hello"');
        assert.equal(serialize(''),      '""');
    });

    test('转义：反斜杠', () => {
        assert.equal(serialize('a\\b'), '"a\\\\b"');
    });

    test('转义：双引号', () => {
        assert.equal(serialize('a"b'), '"a\\"b"');
    });

    test('转义：换行 \\n 和 \\r', () => {
        assert.equal(serialize('a\nb'), '"a\\nb"');
        assert.equal(serialize('a\rb'), '"a\\rb"');
        assert.equal(serialize('a\r\nb'), '"a\\r\\nb"');
    });

    test('转义：多种混合', () => {
        assert.equal(serialize('say "hi"\nbye\\ok'), '"say \\"hi\\"\\nbye\\\\ok"');
    });

    test('不截断：长度恰好等于 MAX_BYTES', () => {
        const s = 'x'.repeat(MAX_BYTES);
        const r = serialize(s);
        assert.ok(r.startsWith('"'), '应以双引号开头');
        assert.ok(!r.includes('(+'), '不应包含截断提示');
    });

    test('截断：长度超过 MAX_BYTES', () => {
        const extra = 5;
        const s = 'y'.repeat(MAX_BYTES + extra);
        const r = serialize(s);
        assert.ok(r.includes(`(+${extra})`), `应包含截断提示 "(+${extra})"`);
        // 实际输出的字符数应约为 MAX_BYTES + 引号 + 提示
        assert.ok(!r.startsWith('"' + s), '不应包含完整原串');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Error
// ════════════════════════════════════════════════════════════════════════════════

describe('Error', () => {
    test('普通 Error', () => {
        assert.equal(serialize(new Error('oops')), 'Error: oops');
    });

    test('无 message 的 Error', () => {
        assert.equal(serialize(new Error()), 'Error: ');
    });

    test('Error 子类保留名称', () => {
        assert.equal(serialize(new TypeError('bad type')), 'TypeError: bad type');
        assert.equal(serialize(new RangeError('out of range')), 'RangeError: out of range');
    });

    test('超长 message 截断', () => {
        const longMsg = 'e'.repeat(MAX_BYTES + 10);
        const r = serialize(new Error(longMsg));
        assert.ok(r.startsWith('Error: '), '应以 "Error: " 开头');
        assert.ok(r.includes('…'), '超长 message 应截断并含 …');
        assert.ok(r.length < MAX_BYTES + 20, '输出不应过长');
    });

    test('自定义 name 的 Error', () => {
        const e = new Error('custom');
        e.name = 'MyError';
        assert.equal(serialize(e), 'MyError: custom');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Date
// ════════════════════════════════════════════════════════════════════════════════

describe('Date', () => {
    test('有效 Date', () => {
        const d = new Date('2024-01-15T12:00:00.000Z');
        assert.equal(serialize(d), 'Date(2024-01-15T12:00:00.000Z)');
    });

    test('epoch 0', () => {
        assert.equal(serialize(new Date(0)), 'Date(1970-01-01T00:00:00.000Z)');
    });

    test('Invalid Date', () => {
        assert.equal(serialize(new Date('not-a-date')), 'Date(Invalid)');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// RegExp
// ════════════════════════════════════════════════════════════════════════════════

describe('RegExp', () => {
    test('无 flags', () => {
        assert.equal(serialize(/foo/), '/foo/');
    });

    test('带 flags', () => {
        assert.equal(serialize(/bar/gi), '/bar/gi');
    });

    test('特殊字符', () => {
        const r = serialize(/^\d+\.?\d*$/m);
        assert.ok(r.startsWith('/'), '应以 / 开头');
        assert.ok(r.endsWith('/m'), '应以 /m 结尾');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Promise
// ════════════════════════════════════════════════════════════════════════════════

describe('Promise', () => {
    test('pending Promise', () => {
        const p = new Promise(() => {});
        const r = serialize(p);
        assert.ok(r.startsWith('Promise('), '应以 Promise( 开头');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Map
// ════════════════════════════════════════════════════════════════════════════════

describe('Map', () => {
    test('空 Map', () => {
        assert.equal(serialize(new Map()), 'Map(0)');
    });

    test('普通 Map', () => {
        const m = new Map([['a', 1], ['b', 2]]);
        const r = serialize(m);
        assert.ok(r.startsWith('Map('), '应以 Map( 开头');
        assert.ok(r.includes('"a"=>1'), '应包含 "a"=>1');
        assert.ok(r.includes('"b"=>2'), '应包含 "b"=>2');
    });

    test('Map key 为非字符串类型', () => {
        const m = new Map([[42, 'num'], [true, 'bool']]);
        const r = serialize(m);
        assert.ok(r.includes('42=>"num"'), '数字 key 应正确序列化');
        assert.ok(r.includes('true=>"bool"'), 'boolean key 应正确序列化');
    });

    test(`超过 MAX_MAP_ITEMS(${MAX_MAP_ITEMS}) 条目时截断`, () => {
        const m = new Map();
        for (let i = 0; i < MAX_MAP_ITEMS + 3; i++) m.set(i, i);
        const r = serialize(m);
        assert.ok(r.includes('…(+3)'), '应有截断提示 "(+3)"');
    });

    test('Map 总长超过 MAX_BYTES 时截断', () => {
        const m = new Map();
        // 每个 value 是一个 500 字节的字符串，两条就超过 1000
        m.set('k1', 'v'.repeat(500));
        m.set('k2', 'v'.repeat(500));
        m.set('k3', 'sentinel');
        const r = serialize(m);
        assert.ok(!r.includes('"sentinel"'), '超过字节限制后的条目不应出现');
        assert.ok(r.includes('…'), '应有省略提示');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Set
// ════════════════════════════════════════════════════════════════════════════════

describe('Set', () => {
    test('空 Set', () => {
        assert.equal(serialize(new Set()), 'Set(0)');
    });

    test('普通 Set', () => {
        const s = new Set([1, 2, 3]);
        const r = serialize(s);
        assert.ok(r.startsWith('Set('), '应以 Set( 开头');
        assert.ok(r.includes('1') && r.includes('2') && r.includes('3'), '应包含所有元素');
    });

    test(`超过 MAX_MAP_ITEMS(${MAX_MAP_ITEMS}) 时截断`, () => {
        const s = new Set();
        for (let i = 0; i < MAX_MAP_ITEMS + 5; i++) s.add(i);
        const r = serialize(s);
        assert.ok(r.includes('…(+5)'), '应有截断提示 "(+5)"');
    });

    test('Set 总长超过 MAX_BYTES 时截断', () => {
        // 注意：Set 会对重复值去重，必须使用不同字符串触发字节截断
        const s = new Set(['v'.repeat(600), 'w'.repeat(600), 'sentinel']);
        const r = serialize(s);
        assert.ok(!r.includes('"sentinel"'), '超过字节限制后的元素不应出现');
        assert.ok(r.includes('…'), '应有省略提示');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// Array
// ════════════════════════════════════════════════════════════════════════════════

describe('Array', () => {
    test('空数组', () => {
        assert.equal(serialize([]), '[]');
    });

    test('基本类型元素', () => {
        assert.equal(serialize([1, 'two', true, null]), '[1,"two",true,null]');
    });

    test('嵌套数组（depth < MAX_DEPTH）', () => {
        const r = serialize([[1, 2], [3, 4]]);
        assert.ok(r.includes('[1,2]'), '应展开第一层嵌套');
    });

    test(`depth >= MAX_DEPTH(${MAX_DEPTH}) 时数组元素折叠为 …`, () => {
        // 在 depth=MAX_DEPTH 时调用 serialize，内部元素应折叠
        const r = serialize([[1, 2]], MAX_DEPTH);
        assert.ok(r.includes('…'), `depth=${MAX_DEPTH} 时嵌套数组应折叠`);
    });

    test(`超过 MAX_ARRAY_ITEMS(${MAX_ARRAY_ITEMS}) 个元素时截断`, () => {
        const arr = Array.from({ length: MAX_ARRAY_ITEMS + 7 }, (_, i) => i);
        const r = serialize(arr);
        assert.ok(r.includes('…(+7)'), '应有截断提示 "(+7)"');
    });

    test('数组总长超过 MAX_BYTES 时截断', () => {
        // 生成两个长字符串，使总输出超过 MAX_BYTES
        const arr = ['x'.repeat(600), 'y'.repeat(600), 'sentinel'];
        const r = serialize(arr);
        assert.ok(!r.includes('"sentinel"'), '超过字节限制后的元素不应出现');
        assert.ok(r.includes('…'), '应有省略提示');
    });

    test('含特殊值的数组', () => {
        const r = serialize([undefined, null, NaN, Infinity]);
        assert.equal(r, '[undefined,null,NaN,Infinity]');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 普通对象
// ════════════════════════════════════════════════════════════════════════════════

describe('普通对象', () => {
    test('空对象', () => {
        assert.equal(serialize({}), '{}');
    });

    test('单层对象', () => {
        assert.equal(serialize({ a: 1, b: 'two' }), '{a:1,b:"two"}');
    });

    test('key 按字典序排序，保证输出一致性', () => {
        const r1 = serialize({ z: 1, a: 2, m: 3 });
        const r2 = serialize({ m: 3, z: 1, a: 2 });
        assert.equal(r1, r2, '属性插入顺序不同，输出应相同');
        assert.ok(r1.indexOf('a:') < r1.indexOf('m:'), 'a 应排在 m 前');
        assert.ok(r1.indexOf('m:') < r1.indexOf('z:'), 'm 应排在 z 前');
    });

    test('对象属性：null 值', () => {
        assert.equal(serialize({ x: null }), '{x:null}');
    });

    test('对象属性：undefined 值', () => {
        assert.equal(serialize({ x: undefined }), '{x:undefined}');
    });

    test('对象属性：function 值缩写为 [Function]', () => {
        const r = serialize({ fn: () => {} });
        assert.ok(r.includes('[Function]'), '函数属性应显示为 [Function]');
    });

    test('对象属性：symbol 值', () => {
        const r = serialize({ s: Symbol('tag') });
        assert.ok(r.includes('Symbol(tag)'), 'symbol 属性应序列化');
    });

    test('对象属性：bigint 值', () => {
        assert.equal(serialize({ n: 99n }), '{n:99n}');
    });

    test('对象属性：嵌套对象（depth < MAX_DEPTH）', () => {
        const r = serialize({ outer: { inner: 42 } });
        assert.ok(r.includes('inner:42'), '应展开嵌套对象');
    });

    test(`对象属性：depth >= MAX_DEPTH(${MAX_DEPTH}) 时嵌套对象折叠为 {…}`, () => {
        const r = serialize({ outer: { inner: 42 } }, MAX_DEPTH);
        assert.ok(r.includes('{…}'), `depth=${MAX_DEPTH} 时嵌套对象应折叠`);
    });

    test('总输出超过 MAX_BYTES 时截断', () => {
        // 一个拥有长字符串值的对象
        const obj = { a: 'x'.repeat(MAX_BYTES) };
        const r = serialize(obj);
        assert.ok(r.endsWith('…') || r.length <= MAX_BYTES + 10, '超长对象应截断');
    });

    test('总输出超过 MAX_BYTES 时追加 … 而非硬截断格式错误', () => {
        const obj = {};
        for (let i = 0; i < 20; i++) obj[`key${i}`] = 'v'.repeat(80);
        const r = serialize(obj);
        assert.ok(r.endsWith('…') || r.includes('…'), '超长时应有省略符号');
    });

    test('key 累计超过 MAX_BYTES 时推入 … 并停止', () => {
        // 用 50 个键 × 25 字节 value，共约 1500 字节，触发 total >= MAX_BYTES 路径
        const obj = {};
        for (let i = 0; i < 50; i++) obj[`k${String(i).padStart(3, '0')}`] = 'v'.repeat(25);
        const r = serialize(obj);
        assert.ok(r.includes('…'), '应有省略符号');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// getter 抛异常降级
// ════════════════════════════════════════════════════════════════════════════════

describe('getter 抛异常 → 降级为 Object.prototype.toString', () => {
    test('Object.keys 抛异常时降级', () => {
        // 构造一个 Object.keys 会抛的对象（通过代理拦截 ownKeys）
        const proxy = new Proxy({}, {
            ownKeys() { throw new Error('ownKeys bomb'); },
            getOwnPropertyDescriptor() { return { configurable: true, enumerable: true }; },
        });
        const r = serialize(proxy);
        // 降级后应返回类似 "[object Object]"
        assert.ok(r.includes('[object'), '应降级为 toString 结果');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 函数
// ════════════════════════════════════════════════════════════════════════════════

describe('function', () => {
    test('具名函数', () => {
        function myFunc() {}
        assert.equal(serialize(myFunc), '[Function myFunc]');
    });

    test('匿名函数表达式', () => {
        // V8 会从赋值目标推断 name（const f = function(){} → name='f'），
        // 真正 name 为空的情形需要通过 IIFE 或 Object.defineProperty 构造。
        const f = function() {};
        assert.equal(serialize(f), '[Function f]', 'V8 推断 name 为变量名');

        // name 显式为空字符串时（通过 defineProperty 覆盖）
        const anon = function namedThenCleared() {};
        Object.defineProperty(anon, 'name', { value: '' });
        assert.equal(serialize(anon), '[Function (anonymous)]', 'name 为空字符串时应显示 (anonymous)');
    });

    test('箭头函数（有名绑定）', () => {
        const arrowFn = () => {};
        assert.equal(serialize(arrowFn), '[Function arrowFn]');
    });

    test('class 也视为函数', () => {
        class MyClass {}
        assert.equal(serialize(MyClass), '[Function MyClass]');
    });

    test('内置函数', () => {
        const r = serialize(Math.max);
        assert.ok(r.startsWith('[Function'), '内置函数应以 [Function 开头');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 嵌套混合结构
// ════════════════════════════════════════════════════════════════════════════════

describe('嵌套混合结构', () => {
    test('对象含数组', () => {
        const r = serialize({ list: [1, 2, 3] });
        assert.ok(r.includes('[1,2,3]'), '应展开数组属性');
    });

    test('数组含对象', () => {
        const r = serialize([{ x: 1 }, { y: 2 }]);
        assert.ok(r.includes('x:1') && r.includes('y:2'), '应展开对象元素');
    });

    test('Map value 为对象', () => {
        const m = new Map([['key', { val: 42 }]]);
        const r = serialize(m);
        assert.ok(r.includes('val:42'), '应展开 Map value 中的对象');
    });

    test('Set 含 Error 元素', () => {
        const s = new Set([new Error('boom')]);
        const r = serialize(s);
        assert.ok(r.includes('Error: boom'), '应正确序列化 Set 内的 Error');
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// 边界与回归
// ════════════════════════════════════════════════════════════════════════════════

describe('边界与回归', () => {
    test('顶层 string 类型换行被转义（单行约束）', () => {
        // 注意：只有顶层 serialize(string) 路径才做 \n 转义；
        // 对象属性分支对 string value 走 String(vv)，不转义——这是当前已知行为。
        // 此处测试通过 serialize() 递归路径（数组元素）来验证转义正常。
        const r = serialize(['line1\nline2']);
        assert.ok(!r.includes('\n'), '数组元素中的字符串应转义 \\n');
        assert.ok(r.includes('\\n'), '\\n 应被转义为 \\\\n');
    });

    test('serialize 对相同输入多次调用结果稳定', () => {
        const obj = { z: 3, a: 1, m: 2 };
        const r1 = serialize(obj);
        const r2 = serialize(obj);
        assert.equal(r1, r2, '多次调用应产生相同结果');
    });

    test('number 0 不被当作 falsy 导致输出错误', () => {
        assert.equal(serialize(0), '0');
        assert.equal(serialize({ n: 0 }), '{n:0}');
    });

    test('空字符串属性 key', () => {
        // 空字符串 key 直接拼接，value（字符串）经 serialize() 加引号
        const r = serialize({ '': 'empty key' });
        assert.equal(r, '{:"empty key"}', '空 key 拼接，string value 带引号');
    });

    test('数组含 undefined 和 null', () => {
        assert.equal(serialize([undefined, null, 0, '']), '[undefined,null,0,""]');
    });

    test('非常规对象：Object.create(null)', () => {
        const obj = Object.create(null);
        obj.x = 1;
        // Object.keys 应正常工作
        const r = serialize(obj);
        assert.ok(r.includes('x:1'), '无原型的对象应正常序列化');
    });
});
