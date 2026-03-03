// JALANGI DO NOT INSTRUMENT

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

/**
 * @file AddCoverage —— 特征图（feature graph）管理与覆盖率统计。
 *
 * 可独立运行（ESM 顶层 await 不可用时用 --input-type=module），
 * 也可作为 Jalangi 分析挂载到 J$.Features。
 *
 * 导出：
 *   export const Features   — 静态方法集合
 *
 * 向后兼容：
 *   J$.Features.addCoverage(...)
 */

import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

const COVERAGE_TYPE        = 1;
const UNUSED_COVERAGE_TYPE = 3;
const FEATURES_FILE        = 'tmp/features.json';
const RESULT_FILE          = 'tmp/results.json';
const PREFIX_TEST_FILE     = 'tmpTestPrefix.js';
const POSTFIX_TEST_FILE    = 'tmpTestPostfix.js';
const TMP_TEST_FILE        = 'tmpTestFile.js';
const NEW_TEST_FILE_NAME   = 'newtest';
const MIN_TEST_FILE_NAME   = 'mintest';
const MAX_COST             = 100000;

// ─── Set 数据结构 ────────────────────────────────────────────────────────────

class CoverageSet {
    constructor(map) {
        if (map === undefined) {
            this.set   = false;
            this.count = 0;
        } else {
            this.set   = map.set;
            this.count = map.count;
        }
    }

    add(...args) {
        let base   = this;
        let offset = 'set';
        let val    = base[offset];
        for (const arg of args) {
            if (typeof val !== 'object') {
                base[offset] = val = { isFinal: val, children: Object.create(null) };
            }
            let valc = val.children[arg];
            if (valc === undefined) {
                valc = false;
                val.children[arg] = valc;
            }
            base   = val.children;
            offset = arg;
            val    = valc;
        }
        if (typeof val !== 'object') {
            if (base[offset] !== true) this.count++;
            base[offset] = true;
        } else {
            if (val.isFinal !== true) this.count++;
            val.isFinal = true;
        }
    }

    contains(...args) {
        let val = this.set;
        for (const arg of args) {
            if (typeof val !== 'object') return false;
            const valc = val.children[arg];
            if (valc === undefined) return false;
            val = valc;
        }
        return (typeof val !== 'object') ? val : val.isFinal;
    }

    remove(...args) {
        let base   = this;
        let offset = 'set';
        let val    = base[offset];
        for (const arg of args) {
            if (typeof val !== 'object') return false;
            const valc = val.children[arg];
            if (valc === undefined) return false;
            base   = val.children;
            offset = arg;
            val    = valc;
        }
        if (typeof val !== 'object') {
            if (base[offset] === false) return false;
            this.count--;
            base[offset] = false;
        } else {
            if (val.isFinal === false) return false;
            this.count--;
            val.isFinal = false;
        }
        return true;
    }

    clone() {
        const ret = new CoverageSet();
        this.forEach(null, (...a) => ret.add(...a));
        return ret;
    }

    forEach(dis, f) {
        _setForEach(this.set, f, dis);
    }

    split(coverage) {
        const intersection = new CoverageSet();
        const difference   = new CoverageSet();
        this.forEach(null, (...args) => {
            if (_getMapElement(coverage, args) === COVERAGE_TYPE) {
                intersection.add(...args);
                _putMapElement(coverage, args, UNUSED_COVERAGE_TYPE);
            } else {
                difference.add(...args);
            }
        });
        return { intersection, difference };
    }

    size()    { return this.count; }
    isEmpty() { return this.count === 0; }

    print() {
        let ret = '[';
        let flag = true;
        this.forEach(null, (...args) => {
            if (!flag) ret += ', ';
            flag = false;
            ret += args.join(':');
        });
        ret += ']';
        process.stdout.write(ret);
    }
}

function _setForEach(obj, f, dis, ...prefix) {
    if (obj === true || (typeof obj === 'object' && obj && obj.isFinal)) {
        f.call(dis, ...prefix);
    }
    if (typeof obj === 'object' && obj && obj.children) {
        for (const key of Object.keys(obj.children)) {
            _setForEach(obj.children[key], f, dis, ...prefix, key);
        }
    }
}

function _getMapElement(obj, args) {
    let ret = obj;
    for (const a of args) {
        ret = ret?.[a];
        if (ret === undefined) return ret;
    }
    return ret;
}

