/**
 * I5_WebApiDetector.mjs — BOM/DOM Web API 调用检测
 *
 * 从 fields 表中识别对浏览器宿主对象（window / document / navigator / location /
 * localStorage / sessionStorage / XMLHttpRequest / fetch / performance 等）的
 * 属性访问与方法调用，写入 web_api_calls 表。
 *
 * 三级置信度：
 *   confirmed  — fields.base_oid 通过 oid_aliases 精确匹配到已知宿主对象变量名
 *   propagated — 该 OID 曾被 inferred 专属属性名确认过类型，后续同 OID 的访问传播此结论
 *   inferred   — 仅靠高专属性属性名/方法名启发式匹配，未能确认 receiver 身份
 *
 * 依赖：F1-EventIndex（fields / oid_aliases / events / smap 表）
 *       F3-CallGraphBuilder（call_edges 表，用于关联调用参数/返回值，可选）
 */
import BasePlugin from './BasePlugin.mjs';
import * as db from '../db/Database.mjs';
import { cfg } from '../Config.mjs';

// ─── 宿主对象分类规则 ────────────────────────────────────────────────────────
//
// 结构：
//   category  : 宿主对象分类（用于 UI 分组展示）
//   hostObj   : 推断的宿主对象名（UI 显示用）
//   varNames  : oid_aliases.var_name 精确匹配列表（用于 confirmed 检测）
//   properties: 属性名集合（用于 inferred 启发式检测）
//               若为 null 则"仅靠 varNames 确认，不做 inferred 独立检测"
//
// 匹配优先级：先 confirmed（oid_aliases），再 inferred（属性名）
// 同一 (event_id, property_name) 只写入一条，confirmed 优先于 inferred

// ─── 属性名的 inferred 筛选原则 ──────────────────────────────────────────────
//
// 只收录"命名高度专属"的属性名——即在正常业务代码里极不可能出现在非宿主对象上。
// 以下类别的词一律不放入 inferred 列表（只靠 confirmed 路径捕获）：
//   × 通用方法：open/close/stop/send/get/set/has/delete/append/clear/key/keys/
//              values/entries/clone/toString/valueOf/length/replace/reload/go/
//              back/forward/state/status/type/body/url/text/now/mark/measure/
//              timing/memory/save/restore/scale/rotate/fill/stroke/arc
//   × EventTarget 通用：stopPropagation/preventDefault/target/type 等
//     （这些词在任何 DOM 事件对象、Proxy、框架的事件系统中都会出现）
//   × XHR 实例字段：status/response/timeout/upload/withCredentials 等
//     （这些在 axios/fetch wrapper/自定义 HTTP 客户端里大量出现）
//   × fetch/Response 字段：json/text/blob/ok/headers/redirected/bodyUsed 等
//     （这些在 wrapper 对象上高频出现）
//   × canvas 操作：fill/stroke/save/restore/clip/rotate/scale/arc 等
//     （游戏引擎/可视化库里的普通方法）
//   × location 的 href/hash/search/host/pathname/replace：
//     在 Vue Router、React Router 的 route 对象上也存在
//
// 保留的词必须满足：在常见 npm 包 / 业务代码中，见到这个词几乎可以确定是宿主 API

