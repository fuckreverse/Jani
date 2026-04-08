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

          <!-- 源码输入方式 Tab -->
          <div class="form-field">
            <label>原始 JS 文件 <span class="required">*</span></label>
            <div class="source-tabs">
              <button
                class="source-tab"
                :class="{ active: sourceMode === 'file' }"
                @click="sourceMode = 'file'"
              >📁 上传文件</button>
              <button
                class="source-tab"
                :class="{ active: sourceMode === 'paste' }"
                @click="sourceMode = 'paste'"
              >📋 粘贴代码</button>
            </div>

            <!-- 文件上传模式 -->
            <div v-if="sourceMode === 'file'">
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

            <!-- 粘贴代码模式 -->
            <div v-else class="paste-mode">
              <div class="paste-filename-row">
                <input
                  v-model="form.pasteFilename"
                  placeholder="文件名（如 script.js）"
                  class="paste-filename-input"
                />
                <span class="paste-stat">{{ pasteLineCount }} 行 · {{ pasteByteCount }} bytes</span>
              </div>
              <textarea
                v-model="form.pasteCode"
                class="code-editor"
                placeholder="// 粘贴 JavaScript 源码..."
                spellcheck="false"
              ></textarea>
            </div>
          </div>

          <!-- 预处理选项（可选，启用后 source 变为预处理后代码） -->
          <PreprocessOptions ref="preprocessRef" :embedded="true" />

          <!-- 插桩选项（复用 InstrumentOptions 组件） -->
          <InstrumentOptions ref="optionsRef" :embedded="true" />

          <!-- 运行模式选择 -->
          <div class="run-mode-section">
            <div class="run-mode-header">
              <label class="run-mode-label">创建后操作</label>
            </div>
            <div class="run-mode-options">
              <label class="radio-card" :class="{ selected: runMode === 'instrument_only' }">
                <input type="radio" v-model="runMode" value="instrument_only" />
                <div class="radio-card-content">
                  <span class="radio-card-title">🔧 仅插桩</span>
                  <span class="radio-card-hint">创建工作空间后停止，稍后手动上传 trace</span>
                </div>
              </label>
              <label class="radio-card" :class="{ selected: runMode === 'instrument_and_run' }">
                <input type="radio" v-model="runMode" value="instrument_and_run" />
                <div class="radio-card-content">
                  <span class="radio-card-title">▶ 插桩并运行</span>
                  <span class="radio-card-hint">在服务端执行，自动生成 trace 并创建分析会话</span>
                </div>
              </label>
            </div>
          </div>

          <div v-if="createError" class="form-error">❌ {{ createError }}</div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="cancelCreate">取消</button>
          <button
            class="btn-primary"
            :disabled="!canCreate || creating"
            @click="doCreate"
          >
            <span v-if="creating">
              <span class="spinner-sm"></span>
              {{ runMode === 'instrument_and_run' ? '插桩并运行中...' : '上传中...' }}
            </span>
            <span v-else>
              {{ runMode === 'instrument_and_run' ? '插桩并运行 ▶' : '创建工作空间' }}
            </span>
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
        :class="[`project-card-${p.status}`, { 'project-card-clickable': p.status === 'ready' || p.status === 'failed' }]"
        @click="handleCardClick(p)"
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

        <div class="project-actions" @click.stop>
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
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import InstrumentOptions from './InstrumentOptions.vue';
import PreprocessOptions from './PreprocessOptions.vue';

const router = useRouter();

const projects   = ref([]);
const loading    = ref(true);
const showCreate = ref(false);
const dragOver   = ref(false);
const creating   = ref(false);
const createError = ref('');
const deleteTarget = ref(null);
const deleting   = ref(false);

const wsMap = new Map(); // projectId → WebSocket

const optionsRef    = ref(null); // InstrumentOptions 组件引用
const preprocessRef = ref(null); // PreprocessOptions 组件引用

// 源码输入模式：'file' | 'paste'
const sourceMode = ref('file');
// 运行模式：'instrument_only' | 'instrument_and_run'
const runMode = ref('instrument_only');

