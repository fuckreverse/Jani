<template>
  <teleport to="body">
    <transition name="vv-fade">
      <div v-if="visible" class="vv-overlay" @click.self="close">
        <div class="vv-modal">
          <!-- 头部 -->
          <div class="vv-header">
            <div class="vv-title">
              <span class="vv-icon">🔍</span>
              <span v-if="label" class="vv-label">{{ label }}</span>
              <span class="vv-type-badge" :class="`vv-type-${valueType}`">{{ valueType }}</span>
              <!-- 编码类型徽章（字符串时显示） -->
              <span
                v-if="valueType === 'string' && detectedEncoding"
                class="vv-enc-badge"
                :class="`vv-enc-${detectedEncoding}`"
                :title="ENC_DESC[detectedEncoding]"
              >{{ detectedEncoding }}</span>
            </div>
            <div class="vv-header-actions">
              <button class="vv-btn-copy" :class="{ copied: copied }" @click="copyValue" title="复制到剪贴板">
                {{ copied ? '✓ 已复制' : '📋 复制' }}
              </button>
              <button class="vv-close" @click="close" title="关闭 (Esc)">✕</button>
            </div>
          </div>

          <!-- 内容区 -->
          <div class="vv-body">
            <!-- JSON 对象/数组：格式化展示 -->
            <div v-if="valueType === 'object' || valueType === 'array'" class="vv-json-wrap">
              <div class="vv-view-tabs">
                <button
                  class="vv-view-tab"
                  :class="{ 'vv-view-tab-active': viewMode === 'pretty' }"
                  @click="viewMode = 'pretty'"
                >格式化</button>
                <button
                  class="vv-view-tab"
                  :class="{ 'vv-view-tab-active': viewMode === 'raw' }"
                  @click="viewMode = 'raw'"
                >原始</button>
              </div>
              <pre v-if="viewMode === 'pretty'" class="vv-pre">{{ prettyJson }}</pre>
              <pre v-else class="vv-pre vv-pre-raw">{{ rawString }}</pre>
            </div>

            <!-- 字符串：带解码 Tab -->
            <div v-else-if="valueType === 'string'" class="vv-string-wrap">
              <!-- Tab 栏 -->
              <div class="vv-view-tabs">
                <button
                  class="vv-view-tab"
                  :class="{ 'vv-view-tab-active': strTab === 'raw' }"
                  @click="strTab = 'raw'"
                >原始</button>
                <button
                  v-for="enc in decodableTabs"
                  :key="enc"
                  class="vv-view-tab vv-view-tab-decode"
                  :class="{ 'vv-view-tab-active': strTab === enc }"
                  @click="strTab = enc"
                  :title="ENC_DESC[enc]"
                >🔓 {{ ENC_LABEL[enc] }}</button>
              </div>

              <!-- 元信息栏 -->
              <div class="vv-string-meta">
                <span>长度: {{ stringLength }} 字符</span>
                <template v-if="strTab !== 'raw' && decodeResult(strTab)">
                  <span class="vv-meta-sep">·</span>
                  <span :class="decodeResult(strTab).ok ? 'vv-meta-ok' : 'vv-meta-err'">
                    {{ decodeResult(strTab).ok
                      ? `解码后 ${decodeResult(strTab).value.length} 字符`
                      : decodeResult(strTab).error }}
                  </span>
                </template>
              </div>

              <!-- 原始视图 -->
              <pre v-if="strTab === 'raw'" class="vv-pre vv-pre-string">{{ rawString }}</pre>

              <!-- 解码视图 -->
              <template v-else>
                <div v-if="!decodeResult(strTab)" class="vv-decode-placeholder">
                  <span class="vv-spinner"></span> 解码中…
                </div>
                <div v-else-if="!decodeResult(strTab).ok" class="vv-decode-error">
                  ⚠️ {{ decodeResult(strTab).error }}
                </div>
                <template v-else>
                  <!-- 解码结果是 JSON：提供格式化/原始子视图 -->
                  <div v-if="decodeResult(strTab).isJson" class="vv-json-wrap">
                    <div class="vv-view-tabs">
                      <button
                        class="vv-view-tab"
                        :class="{ 'vv-view-tab-active': decodeViewMode(strTab) === 'pretty' }"
                        @click="setDecodeViewMode(strTab, 'pretty')"
                      >格式化</button>
                      <button
                        class="vv-view-tab"
                        :class="{ 'vv-view-tab-active': decodeViewMode(strTab) === 'raw' }"
                        @click="setDecodeViewMode(strTab, 'raw')"
                      >原始文本</button>
                    </div>
                    <pre class="vv-pre">{{ decodeViewMode(strTab) === 'pretty'
                      ? decodeResult(strTab).prettyJson
                      : decodeResult(strTab).value }}</pre>
                  </div>
                  <!-- 解码结果是纯文本 -->
                  <pre v-else class="vv-pre vv-pre-decoded">{{ decodeResult(strTab).value }}</pre>
                </template>
              </template>
            </div>

            <!-- 数值型时间戳：额外展示格式化时间 -->
            <div v-else-if="valueType === 'number' && tsFormatted" class="vv-primitive-wrap">
              <div class="vv-string-meta">
                <span>原始值: {{ rawString }}</span>
                <span class="vv-meta-sep">·</span>
                <span class="vv-meta-ok">{{ rawString.length >= 13 ? '毫秒级' : '秒级' }}</span>
              </div>
              <div class="vv-ts-display">
                <div class="vv-ts-main">{{ tsFormatted }}</div>
                <div class="vv-ts-sub">{{ rawString }}</div>
              </div>
            </div>

            <!-- 其他基础类型 -->
            <div v-else class="vv-primitive-wrap">
              <pre class="vv-pre vv-pre-primitive">{{ rawString }}</pre>
            </div>
          </div>

          <!-- 底部 -->
          <div class="vv-footer">
            <span class="vv-meta">字符数: {{ rawString.length }}</span>
            <span v-if="valueType === 'string'" class="vv-meta">字符串长度: {{ stringLength }}</span>
            <span v-if="strTab !== 'raw'" class="vv-meta vv-meta-tab">
              当前视图: {{ ENC_LABEL[strTab] ?? strTab }}
            </span>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { ref, computed, watch, reactive, onMounted, onUnmounted } from 'vue';
