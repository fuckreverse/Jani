<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">函数执行追踪</h2>
      <span class="section-badge">{{ fnExecTotal }} 个函数</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar-wrap">
      <div class="filter-bar-row">
        <!-- 左侧：搜索框 + 所有筛选条件 + 查询/重置（可换行） -->
        <div class="filter-bar-controls">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input
              v-model="fnExecSearch"
              placeholder="按函数名搜索..."
              class="search-input"
              @keyup.enter="loadFnExec(true)"
              @input="onSearchInput"
            />
            <button v-if="fnExecSearch" class="search-clear" @click="clearSearch" title="清空搜索">✕</button>
          </div>

          <!-- 调用次数 -->
          <label class="filter-label">
            调用≥
            <input
              v-model="fnExecMinCalls"
              type="number"
              min="1"
              style="width:52px"
              @keyup.enter="loadFnExec(true)"
              @input="debouncedSearch"
            />
          </label>

          <!-- 事件数范围 -->
          <label class="filter-label">
            事件数
            <input
              v-model="fnMinEvents"
              type="number"
              min="0"
              placeholder="最少"
              style="width:60px"
              title="每次调用自身事件数均值下限（不含子调用，近似值）"
              @keyup.enter="loadFnExec(true)"
              @input="debouncedSearch"
            />
            <span style="color:var(--text-muted);font-size:11px">~</span>
            <input
              v-model="fnMaxEvents"
              type="number"
              min="0"
              placeholder="最多"
              style="width:60px"
              title="每次调用自身事件数均值上限（不含子调用，近似值）"
              @keyup.enter="loadFnExec(true)"
              @input="debouncedSearch"
            />
          </label>

          <!-- 行号过滤 -->
          <label class="filter-label">
            行号
            <input
              v-model="fnLineFilter"
              type="number"
              min="1"
              placeholder="调用点行"
              style="width:66px"
              title="按调用点行号过滤（caller_line = N），可用于定位 (anonymous) 等函数"
              @keyup.enter="loadFnExec(true)"
              @input="debouncedSearch"
            />
          </label>

          <!-- 隐藏内建函数 toggle -->
          <label class="filter-label filter-toggle" :class="{ 'toggle-active': fnHideBuiltin }" @click="fnHideBuiltin = !fnHideBuiltin; loadFnExec(true)">
            <span class="toggle-dot"></span>
            隐藏内建
          </label>

          <button class="btn-primary" @click="loadFnExec(true)">查询</button>
          <button class="btn-secondary" @click="clearFnExecFilters">重置</button>

          <!-- 排序 -->
          <select v-model="fnSortBy" class="filter-select" @change="loadFnExec(true)" title="排序方式">
            <option value="call_count">调用次数↓</option>
            <option value="event_count">事件数↓</option>
          </select>
        </div>

        <!-- 右侧：火焰图按钮组（不参与换行，始终靠右） -->
        <div class="flame-btn-group" style="flex-shrink:0">
          <button
            class="btn-flame"
            :class="{ 'btn-flame-active': showFlameGraph }"
            :disabled="flameLoading"
            @click="toggleFlameGraph"
            title="内嵌火焰图（Canvas 渲染，可下钻缩放）"
          >
            <span v-if="flameLoading" class="spinner-tiny"></span>
            <span v-else>🔥</span>
            {{ showFlameGraph ? '隐藏火焰图' : '火焰图' }}
          </button>
          <button
            class="btn-flame-export"
            :disabled="flameLoading"
            @click="exportFlamegraph"
            title="导出 Speedscope JSON，拖入 speedscope.app 查看"
          >↗ 导出</button>
        </div>
      </div>
    </div>

    <!-- 内嵌火焰图面板 -->
    <div v-if="showFlameGraph" class="flame-panel">
      <div class="flame-toolbar">
        <span class="flame-info">
          <span v-if="flameData">{{ flameFrameCount }} 个函数 · {{ flameTotalTime }} 事件</span>
          <span v-if="flameZoomStack.length" class="flame-breadcrumb">
            <span class="flame-crumb" @click="flameResetZoom">全量</span>
            <template v-for="(crumb, i) in flameZoomStack" :key="i">
              <span class="flame-crumb-sep">›</span>
              <span class="flame-crumb" @click="flameZoomTo(i)">{{ crumb.name }}</span>
            </template>
          </span>
        </span>
        <button v-if="flameZoomStack.length" class="btn-secondary" style="padding:2px 10px;font-size:11px" @click="flameResetZoom">重置缩放</button>
      </div>
      <div v-if="flameLoading" class="loading" style="padding:24px"><div class="spinner"></div><span>生成火焰图...</span></div>
      <div v-else-if="flameError" class="empty-state" style="color:#f87171">{{ flameError }}</div>
      <div v-else-if="!flameData" class="empty-state">暂无数据，请先运行 F3 · CallGraphBuilder</div>
      <div v-else class="flame-canvas-wrap" ref="flameWrap">
        <canvas
          ref="flameCanvas"
          class="flame-canvas"
          @mousemove="onFlameMouseMove"
          @mouseleave="onFlameMouseLeave"
          @click="onFlameClick"
        ></canvas>
        <!-- Tooltip -->
        <div
          v-if="flameTooltip.visible"
          class="flame-tooltip"
          :style="{ left: flameTooltip.x + 'px', top: flameTooltip.y + 'px' }"
        >
          <div class="flame-tooltip-name">{{ flameTooltip.name }}</div>
          <div class="flame-tooltip-stats">
            自身 {{ flameTooltip.self }} · 总计 {{ flameTooltip.total }} 事件
            <span v-if="flameTooltip.pct"> · {{ flameTooltip.pct }}%</span>
          </div>
          <div class="flame-tooltip-hint">点击下钻</div>
        </div>
      </div>
    </div>

    <div v-if="fnExecLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="fnExecList.length === 0" class="empty-state">
      <p v-if="fnExecSearch">未找到匹配 "<strong>{{ fnExecSearch }}</strong>" 的函数</p>
      <p v-else-if="f3Status === 'done'">暂无函数数据（F3 已运行，但未找到调用记录。可尝试点击「🔄 重跑 Phase 2」按钮重新分析）</p>
      <p v-else-if="f3Status === 'running' || f3Status === 'pending'">F3 · CallGraphBuilder 正在分析中，请稍候...</p>
      <p v-else>暂无函数数据（需先运行 F3 · CallGraphBuilder，点击顶部「🔄 重跑 Phase 2」按钮）</p>
    </div>
    <div v-else>
      <!-- 函数列表 -->
      <div class="fn-list">
        <div
          v-for="fn in fnExecList"
          :key="fn.fn_name + (fn.fn_iid ?? '')"
          class="fn-item"
        >
          <!-- 一级：函数名行（可点击展开） -->
          <div class="fn-header" @click="toggleFnExpand(fn)">
            <span class="fn-expand-icon">{{ fnExpandedKey(fn) && expandedFns.has(fnExpandedKey(fn)) ? '▾' : '▸' }}</span>
            <code class="fn-name-text">{{ fn.fn_name || '(anonymous)' }}</code>
            <!-- 同名函数：显示位置标签以区分 -->
            <span v-if="isDuplicateName(fn)" class="fn-location-badge" :title="`iid=${fn.fn_iid}`">
              {{ fn.min_line ? `@line ${fn.min_line}` : `@iid ${fn.fn_iid}` }}
            </span>
            <span class="fn-call-badge">{{ fn.call_count }} 次调用</span>
            <span
              v-if="fn.avg_own_event_count != null || fn.event_count != null"
              class="fn-event-badge"
              :title="`均值 ${fn.avg_own_event_count ?? '?'} / 总量 ${fn.event_count ?? '?'}（自身事件，不含子调用）`"
            >≈{{ formatEventCount(fn.avg_own_event_count ?? fn.event_count) }} 事件/次</span>
            <span v-if="fn.min_line && !isDuplicateName(fn)" class="text-muted" style="font-size:11px">line {{ fn.min_line }}</span>
            <span v-if="fn.fn_iid && !isDuplicateName(fn)" class="text-muted" style="font-size:11px">iid={{ fn.fn_iid }}</span>
            <span class="text-muted" style="font-size:11px">深度 {{ fn.min_depth }}~{{ fn.max_depth }}</span>
          </div>

          <!-- 二级：展开区域（子面板切换：调用记录 / 被谁调用） -->
          <div v-if="expandedFns.has(fnExpandedKey(fn))" class="fn-calls-container">
            <!-- 子面板 Tab 栏 -->
            <div class="fn-subpanel-tabs">
              <button
                class="fn-subpanel-tab"
                :class="{ 'fn-subpanel-tab-active': (fnSubPanel[fnExpandedKey(fn)] || 'calls') === 'calls' }"
                @click.stop="switchSubPanel(fn, 'calls')"
              >📋 调用记录 <span v-if="fnCallsTotal[fnExpandedKey(fn)]" class="subpanel-cnt">{{ fnCallsTotal[fnExpandedKey(fn)] }}</span></button>
              <button
                class="fn-subpanel-tab"
                :class="{ 'fn-subpanel-tab-active': fnSubPanel[fnExpandedKey(fn)] === 'callers' }"
                @click.stop="switchSubPanel(fn, 'callers')"
                title="查看哪些函数调用了此函数（反向调用图）"
              >📤 被谁调用 <span v-if="fnCallersMap[fnExpandedKey(fn)]" class="subpanel-cnt">{{ fnCallersMap[fnExpandedKey(fn)].length }}</span></button>
            </div>

            <!-- 子面板：调用记录 -->
            <template v-if="(fnSubPanel[fnExpandedKey(fn)] || 'calls') === 'calls'">
              <div v-if="fnCallsLoading[fnExpandedKey(fn)]" class="loading" style="padding:10px">
                <div class="spinner"></div><span>加载调用记录...</span>
              </div>
              <div v-else-if="(fnCallsMap[fnExpandedKey(fn)] || []).length === 0" class="empty-state" style="padding:10px">
                暂无调用记录
              </div>
              <div v-else class="fn-calls-list">
                <div
                  v-for="call in fnCallsMap[fnExpandedKey(fn)]"
                  :key="call.id"
                  :id="`call-item-${call.id}`"
                  class="fn-call-item"
                  :class="{ 'call-highlighted': highlightedCallId === call.id }"
                >
                  <!-- 二级头：参数 + 返回值 -->
                  <div class="fn-call-header" @click="toggleCallExpand(call)">
                    <span class="fn-expand-icon">{{ expandedCalls.has(call.id) ? '▾' : '▸' }}</span>
                    <span class="text-muted" style="font-size:11px">SEQ {{ call.callSeq }}→{{ call.returnSeq }}</span>
                    <span class="text-muted" style="font-size:11px">depth={{ call.depth }}</span>
                    <!-- 参数 chips -->
                    <span class="fn-args-preview">
                      <span v-if="call.args?.length" class="filter-label" style="margin-left:8px">参数：</span>
                      <span
                        v-for="(arg, i) in (call.args || []).slice(0, 4)"
                        :key="i"
                        class="var-chip var-read var-chip-expandable"
                        title="点击查看完整参数值"
                        @click.stop="openValueViewer(arg.value !== undefined ? arg.value : arg, arg.name || ('arg'+i))"
                      >{{ arg.name || ('arg'+i) }}=<em style="color:#fcd34d">{{ truncate(formatArgValue(arg.value !== undefined ? arg.value : arg), 15) }}</em></span>
                      <span v-if="(call.args || []).length > 4" class="var-more">+{{ call.args.length - 4 }}</span>
                    </span>
                    <!-- 返回值 -->
                    <span v-if="call.returnValue !== null && call.returnValue !== undefined" class="fn-ret-preview">
                      <span class="filter-label" style="margin-left:8px">→</span>
                      <span
                        class="var-chip var-write var-chip-expandable"
                        title="点击查看完整返回值"
                        @click.stop="openValueViewer(call.returnValue, 'return')"
                      >{{ truncate(formatArgValue(call.returnValue), 20) }}</span>
                    </span>
                  </div>

                  <!-- 三级：子面板切换（调用栈 / 事件流）→ CallDetail 组件 -->
                  <CallDetail
                    v-if="expandedCalls.has(call.id)"
                    :session-id="sessionId"
                    :call="call"
                    :initial-view="callView[call.id] || 'events'"
                    @update:child-count="callChildCount[call.id] = $event"
                    @open-dataflow="$emit('open-dataflow', $event)"
                  />

                </div>

                <!-- 调用记录分页（上一页/下一页） -->
                <div v-if="fnCallsTotal[fnExpandedKey(fn)] > FN_CALLS_PAGE" class="calls-pagination">
                  <span class="page-info">
                    第 {{ fnCallsPage[fnExpandedKey(fn)] || 1 }} /
                    {{ Math.ceil(fnCallsTotal[fnExpandedKey(fn)] / FN_CALLS_PAGE) }} 页
                    · 共 {{ fnCallsTotal[fnExpandedKey(fn)] }} 条
                  </span>
                  <div class="page-nav">
                    <button
                      class="btn-secondary btn-page"
                      :disabled="(fnCallsPage[fnExpandedKey(fn)] || 1) <= 1"
                      @click="prevCallsPage(fn)"
                    >‹ 上一页</button>
                    <button
                      class="btn-secondary btn-page"
                      :disabled="(fnCallsPage[fnExpandedKey(fn)] || 1) >= Math.ceil(fnCallsTotal[fnExpandedKey(fn)] / FN_CALLS_PAGE)"
                      @click="nextCallsPage(fn)"
                    >下一页 ›</button>
                  </div>
                </div>
              </div>
            </template>

            <!-- 子面板：被谁调用（反向调用图） -->
            <template v-if="fnSubPanel[fnExpandedKey(fn)] === 'callers'">
              <div v-if="fnCallersLoading[fnExpandedKey(fn)]" class="loading" style="padding:10px">
                <div class="spinner"></div><span>加载调用者...</span>
              </div>
              <div v-else-if="(fnCallersMap[fnExpandedKey(fn)] || []).length === 0" class="empty-state" style="padding:10px">
                暂无调用者（该函数未被其他函数调用，或为顶层调用）
              </div>
              <div v-else class="fn-callers-list">
                <!-- 总计提示 -->
                <div class="callers-summary">
                  共 <strong>{{ fnCallersTotalCalls[fnExpandedKey(fn)] || 0 }}</strong> 次调用来自
                  <strong>{{ (fnCallersMap[fnExpandedKey(fn)] || []).length }}</strong> 个调用者
                </div>
                <div
                  v-for="caller in fnCallersMap[fnExpandedKey(fn)]"
                  :key="caller.callerFnName + (caller.callerFnIid ?? '')"
                  class="caller-item"
                  :title="caller.callerFnName === '(top-level)' ? '顶层代码直接调用' : `点击跳转到 ${caller.callerFnName}`"
                  :class="{ 'caller-item-clickable': caller.callerFnName !== '(top-level)' }"
                  @click="caller.callerFnName !== '(top-level)' && gotoCallerFn(caller)"
                >
                  <span class="caller-icon">{{ caller.callerFnName === '(top-level)' ? '🌐' : '📌' }}</span>
                  <code class="caller-fn-name">{{ caller.callerFnName }}</code>
                  <span v-if="caller.callerMinLine" class="caller-line text-muted">line {{ caller.callerMinLine }}</span>
                  <span class="caller-count-badge">{{ caller.callCount }} 次</span>
                  <!-- 调用占比 -->
                  <span
                    v-if="fnCallersTotalCalls[fnExpandedKey(fn)]"
                    class="caller-pct text-muted"
                  >{{ Math.round(caller.callCount / fnCallersTotalCalls[fnExpandedKey(fn)] * 100) }}%</span>
                  <!-- 被调用的代码位置（callee_min_line 是目标函数被调用处的行号，通常就是 caller_line） -->
                  <span v-if="caller.calleeMinLine && caller.callerFnName !== '(top-level)'" class="caller-at text-muted" style="font-size:10px">at line {{ caller.calleeMinLine }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 函数列表分页 -->
      <div v-if="fnExecTotal > 0" class="pagination">
        <div class="page-summary">共 {{ fnExecTotal }} 个 · 每页 {{ FN_EXEC_PAGE }}</div>

        <div class="page-controls">
          <button
            class="btn-page btn-secondary"
            :disabled="fnExecPage <= 1"
            @click="gotoFnPage(1)"
            title="第一页"
          >«</button>
          <button
            class="btn-page btn-secondary"
            :disabled="fnExecPage <= 1"
            @click="gotoFnPage(fnExecPage - 1)"
          >‹ 上一页</button>

          <template v-for="p in visiblePages" :key="'pg-' + p">
            <span v-if="p === '...'" class="page-ellipsis">…</span>
            <button
              v-else
              class="btn-page"
              :class="p === fnExecPage ? 'btn-page-active' : 'btn-secondary'"
              @click="gotoFnPage(p)"
            >{{ p }}</button>
          </template>

          <button
            class="btn-page btn-secondary"
            :disabled="fnExecPage >= fnExecTotalPages"
            @click="gotoFnPage(fnExecPage + 1)"
          >下一页 ›</button>
          <button
            class="btn-page btn-secondary"
            :disabled="fnExecPage >= fnExecTotalPages"
            @click="gotoFnPage(fnExecTotalPages)"
            title="最后一页"
          >»</button>
        </div>

        <!-- 跳转到某页 -->
        <div class="page-jump">
          <span class="page-jump-label">跳转到</span>
          <input
            v-model.number="jumpPage"
            type="number"
            :min="1"
            :max="fnExecTotalPages"
            class="page-jump-input"
            @keyup.enter="doJumpPage"
          />
          <span class="page-jump-label">页</span>
          <button class="btn-page btn-secondary" @click="doJumpPage">GO</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue';
import { truncate, formatValue, formatArgValue } from '../../composables/useSessionUtils.js';
import { openValueViewer } from '../../composables/useValueViewer.js';
import CallDetail from './CallDetail.vue';

// ─── 火焰图颜色方案（warm palette）──────────────────────────────────────────
const FLAME_COLORS = [
    '#e2533a','#e07642','#d9954a','#d4b44a','#a8c84a',
    '#5cb85c','#3aada8','#3a8de2','#6a5ce2','#a64de2',
];
function flameColor(name, depth) {
    let h = depth * 7;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
    return FLAME_COLORS[h % FLAME_COLORS.length];
}

const props = defineProps({
    sessionId:    { type: String,  required: true },
    pluginStatus: { type: Object,  default: () => ({}) },
    targetCall:   { type: Object,  default: null },  // { fnName, fnIid, callSeq } — 来自事件流跳转
});

// open-dataflow: 从函数/调用面板跳转到数据流图（由 CallDetail 冒泡）
const emit = defineEmits(['open-dataflow']);

const f3Status = computed(() => props.pluginStatus?.['F3-CallGraphBuilder'] ?? '');

const fnExecList     = ref([]);
const fnExecTotal    = ref(0);

// 检测当前页中是否有同名函数（用于展示位置区分标签）
const duplicateNames = computed(() => {
    const seen = new Set();
    const dupes = new Set();
    for (const fn of fnExecList.value) {
        const name = fn.fn_name || '(anonymous)';
        if (seen.has(name)) dupes.add(name);
        else seen.add(name);
    }
    return dupes;
});

function isDuplicateName(fn) {
    return duplicateNames.value.has(fn.fn_name || '(anonymous)');
}
const fnExecLoading  = ref(false);
const fnExecSearch   = ref('');
const fnExecMinCalls = ref(1);
const fnMinEvents    = ref('');    // 函数体事件数下限（空=不过滤）
const fnMaxEvents    = ref('');    // 函数体事件数上限（空=不过滤）
const fnHideBuiltin  = ref(true);  // 默认开：隐藏内建函数
const fnSortBy       = ref('call_count');  // 'call_count' | 'event_count'
const fnLineFilter   = ref('');    // 调用点行号过滤（空=不过滤）
const fnExecPage     = ref(1);
const FN_EXEC_PAGE   = 50;

/** 格式化事件量：超过 1000 显示 1.2k */
function formatEventCount(n) {
    if (n == null) return '?';
    if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
    if (n >= 1000)  return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// 统一防抖（400ms）：所有筛选输入框变化时调用
let _debounceTimer = null;
function debouncedSearch() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => loadFnExec(true), 400);
}

