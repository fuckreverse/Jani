<template>
  <teleport to="body">
    <transition name="drawer-fade">
      <div v-if="visible" class="drawer-overlay" @click.self="$emit('close')">
        <div class="progress-drawer" :class="{ 'drawer-open': visible }">
          <!-- 头部 -->
          <div class="drawer-header">
            <div class="drawer-title-row">
              <span class="drawer-icon">{{ overallIcon }}</span>
              <div>
                <div class="drawer-title">分析进度</div>
                <div v-if="sessionName" class="drawer-subtitle">{{ sessionName }}</div>
              </div>
            </div>
            <button class="drawer-close" @click="$emit('close')">✕</button>
          </div>

          <!-- 总进度条 -->
          <div class="overall-progress">
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: overallPercent + '%' }" :class="overallClass"></div>
            </div>
            <span class="progress-text">{{ doneCount }}/{{ totalCount }}</span>
          </div>

          <!-- 阶段列表 -->
          <div class="phases-container">
            <div v-for="phase in phases" :key="phase.id" class="phase-group">
              <div class="phase-header" @click="phase.expanded = !phase.expanded">
                <span class="phase-icon">{{ phaseIcon(phase) }}</span>
                <span class="phase-label">{{ phase.label }}</span>
                <span v-if="isPhaseStale(phase.id)" class="phase-stale-badge" title="该阶段含有过期数据，建议重新分析">⚠️ 已过期</span>
                <span class="phase-badge" :class="phaseBadgeClass(phase)">{{ phaseSummary(phase) }}</span>
                <span class="phase-chevron">{{ phase.expanded ? '▾' : '▸' }}</span>
              </div>
              <transition name="collapse">
                <div v-if="phase.expanded" class="plugin-list">
                  <div
                    v-for="pid in phase.plugins"
                    :key="pid"
                    class="plugin-row"
                    :class="'plugin-' + getPluginStatus(pid)"
                  >
                    <span class="plugin-status-icon">{{ pluginIcon(getPluginStatus(pid)) }}</span>
                    <div class="plugin-main">
                      <div class="plugin-top-row">
                        <span class="plugin-name">{{ (PLUGIN_META[pid] || {}).label || pid }}</span>
                        <span v-if="isPluginStale(pid)" class="plugin-stale-badge" title="上游数据已更新，该插件结果可能过期，建议重新分析">⚠️ 已过期</span>
                        <span v-if="getPluginDuration(pid)" class="plugin-duration">{{ formatDuration(getPluginDuration(pid)) }}</span>
                        <span v-if="getPluginStatus(pid) === 'running'" class="plugin-spinner"></span>
                      </div>
                      <!-- 运行中：进度条 + message -->
                      <template v-if="getPluginStatus(pid) === 'running' && getPluginProgress(pid)">
                        <div class="plugin-progress-track">
                          <div class="plugin-progress-fill" :style="{ width: getPluginProgress(pid).pct + '%' }"></div>
                        </div>
                        <div class="plugin-progress-msg">
                          <span class="plugin-msg-text">{{ getPluginProgress(pid).message }}</span>
                          <span v-if="getPluginProgress(pid).eventsPerSec > 0" class="plugin-rate">
                            {{ (getPluginProgress(pid).eventsPerSec / 1000).toFixed(0) }}k ev/s
                          </span>
                        </div>
                      </template>
                      <!-- 未运行：显示描述 -->
                      <span v-else class="plugin-desc">{{ (PLUGIN_META[pid] || {}).desc || '' }}</span>
                    </div>
                  </div>
                </div>
              </transition>
            </div>
          </div>

          <!-- 错误日志 -->
          <div v-if="errors.length > 0" class="error-log">
            <div class="error-log-title">⚠️ 错误</div>
            <div v-for="(err, i) in errors" :key="i" class="error-item">{{ err }}</div>
          </div>

          <!-- 底部：分阶段操作按钮 -->
          <div class="drawer-footer">
            <div class="phase-actions">
              <!-- Phase 2 -->
              <button
                class="btn-phase btn-phase2"
                :class="{ 'btn-rerun': isPhaseRun('phase2'), 'btn-stale': isPhaseStale('phase2') }"
                :disabled="isPhaseRunning('phase2') || isAnalyzingAny"
                @click="triggerPhase('phase2')"
                :title="isPhaseStale('phase2') ? '⚠️ 该阶段含过期数据，建议重新分析 | F3 调用图 / F4 变量生命周期 / A3 热路径' : 'F3 调用图 / F4 变量生命周期 / A3 热路径'"
              >
                <span class="phase-btn-icon">{{ isPhaseRunning('phase2') ? '⏳' : isPhaseStale('phase2') ? '⚠️' : isPhaseRun('phase2') ? '🔄' : '▶' }}</span>
                {{ isPhaseRunning('phase2') ? 'P2 分析中...' : isPhaseStale('phase2') ? '重分析 P2 (过期)' : isPhaseRun('phase2') ? '重新分析 P2' : '分析 Phase 2' }}
              </button>
              <!-- Phase 3 -->
              <button
                class="btn-phase btn-phase3"
                :class="{ 'btn-rerun': isPhaseRun('phase3'), 'btn-stale': isPhaseStale('phase3') }"
                :disabled="isPhaseRunning('phase3') || isAnalyzingAny"
                @click="triggerPhase('phase3')"
                :title="isPhaseStale('phase3') ? '⚠️ 该阶段含过期数据，建议重新分析 | A5 循环 / A8 值模式 / I1 加密检测 / I2 签名' : 'A5 循环 / A8 值模式 / I1 加密检测 / I2 签名'"
              >
                <span class="phase-btn-icon">{{ isPhaseRunning('phase3') ? '⏳' : isPhaseStale('phase3') ? '⚠️' : isPhaseRun('phase3') ? '🔄' : '▶' }}</span>
                {{ isPhaseRunning('phase3') ? 'P3 分析中...' : isPhaseStale('phase3') ? '重分析 P3 (过期)' : isPhaseRun('phase3') ? '重新分析 P3' : '分析 Phase 3' }}
              </button>
              <!-- Phase 4 -->
              <button
                class="btn-phase btn-phase4"
                :class="{ 'btn-rerun': isPhaseRun('phase4'), 'btn-stale': isPhaseStale('phase4') }"
                :disabled="isPhaseRunning('phase4') || isAnalyzingAny"
                @click="triggerPhase('phase4')"
                :title="isPhaseStale('phase4') ? '⚠️ 该阶段含过期数据，建议重新分析 | A2 数据流 / A4 字符串 / A7 对象变异 / I3 混淆 / I4 算法汇总' : 'A2 数据流 / A4 字符串 / A7 对象变异 / I3 混淆 / I4 算法汇总'"
              >
                <span class="phase-btn-icon">{{ isPhaseRunning('phase4') ? '⏳' : isPhaseStale('phase4') ? '⚠️' : isPhaseRun('phase4') ? '🔄' : '✨' }}</span>
                {{ isPhaseRunning('phase4') ? 'P4 分析中...' : isPhaseStale('phase4') ? '重分析 P4 (过期)' : isPhaseRun('phase4') ? '重新分析 P4' : '分析 Phase 4' }}
              </button>
            </div>
            <div class="footer-status">
              <template v-if="isFinished && !isAnalyzingAny">
                <span class="finish-text">✅ 分析完成</span>
                <button class="btn-view" @click="$emit('view-session')">查看详情 →</button>
              </template>
              <template v-else-if="isAnalyzingAny">
                <span class="running-text">{{ statusText }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

// ── Props / Emits ─────────────────────────────────────────────────────────────
const props = defineProps({
    visible:     { type: Boolean, default: false },
    sessionId:   { type: String,  default: null },
    sessionName: { type: String,  default: '' },
});
const emit = defineEmits(['close', 'view-session']);

// ── 插件元数据 ────────────────────────────────────────────────────────────────
const PLUGIN_META = {
    'F1-EventIndex':             { label: 'F1 事件索引',      desc: '解析 trace 二进制，建立事件索引' },
    'F2-SmapLoader':             { label: 'F2 源码映射',      desc: '加载 .smap.json 源码位置信息' },
    'F3-CallGraphBuilder':       { label: 'F3 调用图',        desc: '重建函数调用关系图' },
    'F4-VariableLifetime':       { label: 'F4 变量生命周期',  desc: '统计变量读写次数和生命周期' },
    'A3-HotPathAnalyzer':        { label: 'A3 热路径',        desc: '统计执行频率，检测循环' },
    'A5-LoopDetector':           { label: 'A5 循环检测',      desc: '展开循环迭代，记录变量快照' },
    'A8-ValuePatternDetector':   { label: 'A8 值模式',        desc: '检测高频魔术常数' },
    'I1-CryptoDetector':         { label: 'I1 加密检测',      desc: '识别 AES/MD5/SHA 等加密算法' },
    'I2-SignatureAnalyzer':      { label: 'I2 签名分析',      desc: '追踪签名/Token 计算路径' },
    'A2-DataFlowGraph':          { label: 'A2 数据流图',      desc: '构建 def-use 数据流图' },
    'A7-ObjectMutationTracker':  { label: 'A7 对象变异',      desc: '重建对象属性变化时间线' },
    'I3-ObfuscationDetector':    { label: 'I3 混淆检测',      desc: '识别变量名混淆和控制流平坦化' },
    'I4-AlgorithmSummarizer':    { label: 'I4 算法汇总',      desc: '生成综合分析报告' },
};

const PHASES_CONFIG = [
    { id: 'phase1', label: 'Phase 1 · 基础解析', plugins: ['F1-EventIndex', 'F2-SmapLoader'] },
    { id: 'phase2', label: 'Phase 2 · 索引构建', plugins: ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'] },
    { id: 'phase3', label: 'Phase 3 · 深度分析', plugins: ['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer'] },
    { id: 'phase4', label: 'Phase 4 · 完整分析', plugins: ['A2-DataFlowGraph', 'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer'] },
];

// ── 状态 ─────────────────────────────────────────────────────────────────────
const pluginStatusMap   = ref({});
const pluginDurationMap = ref({});
const pluginProgressMap = ref({}); // pluginId → { pct, message, eventsPerSec, totalEvents }
const pluginStaleMap    = ref({}); // pluginId → true/false（上游数据已更新，结果可能过期）
const sessionStatus     = ref('');
const errors            = ref([]);
const enabledPlugins    = ref(new Set());
// 展开状态单独维护（避免修改常量）
const phases = ref(PHASES_CONFIG.map((p, i) => ({ ...p, expanded: i < 2 })));

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

function connectWs() {
    if (!props.sessionId) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/sessions/${props.sessionId}/progress`);
    ws.onopen = () => {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };
    ws.onmessage = (e) => {
        try { handleWsEvent(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
        if (!isFinished.value) reconnectTimer = setTimeout(connectWs, 3000);
    };
    ws.onerror = () => ws.close();
}

function disconnectWs() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.close(); ws = null; }
}

function handleWsEvent(evt) {
    if (evt.type === 'init') {
        sessionStatus.value = evt.status || '';
        if (evt.pluginStatus) {
            for (const [id, st] of Object.entries(evt.pluginStatus)) {
                pluginStatusMap.value[id] = st;
                enabledPlugins.value.add(id);
            }
        }
        if (evt.checkpoints) {
            for (const cp of evt.checkpoints) {
                pluginStatusMap.value[cp.plugin_id] = 'done';
                if (cp.duration_ms) pluginDurationMap.value[cp.plugin_id] = cp.duration_ms;
                if (cp.is_stale) pluginStaleMap.value[cp.plugin_id] = true;
                enabledPlugins.value.add(cp.plugin_id);
            }
        }
        autoExpandActivePhases();

    } else if (evt.type === 'schedule_start') {
        for (const id of (evt.toRun || [])) { pluginStatusMap.value[id] = 'pending'; enabledPlugins.value.add(id); }
        for (const id of (evt.skipped || [])) pluginStatusMap.value[id] = 'skipped';
        autoExpandActivePhases();

    } else if (evt.type === 'phase_start') {
        for (const id of (evt.plugins || [])) {
            if (!pluginStatusMap.value[id]) { pluginStatusMap.value[id] = 'pending'; enabledPlugins.value.add(id); }
        }
        expandPhase(evt.phase);

    } else if (evt.type === 'plugin_start') {
        pluginStatusMap.value[evt.plugin] = 'running';
        pluginProgressMap.value[evt.plugin] = { pct: 0, message: '开始执行...', eventsPerSec: 0, totalEvents: 0 };
        sessionStatus.value = 'processing';

    } else if (evt.plugin && evt.status === 'running' && evt.message != null) {
        // 插件内部进度更新（来自 emitProgress）
        pluginProgressMap.value[evt.plugin] = {
            pct:          evt.progress ?? pluginProgressMap.value[evt.plugin]?.pct ?? 0,
            message:      evt.message,
            eventsPerSec: evt.eventsPerSec ?? 0,
            totalEvents:  evt.totalEvents  ?? 0,
        };

    } else if (evt.type === 'plugin_done') {
        pluginStatusMap.value[evt.plugin] = 'done';
        if (evt.durationMs) pluginDurationMap.value[evt.plugin] = evt.durationMs;
        delete pluginProgressMap.value[evt.plugin];
        // 插件重跑完成，清除 stale 标记
        delete pluginStaleMap.value[evt.plugin];

    } else if (evt.type === 'plugin_failed') {
        pluginStatusMap.value[evt.plugin] = 'failed';
        if (evt.error) errors.value.push(`${evt.plugin}: ${evt.error}`);

    } else if (evt.type === 'all_done') {
        sessionStatus.value = 'ready';

    } else if (evt.type === 'error') {
        if (evt.message) errors.value.push(evt.message);

    } else if (evt.plugin && evt.status) {
        // 兼容旧格式（无 type 字段）
        pluginStatusMap.value[evt.plugin] = evt.status;
        if (evt.durationMs) pluginDurationMap.value[evt.plugin] = evt.durationMs;
        enabledPlugins.value.add(evt.plugin);
    }
}

// ── 阶段状态判断 ──────────────────────────────────────────────────────────────
const PHASE_PLUGIN_MAP = {
    phase2: ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'],
    phase3: ['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer'],
    phase4: ['A2-DataFlowGraph', 'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer'],
};

// 该阶段是否已运行过（至少有一个插件 done/skipped/failed）
function isPhaseRun(phaseId) {
    const plugins = PHASE_PLUGIN_MAP[phaseId] || [];
    return plugins.some(id => {
        const s = pluginStatusMap.value[id];
        return s === 'done' || s === 'skipped' || s === 'failed';
    });
}

// 该阶段是否正在运行
function isPhaseRunning(phaseId) {
    const plugins = PHASE_PLUGIN_MAP[phaseId] || [];
    return plugins.some(id => {
        const s = pluginStatusMap.value[id];
        return s === 'running' || s === 'pending';
    });
}

// 任意阶段有任务在跑
const isAnalyzingAny = computed(() =>
    Object.values(pluginStatusMap.value).some(s => s === 'running' || s === 'pending')
);

// 触发阶段（统一使用 /re-run 接口，forceRerun: true 确保重跑已完成的插件）
const phaseApiMap = {
    phase2: (id) => fetch(`/api/sessions/${id}/re-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'phase2', forceRerun: true }) }),
    phase3: (id) => fetch(`/api/sessions/${id}/re-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'phase3', forceRerun: true }) }),
    phase4: (id) => fetch(`/api/sessions/${id}/re-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'phase4', forceRerun: true }) }),
};

