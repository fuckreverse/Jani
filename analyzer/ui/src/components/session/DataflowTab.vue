<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A2 · 数据流图</h2>
      <span class="section-badge">{{ dfTotal }} 条边</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar" style="margin-bottom:12px">
      <!-- 变量名搜索 -->
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input
          v-model="dfVarName"
          placeholder="按变量名筛选..."
          class="search-input"
          @keyup.enter="loadDataflow(true)"
          @input="onVarNameInput"
        />
        <button v-if="dfVarName" class="search-clear" @click="dfVarName=''; loadDataflow(true)" title="清空">✕</button>
      </div>

      <!-- 边类型统计（点击过滤） -->
      <template v-if="dataflowStats.length > 0">
        <span class="filter-label" style="margin-left:4px">类型：</span>
        <span
          v-for="s in dataflowStats" :key="s.edge_type"
          class="stat-chip"
          :class="dfEdgeTypeFilter === s.edge_type ? 'stat-chip-active' : ''"
          @click="toggleEdgeType(s.edge_type)"
        >{{ s.edge_type }} <em>{{ s.cnt }}</em></span>
      </template>

      <button class="btn-secondary" style="margin-left:auto" @click="resetFilters">重置</button>
    </div>

    <div v-if="dataflowLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="dfTotal === 0 && !dataflowLoading" class="empty-state">
      <p v-if="dfVarName || dfEdgeTypeFilter">无匹配数据流边</p>
      <p v-else>暂无数据流数据（请先运行 Phase 4）</p>
    </div>
    <div v-else>
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

      <!-- 分页 -->
      <div v-if="dfTotal > DF_PAGE_SIZE" class="pagination">
        <span class="page-summary">共 {{ dfTotal }} 条 · 每页 {{ DF_PAGE_SIZE }}</span>
        <div class="page-controls">
          <button class="btn-page btn-secondary" :disabled="dfPage <= 1" @click="gotoPage(1)">«</button>
          <button class="btn-page btn-secondary" :disabled="dfPage <= 1" @click="gotoPage(dfPage - 1)">‹ 上一页</button>

          <template v-for="p in visiblePages" :key="'p'+p">
            <span v-if="p === '...'" class="page-ellipsis">…</span>
            <button v-else class="btn-page" :class="p === dfPage ? 'btn-page-active' : 'btn-secondary'" @click="gotoPage(p)">{{ p }}</button>
          </template>

          <button class="btn-page btn-secondary" :disabled="dfPage >= dfTotalPages" @click="gotoPage(dfPage + 1)">下一页 ›</button>
          <button class="btn-page btn-secondary" :disabled="dfPage >= dfTotalPages" @click="gotoPage(dfTotalPages)">»</button>
        </div>
        <div class="page-jump">
          <span class="page-jump-label">跳转</span>
          <input v-model.number="dfJump" type="number" :min="1" :max="dfTotalPages" class="page-jump-input" @keyup.enter="doJump" />
          <button class="btn-page btn-secondary" @click="doJump">GO</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const dataflowEdges    = ref([]);
const dataflowStats    = ref([]);
const dataflowLoading  = ref(false);
const dfEdgeTypeFilter = ref('');
const dfVarName        = ref('');
const dfTotal          = ref(0);
const dfPage           = ref(1);
const dfJump           = ref(1);
const DF_PAGE_SIZE     = 200;

const dfTotalPages = computed(() => Math.max(1, Math.ceil(dfTotal.value / DF_PAGE_SIZE)));

const visiblePages = computed(() => {
    const total = dfTotalPages.value;
    const cur   = dfPage.value;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (cur <= 4)   return [1, 2, 3, 4, 5, '...', total];
    if (cur >= total - 3) return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
    return [1, '...', cur - 1, cur, cur + 1, '...', total];
});

// 搜索防抖
let varNameTimer = null;
function onVarNameInput() {
    clearTimeout(varNameTimer);
    varNameTimer = setTimeout(() => loadDataflow(true), 350);
}

