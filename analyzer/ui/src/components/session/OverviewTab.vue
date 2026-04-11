<template>
  <div class="overview-tab">

    <!-- 基础信息 -->
    <div class="section card">
      <div class="section-title">📋 会话信息</div>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">会话 ID</span>
          <code class="meta-value mono">{{ session.id }}</code>
        </div>
        <div class="meta-item">
          <span class="meta-label">状态</span>
          <span class="badge" :class="`badge-${session.status}`">{{ statusLabel(session.status) }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">事件总数</span>
          <span class="meta-value highlight">{{ session.event_count?.toLocaleString('zh-CN') ?? '—' }} 条</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">创建时间</span>
          <span class="meta-value">{{ formatDate(session.created_at) }}</span>
        </div>
        <div class="meta-item" v-if="session.updated_at">
          <span class="meta-label">最后更新</span>
          <span class="meta-value">{{ formatDate(session.updated_at) }}</span>
        </div>
        <div class="meta-item" v-if="session.smapCount">
          <span class="meta-label">IID 映射数</span>
          <span class="meta-value">{{ session.smapCount?.toLocaleString('zh-CN') }} 条</span>
        </div>
      </div>
    </div>

    <!-- 文件信息 -->
    <div class="section card" v-if="session.fileInfo">
      <div class="section-title">📂 文件信息</div>
      <div class="file-items">
        <!-- Trace .bin -->
        <div class="file-item" :class="{ 'file-missing': session.fileInfo.binFile?.missing }">
          <span class="file-icon">📦</span>
          <div class="file-detail">
            <span class="file-label">Trace .bin</span>
            <code class="file-name">{{ session.fileInfo.binFile?.name || '未上传' }}</code>
            <span class="file-size" v-if="session.fileInfo.binFile?.size != null">
              {{ formatBytes(session.fileInfo.binFile.size) }}
            </span>
            <span class="file-missing-tag" v-if="session.fileInfo.binFile?.missing">⚠️ 文件缺失</span>
          </div>
        </div>
        <!-- smap.json -->
        <div class="file-item" :class="{ 'file-missing': session.fileInfo.smapFile?.missing, 'file-absent': !session.fileInfo.smapFile }">
          <span class="file-icon">🗺️</span>
          <div class="file-detail">
            <span class="file-label">smap.json</span>
            <code class="file-name" v-if="session.fileInfo.smapFile">{{ session.fileInfo.smapFile.name }}</code>
            <span class="file-name text-muted" v-else>未上传</span>
            <span class="file-size" v-if="session.fileInfo.smapFile?.size != null">
              {{ formatBytes(session.fileInfo.smapFile.size) }}
            </span>
            <span class="file-badge-ok" v-if="session.smapCount > 0">
              ✅ {{ session.smapCount?.toLocaleString('zh-CN') }} 条 IID 映射
            </span>
            <span class="file-missing-tag" v-if="session.fileInfo.smapFile?.missing">⚠️ 文件缺失</span>
          </div>
        </div>
        <!-- 源码 .js -->
        <div class="file-item" :class="{ 'file-missing': session.fileInfo.sourceFile?.missing, 'file-absent': !session.fileInfo.sourceFile }">
          <span class="file-icon">📄</span>
          <div class="file-detail">
            <span class="file-label">源码 .js</span>
            <code class="file-name" v-if="session.fileInfo.sourceFile">{{ session.fileInfo.sourceFile.name }}</code>
            <span class="file-name text-muted" v-else>未上传</span>
            <span class="file-size" v-if="session.fileInfo.sourceFile?.size != null">
              {{ formatBytes(session.fileInfo.sourceFile.size) }}
            </span>
            <span class="file-missing-tag" v-if="session.fileInfo.sourceFile?.missing">⚠️ 文件缺失</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 插件分析进度 -->
    <div class="section card">
      <div class="section-title-row">
        <span class="section-title">🔍 分析进度</span>
        <button class="btn-detail" @click="$emit('openProgress')">详细进度 ›</button>
      </div>

      <div v-if="isAnalyzing" class="analyzing-banner">
        <div class="analyzing-bar">
          <div class="analyzing-fill" :style="{ width: inlineProgressPct + '%' }"></div>
        </div>
        <span class="analyzing-text">{{ inlineProgressPct }}% · {{ runningPlugin || '分析中…' }}</span>
      </div>

      <div class="plugin-list">
        <div
          v-for="(status, pid) in allPluginStatus"
          :key="pid"
          class="plugin-row"
          :class="'plugin-row-' + status"
        >
          <span class="plugin-dot" :class="'plugin-dot-' + status"></span>
          <span class="plugin-name">{{ pluginLabel(pid) }}</span>
          <span class="plugin-badge" :class="'plugin-badge-' + status">{{ statusText(status) }}</span>
          <span class="plugin-duration" v-if="pluginDuration[pid]">
            {{ pluginDuration[pid] >= 1000
              ? (pluginDuration[pid] / 1000).toFixed(1) + 's'
              : pluginDuration[pid] + 'ms' }}
          </span>
        </div>
        <div v-if="Object.keys(allPluginStatus).length === 0" class="no-plugins">
          暂无插件状态信息
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { computed } from 'vue';
import { formatDate, formatBytes, statusLabel } from '../../composables/useSessionUtils.js';

const props = defineProps({
    session:           { type: Object,  required: true },
    pluginStatus:      { type: Object,  default: () => ({}) },
    pluginDuration:    { type: Object,  default: () => ({}) },
    isAnalyzing:       { type: Boolean, default: false },
    inlineProgressPct: { type: Number,  default: 0 },
    runningPlugin:     { type: String,  default: '' },
});

defineEmits(['openProgress']);

const ALL_PLUGIN_IDS = [
    'F1-EventIndex', 'F2-SmapLoader',
    'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer',
    'A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer',
    'A2-DataFlowGraph', 'A4-StringTracker',
    'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer',
];

const PLUGIN_LABELS = {
    'F1-EventIndex':            'F1 · 事件索引',
    'F2-SmapLoader':            'F2 · 源码映射',
    'F3-CallGraphBuilder':      'F3 · 调用图构建',
    'F4-VariableLifetime':      'F4 · 变量生命周期',
    'A3-HotPathAnalyzer':       'A3 · 热路径分析',
    'A5-LoopDetector':          'A5 · 循环检测',
    'A8-ValuePatternDetector':  'A8 · 值模式检测',
    'I1-CryptoDetector':        'I1 · 加密检测',
    'I2-SignatureAnalyzer':     'I2 · 签名分析',
    'A2-DataFlowGraph':         'A2 · 数据流图',
    'A4-StringTracker':         'A4 · 字符串追踪',
    'A7-ObjectMutationTracker': 'A7 · 对象变异追踪',
    'I3-ObfuscationDetector':   'I3 · 混淆检测',
    'I4-AlgorithmSummarizer':   'I4 · 算法汇总',
};

function pluginLabel(pid) { return PLUGIN_LABELS[pid] || pid; }

function statusText(s) {
    return { done: '✅ 完成', running: '⏳ 运行中', pending: '⏸ 等待', failed: '❌ 失败', skipped: '⏭ 跳过', idle: '— 空闲' }[s] ?? s;
}

// 合并已知插件列表与实际状态
const allPluginStatus = computed(() => {
    const result = {};
    // 先填入已知插件（显示为 idle）
    for (const id of ALL_PLUGIN_IDS) result[id] = 'idle';
    // 覆盖实际状态
    for (const [id, s] of Object.entries(props.pluginStatus)) result[id] = s;
    return result;
});
</script>

<style scoped>
.overview-tab {
    display: flex; flex-direction: column; gap: 16px;
}

.section { padding: 16px 20px; }
.section-title {
    font-size: 12px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px;
}
.section-title-row {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
}
.btn-detail {
    font-size: 11px; color: #a5b4fc; background: none; border: none;
    cursor: pointer; padding: 2px 6px; border-radius: 4px; transition: color 0.15s;
}
.btn-detail:hover { color: #c7d2fe; }

/* 基础信息网格 */
.meta-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;
}
.meta-item {
    display: flex; flex-direction: column; gap: 4px;
    padding: 10px 14px; background: var(--bg-tertiary);
    border: 1px solid var(--border-color); border-radius: 8px;
}
.meta-label { font-size: 10px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
.meta-value { font-size: 13px; color: var(--text-primary); }
.meta-value.mono { font-family: monospace; font-size: 11px; word-break: break-all; }
.meta-value.highlight { font-size: 15px; font-weight: 700; color: #a5b4fc; }

/* 文件信息 */
.file-items { display: flex; gap: 14px; flex-wrap: wrap; }
.file-item {
    display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 180px;
    padding: 10px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color);
    border-radius: 8px; transition: border-color 0.15s;
}
.file-item.file-missing { border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.05); }
.file-item.file-absent { opacity: 0.55; }
.file-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.file-detail { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.file-label { font-size: 10px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
.file-name { font-size: 12px; font-family: monospace; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.file-size { font-size: 11px; color: var(--text-muted); font-family: monospace; }
.file-badge-ok { font-size: 11px; color: var(--success); font-weight: 500; }
.file-missing-tag { font-size: 11px; color: var(--danger); }
.text-muted { color: var(--text-muted); }

/* 分析进度 */
.analyzing-banner {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border-radius: 8px; margin-bottom: 14px;
    background: rgba(99,102,241,0.07); border: 1px solid rgba(99,102,241,0.2);
}
.analyzing-bar { flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
.analyzing-fill {
    height: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1);
    border-radius: 3px; transition: width 0.4s ease;
    animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
.analyzing-text { font-size: 12px; color: #a5b4fc; white-space: nowrap; flex-shrink: 0; }

/* 插件列表 */
.plugin-list { display: flex; flex-direction: column; gap: 4px; }
.plugin-row {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 12px; border-radius: 7px;
    border: 1px solid transparent; transition: background 0.12s;
}
.plugin-row:hover { background: var(--bg-tertiary); }
.plugin-row-done    { border-color: rgba(34,197,94,0.1); }
.plugin-row-running { border-color: rgba(99,102,241,0.25); background: rgba(99,102,241,0.05); }
.plugin-row-failed  { border-color: rgba(239,68,68,0.2); }

.plugin-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.plugin-dot-done    { background: #22c55e; }
.plugin-dot-running { background: #6366f1; animation: pulse 1s infinite; }
.plugin-dot-failed  { background: #ef4444; }
.plugin-dot-pending { background: #475569; }
.plugin-dot-skipped { background: #374151; }
.plugin-dot-idle    { background: #1e2235; border: 1px solid #2d3148; }

.plugin-name { flex: 1; font-size: 12.5px; color: var(--text-secondary); }
.plugin-badge { font-size: 11px; }
.plugin-badge-done    { color: #22c55e; }
.plugin-badge-running { color: #a5b4fc; }
.plugin-badge-failed  { color: #ef4444; }
.plugin-badge-pending { color: var(--text-muted); }
.plugin-badge-skipped { color: var(--text-muted); opacity: 0.6; }
.plugin-badge-idle    { color: var(--text-muted); opacity: 0.4; }

.plugin-duration { font-size: 11px; color: var(--text-muted); font-family: monospace; flex-shrink: 0; }
.no-plugins { font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px; }
</style>
