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
        <span class="search-icon">📛</span>
        <input
          v-model="varSearch"
          placeholder="变量名..."
          class="search-input"
          title="按变量名搜索（前端过滤）"
          @input="onLocalFilterChange"
        />
        <button v-if="varSearch" class="search-clear" @click="varSearch = ''" title="清空">✕</button>
      </div>

      <!-- 值内容搜索（走服务端） -->
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input
          v-model="valueSearch"
          placeholder="值内容..."
          class="search-input search-input-wide"
          title="按值内容搜索（服务端模糊匹配）"
          @input="onValueSearchInput"
        />
        <button v-if="valueSearch" class="search-clear" @click="clearValueSearch" title="清空">✕</button>
      </div>

      <!-- 最小出现次数 -->
      <label class="filter-label">
        次数 ≥
        <input
          v-model.number="minCount"
          type="number"
          min="1"
          class="count-input"
          placeholder="不限"
          @input="onLocalFilterChange"
        />
      </label>

      <!-- 仅密码学常数 -->
      <label class="filter-toggle" :class="{ 'toggle-active': onlyCrypto }" @click="onlyCrypto = !onlyCrypto; loadValuePatterns()">
        <span class="toggle-dot"></span>
        仅密码学
      </label>

      <button class="btn-secondary" @click="resetFilters">重置</button>
    </div>

    <div v-if="patternsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="filteredPatterns.length === 0" class="empty-state">
      <p v-if="varSearch || valueSearch || minCount">无匹配的值模式</p>
      <p v-else>暂无值模式数据（请先运行 A8 · ValuePatternDetector）</p>
    </div>
    <div v-else>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr>
              <th>值内容</th>
              <th>出现次数</th>
              <th>首次 SEQ</th>
              <th>iid</th>
              <th>变量名</th>
              <th>行号</th>
              <th>匹配常数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filteredPatterns"
              :key="p.id"
              :class="p.matched_constant ? 'row-crypto' : ''"
            >
              <!-- 值内容：可点击展开完整原始值 -->
              <td>
                <code
                  class="src-text value-clickable"
                  :class="{ 'value-loading': loadingSet.has(p.id) }"
                  :title="p.value_hash + '\n（点击查看完整原始值）'"
                  @click="openValue(p)"
                >{{ loadingSet.has(p.id) ? '加载中…' : truncate(p.value_hash, 60) }}</code>
                <span v-if="!loadingSet.has(p.id) && p.value_hash && p.value_hash.length > 60" class="len-hint">{{ p.value_hash.length }}+ 字符</span>
              </td>

              <!-- 出现次数 -->
              <td class="td-seq td-count">{{ p.count }}</td>

              <!-- 首次 SEQ -->
              <td class="td-seq">{{ p.first_seq }}</td>

              <!-- iid -->
              <td class="td-seq">{{ p.iid ?? '—' }}</td>

              <!-- 变量名 -->
              <td>
                <span v-if="p.var_name" class="var-chip var-write">{{ p.var_name }}</span>
                <span v-else class="text-muted">—</span>
              </td>

              <!-- 行号 -->
              <td class="td-seq">{{ p.line ?? '—' }}</td>

              <!-- 匹配常数 -->
              <td>
                <span v-if="p.matched_constant" class="crypto-badge">{{ p.matched_constant }}</span>
                <span v-else class="text-muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-hint">
        共 {{ filteredPatterns.length }} 条 · 点击值内容可展开完整值并复制
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { truncate } from '../../composables/useSessionUtils.js';
import { openValueViewer } from '../../composables/useValueViewer.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

// ── 服务端数据 ────────────────────────────────────────────────────────────────
const allPatterns     = ref([]);
const patternsLoading = ref(false);

// ── 点击加载完整值的状态追踪 ──────────────────────────────────────────────────
const loadingSet = ref(new Set());

// ── 筛选条件 ──────────────────────────────────────────────────────────────────
const varSearch   = ref('');   // 前端过滤：变量名
const valueSearch = ref('');   // 服务端过滤：值内容
const minCount    = ref('');   // 前端过滤：最小次数
const onlyCrypto  = ref(false);

// ── 服务端搜索防抖 ────────────────────────────────────────────────────────────
let valueSearchTimer = null;

function onValueSearchInput() {
    clearTimeout(valueSearchTimer);
    valueSearchTimer = setTimeout(() => {
        loadValuePatterns();
    }, 350);
}

