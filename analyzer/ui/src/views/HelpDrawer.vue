<template>
  <teleport to="body">
    <transition name="drawer-fade">
      <div v-if="visible" class="drawer-overlay" @click.self="$emit('close')">
        <div class="help-drawer">

          <!-- 头部 -->
          <div class="drawer-header">
            <div class="drawer-title-row">
              <span class="drawer-icon">📖</span>
              <div>
                <div class="drawer-title">使用帮助</div>
                <div class="drawer-subtitle">悬停 Tab 按钮可快速预览，这里查看完整说明</div>
              </div>
            </div>
            <button class="drawer-close" @click="$emit('close')">✕</button>
          </div>

          <!-- 快速导航 -->
          <div class="quick-nav">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              class="qnav-btn"
              :class="{ 'qnav-active': activeTab === tab.id }"
              @click="scrollToTab(tab.id)"
            >{{ tab.label }}</button>
          </div>

          <!-- 内容区 -->
          <div class="drawer-content" ref="contentRef">

            <!-- 使用建议入口 -->
            <div class="getting-started card-inner">
              <div class="gs-title">🚀 分析入门建议</div>
              <div class="gs-steps">
                <div class="gs-step">
                  <span class="gs-num">1</span>
                  <div>
                    <strong>先看算法报告</strong>
                    <span>分析完成后，「📝 算法报告」提供整体结论，快速锁定重点方向。</span>
                  </div>
                </div>
                <div class="gs-step">
                  <span class="gs-num">2</span>
                  <div>
                    <strong>混淆代码先看混淆检测</strong>
                    <span>「🕵️ 混淆检测」定位字符串解码器函数，通常是逆向突破口。</span>
                  </div>
                </div>
                <div class="gs-step">
                  <span class="gs-num">3</span>
                  <div>
                    <strong>追踪签名从字符串出发</strong>
                    <span>「🔤 字符串追踪」找到 sign/token 变量，再跳到「✍️ 签名路径」追溯来源。</span>
                  </div>
                </div>
                <div class="gs-step">
                  <span class="gs-num">4</span>
                  <div>
                    <strong>识别算法用值模式+加密检测</strong>
                    <span>两个 Tab 交叉印证，置信度更高。</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 各 Tab 详细说明 -->
            <div
              v-for="tab in tabs"
              :key="tab.id"
              :id="'help-' + tab.id"
              class="tab-help-section"
            >
              <div class="ths-header">
                <span class="ths-label">{{ tab.label }}</span>
                <span v-if="tab.plugin" class="ths-plugin">{{ tab.plugin }}</span>
                <button
                  class="ths-goto"
                  @click="$emit('gotoTab', tab.id)"
                  :class="{ 'ths-goto-active': activeTab === tab.id }"
                >{{ activeTab === tab.id ? '▶ 当前' : '→ 前往' }}</button>
              </div>

              <p class="ths-desc">{{ tab.desc }}</p>

              <div class="ths-block" v-if="tab.capabilities?.length">
                <div class="ths-block-title">⚙️ 功能列表</div>
                <ul class="ths-list">
                  <li v-for="cap in tab.capabilities" :key="cap">{{ cap }}</li>
                </ul>
              </div>

              <div class="ths-block" v-if="tab.tips?.length">
                <div class="ths-block-title">⚡ 使用技巧</div>
                <ul class="ths-list ths-list-tips">
                  <li v-for="tip in tab.tips" :key="tip">{{ tip }}</li>
                </ul>
              </div>

              <!-- 补充说明（各 Tab 特有的详细文字，通过 extraHelp 字段传入） -->
              <div class="ths-block" v-if="extraHelp[tab.id]">
                <div class="ths-block-title">📌 详细说明</div>
                <p class="ths-extra">{{ extraHelp[tab.id] }}</p>
              </div>
            </div>

          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
    visible:   { type: Boolean, default: false },
    tabs:      { type: Array,   default: () => [] },
    activeTab: { type: String,  default: '' },
});

defineEmits(['close', 'gotoTab']);

const contentRef = ref(null);

