<template>
  <!-- 三级：子面板切换（调用栈 / 事件流 / CFG） -->
  <div class="fn-call-panels">
    <!-- 面板切换按钮 -->
    <div class="call-panel-tabs">
      <button
        class="call-panel-tab"
        :class="{ 'call-panel-tab-active': activeView === 'stack' }"
        @click.stop="toggleView('stack')"
      >📚 调用栈</button>
      <button
        class="call-panel-tab"
        :class="{ 'call-panel-tab-active': activeView === 'events' }"
        @click.stop="toggleView('events')"
      >📋 事件流</button>
      <button
        class="call-panel-tab"
        :class="{ 'call-panel-tab-active': activeView === 'cfg' }"
        @click.stop="toggleView('cfg')"
        title="查看该次调用内部的控制流图（IDA 风格）"
      >🧩 CFG</button>
      <button
        v-if="call.fnName"
        class="call-panel-tab"
        @click.stop="openDataflow"
        title="在数据流图中追踪该函数相关的变量流向"
      >🔗 数据流</button>
      <button
        v-if="call.fnIid != null"
        class="call-panel-tab"
        :class="{ 'call-panel-tab-active': activeView === 'source' }"
        @click.stop="toggleView('source')"
        title="查看函数源码，并叠加本次调用的执行次数与读写值"
      >{ } 源码注解</button>
      <!-- 自身/全部切换：仅在事件流面板时显示 -->
      <template v-if="activeView === 'events'">
        <span class="call-panel-sep">|</span>
        <button
          class="call-panel-tab call-panel-tab-own"
          :class="{ 'call-panel-tab-active': ownOnly }"
          @click.stop="setOwnOnly(true)"
          title="只显示该函数自身的事件，隐藏内层调用的事件"
        >🔍 自身</button>
        <button
          class="call-panel-tab call-panel-tab-own"
          :class="{ 'call-panel-tab-active': !ownOnly }"
          @click.stop="setOwnOnly(false)"
          title="显示包含内层调用在内的全部事件"
        >📄 全部</button>
        <span v-if="childCount > 0" class="call-child-hint">
          已折叠 {{ childCount }} 个子调用
        </span>

        <!-- 导出按钮 -->
        <div class="cd-export-wrap" ref="cdExportBtnRef">
          <button
            class="cd-export-btn"
            :disabled="cdExporting"
            @click.stop="toggleCdExport"
            title="导出当前事件流"
          >{{ cdExporting ? '…' : '⬇' }}</button>
          <div v-if="cdExportOpen" class="cd-export-popover" @click.stop>
            <div class="cd-ep-row" v-for="f in cdExportFormats" :key="f.value">
              <button
                class="cd-ep-fmt-btn"
                :class="{ 'cd-ep-fmt-active': cdExportFormat === f.value }"
                @click.stop="cdExportFormat = f.value"
              >{{ f.label }}</button>
              <span class="cd-ep-hint">{{ f.hint }}</span>
            </div>
            <div class="cd-ep-actions">
              <span v-if="cdExportError" class="cd-ep-error">{{ cdExportError }}</span>
              <button class="cd-ep-go btn-primary" @click.stop="doCdExport">下载</button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 调用栈面板 -->
    <div v-if="activeView === 'stack'" class="call-stack-panel">
      <div v-if="stackLoading" class="loading" style="padding:8px">
        <div class="spinner"></div><span>加载调用栈...</span>
      </div>
      <div v-else-if="stack.length === 0" class="empty-state" style="padding:10px">
        此调用无父帧（顶层调用，depth=0）
      </div>
      <div v-else class="call-stack-list">
        <div
          v-for="frame in stack"
          :key="frame.depth"
          class="stack-frame"
        >
          <span class="frame-depth">#{{ frame.depth }}</span>
          <code class="frame-fn">{{ frame.fnName || '(anonymous)' }}</code>
          <span v-if="frame.callerLine" class="frame-line text-muted">line {{ frame.callerLine }}</span>
          <span class="frame-args">
            <span
              v-for="(arg, i) in (frame.args || []).slice(0, 3)"
              :key="i"
              class="var-chip var-read var-chip-expandable"
              title="点击查看完整参数值"
              @click.stop="openValueViewer(arg.value !== undefined ? arg.value : arg, arg.name || ('arg'+i))"
            >{{ arg.name || ('arg'+i) }}=<em style="color:#fcd34d">{{ truncate(formatArgValue(arg.value !== undefined ? arg.value : arg), 12) }}</em></span>
            <span v-if="(frame.args || []).length > 3" class="var-more">+{{ frame.args.length - 3 }}</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 事件流面板 -->
    <div v-if="activeView === 'events'" class="fn-call-events">
      <div v-if="eventsLoading" class="loading" style="padding:8px">
        <div class="spinner"></div><span>加载事件流...</span>
      </div>
      <div v-else-if="events.length === 0" class="empty-state" style="padding:8px">
        该区间无{{ ownOnly ? '自身' : '' }}事件
      </div>
      <div v-else class="events-table-wrapper">
        <table class="events-table" style="font-size:11px">
          <thead>
            <tr><th>SEQ</th><th>类型</th><th>行:列</th><th>源码</th><th>写入</th><th>读取</th></tr>
          </thead>
          <tbody>
            <tr v-for="ev in events" :key="ev.seq">
              <td class="td-seq">{{ ev.seq }}</td>
              <td class="td-type">
                <span class="type-badge" :class="`type-${ev.type}`">{{ ev.type }}</span>
              </td>
              <td class="td-location">
                <span v-if="ev.line != null">{{ ev.line }}:{{ ev.col ?? 0 }}</span>
                <span v-else class="text-muted">—</span>
              </td>
              <td class="td-src">
                <code class="src-text">{{ truncate(ev.srcText, 50) }}</code>
              </td>
              <td class="td-vars">
                <span
                  v-for="w in (ev.writes || []).slice(0, 2)"
                  :key="w.name"
                  class="var-chip var-write"
                  :class="{ 'var-chip-expandable': w.value !== null && w.value !== undefined && !w.omitted }"
                  :title="w.value !== null && w.value !== undefined && !w.omitted ? '点击查看完整值' : `${w.name} = ${JSON.stringify(w.value)}`"
                  @click.stop="w.value !== null && w.value !== undefined && !w.omitted && openValueViewer(w.value, w.name)"
                >{{ w.name }}<span class="var-chip-val" v-if="w.value !== null && w.value !== undefined && !w.omitted">=<em>{{ truncate(formatValue(w.value), 15) }}</em></span></span>
                <span v-if="(ev.writes || []).length > 2" class="var-more">+{{ ev.writes.length - 2 }}</span>
              </td>
              <td class="td-vars">
                <span
                  v-for="r in (ev.reads || []).slice(0, 2)"
                  :key="r.name"
                  class="var-chip var-read"
                  :class="{ 'var-chip-expandable': r.value !== null && r.value !== undefined && !r.omitted }"
                  :title="r.value !== null && r.value !== undefined && !r.omitted ? '点击查看完整值' : `${r.name} → ${JSON.stringify(r.value)}`"
                  @click.stop="r.value !== null && r.value !== undefined && !r.omitted && openValueViewer(r.value, r.name)"
                >{{ r.name }}<span class="var-chip-val" v-if="r.value !== null && r.value !== undefined && !r.omitted">→<em>{{ truncate(formatValue(r.value), 15) }}</em></span></span>
                <span v-if="(ev.reads || []).length > 2" class="var-more">+{{ ev.reads.length - 2 }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- 事件流分页 -->
        <div v-if="eventsPage > 1 || eventsHasMore" class="events-pagination">
          <button class="call-panel-tab" :disabled="eventsPage <= 1" @click.stop="prevEventsPage">‹ 上一页</button>
          <span class="events-page-info">第 {{ eventsPage }} 页</span>
          <button class="call-panel-tab" :disabled="!eventsHasMore" @click.stop="nextEventsPage">下一页 ›</button>
        </div>
      </div>
    </div>

    <!-- 源码注解面板 -->
    <div v-if="activeView === 'source'" class="fn-call-source">
      <div v-if="sourceLoading" class="loading" style="padding:16px">
        <div class="spinner"></div><span>加载源码注解...</span>
      </div>
      <div v-else-if="sourceError" class="empty-state" style="padding:16px;color:#f87171">
        ⚠ {{ sourceError }}
      </div>
      <div v-else-if="sourceData?.error === 'not_instrumented'" class="empty-state" style="padding:16px">
        <p style="color:var(--text-muted)">🔒 该函数未被插桩，无执行数据</p>
        <p v-if="sourceData.callSite" style="font-size:11px;color:var(--text-muted);margin-top:6px">
          调用点：第 {{ sourceData.callSite.line }} 行
          <code v-if="sourceData.callSite.srcText" style="margin-left:6px;opacity:.8">{{ sourceData.callSite.srcText }}</code>
        </p>
        <p v-else style="font-size:11px;color:var(--text-muted)">（原生函数 / 未加载的第三方库）</p>
      </div>
      <div v-else-if="!sourceData || sourceData.lines.length === 0" class="empty-state" style="padding:16px">
        <p>📭 无源码数据</p>
        <p style="font-size:11px;color:var(--text-muted)">需要 F2-SmapLoader 插件加载源码映射</p>
      </div>
      <div v-else class="source-panel-body">
        <!-- 函数签名信息栏 -->
        <div v-if="sourceData.signature" class="source-sig-bar">
          <span class="source-sig-label">签名推断</span>
          <span class="source-sig-fn">{{ sourceData.fnName }}</span>
          <span class="source-sig-sep">·</span>
          <span class="source-sig-meta">共调用 {{ sourceData.signature.callCount }} 次</span>
          <span v-if="sourceData.signature.isPure" class="source-sig-badge pure">纯函数</span>
          <template v-if="sourceData.signature.returnTypes?.length">
            <span class="source-sig-sep">→</span>
            <span class="source-sig-types">
              <span
                v-for="rt in sourceData.signature.returnTypes"
                :key="rt.type"
                class="sig-type-chip"
              >{{ rt.type }}<em v-if="rt.pct != null"> {{ rt.pct }}%</em></span>
            </span>
          </template>
        </div>
        <!-- 源码表格 -->
        <div class="source-code-wrapper">
          <table class="source-table">
            <tbody>
              <tr
                v-for="lineInfo in sourceData.lines"
                :key="lineInfo.line"
                class="source-row"
                :class="{
                  'source-row-hot':  lineInfo.execCount >= 100,
                  'source-row-exec': lineInfo.execCount > 0 && lineInfo.execCount < 100,
                  'source-row-dead': lineInfo.execCount === 0,
                }"
              >
                <!-- 行号 -->
                <td class="source-lineno">{{ lineInfo.line }}</td>
                <!-- 执行次数气泡 -->
                <td class="source-exec">
                  <span v-if="lineInfo.execCount > 0" class="exec-badge" :class="lineInfo.execCount >= 100 ? 'exec-hot' : 'exec-warm'">
                    ×{{ fmtNum(lineInfo.execCount) }}
                  </span>
                  <span v-else class="exec-dead">—</span>
                </td>
                <!-- 源码文本 -->
                <td class="source-text">
                  <code>{{ lineInfo.srcText }}</code>
                </td>
                <!-- 写入值 -->
                <td class="source-vars">
                  <template v-if="lineInfo.writes?.length">
                    <span
                      v-for="w in lineInfo.writes"
                      :key="w.name"
                      class="var-chip var-write"
                    >
                      {{ w.name }}=<em class="source-val">{{ fmtVals(w.values) }}</em>
                    </span>
                  </template>
                </td>
                <!-- 读取值 -->
                <td class="source-vars">
                  <template v-if="lineInfo.reads?.length">
                    <span
                      v-for="r in lineInfo.reads"
                      :key="r.name"
                      class="var-chip var-read"
                    >
                      {{ r.name }}→<em class="source-val">{{ fmtVals(r.values) }}</em>
                    </span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- CFG 面板 -->
    <div v-if="activeView === 'cfg'" class="fn-call-cfg">
      <div v-if="cfgLoading" class="loading" style="padding:16px">
        <div class="spinner"></div><span>分析控制流...</span>
      </div>
      <div v-else-if="cfgError" class="empty-state" style="padding:16px;color:#f87171">
        ⚠ {{ cfgError }}
      </div>
      <div v-else-if="cfgData && cfgData.blocks.length === 0" class="empty-state" style="padding:16px">
        <p>📭 无法分析控制流</p>
        <p style="font-size:11px;color:var(--text-muted)">函数事件数据不足（需要 smap + F3 插件）</p>
      </div>
      <div v-else-if="cfgData" class="cfg-panel-body">
        <!-- 工具栏 -->
        <div class="cfg-mini-toolbar">
          <span class="cfg-mini-stats">
            {{ cfgData.stats.blockCount }} 块 · {{ cfgData.stats.edgeCount }} 条边
          </span>
          <span class="cfg-path-badge">
            🎯 单次调用路径
          </span>
          <div style="flex:1"></div>
          <button class="btn-secondary cfg-mini-btn" @click="fitCfgGraph" title="适应窗口">⊡ 适应</button>
        </div>
        <!-- 图例 -->
        <div class="cfg-mini-legend">
          <span class="legend-item"><span class="legend-dot active-dot"></span>已执行块</span>
          <span class="legend-item"><span class="legend-dot inactive-dot"></span>未执行块</span>
          <span class="legend-item"><span class="legend-line active-edge"></span>执行路径</span>
        </div>
        <!-- Cytoscape 容器 -->
        <div ref="cfgCyRef" class="cfg-mini-canvas"></div>
        <!-- 节点 Tooltip -->
        <div v-if="cfgTooltip" class="cfg-mini-tooltip"
             :style="{ left: cfgTooltip.x + 'px', top: cfgTooltip.y + 'px' }">
          <div class="cfg-tooltip-title">{{ cfgTooltip.title }}</div>
          <div v-for="(v, k) in cfgTooltip.props" :key="k" class="cfg-tooltip-row">
            <span class="cfg-tooltip-key">{{ k }}</span>
            <span class="cfg-tooltip-val">{{ v }}</span>
          </div>
          <div v-if="cfgTooltip.hint" class="cfg-tooltip-hint">{{ cfgTooltip.hint }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted, nextTick } from 'vue';