function clearValueSearch() {
    valueSearch.value = '';
    loadValuePatterns();
}

// ── 前端过滤（变量名 + 最小次数，无需重新请求）────────────────────────────────
function onLocalFilterChange() {
    // 纯前端过滤，响应即时
}

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

// ── 重置所有过滤条件 ──────────────────────────────────────────────────────────
function resetFilters() {
    varSearch.value   = '';
    valueSearch.value = '';
    minCount.value    = '';
    onlyCrypto.value  = false;
    loadValuePatterns();
}

// ── 加载数据（服务端过滤：onlyCrypto + valueSearch）──────────────────────────
async function loadValuePatterns() {
    patternsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '2000' });
        if (onlyCrypto.value) params.set('onlyCrypto', '1');
        if (valueSearch.value.trim()) params.set('valueSearch', valueSearch.value.trim());
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

// ── 点击值行：拉取完整原始值后弹 ValueViewer ──────────────────────────────────
async function openValue(p) {
    if (loadingSet.value.has(p.id)) return;

    // 标记加载中
    const next = new Set(loadingSet.value);
    next.add(p.id);
    loadingSet.value = next;

    let rawFull = p.value_hash ?? '';
    try {
        // 通过 full-value 接口拿 writes 表里的原始完整值
        const res = await fetch(`/api/sessions/${props.sessionId}/value-patterns/${p.id}/full-value`);
        if (res.ok) {
            const data = await res.json();
            if (data.fullValue != null) rawFull = data.fullValue;
        }
    } catch {
        // 网络失败时降级使用 value_hash
    } finally {
        const s = new Set(loadingSet.value);
        s.delete(p.id);
        loadingSet.value = s;
    }

    // 尝试解析为 JSON（数组/对象）以便格式化展示
    let parsed = rawFull;
    if (typeof rawFull === 'string' && (rawFull.startsWith('[') || rawFull.startsWith('{'))) {
        try { parsed = JSON.parse(rawFull); } catch { parsed = rawFull; }
    }

    const label = p.var_name
        ? `${p.var_name}（出现 ${p.count} 次，行 ${p.line ?? '?'}）`
        : `值 · 出现 ${p.count} 次，行 ${p.line ?? '?'}`;
    openValueViewer(parsed, label);
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

/* 筛选栏 */
.filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }

/* 搜索框 */
.search-box { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 8px; font-size: 11px; pointer-events: none; opacity: 0.55; }
.search-input {
    width: 130px; padding: 5px 24px 5px 26px !important;
    border: 1px solid var(--border-color); border-radius: 6px;
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
    transition: border-color 0.15s, width 0.2s;
}
.search-input-wide { width: 180px; }
.search-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.search-clear {
    position: absolute; right: 6px; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 0 2px;
    opacity: 0.7;
}
.search-clear:hover { opacity: 1; color: var(--danger, #f87171); }

/* 最小次数输入 */
.count-input {
    width: 60px; padding: 4px 6px; font-size: 12px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-secondary); color: var(--text-primary);
}
.count-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
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

/* 值内容单元格 */
.src-text {
    color: var(--text-primary);
    white-space: nowrap;
    max-width: 360px;
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
}

/* 可点击的值 —— 仿 StringsTab 的 str-value-clickable 风格 */
.value-clickable {
    cursor: pointer;
    border-bottom: 1px dashed rgba(165, 180, 252, 0.35);
    transition: opacity 0.1s, color 0.1s;
}
.value-clickable:hover {
    opacity: 0.85;
    color: #c7d2fe;
    border-bottom-style: solid;
}
.value-loading {
    cursor: wait;
    opacity: 0.5;
    color: var(--text-muted) !important;
    border-bottom-style: dotted;
}

/* 长度提示 */
.len-hint {
    display: inline-block;
    margin-left: 5px;
    font-size: 10px;
    color: var(--text-muted);
    vertical-align: middle;
    opacity: 0.7;
}

/* 变量名 chip */
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }

/* 密码学常数 badge */
.text-muted { color: var(--text-muted); }
.row-crypto td { background: rgba(245,158,11,0.06) !important; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}

/* 底部提示 */
.table-hint {
    margin-top: 10px; font-size: 11px; color: var(--text-muted);
    text-align: right; padding-right: 4px;
}
</style>
