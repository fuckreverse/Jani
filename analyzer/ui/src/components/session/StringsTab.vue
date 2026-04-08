<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A4 · 字符串追踪</h2>
      <span class="section-badge">{{ stringEvents.length }} 条</span>
    </div>

    <div v-if="stringsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="stringEvents.length === 0" class="empty-state"><p>暂无字符串追踪数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <!-- 编码分布 -->
      <div class="filter-bar" style="margin-bottom:12px">
        <span class="filter-label">编码过滤：</span>
        <span
          v-for="s in stringEncStats" :key="s.encoding_hint"
          class="var-chip"
          :class="strEncodingFilter === s.encoding_hint ? 'var-write' : 'var-read'"
          style="cursor:pointer; margin-right:6px"
          @click="strEncodingFilter = strEncodingFilter === s.encoding_hint ? '' : s.encoding_hint; loadStrings()"
        >{{ s.encoding_hint || 'plain' }}: {{ s.cnt }}</span>
      </div>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr><th>编码</th><th>变量名</th><th>值（前80字符）</th><th>行号</th><th>iid</th><th>event SEQ</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in stringEvents" :key="s.id" :class="s.encoding_hint && s.encoding_hint !== 'plain' ? 'row-crypto' : ''">
              <td>
                <span v-if="s.encoding_hint && s.encoding_hint !== 'plain'" class="crypto-badge">{{ s.encoding_hint }}</span>
                <span v-else class="text-muted">plain</span>
              </td>
              <td><span v-if="s.var_name" class="var-chip var-write">{{ s.var_name }}</span><span v-else class="text-muted">—</span></td>
              <td><code class="src-text" style="max-width:350px">{{ truncate(s.value, 80) }}</code></td>
              <td class="td-seq">{{ s.line ?? '—' }}</td>
              <td class="td-seq">{{ s.iid ?? '—' }}</td>
              <td class="td-seq">{{ s.event_id }}</td>
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

const stringEvents      = ref([]);
const stringEncStats    = ref([]);
const stringsLoading    = ref(false);
const strEncodingFilter = ref('');

async function loadStrings() {
    stringsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (strEncodingFilter.value) params.set('encoding', strEncodingFilter.value);
        const res = await fetch(`/api/sessions/${props.sessionId}/strings?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        stringEvents.value = data.strings || [];
        stringEncStats.value = data.encodingStats || [];
    } catch (e) {
        console.error('loadStrings error:', e);
    } finally {
        stringsLoading.value = false;
    }
}

defineExpose({ reload: loadStrings });

onMounted(loadStrings);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
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
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 300px; display: block; overflow: hidden; text-overflow: ellipsis; }
.text-muted { color: var(--text-muted); }
.row-crypto td { background: rgba(245,158,11,0.06) !important; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
</style>
