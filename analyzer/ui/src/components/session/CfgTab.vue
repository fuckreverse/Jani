<template>
  <div class="cfg-tab">

    <!-- ── 顶部模式切换 + 工具栏 ──────────────────────────────────────── -->
    <div class="cfg-toolbar card">
      <div class="toolbar-left">
        <!-- 模式切换 -->
        <div class="mode-tabs">
          <button
            :class="['mode-btn', { active: mode === 'callgraph' }]"
            @click="switchMode('callgraph')"
          >📊 调用图</button>
          <button
            :class="['mode-btn', { active: mode === 'funcfg' }]"
            @click="switchMode('funcfg')"
          >🧩 函数CFG</button>
        </div>

        <div class="toolbar-divider"></div>

        <!-- 调用图参数 -->
        <template v-if="mode === 'callgraph'">
          <div class="toolbar-group">
            <label>深度</label>
            <select v-model="depth" style="width:70px" @change="loadCfg">
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
            </select>
          </div>
          <div class="toolbar-group">
            <label>最小执行次数</label>
            <input type="number" v-model.number="minCount" style="width:80px" min="1" @change="loadCfg" />
          </div>
          <div class="toolbar-group">
            <label>根函数</label>
            <input type="text" v-model="rootFn" placeholder="fnName" style="width:160px" @keydown.enter="loadCfg" />
          </div>
          <label class="toggle-label">
            <input type="checkbox" v-model="foldLoops" @change="loadCfg" />
            折叠循环
          </label>
        </template>

        <!-- 函数CFG参数 -->
        <template v-else>
          <div class="toolbar-group fn-search-group">
            <label>选择函数</label>
            <div class="fn-search-wrap" ref="fnSearchWrapRef">
              <input
                ref="fnSearchRef"
                type="text"
                v-model="fnSearchText"
                placeholder="输入函数名搜索…"
                style="width:220px"
                @input="onFnSearchInput"
                @focus="showFnDropdown = true"
                @keydown.enter="selectFnByEnter"
                @keydown.escape="showFnDropdown = false"
                @keydown.arrow-down.prevent="fnDropdownIdx = Math.min(fnDropdownIdx + 1, fnDropdownList.length - 1)"
                @keydown.arrow-up.prevent="fnDropdownIdx = Math.max(fnDropdownIdx - 1, 0)"
              />
              <div v-if="showFnDropdown && fnDropdownList.length > 0" class="fn-dropdown">
                <div
                  v-for="(fn, i) in fnDropdownList"
                  :key="`${fn.fnName}:${fn.fnIid}`"
                  class="fn-dropdown-item"
                  :class="{ active: i === fnDropdownIdx }"
                  @mousedown.prevent="selectFn(fn)"
                >
                  <span class="fn-name">{{ fn.fnName }}</span>
                  <span class="fn-meta">×{{ fn.callCount }} L{{ fn.minLine }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="toolbar-group">
            <label>采样调用</label>
            <select v-model="maxCalls" style="width:70px">
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          <button class="btn-primary" :disabled="!selectedFn" @click="loadFnCfg">🔄 分析</button>
        </template>
      </div>

      <div class="toolbar-right">
        <span v-if="mode === 'callgraph' && cgStats" class="stats-text">
          {{ cgStats.fnNodes }} 函数 · {{ cgStats.loopNodes }} 循环 · {{ cgStats.totalEdges }} 条边
        </span>
        <span v-if="mode === 'funcfg' && fnCfgData" class="stats-text">
          {{ fnCfgData.stats.blockCount }} 块 · {{ fnCfgData.stats.edgeCount }} 条边 · 采样 {{ fnCfgData.sampledCalls }}/{{ fnCfgData.totalCalls }} 次调用
          <span v-if="fnCfgData.stats.truncated" class="trunc-warn" title="函数过大，只显示最常执行的 50 个块">
            ⚠ 已裁剪（共 {{ fnCfgData.stats.totalBlockCount }} 块）
          </span>
        </span>
        <button class="btn-secondary" @click="fitGraph" title="适应窗口">⊡ 适应</button>
        <button class="btn-secondary" @click="resetLayout" title="重新布局">🔀 布局</button>
      </div>
    </div>

    <!-- ── 加载状态 ──────────────────────────────────────────────────── -->
    <div v-if="loading" class="loading cfg-loading">
      <div class="spinner"></div><span>{{ mode === 'funcfg' ? '分析函数控制流...' : '构建调用图...' }}</span>
    </div>

    <!-- ── 错误 ────────────────────────────────────────────────────── -->
    <div v-else-if="error" class="error-state card">❌ {{ error }}</div>

    <!-- ── 空数据提示 ─────────────────────────────────────────────── -->
    <div v-else-if="mode === 'callgraph' && cgData && cgData.nodes.length === 0" class="empty-state card">
      <p>📭 暂无调用图数据</p>
      <p class="empty-hint">需先运行 F3 CallGraphBuilder</p>
    </div>

    <div v-else-if="mode === 'funcfg' && !selectedFn && !fnCfgData" class="empty-state card">
      <p>🧩 请在上方搜索并选择一个函数</p>
      <p class="empty-hint">将显示该函数内部的动态控制流图（IDA 风格）</p>
    </div>

    <div v-else-if="mode === 'funcfg' && fnCfgData && fnCfgData.blocks.length === 0" class="empty-state card">
      <p>📭 无法分析该函数的控制流</p>
      <p class="empty-hint">函数可能没有事件数据（需要 smap / F3 / A3 插件数据）</p>
    </div>

    <!-- ── 图容器（两种模式共用 Cytoscape） ────────────────────────── -->
    <div v-show="!loading && !error && hasGraph" class="cfg-container">
      <div ref="cyRef" class="cy-canvas"></div>

      <!-- 图例（调用图模式） -->
      <div v-if="mode === 'callgraph'" class="legend card">
        <div class="legend-title">图例</div>
        <div class="legend-item"><span class="legend-dot fn-dot"></span>函数节点</div>
        <div class="legend-item"><span class="legend-dot loop-dot"></span>循环节点</div>
        <div class="legend-item"><span class="legend-dot hot-dot"></span>热点代码</div>
        <div class="legend-item"><span class="legend-line call-line"></span>调用边</div>
        <div class="legend-item"><span class="legend-line loop-line"></span>循环回边</div>
      </div>

      <!-- 图例（函数CFG模式） -->
      <div v-if="mode === 'funcfg'" class="legend card">
        <div class="legend-title">图例</div>
        <div class="legend-item"><span class="legend-dot entry-dot"></span>入口块</div>
        <div class="legend-item"><span class="legend-dot hot-block-dot"></span>热路径块</div>
        <div class="legend-item"><span class="legend-dot cold-block-dot"></span>冷路径块</div>
        <div class="legend-item"><span class="legend-line flow-line"></span>顺序边</div>
        <div class="legend-item"><span class="legend-line cond-line"></span>条件边</div>
        <div class="legend-item"><span class="legend-line back-line"></span>回边（循环）</div>
      </div>

      <!-- 节点 Tooltip -->
      <div v-if="tooltip" class="node-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
        <div class="tooltip-title">{{ tooltip.title }}</div>
        <div v-for="(v, k) in tooltip.props" :key="k" class="tooltip-row">
          <span class="tooltip-key">{{ k }}</span>
          <span class="tooltip-val">{{ v }}</span>
        </div>
        <div v-if="tooltip.isLoop" class="tooltip-hint">🖱 双击查看迭代详情</div>
      </div>
    </div>

    <!-- ── 循环迭代抽屉 ──────────────────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="loopDrawer.open" class="loop-drawer-mask" @click.self="closeLoopDrawer">
        <div class="loop-drawer">
          <div class="drawer-header">
            <div class="drawer-title">
              🔄 循环迭代详情
              <span class="drawer-subtitle">L{{ loopDrawer.line }} · IID {{ loopDrawer.iid }} · 共 {{ loopDrawer.totalIters?.toLocaleString() }} 次迭代</span>
            </div>
            <button class="drawer-close" @click="closeLoopDrawer">✕</button>
          </div>
          <div v-if="loopDrawer.loading" class="drawer-loading">
            <div class="spinner"></div><span>加载迭代数据...</span>
          </div>
          <div v-else-if="!loopDrawer.iterations.length" class="drawer-empty">
            <p>暂无迭代快照</p>
            <p class="empty-hint">需先运行 A5 LoopDetector 插件</p>
          </div>
          <div v-else class="drawer-body">
            <div class="iter-info">显示前 {{ loopDrawer.iterations.length }} 次迭代（共 {{ loopDrawer.total }} 次）</div>
            <div class="iter-table-wrap">
              <table class="iter-table">
                <thead>
                  <tr>
                    <th class="iter-idx-th">#</th>
                    <th class="iter-seq-th">SEQ 范围</th>
                    <th v-for="varName in loopDrawer.varNames" :key="varName" class="iter-var-th">{{ varName }}</th>
                    <th v-if="!loopDrawer.varNames.length" class="iter-var-th">（无变量快照）</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="iter in loopDrawer.iterations" :key="iter.iteration_idx" :class="{ 'iter-changed': iter._hasChange }">
                    <td class="iter-idx">{{ iter.iteration_idx + 1 }}</td>
                    <td class="iter-seq">
                      <span class="seq-badge">{{ iter.start_seq }}</span>
                      <span class="seq-sep">→</span>
                      <span class="seq-badge">{{ iter.end_seq }}</span>
                    </td>
                    <td v-for="varName in loopDrawer.varNames" :key="varName" class="iter-val"
                        :class="{ 'val-changed': iter._changedVars?.has(varName) }"
                        :title="String(iter.vars_snapshot[varName] ?? '')">
                      {{ formatVal(iter.vars_snapshot[varName]) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="loopDrawer.total > loopDrawer.pageSize" class="drawer-pagination">
              <button class="btn-secondary" :disabled="loopDrawer.page === 0" @click="loadIterPage(loopDrawer.page - 1)">‹ 上一页</button>
              <span class="page-info">第 {{ loopDrawer.page + 1 }} / {{ Math.ceil(loopDrawer.total / loopDrawer.pageSize) }} 页</span>
              <button class="btn-secondary" :disabled="(loopDrawer.page + 1) * loopDrawer.pageSize >= loopDrawer.total" @click="loadIterPage(loopDrawer.page + 1)">下一页 ›</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import cytoscape from 'cytoscape';

// ── Props ─────────────────────────────────────────────────────────────────

const props = defineProps({
    sessionId: { type: String, required: true },
});

// ── 全局状态 ──────────────────────────────────────────────────────────────

const cyRef    = ref(null);
const loading  = ref(false);
const error    = ref('');
const tooltip  = ref(null);
const mode     = ref('funcfg'); // 'callgraph' | 'funcfg'

let cy = null;

// ── 调用图参数/数据 ───────────────────────────────────────────────────────

const depth       = ref('3');
const minCount    = ref(10);
const rootFn      = ref('');
const foldLoops   = ref(true);
const cgData      = ref(null);
const cgStats     = ref(null);

// ── 函数 CFG 参数/数据 ────────────────────────────────────────────────────

const maxCalls        = ref('20');
const fnSearchText    = ref('');
const showFnDropdown  = ref(false);
const fnDropdownList  = ref([]);  // [{fnName, fnIid, callCount, minLine}]
const fnDropdownIdx   = ref(0);
const selectedFn      = ref(null); // {fnName, fnIid}
const fnCfgData       = ref(null);
const fnSearchWrapRef = ref(null);
const fnSearchRef     = ref(null);
let fnSearchTimer     = null;
let fnListCache       = null; // 全量函数列表缓存（仅加载一次）

// ── 计算：是否有图可显示 ─────────────────────────────────────────────────

const hasGraph = computed(() => {
    if (mode.value === 'callgraph') return cgData.value?.nodes?.length > 0;
    return fnCfgData.value?.blocks?.length > 0;
});

// ── 模式切换 ──────────────────────────────────────────────────────────────

function switchMode(m) {
    if (mode.value === m) return;
    mode.value = m;
    error.value = '';
    tooltip.value = null;
    destroyCy();
    if (m === 'callgraph') {
        loadCfg();
    } else {
        // 函数CFG模式：预加载函数列表
        loadFnList();
    }
}

// ── 函数搜索 ──────────────────────────────────────────────────────────────

async function loadFnList() {
    if (fnListCache) return;
    try {
        const r = await fetch(`/api/sessions/${props.sessionId}/functions?limit=500&minCalls=1`);
        if (!r.ok) return;
        const data = await r.json();
        fnListCache = (data.functions || []).map(f => ({
            fnName:    f.fn_name,
            fnIid:     f.fn_iid,
            callCount: f.call_count,
            minLine:   f.min_line,
        }));
        // 默认过滤一次
        filterFnList(fnSearchText.value);
    } catch (_) {}
}

function onFnSearchInput() {
    clearTimeout(fnSearchTimer);
    fnDropdownIdx.value = 0;
    fnSearchTimer = setTimeout(() => {
        if (!fnListCache) {
            loadFnList();
        } else {
            filterFnList(fnSearchText.value);
        }
        showFnDropdown.value = true;
    }, 150);
}

function filterFnList(q) {
    if (!fnListCache) {
        fnDropdownList.value = [];
        return;
    }
    const ql = (q || '').toLowerCase();
    fnDropdownList.value = (ql
        ? fnListCache.filter(f => f.fnName.toLowerCase().includes(ql))
        : fnListCache
    ).slice(0, 30);
}

function selectFn(fn) {
    selectedFn.value = fn;
    fnSearchText.value = fn.fnName;
    showFnDropdown.value = false;
    fnCfgData.value = null;
    destroyCy();
}

function selectFnByEnter() {
    if (fnDropdownList.value.length > 0) {
        selectFn(fnDropdownList.value[fnDropdownIdx.value]);
    }
}

// 点击外部关闭下拉
function handleClickOutside(e) {
    if (fnSearchWrapRef.value && !fnSearchWrapRef.value.contains(e.target)) {
        showFnDropdown.value = false;
    }
}

// ── 函数 CFG 加载 ────────────────────────────────────────────────────────

async function loadFnCfg() {
    if (!selectedFn.value) return;
    loading.value = true;
    error.value = '';
    tooltip.value = null;
    destroyCy();

    try {
        const params = new URLSearchParams({
            fnName:   selectedFn.value.fnName,
            maxCalls: maxCalls.value,
        });
        if (selectedFn.value.fnIid != null) {
            params.set('fnIid', selectedFn.value.fnIid);
        }

        const r = await fetch(`/api/sessions/${props.sessionId}/fn-cfg?${params}`);
        if (!r.ok) {
            const msg = await r.json().catch(() => ({ error: r.statusText }));
            throw new Error(msg.error || r.statusText);
        }

        const data = await r.json();
        fnCfgData.value = data;

        if (data.blocks.length === 0) return;

        await nextTick();
        const elements = buildFnCfgElements(data);
        initCytoscape(elements, 'funcfg');
    } catch (e) {
        error.value = e.message;
    } finally {
        loading.value = false;
    }
}

// ── 函数 CFG → Cytoscape Elements ────────────────────────────────────────

function buildFnCfgElements(data) {
    const elements = [];

    for (const block of data.blocks) {
        // 构建块内显示文本（IDA 风格：每行一条代码）
        const lineTexts = block.lines.map(l => {
            const lineNo = l.line != null ? `L${l.line}` : '?';
            const src = truncate(l.srcText || '', 32);
            const cnt = l.execCount > 1 ? ` ×${fmtNum(l.execCount)}` : '';
            return `${lineNo.padEnd(5)} ${src}${cnt}`;
        });
        // 省略行提示
        if (block.omittedLines > 0) {
            lineTexts.push(`... +${block.omittedLines} 行`);
        }

        // 子调用显示（调用了哪些函数），最多显示 3 个
        const subCallsToShow = (block.subCalls || []).slice(0, 3);
        const callTexts = subCallsToShow.map(sc => `→ ${sc.fnName}()`);
        if ((block.subCalls || []).length > 3) {
            callTexts.push(`→ ...+${block.subCalls.length - 3} 调用`);
        }

        const allLines = [...lineTexts, ...callTexts];
        const label = allLines.join('\n') || `block:${block.minLine ?? '?'}`;

        const presencePct = data.sampledCalls > 0
            ? Math.round(block.presence / data.sampledCalls * 100)
            : 0;

        elements.push({
            data: {
                id:          block.id,
                label,
                type:        'block',
                isEntry:     block.isEntry,
                isHot:       block.isHot,
                isCold:      block.isCold,
                minLine:     block.minLine,
                maxLine:     block.maxLine,
                presence:    block.presence,
                presencePct,
                callCount:   data.sampledCalls,
                lineCount:   block.lines.length,
                subCalls:    block.subCalls,
                // 宽度根据最长行调整
                _maxLineLen: Math.max(...allLines.map(s => s.length), 1),
            },
            classes: [
                block.isEntry ? 'entry' : '',
                block.isHot   ? 'hot'   : '',
                block.isCold  ? 'cold'  : '',
            ].filter(Boolean),
        });
    }

    for (const edge of data.edges) {
        elements.push({
            data: {
                id:     edge.id,
                source: edge.source,
                target: edge.target,
                type:   edge.type,
                count:  edge.count,
                label:  edge.label,
            },
        });
    }

    return elements;
}

// ── 调用图（旧逻辑保留） ──────────────────────────────────────────────────

async function loadCfg() {
    if (!props.sessionId) return;
    loading.value = true;
    error.value = '';
    tooltip.value = null;
    destroyCy();

    try {
        const params = new URLSearchParams({
            depth:       depth.value,
            minCount:    minCount.value,
            foldLoops:   foldLoops.value ? 'true' : 'false',
            includeIids: 'true',
        });
        if (rootFn.value.trim()) params.set('rootFn', rootFn.value.trim());

        const r = await fetch(`/api/sessions/${props.sessionId}/cfg?${params}`);
        if (!r.ok) {
            const msg = await r.json().catch(() => ({ error: r.statusText }));
            throw new Error(msg.error || r.statusText);
        }

        const data = await r.json();
        cgData.value  = data;
        cgStats.value = data.stats;

        if (data.nodes.length === 0) return;

        await nextTick();
        const elements = buildCgElements(data);
        initCytoscape(elements, 'callgraph');
    } catch (e) {
        error.value = e.message;
    } finally {
        loading.value = false;
    }
}

function buildCgElements(data) {
    const elements = [];
    for (const node of data.nodes) {
        let label = '';
        if (node.type === 'function') {
            label = node.fnName || node.id;
            if (node.callCount > 1) label += `\n×${node.callCount.toLocaleString()}`;
        } else if (node.type === 'loop') {
            label = `🔄 L${node.line ?? '?'}\n×${(node.totalIters || 0).toLocaleString()}`;
        } else if (node.type === 'hotspot') {
            label = truncate(node.srcText || `L${node.line}`, 20) + `\n×${(node.count || 0).toLocaleString()}`;
        }
        const classes = data.rootNodes?.includes(node.id) ? ['root'] : [];
        elements.push({ data: { ...node, label }, classes });
    }
    for (const edge of data.edges) {
        let edgeLabel = '';
        let loopLabel = '';
        if (edge.type === 'call' && edge.edgeCount > 1) edgeLabel = `×${edge.edgeCount}`;
        if (edge.type === 'loop-back') loopLabel = `×${(edge.totalIters || 0).toLocaleString()}`;
        elements.push({ data: { ...edge, edgeLabel, loopLabel } });
    }
    return elements;
}

// ── Cytoscape 初始化 ──────────────────────────────────────────────────────

function destroyCy() {
    if (cy) {
        cy.destroy();
        cy = null;
    }
}

function initCytoscape(elements, cfgMode) {
    destroyCy();
    const nodeCount = elements.filter(e => !e.data?.source).length;

    cy = cytoscape({
        container: cyRef.value,
        elements,
        style: cfgMode === 'funcfg' ? buildFnCfgStyle() : buildCgStyle(),
        layout: cfgMode === 'funcfg'
            ? buildFnCfgLayout(nodeCount)
            : buildCgLayout(nodeCount),
        minZoom: 0.05,
        maxZoom: 4,
        wheelSensitivity: 0.3,
    });

    // 节点点击 → Tooltip
    cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        const data = node.data();
        const pos  = evt.renderedPosition;
        const props_obj = {};
        let isLoop = false;

        if (cfgMode === 'funcfg') {
            props_obj['行号范围']  = data.minLine != null ? `L${data.minLine} ~ L${data.maxLine}` : '?';
            props_obj['出现频率']  = `${data.presencePct}%（${data.presence}/${data.callCount} 次调用）`;
            props_obj['代码行数']  = data.lineCount;
            if (data.subCalls?.length) {
                props_obj['调用函数'] = data.subCalls.map(s => s.fnName).join(', ');
            }
        } else if (data.type === 'function') {
            props_obj['调用次数'] = data.callCount?.toLocaleString();
            props_obj['最小行号'] = `L${data.minLine ?? '?'}`;
            props_obj['调用深度'] = `${data.minDepth ?? '?'} ~ ${data.maxDepth ?? '?'}`;
        } else if (data.type === 'loop') {
            isLoop = true;
            props_obj['迭代次数'] = data.totalIters?.toLocaleString();
            props_obj['行号']     = `L${data.line ?? '?'}`;
            props_obj['IID']      = data.iid;
        } else if (data.type === 'hotspot') {
            props_obj['执行次数'] = data.count?.toLocaleString();
            props_obj['行号']     = `L${data.line ?? '?'}`;
            props_obj['源码']     = truncate(data.srcText, 40);
        }

        tooltip.value = {
            x:     pos.x + 12,
            y:     pos.y + 12,
            title: cfgMode === 'funcfg'
                ? (data.minLine != null ? `Block L${data.minLine}` : data.id)
                : (data.label || data.id),
            props: props_obj,
            isLoop,
        };
    });

    // 循环节点双击 → 迭代详情
    if (cfgMode === 'callgraph') {
        cy.on('dblclick', 'node[type="loop"]', (evt) => {
            openLoopDrawer(evt.target.data());
        });
    }

    cy.on('tap', (evt) => {
        if (evt.target === cy) tooltip.value = null;
    });
}

// ── IDA 风格块 CFG 样式 ───────────────────────────────────────────────────

function buildFnCfgStyle() {
    return [
        // 普通块
        {
            selector: 'node[type="block"]',
            style: {
                'label':             'data(label)',
                'shape':             'rectangle',
                'background-color':  '#141520',
                'border-width':      1.5,
                'border-color':      '#3d4070',
                'color':             '#c8d0e0',
                'font-size':         '10px',
                'font-family':       'JetBrains Mono, Consolas, monospace',
                'text-valign':       'center',
                'text-halign':       'center',
                'text-wrap':         'wrap',
                'text-max-width':    400,   // 单位 px，用数字不用字符串
                'width':             'label',
                'height':            'label',
                'padding':           12,    // Cytoscape padding 只接受单个数字
            },
        },
        // 入口块（绿色边框）
        {
            selector: 'node.entry',
            style: {
                'border-color':     '#22c55e',
                'border-width':      2.5,
                'background-color': '#0d1f14',
            },
        },
        // 热路径块（暖橙色背景）
        {
            selector: 'node.hot',
            style: {
                'background-color': '#1a1209',
                'border-color':     '#f59e0b',
                'border-width':      2,
            },
        },
        // 冷路径块（暗色+虚线边框）
        {
            selector: 'node.cold',
            style: {
                'background-color': '#0e0e14',
                'border-color':     '#374151',
                'border-style':     'dashed',
                'color':            '#6b7280',
            },
        },
        // 选中
        {
            selector: 'node:selected',
            style: {
                'border-color':     '#818cf8',
                'border-width':      2.5,
                'background-color': '#1a1c38',
            },
        },
        // 顺序边（灰色）
        {
            selector: 'edge[type="flow"]',
            style: {
                'line-color':         '#4b5563',
                'target-arrow-color': '#6b7280',
                'target-arrow-shape': 'triangle',
                'curve-style':        'taxi',
                'taxi-direction':     'downward',
                'taxi-turn':          '50%',
                'width':              1.5,
                'label':              'data(label)',
                'font-size':          '9px',
                'color':              '#6b7280',
            },
        },
        // 条件边（蓝/绿）
        {
            selector: 'edge[type="cond"]',
            style: {
                'line-color':         '#6366f1',
                'target-arrow-color': '#818cf8',
                'target-arrow-shape': 'triangle',
                'curve-style':        'taxi',
                'taxi-direction':     'downward',
                'width':              2,
                'label':              'data(label)',
                'font-size':          '10px',
                'font-weight':        'bold',
                'color':              '#818cf8',
                'text-background-color': '#0f1117',
                'text-background-opacity': 0.9,
                'text-background-padding': '2px',
            },
        },
        // 回边（循环，红橙色虚线弯曲）
        {
            selector: 'edge[type="back"]',
            style: {
                'line-color':         '#f59e0b',
                'target-arrow-color': '#f59e0b',
                'target-arrow-shape': 'triangle',
                'curve-style':        'unbundled-bezier',
                'control-point-distances': [120],
                'control-point-weights':   [0.5],
                'width':              2,
                'line-style':         'dashed',
                'label':              '↩',
                'font-size':          '12px',
                'color':              '#f59e0b',
                'text-background-color': '#0f1117',
                'text-background-opacity': 0.9,
                'text-background-padding': '2px',
            },
        },
        // 边选中
        {
            selector: 'edge:selected',
            style: { 'line-color': '#818cf8', 'target-arrow-color': '#818cf8' },
        },
    ];
}

// ── 函数 CFG 布局（自顶向下层次布局） ────────────────────────────────────

function buildFnCfgLayout(_nodeCount) {
    return {
        name:    'breadthfirst',
        directed: true,
        padding:  40,
        spacingFactor: 1.6,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: true,
        // roots 由布局引擎自动识别（无入边节点），不手动传入（此时 cy 可能还未赋值）
    };
}

// ── 调用图样式（保持原有） ────────────────────────────────────────────────

function buildCgStyle() {
    return [
        {
            selector: 'node[type="function"]',
            style: {
                'label':             'data(label)',
                'shape':             'roundrectangle',
                'background-color':  '#1e1f35',
                'border-width':      2,
                'border-color':      '#6366f1',
                'color':             '#e2e8f0',
                'font-size':         '10px',
                'font-family':       'JetBrains Mono, monospace',
                'text-valign':       'center',
                'text-halign':       'center',
                'width':             'label',
                'height':            36,
                'padding':           8,
                'text-wrap':         'wrap',
                'text-max-width':    160,
            },
        },
        {
            selector: 'node[type="loop"]',
            style: {
                'label':            'data(label)',
                'shape':            'ellipse',
                'background-color': '#1f2530',
                'border-width':     2,
                'border-color':     '#f59e0b',
                'color':            '#fbbf24',
                'font-size':        '9px',
                'text-valign':      'center',
                'text-halign':      'center',
                'width':            80,
                'height':           80,
                'text-wrap':        'wrap',
                'text-max-width':   70,
            },
        },
        {
            selector: 'node[type="hotspot"]',
            style: {
                'label':            'data(label)',
                'shape':            'diamond',
                'background-color': '#1f1e2e',
                'border-width':     1,
                'border-color':     '#ef4444',
                'color':            '#f87171',
                'font-size':        '9px',
                'font-family':      'JetBrains Mono, monospace',
                'text-valign':      'center',
                'text-halign':      'center',
                'width':            90,
                'height':           50,
                'text-wrap':        'wrap',
                'text-max-width':   80,
            },
        },
        {
            selector: 'node.root',
            style: { 'border-color': '#22c55e', 'border-width': 3 },
        },
        {
            selector: 'node:selected',
            style: { 'background-color': '#2d2f50', 'border-color': '#818cf8', 'border-width': 3 },
        },
        {
            selector: 'edge[type="call"]',
            style: {
                'line-color':         '#3d4070',
                'target-arrow-color': '#6366f1',
                'target-arrow-shape': 'triangle',
                'curve-style':        'bezier',
                'width':              'mapData(edgeCount, 1, 100, 1, 5)',
                'label':              'data(edgeLabel)',
                'font-size':          '9px',
                'color':              '#6b7280',
                'text-background-color': '#0f1117',
                'text-background-opacity': 0.8,
                'text-background-padding': '2px',
            },
        },
        {
            selector: 'edge[type="loop-back"]',
            style: {
                'line-color':         '#f59e0b',
                'target-arrow-color': '#f59e0b',
                'target-arrow-shape': 'triangle',
                'curve-style':        'loop',
                'loop-direction':     '-45deg',
                'loop-sweep':         '-90deg',
                'width':              2,
                'line-style':         'dashed',
                'label':              'data(loopLabel)',
                'font-size':          '9px',
                'color':              '#f59e0b',
            },
        },
        {
            selector: 'node:active',
            style: { 'overlay-opacity': 0.1 },
        },
        {
            selector: 'edge:selected',
            style: { 'line-color': '#818cf8', 'target-arrow-color': '#818cf8' },
        },
    ];
}

function buildCgLayout(nodeCount) {
    if (nodeCount <= 20) {
        return { name: 'breadthfirst', directed: true, padding: 30, spacingFactor: 1.5, avoidOverlap: true, nodeDimensionsIncludeLabels: true };
    }
    return { name: 'cose', animate: false, randomize: false, nodeRepulsion: () => 4000, idealEdgeLength: () => 80, edgeElasticity: () => 50, gravity: 0.25, numIter: 1000, initialTemp: 200, coolingFactor: 0.95, minTemp: 1.0, padding: 30 };
}

// ── 图操作 ────────────────────────────────────────────────────────────────

function fitGraph() {
    cy?.fit(undefined, 40);
}

function resetLayout() {
    if (!cy) return;
    const nodeCount = cy.nodes().length;
    const layout = mode.value === 'funcfg'
        ? buildFnCfgLayout(nodeCount)
        : buildCgLayout(nodeCount);
    cy.layout(layout).run();
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
}

function fmtNum(n) {
    if (n == null) return '';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

// ── 循环迭代抽屉 ────────────────────────────────────────────────────────────

const loopDrawer = reactive({
    open:       false,
    loading:    false,
    loopId:     null,
    iid:        null,
    line:       null,
    totalIters: null,
    iterations: [],
    varNames:   [],
    total:      0,
    page:       0,
    pageSize:   50,
});

async function openLoopDrawer(nodeData) {
    loopDrawer.open       = true;
    loopDrawer.loading    = true;
    loopDrawer.iid        = nodeData.iid;
    loopDrawer.line       = nodeData.line;
    loopDrawer.totalIters = nodeData.totalIters;
    loopDrawer.iterations = [];
    loopDrawer.varNames   = [];
    loopDrawer.total      = 0;
    loopDrawer.page       = 0;
    loopDrawer.loopId     = null;
    tooltip.value         = null;

    try {
        const loopListRes = await fetch(`/api/sessions/${props.sessionId}/loop-iterations?limit=1`);
        if (!loopListRes.ok) throw new Error(await loopListRes.text());
        const loopListData = await loopListRes.json();
        const matchedLoop = loopListData.loops.find(l => l.iid === nodeData.iid);
        if (!matchedLoop) { loopDrawer.loading = false; return; }
        loopDrawer.loopId = matchedLoop.id;
        await loadIterPage(0);
    } catch (e) {
        console.error('openLoopDrawer error', e);
        loopDrawer.loading = false;
    }
}

async function loadIterPage(page) {
    if (loopDrawer.loopId == null) return;
    loopDrawer.loading = true;
    loopDrawer.page    = page;
    try {
        const offset = page * loopDrawer.pageSize;
        const res = await fetch(
            `/api/sessions/${props.sessionId}/loop-iterations` +
            `?loopId=${loopDrawer.loopId}&limit=${loopDrawer.pageSize}&offset=${offset}`
        );
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        loopDrawer.total      = data.total;
        loopDrawer.iterations = processIterations(data.iterations);
        loopDrawer.varNames   = buildVarNames(data.iterations);
    } catch (e) {
        console.error('loadIterPage error', e);
    } finally {
        loopDrawer.loading = false;
    }
}

function processIterations(iters) {
    return iters.map((iter, idx) => {
        const prev = idx > 0 ? iters[idx - 1].vars_snapshot : null;
        const changedVars = new Set();
        if (prev) {
            const allKeys = new Set([...Object.keys(prev), ...Object.keys(iter.vars_snapshot)]);
            for (const k of allKeys) {
                if (String(prev[k] ?? '') !== String(iter.vars_snapshot[k] ?? '')) changedVars.add(k);
            }
        }
        return { ...iter, _changedVars: changedVars, _hasChange: changedVars.size > 0 };
    });
}

function buildVarNames(iters) {
    const seen = new Map();
    for (const iter of iters) {
        for (const k of Object.keys(iter.vars_snapshot)) {
            if (!seen.has(k)) seen.set(k, iter.iteration_idx);
        }
    }
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 20).map(([k]) => k);
}

function formatVal(v) {
    if (v === undefined || v === null) return '—';
    const s = String(v);
    return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

function closeLoopDrawer() {
    loopDrawer.open = false;
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

onMounted(() => {
    document.addEventListener('click', handleClickOutside);
    // 默认进入函数CFG模式，预加载函数列表
    loadFnList();
});

onUnmounted(() => {
    document.removeEventListener('click', handleClickOutside);
    destroyCy();
});

watch(() => props.sessionId, () => {
    fnListCache = null;
    fnCfgData.value = null;
    cgData.value = null;
    selectedFn.value = null;
    fnSearchText.value = '';
    destroyCy();
    if (mode.value === 'callgraph') {
        loadCfg();
    } else {
        loadFnList();
    }
});
</script>

<style scoped>
/* ── 工具栏 ─────────────────────────────────────────────────────────── */

.cfg-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-group label {
  margin: 0;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-muted);
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--border-color);
  margin: 0 4px;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}
.toggle-label input { cursor: pointer; }

.stats-text {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

.trunc-warn {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  background: rgba(245,158,11,0.15);
  color: #fcd34d;
  border: 1px solid rgba(245,158,11,0.3);
  cursor: help;
}

/* ── 模式切换按钮 ──────────────────────────────────────────────────── */

.mode-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 2px;
}

.mode-btn {
  background: none;
  border: none;
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.mode-btn:hover { color: var(--text-primary); background: var(--bg-secondary); }
.mode-btn.active {
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-weight: 600;
}

/* ── 函数搜索下拉 ─────────────────────────────────────────────────── */

.fn-search-group { position: relative; }

.fn-search-wrap {
  position: relative;
}

.fn-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  width: 340px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  z-index: 100;
}

.fn-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.fn-dropdown-item:last-child { border-bottom: none; }
.fn-dropdown-item:hover,
.fn-dropdown-item.active {
  background: var(--bg-tertiary);
}

.fn-name {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 8px;
}

.fn-meta {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── 图容器 ─────────────────────────────────────────────────────────── */

.cfg-container {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}

.cy-canvas {
  width: 100%;
  height: calc(100vh - 220px);
  min-height: 500px;
}

/* ── 图例 ────────────────────────────────────────────────────────────── */

.legend {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 10px 14px;
  background: rgba(15,17,23,0.92);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  z-index: 10;
  min-width: 130px;
}

.legend-title {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.legend-dot {
  width: 10px; height: 10px;
  border-radius: 2px;
  display: inline-block;
  flex-shrink: 0;
}
.legend-line {
  width: 16px; height: 2px;
  display: inline-block;
  flex-shrink: 0;
}

/* 调用图图例 */
.fn-dot   { background: #6366f1; border-radius: 50%; }
.loop-dot { background: #f59e0b; border-radius: 50%; }
.hot-dot  { background: #ef4444; border-radius: 50%; }
.call-line { background: #6366f1; }
.loop-line { background: #f59e0b; }

/* 函数CFG图例 */
.entry-dot    { background: #22c55e; }
.hot-block-dot { background: #f59e0b; }
.cold-block-dot { background: #374151; border: 1px dashed #6b7280; }
.flow-line  { background: #4b5563; }
.cond-line  { background: #6366f1; }
.back-line  { background: #f59e0b; border-top: 2px dashed #f59e0b; height: 0; }

/* ── Tooltip ────────────────────────────────────────────────────────── */

.node-tooltip {
  position: absolute;
  background: rgba(15,17,23,0.96);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 14px;
  z-index: 20;
  pointer-events: none;
  min-width: 180px;
  max-width: 300px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
}

.tooltip-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
  word-break: break-all;
}

.tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  margin-bottom: 3px;
}

.tooltip-key { color: var(--text-muted); }
.tooltip-val { color: var(--text-primary); font-family: 'JetBrains Mono', monospace; text-align: right; word-break: break-all; }

.tooltip-hint {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color);
  font-size: 10px;
  color: var(--text-muted);
  text-align: center;
}

/* ── 通用状态 ─────────────────────────────────────────────────────── */

.cfg-loading {
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
}

.empty-state { text-align: center; padding: 48px; }
.empty-hint  { color: var(--text-muted); font-size: 12px; }
.error-state { color: var(--danger); padding: 16px 20px; }

/* ── 循环迭代抽屉 ────────────────────────────────────────────────── */

.loop-drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 1000;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
}

.loop-drawer {
  width: min(860px, 92vw);
  height: 100vh;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: -8px 0 40px rgba(0,0,0,0.5);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--bg-tertiary);
}

.drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.drawer-subtitle {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
}

.drawer-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  padding: 4px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.drawer-close:hover { color: var(--text-primary); background: var(--bg-primary); }

.drawer-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
}

.drawer-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  gap: 4px;
}

.drawer-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 12px 20px 0;
}

.iter-info {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 8px;
  flex-shrink: 0;
}

.iter-table-wrap {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.iter-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
}

.iter-table th {
  position: sticky;
  top: 0;
  background: var(--bg-tertiary);
  padding: 7px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
  color: var(--text-muted);
  font-weight: 600;
  font-size: 10px;
  z-index: 1;
}

.iter-table td {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iter-table tbody tr:hover { background: var(--bg-tertiary); }
.iter-changed { background: rgba(99,102,241,0.04); }

.iter-idx-th { width: 48px; }
.iter-seq-th { width: 180px; }
.iter-var-th { min-width: 100px; max-width: 200px; }

.iter-idx { color: var(--text-muted); text-align: right; }
.iter-seq { color: var(--text-muted); white-space: nowrap; }
.iter-val { color: var(--text-primary); }

.val-changed {
  color: #fbbf24 !important;
  font-weight: 700;
  background: rgba(245,158,11,0.08);
}

.seq-badge {
  display: inline-block;
  padding: 1px 5px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  font-size: 10px;
  color: var(--accent);
}

.seq-sep {
  color: var(--text-muted);
  margin: 0 3px;
  font-size: 10px;
}

.drawer-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 0;
  flex-shrink: 0;
  border-top: 1px solid var(--border-color);
  margin-top: 4px;
}

.page-info {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
