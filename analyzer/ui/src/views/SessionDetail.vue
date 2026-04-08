<template>
  <div class="session-detail">
    <!-- 进度抽屉 -->
    <ProgressDrawer
      :visible="showProgressDrawer"
      :session-id="sessionId"
      :session-name="session?.name || ''"
      @close="showProgressDrawer = false"
      @view-session="showProgressDrawer = false"
    />

    <!-- 顶部：会话信息 -->
    <SessionHeader
      v-if="session"
      :session="session"
      :plugin-status="pluginStatus"
      :is-analyzing="isAnalyzing"
      :inline-progress-pct="inlineProgressPct"
      :running-plugin="runningPlugin"
      @open-progress="showProgressDrawer = true"
    />

    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载会话...</span>
    </div>

    <div v-else-if="error" class="error-state card">
      <p>❌ {{ error }}</p>
    </div>

    <div v-else class="detail-body">
      <!-- 文件信息区 -->
      <FileInfoBar
        v-if="session?.fileInfo"
        :file-info="session.fileInfo"
        :smap-count="session.smapCount || 0"
      />

      <!-- 标签页导航 -->
      <div class="tab-nav card">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ 'tab-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >{{ tab.label }}</button>

        <!-- Phase 3：手动触发按钮 -->
        <button
          class="tab-btn btn-run-phase3"
          :disabled="phase3Running"
          @click="runPhase3"
        >{{ phase3Running ? '⏳ P3 分析中...' : '🚀 运行 Phase 3' }}</button>

        <!-- Phase 4：手动触发按钮 -->
        <button
          class="tab-btn btn-run-phase4"
          style="margin-left:auto"
          :disabled="phase4Running"
          @click="runPhase4"
        >{{ phase4Running ? '⏳ P4 分析中...' : '✨ 运行 Phase 4' }}</button>
      </div>

      <!-- Tab 内容区域（使用 v-show 保留已加载组件状态） -->
      <EventsTab      v-show="activeTab === 'events'"      ref="eventsTabRef"      :session-id="sessionId" />
      <FunctionsTab   v-show="activeTab === 'functions'"   ref="functionsTabRef"   :session-id="sessionId" />
      <LoopsTab       v-show="activeTab === 'loops'"       ref="loopsTabRef"       :session-id="sessionId" />
      <PatternsTab    v-show="activeTab === 'patterns'"    ref="patternsTabRef"    :session-id="sessionId" />
      <CryptoTab      v-show="activeTab === 'crypto'"      ref="cryptoTabRef"      :session-id="sessionId" />
      <SignaturesTab  v-show="activeTab === 'signatures'"  ref="signaturesTabRef"  :session-id="sessionId" />
      <DataflowTab    v-show="activeTab === 'dataflow'"    ref="dataflowTabRef"    :session-id="sessionId" />
      <StringsTab     v-show="activeTab === 'strings'"     ref="stringsTabRef"     :session-id="sessionId" />
      <FnSigTab       v-show="activeTab === 'fnsig'"       ref="fnsigTabRef"       :session-id="sessionId" />
      <ObjMutTab      v-show="activeTab === 'objmut'"      ref="objmutTabRef"      :session-id="sessionId" />
      <ObfuscationTab v-show="activeTab === 'obfuscation'" ref="obfuscationTabRef" :session-id="sessionId" />
      <SummaryTab     v-show="activeTab === 'summary'"     ref="summaryTabRef"     :session-id="sessionId" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';

import ProgressDrawer  from './ProgressDrawer.vue';
import SessionHeader   from '../components/session/SessionHeader.vue';
import FileInfoBar     from '../components/session/FileInfoBar.vue';
import EventsTab       from '../components/session/EventsTab.vue';
import FunctionsTab    from '../components/session/FunctionsTab.vue';
import LoopsTab        from '../components/session/LoopsTab.vue';
import PatternsTab     from '../components/session/PatternsTab.vue';
import CryptoTab       from '../components/session/CryptoTab.vue';
import SignaturesTab   from '../components/session/SignaturesTab.vue';
import DataflowTab     from '../components/session/DataflowTab.vue';
import StringsTab      from '../components/session/StringsTab.vue';
import FnSigTab        from '../components/session/FnSigTab.vue';
import ObjMutTab       from '../components/session/ObjMutTab.vue';
import ObfuscationTab  from '../components/session/ObfuscationTab.vue';
import SummaryTab      from '../components/session/SummaryTab.vue';

// ─── 路由 ─────────────────────────────────────────────────────────────────────
const route = useRoute();
const sessionId = computed(() => route.params.id);

// ─── 进度抽屉 ─────────────────────────────────────────────────────────────────
const showProgressDrawer = ref(false);

