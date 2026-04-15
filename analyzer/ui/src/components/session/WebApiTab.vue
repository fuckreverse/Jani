<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">I5 · Web API 调用</h2>
      <span class="section-badge">{{ total }} 条记录</span>
<span v-if="confirmedCount > 0" class="section-badge badge-confirmed">✓ {{ confirmedCount }} 精确</span>
<span v-if="propagatedCount > 0" class="section-badge badge-propagated">⊕ {{ propagatedCount }} 传播</span>
<span v-if="inferredCount > 0" class="section-badge badge-inferred">~ {{ inferredCount }} 启发式</span>
    </div>

    <div v-if="loading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="!hasData" class="empty-state">
      <p>暂无 Web API 调用数据（请先运行 I5 · WebApiDetector）</p>
    </div>

    <template v-else>
      <!-- ── 分类汇总卡片区 ───────────────────────────────────────────── -->
      <div class="summary-grid">
        <div
          v-for="cat in categorySummary"
          :key="cat.category"
          class="cat-card"
          :class="{ 'cat-active': activeCategory === cat.category }"
          @click="toggleCategory(cat.category)"
          :title="`点击筛选：${cat.category}`"
        >
          <div class="cat-icon">{{ catIcon(cat.category) }}</div>
          <div class="cat-name">{{ cat.category }}</div>
          <div class="cat-count">{{ cat.total }}</div>
          <div class="cat-breakdown">
<span v-if="cat.confirmed" class="mini-badge confirmed">✓{{ cat.confirmed }}</span>
<span v-if="cat.propagated" class="mini-badge propagated">⊕{{ cat.propagated }}</span>
<span v-if="cat.inferred" class="mini-badge inferred">~{{ cat.inferred }}</span>
          </div>
        </div>
      </div>

      <!-- ── 过滤栏 ──────────────────────────────────────────────────── -->
      <div class="filter-bar">
        <input
          v-model="searchText"
          class="filter-input"
          placeholder="搜索属性名 / 方法名..."
          @input="onSearchInput"
        />

        <select v-model="filterAccessType" class="filter-select" @change="loadItems(true)">
          <option value="">全部类型</option>
          <option value="call">call（方法调用）</option>
          <option value="read">read（属性读取）</option>
          <option value="write">write（属性写入）</option>
        </select>

        <select v-model="filterConfidence" class="filter-select" @change="loadItems(true)">
          <option value="">全部置信度</option>