import { valueViewerState } from '../composables/useValueViewer.js';

const visible  = ref(false);
const copied   = ref(false);
const viewMode = ref('pretty');
const strTab   = ref('raw');

// 每个解码视图的子视图模式（'pretty' | 'raw'），key = enc
const decodeSubMode = reactive({});

const label = computed(() => valueViewerState.label);
const value = computed(() => valueViewerState.value);

// ─── 编码类型元数据 ────────────────────────────────────────────────────────────

const ENC_LABEL = {
    base64:    'Base64',
    base64url: 'Base64URL',
    hex:       'Hex',
    url:       'URL',
    unicode:   'Unicode',
    jwt:       'JWT',
};

const ENC_DESC = {
    base64:    '将 Base64 编码字符串解码为原始内容',
    base64url: '将 URL-safe Base64 字符串解码为原始内容',
    hex:       '将十六进制字符串解码为 UTF-8 文本',
    url:       '将 URL 编码（%xx）字符串解码',
    unicode:   '将 \\uXXXX 转义序列解码为可读字符',
    jwt:       '解析 JWT token 的 header 和 payload',
};

// ─── 编码检测 ──────────────────────────────────────────────────────────────────

const RE_BASE64     = /^[A-Za-z0-9+/]{4,}={0,2}$/;
const RE_BASE64_URL = /^[A-Za-z0-9_-]{4,}={0,2}$/;
const RE_HEX        = /^[0-9a-fA-F]+$/;
const RE_URL_ENC    = /%[0-9A-Fa-f]{2}/;
const RE_UNICODE    = /\\u[0-9a-fA-F]{4}/;
const RE_JWT        = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function detectEncodings(str) {
    if (!str || typeof str !== 'string') return [];
    const s = str.trim();
    const result = [];

    // JWT 优先（三段式，否则会被误判为 base64url）
    if (RE_JWT.test(s) && s.split('.').length === 3) {
        result.push('jwt');
        return result;
    }

    // URL encoded（含 %xx）
    if (RE_URL_ENC.test(s)) result.push('url');

    // Unicode 转义（含 \uXXXX）
    if (RE_UNICODE.test(s)) result.push('unicode');

    // Hex（偶数长度 ≥ 8，全十六进制字符）
    if (s.length >= 8 && s.length % 2 === 0 && RE_HEX.test(s)) result.push('hex');

    // Base64URL（含 - 或 _，不含 + /）
    if (
        s.length >= 8 &&
        !result.includes('hex') &&
        RE_BASE64_URL.test(s) &&
        (s.includes('-') || s.includes('_'))
    ) {
        result.push('base64url');
    }

    // 标准 Base64（长度 mod4 = 0）
    if (
        s.length >= 8 &&
        !result.includes('hex') &&
        !result.includes('base64url') &&
        RE_BASE64.test(s) &&
        s.length % 4 === 0
    ) {
        result.push('base64');
    }

    return result;
}

