<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A2 · 数据流图</h2>
      <span class="section-badge">{{ dfTotal }} 条边</span>
      <!-- 视图切换 -->
      <div class="view-toggle">
        <button class="vtbtn" :class="viewMode === 'graph' ? 'vtbtn-active' : ''" @click="setViewMode('graph')" title="图形化子图视图">🕸 图视图</button>
        <button class="vtbtn" :class="viewMode === 'table' ? 'vtbtn-active' : ''" @click="setViewMode('table')" title="边列表表格">📋 表格</button>
        <button class="vtbtn" :class="viewMode === 'slice' ? 'vtbtn-active' : ''" @click="setViewMode('slice')" title="后向切片（从变量出发回溯依赖链）">🔍 切片</button>
      </div>
    </div>

    <!-- ═══════════ 图视图 ═══════════ -->
    <template v-if="viewMode === 'graph'">
      <!-- 控制栏 -->
      <div class="filter-bar" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input
            v-model="graphVarInput"
            placeholder="输入变量名查看子图..."
            class="search-input"
            list="df-var-suggest"
            @keyup.enter="loadSubgraph"
            @input="onGraphVarInput"
          />
          <datalist id="df-var-suggest">
            <option v-for="v in varSuggestions" :key="v" :value="v" />
          </datalist>
          <button v-if="graphVarInput" class="search-clear" @click="graphVarInput=''; clearGraph()" title="清空">✕</button>
        </div>

        <!-- 方向 -->
        <div class="btn-group">
          <button class="btn-seg" :class="graphDir==='both'     ? 'btn-seg-active':''" @click="graphDir='both';    loadSubgraph()">双向</button>
          <button class="btn-seg" :class="graphDir==='forward'  ? 'btn-seg-active':''" @click="graphDir='forward'; loadSubgraph()">下游</button>
          <button class="btn-seg" :class="graphDir==='backward' ? 'btn-seg-active':''" @click="graphDir='backward';loadSubgraph()">上游</button>
        </div>

        <!-- 跳数 -->
        <div class="btn-group">
          <span style="font-size:11px;color:var(--text-muted);padding:0 4px;">跳数</span>
          <button v-for="h in [2,3,4,5]" :key="h" class="btn-seg" :class="graphHops===h ? 'btn-seg-active':''" @click="graphHops=h; loadSubgraph()">{{ h }}</button>
        </div>

        <button class="btn-secondary" @click="loadSubgraph" :disabled="!graphVarInput.trim() || graphLoading">
          {{ graphLoading ? '加载中...' : '展开子图' }}
        </button>
        <button v-if="cyReady" class="btn-secondary" @click="fitGraph">适配视图</button>
        <button v-if="cyReady" class="btn-secondary" @click="layoutGraph">重新布局</button>
      </div>

      <!-- 图容器 -->
      <div v-if="graphStats" class="graph-stats-bar">
        <span class="stat-chip">{{ graphStats.varNodes }} 变量节点</span>
        <span class="stat-chip">{{ graphStats.eventNodes }} 事件节点</span>
        <span class="stat-chip">{{ graphStats.edgeCount }} 条边</span>
        <span v-if="graphStats.truncated" class="stat-chip stat-chip-warn">⚠ 节点已截断（超过上限）</span>
      </div>

      <div v-if="graphLoading" class="loading"><div class="spinner"></div><span>加载子图...</span></div>
      <div v-else-if="!cyReady && !graphVarInput.trim()" class="empty-state graph-placeholder">
        <div class="placeholder-icon">🕸</div>
        <p>在上方输入变量名，展开以该变量为中心的数据流子图</p>
        <p style="font-size:11px;color:var(--text-muted);margin-top:4px">支持正向/反向/双向追踪，最多 6 跳</p>
      </div>
      <div v-else-if="graphEmpty" class="empty-state">
        <p>未找到与 <strong>{{ graphVarInput }}</strong> 相关的数据流边</p>
        <p style="font-size:11px;color:var(--text-muted)">请先运行 Phase 4 (A2 插件)</p>
      </div>

      <!-- Cytoscape 容器 -->
      <div ref="cyContainer" class="cy-container" :style="cyReady ? {} : {display:'none'}"></div>

      <!-- 选中节点详情面板 -->
      <div v-if="selectedNode" class="node-detail-panel">
        <div class="node-detail-header">
          <span class="nd-type-badge" :class="`nd-${selectedNode.type}`">{{ selectedNode.type === 'var' ? '变量' : '事件' }}</span>
          <code class="nd-label">{{ selectedNode.type === 'var' ? selectedNode.label : `#${selectedNode.eventId}` }}</code>
          <button class="nd-close" @click="selectedNode=null">✕</button>
        </div>
        <div class="nd-body">
          <template v-if="selectedNode.type === 'var'">
            <div class="nd-row"><span class="nd-key">变量名</span><code>{{ selectedNode.label }}</code></div>
            <div v-if="selectedNode.edgeTypes?.length" class="nd-row"><span class="nd-key">边类型</span>
              <span v-for="t in selectedNode.edgeTypes" :key="t" class="type-badge" :class="`df-${t}`">{{ t }}</span>
            </div>
            <div class="nd-actions">
              <button class="btn-secondary btn-sm" @click="loadSubgraphFrom(selectedNode.label, 'both')">展开双向子图</button>
              <button class="btn-secondary btn-sm" @click="loadSubgraphFrom(selectedNode.label, 'backward')">← 回溯上游</button>
              <button class="btn-secondary btn-sm" @click="loadSubgraphFrom(selectedNode.label, 'forward')">下游追踪 →</button>
              <button class="btn-secondary btn-sm" @click="openSlice(selectedNode.label)">切片分析</button>
            </div>
          </template>
          <template v-else>
            <div class="nd-row"><span class="nd-key">事件 SEQ</span><code>{{ selectedNode.eventId }}</code></div>
            <div v-if="selectedNode.varName" class="nd-row"><span class="nd-key">变量</span><code>{{ selectedNode.varName }}</code></div>
            <div v-if="selectedNode.line"    class="nd-row"><span class="nd-key">行号</span><code>{{ selectedNode.line }}</code></div>
            <div v-if="selectedNode.srcText" class="nd-row"><span class="nd-key">源码</span><code class="src-text">{{ selectedNode.srcText }}</code></div>
            <div class="nd-actions">
              <button v-if="selectedNode.varName" class="btn-secondary btn-sm" @click="loadSubgraphFrom(selectedNode.varName, 'backward')">← 回溯上游</button>
              <button v-if="selectedNode.line != null" class="btn-secondary btn-sm" @click="gotoEventLine(selectedNode.line)" title="跳转到事件流对应行号">📋 查看事件</button>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- ═══════════ 表格模式 ═══════════ -->
    <template v-else-if="viewMode === 'table'">
      <!-- 筛选栏 -->
      <div class="filter-bar" style="margin-bottom:12px">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input
            v-model="dfVarName"
            placeholder="按变量名筛选..."
            class="search-input"
            @keyup.enter="loadDataflow(true)"
            @input="onVarNameInput"
          />
          <button v-if="dfVarName" class="search-clear" @click="dfVarName=''; loadDataflow(true)" title="清空">✕</button>
        </div>

        <!-- 边类型统计（点击过滤） -->
        <template v-if="dataflowStats.length > 0">
          <span class="filter-label" style="margin-left:4px">类型：</span>
          <span
            v-for="s in dataflowStats" :key="s.edge_type"
            class="stat-chip"
            :class="dfEdgeTypeFilter === s.edge_type ? 'stat-chip-active' : ''"
            @click="toggleEdgeType(s.edge_type)"
          >{{ s.edge_type }} <em>{{ s.cnt }}</em></span>
        </template>

        <button class="btn-secondary" style="margin-left:auto" @click="resetTableFilters">重置</button>
      </div>

      <div v-if="dataflowLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
      <div v-else-if="dfTotal === 0 && !dataflowLoading" class="empty-state">
        <p v-if="dfVarName || dfEdgeTypeFilter">无匹配数据流边</p>
        <p v-else>暂无数据流数据（请先运行 Phase 4）</p>
      </div>
      <div v-else>
        <!-- 边列表 -->
        <div class="events-table-wrapper">
          <table class="events-table">
            <thead>
              <tr><th>类型</th><th>来源变量</th><th>目标变量</th><th>来源 SEQ</th><th>目标 SEQ</th><th>行号</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="e in dataflowEdges" :key="e.id" @click="onTableRowClick(e)" style="cursor:pointer">
                <td><span class="type-badge" :class="`df-${e.edge_type}`">{{ e.edge_type }}</span></td>
                <td>
                  <span
                    class="var-chip var-write var-clickable"
                    :title="e.from_var"
                    @click.stop="quickLoadSubgraph(e.from_var)"
                  >{{ e.from_var || '—' }}</span>
                </td>
                <td>
                  <span
                    class="var-chip var-read var-clickable"
                    :title="e.to_var"
                    @click.stop="quickLoadSubgraph(e.to_var)"
                  >{{ e.to_var || '—' }}</span>
                </td>
                <td class="td-seq">{{ e.from_event_id ?? '—' }}</td>
                <td class="td-seq">{{ e.to_event_id ?? '—' }}</td>
                <td class="td-seq">{{ e.line ?? '—' }}</td>
                <td>
                  <button
                    v-if="e.from_var || e.to_var"
                    class="btn-secondary btn-xs"
                    @click.stop="openSlice(e.from_var || e.to_var)"
                    title="切片分析"
                  >切片</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div v-if="dfTotal > DF_PAGE_SIZE" class="pagination">
          <span class="page-summary">共 {{ dfTotal }} 条 · 每页 {{ DF_PAGE_SIZE }}</span>
          <div class="page-controls">
            <button class="btn-page btn-secondary" :disabled="dfPage <= 1" @click="gotoPage(1)">«</button>
            <button class="btn-page btn-secondary" :disabled="dfPage <= 1" @click="gotoPage(dfPage - 1)">‹ 上一页</button>
            <template v-for="p in visiblePages" :key="'p'+p">
              <span v-if="p === '...'" class="page-ellipsis">…</span>
              <button v-else class="btn-page" :class="p === dfPage ? 'btn-page-active' : 'btn-secondary'" @click="gotoPage(p)">{{ p }}</button>
            </template>
            <button class="btn-page btn-secondary" :disabled="dfPage >= dfTotalPages" @click="gotoPage(dfPage + 1)">下一页 ›</button>
            <button class="btn-page btn-secondary" :disabled="dfPage >= dfTotalPages" @click="gotoPage(dfTotalPages)">»</button>
          </div>
          <div class="page-jump">
            <span class="page-jump-label">跳转</span>
            <input v-model.number="dfJump" type="number" :min="1" :max="dfTotalPages" class="page-jump-input" @keyup.enter="doJump" />
            <button class="btn-page btn-secondary" @click="doJump">GO</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ═══════════ 切片视图 ═══════════ -->
    <template v-else-if="viewMode === 'slice'">
      <div class="filter-bar" style="margin-bottom:12px">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input
            v-model="sliceVarInput"
            placeholder="输入目标变量名，追溯所有影响它的来源..."
            class="search-input"
            style="width:320px"
            list="df-var-suggest-slice"
            @keyup.enter="loadSlice"
            @input="onSliceVarInput"
          />
          <datalist id="df-var-suggest-slice">
            <option v-for="v in varSuggestions" :key="v" :value="v" />
          </datalist>
          <button v-if="sliceVarInput" class="search-clear" @click="sliceVarInput=''" title="清空">✕</button>
        </div>

        <!-- 切片方向 -->
        <div class="btn-group">
          <button class="btn-seg" :class="sliceDir==='backward' ? 'btn-seg-active':''" @click="sliceDir='backward';loadSlice()" title="向上追溯：谁影响了这个变量">← 上游</button>
          <button class="btn-seg" :class="sliceDir==='forward'  ? 'btn-seg-active':''" @click="sliceDir='forward'; loadSlice()" title="向下追踪：这个变量影响了谁">下游 →</button>
        </div>

        <!-- 深度 -->
        <div class="btn-group">
          <span style="font-size:11px;color:var(--text-muted);padding:0 4px;">深度</span>
          <button v-for="h in [2,3,4,5,6]" :key="h" class="btn-seg" :class="sliceHops===h ? 'btn-seg-active':''" @click="sliceHops=h; loadSlice()">{{ h }}</button>
        </div>

        <button class="btn-secondary" @click="loadSlice" :disabled="!sliceVarInput.trim() || sliceLoading">
          {{ sliceLoading ? '分析中...' : '开始切片' }}
        </button>
      </div>

      <div v-if="sliceLoading" class="loading"><div class="spinner"></div><span>计算切片...</span></div>
      <div v-else-if="!sliceResult && !sliceVarInput.trim()" class="empty-state">
        <div class="placeholder-icon">🔍</div>
        <p>后向切片（Backward Slice）：输入目标变量，追溯所有影响它的变量和操作</p>
        <p style="font-size:11px;color:var(--text-muted);margin-top:4px">适用于逆向分析：从签名/Token 变量出发，找出所有输入来源</p>
      </div>
      <div v-else-if="sliceResult && sliceResult.nodes.length === 0" class="empty-state">
        <p>未找到 <strong>{{ sliceVarInput }}</strong> 的切片数据</p>
      </div>
      <div v-else-if="sliceResult">
        <!-- 切片统计 -->
        <div class="slice-stats">
          <span class="stat-chip">{{ sliceResult.stats.varNodes }} 个变量</span>
          <span class="stat-chip">{{ sliceResult.stats.eventNodes }} 个事件点</span>
          <span class="stat-chip">{{ sliceResult.stats.edgeCount }} 条依赖边</span>
          <span v-if="sliceResult.stats.truncated" class="stat-chip stat-chip-warn">⚠ 已截断</span>
          <button class="btn-secondary btn-sm" style="margin-left:auto" @click="showSliceAsGraph">在图视图打开</button>
        </div>

        <!-- 切片链路树（层级展示） -->
        <div class="slice-tree">
          <SliceTree
            :nodes="sliceResult.nodes"
            :edges="sliceResult.edges"
            :root-var="sliceVarInput"
            :direction="sliceDir"
            @jump-subgraph="jumpToSubgraph"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';

