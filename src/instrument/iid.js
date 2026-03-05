/*
 * Copyright 2013 Samsung Information Systems America, Inc.
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

// JALANGI DO NOT INSTRUMENT

/**
 * IID (Instruction ID) 管理模块。
 *
 * 负责：
 *  - 维护三个独立的 IID 计数器（memIid、condIid、opIid）
 *  - 记录每个 IID 对应的源码位置（iidSourceInfo）
 *  - 提供 getIid / getCondIid / getOpIid 等分配函数
 *
 * IID 步长为 8，为同一 AST 节点的多个子操作预留空间
 * （如方法调用的 iid+2 用于内部 getField）。
 */

const IID_INC_STEP = 8;

// 当前文件相关的 IID 状态（每次调用 instrumentCode 前通过 initialize() 重置）
let condIid;
let memIid;
let opIid;

/** 当前正在插桩的 instrumented 文件名 */
let instCodeFileName;
/** 当前正在插桩的 original 文件名 */
let origCodeFileName;
/** iid -> [startLine, startCol, endLine, endCol] 的映射表 */
let iidSourceInfo;

// IID 值是整数，用 Babel NumericLiteral 节点。
const createLiteralAst = (name) => ({ type: 'NumericLiteral', value: name });

// ─── 源码位置记录 ─────────────────────────────────────────────────────────────

function printLineInfoAux(i, ast) {
    if (ast?.loc) {
        iidSourceInfo[i] = [
            ast.loc.start.line,
            ast.loc.start.column + 1,
            ast.loc.end.line,
            ast.loc.end.column + 1,
        ];
    }
}

const printIidToLoc        = (ast) => printLineInfoAux(memIid, ast);
/** iid+2 is reserved for the implicit getField inside a method call (see analysis.M) */
const printSpecialIidToLoc = (ast) => printLineInfoAux(memIid + 2, ast);
const printModIidToLoc     = (ast) => { printLineInfoAux(memIid, ast); printLineInfoAux(memIid + 2, ast); };
const printOpIidToLoc      = (ast) => printLineInfoAux(opIid, ast);
const printCondIidToLoc    = (ast) => printLineInfoAux(condIid, ast);

// ─── IID 分配 ─────────────────────────────────────────────────────────────────

function getIid() {
    const tmp = memIid;
    memIid += IID_INC_STEP;
    return createLiteralAst(tmp);
}

const getPrevIidNoInc = () => createLiteralAst(memIid - IID_INC_STEP);

function getCondIid() {
    const tmp = condIid;
    condIid += IID_INC_STEP;
    return createLiteralAst(tmp);
}

function getOpIid() {
    const tmp = opIid;
    opIid += IID_INC_STEP;
    return createLiteralAst(tmp);
}

// ─── 初始化与状态导出 ──────────────────────────────────────────────────────────

function initialize(forEval, instFile, origFile) {
    const adj = forEval ? IID_INC_STEP / 2 : 0;
    condIid = IID_INC_STEP + adj + 0;
    memIid  = IID_INC_STEP + adj + 1;
    opIid   = IID_INC_STEP + adj + 2;
    iidSourceInfo    = {};
    instCodeFileName = instFile ?? (forEval ? 'eval' : 'evalIndirect');
    origCodeFileName = origFile ?? (forEval ? 'eval' : 'evalIndirect');
}

/**
 * 返回当前 iidSourceInfo 的快照，用于插入到插桩代码头部。
 * nBranches 会在此时根据最终 condIid 计算。
 *
 * Q-1 修复：返回防御性副本（shallow spread），防止调用者修改返回值时污染内部
 * iidSourceInfo 对象（该对象在整个 instrumentCode 调用生命周期内持续使用）。
 */
function getSourceInfo() {
    iidSourceInfo.nBranches                  = (condIid / IID_INC_STEP - 1) * 2;
    iidSourceInfo.originalCodeFileName       = origCodeFileName;
    iidSourceInfo.instrumentedCodeFileName   = instCodeFileName;
    return { ...iidSourceInfo };
}

const getInstCodeFileName = () => instCodeFileName;
const getOrigCodeFileName = () => origCodeFileName;
const getCondIidCount     = () => condIid;
const getIidIncStep       = () => IID_INC_STEP;

// ─── 导出 ──────────────────────────────────────────────────────────────────────

export {
    initialize,
    getSourceInfo,
    getInstCodeFileName,
    getOrigCodeFileName,
    getCondIidCount,
    getIidIncStep,
    // iid 分配
    getIid,
    getPrevIidNoInc,
    getCondIid,
    getOpIid,
    // 位置记录
    printIidToLoc,
    printSpecialIidToLoc,
    printModIidToLoc,
    printOpIidToLoc,
    printCondIidToLoc,
};
