<template>
  <div class="overview-tab">

    <!-- ── 基础信息 ─────────────────────────────────────────────────────── -->
    <div class="section card">
      <div class="section-title">📋 会话信息</div>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">会话 ID</span>
          <code class="meta-value mono">{{ session.id }}</code>
        </div>

        <div class="meta-item">
          <span class="meta-label">事件总数</span>
          <span class="meta-value highlight">{{ session.event_count?.toLocaleString('zh-CN') ?? '—' }} 条</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">创建时间</span>
          <span class="meta-value">{{ formatDate(session.created_at) }}</span>
        </div>
        <div class="meta-item" v-if="session.updated_at">
          <span class="meta-label">最后更新</span>
          <span class="meta-value">{{ formatDate(session.updated_at) }}</span>
        </div>
        <div class="meta-item" v-if="session.smapCount">
          <span class="meta-label">IID 映射数</span>
          <span class="meta-value">{{ session.smapCount?.toLocaleString('zh-CN') }} 条</span>
        </div>
        <div class="meta-item" v-if="session.fileInfo?.binFile">
          <span class="meta-label">Trace 文件</span>
          <span class="meta-value mono" style="font-size:12px">
            {{ session.fileInfo.binFile.name }}
            <span class="meta-sub" v-if="session.fileInfo.binFile.size != null">{{ formatBytes(session.fileInfo.binFile.size) }}</span>
            <span class="meta-missing" v-if="session.fileInfo.binFile.missing">⚠️ 缺失</span>
          </span>
        </div>
      </div>
    </div>

    <!-- ── 关联工作空间 ───────────────────────────────────────────────────── -->
    <div class="section card project-card" v-if="session.projectInfo">
      <div class="section-title-row">
        <span class="section-title">🏗️ 关联工作空间</span>
        <router-link
          class="btn-goto-project"
          :to="`/workspaces/${session.projectInfo.id}`"
          title="前往工作空间详情页"
        >前往工作空间 →</router-link>
      </div>
      <!-- 项目名称 + 状态 -->
      <div class="project-meta-row">
        <span class="project-name">{{ session.projectInfo.name }}</span>
        <span class="project-status-badge" :class="`proj-status-${session.projectInfo.status}`">
          {{ projectStatusLabel(session.projectInfo.status) }}
        </span>
        <span class="project-iid" v-if="session.projectInfo.iidCount > 0">
          · {{ session.projectInfo.iidCount.toLocaleString('zh-CN') }} 个 IID
        </span>
      </div>
      <!-- 四类文件信息 -->
      <div class="proj-files-grid">
        <!-- 原始源码 -->
        <template v-if="session.projectInfo.source">
          <div class="proj-file-row">
            <span class="proj-file-icon">📄</span>
            <span class="proj-file-label">原始源码</span>
            <code class="proj-file-name">{{ session.projectInfo.source.name }}</code>
            <span class="proj-file-size">{{ formatBytes(session.projectInfo.source.size) }}</span>
            <button class="proj-cp-btn" :class="projCopyClass(projCopyStates[`/api/projects/${session.projectInfo.id}/source`])" @click="copyProjFile(`/api/projects/${session.projectInfo.id}/source`)" :title="projCopyTitle(projCopyStates[`/api/projects/${session.projectInfo.id}/source`])">{{ projCopyIcon(projCopyStates[`/api/projects/${session.projectInfo.id}/source`]) }}</button>
            <a :href="`/api/projects/${session.projectInfo.id}/source`" download class="proj-dl-btn" title="下载原始源码">⬇</a>
          </div>
        </template>
        <!-- 预处理后代码 -->
        <template v-if="session.projectInfo.preprocessed">
          <div class="proj-file-row proj-file-row--preprocess">
            <span class="proj-file-icon">🔧</span>
            <span class="proj-file-label">预处理代码</span>
            <code class="proj-file-name">{{ session.projectInfo.preprocessed.name }}</code>
            <span class="proj-file-size">{{ formatBytes(session.projectInfo.preprocessed.size) }}</span>
            <button class="proj-cp-btn" :class="projCopyClass(projCopyStates[`/api/projects/${session.projectInfo.id}/preprocessed`])" @click="copyProjFile(`/api/projects/${session.projectInfo.id}/preprocessed`)" :title="projCopyTitle(projCopyStates[`/api/projects/${session.projectInfo.id}/preprocessed`])">{{ projCopyIcon(projCopyStates[`/api/projects/${session.projectInfo.id}/preprocessed`]) }}</button>
            <a :href="`/api/projects/${session.projectInfo.id}/preprocessed`" download class="proj-dl-btn" title="下载预处理后代码">⬇</a>
          </div>
        </template>
        <!-- smap -->
        <template v-if="session.projectInfo.smap">
          <div class="proj-file-row proj-file-row--smap">
            <span class="proj-file-icon">🗺️</span>
            <span class="proj-file-label">smap</span>
            <code class="proj-file-name">{{ session.projectInfo.smap.name }}</code>
            <span class="proj-file-size">{{ formatBytes(session.projectInfo.smap.size) }}</span>
            <button class="proj-cp-btn" :class="projCopyClass(projCopyStates[`/api/projects/${session.projectInfo.id}/smap`])" @click="copyProjFile(`/api/projects/${session.projectInfo.id}/smap`)" :title="projCopyTitle(projCopyStates[`/api/projects/${session.projectInfo.id}/smap`])">{{ projCopyIcon(projCopyStates[`/api/projects/${session.projectInfo.id}/smap`]) }}</button>
            <a :href="`/api/projects/${session.projectInfo.id}/smap`" download class="proj-dl-btn" title="下载 smap.json">⬇</a>
          </div>
        </template>
        <!-- 插桩代码 -->
        <template v-if="session.projectInfo.instrumented">
          <div class="proj-file-row proj-file-row--instrumented">
            <span class="proj-file-icon">⚙️</span>
            <span class="proj-file-label">插桩代码</span>
            <code class="proj-file-name">{{ session.projectInfo.instrumented.name }}</code>
            <span class="proj-file-size">{{ formatBytes(session.projectInfo.instrumented.size) }}</span>
            <button class="proj-cp-btn" :class="projCopyClass(projCopyStates[`/api/projects/${session.projectInfo.id}/instrumented`])" @click="copyProjFile(`/api/projects/${session.projectInfo.id}/instrumented`)" :title="projCopyTitle(projCopyStates[`/api/projects/${session.projectInfo.id}/instrumented`])">{{ projCopyIcon(projCopyStates[`/api/projects/${session.projectInfo.id}/instrumented`]) }}</button>
            <a :href="`/api/projects/${session.projectInfo.id}/instrumented`" download class="proj-dl-btn" title="下载插桩后代码">⬇</a>
          </div>
        </template>
        <div v-if="!session.projectInfo.source && !session.projectInfo.preprocessed && !session.projectInfo.smap && !session.projectInfo.instrumented" class="no-files-tip">
          暂无可下载文件
        </div>
      </div>
    </div>


    <!-- ── 分析进度 ─────────────────────────────────────────────────────── -->
    <div class="section card">
      <div class="section-title-row">
        <span class="section-title">🔍 分析进度</span>
        <button class="btn-detail" @click="$emit('openProgress')">详细进度抽屉 ›</button>
      </div>

      <!-- 正在分析时的横幅 -->
      <div v-if="isAnalyzing" class="analyzing-banner">
        <div class="analyzing-bar">
          <div class="analyzing-fill" :style="{ width: inlineProgressPct + '%' }"></div>
        </div>
        <span class="analyzing-text">{{ inlineProgressPct }}% · {{ runningPlugin || '分析中…' }}</span>
      </div>

      <!-- 各阶段耗时汇总卡片 -->
      <div class="phase-duration-row" v-if="phaseDurations.some(p => p.total > 0)">
        <template v-for="p in phaseDurations" :key="p.id">
          <div class="phase-dur-card" v-if="p.total > 0">
            <span class="phase-dur-label">{{ p.label }}</span>
            <span class="phase-dur-value">{{ formatDuration(p.total) }}</span>
            <div class="phase-dur-bar-wrap">
              <div class="phase-dur-bar" :style="{ width: p.pct + '%', background: p.color }"></div>
            </div>
          </div>
        </template>
        <div class="phase-dur-card phase-dur-total" v-if="totalDurationMs > 0">
          <span class="phase-dur-label">总计</span>
          <span class="phase-dur-value total-val">{{ formatDuration(totalDurationMs) }}</span>
        </div>
      </div>

      <!-- 插件列表（可展开） -->
      <div class="plugin-list">
        <div
          v-for="(status, pid) in allPluginStatus"
          :key="pid"
          class="plugin-row-wrap"
        >
          <!-- 插件头行（可点击展开） -->
          <div
            class="plugin-row"
            :class="'plugin-row-' + status"
            @click="toggleExpand(pid)"
          >
            <span class="plugin-dot" :class="'plugin-dot-' + status"></span>
            <span class="plugin-name">{{ pluginLabel(pid) }}</span>
            <!-- 产出摘要徽章（已完成时显示） -->
            <span v-if="status === 'done' && pluginSummaryText(pid)" class="plugin-summary-badge">
              {{ pluginSummaryText(pid) }}
            </span>
            <span class="plugin-badge" :class="'plugin-badge-' + status">{{ statusText(status) }}</span>
            <span class="plugin-duration" v-if="pluginDuration[pid]">
              {{ pluginDuration[pid] >= 1000
                ? (pluginDuration[pid] / 1000).toFixed(1) + 's'
                : pluginDuration[pid] + 'ms' }}
            </span>
            <!-- 展开指示箭头 -->
            <span class="expand-chevron" :class="{ expanded: expandedPlugins.has(pid) }">▸</span>
          </div>

          <!-- 展开详情面板 -->
          <transition name="plugin-expand">
            <div v-if="expandedPlugins.has(pid)" class="plugin-detail-panel">
              <!-- 插件描述 -->
              <div class="plugin-desc-text">{{ PLUGIN_META[pid]?.desc || '' }}</div>

              <!-- 耗时进度条（相对于最慢插件） -->
              <div v-if="pluginDuration[pid]" class="plugin-time-bar-wrap">
                <div class="plugin-time-label">耗时</div>
                <div class="plugin-time-bar-track">
                  <div
                    class="plugin-time-bar-fill"
                    :style="{ width: durationBarPct(pid) + '%', background: phaseColorForPlugin(pid) }"
                  ></div>
                </div>
                <div class="plugin-time-value">{{ formatDuration(pluginDuration[pid]) }}</div>
              </div>

              <!-- 产出统计 -->
              <div v-if="pluginStats?.[pid]" class="plugin-stats-grid">
                <template v-if="pid === 'F1-EventIndex'">
                  <div class="stat-item"><span class="stat-label">事件总数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].eventCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">写入事件</span><span class="stat-val">{{ fmtNum(pluginStats[pid].writeCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">读取事件</span><span class="stat-val">{{ fmtNum(pluginStats[pid].readCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">属性事件</span><span class="stat-val">{{ fmtNum(pluginStats[pid].fieldCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">值字典去重</span><span class="stat-val">{{ fmtNum(pluginStats[pid].valueDictCnt) }} 条</span></div>
                </template>
                <template v-else-if="pid === 'F2-SmapLoader'">
                  <div class="stat-item"><span class="stat-label">IID 映射</span><span class="stat-val">{{ fmtNum(pluginStats[pid].smapCount) }} 条</span></div>
                </template>
                <template v-else-if="pid === 'F3-CallGraphBuilder'">
                  <div class="stat-item"><span class="stat-label">函数数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].fnCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">调用次数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].callCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">最大调用深度</span><span class="stat-val">{{ pluginStats[pid].maxDepth }}</span></div>
                </template>
                <template v-else-if="pid === 'F4-VariableLifetime'">
                  <div class="stat-item"><span class="stat-label">变量数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].varCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">写入次数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].totalWrites) }}</span></div>
                  <div class="stat-item"><span class="stat-label">读取次数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].totalReads) }}</span></div>
                </template>
                <template v-else-if="pid === 'A3-HotPathAnalyzer'">
                  <div class="stat-item"><span class="stat-label">热点 IID 数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].iidCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">最高命中次数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].topHitCount) }}</span></div>
                </template>
                <template v-else-if="pid === 'A5-LoopDetector'">
                  <div class="stat-item"><span class="stat-label">循环数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].loopCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">最大迭代次数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].maxIter) }}</span></div>
                  <div class="stat-item"><span class="stat-label">迭代快照</span><span class="stat-val">{{ fmtNum(pluginStats[pid].iterSnapshots) }} 条</span></div>
                </template>
                <template v-else-if="pid === 'A8-ValuePatternDetector'">
                  <div class="stat-item"><span class="stat-label">值模式数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].patternCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">密码学常数匹配</span><span class="stat-val">{{ fmtNum(pluginStats[pid].cryptoMatchCount) }}</span></div>
                </template>
                <template v-else-if="pid === 'I1-CryptoDetector'">
                  <div class="stat-item"><span class="stat-label">识别算法数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].algCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">最高置信度</span><span class="stat-val">{{ pluginStats[pid].topConf }}%</span></div>
                  <div class="stat-item stat-item-wide" v-if="pluginStats[pid].algorithms?.length">
                    <span class="stat-label">算法标签</span>
                    <span class="stat-val">
                      <span class="algo-tag" v-for="alg in pluginStats[pid].algorithms" :key="alg">{{ alg }}</span>
                    </span>
                  </div>
                </template>
                <template v-else-if="pid === 'I2-SignatureAnalyzer'">
                  <div class="stat-item"><span class="stat-label">签名路径数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].sigCount) }}</span></div>
                  <div class="stat-item stat-item-wide" v-if="pluginStats[pid].fieldNames?.length">
                    <span class="stat-label">签名字段</span>
                    <span class="stat-val">
                      <span class="algo-tag" v-for="f in pluginStats[pid].fieldNames" :key="f">{{ f }}</span>
                    </span>
                  </div>
                </template>
                <template v-else-if="pid === 'A2-DataFlowGraph'">
                  <div class="stat-item"><span class="stat-label">数据流边数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].edgeCount) }}</span></div>
                  <template v-if="pluginStats[pid].edgeTypes?.length">
                    <div class="stat-item" v-for="et in pluginStats[pid].edgeTypes" :key="et.edge_type">
                      <span class="stat-label">{{ et.edge_type }}</span>
                      <span class="stat-val">{{ fmtNum(et.cnt) }}</span>
                    </div>
                  </template>
                </template>
                <template v-else-if="pid === 'A7-ObjectMutationTracker'">
                  <div class="stat-item"><span class="stat-label">追踪对象数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].objCount) }}</span></div>
                  <div class="stat-item"><span class="stat-label">属性变更记录</span><span class="stat-val">{{ fmtNum(pluginStats[pid].changeCount) }}</span></div>
                </template>
                <template v-else-if="pid === 'I3-ObfuscationDetector'">
                  <div class="stat-item"><span class="stat-label">混淆特征数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].hintCount) }}</span></div>
                  <div class="stat-item" v-if="pluginStats[pid].obfuscationScore != null">
                    <span class="stat-label">混淆评分</span>
                    <span class="stat-val" :class="obfScoreClass(pluginStats[pid].obfuscationScore)">
                      {{ pluginStats[pid].obfuscationScore }} 分
                    </span>
                  </div>
                </template>
                <template v-else-if="pid === 'I4-AlgorithmSummarizer'">
                  <div class="stat-item" v-if="pluginStats[pid].totalEvents != null"><span class="stat-label">事件总数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].totalEvents) }}</span></div>
                  <div class="stat-item" v-if="pluginStats[pid].totalFunctions != null"><span class="stat-label">函数数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].totalFunctions) }}</span></div>
                  <div class="stat-item" v-if="pluginStats[pid].totalEdges != null"><span class="stat-label">数据流边数</span><span class="stat-val">{{ fmtNum(pluginStats[pid].totalEdges) }}</span></div>
                  <div class="stat-item" v-if="pluginStats[pid].obfuscationScore != null">
                    <span class="stat-label">混淆评分</span>
                    <span class="stat-val" :class="obfScoreClass(pluginStats[pid].obfuscationScore)">{{ pluginStats[pid].obfuscationScore }} 分</span>
                  </div>
                  <div class="stat-item stat-item-wide" v-if="pluginStats[pid].algorithms?.length">
                    <span class="stat-label">识别算法</span>
                    <span class="stat-val">
                      <span class="algo-tag" v-for="alg in pluginStats[pid].algorithms" :key="alg">{{ alg }}</span>
                    </span>
                  </div>
                </template>
              </div>
              <!-- 插件尚未运行或无统计 -->
              <div v-else-if="status === 'idle' || status === 'pending'" class="plugin-not-run-tip">
                尚未运行
              </div>
              <div v-else-if="status === 'skipped'" class="plugin-not-run-tip">
                已跳过（依赖文件未上传）
              </div>
              <div v-else-if="status === 'failed'" class="plugin-not-run-tip err-tip">
                分析失败，可前往「详细进度抽屉」查看错误日志
              </div>
              <div v-else-if="!pluginStats" class="plugin-not-run-tip">
                统计数据加载中…
              </div>
            </div>
          </transition>
        </div>

        <div v-if="Object.keys(allPluginStatus).length === 0" class="no-plugins">
          暂无插件状态信息
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { formatDate, formatBytes, statusLabel } from '../../composables/useSessionUtils.js';

