// JALANGI DO NOT INSTRUMENT

/**
 * @file FrameAnalysis —— Jalangi 分析插件：维护 shadow 帧栈，追踪变量所属函数帧。
 *
 * 依赖 Frames.js（自动 import）。
 *
 * @author Koushik Sen / Marija Selakovic
 */

import { Frames } from './Frames.js';

export class FrameAnalysisPlugin {
    constructor(sandbox) {
        this._sandbox = sandbox;
        const frames   = new Frames(this._sandbox);
        this._frames   = frames;
        this._sandbox.frames = frames;   // 其他分析可通过 sandbox.frames 访问
    }

    evalLiteral(iid, val, hasGetterSetter) {
        if (typeof val === 'function') {
            this._frames.defineFunction(val);
        }
    }

    declareVar(iid, name, val, isArgument, argumentIndex, isCatchParam) {
        this._frames.initialize(name);
    }

    functionEnter(iid, f, dis, args) {
        this._frames.functionEnter(f);
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        this._frames.functionReturn();
    }

    scriptEnter(iid, instrumentedFileName, originalFileName) {
        this._frames.scriptEnter();
    }

    scriptExit(iid, wrappedExceptionVal) {
        this._frames.scriptReturn();
    }

    instrumentCodePre(iid, code) {
        this._frames.evalBegin();
    }

    instrumentCode(iid, newCode, newAst) {
        this._frames.evalEnd();
    }
}
