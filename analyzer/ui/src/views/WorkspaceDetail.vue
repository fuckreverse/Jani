<template>
  <div class="workspace-detail">

    <!-- 分析进度侧边抽屉 -->
    <ProgressDrawer
      :visible="showProgressDrawer"
      :session-id="progressSessionId"
      :session-name="progressSessionName"
      @close="showProgressDrawer = false"
      @view-session="goToSession"
    />

    <!-- 顶部面包屑 -->
    <div class="breadcrumb">
      <router-link to="/workspaces" class="breadcrumb-link">工作空间</router-link>
      <span class="breadcrumb-sep">›</span>
      <span class="breadcrumb-current">{{ project?.name || projectId }}</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载中...</span>
    </div>

    <template v-else-if="project">
      <!-- 项目信息卡 -->
      <div class="info-card card">
        <div class="info-header">
          <div class="info-title-row">
            <h2 class="project-title">{{ project.name }}</h2>
            <div class="status-badge" :class="`status-${project.status}`">
              <span class="status-dot" :class="`dot-${project.status}`"></span>
              {{ statusLabel(project.status) }}
            </div>
          </div>
          <div class="info-actions">
            <button v-if="project.status === 'ready'" class="btn-secondary btn-sm" @click="downloadInstrumented">
              ⬇ 插桩后代码
            </button>
            <button v-if="project.status === 'ready'" class="btn-secondary btn-sm" @click="downloadSmap">
              ⬇ smap.json
            </button>
            <button
              v-if="project.status === 'ready'"
              class="btn-secondary btn-sm"
              :disabled="copyingCode"
              @click="copyInstrumentedCode"
            >
              <span v-if="copyingCode">⏳ 复制中...</span>
              <span v-else-if="copyCodeMsg === 'ok'">✅ 已复制</span>
              <span v-else-if="copyCodeMsg === 'fail'">❌ 复制失败</span>
              <span v-else>📋 复制代码</span>
            </button>
            <button
              v-if="project.status === 'ready' || project.status === 'failed'"
              class="btn-accent btn-sm"
              @click="openForkModal"
            >
              🔁 重新插桩
            </button>
          </div>
        </div>

        <!-- 进度条（插桩中） -->
        <div v-if="project.status === 'instrumenting'" class="instrument-bar">
          <div class="progress-bar">
            <div class="progress-fill progress-indeterminate"></div>
          </div>
          <span class="progress-label">正在对源码进行插桩，请稍候...</span>
        </div>

        <!-- 错误信息 -->
        <div v-if="project.status === 'failed'" class="error-box">
          <strong>插桩失败：</strong>{{ project.error_msg || '未知错误' }}
        </div>

        <!-- 就绪状态：统计信息 -->
        <div v-if="project.status === 'ready'" class="stats-row">
          <div class="stat-item">
            <span class="stat-label">IID 数量</span>
            <span class="stat-value">{{ project.iid_count?.toLocaleString() || 0 }}</span>
          </div>
          <div class="stat-item" v-if="project.instrumented_size != null">
            <span class="stat-label">插桩后代码</span>
            <span class="stat-value">{{ formatBytes(project.instrumented_size) }}</span>
          </div>
          <div class="stat-item" v-if="project.smap_size != null">
            <span class="stat-label">smap.json</span>
            <span class="stat-value">{{ formatBytes(project.smap_size) }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">会话数</span>
            <span class="stat-value">{{ project.sessions?.length || 0 }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">创建时间</span>
            <span class="stat-value">{{ formatDate(project.created_at) }}</span>
          </div>
          <div class="stat-item" v-if="project.instrument_options">
            <span class="stat-label">目标平台</span>
            <span class="stat-value">{{ parsedOptions?.target || 'browser' }}</span>
          </div>
        </div>
      </div>

      <!-- 上传 Trace 区（仅就绪状态显示） -->
      <div v-if="project.status === 'ready'" class="upload-section card">
        <div class="section-header">
          <span class="section-title">📥 创建分析会话</span>
          <span class="section-hint">smap 已自动关联</span>
        </div>

        <div class="upload-body">
          <!-- Tab 切换 -->
          <div class="upload-tabs">
            <button
              class="tab-btn"
              :class="{ active: uploadTab === 'upload' }"
              @click="uploadTab = 'upload'"
            >上传文件</button>
            <button
              class="tab-btn"
              :class="{ active: uploadTab === 'existing' }"
              @click="uploadTab = 'existing'; onTabChange('existing')"
            >选已有 Trace</button>
          </div>

          <!-- 上传 Tab -->
          <div v-show="uploadTab === 'upload'">
            <!-- 拖拽区 -->
            <div
              class="dropzone"
              :class="{ 'dropzone-active': dragOver, 'dropzone-has-file': traceFile }"
              @dragover.prevent="dragOver = true"
              @dragleave="dragOver = false"
              @drop.prevent="handleTraceDrop"
              @click="$refs.traceInput.click()"
            >
              <input ref="traceInput" type="file" accept=".bin" style="display:none" @change="handleTraceChange" />
              <template v-if="traceFile">
                <span class="dz-icon">📦</span>
                <span class="dz-filename">{{ traceFile.name }}</span>
                <span class="dz-size">{{ formatBytes(traceFile.size) }}</span>
              </template>
              <template v-else>
                <span class="dz-icon">⬆</span>
                <span class="dz-hint">点击或拖拽 .bin trace 文件</span>
                <span class="dz-hint2">由插桩后代码运行时自动生成</span>
              </template>
            </div>
          </div>

          <!-- 选已有 Trace Tab -->
          <div v-show="uploadTab === 'existing'" class="existing-trace-panel">
            <div class="trace-search-row">
              <input
                v-model="traceSearchQuery"
                type="text"
                class="trace-search-input"
                placeholder="搜索 trace 文件..."
                @input="loadExistingTraces"
              />
            </div>
            <div v-if="loadingTraces" class="trace-loading"><div class="spinner-sm"></div> 加载中...</div>
            <div v-else-if="existingTraces.length === 0" class="trace-empty">暂无可用 trace 文件</div>
            <div v-else class="trace-list">
              <div
                v-for="t in existingTraces"
                :key="t.name"
                class="trace-item"
                :class="{ selected: selectedTrace?.name === t.name }"
                @click="selectedTrace = t"
              >
                <span class="trace-radio">{{ selectedTrace?.name === t.name ? '◉' : '○' }}</span>
                <span class="trace-name">{{ t.alias || t.name }}</span>
                <span class="trace-size">{{ formatBytes(t.size) }}</span>
                <span class="trace-mtime">{{ formatDate(t.mtime) }}</span>
              </div>
            </div>
          </div>

          <!-- 会话名称（两个 Tab 共用） -->
          <div class="trace-opts">
            <div class="opt-field">
              <label>会话名称（可选）</label>
              <input v-model="sessionName" placeholder="留空则自动生成" style="width:260px" />
            </div>
            <button
              v-if="uploadTab === 'upload'"
              class="btn-primary btn-upload"
              :disabled="!traceFile || uploading"
              @click="uploadTrace"
            >
              <span v-if="uploading">
                <span class="spinner-sm"></span>
                创建中...
              </span>
              <span v-else>创建分析会话 →</span>
            </button>
            <button
              v-else
              class="btn-primary btn-upload"
              :disabled="!selectedTrace || uploading"
              @click="importExistingTrace"
            >
              <span v-if="uploading">
                <span class="spinner-sm"></span>
                创建中...
              </span>
              <span v-else>使用选中文件 →</span>
            </button>
          </div>

          <div v-if="uploadError" class="upload-error">❌ {{ uploadError }}</div>
          <div v-if="uploadSuccess" class="upload-success">
            ✅ 会话已创建
            <router-link :to="`/sessions/${uploadSuccess}`" class="btn-primary btn-sm" style="margin-left:12px">
              查看会话 →
            </router-link>
          </div>
        </div>
      </div>

      <!-- 会话列表 -->
      <div class="sessions-section">
        <div class="sessions-header">
          <span class="section-title">分析会话历史</span>
          <span class="sessions-count" v-if="sessions.length">{{ sessions.length }} 个会话</span>
        </div>

        <div v-if="sessions.length === 0" class="sessions-empty">
          <p>暂无会话。上传 trace log 后自动创建。</p>
        </div>

        <div v-else class="sessions-table">
          <div class="sessions-table-header">
            <span>会话名称</span>
            <span>创建时间</span>
            <span>事件数</span>
            <span>状态</span>
            <span></span>
          </div>
          <div
            v-for="s in sessions"
            :key="s.id"
            class="sessions-table-row"
          >
            <span class="session-name">{{ s.name }}</span>
            <span class="session-date">{{ formatDate(s.created_at) }}</span>
            <span class="session-events">{{ s.event_count?.toLocaleString() || '-' }}</span>
            <span>
              <span :class="`badge badge-${sessionStatusBadge(s.status)}`">{{ s.status }}</span>
            </span>
            <span class="session-actions">
              <router-link :to="`/sessions/${s.id}`" class="btn-secondary btn-sm">查看 →</router-link>
              <button class="btn-danger btn-xs" @click="confirmDeleteSession(s)" title="删除">🗑</button>
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- 404 -->
    <div v-else class="empty-state">
      <p>工作空间不存在或已被删除</p>
      <router-link to="/workspaces" class="btn-secondary" style="margin-top:12px;display:inline-block">
        返回列表
      </router-link>
    </div>
  </div>

  <!-- ── Fork Modal ── -->
  <ForkModal
    :visible="showForkModal"
    :project-id="projectId"
    :initial-name="forkInitialName"
    :initial-options="project?.instrument_options || ''"
    @close="showForkModal = false"
    @success="onForkSuccess"
  />

  <!-- 删除会话确认 Modal -->
  <Teleport to="body">
    <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
      <div class="modal-box" style="max-width: 420px">
        <div class="modal-header">
          <span class="modal-title">确认删除</span>
          <button class="modal-close" @click="deleteTarget = null">✕</button>
        </div>
        <div class="modal-body">
          <p>确定删除会话 <strong>{{ deleteTarget.name || deleteTarget.id.slice(0, 8) }}</strong> 吗？</p>
          <p class="delete-hint">⚠️ 此操作不可撤销。会话的 trace 文件及所有分析数据将被永久删除。</p>
        </div>
        <div class="modal-footer">
          <div class="modal-btns">
            <button class="btn-secondary btn-sm" @click="deleteTarget = null">取消</button>
            <button class="btn-danger btn-sm" :disabled="deleting" @click="doDeleteSession">
              {{ deleting ? '删除中...' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ProgressDrawer from './ProgressDrawer.vue';
import ForkModal from './ForkModal.vue';

const route  = useRoute();
const router = useRouter();

const projectId = route.params.id;
const project   = ref(null);
const sessions  = ref([]);
const loading   = ref(true);

const dragOver   = ref(false);
const traceFile  = ref(null);
const sessionName = ref('');
const uploading  = ref(false);
const uploadError = ref('');
const uploadSuccess = ref('');

// Tab 切换：上传 / 选已有 trace
const uploadTab = ref('upload');  // 'upload' | 'existing'
const existingTraces = ref([]);
const loadingTraces = ref(false);
const selectedTrace = ref(null);
const traceSearchQuery = ref('');
const tracePagination = ref({ total: 0, offset: 0, limit: 10 });

// 进度抽屉
const showProgressDrawer  = ref(false);
const progressSessionId   = ref(null);
const progressSessionName = ref('');

// 删除会话
const deleteTarget = ref(null);
const deleting     = ref(false);

let progressWs = null;

// ── 计算属性 ──────────────────────────────────────────────────────────────────
const parsedOptions = computed(() => {
    if (!project.value?.instrument_options) return {};
    try { return JSON.parse(project.value.instrument_options); } catch { return {}; }
});

// ── 加载数据 ──────────────────────────────────────────────────────────────────
async function loadProject() {
    loading.value = true;
    try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) { project.value = null; return; }
        const data = await res.json();
        project.value = data;
        sessions.value = data.sessions || [];

        // 如果插桩中，订阅 WS 进度
        if (data.status === 'instrumenting') {
            watchProgress();
        }
    } catch (e) {
        console.error('loadProject error:', e);
    } finally {
        loading.value = false;
    }
}

// 加载已有 trace 文件
async function loadExistingTraces() {
    loadingTraces.value = true;
    try {
        const params = new URLSearchParams({
            offset: tracePagination.value.offset,
            limit: tracePagination.value.limit,
        });
        if (traceSearchQuery.value.trim()) {
            params.set('q', traceSearchQuery.value.trim());
        }
        const res = await fetch(`/api/trace/files?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        existingTraces.value = data.files || [];
        tracePagination.value.total = data.total;
    } catch (e) {
        console.error('loadExistingTraces error:', e);
    } finally {
        loadingTraces.value = false;
    }
}

// ── WS 进度 ───────────────────────────────────────────────────────────────────
function watchProgress() {
    if (progressWs) return;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/projects/${projectId}/progress`;
    progressWs = new WebSocket(wsUrl);

    progressWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (!project.value) return;

        if (msg.type === 'instrument_done') {
            project.value.status    = 'ready';
            project.value.iid_count = msg.iidCount;
            progressWs?.close();
            progressWs = null;
        } else if (msg.type === 'error') {
            project.value.status    = 'failed';
            project.value.error_msg = msg.message;
            progressWs?.close();
            progressWs = null;
        } else if (msg.type === 'init') {
            project.value.status    = msg.status;
            project.value.iid_count = msg.iid_count;
        }
    };

    progressWs.onerror = () => { progressWs = null; };
}

// ── 文件处理 ──────────────────────────────────────────────────────────────────
function handleTraceDrop(e) {
    dragOver.value = false;
    const f = e.dataTransfer.files[0];
    if (f) { traceFile.value = f; uploadSuccess.value = ''; uploadError.value = ''; }
}

function handleTraceChange(e) {
    traceFile.value = e.target.files[0] || null;
    uploadSuccess.value = '';
    uploadError.value = '';
}

// ── 上传 Trace 创建会话 ───────────────────────────────────────────────────────
async function uploadTrace() {
    if (!traceFile.value) return;
    uploading.value  = true;
    uploadError.value  = '';
    uploadSuccess.value = '';

    try {
        const fd = new FormData();
        fd.append('bin', traceFile.value, traceFile.value.name);
        if (sessionName.value.trim()) fd.append('name', sessionName.value.trim());

        const res  = await fetch(`/api/projects/${projectId}/sessions`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        uploadSuccess.value = data.sessionId;
        const savedName = sessionName.value || traceFile.value.name.replace(/\.bin$/, '');
        traceFile.value     = null;
        sessionName.value   = '';

        // 打开进度抽屉
        progressSessionId.value = data.sessionId;
        progressSessionName.value = savedName;
        showProgressDrawer.value = true;

        // 稍后刷新会话列表
        setTimeout(loadProject, 1500);

    } catch (e) {
        uploadError.value = e.message;
    } finally {
        uploading.value = false;
    }
}

// 使用已有 trace 文件创建会话
async function importExistingTrace() {
    if (!selectedTrace.value) return;
    uploading.value  = true;
    uploadError.value  = '';
    uploadSuccess.value = '';

    try {
        const res = await fetch('/api/trace/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: selectedTrace.value.name,
                name: sessionName.value.trim() || undefined,
                projectId: projectId,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        uploadSuccess.value = data.sessionId;
        const savedName = sessionName.value || selectedTrace.value.name.replace(/\.bin$/, '');
        selectedTrace.value = null;
        sessionName.value = '';

        // 打开进度抽屉
        progressSessionId.value = data.sessionId;
        progressSessionName.value = savedName;
        showProgressDrawer.value = true;

        // 稍后刷新会话列表
        setTimeout(loadProject, 1500);

    } catch (e) {
        uploadError.value = e.message;
    } finally {
        uploading.value = false;
    }
}

// ── 下载 ──────────────────────────────────────────────────────────────────────
async function downloadInstrumented() {
    const a = document.createElement('a');
    a.href = `/api/projects/${projectId}/instrumented`;
    a.download = '';
    a.click();
}

async function downloadSmap() {
    const a = document.createElement('a');
    a.href = `/api/projects/${projectId}/smap`;
    a.download = '';
    a.click();
}

// ── 复制插桩后代码到剪贴板 ────────────────────────────────────────────────────
const copyingCode = ref(false);
const copyCodeMsg = ref('');   // '' | 'ok' | 'fail'

async function copyInstrumentedCode() {
    if (copyingCode.value) return;
    copyingCode.value = true;
    copyCodeMsg.value  = '';
    try {
        const res = await fetch(`/api/projects/${projectId}/instrumented`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        copyCodeMsg.value = 'ok';
    } catch (e) {
        console.error('copyInstrumentedCode error:', e);
        copyCodeMsg.value = 'fail';
    } finally {
        copyingCode.value = false;
        setTimeout(() => { copyCodeMsg.value = ''; }, 2500);
    }
}

// ── Fork（重新插桩）Modal ─────────────────────────────────────────────────────
const showForkModal   = ref(false);
const forkInitialName = ref('');

function openForkModal() {
    forkInitialName.value = `${project.value?.name || ''}-fork`;
    showForkModal.value   = true;
}

function onForkSuccess({ projectId: newProjectId }) {
    showForkModal.value = false;
    router.push(`/workspaces/${newProjectId}`);
}

// ── 工具 ──────────────────────────────────────────────────────────────────────
function statusLabel(s) {
    return { pending: '待插桩', instrumenting: '插桩中', ready: '就绪', failed: '失败' }[s] || s;
}

function sessionStatusBadge(s) {
    return { parsing: 'processing', indexing: 'processing', ready: 'ready', failed: 'failed' }[s] || 'pending';
}

function formatDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 导航到会话
function goToSession() {
    if (progressSessionId.value) {
        showProgressDrawer.value = false;
        router.push(`/sessions/${progressSessionId.value}`);
    }
}

// 删除会话
function confirmDeleteSession(s) {
    deleteTarget.value = s;
}

async function doDeleteSession() {
    if (!deleteTarget.value) return;
    deleting.value = true;
    try {
        const res = await fetch(`/api/sessions/${deleteTarget.value.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        sessions.value = sessions.value.filter(s => s.id !== deleteTarget.value.id);
        deleteTarget.value = null;
    } catch (e) {
        alert(`删除失败：${e.message}`);
    } finally {
        deleting.value = false;
    }
}

// Tab 切换时加载 trace 列表
function onTabChange(tab) {
    if (tab === 'existing' && existingTraces.value.length === 0) {
        loadExistingTraces();
    }
}

onMounted(loadProject);
onUnmounted(() => {
    if (progressWs) { progressWs.onclose = null; progressWs.close(); progressWs = null; }
});
</script>

<style scoped>
.breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 20px;
}
.breadcrumb-link {
    color: var(--accent);
    text-decoration: none;
}
.breadcrumb-link:hover { text-decoration: underline; }
.breadcrumb-sep { font-size: 16px; color: var(--border-color); }
.breadcrumb-current { color: var(--text-primary); font-weight: 500; }

/* 信息卡 */
.info-card {
    margin-bottom: 16px;
    padding: 20px 24px;
}

.info-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
}

.info-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.project-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0;
}

.status-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
}
.status-pending      { background: rgba(148,163,184,0.12); color: #94a3b8; }
.status-instrumenting { background: rgba(59,130,246,0.12);  color: #60a5fa; }
.status-ready        { background: rgba(34,197,94,0.12);   color: #4ade80; }
.status-failed       { background: rgba(239,68,68,0.12);   color: #f87171; }

.status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
}
.dot-pending      { background: #94a3b8; }
.dot-instrumenting { background: #60a5fa; animation: pulse 1.2s ease-in-out infinite; }
.dot-ready        { background: #4ade80; }
.dot-failed       { background: #f87171; }

.info-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* 进度条 */
.instrument-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0 4px;
}

.progress-bar {
    flex: 1;
    height: 4px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
}

.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; }
.progress-indeterminate {
    animation: indeterminate 1.5s ease-in-out infinite;
    width: 40%;
}

@keyframes indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
}

.progress-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }

.error-box {
    padding: 10px 14px;
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: 6px;
    font-size: 13px;
    color: var(--danger);
    word-break: break-all;
}

/* 统计行 */
.stats-row {
    display: flex;
    gap: 32px;
    flex-wrap: wrap;
    border-top: 1px solid var(--border-color);
    padding-top: 14px;
}

.stat-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.stat-label { font-size: 11px; color: var(--text-muted); }
.stat-value { font-size: 15px; font-weight: 600; color: var(--text-primary); font-family: monospace; }

/* 上传区 */
.upload-section {
    margin-bottom: 20px;
    padding: 0;
    overflow: hidden;
}

.section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border-color);
}

.section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
}

.section-hint {
    font-size: 12px;
    color: var(--text-muted);
}

.upload-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

/* 拖拽区 */
.dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 100px;
    border: 2px dashed var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    background: var(--bg-primary);
    color: var(--text-muted);
}
.dropzone:hover, .dropzone-active {
    border-color: var(--accent);
    background: rgba(99,102,241,0.06);
}
.dropzone-has-file {
    border-color: var(--success);
    background: rgba(34,197,94,0.06);
    color: var(--text-primary);
}

.dz-icon     { font-size: 22px; }
.dz-filename { font-size: 13px; font-weight: 600; }
.dz-size     { font-size: 11px; color: var(--text-muted); }
.dz-hint     { font-size: 13px; }
.dz-hint2    { font-size: 11px; color: var(--text-muted); }

.trace-opts {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    flex-wrap: wrap;
}

.opt-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.opt-field label { font-size: 11px; color: var(--text-muted); }

.btn-upload {
    padding: 8px 20px;
    flex-shrink: 0;
}

.btn-upload:disabled { opacity: 0.5; cursor: not-allowed; }

/* Tab 切换 */
.upload-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border-color);
}

.tab-btn {
    padding: 8px 16px;
    font-size: 13px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
}

.tab-btn:hover {
    color: var(--text-primary);
}

.tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
}

/* 已有 trace 列表 */
.existing-trace-panel {
    margin-bottom: 16px;
}

.trace-search-row {
    margin-bottom: 10px;
}

.trace-search-input {
    width: 100%;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 13px;
}

.trace-search-input:focus {
    outline: none;
    border-color: var(--accent);
}

.trace-loading, .trace-empty {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
}

.trace-list {
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid var(--border-color);
    border-radius: 8px;
}

.trace-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    transition: background 0.1s;
}

.trace-item:last-child {
    border-bottom: none;
}

.trace-item:hover {
    background: var(--bg-tertiary);
}

.trace-item.selected {
    background: rgba(99, 102, 241, 0.12);
}

.trace-radio {
    font-size: 14px;
    color: var(--text-muted);
}

.trace-item.selected .trace-radio {
    color: var(--accent);
}

.trace-name {
    flex: 1;
    font-size: 12px;
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.trace-size, .trace-mtime {
    font-size: 11px;
    color: var(--text-muted);
    font-family: monospace;
}

.upload-error {
    padding: 8px 12px;
    background: rgba(239,68,68,0.08);
    border-radius: 6px;
    color: var(--danger);
    font-size: 12px;
}

.upload-success {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: rgba(34,197,94,0.08);
    border-radius: 6px;
    color: var(--success);
    font-size: 13px;
}

/* 会话列表 */
.sessions-section { margin-top: 4px; }

.sessions-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
}

.sessions-count {
    font-size: 12px;
    color: var(--text-muted);
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border-radius: 10px;
}

.sessions-empty {
    text-align: center;
    padding: 32px;
    color: var(--text-muted);
    font-size: 13px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
}

.sessions-table {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    overflow: hidden;
}

.sessions-table-header {
    display: grid;
    grid-template-columns: 1fr 140px 90px 80px 80px;
    padding: 10px 16px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-tertiary);
}

.sessions-table-row {
    display: grid;
    grid-template-columns: 1fr 140px 90px 80px 80px;
    padding: 12px 16px;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    font-size: 13px;
    transition: background 0.1s;
}
.sessions-table-row:last-child { border-bottom: none; }
.sessions-table-row:hover { background: var(--bg-tertiary); }

.session-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.session-date, .session-events {
    color: var(--text-muted);
    font-size: 12px;
    font-family: monospace;
}

.btn-sm { padding: 4px 10px; font-size: 12px; }

/* 会话操作按钮 */
.session-actions {
    display: flex;
    gap: 6px;
    align-items: center;
}

.btn-xs {
    padding: 3px 8px;
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
}

.btn-danger {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    color: #f87171;
}

.btn-danger:hover {
    background: rgba(239, 68, 68, 0.2);
}

.btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.delete-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 8px;
    line-height: 1.5;
}

/* spinner */
.spinner-sm {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: -2px;
    margin-right: 4px;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

/* ── accent 按钮（重新插桩等操作） ─────────────────────────────────────── */
.btn-accent {
    background: rgba(99,102,241,0.18);
    color: #818cf8;
    border: 1px solid rgba(99,102,241,0.35);
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
}
.btn-accent:hover { background: rgba(99,102,241,0.28); }
.btn-accent:disabled { opacity: 0.5; cursor: not-allowed; }

/* Fork Modal 样式已移至 ForkModal.vue */
</style>
