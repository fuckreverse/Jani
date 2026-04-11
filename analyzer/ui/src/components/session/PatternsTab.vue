<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A8 · 值模式 / 魔术常数</h2>
      <span class="section-badge">{{ filteredPatterns.length }} 条</span>
      <span v-if="cryptoCount > 0" class="section-badge badge-crypto">🔐 {{ cryptoCount }} 个密码学常数</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar" style="margin-bottom:8px">
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

      <!-- 长度过滤 -->
      <label class="filter-label">
        长度
        <input
          v-model.number="lenMin"
          type="number"
          min="0"
          class="count-input count-input-len"
          placeholder="最小"
          @input="onLenFilterInput"
        />
        <span class="filter-range-sep">–</span>
        <input
          v-model.number="lenMax"
          type="number"
          min="0"
          class="count-input count-input-len"
          placeholder="最大"
          @input="onLenFilterInput"
        />
      </label>

      <button class="btn-secondary" @click="resetFilters">重置</button>
    </div>

    <!-- 模式类型 chip 过滤栏（含「仅密码学」） -->
    <div class="type-filter-bar" style="margin-bottom:12px">
      <span class="type-filter-label">类型：</span>
      <!-- 「仅密码学」作为特殊 chip，与 patternType 互斥 -->
      <button
        class="type-chip type-chip-crypto"
        :class="{ 'type-chip-active': onlyCrypto }"
        :style="onlyCrypto ? { background: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.45)', color: '#fcd34d' } : {}"
        title="只显示已匹配密码学常数的值"
        @click="onCryptoChipClick"
      >🔐 密码学常数</button>
      <button
        v-for="t in PATTERN_TYPES"
        :key="t.value"
        class="type-chip"
        :class="{ 'type-chip-active': selectedPatternType === t.value }"
        :style="selectedPatternType === t.value ? { background: t.bg, borderColor: t.border, color: t.color } : {}"
        @click="onPatternTypeClick(t.value)"
        :title="t.desc"
      >{{ t.label }}</button>
    </div>

    <div v-if="patternsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="filteredPatterns.length === 0" class="empty-state">
      <p v-if="varSearch || valueSearch || minCount || lenMin || lenMax || selectedPatternType || onlyCrypto">无匹配的值模式</p>
      <p v-else>暂无值模式数据（请先运行 A8 · ValuePatternDetector）</p>
    </div>
    <div v-else>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr>
              <th>值内容</th>
              <th>类型</th>
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

              <!-- 模式类型 badge -->
              <td>
                <span
                  v-if="p.pattern_type"
                  class="pattern-type-badge"
                  :class="'ptype-' + p.pattern_type"
                >{{ PATTERN_TYPE_LABELS[p.pattern_type] ?? p.pattern_type }}</span>
                <span v-else class="text-muted">—</span>
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
        共 {{ filteredPatterns.length }} 条
        <span v-if="selectedPatternType"> · 类型过滤：{{ PATTERN_TYPE_LABELS[selectedPatternType] ?? selectedPatternType }}</span>
        · 点击值内容可展开完整值并复制
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

// ── 模式类型常量表 ────────────────────────────────────────────────────────────
const PATTERN_TYPES = [
    { value: 'timestamp_ms',   label: '⏱ 时间戳(ms)',    desc: '13 位 Unix 毫秒时间戳',        color: '#fde68a', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)' },
    { value: 'timestamp_s',    label: '⏱ 时间戳(s)',     desc: '10 位 Unix 秒时间戳',          color: '#fde68a', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)' },
    { value: 'uuid',           label: '🆔 UUID',          desc: 'UUID v1-v5 格式',              color: '#a5f3fc', bg: 'rgba(6,182,212,0.12)',  border: 'rgba(6,182,212,0.35)'  },
    { value: 'hex_str',        label: '🔣 Hex',           desc: '纯十六进制字符串（偶数长度≥8）', color: '#c4b5fd', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.35)' },
    { value: 'base64_charset', label: '📋 B64字符表',     desc: '标准/URL-safe/魔改 Base64 字符表', color: '#86efac', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.35)'  },
    { value: 'custom_alphabet',label: '🔀 自定义字母表',  desc: '64 个唯一字符的自定义编码字典', color: '#f9a8d4', bg: 'rgba(236,72,153,0.12)', border: 'rgba(236,72,153,0.35)' },
    { value: 'base64_encoded', label: '📦 Base64编码',    desc: '看起来像 Base64 编码结果',      color: '#6ee7b7', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.35)' },
    { value: 'ip_addr',        label: '🌐 IP地址',        desc: 'IPv4 地址（带或不带端口）',     color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)' },
    { value: 'url',            label: '🔗 URL',           desc: 'HTTP/HTTPS URL',               color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)' },
    { value: 'json_obj',       label: '📄 JSON',          desc: 'JSON 对象/数组字符串',          color: '#d1d5db', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.35)' },
    { value: 'byte_array',     label: '📊 字节数组',      desc: '纯整数数组（16~512 元素，每个 0-255）', color: '#fca5a5', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)'  },
];

// 用于显示徽章文字（不含 emoji，更紧凑）
const PATTERN_TYPE_LABELS = {
    timestamp_ms:    '时间戳ms',
    timestamp_s:     '时间戳s',
    uuid:            'UUID',
    hex_str:         'Hex',
    base64_charset:  'B64字符表',
    custom_alphabet: '自定义字母表',
    base64_encoded:  'Base64',
    ip_addr:         'IP地址',
    url:             'URL',
    json_obj:        'JSON',
    byte_array:      '字节数组',
};

