// JALANGI DO NOT INSTRUMENT
// @ts-check
/// <reference types="../types.d.ts" />

/**
 * @file DataFlowAnalyzer — 运行时 SSA 数据流分析器。
 *
 * 消费 Jani 运行时（JalangiRuntime）产生的 log 条目，在 log 上执行：
 *   1. **SSA 化**：为每次赋值创建唯一寄存器 ID（registerID），维护 LastWrite 表；
 *   2. **别名追踪**：通过 OID 关联所有持有同一对象引用的变量；
 *   3. **Backward Slicing**：从目标寄存器出发，回溯所有影响其值的赋值链，
 *      还原出被混淆代码中隐藏的算法逻辑。
 *
 * 典型使用场景：
 *   - 还原 VMP/控制流混淆算法逻辑
 *   - 污点分析（标记 fetch/cookie 等为污点源，追踪传播路径）
 *   - 逆向切片（从已知输出逆推输入）
 *
 * ### Log 条目格式（由 JalangiRuntime 的分析插件或用户代码手动提供）
 *
 * 每条 log 条目是一个普通对象，支持以下字段：
 *
 * ```js
 * // W（write）条目
 * { type: 'W', iid, scopeId, callId, contextId, name, value, oid }
 *
 * // R 或 Rl（read）条目
 * { type: 'R', iid, scopeId, callId, contextId, name, value }
 *
 * // P（putField）条目
 * { type: 'P', iid, baseOid, offset, value }
 *
 * // G（getField）条目
 * { type: 'G', iid, baseOid, offset, value }
 *
 * // F / M（function/method call）条目
 * { type: 'F', iid, callId, result }
 * ```
 *
 * 其中 `scopeId`、`callId`、`contextId` 均来自 JalangiRuntime（Wave 1-4 + Wave 5 实现）。
 *
 * @module DataFlowAnalyzer
 */

import {
    $push, $shift, $sort, $map, $from, $freeze, $filter,
    $strSplit, $join, $slice,
} from './NativeProxy.js';

// ── 模块级常量 ────────────────────────────────────────────────────────────────

/**
 * 寄存器类型枚举
 * @type {Readonly<{ WRITE: 'W', ARG: 'A', RETURN: 'R', PUTFIELD: 'P', UNKNOWN: 'U' }>}
 */
export const REG_TYPE = $freeze({
    WRITE:     'W',   // 变量赋值
    ARG:       'A',   // 函数参数传入
    RETURN:    'R',   // 函数调用返回值
    PUTFIELD:  'P',   // 属性写入（对象版本 bump）
    UNKNOWN:   'U',   // 初始/未知值（无来源记录）
});

// ── DataFlowAnalyzer ──────────────────────────────────────────────────────────

/**
 * DataFlowAnalyzer — 运行时 SSA 数据流分析器。
 *
 * 使用方式：
 * ```js
 * import { DataFlowAnalyzer } from './DataFlowAnalyzer.js';
 *
 * const dfa = new DataFlowAnalyzer();
 *
 * // 实时处理（在分析插件的 write/read/putField 回调中调用）
 * dfa.processWrite({ iid: 8, scopeId: 0, callId: 1, name: 'x', value: 1, oid: null });
 * dfa.processRead({ scopeId: 0, callId: 1, name: 'x' });
 * dfa.processWrite({ iid: 16, scopeId: 0, callId: 1, name: 'y', value: 2, oid: null });
 *
 * // 批量处理（处理收集好的 log 数组）
 * dfa.processLog(logEntries);
 *
 * // Backward slicing
 * const slice = dfa.backwardSlice(targetRegId);
 * ```
 */
export class DataFlowAnalyzer {

    // ── 私有字段 ─────────────────────────────────────────────────────────────