const HOST_RULES = [
    // ── document ─────────────────────────────────────────────────────────
    // 保留：DOM 查询/创建 API，命名极具专属性，业务代码不会自定义同名方法
    {
        category: 'document',
        hostObj: 'document',
        varNames: ['document'],
        properties: new Set([
            // 查询——极专属，业务代码不会自定义
            'getElementById', 'getElementsByClassName', 'getElementsByTagName',
            'querySelector', 'querySelectorAll', 'getElementsByName',
            // 创建——极专属
            'createElement', 'createElementNS', 'createTextNode',
            'createDocumentFragment', 'createComment', 'createEvent',
            'createRange', 'createTreeWalker', 'createNodeIterator',
            'importNode', 'adoptNode',
            // 专属属性
            'documentElement', 'activeElement',
            'cookie', 'referrer', 'readyState',
            'visibilityState', 'fullscreenElement',
            'execCommand', 'hasFocus',
            // writeln 比 write 更专属（write 在普通对象上常见）
            'writeln',
        ]),
    },
    // ── window（全局）────────────────────────────────────────────────────
    // 去掉：open/close/stop/blur/focus/scroll/origin/print/gc（均有歧义）
    // 去掉：fetch（作为 inferred 太模糊，靠 confirmed 捕获）
    {
        category: 'window',
        hostObj: 'window',
        varNames: ['window', 'self', 'globalThis', 'top', 'parent', 'frames'],
        properties: new Set([
            // 计时器——极专属
            'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
            'requestAnimationFrame', 'cancelAnimationFrame',
            'requestIdleCallback', 'cancelIdleCallback',
            // 浏览器专属全局
            'XMLHttpRequest', 'WebSocket', 'EventSource',
            'localStorage', 'sessionStorage', 'indexedDB',
            'openDatabase',
            // 对话框——极专属
            'alert', 'confirm', 'prompt',
            'postMessage',
            'scrollTo', 'scrollBy',
            // 只读属性——专属
            'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight',
            'screenX', 'screenY', 'pageXOffset', 'pageYOffset',
            'scrollX', 'scrollY', 'devicePixelRatio',
            // 编解码——专属（业务代码不自定义）
            'btoa', 'atob',
            'encodeURIComponent', 'decodeURIComponent',
            'encodeURI', 'decodeURI',
            // 其他专属
            'getComputedStyle', 'matchMedia', 'queueMicrotask',
            'structuredClone',
        ]),
    },
    // ── navigator ────────────────────────────────────────────────────────
    // 去掉：language/languages/connection/storage/share（在业务对象上可能出现）
    {
        category: 'navigator',
        hostObj: 'navigator',
        varNames: ['navigator'],
        properties: new Set([
            // 极专属——只在 navigator 上出现
            'userAgent', 'appVersion', 'cookieEnabled', 'javaEnabled',
            'hardwareConcurrency', 'maxTouchPoints', 'deviceMemory',
            'geolocation', 'mediaDevices', 'permissions',
            'clipboard', 'credentials', 'serviceWorker',
            'sendBeacon', 'vibrate', 'getBattery', 'getGamepads',
            'requestMIDIAccess', 'webdriver', 'doNotTrack',
            'vendor', 'productSub', 'vendorSub',
            'onLine', 'platform',
        ]),
    },
    // ── location ─────────────────────────────────────────────────────────
    // 去掉：href/hash/search/host/pathname/replace/reload——这些在路由框架里极常见
    // 只保留组合极具辨识度的专属方法
    {
        category: 'location',
        hostObj: 'location',
        varNames: ['location'],
        properties: new Set([
            // assign 在业务代码里很少自定义；reload 去掉（普通方法名）
            'assign',
            // 组合特征：这三个字段同时出现才高置信，但单个也可作信号
            'hostname', 'pathname', 'protocol',
        ]),
    },
    // ── localStorage / sessionStorage ────────────────────────────────────
    // getItem/setItem/removeItem 组合极专属；clear/key/length 太通用去掉
    {
        category: 'storage',
        hostObj: 'localStorage',
        varNames: ['localStorage'],
        properties: new Set([
            'getItem', 'setItem', 'removeItem',
        ]),
    },
    {
        category: 'storage',
        hostObj: 'sessionStorage',
        varNames: ['sessionStorage'],
        properties: new Set([
            'getItem', 'setItem', 'removeItem',
        ]),
    },
    // ── XMLHttpRequest ───────────────────────────────────────────────────
    // 去掉：open/send/abort/status/response/timeout/upload（在 wrapper 层极常见）
    // 只保留极专属的 XHR 方法/属性名
    {
        category: 'xhr',
        hostObj: 'XMLHttpRequest',
        varNames: ['XMLHttpRequest'],
        properties: new Set([
            // 这几个命名高度专属，业务代码不会自定义
            'setRequestHeader', 'getResponseHeader', 'getAllResponseHeaders',
            'overrideMimeType',
            'onreadystatechange',
            'responseXML', 'responseURL', 'withCredentials',
        ]),
    },
    // ── fetch / Response / Request / Headers ─────────────────────────────
    // 大量字段（json/text/blob/ok/status/headers/get/set/has/…）在 wrapper 里高频出现
    // 只保留：arrayBuffer/formData/bodyUsed/redirected 这类极专属的
    {
        category: 'fetch',
        hostObj: 'fetch',
        varNames: ['fetch'],
        properties: new Set([
            'arrayBuffer', 'formData', 'bodyUsed', 'redirected',
        ]),
    },
    // ── performance ──────────────────────────────────────────────────────
    // 去掉：now/mark/measure/timing/memory/toJSON（在自定义 perf 工具里常见）
    // 只保留极专属方法
    {
        category: 'timing',
        hostObj: 'performance',
        varNames: ['performance'],
        properties: new Set([
            'getEntries', 'getEntriesByName', 'getEntriesByType',
            'clearMarks', 'clearMeasures',
            'timeOrigin', 'eventCounts',
        ]),
    },
    // ── MutationObserver ─────────────────────────────────────────────────
    // observe/disconnect/takeRecords 组合专属性强，但 observe/disconnect 单个有歧义
    // 仅保留 takeRecords（极专属）；observe/disconnect 靠 confirmed 路径
    {
        category: 'observer',
        hostObj: 'MutationObserver',
        varNames: ['MutationObserver'],
        properties: new Set(['takeRecords']),
    },
    {
        category: 'observer',
        hostObj: 'IntersectionObserver',
        varNames: ['IntersectionObserver'],
        properties: new Set(['unobserve', 'rootMargin', 'thresholds']),
    },
    // ── Canvas ───────────────────────────────────────────────────────────
    // 去掉：fill/stroke/arc/save/restore/scale/rotate/clip（游戏/可视化库常见）
    // 保留：高度专属的 Canvas/2D API
    {
        category: 'canvas',
        hostObj: 'CanvasRenderingContext2D',
        varNames: [],
        properties: new Set([
            // 专属：只在 canvas 上出现
            'toDataURL', 'toBlob', 'captureStream',
            'fillRect', 'clearRect', 'strokeRect',
            'fillText', 'strokeText', 'measureText',
            'drawImage', 'putImageData', 'getImageData', 'createImageData',
            'bezierCurveTo', 'quadraticCurveTo',
            'beginPath', 'closePath', 'moveTo', 'lineTo', 'arcTo',
            'setTransform',
            'createLinearGradient', 'createRadialGradient', 'createPattern',
            'isPointInPath', 'isPointInStroke',
            'getContext',
        ]),
    },
    // ── Event 对象 ───────────────────────────────────────────────────────
    // 去掉全部通用字段（type/target/bubbles/cancelable/timeStamp 均高频误报）
    // 只保留极专属的 Event 方法
    {
        category: 'event',
        hostObj: 'EventTarget',
        varNames: [],
        properties: new Set([
            // stopImmediatePropagation 极专属
            'stopImmediatePropagation',
            // preventDefault / stopPropagation 在框架代理中也出现，保留但置信度低
            'stopPropagation', 'preventDefault',
            'isTrusted', 'defaultPrevented', 'composedPath',
        ]),
    },
    // ── history ──────────────────────────────────────────────────────────
    // 去掉：state/length/back/forward/go/scrollRestoration（太通用）
    {
        category: 'history',
        hostObj: 'history',
        varNames: ['history'],
        properties: new Set([
            // pushState/replaceState 极专属
            'pushState', 'replaceState',
        ]),
    },
    // ── crypto（Web Crypto API）──────────────────────────────────────────
    {
        category: 'crypto',
        hostObj: 'crypto',
        varNames: ['crypto'],
        properties: new Set([
            // getRandomValues/randomUUID 极专属
            'getRandomValues', 'randomUUID',
            'subtle',
        ]),
    },
];

