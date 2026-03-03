// JALANGI DO NOT INSTRUMENT

/*
 * Copyright (c) 2014 Samsung Electronics Co., Ltd.
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
 * @file Dsjs —— 动态类型统计分析（数组均匀性、对象哈希、for-in 等）。
 * @author Koushik Sen
 *
 * 运行示例：
 *   python scripts/dsjs.py tests/octane/richards
 *   open jalangi_tmp/index.html
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 辅助工具 ───────────────────────────────────────────────────────────────

function isArr(obj) {
    return Array.isArray(obj) || (obj && obj.constructor && (
        obj instanceof Uint8Array    || obj instanceof Uint16Array   ||
        obj instanceof Uint32Array   || obj instanceof Uint8ClampedArray ||
        obj instanceof ArrayBuffer   || obj instanceof Int8Array    ||
        obj instanceof Int16Array    || obj instanceof Int32Array   ||
        obj instanceof Float32Array  || obj instanceof Float64Array
    ));
}

function isNormalNumber(num) {
    if (typeof num === 'number' && !isNaN(num)) return true;
    if (typeof num === 'string' && (parseInt(num, 10) + '' === num)) return true;
    return false;
}

// ─── 分析类 ─────────────────────────────────────────────────────────────────

export class DsjsAnalysis {
    constructor(sandbox) {
        this._sandbox        = sandbox;
        const C              = this._sandbox.Constants;
        this._SPECIAL_PROP   = C.SPECIAL_PROP + 'M';
        this._HOP            = C.HOP;
        this._hasGetterSetter = C.hasGetterSetter;
        this._iidToLocation  = this._sandbox.iidToLocation.bind(this._sandbox);

        this._objectId           = 1;
        this._info               = {};
        this._isCallingConstructor = false;
        this._constructorFun     = null;
        this._thisStack          = [];
        this._currThis           = undefined;
        this._scriptName         = null;
    }

    // ── shadow 对象管理 ──────────────────────────────────────────────────────

    _createShadowObject(iid, val) {
        const type = typeof val;
        if ((type === 'object' || type === 'function') && val !== null && !this._HOP(val, this._SPECIAL_PROP)) {
            try {
                Object.defineProperty(val, this._SPECIAL_PROP, { enumerable: false, writable: true, configurable: true });
            } catch { /* DOM 对象不可扩展，忽略 */ }
            try {
                val[this._SPECIAL_PROP] = Object.create(null);
                val[this._SPECIAL_PROP][this._SPECIAL_PROP] = this._objectId;
                this._objectId += 2;
                val[this._SPECIAL_PROP].iid = iid;
            } catch { /* 忽略 */ }
        }
    }

    _getShadowObject(iid, val) {
        this._createShadowObject(iid, val);
        const type = typeof val;
        if ((type === 'object' || type === 'function') && val !== null && this._HOP(val, this._SPECIAL_PROP)) {
            return val[this._SPECIAL_PROP];
        }
        return undefined;
    }

    // ── 统计辅助 ─────────────────────────────────────────────────────────────

    _inc(hash, ...keys) {
        let map = hash;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!map[key]) map[key] = { count: 0 };
            map[key].count++;
            if (i < keys.length - 1) {
                map[key].details ??= {};
                map = map[key].details;
            }
        }
    }

    _updateSObjArrayNonUniformity(iid, sobj, elem) {
        if (!sobj.typeInitialized) {
            sobj.type            = typeof elem;
            sobj.typeInitialized = true;
            sobj.isUniform       = true;
        } else if (sobj.isUniform) {
            sobj.isUniform = (sobj.type === typeof elem);
            if (!sobj.isUniform) {
                this._inc(this._info,
                    '# of instructions at which an array becomes nonuniform',
                    `times allocated at IID:${sobj.iid}`,
                    `times get nonuniform at IID:${iid}`);
            }
        }
    }

    _updateSObjObjectNonUniformity(iid, sobj, elem) {
        if (sobj?.isDynamic) {
            if (!sobj.typeInitialized) {
                sobj.type            = typeof elem;
                sobj.typeInitialized = true;
                sobj.isUniform       = true;
            } else if (sobj.isUniform) {
                sobj.isUniform = (sobj.type === typeof elem);
                if (!sobj.isUniform) {
                    this._inc(this._info,
                        '# of instructions at which object hashes become nonuniform',
                        `times allocated at IID:${sobj.iid}`,
                        `times get nonuniform at IID:${iid}`);
                }
            }
        }
    }

    _checkObjectUniformity(iid, sobj, obj, elem) {
        if (!sobj.isDynamic) {
            sobj.isDynamic = true;
            this._inc(this._info,
                '# of instructions at which an object become an hashtable',
                `times allocated at IID:${sobj.iid}`,
                `times become hash at IID:${iid}`);
            for (const p in obj) {
                if (!this._hasGetterSetter(obj, p, true)) {
                    this._updateSObjObjectNonUniformity(iid, sobj, obj[p]);
                }
            }
        }
        if (sobj.isDynamic) {
            this._updateSObjObjectNonUniformity(iid, sobj, elem);
        }
    }

    _checkArrayUniformity(iid, val) {
        if (isArr(val)) {
            this._inc(this._info, '# of arrays allocated');
            const sobj = this._getShadowObject(iid, val);
            for (let i = 0; i < val.length; i++) {
                this._updateSObjArrayNonUniformity(iid, sobj, val[i]);
            }
        }
    }

    _getCreateObjectInfo(iid, obj, isPrototype) {
        if (!isArr(obj) && typeof obj === 'object') {
            const sobj = this._getShadowObject(iid, obj);
            if (sobj && sobj.isUsedInForIn === undefined) {
                this._inc(this._info, '# of objects allocated (excluding arrays and functions)');
                sobj.isUsedInForIn = false;
                sobj.isPrototype   = isPrototype;
            }
            return sobj;
        }
        return undefined;
    }

    _forInUse(iid, obj) {
        const sobj = this._getCreateObjectInfo(iid, obj, false);
        if (sobj && !sobj.isUsedInForIn) {
            sobj.isUsedInForIn = true;
            this._inc(this._info,
                '# of instructions where for-in is called on an object',
                `times allocated at IID:${sobj.iid}`,
                `times called for-in at IID:${iid}`);
        }
    }

    // ── 分析钩子 ─────────────────────────────────────────────────────────────

    invokeFunPre(iid, f, base, args, isConstructor, isMethod) {
        const protoMethods = [
            'concat', 'indexOf', 'join', 'lastIndexOf', 'pop',
            'push', 'reverse', 'shift', 'slice', 'sort', 'splice', 'unshift',
        ];
        for (const m of protoMethods) {
            if (f === Array.prototype[m]) {
                this._inc(this._info, `times Array.prototype.${m} called`);
                break;
            }
        }
        this._isCallingConstructor = isConstructor;
        this._constructorFun       = f;
        return { f, base, args, skip: false };
    }

    invokeFun(iid, f, base, args, result, isConstructor, isMethod) {
        const giid = this._sandbox.getGlobalIID(iid);
        if (isConstructor) {
            this._checkArrayUniformity(giid, result);
            this._getCreateObjectInfo(giid, result, false);
        }
        return { result };
    }

    literal(iid, val, hasGetterSetter) {
        const giid = this._sandbox.getGlobalIID(iid);
        this._checkArrayUniformity(giid, val);
        this._getCreateObjectInfo(giid, val, false);
        return { result: val };
    }

    forinObject(iid, val) {
        const giid = this._sandbox.getGlobalIID(iid);
        this._forInUse(giid, val);
        return { result: val };
    }

    getField(iid, base, offset, val) {
        const giid = this._sandbox.getGlobalIID(iid);
        if (typeof base === 'function' && offset === 'prototype') {
            this._getCreateObjectInfo(giid, val, true);
        }
        if (!isArr(base) && typeof base === 'object') {
            this._inc(this._info, '# of instructions where an object property is read');
            if (!this._HOP(base, offset)) {
                if (typeof val === 'function') {
                    this._inc(this._info, '# of instructions where an object property of type function is read from a prototype');
                } else {
                    this._inc(this._info,
                        '# of instructions where an object property of type non-function is read from a prototype',
                        `times read at IID:${giid}`,
                        `times read property named ${offset}`);
                }
            }
        }
        return { result: val };
    }

    putFieldPre(iid, base, offset, val) {
        const giid = this._sandbox.getGlobalIID(iid);
        if (isArr(base)) {
            this._inc(this._info, '# of instructions where an array property (including integer index) is written');
            if (isNormalNumber(offset) || offset === 'length') {
                if (offset === 'length') {
                    this._inc(this._info, '# of instructions where the length property of an array is written');
                } else if (offset < 0 || offset >= base.length) {
                    if (offset === base.length) {
                        this._inc(this._info, '# of instructions where an element is appended to an array', `times appended at IID:${giid}`);
                    } else {
                        this._inc(this._info, '# of instructions where an out of bound (excluding array.length index) array element is written', `time written at IID:${giid}`);
                    }
                }
            } else {
                this._inc(this._info, '# of instructions where a non-number property (excluding length) is written', `times written at IID:${giid}`, `times written property named ${offset}`);
            }
            const sobj = this._getShadowObject(giid, base);
            if (sobj) this._updateSObjArrayNonUniformity(giid, sobj, val);
        } else if (typeof base === 'object') {
            this._inc(this._info, '# of instructions where an object property is written');
            if (!this._HOP(base, offset) && base !== this._currThis) {
                const sobj = this._getCreateObjectInfo(giid, base, false);
                if (!sobj?.isPrototype) {
                    this._inc(this._info,
                        '# of instructions where an object property is added outside a literal or constructor',
                        `times added at IID:${giid}`,
                        `times added property named ${offset}`);
                    if (sobj) this._checkObjectUniformity(giid, sobj, base, val);
                }
            }
        }
        return { base, offset, val, skip: false };
    }

    functionEnter(iid, f, dis, args) {
        this._currThis = (this._isCallingConstructor && f === this._constructorFun) ? dis : undefined;
        this._thisStack.push(this._currThis);
    }

    functionExit(iid, returnVal, wrappedExceptionVal) {
        this._thisStack.pop();
        this._currThis = this._thisStack[this._thisStack.length - 1];
        return { returnVal, wrappedExceptionVal, isBacktrack: false };
    }

    scriptEnter(iid, val) {
        if (!this._scriptName) this._scriptName = val;
    }

    endExecution() {
        const contents = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
        writeFileSync('index.html', contents, 'utf8');
        appendFileSync('index.html',
            `<script>\n var flare = ${JSON.stringify(this._createTree(this._info, `Statistics for ${this._scriptName}`), null, 4)};\n flare.x0 = 0; flare.y0 = 0; update(root=flare);\n</script>`,
            'utf8');
    }

    _createTree(input, name, c) {
        const output   = { name, count: c };
        const children = [];
        if (input) {
            for (const key of Object.keys(input)) {
                const tmp   = input[key];
                const count = tmp.count;
                const idx   = key.indexOf('IID:');
                const txt   = idx >= 0 ? key.slice(0, idx) + this._iidToLocation(key.slice(idx + 4)) : key;
                children.push(this._createTree(tmp.details, `${txt} = ${count}`, count));
            }
        }
        children.sort((a, b) => b.count - a.count);
        if (children.length > 0) output.children = children;
        else output.size = 2000;
        return output;
    }
}
