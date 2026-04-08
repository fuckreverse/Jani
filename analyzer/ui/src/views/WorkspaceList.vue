<template>
  <div class="workspace-list">
    <div class="page-header">
      <div>
        <h1 class="page-title">工作空间</h1>
        <p class="page-subtitle">上传原始 JS，自动插桩后即可反复上传 trace 进行分析，无需重复插桩</p>
      </div>
      <button class="btn-primary" @click="showCreate = true">＋ 新建工作空间</button>
    </div>

    <!-- 新建工作空间弹窗 -->
    <div v-if="showCreate" class="modal-overlay" @click.self="cancelCreate">
      <div class="modal card">
        <div class="modal-header">
          <span class="modal-title">新建工作空间</span>
          <button class="btn-icon" @click="cancelCreate">✕</button>
        </div>

        <div class="modal-body">
          <!-- 名称 -->
          <div class="form-field">
            <label>工作空间名称</label>
            <input v-model="form.name" placeholder="如 jd-sec（留空则使用文件名）" />
          </div>

          <!-- 文件上传 -->
          <div class="form-field">
            <label>原始 JS 文件 <span class="required">*</span></label>
            <div
              class="dropzone"
              :class="{ 'dropzone-active': dragOver, 'dropzone-has-file': form.file }"
              @dragover.prevent="dragOver = true"
              @dragleave="dragOver = false"
              @drop.prevent="handleDrop"
              @click="$refs.fileInput.click()"
            >
              <input ref="fileInput" type="file" accept=".js" style="display:none" @change="handleFileChange" />
              <template v-if="form.file">
                <span class="dropzone-icon">📄</span>
                <span class="dropzone-filename">{{ form.file.name }}</span>
                <span class="dropzone-size">{{ formatBytes(form.file.size) }}</span>
              </template>
              <template v-else>
                <span class="dropzone-icon">⬆</span>
                <span class="dropzone-hint">点击或拖拽 .js 文件到此处</span>
              </template>
            </div>
          </div>

          <!-- 插桩选项（复用 InstrumentOptions 组件） -->
          <InstrumentOptions ref="optionsRef" :embedded="true" />

          <div v-if="createError" class="form-error">❌ {{ createError }}</div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="cancelCreate">取消</button>
          <button
            class="btn-primary"
            :disabled="!form.file || creating"
            @click="doCreate"
          >
            <span v-if="creating">
              <span class="spinner-sm"></span> 上传中...
            </span>
            <span v-else>创建工作空间</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 工作空间列表 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载中...</span>
    </div>

    <div v-else-if="projects.length === 0" class="empty-state">
      <div class="empty-icon">🗂️</div>
      <p>暂无工作空间</p>
      <p class="empty-hint">点击「新建工作空间」上传原始 JS，插桩完成后即可上传 trace 进行分析</p>
    </div>

    <div v-else class="project-grid">
      <div
        v-for="p in projects"
        :key="p.id"
        class="project-card card"
        :class="`project-card-${p.status}`"
      >
        <div class="project-card-header">
          <div class="project-name">{{ p.name }}</div>
          <div class="project-status">
            <span class="status-dot" :class="`dot-${p.status}`"></span>
            <span class="status-label">{{ statusLabel(p.status) }}</span>
          </div>
        </div>

        <div class="project-meta">
          <span class="meta-item">
            <span class="meta-label">创建时间</span>
            {{ formatDate(p.created_at) }}
          </span>
          <span v-if="p.iid_count" class="meta-item">
            <span class="meta-label">IID 数</span>
            {{ p.iid_count.toLocaleString() }}
          </span>
          <span v-if="p.session_count" class="meta-item">
            <span class="meta-label">会话数</span>
            {{ p.session_count }}
          </span>
        </div>

        <!-- 插桩中进度条 -->
        <div v-if="p.status === 'instrumenting'" class="instrument-progress">
          <div class="progress-bar">
            <div class="progress-fill progress-indeterminate"></div>
          </div>
          <span class="progress-label">插桩中，请稍候...</span>
        </div>

        <!-- 错误信息 -->
        <div v-if="p.status === 'failed'" class="project-error">
          ❌ {{ p.error_msg || '插桩失败' }}
        </div>

        <div class="project-actions">
          <button
            v-if="p.status === 'ready'"
            class="btn-primary btn-sm"
            @click="$router.push(`/workspaces/${p.id}`)"
          >
            进入工作空间 →
          </button>
          <button
            v-else-if="p.status === 'instrumenting'"
            class="btn-secondary btn-sm"
            disabled
          >
            插桩中...
          </button>
          <button
            v-else-if="p.status === 'failed'"
            class="btn-secondary btn-sm"
            @click="$router.push(`/workspaces/${p.id}`)"
          >
            查看详情
          </button>
          <button class="btn-danger btn-sm" @click="confirmDelete(p)">删除</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
      <div class="modal card" style="max-width:420px">
        <div class="modal-header">
          <span class="modal-title">确认删除</span>
        </div>
        <div class="modal-body">
          <p>确定删除工作空间 <strong>{{ deleteTarget.name }}</strong> 吗？</p>
          <p class="delete-hint">⚠️ 此操作不可撤销。工作空间的插桩文件和 smap 将被删除，关联的会话不受影响。</p>
        </div>
        <div class="modal-footer">
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
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import InstrumentOptions from './InstrumentOptions.vue';

