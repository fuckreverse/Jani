<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">函数执行追踪</h2>
      <span class="section-badge">{{ fnExecTotal }} 个函数</span>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar" style="margin-bottom:14px; flex-wrap:wrap; gap:8px">
      <input
        v-model="fnExecSearch"
        placeholder="搜索函数名..."
        style="width:200px"
        @keyup.enter="loadFnExec(true)"
      />
      <label class="filter-label" style="gap:4px">
        最少调用次数
        <input
          v-model="fnExecMinCalls"
          type="number"
          min="1"
          style="width:70px"
          @keyup.enter="loadFnExec(true)"
        />
      </label>
      <button class="btn-primary" @click="loadFnExec(true)">查询</button>
      <button class="btn-secondary" @click="clearFnExecFilters">清空</button>
    </div>

    <div v-if="fnExecLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="fnExecList.length === 0" class="empty-state">
      <p v-if="f3Status === 'done'">暂无函数数据（F3 已运行，但未找到调用记录。可尝试点击「🔄 重跑 Phase 2」按钮重新分析）</p>
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
            <span class="fn-call-badge">{{ fn.call_count }} 次调用</span>
            <span v-if="fn.min_line" class="text-muted" style="font-size:11px">line {{ fn.min_line }}</span>
            <span v-if="fn.fn_iid" class="text-muted" style="font-size:11px">iid={{ fn.fn_iid }}</span>
            <span class="text-muted" style="font-size:11px">深度 {{ fn.min_depth }}~{{ fn.max_depth }}</span>
          </div>

          <!-- 二级：调用记录列表 -->
          <div v-if="expandedFns.has(fnExpandedKey(fn))" class="fn-calls-container">
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
                class="fn-call-item"
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
                      class="var-chip var-read"
                      :title="`${arg.name || 'arg'+i} = ${JSON.stringify(arg.value || arg)}`"
                    >{{ arg.name || ('arg'+i) }}=<em style="color:#fcd34d">{{ truncate(formatArgValue(arg.value !== undefined ? arg.value : arg), 15) }}</em></span>
                    <span v-if="(call.args || []).length > 4" class="var-more">+{{ call.args.length - 4 }}</span>
                  </span>
                  <!-- 返回值 -->
                  <span v-if="call.returnValue !== null && call.returnValue !== undefined" class="fn-ret-preview">
                    <span class="filter-label" style="margin-left:8px">→</span>
                    <span class="var-chip var-write">{{ truncate(formatArgValue(call.returnValue), 20) }}</span>
                  </span>
                </div>

                <!-- 三级：该次调用的事件流 -->
                <div v-if="expandedCalls.has(call.id)" class="fn-call-events">
                  <div v-if="callEventsLoading[call.id]" class="loading" style="padding:8px">
                    <div class="spinner"></div><span>加载事件流...</span>
                  </div>
                  <div v-else-if="(callEventsMap[call.id] || []).length === 0" class="empty-state" style="padding:8px">
                    该区间无事件
                  </div>
                  <div v-else class="events-table-wrapper">
                    <table class="events-table" style="font-size:11px">
                      <thead>
                        <tr><th>SEQ</th><th>类型</th><th>行:列</th><th>源码</th><th>写入</th><th>读取</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="ev in callEventsMap[call.id]" :key="ev.seq">
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
                              :title="`${w.name} = ${JSON.stringify(w.value)}`"
                            >{{ w.name }}<span class="var-chip-val" v-if="w.value !== null && w.value !== undefined && !w.omitted">=<em>{{ truncate(formatValue(w.value), 15) }}</em></span></span>
                            <span v-if="(ev.writes || []).length > 2" class="var-more">+{{ ev.writes.length - 2 }}</span>
                          </td>
                          <td class="td-vars">
                            <span
                              v-for="r in (ev.reads || []).slice(0, 2)"
                              :key="r.name"
                              class="var-chip var-read"
                              :title="`${r.name} → ${JSON.stringify(r.value)}`"
                            >{{ r.name }}<span class="var-chip-val" v-if="r.value !== null && r.value !== undefined && !r.omitted">→<em>{{ truncate(formatValue(r.value), 15) }}</em></span></span>
                            <span v-if="(ev.reads || []).length > 2" class="var-more">+{{ ev.reads.length - 2 }}</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <!-- 调用记录分页 -->
              <div v-if="fnCallsTotal[fnExpandedKey(fn)] > (fnCallsMap[fnExpandedKey(fn)] || []).length" class="pagination" style="margin-top:8px; padding-top:8px">
                <span class="page-info">显示 {{ (fnCallsMap[fnExpandedKey(fn)] || []).length }} / {{ fnCallsTotal[fnExpandedKey(fn)] }} 条</span>
                <button class="btn-secondary" @click="loadMoreCalls(fn)">加载更多</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 函数列表分页 -->
      <div v-if="fnExecTotal > fnExecList.length" class="pagination">
        <span class="page-info">已显示 {{ fnExecList.length }} / {{ fnExecTotal }} 个函数</span>
        <button class="btn-secondary" @click="loadMoreFns">加载更多</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { truncate, formatValue, formatArgValue } from '../../composables/useSessionUtils.js';

