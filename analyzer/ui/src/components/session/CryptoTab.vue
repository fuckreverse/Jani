<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">I1 · 加密算法检测</h2>
      <span class="section-badge">{{ cryptoHints.length }} 个特征</span>
    </div>

    <div v-if="cryptoLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="cryptoHints.length === 0" class="empty-state"><p>暂无加密检测数据（请先运行 I1 · CryptoDetector）</p></div>
    <div v-else>
      <div class="crypto-cards">
        <div v-for="hint in cryptoHints" :key="hint.id" class="crypto-card">
          <div class="crypto-algo">{{ hint.algorithm }}</div>
          <div class="crypto-confidence">
            <div class="conf-bar-bg">
              <div class="conf-bar-fill" :style="{ width: (hint.confidence * 100) + '%' }"></div>
            </div>
            <span class="conf-text">{{ (hint.confidence * 100).toFixed(0) }}%</span>
          </div>
          <div class="crypto-meta">
            <span v-if="hint.line">line {{ hint.line }}</span>
            <span v-if="hint.iid">  iid={{ hint.iid }}</span>
            <span v-if="hint.fn_name"> · {{ hint.fn_name }}</span>
          </div>
          <div v-if="hint.evidence?.length" class="crypto-evidence">
            <div v-for="(ev, i) in hint.evidence.slice(0, 4)" :key="i" class="evidence-item">
              <span class="crypto-badge">{{ ev.constant }}</span>
              <span v-if="ev.line" class="text-muted" style="font-size:11px"> line {{ ev.line }}</span>
            </div>
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

const cryptoHints   = ref([]);
const cryptoLoading = ref(false);

async function loadCryptoHints() {
    cryptoLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/crypto-hints`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cryptoHints.value = data.hints || [];
    } catch (e) {
        console.error('loadCryptoHints error:', e);
    } finally {
        cryptoLoading.value = false;
    }
}

defineExpose({ reload: loadCryptoHints });

onMounted(loadCryptoHints);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.crypto-cards { display: flex; flex-wrap: wrap; gap: 16px; }
.crypto-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 16px 20px; min-width: 200px; flex: 1;
}
.crypto-algo { font-size: 22px; font-weight: 800; color: #a5b4fc; margin-bottom: 10px; font-family: monospace; }
.crypto-confidence { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.conf-bar-bg { flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
.conf-bar-fill {
    height: 100%; background: linear-gradient(90deg, #6366f1, #818cf8);
    border-radius: 3px; transition: width 0.3s;
}
.conf-text { font-size: 12px; color: var(--text-muted); min-width: 34px; text-align: right; }
.crypto-meta { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }
.crypto-evidence { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.evidence-item { display: flex; align-items: center; gap: 4px; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
.text-muted { color: var(--text-muted); }
</style>
