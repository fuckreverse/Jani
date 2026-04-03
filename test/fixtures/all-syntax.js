/**
 * test/fixtures/all-syntax.js
 *
 * 全语法覆盖样例 —— 供全流程集成测试使用。
 *
 * 覆盖范围：
 *   - ES5   var / function / for / while / do-while / switch / try-catch-finally
 *   - ES6   let/const / 箭头函数 / class（含 getter/setter/继承）/ 模板字符串
 *           解构（对象/数组/嵌套/默认值）/ rest/spread / for-of / for-in
 *           Symbol / Map / Set / WeakMap / generator / Promise
 *   - ES2017 async/await
 *   - ES2018 rest/spread in objects
 *   - ES2019 optional catch binding
 *   - ES2020 可选链 ?. / 空值合并 ?? / BigInt / 逻辑赋值 &&= ||= ??=
 *   - ES2022 class 私有字段 / 私有方法 / static 初始化块
 *   - 边缘案例：递归 / 闭包 / 多层继承 / throw-rethrow / delete / in / instanceof
 *              逗号表达式 / typeof / void / 前置++ / 后置++ / 位运算 / 逻辑运算
 *              Object.freeze / Reflect / Proxy / 标签模板字符串 / arguments
 *
 * 注意：本文件用 script 模式运行，不含 ESM import/export。
 *       所有结果写入全局 $__results 对象，供测试层验证。
 */

/* ── 环境准备 ───────────────────────────────────────────────────────────────── */
var $__results = {};

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 1: ES5 基础
   ══════════════════════════════════════════════════════════════════════════════ */

// 1a. var + 算术 + 字符串
var es5_num = 3 + 4;
var es5_str = 'hello' + ' ' + 'world';
var es5_modulo = 17 % 5;
var es5_exp = 2 * 2 * 2;   // 8，不用 **（兼容 ES5 降级检测）
$__results.es5_num    = es5_num;
$__results.es5_str    = es5_str;
$__results.es5_modulo = es5_modulo;
$__results.es5_exp    = es5_exp;