async function triggerPhase(phaseId) {
    if (!props.sessionId) return;
    const fn = phaseApiMap[phaseId];
    if (!fn) return;
    try {
        const res = await fn(props.sessionId);
        if (!res.ok) console.error(`triggerPhase ${phaseId} HTTP ${res.status}`);
    } catch (e) {
        console.error(`triggerPhase ${phaseId} error:`, e);
    }
}

function expandPhase(phaseId) {
    const p = phases.value.find(p => p.id === phaseId);
    if (p) p.expanded = true;
}

function autoExpandActivePhases() {
    for (const phase of phases.value) {
        if (phase.plugins.some(id => pluginStatusMap.value[id])) phase.expanded = true;
    }
}

// ── 计算属性 ─────────────────────────────────────────────────────────────────
const ALL_PLUGINS = PHASES_CONFIG.flatMap(p => p.plugins);

const trackedPlugins = computed(() =>
    enabledPlugins.value.size > 0
        ? [...enabledPlugins.value]
        : ['F1-EventIndex', 'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer']
);

const totalCount = computed(() => trackedPlugins.value.length);

const doneCount = computed(() =>
    trackedPlugins.value.filter(id => {
        const st = pluginStatusMap.value[id];
        return st === 'done' || st === 'skipped';
    }).length
);

