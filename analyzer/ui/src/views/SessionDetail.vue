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
          :title="tab.desc"
          @click="onTabClick(tab.id)"
        >{{ tab.label }}</button>

        <!-- 进度入口按钮 -->
        <button
          class="tab-btn btn-open-progress"
          style="margin-left:auto"
          @click="showProgressDrawer = true"
        >{{ isAnalyzing ? '⏳ 分析中...' : '🔍 分析进度' }}</button>
      </div>

      <!-- Tab 说明横幅 -->
      <transition name="tab-desc-slide">
        <div v-if="activeTabInfo && !tabDescDismissed" class="tab-desc-bar card">
          <div class="tab-desc-icon">ℹ️</div>
          <div class="tab-desc-body">
            <div class="tab-desc-headline">{{ activeTabInfo.label }} — {{ activeTabInfo.desc }}</div>
            <div v-if="activeTabInfo.capabilities?.length" class="tab-desc-caps">
              <span v-for="cap in activeTabInfo.capabilities" :key="cap" class="tab-cap-tag">{{ cap }}</span>
            </div>
          </div>
          <button class="tab-desc-close" title="收起说明" @click="tabDescDismissed = true">✕</button>
        </div>
      </transition>
      <div v-if="activeTabInfo && tabDescDismissed" class="tab-desc-hint">
        <button class="tab-desc-reopen" @click="tabDescDismissed = false" title="展开说明">ℹ️ 功能说明</button>
      </div>

      <!-- Tab 内容区域（使用 v-show 保留已加载组件状态） -->
      <EventsTab      v-show="activeTab === 'events'"      ref="eventsTabRef"      :session-id="sessionId" :target-seq="targetSeq" @goto-function="onGotoFunction" />
      <FunctionsTab   v-show="activeTab === 'functions'"   ref="functionsTabRef"   :session-id="sessionId" :plugin-status="pluginStatus" :target-call="targetCall" />
      <LoopsTab       v-show="activeTab === 'loops'"       ref="loopsTabRef"       :session-id="sessionId" />
      <PatternsTab    v-show="activeTab === 'patterns'"    ref="patternsTabRef"    :session-id="sessionId" />
      <CryptoTab      v-show="activeTab === 'crypto'"      ref="cryptoTabRef"      :session-id="sessionId" />
      <SignaturesTab  v-show="activeTab === 'signatures'"  ref="signaturesTabRef"  :session-id="sessionId" />
      <DataflowTab    v-show="activeTab === 'dataflow'"    ref="dataflowTabRef"    :session-id="sessionId" />
      <StringsTab     v-show="activeTab === 'strings'"     ref="stringsTabRef"     :session-id="sessionId" @goto-event="onGotoEvent" @goto-function="onGotoFunction" />
      <ObjMutTab      v-show="activeTab === 'objmut'"      ref="objmutTabRef"      :session-id="sessionId" />
      <ObfuscationTab v-show="activeTab === 'obfuscation'" ref="obfuscationTabRef" :session-id="sessionId" @goto-function="onGotoFunction" />
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
    'A2-DataFlowGraph', 'A4-StringTracker',
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
        'A4-StringTracker': 'A4 字符串',
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
// ─── 跨 Tab 导航：事件流 ↔ 函数 ─────────────────────────────────────────────
const targetCall = ref(null); // { fnName, fnIid, callSeq }
const targetSeq  = ref(null); // event SEQ，用于事件流跳转定位

function onGotoFunction({ fnName, fnIid, callSeq }) {
    targetCall.value = { fnName, fnIid, callSeq };
    activeTab.value = 'functions';
}

/** 来自 StringsTab 的跳转到事件流（按 event_id = event SEQ） */
function onGotoEvent({ eventId }) {
    targetSeq.value = eventId;
    activeTab.value = 'events';
}

