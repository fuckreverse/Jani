<template>
  <teleport to="body">
    <transition name="vv-fade">
      <div v-if="visible" class="vv-overlay" @click.self="close">
        <div class="vv-modal">
          <!-- 头部 -->
          <div class="vv-header">
            <div class="vv-title">
              <span class="vv-icon">🔍</span>
              <span v-if="label" class="vv-label">{{ label }}</span>
              <span class="vv-type-badge" :class="`vv-type-${valueType}`">{{ valueType }}</span>
            </div>
            <div class="vv-header-actions">
              <button class="vv-btn-copy" :class="{ copied: copied }" @click="copyValue" title="复制到剪贴板">
                {{ copied ? '✓ 已复制' : '📋 复制' }}
              </button>
              <button class="vv-close" @click="close" title="关闭 (Esc)">✕</button>
            </div>
          </div>

          <!-- 内容区 -->
          <div class="vv-body">
            <!-- JSON 对象/数组：格式化展示 -->
            <div v-if="valueType === 'object' || valueType === 'array'" class="vv-json-wrap">
              <div class="vv-view-tabs">
                <button
                  class="vv-view-tab"
                  :class="{ 'vv-view-tab-active': viewMode === 'pretty' }"
                  @click="viewMode = 'pretty'"
                >格式化</button>
                <button
                  class="vv-view-tab"
                  :class="{ 'vv-view-tab-active': viewMode === 'raw' }"
                  @click="viewMode = 'raw'"
                >原始</button>
              </div>
              <pre v-if="viewMode === 'pretty'" class="vv-pre">{{ prettyJson }}</pre>
              <pre v-else class="vv-pre vv-pre-raw">{{ rawString }}</pre>
            </div>
            <!-- 长字符串 -->
            <div v-else-if="valueType === 'string'" class="vv-string-wrap">
              <div class="vv-string-meta">长度: {{ stringLength }} 字符</div>
              <pre class="vv-pre vv-pre-string">{{ rawString }}</pre>
            </div>
            <!-- 其他基础类型 -->
            <div v-else class="vv-primitive-wrap">
              <pre class="vv-pre vv-pre-primitive">{{ rawString }}</pre>
            </div>
          </div>

          <!-- 底部元信息 -->
          <div class="vv-footer">
            <span class="vv-meta">字符数: {{ rawString.length }}</span>
            <span v-if="valueType === 'string'" class="vv-meta">字符串长度: {{ stringLength }}</span>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { valueViewerState } from '../composables/useValueViewer.js';

const visible  = ref(false);
const copied   = ref(false);
const viewMode = ref('pretty');

const label = computed(() => valueViewerState.label);
const value = computed(() => valueViewerState.value);

// 计算值类型
const valueType = computed(() => {
    const v = value.value;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return 'array';
    return typeof v;
});

// 原始字符串（用于展示/复制）
const rawString = computed(() => {
    const v = value.value;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
});

// 格式化 JSON
const prettyJson = computed(() => {
    const v = value.value;
    if (v === null || v === undefined) return String(v);
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
});

// 字符串长度（值是字符串时）
const stringLength = computed(() => {
    const v = value.value;
    if (typeof v === 'string') return v.length;
    return rawString.value.length;
});

// 监听全局状态变化来打开/关闭
watch(() => valueViewerState.openCount, (n) => {
    if (n > 0) {
        visible.value = true;
        viewMode.value = 'pretty';
        copied.value = false;
    }
});
watch(() => valueViewerState.closeCount, () => {
    visible.value = false;
});

function close() {
    visible.value = false;
}

async function copyValue() {
    try {
        await navigator.clipboard.writeText(rawString.value);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
    } catch {
        // fallback
        const el = document.createElement('textarea');
        el.value = rawString.value;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
    }
}

function onKeydown(e) {
    if (e.key === 'Escape' && visible.value) close();
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<style scoped>
.vv-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0, 0, 0, 0.65);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
}