const decodableTabs = computed(() => {
    if (valueType.value !== 'string') return [];
    const v = value.value;
    if (typeof v !== 'string') return [];
    return detectEncodings(v.trim());
});

// 头部徽章用：第一个检测到的编码
const detectedEncoding = computed(() => decodableTabs.value[0] ?? null);

// ─── 解码逻辑 ──────────────────────────────────────────────────────────────────

const decodeCache = reactive({});

function doDecode(enc, raw) {
    try {
        let decoded = '';

        if (enc === 'base64') {
            decoded = atob(raw.trim().replace(/\s/g, ''));
            // atob 返回 latin1，尝试 UTF-8 解读
            try {
                const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
                decoded = new TextDecoder('utf-8').decode(bytes);
            } catch { /* 保持 latin1 */ }

        } else if (enc === 'base64url') {
            let std = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
            while (std.length % 4 !== 0) std += '=';
            decoded = atob(std);
            try {
                const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
                decoded = new TextDecoder('utf-8').decode(bytes);
            } catch { /* keep */ }

        } else if (enc === 'hex') {
            const hexStr = raw.trim().replace(/\s+/g, '').toLowerCase();
            const bytes = [];
            for (let i = 0; i + 1 < hexStr.length; i += 2) {
                bytes.push(parseInt(hexStr.slice(i, i + 2), 16));
            }
            try {
                decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
            } catch {
                decoded = bytes.map(b => String.fromCharCode(b)).join('');
            }

        } else if (enc === 'url') {
            try { decoded = decodeURIComponent(raw); }
            catch { decoded = unescape(raw); }

        } else if (enc === 'unicode') {
            decoded = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
                String.fromCharCode(parseInt(code, 16))
            );

        } else if (enc === 'jwt') {
            const parts = raw.trim().split('.');
            const decodeB64u = (s) => {
                let std = s.replace(/-/g, '+').replace(/_/g, '/');
                while (std.length % 4 !== 0) std += '=';
                const bin = atob(std);
                try {
                    return new TextDecoder('utf-8').decode(
                        Uint8Array.from(bin, c => c.charCodeAt(0))
                    );
                } catch { return bin; }
            };
            const header  = JSON.parse(decodeB64u(parts[0]));
            const payload = JSON.parse(decodeB64u(parts[1]));
            decoded = JSON.stringify({ header, payload, signature: parts[2] }, null, 2);
        }

        // 检测解码结果是否是 JSON（JWT 结果本身已是 JSON）
        let isJson = false;
        let prettyJson = '';
        if (enc === 'jwt') {
            isJson = true;
            prettyJson = decoded;
        } else {
            const t = decoded.trimStart();
            if (
                (t.startsWith('{') && decoded.trimEnd().endsWith('}')) ||
                (t.startsWith('[') && decoded.trimEnd().endsWith(']'))
            ) {
                try {
                    prettyJson = JSON.stringify(JSON.parse(decoded), null, 2);
                    isJson = true;
                } catch { /* not JSON */ }
            }
        }

        return { ok: true, value: decoded, isJson, prettyJson };
    } catch (e) {
        return { ok: false, error: `${ENC_LABEL[enc] ?? enc} 解码失败: ${e.message}`, value: '', isJson: false };
    }
}

function decodeResult(enc) {
    if (!enc || enc === 'raw') return null;
    if (decodeCache[enc] !== undefined) return decodeCache[enc];
    const raw = typeof value.value === 'string' ? value.value : rawString.value;
    const result = doDecode(enc, raw);
    decodeCache[enc] = result;
    return result;
}

function decodeViewMode(enc) {
    return decodeSubMode[enc] ?? 'pretty';
}

function setDecodeViewMode(enc, mode) {
    decodeSubMode[enc] = mode;
}

// ─── 值类型和字符串工具 ───────────────────────────────────────────────────────

const valueType = computed(() => {
    const v = value.value;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return 'array';
    return typeof v;
});

const rawString = computed(() => {
    const v = value.value;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
});

const prettyJson = computed(() => {
    const v = value.value;
    if (v === null || v === undefined) return String(v);
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
});

const stringLength = computed(() => {
    const v = value.value;
    if (typeof v === 'string') return v.length;
    return rawString.value.length;
});