// SliceTree：切片层级展示组件（内联 Options API，无需独立文件）
const SliceTree = {
    props: {
        nodes:     { type: Array,  default: () => [] },
        edges:     { type: Array,  default: () => [] },
        rootVar:   { type: String, default: '' },
        direction: { type: String, default: 'backward' },
    },
    emits: ['jump-subgraph'],
    computed: {
        // BFS 按层展开依赖链
        // backward: dst = to_var（target），src = from_var（上游）
        // forward:  dst = from_var（source），src = to_var（下游）
        computedLayers() {
            if (!this.rootVar) return [];
            const rootKey = `var:${this.rootVar}`;

            // 构建邻接表：dst → Set<src>（"dst 的依赖来自 src"）
            const adj = new Map();
            for (const e of this.edges) {
                if (!e.from_var || !e.to_var) continue;
                const src = this.direction === 'backward' ? `var:${e.from_var}` : `var:${e.to_var}`;
                const dst = this.direction === 'backward' ? `var:${e.to_var}`   : `var:${e.from_var}`;
                if (!adj.has(dst)) adj.set(dst, new Set());
                adj.get(dst).add(src);
            }

            // BFS 层级构建（带安全计数防止意外死循环）
            const visited  = new Set([rootKey]);
            const result   = [[rootKey]];
            let frontier   = [rootKey];
            let safety     = 0;
            while (frontier.length > 0 && safety++ < 20) {
                const next = [];
                for (const key of frontier) {
                    for (const c of (adj.get(key) || [])) {
                        if (!visited.has(c)) { visited.add(c); next.push(c); }
                    }
                }
                if (next.length > 0) result.push(next);
                frontier = next;
            }
            return result;
        },
        // id → 节点对象映射（用于取 edgeTypes）
        nodeMap() {
            const m = new Map();
            for (const n of this.nodes) m.set(n.id, n);
            return m;
        },
    },
    template: `
<div class="slice-tree-wrap">
  <div v-for="(layer, li) in computedLayers" :key="li" class="slice-layer">
    <div class="slice-layer-label">{{ li === 0 ? '目标' : (direction === 'backward' ? '来源 L'+li : '影响 L'+li) }}</div>
    <div class="slice-layer-nodes">
      <div
        v-for="key in layer" :key="key"
        class="slice-node"
        :class="li === 0 ? 'slice-node-root' : ''"
        @click="$emit('jump-subgraph', key.replace('var:', ''))"
        :title="'点击在子图中查看 ' + key.replace('var:', '')"
      >
        <code>{{ key.replace('var:', '') }}</code>
        <span v-if="nodeMap.get(key)?.edgeTypes?.length" class="slice-edge-types">
          <span v-for="t in nodeMap.get(key).edgeTypes" :key="t" class="type-badge" :class="'df-'+t" style="font-size:9px;padding:1px 4px">{{ t }}</span>
        </span>
      </div>
    </div>
    <div v-if="li < computedLayers.length - 1" class="slice-layer-arrow">{{ direction === 'backward' ? '←' : '→' }}</div>
  </div>
</div>
    `,
};