function _putMapElement(obj, args, val) {
    let ret = obj;
    for (let i = 0; i < args.length; i++) {
        if (i === args.length - 1) { ret[args[i]] = val; }
        else {
            ret = ret[args[i]];
            if (ret === undefined) return ret;
        }
    }
    return ret;
}

// ─── 特征图 ─────────────────────────────────────────────────────────────────

let features     = [];
let tests        = [];
let featureGraph = Object.create(null);

function _addEdge(x, y) {
    if (x === y) throw new Error(`x ${x} === y ${y}`);
    featureGraph[x] ??= Object.create(null);
    featureGraph[x][y] = true;
}
function _containsEdge(x, y) { return !!featureGraph[x]?.[y]; }
function _removeEdge(x, y) {
    if (!featureGraph[x]) return;
    delete featureGraph[x][y];
    if (Object.keys(featureGraph[x]).length === 0) delete featureGraph[x];
}
function _forEachEdge(x, f) {
    const children = featureGraph[x];
    if (children) Object.keys(children).forEach(y => f(y));
}
function _resetEdges(x, testIndex) {
    let mod = false;
    _forEachEdge(x, y => {
        if (!features[y].tests.contains(testIndex)) {
            _removeEdge(x, y);
            mod = true;
        }
    });
    return mod;
}

function _readData() {
    try {
        const data = JSON.parse(readFileSync(FEATURES_FILE, 'utf8'));
        features     = data.features;
        tests        = data.tests;
        featureGraph = data.featureGraph;
    } catch {
        features     = [];
        tests        = [];
        featureGraph = Object.create(null);
        console.log('Cannot read features data');
    }
    for (const feature of features) {
        feature.coverage = new CoverageSet(feature.coverage);
        feature.tests    = new CoverageSet(feature.tests);
    }
}

function _saveData() {
    try {
        writeFileSync(FEATURES_FILE, JSON.stringify({ features, tests, featureGraph }, null, '    '), 'utf8');
    } catch (e) {
        console.log('Cannot save feature data', e);
    }
}

function addCoverage(testCode, coverage, forceAdd) {
    _readData();

    const testIndex       = tests.length;
    let mod               = false;
    const modFeatures     = Object.create(null);
    const featuresCovered = Object.create(null);

    for (let i = 0; i < features.length; i++) {
        const feature = features[i];
        const split   = feature.coverage.split(coverage);
        if (!split.intersection.isEmpty() && !split.difference.isEmpty()) {
            const feature2 = { coverage: split.difference, tests: feature.tests.clone(), index: features.length };
            features.push(feature2);
            feature.coverage = split.intersection;
            feature.tests.add(testIndex);
            featuresCovered[feature.index]  = true;
            modFeatures[feature.index]      = true;
            mod = true;
            _addEdge(feature2.index, feature.index);
            _forEachEdge(feature.index, y => _addEdge(feature2.index, y));
            _resetEdges(feature.index, testIndex);
            Object.keys(featureGraph).forEach(x => {
                if (_containsEdge(x, feature.index) && x != feature2.index) {
                    _addEdge(x, feature2.index);
                }
            });
        } else if (!split.intersection.isEmpty()) {
            feature.tests.add(testIndex);
            featuresCovered[feature.index] = true;
            modFeatures[feature.index]     = true;
        }
    }

    const newFeature = new CoverageSet();
    for (const keyf of Object.keys(coverage)) {
        const o = coverage[keyf];
        for (const keyi of Object.keys(o)) {
            if (o[keyi] === COVERAGE_TYPE) newFeature.add(keyf, keyi);
        }
    }
    if (!newFeature.isEmpty()) {
        const feature = { coverage: newFeature, tests: new CoverageSet(), index: features.length };
        features.push(feature);
        feature.tests.add(testIndex);
        featuresCovered[feature.index] = true;
        featureGraph[feature.index]    = modFeatures;
        mod = true;
    }

    if (forceAdd) {
        tests.push(testCode);
        _saveData();
    }

    const results = { modified: mod, featuresCovered, testIndex };
    writeFileSync(RESULT_FILE, JSON.stringify(results, null, '    '), 'utf8');
    return results;
}

function getFeaturesFromTest(testIndex) {
    const ret = Object.create(null);
    features.forEach((f, i) => { if (f.tests.contains(testIndex)) ret[i] = true; });
    return ret;
}

function _getFeatureCountForTests() {
    const ret = Object.create(null);
    for (let i = 0; i < features.length; i++) {
        for (let j = 0; j < tests.length; j++) {
            if (features[i].tests.contains(j)) ret[j] = (ret[j] | 0) + 1;
        }
    }
    return ret;
}

