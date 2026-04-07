<template>
  <div class="session-list">
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
        <h1 class="page-title">分析会话</h1>
        <p class="page-subtitle">上传 trace 文件创建新会话，或点击已有会话查看详情</p>
      </div>
      <button class="btn-primary" @click="showUploadDialog = true">+ 新建会话</button>
    </div>

    <!-- 上传对话框 -->
    <div v-if="showUploadDialog" class="dialog-overlay" @click.self="showUploadDialog = false">
      <div class="dialog card">
        <h2 class="dialog-title">新建分析会话</h2>
        <p class="dialog-hint">上传 .bin trace 文件（必须）以及可选的 .smap.json 和 .js 源文件</p>

        <div class="upload-form">
          <div class="form-field">
            <label>会话名称（可选）</label>
            <input v-model="uploadForm.name" placeholder="如：target-v2.3" />
          </div>

          <div class="form-field">
            <label>trace .bin 文件 <span class="required">*</span></label>
            <div
              class="dropzone"
              :class="{ 'dropzone-active': dragging.bin }"
              @dragover.prevent="dragging.bin = true"
              @dragleave="dragging.bin = false"
              @drop.prevent="handleDrop('bin', $event)"
              @click="$refs.binInput.click()"
            >
              <span v-if="uploadForm.bin">📦 {{ uploadForm.bin.name }} ({{ formatSize(uploadForm.bin.size) }})</span>
              <span v-else>点击或拖入 .bin 文件</span>
            </div>
            <input ref="binInput" type="file" accept=".bin" style="display:none" @change="handleFileInput('bin', $event)" />
          </div>

          <div class="form-field">
            <label>源码映射 .smap.json（可选）</label>
            <div
              class="dropzone"
              :class="{ 'dropzone-active': dragging.smap }"
              @dragover.prevent="dragging.smap = true"
              @dragleave="dragging.smap = false"
              @drop.prevent="handleDrop('smap', $event)"
              @click="$refs.smapInput.click()"
            >
              <span v-if="uploadForm.smap">🗺️ {{ uploadForm.smap.name }}</span>
              <span v-else>点击或拖入 .smap.json 文件（可选）</span>
            </div>
            <input ref="smapInput" type="file" accept=".json" style="display:none" @change="handleFileInput('smap', $event)" />
          </div>

          <div class="form-field">
            <label>原始 JS 源文件（可选）</label>
            <div
              class="dropzone"
              :class="{ 'dropzone-active': dragging.source }"
              @dragover.prevent="dragging.source = true"
              @dragleave="dragging.source = false"
              @drop.prevent="handleDrop('source', $event)"
              @click="$refs.sourceInput.click()"
            >
              <span v-if="uploadForm.source">📄 {{ uploadForm.source.name }}</span>
              <span v-else>点击或拖入 .js 文件（可选）</span>
            </div>
            <input ref="sourceInput" type="file" accept=".js" style="display:none" @change="handleFileInput('source', $event)" />
          </div>

          <div v-if="uploadError" class="upload-error">❌ {{ uploadError }}</div>

          <div class="dialog-actions">
            <button class="btn-secondary" @click="showUploadDialog = false">取消</button>
            <button
              class="btn-primary"
              :disabled="!uploadForm.bin || uploading"
              @click="submitUpload"
            >
              <span v-if="uploading">上传中...</span>
              <span v-else>创建会话</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载会话列表...</span>
    </div>

    <!-- 空状态 -->
    <div v-else-if="sessions.length === 0" class="empty-state card">
      <div class="empty-icon">🔬</div>
      <p>暂无分析会话</p>
      <p class="empty-hint">点击"新建会话"上传 trace 文件开始分析</p>
    </div>

    <!-- 会话列表 -->
    <div v-else class="sessions-grid">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="session-card card"
        @click="$router.push(`/sessions/${session.id}`)"
      >
        <div class="session-header">
          <div class="session-name">{{ session.name || session.id.slice(0, 8) }}</div>
          <span class="badge" :class="`badge-${session.status}`">{{ session.status }}</span>
        </div>

        <div class="session-meta">
          <div class="meta-item">
            <span class="meta-label">事件数</span>
            <span class="meta-value">{{ formatNumber(session.event_count) }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">创建时间</span>
            <span class="meta-value">{{ formatDate(session.created_at) }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">文件</span>
            <span class="meta-value">{{ session.source_file ? getFilename(session.source_file) : '—' }}</span>
          </div>
        </div>

        <!-- 插件状态 -->
        <div v-if="session.plugin_status && Object.keys(session.plugin_status).length > 0" class="plugin-status-bar">
          <div
            v-for="(status, pluginId) in session.plugin_status"
            :key="pluginId"
            class="plugin-dot"
            :class="`plugin-dot-${status}`"
            :title="`${pluginId}: ${status}`"
          ></div>
          <!-- 进行中时，显示「查看进度」按钮 -->
          <button
            v-if="['parsing','indexing','processing'].includes(session.status)"
            class="btn-progress"
            @click.stop="openProgress(session)"
          >⚡ 进度</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import ProgressDrawer from './ProgressDrawer.vue';

const router = useRouter();

const sessions = ref([]);
const loading  = ref(true);
const showUploadDialog = ref(false);
const uploading = ref(false);
const uploadError = ref('');

const uploadForm = ref({ name: '', bin: null, smap: null, source: null });
const dragging   = ref({ bin: false, smap: false, source: false });

// 进度抽屉状态
const showProgressDrawer  = ref(false);
const progressSessionId   = ref(null);
const progressSessionName = ref('');

let refreshTimer = null;

// 加载会话列表
async function loadSessions() {
    try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sessions.value = await res.json();
    } catch (e) {
        console.error('Failed to load sessions:', e);
    } finally {
        loading.value = false;
    }
}

// 处理文件拖放
function handleDrop(field, e) {
    dragging.value[field] = false;
    const file = e.dataTransfer.files[0];
    if (file) uploadForm.value[field] = file;
}

function handleFileInput(field, e) {
    const file = e.target.files[0];
    if (file) uploadForm.value[field] = file;
}

// 提交上传
async function submitUpload() {
    if (!uploadForm.value.bin) return;
    uploading.value = true;
    uploadError.value = '';

    try {
        const formData = new FormData();
        formData.append('bin', uploadForm.value.bin);
        if (uploadForm.value.smap)   formData.append('smap',   uploadForm.value.smap);
        if (uploadForm.value.source) formData.append('source', uploadForm.value.source);
        if (uploadForm.value.name)   formData.append('name',   uploadForm.value.name);

        const res = await fetch('/api/sessions', { method: 'POST', body: formData });

        // 安全解析 JSON：先检查 Content-Type，避免空响应体导致 "Unexpected end of JSON input"
        const contentType = res.headers.get('content-type') || '';
        let data = {};
        if (contentType.includes('application/json')) {
            data = await res.json();
        } else if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // 先保存名称（重置 form 前）
        const savedName = uploadForm.value.name || (uploadForm.value.bin?.name?.replace(/\.bin$/, '')) || '';

        showUploadDialog.value = false;
        uploadForm.value = { name: '', bin: null, smap: null, source: null };
        await loadSessions();

        // 打开进度抽屉
        progressSessionId.value   = data.sessionId;
        progressSessionName.value = savedName || data.sessionId?.slice(0, 8) || '';
        showProgressDrawer.value  = true;

    } catch (e) {
        uploadError.value = e.message;
    } finally {
        uploading.value = false;
    }
}

// 导航到会话详情
function goToSession() {
    if (progressSessionId.value) {
        showProgressDrawer.value = false;
        router.push(`/sessions/${progressSessionId.value}`);
    }
}

// 打开进度抽屉（从卡片触发）
function openProgress(session) {
    progressSessionId.value   = session.id;
    progressSessionName.value = session.name || session.id.slice(0, 8);
    showProgressDrawer.value  = true;
}

// 工具函数
function formatNumber(n) {
    if (!n) return '0';
    return n.toLocaleString('zh-CN');
}

function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getFilename(path) {
    return path ? path.split('/').pop() : '—';
}

onMounted(() => {
    loadSessions();
    // 每 5s 自动刷新（处理中的 session 会更新状态）
    refreshTimer = setInterval(loadSessions, 5000);
});

onUnmounted(() => {
    if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 24px;
}

.page-title {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
}

.page-subtitle {
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 13px;
}

/* 会话网格 */
.sessions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
}

.session-card {
    cursor: pointer;
    transition: all 0.15s;
    border-color: var(--border-color);
}

.session-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(99,102,241,0.15);
}

