<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A5 · 循环迭代展开</h2>
      <span class="section-badge">{{ loopIterData.loops.length }} 个循环</span>
    </div>

    <div v-if="loopIterLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="loopIterData.loops.length === 0" class="empty-state"><p>暂无循环数据（请先运行 A5 · LoopDetector）</p></div>
    <div v-else>
      <!-- 循环选择器 -->
      <div class="filter-bar">
        <label class="filter-label">选择循环：</label>
        <select v-model="selectedLoopId" @change="loadLoopIterations" class="select-input">
          <option :value="null">— 全部 —</option>
          <option v-for="loop in loopIterData.loops" :key="loop.id" :value="loop.id">
            Loop #{{ loop.id }} (iid={{ loop.iid }}, line={{ loop.line }}, {{ loop.iteration_count }} 次)
          </option>
        </select>
      </div>

      <!-- 迭代表格 -->
      <div class="events-table-wrapper" style="margin-top:12px">
        <table class="events-table">
          <thead>
            <tr>
              <th>Loop</th><th>迭代</th><th>起始 SEQ</th><th>结束 SEQ</th><th>变量快照</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="iter in loopIterData.iterations" :key="iter.id">
              <td class="td-seq">{{ iter.loop_id }}</td>
              <td class="td-seq">#{{ iter.iteration_idx }}</td>
              <td class="td-seq">{{ iter.start_seq }}</td>
              <td class="td-seq">{{ iter.end_seq }}</td>
              <td>
                <div class="snapshot-chips">
                  <span
                    v-for="(val, key) in iter.vars_snapshot"
                    :key="key"
                    class="var-chip var-write"
                    :title="`${key} = ${val}`"
                  >{{ key }}</span>
                </div>
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

const loopIterData    = ref({ loops: [], iterations: [] });
const loopIterLoading = ref(false);
const selectedLoopId  = ref(null);

async function loadLoopIterations() {
    loopIterLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (selectedLoopId.value != null) params.set('loopId', selectedLoopId.value);
        const res = await fetch(`/api/sessions/${props.sessionId}/loop-iterations?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        loopIterData.value = {
            loops: data.loops || [],
            iterations: data.iterations || [],
        };
    } catch (e) {
        console.error('loadLoopIterations error:', e);
    } finally {
        loopIterLoading.value = false;
    }
}

defineExpose({ reload: loadLoopIterations });

onMounted(loadLoopIterations);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.select-input {
    padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color);
    background: var(--bg-secondary); color: var(--text-primary); font-size: 12px;
}
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
.snapshot-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
</style>