// ─── WS 驱动的插件进度状态 ────────────────────────────────────────────────────
const wsPluginStatus   = ref({});  // pluginId → 'pending'|'running'|'done'|'failed'|'skipped'
const wsPluginDuration = ref({});
const wsSessionStatus  = ref('');

const ALL_PLUGIN_IDS = [
    'F1-EventIndex', 'F2-SmapLoader',
    'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer',
    'A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer',
    'A2-DataFlowGraph', 'A4-StringTracker', 'A6-FunctionSignatureInfer',
    'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer',
];

const isAnalyzing = computed(() => {
    const vals = Object.values(wsPluginStatus.value);
    return vals.some(s => s === 'running' || s === 'pending') && wsSessionStatus.value !== 'ready';
});

const runningPlugin = computed(() => {
    const entry = Object.entries(wsPluginStatus.value).find(([, s]) => s === 'running');
    if (!entry) return '';
    const labels = {
        'F1-EventIndex': 'F1 事件索引', 'F2-SmapLoader': 'F2 源码映射',
        'F3-CallGraphBuilder': 'F3 调用图', 'F4-VariableLifetime': 'F4 变量生命周期',
        'A3-HotPathAnalyzer': 'A3 热路径', 'A5-LoopDetector': 'A5 循环检测',
        'A8-ValuePatternDetector': 'A8 值模式', 'I1-CryptoDetector': 'I1 加密检测',
        'I2-SignatureAnalyzer': 'I2 签名分析', 'A2-DataFlowGraph': 'A2 数据流',
        'A4-StringTracker': 'A4 字符串', 'A6-FunctionSignatureInfer': 'A6 函数签名',
        'A7-ObjectMutationTracker': 'A7 对象变异', 'I3-ObfuscationDetector': 'I3 混淆检测',
        'I4-AlgorithmSummarizer': 'I4 算法汇总',
    };
    return labels[entry[0]] || entry[0];
});

const inlineProgressPct = computed(() => {
    const tracked = Object.keys(wsPluginStatus.value);
    if (tracked.length === 0) return 0;
    const done = tracked.filter(id => {
        const s = wsPluginStatus.value[id];
        return s === 'done' || s === 'skipped';
    }).length;
    return Math.round(done / tracked.length * 100);
});

// ─── 标签页 ───────────────────────────────────────────────────────────────────
const tabs = [
    { id: 'events',      label: '📋 事件流' },
    { id: 'functions',   label: '📌 函数' },
    { id: 'loops',       label: '🔁 循环迭代' },
    { id: 'patterns',    label: '🔢 值模式' },
    { id: 'crypto',      label: '🔐 加密检测' },
    { id: 'signatures',  label: '✍️ 签名路径' },
    { id: 'dataflow',    label: '🔗 数据流图' },
    { id: 'strings',     label: '🔤 字符串追踪' },
    { id: 'fnsig',       label: '🧩 函数签名' },
    { id: 'objmut',      label: '🔄 对象变异' },
    { id: 'obfuscation', label: '🕵️ 混淆检测' },
    { id: 'summary',     label: '📝 算法报告' },
];
const activeTab = ref('events');

// ─── 基础会话状态 ─────────────────────────────────────────────────────────────
const session = ref(null);
const loading = ref(true);
const error   = ref('');

const pluginStatus = computed(() => {
    if (!session.value?.plugin_status) return {};
    if (typeof session.value.plugin_status === 'string') {
        try { return JSON.parse(session.value.plugin_status); } catch { return {}; }
    }
    return session.value.plugin_status;
});

// ─── Tab 组件 refs（用于 WS 完成时触发刷新）────────────────────────────────────
const eventsTabRef      = ref(null);
const functionsTabRef   = ref(null);
const loopsTabRef       = ref(null);
const patternsTabRef    = ref(null);
const cryptoTabRef      = ref(null);
const signaturesTabRef  = ref(null);
const dataflowTabRef    = ref(null);
const stringsTabRef     = ref(null);
const fnsigTabRef       = ref(null);
const objmutTabRef      = ref(null);
const obfuscationTabRef = ref(null);
const summaryTabRef     = ref(null);

// ─── Phase 3 / 4 触发按钮 ────────────────────────────────────────────────────
const phase3Running = ref(false);
const phase4Running = ref(false);

async function runPhase3() {
    phase3Running.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/run-phase3`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('runPhase3 error:', e);
        phase3Running.value = false;
    }
    setTimeout(() => { phase3Running.value = false; }, 3000);
}

async function runPhase4() {
    phase4Running.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/run-phase4`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('runPhase4 error:', e);
        phase4Running.value = false;
    }
    setTimeout(() => { phase4Running.value = false; }, 3000);
}

// ─── 会话加载 ─────────────────────────────────────────────────────────────────
async function loadSession() {
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        session.value = await res.json();
    } catch (e) {
        error.value = e.message;
    } finally {
        loading.value = false;
    }
}

