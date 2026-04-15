<template>
  <div class="trace-monitor">
    <!-- 分析进度侧边抽屉 -->
    <ProgressDrawer
      :visible="showProgressDrawer"
      :session-id="progressSessionId"
      :session-name="progressSessionName"
      @close="showProgressDrawer = false"
      @view-session="goToSession"
    />

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

    <!-- trace 文件列表（增强版） -->
    <div class="traces-card card">
      <div class="traces-header">
        <div class="traces-header-left">
          <span class="traces-title">Trace 文件列表</span>
          <span class="traces-count" v-if="pagination.total > 0">共 {{ pagination.total }} 个</span>
        </div>
        <div class="traces-header-actions">
          <input
            v-model="searchQuery"
            type="text"
            class="search-input"
            placeholder="搜索文件名或别名..."
            @input="debouncedSearch"
          />
          <button class="btn-secondary btn-sm" @click="fetchFiles">刷新</button>
        </div>
      </div>

      <div v-if="loadingFiles" class="loading"><div class="spinner"></div><span>加载中...</span></div>
      <div v-else-if="files.length === 0" class="empty-state">暂无 trace 文件</div>
      <template v-else>
        <!-- 批量操作栏 -->
        <div class="batch-actions" v-if="selectedFiles.size > 0">
          <span class="selected-count">已选 {{ selectedFiles.size }} 项</span>
          <button class="btn-danger btn-sm" @click="batchDelete" :disabled="batchDeleting">
            {{ batchDeleting ? '删除中...' : '批量删除' }}
          </button>
          <button class="btn-secondary btn-sm" @click="selectedFiles.clear()">取消选择</button>
        </div>

        <table class="files-table">
          <thead>
            <tr>
              <th class="col-check"><input type="checkbox" @change="toggleSelectAll" :checked="isAllSelected" /></th>
              <th class="col-name">文件名 / 别名</th>
              <th class="col-project">来源工作空间</th>
              <th class="col-size">大小</th>
              <th class="col-mtime">修改时间</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in files" :key="f.name" :class="{ 'row-selected': selectedFiles.has(f.name) }">
              <td class="col-check">
                <input type="checkbox" :checked="selectedFiles.has(f.name)" @change="toggleSelect(f.name)" />
              </td>
              <td class="col-name">
                <div class="file-name-cell">
                  <span class="file-name">{{ f.name }}</span>
                  <div class="alias-row" v-if="f.alias">
                    <span class="alias-label">别名:</span>
                    <span class="alias-value">{{ f.alias }}</span>
                  </div>
                  <!-- 内联编辑别名 -->
                  <div class="alias-edit" v-if="editingFile === f.name">
                    <input
                      v-model="editingAlias"
                      type="text"
                      class="alias-input"
                      placeholder="输入别名"
                      @keydown.enter="saveAlias(f.name)"
                      @keydown.esc="cancelEditAlias"
                      ref="aliasInputRef"
                    />
                    <button class="btn-xs btn-primary" @click="saveAlias(f.name)">保存</button>
                    <button class="btn-xs btn-secondary" @click="cancelEditAlias">取消</button>
                  </div>
                </div>
              </td>
              <td class="col-project">
                <span v-if="f.projectName" class="project-tag" @click="goToProject(f.projectId)">
                  {{ f.projectName }}
                </span>
                <span v-else class="text-muted">—</span>
              </td>
              <td class="col-size">{{ fmtBytes(f.size) }}</td>
              <td class="col-mtime">{{ fmtMtime(f.mtime) }}</td>
              <td class="col-actions">
                <div class="action-btns">
                  <button class="btn-xs btn-secondary" @click="startEditAlias(f)" title="设置别名">✏️</button>
                  <button class="btn-xs btn-secondary" @click="downloadFile(f.name)" title="下载">⬇️</button>
                  <button class="btn-xs btn-accent" @click="openImportDialog(f)" :disabled="f.importing" title="导入会话">
                    {{ f.importing ? '...' : '📥' }}
                  </button>
                  <button class="btn-xs btn-danger" @click="confirmDelete(f.name)" title="删除">🗑</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 分页 -->
        <div class="pagination" v-if="pagination.totalPages > 1">
          <button class="btn-xs btn-secondary" :disabled="pagination.offset === 0" @click="goToPage(0)">«</button>
          <button class="btn-xs btn-secondary" :disabled="pagination.offset === 0" @click="goToPage(pagination.offset - pagination.limit)">‹</button>
          <span class="page-info">第 {{ currentPage }} / {{ pagination.totalPages }} 页</span>
          <button class="btn-xs btn-secondary" :disabled="pagination.offset + pagination.limit >= pagination.total" @click="goToPage(pagination.offset + pagination.limit)">›</button>
          <button class="btn-xs btn-secondary" :disabled="pagination.offset + pagination.limit >= pagination.total" @click="goToPage((pagination.totalPages - 1) * pagination.limit)">»</button>
        </div>
      </template>
    </div>

    <!-- 导入会话对话框 -->
    <div v-if="showImportDialog" class="dialog-overlay" @click.self="showImportDialog = false">
      <div class="dialog card" style="width: min(660px, 96vw)">
        <h2 class="dialog-title">导入为分析会话</h2>
        <p class="dialog-hint">文件：<code>{{ importTarget?.name }}</code></p>

        <div class="import-form">
          <div class="form-field">
            <label>会话名称（可选）</label>
            <input v-model="importForm.sessionName" placeholder="留空则自动生成" />
          </div>

          <div class="form-field">
            <label>关联工作空间（自动使用其 smap）</label>
            <select v-model="importForm.projectId">
              <option :value="null">不关联工作空间</option>
              <option v-for="p in availableProjects" :key="p.id" :value="p.id">
                {{ p.name }} {{ p.status === 'ready' ? '✓' : '(' + p.status + ')' }}
              </option>
            </select>
            <p class="field-hint" v-if="importForm.projectId">
              将使用该工作空间的 smap.json 进行源码映射
            </p>
          </div>

          <!-- 分析插件选择 -->
          <PluginSelector v-model="importForm.selectedPlugins" ref="pluginSelectorRef" />
        </div>

        <div v-if="importError" class="upload-error">❌ {{ importError }}</div>

        <div class="dialog-actions">
          <button class="btn-secondary" @click="showImportDialog = false">取消</button>
          <button class="btn-primary" :disabled="importing" @click="doImport">
            {{ importing ? '导入中...' : '开始导入' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认对话框 -->
    <div v-if="deleteTarget" class="dialog-overlay" @click.self="deleteTarget = null">
      <div class="dialog card" style="max-width: 420px">
        <h2 class="dialog-title">确认删除</h2>
        <p>确定删除文件 <strong>{{ deleteTarget }}</strong> 吗？</p>
        <p class="delete-hint">⚠️ 此操作不可撤销。对应的 .smap.json 文件也会被删除。</p>
        <div class="dialog-actions">
          <button class="btn-secondary" @click="deleteTarget = null">取消</button>
          <button class="btn-danger" :disabled="deleting" @click="doDelete">
            {{ deleting ? '删除中...' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import ProgressDrawer from './ProgressDrawer.vue';
import PluginSelector from '../components/session/PluginSelector.vue';
import { useConfig } from '../composables/useConfig.js';

const router = useRouter();
const { ui: uiCfg } = useConfig();

const CHART_W = 600;
const CHART_H = 60;
const POLL_INTERVAL = computed(() => uiCfg.value.traceMonitorPollMs);
const HISTORY_MAX   = computed(() => uiCfg.value.traceMonitorHistoryMax);
const PAGE_SIZE     = computed(() => uiCfg.value.traceMonitorPageSize);

const stats        = ref(null);
const fetchError   = ref('');
const lastFetch    = ref(null);
const files        = ref([]);
const loadingFiles = ref(false);
const connecting   = ref(true);

// 分页和搜索
const pagination   = ref({ total: 0, offset: 0, limit: PAGE_SIZE.value, totalPages: 1 });
const searchQuery  = ref('');
let searchTimer    = null;

// 多选
const selectedFiles = ref(new Set());
const batchDeleting = ref(false);

// 别名编辑
const editingFile  = ref(null);
const editingAlias = ref('');
const aliasInputRef = ref(null);

// 导入会话
const showImportDialog    = ref(false);
const importTarget        = ref(null);
const importForm          = ref({ sessionName: '', projectId: null, selectedPlugins: [] });
const importing           = ref(false);
const importError         = ref('');
const pluginSelectorRef   = ref(null);
const availableProjects = ref([]);

// 进度抽屉
const showProgressDrawer  = ref(false);
const progressSessionId   = ref(null);
const progressSessionName = ref('');

// 删除确认
const deleteTarget = ref(null);
const deleting     = ref(false);

// 吞吐率历史（用于折线图）
const history = ref([]);
let prevEvents = 0;
let prevTime   = 0;
let retryCount = 0;
const MAX_SILENT_RETRIES = 8;

// 计算当前 ws 端点
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

const currentPage = computed(() => Math.floor(pagination.value.offset / pagination.value.limit) + 1);

const isAllSelected = computed(() => {
    return files.value.length > 0 && files.value.every(f => selectedFiles.value.has(f.name));
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
        fetchError.value = '';
        connecting.value = false;
        retryCount = 0;
        lastFetch.value = new Date();

        const now = Date.now();
        if (prevTime > 0) {
            const dt  = (now - prevTime) / 1000;
            const eps = dt > 0 ? (data.eventsReceived - prevEvents) / dt : 0;
            history.value.push({ t: now, eps: Math.max(0, eps) });
            if (history.value.length > HISTORY_MAX.value) history.value.shift();
        }
        prevEvents = data.eventsReceived;
        prevTime   = now;

        stats.value = data;
    } catch (e) {
        retryCount++;
        if (retryCount > MAX_SILENT_RETRIES) {
            connecting.value = false;
            fetchError.value = e.message;
        }
    }
}

async function fetchFiles() {
    loadingFiles.value = true;
    try {
        const params = new URLSearchParams({
            offset: pagination.value.offset,
            limit: pagination.value.limit,
        });
        if (searchQuery.value.trim()) {
            params.set('q', searchQuery.value.trim());
        }

        const res = await fetch(`/api/trace/files?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        files.value = (data.files || []).map(f => ({ ...f, importing: false }));
        pagination.value = {
            total: data.total,
            offset: data.offset,
            limit: data.limit,
            totalPages: Math.ceil(data.total / data.limit),
        };
        // 清理已选中的不在当前页的文件
        const currentNames = new Set(files.value.map(f => f.name));
        for (const name of selectedFiles.value) {
            if (!currentNames.has(name)) selectedFiles.value.delete(name);
        }
    } catch {
        if (!connecting.value) files.value = [];
    } finally {
        if (!connecting.value) loadingFiles.value = false;
    }
}

function debouncedSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        pagination.value.offset = 0;
        fetchFiles();
    }, 300);
}

function goToPage(offset) {
    pagination.value.offset = Math.max(0, Math.min(offset, pagination.value.total - 1));
    fetchFiles();
}

// ── 多选操作 ───────────────────────────────────────────────────────────────────
function toggleSelectAll(e) {
    if (e.target.checked) {
        files.value.forEach(f => selectedFiles.value.add(f.name));
    } else {
        selectedFiles.value.clear();
    }
}

function toggleSelect(name) {
    if (selectedFiles.value.has(name)) {
        selectedFiles.value.delete(name);
    } else {
        selectedFiles.value.add(name);
    }
}

async function batchDelete() {
    if (selectedFiles.value.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedFiles.value.size} 个文件吗？`)) return;

    batchDeleting.value = true;
    try {
        const res = await fetch('/api/trace/files/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names: [...selectedFiles.value] }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // 从列表中移除已删除的文件
        const deletedSet = new Set(data.deleted || []);
        files.value = files.value.filter(f => !deletedSet.has(f.name));
        selectedFiles.value.clear();
        pagination.value.total -= deletedSet.size;
    } catch (e) {
        alert(`批量删除失败：${e.message}`);
    } finally {
        batchDeleting.value = false;
    }
}

// ── 别名编辑 ───────────────────────────────────────────────────────────────────
function startEditAlias(f) {
    editingFile.value = f.name;
    editingAlias.value = f.alias || '';
    nextTick(() => {
        if (aliasInputRef.value?.[0]) aliasInputRef.value[0].focus();
    });
}

function cancelEditAlias() {
    editingFile.value = null;
    editingAlias.value = '';
}

async function saveAlias(filename) {
    try {
        const res = await fetch(`/api/trace/files/${encodeURIComponent(filename)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: editingAlias.value.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const f = files.value.find(x => x.name === filename);
        if (f) f.alias = data.alias;
        editingFile.value = null;
        editingAlias.value = '';
    } catch (e) {
        alert(`保存别名失败：${e.message}`);
    }
}

// ── 下载 ───────────────────────────────────────────────────────────────────────
function downloadFile(filename) {
    const a = document.createElement('a');
    a.href = `/api/trace/files/${encodeURIComponent(filename)}/download`;
    a.download = filename;
    a.click();
}

// ── 导入会话 ───────────────────────────────────────────────────────────────────
async function loadProjects() {
    try {
        const res = await fetch('/api/projects');
        if (!res.ok) return;
        const data = await res.json();
        availableProjects.value = (data.projects || data).filter(p => p.status === 'ready');
    } catch { /* ignore */ }
}

function openImportDialog(f) {
    importTarget.value = f;
    importForm.value = { sessionName: '', projectId: null };
    importError.value = '';
    showImportDialog.value = true;
    loadProjects();
}

async function doImport() {
    if (!importTarget.value) return;
    importing.value = true;
    importError.value = '';

    try {
        const selectedPlugins = pluginSelectorRef.value?.getPayload();

        const res = await fetch('/api/trace/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: importTarget.value.name,
                name: importForm.value.sessionName.trim() || undefined,
                projectId: importForm.value.projectId || undefined,
                selectedPlugins,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        showImportDialog.value = false;

        // 打开进度抽屉
        progressSessionId.value   = data.sessionId;
        progressSessionName.value = importForm.value.sessionName || importTarget.value.name.replace(/\.bin$/, '');
        showProgressDrawer.value  = true;

    } catch (e) {
        importError.value = e.message;
    } finally {
        importing.value = false;
    }
}

function goToSession() {
    if (progressSessionId.value) {
        showProgressDrawer.value = false;
        router.push(`/sessions/${progressSessionId.value}`);
    }
}

function goToProject(projectId) {
    if (projectId) {
        router.push(`/workspaces/${projectId}`);
    }
}

// ── 单个删除 ───────────────────────────────────────────────────────────────────
function confirmDelete(filename) {
    deleteTarget.value = filename;
}

async function doDelete() {
    if (!deleteTarget.value) return;
    deleting.value = true;
    try {
        const res = await fetch(`/api/trace/files/${encodeURIComponent(deleteTarget.value)}`, {
            method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        files.value = files.value.filter(f => f.name !== deleteTarget.value);
        pagination.value.total--;
        deleteTarget.value = null;
    } catch (e) {
        alert(`删除失败：${e.message}`);
    } finally {
        deleting.value = false;
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
    const stopWatch = watch(connecting, (val) => {
        if (!val) { fetchFiles(); stopWatch(); }
    });
    timer = setInterval(() => {
        fetchStats();
        if (!connecting.value) fetchFiles();
    }, POLL_INTERVAL.value);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
    if (searchTimer) clearTimeout(searchTimer);
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
    flex-wrap: wrap;
    gap: 12px;
}

.traces-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
}

.traces-title {
    font-size: 13px;
    font-weight: 600;
}

.traces-count {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 10px;
}

.traces-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.search-input {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 12px;
    width: 200px;
}

.search-input:focus {
    outline: none;
    border-color: var(--accent);
}

/* 批量操作栏 */
.batch-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    background: rgba(99, 102, 241, 0.08);
    border-bottom: 1px solid var(--border-color);
}

.selected-count {
    font-size: 12px;
    color: var(--accent);
    font-weight: 500;
}

.files-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}

.files-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
}

.files-table td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(45,49,72,0.5);
    vertical-align: middle;
}

.files-table tr:last-child td {
    border-bottom: none;
}

.files-table tr:hover td {
    background: var(--bg-tertiary);
}

.files-table tr.row-selected td {
    background: rgba(99, 102, 241, 0.08);
}

.col-check { width: 36px; }
.col-name { min-width: 200px; }
.col-project { width: 120px; }
.col-size { width: 90px; }
.col-mtime { width: 150px; }
.col-actions { width: 140px; }

.file-name-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.file-name {
    font-family: monospace;
    font-size: 12px;
    color: var(--text-primary);
}

.alias-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
}

.alias-label {
    color: var(--text-muted);
}

.alias-value {
    color: var(--success);
    font-weight: 500;
}

.alias-edit {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
}

.alias-input {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 11px;
    width: 140px;
}

.project-tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(99, 102, 241, 0.12);
    color: var(--accent);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
}

.project-tag:hover {
    background: rgba(99, 102, 241, 0.22);
}

.text-muted {
    color: var(--text-muted);
}

.action-btns {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}

.btn-xs {
    padding: 3px 8px;
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
}

.btn-xs:hover {
    background: var(--bg-tertiary);
}

.btn-xs.btn-primary {
    background: rgba(99, 102, 241, 0.15);
    border-color: rgba(99, 102, 241, 0.3);
    color: var(--accent);
}

.btn-xs.btn-accent {
    background: rgba(99, 102, 241, 0.12);
    border-color: rgba(99, 102, 241, 0.25);
    color: #a5b4fc;
}

.btn-xs.btn-danger {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.25);
    color: #f87171;
}

.btn-xs:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* 分页 */
.pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--border-color);
}

.page-info {
    font-size: 12px;
    color: var(--text-muted);
    min-width: 100px;
    text-align: center;
}

/* ── 对话框 ──────────────────────────────────────────────────────── */
.dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.dialog {
    width: min(520px, 96vw);
    max-height: 90vh;
    overflow-y: auto;
    padding: 20px;
}

.dialog-title {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 4px;
}

.dialog-hint {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 16px;
}

.import-form, .upload-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.form-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.form-field label {
    font-size: 12px;
    color: var(--text-muted);
}

.form-field input, .form-field select {
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 13px;
}

.form-field input:focus, .form-field select:focus {
    outline: none;
    border-color: var(--accent);
}

.field-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
}

.upload-error {
    padding: 8px 12px;
    background: rgba(239,68,68,0.1);
    border-radius: 6px;
    color: var(--danger);
    font-size: 12px;
}

.dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 16px;
}

.delete-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 8px;
    line-height: 1.5;
}

/* 按钮样式 */
.btn-sm {
    padding: 4px 10px;
    font-size: 12px;
}

.btn-primary {
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid rgba(99, 102, 241, 0.35);
    background: rgba(99, 102, 241, 0.15);
    color: var(--accent);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
}

.btn-primary:hover {
    background: rgba(99, 102, 241, 0.25);
}

.btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-secondary {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
}

.btn-secondary:hover {
    background: var(--bg-tertiary);
}

.btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-danger {
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid rgba(239, 68, 68, 0.35);
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
}

.btn-danger:hover {
    background: rgba(239, 68, 68, 0.25);
}

.btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* loading */
.loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 40px;
    color: var(--text-muted);
}

.spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-color);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.empty-state {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
    font-size: 13px;
}
</style>
