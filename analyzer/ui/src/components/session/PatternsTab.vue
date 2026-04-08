<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A8 · 值模式 / 魔术常数</h2>
      <span class="section-badge">{{ valuePatterns.length }} 条</span>
    </div>

    <div v-if="patternsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="valuePatterns.length === 0" class="empty-state"><p>暂无值模式数据（请先运行 A8 · ValuePatternDetector）</p></div>
    <div v-else>
      <div class="filter-bar">
        <label class="filter-label">
          <input type="checkbox" v-model="onlyCryptoPatterns" @change="loadValuePatterns" />
          仅显示密码学常数
        </label>
      </div>
      <div class="events-table-wrapper" style="margin-top:12px">
        <table class="events-table">
          <thead>
            <tr>
              <th>值指纹 (前64字符)</th><th>出现次数</th><th>首次 SEQ</th><th>iid</th><th>变量名</th><th>行号</th><th>匹配常数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in valuePatterns" :key="p.id" :class="p.matched_constant ? 'row-crypto' : ''">
              <td><code class="src-text" style="max-width:250px">{{ p.value_hash }}</code></td>
              <td class="td-seq">{{ p.count }}</td>
              <td class="td-seq">{{ p.first_seq }}</td>
              <td class="td-seq">{{ p.iid ?? '—' }}</td>
              <td><span v-if="p.var_name" class="var-chip var-write">{{ p.var_name }}</span></td>
              <td class="td-seq">{{ p.line ?? '—' }}</td>
              <td>
                <span v-if="p.matched_constant" class="crypto-badge">{{ p.matched_constant }}</span>
                <span v-else class="text-muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const valuePatterns      = ref([]);
const patternsLoading    = ref(false);
const onlyCryptoPatterns = ref(false);

async function loadValuePatterns() {
    patternsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (onlyCryptoPatterns.value) params.set('onlyCrypto', '1');
        const res = await fetch(`/api/sessions/${props.sessionId}/value-patterns?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        valuePatterns.value = data.patterns || [];
    } catch (e) {
        console.error('loadValuePatterns error:', e);
    } finally {
        patternsLoading.value = false;
    }
}

defineExpose({ reload: loadValuePatterns });

onMounted(loadValuePatterns);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
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
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 300px; display: block; overflow: hidden; text-overflow: ellipsis; }
.text-muted { color: var(--text-muted); }
.row-crypto td { background: rgba(245,158,11,0.06) !important; }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
</style>
