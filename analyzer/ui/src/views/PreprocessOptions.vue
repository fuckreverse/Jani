<template>
  <!-- 预处理选项面板（可折叠，支持 embedded 嵌入模式） -->
  <div class="preprocess-panel" :class="{ 'preprocess-panel-embedded': embedded }">
    <!-- 启用开关 + 标题行 -->
    <div class="preprocess-header" @click="toggleCollapse">
      <label class="enabled-toggle" @click.stop>
        <input type="checkbox" v-model="opts.enabled" @change="onEnabledChange" />
        <span class="enabled-label">⚙ 预处理</span>
      </label>
      <span v-if="opts.enabled && currentPreset" class="preset-badge">{{ PRESET_LABELS[currentPreset] ?? currentPreset }}</span>
      <span v-if="!opts.enabled" class="disabled-hint">（未启用）</span>
      <span class="collapse-arrow" :class="{ open: expanded && opts.enabled }">▶</span>
    </div>

    <!-- 展开体（仅在启用时显示） -->
    <div v-if="opts.enabled && expanded" class="preprocess-body">

      <!-- Preset 快捷选择 -->
      <div class="pp-field">
        <label class="pp-label">Preset（快捷组合）</label>
        <div class="preset-cards">
          <label
            v-for="p in PRESETS"
            :key="p.value"
            class="preset-card"
            :class="{ selected: opts.preset === p.value }"
          >
            <input type="radio" v-model="opts.preset" :value="p.value" style="display:none" />
            <span class="preset-card-title">{{ p.label }}</span>
            <span class="preset-card-hint">{{ p.hint }}</span>
          </label>
        </div>
      </div>

      <!-- 源码类型 -->
      <div class="pp-field pp-field-inline">
        <label class="pp-label">源码类型 (sourceType)</label>
        <select v-model="opts.sourceType" style="width:130px">
          <option value="script">script（默认）</option>
          <option value="module">module（ESM）</option>
        </select>
      </div>

      <!-- ── 反混淆选项（仅 deobfuscate / full 时显示） ── -->
      <div v-if="hasDeobfuscate" class="pp-section">
        <div class="pp-section-header" @click="toggle('deob')">
          <span class="section-arrow" :class="{ open: open.deob }">▶</span>
          <span class="pp-section-title">反混淆（DeobfuscatePlugin）</span>
        </div>
        <div v-show="open.deob" class="pp-section-body">
          <div class="options-grid">
            <label class="checkbox-label" v-for="p in DEOB_PASSES" :key="p.key">
              <input type="checkbox" v-model="opts.deobfuscate[p.key]" />
              <span class="opt-key">{{ p.label }}</span>
              <span v-if="p.safe" class="safe-dot" title="语义等价，安全">●</span>
              <span class="opt-hint">{{ p.hint }}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ── 箭头函数规范化（仅 normalize-arrow / full 时显示） ── -->
      <div v-if="hasNormalizeArrow" class="pp-section">
        <div class="pp-section-header" @click="toggle('arrow')">
          <span class="section-arrow" :class="{ open: open.arrow }">▶</span>
          <span class="pp-section-title">箭头函数规范化（NormalizeArrowPlugin）</span>
        </div>
        <div v-show="open.arrow" class="pp-section-body">
          <div class="options-grid">
            <label class="checkbox-label">
              <input type="checkbox" v-model="opts.normalizeArrow.preserveThis" />
              <span class="opt-key">preserveThis</span>
              <span class="opt-hint">重命名捕获的 this 变量（默认 true）</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="opts.normalizeArrow.onlyExpression" />
              <span class="opt-key">onlyExpression</span>
              <span class="opt-hint">仅处理表达式体箭头函数</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ── 语法降级选项（仅 transpile / full 时显示） ── -->
      <div v-if="hasTranspile" class="pp-section">
        <div class="pp-section-header" @click="toggle('transpile')">
          <span class="section-arrow" :class="{ open: open.transpile }">▶</span>
          <span class="pp-section-title">语法降级（TranspilePlugin / Babel）</span>
        </div>
        <div v-show="open.transpile" class="pp-section-body">
          <div class="transpile-targets">
            <label class="pp-label" style="margin-bottom:6px">目标环境 (targets)</label>
            <div class="target-presets">
              <label
                v-for="t in TRANSPILE_TARGETS"
                :key="t.value"
                class="target-card"
                :class="{ selected: opts.transpile.targets === t.value }"
              >
                <input type="radio" v-model="opts.transpile.targets" :value="t.value" style="display:none" />
                <span class="target-card-name">{{ t.label }}</span>
                <span class="target-card-value">{{ t.chrome }}</span>
                <span class="target-card-hint">{{ t.hint }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';

// ── Props ─────────────────────────────────────────────────────────────────────
defineProps({
  /**
   * embedded: true 时嵌入表单内，去掉外层圆角/边框样式
   */
  embedded: {
    type: Boolean,
    default: false,
  },
});

// ── Preset 定义 ───────────────────────────────────────────────────────────────
const PRESETS = [
  {
    value: 'deobfuscate',
    label: '反混淆',
    hint:  '逗号表达式拆分 + void 替换 + 常量折叠',
  },
  {
    value: 'normalize-arrow',
    label: '箭头规范化',
    hint:  '将箭头函数转为普通函数（改善 Jalangi this 追踪）',
  },
  {
    value: 'transpile',
    label: '语法降级',
    hint:  '通过 Babel preset-env 将 ESNext 降级',
  },
  {
    value: 'full',
    label: '全流程',
    hint:  '箭头规范化 → 反混淆 → 语法降级',
  },
];

const PRESET_LABELS = Object.fromEntries(PRESETS.map(p => [p.value, p.label]));

// ── 反混淆子选项 ──────────────────────────────────────────────────────────────
const DEOB_PASSES = [
  { key: 'replaceVoid',       label: 'replaceVoid',       hint: 'void 0 → undefined（语义等价）',                   safe: true  },
  { key: 'foldConstants',     label: 'foldConstants',     hint: '折叠纯字面量常量（语义等价）',                       safe: true  },
  { key: 'splitSequence',     label: 'splitSequence',     hint: '拆分语句级逗号表达式（语义等价，让 iid 更细粒度）',   safe: true  },
  { key: 'simplifyBoolean',   label: 'simplifyBoolean',   hint: '!!x → Boolean(x)（结构改变，可能影响插桩精度）',     safe: false },
  { key: 'expandConditional', label: 'expandConditional', hint: '条件表达式 → if-else（结构改变较大，谨慎开启）',      safe: false },
];

// ── 语法降级目标预设 ──────────────────────────────────────────────────────────
// value 使用 esXXXX 年份标识，后端会将其映射为对应的 browserslist 查询。
// 选择原则：越低的版本，语法展开越彻底，iid 越细粒度，越适合 Jani trace 分析。
const TRANSPILE_TARGETS = [
  {
    value:  'es2015',
    label:  'ES2015',
    chrome: 'Chrome ≥49',
    hint:   '彻底展开箭头函数、class、解构、模板字符串等，iid 最细，推荐用于 trace 分析',
  },
  {
    value:  'es2017',
    label:  'ES2017',
    chrome: 'Chrome ≥58',
    hint:   '保留 async/await，避免 generator 膨胀，兼顾异步代码可读性',
  },
  {
    value:  'es2020',
    label:  'ES2020',
    chrome: 'Chrome ≥80',
    hint:   '仅展开可选链、空值合并、逻辑赋值等新语法，代码结构变化最小',
  },
  {
    value:  'es2022',
    label:  'ES2022',
    chrome: 'Chrome ≥103',
    hint:   '仅展开类私有字段等最新语法，降级程度最低',
  },
];

// ── 内部状态 ──────────────────────────────────────────────────────────────────
const expanded = ref(true);

const opts = reactive({
  enabled:   false,
  preset:    'deobfuscate',
  sourceType: 'script',
  deobfuscate: {
    replaceVoid:       true,    // void 0 → undefined，语义等价，最安全
    foldConstants:     true,    // 纯字面量折叠，语义等价，安全
    splitSequence:     true,    // 语句级逗号表达式拆分，语义等价，让 iid 更细粒度
    simplifyBoolean:   false,   // !!x → Boolean(x)，结构改变，保守关闭
    expandConditional: false,   // 三元 → if-else，结构改变较大，关闭
  },
  normalizeArrow: {
    preserveThis:  true,
    onlyExpression: false,
  },
  transpile: {
    targets: 'es2015',   // 推荐：彻底展开常见语法，iid 最细，最适合 trace 分析
  },
});

// 哪些插件区块需要展示
const hasDeobfuscate   = computed(() => opts.preset === 'deobfuscate' || opts.preset === 'full');
const hasNormalizeArrow = computed(() => opts.preset === 'normalize-arrow' || opts.preset === 'full');
const hasTranspile     = computed(() => opts.preset === 'transpile' || opts.preset === 'full');

// 当前 preset 值（供 badge 显示）
const currentPreset = computed(() => opts.preset);

// 折叠
const open = reactive({ deob: true, arrow: false, transpile: false });

function toggle(name) {
  open[name] = !open[name];
}

function toggleCollapse() {
  if (opts.enabled) expanded.value = !expanded.value;
}

function onEnabledChange() {
  if (opts.enabled) expanded.value = true;
}

// ── 供父组件调用的 API ────────────────────────────────────────────────────────

/**
 * 返回预处理配置对象；若未启用，返回 null。
 * @returns {object|null}
 */
function buildPreprocess() {
  if (!opts.enabled) return null;

  const cfg = {
    enabled:    true,
    preset:     opts.preset,
    sourceType: opts.sourceType,
  };

  if (hasDeobfuscate.value) {
    cfg.deobfuscate = { ...opts.deobfuscate };
  }
  if (hasNormalizeArrow.value) {
    cfg.normalizeArrow = { ...opts.normalizeArrow };
  }
  if (hasTranspile.value && opts.transpile.targets) {
    cfg.transpile = { targets: opts.transpile.targets };
  }

  return cfg;
}

/**
 * 从保存的配置中恢复状态。
 * @param {object|null} saved
 */
function loadPreprocess(saved) {
  if (!saved || !saved.enabled) {
    opts.enabled = false;
    return;
  }
  opts.enabled    = true;
  opts.preset     = saved.preset ?? 'deobfuscate';
  opts.sourceType = saved.sourceType ?? 'script';
  if (saved.deobfuscate) Object.assign(opts.deobfuscate, saved.deobfuscate);
  if (saved.normalizeArrow) Object.assign(opts.normalizeArrow, saved.normalizeArrow);
  if (saved.transpile) Object.assign(opts.transpile, saved.transpile);
}

defineExpose({ buildPreprocess, loadPreprocess, opts });
</script>

<style scoped>
.preprocess-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
}