const props = defineProps({
    sessionId: { type: String, required: true },
    // 外部传入：从 CallDetail 等联动触发，自动展开指定变量的子图
    initialVar:  { type: String, default: '' },
    initialMode: { type: String, default: '' }, // 'graph'|'slice'|'table'
});

const emit = defineEmits(['goto-dataflow', 'goto-line']);

// ─── 视图模式 ─────────────────────────────────────────────────────────────────
const viewMode = ref('graph');

function setViewMode(m) {
    viewMode.value = m;
    if (m === 'table' && dataflowEdges.value.length === 0) loadDataflow(true);
}

// ─── 变量建议（共享）────────────────────────────────────────────────────────
const varSuggestions = ref([]);
let varSuggestTimer = null;
async function fetchVarSuggestions(prefix) {
    try {
        const url = `/api/sessions/${props.sessionId}/dataflow/vars` + (prefix ? `?prefix=${encodeURIComponent(prefix)}&limit=20` : '?limit=20');
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            varSuggestions.value = data.vars || [];
        }
    } catch { /* non-fatal */ }
}

// ─── 图视图 ──────────────────────────────────────────────────────────────────
const cyContainer  = ref(null);
const graphVarInput = ref('');
const graphDir      = ref('both');
const graphHops     = ref(3);
const graphLoading  = ref(false);
const graphEmpty    = ref(false);
const graphStats    = ref(null);
const cyReady       = ref(false);
const selectedNode  = ref(null);

