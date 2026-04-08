<template>
  <!-- 插桩选项面板（分区块折叠）——可复用组件 -->
  <div class="options-panel" :class="{ 'options-panel-embedded': embedded }">
    <div v-if="!embedded" class="options-panel-title">插桩选项</div>

    <!-- ① 基础选项 -->
    <div class="section">
      <div class="section-header" @click="toggle('basic')">
        <span class="section-arrow" :class="{ open: open.basic }">▶</span>
        <span class="section-title">基础选项</span>
      </div>
      <div class="section-body" v-show="open.basic">
        <div class="options-grid">
          <div class="opt-field">
            <label>沙盒变量名</label>
            <input v-model="opts.sandboxVar" placeholder="J$" style="width:100px" />
          </div>
          <div class="opt-field">
            <label>源码类型</label>
            <select v-model="opts.sourceType" style="width:130px">
              <option value="auto">auto（自动识别）</option>
              <option value="script">script</option>
              <option value="module">module</option>
            </select>
          </div>
          <div class="opt-field">
            <label>目标平台 (--target)</label>
            <select v-model="opts.target" style="width:120px">
              <option value="browser">browser</option>
              <option value="node">node</option>
            </select>
          </div>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.randomVar" />
            <span>--random-var</span>
            <span class="opt-hint">随机生成沙盒变量名</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.debug" />
            <span>--debug</span>
            <span class="opt-hint">详细日志输出</span>
          </label>
        </div>
      </div>
    </div>

    <!-- ② 输出选项 -->
    <div class="section">
      <div class="section-header" @click="toggle('output')">
        <span class="section-arrow" :class="{ open: open.output }">▶</span>
        <span class="section-title">输出选项</span>
      </div>
      <div class="section-body" v-show="open.output">
        <div class="options-grid">
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.inlineIid" />
            <span>--inline-iid</span>
            <span class="opt-hint">iid→位置 map 内联到文件头</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.inlineSource" />
            <span>--inline-source</span>
            <span class="opt-hint">原始源码内联到 source map</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.noSourceMap" />
            <span>--no-source-map</span>
            <span class="opt-hint">不写 source map 文件</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.vlcqSourceMap" />
            <span>--vlcq-source-map</span>
            <span class="opt-hint">额外生成标准 Source Map v3</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.splitRuntime" />
            <span>--split-runtime</span>
            <span class="opt-hint">运行时与插桩代码分离输出</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.dryRun" />
            <span>--dry-run</span>
            <span class="opt-hint">只预览，不写文件</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.noWrite" />
            <span>--no-write</span>
            <span class="opt-hint">仅内存插桩（instrument-and-run）</span>
          </label>
        </div>
      </div>
    </div>

    <!-- ③ 浏览器专属选项（仅 target=browser 时显示） -->
    <div class="section" v-if="opts.target === 'browser'">
      <div class="section-header" @click="toggle('browser')">
        <span class="section-arrow" :class="{ open: open.browser }">▶</span>
        <span class="section-title">浏览器专属选项</span>
        <span class="section-badge">target=browser</span>
      </div>
      <div class="section-body" v-show="open.browser">
        <div class="options-grid">
          <div class="opt-field">
            <label>--db-name</label>
            <input v-model="opts.dbName" placeholder="jalangi-traces" style="width:180px" />
            <span class="opt-hint-inline">IndexedDB 数据库名</span>
          </div>
          <div class="opt-field">
            <label>--store-name</label>
            <input v-model="opts.storeName" placeholder="execution-trace" style="width:180px" />
            <span class="opt-hint-inline">ObjectStore 名</span>
          </div>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.noIdb" />
            <span>--no-idb</span>
            <span class="opt-hint">不启用 IndexedDB</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.wsSab" />
            <span>--ws-sab</span>
            <span class="opt-hint">SharedArrayBuffer 零拷贝模式（需 COOP/COEP）</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.minify" />
            <span>--minify</span>
            <span class="opt-hint">压缩运行时 bundle</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="opts.deferredLoad" />
            <span>--deferred-load</span>
            <span class="opt-hint">延迟加载（需配合 --split-runtime）</span>
          </label>
          <div class="opt-field" style="width:100%">
            <label>--ws-url</label>
            <input
              v-model="opts.wsUrl"
              :placeholder="defaultWsUrl"
              style="width:320px;font-family:monospace;font-size:12px"
            />
            <span class="opt-hint-inline">留空则使用默认地址</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ④ 插桩粒度控制 (Config) -->
    <div class="section">
      <div class="section-header" @click="toggle('config')">
        <span class="section-arrow" :class="{ open: open.config }">▶</span>
        <span class="section-title">插桩粒度控制（Config）</span>
        <span class="section-hint">null = 全量（默认），取消勾选 = 禁用该操作类型的插桩</span>
      </div>
      <div class="section-body" v-show="open.config">
        <div class="config-bar">
          <span class="config-mode-label">模式：</span>
          <label class="radio-label">
            <input type="radio" v-model="cfgMode" value="full" />
            <span>全量（不传 Config）</span>
          </label>
          <label class="radio-label">
            <input type="radio" v-model="cfgMode" value="custom" />
            <span>自定义</span>
          </label>
          <template v-if="cfgMode === 'custom'">
            <button class="btn-secondary btn-xs" @click="selectAll">全部开启</button>
            <button class="btn-secondary btn-xs" @click="clearAll">全部关闭</button>
          </template>
        </div>
        <div v-if="cfgMode === 'custom'" class="config-grid">
          <label v-for="key in CONFIG_KEYS" :key="key" class="checkbox-label config-item">
            <input type="checkbox" v-model="cfgValues[key]" />
            <span class="config-key">{{ key }}</span>
            <span class="opt-hint">{{ CONFIG_DESC[key] }}</span>
          </label>
        </div>
      </div>
    </div>

    <!-- ⑤ 运行选项（embedded 模式不显示，因为弹窗中无需 run options） -->
    <div v-if="!embedded" class="section">
      <div class="section-header" @click="toggle('run')">
        <span class="section-arrow" :class="{ open: open.run }">▶</span>
        <span class="section-title">运行选项（instrument-and-run）</span>
      </div>
      <div class="section-body" v-show="open.run">
        <!-- analysis 插件列表 -->
        <div class="run-option-group">
          <div class="run-option-label">
            <span>--analysis 插件路径</span>
            <button class="btn-secondary btn-xs" @click="addAnalysis">+ 添加</button>
          </div>
          <div v-for="(_, idx) in opts.analyses" :key="idx" class="run-option-row">
            <input
              v-model="opts.analyses[idx]"
              placeholder="如 src/plugins/tutorial/LogAll.js"
              class="run-option-input"
            />
            <button class="btn-danger btn-xs" @click="removeAnalysis(idx)">删除</button>
          </div>
          <div v-if="opts.analyses.length === 0" class="run-option-empty">暂无分析插件（使用默认执行追踪）</div>
        </div>

        <!-- init-param 键值对列表 -->
        <div class="run-option-group" style="margin-top:12px">
          <div class="run-option-label">
            <span>--init-param 初始参数</span>
            <button class="btn-secondary btn-xs" @click="addInitParam">+ 添加</button>
          </div>
          <div v-for="(param, idx) in opts.initParams" :key="idx" class="run-option-row">
            <input
              v-model="param.key"
              placeholder="key"
              class="run-option-input run-option-input-key"
            />
            <span class="run-param-colon">:</span>
            <input
              v-model="param.value"
              placeholder="value"
              class="run-option-input"
            />
            <button class="btn-danger btn-xs" @click="removeInitParam(idx)">删除</button>
          </div>
          <div v-if="opts.initParams.length === 0" class="run-option-empty">暂无初始参数</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';

