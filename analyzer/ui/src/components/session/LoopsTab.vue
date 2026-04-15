<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A5 · 循环迭代展开</h2>
      <span class="section-badge">{{ allLoops.length }} 个循环</span>
      <span v-if="selectedLoop" class="section-badge badge-iter">
        共 {{ iterTotal }} 次迭代
      </span>
    </div>

    <div v-if="loopsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="allLoops.length === 0" class="empty-state">
      <p>暂无循环数据（请先运行 A5 · LoopDetector）</p>
    </div>
    <div v-else class="loops-layout">

      <!-- ── 左侧：循环列表（前端分页） ────────────────────────────────────── -->
      <div class="loops-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">循环列表</span>
          <span class="sidebar-count">{{ allLoops.length }} 个</span>
        </div>

        <!-- 筛选 -->
        <div class="sidebar-filter">
          <input
            v-model="loopSearch"
            placeholder="按行号/迭代次数过滤..."
            class="filter-input"
            @input="loopPage = 1"
          />
        </div>

        <!-- 循环列表 -->
        <div class="loop-list">
          <div
            v-for="loop in pagedLoops"
            :key="loop.id"
            class="loop-item"
            :class="{ 'loop-selected': selectedLoop?.id === loop.id }"
            @click="selectLoop(loop)"
          >
            <div class="loop-item-top">
              <span class="loop-id">Loop #{{ loop.id }}</span>
              <span v-if="loop.loop_depth > 0" class="loop-depth-badge" :title="`嵌套深度 ${loop.loop_depth}`">D{{ loop.loop_depth }}</span>
            </div>
            <div class="loop-meta">
              <span v-if="loop.line" class="loop-tag">line {{ loop.line }}</span>
              <span class="loop-tag loop-iters">{{ loop.iteration_count }} 次</span>
              <span v-if="loop.median_gap" class="loop-tag loop-gap" :title="`循环体大小约 ${loop.median_gap} events`">~{{ loop.median_gap }}ev</span>
            </div>
            <!-- 所属函数名（A3 v3 新增） -->
            <div v-if="loop.fn_name" class="loop-fn" :title="`所属函数调用帧 #${loop.call_edge_id}`">ƒ {{ loop.fn_name }}</div>
            <div v-else class="loop-fn loop-fn-toplevel" title="顶层脚本中检测到的循环">ƒ (toplevel)</div>
            <!-- 循环首行源码（A3 v2 新增） -->
            <div v-if="loop.src_text" class="loop-src">{{ truncateSrc(loop.src_text) }}</div>
            <div class="loop-seq">SEQ {{ loop.start_seq }}→{{ loop.end_seq }}</div>
          </div>
          <div v-if="pagedLoops.length === 0" class="empty-state" style="padding:16px;font-size:12px">
            无匹配循环
          </div>
        </div>

        <!-- 循环列表分页 -->
        <div v-if="filteredLoops.length > LOOP_PAGE_SIZE" class="sidebar-pagination">
          <button class="btn-page-sm" :disabled="loopPage <= 1" @click="loopPage--">‹</button>
          <span class="page-info-sm">{{ loopPage }}/{{ loopTotalPages }}</span>
          <button class="btn-page-sm" :disabled="loopPage >= loopTotalPages" @click="loopPage++">›</button>
        </div>
      </div>

      <!-- ── 右侧：迭代记录（后端分页） ─────────────────────────────────────── -->
      <div class="iterations-panel">
        <div v-if="!selectedLoop" class="empty-state" style="padding:40px">
          <p>← 从左侧选择一个循环查看迭代记录</p>
        </div>
        <template v-else>

          <!-- ── 循环信息横幅（src_text + 函数归属）─────────────────────────── -->
          <div class="loop-src-banner">
            <span class="loop-src-label">源码</span>
            <code class="loop-src-code">{{ selectedLoop.src_text || '（无源码映射）' }}</code>
            <span class="loop-src-loc">
              <span v-if="selectedLoop.line" class="loop-src-line">L{{ selectedLoop.line }}</span>
              <span v-if="selectedLoop.loop_depth > 0" class="loop-src-depth">嵌套 {{ selectedLoop.loop_depth }}</span>
              <!-- 函数归属（v3 新增） -->
              <span
                v-if="selectedLoop.fn_name"
                class="loop-src-fn"
                :title="`所属函数调用帧 id=${selectedLoop.call_edge_id}`"
              >ƒ {{ selectedLoop.fn_name }}</span>
              <span v-else class="loop-src-fn loop-src-fn-top" title="顶层脚本中检测到的循环">ƒ (toplevel)</span>
              <button
                class="btn-goto-src"
                title="跳转到事件流查看此循环起始位置"
                @click="$emit('goto-seq', selectedLoop.start_seq)"
              >⇢ 事件流</button>
            </span>
          </div>

          <div class="iter-header">
            <span class="iter-title">Loop #{{ selectedLoop.id }} · 迭代记录</span>
            <span class="iter-badge">共 {{ iterTotal }} 次</span>
            <!-- diff 高亮开关 -->
            <button
              class="mode-tab"
              :class="{ 'mode-active': diffMode }"
              @click="diffMode = !diffMode"
              title="开启后：与上一次迭代相比，发生变化的变量高亮（橙色边框），未变化的淡化"
            >Δ diff</button>
            <!-- 快照视图切换 -->
            <div class="snapshot-mode-tabs">
              <button
                class="mode-tab"
                :class="{ 'mode-active': snapshotMode === 'write' }"
                @click="snapshotMode = 'write'"
                title="仅显示变量写入值"
              >写</button>
              <button
                class="mode-tab"
                :class="{ 'mode-active': snapshotMode === 'read' }"
                @click="snapshotMode = 'read'"
                title="仅显示变量读取值"
              >读</button>
              <button
                class="mode-tab"
                :class="{ 'mode-active': snapshotMode === 'both' }"
                @click="snapshotMode = 'both'"
                title="同时显示读/写"
              >读+写</button>
            </div>
            <!-- 变量名过滤 -->
            <input
              v-model="varFilter"
              placeholder="过滤变量名..."
              class="var-filter-input"
              title="输入变量名关键字过滤快照"
            />
          </div>

          <div v-if="iterLoading" class="loading" style="padding:20px">
            <div class="spinner"></div><span>加载迭代...</span>
          </div>
          <div v-else-if="iterations.length === 0" class="empty-state" style="padding:20px">
            暂无迭代数据
          </div>
          <div v-else>
            <div class="events-table-wrapper">
              <table class="events-table">
                <thead>
                  <tr>
                    <th>迭代 #</th><th>起始 SEQ</th><th>结束 SEQ</th><th>变量快照</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(iter, rowIdx) in iterations" :key="iter.id">
                    <td class="td-seq">#{{ iter.iteration_idx }}</td>
                    <td class="td-seq">{{ iter.start_seq }}</td>
                    <td class="td-seq">{{ iter.end_seq }}</td>
                    <td>
                      <div class="snapshot-chips">
                        <!-- v2 新格式：区分写（w）和读（r） -->
                        <template v-if="isV2Snapshot(iter.vars_snapshot)">
                          <!-- 写快照（绿色） -->
                          <template v-if="snapshotMode !== 'read'">
                            <span
                              v-for="(val, key) in filteredWrites(iter)"
                              :key="'w:' + key"
                              class="var-chip var-write var-chip-expandable"
                              :class="chipDiffClass('w', key, val, rowIdx)"
                              title="写入值 — 点击查看完整值"
                              @click.stop="openValueViewer(val, key + ' [write]')"
                            >{{ key }}=<em>{{ truncateVal(val) }}</em></span>
                          </template>
                          <!-- 读快照（蓝色） -->
                          <template v-if="snapshotMode !== 'write'">
                            <span
                              v-for="(val, key) in filteredReads(iter)"
                              :key="'r:' + key"
                              class="var-chip var-read var-chip-expandable"
                              :class="chipDiffClass('r', key, val, rowIdx)"
                              title="读取值 — 点击查看完整值"
                              @click.stop="openValueViewer(val, key + ' [read]')"
                            >{{ key }}<span class="read-mark">r</span>=<em>{{ truncateVal(val) }}</em></span>
                          </template>
                          <span
                            v-if="noVisibleVars(iter)"
                            class="text-muted"
                          >—</span>
                        </template>
                        <!-- v1 旧格式（兼容）：纯写快照 -->
                        <template v-else>
                          <span
                            v-for="(val, key) in filteredLegacy(iter)"
                            :key="key"
                            class="var-chip var-write var-chip-expandable"
                            :class="legacyChipDiffClass(key, val, rowIdx)"
                            title="点击查看完整值"
                            @click.stop="openValueViewer(val, key)"
                          >{{ key }}=<em>{{ truncateVal(val) }}</em></span>
                          <span v-if="Object.keys(iter.vars_snapshot || {}).length === 0" class="text-muted">—</span>
                        </template>
                      </div>
                    </td>
                    <!-- 跳转到事件流 -->
                    <td class="td-action">
                      <button
                        class="btn-goto-iter"
                        title="跳转到事件流查看此次迭代（起始 SEQ）"
                        @click="$emit('goto-seq', iter.start_seq)"
                      >⇢</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 迭代分页（后端） -->
            <div v-if="iterTotal > ITER_PAGE_SIZE" class="iter-pagination">
              <span class="page-info">第 {{ iterPage }} / {{ iterTotalPages }} 页 · 共 {{ iterTotal }} 条</span>
              <div class="page-nav">
                <button class="btn-page btn-secondary" :disabled="iterPage <= 1" @click="gotoIterPage(1)">«</button>
                <button class="btn-page btn-secondary" :disabled="iterPage <= 1" @click="gotoIterPage(iterPage - 1)">‹ 上一页</button>
                <button class="btn-page btn-secondary" :disabled="iterPage >= iterTotalPages" @click="gotoIterPage(iterPage + 1)">下一页 ›</button>
                <button class="btn-page btn-secondary" :disabled="iterPage >= iterTotalPages" @click="gotoIterPage(iterTotalPages)">»</button>
              </div>
              <div class="page-jump">
                <input v-model.number="iterJump" type="number" :min="1" :max="iterTotalPages" class="page-jump-input" @keyup.enter="doIterJump" />
                <button class="btn-page btn-secondary" @click="doIterJump">GO</button>
              </div>
            </div>
          </div>
        </template>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { openValueViewer } from '../../composables/useValueViewer.js';
