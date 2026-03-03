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

// Author: Manu Sridharan
// Author: Koushik Sen

'use strict';

/* global J$ */

const argparse = require('argparse');
const parser   = new argparse.ArgumentParser({
    addHelp:     true,
    description: "Command-line utility to perform Jalangi2's analysis (direct mode)",
});
parser.addArgument(['--analysis'],   { help: 'absolute path to analysis file', action: 'append' });
parser.addArgument(['--initParam'],  { help: 'initialization parameter, key:value', action: 'append' });
parser.addArgument(['script_and_args'], {
    help:  'script to record and CLI arguments',
    nargs: argparse.Const.REMAINDER,
});
const args = parser.parseArgs();

function runAnalysis(initParam) {
    if (args.script_and_args.length === 0) {
        console.error('must provide script to record');
        process.exit(1);
    }
    const script = args.script_and_args.shift();
    const path   = require('path');

    require('../headers').headerSources.forEach((header) => {
        require(`./../../../${header}`);
    });

    J$.initParams = initParam ?? {};
    if (args.analysis) {
        args.analysis.forEach((src) => require(path.resolve(src)));
    }

    function startProgram() {
        const resolved = path.resolve(script);
        process.argv   = [process.argv[0], resolved, ...args.script_and_args];
        process.on('exit', () => J$.endExecution());
        const mod = require('module').Module;
        mod.runMain(resolved, null, true);
    }

    if (J$.analysis?.onReady) {
        J$.analysis.onReady(startProgram);
    } else {
        startProgram();
    }
}

let initParam = null;
if (args.initParam) {
    initParam = {};
    for (const keyVal of args.initParam) {
        const parts = keyVal.split(':');
        if (parts.length !== 2) throw new Error(`invalid initParam ${keyVal}`);
        initParam[parts[0]] = parts[1];
    }
}
runAnalysis(initParam);