const overallPercent = computed(() =>
    totalCount.value === 0 ? 0 : Math.round(doneCount.value / totalCount.value * 100)
);

const hasRunning = computed(() => Object.values(pluginStatusMap.value).some(s => s === 'running'));
const hasFailed  = computed(() => Object.values(pluginStatusMap.value).some(s => s === 'failed'));

const isFinished = computed(() =>
    sessionStatus.value === 'ready' ||
    (doneCount.value > 0 && doneCount.value >= totalCount.value && !hasRunning.value)
);

const overallClass = computed(() =>
    hasFailed.value ? 'fill-failed' :
    hasRunning.value ? 'fill-running' :
    isFinished.value ? 'fill-done' : 'fill-pending'
);

const overallIcon = computed(() =>
    hasFailed.value ? '❌' :
    hasRunning.value ? '⚡' :
    isFinished.value ? '✅' : '🔬'
);

const statusText = computed(() => {
    if (hasRunning.value) return '分析进行中，请稍候…';
    const pending = Object.entries(pluginStatusMap.value)
        .filter(([, s]) => s === 'pending').map(([id]) => id);
    if (pending.length) return `等待执行: ${pending.slice(0, 2).join(', ')}…`;
    return '已调度，等待后端处理…';
});

function phaseIcon(phase) {
    const sts = phase.plugins.map(id => pluginStatusMap.value[id]).filter(Boolean);
    if (sts.some(s => s === 'failed'))  return '❌';
    if (sts.some(s => s === 'running')) return '⚡';
    if (sts.length && sts.every(s => s === 'done' || s === 'skipped')) return '✅';
    if (sts.some(s => s === 'pending')) return '⏳';
    return '○';
}