import { useConfig } from '../../composables/useConfig.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

defineEmits(['goto-seq']);

const { api: apiCfg } = useConfig();

// ── 循环列表（一次性加载，前端分页） ───────────────────────────────────────
const allLoops   = ref([]);
const loopsLoading = ref(false);
const loopSearch = ref('');
const loopPage   = ref(1);
const LOOP_PAGE_SIZE  = Math.min(apiCfg.value.defaultPageSize ?? 30, 50);

const filteredLoops = computed(() => {
    const q = loopSearch.value.trim();
    if (!q) return allLoops.value;
    return allLoops.value.filter(l =>
        String(l.line ?? '').includes(q) ||
        String(l.iteration_count ?? '').includes(q) ||
        String(l.id).includes(q) ||
        (l.src_text ?? '').includes(q) ||
        (l.fn_name ?? '').includes(q)
    );
});

const loopTotalPages = computed(() => Math.max(1, Math.ceil(filteredLoops.value.length / LOOP_PAGE_SIZE)));
const pagedLoops = computed(() => {
    const start = (loopPage.value - 1) * LOOP_PAGE_SIZE;
    return filteredLoops.value.slice(start, start + LOOP_PAGE_SIZE);
});

// ── 选中循环 + 迭代记录（后端分页） ──────────────────────────────────────
const selectedLoop = ref(null);
const iterations   = ref([]);
const iterTotal    = ref(0);
const iterPage     = ref(1);
const iterJump     = ref(1);
const iterLoading  = ref(false);
const ITER_PAGE_SIZE  = apiCfg.value.defaultPageSize ?? 100;

