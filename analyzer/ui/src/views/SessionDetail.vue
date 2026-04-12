<template>
  <div class="session-detail">
    <!-- 全局值查看器 modal -->
    <ValueViewer />

    <!-- 帮助抽屉 -->
    <HelpDrawer
      :visible="showHelpDrawer"
      :tabs="tabs"
      :active-tab="activeTab"
      @close="showHelpDrawer = false"
      @goto-tab="id => { activeTab = id; showHelpDrawer = false; }"
    />

    <!-- 进度抽屉 -->
    <ProgressDrawer
      :visible="showProgressDrawer"
      :session-id="sessionId"
      :session-name="session?.name || ''"
      @close="showProgressDrawer = false"
      @view-session="showProgressDrawer = false"
    />

    <!-- 顶部：极简导航栏（始终显示） -->
    <SessionHeader
      v-if="session"
      :session="session"
      :plugin-status="pluginStatus"
      :is-analyzing="isAnalyzing"
      :inline-progress-pct="inlineProgressPct"
      :running-plugin="runningPlugin"
      :stale-plugins="wsStalePlugins"
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
      <!-- 标签页导航 -->
      <div class="tab-nav card">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ 'tab-active': activeTab === tab.id, 'tab-stale': isTabStale(tab.id) }"
          @click="onTabClick(tab.id)"
          :title="isTabStale(tab.id) ? `${tab.label} — 上游数据已更新，结果可能过期，建议重新分析此阶段` : undefined"
        >{{ tab.label }}<span v-if="isTabStale(tab.id)" class="tab-stale-dot" title="">⚠</span></button>

        <!-- 右侧工具按钮组 -->
        <div class="tab-nav-actions">
          <button class="tab-btn btn-help" @click="showHelpDrawer = true" title="使用帮助">？</button>
          <button
            class="tab-btn btn-open-progress"
            @click="showProgressDrawer = true"
          >{{ isAnalyzing ? '⏳ 分析中...' : '🔍 进度' }}</button>
        </div>
      </div>

      <!-- stale 警告横幅：当前 Tab 依赖的插件数据可能已过期 -->
      <div v-if="isTabStale(activeTab)" class="stale-banner card">
        <span class="stale-banner-icon">⚠️</span>
        <span class="stale-banner-text">
          当前 Tab 的分析数据可能已过期——上游阶段已重新分析，但本阶段尚未跟进重跑。
          如需最新结果，请前往 <strong>进度抽屉</strong> 重新分析对应阶段。
        </span>
        <button class="stale-banner-btn" @click="showProgressDrawer = true">⏩ 前往重分析</button>
      </div>

      <!-- Tab 内容区域（使用 v-show 保留已加载组件状态） -->
      <OverviewTab    v-show="activeTab === 'overview'"   :session="session" :plugin-status="pluginStatus" :plugin-duration="wsPluginDuration" :is-analyzing="isAnalyzing" :inline-progress-pct="inlineProgressPct" :running-plugin="runningPlugin" @open-progress="showProgressDrawer = true" />
      <EventsTab      v-show="activeTab === 'events'"      ref="eventsTabRef"      :session-id="sessionId" :target-seq="targetSeq" @goto-function="onGotoFunction" />
      <FunctionsTab   v-show="activeTab === 'functions'"   ref="functionsTabRef"   :session-id="sessionId" :plugin-status="pluginStatus" :target-call="targetCall" />
      <LoopsTab       v-show="activeTab === 'loops'"       ref="loopsTabRef"       :session-id="sessionId" @goto-seq="onGotoSeq" />
      <PatternsTab    v-show="activeTab === 'patterns'"    ref="patternsTabRef"    :session-id="sessionId" @goto-event-by-value="onGotoEventByValue" />
      <CryptoTab      v-show="activeTab === 'crypto'"      ref="cryptoTabRef"      :session-id="sessionId" />
      <SignaturesTab  v-show="activeTab === 'signatures'"  ref="signaturesTabRef"  :session-id="sessionId" />
      <DataflowTab    v-show="activeTab === 'dataflow'"    ref="dataflowTabRef"    :session-id="sessionId" />
      <ObjMutTab      v-show="activeTab === 'objmut'"      ref="objmutTabRef"      :session-id="sessionId" />
      <ObfuscationTab v-show="activeTab === 'obfuscation'" ref="obfuscationTabRef" :session-id="sessionId" @goto-function="onGotoFunction" />
      <SummaryTab     v-show="activeTab === 'summary'"     ref="summaryTabRef"     :session-id="sessionId" />
      <CfgTab        v-show="activeTab === 'cfg'"         ref="cfgTabRef"         :session-id="sessionId" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';

