import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { instrAndRun } from '../helpers/shared-helpers.mjs';

const cases = {
    'creating a literal never invokes string or symbol getters': `
        var count=0;
        var o={get x(){throw new Error('unexpected getter');},
            get [Symbol.iterator](){count++;throw new Error('unexpected symbol getter');}};
        $out.count=count; $out.exists=typeof o==='object';`,
    'super calls preserve the receiver': `
        class A { m() { return this.value; } }
        class B extends A { constructor() { super(); this.value=7; } m() { return super.m(); } }
        $out.value = new B().m();`,
    'super getters and setters preserve the receiver': `
        class A { get x() { return this.value; } set x(v) { this.value=v; } }
        class B extends A { m() { super.x=3; super.x+=2; return super.x++; } }
        var b=new B(); $out.old=b.m(); $out.value=b.value;`,
    'BigInt prefix and postfix updates': `
        var n=1n; $out.old=n++; $out.next=++n; $out.last=n--; $out.value=--n;
        var o={n:1n}; $out.property=o.n++; $out.final=o.n;`,
    'postfix values survive floating point rounding': `
        var n=9007199254740992; $out.old=n++; $out.value=n;
        var m=-9007199254740992; $out.before=m--; $out.after=m;`,
    'updates coerce once and evaluate a computed reference once': `
        var calls=0, keys=0, gets=0, sets=0, value;
        var o={get x(){gets++;return {[Symbol.toPrimitive](){calls++;return 4n;}};},set x(v){sets++;value=v;}};
        function key(){keys++;return 'x';}
        $out.old=o[key()]++; $out.value=value; $out.counts=[calls,keys,gets,sets];`,
    'destructuring assignment remains a native assignment': `
        var a,b; $out.result=({a,b}={a:2,b:3}); $out.a=a; $out.b=b;
        [a,b]=[5,6]; $out.array=[a,b];`,
    'optional delete short circuits computed keys': `
        var n=0, o=null; $out.result=delete o?.[n++]; $out.count=n;
        o={x:1}; $out.deleted=delete o?.x; $out.present='x' in o;`,
};

for (const [name, source] of Object.entries(cases)) {
    test(name, () => {
        const expected = {};
        vm.runInNewContext(source, { $out: expected });
        const actual = instrAndRun(source).out;
        // Normalize cross-realm prototypes while retaining BigInt and undefined.
        assert.deepEqual(structuredClone(actual), structuredClone(expected));
    });
}