function phaseSummary(phase) {
    const done = phase.plugins.filter(id => {
        const s = pluginStatusMap.value[id];
        return s === 'done' || s === 'skipped';
    }).length;
    return `${done}/${phase.plugins.length}`;
}

function phaseBadgeClass(phase) {
    const icon = phaseIcon(phase);
    return icon === '✅' ? 'badge-done'    :
           icon === '⚡' ? 'badge-running' :
           icon === '❌' ? 'badge-failed'  :
           icon === '⏳' ? 'badge-pending' : 'badge-idle';
}

function getPluginStatus(id)   { return pluginStatusMap.value[id] || 'idle'; }
function getPluginDuration(id) { return pluginDurationMap.value[id] || null; }
function getPluginProgress(id) { return pluginProgressMap.value[id] || null; }
function isPluginStale(id)     { return !!pluginStaleMap.value[id]; }
/** 判断某阶段是否含有任何 stale 插件（用于阶段标题行和按钮高亮） */
function isPhaseStale(phaseId) {
    const plugins = PHASE_PLUGIN_MAP[phaseId] || [];
    return plugins.some(id => !!pluginStaleMap.value[id]);
}

function pluginIcon(status) {
    const icons = { done: '✓', skipped: '↩', running: '…', failed: '✗', pending: '○', idle: '·' };
    return icons[status] || '·';
}