const props = defineProps({
    sessionId:    { type: String,  required: true },
    pluginStatus: { type: Object,  default: () => ({}) },
});

const f3Status = computed(() => props.pluginStatus?.['F3-CallGraphBuilder'] ?? '');

const fnExecList     = ref([]);
const fnExecTotal    = ref(0);
const fnExecLoading  = ref(false);
const fnExecSearch   = ref('');
const fnExecMinCalls = ref(1);
const fnExecOffset   = ref(0);
const FN_EXEC_PAGE   = 50;

const expandedFns   = reactive(new Set());
const expandedCalls = reactive(new Set());

const fnCallsMap     = reactive({});
const fnCallsTotal   = reactive({});
const fnCallsOffset  = reactive({});
const fnCallsLoading = reactive({});
const FN_CALLS_PAGE  = 30;

const callEventsMap     = reactive({});
const callEventsLoading = reactive({});

function fnExpandedKey(fn) {
    return `${fn.fn_name}__${fn.fn_iid ?? ''}`;
}

async function loadFnExec(reset = false) {
    if (reset) fnExecOffset.value = 0;
    fnExecLoading.value = true;
    try {
        const params = new URLSearchParams({
            limit:    FN_EXEC_PAGE,
            offset:   fnExecOffset.value,
            minCalls: fnExecMinCalls.value || 1,
        });
        if (fnExecSearch.value.trim()) params.set('search', fnExecSearch.value.trim());
        const res = await fetch(`/api/sessions/${props.sessionId}/functions?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (reset) {
            fnExecList.value = data.functions || [];
        } else {
            fnExecList.value.push(...(data.functions || []));
        }
        fnExecTotal.value = data.total ?? (data.functions?.length ?? 0);
    } catch (e) {
        console.error('loadFnExec error:', e);
    } finally {
        fnExecLoading.value = false;
    }
}

function clearFnExecFilters() {
    fnExecSearch.value = '';
    fnExecMinCalls.value = 1;
    loadFnExec(true);
}

async function loadMoreFns() {
    fnExecOffset.value += FN_EXEC_PAGE;
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

async function loadFnCalls(fn, reset = false) {
    const key = fnExpandedKey(fn);
    if (reset) fnCallsOffset[key] = 0;
    fnCallsLoading[key] = true;
    try {
        const params = new URLSearchParams({
            limit:  FN_CALLS_PAGE,
            offset: fnCallsOffset[key] || 0,
        });
        const res = await fetch(
            `/api/sessions/${props.sessionId}/functions/${encodeURIComponent(fn.fn_name)}/calls?${params}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (reset || !fnCallsMap[key]) {
            fnCallsMap[key] = data.calls || [];
        } else {
            fnCallsMap[key].push(...(data.calls || []));
        }
        fnCallsTotal[key] = data.total ?? (data.calls?.length ?? 0);
    } catch (e) {
        console.error('loadFnCalls error:', e);
    } finally {
        fnCallsLoading[key] = false;
    }
}

async function loadMoreCalls(fn) {
    const key = fnExpandedKey(fn);
    fnCallsOffset[key] = (fnCallsOffset[key] || 0) + FN_CALLS_PAGE;
    await loadFnCalls(fn, false);
}

async function toggleCallExpand(call) {
    if (expandedCalls.has(call.id)) {
        expandedCalls.delete(call.id);
        return;
    }
    expandedCalls.add(call.id);
    if (!callEventsMap[call.id]) {
        await loadCallEvents(call);
    }
}

async function loadCallEvents(call) {
    callEventsLoading[call.id] = true;
    try {
        const params = new URLSearchParams({
            seqFrom: call.callSeq,
            seqTo:   call.returnSeq,
            limit:   200,
            offset:  0,
        });
        const res = await fetch(`/api/sessions/${props.sessionId}/events?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        callEventsMap[call.id] = data.events || [];
    } catch (e) {
        console.error('loadCallEvents error:', e);
    } finally {
        callEventsLoading[call.id] = false;
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
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.text-muted { color: var(--text-muted); }

/* 分页 */
.pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-color); }
.page-info { font-size: 12px; color: var(--text-muted); }

/* 函数列表 */
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

/* 二级：调用容器 */
.fn-calls-container { border-top: 1px solid var(--border-color); background: var(--bg-primary, #0f1117); }
.fn-calls-list { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; }
.fn-call-item { border: 1px solid rgba(45,49,72,0.6); border-radius: 5px; overflow: hidden; background: var(--bg-secondary); margin-bottom: 3px; }
.fn-call-header {
    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    cursor: pointer; transition: background 0.1s; flex-wrap: wrap;
}
.fn-call-header:hover { background: var(--bg-tertiary); }
.fn-args-preview { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.fn-ret-preview { display: flex; align-items: center; gap: 4px; }

/* 三级：事件流 */
.fn-call-events { border-top: 1px solid var(--border-color); padding: 8px; background: rgba(15,17,23,0.6); }

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
.var-chip-val { opacity: 0.75; font-size: 10px; margin-left: 2px; }
.var-chip-val em { font-style: normal; color: #fcd34d; }
.var-more { font-size: 11px; color: var(--text-muted); }
</style>
