<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A7 · 对象属性变异追踪</h2>
      <span class="section-badge">共 {{ total }} 条记录</span>
    </div>

    <div v-if="objLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="total === 0 && !objBaseFilter" class="empty-state"><p>暂无对象变异数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <!-- 过滤栏 -->
      <div class="filter-bar">
        <label class="filter-label">过滤对象：</label>
        <select v-model="objBaseFilter" @change="onFilterChange" class="select-input obj-select">
          <option value="">— 全部 —</option>
          <option v-for="s in objBaseStats" :key="s.base_var" :value="s.base_var">
            {{ s.base_var }}（写 {{ s.write_count }}·读 {{ s.read_count }}）
          </option>
        </select>
        <label class="filter-label">
          <input type="checkbox" v-model="onlyObjWrites" @change="onFilterChange" />
          仅显示写入
        </label>
        <label class="filter-label">
          每页
          <select v-model.number="pageSize" @change="onFilterChange" class="select-input" style="width:70px">
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
            <option :value="500">500</option>
          </select>
          条
        </label>
      </div>

      <!-- 表格 -->
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr><th>操作</th><th>对象</th><th>属性</th><th>旧值</th><th>新值</th><th>行号</th><th>SEQ</th></tr>
          </thead>
          <tbody>
            <tr v-if="objTimelines.length === 0">
              <td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px">无匹配记录</td>
            </tr>
            <tr v-for="t in objTimelines" :key="t.id" :class="t.is_write ? '' : 'row-read-op'">
              <td>
                <span :class="t.is_write ? 'var-chip var-write' : 'var-chip var-read'">
                  {{ t.is_write ? 'write' : 'read' }}
                </span>
              </td>
              <td><code class="src-text">{{ t.base_var }}</code></td>
              <td><span class="var-chip var-field">{{ t.offset_key }}</span></td>
              <td>
                <code
                  class="src-text"
                  style="color:#94a3b8"
                  :class="{ 'obj-value-clickable': t.old_value != null }"
                  :title="t.old_value != null ? '点击查看完整旧值' : ''"
                  @click="t.old_value != null && openValueViewer(tryParseJson(t.old_value), t.offset_key + ' (旧值)')"
                >{{ truncate(t.old_value, 40) || '—' }}</code>
              </td>
              <td>
                <code
                  class="src-text"
                  style="color:#fcd34d"
                  :class="{ 'obj-value-clickable': t.new_value != null }"
                  :title="t.new_value != null ? '点击查看完整新值' : ''"
                  @click="t.new_value != null && openValueViewer(tryParseJson(t.new_value), t.offset_key + ' (新值)')"
                >{{ truncate(t.new_value, 40) || '—' }}</code>
              </td>
              <td class="td-seq">{{ t.line ?? '—' }}</td>
              <td class="td-seq">{{ t.change_seq }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页控件 -->
      <div class="pagination-bar" v-if="totalPages > 1">
        <button class="page-btn" :disabled="currentPage <= 1" @click="goPage(1)">«</button>
        <button class="page-btn" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">‹</button>
        <span class="page-info">第 {{ currentPage }} / {{ totalPages }} 页（共 {{ total }} 条）</span>
        <button class="page-btn" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">›</button>
        <button class="page-btn" :disabled="currentPage >= totalPages" @click="goPage(totalPages)">»</button>
        <span class="page-jump">
          跳至
          <input
            type="number" min="1" :max="totalPages"
            v-model.number="jumpPage"
            @keydown.enter="goPage(jumpPage)"
            class="page-jump-input"
          />
          页
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { truncate } from '../../composables/useSessionUtils.js';
import { openValueViewer } from '../../composables/useValueViewer.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const objTimelines  = ref([]);
const objBaseStats  = ref([]);
const objLoading    = ref(false);
const objBaseFilter = ref('');
const onlyObjWrites = ref(false);

// 分页状态
const currentPage = ref(1);
const totalPages  = ref(1);
const total       = ref(0);
const pageSize    = ref(100);
const jumpPage    = ref(1);

async function loadObjTimelines(page = currentPage.value) {
    objLoading.value = true;
    try {
        const params = new URLSearchParams({
            page:     String(page),
            pageSize: String(pageSize.value),
        });
        if (objBaseFilter.value)  params.set('baseVar',    objBaseFilter.value);
        if (onlyObjWrites.value)  params.set('onlyWrites', '1');

        const res = await fetch(`/api/sessions/${props.sessionId}/object-timelines?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        objTimelines.value = data.timelines  || [];
        objBaseStats.value = data.baseVarStats || [];
        total.value        = data.total       ?? 0;
        totalPages.value   = data.totalPages  ?? 1;
        currentPage.value  = data.page        ?? page;
        jumpPage.value     = currentPage.value;
    } catch (e) {
        console.error('loadObjTimelines error:', e);
    } finally {
        objLoading.value = false;
    }
}

function onFilterChange() {
    // 过滤条件变化时重置到第 1 页
    loadObjTimelines(1);
}

function tryParseJson(s) {
    if (s == null) return s;
    try { return JSON.parse(s); } catch { return s; }
}

function goPage(p) {
    const pg = Math.max(1, Math.min(Number(p) || 1, totalPages.value));
    if (pg !== currentPage.value) {
        loadObjTimelines(pg);
    }
}

defineExpose({ reload: () => loadObjTimelines(1) });

onMounted(() => loadObjTimelines(1));
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.select-input {
    padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
}
.obj-select { max-width: 320px; }
.events-table-wrapper { overflow-x: auto; }
.events-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.events-table th {
    text-align: left; padding: 8px 12px; color: var(--text-muted);
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    border-bottom: 1px solid var(--border-color); white-space: nowrap;
}
.events-table td { padding: 7px 12px; border-bottom: 1px solid rgba(45,49,72,0.5); vertical-align: middle; }
.events-table tr:hover td { background: var(--bg-tertiary); }
.td-seq { font-family: monospace; color: var(--text-muted); min-width: 50px; }
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 200px; display: block; overflow: hidden; text-overflow: ellipsis; }
.row-read-op td { background: rgba(99,102,241,0.05) !important; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-field { background: rgba(245,158,11,0.15); color: #fcd34d; }
.obj-value-clickable {
    cursor: pointer;
    border-bottom: 1px dashed rgba(255,255,255,0.2);
    transition: opacity 0.1s;
}
.obj-value-clickable:hover { opacity: 0.85; border-bottom-style: solid; }

/* 分页 */
.pagination-bar {
    display: flex; align-items: center; gap: 6px;
    margin-top: 12px; padding-top: 10px;
    border-top: 1px solid var(--border-color);
    flex-wrap: wrap;
}
.page-btn {
    padding: 3px 10px; border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary);
    font-size: 13px; cursor: pointer; transition: background 0.15s;
}
.page-btn:hover:not(:disabled) { background: var(--bg-tertiary); }
.page-btn:disabled { opacity: 0.35; cursor: default; }
.page-info { font-size: 12px; color: var(--text-muted); margin: 0 4px; }
.page-jump { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; margin-left: 8px; }
.page-jump-input {
    width: 50px; padding: 2px 6px; border-radius: 4px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
    text-align: center;
}
</style>
