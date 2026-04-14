/**
 * client.mjs — JTA REST API HTTP 封装
 *
 * 所有 MCP Tool 均通过此模块与 JTA Server 通信。
 * 不包含任何业务逻辑，只做 HTTP 转发 + 错误处理。
 */

export class JtaClient {
    /**
     * @param {string} baseUrl  JTA Server 地址，如 http://localhost:33000
     */
    constructor(baseUrl = 'http://localhost:33000') {
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    // ── 内部 helpers ────────────────────────────────────────────────────────

    async _request(method, path, body = null, query = {}) {
        const url = new URL(this.baseUrl + path);
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }

        const init = { method, headers: {} };
        if (body !== null) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        let res;
        try {
            res = await fetch(url.toString(), init);
        } catch (err) {
            throw new Error(`JTA Server 连接失败（${this.baseUrl}）：${err.message}`);
        }

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        if (!res.ok) {
            const msg = (data && data.error) ? data.error : text;
            throw new Error(`JTA API 错误 ${res.status}：${msg}`);
        }
        return data;
    }

    _get(path, query = {}) { return this._request('GET', path, null, query); }
    _post(path, body = {}, query = {}) { return this._request('POST', path, body, query); }
    _delete(path) { return this._request('DELETE', path); }

    // ── 健康检查 ─────────────────────────────────────────────────────────────

    health() { return this._get('/api/health'); }

    // ── 插桩 ─────────────────────────────────────────────────────────────────

    /**
     * 对 JS 源码执行插桩
     * @param {string} code       JS 源码
     * @param {string} filename   文件名（用于 source map）
     * @param {object} options    插桩选项（inlineIid / inlineSource / sandboxVar / sourceType 等）
     * @param {object} preprocess 预处理选项（enabled / preset / ... 可选）
     */
    instrumentCode(code, filename, options = {}, preprocess = null) {
        const body = { code, filename, options };
        if (preprocess) body.preprocess = preprocess;
        return this._post('/api/instrument', body);
    }

    /**
     * 在服务端 Node.js 沙箱运行代码，立即返回 runId（不等待执行完成）
     */
    runInstrumented(code, filename, options = {}, env = 'node', preprocess = null) {
        const body = { code, filename, options, env };
        if (preprocess) body.preprocess = preprocess;
        return this._post('/api/instrument/run', body);
    }

    /**
     * 查询服务端运行任务状态
     */
    getRunStatus(runId) {
        return this._get(`/api/instrument/run/${encodeURIComponent(runId)}`);
    }

    // ── 工作空间（Projects）──────────────────────────────────────────────────

    listProjects() { return this._get('/api/projects'); }

    getProject(projectId) {
        return this._get(`/api/projects/${encodeURIComponent(projectId)}`);
    }

    deleteProject(projectId) {
        return this._delete(`/api/projects/${encodeURIComponent(projectId)}`);
    }

    // ── 分析会话 ─────────────────────────────────────────────────────────────

    listSessions() { return this._get('/api/sessions'); }

