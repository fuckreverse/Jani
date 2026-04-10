<template>
  <div class="card">
    <div class="section-header">
      <h2 class="section-title">A4 · 字符串追踪</h2>
      <span class="section-badge">{{ total }} 条</span>
    </div>

    <div v-if="stringsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
    <div v-else-if="total === 0 && stringEvents.length === 0" class="empty-state"><p>暂无字符串追踪数据（请先运行 Phase 4）</p></div>
    <div v-else>
      <!-- 编码分布过滤栏 -->
      <div class="filter-bar" style="margin-bottom:12px">
        <span class="filter-label">编码过滤：</span>
        <span
          v-for="s in stringEncStats" :key="s.encoding_hint"
          class="var-chip"
          :class="strEncodingFilter === s.encoding_hint ? 'var-write' : 'var-read'"
          style="cursor:pointer; margin-right:6px"
          @click="onEncodingFilterClick(s.encoding_hint)"
        >{{ s.encoding_hint || 'plain' }}: {{ s.cnt }}</span>
      </div>

      <!-- 错误提示 -->
      <div v-if="actionError" class="action-error">{{ actionError }}</div>

      <!-- 表格 -->
      <div class="events-table-wrapper">
        <table class="events-table">
          <thead>
            <tr>
              <th>编码</th>
              <th>变量名</th>
              <th>值（前80字符）</th>
              <th>行号</th>
              <th>iid</th>
              <th>event SEQ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in stringEvents"
              :key="s.id"
              :class="s.encoding_hint && s.encoding_hint !== 'plain' ? 'row-crypto' : ''"
            >
              <!-- 编码类型 -->
              <td>
                <span v-if="s.encoding_hint && s.encoding_hint !== 'plain'" class="crypto-badge">{{ s.encoding_hint }}</span>
                <span v-else class="text-muted">plain</span>
              </td>

              <!-- 变量名 -->
              <td>
                <span v-if="s.var_name" class="var-chip var-write">{{ s.var_name }}</span>
                <span v-else class="text-muted">—</span>
              </td>

              <!-- 值 + 解码展示区 -->
              <td class="td-value-cell">
                <code class="src-text">{{ truncate(s.value, 80) }}</code>
                <!-- url / hex 类型：按需解码按钮 -->
                <template v-if="isDecodable(s.encoding_hint)">
                  <button
                    v-if="!decodedMap[s.id]"
                    class="btn-decode"
                    :disabled="decodingSet.has(s.id)"
                    @click="decodeValue(s)"
                  >
                    <span v-if="decodingSet.has(s.id)">…</span>
                    <span v-else>🔓 解码</span>
                  </button>
                  <div v-else class="decoded-block">
                    <span class="decoded-label">解码后：</span>
                    <code class="decoded-value">{{ truncate(decodedMap[s.id], 200) }}</code>
                    <button class="btn-decode btn-decode-close" @click="delete decodedMap[s.id]">✕</button>
                  </div>
                </template>
              </td>

              <!-- 行号 -->
              <td class="td-seq">{{ s.line ?? '—' }}</td>

              <!-- iid -->
              <td class="td-seq">{{ s.iid ?? '—' }}</td>

              <!-- event SEQ -->
              <td class="td-seq">{{ s.event_id ?? '—' }}</td>

              <!-- 操作列：跳转事件流 + 跳转函数 -->
              <td class="td-actions">
                <button
                  v-if="s.event_id != null"
                  class="btn-goto"
                  title="跳转到事件流"
                  @click="gotoEvent(s)"
                >📋</button>
                <button
                  v-if="s.event_id != null"
                  class="btn-goto"
                  :class="{ 'btn-goto-loading': gotoFnLoadingSet.has(s.id) }"
                  :disabled="gotoFnLoadingSet.has(s.id)"
                  title="跳转到函数面板"
                  @click="gotoFn(s)"
                >📌</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div v-if="total > PAGE_SIZE" class="pagination">
        <button class="btn-secondary" :disabled="currentPage <= 1" @click="prevPage">← 上一页</button>
        <span class="page-info">第 {{ currentPage }} / {{ totalPages }} 页（共 {{ total }} 条）</span>
        <button class="btn-secondary" :disabled="!hasMore" @click="nextPage">下一页 →</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive } from 'vue';