    /**
     * SSA 寄存器表：registerID → RegisterEntry
     *
     * RegisterEntry：
     * ```js
     * {
     *   regId:    number,          // 全局唯一 ID（单调递增）
     *   type:     REG_TYPE,        // 寄存器类型
     *   iid:      number,          // 产生此赋值的指令 ID
     *   scopeId:  number,          // 变量所在词法作用域 ID
     *   callId:   number,          // 调用帧 ID
     *   contextId:number,          // 异步上下文 ID
     *   name:     string,          // 变量名
     *   value:    *,               // 赋值时的具体值（运行时）
     *   oid:      number|null,     // 若值为对象，对应 OID；否则 null
     *   sources:  Set<number>,     // 此赋值依赖的源寄存器 ID 集合（backward slice 边）
     * }
     * ```
     */
    #registers = new Map();

    /**
     * 当前活跃的 LastWrite 表：`${scopeId}:${callId}:${name}` → registerID。
     * 每次变量被写入时更新，读取时查询以获取 SSA 源寄存器。
     */
    #lastWrite = new Map();

    /**
     * OID 版本号表：oid → currentVersion。
     * 每次 P（putField）时递增；分析器通过版本号检测对象属性是否发生变化。
     */
    #oidVersions = new Map();

    /**
     * 别名表：`${scopeId}:${callId}:${name}` → oid。
     * 当变量持有对象引用时（由 W 条目的 oid 字段驱动），更新此表。
     */
    #aliasTable = new Map();

    /**
     * 待 pending 的读取源集合。
     * 在调用 processRead() 后，将已读到的源寄存器 ID 暂存在这里；
     * 下一次 processWrite() 调用时消费，将其作为 sources 关联到新寄存器。
     */
    #pendingReadSources = null;

    /** 全局单调递增的寄存器 ID 计数器 */
    #regIdCounter = 0;

    // ── 公开接口 ─────────────────────────────────────────────────────────────

    /**
     * 处理一条 W（write）log 条目。
     * 为此次赋值创建新的 SSA 寄存器，更新 LastWrite 表，
     * 消费 #pendingReadSources（由上一次 processRead 暂存的源寄存器集合）。
     *
     * @param {object} entry  W 条目（见模块注释中的格式说明）
     * @returns {number}  新分配的寄存器 ID
     */
    processWrite(entry) {
        const {
            iid       = 0,
            scopeId   = 0,
            callId    = 0,
            contextId = 0,
            name      = '',
            value,
            oid       = null,
        } = entry;

        const regId  = ++this.#regIdCounter;
        const key    = `${scopeId}:${callId}:${name}`;
        const sources = this.#pendingReadSources ?? new Set();
        this.#pendingReadSources = null;

        /** @type {import('../types.js').RegisterEntry} */
        const reg = {
            regId,
            type:      REG_TYPE.WRITE,
            iid,
            scopeId,
            callId,
            contextId,
            name,
            value,
            oid,
            sources,
        };

        this.#registers.set(regId, reg);
        this.#lastWrite.set(key, regId);

        // 更新别名表
        if (oid !== null && oid !== undefined) {
            this.#aliasTable.set(key, oid);
        } else {
            this.#aliasTable.delete(key);
        }

        return regId;
    }

    /**
     * 处理一条 R 或 Rl（read）log 条目。
     * 将读到的源寄存器 ID 累积到 #pendingReadSources，
     * 供下一次 processWrite() 消费，建立数据流依赖边。
     *
     * @param {object} entry  R/Rl 条目
     * @returns {number|undefined}  当前 active 寄存器 ID，若变量从未被写入则返回 undefined
     */
    processRead(entry) {
        const { scopeId = 0, callId = 0, name = '' } = entry;
        const key    = `${scopeId}:${callId}:${name}`;
        const regId  = this.#lastWrite.get(key);

        if (regId !== undefined) {
            if (!this.#pendingReadSources) {
                this.#pendingReadSources = new Set();
            }
            this.#pendingReadSources.add(regId);
        }

        return regId;
    }