// 搜索框专用（同一防抖，保持向后兼容）
function onSearchInput() {
    debouncedSearch();
}

function clearSearch() {
    fnExecSearch.value = '';
    loadFnExec(true);
}

// 总页数
const fnExecTotalPages = computed(() => Math.max(1, Math.ceil(fnExecTotal.value / FN_EXEC_PAGE)));

// 页码列表（智能省略）
const visiblePages = computed(() => {
    const total = fnExecTotalPages.value;
    const cur   = fnExecPage.value;
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }
    if (cur <= 4) {
        return [1, 2, 3, 4, 5, '...', total];
    }
    if (cur >= total - 3) {
        return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
    }
    return [1, '...', cur - 1, cur, cur + 1, '...', total];
});

const jumpPage = ref(1);

function doJumpPage() {
    const p = Math.max(1, Math.min(fnExecTotalPages.value, Math.round(jumpPage.value) || 1));
    gotoFnPage(p);
}

const expandedFns   = reactive(new Set());
const expandedCalls = reactive(new Set());

const fnCallsMap     = reactive({});
const fnCallsTotal   = reactive({});
const fnCallsPage    = reactive({});
const fnCallsLoading = reactive({});
const FN_CALLS_PAGE  = 30;

const callChildCount    = reactive({});  // call.id → 直接子调用数量（由 CallDetail 子组件更新）
const callView          = reactive({});  // call.id → 'stack' | 'events'（传给 CallDetail 的 initialView）

