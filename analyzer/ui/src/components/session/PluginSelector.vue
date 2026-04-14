<template>
  <div class="plugin-selector">
    <!-- 标题栏（可折叠） -->
    <div class="ps-header" @click="expanded = !expanded">
      <span class="ps-title">🔬 分析插件</span>
      <span class="ps-badge">{{ selectedCount }}/{{ totalCount }} 已选</span>
      <span class="ps-chevron">{{ expanded ? '▲' : '▼' }}</span>
    </div>
    <p class="ps-hint">选择导入后自动执行的分析（Phase 1 基础解析始终执行）</p>

    <div v-if="expanded" class="ps-body">
      <div v-if="loading" class="ps-loading">加载插件列表中...</div>
      <template v-else-if="totalCount > 0">
        <!-- 全选 / 全不选 快捷操作 -->
        <div class="ps-quick-actions">
          <button type="button" class="ps-quick-btn" @click="selectAll">全选</button>
          <button type="button" class="ps-quick-btn" @click="deselectAll">全不选</button>
        </div>

        <!-- 按阶段分组 -->
        <div v-for="(plugins, phase) in groups" :key="phase" class="ps-group">
          <!-- 组标题 + 全选复选框 -->
          <label class="ps-group-header">
            <input
              type="checkbox"
              :checked="isGroupAll(phase)"
              :indeterminate.prop="isGroupPartial(phase)"
              @change="toggleGroup(phase, $event.target.checked)"
            />
            <span class="ps-group-label">{{ phaseLabel(phase) }}</span>
          </label>

          <!-- 插件列表 -->
          <div class="ps-plugin-grid">
            <label
              v-for="p in plugins"
              :key="p.id"
              class="ps-plugin-item"
              :class="{ checked: modelValue.includes(p.id) }"
            >
              <input
                type="checkbox"
                :value="p.id"
                :checked="modelValue.includes(p.id)"
                @change="onPluginChange(p.id, $event.target.checked)"
              />
              <span class="ps-plugin-name">{{ p.displayName }}</span>
              <span class="ps-plugin-desc">{{ p.description }}</span>
            </label>
          </div>
        </div>
      </template>
      <div v-else class="ps-loading">暂无可用插件</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(['update:modelValue']);

const groups  = ref({});
const loading = ref(false);
const expanded = ref(true);

const allIds = computed(() =>
    Object.values(groups.value).flat().map(p => p.id)
);
const totalCount    = computed(() => allIds.value.length);
const selectedCount = computed(() => props.modelValue.length);

// ── 加载插件 ────────────────────────────────────────────────────────────────

async function loadPlugins() {
    loading.value = true;
    try {
        const res = await fetch('/api/plugins');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        groups.value = await res.json();
        // 初始化时若 modelValue 为空则全选
        if (props.modelValue.length === 0) {
            emit('update:modelValue', [...allIds.value]);
        }
    } catch (e) {
        console.error('PluginSelector: loadPlugins error', e);
    } finally {
        loading.value = false;
    }
}

// ── 组操作 ──────────────────────────────────────────────────────────────────

function phaseLabel(phase) {
    return {
        phase2: 'Phase 2 — 调用图 / 变量追踪 / 热路径',
        phase3: 'Phase 3 — 循环检测 / 值模式 / 加密 / 签名',
        phase4: 'Phase 4 — 数据流 / 对象变异 / 混淆 / 算法 / WebAPI',
    }[phase] || phase;
}

function isGroupAll(phase) {
    const ids = (groups.value[phase] || []).map(p => p.id);
    return ids.length > 0 && ids.every(id => props.modelValue.includes(id));
}

function isGroupPartial(phase) {
    const ids = (groups.value[phase] || []).map(p => p.id);
    const n   = ids.filter(id => props.modelValue.includes(id)).length;
    return n > 0 && n < ids.length;
}

function toggleGroup(phase, checked) {
    const ids = (groups.value[phase] || []).map(p => p.id);
    const set = new Set(props.modelValue);
    ids.forEach(id => checked ? set.add(id) : set.delete(id));
    emit('update:modelValue', [...set]);
}

function onPluginChange(id, checked) {
    const set = new Set(props.modelValue);
    checked ? set.add(id) : set.delete(id);
    emit('update:modelValue', [...set]);
}

function selectAll()   { emit('update:modelValue', [...allIds.value]); }
function deselectAll() { emit('update:modelValue', []); }

// ── 暴露给父组件 ─────────────────────────────────────────────────────────────

/** 若 v-model 等于全选，返回 null（让后端用默认），否则返回选中列表 */
function getPayload() {
    const all = allIds.value;
    if (all.length > 0 && all.every(id => props.modelValue.includes(id))) return null;
    return [...props.modelValue];
}

defineExpose({ getPayload, allIds });

onMounted(() => loadPlugins());
</script>

<style scoped>
.plugin-selector {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    overflow: hidden;
}

/* 标题栏 */
.ps-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    cursor: pointer;
    user-select: none;
    background: var(--bg-secondary);
    border-bottom: 1px solid transparent;
    transition: background 0.1s;
}
.ps-header:hover { background: var(--bg-tertiary); }
.ps-title  { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ps-badge  {
    font-size: 11px; font-weight: 600;
    padding: 1px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.15); color: var(--accent);
}
.ps-chevron { margin-left: auto; font-size: 10px; color: var(--text-muted); }
.ps-hint {
    font-size: 12px; color: var(--text-muted);
    padding: 0 14px 8px; margin: 0;
}

/* Body（展开时） */
.ps-body {
    border-top: 1px solid var(--border-color);
    padding: 10px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.ps-loading {
    font-size: 12px; color: var(--text-muted);
    text-align: center; padding: 10px 0;
}

/* 全选 / 全不选 */
.ps-quick-actions {
    display: flex;
    gap: 6px;
    padding-bottom: 2px;
}
.ps-quick-btn {
    background: none; border: 1px solid var(--border-color);
    padding: 2px 10px; font-size: 11px; color: var(--text-secondary);
    border-radius: 4px; cursor: pointer; transition: all 0.1s;
}
.ps-quick-btn:hover {
    border-color: var(--accent); color: var(--accent);
    background: rgba(99,102,241,0.06);
}

/* 分组 */
.ps-group {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
}
.ps-group-header {
    display: grid;
    grid-template-columns: 16px 148px 1fr;
    align-items: center;
    gap: 0 8px;
    padding: 6px 10px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
}
.ps-group-header input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
    justify-self: start;
    align-self: center;
}
.ps-group-label {
    grid-column: 2 / -1;   /* 跨第2、3列，让阶段标题占满剩余宽度 */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 插件列表：单列，三列 grid（checkbox | 插件名 | 描述） */
.ps-plugin-grid {
    display: flex;
    flex-direction: column;
}
.ps-plugin-item {
    display: grid;
    grid-template-columns: 16px 148px 1fr;
    align-items: baseline;
    gap: 0 8px;
    padding: 6px 10px;
    background: var(--bg-secondary);
    cursor: pointer;
    transition: background 0.1s;
    border-bottom: 1px solid var(--border-color);
}
.ps-plugin-item:last-child { border-bottom: none; }
.ps-plugin-item:hover { background: var(--bg-tertiary); }
.ps-plugin-item.checked { background: rgba(99,102,241,0.06); }
.ps-plugin-item input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
    align-self: center;
}
.ps-plugin-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ps-plugin-desc {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