    getSession(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}`);
    }

    deleteSession(sessionId) {
        return this._delete(`/api/sessions/${encodeURIComponent(sessionId)}`);
    }

    getSessionCheckpoints(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
    }

    reRunSession(sessionId, opts = {}) {
        return this._post(`/api/sessions/${encodeURIComponent(sessionId)}/re-run`, opts);
    }

    // ── 事件查询 ─────────────────────────────────────────────────────────────

    /**
     * 查询事件
     * @param {string} sessionId
     * @param {object} params  支持：line / type / types / varName / seqFrom / seqTo / cursor / limit
     */
    queryEvents(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/events`, params);
    }

    getEventTypes(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/event-types`);
    }

    // ── 函数分析 ─────────────────────────────────────────────────────────────

    /**
     * 查询函数调用统计
     * @param {object} params  search / minCalls / hideBuiltin / sortBy / limit / offset / fnDefIid / line
     */
    queryFunctions(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/functions`, params);
    }

    getFunctionCalls(sessionId, fnName, params = {}) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/functions/${encodeURIComponent(fnName)}/calls`,
            params
        );
    }

    getFunctionCallers(sessionId, fnName, params = {}) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/functions/${encodeURIComponent(fnName)}/callers`,
            params
        );
    }

    getCallStack(sessionId, callSeq, returnSeq, depth) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/call-stack`,
            { callSeq, returnSeq, depth }
        );
    }

    getAnnotatedSource(sessionId, callId) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/annotated-source`
        );
    }

    // ── 热路径 / 控制流 ───────────────────────────────────────────────────────

    getHotIids(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/hot-iids`);
    }

    getCallGraph(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/call-graph`, params);
    }

    getCfg(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/cfg`, params);
    }

    getFnCfg(sessionId, fnName, params = {}) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/fn-cfg`,
            { fnName, ...params }
        );
    }

    getFlamegraph(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/flamegraph`, params);
    }

    getLoopIterations(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/loop-iterations`, params);
    }

    // ── 数据流 / 污点 ─────────────────────────────────────────────────────────

    traceTaint(sessionId, varName, direction = 'forward', startSeq = null) {
        const q = { var: varName, direction };
        if (startSeq !== null) q.startSeq = startSeq;
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/taint`, q);
    }

    getDataflow(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/dataflow`, params);
    }

    getDataflowSubgraph(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/dataflow/subgraph`, params);
    }

    getDataflowVars(sessionId, prefix = '') {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/dataflow/vars`, { prefix });
    }

    // ── 值搜索 / 值字典 ───────────────────────────────────────────────────────

    valueSearch(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/value-search`, params);
    }

    valueSearchEvents(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/value-search/events`, params);
    }

    getValuePatterns(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/value-patterns`, params);
    }

    getObjectTimelines(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/object-timelines`, params);
    }

    // ── 加密 / 签名 / 混淆 ───────────────────────────────────────────────────

    detectCrypto(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/crypto-hints`);
    }

    analyzeSignature(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/summary`);
    }

    getWebApiCalls(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/web-api`, params);
    }

    getPluginStats(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/plugin-stats`);
    }

    // ── 书签 ─────────────────────────────────────────────────────────────────

    listBookmarks(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`);
    }

    createBookmark(sessionId, seq, label = '', note = '') {
        return this._post(`/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`, { seq, label, note });
    }

    deleteBookmark(sessionId, bookmarkId) {
        return this._delete(`/api/sessions/${encodeURIComponent(sessionId)}/bookmarks/${encodeURIComponent(bookmarkId)}`);
    }

    // ── 多会话对比 ────────────────────────────────────────────────────────────

    compareSessions(sessionIds) {
        return this._post('/api/compare/sessions', { sessionIds });
    }

    compareFunctions(sessionIds, limit = 50, hideBuiltin = false) {
        return this._post('/api/compare/functions', { sessionIds, limit, hideBuiltin });
    }

    compareHotIids(sessionIds, topN = 20) {
        return this._post('/api/compare/hot-iids', { sessionIds, topN });
    }

    compareLoops(sessionIds) {
        return this._post('/api/compare/loops', { sessionIds });
    }

    compareEvents(sessionIds) {
        return this._post('/api/compare/events', { sessionIds });
    }

    // ── Trace 文件 ────────────────────────────────────────────────────────────

    listTraceFiles(params = {}) {
        return this._get('/api/trace/files', params);
    }

    importTrace(filename, name = null, projectId = null) {
        const body = { filename };
        if (name) body.name = name;
        if (projectId) body.projectId = projectId;
        return this._post('/api/trace/import', body);
    }

    getTraceStats() {
        return this._get('/api/trace/stats');
    }

    setTraceFileAlias(name, alias) {
        return this._request('PUT', `/api/trace/files/${encodeURIComponent(name)}`, { alias });
    }

    deleteTraceFile(name) {
        return this._delete(`/api/trace/files/${encodeURIComponent(name)}`);
    }

    batchDeleteTraceFiles(names) {
        return this._post('/api/trace/files/batch-delete', { names });
    }

    // ── 空间分析 ─────────────────────────────────────────────────────────────

    getStorageStats() {
        return this._get('/api/storage/stats');
    }

    storageDelete(items) {
        return this._post('/api/storage/delete', { items });
    }

    // ── 值字典 ────────────────────────────────────────────────────────────────

    getValueDictStats(sessionId) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/value-dict/stats`);
    }

    getValueDict(sessionId, params = {}) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/value-dict`, params);
    }

    getValuePatternFullValue(sessionId, patternId) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/value-patterns/${encodeURIComponent(patternId)}/full-value`
        );
    }

    valueIndexSearch(sessionId, q) {
        return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/value-index-search`, { q });
    }

    // ── 单次调用自身事件 ──────────────────────────────────────────────────────

    getCallOwnEvents(sessionId, callId, params = {}) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/own-events`,
            params
        );
    }

    // ── 事件所属函数帧 ────────────────────────────────────────────────────────

    getEventOwnerFn(sessionId, seq) {
        return this._get(
            `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(seq)}/owner-fn`
        );
    }
}
