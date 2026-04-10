<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A8 · 值模式 / 魔术常数</h2>
      <span class="section-badge">{{ filteredPatterns.length }} 条</span>
      <span v-if="cryptoCount > 0" class="section-badge badge-crypto">🔐 {{ cryptoCount }} 个密码学常数</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar" style="margin-bottom:12px">
      <!-- 变量名搜索 -->
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input
          v-model="varSearch"
          placeholder="按变量名搜索..."
          class="search-input"
          @input="onSearchInput"
        />
        <button v-if="varSearch" class="search-clear" @click="varSearch=''" title="清空">✕</button>
      </div>

      <!-- 最小出现次数 -->
      <label class="filter-label">
        出现次数 ≥
        <input
          v-model.number="minCount"
          type="number"
          min="1"
          class="count-input"
          placeholder="不限"
          @input="onSearchInput"
        />
      </label>

      <!-- 仅密码学常数 -->
      <label class="filter-toggle" :class="{ 'toggle-active': onlyCrypto }" @click="onlyCrypto = !onlyCrypto; loadValuePatterns()">
        <span class="toggle-dot"></span>
        仅密码学常数
      </label>

      <button class="btn-secondary" @click="resetFilters">重置</button>
    </div>

    <div v-if="patternsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="filteredPatterns.length === 0" class="empty-state">
      <p v-if="varSearch || minCount">无匹配的值模式</p>
      <p v-else>暂无值模式数据（请先运行 A8 · ValuePatternDetector）</p>
    </div>
    <div v-else>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr>
              <th>值指纹 (前64字符)</th><th>出现次数</th><th>首次 SEQ</th><th>iid</th><th>变量名</th><th>行号</th><th>匹配常数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filteredPatterns" :key="p.id" :class="p.matched_constant ? 'row-crypto' : ''">
              <td><code class="src-text">{{ p.value_hash }}</code></td>
              <td class="td-seq td-count">{{ p.count }}</td>
              <td class="td-seq">{{ p.first_seq }}</td>
              <td class="td-seq">{{ p.iid ?? '—' }}</td>
              <td>
                <span v-if="p.var_name" class="var-chip var-write">{{ p.var_name }}</span>
                <span v-else class="text-muted">—</span>
              </td>
              <td class="td-seq">{{ p.line ?? '—' }}</td>
              <td>
                <span v-if="p.matched_constant" class="crypto-badge">{{ p.matched_constant }}</span>
                <span v-else class="text-muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const props = defineProps({
    sessionId: { type: String, required: true },
});

// ── 服务端数据（全量加载，最多 2000 条） ────────────────────────────────────
const allPatterns    = ref([]);
const patternsLoading = ref(false);

// ── 筛选条件 ─────────────────────────────────────────────────────────────────
const varSearch  = ref('');
const minCount   = ref('');
const onlyCrypto = ref(false);

// 搜索防抖
let searchTimer = null;
function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {}, 0); // 纯前端过滤，响应即时，无需防抖延迟
}

// ── 前端过滤（变量名 + 最小次数） ─────────────────────────────────────────
const filteredPatterns = computed(() => {
    let list = allPatterns.value;
    const q = varSearch.value.trim().toLowerCase();
    if (q) {
        list = list.filter(p => (p.var_name ?? '').toLowerCase().includes(q));
    }
    const mc = Number(minCount.value) || 0;
    if (mc > 0) {
        list = list.filter(p => (p.count ?? 0) >= mc);
    }
    return list;
});

const cryptoCount = computed(() => allPatterns.value.filter(p => p.matched_constant).length);

function resetFilters() {
    varSearch.value  = '';
    minCount.value   = '';
    onlyCrypto.value = false;
    loadValuePatterns();
}

async function loadValuePatterns() {
    patternsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '2000' });
        if (onlyCrypto.value) params.set('onlyCrypto', '1');
        const res = await fetch(`/api/sessions/${props.sessionId}/value-patterns?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allPatterns.value = data.patterns || [];
    } catch (e) {
        console.error('loadValuePatterns error:', e);
    } finally {
        patternsLoading.value = false;
    }
}

defineExpose({ reload: loadValuePatterns });

onMounted(loadValuePatterns);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.badge-crypto { background: rgba(245,158,11,0.2); color: #fcd34d; }

.filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }

/* 搜索框 */
.search-box { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 8px; font-size: 12px; pointer-events: none; opacity: 0.6; }
.search-input {
    width: 180px; padding: 5px 26px 5px 28px !important;
    border: 1px solid var(--border-color); border-radius: 6px;
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
}
.search-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.search-clear {
    position: absolute; right: 6px; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 0 2px;
    opacity: 0.7;
}
.search-clear:hover { opacity: 1; color: var(--danger, #f87171); }

/* 最小次数输入 */
.count-input {
    width: 70px; padding: 4px 6px; font-size: 12px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-secondary); color: var(--text-primary);
}
.count-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
/* 隐藏数字 spinner */
.count-input::-webkit-inner-spin-button,
.count-input::-webkit-outer-spin-button { -webkit-appearance: none; }
.count-input { -moz-appearance: textfield; }

/* 仅密码学 toggle */
.filter-toggle {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); user-select: none;
    transition: background 0.15s, border-color 0.15s; font-size: 12px; color: var(--text-muted);
}
.filter-toggle:hover { border-color: rgba(245,158,11,0.4); background: var(--bg-tertiary); }
.filter-toggle.toggle-active {
    background: rgba(245,158,11,0.1); border-color: rgba(245,158,11,0.45); color: #fcd34d;
}
.toggle-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: var(--text-muted); transition: background 0.15s;
}
.filter-toggle.toggle-active .toggle-dot { background: #fcd34d; }

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
.td-count { font-weight: 600; color: #a5b4fc !important; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 300px; display: block; overflow: hidden; text-overflow: ellipsis; }
.text-muted { color: var(--text-muted); }
.row-crypto td { background: rgba(245,158,11,0.06) !important; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
</style>