const props = defineProps({
    session:           { type: Object,  required: true },
    pluginStatus:      { type: Object,  default: () => ({}) },
    pluginDuration:    { type: Object,  default: () => ({}) },
    isAnalyzing:       { type: Boolean, default: false },
    inlineProgressPct: { type: Number,  default: 0 },
    runningPlugin:     { type: String,  default: '' },
});

defineEmits(['openProgress']);

// ── 插件元数据 ─────────────────────────────────────────────────────────────
const ALL_PLUGIN_IDS = [
    'F1-EventIndex', 'F2-SmapLoader',
    'F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer',
    'A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer',
    'A2-DataFlowGraph',
    'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer',
];

const PLUGIN_META = {
    'F1-EventIndex':            { label: 'F1 · 事件索引',        desc: '解析 trace 二进制文件，建立完整事件索引，填充 events/writes/reads/fields/value_dict 等基础表，是所有后续分析的数据基础。' },
    'F2-SmapLoader':            { label: 'F2 · 源码映射',        desc: '加载 .smap.json 源码位置信息，将插桩 IID 映射到原始源码的行列号，支持后续分析展示代码位置。' },
    'F3-CallGraphBuilder':      { label: 'F3 · 调用图构建',      desc: '重建函数调用关系图，记录每次调用的参数、返回值和调用深度，生成 call_edges 表供函数分析使用。' },
    'F4-VariableLifetime':      { label: 'F4 · 变量生命周期',    desc: '统计每个变量的读写次数和生命周期跨度，识别关键变量，填充 var_lifetime 表。' },
    'A3-HotPathAnalyzer':       { label: 'A3 · 热路径分析',      desc: '统计每个 IID 的执行次数（热力图），检测热点代码区域，为循环检测提供统计基础。' },
    'A5-LoopDetector':          { label: 'A5 · 循环检测',        desc: '展开每个循环的全部迭代，记录变量值快照，支持分析加密算法中的循环行为。' },
    'A8-ValuePatternDetector':  { label: 'A8 · 值模式检测',      desc: '检测运行时反复出现的高频魔术常数（如 AES/SHA 的初始化向量），辅助识别密码学算法实现。' },
    'I1-CryptoDetector':        { label: 'I1 · 加密检测',        desc: '综合多维特征（魔术常数 / XOR 操作 / 库调用频率）对加密算法进行置信度评估，识别 AES/DES/RSA/MD5/SHA 等。' },
    'I2-SignatureAnalyzer':      { label: 'I2 · 签名分析',        desc: '追踪 sign/token/_sign 等签名字段从数据源到最终输出的完整数据流路径，还原签名计算过程。' },
    'A2-DataFlowGraph':         { label: 'A2 · 数据流图',        desc: '记录变量间的赋值 / 返回值 / 参数传递关系，构建运行时 def-use 数据流图，支持变量追踪分析。' },
    'A7-ObjectMutationTracker': { label: 'A7 · 对象变异追踪',    desc: '记录对象属性的读写历史，重建属性值随时间的变化轨迹，适合分析请求对象构造过程。' },
    'I3-ObfuscationDetector':   { label: 'I3 · 混淆检测',        desc: '识别字符串解码器 / 控制流平坦化 / 十六进制编码 / 变量名混淆等特征，评估代码整体混淆程度。' },
    'I4-AlgorithmSummarizer':   { label: 'I4 · 算法汇总',        desc: '整合所有分析插件的结果，生成结构化算法汇总报告（Markdown + JSON），是分析流程的最终结论。' },
};

