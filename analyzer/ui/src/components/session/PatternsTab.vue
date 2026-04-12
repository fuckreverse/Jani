<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A8 · 值模式 / 魔术常数</h2>
      <span class="section-badge">{{ totalCount }} 条</span>
      <span v-if="cryptoCount > 0" class="section-badge badge-crypto">🔐 {{ cryptoCount }} 个密码学常数</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar" style="margin-bottom:8px">
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

      <!-- 每页条数 -->
      <label class="filter-label">
        每页
        <select v-model="pageSize" class="page-size-select" @change="onPageSizeChange">
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
          <option :value="500">500</option>
        </select>
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
      <p v-if="valueSearch || lenMin || lenMax || selectedPatternType || onlyCrypto">无匹配的已识别值模式</p>
      <p v-else>暂无值模式数据（请先运行 A8 · ValuePatternDetector）</p>
    </div>
    <div v-else>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr>
              <th>值内容</th>
              <th>类型</th>
              <th>熵値</th>
              <th>匹配常数</th>
              <th></th>
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

              <!-- Shannon 熵値 -->
              <td class="td-entropy">
                <span
                  v-if="p.entropy != null"
                  class="entropy-badge"
                  :class="{
                    'entropy-high': p.entropy > 4.5,
                    'entropy-mid':  p.entropy > 3.5 && p.entropy <= 4.5,
                    'entropy-low':  p.entropy <= 3.5,
                  }"
                  :title="`Shannon 熵 = ${p.entropy} bits/char${p.entropy > 4.5 ? '（高熵，暗示加密/压缩）' : p.entropy > 3.5 ? '（中熵）' : '（低熵）'}`"
                >{{ p.entropy }}</span>
                <span v-else class="text-muted">—</span>
              </td>

              <!-- 匹配常数 -->
              <td>
                <span v-if="p.matched_constant" class="crypto-badge">{{ p.matched_constant }}</span>
                <span v-else class="text-muted">—</span>
              </td>

              <!-- 跳转到事件流 -->
              <td class="td-action">
                <button
                  class="btn-goto-events"
                  title="在事件流中精确匹配这个値"
                  @click.stop="gotoEvents(p)"
                >📋</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- 分页控件 -->
      <div class="pagination-bar">
        <span class="pagination-info">
          共 <strong>{{ totalCount }}</strong> 条
          <template v-if="selectedPatternType"> · 类型：{{ PATTERN_TYPE_LABELS[selectedPatternType] ?? selectedPatternType }}</template>
          · 第 {{ currentPage }} / {{ totalPages }} 页 · 点击值内容可展开完整值
        </span>
        <div class="pagination-controls">
          <button class="page-btn" :disabled="currentPage <= 1" @click="goPage(1)" title="第一页">«</button>
          <button class="page-btn" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)" title="上一页">‹</button>
          <template v-for="pg in pageList" :key="pg">
            <span v-if="pg === '...'" class="page-ellipsis">…</span>
            <button v-else class="page-btn" :class="{ 'page-btn-active': pg === currentPage }" @click="goPage(pg)">{{ pg }}</button>
          </template>
          <button class="page-btn" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)" title="下一页">›</button>
          <button class="page-btn" :disabled="currentPage >= totalPages" @click="goPage(totalPages)" title="最后一页">»</button>
          <label class="jump-label">
            跳至
            <input v-model.number="jumpInput" type="number" min="1" :max="totalPages"
              class="jump-input" @keyup.enter="doJump" />
            页
          </label>
          <button class="btn-secondary btn-jump" @click="doJump">GO</button>
        </div>
      </div>
    </div>

    <!-- ── 降级全量搜索结果区（在 value_dict 全量匹配，不依赖 A8）──────────── -->
    <!-- 只在有搜索关键词时显示 -->
    <template v-if="valueSearch && valueSearch.trim().length >= 2">
      <div class="fallback-divider">
        <span class="fallback-divider-label">🔍 全量字符串搜索（直接查原始值字典）</span>
      </div>

      <div v-if="fallbackLoading" class="loading"><div class="spinner"></div><span>搜索中...</span></div>
      <div v-else-if="fallbackResults.length === 0" class="empty-state">
        <p>在原始值字典中也未找到包含「{{ valueSearch }}」的字符串</p>
      </div>
      <div v-else>
        <div class="events-table-wrapper">
          <table class="events-table">
            <thead>
              <tr>
                <th>值内容（原始字典）</th>
                <th>出现次数</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in fallbackResults" :key="row.value_dict_id">
                <td>
                  <code
                    class="src-text value-clickable"
                    :title="row.val_text + '\n（点击查看完整值）'"
                    @click="openFallbackValue(row)"
                  >{{ truncate(row.val_text, 80) }}</code>
                </td>
                <td class="td-count">
                  <span v-if="row.occurrence_count > 0" class="occurrence-badge">{{ row.occurrence_count }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="td-action">
                  <button
                    class="btn-goto-events"
                    title="在事件流中精确匹配这个值"
                    @click.stop="gotoFallbackEvents(row)"
                  >📋</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pagination-info" style="margin-top:8px">
          共 <strong>{{ fallbackTotal }}</strong> 条匹配
          <span v-if="fallbackTotal >= 50" class="text-muted">（已截断到 Top 50，请缩小关键词范围）</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { truncate } from '../../composables/useSessionUtils.js';
import { openValueViewer } from '../../composables/useValueViewer.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const emit = defineEmits(['goto-event-by-value']);

/**
 * 点击跳转到事件流。
 * value_hash 在 loadValuePatterns 时已 JSON 解包，字符串型直接是裸字符串，数字型是数字字符串。
 */
function gotoEvents(p) {
    const raw = p.value_hash ?? '';
    const n = Number(raw);
    const mode  = (!isNaN(n) && isFinite(n) && raw.trim() !== '') ? 'num' : 'str';
    emit('goto-event-by-value', { value: raw, mode });
}

// ── 服务端数据 ────────────────────────────────────────────────────────────────
const allPatterns     = ref([]);
const patternsLoading = ref(false);
const totalCount      = ref(0);   // 服务端真实总数

// ── 分页状态 ──────────────────────────────────────────────────────────────────
const currentPage = ref(1);
const pageSize    = ref(100);
const jumpInput   = ref('');

const totalPages = computed(() => Math.max(1, Math.ceil(totalCount.value / pageSize.value)));

// 页码列表（带省略号，最多显示约 7 个按钮）
const pageList = computed(() => {
    const total = totalPages.value;
    const cur   = currentPage.value;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    const delta = 2;
    const left  = cur - delta;
    const right = cur + delta;
    pages.push(1);
    if (left > 2)     pages.push('...');
    for (let i = Math.max(2, left); i <= Math.min(total - 1, right); i++) pages.push(i);
    if (right < total - 1) pages.push('...');
    pages.push(total);
    return pages;
});

function goPage(pg) {
    const p = Math.max(1, Math.min(Number(pg), totalPages.value));
    if (p !== currentPage.value) {
        currentPage.value = p;
        loadValuePatterns();
    }
}

function doJump() {
    const pg = Number(jumpInput.value);
    if (pg >= 1 && pg <= totalPages.value) goPage(pg);
    jumpInput.value = '';
}

function onPageSizeChange() {
    currentPage.value = 1;
    loadValuePatterns();
}

// ── 点击加载完整值的状态追踪 ──────────────────────────────────────────────────
const loadingSet = ref(new Set());

// ── 模式类型常量表 ────────────────────────────────────────────────────────────
const PATTERN_TYPES = [
    { value: 'timestamp',      label: '⏱ 时间戳',       desc: 'Unix 时间戳（秒或毫秒）',       color: '#fde68a', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)' },
    { value: 'uuid',           label: '🆔 UUID',          desc: 'UUID v1-v5 格式',              color: '#a5f3fc', bg: 'rgba(6,182,212,0.12)',  border: 'rgba(6,182,212,0.35)'  },
    { value: 'hex_str',        label: '🔣 Hex',           desc: '纯十六进制字符串（偶数长度≥8）', color: '#c4b5fd', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.35)' },
    { value: 'base64_charset', label: '📋 B64字符表',     desc: '标准/URL-safe/魔改 Base64 字符表', color: '#86efac', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.35)'  },
    { value: 'base64_encoded', label: '📦 Base64编码',    desc: '看起来像 Base64 编码结果',      color: '#6ee7b7', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.35)' },
    { value: 'ip_addr',        label: '🌐 IP地址',        desc: 'IPv4 地址（带或不带端口）',     color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)' },
    { value: 'url',            label: '🔗 URL',           desc: 'HTTP/HTTPS URL',               color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)' },
    { value: 'url_encoded',    label: '🔒 URL编码',       desc: '含 %xx 编码的字符串（URL 参数 / form data）', color: '#67e8f9', bg: 'rgba(6,182,212,0.10)', border: 'rgba(6,182,212,0.35)' },
    { value: 'json_obj',       label: '📄 JSON',          desc: 'JSON 对象/数组字符串',          color: '#d1d5db', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.35)' },
    { value: 'byte_array',     label: '📊 字节数组',      desc: '纯整数数组（16~512 元素，每个 0-255）', color: '#fca5a5', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)'  },
    { value: 'plain',          label: '📝 普通字符串',    desc: '无特殊模式的普通字符串（长度≥4）',  color: '#cbd5e1', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.35)' },
];

// 用于显示徽章文字（不含 emoji，更紧凑）
const PATTERN_TYPE_LABELS = {
    timestamp:       '时间戳',
    uuid:            'UUID',
    hex_str:         'Hex',
    base64_charset:  'B64字符表',
    base64_encoded:  'Base64',
    ip_addr:         'IP地址',
    url:             'URL',
    url_encoded:     'URL编码',
    json_obj:        'JSON',
    byte_array:      '字节数组',
    plain:           '普通字符串',
};

// ── 筛选条件 ──────────────────────────────────────────────────────────────────
const varSearch          = ref('');   // 前端过滤：变量名（已废弃，保留避免引用报错）
const valueSearch        = ref('');   // 服务端过滤：值内容
const minCount           = ref('');   // 已废弃（count 字段已移除）
const lenMin             = ref('');   // 服务端过滤：值长度最小值
const lenMax             = ref('');   // 服务端过滤：值长度最大值
const onlyCrypto         = ref(false); // 仅密码学常数（与 selectedPatternType 互斥）
const selectedPatternType = ref('');   // 服务端过滤：语义类型（单选，空=全部）

// ── 服务端搜索/过滤防抖 ──────────────────────────────────────────────────────
let valueSearchTimer = null;
let lenFilterTimer   = null;

function onValueSearchInput() {
    clearTimeout(valueSearchTimer);
    clearTimeout(fallbackTimer);
    valueSearchTimer = setTimeout(() => {
        currentPage.value = 1;
        loadValuePatterns();
    }, 350);
    // 同步触发降级搜索（不管 value_patterns 是否有结果，均并行查询）
    fallbackTimer = setTimeout(() => {
        doFallbackSearch(valueSearch.value);
    }, 350);
}

function onLenFilterInput() {
    clearTimeout(lenFilterTimer);
    lenFilterTimer = setTimeout(() => {
        currentPage.value = 1;
        loadValuePatterns();
    }, 400);
}

function clearValueSearch() {
    valueSearch.value     = '';
    currentPage.value     = 1;
    fallbackResults.value = [];
    fallbackTotal.value   = 0;
    loadValuePatterns();
}

// ── 前端过滤（变量名 + 最小次数，无需重新请求）────────────────────────────────
function onLocalFilterChange() {
    // 纯前端过滤，响应即时
}

const filteredPatterns = computed(() => {
    // count/var_name 字段已移除，无需前端过滤，直接返回全部
    return allPatterns.value;
});

const cryptoCount = computed(() => allPatterns.value.filter(p => p.matched_constant).length);

// ── 密码学 chip 点击（与 patternType 互斥）─────────────────────────────────────
function onCryptoChipClick() {
    onlyCrypto.value = !onlyCrypto.value;
    if (onlyCrypto.value) selectedPatternType.value = '';
    currentPage.value = 1;
    loadValuePatterns();
}

// ── 模式类型 chip 点击（单选切换，与 onlyCrypto 互斥）───────────────────────────
function onPatternTypeClick(typeVal) {
    selectedPatternType.value = selectedPatternType.value === typeVal ? '' : typeVal;
    if (selectedPatternType.value) onlyCrypto.value = false;
    currentPage.value = 1;
    loadValuePatterns();
}

// ── 重置所有过滤条件 ──────────────────────────────────────────────────────────
function resetFilters() {
    varSearch.value           = '';
    valueSearch.value         = '';
    lenMin.value              = '';
    lenMax.value              = '';
    onlyCrypto.value          = false;
    selectedPatternType.value = '';
    currentPage.value         = 1;
    fallbackResults.value     = [];
    fallbackLoading.value     = false;
    loadValuePatterns();
}

// ── 降级搜索：在 value_dict 里全量搜索字符串（不依赖 A8 运行结果）────────────
const fallbackResults  = ref([]);   // 降级搜索命中的结果
const fallbackLoading  = ref(false);
const fallbackTotal    = ref(0);

let fallbackTimer = null;

async function doFallbackSearch(keyword) {
    if (!keyword || keyword.trim().length < 2) {
        fallbackResults.value = [];
        fallbackTotal.value   = 0;
        return;
    }
    fallbackLoading.value = true;
    try {
        const res = await fetch(
            `/api/sessions/${props.sessionId}/value-index-search?q=${encodeURIComponent(keyword.trim())}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fallbackResults.value = data.results || [];
        fallbackTotal.value   = fallbackResults.value.length;
    } catch (e) {
        console.error('fallbackSearch error:', e);
        fallbackResults.value = [];
    } finally {
        fallbackLoading.value = false;
    }
}

// 点击降级结果行，弹出 ValueViewer
function openFallbackValue(row) {
    // val_text 是 JSON 序列化字符串（带引号），解包后展示
    let parsed = row.val_text;
    try { parsed = JSON.parse(row.val_text); } catch { /* keep raw */ }
    const label = typeof parsed === 'string' ? parsed.slice(0, 40) : String(row.val_text).slice(0, 40);
    openValueViewer(parsed, label);
}

// 点击降级结果行跳转到事件流
function gotoFallbackEvents(row) {
    let value = row.val_text;
    try { value = JSON.parse(row.val_text); } catch { /* keep raw */ }
    const strValue = typeof value === 'string' ? value : String(value);
    emit('goto-event-by-value', { value: strValue, mode: 'str' });
}

// ── 加载数据（服务端过滤 + 分页）─────────────────────────────────────────────
async function loadValuePatterns() {
    patternsLoading.value = true;
    try {
        const offsetN = (currentPage.value - 1) * pageSize.value;
        const params  = new URLSearchParams({
            limit:  String(pageSize.value),
            offset: String(offsetN),
        });
        if (onlyCrypto.value)          params.set('onlyCrypto', '1');
        if (valueSearch.value.trim())  params.set('valueSearch', valueSearch.value.trim());
        if (selectedPatternType.value) params.set('patternType', selectedPatternType.value);
        if (lenMin.value !== '' && lenMin.value !== null) params.set('lenMin', String(lenMin.value));
        if (lenMax.value !== '' && lenMax.value !== null) params.set('lenMax', String(lenMax.value));
        const res = await fetch(`/api/sessions/${props.sessionId}/value-patterns?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // value_hash 是 val_text（JSON 序列化格式），字符串型带双引号，解包后才是真实内容
        allPatterns.value = (data.patterns || []).map(p => {
            if (p.value_hash && p.value_hash.startsWith('"') && p.value_hash.endsWith('"')) {
                try {
                    const decoded = JSON.parse(p.value_hash);
                    if (typeof decoded === 'string') return { ...p, value_hash: decoded };
                } catch { /* 解析失败保持原值 */ }
            }
            return p;
        });
        totalCount.value  = data.total ?? data.patterns?.length ?? 0;
        // 如果当前页超出新的总页数，自动修正
        const maxPage = Math.max(1, Math.ceil(totalCount.value / pageSize.value));
        if (currentPage.value > maxPage) currentPage.value = maxPage;
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
        // 通过 full-value 接口拿 val_text（JSON 序列化格式，字符串带引号）
        const res = await fetch(`/api/sessions/${props.sessionId}/value-patterns/${p.id}/full-value`);
        if (res.ok) {
            const data = await res.json();
            if (data.fullValue != null) {
                // val_text 字符串型带引号，先解包为真实内容
                let fv = data.fullValue;
                if (typeof fv === 'string' && fv.startsWith('"') && fv.endsWith('"')) {
                    try { fv = JSON.parse(fv); } catch { /* 保持原值 */ }
                }
                rawFull = fv;
            }
        }
    } catch {
        // 网络失败时降级使用 value_hash（已解包）
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

    let label = p.value_hash ? `值：${String(p.value_hash).slice(0, 40)}` : '值详情';
    // 时间戳类型：把值转为 Number 传给 ValueViewer，触发格式化展示分支
    if (p.pattern_type === 'timestamp') {
        const numStr = String(rawFull ?? p.value_hash ?? '').trim();
        const num = Number(numStr);
        if (!isNaN(num) && isFinite(num)) {
            parsed = num;  // 转为 number，ValueViewer 识别 valueType==='number' 后格式化
            label = numStr;  // label 只用原始数字，ValueViewer 内部会显示格式化时间
        }
    }
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

/* 可点击的值 */
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
.ptype-timestamp {
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
.ptype-base64_encoded {
    background: rgba(16,185,129,0.12); color: #6ee7b7; border-color: rgba(16,185,129,0.3);
}
.ptype-ip_addr, .ptype-url {
    background: rgba(59,130,246,0.12); color: #93c5fd; border-color: rgba(59,130,246,0.3);
}
.ptype-url_encoded {
    background: rgba(6,182,212,0.10); color: #67e8f9; border-color: rgba(6,182,212,0.3);
}
.ptype-json_obj {
    background: rgba(107,114,128,0.12); color: #d1d5db; border-color: rgba(107,114,128,0.3);
}
.ptype-byte_array {
    background: rgba(239,68,68,0.12); color: #fca5a5; border-color: rgba(239,68,68,0.3);
}

/* ── 每页下拉 ── */
.page-size-select {
    padding: 3px 6px; font-size: 12px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-secondary); color: var(--text-primary); cursor: pointer;
}
.page-size-select:focus { outline: none; border-color: rgba(99,102,241,0.5); }

/* ── 分页控件 ── */
.pagination-bar {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 12px; flex-wrap: wrap; gap: 8px;
}
.pagination-info { font-size: 11px; color: var(--text-muted); }
.pagination-info strong { color: var(--text-primary); }

.pagination-controls {
    display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
}

.page-btn {
    min-width: 28px; height: 26px; padding: 0 7px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-secondary); color: var(--text-muted);
    font-size: 12px; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    display: inline-flex; align-items: center; justify-content: center;
}
.page-btn:hover:not(:disabled) {
    background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.4); color: #a5b4fc;
}
.page-btn:disabled { opacity: 0.35; cursor: default; }
.page-btn-active {
    background: rgba(99,102,241,0.2) !important;
    border-color: rgba(99,102,241,0.55) !important;
    color: #c7d2fe !important; font-weight: 700;
}

.page-ellipsis {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; font-size: 12px; color: var(--text-muted); user-select: none;
}

.jump-label {
    font-size: 12px; color: var(--text-muted);
    display: flex; align-items: center; gap: 4px; margin-left: 6px;
}
.jump-input {
    width: 46px; height: 26px; padding: 0 5px; font-size: 12px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-secondary); color: var(--text-primary); text-align: center;
}
.jump-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.jump-input::-webkit-inner-spin-button,
.jump-input::-webkit-outer-spin-button { -webkit-appearance: none; }
.jump-input { -moz-appearance: textfield; }

.btn-jump { padding: 3px 9px; font-size: 12px; height: 26px; }

/* ── 熵値列 ── */
.td-entropy { text-align: center; min-width: 52px; }
.entropy-badge {
    display: inline-block; padding: 1px 6px; border-radius: 4px;
    font-size: 11px; font-weight: 600; font-family: monospace; white-space: nowrap;
    cursor: default;
}
.entropy-high {
    background: rgba(239,68,68,0.18); color: #fca5a5; border: 1px solid rgba(239,68,68,0.35);
}
.entropy-mid {
    background: rgba(245,158,11,0.15); color: #fde68a; border: 1px solid rgba(245,158,11,0.35);
}
.entropy-low {
    background: rgba(107,114,128,0.12); color: #9ca3af; border: 1px solid rgba(107,114,128,0.25);
}

/* ── 跳转事件流按钮 ── */
.td-action { text-align: center; width: 30px; padding: 4px 4px; }
.btn-goto-events {
    background: none; border: none; cursor: pointer;
    font-size: 13px; opacity: 0.45; padding: 1px 3px;
    border-radius: 3px;
    transition: opacity 0.12s, background 0.12s;
}
.btn-goto-events:hover {
    opacity: 1; background: rgba(99,102,241,0.12);
}

/* ── plain 类型 badge ── */
.ptype-plain {
    background: rgba(148,163,184,0.12); color: #cbd5e1; border-color: rgba(148,163,184,0.3);
}

/* ── 降级搜索分隔线 ── */
.fallback-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 20px 0 12px;
    border-top: 1px solid var(--border-color);
    padding-top: 14px;
}
.fallback-divider-label {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    white-space: nowrap; letter-spacing: 0.03em;
}

/* ── 出现次数 badge ── */
.occurrence-badge {
    display: inline-block; padding: 1px 6px; border-radius: 4px;
    font-size: 11px; font-weight: 600; font-family: monospace;
    background: rgba(99,102,241,0.12); color: #a5b4fc;
    border: 1px solid rgba(99,102,241,0.25);
}
</style>