// ─── 属性名 → 规则 反向索引（用于快速 inferred 查找）───────────────────────
// 一个属性名可能对应多个规则（如 addEventListener 出现在 document/window/EventTarget）
// 取第一条匹配规则（按 HOST_RULES 定义顺序，更具体的写在前面）
const PROP_TO_RULE = new Map(); // propertyName → HOST_RULE（第一匹配）
for (const rule of HOST_RULES) {
    if (!rule.properties) continue;
    for (const prop of rule.properties) {
        if (!PROP_TO_RULE.has(prop)) {
            PROP_TO_RULE.set(prop, rule);
        }
    }
}

// ─── varName → 规则 反向索引（confirmed 查找）───────────────────────────────
const VAR_TO_RULE = new Map(); // varName → HOST_RULE（第一匹配）
for (const rule of HOST_RULES) {
    for (const vn of (rule.varNames || [])) {
        if (!VAR_TO_RULE.has(vn)) {
            VAR_TO_RULE.set(vn, rule);
        }
    }
}

// 配置项在 run() 入口处一次性捕获

export default class I5WebApiDetector extends BasePlugin {
    static observes = ['F2-SmapLoader'];
    static id = 'I5-WebApiDetector';
    static deps = ['F1-EventIndex', 'F3-CallGraphBuilder'];
    static description = '检测运行时对 BOM/DOM 宿主对象（document/window/navigator 等）的属性访问与方法调用，写入 web_api_calls 表';
    static displayName = 'I5 · WebApiDetector';

