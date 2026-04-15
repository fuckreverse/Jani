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
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            class="line-input"
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

          <!-- 导出按钮 -->
          <div class="export-wrap" ref="exportBtnRef">
            <button class="btn-export" @click.stop="toggleExportPanel">
              ⬇ 导出
            </button>

            <!-- 导出面板 -->
            <div v-if="exportPanelOpen" class="export-panel" @click.stop>
              <div class="ep-title">导出事件</div>

              <!-- 范围条目列表 -->
              <div class="ep-ranges">
                <div
                  v-for="(rng, idx) in exportRanges"
                  :key="idx"
                  class="ep-range-row"
                >
                  <!-- 范围类型选择 -->
                  <select v-model="rng.type" class="ep-type-sel" @change="onRangeTypeChange(rng)">
                    <option value="seq">SEQ 区间</option>
                    <option value="call">函数调用 callId</option>
                  </select>

                  <!-- SEQ 区间输入 -->
                  <template v-if="rng.type === 'seq'">
                    <input v-model="rng.seqFrom" placeholder="起始 SEQ" type="number" class="ep-seq-input" />
                    <span class="ep-tilde">~</span>
                    <input v-model="rng.seqTo" placeholder="结束 SEQ" type="number" class="ep-seq-input" />
                  </template>

                  <!-- callId 输入 -->
                  <template v-else>
                    <input v-model="rng.callId" placeholder="callId" type="number" class="ep-call-input" />
                    <label class="ep-own-label">
                      <input type="checkbox" v-model="rng.ownOnly" />
                      <span>仅自身</span>
                    </label>
                  </template>

                  <!-- 删除按钮（超过一条时显示） -->
                  <button
                    v-if="exportRanges.length > 1"
                    class="ep-del-btn"
                    @click="exportRanges.splice(idx, 1)"
                    title="删除此范围"
                  >✕</button>
                </div>

                <!-- 添加范围 -->
                <button class="ep-add-btn" @click="addExportRange">＋ 添加范围</button>
              </div>

              <!-- 格式选择 -->
              <div class="ep-fmt">
                <span class="ep-fmt-label">格式</span>
                <label v-for="f in exportFormats" :key="f.value" class="ep-fmt-radio">
                  <input type="radio" v-model="exportFormat" :value="f.value" />
                  <span>{{ f.label }}</span>
                  <span class="ep-fmt-hint">{{ f.hint }}</span>
                </label>
              </div>

              <!-- 操作 -->
              <div class="ep-actions">
                <span v-if="exportError" class="ep-error">{{ exportError }}</span>
                <button
                  class="btn-primary ep-submit"
                  :disabled="exporting"
                  @click="doExport"
                >{{ exporting ? '导出中…' : '下载' }}</button>
              </div>
            </div>
          </div>
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
                  :class="{ 'var-chip-expandable': w.value !== null && w.value !== undefined && !w.omitted }"
                  :title="w.value !== null && w.value !== undefined && !w.omitted ? '点击查看完整值' : `${w.name} = ${JSON.stringify(w.value)}`"
                  @click.stop="w.value !== null && w.value !== undefined && !w.omitted && openValueViewer(w.value, w.name)"
                >{{ w.name }}<span class="var-chip-val" v-if="w.value !== null && w.value !== undefined && !w.omitted">=<em>{{ truncate(formatValue(w.value), 20) }}</em></span><span class="var-chip-omitted" v-else-if="w.omitted">…</span></span>
                <span v-if="(event.writes || []).length > 3" class="var-more">+{{ event.writes.length - 3 }}</span>
              </td>
              <td class="td-vars">
                <span
                  v-for="r in (event.reads || []).slice(0, 3)"
                  :key="r.name"
                  class="var-chip var-read"
                  :class="{ 'var-chip-expandable': r.value !== null && r.value !== undefined && !r.omitted }"
                  :title="r.value !== null && r.value !== undefined && !r.omitted ? '点击查看完整值' : `${r.name} → ${JSON.stringify(r.value)}`"
                  @click.stop="r.value !== null && r.value !== undefined && !r.omitted && openValueViewer(r.value, r.name)"
                >{{ r.name }}<span class="var-chip-val" v-if="r.value !== null && r.value !== undefined && !r.omitted">→<em>{{ truncate(formatValue(r.value), 20) }}</em></span><span class="var-chip-omitted" v-else-if="r.omitted">…</span></span>
                <span v-if="(event.reads || []).length > 3" class="var-more">+{{ event.reads.length - 3 }}</span>
              </td>
              <td class="td-vars">
                <span
                  v-for="f in (event.fields || []).slice(0, 2)"
                  :key="`${f.baseOid ?? '?'}.${f.offset}`"
                  class="var-chip var-field"
                  :title="`#${f.baseOid ?? '?'}.${f.offset} ${f.isWrite ? '=' : '→'} ${JSON.stringify(f.value)}`"
                >#{{ f.baseOid ?? '?' }}.{{ f.offset }}</span>
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
        <span class="page-info">第 {{ currentPage }} 页（每页 {{ PAGE_SIZE }} 条）<span v-if="!isValueSearchMode()" class="cursor-hint" title="游标分页：深页访问速度恒定">⚡</span></span>
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
            <code
              class="var-value"
              :class="{ 'var-value-clickable': !w.omitted && w.value !== null && w.value !== undefined }"
              :title="!w.omitted && w.value !== null && w.value !== undefined ? '点击查看完整值' : ''"
              @click="!w.omitted && w.value !== null && w.value !== undefined && openValueViewer(w.value, w.name)"
            >{{ formatValue(w.value) }}</code>
            <span v-if="w.omitted" class="omitted-badge">OMITTED</span>
          </div>
        </div>
        <div v-if="selectedEvent.reads?.length" class="detail-section">
          <div class="detail-label">读取变量</div>
          <div v-for="r in selectedEvent.reads" :key="r.name" class="var-row">
            <span class="var-name">{{ r.name }}</span>
            <span class="var-arrow">→</span>
            <code
              class="var-value"
              :class="{ 'var-value-clickable': !r.omitted && r.value !== null && r.value !== undefined }"
              :title="!r.omitted && r.value !== null && r.value !== undefined ? '点击查看完整值' : ''"
              @click="!r.omitted && r.value !== null && r.value !== undefined && openValueViewer(r.value, r.name)"
            >{{ formatValue(r.value) }}</code>
            <span v-if="r.omitted" class="omitted-badge">OMITTED</span>
          </div>
        </div>
        <div v-if="selectedEvent.fields?.length" class="detail-section">
          <div class="detail-label">属性访问</div>
          <div v-for="f in selectedEvent.fields" :key="`${f.baseOid ?? '?'}.${f.offset}`" class="var-row">
            <span class="var-name">#{{ f.baseOid ?? '?' }}.{{ f.offset }}</span>
            <span class="var-arrow">{{ f.isWrite ? '=' : '→' }}</span>
            <code
              class="var-value"
              :class="{ 'var-value-clickable': f.value !== null && f.value !== undefined }"
              :title="f.value !== null && f.value !== undefined ? '点击查看完整值' : ''"
              @click="f.value !== null && f.value !== undefined && openValueViewer(f.value, `#${f.baseOid ?? '?'}.${f.offset}`)"
            >{{ formatValue(f.value) }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { truncate, formatValue } from '../../composables/useSessionUtils.js';
import { openValueViewer } from '../../composables/useValueViewer.js';
import { useConfig } from '../../composables/useConfig.js';

const props = defineProps({
    sessionId: { type: String, required: true },
    targetSeq: { type: Number, default: null },   // 从外部跳转到指定 event SEQ
});

const emit = defineEmits(['goto-function']);

const { api: apiCfg } = useConfig();
const PAGE_SIZE = apiCfg.value.defaultPageSize ?? 100;

const events        = ref([]);
const eventsLoading = ref(false);
const hasMore       = ref(false);
const currentPage   = ref(1);
const selectedSeq   = ref(null);

// ─── 游标分页状态（普通模式专用）─────────────────────────────────────────────
// cursorStack[0] = 第 1 页起始游标（始终为 0，代表从头开始）
// cursorStack[n] = 第 n+1 页起始游标（即第 n 页最后一条 seq）
// 翻到第 N 页时：请求 cursor = cursorStack[N-1]（0-indexed）
// 获得响应后：cursorStack[N] = nextCursor（供下一页使用）
const cursorStack   = ref([0]);   // 初始：第 1 页从 cursor=0 开始

const filters = ref({ types: [], line: '', varName: '', valueMode: 'strLike', valueQuery: '', valueQuery2: '' });

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

/**
 * loadEvents — 统一事件加载入口
 *
 * 普通模式（非值搜索）：游标分页（cursor），O(log N) B-tree 定位
 *   - reset=true  → 重置到第 1 页，清空 cursorStack
 *   - seqFromVal  → seqFrom 直接定位（跨 Tab 跳转专用），重置 cursorStack
 *   - 否则        → 用 cursorStack[currentPage-1] 拿本页游标
 * 值搜索模式：保留 offset 分页（结果集小，随机翻页需求高）
 */
async function loadEvents(reset = false, seqFromVal = null) {
    if (reset) {
        currentPage.value = 1;
        cursorStack.value = [0];
    }
    eventsLoading.value  = true;
    valueSearchError.value = '';

    try {
        if (isValueSearchMode()) {
            // ── 值搜索模式：offset 分页（结果集有限，OFFSET 开销可接受）──
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
            // ── 普通模式：游标分页（O(log N) B-tree 定位，消除深页线性扫描）──
            valueSearchTotal.value = 0;
            const params = new URLSearchParams({ limit: PAGE_SIZE });

            if (seqFromVal != null) {
                // 跨 Tab 跳转：用 seqFrom 精确定位，将 seqFrom-1 存为入场游标
                // 这样"上一页"也能正确定位到 seqFrom 之前的事件，而不是跳回最头部
                params.set('seqFrom', seqFromVal);
                cursorStack.value = [Math.max(0, seqFromVal - 1)];  // 入场游标
            } else {
                // 普通翻页：从游标栈取当前页的起始游标
                const cursor = cursorStack.value[currentPage.value - 1] ?? 0;
                if (cursor > 0) params.set('cursor', cursor);
            }

            if (filters.value.types.length > 0) params.set('types', filters.value.types.join(','));
            if (filters.value.line)    params.set('line',    filters.value.line);
            if (filters.value.varName) params.set('varName', filters.value.varName.trim());

            const res = await fetch(`/api/sessions/${props.sessionId}/events?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            events.value  = data.events || [];
            hasMore.value = data.hasMore || false;

            // 保存本页末尾游标，供下一页使用（nextCursor 为 null 表示末页）
            if (data.nextCursor != null) {
                cursorStack.value[currentPage.value] = data.nextCursor;
            }
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
    if (currentPage.value > 1) {
        currentPage.value--;
        loadEvents();
    }
}

function nextPage() {
    if (hasMore.value) {
        currentPage.value++;
        loadEvents();
    }
}

function clearFilters() {
    filters.value = { types: [], line: '', varName: '', valueMode: 'strLike', valueQuery: '', valueQuery2: '' };
    valueSearchTotal.value = 0;
    valueSearchError.value = '';
    typeDropdownOpen.value = false;
    cursorStack.value = [0];
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

// ─── 跨 Tab 导航：跳转到指定 event SEQ ──────────────────────────────────────

watch(() => props.targetSeq, async (seq) => {
    if (seq == null) return;
    // 清空过滤 + 游标栈，用 seqFrom 直接定位（O(log N)，无需估算页码）
    filters.value = { types: [], line: '', varName: '', valueMode: 'strLike', valueQuery: '', valueQuery2: '' };
    valueSearchTotal.value = 0;
    valueSearchError.value = '';
    currentPage.value = 1;
    cursorStack.value = [0];

    // seqFrom 精确定位：后端从 id >= seq 开始返回 PAGE_SIZE 条
    await loadEvents(false, seq);
    await nextTick();

    // 高亮 + 滚动
    selectedSeq.value = seq;
    await nextTick();
    const rows = document.querySelectorAll('.events-table tbody tr');
    for (const row of rows) {
        const seqCell = row.querySelector('.td-seq');
        if (seqCell && Number(seqCell.textContent.trim()) === seq) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        }
    }
});

/**
 * 从外部跳转：以精确匹配方式搜索指定值。
 * mode: 'str'（字符串精确）| 'num'（数值精确），默认 'str'
 */
function gotoValueSearch(value, mode = 'str') {
    filters.value = {
        types: [], line: '', varName: '',
        valueMode: mode === 'num' ? 'num' : 'str',
        valueQuery: String(value ?? ''),
        valueQuery2: '',
    };
    currentPage.value = 1;
    cursorStack.value = [0];
    loadEvents(true);
}

/**
 * 从外部跳转：按行号范围过滤事件流。
 * minLine / maxLine 均为源码行号（包含端点）。
 * 若 maxLine 省略则只按 minLine 精确过滤。
 */
function gotoLine(minLine, maxLine) {
    const lineStr = (maxLine != null && maxLine !== minLine)
        ? `${minLine}-${maxLine}`
        : String(minLine);
    filters.value = {
        types: [], line: lineStr, varName: '',
        valueMode: 'strLike', valueQuery: '', valueQuery2: '',
    };
    currentPage.value = 1;
    cursorStack.value = [0];
    loadEvents(true);
}

// ─── 导出面板 ─────────────────────────────────────────────────────────────────

const exportBtnRef    = ref(null);
const exportPanelOpen = ref(false);
const exporting       = ref(false);
const exportError     = ref('');
const exportFormat    = ref('ndjson');

const exportFormats = [
    { value: 'ndjson', label: 'NDJSON',  hint: 'jq 可直接处理' },
    { value: 'tsv',    label: 'TSV',     hint: 'Excel/awk 友好' },
    { value: 'text',   label: '纯文本',  hint: '人类可读' },
];

function makeEmptyRange() {
    return { type: 'seq', seqFrom: '', seqTo: '', callId: '', ownOnly: true };
}
const exportRanges = ref([makeEmptyRange()]);

function toggleExportPanel() {
    exportPanelOpen.value = !exportPanelOpen.value;
    if (exportPanelOpen.value) exportError.value = '';
}

function addExportRange() {
    exportRanges.value.push(makeEmptyRange());
}

function onRangeTypeChange(rng) {
    // 切换类型时清空输入，避免残留脏数据
    rng.seqFrom = '';
    rng.seqTo   = '';
    rng.callId  = '';
    rng.ownOnly = true;
}

function handleExportOutsideClick(e) {
    if (exportBtnRef.value && !exportBtnRef.value.contains(e.target)) {
        exportPanelOpen.value = false;
    }
}

async function doExport() {
    exportError.value = '';

    // 校验并构建 ranges 数组
    const ranges = [];
    for (const rng of exportRanges.value) {
        if (rng.type === 'seq') {
            const lo = Number(rng.seqFrom);
            const hi = Number(rng.seqTo);
            if (!rng.seqFrom || !rng.seqTo || isNaN(lo) || isNaN(hi)) {
                exportError.value = '请填写完整的 SEQ 范围';
                return;
            }
            if (lo > hi) {
                exportError.value = `SEQ 范围无效：${lo} > ${hi}`;
                return;
            }
            ranges.push({ seqFrom: lo, seqTo: hi });
        } else {
            const cid = Number(rng.callId);
            if (!rng.callId || isNaN(cid)) {
                exportError.value = '请填写有效的 callId';
                return;
            }
            ranges.push({ callId: cid, ownOnly: !!rng.ownOnly });
        }
    }

    exporting.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/events/export`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ ranges, format: exportFormat.value }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        // 流式下载 → Blob → 触发浏览器下载
        const ext  = exportFormat.value === 'tsv' ? 'tsv'
                   : exportFormat.value === 'text' ? 'txt'
                   : 'ndjson';
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `events-${props.sessionId.slice(0, 8)}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        exportPanelOpen.value = false;
    } catch (e) {
        exportError.value = `导出失败: ${e.message}`;
    } finally {
        exporting.value = false;
    }
}

defineExpose({ reload: () => loadEvents(true), gotoValueSearch, gotoLine });

onMounted(async () => {
    await loadEvents();
    await loadEventTypes();
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('click', handleExportOutsideClick);
});

onUnmounted(() => {
    document.removeEventListener('click', handleOutsideClick);
    document.removeEventListener('click', handleExportOutsideClick);
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
.var-chip-expandable { cursor: pointer; }
.var-chip-expandable:hover { filter: brightness(1.2); outline: 1px solid rgba(255,255,255,0.15); }
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
.var-value-clickable {
    cursor: pointer;
    border-bottom: 1px dashed rgba(252, 211, 77, 0.4);
    transition: color 0.1s, border-color 0.1s;
}
.var-value-clickable:hover {
    color: #fef08a;
    border-bottom-color: rgba(252, 211, 77, 0.8);
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

/* ─── 行号输入框：隐藏 number spinner ──────────────────────────────────── */
.line-input::-webkit-outer-spin-button,
.line-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.line-input[type=number] { -moz-appearance: textfield; }

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

/* 游标分页标记 */
.cursor-hint {
    font-size: 10px; margin-left: 4px; opacity: 0.5;
    cursor: default; user-select: none;
}

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

/* ─── 导出面板 ─────────────────────────────────────────────────────────────── */
.export-wrap { position: relative; }

.btn-export {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(99,102,241,0.4);
    background: rgba(99,102,241,0.1); color: #a5b4fc;
    font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
    transition: background 0.15s, border-color 0.15s;
}
.btn-export:hover { background: rgba(99,102,241,0.2); border-color: rgba(99,102,241,0.7); }

.export-panel {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 200;
    width: 380px; padding: 14px 16px;
    background: var(--bg-secondary, #1e2138);
    border: 1px solid var(--border-color, rgba(99,102,241,0.25));
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.45);
}

.ep-title {
    font-size: 13px; font-weight: 700; color: var(--text-primary);
    margin-bottom: 12px; letter-spacing: 0.02em;
}

/* 范围列表 */
.ep-ranges { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }

.ep-range-row {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}

.ep-type-sel {
    padding: 3px 6px; border-radius: 5px; font-size: 11px;
    background: var(--bg-tertiary, #161929); color: var(--text-primary);
    border: 1px solid var(--border-color);
}

.ep-seq-input, .ep-call-input {
    width: 90px; padding: 3px 6px; border-radius: 5px; font-size: 11px;
    background: var(--bg-tertiary, #161929); color: var(--text-primary);
    border: 1px solid var(--border-color); font-family: monospace;
}
.ep-call-input { width: 80px; }

.ep-tilde { color: var(--text-muted); font-size: 12px; }

.ep-own-label {
    display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary);
    cursor: pointer; white-space: nowrap;
}

.ep-del-btn {
    padding: 2px 6px; border-radius: 4px; border: none; font-size: 11px;
    background: rgba(239,68,68,0.15); color: #fca5a5; cursor: pointer;
    transition: background 0.1s;
}
.ep-del-btn:hover { background: rgba(239,68,68,0.3); }

.ep-add-btn {
    align-self: flex-start; padding: 3px 10px; border-radius: 5px;
    border: 1px dashed rgba(99,102,241,0.4); background: transparent;
    color: #a5b4fc; font-size: 11px; cursor: pointer;
    transition: background 0.1s;
}
.ep-add-btn:hover { background: rgba(99,102,241,0.1); }

/* 格式选择 */
.ep-fmt {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 0; border-top: 1px solid var(--border-color); margin-bottom: 10px;
}
.ep-fmt-label { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.ep-fmt-radio {
    display: flex; align-items: center; gap: 4px; font-size: 11px;
    color: var(--text-secondary); cursor: pointer;
}
.ep-fmt-hint { color: var(--text-muted); font-size: 10px; margin-left: 2px; }

/* 操作区 */
.ep-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ep-error { flex: 1; font-size: 11px; color: #fca5a5; }
.ep-submit { font-size: 12px; padding: 5px 14px; }
</style>
