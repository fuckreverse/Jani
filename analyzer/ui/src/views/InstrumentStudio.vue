<template>
  <div class="instrument-studio">
    <div class="studio-header">
      <h1 class="page-title">插桩工作台</h1>
      <p class="page-subtitle">粘贴或上传 JS 源码，插桩预览 + 服务端运行 + 自动创建分析会话</p>
    </div>

    <!-- 主体：左右分屏 -->
    <div class="studio-body">

      <!-- 左侧：源码编辑 -->
      <div class="panel panel-left card">
        <div class="panel-header">
          <span class="panel-title">源码编辑</span>
          <div class="panel-actions">
            <button class="btn-secondary btn-sm" @click="$refs.codeInput.click()">上传文件</button>
            <button class="btn-secondary btn-sm" @click="clearCode">清空</button>
          </div>
        </div>
        <input ref="codeInput" type="file" accept=".js" style="display:none" @change="loadFile" />
        <textarea
          v-model="code"
          class="code-editor"
          placeholder="// 粘贴或上传 JavaScript 源码..."
          spellcheck="false"
        ></textarea>
        <div class="panel-footer">
          <span class="code-stat">{{ lineCount }} 行 · {{ byteCount }} bytes</span>
          <input v-model="filename" placeholder="文件名 (如 script.js)" class="filename-input" />
        </div>
      </div>

      <!-- 右侧：插桩后代码（只读） -->
      <div class="panel panel-right card">
        <div class="panel-header">
          <span class="panel-title">插桩后代码（预览）</span>
          <div class="panel-actions">
            <span v-if="smapInfo" class="smap-stat">{{ smapInfo.iidCount }} iids</span>
            <button
              v-if="instrumentedCode"
              class="btn-secondary btn-sm btn-copy"
              :class="{ 'btn-copy-ok': copyOk }"
              @click="copyInstrumented"
            >{{ copyOk ? '✓ 已复制' : '复制' }}</button>
          </div>
        </div>
        <div v-if="instrumenting" class="loading panel-loading">
          <div class="spinner"></div>
          <span>插桩中...</span>
        </div>
        <textarea
          v-else
          :value="instrumentedCode"
          class="code-editor code-readonly"
          readonly
          placeholder="点击「插桩」后显示插桩后代码..."
          spellcheck="false"
        ></textarea>
        <div v-if="instrumentError" class="panel-error">❌ {{ instrumentError }}</div>
      </div>
    </div>

    <!-- 插桩选项（分区块折叠） -->
    <div class="options-panel card">
      <div class="options-panel-title">插桩选项</div>

      <!-- ① 基础选项（默认展开） -->
      <div class="section">
        <div class="section-header" @click="toggleSection('basic')">
          <span class="section-arrow" :class="{ open: sections.basic }">▶</span>
          <span class="section-title">基础选项</span>
        </div>
        <div class="section-body" v-show="sections.basic">
          <div class="options-grid">
            <div class="opt-field">
              <label>沙盒变量名</label>
              <input v-model="options.sandboxVar" placeholder="J$" style="width:100px" />
            </div>
            <div class="opt-field">
              <label>源码类型</label>
              <select v-model="options.sourceType" style="width:130px">
                <option value="auto">auto（自动识别）</option>
                <option value="script">script</option>
                <option value="module">module</option>
              </select>
            </div>
            <div class="opt-field">
              <label>执行环境 (env)</label>
              <select v-model="env" style="width:120px">
                <option value="node">Node.js</option>
                <option value="jsdom">JSDOM</option>
              </select>
            </div>
            <div class="opt-field">
              <label>目标平台 (--target)</label>
              <select v-model="options.target" style="width:120px">
                <option value="node">node</option>
                <option value="browser">browser</option>
              </select>
            </div>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.randomVar" />
              <span>--random-var</span>
              <span class="opt-hint">随机生成沙盒变量名</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.debug" />
              <span>--debug</span>
              <span class="opt-hint">详细日志输出</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ② 输出选项 -->
      <div class="section">
        <div class="section-header" @click="toggleSection('output')">
          <span class="section-arrow" :class="{ open: sections.output }">▶</span>
          <span class="section-title">输出选项</span>
        </div>
        <div class="section-body" v-show="sections.output">
          <div class="options-grid">
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.inlineIid" />
              <span>--inline-iid</span>
              <span class="opt-hint">iid→位置 map 内联到文件头</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.inlineSource" />
              <span>--inline-source</span>
              <span class="opt-hint">原始源码内联到 source map</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.noSourceMap" />
              <span>--no-source-map</span>
              <span class="opt-hint">不写 source map 文件</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.vlcqSourceMap" />
              <span>--vlcq-source-map</span>
              <span class="opt-hint">额外生成标准 Source Map v3</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.splitRuntime" />
              <span>--split-runtime</span>
              <span class="opt-hint">运行时与插桩代码分离输出</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.dryRun" />
              <span>--dry-run</span>
              <span class="opt-hint">只预览，不写文件</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.noWrite" />
              <span>--no-write</span>
              <span class="opt-hint">仅内存插桩（instrument-and-run）</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ③ 浏览器专属选项（仅 target=browser 时显示） -->
      <div class="section" v-if="options.target === 'browser'">
        <div class="section-header" @click="toggleSection('browser')">
          <span class="section-arrow" :class="{ open: sections.browser }">▶</span>
          <span class="section-title">浏览器专属选项</span>
          <span class="section-badge">target=browser</span>
        </div>
        <div class="section-body" v-show="sections.browser">
          <div class="options-grid">
            <div class="opt-field">
              <label>--db-name</label>
              <input v-model="options.dbName" placeholder="jalangi-traces" style="width:180px" />
              <span class="opt-hint-inline">IndexedDB 数据库名</span>
            </div>
            <div class="opt-field">
              <label>--store-name</label>
              <input v-model="options.storeName" placeholder="execution-trace" style="width:180px" />
              <span class="opt-hint-inline">ObjectStore 名</span>
            </div>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.noIdb" />
              <span>--no-idb</span>
              <span class="opt-hint">不启用 IndexedDB</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.wsSab" />
              <span>--ws-sab</span>
              <span class="opt-hint">SharedArrayBuffer 零拷贝模式（需 COOP/COEP）</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.minify" />
              <span>--minify</span>
              <span class="opt-hint">压缩运行时 bundle</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="options.deferredLoad" />
              <span>--deferred-load</span>
              <span class="opt-hint">延迟加载（需配合 --split-runtime）</span>
            </label>
            <div class="opt-field" style="width:100%">
              <label>--ws-url</label>
              <input v-model="options.wsUrl" placeholder="ws://localhost:33000/ws/trace" style="width:320px;font-family:monospace;font-size:12px" />
              <span class="opt-hint-inline">留空则禁用 WS</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ④ 插桩粒度控制 (Config) -->
      <div class="section">
        <div class="section-header" @click="toggleSection('config')">
          <span class="section-arrow" :class="{ open: sections.config }">▶</span>
          <span class="section-title">插桩粒度控制（Config）</span>
          <span class="section-hint">null = 全量（默认），取消勾选 = 禁用该操作类型的插桩</span>
        </div>
        <div class="section-body" v-show="sections.config">
          <div class="config-bar">
            <span class="config-mode-label">模式：</span>
            <label class="radio-label">
              <input type="radio" v-model="configMode" value="full" />
              <span>全量（不传 Config）</span>
            </label>
            <label class="radio-label">
              <input type="radio" v-model="configMode" value="custom" />
              <span>自定义</span>
            </label>
            <template v-if="configMode === 'custom'">
              <button class="btn-secondary btn-xs" @click="selectAllConfig">全部开启</button>
              <button class="btn-secondary btn-xs" @click="clearAllConfig">全部关闭</button>
            </template>
          </div>
          <div v-if="configMode === 'custom'" class="config-grid">
            <label v-for="key in configKeys" :key="key" class="checkbox-label config-item">
              <input type="checkbox" v-model="jalangiConfig[key]" />
              <span class="config-key">{{ key }}</span>
              <span class="opt-hint">{{ configDesc[key] }}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ⑤ 运行选项（analysis + init-param） -->
      <div class="section">
        <div class="section-header" @click="toggleSection('run')">
          <span class="section-arrow" :class="{ open: sections.run }">▶</span>
          <span class="section-title">运行选项（instrument-and-run）</span>
        </div>
        <div class="section-body" v-show="sections.run">
          <!-- analysis 插件列表 -->
          <div class="run-option-group">
            <div class="run-option-label">
              <span>--analysis 插件路径</span>
              <button class="btn-secondary btn-xs" @click="addAnalysis">+ 添加</button>
            </div>
            <div v-for="(_, idx) in options.analyses" :key="idx" class="run-option-row">
              <input
                v-model="options.analyses[idx]"
                placeholder="如 src/plugins/tutorial/LogAll.js"
                class="run-option-input"
              />
              <button class="btn-danger btn-xs" @click="removeAnalysis(idx)">删除</button>
            </div>
            <div v-if="options.analyses.length === 0" class="run-option-empty">暂无分析插件（使用默认执行追踪）</div>
          </div>

          <!-- init-param 键值对列表 -->
          <div class="run-option-group" style="margin-top:12px">
            <div class="run-option-label">
              <span>--init-param 初始参数</span>
              <button class="btn-secondary btn-xs" @click="addInitParam">+ 添加</button>
            </div>
            <div v-for="(param, idx) in options.initParams" :key="idx" class="run-option-row">
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
            <div v-if="options.initParams.length === 0" class="run-option-empty">暂无初始参数</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="action-bar">
      <button class="btn-primary btn-action" :disabled="!code || instrumenting" @click="doInstrument">
        🔧 插桩
      </button>
      <button
        class="btn-action btn-run"
        :disabled="!code || running"
        @click="doRun"
        :title="!code ? '请先输入源码' : ''"
      >
        ▶ 在服务端运行
        <span v-if="running" class="running-dot"></span>
      </button>
      <button v-if="instrumentedCode" class="btn-secondary btn-action" @click="downloadInstrumented">
        ⬇ 下载插桩代码
      </button>
      <button v-if="smapInfo" class="btn-secondary btn-action" @click="downloadSmap">
        ⬇ 下载 smap.json
      </button>
    </div>

    <!-- 运行输出控制台 -->
    <div class="console-panel card" v-if="runLog.length > 0 || running">
      <div class="console-header">
        <span class="console-title">运行输出</span>
        <div class="console-actions">
          <span v-if="runStatus" class="run-status" :class="`run-status-${runStatus}`">{{ runStatus }}</span>
          <button class="btn-secondary btn-sm" @click="clearLog">清空</button>
        </div>
      </div>
      <div class="console-body" ref="consoleEl">
        <div v-for="(line, i) in runLog" :key="i" class="log-line" :class="`log-${line.type}`">
          <span class="log-prefix" v-if="line.type !== 'data'">{{ line.type === 'stdout' ? '' : line.type === 'stderr' ? '[stderr] ' : `[${line.type}] ` }}</span>{{ line.data }}
        </div>
      </div>
      <!-- 运行完成后跳转 -->
      <div v-if="completedSessionId" class="run-complete">
        <span>✅ 运行完成，已创建分析会话</span>
        <router-link :to="`/sessions/${completedSessionId}`" class="btn-primary btn-sm">查看会话 →</router-link>
      </div>
    </div>

    <!-- 运行中的错误提示 -->
    <div v-if="runError" class="run-error card">
      ❌ {{ runError }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onUnmounted, reactive } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