    /**
     * 处理一条 P（putField）log 条目。
     * 递增 OID 版本号，并为所有持有该 OID 的变量创建新的 SSA 寄存器
     * （因为对象属性变化，持有该对象引用的变量的"语义值"也发生了变化）。
     *
     * @param {object} entry  P 条目，含 { iid, baseOid, offset, value, callId, scopeId, contextId }
     */
    processPutField(entry) {
        const {
            iid       = 0,
            baseOid,
            offset    = '',
            value,
            callId    = 0,
            scopeId   = 0,
            contextId = 0,
        } = entry;

        if (baseOid === null || baseOid === undefined) return;

        const newVersion = (this.#oidVersions.get(baseOid) ?? 0) + 1;
        this.#oidVersions.set(baseOid, newVersion);

        // 为所有持有 baseOid 的变量创建新的版本寄存器
        for (const [key, mappedOid] of this.#aliasTable) {
            if (mappedOid !== baseOid) continue;

            const regId  = ++this.#regIdCounter;
            // 防御性处理：变量名理论上不含 ':'，但用 slice(2).join(':') 避免将来引入时静默截断。
            const _parts  = $strSplit(key, ':');
            const kScopeId = _parts[0];
            const kCallId  = _parts[1];
            const kName    = $join($slice(_parts, 2), ':');

            /** @type {import('../types.js').RegisterEntry} */
            const reg = {
                regId,
                type:     REG_TYPE.PUTFIELD,
                iid,
                scopeId:  Number(kScopeId),
                callId:   Number(kCallId),
                contextId,
                name:     kName,
                value:    undefined, // 对象引用本身未变，属性变了
                oid:      baseOid,
                oidVersion: newVersion,
                offset,
                fieldValue: value,
                sources:  new Set($filter([this.#lastWrite.get(key) ?? -1], x => x !== -1)),
            };

            this.#registers.set(regId, reg);
            this.#lastWrite.set(key, regId);
        }
    }

    /**
     * 处理一条函数调用返回值（F/M）条目。
     * 如果调用的结果被赋值给某个变量，这条记录作为"源"用于后续的 processWrite。
     *
     * @param {object} entry  含 { iid, callId, contextId, result, oid }
     * @returns {number}  新建的返回值寄存器 ID
     */
    processCallReturn(entry) {
        const {
            iid       = 0,
            callId    = 0,
            contextId = 0,
            result,
            oid       = null,
        } = entry;

        const regId = ++this.#regIdCounter;
        const sources = this.#pendingReadSources ?? new Set();
        this.#pendingReadSources = null;

        const reg = {
            regId,
            type:     REG_TYPE.RETURN,
            iid,
            scopeId:  -1,  // 返回值不属于特定变量作用域
            callId,
            contextId,
            name:     '<return>',
            value:    result,
            oid,
            sources,
        };

        this.#registers.set(regId, reg);

        // 将返回值寄存器加入 pendingReadSources，供接下来的 W 消费
        this.#pendingReadSources = new Set([regId]);

        return regId;
    }

    /**
     * 批量处理 log 条目数组。
     * log 条目按 `type` 字段分发到对应的处理方法。
     *
     * @param {Array<object>} entries  log 条目数组（按时间顺序）
     */
    processLog(entries) {
        for (const entry of entries) {
            switch (entry.type) {
                case 'W':  this.processWrite(entry);      break;
                case 'R':
                case 'Rl': this.processRead(entry);       break;
                case 'P':  this.processPutField(entry);   break;
                case 'F':
                case 'M':  this.processCallReturn(entry); break;
                default:   /* ignore unknown types */     break;
            }
        }
    }

    // ── 查询 API ─────────────────────────────────────────────────────────────

    /**
     * Backward Slicing：从目标寄存器出发，BFS 回溯所有影响其值的赋值寄存器链。
     * 返回按 iid 升序排列的寄存器列表（还原时间顺序）。
     *
     * @param {number} targetRegId  目标寄存器 ID（终点）
     * @returns {RegisterEntry[]}   影响目标值的所有赋值，按时间升序
     */
    backwardSlice(targetRegId) {
        const visited = new Set();
        const result  = [];
        const queue   = [targetRegId];

        while (queue.length > 0) {
            const regId = $shift(queue);
            if (visited.has(regId)) continue;
            visited.add(regId);

            const reg = this.#registers.get(regId);
            if (!reg) continue;

            $push(result, reg);

            for (const srcRegId of reg.sources) {
                if (!visited.has(srcRegId)) {
                    $push(queue, srcRegId);
                }
            }
        }

        // 按 regId 升序排列（而非 iid）以正确反映运行时执行顺序。
        // iid 是编译时静态分配的，同一指令在循环中多次执行时 iid 相同，无法区分执行顺序；
        // regId 是单调递增的运行时序号，才能正确还原执行时间顺序。
        return $sort(result, (a, b) => a.regId - b.regId);
    }

    /**
     * 返回指定变量的最新 SSA 寄存器 ID。
     *
     * @param {number} scopeId  词法作用域 ID
     * @param {number} callId   调用帧 ID
     * @param {string} name     变量名
     * @returns {number|undefined}  当前 active 寄存器 ID，若未写入过则 undefined
     */
    getLastWrite(scopeId, callId, name) {
        return this.#lastWrite.get(`${scopeId}:${callId}:${name}`);
    }

    /**
     * 返回指定寄存器 ID 对应的寄存器详情。
     *
     * @param {number} regId  寄存器 ID
     * @returns {RegisterEntry|undefined}
     */
    getRegister(regId) {
        return this.#registers.get(regId);
    }

    /**
     * 返回所有已记录寄存器的数量（用于调试/统计）。
     *
     * @returns {number}
     */
    get registerCount() {
        return this.#registers.size;
    }

    /**
     * 返回 OID 的当前版本号。
     *
     * @param {number} oid  对象 ID
     * @returns {number}    版本号（0 = 从未被 putField 修改过）
     */
    getOidVersion(oid) {
        return this.#oidVersions.get(oid) ?? 0;
    }

    /**
     * 查询变量是否通过别名持有某个 OID。
     *
     * @param {number} scopeId
     * @param {number} callId
     * @param {string} name
     * @returns {number|undefined}  该变量当前持有的 OID，若无则 undefined
     */
    getAlias(scopeId, callId, name) {
        return this.#aliasTable.get(`${scopeId}:${callId}:${name}`);
    }

    /**
     * 找到所有当前持有指定 OID 的变量（别名集合）。
     *
     * @param {number} targetOid  目标 OID
     * @returns {Array<{scopeId: number, callId: number, name: string}>}
     */
    getAliasesForOid(targetOid) {
        const aliases = [];
        for (const [key, oid] of this.#aliasTable) {
            if (oid !== targetOid) continue;
            const parts = $strSplit(key, ':');
            $push(aliases, {
                scopeId: Number(parts[0]),
                callId:  Number(parts[1]),
                name:    $join($slice(parts, 2), ':'), // 变量名本身不含 ':'，但防御性处理
            });
        }
        return aliases;
    }

    /**
     * 重置分析器状态（开始处理新一轮 log 序列）。
     */
    reset() {
        this.#registers.clear();
        this.#lastWrite.clear();
        this.#oidVersions.clear();
        this.#aliasTable.clear();
        this.#pendingReadSources = null;
        this.#regIdCounter = 0;
    }

    /**
     * 将所有寄存器导出为可序列化的 JSON 对象（用于离线分析）。
     * Set 类型的 sources 字段转换为数组。
     *
     * @returns {object[]}
     */
    exportRegisters() {
        return $map($from(this.#registers.values()), reg => ({
            ...reg,
            sources: $from(reg.sources),
        }));
    }
}