const form = reactive({
    name: '',
    file: null,
    pasteCode: '',
    pasteFilename: 'script.js',
});

// 粘贴模式统计
const pasteLineCount = computed(() => {
    if (!form.pasteCode) return 0;
    return form.pasteCode.split('\n').length;
});

const pasteByteCount = computed(() => {
    if (!form.pasteCode) return 0;
    return new TextEncoder().encode(form.pasteCode).length;
});

// 是否可以创建
const canCreate = computed(() => {
    if (sourceMode.value === 'file') return !!form.file;
    return form.pasteCode.trim().length > 0;
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

// ── 卡片点击 ──────────────────────────────────────────────────────────────────
function handleCardClick(p) {
    if (p.status === 'ready' || p.status === 'failed') {
        router.push(`/workspaces/${p.id}`);
    }
}

// ── 创建工作空间 ──────────────────────────────────────────────────────────────
async function doCreate() {
    if (!canCreate.value) return;
    creating.value = true;
    createError.value = '';

    try {
        const opts       = optionsRef.value?.buildOptions() ?? {};
        const preprocess = preprocessRef.value?.buildPreprocess() ?? null;

        if (runMode.value === 'instrument_and_run') {
            await _createAndRun(opts, preprocess);
        } else if (sourceMode.value === 'file') {
            await _createFromFile(opts, preprocess);
        } else {
            await _createFromPaste(opts, preprocess);
        }
    } catch (e) {
        createError.value = e.message;
    } finally {
        creating.value = false;
    }
}

// 统一处理「插桩并运行」
async function _createAndRun(opts, preprocess) {
    // 获取源码和文件名
    let code, filename;
    if (sourceMode.value === 'file') {
        code = await form.file.text();
        filename = form.file.name;
    } else {
        code = form.pasteCode;
        filename = form.pasteFilename.trim() || 'script.js';
        if (!filename.endsWith('.js')) filename += '.js';
    }

    const displayName = form.name.trim() || filename.replace(/\.js$/, '');

    // Step 1：调用 /api/instrument/run 运行并生成 trace（含预处理）
    const runRes = await fetch('/api/instrument/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            filename,
            options:    { ...opts, target: 'node', noIdb: false },
            env:        'node',
            preprocess: preprocess ?? null,
        }),
    });
    const runData = await runRes.json();
    if (!runRes.ok) throw new Error(runData.error || `HTTP ${runRes.status}`);

    const { runId } = runData;

    // Step 2：轮询运行结果，等待完成
    const sessionId = await _pollRunResult(runId);

    // Step 3：同时在后台创建工作空间（仅插桩，不运行）
    const blob = new Blob([code], { type: 'text/javascript' });
    const file = new File([blob], filename, { type: 'text/javascript' });
    const fd = new FormData();
    fd.append('source', file, filename);
    if (form.name.trim()) fd.append('name', form.name.trim());
    fd.append('options', JSON.stringify(opts));
    if (preprocess) fd.append('preprocess', JSON.stringify(preprocess));

    const projRes  = await fetch('/api/projects', { method: 'POST', body: fd });
    const projData = await projRes.json();
    if (!projRes.ok) throw new Error(projData.error || `HTTP ${projRes.status}`);

    projects.value.unshift({
        id:         projData.projectId,
        name:       displayName,
        status:     'instrumenting',
        created_at: Date.now(),
        iid_count:  0,
    });

    watchProject(projData.projectId);
    cancelCreate();

    // 如果运行成功并生成了 session，跳转到该 session
    if (sessionId) {
        router.push(`/sessions/${sessionId}`);
    }
}