const code             = ref('');
const filename         = ref('script.js');
const instrumentedCode = ref('');
const instrumenting    = ref(false);
const instrumentError  = ref('');
const smapInfo         = ref(null);  // { iidCount, smapJson }
const copyOk           = ref(false);

async function copyInstrumented() {
    if (!instrumentedCode.value) return;
    try {
        await navigator.clipboard.writeText(instrumentedCode.value);
        copyOk.value = true;
        setTimeout(() => { copyOk.value = false; }, 2000);
    } catch {
        // fallback：execCommand
        const ta = document.createElement('textarea');
        ta.value = instrumentedCode.value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyOk.value = true;
        setTimeout(() => { copyOk.value = false; }, 2000);
    }
}

const running            = ref(false);
const runLog             = ref([]);
const runStatus          = ref('');
const runError           = ref('');
const completedSessionId = ref('');
const consoleEl          = ref(null);

const env = ref('node');

// ── 折叠状态 ────────────────────────────────────────────────────────────────
const sections = reactive({
    basic:   true,    // 基础选项默认展开
    output:  false,
    browser: false,
    config:  false,
    run:     false,
});

function toggleSection(name) {
    sections[name] = !sections[name];
}

// ── 插桩选项 ────────────────────────────────────────────────────────────────
const DEFAULT_WS_URL = `ws://${location.host}/ws/trace`;

