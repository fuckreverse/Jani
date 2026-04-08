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
          <span v-if="preprocessedCode" class="preprocess-indicator" title="实际插桩的是预处理后的代码">⚙ 已预处理</span>
          <div class="panel-actions">
            <span v-if="smapInfo" class="smap-stat">{{ smapInfo.iidCount }} iids</span>
            <span v-if="instrumentedCode" class="smap-stat">{{ formatBytes(new TextEncoder().encode(instrumentedCode).length) }}</span>
            <span v-if="smapInfo?.smapJson" class="smap-stat">smap {{ formatBytes(JSON.stringify(smapInfo.smapJson).length) }}</span>
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

    <!-- 预处理选项（可选，启用后插桩前先对源码做 AST 变换） -->
    <PreprocessOptions ref="preprocessRef" />

    <!-- 插桩选项（复用 InstrumentOptions 组件） -->
    <!-- 执行环境选项单独保留在此，因为它是 InstrumentStudio 专属的（工作空间不需要） -->
    <div class="env-bar card">
      <span class="env-label">执行环境 (env)</span>
      <select v-model="env" style="width:120px">
        <option value="node">Node.js</option>
        <option value="jsdom">JSDOM</option>
      </select>
    </div>
    <InstrumentOptions ref="optionsRef" />

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
      <button v-if="preprocessedCode" class="btn-secondary btn-action" @click="downloadPreprocessed">
        ⬇ 下载预处理代码
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
import { ref, computed, nextTick, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import InstrumentOptions from './InstrumentOptions.vue';
import PreprocessOptions from './PreprocessOptions.vue';

const router = useRouter();

const code             = ref('');
const filename         = ref('script.js');
const instrumentedCode = ref('');
const instrumenting    = ref(false);
const instrumentError  = ref('');
const smapInfo         = ref(null);  // { iidCount, smapJson }
const preprocessedCode = ref(null);  // 预处理后的代码（可为 null表示未启用预处理）
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

const env           = ref('node');
const optionsRef    = ref(null);  // InstrumentOptions 组件引用
const preprocessRef = ref(null);  // PreprocessOptions 组件引用

// ── 计算属性 ─────────────────────────────────────────────────────────────────
let ws = null;
// optionsRef.buildOptions(sourceCode) 由 InstrumentOptions 组件提供

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
    preprocessedCode.value = null;
}

// ── 构建请求体选项（委托给 InstrumentOptions 组件）────────────────────────────
function buildRequestOptions() {
    return optionsRef.value?.buildOptions(code.value) ?? {};
}

// ── 插桩 ────────────────────────────────────────────────────────────────────
async function doInstrument() {
    if (!code.value) return;
    instrumenting.value = true;
    instrumentError.value = '';
    instrumentedCode.value = '';
    smapInfo.value = null;
    preprocessedCode.value = null;

    try {
        const preprocess = preprocessRef.value?.buildPreprocess() ?? null;

        const res = await fetch('/api/instrument', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code:       code.value,
                filename:   filename.value,
                options:    buildRequestOptions(),
                preprocess: preprocess ?? null,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.stderr || `HTTP ${res.status}`);

        instrumentedCode.value = data.instrumentedCode || '';
        smapInfo.value = data.smapJson ? { iidCount: data.iidCount, smapJson: data.smapJson } : null;
        preprocessedCode.value = data.preprocessedCode ?? null;

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
        const preprocess = preprocessRef.value?.buildPreprocess() ?? null;

        const res = await fetch('/api/instrument/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code:       code.value,
                filename:   filename.value,
                options:    { ...buildRequestOptions(), executionTrace: true },
                env:        env.value,
                preprocess: preprocess ?? null,
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

function downloadPreprocessed() {
    if (!preprocessedCode.value) return;
    download(preprocessedCode.value, filename.value.replace(/\.js$/, '') + '_preprocessed_.js', 'text/javascript');
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

function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

.preprocess-indicator {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: rgba(139, 92, 246, 0.18);
    color: #a78bfa;
    font-family: monospace;
    flex-shrink: 0;
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

/* 执行环境选择条 */
.env-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    margin-bottom: 4px;
}

.env-label {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
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