// ── 快照展示控制 ──────────────────────────────────────────────────────────
/** 'write' | 'read' | 'both' */
const snapshotMode = ref('both');
/** 变量名过滤关键字 */
const varFilter    = ref('');
/** 跨迭代 diff 高亮开关（默认开启） */
const diffMode     = ref(true);

const iterTotalPages = computed(() => Math.max(1, Math.ceil(iterTotal.value / ITER_PAGE_SIZE)));

function truncateVal(v) {
    if (v == null) return '—';
    const s = String(v);
    return s.length > 20 ? s.slice(0, 20) + '…' : s;
}

function truncateSrc(s) {
    if (!s) return '';
    const trimmed = s.trim();
    return trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
}

// ── v2 快照格式判断与辅助函数 ────────────────────────────────────────────

/** 判断是否为 v2 格式（含 v/w/r 字段） */
function isV2Snapshot(snap) {
    return snap != null && typeof snap === 'object' && snap.v === 2;
}

// ── 过滤快照（computed 批量缓存，避免 v-for 内每行多次重建对象）──────────────
//
// filteredSnapshots: Map<iterationId, { w: object, r: object, legacy: object }>
// 依赖：iterations + varFilter。变量名过滤或翻页时才重算（整页一次），渲染时直接查 Map。