function _getTestWithMinFeatures(featureCountForTests, testsSet) {
    let min = MAX_COST, ti;
    testsSet.forEach(null, testIndex => {
        if (min > featureCountForTests[testIndex]) {
            min = featureCountForTests[testIndex];
            ti  = testIndex;
        }
    });
    return { min, testIndex: ti };
}

function getTestsFromFeature(index) { return features[index].tests; }
function getTestCode(testIndex)     { return tests[testIndex]; }

// ─── Delta Debug ─────────────────────────────────────────────────────────────

function _deltaDebug(str, pred) {
    let $n   = 2;
    let cost = MAX_COST;
    outer: while (true) {
        const $len  = str.length;
        let $size = Math.floor($len / $n);
        while ($size >= 1) {
            let found = false, tmpn, tmpstr;
            for (let $i = 1; $i <= $n; $i++) {
                const str1 = str.slice(($i - 1) * $size, $i < $n ? $i * $size : undefined);
                if (pred(str1) <= cost) { tmpn = 2; tmpstr = str1; found = true; }
                const str2 = str.slice(0, ($i - 1) * $size) + ($i < $n ? str.slice($i * $size) : '');
                if (pred(str2) < cost) { tmpn = $n - 1; tmpstr = str2; found = true; }
            }
            if (found) { $n = tmpn; str = tmpstr; continue outer; }
            $n    *= 2;
            $size  = $len / $n;
        }
        return str;
    }
}

function getMinTestForEachFeature() {
    const shelljs = _require('shelljs');
    _readData();
    const featureCountForTests = _getFeatureCountForTests();
    let min;
    let newTestIndex = 0;

    for (let i = features.length - 1; i >= 0; i--) {
        const thisTests     = features[i].tests;
        let combinedTest    = '';
        thisTests.forEach(null, ti => { combinedTest += tests[ti]; });
        console.log('Running dd');

        const predicate = (str) => {
            const prefix  = readFileSync(PREFIX_TEST_FILE, 'utf8');
            const postfix = readFileSync(POSTFIX_TEST_FILE, 'utf8');
            writeFileSync(TMP_TEST_FILE, prefix + str + postfix, 'utf8');
            process.stdout.write('.');
            const result = shelljs.exec(`gtimeout 30s node ${TMP_TEST_FILE} > /dev/null 2>&1`);
            if (result.code !== 0) return MAX_COST + 1;
            const results = JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
            if (!results.featuresCovered[i]) return MAX_COST + 1;
            if (results.modified) {
                console.log(`New feature splitting test found: ${str}`);
                writeFileSync(`${NEW_TEST_FILE_NAME}${newTestIndex++}.js`, prefix + str + postfix, 'utf8');
                return MAX_COST + 1;
            }
            const curMin = Object.keys(results.featuresCovered).length;
            min = Math.min(min ?? MAX_COST, curMin);
            return curMin;
        };

        min = MAX_COST;
        const mintest  = _deltaDebug(combinedTest, predicate);
        const oldmins  = _getTestWithMinFeatures(featureCountForTests, thisTests);

        if (min < oldmins.min) {
            const prefix  = readFileSync(PREFIX_TEST_FILE, 'utf8');
            const postfix = readFileSync(POSTFIX_TEST_FILE, 'utf8');
            writeFileSync(`${MIN_TEST_FILE_NAME}${i}.js`, prefix + mintest + postfix, 'utf8');
            console.log(`Found minimal test old minimal features = ${oldmins.min} new minimal features ${min}`);
        } else {
            console.log(`Failed to find min test for feature ${i}`);
        }
        console.log('-- old minimal --\n', tests[oldmins.testIndex]);
        console.log('-- computed minimal --\n', mintest);
    }
}

// ─── 导出 ─────────────────────────────────────────────────────────────────────

export const Features = {
    Set: CoverageSet,
    addCoverage,
    getFeaturesFromTest,
    getTestsFromFeature,
    getTestCode,
    loadFeatures: _readData,
    storeFeatures: _saveData,
};

// 向后兼容：挂到 J$
if (typeof J$ !== 'undefined') {
    J$.Features = Features;
}

// 独立运行模式
const isMain = (typeof process !== 'undefined') &&
    process.argv[1] &&
    (new URL(import.meta.url)).pathname === process.argv[1];

if (isMain) {
    getMinTestForEachFeature();
}