let cy = null; // Cytoscape 实例

function onGraphVarInput() {
    clearTimeout(varSuggestTimer);
    varSuggestTimer = setTimeout(() => fetchVarSuggestions(graphVarInput.value.trim()), 200);
}

async function loadSubgraph() {
    const vn = graphVarInput.value.trim();
    if (!vn) return;
    graphLoading.value = true;
    graphEmpty.value   = false;
    selectedNode.value = null;
    try {
        const params = new URLSearchParams({
            varName:   vn,
            direction: graphDir.value,
            hops:      graphHops.value,
            maxNodes:  100,
        });
        const res = await fetch(`/api/sessions/${props.sessionId}/dataflow/subgraph?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data.nodes || data.nodes.length === 0) {
            graphEmpty.value = true;
            graphStats.value = null;
            destroyCy();
            return;
        }

        graphStats.value = data.stats;
        await nextTick();
        await renderCy(data.nodes, data.edges);
    } catch (e) {
        console.error('[DataflowTab] loadSubgraph error:', e);
    } finally {
        graphLoading.value = false;
    }
}

function loadSubgraphFrom(varN, dir) {
    graphVarInput.value = varN;
    graphDir.value      = dir;
    loadSubgraph();
    viewMode.value = 'graph';
}

// 从表格行快速打开子图
function quickLoadSubgraph(varN) {
    if (!varN || varN.startsWith('#')) return;
    loadSubgraphFrom(varN, 'both');
    viewMode.value = 'graph';
}

function clearGraph() {
    graphEmpty.value   = false;
    graphStats.value   = null;
    selectedNode.value = null;
    destroyCy();
}

function fitGraph()    { cy?.fit(undefined, 24); }
function layoutGraph() { cy?.layout(getCyLayout()).run(); }

// ── Cytoscape 渲染 ────────────────────────────────────────────────────────────
async function loadCytoscape() {
    if (window.cytoscape) return window.cytoscape;
    // 动态加载 Cytoscape（CDN 或本地 node_modules）
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // 尝试使用 node_modules 路径（Vite 会处理），回退到 CDN
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js';
        s.onload  = () => resolve(window.cytoscape);
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// 边类型颜色映射
const EDGE_COLORS = {
    assign:      '#6366f1',
    copy:        '#06b6d4',
    field_write: '#22c55e',
    field_read:  '#f59e0b',
    call_arg:    '#a855f7',
    call_ret:    '#ef4444',
};

function getCyLayout() {
    return {
        name: 'breadthfirst',
        directed: true,
        padding: 20,
        spacingFactor: 1.4,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: true,
    };
}

async function renderCy(nodes, edges) {
    const cytoscape = await loadCytoscape();
    if (!cytoscape) return;

    if (!cyContainer.value) return;

    // 销毁旧实例
    destroyCy();

    // 构建 Cytoscape elements
    const cyNodes = nodes.map(n => ({
        group: 'nodes',
        data: {
            id:       n.id,
            label:    n.type === 'var' ? n.label : `#${n.eventId}`,
            type:     n.type,
            varName:  n.varName  || n.label || '',
            eventId:  n.eventId  || null,
            line:     n.line     || null,
            iid:      n.iid      || null,
            srcText:  n.srcText  || '',
            edgeTypes: (n.edgeTypes || []).join(','),
        },
    }));

    const seenEdges = new Set();
    const cyEdges = [];
    for (const e of edges) {
        // 边连接：从 from_var/from_event 到 to_var/to_event
        const srcKey = e.from_event_id != null ? `ev:${e.from_event_id}` : (e.from_var ? `var:${e.from_var}` : null);
        const tgtKey = e.to_event_id   != null ? `ev:${e.to_event_id}`   : (e.to_var   ? `var:${e.to_var}`   : null);
        if (!srcKey || !tgtKey) continue;
        const eKey = `${srcKey}→${tgtKey}→${e.edge_type}`;
        if (seenEdges.has(eKey)) continue;
        seenEdges.add(eKey);
        cyEdges.push({
            group: 'edges',
            data: {
                id:         `e${e.id}`,
                source:     srcKey,
                target:     tgtKey,
                edgeType:   e.edge_type,
                label:      e.edge_type,
                color:      EDGE_COLORS[e.edge_type] || '#6b7280',
                fromVar:    e.from_var || '',
                toVar:      e.to_var   || '',
                line:       e.line     || null,
            },
        });
    }

    cy = cytoscape({
        container: cyContainer.value,
        elements: [...cyNodes, ...cyEdges],
        style: [
            // 变量节点
            {
                selector: 'node[type="var"]',
                style: {
                    'shape':              'round-rectangle',
                    'width':              'label',
                    'height':             24,
                    'padding':            '6px',
                    'background-color':   '#1e1f2e',
                    'border-color':       '#6366f1',
                    'border-width':       1.5,
                    'label':              'data(label)',
                    'color':              '#a5b4fc',
                    'font-size':          11,
                    'font-family':        'ui-monospace, monospace',
                    'text-valign':        'center',
                    'text-halign':        'center',
                    'text-max-width':     160,
                    'text-overflow-wrap': 'anywhere',
                    'min-zoomed-font-size': 8,
                },
            },
            // 事件节点
            {
                selector: 'node[type="event"]',
                style: {
                    'shape':            'ellipse',
                    'width':            32,
                    'height':           32,
                    'background-color': '#1a2030',
                    'border-color':     '#f59e0b',
                    'border-width':     1.5,
                    'label':            'data(label)',
                    'color':            '#fcd34d',
                    'font-size':        10,
                    'font-family':      'ui-monospace, monospace',
                    'text-valign':      'center',
                    'text-halign':      'center',
                    'min-zoomed-font-size': 7,
                },
            },
            // 选中节点
            {
                selector: 'node:selected',
                style: {
                    'border-color':  '#fff',
                    'border-width':  2.5,
                    'overlay-color': '#6366f1',
                    'overlay-padding': 4,
                    'overlay-opacity': 0.15,
                },
            },
            // 边
            {
                selector: 'edge',
                style: {
                    'curve-style':         'bezier',
                    'target-arrow-shape':  'triangle',
                    'target-arrow-color':  'data(color)',
                    'line-color':          'data(color)',
                    'width':               1.5,
                    'label':               'data(label)',
                    'color':               'data(color)',
                    'font-size':           9,
                    'text-background-color': '#0f1117',
                    'text-background-opacity': 0.7,
                    'text-background-padding': '2px',
                    'opacity':             0.85,
                    'min-zoomed-font-size': 6,
                },
            },
            // 悬停边
            {
                selector: 'edge:selected',
                style: {
                    'width':   3,
                    'opacity': 1,
                },
            },
        ],
        layout: getCyLayout(),
        minZoom: 0.1,
        maxZoom: 4,
    });

    // 节点点击 → 显示详情面板
    cy.on('tap', 'node', (evt) => {
        const nodeData = evt.target.data();
        selectedNode.value = {
            type:      nodeData.type,
            label:     nodeData.label,
            varName:   nodeData.varName,
            eventId:   nodeData.eventId,
            line:      nodeData.line,
            iid:       nodeData.iid,
            srcText:   nodeData.srcText,
            edgeTypes: nodeData.edgeTypes ? nodeData.edgeTypes.split(',').filter(Boolean) : [],
        };
    });

    // 点击背景取消选中
    cy.on('tap', (evt) => {
        if (evt.target === cy) selectedNode.value = null;
    });

    cyReady.value = true;
}