// ── Props ────────────────────────────────────────────────────────────────────
defineProps({
  /**
   * embedded: true 时嵌入在弹窗/表单中，去掉外层圆角边框，隐藏"运行选项"分区
   */
  embedded: {
    type: Boolean,
    default: false,
  },
});

// ── 默认 WS URL ───────────────────────────────────────────────────────────────
const defaultWsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/trace`;

// ── 折叠状态 ──────────────────────────────────────────────────────────────────
const open = reactive({
  basic:   true,
  output:  false,
  browser: false,
  config:  false,
  run:     false,
});

function toggle(name) {
  open[name] = !open[name];
}

// ── 插桩选项 ──────────────────────────────────────────────────────────────────
const opts = reactive({
  // 基础
  sandboxVar:    'J$',
  sourceType:    'auto',
  target:        'browser',
  randomVar:     false,
  debug:         true,
  // 输出
  inlineIid:     false,
  inlineSource:  false,
  noSourceMap:   false,
  vlcqSourceMap: false,
  splitRuntime:  false,
  dryRun:        false,
  noWrite:       false,
  // 浏览器专属
  dbName:        '',
  storeName:     '',
  noIdb:         true,
  wsUrl:         '',   // 空 = 使用 defaultWsUrl
  wsSab:         true,
  minify:        false,
  deferredLoad:  false,
  // 运行选项
  analyses:      [],
  initParams:    [],   // [{ key: '', value: '' }, ...]
});

// ── Config 粒度控制 ────────────────────────────────────────────────────────────
const CONFIG_KEYS = [
  'INSTR_READ',
  'INSTR_WRITE',
  'INSTR_GETFIELD',
  'INSTR_PUTFIELD',
  'INSTR_BINARY',
  'INSTR_UNARY',
  'INSTR_LITERAL',
  'INSTR_INIT',
  'INSTR_CONDITIONAL',
  'INSTR_TRY_CATCH_ARGUMENTS',
  'INSTR_END_EXPRESSION',
  'INSTR_INVOKE',
  'INSTR_RETURN',
  'INSTR_THROW',
  'INSTR_FORIN',
  'ENABLE_SAMPLING',
];

const CONFIG_DESC = {
  INSTR_READ:                '变量读取',
  INSTR_WRITE:               '变量写入',
  INSTR_GETFIELD:            '属性读取',
  INSTR_PUTFIELD:            '属性写入',
  INSTR_BINARY:              '二元运算',
  INSTR_UNARY:               '一元运算',
  INSTR_LITERAL:             '字面量',
  INSTR_INIT:                '变量声明初始化',
  INSTR_CONDITIONAL:         '条件表达式/switch',
  INSTR_TRY_CATCH_ARGUMENTS: '函数/脚本 try-catch 包裹',
  INSTR_END_EXPRESSION:      '表达式语句末尾',
  INSTR_INVOKE:              '函数/方法调用',
  INSTR_RETURN:              'return 语句',
  INSTR_THROW:               'throw 语句',
  INSTR_FORIN:               'for-in 循环',
  ENABLE_SAMPLING:           '采样模式',
};

const cfgMode   = ref('full');   // 'full' | 'custom'
const cfgValues = reactive(Object.fromEntries(CONFIG_KEYS.map(k => [k, true])));

function selectAll() { for (const k of CONFIG_KEYS) cfgValues[k] = true; }
function clearAll()  { for (const k of CONFIG_KEYS) cfgValues[k] = false; }

// ── analysis / init-param 动态列表 ──────────────────────────────────────────
function addAnalysis()        { opts.analyses.push(''); }
function removeAnalysis(idx)  { opts.analyses.splice(idx, 1); }
function addInitParam()       { opts.initParams.push({ key: '', value: '' }); }
function removeInitParam(idx) { opts.initParams.splice(idx, 1); }

// ── source-type 自动识别（简单启发） ─────────────────────────────────────────
function detectSourceType(src) {
  return /^\s*(import\s|export\s)/m.test(src) ? 'module' : 'script';
}

// ── 构建请求选项（供父组件通过 ref 调用） ─────────────────────────────────────
function buildOptions(sourceCode) {
  const resolvedSourceType = opts.sourceType === 'auto' && sourceCode
      ? detectSourceType(sourceCode)
      : (opts.sourceType === 'auto' ? 'script' : opts.sourceType);

  const jalangiConfig = cfgMode.value === 'full'
      ? null
      : Object.fromEntries(CONFIG_KEYS.map(k => [k, cfgValues[k]]));

  return {
    sandboxVar:    opts.sandboxVar,
    sourceType:    resolvedSourceType,
    target:        opts.target,
    randomVar:     opts.randomVar,
    debug:         opts.debug,
    inlineIid:     opts.inlineIid,
    inlineSource:  opts.inlineSource,
    noSourceMap:   opts.noSourceMap,
    vlcqSourceMap: opts.vlcqSourceMap,
    splitRuntime:  opts.splitRuntime,
    dryRun:        opts.dryRun,
    noWrite:       opts.noWrite,
    dbName:        opts.dbName    || undefined,
    storeName:     opts.storeName || undefined,
    noIdb:         opts.noIdb,
    wsUrl:         opts.wsUrl     || defaultWsUrl,
    wsSab:         opts.wsSab,
    minify:        opts.minify,
    deferredLoad:  opts.deferredLoad,
    analyses:      opts.analyses.filter(a => a.trim()),
    initParams:    opts.initParams
        .filter(p => p.key.trim())
        .map(p => `${p.key.trim()}:${p.value}`),
    jalangiConfig,
  };
}

// ── 加载已有选项（供父组件预填，如 Fork 时使用） ───────────────────────────────
function loadOptions(savedOpts) {
  if (!savedOpts || typeof savedOpts !== 'object') return;
  const keys = Object.keys(opts);
  for (const k of keys) {
    if (k in savedOpts) {
      // 数组单独处理（analyses / initParams）
      if (Array.isArray(opts[k])) {
        const val = savedOpts[k];
        if (Array.isArray(val)) {
          if (k === 'initParams') {
            // [{ key, value }] 或 ["key:value"] 两种格式兼容
            opts[k] = val.map(v => {
              if (typeof v === 'string') {
                const colonIdx = v.indexOf(':');
                return colonIdx !== -1
                    ? { key: v.slice(0, colonIdx), value: v.slice(colonIdx + 1) }
                    : { key: v, value: '' };
              }
              return v;
            });
          } else {
            opts[k] = [...val];
          }
        }
      } else {
        opts[k] = savedOpts[k];
      }
    }
  }
  // 处理 jalangiConfig
  if (savedOpts.jalangiConfig && typeof savedOpts.jalangiConfig === 'object') {
    cfgMode.value = 'custom';
    for (const k of CONFIG_KEYS) {
      cfgValues[k] = savedOpts.jalangiConfig[k] ?? true;
    }
  } else {
    cfgMode.value = 'full';
  }
}

// 暴露给父组件
defineExpose({ buildOptions, loadOptions, opts, defaultWsUrl });
</script>

<style scoped>
/* ── 面板外壳 ─────────────────────────────────────────────────────────────── */
.options-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
}

/* embedded 模式：去掉外层圆角/边框，贴合弹窗内部 */
.options-panel-embedded {
  border-radius: 0;
  border: none;
  border-top: 1px solid var(--border-color);
}

.options-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border-color);
}

/* ── 折叠区块 ────────────────────────────────────────────────────────────── */
.section {
  border-bottom: 1px solid var(--border-color);
}
.section:last-child {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-secondary);
  transition: background 0.15s;
}
.section-header:hover {
  background: var(--bg-tertiary);
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

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: rgba(59,130,246,0.18);
  color: #60a5fa;
  font-family: monospace;
}

.section-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}

.section-body {
  padding: 12px 16px 14px;
}

/* ── 选项网格 ────────────────────────────────────────────────────────────── */
.options-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 24px;
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

.opt-hint {
  font-size: 11px;
  color: var(--text-muted);
}
.opt-hint-inline {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.opt-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.opt-field label {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 0;
}

/* ── Config 粒度控制 ─────────────────────────────────────────────────────── */
.config-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.config-mode-label {
  font-size: 12px;
  color: var(--text-muted);
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-primary);
}
.radio-label input[type="radio"] {
  width: auto;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px 16px;
}

.config-item {
  padding: 4px 0;
}

.config-key {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-primary);
}

/* ── 运行选项 ────────────────────────────────────────────────────────────── */
.run-option-group {
  margin-bottom: 4px;
}

.run-option-label {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.run-option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.run-option-input {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  font-family: monospace;
}

.run-option-input-key {
  flex: 0 0 140px;
  min-width: 80px;
}

.run-param-colon {
  font-size: 14px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.run-option-empty {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
  padding: 4px 0;
}

/* ── 工具按钮 ────────────────────────────────────────────────────────────── */
.btn-xs {
  padding: 3px 8px;
  font-size: 11px;
}

.btn-danger {
  background: rgba(239,68,68,0.15);
  color: #f87171;
  border: 1px solid rgba(239,68,68,0.3);
}
.btn-danger:hover { background: rgba(239,68,68,0.25); }
</style>