.vv-modal {
    background: var(--bg-secondary, #1a1d2e);
    border: 1px solid var(--border-color, #2d3148);
    border-radius: 12px;
    width: min(720px, 90vw);
    max-height: 80vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    overflow: hidden;
}

/* ── 头部 ── */
.vv-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
    gap: 8px;
}
.vv-title {
    display: flex; align-items: center; gap: 8px;
    min-width: 0; flex: 1;
}
.vv-icon { font-size: 14px; flex-shrink: 0; }
.vv-label {
    font-family: monospace; font-size: 13px; font-weight: 600;
    color: #a5b4fc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 300px;
}
.vv-type-badge {
    flex-shrink: 0; padding: 1px 7px; border-radius: 10px;
    font-size: 11px; font-weight: 600; font-family: monospace;
}
.vv-type-string    { background: rgba(34,197,94,0.15);   color: #86efac; }
.vv-type-number    { background: rgba(245,158,11,0.15);  color: #fcd34d; }
.vv-type-boolean   { background: rgba(99,102,241,0.15);  color: #a5b4fc; }
.vv-type-object    { background: rgba(59,130,246,0.15);  color: #93c5fd; }
.vv-type-array     { background: rgba(168,85,247,0.15);  color: #d8b4fe; }
.vv-type-null      { background: rgba(248,113,113,0.15); color: #f87171; }
.vv-type-undefined { background: rgba(107,114,128,0.15); color: #9ca3af; }

.vv-header-actions {
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.vv-btn-copy {
    padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer;
    background: rgba(99,102,241,0.12); color: #a5b4fc;
    border: 1px solid rgba(99,102,241,0.3);
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
}
.vv-btn-copy:hover { background: rgba(99,102,241,0.25); }
.vv-btn-copy.copied { background: rgba(34,197,94,0.15); color: #86efac; border-color: rgba(34,197,94,0.3); }
.vv-close {
    width: 26px; height: 26px; border-radius: 5px;
    background: none; border: none; color: var(--text-muted, #6b7280);
    font-size: 13px; cursor: pointer; transition: background 0.15s, color 0.15s;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.vv-close:hover { background: rgba(248,113,113,0.12); color: #f87171; }

/* ── 内容区 ── */
.vv-body {
    flex: 1; overflow: hidden; display: flex; flex-direction: column;
    min-height: 0;
}

/* 视图切换 tabs */
.vv-view-tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
}
.vv-view-tab {
    padding: 5px 14px; font-size: 11px; background: transparent;
    border: none; border-right: 1px solid var(--border-color, #2d3148);
    color: var(--text-muted, #6b7280); cursor: pointer;
    transition: background 0.1s, color 0.1s;
}
.vv-view-tab:hover { background: var(--bg-tertiary, #262938); color: var(--text-primary, #e2e8f0); }
.vv-view-tab-active {
    background: rgba(99,102,241,0.12) !important;
    color: #a5b4fc !important; font-weight: 600;
}

.vv-json-wrap, .vv-string-wrap, .vv-primitive-wrap {
    display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;
}

.vv-string-meta {
    padding: 4px 16px; font-size: 11px; color: var(--text-muted, #6b7280);
    border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
    background: var(--bg-tertiary, #1e2130);
}

.vv-pre {
    flex: 1; overflow: auto; margin: 0;
    padding: 16px;
    font-family: 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace;
    font-size: 12px; line-height: 1.6;
    color: var(--text-primary, #e2e8f0);
    background: var(--bg-primary, #0f1117);
    white-space: pre-wrap; word-break: break-all;
}

.vv-pre-string {
    color: #86efac;
    background: rgba(34,197,94,0.04);
}

.vv-pre-primitive {
    color: #fcd34d;
    padding: 24px;
    font-size: 16px;
    text-align: center;
    background: var(--bg-primary, #0f1117);
}

/* ── 底部 ── */
.vv-footer {
    padding: 7px 16px;
    border-top: 1px solid var(--border-color, #2d3148);
    display: flex; gap: 16px;
    flex-shrink: 0;
    background: var(--bg-tertiary, #1e2130);
}
.vv-meta { font-size: 11px; color: var(--text-muted, #6b7280); }

/* ── 动画 ── */
.vv-fade-enter-active { transition: opacity 0.15s ease; }
.vv-fade-leave-active { transition: opacity 0.12s ease; }
.vv-fade-enter-from, .vv-fade-leave-to { opacity: 0; }
</style>