// 从文件创建
async function _createFromFile(opts, preprocess) {
    const fd = new FormData();
    fd.append('source', form.file, form.file.name);
    if (form.name.trim()) fd.append('name', form.name.trim());
    fd.append('options', JSON.stringify(opts));
    if (preprocess) fd.append('preprocess', JSON.stringify(preprocess));

    const res  = await fetch('/api/projects', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    projects.value.unshift({
        id:         data.projectId,
        name:       form.name.trim() || form.file.name.replace(/\.js$/, ''),
        status:     'instrumenting',
        created_at: Date.now(),
        iid_count:  0,
    });

    watchProject(data.projectId);
    cancelCreate();
}

// 从粘贴代码创建（仅插桩）
async function _createFromPaste(opts, preprocess) {
    const filename = form.pasteFilename.trim() || 'script.js';
    const ensuredFilename = filename.endsWith('.js') ? filename : filename + '.js';

    // 把粘贴的代码构建成 File 对象并上传
    const blob = new Blob([form.pasteCode], { type: 'text/javascript' });
    const file = new File([blob], ensuredFilename, { type: 'text/javascript' });

    const fd = new FormData();
    fd.append('source', file, ensuredFilename);
    if (form.name.trim()) fd.append('name', form.name.trim());
    fd.append('options', JSON.stringify(opts));
    if (preprocess) fd.append('preprocess', JSON.stringify(preprocess));

    const res  = await fetch('/api/projects', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const displayName = form.name.trim() || ensuredFilename.replace(/\.js$/, '');
    projects.value.unshift({
        id:         data.projectId,
        name:       displayName,
        status:     'instrumenting',
        created_at: Date.now(),
        iid_count:  0,
    });

    watchProject(data.projectId);
    cancelCreate();
}
// 轮询运行结果
async function _pollRunResult(runId, maxWait = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        await _sleep(800);
        try {
            const res = await fetch(`/api/instrument/run/${runId}`);
            if (!res.ok) continue;
            const data = await res.json();
            if (data.status === 'done' || data.status === 'failed') {
                return data.sessionId || null;
            }
        } catch { /* 忽略临时错误 */ }
    }
    return null;
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function cancelCreate() {
    showCreate.value  = false;
    createError.value = '';
    form.name         = '';
    form.file         = null;
    form.pasteCode    = '';
    form.pasteFilename = 'script.js';
    sourceMode.value  = 'file';
    runMode.value     = 'instrument_only';
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
    transition: border-color 0.15s, box-shadow 0.15s;
}
.project-card:hover {
    border-color: var(--accent);
}

/* 可点击卡片样式 */
.project-card-clickable {
    cursor: pointer;
}
.project-card-clickable:hover {
    box-shadow: 0 4px 16px rgba(99,102,241,0.15);
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

/* InstrumentOptions / PreprocessOptions embedded 模式：突破 modal-body padding 贴边显示 */
.modal-body :deep(.options-panel-embedded),
.modal-body :deep(.preprocess-panel-embedded) {
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

/* 源码输入 Tab */
.source-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 10px;
}

.source-tab {
    padding: 7px 14px;
    font-size: 13px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
}

.source-tab:hover {
    color: var(--text-primary);
}

.source-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
}

/* 粘贴模式 */
.paste-mode {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.paste-filename-row {
    display: flex;
    align-items: center;
    gap: 10px;
}

.paste-filename-input {
    flex: 0 0 auto;
    width: 200px;
    padding: 5px 10px;
    font-size: 12px;
    font-family: monospace;
}

.paste-stat {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
}

.code-editor {
    width: 100%;
    height: 200px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    line-height: 1.6;
    padding: 10px 12px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    resize: vertical;
    box-sizing: border-box;
    tab-size: 2;
}

.code-editor:focus {
    outline: none;
    border-color: var(--accent);
}

/* 运行模式选择 */
.run-mode-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0 4px;
}

.run-mode-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
}

.run-mode-options {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

.radio-card {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 14px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    flex: 1;
    min-width: 180px;
    transition: all 0.15s;
    background: var(--bg-primary);
}

.radio-card:hover {
    border-color: var(--accent);
}

.radio-card.selected {
    border-color: var(--accent);
    background: rgba(99,102,241,0.06);
}

.radio-card input[type="radio"] {
    width: auto;
    margin-top: 2px;
    flex-shrink: 0;
}

.radio-card-content {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.radio-card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
}

.radio-card-hint {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
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

@keyframes spin {
    to { transform: rotate(360deg); }
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
</style>
