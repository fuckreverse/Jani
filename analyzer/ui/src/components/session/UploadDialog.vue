<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog card">
      <h2 class="dialog-title">新建分析会话</h2>
      <p class="dialog-hint">上传 .bin trace 文件（必须）以及可选的 .smap.json 和 .js 源文件</p>

      <div class="upload-form">
        <div class="form-field">
          <label>会话名称（可选）</label>
          <input v-model="form.name" placeholder="如：target-v2.3" />
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
            <span v-if="form.bin">📦 {{ form.bin.name }} ({{ formatSize(form.bin.size) }})</span>
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
            <span v-if="form.smap">🗺️ {{ form.smap.name }}</span>
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
            <span v-if="form.source">📄 {{ form.source.name }}</span>
            <span v-else>点击或拖入 .js 文件（可选）</span>
          </div>
          <input ref="sourceInput" type="file" accept=".js" style="display:none" @change="handleFileInput('source', $event)" />
        </div>

        <!-- 分析插件选择 -->
        <PluginSelector v-model="form.selectedPlugins" ref="pluginSelectorRef" />

        <div v-if="uploadError" class="upload-error">❌ {{ uploadError }}</div>

        <div class="dialog-actions">
          <button class="btn-secondary" @click="$emit('close')">取消</button>
          <button
            class="btn-primary"
            :disabled="!form.bin || uploading"
            @click="submit"
          >
            <span v-if="uploading">上传中...</span>
            <span v-else>创建会话</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import PluginSelector from './PluginSelector.vue';

const emit = defineEmits(['close', 'created']);

const form     = ref({ name: '', bin: null, smap: null, source: null, selectedPlugins: [] });
const dragging = reactive({ bin: false, smap: false, source: false });
const uploading   = ref(false);
const uploadError = ref('');
const pluginSelectorRef = ref(null);

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function handleDrop(field, e) {
    dragging[field] = false;
    const file = e.dataTransfer.files[0];
    if (file) form.value[field] = file;
}

function handleFileInput(field, e) {
    const file = e.target.files[0];
    if (file) form.value[field] = file;
}

async function submit() {
    if (!form.value.bin) return;
    uploading.value = true;
    uploadError.value = '';

    try {
        const formData = new FormData();
        formData.append('bin', form.value.bin);
        if (form.value.smap)   formData.append('smap',   form.value.smap);
        if (form.value.source) formData.append('source', form.value.source);
        if (form.value.name)   formData.append('name',   form.value.name);

        // 传递 selectedPlugins：null = 全选（不传，后端用默认），否则传过滤列表
        const payload = pluginSelectorRef.value?.getPayload();
        if (payload !== null && payload !== undefined) {
            formData.append('selectedPlugins', JSON.stringify(payload));
        }

        const res = await fetch('/api/sessions', { method: 'POST', body: formData });

        const contentType = res.headers.get('content-type') || '';
        let data = {};
        if (contentType.includes('application/json')) {
            data = await res.json();
        } else if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const savedName = form.value.name || (form.value.bin?.name?.replace(/\.bin$/, '')) || '';
        form.value = { name: '', bin: null, smap: null, source: null, selectedPlugins: [] };

        emit('created', { sessionId: data.sessionId, name: savedName });
    } catch (e) {
        uploadError.value = e.message;
    } finally {
        uploading.value = false;
    }
}
</script>

<style scoped>
.dialog-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.dialog { width: 600px; max-height: 90vh; overflow-y: auto; }
.dialog-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.dialog-hint { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }
.upload-form { display: flex; flex-direction: column; gap: 16px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.required { color: var(--danger); }
.dropzone {
    border: 2px dashed var(--border-color); border-radius: 8px; padding: 16px;
    text-align: center; cursor: pointer; font-size: 13px; color: var(--text-muted); transition: all 0.15s;
}
.dropzone:hover, .dropzone-active {
    border-color: var(--accent); color: var(--text-primary); background: rgba(99,102,241,0.05);
}
.upload-error {
    color: var(--danger); font-size: 13px; padding: 8px 12px;
    background: rgba(239,68,68,0.1); border-radius: 6px;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; }
</style>
