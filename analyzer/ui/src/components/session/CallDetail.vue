<template>
  <!-- 三级：子面板切换（调用栈 / 事件流） -->
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
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
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
  /** 初始展开的面板（'stack' | 'events'）*/
  initialView: {
    type: String,
    default: 'events',
  },
});

const emit = defineEmits(['update:childCount']);

// ── 状态 ─────────────────────────────────────────────────────────────────────

const activeView   = ref(props.initialView);
const ownOnly      = ref(true);
const childCount   = ref(0);

const stack        = ref([]);
const stackLoading = ref(false);

const events       = ref([]);
const eventsLoading = ref(false);

// ── 生命周期：初次展开时加载默认面板 ─────────────────────────────────────────

watch(() => props.call?.id, (id) => {
  if (!id) return;
  // 重置状态
  stack.value  = [];
  events.value = [];
  childCount.value = 0;
  activeView.value = props.initialView;
  ownOnly.value    = true;
  // 加载初始面板数据
  if (props.initialView === 'stack') {
    loadStack();
  } else {
    loadEvents();
  }
}, { immediate: true });

// ── 面板切换 ──────────────────────────────────────────────────────────────────

async function toggleView(view) {
  if (activeView.value === view) {
    activeView.value = null;
    return;
  }
  activeView.value = view;
  if (view === 'stack'  && stack.value.length  === 0) await loadStack();
  if (view === 'events' && events.value.length === 0) await loadEvents();
}

async function setOwnOnly(val) {
  if (ownOnly.value === val) return;
  ownOnly.value    = val;
  events.value     = [];
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

async function loadEvents() {
  eventsLoading.value = true;
  try {
    let data;
    if (ownOnly.value && props.call.id != null) {
      // 自身模式：own-events API
      const params = new URLSearchParams({ limit: 200 });
      const res = await fetch(`/api/sessions/${props.sessionId}/calls/${props.call.id}/own-events?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      const cnt = data.childCount ?? 0;
      childCount.value = cnt;
      emit('update:childCount', cnt);
    } else {
      // 全部模式：events API（SEQ 区间）
      const params = new URLSearchParams({
        seqFrom: props.call.callSeq,
        seqTo:   props.call.returnSeq,
        limit:   200,
        offset:  0,
      });
      const res = await fetch(`/api/sessions/${props.sessionId}/events?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    }
    events.value = data.events || [];
  } catch (e) {
    console.error('[CallDetail] loadEvents error:', e);
    events.value = [];
  } finally {
    eventsLoading.value = false;
  }
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
.frame-depth { font-size: 10px; font-family: monospace; color: var(--text-muted); min-width: 24px; flex-shrink: 0; }
.frame-fn    { font-size: 12px; color: #a5b4fc; font-weight: 600; flex-shrink: 0; }
.frame-line  { font-size: 11px; flex-shrink: 0; }
.frame-args  { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

/* 事件流面板 */
.fn-call-events { padding: 8px; }
.events-table-wrapper { overflow-x: auto; }
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
</style>
