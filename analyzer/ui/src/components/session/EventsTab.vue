<template>
  <div>
    <!-- 事件列表 -->
    <div class="events-section card">
      <div class="events-toolbar">
        <h2 class="section-title">事件流</h2>
        <div class="filters">
          <!-- 事件类型多选下拉 -->
          <div class="type-multiselect" ref="typeDropdownRef">
            <div class="type-multiselect-trigger" @click="toggleTypeDropdown">
              <span v-if="filters.types.length === 0" class="type-placeholder">事件类型（全部）</span>
              <span v-else class="type-selected-chips">
                <span
                  v-for="t in filters.types"
                  :key="t"
                  class="type-badge"
                  :class="`type-${t}`"
                  @click.stop="removeTypeFilter(t)"
                >{{ t }} ✕</span>
              </span>
              <span class="type-caret">▾</span>
            </div>
            <div v-if="typeDropdownOpen" class="type-dropdown-menu">
              <div class="type-dropdown-search">
                <input v-model="typeSearchQuery" placeholder="搜索类型..." @click.stop />
              </div>
              <div class="type-dropdown-list">
                <label
                  v-for="item in filteredEventTypeOptions"
                  :key="item.type"
                  class="type-dropdown-item"
                  :class="{ 'item-selected': filters.types.includes(item.type) }"
                  @click.stop="toggleTypeFilter(item.type)"
                >
                  <input type="checkbox" :checked="filters.types.includes(item.type)" @change.stop />
                  <span class="type-badge" :class="`type-${item.type}`">{{ item.type }}</span>
                  <span class="type-cnt">{{ item.cnt.toLocaleString('zh-CN') }}</span>
                </label>
              </div>
              <div class="type-dropdown-footer">
                <button class="btn-link" @click.stop="filters.types = []; typeDropdownOpen = false; loadEvents(true)">清空</button>
                <button class="btn-primary" style="font-size:11px;padding:3px 10px" @click.stop="typeDropdownOpen = false; loadEvents(true)">确定</button>
              </div>
            </div>
          </div>
          <input
            v-model="filters.line"
            placeholder="行号"
            type="number"
            style="width:90px"
            @keyup.enter="loadEvents(true)"
          />
          <input
            v-model="filters.varName"
            placeholder="变量名"
            style="width:120px"
            @keyup.enter="loadEvents(true)"
          />
          <!-- 值搜索 -->
          <div class="value-search-group">
            <select v-model="filters.valueMode" class="value-mode-select" @change="filters.valueQuery = ''; filters.valueQuery2 = ''">
              <option value="">值搜索…</option>
              <option value="str">字符串精确</option>
              <option value="strLike">字符串模糊(*)</option>
              <option value="num">数值精确</option>
              <option value="numRange">数值范围</option>
            </select>
            <template v-if="filters.valueMode === 'numRange'">
              <input v-model="filters.valueQuery"  placeholder="最小值" type="number" style="width:80px" @keyup.enter="loadEvents(true)" />
              <span class="range-sep">~</span>
              <input v-model="filters.valueQuery2" placeholder="最大值" type="number" style="width:80px" @keyup.enter="loadEvents(true)" />
            </template>
            <input
              v-else-if="filters.valueMode"
              v-model="filters.valueQuery"
              :placeholder="filters.valueMode === 'num' ? '数值' : filters.valueMode === 'strLike' ? '模糊，* 通配' : '字符串'"
              :type="filters.valueMode === 'num' ? 'number' : 'text'"
              style="width:140px"
              @keyup.enter="loadEvents(true)"
            />
          </div>
          <button class="btn-primary" :disabled="valueSearchLoading" @click="loadEvents(true)">
            <span v-if="valueSearchLoading">搜索中…</span>
            <span v-else>查询</span>
          </button>
          <button class="btn-secondary" @click="clearFilters">清空</button>
        </div>
        <div v-if="valueSearchError" class="value-search-error">{{ valueSearchError }}</div>
      </div>

      <!-- 加载中 -->
      <div v-if="eventsLoading" class="loading">
        <div class="spinner"></div>
        <span>加载事件...</span>
      </div>

      <!-- 跳转错误提示（独立显示，不影响表格渲染） -->
      <div v-if="gotoFnError" class="goto-fn-error">{{ gotoFnError }}</div>

      <!-- 值搜索命中数提示 -->
      <div v-if="valueSearchTotal > 0" class="value-search-total">
        共命中 <strong>{{ valueSearchTotal }}</strong> 条事件
      </div>

      <!-- 事件表格 -->
      <div v-if="events.length > 0" class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr>
              <th>SEQ</th>
              <th>类型</th>
              <th>行:列</th>
              <th>源码</th>
              <th v-if="valueSearchTotal > 0">命中值</th>
              <th>写入</th>
              <th>读取</th>
              <th>属性</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="event in events"
              :key="event.seq"
              :class="{ 'row-selected': selectedSeq === event.seq }"
              @click="selectedSeq = event.seq"
            >
              <td class="td-seq">{{ event.seq }}</td>
              <td class="td-type">
                <span class="type-badge" :class="`type-${event.type}`">{{ event.type }}</span>
              </td>
              <td class="td-location">
                <span v-if="event.line != null">{{ event.line }}:{{ event.col ?? 0 }}</span>
                <span v-else class="text-muted">—</span>
              </td>
              <td class="td-src">
                <code class="src-text">{{ truncate(event.srcText, 60) }}</code>
              </td>
              <td v-if="valueSearchTotal > 0" class="td-match">
                <span v-if="event.matchInfo" class="match-chip"
                      :title="`${event.matchInfo.source}: ${event.matchInfo.varName ?? ''}`">
                  <em v-if="event.matchInfo.varName" class="match-var">{{ event.matchInfo.varName }}</em>
                  <span class="match-eq" v-if="event.matchInfo.varName">=</span>
                  <span class="match-val">{{ truncate(event.matchInfo.valType === 'num'
                    ? String(event.matchInfo.valNum)
                    : (event.matchInfo.valStr ?? ''), 24) }}</span>
                </span>
              </td>
              <td class="td-vars">
                <span
                  v-for="w in (event.writes || []).slice(0, 3)"
                  :key="w.name"
                  class="var-chip var-write"
                  :title="`${w.name} = ${JSON.stringify(w.value)}`"
                >{{ w.name }}<span class="var-chip-val" v-if="w.value !== null && w.value !== undefined && !w.omitted">=<em>{{ truncate(formatValue(w.value), 20) }}</em></span><span class="var-chip-omitted" v-else-if="w.omitted">…</span></span>
                <span v-if="(event.writes || []).length > 3" class="var-more">+{{ event.writes.length - 3 }}</span>
              </td>
              <td class="td-vars">
                <span
                  v-for="r in (event.reads || []).slice(0, 3)"
                  :key="r.name"
                  class="var-chip var-read"
                  :title="`${r.name} → ${JSON.stringify(r.value)}`"
                >{{ r.name }}<span class="var-chip-val" v-if="r.value !== null && r.value !== undefined && !r.omitted">→<em>{{ truncate(formatValue(r.value), 20) }}</em></span><span class="var-chip-omitted" v-else-if="r.omitted">…</span></span>
                <span v-if="(event.reads || []).length > 3" class="var-more">+{{ event.reads.length - 3 }}</span>
              </td>
              <td class="td-vars">
                <span
                  v-for="f in (event.fields || []).slice(0, 2)"
                  :key="`${f.base}.${f.offset}`"
                  class="var-chip var-field"
                  :title="`${f.base}.${f.offset} ${f.isWrite ? '=' : '→'} ${JSON.stringify(f.value)}`"
                >{{ f.base }}.{{ f.offset }}</span>
                <span v-if="(event.fields || []).length > 2" class="var-more">+{{ event.fields.length - 2 }}</span>
              </td>
              <td class="td-actions">
                <button
                  class="btn-goto-fn"
                  :class="{ 'btn-goto-fn-loading': gotoFnLoading[event.seq] }"
                  :disabled="gotoFnLoading[event.seq]"
                  title="跳转到所属函数"
                  @click.stop="gotoOwnerFn(event)"
                >📌</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!eventsLoading && events.length === 0" class="empty-state">
        <p>暂无事件，或条件过滤后无结果</p>
      </div>

      <!-- 分页 -->
      <div v-if="events.length > 0" class="pagination">
        <button class="btn-secondary" :disabled="currentPage <= 1" @click="prevPage">← 上一页</button>
        <span class="page-info">第 {{ currentPage }} 页（每页 {{ PAGE_SIZE }} 条）</span>
        <button class="btn-secondary" :disabled="!hasMore" @click="nextPage">下一页 →</button>
      </div>
    </div>

    <!-- 选中事件详情 -->
    <div v-if="selectedEvent" class="event-detail card">
      <h2 class="section-title">事件详情 — SEQ {{ selectedEvent.seq }}</h2>
      <div class="detail-grid">
        <div v-if="selectedEvent.writes?.length" class="detail-section">
          <div class="detail-label">写入变量</div>
          <div v-for="w in selectedEvent.writes" :key="w.name" class="var-row">
            <span class="var-name">{{ w.name }}</span>
            <span class="var-arrow">=</span>
            <code class="var-value">{{ formatValue(w.value) }}</code>
            <span v-if="w.omitted" class="omitted-badge">OMITTED</span>
          </div>
        </div>
        <div v-if="selectedEvent.reads?.length" class="detail-section">
          <div class="detail-label">读取变量</div>
          <div v-for="r in selectedEvent.reads" :key="r.name" class="var-row">
            <span class="var-name">{{ r.name }}</span>
            <span class="var-arrow">→</span>
            <code class="var-value">{{ formatValue(r.value) }}</code>
            <span v-if="r.omitted" class="omitted-badge">OMITTED</span>
          </div>
        </div>
        <div v-if="selectedEvent.fields?.length" class="detail-section">
          <div class="detail-label">属性访问</div>
          <div v-for="f in selectedEvent.fields" :key="`${f.base}.${f.offset}`" class="var-row">
            <span class="var-name">{{ f.base }}.{{ f.offset }}</span>
            <span class="var-arrow">{{ f.isWrite ? '=' : '→' }}</span>
            <code class="var-value">{{ formatValue(f.value) }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onUnmounted } from 'vue';