const options = reactive({
    // 基础
    sandboxVar:   'J$',
    sourceType:   'auto',   // 'auto' | 'script' | 'module'
    target:       'browser',
    randomVar:    false,
    debug:        true,
    // 输出
    inlineIid:    true,
    inlineSource: false,
    noSourceMap:  false,
    vlcqSourceMap: false,
    splitRuntime: false,
    dryRun:       false,
    noWrite:      false,
    // 浏览器专属
    dbName:       '',
    storeName:    '',
    noIdb:        true,   // 默认禁用 IDB，纯 WS 模式
    wsUrl:        DEFAULT_WS_URL,
    wsSab:        true,   // 默认启用 SAB 模式
    minify:       false,
    deferredLoad: false,
    // 运行选项
    analyses:     [],
    initParams:   [],   // [{ key: '', value: '' }, ...]
});

// ── JalangiConfig 粒度控制 ────────────────────────────────────────────────
const configMode = ref('full');  // 'full' | 'custom'

const configKeys = [
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

const configDesc = {
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

// 初始化全开
const jalangiConfig = reactive(
    Object.fromEntries(configKeys.map(k => [k, true]))
);

function selectAllConfig() {
    for (const k of configKeys) jalangiConfig[k] = true;
}
function clearAllConfig() {
    for (const k of configKeys) jalangiConfig[k] = false;
}

// 构建 config 对象（传给后端）
function buildConfig() {
    if (configMode.value === 'full') return null;
    const cfg = {};
    for (const k of configKeys) {
        cfg[k] = jalangiConfig[k];
    }
    return cfg;
}

// ── analysis / init-param 动态列表 ─────────────────────────────────────────
function addAnalysis() {
    options.analyses.push('');
}
function removeAnalysis(idx) {
    options.analyses.splice(idx, 1);
}
function addInitParam() {
    options.initParams.push({ key: '', value: '' });
}
function removeInitParam(idx) {
    options.initParams.splice(idx, 1);
}

// ── 计算属性 ─────────────────────────────────────────────────────────────────
let ws = null;

const lineCount = computed(() => code.value ? code.value.split('\n').length : 0);
const byteCount = computed(() => new TextEncoder().encode(code.value).length);

// ── 加载文件 ─────────────────────────────────────────────────────────────────
function loadFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    filename.value = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => { code.value = ev.target.result; };
    reader.readAsText(file);
}

function clearCode() {
    code.value = '';
    instrumentedCode.value = '';
    smapInfo.value = null;
    instrumentError.value = '';
}

// ── source-type 自动识别 ──────────────────────────────────────────────────────
// 简单启发：包含顶层 import/export 语句则认为是 module
function detectSourceType(src) {
    // 去掉字符串和注释后检测，简化处理：直接正则粗判
    return /^\s*(import\s|export\s)/m.test(src) ? 'module' : 'script';
}

// ── 构建请求体选项 ────────────────────────────────────────────────────────────
function buildRequestOptions() {
    const resolvedSourceType = options.sourceType === 'auto'
        ? detectSourceType(code.value)
        : options.sourceType;

    return {
        // 基础
        sandboxVar:    options.sandboxVar,
        sourceType:    resolvedSourceType,
        target:        options.target,
        randomVar:     options.randomVar,
        debug:         options.debug,
        // 输出
        inlineIid:     options.inlineIid,
        inlineSource:  options.inlineSource,
        noSourceMap:   options.noSourceMap,
        vlcqSourceMap: options.vlcqSourceMap,
        splitRuntime:  options.splitRuntime,
        dryRun:        options.dryRun,
        noWrite:       options.noWrite,
        // 浏览器专属（只在 browser 模式有意义，后端自行判断）
        dbName:        options.dbName || undefined,
        storeName:     options.storeName || undefined,
        noIdb:         options.noIdb,
        wsUrl:         options.wsUrl || undefined,
        wsSab:         options.wsSab,
        minify:        options.minify,
        deferredLoad:  options.deferredLoad,
        // 运行
        analyses:      options.analyses.filter(a => a.trim()),
        initParams:    options.initParams
            .filter(p => p.key.trim())
            .map(p => `${p.key.trim()}:${p.value}`),
        // Config 粒度控制
        jalangiConfig: buildConfig(),
    };
}

// ── 插桩 ────────────────────────────────────────────────────────────────────
async function doInstrument() {
    if (!code.value) return;
    instrumenting.value = true;
    instrumentError.value = '';
    instrumentedCode.value = '';
    smapInfo.value = null;

    try {
        const res = await fetch('/api/instrument', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: code.value,
                filename: filename.value,
                options: buildRequestOptions(),
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.stderr || `HTTP ${res.status}`);

        instrumentedCode.value = data.instrumentedCode || '';
        smapInfo.value = data.smapJson ? { iidCount: data.iidCount, smapJson: data.smapJson } : null;

    } catch (e) {
        instrumentError.value = e.message;
    } finally {
        instrumenting.value = false;
    }
}

// ── 服务端运行 ───────────────────────────────────────────────────────────────
async function doRun() {
    if (!code.value) return;
    running.value = true;
    runLog.value = [];
    runStatus.value = 'running';
    runError.value = '';
    completedSessionId.value = '';

    try {
        const res = await fetch('/api/instrument/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: code.value,
                filename: filename.value,
                options: { ...buildRequestOptions(), executionTrace: true },
                env: env.value,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const runId = data.runId;
        connectRunWs(runId);

    } catch (e) {
        runError.value = e.message;
        running.value = false;
        runStatus.value = 'failed';
    }
}

// ── WebSocket 订阅运行输出 ────────────────────────────────────────────────────
function connectRunWs(runId) {
    if (ws) { ws.onclose = null; ws.close(); }

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/instrument/run/${runId}`;
    ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'stdout') {
            appendLog('stdout', msg.data);
        } else if (msg.type === 'stderr') {
            appendLog('stderr', msg.data);
        } else if (msg.type === 'done') {
            runStatus.value = msg.exitCode === 0 ? 'done' : 'failed';
            running.value = false;
            if (msg.sessionId) {
                completedSessionId.value = msg.sessionId;
                appendLog('info', `\n✅ 已创建分析会话: ${msg.sessionId}`);
            }
        } else if (msg.type === 'error') {
            runError.value = msg.message;
            runStatus.value = 'failed';
            running.value = false;
        }
    };

    ws.onerror = () => {
        runError.value = 'WebSocket 连接失败';
        running.value = false;
    };
}

function appendLog(type, data) {
    const lines = data.split('\n');
    for (const line of lines) {
        runLog.value.push({ type, data: line });
    }
    nextTick(() => {
        if (consoleEl.value) {
            consoleEl.value.scrollTop = consoleEl.value.scrollHeight;
        }
    });
}

function clearLog() {
    runLog.value = [];
    runStatus.value = '';
    completedSessionId.value = '';
}

// ── 下载 ─────────────────────────────────────────────────────────────────────
function downloadInstrumented() {
    download(instrumentedCode.value, filename.value.replace(/\.js$/, '') + '_jalangi_.js', 'text/javascript');
}

function downloadSmap() {
    if (smapInfo.value?.smapJson) {
        download(JSON.stringify(smapInfo.value.smapJson, null, 2), filename.value.replace(/\.js$/, '') + '.smap.json', 'application/json');
    }
}

function download(content, name, type) {
    const blob = new Blob([content], { type });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

onUnmounted(() => {
    if (ws) { ws.onclose = null; ws.close(); }
});
</script>

<style scoped>
.studio-header {
    margin-bottom: 20px;
}
.page-title {
    font-size: 22px;
    font-weight: 700;
}
.page-subtitle {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 4px;
}

/* 主体分屏 */
.studio-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 16px;
}

.panel {
    display: flex;
    flex-direction: column;
    min-height: 400px;
    padding: 0;
    overflow: hidden;
}

.panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color);
}

.panel-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
}

.panel-actions { display: flex; gap: 6px; align-items: center; }

.smap-stat {
    font-size: 12px;
    color: var(--success);
    font-family: monospace;
}

.btn-copy {
    transition: all 0.15s;
}
.btn-copy-ok {
    color: var(--success) !important;
    border-color: rgba(34, 197, 94, 0.4) !important;
    background: rgba(34, 197, 94, 0.08) !important;
}

.code-editor {
    flex: 1;
    background: var(--bg-primary);
    border: none;
    border-radius: 0;
    color: var(--text-primary);
    font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
    padding: 16px;
    resize: none;
    outline: none;
    min-height: 360px;
    tab-size: 2;
}

.code-readonly { color: var(--text-muted); cursor: default; }

.panel-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-top: 1px solid var(--border-color);
    background: var(--bg-tertiary);
}

.code-stat {
    font-size: 11px;
    color: var(--text-muted);
    font-family: monospace;
}

.filename-input {
    width: 200px;
    padding: 4px 8px;
    font-size: 12px;
}

.panel-loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}

.panel-error {
    padding: 8px 16px;
    color: var(--danger);
    font-size: 12px;
    background: rgba(239,68,68,0.08);
}

/* 选项面板 */
.options-panel {
    margin-bottom: 16px;
    padding: 0;
    overflow: hidden;
}

.options-panel-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border-color);
}

/* 折叠区块 */
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

/* Config 粒度控制 */
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

/* 运行选项 */
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

/* 操作按钮 */
.action-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
    align-items: center;
    flex-wrap: wrap;
}

.btn-action {
    padding: 8px 20px;
    font-size: 13px;
}

.btn-run {
    background: linear-gradient(135deg, #22c55e, #16a34a);
    color: #fff;
    display: flex;
    align-items: center;
    gap: 6px;
}
.btn-run:hover { opacity: 0.9; }
.btn-run:disabled { opacity: 0.5; cursor: not-allowed; }

.running-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #fff;
    animation: pulse 1s infinite;
}

.btn-sm {
    padding: 4px 10px;
    font-size: 12px;
}

.btn-xs {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    transition: background 0.15s;
}
.btn-xs:hover {
    background: var(--bg-secondary);
}

.btn-danger {
    background: rgba(239,68,68,0.12);
    color: #f87171;
    border-color: rgba(239,68,68,0.25);
}
.btn-danger:hover {
    background: rgba(239,68,68,0.22);
}

/* 运行输出控制台 */
.console-panel {
    margin-bottom: 16px;
    padding: 0;
    overflow: hidden;
}

.console-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-color);
}

.console-title {
    font-size: 13px;
    font-weight: 600;
}

.console-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

.run-status {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
}
.run-status-running { background: rgba(59,130,246,0.15); color: #60a5fa; }
.run-status-done    { background: rgba(34,197,94,0.15);  color: #4ade80; }
.run-status-failed  { background: rgba(239,68,68,0.15);  color: #f87171; }

.console-body {
    background: #0a0c10;
    padding: 12px 16px;
    min-height: 120px;
    max-height: 320px;
    overflow-y: auto;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
}

.log-line { white-space: pre-wrap; word-break: break-all; }
.log-stdout { color: #e2e8f0; }
.log-stderr { color: #f87171; }
.log-info   { color: #60a5fa; }
.log-error  { color: #f87171; font-weight: 600; }

.run-complete {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: rgba(34,197,94,0.08);
    border-top: 1px solid rgba(34,197,94,0.2);
    font-size: 13px;
    color: var(--success);
}

.run-error {
    padding: 12px 16px;
    color: var(--danger);
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.2);
}
</style>