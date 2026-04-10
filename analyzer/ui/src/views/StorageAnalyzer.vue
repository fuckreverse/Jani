<template>
  <div class="storage-analyzer">
    <!-- 页头 -->
    <div class="page-header">
      <div>
        <h1 class="page-title">💾 空间使用分析</h1>
        <p class="page-subtitle">扫描 data 目录的磁盘占用，识别可安全删除的冗余文件，帮助你释放存储空间</p>
      </div>
      <button class="btn-primary" :disabled="loading" @click="loadStats">
        <span v-if="loading"><span class="spinner-sm"></span> 扫描中...</span>
        <span v-else>🔄 重新扫描</span>
      </button>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading && !stats" class="loading-state">
      <div class="spinner"></div>
      <span>正在扫描磁盘占用...</span>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="error" class="error-state card">
      <span class="error-icon">❌</span>
      <div class="error-body">
        <div class="error-title">扫描失败</div>
        <div class="error-msg">{{ error }}</div>
      </div>
      <button class="btn-secondary" @click="loadStats">重试</button>
    </div>

    <!-- 主体 -->
    <template v-else-if="stats">

      <!-- 概览卡片行 -->
      <div class="summary-row">
        <div class="summary-card card total-card">
          <div class="summary-icon">🗄️</div>
          <div class="summary-body">
            <div class="summary-label">data/ 目录总占用</div>
            <div class="summary-value total-value">{{ stats.summary.totalSizeStr }}</div>
          </div>
        </div>
        <div v-for="(cat, key) in stats.summary.breakdown" :key="key" class="summary-card card" :class="{ 'db-card': key === 'database' }">
          <div class="summary-icon">{{ catIcon(key) }}</div>
          <div class="summary-body">
            <div class="summary-label">{{ catLabel(key) }}</div>
            <div class="summary-value">{{ cat.sizeStr }}</div>
            <div v-if="cat.count != null" class="summary-sub">{{ cat.count }} 个</div>
            <div v-if="key === 'database'" class="vacuum-area">
              <button
                class="btn-vacuum btn-sm"
                :disabled="vacuuming"
                @click="runVacuum"
                title="执行 VACUUM + WAL checkpoint，回收删除数据占用的磁盘空间"
              >
                <span v-if="vacuuming"><span class="spinner-sm"></span> 压缩中...</span>
                <span v-else>🗜️ 压缩数据库</span>
              </button>
            </div>
          </div>
          <div class="summary-bar">
            <div
              class="summary-bar-fill"
              :class="`bar-${key}`"
              :style="{ width: barPercent(cat.size, stats.summary.totalSize) + '%' }"
            ></div>
          </div>
        </div>
      </div>

      <!-- 智能建议区 -->
      <section class="section">
        <h2 class="section-title">🧹 智能删除建议</h2>
        <div class="suggestions">
          <div
            v-for="sug in stats.suggestions"
            :key="sug.id"
            class="sug-card card"
            :class="`sug-${sug.priority}`"
          >
            <div class="sug-header">
              <div class="sug-left">
                <span class="sug-badge" :class="`badge-${sug.priority}`">{{ priorityLabel(sug.priority) }}</span>
                <span class="sug-title">{{ sug.title }}</span>
              </div>
              <div class="sug-right">
                <span v-if="sug.savedSize > 0" class="sug-saved">可释放 {{ sug.savedSizeStr }}</span>
                <button
                  v-if="sug.items && sug.items.length > 0"
                  class="btn-danger btn-sm"
                  :disabled="deleting"
                  @click="deleteSuggestion(sug)"
                >
                  <span v-if="deletingSugId === sug.id"><span class="spinner-sm"></span> 清理中...</span>
                  <span v-else>一键清理</span>
                </button>
              </div>
            </div>
            <div class="sug-desc">{{ sug.description }}</div>
            <template v-if="sug.items && sug.items.length > 0 && sug.priority !== 'info'">
              <div class="sug-toggle" @click="toggleSug(sug.id)">
                {{ expandedSugs.has(sug.id) ? '▲ 收起明细' : ('▼ 展开 ' + sug.items.length + ' 条明细') }}
              </div>
              <div v-if="expandedSugs.has(sug.id)" class="sug-items">
                <div v-for="(it, idx) in sug.items" :key="idx" class="sug-item">
                  <span class="sug-item-name">{{ it.name || it.id || shortPath(it.path) }}</span>
                  <span class="sug-item-age">{{ it.ageStr }}</span>
                  <span class="sug-item-size">{{ it.sizeStr }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <!-- 明细 Tab -->
      <section class="section">
        <h2 class="section-title">📋 文件明细</h2>
        <div class="tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="tab-btn"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}<span class="tab-count">{{ tabCount(tab.id) }}</span>
          </button>
        </div>

        <!-- uploads 明细 -->
        <div v-if="activeTab === 'uploads'" class="detail-panel">
          <div v-if="stats.uploads.length === 0" class="empty-hint">无上传临时文件</div>
          <template v-else>
            <div class="detail-toolbar">
              <span class="detail-hint">
                uploads/ 目录的 multer 临时文件。
                <strong>孤立文件</strong>（未被任何会话/工作空间引用）可安全删除。
              </span>
              <button
                v-if="orphanUploads.length > 0"
                class="btn-danger btn-sm"
                :disabled="deleting"
                @click="deleteOrphanUploads"
              >清理全部孤立文件（{{ orphanUploads.length }} 个）</button>
            </div>
            <table class="detail-table">
              <thead>
                <tr><th>文件名</th><th>大小</th><th>修改时间</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="f in stats.uploads" :key="f.path" :class="{ 'row-orphan': f.orphan }">
                  <td class="cell-mono">{{ f.name }}</td>
                  <td>{{ f.sizeStr }}</td>
                  <td>{{ f.ageStr }}</td>
                  <td>
                    <span v-if="f.orphan" class="tag tag-danger">孤立</span>
                    <span v-else class="tag tag-ok">引用中</span>
                  </td>
                  <td>
                    <button v-if="f.orphan" class="btn-danger btn-xs" :disabled="deleting"
                      @click="deleteItem({ type: 'upload', path: f.path, name: f.name })">删除</button>
                    <span v-else class="text-muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <!-- sessions 明细 -->
        <div v-if="activeTab === 'sessions'" class="detail-panel">
          <div v-if="stats.sessions.length === 0" class="empty-hint">无会话数据目录</div>
          <template v-else>
            <div class="detail-toolbar">
              <span class="detail-hint">每个会话的磁盘占用（按大小降序）。<strong>孤立项</strong>表示数据库中已无记录，可直接删除。</span>
            </div>
            <table class="detail-table">
              <thead>
                <tr><th>会话名称</th><th>大小</th><th>文件数</th><th>事件数</th><th>最后修改</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in stats.sessions" :key="s.id" :class="{ 'row-orphan': s.orphan }">
                  <td>
                    <div class="item-name-cell">
                      <span class="item-name">{{ s.name }}</span>
                      <span class="item-id">{{ s.id.slice(0,8) }}…</span>
                    </div>
                  </td>
                  <td class="td-size">{{ s.sizeStr }}</td>
                  <td>{{ s.fileCount }}</td>
                  <td>{{ s.eventCount > 0 ? s.eventCount.toLocaleString() : '—' }}</td>
                  <td>{{ s.ageStr }}</td>
                  <td>
                    <span v-if="s.orphan" class="tag tag-danger">孤立</span>
                    <span v-else-if="s.status === 'ready'" class="tag tag-ready">就绪</span>
                    <span v-else-if="s.status === 'failed'" class="tag tag-failed">失败</span>
                    <span v-else-if="s.status" class="tag tag-processing">{{ s.status }}</span>
                    <span v-else class="tag tag-ok">正常</span>
                  </td>
                  <td>
                    <div class="action-row">
                      <router-link v-if="!s.orphan" :to="`/sessions/${s.id}`" class="btn-secondary btn-xs">查看</router-link>
                      <button class="btn-danger btn-xs" :disabled="deleting" @click="confirmDeleteSession(s)">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <!-- projects 明细 -->
        <div v-if="activeTab === 'projects'" class="detail-panel">
          <div v-if="stats.projects.length === 0" class="empty-hint">无工作空间数据目录</div>
          <template v-else>
            <div class="detail-toolbar">
              <span class="detail-hint">每个工作空间的磁盘占用（含原始 JS、插桩后代码、smap 等）。<strong>孤立项</strong>表示数据库中已无记录。</span>
            </div>
            <table class="detail-table">
              <thead>
                <tr><th>工作空间名称</th><th>大小</th><th>文件数</th><th>IID 数</th><th>最后修改</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="p in stats.projects" :key="p.id" :class="{ 'row-orphan': p.orphan }">
                  <td>
                    <div class="item-name-cell">
                      <span class="item-name">{{ p.name }}</span>
                      <span class="item-id">{{ p.id.slice(0,8) }}…</span>
                    </div>
                  </td>
                  <td class="td-size">{{ p.sizeStr }}</td>
                  <td>{{ p.fileCount }}</td>
                  <td>{{ p.iidCount > 0 ? p.iidCount.toLocaleString() : '—' }}</td>
                  <td>{{ p.ageStr }}</td>
                  <td>
                    <span v-if="p.orphan" class="tag tag-danger">孤立</span>
                    <span v-else-if="p.status === 'ready'" class="tag tag-ready">就绪</span>
                    <span v-else-if="p.status === 'failed'" class="tag tag-failed">失败</span>
                    <span v-else-if="p.status === 'instrumenting'" class="tag tag-processing">插桩中</span>
                    <span v-else class="tag tag-ok">正常</span>
                  </td>
                  <td>
                    <div class="action-row">
                      <router-link v-if="!p.orphan && p.status === 'ready'" :to="`/workspaces/${p.id}`" class="btn-secondary btn-xs">查看</router-link>
                      <button class="btn-danger btn-xs" :disabled="deleting" @click="confirmDeleteProject(p)">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>
      </section>
    </template>

    <!-- 删除确认弹窗 -->
    <div v-if="deleteConfirm" class="modal-overlay" @click.self="deleteConfirm = null">
      <div class="modal card">
        <div class="modal-header">
          <span class="modal-title">⚠️ 确认删除</span>
          <button class="btn-icon" @click="deleteConfirm = null">✕</button>
        </div>
        <div class="modal-body">
          <p>确定删除以下项目吗？此操作<strong>不可撤销</strong>。</p>
          <div class="confirm-target">
            <span class="confirm-icon">{{ deleteConfirm.type === 'session_dir' ? '📊' : '🗂️' }}</span>
            <span class="confirm-name">{{ deleteConfirm.name || deleteConfirm.id }}</span>
            <span class="confirm-size">{{ deleteConfirm.sizeStr }}</span>
          </div>
          <p v-if="deleteConfirm.type === 'session_dir'" class="confirm-warn">
            ⚠️ 会话目录及所有分析数据将被永久删除，数据库记录也将一并清除。
          </p>
          <p v-else-if="deleteConfirm.type === 'project_dir'" class="confirm-warn">
            ⚠️ 工作空间目录（含插桩文件和 smap）将被永久删除。关联会话不受影响，但将失去工作空间关联。
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="deleteConfirm = null">取消</button>
          <button class="btn-danger" :disabled="deleting" @click="executeConfirmedDelete">
            <span v-if="deleting"><span class="spinner-sm"></span> 删除中...</span>
            <span v-else>确认删除</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Toast 通知 -->
    <div v-if="toast" class="toast" :class="`toast-${toast.type}`">
      <span>{{ toast.message }}</span>
      <button class="toast-close" @click="toast = null">✕</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const loading       = ref(false);
const error         = ref('');
const stats         = ref(null);
const activeTab     = ref('sessions');
const expandedSugs  = ref(new Set());
const deleting      = ref(false);
const deletingSugId = ref(null);
const deleteConfirm = ref(null);
const toast         = ref(null);
const vacuuming     = ref(false);

const tabs = [
    { id: 'sessions', label: '会话数据' },
    { id: 'projects', label: '工作空间' },
    { id: 'uploads',  label: '上传临时文件' },
];

const orphanUploads = computed(() => (stats.value?.uploads || []).filter(f => f.orphan));

async function loadStats() {
    loading.value = true; error.value = '';
    try {
        const res  = await fetch('/api/storage/stats');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        stats.value = data;
    } catch (e) { error.value = e.message; }
    finally { loading.value = false; }
}
onMounted(loadStats);

function toggleSug(id) {
    const s = new Set(expandedSugs.value);
    if (s.has(id)) s.delete(id); else s.add(id);
    expandedSugs.value = s;
}

async function deleteSuggestion(sug) {
    if (!sug.items || !sug.items.length) return;
    deletingSugId.value = sug.id; deleting.value = true;
    try {
        const items = sug.items.map(it => _sugItemToApiItem(sug.category, it));
        const r = await _sendDelete(items);
        showToast('success', '✅ 已清理 ' + r.successCount + ' 个文件，释放 ' + r.freedStr);
        await loadStats();
    } catch (e) { showToast('error', '❌ 清理失败：' + e.message); }
    finally { deleting.value = false; deletingSugId.value = null; }
}

async function deleteOrphanUploads() {
    const items = orphanUploads.value.map(f => ({ type: 'upload', path: f.path, name: f.name }));
    if (!items.length) return;
    deleting.value = true;
    try {
        const r = await _sendDelete(items);
        showToast('success', '✅ 已删除 ' + r.successCount + ' 个临时文件，释放 ' + r.freedStr);
        await loadStats();
    } catch (e) { showToast('error', '❌ 删除失败：' + e.message); }
    finally { deleting.value = false; }
}

async function deleteItem(item) {
    deleting.value = true;
    try {
        const r = await _sendDelete([item]);
        if (r.successCount > 0) { showToast('success', '✅ 已删除，释放 ' + r.freedStr); await loadStats(); }
        else showToast('error', '❌ 删除失败：' + (r.results[0]?.error || '未知错误'));
    } catch (e) { showToast('error', '❌ 删除失败：' + e.message); }
    finally { deleting.value = false; }
}

function confirmDeleteSession(s) {
    deleteConfirm.value = { type: 'session_dir', path: s.path, id: s.id, name: s.name, sizeStr: s.sizeStr };
}
function confirmDeleteProject(p) {
    deleteConfirm.value = { type: 'project_dir', path: p.path, id: p.id, name: p.name, sizeStr: p.sizeStr };
}

async function executeConfirmedDelete() {
    if (!deleteConfirm.value) return;
    const item = deleteConfirm.value; deleting.value = true;
    try {
        const r = await _sendDelete([{ type: item.type, path: item.path, id: item.id }]);
        if (r.successCount > 0) {
            showToast('success', '✅ 已删除「' + (item.name || item.id) + '」，释放 ' + r.freedStr);
            deleteConfirm.value = null; await loadStats();
        } else showToast('error', '❌ 删除失败：' + (r.results[0]?.error || '未知错误'));
    } catch (e) { showToast('error', '❌ 删除失败：' + e.message); }
    finally { deleting.value = false; }
}

function _sugItemToApiItem(category, item) {
    if (category === 'uploads')  return { type: 'upload',      path: item.path, name: item.name };
    if (category === 'sessions') return { type: 'session_dir', path: item.path, id: item.id || item.sessionId };
    if (category === 'projects') return { type: 'project_dir', path: item.path, id: item.id };
    return { type: 'upload', path: item.path };
}

async function _sendDelete(items) {
    const res = await fetch('/api/storage/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
}

function tabCount(id) {
    if (!stats.value) return 0;
    return { sessions: stats.value.sessions.length, projects: stats.value.projects.length, uploads: stats.value.uploads.length }[id] || 0;
}
function barPercent(size, total) { return total ? Math.max(1, Math.round(size / total * 100)) : 0; }
function shortPath(p) { if (!p) return ''; const pts = p.split('/'); return pts.slice(-2).join('/'); }
function catLabel(key) { return { uploads: '上传临时文件', sessions: '会话数据', projects: '工作空间', database: '数据库' }[key] || key; }
function catIcon(key)  { return { uploads: '📤', sessions: '📊', projects: '🗂️', database: '🗃️' }[key] || '📁'; }
function priorityLabel(p) { return { high: '⚠️ 推荐清理', medium: '💡 建议', low: '📋 可选', info: 'ℹ️ 提示' }[p] || p; }

async function runVacuum() {
    vacuuming.value = true;
    try {
        const res  = await fetch('/api/storage/vacuum', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        if (data.freed > 0) {
            showToast('success', `🗜️ VACUUM 完成，释放了 ${data.freedStr}（${data.sizeBeforeStr} → ${data.sizeAfterStr}）`);
        } else {
            showToast('success', `🗜️ VACUUM 完成，数据库已是最优状态（${data.sizeAfterStr}）`);
        }
        await loadStats();
    } catch (e) {
        showToast('error', '❌ VACUUM 失败：' + e.message);
    } finally {
        vacuuming.value = false;
    }
}

let _tt = null;
function showToast(type, message) {
    toast.value = { type, message }; clearTimeout(_tt);
    _tt = setTimeout(() => { toast.value = null; }, 4500);
}
</script>

<style scoped>
/* ── 页面头 ──────────────────────────────────────────────────────── */
.page-header   { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
.page-title    { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
.page-subtitle { font-size: 13px; color: var(--text-muted); max-width: 540px; line-height: 1.5; }

/* ── 加载 / 错误 ─────────────────────────────────────────────────── */
.loading-state { display: flex; align-items: center; gap: 12px; padding: 80px 0; justify-content: center; color: var(--text-muted); }
.error-state   { display: flex; align-items: center; gap: 16px; padding: 20px; }
.error-icon    { font-size: 28px; }
.error-body    { flex: 1; }
.error-title   { font-weight: 600; margin-bottom: 4px; }
.error-msg     { font-size: 12px; color: var(--text-muted); }

/* ── 概览卡片 ─────────────────────────────────────────────────────── */
.summary-row   { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; margin-bottom: 32px; }
.summary-card  { display: flex; align-items: flex-start; gap: 12px; padding: 16px; position: relative; overflow: hidden; transition: border-color .15s; }
.summary-card:hover { border-color: var(--accent); }
.total-card    { border-color: var(--accent); }
.summary-icon  { font-size: 26px; line-height: 1; flex-shrink: 0; }
.summary-body  { flex: 1; min-width: 0; }
.summary-label { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
.summary-value { font-size: 18px; font-weight: 700; color: var(--text-primary); line-height: 1.1; }
.total-value   { font-size: 22px; color: var(--accent); }
.summary-sub   { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
.summary-bar   { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: var(--bg-tertiary); }
.summary-bar-fill { height: 100%; transition: width .4s ease; }
.bar-uploads  { background: #f59e0b; }
.bar-sessions { background: var(--accent); }
.bar-projects { background: var(--success); }
.bar-database { background: #ec4899; }

/* ── 数据库卡片 VACUUM 区域 ──────────────────────────────────────── */
.db-card       { flex-direction: column; align-items: stretch; }
.db-card .summary-icon { align-self: flex-start; }
.vacuum-area   { margin-top: 10px; }
.btn-vacuum    { width: 100%; justify-content: center; background: rgba(236,72,153,.15); color: #f472b6; border: 1px solid rgba(236,72,153,.3); border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; padding: 5px 10px; transition: background .15s, border-color .15s; display: flex; align-items: center; gap: 4px; }
.btn-vacuum:hover:not(:disabled) { background: rgba(236,72,153,.25); border-color: rgba(236,72,153,.5); }
.btn-vacuum:disabled { opacity: .5; cursor: not-allowed; }

/* ── 章节 ────────────────────────────────────────────────────────── */
.section       { margin-bottom: 36px; }
.section-title { font-size: 15px; font-weight: 700; margin-bottom: 14px; }

/* ── 建议卡片 ────────────────────────────────────────────────────── */
.suggestions  { display: flex; flex-direction: column; gap: 12px; }
.sug-card     { padding: 16px 20px; border-left: 3px solid transparent; }
.sug-high     { border-left-color: var(--danger); }
.sug-medium   { border-left-color: var(--warning); }
.sug-low      { border-left-color: var(--info); }
.sug-info     { border-left-color: var(--success); }
.sug-header   { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.sug-left     { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.sug-right    { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.sug-badge    { padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge-high   { background: rgba(239,68,68,.15); color: #f87171; }
.badge-medium { background: rgba(245,158,11,.15); color: #fbbf24; }
.badge-low    { background: rgba(59,130,246,.15); color: #60a5fa; }
.badge-info   { background: rgba(34,197,94,.15);  color: #4ade80; }
.sug-title    { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.sug-saved    { font-size: 12px; color: var(--warning); font-weight: 600; }
.sug-desc     { font-size: 12px; color: var(--text-muted); line-height: 1.6; margin-bottom: 6px; }
.sug-toggle   { font-size: 12px; color: var(--accent); cursor: pointer; user-select: none; display: inline-block; padding: 2px 0; }
.sug-toggle:hover { color: var(--accent-hover); }
.sug-items    { margin-top: 10px; border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
.sug-item     { display: flex; align-items: center; gap: 12px; padding: 7px 12px; border-bottom: 1px solid var(--border-color); font-size: 12px; }
.sug-item:last-child  { border-bottom: none; }
.sug-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; color: var(--text-primary); }
.sug-item-age  { color: var(--text-muted); white-space: nowrap; }
.sug-item-size { color: var(--warning); font-weight: 600; white-space: nowrap; min-width: 60px; text-align: right; }

/* ── Tab ─────────────────────────────────────────────────────────── */
.tabs    { display: flex; gap: 4px; border-bottom: 1px solid var(--border-color); margin-bottom: 0; }
.tab-btn { padding: 8px 16px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted); font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all .15s; margin-bottom: -1px; border-radius: 0; }
.tab-btn:hover  { color: var(--text-primary); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-count { background: var(--bg-tertiary); border-radius: 20px; padding: 1px 7px; font-size: 11px; color: var(--text-muted); }

/* ── 明细面板 ────────────────────────────────────────────────────── */
.detail-panel   { border: 1px solid var(--border-color); border-top: none; border-radius: 0 0 8px 8px; padding: 16px 20px; background: var(--bg-secondary); }
.detail-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.detail-hint    { font-size: 12px; color: var(--text-muted); line-height: 1.5; flex: 1; min-width: 200px; }
.empty-hint     { padding: 40px; text-align: center; color: var(--text-muted); font-size: 13px; }

/* ── 明细表格 ────────────────────────────────────────────────────── */
.detail-table   { width: 100%; border-collapse: collapse; font-size: 13px; }
.detail-table th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-muted); padding: 6px 8px; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
.detail-table td { padding: 8px 8px; border-bottom: 1px solid rgba(45,49,72,.5); vertical-align: middle; }
.detail-table tr:last-child td { border-bottom: none; }
.detail-table tr:hover td { background: rgba(99,102,241,.04); }
.row-orphan td  { background: rgba(239,68,68,.04); }
.cell-mono      { font-family: monospace; font-size: 12px; }
.td-size        { font-weight: 600; white-space: nowrap; }
.text-muted     { color: var(--text-muted); }
.item-name-cell { display: flex; flex-direction: column; gap: 1px; }
.item-name      { font-weight: 500; color: var(--text-primary); }
.item-id        { font-size: 11px; color: var(--text-muted); font-family: monospace; }
.action-row     { display: flex; gap: 6px; align-items: center; }

/* ── 标签 ────────────────────────────────────────────────────────── */
.tag             { padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 500; }
.tag-ok          { background: rgba(34,197,94,.12);  color: #4ade80; }
.tag-danger      { background: rgba(239,68,68,.15);  color: #f87171; }
.tag-ready       { background: rgba(34,197,94,.12);  color: #4ade80; }
.tag-failed      { background: rgba(239,68,68,.15);  color: #f87171; }
.tag-processing  { background: rgba(59,130,246,.15); color: #60a5fa; }

/* ── 按钮 ─────────────────────────────────────────────────────────── */
.btn-xs  { padding: 3px 10px; font-size: 11px; border-radius: 4px; }
.btn-sm  { padding: 5px 12px; font-size: 12px; }

/* ── 删除确认弹窗 ────────────────────────────────────────────────── */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 24px; }
.modal         { width: 100%; max-width: 480px; padding: 0; }
.modal-header  { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-color); }
.modal-title   { font-size: 15px; font-weight: 600; }
.modal-body    { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.modal-footer  { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border-color); background: var(--bg-tertiary); }
.btn-icon      { background: none; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; padding: 4px; line-height: 1; }
.btn-icon:hover { color: var(--text-primary); }
.confirm-target { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 6px; }
.confirm-icon  { font-size: 20px; }
.confirm-name  { flex: 1; font-weight: 600; }
.confirm-size  { color: var(--warning); font-size: 12px; }
.confirm-warn  { font-size: 12px; color: var(--text-muted); padding: 8px 12px; background: rgba(239,68,68,.07); border-radius: 6px; line-height: 1.5; }

/* ── Toast ───────────────────────────────────────────────────────── */
.toast         { position: fixed; bottom: 24px; right: 24px; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; z-index: 2000; max-width: 380px; animation: slideUp .2s ease; }
.toast-success { background: rgba(34,197,94,.15); border: 1px solid rgba(34,197,94,.3); color: #4ade80; }
.toast-error   { background: rgba(239,68,68,.15);  border: 1px solid rgba(239,68,68,.3); color: #f87171; }
.toast-close   { background: none; border: none; color: inherit; font-size: 14px; cursor: pointer; padding: 0; line-height: 1; opacity: .7; }
.toast-close:hover { opacity: 1; }

@keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

/* ── spinner-sm (复用全局 spinner 变体) ───────────────────────────── */
.spinner-sm { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 4px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
