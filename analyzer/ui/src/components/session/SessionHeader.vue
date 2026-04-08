<template>
  <div class="session-header card">
    <div class="header-left">
      <router-link to="/" class="back-btn">← 返回列表</router-link>
      <h1 class="session-title">{{ session.name || session.id.slice(0, 8) }}</h1>
      <div class="header-meta">
        <span class="badge" :class="`badge-${session.status}`">{{ statusLabel(session.status) }}</span>
        <span class="meta-text">{{ session.event_count?.toLocaleString('zh-CN') ?? 0 }} 条事件</span>
        <span class="meta-text">创建于 {{ formatDate(session.created_at) }}</span>
      </div>
    </div>
    <div class="header-right">
      <!-- 内联进度条（处理中时显示）-->
      <div v-if="isAnalyzing" class="inline-progress" @click="$emit('openProgress')">
        <div class="inline-progress-bar">
          <div class="inline-progress-fill" :style="{ width: inlineProgressPct + '%' }"></div>
        </div>
        <span class="inline-progress-label">{{ inlineProgressPct }}% · {{ runningPlugin || '处理中' }}</span>
        <span class="inline-progress-hint">点击查看详情 ›</span>
      </div>
      <!-- 就绪时，显示插件小点 + 进度按钮 -->
      <div v-else class="header-plugin-dots">
        <div
          v-for="(status, pid) in pluginStatus"
          :key="pid"
          class="plugin-dot"
          :class="'plugin-dot-' + status"
          :title="pid + ': ' + status"
        ></div>
        <button class="btn-show-progress" @click="$emit('openProgress')">🔍 进度</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { formatDate, statusLabel } from '../../composables/useSessionUtils.js';

defineProps({
    session:           { type: Object,  required: true },
    pluginStatus:      { type: Object,  default: () => ({}) },
    isAnalyzing:       { type: Boolean, default: false },
    inlineProgressPct: { type: Number,  default: 0 },
    runningPlugin:     { type: String,  default: '' },
});

defineEmits(['openProgress']);
</script>

<style scoped>
.session-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: 20px;
}
.back-btn { font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 6px; }
.session-title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
.header-meta { display: flex; align-items: center; gap: 12px; }
.meta-text { font-size: 12px; color: var(--text-muted); }
.header-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }

/* 内联进度条 */
.inline-progress {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(99,102,241,0.3);
    background: rgba(99,102,241,0.08); transition: background 0.15s;
}
.inline-progress:hover { background: rgba(99,102,241,0.15); }
.inline-progress-bar { width: 80px; height: 5px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; flex-shrink: 0; }
.inline-progress-fill {
    height: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1); border-radius: 3px;
    transition: width 0.4s ease; animation: ppulse 1.5s ease-in-out infinite;
}
@keyframes ppulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
.inline-progress-label { font-size: 11px; color: #a5b4fc; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.inline-progress-hint { font-size: 10px; color: var(--text-muted); white-space: nowrap; }

/* 插件状态小圆点 */
.header-plugin-dots { display: flex; align-items: center; gap: 4px; }
.plugin-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.plugin-dot-done    { background: #22c55e; }
.plugin-dot-running { background: #6366f1; animation: ppulse 1s infinite; }
.plugin-dot-failed  { background: #ef4444; }
.plugin-dot-pending { background: #475569; }
.plugin-dot-skipped { background: #374151; }
.plugin-dot-idle    { background: #1e2235; border: 1px solid #2d3148; }
.btn-show-progress {
    margin-left: 6px; padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--border-color); background: transparent;
    color: var(--text-muted); font-size: 11px; cursor: pointer; transition: all 0.15s;
}
.btn-show-progress:hover { background: var(--bg-tertiary); color: var(--text-primary); }
</style>
