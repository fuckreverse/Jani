<template>
  <div class="session-card card" @click="$router.push(`/sessions/${session.id}`)">
    <div class="session-header">
      <div class="session-name">{{ session.name || session.id.slice(0, 8) }}</div>
      <span class="badge" :class="`badge-${session.status}`">{{ session.status }}</span>
    </div>

    <div class="session-meta">
      <div class="meta-item">
        <span class="meta-label">事件数</span>
        <span class="meta-value">{{ formatNumber(session.event_count) }}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">创建时间</span>
        <span class="meta-value">{{ formatDate(session.created_at) }}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">文件</span>
        <span class="meta-value">{{ session.source_file ? getFilename(session.source_file) : '—' }}</span>
      </div>
    </div>

    <!-- 插件状态 -->
    <div v-if="session.plugin_status && Object.keys(session.plugin_status).length > 0" class="plugin-status-bar">
      <div
        v-for="(status, pluginId) in session.plugin_status"
        :key="pluginId"
        class="plugin-dot"
        :class="`plugin-dot-${status}`"
        :title="`${pluginId}: ${status}`"
      ></div>
      <!-- 进行中时，显示「查看进度」按钮 -->
      <button
        v-if="['parsing','indexing','processing'].includes(session.status)"
        class="btn-progress"
        @click.stop="$emit('openProgress', session)"
      >⚡ 进度</button>
    </div>

    <!-- 会话操作栏 -->
    <div class="session-actions">
      <button class="btn-delete-session" @click.stop="$emit('delete', session)" title="删除会话">🗑 删除</button>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { formatDate } from '../../composables/useSessionUtils.js';

defineProps({
    session: { type: Object, required: true },
});
defineEmits(['delete', 'openProgress']);

const router = useRouter();

function formatNumber(n) {
    if (!n) return '0';
    return n.toLocaleString('zh-CN');
}

function getFilename(path) {
    return path ? path.split('/').pop() : '—';
}
</script>

<style scoped>
.session-card {
    cursor: pointer; transition: all 0.15s; border-color: var(--border-color);
}
.session-card:hover {
    border-color: var(--accent); transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(99,102,241,0.15);
}
.session-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.session-name {
    font-weight: 600; font-size: 15px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; max-width: 180px;
}
.session-meta { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.meta-item { display: flex; justify-content: space-between; font-size: 12px; }
.meta-label { color: var(--text-muted); }
.meta-value { color: var(--text-primary); font-family: monospace; }

/* 插件状态点 */
.plugin-status-bar { display: flex; gap: 4px; padding-top: 8px; border-top: 1px solid var(--border-color); }
.plugin-dot { width: 8px; height: 8px; border-radius: 50%; }
.plugin-dot-pending  { background: #475569; }
.plugin-dot-running  { background: #3b82f6; animation: pulse 1s infinite; }
.plugin-dot-done     { background: #22c55e; }
.plugin-dot-failed   { background: #ef4444; }
.plugin-dot-skipped  { background: #64748b; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.btn-progress {
    margin-left: auto; padding: 2px 8px; border-radius: 4px;
    border: 1px solid rgba(99,102,241,.35); background: rgba(99,102,241,.1);
    color: #a5b4fc; font-size: 10px; cursor: pointer; transition: all .15s; flex-shrink: 0;
}
.btn-progress:hover { background: rgba(99,102,241,.25); border-color: rgba(99,102,241,.6); }

/* 会话操作栏 */
.session-actions {
    display: flex; justify-content: flex-end; padding-top: 8px;
    border-top: 1px solid var(--border-color); margin-top: 4px;
}
.btn-delete-session {
    padding: 3px 10px; font-size: 11px; border-radius: 4px;
    border: 1px solid rgba(239,68,68,0.3); background: rgba(239,68,68,0.08);
    color: #f87171; cursor: pointer; transition: all 0.15s; opacity: 0;
}
.session-card:hover .btn-delete-session { opacity: 1; }
.btn-delete-session:hover { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.5); }
</style>
