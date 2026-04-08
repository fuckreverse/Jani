<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A7 · 对象属性变异追踪</h2>
      <span class="section-badge">{{ objTimelines.length }} 条记录</span>
    </div>

    <div v-if="objLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="objTimelines.length === 0" class="empty-state"><p>暂无对象变异数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <!-- 对象选择器 -->
      <div class="filter-bar" style="margin-bottom:12px; flex-wrap:wrap; gap:8px">
        <label class="filter-label">过滤对象：</label>
        <select v-model="objBaseFilter" @change="loadObjTimelines" class="select-input">
          <option value="">— 全部 —</option>
          <option v-for="s in objBaseStats" :key="s.base_var" :value="s.base_var">
            {{ s.base_var }} ({{ s.change_count }} 次)
          </option>
        </select>
        <label class="filter-label">
          <input type="checkbox" v-model="onlyObjWrites" @change="loadObjTimelines" />
          仅显示写入
        </label>
      </div>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr><th>操作</th><th>对象</th><th>属性</th><th>旧值</th><th>新值</th><th>行号</th><th>SEQ</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in objTimelines" :key="t.id" :class="t.is_write ? '' : 'row-read-op'">
              <td>
                <span :class="t.is_write ? 'var-chip var-write' : 'var-chip var-read'">
                  {{ t.is_write ? 'write' : 'read' }}
                </span>
              </td>
              <td><code class="src-text">{{ t.base_var }}</code></td>
              <td><span class="var-chip var-field">{{ t.offset_key }}</span></td>
              <td><code class="src-text" style="color:#94a3b8">{{ truncate(t.old_value, 40) || '—' }}</code></td>
              <td><code class="src-text" style="color:#fcd34d">{{ truncate(t.new_value, 40) || '—' }}</code></td>
              <td class="td-seq">{{ t.line ?? '—' }}</td>
              <td class="td-seq">{{ t.change_seq }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { truncate } from '../../composables/useSessionUtils.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const objTimelines  = ref([]);
const objBaseStats  = ref([]);
const objLoading    = ref(false);
const objBaseFilter = ref('');
const onlyObjWrites = ref(false);

async function loadObjTimelines() {
    objLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '300' });
        if (objBaseFilter.value) params.set('baseVar', objBaseFilter.value);
        if (onlyObjWrites.value) params.set('onlyWrites', '1');
        const res = await fetch(`/api/sessions/${props.sessionId}/object-timelines?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        objTimelines.value = data.timelines || [];
        objBaseStats.value = data.baseVarStats || [];
    } catch (e) {
        console.error('loadObjTimelines error:', e);
    } finally {
        objLoading.value = false;
    }
}

defineExpose({ reload: loadObjTimelines });

onMounted(loadObjTimelines);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.select-input {
    padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
}
.events-table-wrapper { overflow-x: auto; }
.events-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.events-table th {
    text-align: left; padding: 8px 12px; color: var(--text-muted);
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    border-bottom: 1px solid var(--border-color); white-space: nowrap;
}
.events-table td { padding: 7px 12px; border-bottom: 1px solid rgba(45,49,72,0.5); vertical-align: middle; }
.events-table tr:hover td { background: var(--bg-tertiary); }
.td-seq { font-family: monospace; color: var(--text-muted); min-width: 50px; }
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 200px; display: block; overflow: hidden; text-overflow: ellipsis; }
.row-read-op td { background: rgba(99,102,241,0.05) !important; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-field { background: rgba(245,158,11,0.15); color: #fcd34d; }
</style>
