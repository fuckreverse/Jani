<template>
  <div class="file-info-bar card">
    <div class="file-info-title">📂 文件信息</div>
    <div class="file-info-items">
      <!-- Trace .bin -->
      <div class="file-info-item" :class="{ 'file-missing': fileInfo.binFile?.missing }">
        <span class="file-icon">📦</span>
        <div class="file-detail">
          <span class="file-label">Trace .bin</span>
          <code class="file-name">{{ fileInfo.binFile?.name || '未上传' }}</code>
          <span class="file-size" v-if="fileInfo.binFile?.size != null">{{ formatBytes(fileInfo.binFile.size) }}</span>
          <span class="file-missing-tag" v-if="fileInfo.binFile?.missing">⚠️ 文件缺失</span>
        </div>
      </div>
      <!-- smap.json -->
      <div class="file-info-item" :class="{ 'file-missing': fileInfo.smapFile?.missing, 'file-absent': !fileInfo.smapFile }">
        <span class="file-icon">🗺️</span>
        <div class="file-detail">
          <span class="file-label">smap.json</span>
          <code class="file-name" v-if="fileInfo.smapFile">{{ fileInfo.smapFile.name }}</code>
          <span class="file-name text-muted" v-else>未上传</span>
          <span class="file-size" v-if="fileInfo.smapFile?.size != null">{{ formatBytes(fileInfo.smapFile.size) }}</span>
          <span class="file-badge-ok" v-if="smapCount > 0">✅ {{ smapCount.toLocaleString('zh-CN') }} 条 IID 映射</span>
          <span class="file-missing-tag" v-if="fileInfo.smapFile?.missing">⚠️ 文件缺失</span>
        </div>
      </div>
      <!-- 源码 .js -->
      <div class="file-info-item" :class="{ 'file-missing': fileInfo.sourceFile?.missing, 'file-absent': !fileInfo.sourceFile }">
        <span class="file-icon">📄</span>
        <div class="file-detail">
          <span class="file-label">源码 .js</span>
          <code class="file-name" v-if="fileInfo.sourceFile">{{ fileInfo.sourceFile.name }}</code>
          <span class="file-name text-muted" v-else>未上传</span>
          <span class="file-size" v-if="fileInfo.sourceFile?.size != null">{{ formatBytes(fileInfo.sourceFile.size) }}</span>
          <span class="file-missing-tag" v-if="fileInfo.sourceFile?.missing">⚠️ 文件缺失</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { formatBytes } from '../../composables/useSessionUtils.js';

defineProps({
    fileInfo:  { type: Object, required: true },
    smapCount: { type: Number, default: 0 },
});
</script>

<style scoped>
.file-info-bar { padding: 14px 20px; margin-bottom: 0; }
.file-info-title {
    font-size: 12px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;
}
.file-info-items { display: flex; gap: 20px; flex-wrap: wrap; }
.file-info-item {
    display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 180px;
    padding: 10px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color);
    border-radius: 8px; transition: border-color 0.15s;
}
.file-info-item.file-missing { border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.05); }
.file-info-item.file-absent { opacity: 0.55; }
.file-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.file-detail { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.file-label { font-size: 10px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
.file-name { font-size: 12px; font-family: monospace; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.file-size { font-size: 11px; color: var(--text-muted); font-family: monospace; }
.file-badge-ok { font-size: 11px; color: var(--success); font-weight: 500; }
.file-missing-tag { font-size: 11px; color: var(--danger); }
.text-muted { color: var(--text-muted); }
</style>