const projects   = ref([]);
const loading    = ref(true);
const showCreate = ref(false);
const dragOver   = ref(false);
const creating   = ref(false);
const createError = ref('');
const deleteTarget = ref(null);
const deleting   = ref(false);

const wsMap = new Map(); // projectId → WebSocket

const optionsRef = ref(null); // InstrumentOptions 组件引用

const form = reactive({
    name: '',
    file: null,
});

// ── 加载列表 ──────────────────────────────────────────────────────────────────
async function loadProjects() {
    loading.value = true;
    try {
        const res = await fetch('/api/projects');
        projects.value = await res.json();
        // 订阅仍在插桩的项目的 WS 进度
        for (const p of projects.value) {
            if (p.status === 'instrumenting') {
                watchProject(p.id);
            }
        }
    } catch (e) {
        console.error('loadProjects error:', e);
    } finally {
        loading.value = false;
    }
}

// ── WS 进度订阅 ───────────────────────────────────────────────────────────────
function watchProject(projectId) {
    if (wsMap.has(projectId)) return;

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/projects/${projectId}/progress`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const p = projects.value.find(x => x.id === projectId);
        if (!p) return;

        if (msg.type === 'instrument_done') {
            p.status    = 'ready';
            p.iid_count = msg.iidCount;
            ws.close();
            wsMap.delete(projectId);
        } else if (msg.type === 'error') {
            p.status    = 'failed';
            p.error_msg = msg.message;
            ws.close();
            wsMap.delete(projectId);
        } else if (msg.type === 'init') {
            p.status    = msg.status;
            p.iid_count = msg.iid_count;
        }
    };

    ws.onerror = () => wsMap.delete(projectId);
    wsMap.set(projectId, ws);
}

// ── 文件处理 ──────────────────────────────────────────────────────────────────
function handleDrop(e) {
    dragOver.value = false;
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.js')) form.file = f;
}

function handleFileChange(e) {
    form.file = e.target.files[0] || null;
}

// ── 创建工作空间 ──────────────────────────────────────────────────────────────
async function doCreate() {
    if (!form.file) return;
    creating.value = true;
    createError.value = '';

    try {
        const fd = new FormData();
        fd.append('source', form.file, form.file.name);
        if (form.name.trim()) fd.append('name', form.name.trim());

        const opts = optionsRef.value?.buildOptions() ?? {};
        fd.append('options', JSON.stringify(opts));

        const res  = await fetch('/api/projects', { method: 'POST', body: fd });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // 添加到列表并开始监听
        projects.value.unshift({
            id:         data.projectId,
            name:       form.name.trim() || form.file.name.replace(/\.js$/, ''),
            status:     'instrumenting',
            created_at: Date.now(),
            iid_count:  0,
        });

        watchProject(data.projectId);
        cancelCreate();

    } catch (e) {
        createError.value = e.message;
    } finally {
        creating.value = false;
    }
}

function cancelCreate() {
    showCreate.value  = false;
    createError.value = '';
    form.name         = '';
    form.file         = null;
    // InstrumentOptions 组件内部状态通过重新 mount 重置（v-if 控制弹窗）
}

// ── 删除 ──────────────────────────────────────────────────────────────────────
function confirmDelete(p) { deleteTarget.value = p; }

async function doDelete() {
    if (!deleteTarget.value) return;
    deleting.value = true;
    try {
        const res = await fetch(`/api/projects/${deleteTarget.value.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
        projects.value = projects.value.filter(p => p.id !== deleteTarget.value.id);
        deleteTarget.value = null;
    } catch (e) {
        alert(`删除失败：${e.message}`);
    } finally {
        deleting.value = false;
    }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────
function statusLabel(s) {
    return { pending: '待插桩', instrumenting: '插桩中', ready: '就绪', failed: '失败' }[s] || s;
}

function formatDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(loadProjects);
onUnmounted(() => {
    for (const ws of wsMap.values()) { ws.onclose = null; ws.close(); }
    wsMap.clear();
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
    margin-bottom: 4px;
}
.page-subtitle {
    font-size: 13px;
    color: var(--text-muted);
}

/* 项目网格 */
.project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
}

.project-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 20px;
    transition: border-color 0.15s;
}
.project-card:hover {
    border-color: var(--accent);
}

