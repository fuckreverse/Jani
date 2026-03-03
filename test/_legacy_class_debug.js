global.acorn = require('acorn');
global.astring = require('astring');
require('./src/js/Constants.js');
require('./src/js/Config.js');
require('./src/js/instrument/astUtil.js');
require('./src/js/instrument/iid.js');
require('./src/js/instrument/scope.js');
require('./src/js/instrument/wrappers.js');
require('./src/js/instrument/esnstrument.js');

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
