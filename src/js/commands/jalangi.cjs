#!/usr/bin/env node
/*
 * Copyright 2014 Samsung Information Systems America, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Author: Koushik Sen
// Author: Manu Sridharan

'use strict';

/* global J$ */

const argparse  = require('argparse');
const instUtil  = require('../instrument/instUtil');

const parser = new argparse.ArgumentParser({
    addHelp:     true,
    description: "Command-line utility to perform Jalangi2's instrumentation and analysis",
});
parser.addArgument(['--analysis'],        { help: 'absolute path to analysis file',  action: 'append' });
parser.addArgument(['--initParam'],       { help: 'initialization parameter, key:value', action: 'append' });
parser.addArgument(['--inlineIID'],       { help: 'Inline IID to location map', action: 'storeTrue' });
parser.addArgument(['--inlineSource'],    { help: 'Inline original source',  action: 'storeTrue' });
parser.addArgument(['--astHandlerModule'], { help: 'Path to AST handler module' });
parser.addArgument(['script_and_args'],   { help: 'script and CLI arguments', nargs: argparse.Const.REMAINDER });

const args       = parser.parseArgs();
const astHandler = args.astHandlerModule ? require(args.astHandlerModule) : null;

if (args.script_and_args.length === 0) {
    console.error('must provide script to record');
    process.exit(1);
}
const script = args.script_and_args.shift();

const Module         = require('module');
const path           = require('path');
const fs             = require('fs');
const FILESUFFIX1    = '_jalangi_';

const makeInstCodeFileName = (name) =>
    name.replace(/.js$/, `${FILESUFFIX1}.js`).replace(/.html$/, `${FILESUFFIX1}.html`);
const makeSMapFileName     = (name) => name.replace(/.js$/, '.json');

require('../headers').headerSources.forEach((header) => {
    require(`./../../../${header}`);
});

let initParam = null;
if (args.initParam) {
    initParam = {};
    for (const keyVal of args.initParam) {
        const parts = keyVal.split(':');
        if (parts.length !== 2) throw new Error(`invalid initParam ${keyVal}`);
        initParam[parts[0]] = parts[1];
    }
}
J$.initParams = initParam ?? {};

if (args.analysis) {
    args.analysis.forEach((src) => require(path.resolve(src)));
}

Module._extensions['.js'] = (mod, filename) => {
    const code         = fs.readFileSync(filename, 'utf8');
    const instFilename = makeInstCodeFileName(filename);
    const instCodeAndData = J$.instrumentCode({
        code,
        isEval:          false,
        origCodeFileName: filename,
        instCodeFileName: instFilename,
        inlineSourceMap:  !!args.inlineIID,
        inlineSource:     !!args.inlineSource,
    });
    instUtil.applyASTHandler(instCodeAndData, astHandler, J$);
    fs.writeFileSync(makeSMapFileName(instFilename), instCodeAndData.sourceMapString, 'utf8');
    fs.writeFileSync(instFilename, instCodeAndData.code, 'utf8');
    mod._compile(instCodeAndData.code, filename);
};

function startProgram() {
    const resolved = path.resolve(script);
    process.argv   = [process.argv[0], resolved, ...args.script_and_args];
    process.on('exit', () => J$.endExecution());
    Module.Module.runMain(resolved, null, true);
}

if (J$.analysis?.onReady) {
    J$.analysis.onReady(startProgram);
} else {
    startProgram();
}