    async run(ctx) {
        const { sessionId } = ctx;
        const rawDb = db.raw();

        // 一次性捕获配置，避免在热循环中频繁调用 cfg()
        const _batchSize = cfg('plugins.I5_WebApiDetector.batchSize');
        const _callLookupDelta = cfg('plugins.I5_WebApiDetector.callLookupDelta');

        this.emitProgress(ctx, '清空旧数据...', 0);
        rawDb.prepare('DELETE FROM web_api_calls WHERE session_id = ?').run(sessionId);

        // ── Step 1: 加载 oid_aliases（OID → 变量名集合）───────────────────
        this.emitProgress(ctx, '加载 OID 别名表...', 5);
        const oidToVars = new Map(); // oid → Set<varName>
        {
            const rows = rawDb.prepare(
                'SELECT oid, var_name FROM oid_aliases WHERE session_id = ?'
            ).all(sessionId);
            for (const r of rows) {
                let s = oidToVars.get(r.oid);
                if (!s) { s = new Set(); oidToVars.set(r.oid, s); }
                s.add(r.var_name);
            }
        }

        // ── Step 1b: 预建 OID → 规则 映射（基于 oid_aliases）────────────────
        // 将已知宿主对象变量名对应的 OID 直接映射到规则，
        // 使后续"同 OID 的任意属性访问"都能以 confirmed 置信度命中
        this.emitProgress(ctx, '建立 OID → 规则映射...', 8);
        // oidToRule: oid → { rule, receiverVar }
        // 注意：同一 OID 可能有多个 var_name（别名），取第一个命中规则的
        const oidToRule = new Map();
        for (const [oid, varNames] of oidToVars) {
            for (const vn of varNames) {
                const rule = VAR_TO_RULE.get(vn);
                if (rule) {
                    oidToRule.set(oid, { rule, receiverVar: vn });
                    break;
                }
            }
        }

        // ── Step 2: 加载 smap（iid → {sl, src_text}）─────────────────────
        this.emitProgress(ctx, '加载源码映射...', 10);
        const smapMap = new Map(); // iid → {sl, src_text}
        {
            const rows = rawDb.prepare(
                'SELECT iid, sl, src_text FROM smap WHERE session_id = ?'
            ).all(sessionId);
            for (const r of rows) smapMap.set(r.iid, { sl: r.sl, src_text: r.src_text });
        }

        // ── Step 3: 加载 call_edges（call_seq → edge）─────────────────────
        // 用于将 GET_FIELD(读取方法) 和紧随其后的 CALL_PRE(调用) 关联起来
        // 策略：call_edges.call_seq（CALL_PRE 的 event id）刚好在 field event_id 之后
        this.emitProgress(ctx, '加载调用图...', 15);
        // call_seq → { id, args_json, return_value }
        const callEdgeBySeq = new Map();
        {
            const rows = rawDb.prepare(
                'SELECT id, call_seq, args_json, return_value FROM call_edges WHERE session_id = ?'
            ).all(sessionId);
            for (const r of rows) callEdgeBySeq.set(r.call_seq, r);
        }

        // ── Step 4: 扫描 fields 表 ────────────────────────────────────────
        this.emitProgress(ctx, '扫描属性访问事件...', 20);
        const fields = rawDb.prepare(
            `SELECT f.id, f.event_id, f.offset, f.is_write, f.base_oid,
                    e.iid
             FROM fields f
             JOIN events e ON e.id = f.event_id
             WHERE f.session_id = ?
               AND f.offset IS NOT NULL
             ORDER BY f.event_id ASC`
        ).all(sessionId);

        this.emitProgress(ctx, `共 ${fields.length} 条属性访问，开始分析...`, 25);

        // ── Step 5: 逐条判断 ─────────────────────────────────────────────
        const stmt = rawDb.prepare(
            `INSERT INTO web_api_calls
             (session_id, event_id, call_edge_id, category, host_obj, property_name,
              access_type, confidence_level, receiver_var, args_json, return_value, line, src_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertBatch = rawDb.transaction((batch) => {
            for (const row of batch) stmt.run(...row);
        });

        // 去重：同一 event_id + property_name 只写一条（confirmed 优先）
        const seen = new Set(); // `${event_id}:${property_name}`

        let resultBatch = [];
        let total = 0;

        const flush = () => {
            if (resultBatch.length === 0) return;
            insertBatch(resultBatch);
            total += resultBatch.length;
            resultBatch = [];
        };

        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            const prop = f.offset;
            const baseOid = f.base_oid;
            const dedupeKey = `${f.event_id}:${prop}`;

            let matchedRule = null;
            let confidenceLevel = null;
            let receiverVar = null;

            // ── Level 1: confirmed / propagated（OID 缓存命中）──────────
            // 先查 oidToRule 缓存：该 OID 已被之前的事件确认或推断过类型，直接复用
            if (baseOid != null) {
                const cached = oidToRule.get(baseOid);
                if (cached) {
                    matchedRule = cached.rule;
                    // propagated=true 表示来自 inferred 归因，置信度不升级为 confirmed
                    confidenceLevel = cached.propagated ? 'propagated' : 'confirmed';
                    receiverVar = cached.receiverVar;
                } else {
                    // 缓存未命中：通过 oid_aliases.var_name → VAR_TO_RULE 精确匹配
                    const varNames = oidToVars.get(baseOid);
                    if (varNames) {
                        for (const vn of varNames) {
                            const rule = VAR_TO_RULE.get(vn);
                            if (rule) {
                                matchedRule = rule;
                                confidenceLevel = 'confirmed';
                                receiverVar = vn;
                                // 写入缓存，后续同 OID 的所有访问无需再查 oid_aliases
                                oidToRule.set(baseOid, { rule, receiverVar: vn });
                                break;
                            }
                        }
                    }
                }
            }

            // ── Level 2: inferred（属性名启发式，仅当 OID 无法确认时兜底）──
            if (!matchedRule) {
                const rule = PROP_TO_RULE.get(prop);
                if (rule) {
                    matchedRule = rule;
                    confidenceLevel = 'inferred';
                    // 归因传播：该属性名是高专属性词，可以锁定 OID 类型。
                    // 后续同 OID 的所有访问（包括通用方法名如 open/close/write）
                    // 将以 'propagated' 置信度写入，不再漏掉。
                    if (baseOid != null) {
                        oidToRule.set(baseOid, { rule, receiverVar: null, propagated: true });
                    }
                }
            }

            if (!matchedRule) continue;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            // ── 确定访问类型 ──────────────────────────────────────────────
            let accessType = f.is_write ? 'write' : 'read';

            // 若是 read，且随后（event_id + 1 ~ + 5 之内）有 call_edges.call_seq
            // 说明这是方法调用前的属性读取，升级为 call
            let callEdgeId = null;
            let argsJson = null;
            let returnValue = null;
            if (!f.is_write) {
                // 在 event_id 之后的小窗口内找 call_seq
                for (let delta = 1; delta <= _callLookupDelta; delta++) {
                    const edge = callEdgeBySeq.get(f.event_id + delta);
                    if (edge) {
                        accessType = 'call';
                        callEdgeId = edge.id;
                        argsJson = edge.args_json;
                        returnValue = edge.return_value;
                        break;
                    }
                }
            }

            // ── 行号 / 源码 ───────────────────────────────────────────────
            const smapEntry = f.iid != null ? smapMap.get(f.iid) : null;
            const line = smapEntry?.sl ?? null;
            const srcText = smapEntry?.src_text ?? null;

            resultBatch.push([
                sessionId,
                f.event_id,
                callEdgeId,
                matchedRule.category,
                matchedRule.hostObj,
                prop,
                accessType,
                confidenceLevel,
                receiverVar,
                argsJson,
                returnValue,
                line,
                srcText,
            ]);

            if (resultBatch.length >= _batchSize) {
                flush();
                const pct = Math.min(90, 25 + Math.round((i / fields.length) * 65));
                this.emitProgress(ctx, `已写入 ${total} 条记录...`, pct);
            }
        }

        flush();

        // ── Step 6: 统计分类摘要 ──────────────────────────────────────────
        this.emitProgress(ctx, '生成统计摘要...', 95);

        let confirmedCount = 0, propagatedCount = 0, inferredCount = 0;
        const categoryStats = {};
        try {
            const rows = rawDb.prepare(
                `SELECT category, confidence_level, COUNT(*) as cnt
                 FROM web_api_calls WHERE session_id = ?
                 GROUP BY category, confidence_level`
            ).all(sessionId);
            for (const r of rows) {
                if (r.confidence_level === 'confirmed') confirmedCount += r.cnt;
                else if (r.confidence_level === 'propagated') propagatedCount += r.cnt;
                else inferredCount += r.cnt;
                if (!categoryStats[r.category]) categoryStats[r.category] = { confirmed: 0, propagated: 0, inferred: 0 };
                categoryStats[r.category][r.confidence_level] = (categoryStats[r.category][r.confidence_level] || 0) + r.cnt;
            }
        } catch { /* 非致命 */ }

        this.emitProgress(ctx, `完成，共 ${total} 条 Web API 访问（confirmed: ${confirmedCount}，propagated: ${propagatedCount}，inferred: ${inferredCount}）`, 100);
        this.emitDone(ctx, { total, confirmedCount, propagatedCount, inferredCount, categoryStats });
    }
}