const tabs = [
    {
        id: 'events', label: '📋 事件流',
        desc: '以时间顺序展示 JS 运行时捕获的所有原始事件，是最底层的执行记录。',
        capabilities: ['按事件类型/行号/变量名/函数筛选', '查看读写值与调用参数', '跳转到对应函数分析', '支持分页与 SEQ 定位'],
    },
    {
        id: 'functions', label: '📌 函数',
        desc: '函数调用统计与执行追踪，展示每个函数的调用次数、事件量及执行热度。',
        capabilities: ['按函数名 / 调用次数 / 事件量筛选', '查看函数体内事件详情', '热路径高亮（A3）', '与事件流双向跳转'],
    },
    {
        id: 'loops', label: '🔁 循环迭代',
        desc: '展开循环的每一次迭代，记录迭代范围和循环变量快照（由 A5 · LoopDetector 提供）。',
        capabilities: ['列出所有循环及迭代次数', '查看每轮迭代的变量值快照', '定位循环 SEQ 范围'],
    },
    {
        id: 'patterns', label: '🔢 值模式',
        desc: '检测运行时反复出现的特殊数值（如密码学魔术常数），辅助识别算法实现（由 A8 · ValuePatternDetector 提供）。',
        capabilities: ['发现高频出现的值指纹', '匹配 AES/SHA/MD5 等已知密码学常数', '过滤仅显示密码学相关模式', '关联变量名与代码行号'],
    },
    {
        id: 'crypto', label: '🔐 加密检测',
        desc: '综合多维特征（魔术常数 / XOR 操作 / 库调用）对加密算法进行置信度评估（由 I1 · CryptoDetector 提供）。',
        capabilities: ['识别 AES / DES / RSA / MD5 / SHA 等常见算法', '显示置信度条与支持证据', '定位算法实现的代码位置'],
    },
    {
        id: 'signatures', label: '✍️ 签名路径',
        desc: '追踪签名/Token 字段从数据源到最终输出的完整数据流路径（由 I2 · SignatureAnalyzer 提供）。',
        capabilities: ['识别 sign / token / _sign 等字段', '展示多跳数据传递链路', '显示输入变量与最终 sink'],
    },
    {
        id: 'dataflow', label: '🔗 数据流图',
        desc: '记录变量间的赋值 / 返回 / 参数传递关系，构建运行时数据流图（由 A2 · DataFlowGraph 提供）。',
        capabilities: ['展示 assign / return / arg / call 等边类型', '按边类型过滤查看', '关联来源/目标 SEQ 与行号'],
    },
    {
        id: 'strings', label: '🔤 字符串追踪',
        desc: '追踪运行时出现的字符串值，自动识别 Base64 / Hex / URL 等编码格式（由 A4 · StringTracker 提供）。',
        capabilities: ['按编码类型（Base64/Hex/URL/plain）过滤', '查看变量名与完整字符串值', '一键跳转到事件流或函数面板', '支持解码预览'],
    },
    {
        id: 'objmut', label: '🔄 对象变异',
        desc: '记录对象属性的读写历史，追踪属性值随时间的变化轨迹（由 A7 · ObjectMutationTracker 提供）。',
        capabilities: ['按对象变量过滤', '查看属性的旧值→新值变化', '仅显示写入操作', '关联代码行号与 SEQ'],
    },
    {
        id: 'obfuscation', label: '🕵️ 混淆检测',
        desc: '识别混淆特征（字符串解码器 / 控制流平坦化 / 十六进制编码 / 死代码等），评估整体混淆程度（由 I3 · ObfuscationDetector 提供）。',
        capabilities: ['多维度混淆特征检测', '给出每项特征的置信度', '标注混淆函数并跳转查看', '综合评估是否为混淆代码'],
    },
    {
        id: 'summary', label: '📝 算法报告',
        desc: '整合所有分析插件的结果，生成结构化的算法汇总报告（由 I4 · AlgorithmSummarizer 提供）。',
        capabilities: ['概览总事件数 / 函数数 / 数据流边数', '显示识别出的算法标签', '混淆评分总览', '输出 Markdown 格式分析报告'],
    },
];
const activeTab = ref('events');
const tabDescDismissed = ref(false);

const activeTabInfo = computed(() => tabs.find(t => t.id === activeTab.value));

// 切换 tab 时自动展开说明
function onTabClick(tabId) {
    if (activeTab.value !== tabId) {
        tabDescDismissed.value = false;
    }
    activeTab.value = tabId;
}

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
const objmutTabRef      = ref(null);
const obfuscationTabRef = ref(null);
const summaryTabRef     = ref(null);


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

