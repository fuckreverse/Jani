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

        <!-- 循环列表筛选 -->
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
            <div class="loop-id">Loop #{{ loop.id }}</div>
            <div class="loop-meta">
              <span v-if="loop.line" class="loop-tag">line {{ loop.line }}</span>
              <span class="loop-tag loop-iters">{{ loop.iteration_count }} 次</span>
            </div>
            <div class="loop-seq">SEQ {{ loop.start_seq }}→{{ loop.end_seq }}</div>
          </div>
          <div v-if="pagedLoops.length === 0" class="empty-state" style="padding:16px;font-size:12px">
            无匹配循环
          </div>
        </div>

        <!-- 循环列表分页（前端） -->
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
          <div class="iter-header">
            <span class="iter-title">Loop #{{ selectedLoop.id }} · 迭代记录</span>
            <span class="iter-badge">共 {{ iterTotal }} 次</span>
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
                    <th>迭代 #</th><th>起始 SEQ</th><th>结束 SEQ</th><th>变量快照</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="iter in iterations" :key="iter.id">
                    <td class="td-seq">#{{ iter.iteration_idx }}</td>
                    <td class="td-seq">{{ iter.start_seq }}</td>
                    <td class="td-seq">{{ iter.end_seq }}</td>
                    <td>
                      <div class="snapshot-chips">
                        <span
                          v-for="(val, key) in iter.vars_snapshot"
                          :key="key"
                          class="var-chip var-write"
                          :title="`${key} = ${val}`"
                        >{{ key }}=<em>{{ truncateVal(val) }}</em></span>
                        <span v-if="Object.keys(iter.vars_snapshot).length === 0" class="text-muted">—</span>
                      </div>
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

const props = defineProps({
    sessionId: { type: String, required: true },
});

// ── 循环列表（一次性加载，前端分页） ───────────────────────────────────────
const allLoops   = ref([]);
const loopsLoading = ref(false);
const loopSearch = ref('');
const loopPage   = ref(1);
const LOOP_PAGE_SIZE = 30;

const filteredLoops = computed(() => {
    const q = loopSearch.value.trim();
    if (!q) return allLoops.value;
    return allLoops.value.filter(l =>
        String(l.line ?? '').includes(q) ||
        String(l.iteration_count ?? '').includes(q) ||
        String(l.id).includes(q)
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
const ITER_PAGE_SIZE = 100;

const iterTotalPages = computed(() => Math.max(1, Math.ceil(iterTotal.value / ITER_PAGE_SIZE)));

function truncateVal(v) {
    if (v == null) return '—';
    const s = String(v);
    return s.length > 20 ? s.slice(0, 20) + '…' : s;
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

// ── 初始加载（只加载循环列表，不加载迭代） ────────────────────────────────
async function loadLoops() {
    loopsLoading.value = true;
    try {
        // 只取循环列表，limit=1 仅为触发 API 返回 loops 字段；offset 可任意
        const res = await fetch(`/api/sessions/${props.sessionId}/loop-iterations?limit=1&offset=0`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allLoops.value = data.loops || [];
        // 默认选中第一个循环
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

/* ── 布局 ────────────────────────────────────────────────────────── */
.loops-layout {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    min-height: 400px;
}

/* ── 左侧循环列表 ──────────────────────────────────────────────────── */
.loops-sidebar {
    width: 220px;
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
.loop-id { font-size: 12px; font-weight: 700; color: #a5b4fc; font-family: monospace; }
.loop-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.loop-tag {
    display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px;
    background: rgba(99,102,241,0.1); color: var(--text-muted); font-family: monospace;
}
.loop-iters { background: rgba(34,197,94,0.1); color: #86efac; }
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

/* ── 右侧迭代面板 ──────────────────────────────────────────────────── */
.iterations-panel { flex: 1; min-width: 0; }
.iter-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
}
.iter-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.iter-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(34,197,94,0.15); color: #86efac; font-size: 11px; font-weight: 600;
}

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

/* ── 表格 ──────────────────────────────────────────────────────────── */
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
.snapshot-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.var-chip {
    display: inline-block; padding: 1px 5px; border-radius: 3px;
    font-size: 11px; font-family: monospace; margin-right: 2px;
}
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-chip em { font-style: normal; color: #fcd34d; font-size: 10px; margin-left: 2px; }
.text-muted { color: var(--text-muted); font-size: 11px; }
</style>
