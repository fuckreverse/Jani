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
 * @file template —— 新分析模块模板。
 *
 * 使用方法：
 *   1. 复制本文件到新位置。
 *   2. 将 NameOfModule 替换为你的模块名。
 *   3. 在 headers.js 中添加本文件路径（用于浏览器 bundle）。
 *   4. 在 export 对象中添加你的功能。
 *
 * 在 J$ 环境下会自动挂载为 J$.NameOfModule。
 */

export const NameOfModule = {};

// 向后兼容
if (typeof J$ !== 'undefined' && typeof J$.NameOfModule === 'undefined') {
    J$.NameOfModule = NameOfModule;
}