import { truncate, formatValue } from '../../composables/useSessionUtils.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const emit = defineEmits(['goto-function']);

const PAGE_SIZE = 100;

const events        = ref([]);
const eventsLoading = ref(false);
const hasMore       = ref(false);
const currentPage   = ref(1);
const selectedSeq   = ref(null);

const filters = ref({ types: [], line: '', varName: '', valueMode: '', valueQuery: '', valueQuery2: '' });

const selectedEvent = computed(() =>
    events.value.find(e => e.seq === selectedSeq.value) ?? null
);

// ─── 事件类型下拉 ─────────────────────────────────────────────────────────────

const typeDropdownOpen  = ref(false);
const typeDropdownRef   = ref(null);
const typeSearchQuery   = ref('');
const eventTypeOptions  = ref([]);

const filteredEventTypeOptions = computed(() => {
    const q = typeSearchQuery.value.trim().toLowerCase();
    if (!q) return eventTypeOptions.value;
    return eventTypeOptions.value.filter(o => o.type.toLowerCase().includes(q));
});

function toggleTypeDropdown() {
    typeDropdownOpen.value = !typeDropdownOpen.value;
    if (typeDropdownOpen.value) typeSearchQuery.value = '';
}

function toggleTypeFilter(type) {
    const idx = filters.value.types.indexOf(type);
    if (idx >= 0) filters.value.types.splice(idx, 1);
    else filters.value.types.push(type);
}