.session-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
}

.session-name {
    font-weight: 600;
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
}

.session-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
}

.meta-item {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
}

.meta-label { color: var(--text-muted); }
.meta-value { color: var(--text-primary); font-family: monospace; }

/* 插件状态点 */
.plugin-status-bar {
    display: flex;
    gap: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color);
}

.plugin-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
.plugin-dot-pending  { background: #475569; }
.plugin-dot-running  { background: #3b82f6; animation: pulse 1s infinite; }
.plugin-dot-done     { background: #22c55e; }
.plugin-dot-failed   { background: #ef4444; }
.plugin-dot-skipped  { background: #64748b; }

.btn-progress {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgba(99, 102, 241, .35);
    background: rgba(99, 102, 241, .1);
    color: #a5b4fc;
    font-size: 10px;
    cursor: pointer;
    transition: all .15s;
    flex-shrink: 0;
}
.btn-progress:hover {
    background: rgba(99, 102, 241, .25);
    border-color: rgba(99, 102, 241, .6);
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

/* 上传对话框 */
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
    width: 520px;
    max-height: 90vh;
    overflow-y: auto;
}

.dialog-title {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 4px;
}

.dialog-hint {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 20px;
}

.upload-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.form-field { display: flex; flex-direction: column; gap: 4px; }

.required { color: var(--danger); }

.dropzone {
    border: 2px dashed var(--border-color);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-muted);
    transition: all 0.15s;
}

.dropzone:hover,
.dropzone-active {
    border-color: var(--accent);
    color: var(--text-primary);
    background: rgba(99,102,241,0.05);
}

.upload-error {
    color: var(--danger);
    font-size: 13px;
    padding: 8px 12px;
    background: rgba(239,68,68,0.1);
    border-radius: 6px;
}

.dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 8px;
}

.empty-icon {
    font-size: 36px;
    margin-bottom: 12px;
}

.empty-hint {
    font-size: 12px;
    margin-top: 4px;
}
</style>