<option value="confirmed">confirmed（精确匹配）</option>
<option value="propagated">propagated（OID 传播）</option>
<option value="inferred">inferred（启发式）</option>
        </select>

        <button
          v-if="activeCategory"
          class="clear-btn"
          @click="activeCategory = ''; loadItems(true)"
        >✕ {{ activeCategory }}</button>
      </div>

      <!-- ── 明细列表 ────────────────────────────────────────────────── -->
      <div v-if="itemLoading" class="loading"><div class="spinner"></div><span>加载明细...</span></div>
      <div v-else-if="items.length === 0" class="empty-state"><p>当前过滤条件下无数据</p></div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:90px">类型</th>
              <th style="width:110px">宿主对象</th>
              <th style="min-width:140px">属性/方法名</th>
              <th style="width:70px">访问</th>
              <th style="width:90px">置信度</th>
              <th style="min-width:120px">参数 / 返回值</th>
              <th style="width:70px">行号</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="item in items" :key="item.id">
              <tr
                class="data-row"
                :class="{ 'row-confirmed': item.confidence_level === 'confirmed', 'row-propagated': item.confidence_level === 'propagated', 'row-expanded': expandedId === item.id }"
                @click="toggleExpand(item)"
              >
                <td>
                  <span class="type-badge" :class="`type-${item.category}`">
                    {{ catIcon(item.category) }} {{ item.category }}
                  </span>
                </td>
                <td class="mono">
                  <span class="host-chip" :class="`host-${item.host_obj}`">{{ item.host_obj }}</span>
                  <span v-if="item.receiver_var && item.receiver_var !== item.host_obj" class="receiver-var"> ({{ item.receiver_var }})</span>
                </td>
                <td class="mono prop-name">{{ item.property_name }}</td>
                <td>
                  <span class="access-badge" :class="`access-${item.access_type}`">{{ item.access_type }}</span>
                </td>
                <td>
                  <span class="conf-chip" :class="`conf-${item.confidence_level}`">
                    {{ item.confidence_level === 'confirmed' ? '✓ 精确' : item.confidence_level === 'propagated' ? '⊕ 传播' : '~ 推断' }}
                  </span>
                </td>
                <td class="args-cell">
                  <template v-if="item.access_type === 'call'">
                    <span v-if="item.args_json?.length" class="arg-preview mono">
                      ({{ formatArgs(item.args_json) }})
                    </span>
                    <span v-if="item.return_value != null" class="ret-preview mono"> → {{ truncate(item.return_value, 30) }}</span>
                  </template>
                  <span v-else-if="item.return_value != null" class="ret-preview mono">{{ truncate(item.return_value, 40) }}</span>
                </td>
                <td class="line-cell">
                  <span v-if="item.line" class="line-num">{{ item.line }}</span>
                </td>
              </tr>
              <!-- 展开行：源码片段 + 完整参数 -->
              <tr v-if="expandedId === item.id" class="expand-row">
                <td colspan="7">
                  <div class="expand-body">
                    <div v-if="item.src_text" class="src-snippet mono">{{ item.src_text }}</div>
                    <div v-if="item.access_type === 'call' && item.args_json?.length" class="expand-section">
                      <span class="expand-label">参数：</span>
                      <span v-for="(arg, i) in item.args_json" :key="i" class="arg-chip mono">
                        {{ formatArgFull(arg) }}
                      </span>
                    </div>
                    <div v-if="item.return_value != null" class="expand-section">
                      <span class="expand-label">返回值：</span>
                      <span class="arg-chip mono">{{ item.return_value }}</span>
                    </div>
                    <div class="expand-meta">
                      event_id={{ item.event_id }}
                      <template v-if="item.call_edge_id"> · call_edge={{ item.call_edge_id }}</template>
                      · <span :class="`conf-${item.confidence_level}`">{{ item.confidence_level }}</span>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <!-- 分页 -->
        <div v-if="total > pageSize" class="pagination">
          <button :disabled="currentOffset === 0" @click="prevPage" class="page-btn">← 上一页</button>
          <span class="page-info">{{ currentOffset + 1 }}–{{ Math.min(currentOffset + items.length, total) }} / {{ total }}</span>
          <button :disabled="currentOffset + items.length >= total" @click="nextPage" class="page-btn">下一页 →</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useConfig } from '../../composables/useConfig.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

// ─── 状态 ─────────────────────────────────────────────────────────────────
const loading     = ref(false);
const itemLoading = ref(false);
const summary     = ref([]);   // 来自 API 的分类统计
const items       = ref([]);
const total       = ref(0);
const expandedId  = ref(null);

// 过滤
const activeCategory    = ref('');
const filterAccessType  = ref('');
const filterConfidence  = ref('');
const searchText        = ref('');
let searchTimer = null;

const { api: apiCfg } = useConfig();
const pageSize     = computed(() => apiCfg.value.webApiDefaultLimit);
const currentOffset = ref(0);

// ─── 计算属性 ──────────────────────────────────────────────────────────────

const hasData = computed(() => summary.value.length > 0 || items.value.length > 0);

const confirmedCount = computed(() =>
    summary.value.filter(s => s.confidence_level === 'confirmed').reduce((a, s) => a + s.cnt, 0)
);
const propagatedCount = computed(() =>
    summary.value.filter(s => s.confidence_level === 'propagated').reduce((a, s) => a + s.cnt, 0)
);
const inferredCount = computed(() =>
    summary.value.filter(s => s.confidence_level === 'inferred').reduce((a, s) => a + s.cnt, 0)
);

/** 按 category 聚合 summary，方便展示分类卡片 */
const categorySummary = computed(() => {
    const map = new Map();
    for (const s of summary.value) {
if (!map.has(s.category)) map.set(s.category, { category: s.category, total: 0, confirmed: 0, propagated: 0, inferred: 0 });
const entry = map.get(s.category);
entry.total += s.cnt;
if (s.confidence_level === 'confirmed') entry.confirmed += s.cnt;
else if (s.confidence_level === 'propagated') entry.propagated += s.cnt;
else entry.inferred += s.cnt;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
});

// ─── 加载 ─────────────────────────────────────────────────────────────────

async function load() {
    loading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/web-api?limit=0`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        summary.value = data.summary || [];
    } catch (e) {
        console.error('WebApiTab load summary error:', e);
    } finally {
        loading.value = false;
    }
    await loadItems(true);
}

async function loadItems(resetPage = false) {
    if (resetPage) {
        currentOffset.value = 0;
        expandedId.value = null;
    }
    itemLoading.value = true;
    try {
        const params = new URLSearchParams({
            limit: pageSize.value,
            offset: currentOffset.value,
        });
        if (activeCategory.value)   params.set('category', activeCategory.value);
        if (filterAccessType.value) params.set('access_type', filterAccessType.value);
        if (filterConfidence.value) params.set('confidence_level', filterConfidence.value);
        if (searchText.value.trim()) params.set('search', searchText.value.trim());

        const res = await fetch(`/api/sessions/${props.sessionId}/web-api?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        items.value  = data.items || [];
        total.value  = data.total ?? 0;
        // 同步更新 summary（带过滤时 summary 仍是全量的，来自首次加载）
        if (data.summary) summary.value = data.summary;
    } catch (e) {
        console.error('WebApiTab loadItems error:', e);
    } finally {
        itemLoading.value = false;
    }
}

