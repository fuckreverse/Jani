// JALANGI DO NOT INSTRUMENT

/**
 * @file iidToLocation — 将 (sid, iid) 对映射回源码位置字符串。
 *
 * 使用方式（推荐）：
 *   import { createIidToLocation } from './iidToLocation.js';
 *   const { iidToLocation, getGlobalIID } = createIidToLocation(J$);
 *
 * 向后兼容：本文件同时将两个函数安装到 sandbox 上，
 * 使旧代码的 J$.iidToLocation(sid, iid) 继续工作。
 */

/**
 * 为给定的 sandbox（通常是 J$）创建 iidToLocation 和 getGlobalIID 函数，
 * 并将它们安装到 sandbox 上。
 *
 * @param {object} sandbox  - J$ 全局对象（需含 smap、sid 属性）
 * @returns {{ iidToLocation: Function, getGlobalIID: Function }}
 */
export function createIidToLocation(sandbox) {
    /**
     * 将 (sid, iid) 或 "sid:iid" 字符串转为可读位置字符串。
     *
     * @param {number|string} sid  脚本 ID，或 "sid:iid" 格式的 giid 字符串
     * @param {number} [iid]       指令 ID（当 sid 为数字时使用）
     * @returns {string}
     */
    function iidToLocation(sid, iid) {
        if (!sandbox.smap) return String(sid);

        let gid = sid;

        // 支持 "sid:iid" 格式的 giid 字符串
        if (typeof sid === 'string' && sid.includes(':')) {
            const parts = sid.split(':');
            iid = parseInt(parts[1]);
            sid = parseInt(parts[0]);
        } else {
            gid = `${sid}:${iid}`;
        }

        const entry = sandbox.smap[sid];
        if (!entry) return String(sid);

        let fname = entry.originalCodeFileName;

        // 嵌套 eval：递归拼接 eval 调用位置
        if (entry.evalSid !== undefined) {
            fname = fname + iidToLocation(entry.evalSid, entry.evalIid);
        }

        const arr = entry[iid];
        if (arr) {
            // 浏览器环境：生成可点击链接（当 sandbox.Results 存在时）
            if (sandbox.Results) {
                return `<a href="javascript:iidToDisplayCodeLocation('${gid}');">(${fname}:${arr[0]}:${arr[1]}:${arr[2]}:${arr[3]})</a>`;
            }
            return `(${fname}:${arr[0]}:${arr[1]}:${arr[2]}:${arr[3]})`;
        }

        return `(${fname}:iid${iid})`;
    }

    /**
     * 返回全局唯一的 IID 字符串（"sid:iid" 格式）。
     * @param {number} iid
     * @returns {string}
     */
    function getGlobalIID(iid) {
        return `${sandbox.sid}:${iid}`;
    }

    // 安装到 sandbox，向后兼容旧式 J$.iidToLocation(...)
    sandbox.iidToLocation = iidToLocation;
    sandbox.getGlobalIID  = getGlobalIID;

    return { iidToLocation, getGlobalIID };
}
