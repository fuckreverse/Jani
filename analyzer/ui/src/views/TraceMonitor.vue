<template>
  <div class="trace-monitor">
    <div class="page-header">
      <div>
        <h1 class="page-title">Trace 收集监控</h1>
        <p class="page-subtitle">实时监控 WebSocket trace 接收状态（<code class="inline-code">ws://{{ wsEndpoint }}</code>）</p>
      </div>
      <div class="header-actions">
        <span class="refresh-hint">每 {{ POLL_INTERVAL / 1000 }}s 自动刷新</span>
        <button class="btn-secondary" @click="fetchStats">立即刷新</button>
      </div>
    </div>

    <!-- 连接状态指示 -->
    <div class="status-bar card" :class="statusClass">
      <span class="status-dot" :class="dotClass"></span>
      <span class="status-text">{{ statusText }}</span>
      <span class="status-time" v-if="lastFetch">上次更新：{{ lastFetchTime }}</span>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-grid" v-if="stats">
      <div class="stat-card card">
        <div class="stat-icon">🔌</div>
        <div class="stat-body">
          <div class="stat-value">{{ stats.connections }}</div>
          <div class="stat-label">当前活跃连接</div>
        </div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">📦</div>
        <div class="stat-body">
          <div class="stat-value">{{ fmtNum(stats.batchesReceived) }}</div>
          <div class="stat-label">已接收批次</div>
        </div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">⚡</div>
        <div class="stat-body">
          <div class="stat-value">{{ fmtNum(stats.eventsReceived) }}</div>
          <div class="stat-label">已接收事件</div>
        </div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">📊</div>
        <div class="stat-body">
          <div class="stat-value">{{ fmtBytes(stats.bytesReceived) }}</div>
          <div class="stat-label">已接收数据量</div>
        </div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">⏱️</div>
        <div class="stat-body">
          <div class="stat-value">{{ fmtUptime(stats.uptime) }}</div>
          <div class="stat-label">服务运行时长</div>
        </div>
      </div>
      <div class="stat-card card" :class="{ 'stat-card-warn': stats.errors > 0 }">
        <div class="stat-icon">{{ stats.errors > 0 ? '⚠️' : '✅' }}</div>
        <div class="stat-body">
          <div class="stat-value" :class="{ 'val-warn': stats.errors > 0 }">{{ stats.errors }}</div>
          <div class="stat-label">累计错误数</div>
        </div>
      </div>
    </div>

    <!-- 输出目录 -->
    <div class="info-card card" v-if="stats">
      <div class="info-row">
        <span class="info-label">Trace 输出目录</span>
        <code class="info-value">{{ stats.tracesDir }}</code>
      </div>
      <div class="info-row">
        <span class="info-label">WS 接入地址</span>
        <code class="info-value">ws://{{ wsEndpoint }}</code>
      </div>
      <div class="info-row">
        <span class="info-label">吞吐率</span>
        <code class="info-value">{{ throughput }}</code>
      </div>
    </div>

    <!-- 历史吞吐折线图（最近 60 个采样点） -->
    <div class="chart-card card" v-if="history.length > 1">
      <div class="chart-title">事件吞吐率（events/s）</div>
      <svg class="chart" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none">
        <!-- 零线 -->
        <line x1="0" :y1="CHART_H" :x2="CHART_W" :y2="CHART_H" stroke="#2d3148" stroke-width="1" />
        <!-- 折线 -->
        <polyline
          :points="chartPoints"
          fill="none"
          stroke="#6366f1"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <!-- 填充 -->
        <polygon :points="chartFill" fill="rgba(99,102,241,0.12)" />
      </svg>
    </div>

    <!-- trace 文件列表（需后端支持，暂用 stats 里信息展示） -->
    <div class="traces-card card">
      <div class="traces-header">
        <span class="traces-title">Trace 文件列表</span>
        <button class="btn-secondary btn-sm" @click="fetchFiles">刷新</button>
      </div>
      <div v-if="loadingFiles" class="loading"><div class="spinner"></div><span>加载中...</span></div>
      <div v-else-if="files.length === 0" class="empty-state">暂无 trace 文件</div>
      <table v-else class="files-table">
        <thead>
          <tr>
            <th>文件名</th>
            <th>大小</th>
            <th>修改时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in files" :key="f.name">
            <td class="file-name">{{ f.name }}</td>
            <td class="file-size">{{ fmtBytes(f.size) }}</td>
            <td class="file-mtime">{{ fmtMtime(f.mtime) }}</td>
            <td class="file-actions">
              <button class="btn-secondary btn-xs" @click="importAsSession(f.name)" :disabled="f.importing">
                {{ f.importing ? '导入中...' : '导入会话' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

const POLL_INTERVAL = 3000;
const CHART_W = 600;
const CHART_H = 60;
const HISTORY_MAX = 60;

const stats        = ref(null);
const fetchError   = ref('');
const lastFetch    = ref(null);
const files        = ref([]);
const loadingFiles = ref(false);
const connecting   = ref(true);   // 启动时等待后端就绪

// 吞吐率历史（用于折线图）
const history = ref([]);   // [{ t, eps }]
let prevEvents = 0;
let prevTime   = 0;
let retryCount = 0;
const MAX_SILENT_RETRIES = 8;  // 最多静默重试 8 次（~24s）后才显示错误

// 计算当前 ws 端点（dev 代理下 location.host = localhost:5173，直接用当前域名也能工作）
const wsEndpoint = computed(() => `${location.host}/ws/trace`);

// ── 状态计算 ──────────────────────────────────────────────────────────────────
const statusClass = computed(() => {
    if (fetchError.value) return 'status-bar-error';
    if (!stats.value) return 'status-bar-unknown';
    return stats.value.connections > 0 ? 'status-bar-active' : 'status-bar-idle';
});

const dotClass = computed(() => {
    if (fetchError.value) return 'dot-error';
    if (!stats.value) return 'dot-unknown';
    return stats.value.connections > 0 ? 'dot-active' : 'dot-idle';
});

const statusText = computed(() => {
    if (connecting.value) return '正在连接后端服务...';
    if (fetchError.value) return `服务不可达：${fetchError.value}`;
    if (!stats.value) return '正在连接...';
    if (stats.value.connections > 0) return `接收中（${stats.value.connections} 个活跃连接）`;
    return '就绪（等待客户端连接）';
});

const lastFetchTime = computed(() => {
    if (!lastFetch.value) return '';
    return lastFetch.value.toLocaleTimeString();
});

const throughput = computed(() => {
    if (history.value.length < 2) return '—';
    const last = history.value[history.value.length - 1];
    return `${fmtNum(Math.round(last.eps))} events/s`;
});

// ── 折线图 ────────────────────────────────────────────────────────────────────
const chartPoints = computed(() => {
    const h = history.value;
    if (h.length < 2) return '';
    const maxEps = Math.max(...h.map(p => p.eps), 1);
    return h.map((p, i) => {
        const x = (i / (h.length - 1)) * CHART_W;
        const y = CHART_H - (p.eps / maxEps) * (CHART_H - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
});

const chartFill = computed(() => {
    if (!chartPoints.value) return '';
    return `0,${CHART_H} ${chartPoints.value} ${CHART_W},${CHART_H}`;
});

// ── 数据获取 ──────────────────────────────────────────────────────────────────
async function fetchStats() {
    try {
        const res = await fetch('/api/trace/stats');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // 成功：清除错误状态，标记已连接
        fetchError.value = '';
        connecting.value = false;
        retryCount = 0;
        lastFetch.value = new Date();

        // 计算 eps
        const now = Date.now();
        if (prevTime > 0) {
            const dt  = (now - prevTime) / 1000;
            const eps = dt > 0 ? (data.eventsReceived - prevEvents) / dt : 0;
            history.value.push({ t: now, eps: Math.max(0, eps) });
            if (history.value.length > HISTORY_MAX) history.value.shift();
        }
        prevEvents = data.eventsReceived;
        prevTime   = now;

        stats.value = data;
    } catch (e) {
        retryCount++;
        if (retryCount > MAX_SILENT_RETRIES) {
            // 超过静默重试次数后才显示错误
            connecting.value = false;
            fetchError.value = e.message;
        }
        // 否则保持 connecting 状态，下次 poll 继续重试
    }
}

async function fetchFiles() {
    loadingFiles.value = true;
    try {
        const res = await fetch('/api/trace/files');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        files.value = (data.files || []).map(f => ({ ...f, importing: false }));
    } catch {
        // 连接失败时保持 loading，等后端就绪后下次刷新
        if (!connecting.value) files.value = [];
    } finally {
        if (!connecting.value) loadingFiles.value = false;
    }
}

async function importAsSession(filename) {
    const f = files.value.find(x => x.name === filename);
    if (!f) return;
    f.importing = true;
    try {
        const res = await fetch('/api/trace/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        router.push(`/sessions/${data.sessionId}`);
    } catch (e) {
        alert(`导入失败：${e.message}`);
        f.importing = false;
    }
}

// ── 格式化工具 ─────────────────────────────────────────────────────────────────
function fmtNum(n) {
    if (n === undefined || n === null) return '—';
    return n.toLocaleString();
}

function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtUptime(s) {
    if (!s) return '—';
    const sec = parseFloat(s);
    if (sec < 60)   return `${sec.toFixed(0)}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function fmtMtime(mtime) {
    if (!mtime) return '—';
    return new Date(mtime).toLocaleString();
}

// ── 生命周期 ──────────────────────────────────────────────────────────────────
let timer = null;

onMounted(() => {
    fetchStats();
    // 后端就绪后立即拉一次文件列表
    const stopWatch = watch(connecting, (val) => {
        if (!val) { fetchFiles(); stopWatch(); }
    });
    timer = setInterval(() => {
        fetchStats();
        if (!connecting.value) fetchFiles();
    }, POLL_INTERVAL);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
});
</script>

<style scoped>
.page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 12px;
}

.page-title {
    font-size: 22px;
    font-weight: 700;
}

.page-subtitle {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 4px;
}

.inline-code {
    font-family: monospace;
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--accent);
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

.refresh-hint {
    font-size: 12px;
    color: var(--text-muted);
}

/* ── 状态栏 ──────────────────────────────────────────────────────── */
.status-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    margin-bottom: 16px;
    border-left: 3px solid var(--border-color);
}

.status-bar-active { border-left-color: var(--success); }
.status-bar-idle   { border-left-color: var(--info); }
.status-bar-error  { border-left-color: var(--danger); }
.status-bar-unknown{ border-left-color: var(--text-muted); }

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.dot-active  { background: var(--success); box-shadow: 0 0 6px var(--success); animation: pulse 1.5s infinite; }
.dot-idle    { background: var(--info); }
.dot-error   { background: var(--danger); }
.dot-unknown { background: var(--text-muted); }

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

.status-text {
    font-size: 13px;
    font-weight: 500;
    flex: 1;
}

.status-time {
    font-size: 11px;
    color: var(--text-muted);
}

/* ── 统计卡片网格 ─────────────────────────────────────────────────── */
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
}

.stat-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 18px;
}

.stat-card-warn {
    border-color: rgba(245,158,11,0.4);
}

.stat-icon {
    font-size: 22px;
    flex-shrink: 0;
}

.stat-value {
    font-size: 22px;
    font-weight: 700;
    font-family: monospace;
    color: var(--text-primary);
    line-height: 1.2;
}

.val-warn { color: var(--warning); }

.stat-label {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
}

/* ── 信息卡片 ──────────────────────────────────────────────────────── */
.info-card {
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.info-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
}

.info-label {
    font-size: 12px;
    color: var(--text-muted);
    width: 110px;
    flex-shrink: 0;
}

.info-value {
    font-family: monospace;
    font-size: 13px;
    color: var(--accent);
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 4px;
}

/* ── 折线图 ──────────────────────────────────────────────────────── */
.chart-card {
    margin-bottom: 16px;
    padding: 14px 16px;
}

.chart-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 8px;
}

.chart {
    width: 100%;
    height: 60px;
    display: block;
}

/* ── 文件列表 ──────────────────────────────────────────────────────── */
.traces-card {
    padding: 0;
    overflow: hidden;
}

.traces-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color);
}

.traces-title {
    font-size: 13px;
    font-weight: 600;
}

.files-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}

.files-table th {
    text-align: left;
    padding: 8px 16px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
}

.files-table td {
    padding: 9px 16px;
    border-bottom: 1px solid rgba(45,49,72,0.5);
    vertical-align: middle;
}

.files-table tr:last-child td {
    border-bottom: none;
}

.files-table tr:hover td {
    background: var(--bg-tertiary);
}

.file-name {
    font-family: monospace;
    font-size: 12px;
    color: var(--text-primary);
}

.file-size, .file-mtime {
    font-family: monospace;
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
}

.file-actions { width: 110px; }

.btn-sm {
    padding: 4px 10px;
    font-size: 12px;
}

.btn-xs {
    padding: 3px 9px;
    font-size: 11px;
    border-radius: 4px;
}
</style>