// ─── 交互 ─────────────────────────────────────────────────────────────────

function toggleCategory(cat) {
    activeCategory.value = activeCategory.value === cat ? '' : cat;
    loadItems(true);
}

function toggleExpand(item) {
    expandedId.value = expandedId.value === item.id ? null : item.id;
}

function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadItems(true), 350);
}

function prevPage() {
    currentOffset.value = Math.max(0, currentOffset.value - pageSize.value);
    loadItems(false);
}

function nextPage() {
    currentOffset.value += pageSize.value;
    loadItems(false);
}

// ─── 格式化工具 ────────────────────────────────────────────────────────────

function truncate(s, max) {
    if (s == null) return '';
    const str = String(s);
    return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatArgs(args) {
    if (!Array.isArray(args) || args.length === 0) return '';
    return args.slice(0, 3).map(a => {
        const s = a?.value ?? String(a);
        return truncate(s, 20);
    }).join(', ') + (args.length > 3 ? ', …' : '');
}

function formatArgFull(arg) {
    if (arg == null) return 'null';
    if (typeof arg === 'object' && 'name' in arg) {
        return `${arg.name}=${truncate(String(arg.value ?? ''), 60)}`;
    }
    return truncate(String(arg), 60);
}

const CAT_ICONS = {
    document: '📄',
    window:   '🪟',
    navigator:'🧭',
    location: '📍',
    storage:  '💾',
    xhr:      '📡',
    fetch:    '🌐',
    timing:   '⏱',
    observer: '👁',
    canvas:   '🎨',
    event:    '⚡',
    history:  '🔙',
    crypto:   '🔑',
    other:    '📦',
};
function catIcon(cat) { return CAT_ICONS[cat] ?? '📦'; }

defineExpose({ reload: load });

onMounted(load);
</script>

<style scoped>
/* ── 顶部 header ────────────────────────────────────────────────────── */
.section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
.section-title  { font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 0; }
.section-badge  {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.badge-confirmed  { background: rgba(16,185,129,0.15); color: #6ee7b7; }
.badge-propagated { background: rgba(99,102,241,0.15);  color: #a5b4fc; }
.badge-inferred   { background: rgba(251,191,36,0.15);  color: #fcd34d; }

/* ── 分类汇总卡片 ───────────────────────────────────────────────────── */
.summary-grid {
    display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px;
}
.cat-card {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 10px 14px; border-radius: 8px; min-width: 72px;
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    cursor: pointer; transition: all 0.15s; user-select: none;
}
.cat-card:hover { border-color: rgba(99,102,241,0.5); background: var(--bg-tertiary); }
.cat-active { border-color: rgba(99,102,241,0.8) !important; background: rgba(99,102,241,0.1) !important; }
.cat-icon   { font-size: 20px; line-height: 1; }
.cat-name   { font-size: 10px; color: var(--text-muted); font-weight: 600; text-align: center; }
.cat-count  { font-size: 16px; font-weight: 800; color: var(--text-primary); }
.cat-breakdown { display: flex; gap: 3px; flex-wrap: wrap; justify-content: center; }
.mini-badge {
    font-size: 9px; padding: 1px 4px; border-radius: 4px; font-weight: 700;
}
.mini-badge.confirmed  { background: rgba(16,185,129,0.2); color: #6ee7b7; }
.mini-badge.propagated { background: rgba(99,102,241,0.2);  color: #a5b4fc; }
.mini-badge.inferred   { background: rgba(251,191,36,0.2);  color: #fcd34d; }

/* ── 过滤栏 ─────────────────────────────────────────────────────────── */
.filter-bar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    margin-bottom: 14px;
}
.filter-input {
    flex: 1; min-width: 160px; padding: 6px 10px;
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 6px; color: var(--text-primary); font-size: 12px;
}
.filter-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.filter-select {
    padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 6px; color: var(--text-primary); font-size: 12px; cursor: pointer;
}
.clear-btn {
    padding: 5px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
    background: rgba(99,102,241,0.15); color: #a5b4fc;
    border: 1px solid rgba(99,102,241,0.3);
}
.clear-btn:hover { background: rgba(99,102,241,0.25); }

/* ── 表格 ───────────────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; }
.data-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
}
.data-table th {
    text-align: left; padding: 6px 10px;
    background: var(--bg-tertiary); color: var(--text-muted);
    border-bottom: 1px solid var(--border-color); font-weight: 600; white-space: nowrap;
}
.data-row {
    border-bottom: 1px solid var(--border-color);
    cursor: pointer; transition: background 0.1s;
}
.data-row:hover { background: var(--bg-secondary); }
.data-row.row-confirmed  { border-left: 2px solid rgba(16,185,129,0.4); }
.data-row.row-propagated { border-left: 2px solid rgba(99,102,241,0.4); }
.data-row.row-expanded  { background: var(--bg-secondary); }
.data-row td { padding: 7px 10px; vertical-align: middle; }

/* ── 徽标 ───────────────────────────────────────────────────────────── */
.type-badge {
    display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px;
    font-weight: 600; white-space: nowrap;
    background: rgba(99,102,241,0.15); color: #a5b4fc;
}
.host-chip {
    display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px;
    font-weight: 700; font-family: monospace;
    background: rgba(99,102,241,0.12); color: #c7d2fe;
}
.receiver-var { font-size: 10px; color: var(--text-muted); font-family: monospace; }

.access-badge {
    display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;
}
.access-call  { background: rgba(99,102,241,0.2); color: #a5b4fc; }
.access-read  { background: rgba(16,185,129,0.15); color: #6ee7b7; }
.access-write { background: rgba(239,68,68,0.15);  color: #fca5a5; }

.conf-chip { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
.conf-confirmed  { background: rgba(16,185,129,0.15); color: #6ee7b7; }
.conf-propagated { background: rgba(99,102,241,0.15);  color: #a5b4fc; }
.conf-inferred   { background: rgba(251,191,36,0.15);  color: #fcd34d; }

.prop-name   { font-family: monospace; color: var(--text-primary); }
.mono        { font-family: monospace; font-size: 11px; }
.args-cell   { max-width: 200px; }
.arg-preview { color: var(--text-muted); }
.ret-preview { color: #6ee7b7; }
.line-cell   { text-align: right; }
.line-num    {
    font-family: monospace; font-size: 10px; color: var(--text-muted);
    background: var(--bg-tertiary); padding: 1px 5px; border-radius: 3px;
}

/* ── 展开行 ─────────────────────────────────────────────────────────── */
.expand-row td { padding: 0; }
.expand-body {
    padding: 10px 16px; background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
}
.src-snippet {
    font-size: 12px; color: #93c5fd; background: rgba(0,0,0,0.2);
    padding: 6px 10px; border-radius: 4px; margin-bottom: 8px;
    white-space: pre-wrap; word-break: break-all;
}
.expand-section { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.expand-label   { font-size: 10px; color: var(--text-muted); flex-shrink: 0; line-height: 20px; }
.arg-chip {
    font-size: 11px; padding: 2px 6px; border-radius: 4px;
    background: rgba(99,102,241,0.12); color: #c7d2fe; word-break: break-all;
}
.expand-meta { font-size: 10px; color: var(--text-muted); margin-top: 4px; }

/* ── 分页 ───────────────────────────────────────────────────────────── */
.pagination {
    display: flex; align-items: center; gap: 12px;
    justify-content: center; padding: 12px 0 4px;
}
.page-btn {
    padding: 5px 14px; border-radius: 6px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-muted); font-size: 12px; cursor: pointer;
}
.page-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-tertiary); }
.page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.page-info { font-size: 12px; color: var(--text-muted); }

/* ── 通用 ───────────────────────────────────────────────────────────── */
.loading { display: flex; align-items: center; gap: 10px; padding: 20px 0; color: var(--text-muted); }
.spinner {
    width: 16px; height: 16px; border: 2px solid var(--border-color);
    border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.empty-state { text-align: center; padding: 32px 0; color: var(--text-muted); font-size: 13px; }
</style>