import cytoscape from 'cytoscape';
import { truncate, formatValue, formatArgValue } from '../../composables/useSessionUtils.js';
import { openValueViewer } from '../../composables/useValueViewer.js';

const props = defineProps({
  sessionId:  { type: String,  required: true },
  /** call_edges 记录 */
  call: {
    type: Object,
    required: true,
    // { id, callSeq, returnSeq, depth, fnName, fnIid, args, returnValue }
  },
  /** 初始展开的面板（'stack' | 'events' | 'cfg'）*/
  initialView: {
    type: String,
    default: 'events',
  },
});

const emit = defineEmits(['update:childCount', 'open-dataflow', 'goto-line']);

// ── 状态 ─────────────────────────────────────────────────────────────────────

const activeView   = ref(props.initialView);
const ownOnly      = ref(true);
const childCount   = ref(0);

const stack        = ref([]);
const stackLoading = ref(false);

const events        = ref([]);
const eventsLoading = ref(false);
const eventsHasMore = ref(false);
const eventsPage    = ref(1);
// 游标栈：ownOnly 模式用游标分页，全部模式用 offset 分页
const eventsCursorStack = ref([null]); // [null, cursor1, cursor2, ...]，null 表示从头
const eventsTotal   = ref(0); // 全部模式下的总数（own 模式不知道总数）