// ── 筛选条件 ──────────────────────────────────────────────────────────────────
const varSearch          = ref('');   // 前端过滤：变量名
const valueSearch        = ref('');   // 服务端过滤：值内容
const minCount           = ref('');   // 前端过滤：最小次数
const lenMin             = ref('');   // 服务端过滤：值长度最小值
const lenMax             = ref('');   // 服务端过滤：值长度最大值
const onlyCrypto         = ref(false); // 仅密码学常数（与 selectedPatternType 互斥）
const selectedPatternType = ref('');   // 服务端过滤：语义类型（单选，空=全部）

// ── 服务端搜索/过滤防抖 ──────────────────────────────────────────────────────
let valueSearchTimer = null;
let lenFilterTimer   = null;

function onValueSearchInput() {
    clearTimeout(valueSearchTimer);
    valueSearchTimer = setTimeout(() => {
        loadValuePatterns();
    }, 350);
}

function onLenFilterInput() {
    clearTimeout(lenFilterTimer);
    lenFilterTimer = setTimeout(() => {
        loadValuePatterns();
    }, 400);
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

// ── 密码学 chip 点击（与 patternType 互斥）─────────────────────────────────────
function onCryptoChipClick() {
    onlyCrypto.value = !onlyCrypto.value;
    if (onlyCrypto.value) selectedPatternType.value = ''; // 互斥：取消 patternType 选中
    loadValuePatterns();
}

// ── 模式类型 chip 点击（单选切换，与 onlyCrypto 互斥）───────────────────────────
function onPatternTypeClick(typeVal) {
    selectedPatternType.value = selectedPatternType.value === typeVal ? '' : typeVal;
    if (selectedPatternType.value) onlyCrypto.value = false; // 互斥：取消密码学选中
    loadValuePatterns();
}

// ── 重置所有过滤条件 ──────────────────────────────────────────────────────────
function resetFilters() {
    varSearch.value           = '';
    valueSearch.value         = '';
    minCount.value            = '';
    lenMin.value              = '';
    lenMax.value              = '';
    onlyCrypto.value          = false;
    selectedPatternType.value = '';
    loadValuePatterns();
}

// ── 加载数据（服务端过滤：onlyCrypto + valueSearch + patternType）────────────
async function loadValuePatterns() {
    patternsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '2000' });
        if (onlyCrypto.value) params.set('onlyCrypto', '1');
        if (valueSearch.value.trim()) params.set('valueSearch', valueSearch.value.trim());
        if (selectedPatternType.value) params.set('patternType', selectedPatternType.value);
        if (lenMin.value !== '' && lenMin.value !== null) params.set('lenMin', String(lenMin.value));
        if (lenMax.value !== '' && lenMax.value !== null) params.set('lenMax', String(lenMax.value));
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

/* 数字输入框（次数 + 长度） */
.count-input {
    width: 60px; padding: 4px 6px; font-size: 12px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-secondary); color: var(--text-primary);
}
.count-input-len { width: 54px; }
.count-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.count-input::-webkit-inner-spin-button,
.count-input::-webkit-outer-spin-button { -webkit-appearance: none; }
.count-input { -moz-appearance: textfield; }
.filter-range-sep { font-size: 11px; color: var(--text-muted); padding: 0 1px; }

/* 密码学 chip 悬停色（偏金色，与普通 chip 区分） */
.type-chip-crypto:hover {
    border-color: rgba(245,158,11,0.4) !important;
    background: rgba(245,158,11,0.08) !important;
    color: #fde68a !important;
}

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

/* ── 模式类型 chip 过滤栏 ──────────────────────────────────────────────────── */
.type-filter-bar {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.type-filter-label {
    font-size: 11px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0;
}
.type-chip {
    padding: 2px 9px; border-radius: 10px; font-size: 11px; white-space: nowrap;
    border: 1px solid var(--border-color); background: transparent;
    color: var(--text-muted); cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.type-chip:hover {
    border-color: rgba(99,102,241,0.4); background: rgba(99,102,241,0.08);
    color: var(--text-primary);
}
.type-chip-active { font-weight: 600; }

/* ── 模式类型 badge（表格内）──────────────────────────────────────────────── */
.pattern-type-badge {
    display: inline-block; padding: 1px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 600; font-family: monospace;
    white-space: nowrap;
    background: rgba(107,114,128,0.15); color: var(--text-muted);
    border: 1px solid rgba(107,114,128,0.25);
}
/* 各类型独立配色 */
.ptype-timestamp_ms, .ptype-timestamp_s {
    background: rgba(245,158,11,0.15); color: #fde68a; border-color: rgba(245,158,11,0.35);
}
.ptype-uuid {
    background: rgba(6,182,212,0.12); color: #a5f3fc; border-color: rgba(6,182,212,0.3);
}
.ptype-hex_str {
    background: rgba(139,92,246,0.12); color: #c4b5fd; border-color: rgba(139,92,246,0.3);
}
.ptype-base64_charset {
    background: rgba(34,197,94,0.12); color: #86efac; border-color: rgba(34,197,94,0.3);
}
.ptype-custom_alphabet {
    background: rgba(236,72,153,0.12); color: #f9a8d4; border-color: rgba(236,72,153,0.3);
}
.ptype-base64_encoded {
    background: rgba(16,185,129,0.12); color: #6ee7b7; border-color: rgba(16,185,129,0.3);
}
.ptype-ip_addr, .ptype-url {
    background: rgba(59,130,246,0.12); color: #93c5fd; border-color: rgba(59,130,246,0.3);
}
.ptype-json_obj {
    background: rgba(107,114,128,0.12); color: #d1d5db; border-color: rgba(107,114,128,0.3);
}
.ptype-byte_array {
    background: rgba(239,68,68,0.12); color: #fca5a5; border-color: rgba(239,68,68,0.3);
}
</style>
