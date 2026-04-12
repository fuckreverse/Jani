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
          <!-- 类型标签行 -->
          <div class="crypto-algo" style="font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="crypto-badge" :class="hintBadgeClass(h.hint_type)">
              {{ hintIcon(h.hint_type) }} {{ h.hint_type }}
            </span>
            <!-- 支持跳转函数面板的类型：string_decoder / dynamic_eval / deep_call_stack -->
            <button
              v-if="canGotoFunction(h)"
              class="btn-goto-fn"
              :title="`在「函数」面板中查看 ${h.fn_name}`"
              @click.stop="gotoFunction(h)"
            >🔍 查看函数</button>
          </div>

          <!-- 置信度条 -->
          <div class="crypto-confidence">
            <div class="conf-bar-bg">
              <div class="conf-bar-fill"
                :style="{ width: (h.confidence * 100) + '%', background: h.confidence > 0.7 ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#f59e0b,#fcd34d)' }">
              </div>
            </div>
            <span class="conf-text">{{ (h.confidence * 100).toFixed(0) }}%</span>
          </div>

          <!-- 描述 -->
          <div class="sig-summary" style="margin-top:10px">{{ h.description }}</div>

          <!-- 位置信息 -->
          <div class="crypto-meta">
            <span v-if="h.line">line {{ h.line }}</span>
            <span v-if="h.iid"> · iid={{ h.iid }}</span>
          </div>

          <!-- 控制流混淆免责提示 -->
          <div v-if="h.hint_type === 'obfuscated_control_flow'" class="obf-disclaimer">
            ⚠️ <strong>注意：</strong>控制流平坦化（CFF）与虚拟机保护（VMP）在运行时数据层面特征高度重叠，
            当前工具<strong>无法可靠区分</strong>二者。上述描述仅为倾向性提示，
            请结合源代码结构（是否存在字节码数组、dispatch 循环等）人工确认。
          </div>

          <!-- 深调用栈免责提示 -->
          <div v-if="h.hint_type === 'deep_call_stack'" class="obf-disclaimer">
            ℹ️ <strong>提示：</strong>深调用栈也可能源于正常的深度递归算法。
            建议配合控制流混淆检测结果交叉印证，并查看「函数」面板中最深帧的逻辑。
          </div>

          <!-- 动态 eval 提示 -->
          <div v-if="h.hint_type === 'dynamic_eval'" class="obf-disclaimer obf-disclaimer--info">
            ℹ️ <strong>提示：</strong>eval/Function 也可能出现在正常代码中（如模板引擎、动态导入）。
            若同时存在字符串解码器或字符串池特征，则混淆可能性更高。
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

const emit = defineEmits(['goto-function']);

const obfHints        = ref([]);
const obfLoading      = ref(false);
const obfIsObfuscated = ref(false);
const obfAvgConf      = ref(0);

// hint 类型 → 图标
function hintIcon(type) {
    const icons = {
        short_var:               '🔤',
        high_entropy_name:       '🎲',
        string_decoder:          '🔓',
        obfuscated_control_flow: '🔀',
        deep_call_stack:         '📚',
        string_pool:             '🗃️',
        dynamic_eval:            '⚡',
        var_reuse:               '♻️',
        // 兼容旧数据中可能存在的 flat_control_flow 类型
        flat_control_flow:       '🔀',
    };
    return icons[type] || '❓';
}

// hint 类型 → badge 样式类
function hintBadgeClass(type) {
    if (type === 'string_decoder' || type === 'string_pool') return 'badge-decoder';
    if (type === 'obfuscated_control_flow' || type === 'flat_control_flow' || type === 'deep_call_stack') return 'badge-cff';
    if (type === 'dynamic_eval') return 'badge-eval';
    if (type === 'var_reuse') return 'badge-reuse';
    return '';
}

// 是否显示「查看函数」按钮
function canGotoFunction(h) {
    return h.fn_name && (
        h.hint_type === 'string_decoder' ||
        h.hint_type === 'dynamic_eval' ||
        h.hint_type === 'deep_call_stack'
    );
}

// 点击"查看函数"按钮：向父组件发 goto-function 事件
function gotoFunction(h) {
    emit('goto-function', {
        fnName: h.fn_name,
        fnIid:  h.iid ?? null,  // iid 字段存的就是 fn_iid
        callSeq: null,
    });
}

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
/* string_decoder / string_pool：蓝紫色 */
.badge-decoder {
    background: rgba(99,102,241,0.2); color: #a5b4fc;
}
/* 控制流混淆 / 深调用栈：橙红色 */
.badge-cff {
    background: rgba(239,68,68,0.15); color: #fca5a5;
}
/* 动态 eval：青色 */
.badge-eval {
    background: rgba(6,182,212,0.15); color: #67e8f9;
}
/* 变量重用：绿色 */
.badge-reuse {
    background: rgba(34,197,94,0.12); color: #86efac;
}
.sig-summary { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; line-height: 1.5; }

/* 跳转函数按钮 */
.btn-goto-fn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: 5px; font-size: 11px; font-weight: 600;
    border: 1px solid rgba(99,102,241,0.4); background: rgba(99,102,241,0.12);
    color: #a5b4fc; cursor: pointer; transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
}
.btn-goto-fn:hover {
    background: rgba(99,102,241,0.25); border-color: rgba(99,102,241,0.65);
    color: #c7d2fe;
}

/* 免责声明 / 提示框 */
.obf-disclaimer {
    margin-top: 10px; padding: 8px 12px;
    background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25);
    border-radius: 6px; font-size: 11px; color: #fcd34d; line-height: 1.6;
}
.obf-disclaimer strong { color: #fbbf24; }
.obf-disclaimer--info {
    background: rgba(6,182,212,0.07); border-color: rgba(6,182,212,0.25);
    color: #67e8f9;
}
.obf-disclaimer--info strong { color: #22d3ee; }
</style>