// 跨 Tab 跳转高亮：记录当前高亮的调用记录 id
const highlightedCallId = ref(null);

function fnExpandedKey(fn) {
    return `${fn.fn_name}__${fn.fn_iid ?? ''}`;
}

async function loadFnExec(reset = false) {
    if (reset) {
        fnExecPage.value = 1;
        jumpPage.value   = 1;
        expandedFns.clear();
        expandedCalls.clear();
    }
    fnExecLoading.value = true;
    try {
        const offset = (fnExecPage.value - 1) * FN_EXEC_PAGE;
        const params = new URLSearchParams({
            limit:    FN_EXEC_PAGE,
            offset,
            minCalls: fnExecMinCalls.value || 1,
            sortBy:   fnSortBy.value,
        });
        if (fnExecSearch.value.trim())  params.set('search',      fnExecSearch.value.trim());
        if (fnHideBuiltin.value)        params.set('hideBuiltin',  '1');
        if (fnMinEvents.value !== '')   params.set('minEvents',    fnMinEvents.value);
        if (fnMaxEvents.value !== '')   params.set('maxEvents',    fnMaxEvents.value);
        if (fnLineFilter.value !== '')  params.set('line',         fnLineFilter.value);
        const res = await fetch(`/api/sessions/${props.sessionId}/functions?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnExecList.value  = data.functions || [];
        fnExecTotal.value = data.total ?? (data.functions?.length ?? 0);
    } catch (e) {
        console.error('loadFnExec error:', e);
    } finally {
        fnExecLoading.value = false;
    }
}

function clearFnExecFilters() {
    fnExecSearch.value   = '';
    fnExecMinCalls.value = 1;
    fnMinEvents.value    = '';
    fnMaxEvents.value    = '';
    fnHideBuiltin.value  = true;  // 重置保持默认开启
    fnSortBy.value       = 'call_count';
    fnLineFilter.value   = '';
    loadFnExec(true);
}

async function gotoFnPage(page) {
    const p = Math.max(1, Math.min(fnExecTotalPages.value, page));
    if (p === fnExecPage.value) return;
    fnExecPage.value = p;
    jumpPage.value   = p;
    expandedFns.clear();
    expandedCalls.clear();
    await loadFnExec(false);
}

async function toggleFnExpand(fn) {
    const key = fnExpandedKey(fn);
    if (expandedFns.has(key)) {
        expandedFns.delete(key);
        return;
    }
    expandedFns.add(key);
    if (!fnCallsMap[key]) {
        await loadFnCalls(fn, true);
    }
}

// targetCallSeq：可选，传入后后端自动计算所在页并返回 targetCallId
// overrideFnIid：可选，覆盖 fn.fn_iid（用于跨 Tab 跳转时精确匹配 owner-fn 返回的 iid）
async function loadFnCalls(fn, reset = false, targetCallSeq = null, overrideFnIid = undefined) {
    const key = fnExpandedKey(fn);
    if (reset) fnCallsPage[key] = 1;
    fnCallsLoading[key] = true;
    try {
        const params = new URLSearchParams({ limit: FN_CALLS_PAGE });
        // 传 fn_iid 确保只查该函数定义处的调用，避免同名函数混在一起
        // overrideFnIid 优先（跨 Tab 跳转时用 owner-fn 返回的精确 iid）
        const fnIidToUse = overrideFnIid !== undefined ? overrideFnIid : fn.fn_iid;
        if (fnIidToUse != null) params.set('fnIid', fnIidToUse);
        // 有目标 callSeq 时让后端定位到正确页，忽略本地 page 状态
        if (targetCallSeq != null) {
            params.set('callSeq', targetCallSeq);
        } else {
            const page   = fnCallsPage[key] || 1;
            const offset = (page - 1) * FN_CALLS_PAGE;
            params.set('offset', offset);
        }
        const res = await fetch(
            `/api/sessions/${props.sessionId}/functions/${encodeURIComponent(fn.fn_name)}/calls?${params}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnCallsMap[key]   = data.calls || [];
        fnCallsTotal[key] = data.total ?? (data.calls?.length ?? 0);
        // 根据后端返回的 offset 同步本地页码
        if (data.offset != null) {
            fnCallsPage[key] = Math.floor(data.offset / FN_CALLS_PAGE) + 1;
        }
        // 调试：打印后端返回的定位信息
        console.debug('[loadFnCalls] targetCallId=', data.targetCallId, 'offset=', data.offset, 'total=', data.total, 'calls[0]=', data.calls?.[0]);
        // 返回后端定位到的目标 call id
        return data.targetCallId ?? null;
    } catch (e) {
        console.error('loadFnCalls error:', e);
        return null;
    } finally {
        fnCallsLoading[key] = false;
    }
}

async function prevCallsPage(fn) {
    const key  = fnExpandedKey(fn);
    const page = fnCallsPage[key] || 1;
    if (page <= 1) return;
    fnCallsPage[key] = page - 1;
    await loadFnCalls(fn, false);
}

async function nextCallsPage(fn) {
    const key     = fnExpandedKey(fn);
    const page    = fnCallsPage[key] || 1;
    const maxPage = Math.ceil((fnCallsTotal[key] || 0) / FN_CALLS_PAGE);
    if (page >= maxPage) return;
    fnCallsPage[key] = page + 1;
    await loadFnCalls(fn, false);
}

// ─── 反向调用图（被谁调用）─────────────────────────────────────────────────

// fnSubPanel[key]: 'calls'（默认）| 'callers'
const fnSubPanel        = reactive({});
// fnCallersMap[key]: 调用者列表
const fnCallersMap      = reactive({});
// fnCallersLoading[key]: 是否加载中
const fnCallersLoading  = reactive({});
// fnCallersTotalCalls[key]: 目标函数被调用的总次数（用于计算百分比）
const fnCallersTotalCalls = reactive({});

/** 切换子面板（调用记录 / 被谁调用），并在首次切换到 callers 时懒加载 */
async function switchSubPanel(fn, panel) {
    const key = fnExpandedKey(fn);
    fnSubPanel[key] = panel;
    if (panel === 'callers' && fnCallersMap[key] === undefined) {
        await loadFnCallers(fn);
    }
}

/** 加载调用了 fn 的调用者列表（反向调用图） */
async function loadFnCallers(fn) {
    const key = fnExpandedKey(fn);
    fnCallersLoading[key] = true;
    try {
        const params = new URLSearchParams({ limit: 200 });
        if (fn.fn_iid != null) params.set('fnIid', fn.fn_iid);
        const res = await fetch(
            `/api/sessions/${props.sessionId}/functions/${encodeURIComponent(fn.fn_name)}/callers?${params}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnCallersMap[key]      = data.callers || [];
        fnCallersTotalCalls[key] = data.totalCalls ?? 0;
    } catch (e) {
        console.error('loadFnCallers error:', e);
        fnCallersMap[key] = [];
        fnCallersTotalCalls[key] = 0;
    } finally {
        fnCallersLoading[key] = false;
    }
}

/**
 * 点击"被谁调用"列表中的某个调用者 → 在函数面板内跳转并展开该调用者函数
 * 先用调用者函数名搜索，然后展开第一条匹配的函数记录并加载其调用列表
 */
async function gotoCallerFn(caller) {
    if (!caller.callerFnName || caller.callerFnName === '(top-level)') return;

    // 1. 重置搜索条件，以调用者函数名精确搜索
    fnExecSearch.value   = caller.callerFnName;
    fnExecPage.value     = 1;
    fnExecLoading.value  = true;
    let fn = null;
    try {
        const params = new URLSearchParams({
            limit:       FN_EXEC_PAGE,
            offset:      0,
            minCalls:    1,
            search:      caller.callerFnName,
            hideBuiltin: '0',
        });
        if (caller.callerFnIid != null) params.set('fnIid', String(caller.callerFnIid));
        const res = await fetch(`/api/sessions/${props.sessionId}/functions?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnExecList.value  = data.functions || [];
        fnExecTotal.value = data.total ?? (data.functions?.length ?? 0);
        fn = fnExecList.value.find(f => f.fn_name === caller.callerFnName)
          ?? fnExecList.value[0]
          ?? null;
    } catch (e) {
        console.error('gotoCallerFn: loadFnExec error:', e);
    } finally {
        fnExecLoading.value = false;
    }

    if (!fn) return;

    // 2. 展开目标函数，加载调用记录，切换到"调用记录"子面板
    const key = fnExpandedKey(fn);
    delete fnCallsMap[key];
    delete fnCallsTotal[key];
    delete fnCallsPage[key];
    fnSubPanel[key] = 'calls';
    expandedFns.add(key);
    await loadFnCalls(fn, true);

    // 3. 滚动到该函数
    await nextTick();
    const el = document.querySelector(`.fn-item [data-fn-key="${key}"]`)
             ?? document.querySelector('.fn-header');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 展开/收起调用记录（三级 CallDetail 面板）
function toggleCallExpand(call) {
    if (expandedCalls.has(call.id)) {
        expandedCalls.delete(call.id);
        return;
    }
    expandedCalls.add(call.id);
    // 默认初始面板为事件流（传给 CallDetail initialView）
    if (!callView[call.id]) callView[call.id] = 'events';
}

// 监听跨 Tab 导航：事件流跳转过来时自动搜索并展开对应函数和调用记录
watch(() => props.targetCall, async (tc) => {
    if (!tc) return;
    highlightedCallId.value = null;

    // 1. 用精确函数名搜索（精确匹配，确保第一页就能找到）
    fnExecSearch.value = tc.fnName || '';
    fnExecPage.value   = 1;
    fnExecLoading.value = true;
    let fn = null;
    try {
        const params = new URLSearchParams({
            limit:    FN_EXEC_PAGE,
            offset:   0,
            minCalls: 1,
            search:   tc.fnName || '',
            // 跨 Tab 跳转时不过滤内建函数，确保目标函数一定能找到
            hideBuiltin: '0',
        });
        // 传入精确 fnIid，确保同名函数时只返回目标函数条目
        if (tc.fnIid != null) params.set('fnIid', String(tc.fnIid));
        const res = await fetch(`/api/sessions/${props.sessionId}/functions?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnExecList.value  = data.functions || [];
        fnExecTotal.value = data.total ?? (data.functions?.length ?? 0);
        fn = fnExecList.value.find(f => f.fn_name === tc.fnName)
          ?? fnExecList.value[0]  // fnIid 过滤后通常只有一条
          ?? null;
    } catch (e) {
        console.error('targetCall: loadFnExec error:', e);
    } finally {
        fnExecLoading.value = false;
    }

    if (!fn) {
        console.warn('targetCall: function not found:', tc.fnName);
        return;
    }

    // 2. 展开函数，并用 callSeq 让后端定位到正确页
    const key = fnExpandedKey(fn);
    // 清除旧数据，确保重新加载
    delete fnCallsMap[key];
    delete fnCallsTotal[key];
    delete fnCallsPage[key];
    expandedFns.add(key);

    // 传入 tc.fnIid 作为精确 iid 过滤，避免同名函数 iid 不匹配导致找不到目标调用
    const targetCallId = await loadFnCalls(fn, true, tc.callSeq, tc.fnIid);
    await nextTick();

    // 3. 找到目标调用记录（优先用后端返回的 id，备用前端按 callSeq 匹配）
    const calls = fnCallsMap[key] || [];
    const call = targetCallId != null
        ? calls.find(c => c.id === targetCallId)
        : calls.find(c => c.callSeq === tc.callSeq);

    if (!call) {
        console.warn('targetCall: call not found in page, targetCallId=', targetCallId, 'callSeq=', tc.callSeq, 'tc=', JSON.stringify(tc), 'calls=', JSON.stringify(calls));
        return;
    }

    // 4. 高亮该调用 + 展开事件流面板（CallDetail 会自动加载）
    highlightedCallId.value = call.id;
    expandedCalls.add(call.id);
    callView[call.id] = 'events';

    // 5. 滚动到目标行
    await nextTick();
    const el = document.getElementById(`call-item-${call.id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ─── 火焰图状态 ────────────────────────────────────────────────────────────
const showFlameGraph = ref(false);
const flameLoading   = ref(false);
const flameError     = ref('');
const flameData      = ref(null);   // 原始 Speedscope JSON
const flameCanvas    = ref(null);
const flameWrap      = ref(null);

// 从 Speedscope JSON 解析出的扁平帧列表：[{ name, depth, start, end, selfTime, totalTime }]
// start/end 用的是 SEQ 空间（call_seq / return_seq）
const flameNodes     = ref([]);

// 下钻缩放栈：每个元素 { name, node } 代表当前 zoom 到的节点
const flameZoomStack = ref([]);

const flameTooltip = reactive({ visible: false, x: 0, y: 0, name: '', self: 0, total: 0, pct: '' });

// 当前渲染区域的 SEQ 范围（由缩放状态决定）
const flameViewStart = ref(0);
const flameViewEnd   = ref(0);

const FLAME_ROW_H   = 20;   // 每行高度（像素）
const FLAME_MIN_W   = 2;    // 低于此宽度的节点跳过渲染
const FLAME_FONT_SZ = 11;

// ── 统计信息（展示用）──────────────────────────────────────────────────────
const flameFrameCount = computed(() => {
    if (!flameData.value) return 0;
    return flameData.value.shared?.frames?.length ?? 0;
});
const flameTotalTime = computed(() => {
    if (!flameNodes.value.length) return 0;
    // 深度 0 的所有节点 totalTime 之和
    return flameNodes.value.filter(n => n.depth === 0).reduce((s, n) => s + n.totalTime, 0);
});

// ── 从 Speedscope JSON 解析扁平节点树 ─────────────────────────────────────
// O(N) 算法：利用栈在 OPEN/CLOSE 配对时直接累计 childTime，避免 O(N²) 嵌套过滤。
function parseFlameNodes(speedscope) {
    const frames = speedscope.shared?.frames ?? [];
    const profile = speedscope.profiles?.[0];
    if (!profile) return [];

    // Speedscope evented profile events: [{type:'O'|'C', frame, at}]
    const events = profile.events ?? [];
    if (!events.length) return [];

    // 栈元素：{ frameIdx, depth, startAt, childTime }
    // childTime 累计直接子节点的 totalTime，用于计算 selfTime
    const stack = [];
    const nodes = [];

    for (const ev of events) {
        if (ev.type === 'O') {
            stack.push({ frameIdx: ev.frame, depth: stack.length, startAt: ev.at, childTime: 0 });
        } else if (ev.type === 'C') {
            if (!stack.length) continue;
            const top       = stack.pop();
            const frame     = frames[top.frameIdx] ?? {};
            const totalTime = ev.at - top.startAt;
            const selfTime  = Math.max(0, totalTime - top.childTime);

            nodes.push({
                name:      frame.name ?? '(unknown)',
                depth:     top.depth,
                start:     top.startAt,
                end:       ev.at,
                totalTime,
                selfTime,
            });

            // 将本节点的 totalTime 累加到父节点的 childTime 上
            if (stack.length > 0) {
                stack[stack.length - 1].childTime += totalTime;
            }
        }
    }

    return nodes;
}

// ── Canvas 渲染 ─────────────────────────────────────────────────────────────
function renderFlame() {
    const canvas = flameCanvas.value;
    if (!canvas) return;
    const nodes = flameNodes.value;
    if (!nodes.length) return;

    const wrap = flameWrap.value;
    const W = wrap ? wrap.clientWidth || 800 : 800;

    // 求最大深度
    const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    const H = (maxDepth + 1) * FLAME_ROW_H;

    // 设置 canvas 尺寸（devicePixelRatio 适配）
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${FLAME_FONT_SZ}px monospace`;

    const viewStart = flameViewStart.value;
    const viewEnd   = flameViewEnd.value;
    const viewSpan  = viewEnd - viewStart || 1;

    // 只渲染在当前视口内的节点
    for (const n of nodes) {
        if (n.end < viewStart || n.start > viewEnd) continue;

        const x = Math.max(0, (n.start - viewStart) / viewSpan * W);
        const x2 = Math.min(W, (n.end - viewStart) / viewSpan * W);
        const w = x2 - x;
        if (w < FLAME_MIN_W) continue;

        const y = n.depth * FLAME_ROW_H;

        ctx.fillStyle = flameColor(n.name, n.depth);
        ctx.fillRect(x, y, w - 1, FLAME_ROW_H - 1);

        // 文字（宽度够时才渲染）
        if (w > 30) {
            ctx.fillStyle = '#fff';
            ctx.save();
            ctx.rect(x, y, w - 1, FLAME_ROW_H);
            ctx.clip();
            const label = n.name || '(anonymous)';
            ctx.fillText(label, x + 3, y + FLAME_ROW_H - 5);
            ctx.restore();
        }
    }
}

// ── 命中检测（鼠标位置 → 节点）─────────────────────────────────────────────
function hitTestFlame(mx, my) {
    const canvas = flameCanvas.value;
    if (!canvas) return null;
    const nodes    = flameNodes.value;
    const W        = canvas.clientWidth || 800;
    const viewStart = flameViewStart.value;
    const viewEnd   = flameViewEnd.value;
    const viewSpan  = viewEnd - viewStart || 1;

    const depth = Math.floor(my / FLAME_ROW_H);
    // 从后往前（最上层优先）
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.depth !== depth) continue;
        if (n.end < viewStart || n.start > viewEnd) continue;
        const x  = (n.start - viewStart) / viewSpan * W;
        const x2 = (n.end   - viewStart) / viewSpan * W;
        if (mx >= x && mx <= x2) return n;
    }
    return null;
}

// ── 鼠标事件 ────────────────────────────────────────────────────────────────
function onFlameMouseMove(e) {
    const rect = flameCanvas.value?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = hitTestFlame(mx, my);
    if (node) {
        const root = flameTotalTime.value || 1;
        flameTooltip.visible = true;
        flameTooltip.x = mx + 12;
        flameTooltip.y = my + 8;
        flameTooltip.name  = node.name || '(anonymous)';
        flameTooltip.self  = node.selfTime;
        flameTooltip.total = node.totalTime;
        flameTooltip.pct   = (node.totalTime / root * 100).toFixed(1);
        flameCanvas.value.style.cursor = 'pointer';
    } else {
        flameTooltip.visible = false;
        flameCanvas.value.style.cursor = 'default';
    }
}
function onFlameMouseLeave() {
    flameTooltip.visible = false;
}
function onFlameClick(e) {
    const rect = flameCanvas.value?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = hitTestFlame(mx, my);
    if (!node) return;

    // 下钻：以当前节点的 SEQ 范围为新视口
    flameZoomStack.value.push({ name: node.name, start: flameViewStart.value, end: flameViewEnd.value });
    flameViewStart.value = node.start;
    flameViewEnd.value   = node.end;
    flameTooltip.visible = false;
    nextTick(() => renderFlame());
}
function flameResetZoom() {
    if (!flameNodes.value.length) return;
    flameZoomStack.value = [];
    let vStart = Infinity, vEnd = -Infinity;
    for (const n of flameNodes.value) {
        if (n.start < vStart) vStart = n.start;
        if (n.end   > vEnd)   vEnd   = n.end;
    }
    flameViewStart.value = vStart;
    flameViewEnd.value   = vEnd;
    flameTooltip.visible = false;
    nextTick(() => renderFlame());
}
function flameZoomTo(stackIdx) {
    // 回退到历史某一层
    const entry = flameZoomStack.value[stackIdx];
    flameZoomStack.value = flameZoomStack.value.slice(0, stackIdx);
    flameViewStart.value = entry.start;
    flameViewEnd.value   = entry.end;
    flameTooltip.visible = false;
    nextTick(() => renderFlame());
}

// ── 加载火焰图数据并渲染 ────────────────────────────────────────────────────
async function loadAndRenderFlame() {
    flameLoading.value = true;
    flameError.value   = '';
    flameData.value    = null;
    flameNodes.value   = [];
    flameZoomStack.value = [];
    flameTooltip.visible = false;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/flamegraph?maxDepth=50`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        flameData.value  = data;
        const nodes = parseFlameNodes(data);
        flameNodes.value = nodes;
        if (nodes.length) {
            // 避免 spread 大数组导致栈溢出，用 reduce
            let vStart = Infinity, vEnd = -Infinity;
            for (const n of nodes) {
                if (n.start < vStart) vStart = n.start;
                if (n.end   > vEnd)   vEnd   = n.end;
            }
            flameViewStart.value = vStart;
            flameViewEnd.value   = vEnd;
        }
        await nextTick();
        renderFlame();
    } catch (e) {
        flameError.value = `加载失败：${e.message}`;
    } finally {
        flameLoading.value = false;
    }
}

// ── 切换显示 ────────────────────────────────────────────────────────────────
async function toggleFlameGraph() {
    showFlameGraph.value = !showFlameGraph.value;
    if (showFlameGraph.value && !flameData.value) {
        await loadAndRenderFlame();
    } else if (showFlameGraph.value) {
        await nextTick();
        renderFlame();
    }
}

// ── 方案 D：导出 Speedscope JSON ──────────────────────────────────────────
async function exportFlamegraph() {
    flameLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/flamegraph?maxDepth=50`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data  = await res.json();
        const blob  = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url   = URL.createObjectURL(blob);
        const a     = document.createElement('a');
        a.href      = url;
        a.download  = `flamegraph-${props.sessionId.slice(0, 8)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        // 同时打开 speedscope（用户自行拖入）
        window.open('https://www.speedscope.app', '_blank', 'noopener');
    } catch (e) {
        alert(`导出失败：${e.message}`);
    } finally {
        flameLoading.value = false;
    }
}

defineExpose({ reload: () => loadFnExec(true) });

onMounted(() => loadFnExec(true));
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar-wrap { margin-bottom: 14px; }
.filter-bar-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: nowrap;   /* 外层不换行，左右两个区块各自处理 */
}
.filter-bar-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;     /* 内层筛选条件可以换行 */
    flex: 1;
    min-width: 0;
}
/* 兼容旧引用 */
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.text-muted { color: var(--text-muted); }

/* 搜索框 */
.search-box {
    position: relative;
    display: flex;
    align-items: center;
}
.search-icon {
    position: absolute;
    left: 8px;
    font-size: 13px;
    pointer-events: none;
    opacity: 0.6;
}
.search-input {
    width: 220px;
    padding-left: 28px !important;
    padding-right: 26px;
}
.search-clear {
    position: absolute;
    right: 6px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    line-height: 1;
    opacity: 0.7;
    transition: opacity 0.12s;
}
.search-clear:hover { opacity: 1; color: var(--danger, #f87171); }

/* ── 分页 ────────────────────────────────────────────────────────────── */
.pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-color);
    flex-wrap: wrap;
}
.calls-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color);
}
.page-summary { font-size: 12px; color: var(--text-muted); flex-shrink: 0; white-space: nowrap; }
.page-info    { font-size: 12px; color: var(--text-muted); white-space: nowrap; }

.page-controls {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-wrap: wrap;
    justify-content: center;
}
.page-nav {
    display: flex;
    gap: 4px;
}

/* 通用页码按钮 */
.btn-page {
    min-width: 32px;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    border-radius: 4px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    line-height: 1;
    white-space: nowrap;
}
.btn-page:hover:not(:disabled) {
    background: var(--bg-tertiary);
    border-color: rgba(99,102,241,0.45);
}
.btn-page:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}
.btn-page-active {
    background: rgba(99,102,241,0.2) !important;
    border-color: rgba(99,102,241,0.6) !important;
    color: #a5b4fc !important;
    font-weight: 600;
    cursor: default;
}
.page-ellipsis {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 28px;
    font-size: 12px;
    color: var(--text-muted);
}

/* 跳转输入 */
.page-jump {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
}
.page-jump-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.page-jump-input {
    width: 50px;
    height: 28px;
    padding: 0 6px;
    font-size: 12px;
    text-align: center;
    border-radius: 4px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
}
.page-jump-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }

/* ── 函数列表 ─────────────────────────────────────────────────────────── */
.fn-list { display: flex; flex-direction: column; gap: 4px; }
.fn-item { border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; background: var(--bg-secondary); }
.fn-header {
    display: flex; align-items: center; gap: 10px; padding: 8px 14px;
    cursor: pointer; transition: background 0.12s; flex-wrap: wrap;
}
.fn-header:hover { background: var(--bg-tertiary); }
.fn-expand-icon { font-size: 10px; color: var(--text-muted); flex-shrink: 0; width: 12px; }
.fn-name-text { font-size: 13px; font-family: monospace; color: #a5b4fc; font-weight: 600; flex-shrink: 0; }
.fn-call-badge {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600; flex-shrink: 0;
}
.fn-event-badge {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    background: rgba(34,197,94,0.10); color: #86efac; font-size: 11px; font-weight: 500; flex-shrink: 0;
    border: 1px solid rgba(34,197,94,0.18);
}

/* ── 筛选控件 ──────────────────────────────────────────────────────────── */
.filter-select {
    font-size: 12px; padding: 4px 8px; border-radius: 6px; height: 30px;
    border: 1px solid var(--border-color); background: var(--bg-secondary);
    color: var(--text-primary); cursor: pointer;
}
.filter-select:focus { outline: none; border-color: rgba(99,102,241,0.5); }

/* 隐藏 number input 的上下调整箭头（spinner） */
.filter-bar input[type=number]::-webkit-inner-spin-button,
.filter-bar input[type=number]::-webkit-outer-spin-button,
.filter-bar-controls input[type=number]::-webkit-inner-spin-button,
.filter-bar-controls input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.filter-bar input[type=number],
.filter-bar-controls input[type=number] { -moz-appearance: textfield; }

/* 内建函数 toggle 按钮 */
.filter-toggle {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); user-select: none;
    transition: background 0.15s, border-color 0.15s; font-size: 12px;
}
.filter-toggle:hover { border-color: rgba(99,102,241,0.4); background: var(--bg-tertiary); }
.filter-toggle.toggle-active {
    background: rgba(99,102,241,0.12);
    border-color: rgba(99,102,241,0.45);
    color: #a5b4fc;
}
.toggle-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: var(--text-muted); transition: background 0.15s;
}
.filter-toggle.toggle-active .toggle-dot { background: #a5b4fc; }
.fn-location-badge {
    display: inline-block; padding: 1px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.15); color: #fcd34d;
    font-size: 11px; font-family: monospace; flex-shrink: 0;
    border: 1px solid rgba(245,158,11,0.25);
}

