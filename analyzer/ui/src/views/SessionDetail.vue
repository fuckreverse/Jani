<template>
  <div class="session-detail">
    <!-- 顶部：会话信息 -->
    <div v-if="session" class="session-header card">
      <div class="header-left">
        <router-link to="/" class="back-btn">← 返回列表</router-link>
        <h1 class="session-title">{{ session.name || session.id.slice(0, 8) }}</h1>
        <div class="header-meta">
          <span class="badge" :class="`badge-${session.status}`">{{ session.status }}</span>
          <span class="meta-text">{{ session.event_count?.toLocaleString('zh-CN') ?? 0 }} 条事件</span>
          <span class="meta-text">创建于 {{ formatDate(session.created_at) }}</span>
        </div>
      </div>
      <div class="header-right">
        <!-- 插件状态 -->
        <div v-if="pluginStatus && Object.keys(pluginStatus).length > 0" class="plugin-status-list">
          <div
            v-for="(status, id) in pluginStatus"
            :key="id"
            class="plugin-status-item"
            :class="`status-${status}`"
          >
            <span class="plugin-icon">{{ statusIcon(status) }}</span>
            <span class="plugin-id">{{ id }}</span>
            <span class="plugin-state">{{ status }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载会话...</span>
    </div>

    <div v-else-if="error" class="error-state card">
      <p>❌ {{ error }}</p>
    </div>

    <div v-else class="detail-body">
      <!-- 标签页导航 -->
      <div class="tab-nav card">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ 'tab-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >{{ tab.label }}</button>

        <!-- Phase 3：手动触发按钮 -->
        <button
          class="tab-btn btn-run-phase3"
          :disabled="phase3Running"
          @click="runPhase3"
        >{{ phase3Running ? '⏳ P3 分析中...' : '🚀 运行 Phase 3' }}</button>

        <!-- Phase 4：手动触发按钮 -->
        <button
          class="tab-btn btn-run-phase4"
          style="margin-left:auto"
          :disabled="phase4Running"
          @click="runPhase4"
        >{{ phase4Running ? '⏳ P4 分析中...' : '✨ 运行 Phase 4' }}</button>
      </div>

      <!-- 事件列表 -->
      <div v-show="activeTab === 'events'" class="events-section card">
        <div class="events-toolbar">
          <h2 class="section-title">事件流</h2>
          <div class="filters">
            <input
              v-model="filters.type"
              placeholder="事件类型 (END_EXPR/CALL_PRE/CALL...)"
              @keyup.enter="loadEvents(true)"
            />
            <input
              v-model="filters.line"
              placeholder="行号"
              type="number"
              style="width:90px"
              @keyup.enter="loadEvents(true)"
            />
            <input
              v-model="filters.varName"
              placeholder="变量名"
              style="width:120px"
              @keyup.enter="loadEvents(true)"
            />
            <button class="btn-primary" @click="loadEvents(true)">查询</button>
            <button class="btn-secondary" @click="clearFilters">清空</button>
          </div>
        </div>

        <!-- 加载中 -->
        <div v-if="eventsLoading" class="loading">
          <div class="spinner"></div>
          <span>加载事件...</span>
        </div>

        <!-- 事件表格 -->
        <div v-else-if="events.length > 0" class="events-table-wrapper">
          <table class="events-table">
            <thead>
              <tr>
                <th>SEQ</th>
                <th>类型</th>
                <th>行:列</th>
                <th>源码</th>
                <th>写入</th>
                <th>读取</th>
                <th>属性</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="event in events"
                :key="event.seq"
                :class="{ 'row-selected': selectedSeq === event.seq }"
                @click="selectedSeq = event.seq"
              >
                <td class="td-seq">{{ event.seq }}</td>
                <td class="td-type">
                  <span class="type-badge" :class="`type-${event.type}`">{{ event.type }}</span>
                </td>
                <td class="td-location">
                  <span v-if="event.line != null">{{ event.line }}:{{ event.col ?? 0 }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="td-src">
                  <code class="src-text">{{ truncate(event.srcText, 60) }}</code>
                </td>
                <td class="td-vars">
                  <span
                    v-for="w in (event.writes || []).slice(0, 3)"
                    :key="w.name"
                    class="var-chip var-write"
                    :title="`${w.name} = ${JSON.stringify(w.value)}`"
                  >{{ w.name }}</span>
                  <span v-if="(event.writes || []).length > 3" class="var-more">+{{ event.writes.length - 3 }}</span>
                </td>
                <td class="td-vars">
                  <span
                    v-for="r in (event.reads || []).slice(0, 3)"
                    :key="r.name"
                    class="var-chip var-read"
                    :title="`${r.name} = ${JSON.stringify(r.value)}`"
                  >{{ r.name }}</span>
                  <span v-if="(event.reads || []).length > 3" class="var-more">+{{ event.reads.length - 3 }}</span>
                </td>
                <td class="td-vars">
                  <span
                    v-for="f in (event.fields || []).slice(0, 2)"
                    :key="`${f.base}.${f.offset}`"
                    class="var-chip var-field"
                    :title="`${f.base}.${f.offset} ${f.isWrite ? '=' : '→'} ${JSON.stringify(f.value)}`"
                  >{{ f.base }}.{{ f.offset }}</span>
                  <span v-if="(event.fields || []).length > 2" class="var-more">+{{ event.fields.length - 2 }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="empty-state">
          <p>暂无事件，或条件过滤后无结果</p>
        </div>

        <!-- 分页 -->
        <div v-if="events.length > 0" class="pagination">
          <button class="btn-secondary" :disabled="currentPage <= 1" @click="prevPage">← 上一页</button>
          <span class="page-info">第 {{ currentPage }} 页（每页 {{ PAGE_SIZE }} 条）</span>
          <button class="btn-secondary" :disabled="!hasMore" @click="nextPage">下一页 →</button>
        </div>
      </div>

      <!-- 选中事件详情 -->
      <div v-if="selectedEvent && activeTab === 'events'" class="event-detail card">
        <h2 class="section-title">事件详情 — SEQ {{ selectedEvent.seq }}</h2>
        <div class="detail-grid">
          <div v-if="selectedEvent.writes?.length" class="detail-section">
            <div class="detail-label">写入变量</div>
            <div v-for="w in selectedEvent.writes" :key="w.name" class="var-row">
              <span class="var-name">{{ w.name }}</span>
              <span class="var-arrow">=</span>
              <code class="var-value">{{ formatValue(w.value) }}</code>
              <span v-if="w.omitted" class="omitted-badge">OMITTED</span>
            </div>
          </div>
          <div v-if="selectedEvent.reads?.length" class="detail-section">
            <div class="detail-label">读取变量</div>
            <div v-for="r in selectedEvent.reads" :key="r.name" class="var-row">
              <span class="var-name">{{ r.name }}</span>
              <span class="var-arrow">→</span>
              <code class="var-value">{{ formatValue(r.value) }}</code>
              <span v-if="r.omitted" class="omitted-badge">OMITTED</span>
            </div>
          </div>
          <div v-if="selectedEvent.fields?.length" class="detail-section">
            <div class="detail-label">属性访问</div>
            <div v-for="f in selectedEvent.fields" :key="`${f.base}.${f.offset}`" class="var-row">
              <span class="var-name">{{ f.base }}.{{ f.offset }}</span>
              <span class="var-arrow">{{ f.isWrite ? '=' : '→' }}</span>
              <code class="var-value">{{ formatValue(f.value) }}</code>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ Phase 3：循环迭代 ═══════════════════════════════════════════════ -->
      <div v-if="activeTab === 'loops'" class="card">
        <div class="section-header">
          <h2 class="section-title">A5 · 循环迭代展开</h2>
          <span class="section-badge">{{ loopIterData.loops.length }} 个循环</span>
        </div>

        <div v-if="loopIterLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="loopIterData.loops.length === 0" class="empty-state"><p>暂无循环数据（请先运行 A5 · LoopDetector）</p></div>
        <div v-else>
          <!-- 循环选择器 -->
          <div class="filter-bar">
            <label class="filter-label">选择循环：</label>
            <select v-model="selectedLoopId" @change="loadLoopIterations" class="select-input">
              <option :value="null">— 全部 —</option>
              <option v-for="loop in loopIterData.loops" :key="loop.id" :value="loop.id">
                Loop #{{ loop.id }} (iid={{ loop.iid }}, line={{ loop.line }}, {{ loop.iteration_count }} 次)
              </option>
            </select>
          </div>

          <!-- 迭代表格 -->
          <div class="events-table-wrapper" style="margin-top:12px">
            <table class="events-table">
              <thead>
                <tr>
                  <th>Loop</th><th>迭代</th><th>起始 SEQ</th><th>结束 SEQ</th><th>变量快照</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="iter in loopIterData.iterations" :key="iter.id">
                  <td class="td-seq">{{ iter.loop_id }}</td>
                  <td class="td-seq">#{{ iter.iteration_idx }}</td>
                  <td class="td-seq">{{ iter.start_seq }}</td>
                  <td class="td-seq">{{ iter.end_seq }}</td>
                  <td>
                    <div class="snapshot-chips">
                      <span
                        v-for="(val, key) in iter.vars_snapshot"
                        :key="key"
                        class="var-chip var-write"
                        :title="`${key} = ${val}`"
                      >{{ key }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ══ Phase 3：值模式 ════════════════════════════════════════════════ -->
      <div v-if="activeTab === 'patterns'" class="card">
        <div class="section-header">
          <h2 class="section-title">A8 · 值模式 / 魔术常数</h2>
          <span class="section-badge">{{ valuePatterns.length }} 条</span>
        </div>

        <div v-if="patternsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="valuePatterns.length === 0" class="empty-state"><p>暂无值模式数据（请先运行 A8 · ValuePatternDetector）</p></div>
        <div v-else>
          <div class="filter-bar">
            <label class="filter-label">
              <input type="checkbox" v-model="onlyCryptoPatterns" @change="loadValuePatterns" />
              仅显示密码学常数
            </label>
          </div>
          <div class="events-table-wrapper" style="margin-top:12px">
            <table class="events-table">
              <thead>
                <tr>
                  <th>值指纹 (前64字符)</th><th>出现次数</th><th>首次 SEQ</th><th>iid</th><th>变量名</th><th>行号</th><th>匹配常数</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in valuePatterns" :key="p.id" :class="p.matched_constant ? 'row-crypto' : ''">
                  <td><code class="src-text" style="max-width:250px">{{ p.value_hash }}</code></td>
                  <td class="td-seq">{{ p.count }}</td>
                  <td class="td-seq">{{ p.first_seq }}</td>
                  <td class="td-seq">{{ p.iid ?? '—' }}</td>
                  <td><span v-if="p.var_name" class="var-chip var-write">{{ p.var_name }}</span></td>
                  <td class="td-seq">{{ p.line ?? '—' }}</td>
                  <td>
                    <span v-if="p.matched_constant" class="crypto-badge">{{ p.matched_constant }}</span>
                    <span v-else class="text-muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ══ Phase 3：加密检测 ══════════════════════════════════════════════ -->
      <div v-if="activeTab === 'crypto'" class="card">
        <div class="section-header">
          <h2 class="section-title">I1 · 加密算法检测</h2>
          <span class="section-badge">{{ cryptoHints.length }} 个特征</span>
        </div>

        <div v-if="cryptoLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="cryptoHints.length === 0" class="empty-state"><p>暂无加密检测数据（请先运行 I1 · CryptoDetector）</p></div>
        <div v-else>
          <div class="crypto-cards">
            <div v-for="hint in cryptoHints" :key="hint.id" class="crypto-card">
              <div class="crypto-algo">{{ hint.algorithm }}</div>
              <div class="crypto-confidence">
                <div class="conf-bar-bg">
                  <div class="conf-bar-fill" :style="{ width: (hint.confidence * 100) + '%' }"></div>
                </div>
                <span class="conf-text">{{ (hint.confidence * 100).toFixed(0) }}%</span>
              </div>
              <div class="crypto-meta">
                <span v-if="hint.line">line {{ hint.line }}</span>
                <span v-if="hint.iid">  iid={{ hint.iid }}</span>
                <span v-if="hint.fn_name"> · {{ hint.fn_name }}</span>
              </div>
              <div v-if="hint.evidence?.length" class="crypto-evidence">
                <div v-for="(ev, i) in hint.evidence.slice(0, 4)" :key="i" class="evidence-item">
                  <span class="crypto-badge">{{ ev.constant }}</span>
                  <span v-if="ev.line" class="text-muted" style="font-size:11px"> line {{ ev.line }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ Phase 3：签名路径 ══════════════════════════════════════════════ -->
      <div v-if="activeTab === 'signatures'" class="card">
        <div class="section-header">
          <h2 class="section-title">I2 · 签名 / Token 路径</h2>
          <span class="section-badge">{{ sigPaths.length }} 条路径</span>
        </div>

        <div v-if="sigLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="sigPaths.length === 0" class="empty-state"><p>暂无签名路径数据（请先运行 I2 · SignatureAnalyzer）</p></div>
        <div v-else>
          <div class="sig-list">
            <div v-for="path in sigPaths" :key="path.id" class="sig-item">
              <div class="sig-header">
                <span class="sig-field">{{ path.field_name }}</span>
                <span class="sig-hops">{{ path.hops }} 跳</span>
                <span class="text-muted" style="font-size:11px">SEQ {{ path.sink_event_id }}</span>
              </div>
              <div class="sig-summary">{{ path.summary }}</div>
              <div v-if="path.input_vars?.length" class="sig-vars">
                <span class="filter-label">输入变量：</span>
                <span v-for="v in path.input_vars" :key="v" class="var-chip var-read">{{ v }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ Phase 4：数据流图 ══════════════════════════════════════════════ -->
      <div v-if="activeTab === 'dataflow'" class="card">
        <div class="section-header">
          <h2 class="section-title">A2 · 数据流图</h2>
          <span class="section-badge">{{ dataflowEdges.length }} 条边</span>
        </div>

        <div v-if="dataflowLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="dataflowEdges.length === 0" class="empty-state"><p>暂无数据流数据（请先运行 Phase 4）</p></div>
        <div v-else>
          <!-- 类型统计 -->
          <div v-if="dataflowStats.length > 0" class="filter-bar" style="margin-bottom:12px">
            <span class="filter-label">边类型统计：</span>
            <span
              v-for="s in dataflowStats" :key="s.edge_type"
              class="var-chip"
              :class="dfEdgeTypeFilter === s.edge_type ? 'var-write' : 'var-read'"
              style="cursor:pointer; margin-right:6px"
              @click="dfEdgeTypeFilter = dfEdgeTypeFilter === s.edge_type ? '' : s.edge_type; loadDataflow()"
            >{{ s.edge_type }}: {{ s.cnt }}</span>
          </div>
          <!-- 边列表 -->
          <div class="events-table-wrapper">
            <table class="events-table">
              <thead>
                <tr><th>类型</th><th>来源变量</th><th>目标变量</th><th>来源 SEQ</th><th>目标 SEQ</th><th>行号</th><th>iid</th></tr>
              </thead>
              <tbody>
                <tr v-for="e in dataflowEdges" :key="e.id">
                  <td><span class="type-badge" :class="`df-${e.edge_type}`">{{ e.edge_type }}</span></td>
                  <td><span class="var-chip var-write">{{ e.from_var || '—' }}</span></td>
                  <td><span class="var-chip var-read">{{ e.to_var || '—' }}</span></td>
                  <td class="td-seq">{{ e.from_event_id ?? '—' }}</td>
                  <td class="td-seq">{{ e.to_event_id ?? '—' }}</td>
                  <td class="td-seq">{{ e.line ?? '—' }}</td>
                  <td class="td-seq">{{ e.iid ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ══ Phase 4：字符串追踪 ════════════════════════════════════════════ -->
      <div v-if="activeTab === 'strings'" class="card">
        <div class="section-header">
          <h2 class="section-title">A4 · 字符串追踪</h2>
          <span class="section-badge">{{ stringEvents.length }} 条</span>
        </div>

        <div v-if="stringsLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="stringEvents.length === 0" class="empty-state"><p>暂无字符串追踪数据（请先运行 Phase 4）</p></div>
        <div v-else>
          <!-- 编码分布 -->
          <div class="filter-bar" style="margin-bottom:12px">
            <span class="filter-label">编码过滤：</span>
            <span
              v-for="s in stringEncStats" :key="s.encoding_hint"
              class="var-chip"
              :class="strEncodingFilter === s.encoding_hint ? 'var-write' : 'var-read'"
              style="cursor:pointer; margin-right:6px"
              @click="strEncodingFilter = strEncodingFilter === s.encoding_hint ? '' : s.encoding_hint; loadStrings()"
            >{{ s.encoding_hint || 'plain' }}: {{ s.cnt }}</span>
          </div>
          <div class="events-table-wrapper">
            <table class="events-table">
              <thead>
                <tr><th>编码</th><th>变量名</th><th>值（前80字符）</th><th>行号</th><th>iid</th><th>event SEQ</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in stringEvents" :key="s.id" :class="s.encoding_hint && s.encoding_hint !== 'plain' ? 'row-crypto' : ''">
                  <td>
                    <span v-if="s.encoding_hint && s.encoding_hint !== 'plain'" class="crypto-badge">{{ s.encoding_hint }}</span>
                    <span v-else class="text-muted">plain</span>
                  </td>
                  <td><span v-if="s.var_name" class="var-chip var-write">{{ s.var_name }}</span><span v-else class="text-muted">—</span></td>
                  <td><code class="src-text" style="max-width:350px">{{ truncate(s.value, 80) }}</code></td>
                  <td class="td-seq">{{ s.line ?? '—' }}</td>
                  <td class="td-seq">{{ s.iid ?? '—' }}</td>
                  <td class="td-seq">{{ s.event_id }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ══ Phase 4：函数签名 ══════════════════════════════════════════════ -->
      <div v-if="activeTab === 'fnsig'" class="card">
        <div class="section-header">
          <h2 class="section-title">A6 · 函数签名推断</h2>
          <span class="section-badge">
            {{ fnSigSummary ? fnSigSummary.total : fnSignatures.length }} 个函数，
            {{ fnSigSummary ? fnSigSummary.pure_count : 0 }} 个纯函数
          </span>
        </div>

        <div v-if="fnSigLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="fnSignatures.length === 0" class="empty-state"><p>暂无函数签名数据（请先运行 Phase 4）</p></div>
        <div v-else>
          <div class="filter-bar" style="margin-bottom:12px">
            <label class="filter-label">
              <input type="checkbox" v-model="onlyPureFns" @change="loadFnSignatures" />
              仅显示纯函数
            </label>
          </div>
          <div class="events-table-wrapper">
            <table class="events-table">
              <thead>
                <tr><th>函数名</th><th>调用次数</th><th>纯函数</th><th>参数类型</th><th>返回类型</th><th>iid</th></tr>
              </thead>
              <tbody>
                <tr v-for="f in fnSignatures" :key="f.id">
                  <td>
                    <code class="src-text">{{ f.fn_name || '(anonymous)' }}</code>
                    <span v-if="f.is_pure" class="crypto-badge" style="margin-left:6px">pure</span>
                  </td>
                  <td class="td-seq">{{ f.call_count }}</td>
                  <td class="td-seq">{{ f.is_pure ? '✅' : '—' }}</td>
                  <td>
                    <span v-if="Array.isArray(f.arg_types) && f.arg_types.length > 0" class="text-muted" style="font-size:11px">
                      {{ f.arg_types.map((t, i) => `arg${i}: ${Object.keys(t||{}).join('/')}`).join(', ') }}
                    </span>
                    <span v-else class="text-muted">—</span>
                  </td>
                  <td>
                    <span v-if="f.return_types && Object.keys(f.return_types).length" class="var-chip var-read">
                      {{ Object.keys(f.return_types).join('/') }}
                    </span>
                    <span v-else class="text-muted">—</span>
                  </td>
                  <td class="td-seq">{{ f.fn_iid ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ══ Phase 4：对象变异时间线 ════════════════════════════════════════ -->
      <div v-if="activeTab === 'objmut'" class="card">
        <div class="section-header">
          <h2 class="section-title">A7 · 对象属性变异追踪</h2>
          <span class="section-badge">{{ objTimelines.length }} 条记录</span>
        </div>

        <div v-if="objLoading" class="loading"><div class="spinner"></div><span>加载中...</span></div>
        <div v-else-if="objTimelines.length === 0" class="empty-state"><p>暂无对象变异数据（请先运行 Phase 4）</p></div>
        <div v-else>
          <!-- 对象选择器 -->
          <div class="filter-bar" style="margin-bottom:12px; flex-wrap:wrap; gap:8px">
            <label class="filter-label">过滤对象：</label>
            <select v-model="objBaseFilter" @change="loadObjTimelines" class="select-input">
              <option value="">— 全部 —</option>
              <option v-for="s in objBaseStats" :key="s.base_var" :value="s.base_var">
                {{ s.base_var }} ({{ s.change_count }} 次)
              </option>
            </select>
            <label class="filter-label">
              <input type="checkbox" v-model="onlyObjWrites" @change="loadObjTimelines" />
              仅显示写入
            </label>
          </div>
          <div class="events-table-wrapper">
            <table class="events-table">
              <thead>
                <tr><th>操作</th><th>对象</th><th>属性</th><th>旧值</th><th>新值</th><th>行号</th><th>SEQ</th></tr>
              </thead>
              <tbody>
                <tr v-for="t in objTimelines" :key="t.id" :class="t.is_write ? '' : 'row-read-op'">
                  <td>
                    <span :class="t.is_write ? 'var-chip var-write' : 'var-chip var-read'">
                      {{ t.is_write ? 'write' : 'read' }}
                    </span>
                  </td>
                  <td><code class="src-text">{{ t.base_var }}</code></td>
                  <td><span class="var-chip var-field">{{ t.offset_key }}</span></td>
                  <td><code class="src-text" style="color:#94a3b8">{{ truncate(t.old_value, 40) || '—' }}</code></td>
                  <td><code class="src-text" style="color:#fcd34d">{{ truncate(t.new_value, 40) || '—' }}</code></td>
                  <td class="td-seq">{{ t.line ?? '—' }}</td>
                  <td class="td-seq">{{ t.change_seq }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ══ Phase 4：混淆检测 ══════════════════════════════════════════════ -->
      <div v-if="activeTab === 'obfuscation'" class="card">
        <div class="section-header">
          <h2 class="section-title">I3 · 混淆检测</h2>
          <span class="section-badge">{{ obfHints.length }} 个特征</span>
          <span v-if="obfIsObfuscated" class="section-badge" style="background:rgba(239,68,68,0.2);color:#fca5a5">⚠️ 疑似混淆</span>
          <span v-else-if="obfHints.length === 0 && !obfLoading" class="section-badge" style="background:rgba(34,197,94,0.2);color:#86efac">✅ 未检测到混淆</span>
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
              <div class="crypto-algo" style="font-size:14px;margin-bottom:8px">
                <span class="crypto-badge">{{ h.hint_type }}</span>
              </div>
              <div class="crypto-confidence">
                <div class="conf-bar-bg">
                  <div class="conf-bar-fill"
                    :style="{ width: (h.confidence * 100) + '%', background: h.confidence > 0.7 ? 'linear-gradient(90deg,#ef4444,#f87171)' : 'linear-gradient(90deg,#f59e0b,#fcd34d)' }">
                  </div>
                </div>
                <span class="conf-text">{{ (h.confidence * 100).toFixed(0) }}%</span>
              </div>
              <div class="sig-summary" style="margin-top:10px">{{ h.description }}</div>
              <div class="crypto-meta">
                <span v-if="h.line">line {{ h.line }}</span>
                <span v-if="h.iid"> · iid={{ h.iid }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ Phase 4：算法汇总报告 ══════════════════════════════════════════ -->
      <div v-if="activeTab === 'summary'" class="card">
        <div class="section-header">
          <h2 class="section-title">I4 · 算法汇总报告</h2>
          <button class="btn-secondary" style="font-size:11px;padding:4px 10px" @click="loadSummary">🔄 刷新</button>
        </div>

        <div v-if="summaryLoading" class="loading"><div class="spinner"></div><span>生成中...</span></div>
        <div v-else-if="!summaryReport" class="empty-state"><p>暂无报告（请先运行 Phase 4，执行 I4 · AlgorithmSummarizer）</p></div>
        <div v-else>
          <!-- 概览卡片 -->
          <div class="crypto-cards" style="margin-bottom:20px">
            <div class="crypto-card" style="min-width:150px;flex:0 0 auto">
              <div class="detail-label">总事件数</div>
              <div class="crypto-algo" style="font-size:28px">{{ (summaryReport.overview?.eventCount || 0).toLocaleString('zh-CN') }}</div>
            </div>
            <div class="crypto-card" style="min-width:150px;flex:0 0 auto">
              <div class="detail-label">唯一函数</div>
              <div class="crypto-algo" style="font-size:28px">{{ summaryReport.callGraph?.uniqueFunctions || 0 }}</div>
            </div>
            <div class="crypto-card" style="min-width:150px;flex:0 0 auto">
              <div class="detail-label">数据流边</div>
              <div class="crypto-algo" style="font-size:28px">{{ summaryReport.dataFlow?.totalEdges || 0 }}</div>
            </div>
            <div v-if="summaryReport.overview?.isObfuscated" class="crypto-card" style="min-width:150px;flex:0 0 auto;border-color:rgba(239,68,68,0.4)">
              <div class="detail-label">混淆评分</div>
              <div class="crypto-algo" style="font-size:28px;color:#fca5a5">{{ summaryReport.overview?.obfuscationScore }}%</div>
            </div>
          </div>

          <!-- 算法标签 -->
          <div v-if="summaryReport.overview?.algorithmTags?.length" style="margin-bottom:16px">
            <div class="detail-label">识别标签</div>
            <span v-for="tag in summaryReport.overview.algorithmTags" :key="tag" class="crypto-badge" style="margin-right:6px">{{ tag }}</span>
          </div>

          <!-- Markdown 报告 -->
          <div v-if="summaryMd" class="sig-item" style="font-family:monospace;font-size:12px;white-space:pre-wrap;max-height:600px;overflow-y:auto;line-height:1.6">{{ summaryMd }}</div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const sessionId = computed(() => route.params.id);

// ─── 标签页 ──────────────────────────────────────────────────────────────

const tabs = [
    { id: 'events',     label: '📋 事件流' },
    { id: 'loops',      label: '🔁 循环迭代' },
    { id: 'patterns',   label: '🔢 值模式' },
    { id: 'crypto',     label: '🔐 加密检测' },
    { id: 'signatures', label: '✍️ 签名路径' },
    // Phase 4
    { id: 'dataflow',   label: '🔗 数据流图' },
    { id: 'strings',    label: '🔤 字符串追踪' },
    { id: 'fnsig',      label: '🧩 函数签名' },
    { id: 'objmut',     label: '🔄 对象变异' },
    { id: 'obfuscation',label: '🕵️ 混淆检测' },
    { id: 'summary',    label: '📝 算法报告' },
];
const activeTab = ref('events');

// ─── 基础状态 ─────────────────────────────────────────────────────────────

const session      = ref(null);
const loading      = ref(true);
const error        = ref('');
const events       = ref([]);
const eventsLoading = ref(false);
const hasMore      = ref(false);
const currentPage  = ref(1);
const selectedSeq  = ref(null);

const PAGE_SIZE = 100;

// ─── Phase 3 状态 ─────────────────────────────────────────────────────────

const phase3Running = ref(false);

// A5 · LoopDetector
const loopIterData    = ref({ loops: [], iterations: [] });
const loopIterLoading = ref(false);
const selectedLoopId  = ref(null);

// A8 · ValuePatternDetector
const valuePatterns      = ref([]);
const patternsLoading    = ref(false);
const onlyCryptoPatterns = ref(false);

// I1 · CryptoDetector
const cryptoHints   = ref([]);
const cryptoLoading = ref(false);

// I2 · SignatureAnalyzer
const sigPaths  = ref([]);
const sigLoading = ref(false);

// ─── Phase 4 状态 ──────────────────────────────────────────────────────────

const phase4Running = ref(false);

// A2 · DataFlowGraph
const dataflowEdges   = ref([]);
const dataflowStats   = ref([]);
const dataflowLoading = ref(false);
const dfEdgeTypeFilter = ref('');

// A4 · StringTracker
const stringEvents    = ref([]);
const stringEncStats  = ref([]);
const stringsLoading  = ref(false);
const strEncodingFilter = ref('');
const onlyEncodedStrings = ref(false);

// A6 · FunctionSignatureInfer
const fnSignatures   = ref([]);
const fnSigSummary   = ref(null);
const fnSigLoading   = ref(false);
const onlyPureFns    = ref(false);

// A7 · ObjectMutationTracker
const objTimelines   = ref([]);
const objBaseStats   = ref([]);
const objLoading     = ref(false);
const objBaseFilter  = ref('');
const onlyObjWrites  = ref(false);

// I3 · ObfuscationDetector
const obfHints       = ref([]);
const obfLoading     = ref(false);
const obfIsObfuscated = ref(false);
const obfAvgConf     = ref(0);

// I4 · AlgorithmSummarizer
const summaryReport  = ref(null);
const summaryMd      = ref('');
const summaryLoading = ref(false);

const filters = ref({
    type: '',
    line: '',
    varName: '',
});

const pluginStatus = computed(() => {
    if (!session.value?.plugin_status) return {};
    if (typeof session.value.plugin_status === 'string') {
        try { return JSON.parse(session.value.plugin_status); } catch { return {}; }
    }
    return session.value.plugin_status;
});

const selectedEvent = computed(() =>
    events.value.find(e => e.seq === selectedSeq.value) ?? null
);

async function loadSession() {
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        session.value = await res.json();
    } catch (e) {
        error.value = e.message;
    } finally {
        loading.value = false;
    }
}

async function loadEvents(reset = false) {
    if (reset) currentPage.value = 1;
    eventsLoading.value = true;

    try {
        const params = new URLSearchParams({
            limit: PAGE_SIZE,
            offset: (currentPage.value - 1) * PAGE_SIZE,
        });
        if (filters.value.type)    params.set('type',    filters.value.type.trim());
        if (filters.value.line)    params.set('line',    filters.value.line);
        if (filters.value.varName) params.set('varName', filters.value.varName.trim());

        const res = await fetch(`/api/sessions/${sessionId.value}/events?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        events.value = data.events || [];
        hasMore.value = data.hasMore || false;
    } catch (e) {
        console.error('loadEvents error:', e);
    } finally {
        eventsLoading.value = false;
    }
}

function prevPage() {
    if (currentPage.value > 1) {
        currentPage.value--;
        loadEvents();
    }
}

function nextPage() {
    if (hasMore.value) {
        currentPage.value++;
        loadEvents();
    }
}

function clearFilters() {
    filters.value = { type: '', line: '', varName: '' };
    loadEvents(true);
}

// ─── Phase 3 加载函数 ──────────────────────────────────────────────────────

async function loadLoopIterations() {
    loopIterLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (selectedLoopId.value != null) params.set('loopId', selectedLoopId.value);
        const res = await fetch(`/api/sessions/${sessionId.value}/loop-iterations?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        loopIterData.value = {
            loops: data.loops || [],
            iterations: data.iterations || [],
        };
    } catch (e) {
        console.error('loadLoopIterations error:', e);
    } finally {
        loopIterLoading.value = false;
    }
}

async function loadValuePatterns() {
    patternsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (onlyCryptoPatterns.value) params.set('onlyCrypto', '1');
        const res = await fetch(`/api/sessions/${sessionId.value}/value-patterns?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        valuePatterns.value = data.patterns || [];
    } catch (e) {
        console.error('loadValuePatterns error:', e);
    } finally {
        patternsLoading.value = false;
    }
}

async function loadCryptoHints() {
    cryptoLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/crypto-hints`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cryptoHints.value = data.hints || [];
    } catch (e) {
        console.error('loadCryptoHints error:', e);
    } finally {
        cryptoLoading.value = false;
    }
}

async function loadSigPaths() {
    sigLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/signature-paths`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sigPaths.value = data.paths || [];
    } catch (e) {
        console.error('loadSigPaths error:', e);
    } finally {
        sigLoading.value = false;
    }
}

async function runPhase3() {
    phase3Running.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/run-phase3`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('runPhase3 error:', e);
        phase3Running.value = false;
    }
    setTimeout(() => { phase3Running.value = false; }, 3000);
}

// ─── Phase 4 加载函数 ──────────────────────────────────────────────────────

async function loadDataflow() {
    dataflowLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (dfEdgeTypeFilter.value) params.set('edgeType', dfEdgeTypeFilter.value);
        const res = await fetch(`/api/sessions/${sessionId.value}/dataflow?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        dataflowEdges.value = data.edges || [];
        dataflowStats.value = data.stats || [];
    } catch (e) {
        console.error('loadDataflow error:', e);
    } finally {
        dataflowLoading.value = false;
    }
}

async function loadStrings() {
    stringsLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '500' });
        if (strEncodingFilter.value) params.set('encoding', strEncodingFilter.value);
        const res = await fetch(`/api/sessions/${sessionId.value}/strings?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        stringEvents.value = data.strings || [];
        stringEncStats.value = data.encodingStats || [];
    } catch (e) {
        console.error('loadStrings error:', e);
    } finally {
        stringsLoading.value = false;
    }
}

async function loadFnSignatures() {
    fnSigLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '200' });
        if (onlyPureFns.value) params.set('onlyPure', '1');
        const res = await fetch(`/api/sessions/${sessionId.value}/fn-signatures?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fnSignatures.value = data.signatures || [];
        fnSigSummary.value = data.summary || null;
    } catch (e) {
        console.error('loadFnSignatures error:', e);
    } finally {
        fnSigLoading.value = false;
    }
}

async function loadObjTimelines() {
    objLoading.value = true;
    try {
        const params = new URLSearchParams({ limit: '300' });
        if (objBaseFilter.value) params.set('baseVar', objBaseFilter.value);
        if (onlyObjWrites.value) params.set('onlyWrites', '1');
        const res = await fetch(`/api/sessions/${sessionId.value}/object-timelines?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        objTimelines.value = data.timelines || [];
        objBaseStats.value = data.baseVarStats || [];
    } catch (e) {
        console.error('loadObjTimelines error:', e);
    } finally {
        objLoading.value = false;
    }
}

async function loadObfuscation() {
    obfLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/obfuscation`);
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

async function loadSummary() {
    summaryLoading.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/summary`);
        if (!res.ok) {
            if (res.status === 404) {
                summaryReport.value = null;
                summaryMd.value = '';
                return;
            }
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        summaryReport.value = data.report || null;
        summaryMd.value = data.markdown || '';
    } catch (e) {
        console.error('loadSummary error:', e);
    } finally {
        summaryLoading.value = false;
    }
}

async function runPhase4() {
    phase4Running.value = true;
    try {
        const res = await fetch(`/api/sessions/${sessionId.value}/run-phase4`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('runPhase4 error:', e);
        phase4Running.value = false;
    }
    setTimeout(() => { phase4Running.value = false; }, 3000);
}

// 切换标签页时延迟加载数据
watch(activeTab, (tab) => {
    if (tab === 'loops'      && loopIterData.value.loops.length === 0)   loadLoopIterations();
    if (tab === 'patterns'   && valuePatterns.value.length === 0)         loadValuePatterns();
    if (tab === 'crypto'     && cryptoHints.value.length === 0)           loadCryptoHints();
    if (tab === 'signatures' && sigPaths.value.length === 0)              loadSigPaths();
    // Phase 4
    if (tab === 'dataflow'   && dataflowEdges.value.length === 0)         loadDataflow();
    if (tab === 'strings'    && stringEvents.value.length === 0)          loadStrings();
    if (tab === 'fnsig'      && fnSignatures.value.length === 0)          loadFnSignatures();
    if (tab === 'objmut'     && objTimelines.value.length === 0)          loadObjTimelines();
    if (tab === 'obfuscation'&& obfHints.value.length === 0)              loadObfuscation();
    if (tab === 'summary'    && !summaryReport.value)                     loadSummary();
});

// WebSocket 完成通知时刷新对应标签
function onPhase3Done(pluginId) {
    if (pluginId === 'A5-LoopDetector')             loadLoopIterations();
    if (pluginId === 'A8-ValuePatternDetector')      loadValuePatterns();
    if (pluginId === 'I1-CryptoDetector')            loadCryptoHints();
    if (pluginId === 'I2-SignatureAnalyzer')          loadSigPaths();
    // Phase 4
    if (pluginId === 'A2-DataFlowGraph')             loadDataflow();
    if (pluginId === 'A4-StringTracker')             loadStrings();
    if (pluginId === 'A6-FunctionSignatureInfer')    loadFnSignatures();
    if (pluginId === 'A7-ObjectMutationTracker')     loadObjTimelines();
    if (pluginId === 'I3-ObfuscationDetector')       loadObfuscation();
    if (pluginId === 'I4-AlgorithmSummarizer')       loadSummary();
}

// WebSocket 订阅进度
let ws = null;
function connectWs() {
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sessions/${sessionId.value}/progress`;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init' || msg.sessionId === sessionId.value) {
            loadSession();
            if (session.value?.status === 'ready' && events.value.length === 0) {
                loadEvents();
            }
            // Phase 3 插件完成时刷新对应标签
            if (msg.status === 'done' && msg.plugin) {
                onPhase3Done(msg.plugin);
            }
        }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
        // 5s 后重连
        setTimeout(connectWs, 5000);
    };
}

// 格式化工具
function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('zh-CN');
}

function formatValue(v) {
    if (v === undefined || v === null) return String(v);
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '...' : s;
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function statusIcon(s) {
    return { pending: '⏸', running: '⏳', done: '✅', failed: '❌' }[s] ?? '?';
}

let refreshTimer = null;
onMounted(async () => {
    await loadSession();
    await loadEvents();
    connectWs();
    refreshTimer = setInterval(loadSession, 10000);
});

onUnmounted(() => {
    if (ws) { ws.onclose = null; ws.close(); }
    if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.session-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 20px;
}

.back-btn {
    font-size: 12px;
    color: var(--text-muted);
    display: block;
    margin-bottom: 6px;
}

.session-title {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 8px;
}

.header-meta {
    display: flex;
    align-items: center;
    gap: 12px;
}

.meta-text {
    font-size: 12px;
    color: var(--text-muted);
}

/* 插件状态 */
.plugin-status-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
}

.plugin-status-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--bg-tertiary);
}

.plugin-id   { color: var(--text-muted); }
.plugin-state { font-weight: 600; }

.status-done    .plugin-state { color: var(--success); }
.status-running .plugin-state { color: var(--info); }
.status-failed  .plugin-state { color: var(--danger); }
.status-pending .plugin-state { color: var(--text-muted); }

/* 详情主体 */
.detail-body {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

/* 事件工具栏 */
.events-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    flex-wrap: wrap;
    gap: 12px;
}

.filters {
    display: flex;
    align-items: center;
    gap: 8px;
}

.filters input {
    width: 200px;
}

/* 事件表格 */
.events-table-wrapper {
    overflow-x: auto;
}

.events-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}

.events-table th {
    text-align: left;
    padding: 8px 12px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
}

.events-table td {
    padding: 7px 12px;
    border-bottom: 1px solid rgba(45,49,72,0.5);
    vertical-align: middle;
}

.events-table tr:hover td { background: var(--bg-tertiary); }
.row-selected td { background: rgba(99,102,241,0.1) !important; }

.td-seq { font-family: monospace; color: var(--text-muted); min-width: 50px; }

.type-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
}
.type-END_EXPR   { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.type-CALL_PRE   { background: rgba(245,158,11,0.15); color: #fcd34d; }
.type-CALL       { background: rgba(34,197,94,0.15);  color: #86efac; }
.type-SCRIPT_ENTER { background: rgba(59,130,246,0.15); color: #93c5fd; }
.type-FUNCTION_ENTER { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.type-FUNCTION_EXIT  { background: rgba(168,85,247,0.15); color: #d8b4fe; }

.td-location { font-family: monospace; color: var(--text-muted); min-width: 60px; }

.src-text {
    color: var(--text-primary);
    white-space: nowrap;
    max-width: 300px;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
}

.td-vars { max-width: 150px; }

.var-chip {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
    font-family: monospace;
    margin-right: 3px;
    cursor: default;
}
.var-write { background: rgba(34,197,94,0.15);  color: #86efac; }
.var-read  { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.var-field { background: rgba(245,158,11,0.15); color: #fcd34d; }

.var-more {
    font-size: 11px;
    color: var(--text-muted);
}

/* 分页 */
.pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-color);
}

.page-info {
    font-size: 12px;
    color: var(--text-muted);
}

/* 事件详情 */
.event-detail { margin-top: 4px; }

.detail-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
}

.detail-section { flex: 1; min-width: 200px; }

.detail-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 8px;
}

.var-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px solid rgba(45,49,72,0.4);
    font-size: 12px;
}

.var-name  { font-family: monospace; color: #a5b4fc; min-width: 80px; }
.var-arrow { color: var(--text-muted); }
.var-value {
    color: #fcd34d;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.omitted-badge {
    font-size: 10px;
    padding: 1px 5px;
    background: rgba(148,163,184,0.15);
    color: #94a3b8;
    border-radius: 3px;
}

.error-state { color: var(--danger); }

/* ─── 标签页导航 ──────────────────────────────────────────────────────────── */

.tab-nav {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    margin-bottom: 0;
    flex-wrap: wrap;
}

.tab-btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
}
.tab-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.tab-active {
    background: rgba(99,102,241,0.2) !important;
    color: #a5b4fc !important;
    border-color: rgba(99,102,241,0.4) !important;
}
.btn-run-phase3 {
    background: rgba(34,197,94,0.1);
    border-color: rgba(34,197,94,0.3);
    color: #86efac;
}
.btn-run-phase3:hover:not(:disabled) {
    background: rgba(34,197,94,0.2);
}
.btn-run-phase3:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* ─── 通用 section header ─────────────────────────────────────────────────── */

.section-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
}
.section-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    background: rgba(99,102,241,0.15);
    color: #a5b4fc;
    font-size: 11px;
    font-weight: 600;
}

/* ─── 过滤栏 ─────────────────────────────────────────────────────────────── */

.filter-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}
.filter-label {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
}
.select-input {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 12px;
}

/* ─── 快照 chips ──────────────────────────────────────────────────────────── */

.snapshot-chips { display: flex; flex-wrap: wrap; gap: 3px; }

/* ─── 值模式 ─────────────────────────────────────────────────────────────── */

.row-crypto td { background: rgba(245,158,11,0.06) !important; }
.crypto-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(245,158,11,0.2);
    color: #fcd34d;
    font-size: 11px;
    font-weight: 600;
    font-family: monospace;
}

/* ─── 加密检测卡片 ────────────────────────────────────────────────────────── */

.crypto-cards {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
}
.crypto-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px 20px;
    min-width: 200px;
    flex: 1;
}
.crypto-algo {
    font-size: 22px;
    font-weight: 800;
    color: #a5b4fc;
    margin-bottom: 10px;
    font-family: monospace;
}
.crypto-confidence {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}
.conf-bar-bg {
    flex: 1;
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
}
.conf-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #6366f1, #818cf8);
    border-radius: 3px;
    transition: width 0.3s;
}
.conf-text {
    font-size: 12px;
    color: var(--text-muted);
    min-width: 34px;
    text-align: right;
}
.crypto-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 8px;
}
.crypto-evidence { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.evidence-item { display: flex; align-items: center; gap: 4px; }

/* ─── 签名路径 ────────────────────────────────────────────────────────────── */

.sig-list { display: flex; flex-direction: column; gap: 12px; }
.sig-item {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px 16px;
}
.sig-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
}
.sig-field {
    font-family: monospace;
    font-weight: 700;
    color: #86efac;
    font-size: 14px;
}
.sig-hops {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 10px;
    background: rgba(34,197,94,0.15);
    color: #86efac;
}
.sig-summary {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 8px;
    line-height: 1.5;
}
.sig-vars { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.text-muted { color: var(--text-muted); }

/* ─── Phase 4 样式 ────────────────────────────────────────────────────────── */

.btn-run-phase4 {
    background: rgba(168,85,247,0.1);
    border-color: rgba(168,85,247,0.3);
    color: #d8b4fe;
}
.btn-run-phase4:hover:not(:disabled) {
    background: rgba(168,85,247,0.2);
}
.btn-run-phase4:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* 数据流图边类型 badges */
.df-assign      { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.df-field_write { background: rgba(34,197,94,0.15);  color: #86efac; }
.df-field_read  { background: rgba(245,158,11,0.15); color: #fcd34d; }
.df-call_arg    { background: rgba(168,85,247,0.15); color: #d8b4fe; }
.df-call_ret    { background: rgba(239,68,68,0.15);  color: #fca5a5; }

/* 对象读取行 */
.row-read-op td { background: rgba(99,102,241,0.05) !important; }
</style>
