<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">I3 · 混淆检测</h2>
      <span class="section-badge">{{ obfHints.length }} 个特征</span>
      <span v-if="obfIsObfuscated" class="section-badge obf-warn">⚠️ 疑似混淆</span>
      <span v-else-if="obfHints.length === 0 && !obfLoading" class="section-badge obf-ok">✅ 未检测到混淆</span>
    </div>

    <div v-if="obfLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="obfHints.length === 0" class="empty-state"><p>暂无混淆检测数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <div v-if="obfAvgConf > 0" class="crypto-confidence" style="max-width:400px;margin-bottom:16px">
        <span class="filter-label" style="margin-right:8px">平均置信度：</span>
        <div class="conf-bar-bg" style="flex:1">
          <div class="conf-bar-fill" :style="{ width: obfAvgConf + '%', background: obfAvgConf > 70 ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#f59e0b,#fcd34d)' }"></div>
        </div>
        <span class="conf-text">{{ obfAvgConf }}%</span>
      </div>
      <div class="crypto-cards">
        <div v-for="h in obfHints" :key="h.id" class="crypto-card">
          <div class="crypto-algo" style="font-size:14px;margin-bottom:8px">
            <span class="crypto-badge">{{ h.hint_type }}</span>
          </div>
          <div class="crypto-confidence">
            <div class="conf-bar-bg">
              <div class="conf-bar-fill"
                :style="{ width: (h.confidence * 100) + '%', background: h.confidence > 0.7 ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#f59e0b,#fcd34d)' }">
              </div>
            </div>
            <span class="conf-text">{{ (h.confidence * 100).toFixed(0) }}%</span>
          </div>
          <div class="sig-summary" style="margin-top:10px">{{ h.description }}</div>
          <div class="crypto-meta">
            <span v-if="h.line">line {{ h.line }}</span>
            <span v-if="h.iid"> · iid={{ h.iid }}</span>
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

const obfHints        = ref([]);
const obfLoading      = ref(false);
const obfIsObfuscated = ref(false);
const obfAvgConf      = ref(0);

async function loadObfuscation() {
    obfLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/obfuscation`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        obfHints.value = data.hints || [];
        obfIsObfuscated.value = data.isObfuscated || false;
        obfAvgConf.value = data.avgConfidence || 0;
    } catch (e) {
        console.error('loadObfuscation error:', e);
    } finally {
        obfLoading.value = false;
    }
}

defineExpose({ reload: loadObfuscation });

onMounted(loadObfuscation);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.obf-warn { background: rgba(239,68,68,0.2); color: #fca5a5; }
.obf-ok   { background: rgba(34,197,94,0.2); color: #86efac; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.crypto-cards { display: flex; flex-wrap: wrap; gap: 16px; }
.crypto-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 16px 20px; min-width: 200px; flex: 1;
}
.crypto-algo { font-size: 22px; font-weight: 800; color: #a5b4fc; margin-bottom: 10px; font-family: monospace; }
.crypto-confidence { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.conf-bar-bg { flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
.conf-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.conf-text { font-size: 12px; color: var(--text-muted); min-width: 34px; text-align: right; }
.crypto-meta { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
.sig-summary { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; line-height: 1.5; }
</style>