import ProgressDrawer  from './ProgressDrawer.vue';
import HelpDrawer      from './HelpDrawer.vue';
import ValueViewer     from '../components/ValueViewer.vue';
import SessionHeader   from '../components/session/SessionHeader.vue';
import OverviewTab     from '../components/session/OverviewTab.vue';
import EventsTab       from '../components/session/EventsTab.vue';
import FunctionsTab    from '../components/session/FunctionsTab.vue';
import LoopsTab        from '../components/session/LoopsTab.vue';
import PatternsTab     from '../components/session/PatternsTab.vue';
import CryptoTab       from '../components/session/CryptoTab.vue';
import SignaturesTab   from '../components/session/SignaturesTab.vue';
import DataflowTab     from '../components/session/DataflowTab.vue';
import ObjMutTab       from '../components/session/ObjMutTab.vue';
import ObfuscationTab  from '../components/session/ObfuscationTab.vue';
import SummaryTab      from '../components/session/SummaryTab.vue';
import CfgTab          from '../components/session/CfgTab.vue';

// ─── 路由 ─────────────────────────────────────────────────────────────────────
const route = useRoute();
const sessionId = computed(() => route.params.id);

// ─── 进度抽屉 ─────────────────────────────────────────────────────────────────
const showProgressDrawer = ref(false);

// ─── 帮助抽屉 ─────────────────────────────────────────────────────────────────
const showHelpDrawer = ref(false);

// ─── WS 驱动的插件进度状态 ────────────────────────────────────────────────────
const wsPluginStatus   = ref({});  // pluginId → 'pending'|'running'|'done'|'failed'|'skipped'
const wsPluginDuration = ref({});
const wsSessionStatus  = ref('');
const wsStalePlugins   = ref(new Set()); // 已过期的插件集合（上游数据已更新，结果可能不一致）

// ─── Tab → 所依赖的插件 ID（用于 stale 警告） ────────────────────────────────
const TAB_PLUGIN_MAP = {
    functions:   ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'],
    loops:       ['A5-LoopDetector'],
    patterns:    ['A8-ValuePatternDetector'],
    crypto:      ['I1-CryptoDetector'],
    signatures:  ['I2-SignatureAnalyzer'],
    dataflow:    ['A2-DataFlowGraph'],
    objmut:      ['A7-ObjectMutationTracker'],
    obfuscation: ['I3-ObfuscationDetector'],
    summary:     ['I4-AlgorithmSummarizer'],
    cfg:         ['F3-CallGraphBuilder', 'A5-LoopDetector'],
};

/** 判断指定 Tab 的依赖插件是否有 stale 数据 */
const isTabStale = computed(() => {
    return (tabId) => {
        const plugins = TAB_PLUGIN_MAP[tabId];
        if (!plugins) return false;
        return plugins.some(pid => wsStalePlugins.value.has(pid));
    };
});

