<template>
  <div class="trace-diff">
    <div class="page-header">
      <div>
        <h1 class="page-title">🔍 Trace 对照分析</h1>
        <p class="page-subtitle">选择 2–8 个会话，对比其执行行为的差异，快速定位噪音与核心分歧</p>
      </div>
    </div>

    <!-- Session 选择区 -->
    <div class="card session-picker">
      <div class="picker-header">
        <span class="section-title" style="margin-bottom:0">选择对比会话</span>
        <div class="picker-actions">
          <button class="btn-secondary" @click="clearAll">清空</button>
          <button class="btn-primary" :disabled="selectedIds.length < 2 || loading" @click="runCompare">
            {{ loading ? '⏳ 对比中...' : '▶ 开始对比' }}
          </button>
        </div>
      </div>

      <!-- 已选列表 -->
      <div class="selected-list" v-if="selectedIds.length > 0">
        <div
          v-for="(sid, idx) in selectedIds"
          :key="sid"
          class="selected-tag"
          :class="`session-color-${idx}`"
        >
          <span class="session-label">S{{ idx + 1 }}</span>
          <span class="session-name">{{ sessionNames[sid] || sid.slice(0, 12) + '...' }}</span>
          <button class="remove-btn" @click="removeSession(sid)" title="移除">✕</button>
        </div>
        <div v-if="selectedIds.length < 8" class="add-hint">点击下方列表添加（最多 8 个）</div>
      </div>
      <div v-else class="empty-state" style="padding:16px">
        请从下方会话列表中选择至少 2 个会话进行对比
      </div>

      <!-- 会话列表 -->
      <div class="session-pool">
        <div v-if="loadingSessions" class="loading"><div class="spinner"></div><span>加载会话列表...</span></div>
        <div v-else-if="sessions.length === 0" class="empty-state">暂无会话</div>
        <div
          v-else
          v-for="s in sessions"
          :key="s.id"
          class="pool-item"
          :class="{ selected: selectedIds.includes(s.id), disabled: !selectedIds.includes(s.id) && selectedIds.length >= 8 }"
          @click="toggleSession(s)"
          :title="s.id"
        >
          <span class="pool-check">{{ selectedIds.includes(s.id) ? '✓' : '+' }}</span>
          <div class="pool-info">
            <div class="pool-name">{{ s.name }}</div>
            <div class="pool-meta">{{ formatDate(s.created_at) }} · {{ s.event_count?.toLocaleString() }} events</div>
          </div>
          <div v-if="selectedIds.includes(s.id)" class="pool-idx">S{{ selectedIds.indexOf(s.id) + 1 }}</div>
        </div>
      </div>
    </div>

    <!-- 对比结果区 -->
    <div v-if="result" class="compare-result">
      <!-- Tab 导航 -->
      <div class="tab-nav card" style="margin-bottom:16px">
        <button
          v-for="tab in compareTabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ 'tab-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
          <span v-if="isTabLoading(tab.id)" class="tab-loading">⏳</span>
          <span v-else-if="tabLoaded[tab.id]" class="tab-done">✓</span>
        </button>
      </div>

      <!-- ─── Tab 1: 整体指标 ─── -->
      <div v-show="activeTab === 'overview'" class="tab-content">
        <div class="overview-grid">
          <div
            v-for="(s, idx) in result.sessions"
            :key="s.sessionId"
            class="overview-card card"
            :class="`session-border-${idx}`"
          >
            <div class="overview-title">
              <span class="session-badge" :class="`session-color-${idx}`">S{{ idx + 1 }}</span>
              {{ s.name }}
            </div>
            <div class="metric-list">
              <div class="metric-row">
                <span class="metric-label">事件总数</span>
                <span class="metric-val">{{ s.eventCount?.toLocaleString() }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">不同函数数</span>
                <span class="metric-val">{{ s.fnCount }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">函数调用次数</span>
                <span class="metric-val">{{ s.callCount?.toLocaleString() }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">循环数量</span>
                <span class="metric-val">{{ s.loopCount }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">总迭代次数</span>
                <span class="metric-val">{{ s.totalIters?.toLocaleString() }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">最大调用深度</span>
                <span class="metric-val">{{ s.maxDepth }}</span>
              </div>
            </div>
            <!-- Top-5 热点 -->
            <div v-if="s.hotIids?.length" class="hot-iids">
              <div class="hot-title">Top-5 热点</div>
              <div v-for="h in s.hotIids" :key="h.iid" class="hot-row">
                <span class="hot-line">L{{ h.line }}</span>
                <span class="hot-src">{{ truncate(h.src_text, 28) }}</span>
                <span class="hot-count">×{{ h.count?.toLocaleString() }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 分歧摘要 -->
        <div v-if="result.divergence?.length" class="divergence-summary card">
          <div class="section-title">⚡ 与 S1 的分歧</div>
          <div v-for="(d, idx) in result.divergence" :key="d.sessionId" class="div-row">
            <span class="session-badge" :class="`session-color-${idx+1}`">S{{ idx + 2 }}</span>
            <span class="div-name">{{ d.name }}</span>
            <span :class="deltaClass(d.deltaEvents)">事件 {{ deltaStr(d.deltaEvents) }}</span>
            <span :class="deltaClass(d.deltaFns)">函数 {{ deltaStr(d.deltaFns) }}</span>
            <span :class="deltaClass(d.deltaCalls)">调用 {{ deltaStr(d.deltaCalls) }}</span>
            <span :class="deltaClass(d.deltaLoops)">循环 {{ deltaStr(d.deltaLoops) }}</span>
            <span :class="deltaClass(d.deltaIters)">迭代 {{ deltaStr(d.deltaIters) }}</span>
          </div>
        </div>
      </div>

      <!-- ─── Tab 2: 函数分布 ─── -->
      <div v-show="activeTab === 'functions'" class="tab-content">
        <div class="fn-toolbar card" style="margin-bottom:8px; padding:10px 16px; display:flex; gap:12px; align-items:center">
          <label style="margin:0; display:flex; align-items:center; gap:6px; cursor:pointer">
            <input type="checkbox" v-model="showOnlyDivergent" />
            只显示分歧函数
          </label>
          <span class="text-muted">共 {{ fnResult?.totalFns ?? 0 }} 个函数，{{ fnResult?.divergentFns ?? 0 }} 个有分歧</span>
          <button class="btn-secondary" style="margin-left:auto" @click="loadFunctions">
            {{ loadingFns ? '⏳ 加载中...' : '🔄 刷新' }}
          </button>
        </div>
        <div class="compare-table-wrap">
          <table class="compare-table" v-if="fnResult">
            <thead>
              <tr>
                <th style="width:220px">函数名</th>
                <th style="width:60px">分歧</th>
                <th
                  v-for="(name, idx) in fnResult.sessionNames"
                  :key="idx"
                  class="session-th"
                  :class="`session-th-${idx}`"
                >
                  <span class="session-badge sm" :class="`session-color-${idx}`">S{{ idx + 1 }}</span>
                  {{ name }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in filteredFunctions"
                :key="row.fnName"
                :class="{ 'row-divergent': row.isDivergent }"
              >
                <td class="fn-name-cell" :title="row.fnName">{{ row.fnName }}</td>
                <td class="divergent-cell">
                  <span v-if="row.isDivergent" class="divergent-badge">⚡ {{ row.maxDeltaPct.toFixed(0) }}%</span>
                </td>
                <td
                  v-for="(sid, idx) in selectedIds"
                  :key="sid"
                  class="metric-cell"
                  :class="getCellClass(row, sid, idx)"
                >
                  <span v-if="row.sessions[sid]">
                    <span class="call-count">{{ row.sessions[sid].callCount?.toLocaleString() }}</span>
                    <span class="event-count-sm text-muted"> / {{ row.sessions[sid].eventCount?.toLocaleString() }}</span>
                  </span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
              <tr v-if="filteredFunctions.length === 0">
                <td :colspan="2 + selectedIds.length" style="text-align:center; padding:24px; color:var(--text-muted)">无结果</td>
              </tr>
            </tbody>
          </table>
          <div v-else-if="loadingFns" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        </div>
      </div>

      <!-- ─── Tab 3: 热点 IID ─── -->
      <div v-show="activeTab === 'hot-iids'" class="tab-content">
        <div class="fn-toolbar card" style="margin-bottom:8px; padding:10px 16px; display:flex; gap:12px; align-items:center">
          <label style="margin:0; display:flex; align-items:center; gap:6px; cursor:pointer">
            <input type="checkbox" v-model="showOnlyDivergentIid" />
            只显示分歧 IID
          </label>
          <span class="text-muted">{{ iidResult?.totalIids ?? 0 }} 个热点，{{ iidResult?.divergentIids ?? 0 }} 个有分歧</span>
          <button class="btn-secondary" style="margin-left:auto" @click="loadHotIids">
            {{ loadingIids ? '⏳ 加载中...' : '🔄 刷新' }}
          </button>
        </div>
        <div class="compare-table-wrap">
          <table class="compare-table" v-if="iidResult">
            <thead>
              <tr>
                <th style="width:60px">行号</th>
                <th style="width:200px">源码片段</th>
                <th style="width:60px">分歧</th>
                <th
                  v-for="(name, idx) in iidResult.sessionNames"
                  :key="idx"
                  class="session-th"
                  :class="`session-th-${idx}`"
                >
                  <span class="session-badge sm" :class="`session-color-${idx}`">S{{ idx + 1 }}</span>
                  {{ name }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in filteredIids"
                :key="row.iid"
                :class="{ 'row-divergent': row.isDivergent }"
              >
                <td class="line-cell">L{{ row.line ?? '?' }}</td>
                <td class="src-cell" :title="row.srcText">{{ truncate(row.srcText, 32) }}</td>
                <td class="divergent-cell">
                  <span v-if="row.isDivergent" class="divergent-badge">⚡ {{ row.maxDeltaPct?.toFixed(0) }}%</span>
                </td>
                <td
                  v-for="(sid, idx) in selectedIds"
                  :key="sid"
                  class="metric-cell"
                  :class="getIidCellClass(row, sid, idx)"
                >
                  <span v-if="row.sessions[sid]">{{ row.sessions[sid].count?.toLocaleString() }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
              <tr v-if="filteredIids.length === 0">
                <td :colspan="3 + selectedIds.length" style="text-align:center; padding:24px; color:var(--text-muted)">无结果</td>
              </tr>
            </tbody>
          </table>
          <div v-else-if="loadingIids" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        </div>
      </div>

      <!-- ─── Tab 4: 事件类型分布 ─── -->
      <div v-show="activeTab === 'events'" class="tab-content">
        <div class="compare-table-wrap">
          <table class="compare-table" v-if="eventsResult">
            <thead>
              <tr>
                <th style="width:120px">事件类型</th>
                <th
                  v-for="(name, idx) in eventsResult.sessionNames"
                  :key="idx"
                  class="session-th"
                  :class="`session-th-${idx}`"
                >
                  <span class="session-badge sm" :class="`session-color-${idx}`">S{{ idx + 1 }}</span>
                  {{ name }}
                </th>
              </tr>
              <tr class="total-row">
                <td>总计</td>
                <td v-for="t in eventsResult.totals" :key="t.sessionId" class="metric-cell">
                  {{ t.total?.toLocaleString() }}
                </td>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in eventsResult.rows"
                :key="row.type"
              >
                <td>{{ decodeEventType(row.type) }}</td>
                <td
                  v-for="(sid, idx) in selectedIds"
                  :key="sid"
                  class="metric-cell"
                >
                  <span v-if="row.sessions[sid]">
                    {{ row.sessions[sid].count?.toLocaleString() }}
                    <span class="pct-badge">{{ row.sessions[sid].pct }}%</span>
                  </span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="loading"><div class="spinner"></div><span>加载中...</span></div>
        </div>
      </div>

      <!-- ─── Tab 5: 循环对比 ─── -->
      <div v-show="activeTab === 'loops'" class="tab-content">
        <div class="compare-table-wrap">
          <table class="compare-table" v-if="loopsResult">
            <thead>
              <tr>
                <th style="width:60px">行号</th>
                <th style="width:60px">IID</th>
                <th style="width:60px">分歧</th>
                <th
                  v-for="(name, idx) in loopsResult.sessionNames"
                  :key="idx"
                  class="session-th"
                  :class="`session-th-${idx}`"
                >
                  <span class="session-badge sm" :class="`session-color-${idx}`">S{{ idx + 1 }}</span>
                  {{ name }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in loopsResult.loops"
                :key="row.iid"
                :class="{ 'row-divergent': row.isDivergent }"
              >
                <td class="line-cell">L{{ row.line ?? '?' }}</td>
                <td class="iid-cell">{{ row.iid }}</td>
                <td class="divergent-cell">
                  <span v-if="row.isDivergent" class="divergent-badge">⚡</span>
                </td>
                <td
                  v-for="(sid, idx) in selectedIds"
                  :key="sid"
                  class="metric-cell"
                  :class="getLoopCellClass(row, sid, idx)"
                >
                  <span v-if="row.sessions[sid]">{{ row.sessions[sid].totalIters?.toLocaleString() }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
              <tr v-if="loopsResult.loops.length === 0">
                <td :colspan="3 + selectedIds.length" style="text-align:center; padding:24px; color:var(--text-muted)">无循环数据（需先运行 A5 LoopDetector）</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="loading"><div class="spinner"></div><span>加载中...</span></div>
        </div>
      </div>
    </div>

    <!-- 错误 -->
    <div v-if="error" class="error-state card" style="margin-top:16px">❌ {{ error }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';

// ── 状态 ──────────────────────────────────────────────────────────────────

const sessions        = ref([]);
const sessionNames    = ref({}); // id → name
const loadingSessions = ref(false);
const selectedIds     = ref([]);

// 每个 Tab 独立 loading 状态（流式渲染：谁先到先显示）
const loadingOverview = ref(false);
const loadingFns      = ref(false);
const loadingIids     = ref(false);
const loadingEvents   = ref(false);
const loadingLoops    = ref(false);

// 是否在运行对比（至少一个 Tab 还在加载）
const loading = computed(() =>
    loadingOverview.value || loadingFns.value || loadingIids.value ||
    loadingEvents.value   || loadingLoops.value
);

const error = ref('');

const activeTab = ref('overview');
const compareTabs = [
    { id: 'overview',  label: '📊 整体指标' },
    { id: 'functions', label: '🔧 函数分布' },
    { id: 'hot-iids',  label: '🔥 热点 IID' },
    { id: 'events',    label: '📋 事件类型' },
    { id: 'loops',     label: '🔄 循环对比' },
];

const result        = ref(null);  // /api/compare/sessions 结果
const fnResult      = ref(null);  // /api/compare/functions 结果
const iidResult     = ref(null);  // /api/compare/hot-iids 结果
const eventsResult  = ref(null);  // /api/compare/events 结果
const loopsResult   = ref(null);  // /api/compare/loops 结果

const showOnlyDivergent    = ref(false);
const showOnlyDivergentIid = ref(false);

// Tab 是否已被加载过（懒加载标记）
const tabLoaded = ref({ overview: false, functions: false, 'hot-iids': false, events: false, loops: false });

// ── 过滤计算属性 ─────────────────────────────────────────────────────────────

const filteredFunctions = computed(() => {
    if (!fnResult.value?.functions) return [];
    return showOnlyDivergent.value
        ? fnResult.value.functions.filter(r => r.isDivergent)
        : fnResult.value.functions;
});

const filteredIids = computed(() => {
    if (!iidResult.value?.iids) return [];
    return showOnlyDivergentIid.value
        ? iidResult.value.iids.filter(r => r.isDivergent)
        : iidResult.value.iids;
});

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function truncate(str, len) {
    if (!str) return '—';
    return str.length > len ? str.slice(0, len) + '…' : str;
}

function deltaStr(v) {
    if (v === 0 || v === null || v === undefined) return '±0';
    return (v > 0 ? '+' : '') + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v);
}

function deltaClass(v) {
    if (!v) return 'delta-zero';
    return v > 0 ? 'delta-up' : 'delta-down';
}

const EVENT_TYPE_NAMES = {
    1: 'END_EXPR', 2: 'CALL_PRE', 3: 'CALL', 4: 'CALL_POST',
    5: 'RETURN', 6: 'RETURN_POST', 7: 'GET_FIELD', 8: 'GET_FIELD_POST',
    9: 'PUT_FIELD', 10: 'PUT_FIELD_POST', 11: 'READ', 12: 'WRITE',
    13: 'DECLARE', 14: 'LITERAL', 15: 'LITERAL_POST', 16: 'CONDITIONAL',
    17: 'BINARY_PRE', 18: 'BINARY', 19: 'UNARY_PRE', 20: 'UNARY',
    21: 'FORIN_OBJECT', 22: 'FORIN_OBJECT_POST',
};

function decodeEventType(code) {
    return EVENT_TYPE_NAMES[code] || `TYPE_${code}`;
}

function getCellClass(row, sid, idx) {
    if (!row.isDivergent) return '';
    if (idx === 0) return 'cell-base';
    const baseCnt = row.sessions[selectedIds.value[0]]?.callCount ?? 0;
    const currCnt = row.sessions[sid]?.callCount ?? 0;
    if (currCnt > baseCnt) return 'cell-higher';
    if (currCnt < baseCnt) return 'cell-lower';
    return '';
}

function getIidCellClass(row, sid, idx) {
    if (!row.isDivergent) return '';
    if (idx === 0) return 'cell-base';
    const baseCnt = row.sessions[selectedIds.value[0]]?.count ?? 0;
    const currCnt = row.sessions[sid]?.count ?? 0;
    if (currCnt > baseCnt) return 'cell-higher';
    if (currCnt < baseCnt) return 'cell-lower';
    return '';
}

function getLoopCellClass(row, sid, idx) {
    if (!row.isDivergent) return '';
    if (idx === 0) return 'cell-base';
    const baseCnt = row.sessions[selectedIds.value[0]]?.totalIters ?? 0;
    const currCnt = row.sessions[sid]?.totalIters ?? 0;
    if (currCnt > baseCnt) return 'cell-higher';
    if (currCnt < baseCnt) return 'cell-lower';
    return '';
}

// ── 网络请求（单个 Tab）──────────────────────────────────────────────────────

function postJson(path, body) {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const SESSION_IDS_BODY = () => ({ sessionIds: selectedIds.value });

/**
 * 流式加载：各 Tab 独立请求，谁完成谁先渲染。
 * overview 优先级最高（用户最先看到）；其余并发。
 */
async function runCompare() {
    if (selectedIds.value.length < 2) return;
    error.value = '';

    // 重置所有结果
    result.value = fnResult.value = iidResult.value = eventsResult.value = loopsResult.value = null;
    Object.keys(tabLoaded.value).forEach(k => tabLoaded.value[k] = false);
    activeTab.value = 'overview';

    // ── Overview（最高优先级，独立 await）
    loadingOverview.value = true;
    postJson('/api/compare/sessions', SESSION_IDS_BODY()).then(async r => {
        if (!r.ok) { error.value = await r.text(); return; }
        result.value = await r.json();
        tabLoaded.value.overview = true;
    }).catch(e => { error.value = e.message; }).finally(() => {
        loadingOverview.value = false;
    });

    // ── 其余 4 个 Tab 并发（不阻塞 overview 渲染）
    loadingFns.value = loadingIids.value = loadingEvents.value = loadingLoops.value = true;

    postJson('/api/compare/functions', SESSION_IDS_BODY()).then(async r => {
        if (r.ok) { fnResult.value = await r.json(); tabLoaded.value.functions = true; }
    }).catch(() => {}).finally(() => { loadingFns.value = false; });

    postJson('/api/compare/hot-iids', SESSION_IDS_BODY()).then(async r => {
        if (r.ok) { iidResult.value = await r.json(); tabLoaded.value['hot-iids'] = true; }
    }).catch(() => {}).finally(() => { loadingIids.value = false; });

    postJson('/api/compare/events', SESSION_IDS_BODY()).then(async r => {
        if (r.ok) { eventsResult.value = await r.json(); tabLoaded.value.events = true; }
    }).catch(() => {}).finally(() => { loadingEvents.value = false; });

    postJson('/api/compare/loops', SESSION_IDS_BODY()).then(async r => {
        if (r.ok) { loopsResult.value = await r.json(); tabLoaded.value.loops = true; }
    }).catch(() => {}).finally(() => { loadingLoops.value = false; });
}

async function loadFunctions() {
    loadingFns.value = true;
    try {
        const r = await postJson('/api/compare/functions', SESSION_IDS_BODY());
        if (r.ok) { fnResult.value = await r.json(); tabLoaded.value.functions = true; }
    } finally { loadingFns.value = false; }
}

async function loadHotIids() {
    loadingIids.value = true;
    try {
        const r = await postJson('/api/compare/hot-iids', SESSION_IDS_BODY());
        if (r.ok) { iidResult.value = await r.json(); tabLoaded.value['hot-iids'] = true; }
    } finally { loadingIids.value = false; }
}

// ── 会话加载 ─────────────────────────────────────────────────────────────────

async function loadSessions() {
    loadingSessions.value = true;
    try {
        const r = await fetch('/api/sessions?limit=200');
        const data = await r.json();
        sessions.value = data.sessions || data || [];
        for (const s of sessions.value) sessionNames.value[s.id] = s.name;
    } catch (e) {
        console.error('load sessions error', e);
    } finally {
        loadingSessions.value = false;
    }
}

// ── Session 选择 ─────────────────────────────────────────────────────────────

function toggleSession(s) {
    const idx = selectedIds.value.indexOf(s.id);
    if (idx >= 0) {
        selectedIds.value.splice(idx, 1);
    } else if (selectedIds.value.length < 8) {
        selectedIds.value.push(s.id);
        sessionNames.value[s.id] = s.name;
    }
    result.value = fnResult.value = iidResult.value = eventsResult.value = loopsResult.value = null;
}

function removeSession(sid) {
    const idx = selectedIds.value.indexOf(sid);
    if (idx >= 0) selectedIds.value.splice(idx, 1);
    result.value = fnResult.value = iidResult.value = eventsResult.value = loopsResult.value = null;
}

function clearAll() {
    selectedIds.value = [];
    result.value = fnResult.value = iidResult.value = eventsResult.value = loopsResult.value = null;
    error.value = '';
}

// Tab 加载状态映射
function isTabLoading(tabId) {
    switch (tabId) {
        case 'overview':  return loadingOverview.value;
        case 'functions': return loadingFns.value;
        case 'hot-iids':  return loadingIids.value;
        case 'events':    return loadingEvents.value;
        case 'loops':     return loadingLoops.value;
        default: return false;
    }
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────

onMounted(() => { loadSessions(); });
</script>

<style scoped>
/* ── 布局 ───────────────────────────────────────────────────────────────── */

.trace-diff { max-width: 1400px; margin: 0 auto; }

.session-picker { margin-bottom: 16px; }

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.picker-actions { display: flex; gap: 8px; }

/* ── 已选 Session 标签 ──────────────────────────────────────────────────── */

.selected-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.selected-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 6px;
  border-radius: 20px;
  border: 1px solid var(--border-color);
  font-size: 12px;
}

.session-label {
  font-weight: 700;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 10px;
}

.session-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.remove-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 2px;
  font-size: 11px;
  line-height: 1;
}
.remove-btn:hover { color: var(--danger); }

.add-hint { color: var(--text-muted); font-size: 12px; padding: 4px 8px; align-self: center; }

/* ── Session 池 ────────────────────────────────────────────────────────── */

.session-pool {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
}

.pool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  background: var(--bg-primary);
}

.pool-item:hover { border-color: var(--accent); background: var(--bg-tertiary); }
.pool-item.selected { border-color: var(--accent); background: rgba(99,102,241,0.08); }
.pool-item.disabled { opacity: 0.4; cursor: not-allowed; }

.pool-check {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
  border: 1px solid var(--border-color);
  border-radius: 50%;
  flex-shrink: 0;
}

.pool-item.selected .pool-check {
  background: var(--accent); color: #fff; border-color: var(--accent);
}

.pool-info { flex: 1; min-width: 0; }
.pool-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pool-meta { font-size: 11px; color: var(--text-muted); }
.pool-idx { font-size: 11px; font-weight: 700; color: var(--accent); }

/* ── Session 颜色主题（最多 8 个） ──────────────────────────────────────── */

.session-color-0 { background: rgba(99,102,241,0.15); color: #818cf8; border-color: rgba(99,102,241,0.4); }
.session-color-1 { background: rgba(34,197,94,0.15);  color: #4ade80; border-color: rgba(34,197,94,0.4); }
.session-color-2 { background: rgba(245,158,11,0.15); color: #fbbf24; border-color: rgba(245,158,11,0.4); }
.session-color-3 { background: rgba(239,68,68,0.15);  color: #f87171; border-color: rgba(239,68,68,0.4); }
.session-color-4 { background: rgba(6,182,212,0.15);  color: #22d3ee; border-color: rgba(6,182,212,0.4); }
.session-color-5 { background: rgba(168,85,247,0.15); color: #c084fc; border-color: rgba(168,85,247,0.4); }
.session-color-6 { background: rgba(249,115,22,0.15); color: #fb923c; border-color: rgba(249,115,22,0.4); }
.session-color-7 { background: rgba(236,72,153,0.15); color: #f472b6; border-color: rgba(236,72,153,0.4); }

.session-border-0 { border-left: 3px solid #818cf8; }
.session-border-1 { border-left: 3px solid #4ade80; }
.session-border-2 { border-left: 3px solid #fbbf24; }
.session-border-3 { border-left: 3px solid #f87171; }
.session-border-4 { border-left: 3px solid #22d3ee; }
.session-border-5 { border-left: 3px solid #c084fc; }
.session-border-6 { border-left: 3px solid #fb923c; }
.session-border-7 { border-left: 3px solid #f472b6; }

/* ── 整体指标 Tab ─────────────────────────────────────────────────────── */

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.overview-card { padding: 16px 20px; }

.overview-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metric-list { display: flex; flex-direction: column; gap: 6px; }

.metric-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-color);
}

.metric-label { font-size: 12px; color: var(--text-muted); }
.metric-val   { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }

.hot-iids { margin-top: 12px; }
.hot-title { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
.hot-row { display: flex; gap: 6px; align-items: center; font-size: 11px; padding: 2px 0; }
.hot-line  { color: var(--text-muted); min-width: 36px; }
.hot-src   { flex: 1; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hot-count { color: var(--warning); font-weight: 600; white-space: nowrap; }

/* ── 分歧摘要 ────────────────────────────────────────────────────────── */

.divergence-summary { padding: 16px 20px; }

.div-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  flex-wrap: wrap;
}

.div-name { flex: 1; font-weight: 500; }

.delta-up   { color: var(--success); font-weight: 600; }
.delta-down { color: var(--danger);  font-weight: 600; }
.delta-zero { color: var(--text-muted); }

/* ── 对比表格 ────────────────────────────────────────────────────────── */

.compare-table-wrap {
  overflow-x: auto;
}

.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.compare-table th {
  background: var(--bg-tertiary);
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  font-weight: 600;
  white-space: nowrap;
  color: var(--text-muted);
}

.compare-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
}

.compare-table tbody tr:hover { background: var(--bg-tertiary); }

.row-divergent { background: rgba(245,158,11,0.04); }

.fn-name-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-cell { text-align: right; font-variant-numeric: tabular-nums; }

.call-count { font-weight: 600; }
.event-count-sm { font-size: 10px; }

.divergent-cell { text-align: center; }
.divergent-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(245,158,11,0.15);
  color: var(--warning);
  white-space: nowrap;
}

.cell-base   { }
.cell-higher { color: var(--success); font-weight: 600; }
.cell-lower  { color: var(--danger);  font-weight: 600; }

/* Session 表头颜色 */
.session-th-0 { border-top: 2px solid #818cf8; }
.session-th-1 { border-top: 2px solid #4ade80; }
.session-th-2 { border-top: 2px solid #fbbf24; }
.session-th-3 { border-top: 2px solid #f87171; }
.session-th-4 { border-top: 2px solid #22d3ee; }
.session-th-5 { border-top: 2px solid #c084fc; }
.session-th-6 { border-top: 2px solid #fb923c; }
.session-th-7 { border-top: 2px solid #f472b6; }

.total-row td {
  font-weight: 700;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 11px;
}

.line-cell { color: var(--text-muted); font-size: 11px; }
.iid-cell  { color: var(--text-muted); font-size: 11px; }
.src-cell  { font-family: 'JetBrains Mono', monospace; font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pct-badge {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 4px;
}

.session-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 10px;
  display: inline-block;
  white-space: nowrap;
}
.session-badge.sm { font-size: 9px; padding: 1px 5px; }

.text-muted { color: var(--text-muted); }

/* ── Tab ────────────────────────────────────────────────────────────── */

.tab-nav { display: flex; gap: 4px; padding: 8px 12px; }

.tab-btn {
  padding: 5px 14px;
  background: transparent;
  color: var(--text-muted);
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s;
}
.tab-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.tab-active { background: var(--bg-tertiary) !important; color: var(--text-primary) !important; border-color: var(--border-color) !important; }

.tab-loading { font-size: 10px; margin-left: 4px; opacity: 0.7; animation: spin 1s linear infinite; display: inline-block; }
.tab-done    { font-size: 10px; margin-left: 4px; color: var(--success); }

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.tab-content { }

.error-state { color: var(--danger); padding: 16px 20px; }
</style>