// ─── 刷新所有 Tab ─────────────────────────────────────────────────────────────
function reloadAllTabs() {
    eventsTabRef.value?.reload();
    functionsTabRef.value?.reload();
    loopsTabRef.value?.reload();
    patternsTabRef.value?.reload();
    cryptoTabRef.value?.reload();
    signaturesTabRef.value?.reload();
    dataflowTabRef.value?.reload();
    stringsTabRef.value?.reload();
    objmutTabRef.value?.reload();
    obfuscationTabRef.value?.reload();
    summaryTabRef.value?.reload();
}

// ─── 插件完成时通知对应 Tab 刷新 ──────────────────────────────────────────────
function onPluginDone(pluginId) {
    const pluginTabMap = {
        'F1-EventIndex':            () => eventsTabRef.value?.reload(),
        'F3-CallGraphBuilder':      () => functionsTabRef.value?.reload(),
        'F4-VariableLifetime':      () => eventsTabRef.value?.reload(),
        'A3-HotPathAnalyzer':       () => patternsTabRef.value?.reload(),
        'A5-LoopDetector':          () => loopsTabRef.value?.reload(),
        'A8-ValuePatternDetector':  () => patternsTabRef.value?.reload(),
        'I1-CryptoDetector':        () => cryptoTabRef.value?.reload(),
        'I2-SignatureAnalyzer':     () => signaturesTabRef.value?.reload(),
        'A2-DataFlowGraph':         () => dataflowTabRef.value?.reload(),
        'A4-StringTracker':         () => stringsTabRef.value?.reload(),
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
        // all_done 时全量刷新所有 tab，确保重新分析后数据都是最新的
        reloadAllTabs();

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

.btn-open-progress {
    background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.3); color: #a5b4fc;
}
.btn-open-progress:hover { background: rgba(99,102,241,0.18); color: #c7d2fe; }

/* ── Tab 说明横幅 ─────────────────────────────────────────────────────────── */
.tab-desc-bar {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 14px;
    background: rgba(99,102,241,0.06);
    border: 1px solid rgba(99,102,241,0.2);
    border-radius: 8px;
    margin-bottom: 0;
}
.tab-desc-icon { font-size: 15px; flex-shrink: 0; margin-top: 1px; opacity: 0.8; }
.tab-desc-body { flex: 1; min-width: 0; }
.tab-desc-headline {
    font-size: 12.5px; color: var(--text-secondary);
    line-height: 1.5; margin-bottom: 6px;
}
.tab-desc-caps {
    display: flex; flex-wrap: wrap; gap: 5px;
}
.tab-cap-tag {
    display: inline-block; padding: 2px 8px;
    background: rgba(99,102,241,0.12); border: 1px solid rgba(99,102,241,0.25);
    border-radius: 12px; font-size: 11px; color: #a5b4fc;
    white-space: nowrap;
}
.tab-desc-close {
    flex-shrink: 0; background: none; border: none;
    color: var(--text-muted); font-size: 12px; cursor: pointer;
    padding: 2px 6px; border-radius: 4px; line-height: 1;
    transition: color 0.15s, background 0.15s;
}
.tab-desc-close:hover { color: var(--text-primary); background: var(--bg-tertiary); }

/* 收起后的小提示按钮 */
.tab-desc-hint { display: flex; justify-content: flex-end; margin-top: -10px; }
.tab-desc-reopen {
    background: none; border: none; color: var(--text-muted);
    font-size: 11px; cursor: pointer; padding: 2px 6px;
    border-radius: 4px; transition: color 0.15s;
}
.tab-desc-reopen:hover { color: #a5b4fc; }

/* 进入/离开动画 */
.tab-desc-slide-enter-active { transition: all 0.2s ease; }
.tab-desc-slide-leave-active { transition: all 0.15s ease; }
.tab-desc-slide-enter-from { opacity: 0; transform: translateY(-6px); }
.tab-desc-slide-leave-to   { opacity: 0; transform: translateY(-4px); }
</style>