.preprocess-panel-embedded {
  border-radius: 0;
  border: none;
  border-top: 1px solid var(--border-color);
}

/* ── 顶部标题行 ────────────────────────────────────────────────────────────── */
.preprocess-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-secondary);
  transition: background 0.15s;
}
.preprocess-header:hover {
  background: var(--bg-tertiary);
}

.enabled-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.enabled-toggle input[type="checkbox"] {
  width: auto;
}

.enabled-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.preset-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(139, 92, 246, 0.18);
  color: #a78bfa;
  font-family: monospace;
}

.disabled-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.collapse-arrow {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s;
  display: inline-block;
}
.collapse-arrow.open {
  transform: rotate(90deg);
}

/* ── 展开体 ────────────────────────────────────────────────────────────────── */
.preprocess-body {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ── Preset 卡片 ───────────────────────────────────────────────────────────── */
.preset-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.preset-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  background: var(--bg-primary);
  min-width: 120px;
}
.preset-card:hover {
  border-color: rgba(139, 92, 246, 0.4);
  background: rgba(139, 92, 246, 0.06);
}
.preset-card.selected {
  border-color: rgba(139, 92, 246, 0.7);
  background: rgba(139, 92, 246, 0.12);
}

.preset-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.preset-card-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

/* ── 字段 ──────────────────────────────────────────────────────────────────── */
.pp-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pp-field-inline {
  flex-direction: row;
  align-items: center;
  gap: 12px;
}

