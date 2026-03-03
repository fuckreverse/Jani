var x = 1;

var e = eval;

eval("x = 3;");

e("x = 2;");


console.log(x);
// node bin/jalangi.mjs --inline-iid --inline-source --analysis src/runtime/SMemory.js --analysis src/plugins/scratch/SmemTest.js tests/unit/indirectEval.js
