<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">I4 · 算法汇总报告</h2>
      <button class="btn-secondary" style="font-size:11px;padding:4px 10px" @click="loadSummary">🔄 刷新</button>
    </div>

    <div v-if="summaryLoading" class="loading"><div class="spinner"></div><span>生成中...</span></div>
    <div v-else-if="!summaryReport" class="empty-state"><p>暂无报告（请先运行 Phase 4，执行 I4 · AlgorithmSummarizer）</p></div>
    <div v-else>
      <!-- 概览卡片 -->
      <div class="crypto-cards" style="margin-bottom:20px">
        <div class="crypto-card" style="min-width:150px;flex:0 0 auto">
          <div class="detail-label">总事件数</div>
          <div class="crypto-algo" style="font-size:28px">{{ (summaryReport.overview?.eventCount || 0).toLocaleString('zh-CN') }}</div>
        </div>
        <div class="crypto-card" style="min-width:150px;flex:0 0 auto">
          <div class="detail-label">唯一函数</div>
          <div class="crypto-algo" style="font-size:28px">{{ summaryReport.callGraph?.uniqueFunctions || 0 }}</div>
        </div>
        <div class="crypto-card" style="min-width:150px;flex:0 0 auto">
          <div class="detail-label">数据流边</div>
          <div class="crypto-algo" style="font-size:28px">{{ summaryReport.dataFlow?.totalEdges || 0 }}</div>
        </div>
        <div v-if="summaryReport.overview?.isObfuscated" class="crypto-card obf-card" style="min-width:150px;flex:0 0 auto">
          <div class="detail-label">混淆评分</div>
          <div class="crypto-algo" style="font-size:28px;color:#fca5a5">{{ summaryReport.overview?.obfuscationScore }}%</div>
        </div>
      </div>

      <!-- 算法标签 -->
      <div v-if="summaryReport.overview?.algorithmTags?.length" style="margin-bottom:16px">
        <div class="detail-label">识别标签</div>
        <span v-for="tag in summaryReport.overview.algorithmTags" :key="tag" class="crypto-badge" style="margin-right:6px">{{ tag }}</span>
      </div>

      <!-- Markdown 报告 -->
      <div v-if="summaryMd" class="sig-item summary-md">{{ summaryMd }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const summaryReport  = ref(null);
const summaryMd      = ref('');
const summaryLoading = ref(false);

async function loadSummary() {
    summaryLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/summary`);
        if (!res.ok) {
            if (res.status === 404) {
                summaryReport.value = null;
                summaryMd.value = '';
                return;
            }
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        summaryReport.value = data.report || null;
        summaryMd.value = data.markdown || '';
    } catch (e) {
        console.error('loadSummary error:', e);
    } finally {
        summaryLoading.value = false;
    }
}

defineExpose({ reload: loadSummary });

onMounted(loadSummary);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.crypto-cards { display: flex; flex-wrap: wrap; gap: 16px; }
.crypto-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 16px 20px;
}
.obf-card { border-color: rgba(239,68,68,0.4); }
.crypto-algo { font-size: 22px; font-weight: 800; color: #a5b4fc; margin-bottom: 10px; font-family: monospace; }
.detail-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
.sig-item {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 12px 16px;
}
.summary-md {
    font-family: monospace; font-size: 12px; white-space: pre-wrap;
    max-height: 600px; overflow-y: auto; line-height: 1.6;
}
</style>