function toggleEdgeType(type) {
    dfEdgeTypeFilter.value = dfEdgeTypeFilter.value === type ? '' : type;
    loadDataflow(true);
}

function resetFilters() {
    dfVarName.value        = '';
    dfEdgeTypeFilter.value = '';
    loadDataflow(true);
}

async function loadDataflow(reset = false) {
    if (reset) { dfPage.value = 1; dfJump.value = 1; }
    dataflowLoading.value = true;
    try {
        const offset = (dfPage.value - 1) * DF_PAGE_SIZE;
        const params = new URLSearchParams({ limit: DF_PAGE_SIZE, offset });
        if (dfEdgeTypeFilter.value) params.set('edgeType', dfEdgeTypeFilter.value);
        if (dfVarName.value.trim()) params.set('varName', dfVarName.value.trim());
        const res = await fetch(`/api/sessions/${props.sessionId}/dataflow?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        dataflowEdges.value = data.edges || [];
        dataflowStats.value = data.stats || [];
        dfTotal.value       = data.total ?? data.edges?.length ?? 0;
    } catch (e) {
        console.error('loadDataflow error:', e);
    } finally {
        dataflowLoading.value = false;
    }
}

async function gotoPage(p) {
    const clamped = Math.max(1, Math.min(dfTotalPages.value, p));
    if (clamped === dfPage.value) return;
    dfPage.value = clamped;
    dfJump.value = clamped;
    await loadDataflow(false);
}

function doJump() {
    gotoPage(Math.round(dfJump.value) || 1);
}

defineExpose({ reload: () => loadDataflow(true) });

onMounted(() => loadDataflow(true));
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); }

/* 搜索框 */
.search-box { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 8px; font-size: 12px; pointer-events: none; opacity: 0.6; }
.search-input {
    width: 200px; padding: 5px 26px 5px 28px !important;
    border: 1px solid var(--border-color); border-radius: 6px;
    background: var(--bg-secondary); color: var(--text-primary);
    font-size: 12px;
}
.search-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.search-clear {
    position: absolute; right: 6px; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 0 2px;
    opacity: 0.7; transition: opacity 0.12s;
}
.search-clear:hover { opacity: 1; color: var(--danger, #f87171); }

/* 边类型统计 chips */
.stat-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 10px; font-size: 11px;
    background: rgba(99,102,241,0.1); color: var(--text-muted);
    border: 1px solid rgba(99,102,241,0.15); cursor: pointer;
    transition: background 0.12s, color 0.12s;
}
.stat-chip:hover { background: rgba(99,102,241,0.18); color: var(--text-primary); }
.stat-chip-active { background: rgba(99,102,241,0.25) !important; color: #a5b4fc !important; border-color: rgba(99,102,241,0.45) !important; }
.stat-chip em { font-style: normal; color: #fcd34d; font-weight: 600; }

/* 表格 */
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
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }

/* 分页 */
.pagination {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-top: 14px; padding-top: 14px;
    border-top: 1px solid var(--border-color); flex-wrap: wrap;
}
.page-summary { font-size: 12px; color: var(--text-muted); flex-shrink: 0; white-space: nowrap; }
.page-controls { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; justify-content: center; }
.page-jump { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.page-jump-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.page-jump-input {
    width: 50px; height: 28px; padding: 0 6px; font-size: 12px; text-align: center;
    border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
}
.page-jump-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.btn-page {
    min-width: 32px; height: 28px; padding: 0 8px; font-size: 12px;
    border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
    cursor: pointer; transition: background 0.12s; white-space: nowrap; line-height: 1;
}
.btn-page:hover:not(:disabled) { background: var(--bg-tertiary); border-color: rgba(99,102,241,0.4); }
.btn-page:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-page-active {
    background: rgba(99,102,241,0.2) !important; border-color: rgba(99,102,241,0.6) !important;
    color: #a5b4fc !important; font-weight: 600; cursor: default;
}
.page-ellipsis {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 24px; height: 28px; font-size: 12px; color: var(--text-muted);
}
</style>