// 源码注解状态
const sourceLoading = ref(false);
const sourceError   = ref('');
const sourceData    = ref(null);

// CFG 状态
const cfgCyRef    = ref(null);
const cfgLoading  = ref(false);
const cfgError    = ref('');
const cfgData     = ref(null);
const cfgTooltip  = ref(null);
let cfgCy         = null;

// ── 生命周期：初次展开时加载默认面板 ─────────────────────────────────────────

watch(() => props.call?.id, (id) => {
  if (!id) return;
  // 重置状态
  stack.value  = [];
  events.value = [];
  childCount.value = 0;
  activeView.value = props.initialView;
  ownOnly.value    = true;
  eventsPage.value = 1;
  eventsCursorStack.value = [null];
  eventsHasMore.value = false;
  eventsTotal.value   = 0;
  cfgData.value    = null;
  cfgError.value   = '';
  sourceData.value = null;
  sourceError.value = '';
  destroyCfgCy();
  // 加载初始面板数据
  if (props.initialView === 'stack') {
    loadStack();
  } else if (props.initialView === 'cfg') {
    loadCfg();
  } else if (props.initialView === 'source') {
    loadSource();
  } else {
    loadEvents();
  }
}, { immediate: true });

onUnmounted(() => {
  destroyCfgCy();
  document.removeEventListener('click', handleCdExportOutside);
});