import { truncate } from '../../composables/useSessionUtils.js';

const props = defineProps({
    sessionId: { type: String, required: true },
});

const emit = defineEmits(['goto-event', 'goto-function']);

// ─── 状态 ──────────────────────────────────────────────────────────────────────
const PAGE_SIZE         = 100;
const stringEvents      = ref([]);
const stringEncStats    = ref([]);
const stringsLoading    = ref(false);
const strEncodingFilter = ref('');
const currentPage       = ref(1);
const total             = ref(0);
const hasMore           = ref(false);

// 解码状态
const decodedMap   = reactive({});  // id → decoded string
const decodingSet  = ref(new Set());

// 跳转状态
const gotoFnLoadingSet = ref(new Set());
const actionError      = ref('');

// ─── 计算属性 ──────────────────────────────────────────────────────────────────
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

// ─── 数据加载 ─────────────────────────────────────────────────────────────────
async function loadStrings(reset = false) {
    if (reset) currentPage.value = 1;
    stringsLoading.value = true;
    try {
        const params = new URLSearchParams({
            limit:  PAGE_SIZE,
            offset: (currentPage.value - 1) * PAGE_SIZE,
        });
        if (strEncodingFilter.value) params.set('encoding', strEncodingFilter.value);
        const res = await fetch(`/api/sessions/${props.sessionId}/strings?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        stringEvents.value   = data.strings || [];
        stringEncStats.value = data.encodingStats || [];
        total.value          = data.total ?? stringEvents.value.length;
        hasMore.value        = data.hasMore ?? false;
        // 换页时清除解码缓存
        if (reset) Object.keys(decodedMap).forEach(k => delete decodedMap[k]);
    } catch (e) {
        console.error('loadStrings error:', e);
    } finally {
        stringsLoading.value = false;
    }
}

function onEncodingFilterClick(hint) {
    strEncodingFilter.value = strEncodingFilter.value === hint ? '' : hint;
    loadStrings(true);
}

function prevPage() {
    if (currentPage.value > 1) { currentPage.value--; loadStrings(); }
}

function nextPage() {
    if (hasMore.value) { currentPage.value++; loadStrings(); }
}

// ─── 按需解码（url / hex）──────────────────────────────────────────────────────
function isDecodable(hint) {
    return hint === 'url' || hint === 'hex';
}

function decodeValue(s) {
    if (decodedMap[s.id]) return;
    const set = new Set(decodingSet.value);
    set.add(s.id);
    decodingSet.value = set;
    try {
        let decoded = '';
        if (s.encoding_hint === 'url') {
            try { decoded = decodeURIComponent(s.value); }
            catch { decoded = unescape(s.value); }
        } else if (s.encoding_hint === 'hex') {
            // hex → UTF-8 string
            const hexStr = s.value.replace(/\s+/g, '');
            const bytes = [];
            for (let i = 0; i + 1 < hexStr.length; i += 2) {
                bytes.push(parseInt(hexStr.slice(i, i + 2), 16));
            }
            try {
                decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
            } catch {
                decoded = bytes.map(b => String.fromCharCode(b)).join('');
            }
        }
        decodedMap[s.id] = decoded || '(空)';
    } catch (e) {
        decodedMap[s.id] = `解码失败: ${e.message}`;
    } finally {
        const set2 = new Set(decodingSet.value);
        set2.delete(s.id);
        decodingSet.value = set2;
    }
}

// ─── 跳转到事件流 ─────────────────────────────────────────────────────────────
function gotoEvent(s) {
    emit('goto-event', { eventId: s.event_id });
}

// ─── 跳转到函数面板 ───────────────────────────────────────────────────────────
async function gotoFn(s) {
    if (gotoFnLoadingSet.value.has(s.id)) return;
    actionError.value = '';
    const set = new Set(gotoFnLoadingSet.value);
    set.add(s.id);
    gotoFnLoadingSet.value = set;
    try {
        const res = await fetch(`/api/sessions/${props.sessionId}/events/${s.event_id}/owner-fn`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.ownerFn) {
            actionError.value = `SEQ ${s.event_id} 不在任何函数调用内（顶层代码）`;
            setTimeout(() => { actionError.value = ''; }, 3000);
            return;
        }
        emit('goto-function', {
            fnName:  data.ownerFn.fnName,
            fnIid:   data.ownerFn.fnIid,
            callSeq: data.ownerFn.callSeq,
        });
    } catch (e) {
        actionError.value = `查询失败: ${e.message}`;
        setTimeout(() => { actionError.value = ''; }, 3000);
    } finally {
        const set2 = new Set(gotoFnLoadingSet.value);
        set2.delete(s.id);
        gotoFnLoadingSet.value = set2;
    }
}

// ─── 暴露给父组件 ─────────────────────────────────────────────────────────────
defineExpose({ reload: () => loadStrings(true) });

// ─── 初始化 ───────────────────────────────────────────────────────────────────
import { onMounted } from 'vue';
onMounted(loadStrings);
</script>

<style scoped>
.section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.section-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: #a5b4fc; font-size: 11px; font-weight: 600;
}
.filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }

/* 表格 */
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
.src-text {
    color: var(--text-primary); white-space: nowrap; max-width: 350px;
    display: inline-block; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;
}
.td-value-cell { max-width: 420px; }
.text-muted { color: var(--text-muted); }
.row-crypto td { background: rgba(245,158,11,0.06) !important; }

/* 编码徽章 */
.crypto-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 600; font-family: monospace;
}

/* chip */
.var-chip { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: monospace; margin-right: 3px; cursor: default; }
.var-write { background: rgba(34,197,94,0.15); color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }

/* 解码按钮 */
.btn-decode {
    display: inline-block; margin-left: 6px; padding: 1px 7px;
    font-size: 11px; border-radius: 4px; cursor: pointer;
    background: rgba(99,102,241,0.15); color: #a5b4fc;
    border: 1px solid rgba(99,102,241,0.3);
    transition: background 0.15s;
    vertical-align: middle;
}
.btn-decode:hover:not(:disabled) { background: rgba(99,102,241,0.3); }
.btn-decode:disabled { opacity: 0.5; cursor: default; }
.btn-decode-close {
    background: rgba(248,113,113,0.1); color: #f87171;
    border-color: rgba(248,113,113,0.3); margin-left: 4px; padding: 1px 5px;
}

/* 解码展示块 */
.decoded-block {
    display: flex; align-items: flex-start; gap: 6px; margin-top: 4px;
    padding: 4px 8px; background: rgba(34,197,94,0.06);
    border: 1px solid rgba(34,197,94,0.2); border-radius: 4px;
    flex-wrap: wrap;
}
.decoded-label { font-size: 10px; color: #86efac; font-weight: 600; white-space: nowrap; margin-top: 2px; }
.decoded-value {
    color: #86efac; font-family: monospace; font-size: 11px;
    word-break: break-all; flex: 1;
}

/* 操作列 */
.td-actions { width: 64px; text-align: center; padding: 4px 6px !important; white-space: nowrap; }
.btn-goto {
    background: none; border: none; cursor: pointer; font-size: 13px;
    opacity: 0.45; transition: opacity 0.15s, transform 0.1s;
    padding: 2px 3px; border-radius: 3px; line-height: 1;
}
.btn-goto:hover:not(:disabled) { opacity: 1; background: rgba(99,102,241,0.15); }
.btn-goto:disabled { cursor: default; opacity: 0.25; }
.btn-goto-loading { opacity: 0.3; animation: spin 0.8s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* 错误提示 */
.action-error {
    font-size: 11px; color: #f87171; margin-bottom: 8px; padding: 4px 8px;
    background: rgba(248,113,113,0.08); border-radius: 4px;
    border: 1px solid rgba(248,113,113,0.2);
}

/* 分页 */
.pagination {
    display: flex; align-items: center; justify-content: center;
    gap: 16px; margin-top: 16px; padding-top: 16px;
    border-top: 1px solid var(--border-color);
}
.page-info { font-size: 12px; color: var(--text-muted); }
</style>