const filteredSnapshots = computed(() => {
    const q   = varFilter.value.trim().toLowerCase();
    const map = new Map();
    for (const iter of iterations.value) {
        const snap = iter.vars_snapshot;
        if (isV2Snapshot(snap)) {
            const rawW = snap.w ?? {};
            const rawR = snap.r ?? {};
            const w = q
                ? Object.fromEntries(Object.entries(rawW).filter(([k]) => k.toLowerCase().includes(q)))
                : rawW;
            const r = q
                ? Object.fromEntries(Object.entries(rawR).filter(([k]) => k.toLowerCase().includes(q)))
                : rawR;
            map.set(iter.id, { w, r, legacy: null });
        } else if (snap && typeof snap === 'object') {
            const legacy = q
                ? Object.fromEntries(Object.entries(snap).filter(([k]) => k.toLowerCase().includes(q)))
                : snap;
            map.set(iter.id, { w: null, r: null, legacy });
        } else {
            map.set(iter.id, { w: {}, r: {}, legacy: {} });
        }
    }
    return map;
});

/** 从缓存获取写快照（v-for 内调用，O(1)） */
function filteredWrites(iter) {
    return filteredSnapshots.value.get(iter.id)?.w ?? {};
}

/** 从缓存获取读快照（v-for 内调用，O(1)） */
function filteredReads(iter) {
    return filteredSnapshots.value.get(iter.id)?.r ?? {};
}

/** 从缓存获取旧格式快照（v-for 内调用，O(1)） */
function filteredLegacy(iter) {
    return filteredSnapshots.value.get(iter.id)?.legacy ?? {};
}

/** 在当前 snapshotMode + varFilter 下是否有可见变量（从缓存读取） */
function noVisibleVars(iter) {
    if (!isV2Snapshot(iter.vars_snapshot)) return false;
    const cached = filteredSnapshots.value.get(iter.id);
    if (!cached) return true;
    const hasW = snapshotMode.value !== 'read'  && Object.keys(cached.w ?? {}).length > 0;
    const hasR = snapshotMode.value !== 'write' && Object.keys(cached.r ?? {}).length > 0;
    return !hasW && !hasR;
}

// ── 跨迭代 diff 高亮（不足4）────────────────────────────────────────────
//
// 思路：对当前页每一行，与上一行（rowIdx-1）同 key 的值做对比。
//   - rowIdx === 0：无上一行参照，所有 chip 正常显示（无 diff 标记）。
//   - 后续行：
//       值发生变化  → chip-diff-changed（橙色边框：此变量本次迭代有变化）
//       值未变化    → chip-dim（灰化淡出：此变量本次迭代无变化，可忽略）
//       上一行不存在此变量 → chip-diff-new（蓝色边框：新出现的变量）
//
// diff 仅在当前页可见的相邻两行间比较（不跨页）。