// 时间戳格式化：仅当值是数值型且落在合理时间范围内（当前时间 ±50 年）时生效
const tsFormatted = computed(() => {
    const v = value.value;
    if (typeof v !== 'number' || !isFinite(v)) return null;
    const now = Date.now();
    const rangeMs = 50 * 365.25 * 24 * 3600 * 1000;
    // 判断是秒级还是毫秒级（13 位为毫秒）
    const ms = v > 1e12 ? v : v * 1000;
    if (ms < now - rangeMs || ms > now + rangeMs) return null;
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        }).format(new Date(ms));
    } catch {
        return null;
    }
});

// ─── 弹窗开关 ─────────────────────────────────────────────────────────────────

watch(() => valueViewerState.openCount, (n) => {
    if (n > 0) {
        visible.value  = true;
        viewMode.value = 'pretty';
        strTab.value   = 'raw';
        copied.value   = false;
        // 清空解码缓存和子视图模式
        Object.keys(decodeCache).forEach(k => delete decodeCache[k]);
        Object.keys(decodeSubMode).forEach(k => delete decodeSubMode[k]);
    }
});

watch(() => valueViewerState.closeCount, () => {
    visible.value = false;
});

function close() {
    visible.value = false;
}

async function copyValue() {
    // 在解码 Tab 时复制解码后的内容
    const textToCopy = (strTab.value !== 'raw' && decodeResult(strTab.value)?.ok)
        ? decodeResult(strTab.value).value
        : rawString.value;
    try {
        await navigator.clipboard.writeText(textToCopy);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
    } catch {
        const el = document.createElement('textarea');
        el.value = textToCopy;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
    }
}

function onKeydown(e) {
    if (e.key === 'Escape' && visible.value) close();
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<style scoped>
.vv-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0, 0, 0, 0.65);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
}