// ─── 插件完成时通知对应 Tab 刷新 ──────────────────────────────────────────────
function onPluginDone(pluginId) {
    const pluginTabMap = {
        'A5-LoopDetector':          () => loopsTabRef.value?.reload(),
        'A8-ValuePatternDetector':  () => patternsTabRef.value?.reload(),
        'I1-CryptoDetector':        () => cryptoTabRef.value?.reload(),
        'I2-SignatureAnalyzer':     () => signaturesTabRef.value?.reload(),
        'A2-DataFlowGraph':         () => dataflowTabRef.value?.reload(),
        'A4-StringTracker':         () => stringsTabRef.value?.reload(),
        'A6-FunctionSignatureInfer':() => fnsigTabRef.value?.reload(),
        'A7-ObjectMutationTracker': () => objmutTabRef.value?.reload(),
        'I3-ObfuscationDetector':   () => obfuscationTabRef.value?.reload(),
        'I4-AlgorithmSummarizer':   () => summaryTabRef.value?.reload(),
    };
    pluginTabMap[pluginId]?.();
}

// ─── WebSocket 进度订阅 ───────────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;

function handleDetailWsEvent(msg) {
    if (msg.type === 'init') {
        wsSessionStatus.value = msg.status || '';
        if (msg.pluginStatus) {
            for (const [id, st] of Object.entries(msg.pluginStatus)) {
                wsPluginStatus.value[id] = st;
            }
        }
        if (msg.checkpoints) {
            for (const cp of msg.checkpoints) {
                wsPluginStatus.value[cp.plugin_id] = 'done';
                if (cp.duration_ms) wsPluginDuration.value[cp.plugin_id] = cp.duration_ms;
            }
        }
        loadSession();

    } else if (msg.type === 'schedule_start') {
        for (const id of (msg.toRun || [])) wsPluginStatus.value[id] = 'pending';
        for (const id of (msg.skipped || [])) wsPluginStatus.value[id] = 'skipped';

    } else if (msg.type === 'phase_start') {
        for (const id of (msg.plugins || [])) {
            if (!wsPluginStatus.value[id]) wsPluginStatus.value[id] = 'pending';
        }

    } else if (msg.type === 'plugin_start') {
        wsPluginStatus.value[msg.plugin] = 'running';
        wsSessionStatus.value = 'processing';

    } else if (msg.type === 'plugin_done') {
        wsPluginStatus.value[msg.plugin] = 'done';
        if (msg.durationMs) wsPluginDuration.value[msg.plugin] = msg.durationMs;
        onPluginDone(msg.plugin);
        loadSession();

    } else if (msg.type === 'plugin_failed') {
        wsPluginStatus.value[msg.plugin] = 'failed';

    } else if (msg.type === 'all_done') {
        wsSessionStatus.value = 'ready';
        loadSession();
        eventsTabRef.value?.reload();

    } else if (msg.plugin && msg.status) {
        // 兼容旧格式
        wsPluginStatus.value[msg.plugin] = msg.status;
        if (msg.durationMs) wsPluginDuration.value[msg.plugin] = msg.durationMs;
        if (msg.status === 'done') {
            onPluginDone(msg.plugin);
            loadSession();
        }
    }
}

function connectWs() {
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sessions/${sessionId.value}/progress`;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
        try { handleDetailWsEvent(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
        if (wsSessionStatus.value !== 'ready') {
            wsReconnectTimer = setTimeout(connectWs, 5000);
        }
    };
}

// ─── 生命周期 ─────────────────────────────────────────────────────────────────
let refreshTimer = null;

onMounted(async () => {
    await loadSession();
    connectWs();
    refreshTimer = setInterval(loadSession, 10000);
});

onUnmounted(() => {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); }
    if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.detail-body {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.error-state { color: var(--danger); }

/* 标签页导航 */
.tab-nav {
    display: flex; align-items: center; gap: 4px;
    padding: 8px 12px; margin-bottom: 0; flex-wrap: wrap;
}
.tab-btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border-color);
    background: transparent; color: var(--text-muted); font-size: 12px;
    cursor: pointer; transition: all 0.15s;
}
.tab-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.tab-active {
    background: rgba(99,102,241,0.2) !important;
    color: #a5b4fc !important;
    border-color: rgba(99,102,241,0.4) !important;
}

.btn-run-phase3 {
    background: rgba(34,197,94,0.1); border-color: rgba(34,197,94,0.3); color: #86efac;
}
.btn-run-phase3:hover:not(:disabled) { background: rgba(34,197,94,0.2); }
.btn-run-phase3:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-run-phase4 {
    background: rgba(168,85,247,0.1); border-color: rgba(168,85,247,0.3); color: #d8b4fe;
}
.btn-run-phase4:hover:not(:disabled) { background: rgba(168,85,247,0.2); }
.btn-run-phase4:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