function destroyCy() {
    if (cy) {
        cy.destroy();
        cy = null;
    }
    cyReady.value = false;
}

// ─── 切片视图 ─────────────────────────────────────────────────────────────────
const sliceVarInput = ref('');
const sliceDir      = ref('backward');
const sliceHops     = ref(4);
const sliceLoading  = ref(false);
const sliceResult   = ref(null);

function onSliceVarInput() {
    clearTimeout(varSuggestTimer);
    varSuggestTimer = setTimeout(() => fetchVarSuggestions(sliceVarInput.value.trim()), 200);
}

async function loadSlice() {
    const vn = sliceVarInput.value.trim();
    if (!vn) return;
    sliceLoading.value = true;
    sliceResult.value  = null;
    try {
        const params = new URLSearchParams({
            varName:   vn,
            direction: sliceDir.value,
            hops:      sliceHops.value,
            maxNodes:  150,
        });
        const res = await fetch(`/api/sessions/${props.sessionId}/dataflow/subgraph?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sliceResult.value = data;
    } catch (e) {
        console.error('[DataflowTab] loadSlice error:', e);
    } finally {
        sliceLoading.value = false;
    }
}

function openSlice(varN) {
    sliceVarInput.value = varN;
    sliceDir.value      = 'backward';
    viewMode.value      = 'slice';
    loadSlice();
}

function showSliceAsGraph() {
    graphVarInput.value = sliceVarInput.value;
    graphDir.value      = sliceDir.value;
    graphHops.value     = sliceHops.value;
    viewMode.value      = 'graph';
    loadSubgraph();
}

function jumpToSubgraph(varN) {
    loadSubgraphFrom(varN, sliceDir.value);
}

// ─── 表格模式 ─────────────────────────────────────────────────────────────────
const dataflowEdges    = ref([]);
const dataflowStats    = ref([]);
const dataflowLoading  = ref(false);
const dfEdgeTypeFilter = ref('');
const dfVarName        = ref('');
const dfTotal          = ref(0);
const dfPage           = ref(1);
const dfJump           = ref(1);
const DF_PAGE_SIZE     = 200;

const dfTotalPages = computed(() => Math.max(1, Math.ceil(dfTotal.value / DF_PAGE_SIZE)));

const visiblePages = computed(() => {
    const total = dfTotalPages.value;
    const cur   = dfPage.value;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (cur <= 4)   return [1, 2, 3, 4, 5, '...', total];
    if (cur >= total - 3) return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
    return [1, '...', cur - 1, cur, cur + 1, '...', total];
});

let varNameTimer = null;
function onVarNameInput() {
    clearTimeout(varNameTimer);
    varNameTimer = setTimeout(() => loadDataflow(true), 350);
}

function toggleEdgeType(type) {
    dfEdgeTypeFilter.value = dfEdgeTypeFilter.value === type ? '' : type;
    loadDataflow(true);
}

function resetTableFilters() {
    dfVarName.value        = '';
    dfEdgeTypeFilter.value = '';
    loadDataflow(true);
}

async function loadDataflow(reset = false) {
    if (reset) { dfPage.value = 1; dfJump.value = 1; }
    dataflowLoading.value = true;
    try {
        const offset = (dfPage.value - 1) * DF_PAGE_SIZE;
        const params = new URLSearchParams({ limit: DF_PAGE_SIZE, offset });
        if (dfEdgeTypeFilter.value) params.set('edgeType', dfEdgeTypeFilter.value);
        if (dfVarName.value.trim()) params.set('varName', dfVarName.value.trim());
        const res = await fetch(`/api/sessions/${props.sessionId}/dataflow?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        dataflowEdges.value = data.edges || [];
        dataflowStats.value = data.stats || [];
        dfTotal.value       = data.total ?? data.edges?.length ?? 0;
    } catch (e) {
        console.error('loadDataflow error:', e);
    } finally {
        dataflowLoading.value = false;
    }
}

async function gotoPage(p) {
    const clamped = Math.max(1, Math.min(dfTotalPages.value, p));
    if (clamped === dfPage.value) return;
    dfPage.value = clamped;
    dfJump.value = clamped;
    await loadDataflow(false);
}

function doJump() {
    gotoPage(Math.round(dfJump.value) || 1);
}

function onTableRowClick(edge) {
    // 点击表格行，在图视图中展开
    const varN = edge.from_var || edge.to_var;
    if (varN && !varN.startsWith('#')) {
        loadSubgraphFrom(varN, 'both');
    }
}

// ─── 跳转到事件流 ─────────────────────────────────────────────────────────────
function gotoEventLine(line) {
    if (line == null) return;
    emit('goto-line', { minLine: line, maxLine: line });
}

// ─── 外部联动接口 ─────────────────────────────────────────────────────────────
// 从 CallDetail 等外部组件调用：展开指定变量的数据流子图
function openDataflowFor(varN, mode = 'graph', direction = 'both') {
    viewMode.value = mode;
    if (mode === 'graph') {
        graphVarInput.value = varN;
        graphDir.value      = direction;
        loadSubgraph();
    } else if (mode === 'slice') {
        sliceVarInput.value = varN;
        sliceDir.value      = direction === 'backward' ? 'backward' : 'forward';
        loadSlice();
    }
}

// ─── 初始化处理 props.initialVar ─────────────────────────────────────────────
watch(() => props.initialVar, (val) => {
    if (val) openDataflowFor(val, props.initialMode || 'graph');
}, { immediate: true });

// ─── 生命周期 ─────────────────────────────────────────────────────────────────
onMounted(async () => {
    // 预加载变量建议
    await fetchVarSuggestions('');
    // 加载总体统计（用于 badge）
    loadDataflowStats();
});

onUnmounted(() => {
    destroyCy();
    clearTimeout(varNameTimer);
    clearTimeout(varSuggestTimer);
});

async function loadDataflowStats() {
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/dataflow?limit=1&offset=0`);
        if (!res.ok) return;
        const data = await res.json();
        dfTotal.value       = data.total ?? 0;
        dataflowStats.value = data.stats || [];
    } catch { /* non-fatal */ }
}

defineExpose({
    reload: () => {
        loadDataflowStats();
        fetchVarSuggestions('');
        if (viewMode.value === 'table') loadDataflow(true);
        else if (viewMode.value === 'graph' && graphVarInput.value.trim()) loadSubgraph();
        else if (viewMode.value === 'slice' && sliceVarInput.value.trim()) loadSlice();
    },
    openDataflowFor,
});
</script>

<style scoped>
/* ── 头部 ─────────────────────────────────────────────────────── */
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}

/* ── 视图切换 ──────────────────────────────────────────────────── */
.view-toggle { display: flex; gap: 2px; background: var(--bg-secondary); padding: 2px; border-radius: 8px; border: 1px solid var(--border-color); }
.vtbtn { padding: 4px 12px; border-radius: 6px; border: none; background: transparent; color: var(--text-muted); font-size: 12px; cursor: pointer; transition: all 0.12s; white-space: nowrap; }
.vtbtn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.vtbtn-active { background: rgba(99,102,241,0.2) !important; color: #a5b4fc !important; }

/* ── 过滤栏 ────────────────────────────────────────────────────── */
.filter-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); }

/* 搜索框 */
.search-box { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 8px; font-size: 12px; pointer-events: none; opacity: 0.6; }
.search-input {
    width: 220px; padding: 5px 26px 5px 28px !important;
    border: 1px solid var(--border-color); border-radius: 6px;
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
}
.search-input:focus { outline: none; border-color: rgba(99,102,241,0.5); }
.search-clear {
    position: absolute; right: 6px; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 0 2px;
    opacity: 0.7; transition: opacity 0.12s;
}
.search-clear:hover { opacity: 1; color: var(--danger, #f87171); }

/* 按钮组（方向/跳数） */
.btn-group { display: flex; align-items: center; gap: 1px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 2px; }
.btn-seg {
    padding: 3px 9px; border-radius: 4px; border: none; background: transparent;
    color: var(--text-muted); font-size: 11px; cursor: pointer; transition: all 0.12s; white-space: nowrap;
}
.btn-seg:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.btn-seg-active { background: rgba(99,102,241,0.2) !important; color: #a5b4fc !important; }

/* stat-chip */
.stat-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 10px; font-size: 11px;
    background: rgba(99,102,241,0.1); color: var(--text-muted);
    border: 1px solid rgba(99,102,241,0.15); cursor: pointer;
    transition: background 0.12s, color 0.12s;
}
.stat-chip:hover { background: rgba(99,102,241,0.18); color: var(--text-primary); }
.stat-chip-active { background: rgba(99,102,241,0.25) !important; color: #a5b4fc !important; border-color: rgba(99,102,241,0.45) !important; }
.stat-chip em { font-style: normal; color: #fcd34d; font-weight: 600; }
.stat-chip-warn { background: rgba(251,146,60,0.12) !important; color: #fb923c !important; border-color: rgba(251,146,60,0.3) !important; cursor: default; }

/* ── 图容器 ────────────────────────────────────────────────────── */
.graph-stats-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }

.cy-container {
    width: 100%;
    height: 520px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: #0d0e14;
    overflow: hidden;
}

.graph-placeholder {
    height: 280px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
.placeholder-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.4; }

/* ── 节点详情面板 ──────────────────────────────────────────────── */
.node-detail-panel {
    margin-top: 12px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    overflow: hidden;
}
.node-detail-header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
}
.nd-type-badge {
    padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700;
    background: rgba(99,102,241,0.2); color: #a5b4fc;
}
.nd-type-badge.nd-event { background: rgba(245,158,11,0.2); color: #fcd34d; }
.nd-label { font-size: 13px; color: var(--text-primary); }
.nd-close { margin-left: auto; background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
.nd-close:hover { color: var(--danger, #f87171); background: rgba(239,68,68,0.1); }
.nd-body { padding: 10px 14px; }
.nd-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 6px; font-size: 12px; }
.nd-key { color: var(--text-muted); min-width: 48px; flex-shrink: 0; }
.src-text { font-family: ui-monospace, monospace; font-size: 11px; color: #86efac; }
.nd-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

/* ── 按钮 ──────────────────────────────────────────────────────── */
.btn-secondary {
    padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
    font-size: 12px; cursor: pointer; transition: background 0.12s; white-space: nowrap;
}
.btn-secondary:hover:not(:disabled) { background: var(--bg-tertiary); border-color: rgba(99,102,241,0.4); }
.btn-secondary:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-sm { padding: 3px 9px !important; font-size: 11px !important; }
.btn-xs { padding: 2px 6px !important; font-size: 10px !important; }

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

.type-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.df-assign      { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.df-copy        { background: rgba(6,182,212,0.15);  color: #67e8f9; }
.df-field_write { background: rgba(34,197,94,0.15);  color: #86efac; }
.df-field_read  { background: rgba(245,158,11,0.15); color: #fcd34d; }
.df-call_arg    { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.df-call_ret    { background: rgba(239,68,68,0.15);  color: #fca5a5; }

.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-clickable { cursor: pointer; transition: opacity 0.12s; }
.var-clickable:hover { opacity: 0.75; text-decoration: underline; }

/* ── 分页 ──────────────────────────────────────────────────────── */
.pagination {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-top: 14px; padding-top: 14px;
    border-top: 1px solid var(--border-color); flex-wrap: wrap;
}
.page-summary { font-size: 12px; color: var(--text-muted); flex-shrink: 0; white-space: nowrap; }
.page-controls { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; justify-content: center; }
.page-jump { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.page-jump-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.page-jump-input {
    width: 50px; height: 28px; padding: 0 6px; font-size: 12px; text-align: center;
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
.btn-page-active {
    background: rgba(99,102,241,0.2) !important; border-color: rgba(99,102,241,0.6) !important;
    color: #a5b4fc !important; font-weight: 600; cursor: default;
}
.page-ellipsis {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 24px; height: 28px; font-size: 12px; color: var(--text-muted);
}

/* ── 切片视图 ──────────────────────────────────────────────────── */
.slice-stats { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.slice-tree { overflow-x: auto; }

/* SliceTree 内联样式（因为是 defineAsyncComponent 的 template） */
:deep(.slice-tree-wrap) { display: flex; align-items: flex-start; gap: 0; overflow-x: auto; padding-bottom: 8px; }
:deep(.slice-layer) { display: flex; flex-direction: column; align-items: center; gap: 6px; flex-shrink: 0; }
:deep(.slice-layer-label) { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
:deep(.slice-layer-nodes) { display: flex; flex-direction: column; gap: 4px; }
:deep(.slice-node) {
    padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); cursor: pointer; transition: all 0.12s;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    min-width: 80px; max-width: 160px;
}
:deep(.slice-node:hover) { border-color: rgba(99,102,241,0.5); background: rgba(99,102,241,0.08); }
:deep(.slice-node-root) { border-color: #6366f1 !important; background: rgba(99,102,241,0.15) !important; }
:deep(.slice-node code) { font-size: 11px; color: #a5b4fc; font-family: monospace; word-break: break-all; text-align: center; }
:deep(.slice-edge-types) { display: flex; gap: 2px; flex-wrap: wrap; justify-content: center; }
:deep(.slice-layer-arrow) { font-size: 18px; color: var(--text-muted); padding: 6px 8px; align-self: center; }

/* ── 空状态 & 加载 ─────────────────────────────────────────────── */
.empty-state {
    padding: 40px 20px; text-align: center; color: var(--text-muted); font-size: 13px;
}
.empty-state p { margin: 4px 0; }
.loading {
    display: flex; align-items: center; gap: 10px;
    padding: 20px; color: var(--text-muted); font-size: 13px;
}
.spinner {
    width: 16px; height: 16px; border: 2px solid rgba(99,102,241,0.3);
    border-top-color: #6366f1; border-radius: 50%;
    animation: spin 0.8s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
