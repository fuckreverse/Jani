<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A6 · 函数签名推断</h2>
      <span class="section-badge">
        {{ fnSigSummary ? fnSigSummary.total : fnSignatures.length }} 个函数，
        {{ fnSigSummary ? fnSigSummary.pure_count : 0 }} 个纯函数
      </span>
    </div>

    <div v-if="fnSigLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="fnSignatures.length === 0" class="empty-state"><p>暂无函数签名数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <div class="filter-bar" style="margin-bottom:12px">
        <label class="filter-label">
          <input type="checkbox" v-model="onlyPureFns" @change="loadFnSignatures" />
          仅显示纯函数
        </label>
      </div>
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr><th>函数名</th><th>调用次数</th><th>纯函数</th><th>参数类型</th><th>返回类型</th><th>iid</th></tr>
          </thead>
          <tbody>
            <tr v-for="f in fnSignatures" :key="f.id">
              <td>
                <code class="src-text">{{ f.fn_name || '(anonymous)' }}</code>
                <span v-if="f.is_pure" class="crypto-badge" style="margin-left:6px">pure</span>
              </td>
              <td class="td-seq">{{ f.call_count }}</td>
              <td class="td-seq">{{ f.is_pure ? '✅' : '—' }}</td>
              <td>
                <span v-if="Array.isArray(f.arg_types) && f.arg_types.length > 0" class="text-muted" style="font-size:11px">
                  {{ f.arg_types.map((t, i) => `arg${i}: ${Object.keys(t||{}).join('/')}`).join(', ') }}
                </span>
                <span v-else class="text-muted">—</span>
              </td>
              <td>
                <span v-if="f.return_types && Object.keys(f.return_types).length" class="var-chip var-read">
                  {{ Object.keys(f.return_types).join('/') }}
                </span>
                <span v-else class="text-muted">—</span>
              </td>
              <td class="td-seq">{{ f.fn_iid ?? '—' }}</td>
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

const fnSignatures = ref([]);
const fnSigSummary = ref(null);
const fnSigLoading = ref(false);
const onlyPureFns  = ref(false);

async function loadFnSignatures() {
    fnSigLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '200' });
        if (onlyPureFns.value) params.set('onlyPure', '1');
        const res = await fetch(`/api/sessions/${props.sessionId}/fn-signatures?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnSignatures.value = data.signatures || [];
        fnSigSummary.value = data.summary || null;
    } catch (e) {
        console.error('loadFnSignatures error:', e);
    } finally {
        fnSigLoading.value = false;
    }
}

defineExpose({ reload: loadFnSignatures });

onMounted(loadFnSignatures);
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
.src-text { color: var(--text-primary); white-space: nowrap; max-width: 300px; display: block; overflow: hidden; text-overflow: ellipsis; }
.text-muted { color: var(--text-muted); }
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; }
.var-read { background: rgba(99,102,241,0.15); color: #a5b4fc; }
</style>
