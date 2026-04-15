/**
 * useConfig.js — UI 配置获取 composable
 *
 * 从后端 /api/config 接口拉取可配置项，支持响应式访问。
 *
 * 设计：
 *   - 单例缓存：第一次调用时发起请求，后续调用复用同一份数据
 *   - 回退默认值：请求失败时使用内置默认值，确保 UI 可用
 *   - 响应式：使用 Vue ref，组件挂载后自动更新
 *
 * 用法：
 *   const { cfg } = useConfig();
 *   // cfg.ui.sessionListRefreshMs、cfg.api.defaultPageSize 等
 *   // 直接读取配置值（响应式）：cfg.value.ui.sessionListRefreshMs
 */

import { ref, computed, readonly } from 'vue';

// ── 内置默认值（与 config.default.json 保持一致）──────────────────────────────
const DEFAULT_CONFIG = {
    ui: {
        sessionListRefreshMs:   5000,
        sessionDetailRefreshMs: 10000,
        wsReconnectMs:          5000,
        traceMonitorPollMs:     3000,
        traceMonitorPageSize:   20,
        traceMonitorHistoryMax: 60,
    },
    api: {
        defaultPageSize:               100,
        maxPageSize:                   500,
        maxEventsCap:                  1000,
        hotIidsLimit:                  200,
        varLifetimeLimit:              500,
        taintPathsLimit:               50,
        valuePatternsLimit:            500,
        valueSearchDefaultLimit:       200,
        valueSearchMaxLimit:           1000,
        valueSearchEventsDefaultLimit: 50,
        valueSearchEventsMaxLimit:     200,
        valueDictTopNDefault:          20,
        valueDictTopNMax:              200,
        valueDictDefaultLimit:         100,
        valueDictMaxLimit:             500,
        webApiDefaultLimit:            500,
        webApiMaxLimit:                2000,
        objectTimelinesMaxPageSize:    500,
        loopIterationsMaxLimit:        1000,
        cfgLoopsLimit:                 50,
        flamegraphMaxDepthCap:         200,
        flamegraphDefaultMaxDepth:     50,
    },
};

// ── 单例状态 ─────────────────────────────────────────────────────────────────

/** @type {import('vue').Ref<typeof DEFAULT_CONFIG>} */
const _config = ref(structuredClone(DEFAULT_CONFIG));

/** @type {import('vue').Ref<boolean>} */
const _loaded = ref(false);

/** @type {Promise<void> | null} 进行中的请求（防止并发多次请求）*/
let _fetchPromise = null;

/**
 * 从后端拉取配置（只需执行一次，结果缓存在模块级单例中）。
 * @returns {Promise<void>}
 */
async function _fetchConfig() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`/api/config returned ${res.status}`);
        const data = await res.json();

        // 深度合并：后端返回的值覆盖默认值
        _config.value = {
            ui:  { ..._config.value.ui,  ...(data.ui  ?? {}) },
            api: { ..._config.value.api, ...(data.api ?? {}) },
        };

        _loaded.value = true;
    } catch (err) {
        console.warn('[useConfig] Failed to fetch /api/config, using defaults:', err.message);
        _loaded.value = true; // 使用默认值，标记为已加载
    }
}

// ── 计算属性（模块级，单例，复用同一批响应式引用）─────────────────────────────
const _uiConfig  = computed(() => _config.value.ui);
const _apiConfig = computed(() => _config.value.api);

/**
 * UI 配置 composable。
 *
 * @returns {{
 *   cfg:   import('vue').ComputedRef<typeof DEFAULT_CONFIG>,
 *   ui:    import('vue').ComputedRef<typeof DEFAULT_CONFIG.ui>,
 *   api:   import('vue').ComputedRef<typeof DEFAULT_CONFIG.api>,
 *   loaded: import('vue').Readonly<import('vue').Ref<boolean>>,
 *   ensureLoaded: () => Promise<void>
 * }}
 */
export function useConfig() {
    // 触发加载（仅第一次）
    if (!_fetchPromise) {
        _fetchPromise = _fetchConfig();
    }

    return {
        cfg:          readonly(_config),
        ui:           _uiConfig,
        api:          _apiConfig,
        loaded:       readonly(_loaded),
        ensureLoaded: () => _fetchPromise,
    };
}