const ALL_PLUGIN_IDS = [
    'F1-EventIndex', 'F2-SmapLoader',
    'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer',
    'A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer',
    'A2-DataFlowGraph',
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

/** 来自 PatternsTab 的跳转到事件流（精确匹配指定值，str/num 模式由 PatternsTab 决定） */
async function onGotoEventByValue({ value, mode }) {
    activeTab.value = 'events';
    // 切换 Tab 后等 nextTick，确保 EventsTab v-show 已激活
    await nextTick();
    eventsTabRef.value?.gotoValueSearch(value, mode);
}

/** 来自 LoopsTab（循环迭代）的跳转到事件流指定 SEQ */
async function onGotoSeq(seq) {
    targetSeq.value = seq;
    activeTab.value = 'events';
}

const tabs = [
    {
        id: 'overview', label: 'ℹ️ 概览',
        desc: '查看当前会话的基本信息、上传的文件列表及各分析插件的运行状态。',
        capabilities: ['会话基础元数据', '文件上传状态（Trace / smap / 源码）', '分析插件运行进度总览'],
        tips: ['分析完成前可在此实时追踪各插件进度', '点击「详细进度」可查看每秒处理速率'],
    },
    {
        id: 'events', label: '📋 事件流',
        desc: '以时间顺序展示 JS 运行时捕获的所有原始事件，是最底层的执行记录。',
        capabilities: ['按事件类型/行号/变量名/函数筛选', '查看读写值与调用参数', '跳转到对应函数分析', '支持分页与 SEQ 定位'],
        tips: ['点击事件行可展开查看完整值', '点击函数名可跳转到函数 Tab 精确定位'],
    },
    {
        id: 'functions', label: '📌 函数',
        plugin: 'F3 · F4 · A3',
        desc: '函数调用统计与执行追踪，展示每个函数的调用次数、事件量及执行热度。',
        capabilities: ['按函数名 / 调用次数 / 事件量筛选', '查看函数体内事件详情', '热路径高亮（A3）', '与事件流双向跳转'],
        tips: ['调用次数越多、事件越密集的函数越值得重点分析', '热路径（橙色）是性能或逻辑核心'],
    },
    {
        id: 'loops', label: '🔁 循环迭代',
        plugin: 'A5 · LoopDetector',
        desc: '展开循环的每一次迭代，记录迭代范围和循环变量快照，适合分析迭代加密算法。',
        capabilities: ['列出所有循环及迭代次数', '查看每轮迭代的变量值快照', '定位循环 SEQ 范围'],
        tips: ['迭代次数异常多（>1000）往往是加密/哈希算法的特征', '可结合值模式 Tab 交叉印证'],
    },
    {
        id: 'patterns', label: '🔢 值模式',
        plugin: 'A8 · ValuePatternDetector',
        desc: '检测运行时反复出现的特殊数值（如密码学魔术常数），辅助识别算法实现。',
        capabilities: ['发现高频出现的值指纹', '匹配 AES/SHA/MD5 等已知密码学常数', '过滤仅显示密码学相关模式', '关联变量名与代码行号'],
        tips: ['开启「仅密码学」过滤可快速排除噪音', '0x6a09e667 等常数是 SHA-256 的标志'],
    },
    {
        id: 'crypto', label: '🔐 加密检测',
        plugin: 'I1 · CryptoDetector',
        desc: '综合多维特征（魔术常数 / XOR 操作 / 库调用）对加密算法进行置信度评估。',
        capabilities: ['识别 AES / DES / RSA / MD5 / SHA 等常见算法', '显示置信度条与支持证据', '定位算法实现的代码位置'],
        tips: ['置信度 > 70% 的结果可信度较高', '多条证据共同指向同一算法时结论更可靠'],
    },
    {
        id: 'signatures', label: '✍️ 签名路径',
        plugin: 'I2 · SignatureAnalyzer',
        desc: '追踪签名/Token 字段从数据源到最终输出的完整数据流路径。',
        capabilities: ['识别 sign / token / _sign 等字段', '展示多跳数据传递链路', '显示输入变量与最终 sink'],
        tips: ['路径越短的签名往往越容易理解', '关注 source→sink 之间经过的转换函数'],
    },
    {
        id: 'dataflow', label: '🔗 数据流图',
        plugin: 'A2 · DataFlowGraph',
        desc: '记录变量间的赋值 / 返回 / 参数传递关系，构建运行时数据流图。',
        capabilities: ['展示 assign / return / arg / call 等边类型', '按边类型过滤查看', '关联来源/目标 SEQ 与行号'],
        tips: ['从 sign/token 变量出发追踪数据来源', 'call 类型边可追踪参数如何传入函数'],
    },
    {
        id: 'objmut', label: '🔄 对象变异',
        plugin: 'A7 · ObjectMutationTracker',
        desc: '记录对象属性的读写历史，追踪属性值随时间的变化轨迹。',
        capabilities: ['按对象变量过滤', '查看属性的旧值→新值变化', '仅显示写入操作', '关联代码行号与 SEQ'],
        tips: ['追踪 XMLHttpRequest / fetch 等对象的属性变化可还原请求构造过程', '写入次数最多的对象是关键状态容器'],
    },
    {
        id: 'obfuscation', label: '🕵️ 混淆检测',
        plugin: 'I3 · ObfuscationDetector',
        desc: '识别混淆特征（字符串解码器 / 控制流平坦化 / 十六进制编码 / 死代码等），评估整体混淆程度。',
        capabilities: ['多维度混淆特征检测', '给出每项特征的置信度', '标注混淆函数并跳转查看', '综合评估是否为混淆代码'],
        tips: ['字符串解码器函数通常是逆向的首要突破口', '综合评分 > 60 分说明代码经过了刻意混淆'],
    },
    {
        id: 'summary', label: '📝 算法报告',
        plugin: 'I4 · AlgorithmSummarizer',
        desc: '整合所有分析插件的结果，生成结构化的算法汇总报告，是分析的最终结论。',
        capabilities: ['概览总事件数 / 函数数 / 数据流边数', '显示识别出的算法标签', '混淆评分总览', '输出 Markdown 格式分析报告'],
        tips: ['分析完成后先看报告，快速锁定重点 Tab', '算法标签可作为进一步搜索的关键词'],
    },
    {
        id: 'cfg', label: '🗺 控制流图',
        plugin: 'F3 + A5',
        desc: '基于真实执行数据构建的动态控制流图（Dynamic CFG），以图形化方式展示函数调用拓扑、热点节点及循环结构。',
        capabilities: ['函数调用有向图（可调深度）', '循环节点标注（循环回边）', '热点代码节点高亮', '可指定根函数子树视角', '节点点击显示详情'],
        tips: ['从顶层入口函数出发，逐层下钻是最高效的路径', '循环回边节点往往是核心算法所在'],
    },
];
const activeTab = ref('overview');

function onTabClick(tabId) {
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
const objmutTabRef      = ref(null);
const obfuscationTabRef = ref(null);
const summaryTabRef     = ref(null);
const cfgTabRef         = ref(null);


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
        'A7-ObjectMutationTracker': () => objmutTabRef.value?.reload(),
        'I3-ObfuscationDetector':   () => obfuscationTabRef.value?.reload(),
        'I4-AlgorithmSummarizer':   () => summaryTabRef.value?.reload(),
    };
    pluginTabMap[pluginId]?.();
}

