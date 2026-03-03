global.acorn = require('acorn');
global.astring = require('astring');
require('./src/Constants.js');
require('./src/Config.js');
require('./src/instrument/astUtil.js');
require('./src/instrument/iid.js');
require('./src/instrument/scope.js');
require('./src/instrument/wrappers.js');
require('./src/instrument/esnstrument.js');

try {
    var result = J$.instrumentCode({
        code: 'class Animal { constructor(name) { this.name = name; } speak() { return this.name; } }',
        isEval: false,
        origCodeFileName: 'test.js',
        instCodeFileName: 'test_inst.js',
        inlineSourceMap: false,
        inlineSource: false
    });
    console.log('PASS - length:', result.code.length);
} catch(e) {
    console.log('FAIL:', e.message);
    console.log(e.stack);
}