/**
 * v2 快照的 diff class。
 * @param {'w'|'r'} section - 'w' 写 或 'r' 读
 * @param {string}  key     - 变量名
 * @param {*}       val     - 当前值
 * @param {number}  rowIdx  - 当前行在 iterations 数组中的下标
 */
function chipDiffClass(section, key, val, rowIdx) {
    if (!diffMode.value || rowIdx === 0) return '';
    const prevSnap = iterations.value[rowIdx - 1]?.vars_snapshot;
    if (!isV2Snapshot(prevSnap)) return '';
    const prevVal = prevSnap[section]?.[key];
    if (prevVal === undefined) return 'chip-diff-new';
    return String(val) !== String(prevVal) ? 'chip-diff-changed' : 'chip-dim';
}

/**
 * 旧格式（v1）的 diff class。
 */
function legacyChipDiffClass(key, val, rowIdx) {
    if (!diffMode.value || rowIdx === 0) return '';
    const prevSnap = iterations.value[rowIdx - 1]?.vars_snapshot;
    if (!prevSnap || isV2Snapshot(prevSnap)) return '';
    const prevVal = prevSnap[key];
    if (prevVal === undefined) return 'chip-diff-new';
    return String(val) !== String(prevVal) ? 'chip-diff-changed' : 'chip-dim';
}

async function selectLoop(loop) {
    selectedLoop.value = loop;
    iterPage.value = 1;
    iterJump.value = 1;
    iterations.value = [];
    iterTotal.value = 0;
    await loadIterations();
}