// ── 导出事件流 ────────────────────────────────────────────────────────────────

const cdExportBtnRef  = ref(null);
const cdExportOpen    = ref(false);
const cdExporting     = ref(false);
const cdExportError   = ref('');
const cdExportFormat  = ref('ndjson');

const cdExportFormats = [
  { value: 'ndjson', label: 'NDJSON', hint: 'jq 可处理' },
  { value: 'tsv',    label: 'TSV',    hint: 'Excel/awk' },
  { value: 'text',   label: '纯文本', hint: '人类可读' },
];

function toggleCdExport() {
  cdExportOpen.value = !cdExportOpen.value;
  cdExportError.value = '';
  if (cdExportOpen.value) {
    // 打开时注册一次性外部点击监听
    setTimeout(() => document.addEventListener('click', handleCdExportOutside), 0);
  } else {
    document.removeEventListener('click', handleCdExportOutside);
  }
}

function handleCdExportOutside(e) {
  if (cdExportBtnRef.value && !cdExportBtnRef.value.contains(e.target)) {
    cdExportOpen.value = false;
    document.removeEventListener('click', handleCdExportOutside);
  }
}

async function doCdExport() {
  cdExportError.value = '';
  cdExporting.value   = true;
  cdExportOpen.value  = false;
  document.removeEventListener('click', handleCdExportOutside);
  try {
    const range = { callId: props.call.id, ownOnly: ownOnly.value };
    const res = await fetch(`/api/sessions/${props.sessionId}/events/export`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ranges: [range], format: cdExportFormat.value }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const ext  = cdExportFormat.value === 'tsv' ? 'tsv'
               : cdExportFormat.value === 'text' ? 'txt'
               : 'ndjson';
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    const fnLabel = props.call.fnName ? props.call.fnName.slice(0, 20) : `call${props.call.id}`;
    a.download = `${fnLabel}-events.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    cdExportError.value = `失败: ${e.message}`;
    cdExportOpen.value  = true;
  } finally {
    cdExporting.value = false;
  }
}

// ── 面板切换 ──────────────────────────────────────────────────────────────────

async function toggleView(view) {
  if (activeView.value === view) {
    activeView.value = null;
    return;
  }
  activeView.value = view;
  if (view === 'stack'  && stack.value.length  === 0) await loadStack();
  if (view === 'events' && events.value.length === 0) await loadEvents();
  if (view === 'cfg'    && cfgData.value === null && !cfgLoading.value) await loadCfg();
  if (view === 'source' && sourceData.value === null && !sourceLoading.value) await loadSource();
}

// ── 数据流联动 ────────────────────────────────────────────────────────────────
// 点击"数据流"按钮：通知父组件切换到数据流 Tab，并展开以函数名为起点的子图
function openDataflow() {
    emit('open-dataflow', {
        varName:   props.call.fnName,
        direction: 'both',
        mode:      'graph',
    });
}

async function setOwnOnly(val) {
  if (ownOnly.value === val) return;
  ownOnly.value    = val;
  events.value     = [];
  eventsPage.value = 1;
  eventsCursorStack.value = [null];
  eventsHasMore.value = false;
  await loadEvents();
}

// ── 数据加载 ──────────────────────────────────────────────────────────────────

async function loadStack() {
  if (props.call.depth <= 0) {
    stack.value = [];
    return;
  }
  stackLoading.value = true;
  try {
    const params = new URLSearchParams({
      callSeq:   props.call.callSeq,
      returnSeq: props.call.returnSeq,
      depth:     props.call.depth,
    });
    const res = await fetch(`/api/sessions/${props.sessionId}/call-stack?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    stack.value = data.stack || [];
  } catch (e) {
    console.error('[CallDetail] loadStack error:', e);
    stack.value = [];
  } finally {
    stackLoading.value = false;
  }
}

const EVENTS_PAGE_SIZE = 100;