/* 二级：调用容器 */
.fn-calls-container { border-top: 1px solid var(--border-color); background: var(--bg-primary, #0f1117); }

/* 子面板 Tab 栏 */
.fn-subpanel-tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border-color);
}
.fn-subpanel-tab {
    padding: 4px 14px; font-size: 11px; background: transparent;
    border: none; border-right: 1px solid var(--border-color);
    color: var(--text-muted); cursor: pointer; transition: background 0.1s, color 0.1s;
    white-space: nowrap;
}
.fn-subpanel-tab:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.fn-subpanel-tab-active {
    background: rgba(99,102,241,0.10) !important;
    color: #a5b4fc !important;
    font-weight: 600;
}
.subpanel-cnt {
    display: inline-block; margin-left: 4px;
    padding: 0 5px; border-radius: 8px; font-size: 10px;
    background: rgba(99,102,241,0.18); color: #a5b4fc; font-weight: 700;
}

/* 被谁调用（反向调用图） */
.fn-callers-list { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; }
.callers-summary {
    font-size: 11px; color: var(--text-muted);
    padding: 4px 8px 6px; border-bottom: 1px dashed var(--border-color);
    margin-bottom: 4px;
}
.caller-item {
    display: flex; align-items: center; gap: 8px; padding: 5px 10px;
    border: 1px solid rgba(45,49,72,0.5); border-radius: 4px;
    background: var(--bg-secondary); flex-wrap: wrap;
}
.caller-item-clickable { cursor: pointer; transition: background 0.1s, border-color 0.1s; }
.caller-item-clickable:hover { background: var(--bg-tertiary); border-color: rgba(99,102,241,0.4); }
.caller-icon { font-size: 12px; flex-shrink: 0; }
.caller-fn-name { font-size: 12px; color: #a5b4fc; font-weight: 600; font-family: monospace; }
.caller-line { font-size: 11px; }
.caller-at { font-size: 10px; color: var(--text-muted); }
.caller-count-badge {
    display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 700;
    background: rgba(245,158,11,0.15); color: #fcd34d; flex-shrink: 0;
}
.caller-pct { font-size: 10px; color: var(--text-muted); font-family: monospace; }

.fn-calls-list { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; }
.fn-call-item { border: 1px solid rgba(45,49,72,0.6); border-radius: 5px; overflow: hidden; background: var(--bg-secondary); margin-bottom: 3px; transition: border-color 0.2s, box-shadow 0.2s; }
.call-highlighted { border-color: rgba(99,102,241,0.7) !important; box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }
.fn-call-header {
    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    cursor: pointer; transition: background 0.1s; flex-wrap: wrap;
}
.fn-call-header:hover { background: var(--bg-tertiary); }
.fn-args-preview { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.fn-ret-preview { display: flex; align-items: center; gap: 4px; }

/* 三级：面板容器 */
.fn-call-panels { border-top: 1px solid var(--border-color); background: rgba(15,17,23,0.6); }

/* 面板切换按钮组 */
.call-panel-tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border-color);
}
.call-panel-tab {
    padding: 5px 14px; font-size: 11px; background: transparent;
    border: none; border-right: 1px solid var(--border-color);
    color: var(--text-muted); cursor: pointer; transition: background 0.1s, color 0.1s;
}
.call-panel-tab:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.call-panel-tab-active {
    background: rgba(99,102,241,0.12) !important;
    color: #a5b4fc !important;
    font-weight: 600;
}
/* 自身/全部切换分隔符 */
.call-panel-sep {
    padding: 5px 4px; color: var(--border-color); font-size: 13px;
    line-height: 1; user-select: none;
}
/* 自身模式尺寸稍小 */
.call-panel-tab-own { padding: 5px 10px; }