.project-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.project-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
}

.project-status {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}
.dot-pending      { background: var(--text-muted); }
.dot-instrumenting { background: var(--info); animation: pulse 1.2s ease-in-out infinite; }
.dot-ready        { background: var(--success); }
.dot-failed       { background: var(--danger); }

.status-label {
    font-size: 12px;
    color: var(--text-muted);
}

.project-meta {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
}

.meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.meta-label {
    font-size: 11px;
    color: var(--text-muted);
}

/* 进度条 */
.instrument-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.progress-bar {
    height: 3px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
}

.progress-indeterminate {
    animation: indeterminate 1.5s ease-in-out infinite;
    width: 40%;
}

@keyframes indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
}

.progress-label {
    font-size: 12px;
    color: var(--text-muted);
}

.project-error {
    font-size: 12px;
    color: var(--danger);
    background: rgba(239,68,68,0.08);
    padding: 6px 10px;
    border-radius: 6px;
    word-break: break-all;
}

.project-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
}

.btn-sm {
    padding: 5px 12px;
    font-size: 12px;
}

/* 空状态 */
.empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
}
.empty-icon {
    font-size: 48px;
    margin-bottom: 12px;
}
.empty-hint {
    font-size: 13px;
    max-width: 420px;
    margin: 8px auto 0;
    line-height: 1.6;
}

/* 弹窗 */
.modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 24px;
}

.modal {
    width: 100%;
    max-width: 720px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 0;
}

.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color);
}

.modal-title {
    font-size: 15px;
    font-weight: 600;
}

.btn-icon {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
}
.btn-icon:hover { color: var(--text-primary); }

.modal-body {
    padding: 20px;
    padding-bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

/* InstrumentOptions embedded 模式：突破 modal-body padding 贴边显示 */
.modal-body :deep(.options-panel-embedded) {
    margin: 0 -20px;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--border-color);
    background: var(--bg-tertiary);
}

.form-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.required {
    color: var(--danger);
}

/* 文件拖拽区 */
.dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 110px;
    border: 2px dashed var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    background: var(--bg-primary);
    color: var(--text-muted);
}

.dropzone:hover,
.dropzone-active {
    border-color: var(--accent);
    background: rgba(99,102,241,0.06);
}

.dropzone-has-file {
    border-color: var(--success);
    background: rgba(34,197,94,0.06);
    color: var(--text-primary);
}

.dropzone-icon   { font-size: 24px; }
.dropzone-hint   { font-size: 13px; }
.dropzone-filename { font-size: 13px; font-weight: 600; }
.dropzone-size   { font-size: 11px; color: var(--text-muted); }

/* 错误 */
.form-error {
    padding: 8px 12px;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.25);
    border-radius: 6px;
    color: var(--danger);
    font-size: 12px;
}

/* 删除确认 */
.delete-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 6px;
}

.btn-danger {
    background: rgba(239,68,68,0.15);
    color: #f87171;
    border: 1px solid rgba(239,68,68,0.3);
}
.btn-danger:hover { background: rgba(239,68,68,0.25); }
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

/* 加载 spinner-sm */
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

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
</style>
