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

// do not remove the following comment
// JALANGI DO NOT INSTRUMENT

/*jslint browser: true */
/*global J$ */

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

if (typeof J$ === 'undefined') {
    J$ = {};
}

(function (sandbox) {
    if (typeof sandbox.IIDManager !== 'undefined') {
        return;
    }

    var IID_INC_STEP = 8;

    // 当前文件相关的 IID 状态（每次调用 instrumentCode 前重置）
    var condIid;
    var memIid;
    var opIid;

    /** 当前正在插桩的 instrumented 文件名 */
    var instCodeFileName;
    /** 当前正在插桩的 original 文件名 */
    var origCodeFileName;
    /** iid -> [startLine, startCol, endLine, endCol] 的映射表 */
    var iidSourceInfo;

    // ─── Literal AST helper ──────────────────────────────────────────────────

    function createLiteralAst(name) {
        return {type: 'Literal', value: name};
    }

    // ─── 源码位置记录 ──────────────────────────────────────────────────────────

    function printLineInfoAux(i, ast) {
        if (ast && ast.loc) {
            iidSourceInfo[i] = [
                ast.loc.start.line,
                ast.loc.start.column + 1,
                ast.loc.end.line,
                ast.loc.end.column + 1
            ];
        }
    }

    function printIidToLoc(ast0) {
        printLineInfoAux(memIid, ast0);
    }

    /** iid+2 is reserved for the implicit getField inside a method call (see analysis.M) */
    function printSpecialIidToLoc(ast0) {
        printLineInfoAux(memIid + 2, ast0);
    }

    function printModIidToLoc(ast0) {
        printLineInfoAux(memIid, ast0);
        printLineInfoAux(memIid + 2, ast0);
    }

    function printOpIidToLoc(ast0) {
        printLineInfoAux(opIid, ast0);
    }

    function printCondIidToLoc(ast0) {
        printLineInfoAux(condIid, ast0);
    }

    // ─── IID 分配 ──────────────────────────────────────────────────────────────

    function getIid() {
        var tmpIid = memIid;
        memIid = memIid + IID_INC_STEP;
        return createLiteralAst(tmpIid);
    }

    function getPrevIidNoInc() {
        return createLiteralAst(memIid - IID_INC_STEP);
    }

    function getCondIid() {
        var tmpIid = condIid;
        condIid = condIid + IID_INC_STEP;
        return createLiteralAst(tmpIid);
    }

    function getOpIid() {
        var tmpIid = opIid;
        opIid = opIid + IID_INC_STEP;
        return createLiteralAst(tmpIid);
    }

    // ─── 初始化与状态导出 ────────────────────────────────────────────────────────

    function initialize(forEval, instFile, origFile) {
        var adj = forEval ? IID_INC_STEP / 2 : 0;
        condIid = IID_INC_STEP + adj + 0;
        memIid  = IID_INC_STEP + adj + 1;
        opIid   = IID_INC_STEP + adj + 2;
        iidSourceInfo = {};
        instCodeFileName = instFile || (forEval ? 'eval' : 'evalIndirect');
        origCodeFileName = origFile || (forEval ? 'eval' : 'evalIndirect');
    }

    /**
     * 返回当前 iidSourceInfo 的快照，用于插入到插桩代码头部。
     * nBranches 会在此时根据最终 condIid 计算。
     */
    function getSourceInfo() {
        iidSourceInfo.nBranches = (condIid / IID_INC_STEP - 1) * 2;
        iidSourceInfo.originalCodeFileName = origCodeFileName;
        iidSourceInfo.instrumentedCodeFileName = instCodeFileName;
        return iidSourceInfo;
    }

    function getInstCodeFileName() { return instCodeFileName; }
    function getOrigCodeFileName()  { return origCodeFileName; }
    function getCondIidCount()      { return condIid; }
    function getIidIncStep()        { return IID_INC_STEP; }

    // ─── 导出 ──────────────────────────────────────────────────────────────────

    sandbox.IIDManager = {
        initialize:             initialize,
        getSourceInfo:          getSourceInfo,
        getInstCodeFileName:    getInstCodeFileName,
        getOrigCodeFileName:    getOrigCodeFileName,
        getCondIidCount:        getCondIidCount,
        getIidIncStep:          getIidIncStep,
        // iid 分配
        getIid:                 getIid,
        getPrevIidNoInc:        getPrevIidNoInc,
        getCondIid:             getCondIid,
        getOpIid:               getOpIid,
        // 位置记录
        printIidToLoc:          printIidToLoc,
        printSpecialIidToLoc:   printSpecialIidToLoc,
        printModIidToLoc:       printModIidToLoc,
        printOpIidToLoc:        printOpIidToLoc,
        printCondIidToLoc:      printCondIidToLoc
    };

}(J$));

// exports J$.IIDManager
// depends on nothing