function formatDuration(ms) {
    if (!ms) return '';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────
watch(() => props.visible, (v) => {
    if (v && props.sessionId) connectWs();
    else disconnectWs();
});

watch(() => props.sessionId, (id) => {
    disconnectWs();
    pluginStatusMap.value = {};
    pluginDurationMap.value = {};
    pluginProgressMap.value = {};
    pluginStaleMap.value = {};
    errors.value = [];
    enabledPlugins.value = new Set();
    phases.value = PHASES_CONFIG.map((p, i) => ({ ...p, expanded: i < 2 }));
    if (id && props.visible) connectWs();
});

onMounted(() => {
    if (props.visible && props.sessionId) connectWs();
});

onUnmounted(() => disconnectWs());
</script>

<style scoped>
.drawer-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 2000;
    display: flex; align-items: flex-start; justify-content: flex-end;
}

.progress-drawer {
    width: 380px; max-width: 95vw; height: 100vh;
    background: var(--bg-primary, #0f1117);
    border-left: 1px solid var(--border-color, #2d3148);
    display: flex; flex-direction: column; overflow: hidden;
    transform: translateX(100%);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.drawer-open { transform: translateX(0); }

.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity 0.2s; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }

/* 头部 */
.drawer-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
}
.drawer-title-row { display: flex; align-items: center; gap: 12px; }
.drawer-icon { font-size: 22px; }
.drawer-title { font-size: 15px; font-weight: 700; color: var(--text-primary, #e2e8f0); }
.drawer-subtitle {
    font-size: 11px; color: var(--text-muted, #64748b); margin-top: 2px;
    max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.drawer-close {
    background: transparent; border: none;
    color: var(--text-muted, #64748b); font-size: 14px;
    cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: all .15s;
}
.drawer-close:hover { background: var(--bg-tertiary, #1e2235); color: var(--text-primary, #e2e8f0); }

/* 总进度条 */
.overall-progress {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
}
.progress-track {
    flex: 1; height: 6px;
    background: var(--bg-tertiary, #1e2235);
    border-radius: 3px; overflow: hidden;
}
.progress-fill { height: 100%; border-radius: 3px; transition: width .4s ease, background .3s; }
.fill-running { background: linear-gradient(90deg, #3b82f6, #6366f1); animation: ppulse 1.5s ease-in-out infinite; }
.fill-done    { background: #22c55e; }
.fill-failed  { background: #ef4444; }
.fill-pending { background: #475569; }
@keyframes ppulse { 0%, 100% { opacity: 1; } 50% { opacity: .7; } }
.progress-text { font-size: 11px; color: var(--text-muted, #64748b); min-width: 36px; text-align: right; }

/* 阶段容器 */
.phases-container { flex: 1; overflow-y: auto; padding: 8px 0; }
.phase-group { border-bottom: 1px solid rgba(45, 49, 72, .5); }
.phase-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 20px; cursor: pointer; user-select: none; transition: background .15s;
}
.phase-header:hover { background: var(--bg-secondary, #161b2e); }
.phase-icon { font-size: 14px; }
.phase-label { flex: 1; font-size: 12px; font-weight: 600; color: var(--text-primary, #e2e8f0); }
.phase-badge { font-size: 10px; padding: 2px 6px; border-radius: 8px; font-weight: 600; }
.badge-done    { background: rgba(34, 197, 94, .15);  color: #86efac; }
.badge-running { background: rgba(99, 102, 241, .15); color: #a5b4fc; animation: bblink 1.2s infinite; }
.badge-failed  { background: rgba(239, 68, 68, .15);  color: #fca5a5; }
.badge-pending { background: rgba(71, 85, 105, .3);   color: #94a3b8; }
.badge-idle    { background: rgba(71, 85, 105, .15);  color: #64748b; }
@keyframes bblink { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
.phase-chevron { font-size: 10px; color: var(--text-muted, #64748b); }

/* 插件行 */
.plugin-list { padding: 4px 20px 10px 32px; }
.plugin-row {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 5px 8px; border-radius: 6px; margin-bottom: 2px;
    font-size: 12px; transition: background .15s;
}
.plugin-row:hover { background: var(--bg-secondary, #161b2e); }
.plugin-done    { color: #86efac; }
.plugin-skipped { color: #64748b; }
.plugin-running { color: #a5b4fc; background: rgba(99, 102, 241, .05); }
.plugin-failed  { color: #fca5a5; }
.plugin-pending { color: #94a3b8; }
.plugin-idle    { color: #475569; }
.plugin-status-icon { width: 14px; text-align: center; font-size: 11px; padding-top: 2px; flex-shrink: 0; }

/* 插件主体：name 行 + 进度条 + desc */
.plugin-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.plugin-top-row { display: flex; align-items: center; gap: 6px; }
.plugin-name {
    font-weight: 600; font-family: monospace; font-size: 11px; flex-shrink: 0;
}
.plugin-desc {
    color: var(--text-muted, #64748b); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.plugin-duration { font-size: 10px; color: var(--text-muted, #64748b); font-family: monospace; margin-left: auto; flex-shrink: 0; }

/* 阶段标题行 stale 徽标 */
.phase-stale-badge {
    font-size: 10px; font-weight: 600;
    padding: 1px 5px; border-radius: 4px;
    background: rgba(251, 146, 60, 0.15);
    border: 1px solid rgba(251, 146, 60, 0.35);
    color: #fb923c;
    cursor: help;
    flex-shrink: 0;
}

/* 阶段按钮 stale 状态（橙色高亮覆盖默认 rerun 样式） */
.btn-phase2.btn-stale { background: rgba(251,146,60,0.12); border-color: rgba(251,146,60,0.5); color: #fb923c; }
.btn-phase2.btn-stale:hover:not(:disabled) { background: rgba(251,146,60,0.22); color: #fed7aa; }
.btn-phase3.btn-stale { background: rgba(251,146,60,0.12); border-color: rgba(251,146,60,0.5); color: #fb923c; }
.btn-phase3.btn-stale:hover:not(:disabled) { background: rgba(251,146,60,0.22); color: #fed7aa; }
.btn-phase4.btn-stale { background: rgba(251,146,60,0.12); border-color: rgba(251,146,60,0.5); color: #fb923c; }
.btn-phase4.btn-stale:hover:not(:disabled) { background: rgba(251,146,60,0.22); color: #fed7aa; }

.plugin-stale-badge {
    font-size: 10px; font-weight: 600; flex-shrink: 0;
    padding: 1px 5px; border-radius: 4px;
    background: rgba(251, 146, 60, 0.15);
    border: 1px solid rgba(251, 146, 60, 0.35);
    color: #fb923c;
    cursor: help;
}
.plugin-spinner {
    display: inline-block; width: 10px; height: 10px; flex-shrink: 0;
    border: 2px solid rgba(99, 102, 241, .3);
    border-top-color: #6366f1;
    border-radius: 50%; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 插件内部进度条 */
.plugin-progress-track {
    height: 3px; background: rgba(99, 102, 241, .15);
    border-radius: 2px; overflow: hidden;
}
.plugin-progress-fill {
    height: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1);
    border-radius: 2px; transition: width .4s ease;
}
.plugin-progress-msg {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.plugin-msg-text {
    font-size: 10px; color: var(--text-muted, #64748b);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
}
.plugin-rate {
    font-size: 10px; color: #6366f1; font-family: monospace;
    flex-shrink: 0; font-weight: 600;
}

/* 展开/折叠过渡 */
.collapse-enter-active, .collapse-leave-active { transition: max-height .2s ease, opacity .2s; overflow: hidden; }
.collapse-enter-from, .collapse-leave-to { max-height: 0; opacity: 0; }
.collapse-enter-to, .collapse-leave-from { max-height: 600px; opacity: 1; }

/* 错误日志 */
.error-log {
    margin: 8px 16px; padding: 10px 14px;
    background: rgba(239, 68, 68, .08);
    border: 1px solid rgba(239, 68, 68, .2);
    border-radius: 8px; flex-shrink: 0;
}
.error-log-title { font-size: 11px; font-weight: 600; color: #fca5a5; margin-bottom: 6px; }
.error-item { font-size: 11px; color: #fca5a5; font-family: monospace; line-height: 1.5; }

/* 底部 */
.drawer-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--border-color, #2d3148);
    display: flex; flex-direction: column; gap: 10px;
    flex-shrink: 0;
}
.phase-actions {
    display: flex; gap: 6px; flex-wrap: wrap;
}
.btn-phase {
    flex: 1; min-width: 0;
    padding: 7px 8px; border-radius: 6px; border: 1px solid;
    font-size: 11px; cursor: pointer; transition: all .15s;
    display: flex; align-items: center; gap: 5px; justify-content: center;
    white-space: nowrap;
}
.btn-phase:disabled { opacity: 0.45; cursor: not-allowed; }
.phase-btn-icon { font-size: 12px; flex-shrink: 0; }

.btn-phase2 {
    background: rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.3); color: #fcd34d;
}
.btn-phase2:hover:not(:disabled) { background: rgba(251,191,36,0.18); }
.btn-phase2.btn-rerun {
    background: rgba(251,191,36,0.05); border-color: rgba(251,191,36,0.2); color: #92742b;
}
.btn-phase2.btn-rerun:hover:not(:disabled) { background: rgba(251,191,36,0.12); color: #fcd34d; }

.btn-phase3 {
    background: rgba(34,197,94,0.08); border-color: rgba(34,197,94,0.3); color: #86efac;
}
.btn-phase3:hover:not(:disabled) { background: rgba(34,197,94,0.18); }
.btn-phase3.btn-rerun {
    background: rgba(34,197,94,0.05); border-color: rgba(34,197,94,0.2); color: #2d6b47;
}
.btn-phase3.btn-rerun:hover:not(:disabled) { background: rgba(34,197,94,0.12); color: #86efac; }

.btn-phase4 {
    background: rgba(168,85,247,0.08); border-color: rgba(168,85,247,0.3); color: #d8b4fe;
}
.btn-phase4:hover:not(:disabled) { background: rgba(168,85,247,0.18); }
.btn-phase4.btn-rerun {
    background: rgba(168,85,247,0.05); border-color: rgba(168,85,247,0.2); color: #6b3d8a;
}
.btn-phase4.btn-rerun:hover:not(:disabled) { background: rgba(168,85,247,0.12); color: #d8b4fe; }

.footer-status {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    min-height: 24px;
}
.finish-text  { font-size: 12px; color: #86efac; }
.running-text { font-size: 12px; color: var(--text-muted, #64748b); }
.btn-view {
    padding: 5px 14px; border-radius: 6px;
    border: 1px solid rgba(99, 102, 241, .4);
    background: rgba(99, 102, 241, .15);
    color: #a5b4fc; font-size: 12px; cursor: pointer; transition: all .15s;
}
.btn-view:hover { background: rgba(99, 102, 241, .25); }
</style>