// 阶段颜色（用于耗时条）
const PHASE_COLORS = {
    'F1-EventIndex':            '#3b82f6',
    'F2-SmapLoader':            '#60a5fa',
    'F3-CallGraphBuilder':      '#f59e0b',
    'F4-VariableLifetime':      '#fbbf24',
    'A3-HotPathAnalyzer':       '#fcd34d',
    'A5-LoopDetector':          '#22c55e',
    'A8-ValuePatternDetector':  '#4ade80',
    'I1-CryptoDetector':        '#86efac',
    'I2-SignatureAnalyzer':     '#bbf7d0',
    'A2-DataFlowGraph':         '#a78bfa',
    'A7-ObjectMutationTracker': '#c4b5fd',
    'I3-ObfuscationDetector':   '#ddd6fe',
    'I4-AlgorithmSummarizer':   '#e9d5ff',
};

const PHASE_GROUPS = [
    { id: 'phase1', label: 'P1 · 基础解析', color: '#3b82f6', plugins: ['F1-EventIndex', 'F2-SmapLoader'] },
    { id: 'phase2', label: 'P2 · 索引构建', color: '#f59e0b', plugins: ['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer'] },
    { id: 'phase3', label: 'P3 · 深度分析', color: '#22c55e', plugins: ['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer'] },
    { id: 'phase4', label: 'P4 · 完整分析', color: '#a78bfa', plugins: ['A2-DataFlowGraph', 'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer'] },
];

