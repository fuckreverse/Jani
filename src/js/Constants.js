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

// JALANGI DO NOT INSTRUMENT

// ─── 原生函数引用（防止被用户分析覆盖）──────────────────────────────────────────
const APPLY = Function.prototype.apply;
const CALL  = Function.prototype.call;
APPLY.apply = APPLY;
APPLY.call  = CALL;
CALL.apply  = APPLY;
CALL.call   = CALL;

const HAS_OWN_PROPERTY      = Object.prototype.hasOwnProperty;
const HAS_OWN_PROPERTY_CALL = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);

// ─── Jalangi 标识符前缀 ───────────────────────────────────────────────────────
const JALANGI_VAR    = 'J$';
const SPECIAL_PROP   = `*${JALANGI_VAR}*`;
const SPECIAL_PROP2  = `*${JALANGI_VAR}I*`;
const SPECIAL_PROP3  = `*${JALANGI_VAR}C*`;
const SPECIAL_PROP4  = `*${JALANGI_VAR}W*`;
const SPECIAL_PROP_SID = `*${JALANGI_VAR}SID*`;
const SPECIAL_PROP_IID = `*${JALANGI_VAR}IID*`;

const UNKNOWN = -1;

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 安全的 hasOwnProperty，同时兼容 __proto__ 键名 */
const HOP = (obj, prop) =>
    prop + '' === '__proto__' || CALL.call(HAS_OWN_PROPERTY, obj, prop);

function hasGetterSetter(obj, prop, isGetter) {
    if (typeof Object.getOwnPropertyDescriptor !== 'function') return true;
    let cur = obj;
    while (cur !== null) {
        if (typeof cur !== 'object' && typeof cur !== 'function') return false;
        const desc = Object.getOwnPropertyDescriptor(cur, prop);
        if (desc !== undefined) {
            if (isGetter && typeof desc.get === 'function') return true;
            if (!isGetter && typeof desc.set === 'function') return true;
        } else if (HOP(cur, prop)) {
            return false;
        }
        cur = Object.getPrototypeOf(cur);
    }
    return false;
}

export {
    APPLY,
    CALL,
    HAS_OWN_PROPERTY,
    HAS_OWN_PROPERTY_CALL,
    JALANGI_VAR,
    SPECIAL_PROP,
    SPECIAL_PROP2,
    SPECIAL_PROP3,
    SPECIAL_PROP4,
    SPECIAL_PROP_SID,
    SPECIAL_PROP_IID,
    UNKNOWN,
    HOP,
    hasGetterSetter,
};
