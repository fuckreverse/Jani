<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">I2 · 签名 / Token 路径</h2>
      <span class="section-badge">{{ sigPaths.length }} 条路径</span>
    </div>

    <div v-if="sigLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="sigPaths.length === 0" class="empty-state"><p>暂无签名路径数据（请先运行 I2 · SignatureAnalyzer）</p></div>
    <div v-else>
      <div class="sig-list">
        <div v-for="path in sigPaths" :key="path.id" class="sig-item">
          <div class="sig-header">
            <span class="sig-field">{{ path.field_name }}</span>
            <span class="sig-hops">{{ path.hops }} 跳</span>
            <span class="text-muted" style="font-size:11px">SEQ {{ path.sink_event_id }}</span>
          </div>
          <div class="sig-summary">{{ path.summary }}</div>
          <div v-if="path.input_vars?.length" class="sig-vars">
            <span class="filter-label">输入变量：</span>
            <span v-for="v in path.input_vars" :key="v" class="var-chip var-read">{{ v }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const sigPaths   = ref([]);
const sigLoading = ref(false);

async function loadSigPaths() {
    sigLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/signature-paths`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sigPaths.value = data.paths || [];
    } catch (e) {
        console.error('loadSigPaths error:', e);
    } finally {
        sigLoading.value = false;
    }
}

defineExpose({ reload: loadSigPaths });

onMounted(loadSigPaths);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.sig-list { display: flex; flex-direction: column; gap: 12px; }
.sig-item {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 12px 16px;
}
.sig-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.sig-field { font-family: monospace; font-weight: 700; color: #86efac; font-size: 14px; }
.sig-hops {
    font-size: 11px; padding: 2px 6px; border-radius: 10px;
    background: rgba(34,197,94,0.15); color: #86efac;
}
.sig-summary { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; line-height: 1.5; }
.sig-vars { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; }
.var-read { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.text-muted { color: var(--text-muted); }
</style>