function removeTypeFilter(type) {
    const idx = filters.value.types.indexOf(type);
    if (idx >= 0) {
        filters.value.types.splice(idx, 1);
        loadEvents(true);
    }
}

function handleOutsideClick(e) {
    if (typeDropdownRef.value && !typeDropdownRef.value.contains(e.target)) {
        typeDropdownOpen.value = false;
    }
}

async function loadEventTypes() {
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/event-types`);
        if (!res.ok) return;
        const data = await res.json();
        eventTypeOptions.value = data.types || [];
    } catch { /* ignore */ }
}

// ─── 事件列表加载 ─────────────────────────────────────────────────────────────

const valueSearchLoading = ref(false);
const valueSearchError   = ref('');
// 值搜索模式下的总命中数（用于分页显示）
const valueSearchTotal   = ref(0);

/** 判断当前是否处于值搜索模式（使用 value-search/events 接口） */
function isValueSearchMode() {
    const { valueMode, valueQuery, valueQuery2 } = filters.value;
    if (!valueMode) return false;
    if (valueMode === 'numRange') return !!(valueQuery.trim() || valueQuery2.trim());
    return !!valueQuery.trim();
}

/** 构建值搜索查询参数（共用于 value-search 和 value-search/events） */
function buildValueSearchParams() {
    const { valueMode, valueQuery, valueQuery2 } = filters.value;
    const p = new URLSearchParams();
    if (valueMode === 'str')          p.set('str',     valueQuery.trim());
    else if (valueMode === 'strLike') p.set('strLike', valueQuery.trim());
    else if (valueMode === 'num')     p.set('num',     valueQuery.trim());
    else if (valueMode === 'numRange') {
        if (valueQuery.trim())  p.set('numMin', valueQuery.trim());
        if (valueQuery2.trim()) p.set('numMax', valueQuery2.trim());
    }
    return p;
}

async function loadEvents(reset = false) {
    if (reset) currentPage.value = 1;
    eventsLoading.value  = true;
    valueSearchError.value = '';

    try {
        if (isValueSearchMode()) {
            // ── 值搜索模式：使用 value-search/events 合并接口，支持正确分页 ──
            const p = buildValueSearchParams();
            p.set('limit',  PAGE_SIZE);
            p.set('offset', (currentPage.value - 1) * PAGE_SIZE);
            // varName 过滤同时传给值搜索接口
            if (filters.value.varName) p.set('varName', filters.value.varName.trim());

            valueSearchLoading.value = true;
            const res = await fetch(`/api/sessions/${props.sessionId}/value-search/events?${p}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            events.value          = data.events || [];
            hasMore.value         = data.hasMore || false;
            valueSearchTotal.value = data.total  ?? 0;

            if (data.total === 0) valueSearchError.value = '值搜索无匹配';
        } else {
            // ── 普通模式：使用 events 接口 ──
            valueSearchTotal.value = 0;
            const params = new URLSearchParams({
                limit:  PAGE_SIZE,
                offset: (currentPage.value - 1) * PAGE_SIZE,
            });
            if (filters.value.types.length > 0) params.set('types', filters.value.types.join(','));
            if (filters.value.line)    params.set('line',    filters.value.line);
            if (filters.value.varName) params.set('varName', filters.value.varName.trim());

            const res = await fetch(`/api/sessions/${props.sessionId}/events?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            events.value  = data.events || [];
            hasMore.value = data.hasMore || false;
        }
    } catch (e) {
        console.error('loadEvents error:', e);
        valueSearchError.value = e.message ? `加载失败: ${e.message}` : '';
    } finally {
        eventsLoading.value      = false;
        valueSearchLoading.value = false;
    }
}

function prevPage() {
    if (currentPage.value > 1) { currentPage.value--; loadEvents(); }
}

function nextPage() {
    if (hasMore.value) { currentPage.value++; loadEvents(); }
}

function clearFilters() {
    filters.value = { types: [], line: '', varName: '', valueMode: '', valueQuery: '', valueQuery2: '' };
    valueSearchTotal.value = 0;
    valueSearchError.value = '';
    typeDropdownOpen.value = false;
    loadEvents(true);
}

// ─── 跳转到所属函数 ───────────────────────────────────────────────────────────

const gotoFnLoading = reactive({}); // seq → boolean
const gotoFnError   = ref('');

async function gotoOwnerFn(event) {
    if (gotoFnLoading[event.seq]) return;
    gotoFnLoading[event.seq] = true;
    gotoFnError.value = '';
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/events/${event.seq}/owner-fn`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.ownerFn) {
            gotoFnError.value = `SEQ ${event.seq} 不在任何函数调用内（顶层代码）`;
            setTimeout(() => { gotoFnError.value = ''; }, 3000);
            return;
        }
        emit('goto-function', {
            fnName:  data.ownerFn.fnName,
            fnIid:   data.ownerFn.fnIid,
            callSeq: data.ownerFn.callSeq,
        });
    } catch (e) {
        gotoFnError.value = `查询失败: ${e.message}`;
        setTimeout(() => { gotoFnError.value = ''; }, 3000);
    } finally {
        gotoFnLoading[event.seq] = false;
    }
}