async function loadIterations() {
    if (!selectedLoop.value) return;
    iterLoading.value = true;
    try {
        const offset = (iterPage.value - 1) * ITER_PAGE_SIZE;
        const params = new URLSearchParams({
            loopId: selectedLoop.value.id,
            limit:  ITER_PAGE_SIZE,
            offset,
        });
        const res = await fetch(`/api/sessions/${props.sessionId}/loop-iterations?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        iterations.value = data.iterations || [];
        iterTotal.value  = data.total ?? iterations.value.length;
    } catch (e) {
        console.error('loadIterations error:', e);
    } finally {
        iterLoading.value = false;
    }
}

async function gotoIterPage(p) {
    const clamped = Math.max(1, Math.min(iterTotalPages.value, p));
    if (clamped === iterPage.value) return;
    iterPage.value  = clamped;
    iterJump.value  = clamped;
    await loadIterations();
}

function doIterJump() {
    gotoIterPage(Math.round(iterJump.value) || 1);
}

// ── 初始加载（只加载循环列表） ────────────────────────────────────────────
async function loadLoops() {
    loopsLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/loop-iterations?loopsOnly=1`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allLoops.value = data.loops || [];
        if (allLoops.value.length > 0) {
            await selectLoop(allLoops.value[0]);
        }
    } catch (e) {
        console.error('loadLoops error:', e);
    } finally {
        loopsLoading.value = false;
    }
}

defineExpose({ reload: loadLoops });

onMounted(loadLoops);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.badge-iter { background: rgba(34,197,94,0.15); color: #86efac; }

/* ── 布局 ────────────────────────────────────────────────────── */
.loops-layout {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    min-height: 400px;
}

/* ── 左侧循环列表 ──────────────────────────────────────────────── */
.loops-sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    overflow: hidden;
}
.sidebar-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
}
.sidebar-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.sidebar-count { font-size: 11px; color: var(--text-muted); }
.sidebar-filter { padding: 6px 8px; border-bottom: 1px solid var(--border-color); }
.filter-input {
    width: 100%; padding: 4px 8px; font-size: 11px;
    border: 1px solid var(--border-color); border-radius: 4px;
    background: var(--bg-primary); color: var(--text-primary);
    box-sizing: border-box;
}
.filter-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.loop-list { flex: 1; overflow-y: auto; max-height: 520px; }
.loop-item {
    padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(45,49,72,0.4);
    transition: background 0.1s;
}
.loop-item:hover { background: var(--bg-tertiary); }
.loop-selected { background: rgba(99,102,241,0.12) !important; border-left: 3px solid #a5b4fc; padding-left: 9px; }

.loop-item-top {
    display: flex; align-items: center; gap: 6px;
}
.loop-id { font-size: 12px; font-weight: 700; color: #a5b4fc; font-family: monospace; }
.loop-depth-badge {
    display: inline-block; padding: 0 4px; border-radius: 3px;
    font-size: 10px; background: rgba(251,146,60,0.15); color: #fb923c;
    font-family: monospace;
}
.loop-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.loop-tag {
    display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px;
    background: rgba(99,102,241,0.1); color: var(--text-muted); font-family: monospace;
}
.loop-iters { background: rgba(34,197,94,0.1); color: #86efac; }
.loop-gap   { background: rgba(167,139,250,0.1); color: #c4b5fd; }
/* 函数名标签（v3 新增） */
.loop-fn {
    font-size: 10px; color: #67e8f9; margin-top: 2px;
    font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    opacity: 0.85;
}
.loop-fn-toplevel { color: var(--text-muted); opacity: 0.5; }
.loop-src {
    font-size: 10px; color: var(--text-muted); margin-top: 3px;
    font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    opacity: 0.75;
}
.loop-seq { font-size: 10px; color: var(--text-muted); margin-top: 2px; font-family: monospace; }

/* 侧边栏分页 */
.sidebar-pagination {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 6px; border-top: 1px solid var(--border-color);
    background: var(--bg-tertiary);
}
.btn-page-sm {
    padding: 2px 8px; border-radius: 4px; font-size: 12px;
    border: 1px solid var(--border-color); background: var(--bg-secondary);
    color: var(--text-primary); cursor: pointer;
}
.btn-page-sm:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-page-sm:hover:not(:disabled) { background: var(--bg-tertiary); }
.page-info-sm { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

/* ── 右侧迭代面板 ──────────────────────────────────────────────── */
.iterations-panel { flex: 1; min-width: 0; }
.iter-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap;
}
.iter-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.iter-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(34,197,94,0.15); color: #86efac; font-size: 11px; font-weight: 600;
}

/* 快照模式切换 */
.snapshot-mode-tabs {
    display: flex; border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden;
    flex-shrink: 0;
}
.mode-tab {
    padding: 3px 10px; font-size: 11px; cursor: pointer;
    border: none; background: transparent; color: var(--text-muted);
    transition: all 0.12s;
}
.mode-tab:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.mode-active {
    background: rgba(99,102,241,0.2) !important;
    color: #a5b4fc !important;
}

/* 变量名过滤输入 */
.var-filter-input {
    padding: 3px 8px; font-size: 11px; border-radius: 4px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
    width: 120px;
}
.var-filter-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }

/* 迭代分页 */
.iter-pagination {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--border-color); flex-wrap: wrap;
}
.page-info { font-size: 12px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; }
.page-nav { display: flex; gap: 4px; }
.page-jump { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.page-jump-input {
    width: 52px; height: 28px; padding: 0 6px; font-size: 12px; text-align: center;
    border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
}
.page-jump-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.btn-page {
    min-width: 32px; height: 28px; padding: 0 8px; font-size: 12px;
    border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
    cursor: pointer; transition: background 0.12s; white-space: nowrap; line-height: 1;
}
.btn-page:hover:not(:disabled) { background: var(--bg-tertiary); border-color: rgba(99,102,241,0.4); }
.btn-page:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-secondary { /* 与全局一致 */ }

/* ── 表格 ──────────────────────────────────────────────────────── */
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

/* 快照 chips */
.snapshot-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.var-chip {
    display: inline-flex; align-items: center; padding: 1px 5px; border-radius: 3px;
    font-size: 11px; font-family: monospace; margin-right: 2px;
}
/* 写快照：绿色 */
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
/* 读快照：蓝色 */
.var-read  { background: rgba(56,189,248,0.12); color: #7dd3fc; }
.var-chip em { font-style: normal; color: #fcd34d; font-size: 10px; margin-left: 2px; }
.var-chip-expandable { cursor: pointer; }
.var-chip-expandable:hover { filter: brightness(1.2); outline: 1px solid rgba(255,255,255,0.15); }

/* 读标记角标 */
.read-mark {
    display: inline-block; font-size: 9px; color: #7dd3fc;
    margin: 0 1px; opacity: 0.7; font-style: italic;
}

.text-muted { color: var(--text-muted); font-size: 11px; }

/* ── 循环源码横幅（src_text 关联）────────────────────────────────── */
.loop-src-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    margin-bottom: 10px;
    background: rgba(20, 20, 40, 0.5);
    border: 1px solid rgba(99,102,241,0.22);
    border-radius: 6px;
    flex-wrap: wrap;
    min-width: 0;
}
.loop-src-label {
    font-size: 10px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em;
    flex-shrink: 0; white-space: nowrap;
}
.loop-src-code {
    flex: 1; min-width: 0;
    font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12px; color: #c4b5fd;
    white-space: pre; overflow: hidden; text-overflow: ellipsis;
    background: none; padding: 0; border: none;
}
.loop-src-loc {
    display: flex; align-items: center; gap: 6px;
    flex-shrink: 0; white-space: nowrap;
}
.loop-src-line {
    font-size: 11px; color: var(--text-muted); font-family: monospace;
}
.loop-src-depth {
    font-size: 10px; padding: 1px 5px; border-radius: 3px;
    background: rgba(251,146,60,0.12); color: #fb923c; font-family: monospace;
}
/* 函数归属标签（横幅内，v3 新增） */
.loop-src-fn {
    font-size: 11px; font-family: monospace;
    padding: 1px 6px; border-radius: 3px;
    background: rgba(103,232,249,0.12); color: #67e8f9;
    white-space: nowrap; flex-shrink: 0;
}
.loop-src-fn-top {
    background: rgba(100,116,139,0.12); color: var(--text-muted);
}

.btn-goto-src {
    padding: 2px 8px; font-size: 11px; border-radius: 4px;
    border: 1px solid rgba(99,102,241,0.3);
    background: rgba(99,102,241,0.08); color: #a5b4fc;
    cursor: pointer; white-space: nowrap; transition: all 0.12s; line-height: 1.6;
}
.btn-goto-src:hover {
    background: rgba(99,102,241,0.2); color: #c7d2fe;
    border-color: rgba(99,102,241,0.5);
}

/* ── diff 高亮 chips（不足4）────────────────────────────────────── */
/* 变化的变量：橙色边框高亮，加粗 */
.chip-diff-changed {
    outline: 1px solid rgba(251,146,60,0.7) !important;
    background: rgba(251,146,60,0.18) !important;
    color: #fed7aa !important;
}
.chip-diff-changed em { color: #fb923c !important; }

/* 新出现的变量（上一行无此变量）：蓝色边框 */
.chip-diff-new {
    outline: 1px solid rgba(99,102,241,0.6) !important;
    background: rgba(99,102,241,0.18) !important;
    color: #c7d2fe !important;
}
.chip-diff-new em { color: #a5b4fc !important; }

/* 未变化的变量：淡化 */
.chip-dim {
    opacity: 0.28;
    filter: grayscale(40%);
}
.chip-dim:hover { opacity: 0.8; filter: none; }

/* ── 跳转操作列 ──────────────────────────────────────────────────── */
.td-action {
    width: 28px; padding: 4px 6px !important;
    text-align: center; vertical-align: middle;
}
.btn-goto-iter {
    padding: 2px 6px; font-size: 12px; line-height: 1;
    border: 1px solid rgba(99,102,241,0.25);
    border-radius: 4px; background: transparent;
    color: var(--text-muted); cursor: pointer;
    transition: all 0.12s; opacity: 0;
}
.events-table tr:hover .btn-goto-iter { opacity: 1; }
.btn-goto-iter:hover {
    background: rgba(99,102,241,0.15);
    color: #a5b4fc; border-color: rgba(99,102,241,0.5);
    opacity: 1;
}
</style>
