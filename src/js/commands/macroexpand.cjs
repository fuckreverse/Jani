'use strict';

// The function expects that str will contain substrings of the form [_[ function(){ ... } ]_]
// Any such substring will be replaced with the string returned by the invocation of the function.
// The replacement process will continue until there are no such substrings in str.

let currentPath = process.cwd();

const BEGIN_MARKER = '//[_[';
const END_MARKER   = '//]_]';
const MARKER_LEN   = BEGIN_MARKER.length;

function expand(str) {
    let sidx, eidx;
    while ((sidx = str.indexOf(BEGIN_MARKER)) >= 0) {
        eidx = str.indexOf(END_MARKER);
        if (eidx < 0) throw new Error(`End marker not found in ${str}`);
        console.log(`str = ${str}`);
        console.log(`sidx = ${sidx}`);
        console.log(`eidx = ${eidx}`);
        const code    = str.slice(sidx + MARKER_LEN, eidx);
        console.log(`code = ${code}`);
        // eslint-disable-next-line no-eval
        const geval   = eval;
        const newCode = geval(`(${code})`)();
        str = str.slice(0, sidx) + newCode + str.slice(eidx + MARKER_LEN);
    }
    return str;
}

function fileExpand(file) {
    const path = require('path');
    const fs   = require('fs');
    const fullFilePath   = path.resolve(currentPath, file);
    const oldCurrentPath = currentPath;
    currentPath          = path.dirname(fullFilePath);
    const content        = fs.readFileSync(fullFilePath, 'utf8');
    const newStr         = expand(content);
    currentPath          = oldCurrentPath;
    return newStr;
}

if (require.main === module) {
    const fs      = require('fs');
    const content = fileExpand(process.argv[2]);
    fs.writeFileSync(process.argv[3], content);
} else {
    module.exports = fileExpand;
}