function pluginLabel(pid) { return PLUGIN_META[pid]?.label || pid; }

function statusText(s) {
    return { done: '✅ 完成', running: '⏳ 运行中', pending: '⏸ 等待', failed: '❌ 失败', skipped: '⏭ 跳过', idle: '— 空闲' }[s] ?? s;
}

function projectStatusLabel(s) {
    return { pending: '等待', instrumenting: '插桩中', ready: '就绪', failed: '失败' }[s] ?? s ?? '未知';
}

// 合并已知插件列表与实际状态
const allPluginStatus = computed(() => {
    const result = {};
    for (const id of ALL_PLUGIN_IDS) result[id] = 'idle';
    for (const [id, s] of Object.entries(props.pluginStatus)) result[id] = s;
    return result;
});

// ── 展开状态 ──────────────────────────────────────────────────────────────
const expandedPlugins = ref(new Set());

function toggleExpand(pid) {
    const next = new Set(expandedPlugins.value);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    expandedPlugins.value = next;
}

// ── plugin-stats（懒加载，首次展开某插件时触发） ──────────────────────────
const pluginStats = ref(null);
const statsLoading = ref(false);

async function loadPluginStats() {
    if (pluginStats.value || statsLoading.value) return;
    statsLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.session.id}/plugin-stats`);
        if (res.ok) {
            const data = await res.json();
            pluginStats.value = data.stats ?? {};
        }
    } catch { /* ignore */ } finally {
        statsLoading.value = false;
    }
}

// 任何插件展开时触发加载（仅加载一次）
watch(expandedPlugins, (set) => {
    if (set.size > 0) loadPluginStats();
});

// 分析完成后自动刷新统计：仅当有新插件从非 done 变为 done 且面板已展开时才重载
let prevDoneSet = new Set(
    Object.entries(props.pluginStatus).filter(([, s]) => s === 'done').map(([k]) => k)
);
watch(() => props.pluginStatus, (newStatus) => {
    const newDoneSet = new Set(
        Object.entries(newStatus).filter(([, s]) => s === 'done').map(([k]) => k)
    );
    const hasNewDone = [...newDoneSet].some(k => !prevDoneSet.has(k));
    prevDoneSet = newDoneSet;
    if (hasNewDone && expandedPlugins.value.size > 0) {
        pluginStats.value = null;
        loadPluginStats();
    }
}, { deep: true });

// ── 耗时相关 ─────────────────────────────────────────────────────────────
function formatDuration(ms) {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(0);
    return `${m}m${s}s`;
}

const totalDurationMs = computed(() => {
    return Object.values(props.pluginDuration).reduce((s, v) => s + (v || 0), 0);
});

const maxSingleDuration = computed(() => {
    const vals = Object.values(props.pluginDuration);
    return vals.length ? Math.max(...vals) : 1;
});

const phaseDurations = computed(() => {
    const maxTotal = Math.max(...PHASE_GROUPS.map(g =>
        g.plugins.reduce((s, pid) => s + (props.pluginDuration[pid] || 0), 0)
    ), 1);
    return PHASE_GROUPS.map(g => {
        const total = g.plugins.reduce((s, pid) => s + (props.pluginDuration[pid] || 0), 0);
        return { ...g, total, pct: Math.round(total / maxTotal * 100) };
    });
});

function durationBarPct(pid) {
    const dur = props.pluginDuration[pid] || 0;
    const max = maxSingleDuration.value || 1;
    return Math.round(dur / max * 100);
}

function phaseColorForPlugin(pid) {
    return PHASE_COLORS[pid] || '#6366f1';
}

// ── 插件产出摘要文字（显示在列表行右侧）──────────────────────────────────
function pluginSummaryText(pid) {
    const s = pluginStats.value?.[pid];
    if (!s) return '';
    if (pid === 'F1-EventIndex')            return `${fmtNum(s.eventCount)} 事件`;
    if (pid === 'F2-SmapLoader')            return `${fmtNum(s.smapCount)} IID`;
    if (pid === 'F3-CallGraphBuilder')      return `${fmtNum(s.fnCount)} 函数 · ${fmtNum(s.callCount)} 次调用`;
    if (pid === 'F4-VariableLifetime')      return `${fmtNum(s.varCount)} 变量`;
    if (pid === 'A3-HotPathAnalyzer')       return `${fmtNum(s.iidCount)} 热点 IID`;
    if (pid === 'A5-LoopDetector')          return `${fmtNum(s.loopCount)} 循环 · 最多 ${fmtNum(s.maxIter)} 次`;
    if (pid === 'A8-ValuePatternDetector')  return `${fmtNum(s.patternCount)} 值模式`;
    if (pid === 'I1-CryptoDetector')        return s.algorithms?.length ? s.algorithms.join(', ') : `${s.algCount} 种算法`;
    if (pid === 'I2-SignatureAnalyzer')     return `${fmtNum(s.sigCount)} 条路径`;
    if (pid === 'A2-DataFlowGraph')         return `${fmtNum(s.edgeCount)} 条边`;
    if (pid === 'A7-ObjectMutationTracker') return `${fmtNum(s.objCount)} 对象`;
    if (pid === 'I3-ObfuscationDetector')   return s.obfuscationScore != null ? `混淆评分 ${s.obfuscationScore}` : `${fmtNum(s.hintCount)} 特征`;
    if (pid === 'I4-AlgorithmSummarizer')   return s.algorithms?.length ? s.algorithms.slice(0, 2).join(', ') : '已生成报告';
    return '';
}

function fmtNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('zh-CN');
}

function obfScoreClass(score) {
    if (score >= 60) return 'score-high';
    if (score >= 30) return 'score-mid';
    return 'score-low';
}

// ── 项目文件复制到剪贴板 ──────────────────────────────────────────────────────
const projCopyStates = ref({});

async function copyProjFile(url) {
    if (projCopyStates.value[url] === 'loading') return;
    projCopyStates.value = { ...projCopyStates.value, [url]: 'loading' };
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        projCopyStates.value = { ...projCopyStates.value, [url]: 'ok' };
    } catch (e) {
        projCopyStates.value = { ...projCopyStates.value, [url]: 'fail' };
    } finally {
        setTimeout(() => { projCopyStates.value = { ...projCopyStates.value, [url]: '' }; }, 2500);
    }
}

function projCopyIcon(state)  {
    if (state === 'loading') return '⏳';
    if (state === 'ok')      return '✅';
    if (state === 'fail')    return '❌';
    return '📋';
}
function projCopyTitle(state) {
    if (state === 'loading') return '复制中...';
    if (state === 'ok')      return '已复制！';
    if (state === 'fail')    return '复制失败';
    return '复制到剪贴板';
}
function projCopyClass(state) {
    if (state === 'ok')   return 'proj-cp-btn--ok';
    if (state === 'fail') return 'proj-cp-btn--fail';
    return '';
}
</script>

<style scoped>
.overview-tab {
    display: flex; flex-direction: column; gap: 16px;
}

.section { padding: 16px 20px; }
.section-title {
    font-size: 12px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px;
}
.section-title-row {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
}
.btn-detail {
    font-size: 11px; color: #a5b4fc; background: none; border: none;
    cursor: pointer; padding: 2px 6px; border-radius: 4px; transition: color 0.15s;
}
.btn-detail:hover { color: #c7d2fe; }

/* ── 基础信息网格 ─────────────────────────────────────────────────────────── */
.meta-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;
}
.meta-item {
    display: flex; flex-direction: column; gap: 4px;
    padding: 10px 14px; background: var(--bg-tertiary);
    border: 1px solid var(--border-color); border-radius: 8px;
}
.meta-label { font-size: 10px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
.meta-value { font-size: 13px; color: var(--text-primary); }
.meta-value.mono { font-family: monospace; font-size: 11px; word-break: break-all; }
.meta-value.highlight { font-size: 15px; font-weight: 700; color: #a5b4fc; }

/* ── 关联工作空间 ─────────────────────────────────────────────────────────── */
.project-card { border-color: rgba(99, 102, 241, 0.25); background: rgba(99, 102, 241, 0.04); }

.btn-goto-project {
    font-size: 11px; color: #a5b4fc;
    background: rgba(99,102,241,0.12); border: 1px solid rgba(99,102,241,0.3);
    padding: 4px 10px; border-radius: 6px; text-decoration: none; transition: all 0.15s;
    white-space: nowrap;
}
.btn-goto-project:hover { background: rgba(99,102,241,0.22); color: #c7d2fe; }

.project-meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.project-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.project-iid { font-size: 12px; color: var(--text-muted); }

.project-status-badge {
    font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px;
}
.proj-status-ready        { background: rgba(34,197,94,0.15);  color: #86efac; }
.proj-status-instrumenting{ background: rgba(99,102,241,0.15); color: #a5b4fc; }
.proj-status-failed       { background: rgba(239,68,68,0.15);  color: #fca5a5; }
.proj-status-pending      { background: rgba(71,85,105,0.25);  color: #94a3b8; }

/* 四行文件信息网格 */
.proj-files-grid { display: flex; flex-direction: column; gap: 6px; }
.proj-file-row {
    display: grid;
    grid-template-columns: 22px 90px 1fr auto 28px 28px;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 7px;
    font-size: 12px;
}
.proj-file-row--preprocess { border-color: rgba(251,191,36,0.25); background: rgba(251,191,36,0.04); }
.proj-file-row--smap       { border-color: rgba(34,197,94,0.25);  background: rgba(34,197,94,0.04);  }
.proj-file-row--instrumented { border-color: rgba(99,102,241,0.25); background: rgba(99,102,241,0.04); }

.proj-file-icon  { font-size: 14px; text-align: center; }
.proj-file-label { font-size: 10px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; white-space: nowrap; }
.proj-file-name  { font-family: monospace; font-size: 11px; color: var(--text-secondary); word-break: break-all; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-file-size  { font-size: 11px; color: var(--text-muted); white-space: nowrap; text-align: right; }
.proj-dl-btn, .proj-cp-btn {
    font-size: 13px; text-align: center; text-decoration: none;
    color: var(--text-muted); padding: 2px 4px; border-radius: 5px;
    border: 1px solid var(--border-color);
    transition: all 0.15s; background: none; cursor: pointer; line-height: 1;
}
.proj-dl-btn:hover, .proj-cp-btn:hover { color: var(--text-primary); border-color: var(--text-muted); background: var(--bg-hover); }
.proj-cp-btn--ok   { color: #86efac !important; border-color: rgba(34,197,94,0.4) !important; }
.proj-cp-btn--fail { color: #fca5a5 !important; border-color: rgba(239,68,68,0.4) !important; }
.no-files-tip { font-size: 11px; color: var(--text-muted); padding: 6px 10px; }

.meta-sub     { font-size: 10px; color: var(--text-muted); margin-left: 6px; }
.meta-missing { font-size: 10px; color: #fca5a5; margin-left: 4px; }

/* ── 分析进度 ─────────────────────────────────────────────────────────────── */
.analyzing-banner {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border-radius: 8px; margin-bottom: 14px;
    background: rgba(99,102,241,0.07); border: 1px solid rgba(99,102,241,0.2);
}
.analyzing-bar { flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
.analyzing-fill {
    height: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1);
    border-radius: 3px; transition: width 0.4s ease;
    animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
.analyzing-text { font-size: 12px; color: #a5b4fc; white-space: nowrap; flex-shrink: 0; }

/* ── 各阶段耗时汇总卡片 ───────────────────────────────────────────────────── */
.phase-duration-row {
    display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap;
    margin-bottom: 16px;
    padding: 10px 14px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
}
.phase-dur-card {
    display: flex; flex-direction: column; gap: 4px;
    flex: 1; min-width: 80px;
}
.phase-dur-total { border-left: 1px solid var(--border-color); padding-left: 12px; }
.phase-dur-label { font-size: 10px; color: var(--text-muted); font-weight: 600; white-space: nowrap; }
.phase-dur-value { font-size: 13px; font-weight: 700; color: var(--text-primary); font-family: monospace; }
.total-val { color: #a5b4fc; font-size: 14px; }
.phase-dur-bar-wrap { height: 4px; background: var(--bg-primary); border-radius: 2px; overflow: hidden; }
.phase-dur-bar { height: 100%; border-radius: 2px; transition: width 0.4s; }

/* ── 插件列表 ─────────────────────────────────────────────────────────────── */
.plugin-list { display: flex; flex-direction: column; gap: 2px; }

.plugin-row-wrap { border-radius: 8px; overflow: hidden; }

.plugin-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 8px;
    border: 1px solid transparent; transition: background 0.12s;
    cursor: pointer; user-select: none;
}
.plugin-row:hover { background: var(--bg-tertiary); }
.plugin-row-done    { border-color: rgba(34,197,94,0.1); }
.plugin-row-running { border-color: rgba(99,102,241,0.25); background: rgba(99,102,241,0.05); }
.plugin-row-failed  { border-color: rgba(239,68,68,0.2); }

.plugin-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.plugin-dot-done    { background: #22c55e; }
.plugin-dot-running { background: #6366f1; animation: pulse 1s infinite; }
.plugin-dot-failed  { background: #ef4444; }
.plugin-dot-pending { background: #475569; }
.plugin-dot-skipped { background: #374151; }
.plugin-dot-idle    { background: #1e2235; border: 1px solid #2d3148; }

.plugin-name { font-size: 12.5px; color: var(--text-secondary); min-width: 0; }

.plugin-summary-badge {
    font-size: 10.5px; color: #64748b; background: rgba(99,102,241,0.07);
    padding: 1px 7px; border-radius: 10px; white-space: nowrap;
    border: 1px solid rgba(99,102,241,0.15); flex-shrink: 0;
    max-width: 220px; overflow: hidden; text-overflow: ellipsis;
}

.plugin-badge { font-size: 11px; margin-left: auto; flex-shrink: 0; }
.plugin-badge-done    { color: #22c55e; }
.plugin-badge-running { color: #a5b4fc; }
.plugin-badge-failed  { color: #ef4444; }
.plugin-badge-pending { color: var(--text-muted); }
.plugin-badge-skipped { color: var(--text-muted); opacity: 0.6; }
.plugin-badge-idle    { color: var(--text-muted); opacity: 0.4; }

.plugin-duration { font-size: 11px; color: var(--text-muted); font-family: monospace; flex-shrink: 0; }

.expand-chevron {
    font-size: 10px; color: var(--text-muted); flex-shrink: 0;
    transition: transform 0.2s; display: inline-block;
}
.expand-chevron.expanded { transform: rotate(90deg); }

/* ── 展开详情面板 ─────────────────────────────────────────────────────────── */
.plugin-detail-panel {
    padding: 10px 14px 14px 30px;
    background: var(--bg-secondary, #161b2e);
    border: 1px solid var(--border-color);
    border-top: none;
    border-radius: 0 0 8px 8px;
    margin-top: -2px;
}
.plugin-desc-text {
    font-size: 11.5px; color: var(--text-muted);
    line-height: 1.6; margin-bottom: 10px;
}

/* 耗时进度条 */
.plugin-time-bar-wrap {
    display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
}
.plugin-time-label { font-size: 10px; color: var(--text-muted); font-weight: 600; min-width: 28px; }
.plugin-time-bar-track { flex: 1; height: 5px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
.plugin-time-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s; }
.plugin-time-value { font-size: 11px; font-family: monospace; color: var(--text-primary); min-width: 42px; text-align: right; }

/* 产出统计网格 */
.plugin-stats-grid {
    display: flex; flex-wrap: wrap; gap: 6px 10px;
}
.stat-item {
    display: flex; flex-direction: column; gap: 2px;
    padding: 6px 10px; background: var(--bg-tertiary);
    border: 1px solid var(--border-color); border-radius: 6px;
    min-width: 90px; flex: 0 0 auto;
}
.stat-item-wide { flex: 1 1 auto; min-width: 180px; }
.stat-label { font-size: 9.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
.stat-val { font-size: 13px; color: var(--text-primary); font-weight: 600; font-family: monospace; }

.algo-tag {
    display: inline-block; font-size: 10px; font-family: monospace;
    padding: 1px 6px; border-radius: 4px; margin-right: 4px; margin-top: 2px;
    background: rgba(168,85,247,0.15); color: #d8b4fe;
    border: 1px solid rgba(168,85,247,0.25);
}

.score-high { color: #ef4444 !important; }
.score-mid  { color: #fb923c !important; }
.score-low  { color: #22c55e !important; }

.plugin-not-run-tip { font-size: 11px; color: var(--text-muted); padding: 4px 0; }
.err-tip { color: #fca5a5; }

.no-plugins { font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px; }

/* ── 展开动画 ─────────────────────────────────────────────────────────────── */
.plugin-expand-enter-active,
.plugin-expand-leave-active {
    transition: max-height 0.22s ease, opacity 0.2s;
    overflow: hidden;
}
.plugin-expand-enter-from, .plugin-expand-leave-to { max-height: 0; opacity: 0; }
.plugin-expand-enter-to,   .plugin-expand-leave-from { max-height: 600px; opacity: 1; }
</style>
