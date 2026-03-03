// JALANGI DO NOT INSTRUMENT

/**
 * @file ProcessCoverage —— 将多轮测试的 coverage*.json 汇总为 allcoverage.json。
 *
 * 独立运行：
 *   node src/js/sample_analyses/coverage/ProcessCoverage.js 1
 *   （参数 1 = 分支覆盖，2 = 语句覆盖）
 *
 * 使用流程（见文件末尾注释）：
 *   1. 用 instrument_folder_coverage.sh 插桩 JS 目录
 *   2. 在顶层 mocha 测试前加入 mocha_prefix.js
 *   3. 运行 mocha，生成 coverage0.json, coverage1.json, …
 *   4. 运行本文件：node ProcessCoverage.js 1|2
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

const stmtMap = {};
const testCov = [];
const coverageType = Number(process.argv[2]) || 1;

let i    = 0;
let file = `coverage${i}.json`;

while (existsSync(file)) {
    const coverage = JSON.parse(readFileSync(file, 'utf8'));
    const fileMap  = {};

    for (const jsFile of Object.keys(coverage)) {
        const smapFile = jsFile.slice(0, -3) + '_jalangi_.json';
        if (existsSync(smapFile)) {
            const jsFileOrg = jsFile.slice(0, -3) + '.org';
            let smapNew     = stmtMap[jsFileOrg];
            const smap      = JSON.parse(readFileSync(smapFile, 'utf8'));

            if (smapNew === undefined) {
                smapNew = {};
                stmtMap[jsFileOrg] = smapNew;
            }

            const oldCoverage = coverage[jsFile];
            const newCoverage = [];
            for (const j of Object.keys(oldCoverage)) {
                if (oldCoverage.hasOwnProperty(j) && (Number(process.argv[2]) | 0) === oldCoverage[j]) {
                    newCoverage.push(j);
                    const loc = (j % 8 === 7) ? smap[(j | 0) + 1] : smap[j];
                    smapNew[j] = {
                        start: { line: loc[0], column: loc[1] - 1 },
                        end:   { line: loc[2], column: loc[3] - 1 },
                    };
                }
            }
            fileMap[jsFileOrg] = newCoverage;
        }
    }

    testCov.push(fileMap);
    i++;
    file = `coverage${i}.json`;
}

writeFileSync('allcoverage.json', JSON.stringify({ statementMap: stmtMap, testCov }, null, '\t'), 'utf8');
console.log(`Wrote allcoverage.json (${i} test(s))`);