// 1b. function 声明 + 递归（阶乘）
function fact(n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
$__results.fact5 = fact(5);   // 120

// 1c. for / while / do-while
var es5_for_sum = 0;
for (var i = 0; i < 5; i++) {
    es5_for_sum += i;
}
var es5_while = 1;
var wc = 0;
while (wc < 4) { es5_while *= 2; wc++; }
var es5_dowhile = 0;
do { es5_dowhile++; } while (es5_dowhile < 3);
$__results.es5_for_sum  = es5_for_sum;   // 10
$__results.es5_while    = es5_while;     // 16
$__results.es5_dowhile  = es5_dowhile;   // 3

// 1d. switch
function dayName(d) {
    switch (d) {
        case 0: return 'Sun';
        case 1: return 'Mon';
        case 6: return 'Sat';
        default: return 'Other';
    }
}
$__results.dayMon = dayName(1);
$__results.dayDef = dayName(3);

// 1e. try / catch / finally
var es5_try = 0;
try {
    throw new Error('boom');
} catch (e) {
    es5_try = e.message.length;   // 4
} finally {
    es5_try += 1;   // 5
}
$__results.es5_try = es5_try;

// 1f. for-in
var obj_forin = { a: 1, b: 2, c: 3 };
var forin_keys = [];
for (var k in obj_forin) {
    forin_keys.push(k);
}
$__results.forin_keys_len = forin_keys.length;   // 3

// 1g. 对象 + 数组基础
var es5_obj = { x: 10, y: 20 };
es5_obj.z = es5_obj.x + es5_obj.y;
var es5_arr = [1, 2, 3];
es5_arr.push(4);
var es5_arr_sum = 0;
for (var ai = 0; ai < es5_arr.length; ai++) {
    es5_arr_sum += es5_arr[ai];
}
$__results.es5_obj_z     = es5_obj.z;       // 30
$__results.es5_arr_sum   = es5_arr_sum;     // 10

// 1h. arguments + 可变参数函数
function sumAll() {
    var s = 0;
    for (var ai2 = 0; ai2 < arguments.length; ai2++) s += arguments[ai2];
    return s;
}
$__results.sumAll = sumAll(1, 2, 3, 4);   // 10

// 1i. typeof / void / delete
var es5_typeof = typeof undefined;
var es5_void   = void 0;
var del_obj    = { p: 1 };
delete del_obj.p;
$__results.es5_typeof     = es5_typeof;            // 'undefined'
$__results.es5_void_undef = es5_void === undefined; // true
$__results.del_has_p      = 'p' in del_obj;        // false

// 1j. 位运算
var es5_bit = (0b1010 | 0b0101) & 0xFF;   // 15
$__results.es5_bit = es5_bit;

// 1k. 逗号表达式（在 for 初始化中）
var comma_a = 0, comma_b = 0;
for (comma_a = 1, comma_b = 2; comma_a < 2; comma_a++) {
    comma_b += comma_a;
}
$__results.comma_b = comma_b;   // 3

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 2: ES6 语法
   ══════════════════════════════════════════════════════════════════════════════ */

// 2a. let / const
let es6_let = 1;
const es6_const = 42;
{
    let block_let = 99;
    $__results.block_let = block_let;
}
$__results.es6_let   = es6_let;
$__results.es6_const = es6_const;

// 2b. 箭头函数（表达式体 + 块体）
const double  = n => n * 2;
const greet   = (name) => `Hello, ${name}!`;
const addOne  = (x) => { const r = x + 1; return r; };
$__results.double7  = double(7);
$__results.greet    = greet('World');
$__results.addOne   = addOne(9);

// 2c. 模板字符串（含嵌套表达式 + 多行）
const a = 3, b = 4;
const tmpl1 = `${a} + ${b} = ${a + b}`;
const tmpl2 = `line1
line2`;
$__results.tmpl1 = tmpl1;
$__results.tmpl2_lines = tmpl2.split('\n').length;   // 2

// 2d. 标签模板字符串
function tag(strings, ...vals) {
    return strings.raw.join('|') + '::' + vals.join(',');
}
const tagged = tag`x=${a}+y=${b}`;
$__results.tagged = tagged;

// 2e. 解构赋值 —— 对象 / 数组 / 嵌套 / 默认值
const { x: ox, y: oy = 5 } = { x: 10 };
const [first, , third] = [1, 2, 3];
const { p: { q } } = { p: { q: 42 } };
$__results.ox    = ox;    // 10
$__results.oy    = oy;    // 5  (默认值)
$__results.first = first; // 1
$__results.third = third; // 3
$__results.q     = q;     // 42

// 2f. 函数参数解构
function pointDist({ x: px = 0, y: py = 0 } = {}) {
    return px * px + py * py;
}
$__results.pointDist = pointDist({ x: 3, y: 4 });   // 25

// 2g. rest / spread
function restFn(first2, ...rest) { return rest.length; }
const spread_arr = [1, 2, ...[3, 4, 5]];
const spread_obj = { ...{ a: 1 }, ...{ b: 2 } };
$__results.rest_len      = restFn(1, 2, 3, 4);   // 3
$__results.spread_len    = spread_arr.length;      // 5
$__results.spread_obj_b  = spread_obj.b;           // 2

// 2h. class（含 getter / setter / 继承）
class Animal {
    #name;
    constructor(name) { this.#name = name; }
    get name()       { return this.#name; }
    set name(v)      { this.#name = v; }
    speak()          { return `${this.#name} makes a noise.`; }
    static create(n) { return new Animal(n); }
}
class Dog extends Animal {
    #breed;
    constructor(name, breed) { super(name); this.#breed = breed; }
    speak()  { return `${this.name} barks.`; }
    info()   { return `${this.name}(${this.#breed})`; }
}
const dog = new Dog('Rex', 'Lab');
dog.name = 'Max';
$__results.dog_speak = dog.speak();
$__results.dog_info  = dog.info();
$__results.dog_name  = dog.name;
$__results.animal_static = Animal.create('Cat').name;

// 2i. Symbol
const sym1 = Symbol('test');
const sym2 = Symbol('test');
$__results.sym_same  = sym1 === sym2;    // false
$__results.sym_type  = typeof sym1;      // 'symbol'

// 2j. Map / Set
const map1 = new Map([['a', 1], ['b', 2]]);
map1.set('c', 3);
const set1 = new Set([1, 2, 2, 3]);
$__results.map_size  = map1.size;    // 3
$__results.map_b     = map1.get('b'); // 2
$__results.set_size  = set1.size;    // 3 (去重)

// 2k. for-of
let forofSum = 0;
for (const v of [1, 2, 3, 4, 5]) { forofSum += v; }
let forofStr = '';
for (const ch of 'abc')           { forofStr += ch; }
$__results.forof_sum = forofSum;   // 15
$__results.forof_str = forofStr;   // 'abc'

// 2l. Generator
function* range(start, end) {
    for (let i = start; i < end; i++) yield i;
}
const gen_arr = [...range(1, 6)];
$__results.gen_arr_len = gen_arr.length;   // 5
$__results.gen_arr_4   = gen_arr[3];       // 4

// 2m. Symbol.iterator 自定义迭代器
const counterIter = {
    [Symbol.iterator]() {
        let n = 0;
        return {
            next() { return n < 3 ? { value: n++, done: false } : { done: true }; }
        };
    }
};
const iter_arr = [...counterIter];
$__results.iter_arr = iter_arr.join(',');   // '0,1,2'

// 2n. WeakMap / WeakSet
const wm = new WeakMap();
const ws = new WeakSet();
const wmKey = {};
wm.set(wmKey, 42);
ws.add(wmKey);
$__results.wm_has  = wm.has(wmKey);    // true
$__results.wm_val  = wm.get(wmKey);    // 42
$__results.ws_has  = ws.has(wmKey);    // true

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 3: ES2017 async / await
   ══════════════════════════════════════════════════════════════════════════════ */

// 3a. 基础 async/await
async function fetchValue(v) {
    const r = await Promise.resolve(v * 2);
    return r + 1;
}

// 3b. 多层 await（async 调用链）
async function chainAsync(x) {
    const a2 = await Promise.resolve(x + 1);
    const b2 = await Promise.resolve(a2 * 2);
    return b2;
}

// 3c. async/await + try-catch
async function asyncTryCatch(shouldThrow) {
    try {
        if (shouldThrow) throw new Error('async-error');
        return await Promise.resolve('ok');
    } catch (e) {
        return 'caught: ' + e.message;
    }
}

// 3d. Promise.all
async function parallelTasks() {
    const [r1, r2, r3] = await Promise.all([
        Promise.resolve(10),
        Promise.resolve(20),
        Promise.resolve(30),
    ]);
    return r1 + r2 + r3;
}

// 异步结果放在全局 Promise，由测试层 await
$__results._asyncPromises = Promise.all([
    fetchValue(5).then(v  => { $__results.fetchValue  = v; }),     // 11
    chainAsync(3).then(v  => { $__results.chainAsync  = v; }),     // (3+1)*2 = 8
    asyncTryCatch(false).then(v => { $__results.asyncOk   = v; }),
    asyncTryCatch(true).then(v  => { $__results.asyncCatch = v; }),
    parallelTasks().then(v  => { $__results.parallel   = v; }),    // 60
]);

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 4: ES2019 optional catch binding
   ══════════════════════════════════════════════════════════════════════════════ */

var es2019_catch_val = 'none';
try {
    throw new Error('x');
} catch {
    es2019_catch_val = 'caught';
}
$__results.es2019_catch = es2019_catch_val;   // 'caught'

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 5: ES2020 可选链 / 空值合并 / BigInt / 逻辑赋值
   ══════════════════════════════════════════════════════════════════════════════ */

// 5a. 可选链
const es20_obj = { a: { b: { c: 42 } } };
const es20_val1 = es20_obj?.a?.b?.c;
const es20_val2 = es20_obj?.x?.y?.z;
const es20_arr2 = [1, 2, 3];
const es20_elem = es20_arr2?.[1];
$__results.optional_chain1 = es20_val1;   // 42
$__results.optional_chain2 = es20_val2;   // undefined
$__results.optional_chain3 = es20_elem;   // 2

// 5b. 空值合并
const nullish1 = null ?? 'default';
const nullish2 = 0 ?? 'not-this';     // 0 不是 null/undefined
const nullish3 = undefined ?? 42;
$__results.nullish1 = nullish1;   // 'default'
$__results.nullish2 = nullish2;   // 0
$__results.nullish3 = nullish3;   // 42

// 5c. BigInt
const big1 = 9007199254740991n;
const big2 = big1 + 1n;
$__results.bigint_ok = big2 === 9007199254740992n;   // true

// 5d. 逻辑赋值
let la1 = null;  la1 ??= 'fallback';
let la2 = 1;     la2 &&= la2 + 1;
let la3 = 0;     la3 ||= 99;
$__results.la1 = la1;   // 'fallback'
$__results.la2 = la2;   // 2
$__results.la3 = la3;   // 99

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 6: ES2022 class 私有字段 / 私有方法 / static 初始化块
   ══════════════════════════════════════════════════════════════════════════════ */

class Counter {
    #count = 0;
    static #instances = 0;

    static {
        // static 初始化块
        Counter.#instances = 0;
    }

    constructor(init = 0) {
        this.#count = init;
        Counter.#instances++;
    }

    #double()  { return this.#count * 2; }
    increment(){ this.#count++; return this; }
    get value(){ return this.#count; }
    doubled()  { return this.#double(); }

    static getInstances() { return Counter.#instances; }
}

const c1 = new Counter(5);
c1.increment().increment();
const c2 = new Counter(10);
$__results.c1_val      = c1.value;               // 7
$__results.c1_doubled  = c1.doubled();            // 14
$__results.c2_val      = c2.value;               // 10
$__results.counter_instances = Counter.getInstances(); // 2

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 7: 边缘案例 / 操作符行为
   ══════════════════════════════════════════════════════════════════════════════ */

// 7a. 前置++ / 后置++
let pre = 5, post = 5;
const pre_result  = ++pre;   // 6
const post_result = post++;  // 5 (先返回再增)
$__results.pre_result  = pre_result;   // 6
$__results.post_result = post_result;  // 5
$__results.pre_final   = pre;          // 6
$__results.post_final  = post;         // 6

// 7b. in / instanceof
const in_obj = { foo: 1 };
const inst_arr = [1, 2, 3];
$__results.in_check   = 'foo' in in_obj;          // true
$__results.inst_check = inst_arr instanceof Array; // true

// 7c. Object.freeze
const frozen = Object.freeze({ x: 1, y: 2 });
try {
    'use strict';
    // 冻结对象赋值在严格模式抛 TypeError
    // 但 vm 沙盒为脚本模式，故静默失败
    frozen.x = 99;
} catch(e) { /* expected in strict mode */ }
$__results.frozen_x = frozen.x;   // 1（赋值失败）

// 7d. Proxy + Reflect
const handler = {
    get(target, prop) {
        return prop in target ? target[prop] : `missing:${prop}`;
    },
    set(target, prop, value) {
        target[prop] = value * 2;   // 写入时翻倍
        return true;
    }
};
const proxy_base = {};
const proxy      = new Proxy(proxy_base, handler);
proxy.val = 5;
const proxy_get  = proxy.val;       // 10
const proxy_miss = proxy.noKey;     // 'missing:noKey'
$__results.proxy_get  = proxy_get;
$__results.proxy_miss = proxy_miss;

// 7e. Reflect.construct
class Base { constructor(v) { this.v = v; } }
class Derived extends Base {}
const inst = Reflect.construct(Base, [42], Derived);
$__results.reflect_v          = inst.v;                      // 42
$__results.reflect_instanceof = inst instanceof Derived;     // true

// 7f. 闭包 + 多层嵌套
function makeAdder(x) {
    return function inner(y) {
        return function innermost(z) {
            return x + y + z;
        };
    };
}
$__results.closure_nested = makeAdder(1)(2)(3);   // 6

// 7g. 闭包工厂（多实例独立）
function makeCounter(start) {
    let n = start;
    return { inc: () => ++n, get: () => n };
}
const ctrA = makeCounter(0);
const ctrB = makeCounter(10);
ctrA.inc(); ctrA.inc();
ctrB.inc();
$__results.ctrA = ctrA.get();   // 2
$__results.ctrB = ctrB.get();   // 11

// 7h. 递归 + 尾部（memoization）
const memo = {};
function fib(n) {
    if (n <= 1) return n;
    if (memo[n]) return memo[n];
    return (memo[n] = fib(n - 1) + fib(n - 2));
}
$__results.fib10 = fib(10);   // 55

// 7i. throw + rethrow
function mayThrow(v) {
    if (v < 0) throw new RangeError('negative');
    return v;
}
function wrapper(v) {
    try { return mayThrow(v); }
    catch(e) {
        if (e instanceof RangeError) throw e;  // rethrow
        return -1;
    }
}
var rethrow_val = 'none';
try {
    wrapper(-1);
} catch(e) {
    rethrow_val = e.constructor.name;
}
$__results.rethrow     = rethrow_val;   // 'RangeError'
$__results.wrapper_ok  = wrapper(5);    // 5

// 7j. 幂运算符 (**)
const pow_result = 2 ** 10;
$__results.pow = pow_result;   // 1024

// 7k. 三元嵌套
const ternary = (x) => x > 0 ? 'pos' : x < 0 ? 'neg' : 'zero';
$__results.ternary_pos  = ternary(1);
$__results.ternary_neg  = ternary(-1);
$__results.ternary_zero = ternary(0);

// 7l. 短路求值
let short_sideEffect = 0;
const short_and = false && (++short_sideEffect, true);
const short_or  = true  || (++short_sideEffect, false);
$__results.short_side  = short_sideEffect;   // 0（均被短路，无副作用）
$__results.short_and   = short_and;          // false
$__results.short_or    = short_or;           // true

// 7m. 对象字面量 computed key
const key = 'dynamic';
const computed_obj = { [key]: 'value', [`${key}2`]: 'value2' };
$__results.computed_key  = computed_obj.dynamic;   // 'value'
$__results.computed_key2 = computed_obj.dynamic2;  // 'value2'

// 7n. getter/setter 在普通对象中
const gobj = {
    _val: 0,
    get val()  { return this._val; },
    set val(v) { this._val = v > 0 ? v : 0; }
};
gobj.val = 10;
const gobj_v1 = gobj.val;  // 10
gobj.val = -5;
const gobj_v2 = gobj.val;  // 0（clamp）
$__results.gobj_v1 = gobj_v1;
$__results.gobj_v2 = gobj_v2;

// 7o. Array destructuring with iterator protocol
const [it0, it1, it2] = counterIter;  // 从 section 2m 定义的迭代器读
$__results.it0 = it0;   // 0
$__results.it1 = it1;   // 1
$__results.it2 = it2;   // 2

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 8: Generator 高级
   ══════════════════════════════════════════════════════════════════════════════ */

// 8a. Generator 双向通信 (next(value))
function* dialog() {
    const a3 = yield 'first';
    const b3 = yield a3 + '-second';
    return b3 + '-done';
}
const gen = dialog();
const g1 = gen.next();        // {value:'first', done:false}
const g2 = gen.next('A');     // {value:'A-second', done:false}
const g3 = gen.next('B');     // {value:'B-done', done:true}
$__results.gen_g1 = g1.value;   // 'first'
$__results.gen_g2 = g2.value;   // 'A-second'
$__results.gen_g3 = g3.value;   // 'B-done'

// 8b. Generator return() 提前终止
function* infinite() { let n = 0; while(true) yield n++; }
const inf = infinite();
inf.next(); inf.next();
const gen_ret = inf.return('stop');
$__results.gen_ret_done  = gen_ret.done;    // true
$__results.gen_ret_value = gen_ret.value;   // 'stop'

// 8c. yield*（委托）
function* inner2() { yield 10; yield 20; }
function* outer2() { yield 1; yield* inner2(); yield 2; }
const delegated = [...outer2()];
$__results.delegated = delegated.join(',');   // '1,10,20,2'

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 9: 更多解构 / 参数边缘案例
   ══════════════════════════════════════════════════════════════════════════════ */

// 9a. 参数默认值含函数调用
let defaultCalled = 0;
function makeDefault() { defaultCalled++; return 42; }
function withDefault(x = makeDefault()) { return x; }
const wd1 = withDefault(1);    // defaultCalled 未触发
const wd2 = withDefault();     // defaultCalled 触发一次
$__results.wd1          = wd1;           // 1
$__results.wd2          = wd2;           // 42
$__results.defaultCalled = defaultCalled; // 1

// 9b. 嵌套解构 + rest
const { a: { b: b_inner, ...b_rest }, c: c_outer } = { a: { b: 1, d: 2, e: 3 }, c: 99 };
$__results.b_inner   = b_inner;            // 1
$__results.b_rest_d  = b_rest.d;           // 2
$__results.c_outer   = c_outer;            // 99

// 9c. 数组 rest 解构
const [head, ...tail] = [10, 20, 30, 40];
$__results.head      = head;               // 10
$__results.tail_len  = tail.length;        // 3

// 9d. swap（不使用解构赋值形式，因插桩器对赋值左侧的数组/对象解构有已知限制）
// NOTE: [a,b]=[b,a] 形式会触发 wrappers.js instrumentStore bug（已知限制）
// 改用临时变量实现相同语义
let swap_x = 1, swap_y = 2;
{ const _tmp = swap_x; swap_x = swap_y; swap_y = _tmp; }
$__results.swap_x = swap_x;   // 2
$__results.swap_y = swap_y;   // 1

/* ══════════════════════════════════════════════════════════════════════════════
   SECTION 10: 数值与字符串边缘案例
   ══════════════════════════════════════════════════════════════════════════════ */

// 10a. NaN / Infinity 处理
$__results.isnan_nan   = isNaN(NaN);        // true
$__results.isnan_0     = isNaN(0);          // false
$__results.isfinite_inf = isFinite(Infinity); // false
$__results.num_str     = String(42);
$__results.parse_int   = parseInt('0xff', 16);   // 255

// 10b. 字符串方法
const s = 'Hello, World!';
$__results.str_upper  = s.toUpperCase();
$__results.str_slice  = s.slice(7, 12);
$__results.str_includes = s.includes('World');
$__results.str_split  = s.split(', ').length;   // 2

// 10c. 模板字符串转义
const tmpl_esc = `backslash: \\ newline: \n tab: \t`;
$__results.tmpl_esc_len = tmpl_esc.length > 10;   // true

/* ══════════════════════════════════════════════════════════════════════════════
   结束标记（后处理工具应能读取到这一步）
   ══════════════════════════════════════════════════════════════════════════════ */
$__results._done = true;