function scrollToTab(tabId) {
    const el = contentRef.value?.querySelector(`#help-${tabId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 各 Tab 的补充详细说明文字
const extraHelp = {
    overview:    '概览 Tab 在分析进行期间会实时更新插件状态，每个插件完成后状态点从灰变绿。若某插件显示「失败」，可刷新页面或重新触发分析。I4 完成后，算法报告（统计卡片 + 算法标签 + Markdown 报告）会自动出现在概览页底部。',
    events:      '事件流是所有分析的数据基础。每条事件对应一次 JS 运行时操作，SEQ 是唯一序号。通过 SEQ 可以在各 Tab 之间精确定位同一时刻的执行状态。',
    functions:   '函数面板展示的调用次数和事件数来自 F3 插件的调用图数据。热路径（A3）基于事件密度打分，橙色高亮表示该函数是执行热点。点击函数名展开详情面板，可查看该函数所有调用的事件列表。',
    loops:       '循环检测基于 SEQ 范围识别同一代码位置反复执行的模式。若循环迭代次数超过 1000，通常意味着这是一个密集计算型算法（如 AES 轮函数、SHA 压缩函数）。',
    patterns:    '值模式检测器维护了一个包含数百个已知密码学魔术常数的数据库（AES S-Box、SHA 初始哈希值、椭圆曲线参数等）。当运行时出现匹配的数值时会被记录并高亮。',
    crypto:      '加密检测综合三类证据：值模式匹配（魔术常数）、操作特征（大量 XOR/移位/取模）、已知库调用（CryptoJS、forge 等）。三类证据同时出现时置信度最高。',
    signatures:  '签名路径追踪从所有字符串中识别出含「sign」「token」「_sign」「hmac」等关键字的变量，然后沿数据流图向上追溯其来源（source）和向下追踪其去向（sink）。',
    dataflow:    '数据流图记录四种边：assign（直接赋值）、return（函数返回值）、arg（函数参数）、call（调用结果）。通过这些边可以重建变量值的完整传播路径，而无需手动打断点。',
    objmut:      '对象变异追踪器记录所有属性的写入操作（PropertyWrite 事件）。对于 XHR 请求追踪，可以搜索请求对象变量名，找到 headers/body 属性被写入的时刻。',
    obfuscation: '混淆检测综合八个维度：① 短/混淆变量名（_0x... 或 ≤3 字符）② 高熵变量名（Shannon 熵 > 3.5）③ 字符串解密函数（多次调用返回不同字符串，若参数全为整数索引则置信度提升）④ 控制流混淆（CFF/VMP：多值状态变量 + 热点 iid）⑤ 深调用栈（最大深度 ≥ 50，CFF/VMP 的 dispatch 调用特征）⑥ 字符串池（大数组变量只被读取不被写入）⑦ 动态 eval（调用 eval/Function 动态执行代码）⑧ 变量名重用率异常（多作用域复用同一短变量名）。每个维度单独评分，综合加权后得到最终混淆评分。',
    cfg:         '控制流图以 D3.js 力导向图的形式展示函数调用关系。节点大小反映调用频率，橙色表示热点。可通过「深度」参数控制展开层数，避免图形过于复杂。点击节点可查看该函数的基本信息并跳转到函数面板。',
};
</script>

<style scoped>
/* ── 抽屉框架（复用 ProgressDrawer 的动画和遮罩） ─────────────────────────── */
.drawer-overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.45); backdrop-filter: blur(2px);
    display: flex; justify-content: flex-end;
}

.help-drawer {
    width: 480px; max-width: 95vw; height: 100vh;
    background: var(--bg-secondary, #13152a);
    border-left: 1px solid var(--border-color);
    display: flex; flex-direction: column;
    box-shadow: -8px 0 40px rgba(0,0,0,0.5);
    transform: translateX(0); transition: transform 0.25s ease;
}

.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity 0.2s ease; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
.drawer-fade-enter-active .help-drawer { transition: transform 0.25s ease; }
.drawer-fade-enter-from  .help-drawer  { transform: translateX(100%); }
.drawer-fade-leave-active .help-drawer { transition: transform 0.2s ease; }
.drawer-fade-leave-to    .help-drawer  { transform: translateX(100%); }

/* ── 头部 ─────────────────────────────────────────────────────────────────── */
.drawer-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    padding: 20px 20px 16px; border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}
.drawer-title-row { display: flex; gap: 12px; align-items: flex-start; }
.drawer-icon { font-size: 22px; }
.drawer-title { font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px; }
.drawer-subtitle { font-size: 11.5px; color: var(--text-muted); line-height: 1.4; }
.drawer-close {
    background: none; border: none; color: var(--text-muted); font-size: 16px;
    cursor: pointer; padding: 4px 8px; border-radius: 6px; transition: all 0.15s; line-height: 1;
}
.drawer-close:hover { color: var(--text-primary); background: var(--bg-tertiary); }

/* ── 快速导航 ─────────────────────────────────────────────────────────────── */
.quick-nav {
    display: flex; flex-wrap: wrap; gap: 4px;
    padding: 12px 16px; border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}
.qnav-btn {
    padding: 3px 10px; border-radius: 12px; font-size: 11px;
    border: 1px solid var(--border-color); background: transparent;
    color: var(--text-muted); cursor: pointer; transition: all 0.15s;
    white-space: nowrap;
}
.qnav-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.qnav-active { color: #a5b4fc !important; border-color: rgba(99,102,241,0.4) !important; background: rgba(99,102,241,0.1) !important; }

/* ── 内容区 ───────────────────────────────────────────────────────────────── */
.drawer-content {
    flex: 1; overflow-y: auto; padding: 0 0 40px;
    scrollbar-width: thin; scrollbar-color: var(--border-color) transparent;
}

/* ── 入门建议 ─────────────────────────────────────────────────────────────── */
.getting-started {
    margin: 16px; padding: 16px;
    background: rgba(99,102,241,0.06);
    border: 1px solid rgba(99,102,241,0.2); border-radius: 10px;
}
.gs-title { font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 14px; }
.gs-steps { display: flex; flex-direction: column; gap: 10px; }
.gs-step { display: flex; gap: 12px; align-items: flex-start; }
.gs-num {
    width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
    background: rgba(99,102,241,0.3); border: 1px solid rgba(99,102,241,0.5);
    color: #c7d2fe; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
}
.gs-step div { display: flex; flex-direction: column; gap: 2px; }
.gs-step strong { font-size: 12.5px; color: var(--text-primary); }
.gs-step span { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }

/* ── 各 Tab 说明区块 ──────────────────────────────────────────────────────── */
.tab-help-section {
    padding: 16px 20px; border-bottom: 1px solid var(--border-color);
    scroll-margin-top: 10px;
}
.tab-help-section:last-child { border-bottom: none; }

.ths-header {
    display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
}
.ths-label { font-size: 14px; font-weight: 700; color: var(--text-primary); flex: 1; }
.ths-plugin {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.12); border: 1px solid rgba(99,102,241,0.25);
    color: #a5b4fc; white-space: nowrap; flex-shrink: 0;
}
.ths-goto {
    font-size: 11px; padding: 3px 10px; border-radius: 8px;
    border: 1px solid var(--border-color); background: transparent;
    color: var(--text-muted); cursor: pointer; white-space: nowrap;
    transition: all 0.15s; flex-shrink: 0;
}
.ths-goto:hover { color: #a5b4fc; border-color: rgba(99,102,241,0.4); background: rgba(99,102,241,0.1); }
.ths-goto-active { color: #a5b4fc !important; border-color: rgba(99,102,241,0.4) !important; background: rgba(99,102,241,0.12) !important; }

.ths-desc {
    font-size: 12.5px; color: var(--text-secondary); line-height: 1.7;
    margin: 0 0 12px;
}

.ths-block { margin-bottom: 12px; }
.ths-block:last-child { margin-bottom: 0; }
.ths-block-title {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 7px;
}

.ths-list {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 4px;
}
.ths-list li {
    font-size: 12px; color: var(--text-secondary); padding-left: 14px;
    position: relative; line-height: 1.5;
}
.ths-list li::before { content: '·'; position: absolute; left: 4px; color: rgba(99,102,241,0.6); }

.ths-list-tips li::before { content: '⚡'; font-size: 10px; left: 0; color: #fbbf24; }

.ths-extra {
    font-size: 12px; color: var(--text-muted); line-height: 1.7; margin: 0;
    padding: 10px 12px;
    background: var(--bg-tertiary); border-radius: 6px;
    border-left: 2px solid rgba(99,102,241,0.3);
}
</style>