/* ── 火焰图按钮组 ─────────────────────────────────────────────────────────── */
.flame-btn-group {
    display: flex;
    align-items: center;
    gap: 0;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border-color);
    flex-shrink: 0;
}
.btn-flame {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    font-size: 12px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: none;
    border-right: 1px solid var(--border-color);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    white-space: nowrap;
}
.btn-flame:hover:not(:disabled) { background: var(--bg-tertiary); }
.btn-flame:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-flame-active {
    background: rgba(226,83,58,0.12) !important;
    color: #fca5a5 !important;
    border-color: rgba(226,83,58,0.3) !important;
}
.btn-flame-export {
    padding: 4px 10px;
    font-size: 12px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    border: none;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    white-space: nowrap;
}
.btn-flame-export:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
.btn-flame-export:disabled { opacity: 0.45; cursor: not-allowed; }

/* ── 火焰图面板 ──────────────────────────────────────────────────────────── */
.flame-panel {
    margin-bottom: 16px;
    border: 1px solid rgba(226,83,58,0.25);
    border-radius: 8px;
    overflow: hidden;
    background: #0c0d12;
}
.flame-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: rgba(226,83,58,0.07);
    border-bottom: 1px solid rgba(226,83,58,0.15);
    min-height: 32px;
    flex-wrap: wrap;
    gap: 6px;
}
.flame-info {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
}
.flame-breadcrumb {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
}
.flame-crumb {
    color: #fca5a5;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
}
.flame-crumb:hover { color: #fff; }
.flame-crumb-sep { color: var(--text-muted); }

.flame-canvas-wrap {
    position: relative;
    width: 100%;
    overflow-x: auto;
}
.flame-canvas {
    display: block;
    width: 100%;
    cursor: default;
}

/* Tooltip */
.flame-tooltip {
    position: absolute;
    pointer-events: none;
    background: rgba(15,17,23,0.95);
    border: 1px solid rgba(226,83,58,0.4);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    max-width: 300px;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.flame-tooltip-name {
    font-family: monospace;
    font-size: 12px;
    color: #fca5a5;
    font-weight: 600;
    word-break: break-all;
    margin-bottom: 3px;
}
.flame-tooltip-stats {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 2px;
}
.flame-tooltip-hint {
    font-size: 10px;
    color: rgba(255,255,255,0.3);
    font-style: italic;
}

/* 按钮内的小 spinner */
.spinner-tiny {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: #fca5a5;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
/* 子调用折叠提示 */
.call-child-hint {
    padding: 5px 10px; font-size: 10px; color: var(--text-muted);
    font-style: italic; flex: 1; text-align: right;
}

/* 调用栈面板 */
.call-stack-panel { padding: 8px 12px; }
.call-stack-list { display: flex; flex-direction: column; gap: 2px; }
.stack-frame {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    border-radius: 4px; background: var(--bg-secondary);
    border: 1px solid rgba(45,49,72,0.5); flex-wrap: wrap;
}
.frame-depth {
    font-size: 10px; font-family: monospace; color: var(--text-muted);
    min-width: 24px; flex-shrink: 0;
}
.frame-fn { font-size: 12px; color: #a5b4fc; font-weight: 600; flex-shrink: 0; }
.frame-line { font-size: 11px; flex-shrink: 0; }
.frame-args { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

/* 三级：事件流 */
.fn-call-events { padding: 8px; }

/* 事件表格 */
.events-table-wrapper { overflow-x: auto; }
.events-table { width: 100%; border-collapse: collapse; }
.events-table th {
    text-align: left; padding: 8px 12px; color: var(--text-muted);
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    border-bottom: 1px solid var(--border-color); white-space: nowrap;
}
.events-table td { padding: 7px 12px; border-bottom: 1px solid rgba(45,49,72,0.5); vertical-align: middle; }
.events-table tr:hover td { background: var(--bg-tertiary); }
.td-seq { font-family: monospace; color: var(--text-muted); min-width: 50px; }
.td-location { font-family: monospace; color: var(--text-muted); min-width: 60px; }
.td-vars { max-width: 150px; }
.type-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.type-END_EXPR      { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.type-CALL_PRE      { background: rgba(245,158,11,0.15); color: #fcd34d; }
.type-CALL          { background: rgba(34,197,94,0.15);  color: #86efac; }
.type-SCRIPT_ENTER  { background: rgba(59,130,246,0.15); color: #93c5fd; }
.type-FUNCTION_ENTER { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.type-FUNCTION_EXIT  { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 250px; display: block; overflow: hidden; text-overflow: ellipsis; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15);  color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-chip-expandable { cursor: pointer; }
.var-chip-expandable:hover { filter: brightness(1.2); outline: 1px solid rgba(255,255,255,0.15); }
.var-chip-val { opacity: 0.75; font-size: 10px; margin-left: 2px; }
.var-chip-val em { font-style: normal; color: #fcd34d; }
.var-more { font-size: 11px; color: var(--text-muted); }
</style>