// ─── WebSocket 进度订阅 ───────────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;
let wsDestroyed = false; // 组件卸载时设为 true，停止重连

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
                if (cp.is_stale) {
                    wsStalePlugins.value = new Set([...wsStalePlugins.value, cp.plugin_id]);
                }
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
        // 插件重跑完成，清除 stale 标记
        if (wsStalePlugins.value.has(msg.plugin)) {
            const next = new Set(wsStalePlugins.value);
            next.delete(msg.plugin);
            wsStalePlugins.value = next;
        }
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
    if (wsDestroyed) return;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sessions/${sessionId.value}/progress`;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
        try { handleDetailWsEvent(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
        // 始终尝试重连（除非组件已卸载）
        // 注意：即使分析已完成(ready)，后续仍可能触发重跑，需要收到新的 init/stale 消息
        if (!wsDestroyed) {
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
    wsDestroyed = true;
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

/* ── 右侧工具按钮组 ──────────────────────────────────────────────────────── */
.tab-nav-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.btn-help {
    font-size: 13px; font-weight: 700; min-width: 30px; padding: 6px 10px;
    color: var(--text-muted); border-color: var(--border-color);
}
.btn-help:hover { color: #a5b4fc; border-color: rgba(99,102,241,0.4); background: rgba(99,102,241,0.1); }

/* ── stale Tab 徽标 ───────────────────────────────────────────────────────── */
.tab-stale-dot {
    display: inline-block;
    margin-left: 4px;
    font-size: 10px;
    color: #fb923c;
    vertical-align: middle;
    line-height: 1;
}
.tab-stale { border-color: rgba(251, 146, 60, 0.35) !important; }
.tab-stale:not(.tab-active) { color: #fb923c !important; }

/* ── stale 警告横幅 ───────────────────────────────────────────────────────── */
.stale-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: rgba(251, 146, 60, 0.08);
    border: 1px solid rgba(251, 146, 60, 0.3);
    border-radius: 8px;
    color: #fdba74;
    font-size: 13px;
    line-height: 1.5;
}
.stale-banner-icon { font-size: 16px; flex-shrink: 0; }
.stale-banner-text { flex: 1; }
.stale-banner-text strong { color: #fed7aa; }
.stale-banner-btn {
    flex-shrink: 0;
    padding: 4px 12px; border-radius: 6px; border: 1px solid rgba(251, 146, 60, 0.4);
    background: rgba(251, 146, 60, 0.15); color: #fb923c;
    font-size: 12px; cursor: pointer; white-space: nowrap;
    transition: all 0.15s;
}
.stale-banner-btn:hover {
    background: rgba(251, 146, 60, 0.25);
    color: #fed7aa;
}

</style>