defineExpose({ reload: () => loadEvents(true) });

onMounted(async () => {
    await loadEvents();
    await loadEventTypes();
    document.addEventListener('click', handleOutsideClick);
});

onUnmounted(() => {
    document.removeEventListener('click', handleOutsideClick);
});
</script>

<style scoped>
/* 事件工具栏 */
.events-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px; flex-wrap: wrap; gap: 12px;
}
.filters { display: flex; align-items: center; gap: 8px; }
.filters input { width: 200px; }

/* 事件表格 */
.events-table-wrapper { overflow-x: auto; }
.events-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.events-table th {
    text-align: left; padding: 8px 12px; color: var(--text-muted);
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    border-bottom: 1px solid var(--border-color); white-space: nowrap;
}
.events-table td { padding: 7px 12px; border-bottom: 1px solid rgba(45,49,72,0.5); vertical-align: middle; }
.events-table tr:hover td { background: var(--bg-tertiary); }
.row-selected td { background: rgba(99,102,241,0.1) !important; }
.td-seq { font-family: monospace; color: var(--text-muted); min-width: 50px; }
.td-location { font-family: monospace; color: var(--text-muted); min-width: 60px; }
.td-vars { max-width: 150px; }

.type-badge {
    display: inline-block; padding: 2px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 700; white-space: nowrap;
}
.type-END_EXPR      { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.type-CALL_PRE      { background: rgba(245,158,11,0.15); color: #fcd34d; }
.type-CALL          { background: rgba(34,197,94,0.15);  color: #86efac; }
.type-SCRIPT_ENTER  { background: rgba(59,130,246,0.15); color: #93c5fd; }
.type-FUNCTION_ENTER { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.type-FUNCTION_EXIT  { background: rgba(168,85,247,0.15); color: #d8b4fe; }

.src-text {
    color: var(--text-primary); white-space: nowrap; max-width: 300px;
    display: block; overflow: hidden; text-overflow: ellipsis;
}
.text-muted { color: var(--text-muted); }
.var-chip {
    display: inline-block; padding: 1px 5px; border-radius: 3px;
    font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default;
}
.var-write { background: rgba(34,197,94,0.15);  color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-field { background: rgba(245,158,11,0.15); color: #fcd34d; }
.var-chip-val { opacity: 0.75; font-size: 10px; margin-left: 2px; }
.var-chip-val em { font-style: normal; color: #fcd34d; }
.var-chip-omitted { font-size: 10px; opacity: 0.5; margin-left: 1px; }
.var-more { font-size: 11px; color: var(--text-muted); }

/* 分页 */
.pagination {
    display: flex; align-items: center; justify-content: center;
    gap: 16px; margin-top: 16px; padding-top: 16px;
    border-top: 1px solid var(--border-color);
}
.page-info { font-size: 12px; color: var(--text-muted); }

/* 事件详情 */
.event-detail { margin-top: 4px; }
.detail-grid { display: flex; flex-wrap: wrap; gap: 20px; }
.detail-section { flex: 1; min-width: 200px; }
.detail-label {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; margin-bottom: 8px;
}
.var-row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0; border-bottom: 1px solid rgba(45,49,72,0.4); font-size: 12px;
}
.var-name  { font-family: monospace; color: #a5b4fc; min-width: 80px; }
.var-arrow { color: var(--text-muted); }
.var-value {
    color: #fcd34d; max-width: 200px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
}
.omitted-badge {
    font-size: 10px; padding: 1px 5px; background: rgba(148,163,184,0.15);
    color: #94a3b8; border-radius: 3px;
}

/* ─── 事件类型多选下拉 ─────────────────────────────────────────────────────── */
.type-multiselect { position: relative; min-width: 200px; max-width: 400px; }
.type-multiselect-trigger {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 10px; border: 1px solid var(--border-color); border-radius: 6px;
    background: var(--bg-secondary); cursor: pointer; min-height: 32px;
    gap: 6px; transition: border-color 0.15s; flex-wrap: wrap;
}
.type-multiselect-trigger:hover { border-color: rgba(99,102,241,0.5); }
.type-placeholder { font-size: 12px; color: var(--text-muted); flex: 1; }
.type-selected-chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
.type-caret { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.type-dropdown-menu {
    position: absolute; top: calc(100% + 4px); left: 0;
    min-width: 260px; max-width: 340px; background: var(--bg-secondary);
    border: 1px solid var(--border-color); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35); z-index: 100; overflow: hidden;
}
.type-dropdown-search { padding: 8px 10px; border-bottom: 1px solid var(--border-color); }
.type-dropdown-search input { width: 100%; font-size: 12px; padding: 4px 8px; }
.type-dropdown-list { max-height: 260px; overflow-y: auto; padding: 4px 0; }
.type-dropdown-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    cursor: pointer; transition: background 0.1s; font-size: 12px;
}
.type-dropdown-item:hover { background: var(--bg-tertiary); }
.type-dropdown-item.item-selected { background: rgba(99,102,241,0.08); }
.type-dropdown-item input[type="checkbox"] {
    width: 14px; height: 14px; flex-shrink: 0; cursor: pointer; accent-color: #6366f1;
}
.type-cnt { margin-left: auto; font-size: 11px; color: var(--text-muted); font-family: monospace; }
.type-dropdown-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; border-top: 1px solid var(--border-color); background: var(--bg-tertiary);
}
.btn-link { background: none; border: none; color: var(--text-muted); font-size: 11px; cursor: pointer; padding: 0; }
.btn-link:hover { color: var(--text-primary); }

/* ─── 跳转函数按钮 ───────────────────────────────────────────────────────── */
.td-actions { width: 32px; text-align: center; padding: 4px !important; }
.btn-goto-fn {
    background: none; border: none; cursor: pointer; font-size: 13px;
    opacity: 0.45; transition: opacity 0.15s, transform 0.1s;
    padding: 2px 4px; border-radius: 3px; line-height: 1;
}
.btn-goto-fn:hover:not(:disabled) { opacity: 1; background: rgba(99,102,241,0.15); }
.btn-goto-fn:disabled { cursor: default; }
.btn-goto-fn-loading { opacity: 0.3; animation: spin 0.8s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.goto-fn-error {
    font-size: 11px; color: #f87171; margin: 6px 0; padding: 4px 8px;
    background: rgba(248,113,113,0.08); border-radius: 4px;
    border: 1px solid rgba(248,113,113,0.2);
}

/* ─── 值搜索 ─────────────────────────────────────────────────────────────── */
.value-search-group {
    display: flex; align-items: center; gap: 4px;
}
.value-mode-select {
    font-size: 12px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border-color); background: var(--bg-secondary);
    color: var(--text-primary); cursor: pointer; height: 32px;
}
.range-sep { font-size: 12px; color: var(--text-muted); padding: 0 2px; }
.value-search-error {
    font-size: 11px; color: #f87171; margin-top: 6px; padding: 0 4px;
}
.value-search-total {
    font-size: 11px; color: var(--text-muted); margin-bottom: 8px; padding: 0 4px;
}
.value-search-total strong { color: #a5b4fc; }

/* 命中值列 */
.td-match { min-width: 100px; max-width: 180px; }
.match-chip {
    display: inline-flex; align-items: center; gap: 2px;
    font-family: monospace; font-size: 11px;
    background: rgba(99,102,241,0.12); color: #a5b4fc;
    border-radius: 3px; padding: 1px 5px;
    max-width: 160px; overflow: hidden;
}
.match-var { color: #c4b5fd; font-style: normal; }
.match-eq  { color: var(--text-muted); margin: 0 1px; }
.match-val { color: #fcd34d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