async function loadEvents() {
  eventsLoading.value = true;
  try {
    if (ownOnly.value && props.call.id != null) {
      // 自身模式：own-events API，游标分页
      const params = new URLSearchParams({ limit: EVENTS_PAGE_SIZE });
      const cursor = eventsCursorStack.value[eventsPage.value - 1];
      if (cursor != null) params.set('cursor', cursor);

      const res = await fetch(`/api/sessions/${props.sessionId}/calls/${props.call.id}/own-events?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      events.value = data.events || [];
      eventsHasMore.value = data.hasMore || false;
      // 保存下一页游标
      if (data.nextCursor != null) {
        eventsCursorStack.value[eventsPage.value] = data.nextCursor;
      }
      const cnt = data.childCount ?? 0;
      childCount.value = cnt;
      emit('update:childCount', cnt);
    } else {
      // 全部模式：events API（SEQ 区间），offset 分页
      const offset = (eventsPage.value - 1) * EVENTS_PAGE_SIZE;
      const params = new URLSearchParams({
        seqFrom: props.call.callSeq,
        seqTo:   props.call.returnSeq,
        limit:   EVENTS_PAGE_SIZE,
        offset,
      });
      const res = await fetch(`/api/sessions/${props.sessionId}/events?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      events.value = data.events || [];
      eventsHasMore.value = data.hasMore || (data.events?.length === EVENTS_PAGE_SIZE);
      eventsTotal.value   = data.total ?? 0;
    }
  } catch (e) {
    console.error('[CallDetail] loadEvents error:', e);
    events.value = [];
  } finally {
    eventsLoading.value = false;
  }
}

function prevEventsPage() {
  if (eventsPage.value <= 1) return;
  eventsPage.value--;
  loadEvents();
}

function nextEventsPage() {
  if (!eventsHasMore.value) return;
  eventsPage.value++;
  loadEvents();
}

// ── 源码注解加载 ──────────────────────────────────────────────

async function loadSource() {
  if (!props.call.id) return;
  sourceLoading.value = true;
  sourceError.value   = '';
  sourceData.value    = null;
  try {
    const res = await fetch(`/api/sessions/${props.sessionId}/calls/${props.call.id}/annotated-source`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
if (data.error === 'not_instrumented') {
                // 未插桩函数单独处理，存入 sourceData 供模板展示友好提示
                sourceData.value = data;
            } else if (data.error === 'no_smap' || data.error === 'no_iid') {
                sourceError.value = '源码映射数据不存在，请确认 F2-SmapLoader 插件已运行';
            } else {
                sourceData.value = data;
            }
  } catch (e) {
    console.error('[CallDetail] loadSource error:', e);
    sourceError.value = e.message;
  } finally {
    sourceLoading.value = false;
  }
}

/** 将一行的多个值格式化为简短展示字符串 */
function fmtVals(values) {
  if (!values || values.length === 0) return '';
  const strs = values.map(v => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return v.length > 18 ? v.slice(0, 18) + '…' : v;
    if (typeof v === 'object') return '{...}';
    return String(v).length > 18 ? String(v).slice(0, 18) + '…' : String(v);
  });
  // 去重展示
  const unique = [...new Set(strs)];
  if (unique.length === 1) return unique[0];
  if (unique.length <= 3) return unique.join(' / ');
  return `${unique.slice(0, 2).join(' / ')} ...+${unique.length - 2}`;
}

// ── CFG 加载与渲染 ────────────────────────────────────────────────────────────

async function loadCfg() {
  if (!props.call.fnName || !props.call.id) {
    cfgError.value = '调用数据不完整（缺少 fnName 或 id）';
    return;
  }
  cfgLoading.value = true;
  cfgError.value = '';
  cfgData.value = null;
  cfgTooltip.value = null;
  destroyCfgCy();

  try {
    const params = new URLSearchParams({
      fnName: props.call.fnName,
      callId: props.call.id,
    });
    if (props.call.fnIid != null) params.set('fnIid', props.call.fnIid);

    const res = await fetch(`/api/sessions/${props.sessionId}/fn-cfg?${params}`);
    if (!res.ok) {
      const msg = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(msg.error || res.statusText);
    }
    const data = await res.json();
    cfgData.value = data;

    if (data.blocks.length > 0) {
      // v-else-if="cfgData" 分支的 DOM 需要两个 tick 才能完成挂载并绑定 ref
      await nextTick();
      await nextTick();
      initCfgCy(data);
    }
  } catch (e) {
    cfgError.value = e.message;
  } finally {
    cfgLoading.value = false;
  }
}

function destroyCfgCy() {
  if (cfgCy) {
    cfgCy.destroy();
    cfgCy = null;
  }
}

function fitCfgGraph() {
  cfgCy?.fit(undefined, 20);
}

function truncateStr(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function fmtNum(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function initCfgCy(data) {
  destroyCfgCy();
  if (!cfgCyRef.value) {
    console.warn('[CallDetail] cfgCyRef is null, retrying after 50ms');
    setTimeout(() => initCfgCy(data), 50);
    return;
  }

  // 构建 elements
  const elements = [];
  for (const block of data.blocks) {
    const lineTexts = block.lines.map(l => {
      const lineNo = l.line != null ? `L${l.line}` : '?';
      const src = truncateStr(l.srcText || '', 30);
      const cnt = l.execCount > 1 ? ` ×${fmtNum(l.execCount)}` : '';
      return `${lineNo.padEnd(5)} ${src}${cnt}`;
    });
    // 省略行提示
    if (block.omittedLines > 0) {
      lineTexts.push(`... +${block.omittedLines} 行`);
    }
    // 子调用最多显示 3 个
    const subCallsToShow = (block.subCalls || []).slice(0, 3);
    const callTexts = subCallsToShow.map(sc => `→ ${sc.fnName}()`);
    if ((block.subCalls || []).length > 3) {
      callTexts.push(`→ ...+${block.subCalls.length - 3} 调用`);
    }
    const label = [...lineTexts, ...callTexts].join('\n') || `block:${block.minLine ?? '?'}`;

    const classes = [];
    if (block.isEntry) classes.push('entry');
    if (block.activeInCall === true)  classes.push('active');
    if (block.activeInCall === false) classes.push('inactive');

    elements.push({
      data: {
        id:          block.id,
        label,
        type:        'block',
        isEntry:     block.isEntry,
        minLine:     block.minLine,
        maxLine:     block.maxLine,
        activeInCall: block.activeInCall,
        subCalls:    block.subCalls,
      },
      classes,
    });
  }

  for (const edge of data.edges) {
    const classes = [];
    if (edge.activeInCall === true)  classes.push('active');
    if (edge.activeInCall === false) classes.push('inactive');
    elements.push({
      data: {
        id:           edge.id,
        source:       edge.source,
        target:       edge.target,
        type:         edge.type,
        count:        edge.count,
        label:        edge.label,
        activeInCall: edge.activeInCall,
      },
      classes,
    });
  }

  // Cytoscape 样式（单次路径高亮风格）
  const style = [
    // 普通块（未执行）
    {
      selector: 'node[type="block"]',
      style: {
        'label':             'data(label)',
        'shape':             'rectangle',
        'background-color':  '#0e0f18',
        'border-width':      1,
        'border-color':      '#2d3050',
        'color':             '#4b5280',
        'font-size':         '9px',
        'font-family':       'JetBrains Mono, Consolas, monospace',
        'text-valign':       'center',
        'text-halign':       'center',
        'text-wrap':         'wrap',
        'text-max-width':    360,
        'width':             'label',
        'height':            'label',
        'padding':           10,
      },
    },
    // 已执行块（蓝色高亮）
    {
      selector: 'node.active',
      style: {
        'background-color': '#0f1a35',
        'border-color':     '#6366f1',
        'border-width':      2,
        'color':            '#c8d0e0',
      },
    },
    // 入口块（额外绿色边框）
    {
      selector: 'node.entry.active',
      style: {
        'border-color':     '#22c55e',
        'background-color': '#0a1a10',
      },
    },
    // 未执行块（极暗，虚线）
    {
      selector: 'node.inactive',
      style: {
        'background-color': '#080810',
        'border-color':     '#1f2140',
        'border-style':     'dashed',
        'color':            '#2a2d50',
      },
    },
    // 选中
    {
      selector: 'node:selected',
      style: {
        'border-color': '#818cf8',
        'border-width':  2.5,
      },
    },
    // 已执行边（高亮）
    {
      selector: 'edge.active',
      style: {
        'line-color':         '#6366f1',
        'target-arrow-color': '#818cf8',
        'target-arrow-shape': 'triangle',
        'curve-style':        'taxi',
        'taxi-direction':     'downward',
        'width':              2,
        'label':              'data(label)',
        'font-size':          '9px',
        'color':              '#818cf8',
        'text-background-color':   '#0f1117',
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
      },
    },
    // 未执行边（极暗）
    {
      selector: 'edge.inactive',
      style: {
        'line-color':         '#1a1d30',
        'target-arrow-color': '#1a1d30',
        'target-arrow-shape': 'triangle',
        'curve-style':        'taxi',
        'taxi-direction':     'downward',
        'width':              1,
        'line-style':         'dashed',
      },
    },
    // 回边（已执行）
    {
      selector: 'edge[type="back"].active',
      style: {
        'curve-style':              'unbundled-bezier',
        'control-point-distances':  [100],
        'control-point-weights':    [0.5],
        'line-color':               '#f59e0b',
        'target-arrow-color':       '#f59e0b',
        'line-style':               'dashed',
        'label':                    '↩',
        'font-size':                '11px',
        'color':                    '#f59e0b',
      },
    },
  ];

  cfgCy = cytoscape({
    container: cfgCyRef.value,
    elements,
    style,
    layout: {
      name:    'breadthfirst',
      directed: true,
      padding:  30,
      spacingFactor: 1.5,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
    },
    minZoom: 0.05,
    maxZoom: 4,
    wheelSensitivity: 0.3,
  });

  // 点击节点显示 Tooltip
  cfgCy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const d    = node.data();
    const pos  = evt.renderedPosition;
    const props_obj = {
      '行号范围': d.minLine != null ? `L${d.minLine}~L${d.maxLine}` : '?',
      '状态':     d.activeInCall === true ? '✅ 本次已执行' : d.activeInCall === false ? '⬜ 本次未执行' : '—',
    };
    if (d.subCalls?.length) {
      props_obj['调用函数'] = d.subCalls.map(s => s.fnName).join(', ');
    }
    cfgTooltip.value = {
      x:     pos.x + 12,
      y:     pos.y + 12,
      title: d.minLine != null ? `Block L${d.minLine}` : d.id,
      props: props_obj,
      hint:  d.minLine != null ? '🖱 双击跳转到事件流' : '',
    };
  });

  // 双击块节点 → 通知父组件跳转到对应行号范围的事件流
  cfgCy.on('dblclick', 'node', (evt) => {
    const d = evt.target.data();
    if (d.minLine != null) {
      cfgTooltip.value = null;
      emit('goto-line', { minLine: d.minLine, maxLine: d.maxLine ?? d.minLine });
    }
  });

  cfgCy.on('tap', (evt) => {
    if (evt.target === cfgCy) cfgTooltip.value = null;
  });
}
</script>

<style scoped>
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
.call-panel-sep {
  padding: 5px 4px; color: var(--border-color); font-size: 13px;
  line-height: 1; user-select: none;
}
.call-panel-tab-own { padding: 5px 10px; }
.call-child-hint {
  padding: 5px 10px; font-size: 10px; color: var(--text-muted);
  font-style: italic;
}

/* 导出按钮 */
.cd-export-wrap { position: relative; margin-left: auto; display: flex; align-items: center; padding-right: 6px; }
.cd-export-btn {
  padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(99,102,241,0.4); background: rgba(99,102,241,0.1);
  color: #a5b4fc; transition: background 0.1s;
}
.cd-export-btn:hover:not(:disabled) { background: rgba(99,102,241,0.22); }
.cd-export-btn:disabled { opacity: 0.5; cursor: default; }

/* 格式选择弹层 */
.cd-export-popover {
  position: absolute; top: calc(100% + 5px); right: 0; z-index: 300;
  width: 180px; padding: 10px 12px;
  background: var(--bg-secondary, #1e2138);
  border: 1px solid var(--border-color, rgba(99,102,241,0.25));
  border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.5);
}
.cd-ep-row {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.cd-ep-fmt-btn {
  padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-color);
  background: var(--bg-tertiary, #161929); color: var(--text-secondary);
  font-size: 11px; cursor: pointer; min-width: 54px;
  transition: background 0.1s, color 0.1s;
}
.cd-ep-fmt-btn:hover { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.cd-ep-fmt-active { background: rgba(99,102,241,0.2) !important; color: #a5b4fc !important; border-color: rgba(99,102,241,0.5) !important; }
.cd-ep-hint { font-size: 10px; color: var(--text-muted); }
.cd-ep-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 8px; border-top: 1px solid var(--border-color); padding-top: 8px; }
.cd-ep-error { flex: 1; font-size: 10px; color: #fca5a5; }
.cd-ep-go { font-size: 11px; padding: 3px 12px; }

/* 调用栈面板 */
.call-stack-panel { padding: 8px 12px; }
.call-stack-list { display: flex; flex-direction: column; gap: 2px; }
.stack-frame {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px;
  border-radius: 4px; background: var(--bg-secondary);
  border: 1px solid rgba(45,49,72,0.5); flex-wrap: wrap;
}
.frame-depth { font-size: 10px; font-family: monospace; color: var(--text-muted); min-width: 24px; flex-shrink: 0; }
.frame-fn    { font-size: 12px; color: #a5b4fc; font-weight: 600; flex-shrink: 0; }
.frame-line  { font-size: 11px; flex-shrink: 0; }
.frame-args  { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

/* 事件流面板 */
.fn-call-events { padding: 8px; }
.events-table-wrapper { overflow-x: auto; }
.events-pagination {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-top: 1px solid var(--border-color);
  background: rgba(10,10,20,0.3);
}
.events-page-info { font-size: 11px; color: var(--text-muted); }
.events-table { width: 100%; border-collapse: collapse; }
.events-table th {
  text-align: left; padding: 8px 12px; color: var(--text-muted);
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  border-bottom: 1px solid var(--border-color); white-space: nowrap;
}
.events-table td { padding: 7px 12px; border-bottom: 1px solid rgba(45,49,72,0.5); vertical-align: middle; }
.events-table tr:hover td { background: var(--bg-tertiary); }
.td-seq      { font-family: monospace; color: var(--text-muted); min-width: 50px; }
.td-location { font-family: monospace; color: var(--text-muted); min-width: 60px; }
.td-vars     { max-width: 150px; }

.type-badge          { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.type-END_EXPR       { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.type-CALL_PRE       { background: rgba(245,158,11,0.15); color: #fcd34d; }
.type-CALL           { background: rgba(34,197,94,0.15);  color: #86efac; }
.type-SCRIPT_ENTER   { background: rgba(59,130,246,0.15); color: #93c5fd; }
.type-FUNCTION_ENTER { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.type-FUNCTION_EXIT  { background: rgba(168,85,247,0.15); color: #d8b4fe; }

.src-text  { color: var(--text-primary); white-space: nowrap; max-width: 250px; display: block; overflow: hidden; text-overflow: ellipsis; }
.var-chip  { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15);  color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-chip-val { opacity: 0.75; font-size: 10px; margin-left: 2px; }
.var-chip-val em { font-style: normal; color: #fcd34d; }
.var-chip-expandable { cursor: pointer; }
.var-chip-expandable:hover { filter: brightness(1.2); outline: 1px solid rgba(255,255,255,0.15); }
.var-more  { font-size: 11px; color: var(--text-muted); }
.text-muted { color: var(--text-muted); }

/* loading / empty-state */
.loading { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 13px; }
.spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--border-color); border-top-color: var(--accent);
  animation: spin 0.7s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
.empty-state { text-align: center; color: var(--text-muted); font-size: 12px; }

/* ── 源码注解面板 ─────────────────────────────────────────────────────── */
.fn-call-source {
  display: flex;
  flex-direction: column;
}

.source-panel-body {
  display: flex;
  flex-direction: column;
}

/* 签名信息栏 */
.source-sig-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(10,10,20,0.4);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.source-sig-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.source-sig-fn {
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: #a5b4fc;
  font-weight: 600;
}
.source-sig-sep {
  color: var(--text-muted);
  font-size: 12px;
}
.source-sig-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.source-sig-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid;
}
.source-sig-badge.pure {
  background: rgba(34,197,94,0.1);
  color: #86efac;
  border-color: rgba(34,197,94,0.3);
}
.source-sig-types {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.sig-type-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  background: rgba(99,102,241,0.12);
  color: #a5b4fc;
  border: 1px solid rgba(99,102,241,0.25);
  font-family: 'JetBrains Mono', monospace;
}
.sig-type-chip em {
  font-style: normal;
  opacity: 0.65;
}

/* 源码表格 */
.source-code-wrapper {
  overflow-x: auto;
  overflow-y: auto;
  max-height: 480px;
}
.source-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'JetBrains Mono', Consolas, monospace;
}
.source-row { transition: background 0.1s; }
.source-row:hover td { background: rgba(99,102,241,0.06); }

/* 已执行行（有动态数据） */
.source-row-exec td { background: rgba(15,20,40,0.5); }
.source-row-exec:hover td { background: rgba(99,102,241,0.08) !important; }

/* 热点行（执行次数 >= 100） */
.source-row-hot td { background: rgba(245,158,11,0.06); }
.source-row-hot:hover td { background: rgba(245,158,11,0.1) !important; }

/* 死代码（未执行） */
.source-row-dead td { opacity: 0.4; }

.source-lineno {
  padding: 3px 10px 3px 12px;
  text-align: right;
  color: var(--text-muted);
  font-size: 11px;
  user-select: none;
  white-space: nowrap;
  min-width: 36px;
  border-right: 1px solid rgba(45,49,72,0.4);
  vertical-align: top;
  padding-top: 5px;
}

.source-exec {
  padding: 3px 8px;
  text-align: right;
  white-space: nowrap;
  min-width: 44px;
  vertical-align: top;
  padding-top: 5px;
}
.exec-badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  font-family: monospace;
}
.exec-warm {
  background: rgba(99,102,241,0.15);
  color: #a5b4fc;
}
.exec-hot {
  background: rgba(245,158,11,0.18);
  color: #fcd34d;
}
.exec-dead {
  font-size: 11px;
  color: rgba(99,99,120,0.4);
}

.source-text {
  padding: 3px 12px 3px 8px;
  white-space: pre;
  color: var(--text-primary);
  vertical-align: top;
  padding-top: 5px;
}
.source-text code {
  font-family: inherit;
  font-size: inherit;
}

.source-vars {
  padding: 3px 8px;
  vertical-align: top;
  padding-top: 4px;
  max-width: 200px;
}
.source-val {
  font-style: normal;
  color: #fcd34d;
  font-size: 10px;
  margin-left: 2px;
  opacity: 0.9;
}

/* ── CFG 面板 ────────────────────────────────────────────────────────── */
.fn-call-cfg {
  display: flex;
  flex-direction: column;
}

.cfg-panel-body {
  position: relative;
  display: flex;
  flex-direction: column;
}

.cfg-mini-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(10,10,20,0.4);
  flex-shrink: 0;
}

.cfg-mini-stats {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}

.cfg-path-badge {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(99,102,241,0.15);
  color: #a5b4fc;
  border: 1px solid rgba(99,102,241,0.3);
  white-space: nowrap;
}

.cfg-mini-btn {
  padding: 2px 8px;
  font-size: 10px;
}

.cfg-mini-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(10,10,20,0.2);
  flex-shrink: 0;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
  flex-shrink: 0;
}

.legend-line {
  width: 14px;
  height: 2px;
  display: inline-block;
  flex-shrink: 0;
}

.active-dot   { background: #6366f1; border: 1px solid #818cf8; }
.inactive-dot { background: #0e0f18; border: 1px dashed #2d3050; }
.active-edge  { background: #6366f1; }

.cfg-mini-canvas {
  width: 100%;
  height: 360px;
  min-height: 240px;
  background: #080910;
}

/* Tooltip */
.cfg-mini-tooltip {
  position: absolute;
  background: rgba(15,17,23,0.96);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 12px;
  z-index: 20;
  pointer-events: none;
  min-width: 160px;
  max-width: 260px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  font-size: 11px;
}

.cfg-tooltip-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.cfg-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 2px;
}

.cfg-tooltip-key { color: var(--text-muted); }
.cfg-tooltip-val { color: var(--text-primary); font-family: 'JetBrains Mono', monospace; }

.cfg-tooltip-hint {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid var(--border-color);
  font-size: 10px;
  color: var(--text-muted);
  text-align: center;
}
</style>