.pp-label {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

/* ── 子区块（折叠） ──────────────────────────────────────────────────────────── */
.pp-section {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

.pp-section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-tertiary);
  transition: background 0.15s;
}
.pp-section-header:hover {
  background: var(--bg-secondary);
}

.section-arrow {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s;
  display: inline-block;
}
.section-arrow.open {
  transform: rotate(90deg);
}

.pp-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.pp-section-body {
  padding: 10px 14px 12px;
}

/* ── 选项网格 ────────────────────────────────────────────────────────────── */
.options-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
  align-items: flex-start;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}
.checkbox-label input[type="checkbox"] {
  width: auto;
}

.opt-key {
  font-family: monospace;
  font-size: 12px;
}

.safe-dot {
  font-size: 8px;
  color: var(--success, #4ade80);
  line-height: 1;
  flex-shrink: 0;
}

.opt-hint {
  font-size: 11px;
  color: var(--text-muted);
}

/* ── 语法降级目标卡片 ── */
.transpile-targets {
  display: flex;
  flex-direction: column;
}
.target-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.target-card {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background: #fafafa;
  min-width: 108px;
  max-width: 148px;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.target-card:hover {
  border-color: #4096ff;
  background: #f0f5ff;
}
.target-card.selected {
  border-color: #1677ff;
  background: #e6f0ff;
}
.target-card-name {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  margin-bottom: 2px;
}
.target-card.selected .target-card-name {
  color: #1677ff;
}
.target-card-value {
  font-size: 10px;
  font-family: monospace;
  color: #888;
  margin-bottom: 3px;
}
.target-card.selected .target-card-value {
  color: #4096ff;
}
.target-card-hint {
  font-size: 10px;
  color: #aaa;
  line-height: 1.3;
}
</style>