.vv-modal {
    background: var(--bg-secondary, #1a1d2e);
    border: 1px solid var(--border-color, #2d3148);
    border-radius: 12px;
    width: min(720px, 90vw);
    max-height: 80vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    overflow: hidden;
}

/* ── 头部 ── */
.vv-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
    gap: 8px;
}
.vv-title {
    display: flex; align-items: center; gap: 8px;
    min-width: 0; flex: 1;
}
.vv-icon { font-size: 14px; flex-shrink: 0; }
.vv-label {
    font-family: monospace; font-size: 13px; font-weight: 600;
    color: #a5b4fc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 300px;
}
.vv-type-badge {
    flex-shrink: 0; padding: 1px 7px; border-radius: 10px;
    font-size: 11px; font-weight: 600; font-family: monospace;
}
.vv-type-string    { background: rgba(34,197,94,0.15);   color: #86efac; }
.vv-type-number    { background: rgba(245,158,11,0.15);  color: #fcd34d; }
.vv-type-boolean   { background: rgba(99,102,241,0.15);  color: #a5b4fc; }
.vv-type-object    { background: rgba(59,130,246,0.15);  color: #93c5fd; }
.vv-type-array     { background: rgba(168,85,247,0.15);  color: #d8b4fe; }
.vv-type-null      { background: rgba(248,113,113,0.15); color: #f87171; }
.vv-type-undefined { background: rgba(107,114,128,0.15); color: #9ca3af; }

/* 编码徽章（头部，标识检测到的主要编码类型） */
.vv-enc-badge {
    flex-shrink: 0; padding: 1px 7px; border-radius: 10px;
    font-size: 10px; font-weight: 600; font-family: monospace;
    letter-spacing: 0.03em;
}
.vv-enc-base64, .vv-enc-base64url {
    background: rgba(16,185,129,0.15); color: #6ee7b7;
    border: 1px solid rgba(16,185,129,0.25);
}
.vv-enc-hex {
    background: rgba(139,92,246,0.15); color: #c4b5fd;
    border: 1px solid rgba(139,92,246,0.25);
}
.vv-enc-url {
    background: rgba(59,130,246,0.15); color: #93c5fd;
    border: 1px solid rgba(59,130,246,0.25);
}
.vv-enc-unicode {
    background: rgba(245,158,11,0.15); color: #fde68a;
    border: 1px solid rgba(245,158,11,0.25);
}
.vv-enc-jwt {
    background: rgba(236,72,153,0.15); color: #f9a8d4;
    border: 1px solid rgba(236,72,153,0.25);
}

.vv-header-actions {
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.vv-btn-copy {
    padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer;
    background: rgba(99,102,241,0.12); color: #a5b4fc;
    border: 1px solid rgba(99,102,241,0.3);
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
}
.vv-btn-copy:hover { background: rgba(99,102,241,0.25); }
.vv-btn-copy.copied { background: rgba(34,197,94,0.15); color: #86efac; border-color: rgba(34,197,94,0.3); }
.vv-close {
    width: 26px; height: 26px; border-radius: 5px;
    background: none; border: none; color: var(--text-muted, #6b7280);
    font-size: 13px; cursor: pointer; transition: background 0.15s, color 0.15s;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.vv-close:hover { background: rgba(248,113,113,0.12); color: #f87171; }

/* ── 内容区 ── */
.vv-body {
    flex: 1; overflow: hidden; display: flex; flex-direction: column;
    min-height: 0;
}

/* Tab 栏 */
.vv-view-tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
    overflow-x: auto;
}
.vv-view-tab {
    padding: 5px 14px; font-size: 11px; background: transparent;
    border: none; border-right: 1px solid var(--border-color, #2d3148);
    color: var(--text-muted, #6b7280); cursor: pointer;
    transition: background 0.1s, color 0.1s;
    white-space: nowrap; flex-shrink: 0;
}
.vv-view-tab:hover { background: var(--bg-tertiary, #262938); color: var(--text-primary, #e2e8f0); }
.vv-view-tab-active {
    background: rgba(99,102,241,0.12) !important;
    color: #a5b4fc !important; font-weight: 600;
}
/* 解码 Tab — 青绿色调区分 */
.vv-view-tab-decode { color: rgba(110,231,183,0.65); }
.vv-view-tab-decode:hover { color: #6ee7b7; }
.vv-view-tab-decode.vv-view-tab-active {
    background: rgba(16,185,129,0.1) !important;
    color: #6ee7b7 !important;
}

.vv-json-wrap, .vv-string-wrap, .vv-primitive-wrap {
    display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;
}

/* 元信息栏 */
.vv-string-meta {
    padding: 4px 16px; font-size: 11px; color: var(--text-muted, #6b7280);
    border-bottom: 1px solid var(--border-color, #2d3148);
    flex-shrink: 0;
    background: var(--bg-tertiary, #1e2130);
    display: flex; align-items: center; gap: 6px;
}
.vv-meta-sep { color: var(--border-color, #2d3148); }
.vv-meta-ok  { color: #6ee7b7; }
.vv-meta-err { color: #f87171; }

/* 代码区 */
.vv-pre {
    flex: 1; overflow: auto; margin: 0;
    padding: 16px;
    font-family: 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace;
    font-size: 12px; line-height: 1.6;
    color: var(--text-primary, #e2e8f0);
    background: var(--bg-primary, #0f1117);
    white-space: pre-wrap; word-break: break-all;
}
.vv-pre-string  { color: #86efac; background: rgba(34,197,94,0.04); }
.vv-pre-decoded { color: #6ee7b7; background: rgba(16,185,129,0.04); }
.vv-pre-primitive {
    color: #fcd34d; padding: 24px; font-size: 16px;
    text-align: center; background: var(--bg-primary, #0f1117);
}

/* 时间戳格式化展示区 */
.vv-ts-display {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px;
    background: var(--bg-primary, #0f1117);
    padding: 32px 24px;
}
.vv-ts-main {
    font-size: 28px; font-weight: 700; letter-spacing: 0.02em;
    color: #fde68a; font-family: 'Fira Code', Consolas, monospace;
}
.vv-ts-sub {
    font-size: 13px; color: var(--text-muted, #6b7280);
    font-family: monospace;
}

/* 解码中占位 */
.vv-decode-placeholder {
    flex: 1; display: flex; align-items: center; justify-content: center;
    gap: 8px; color: var(--text-muted, #6b7280); font-size: 13px;
}
.vv-spinner {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid rgba(99,102,241,0.3); border-top-color: #a5b4fc;
    border-radius: 50%; animation: vv-spin 0.7s linear infinite;
}
@keyframes vv-spin { to { transform: rotate(360deg); } }

/* 解码失败 */
.vv-decode-error {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #f87171; font-size: 12px; padding: 24px;
}

/* ── 底部 ── */
.vv-footer {
    padding: 7px 16px;
    border-top: 1px solid var(--border-color, #2d3148);
    display: flex; gap: 16px; flex-shrink: 0;
    background: var(--bg-tertiary, #1e2130);
}
.vv-meta { font-size: 11px; color: var(--text-muted, #6b7280); }
.vv-meta-tab { color: #6ee7b7; }

/* ── 动画 ── */
.vv-fade-enter-active { transition: opacity 0.15s ease; }
.vv-fade-leave-active { transition: opacity 0.12s ease; }
.vv-fade-enter-from, .vv-fade-leave-to { opacity: 0; }
</style>
