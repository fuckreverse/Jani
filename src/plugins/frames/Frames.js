// JALANGI DO NOT INSTRUMENT

/**
 * @file Frames —— 维护函数调用帧栈（shadow frame），可追踪变量所属帧。
 *
 * 导出：
 *   export class Frames
 */

const SPECIAL_PROP_FRAMES = '*J$F*';

export class Frames {
    /**
     * @param {object} [sandbox]  J$ 运行时（用于读取 Constants）
     */
    constructor(sandbox) {
        this._constants  = sandbox?.Constants ?? {};
        this._frameStack = [Object.create(null)];
        this._frame      = this._frameStack[0];
        this._scriptCount = 0;
    }

    /** 初始化（声明）一个变量 */
    initialize(name) {
        this._frame[name] = undefined;
    }

    /**
     * 将函数 val 的帧关联设置为当前帧
     * （旧实现中通过 SPECIAL_PROP_FRAMES 记录定义时的帧）
     */
    defineFunction(val) {
        if (Object.defineProperty) {
            try {
                Object.defineProperty(val, SPECIAL_PROP_FRAMES, {
                    enumerable: false,
                    writable:   true,
                    configurable: true,
                });
            } catch { /* 某些函数不可扩展，忽略 */ }
        }
        if (typeof val === 'object' || typeof val === 'function') {
            val[SPECIAL_PROP_FRAMES] = this._frame;
        }
    }

    /** 函数进入：创建新帧，并从函数定义时的帧继承 SPECIAL_PROP_FRAMES */
    functionEnter(f) {
        const newFrame = Object.create(null);
        if (Object.defineProperty) {
            try {
                Object.defineProperty(newFrame, SPECIAL_PROP_FRAMES, {
                    enumerable: false,
                    writable:   true,
                    configurable: true,
                });
            } catch { /* ignore */ }
        }
        newFrame[SPECIAL_PROP_FRAMES] = f?.[SPECIAL_PROP_FRAMES];
        this._frameStack.push(newFrame);
        this._frame = newFrame;
    }

    /** 函数返回：弹出当前帧 */
    functionReturn() {
        this._frameStack.pop();
        this._frame = this._frameStack[this._frameStack.length - 1];
    }

    /** 脚本进入（eval 或顶层脚本） */
    scriptEnter() {
        this._scriptCount++;
        if (this._scriptCount > 1) {
            const newFrame = Object.create(null);
            newFrame[SPECIAL_PROP_FRAMES] = this._frameStack[0];
            this._frameStack.push(newFrame);
            this._frame = newFrame;
        }
    }

    /** 脚本退出 */
    scriptReturn() {
        if (this._scriptCount > 1) {
            this._frameStack.pop();
            this._frame = this._frameStack[this._frameStack.length - 1];
        }
        this._scriptCount--;
    }

    /** eval 开始 */
    evalBegin() { this.scriptEnter(); }

    /** eval 结束 */
    evalEnd() { this.scriptReturn(); }
}
