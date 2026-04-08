<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog card" style="width: min(600px, 96vw)">
      <h2 class="dialog-title">从已有 Trace 文件导入</h2>
      <p class="dialog-hint">选择一个已收集的 trace 文件创建分析会话</p>

      <div class="import-form">
        <div class="form-field">
          <label>会话名称（可选）</label>
          <input v-model="form.name" placeholder="留空则自动生成" />
        </div>

        <div class="form-field">
          <label>关联工作空间（可选，用于获取 smap）</label>
          <select v-model="form.projectId">
            <option :value="null">不关联</option>
            <option v-for="p in availableProjects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
        </div>

        <div class="form-field">
          <label>选择 Trace 文件</label>
          <input
            v-model="traceSearchQuery"
            type="text"
            class="trace-search"
            placeholder="搜索..."
            @input="debouncedLoadTraces"
          />
        </div>

        <div v-if="loadingTraces" class="trace-loading"><div class="spinner-sm"></div> 加载中...</div>
        <div v-else-if="existingTraces.length === 0" class="trace-empty">暂无可用 trace 文件</div>
        <div v-else class="trace-list">
          <div
            v-for="t in existingTraces"
            :key="t.name"
            class="trace-item"
            :class="{ selected: form.selectedTrace?.name === t.name }"
            @click="form.selectedTrace = t"
          >
            <span class="trace-radio">{{ form.selectedTrace?.name === t.name ? '◉' : '○' }}</span>
            <span class="trace-name">{{ t.alias || t.name }}</span>
            <span class="trace-size">{{ formatSize(t.size) }}</span>
            <span class="trace-mtime">{{ formatDate(t.mtime) }}</span>
          </div>
        </div>
      </div>

      <div v-if="importError" class="upload-error">❌ {{ importError }}</div>

      <div class="dialog-actions">
        <button class="btn-secondary" @click="$emit('close')">取消</button>
        <button
          class="btn-primary"
          :disabled="!form.selectedTrace || importing"
          @click="doImport"
        >
          {{ importing ? '导入中...' : '开始导入' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { formatDate } from '../../composables/useSessionUtils.js';

const emit = defineEmits(['close', 'imported']);

const form = ref({ name: '', projectId: null, selectedTrace: null });
const importing         = ref(false);
const importError       = ref('');
const existingTraces    = ref([]);
const loadingTraces     = ref(false);
const traceSearchQuery  = ref('');
const availableProjects = ref([]);
let traceSearchTimer = null;

function formatSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadExistingTraces() {
    loadingTraces.value = true;
    try {
        const params = new URLSearchParams({ offset: 0, limit: 20 });
        if (traceSearchQuery.value.trim()) params.set('q', traceSearchQuery.value.trim());
        const res = await fetch(`/api/trace/files?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        existingTraces.value = data.files || [];
    } catch (e) {
        console.error('loadExistingTraces error:', e);
    } finally {
        loadingTraces.value = false;
    }
}

function debouncedLoadTraces() {
    if (traceSearchTimer) clearTimeout(traceSearchTimer);
    traceSearchTimer = setTimeout(loadExistingTraces, 300);
}

async function loadProjects() {
    try {
        const res = await fetch('/api/projects');
        if (!res.ok) return;
        const data = await res.json();
        availableProjects.value = (data.projects || data).filter(p => p.status === 'ready');
    } catch { /* ignore */ }
}

async function doImport() {
    if (!form.value.selectedTrace) return;
    importing.value = true;
    importError.value = '';

    try {
        const res = await fetch('/api/trace/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename:  form.value.selectedTrace.name,
                name:      form.value.name.trim() || undefined,
                projectId: form.value.projectId || undefined,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const savedName = form.value.name || form.value.selectedTrace.name.replace(/\.bin$/, '');
        form.value = { name: '', projectId: null, selectedTrace: null };

        emit('imported', { sessionId: data.sessionId, name: savedName });
    } catch (e) {
        importError.value = e.message;
    } finally {
        importing.value = false;
    }
}

onMounted(() => {
    loadExistingTraces();
    loadProjects();
});
</script>

<style scoped>
.dialog-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.dialog { max-height: 90vh; overflow-y: auto; }
.dialog-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.dialog-hint { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }
.import-form { display: flex; flex-direction: column; gap: 14px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.trace-search {
    width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary); font-size: 13px;
}
.trace-search:focus { outline: none; border-color: var(--accent); }
.trace-loading, .trace-empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
.trace-list { max-height: 240px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px; }
.trace-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-bottom: 1px solid var(--border-color); cursor: pointer; transition: background 0.1s;
}
.trace-item:last-child { border-bottom: none; }
.trace-item:hover { background: var(--bg-tertiary); }
.trace-item.selected { background: rgba(99,102,241,0.12); }
.trace-radio { font-size: 14px; color: var(--text-muted); }
.trace-item.selected .trace-radio { color: var(--accent); }
.trace-name { flex: 1; font-size: 12px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trace-size, .trace-mtime { font-size: 11px; color: var(--text-muted); font-family: monospace; }
.upload-error { color: var(--danger); font-size: 13px; padding: 8px 12px; background: rgba(239,68,68,0.1); border-radius: 6px; margin-top: 8px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px; }
.spinner-sm {
    display: inline-block; width: 12px; height: 12px;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
    border-radius: 50%; animation: spin 0.7s linear infinite;
    vertical-align: -2px; margin-right: 4px;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
