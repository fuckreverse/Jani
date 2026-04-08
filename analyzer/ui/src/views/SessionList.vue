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
      <div class="header-btns">
        <button class="btn-secondary" @click="showImportDialog = true">📥 从已有 Trace 导入</button>
        <button class="btn-primary"   @click="showUploadDialog = true">+ 新建会话</button>
      </div>
    </div>

    <!-- 上传对话框 -->
    <UploadDialog
      v-if="showUploadDialog"
      @close="showUploadDialog = false"
      @created="onSessionCreated"
    />

    <!-- 从已有 Trace 导入对话框 -->
    <ImportFromTraceDialog
      v-if="showImportDialog"
      @close="showImportDialog = false"
      @imported="onSessionCreated"
    />

    <!-- 删除确认弹窗 -->
    <DeleteConfirmDialog
      v-if="deleteTarget"
      :session="deleteTarget"
      @cancel="deleteTarget = null"
      @deleted="onSessionDeleted"
    />

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
      <SessionCard
        v-for="session in sessions"
        :key="session.id"
        :session="session"
        @delete="deleteTarget = $event"
        @open-progress="openProgress"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

import ProgressDrawer         from './ProgressDrawer.vue';
import UploadDialog           from '../components/session/UploadDialog.vue';
import ImportFromTraceDialog  from '../components/session/ImportFromTraceDialog.vue';
import DeleteConfirmDialog    from '../components/session/DeleteConfirmDialog.vue';
import SessionCard            from '../components/session/SessionCard.vue';

const router = useRouter();

// ─── 会话列表状态 ─────────────────────────────────────────────────────────────
const sessions = ref([]);
const loading  = ref(true);

// ─── 对话框显示状态 ───────────────────────────────────────────────────────────
const showUploadDialog = ref(false);
const showImportDialog = ref(false);
const deleteTarget     = ref(null);

// ─── 进度抽屉状态 ─────────────────────────────────────────────────────────────
const showProgressDrawer  = ref(false);
const progressSessionId   = ref(null);
const progressSessionName = ref('');

// ─── 数据加载 ─────────────────────────────────────────────────────────────────
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

// ─── 事件处理 ─────────────────────────────────────────────────────────────────

/** 新建 / 导入成功后的回调 */
function onSessionCreated({ sessionId, name }) {
    showUploadDialog.value = false;
    showImportDialog.value = false;
    loadSessions();

    progressSessionId.value   = sessionId;
    progressSessionName.value = name || sessionId?.slice(0, 8) || '';
    showProgressDrawer.value  = true;
}

/** 删除成功后的回调 */
function onSessionDeleted(sessionId) {
    sessions.value = sessions.value.filter(s => s.id !== sessionId);
    deleteTarget.value = null;
}

/** 导航到会话详情 */
function goToSession() {
    if (progressSessionId.value) {
        showProgressDrawer.value = false;
        router.push(`/sessions/${progressSessionId.value}`);
    }
}

/** 打开进度抽屉（从卡片触发）*/
function openProgress(session) {
    progressSessionId.value   = session.id;
    progressSessionName.value = session.name || session.id.slice(0, 8);
    showProgressDrawer.value  = true;
}

// ─── 生命周期 ─────────────────────────────────────────────────────────────────
let refreshTimer = null;

onMounted(() => {
    loadSessions();
    refreshTimer = setInterval(loadSessions, 5000);
});

onUnmounted(() => {
    if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.page-header {
    display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px;
}
.header-btns { display: flex; gap: 10px; }
.page-title { font-size: 22px; font-weight: 700; color: var(--text-primary); }
.page-subtitle { margin-top: 4px; color: var(--text-muted); font-size: 13px; }

/* 会话网格 */
.sessions-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;
}

.empty-icon { font-size: 36px; margin-bottom: 12px; }
.empty-hint { font-size: 12px; margin-top: 4px; }
</style>
