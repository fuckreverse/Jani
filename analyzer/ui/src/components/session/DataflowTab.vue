<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A2 · 数据流图</h2>
      <span class="section-badge">{{ dataflowEdges.length }} 条边</span>
    </div>

    <div v-if="dataflowLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="dataflowEdges.length === 0" class="empty-state"><p>暂无数据流数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <!-- 类型统计 -->
      <div v-if="dataflowStats.length > 0" class="filter-bar" style="margin-bottom:12px">
        <span class="filter-label">边类型统计：</span>
        <span
          v-for="s in dataflowStats" :key="s.edge_type"
          class="var-chip"
          :class="dfEdgeTypeFilter === s.edge_type ? 'var-write' : 'var-read'"
          style="cursor:pointer; margin-right:6px"
          @click="dfEdgeTypeFilter = dfEdgeTypeFilter === s.edge_type ? '' : s.edge_type; loadDataflow()"
        >{{ s.edge_type }}: {{ s.cnt }}</span>
      </div>
      <!-- 边列表 -->
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr><th>类型</th><th>来源变量</th><th>目标变量</th><th>来源 SEQ</th><th>目标 SEQ</th><th>行号</th><th>iid</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in dataflowEdges" :key="e.id">
              <td><span class="type-badge" :class="`df-${e.edge_type}`">{{ e.edge_type }}</span></td>
              <td><span class="var-chip var-write">{{ e.from_var || '—' }}</span></td>
              <td><span class="var-chip var-read">{{ e.to_var || '—' }}</span></td>
              <td class="td-seq">{{ e.from_event_id ?? '—' }}</td>
              <td class="td-seq">{{ e.to_event_id ?? '—' }}</td>
              <td class="td-seq">{{ e.line ?? '—' }}</td>
              <td class="td-seq">{{ e.iid ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const dataflowEdges    = ref([]);
const dataflowStats    = ref([]);
const dataflowLoading  = ref(false);
const dfEdgeTypeFilter = ref('');

async function loadDataflow() {
    dataflowLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (dfEdgeTypeFilter.value) params.set('edgeType', dfEdgeTypeFilter.value);
        const res = await fetch(`/api/sessions/${props.sessionId}/dataflow?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        dataflowEdges.value = data.edges || [];
        dataflowStats.value = data.stats || [];
    } catch (e) {
        console.error('loadDataflow error:', e);
    } finally {
        dataflowLoading.value = false;
    }
}

defineExpose({ reload: loadDataflow });

onMounted(loadDataflow);
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
.type-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.df-assign      { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.df-field_write { background: rgba(34,197,94,0.15);  color: #86efac; }
.df-field_read  { background: rgba(245,158,11,0.15); color: #fcd34d; }
.df-call_arg    { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.df-call_ret    { background: rgba(239,68,68,0.15);  color: #fca5a5; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
</style>
