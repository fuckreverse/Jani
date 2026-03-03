'use strict';

const fs      = require('fs');
const content = fs.readFileSync('src/js/browser/frame.html', 'utf8');
fs.writeFileSync(
    'src/js/browser/mid.html',
    `<script type="text/javascript">\n J$.frameHtml = ${JSON.stringify(content).replace(/</g, '\x5Cx3c')};\n</script>\n`
);
