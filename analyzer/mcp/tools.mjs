/**
 * tools.mjs — JTA MCP Tool definitions + handler registration
 *
 * Export registerTools(server, client) to register all analysis tools on the McpServer.
 * Parameters use Zod schema (required by @modelcontextprotocol/sdk ≥ 1.x).
 */

import { z } from 'zod';

function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function errResult(err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}
async function safe(fn) {
    try { return ok(await fn()); }
    catch (err) { return errResult(err); }
}

export function registerTools(server, client) {

    // ── Utility ──────────────────────────────────────────────────────────────
    server.tool('health_check',
        'Check if JTA Server is online (returns status/version/uptime).',
        {},
        async () => safe(() => client.health())
    );

    // ── Instrumentation ───────────────────────────────────────────────────────
    server.tool('instrument_code',
        'Instrument JS source code, returns instrumented code + smap. Supports optional preprocessing.',
        {
            code:         z.string().describe('JS source code content'),
            filename:     z.string().optional().describe('filename for source map (e.g. target.js)'),
            inlineIid:    z.boolean().optional().describe('inline iid->position map (default false)'),
            inlineSource: z.boolean().optional().describe('inline original source in source map (default false)'),
            sandboxVar:   z.string().optional().describe('sandbox variable name (default "J$")'),
            sourceType:   z.enum(['script','module']).optional().describe('source type (default script)'),
            preprocess:   z.object({
                enabled:        z.boolean().optional(),
                preset:         z.enum(['deobfuscate','normalize-arrow','transpile','full']).optional(),
                sourceType:     z.enum(['script','module']).optional(),
                deobfuscate:    z.object({ replaceVoid: z.boolean().optional(), foldConstants: z.boolean().optional(), splitSequence: z.boolean().optional(), simplifyBoolean: z.boolean().optional(), expandConditional: z.boolean().optional() }).optional(),
                normalizeArrow: z.object({ preserveThis: z.boolean().optional(), onlyExpression: z.boolean().optional() }).optional(),
                transpile:      z.object({ targets: z.enum(['es2015','es2017','es2020','es2022']).optional() }).optional(),
            }).optional().describe('preprocessing options (optional)'),
        },
        async ({ code, filename = 'target.js', inlineIid = false, inlineSource = false,
                 sandboxVar = 'J$', sourceType = 'script', preprocess = null }) =>
            safe(() => client.instrumentCode(code, filename,
                { inlineIid, inlineSource, sandboxVar, sourceType }, preprocess))
    );

    server.tool('run_instrumented',
        'Run JS source in server-side Node.js/JSDOM sandbox (auto-instrument+ExecutionTrace). Returns runId immediately.',
        {
            code:       z.string().describe('JS source code (server auto-instruments)'),
            filename:   z.string().optional().describe('filename (default target.js)'),
            env:        z.enum(['node','jsdom']).optional().describe('execution env: node (default) or jsdom'),
            preprocess: z.object({ enabled: z.boolean().optional() }).passthrough().optional().describe('preprocessing options (optional)'),
        },
        async ({ code, filename = 'target.js', env = 'node', preprocess = null }) =>
            safe(() => client.runInstrumented(code, filename, {}, env, preprocess))
    );

    server.tool('get_run_status',
        'Query run task status (status/stdout/stderr/exitCode/sessionId/durationMs).',
        {
            runId: z.string().describe('runId from run_instrumented'),
        },
        async ({ runId }) => safe(() => client.getRunStatus(runId))
    );

    // ── Session management ────────────────────────────────────────────────────
    server.tool('list_sessions',
        'List all analysis sessions (status, event count, workspace ID, plugin statuses).',
        {},
        async () => safe(() => client.listSessions())
    );

    server.tool('get_session',
        'Get details of a specific session (plugin status, file info, smapCount).',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.getSession(sessionId))
    );

    server.tool('delete_session',
        'Delete a session and all associated data (files + DB records).',
        {
            sessionId: z.string().describe('session ID to delete'),
        },
        async ({ sessionId }) => safe(() => client.deleteSession(sessionId))
    );

    server.tool('run_plugin',
        'Manually trigger analysis plugins (re-run or first run). Specify plugin IDs or phase.',
        {
            sessionId:  z.string().describe('session ID'),
            plugins:    z.array(z.string()).optional().describe('plugin IDs e.g. ["A1_TaintTracker"]; empty = re-run by phase'),
            forceRerun: z.boolean().optional().describe('force re-run clearing checkpoints (default false)'),
            phase:      z.enum(['phase1','phase2','phase3','phase4']).optional().describe('run phase (optional)'),
        },
        async ({ sessionId, plugins = [], forceRerun = false, phase = undefined }) =>
            safe(() => client.reRunSession(sessionId, { plugins, forceRerun, phase }))
    );

    // ── Event query ───────────────────────────────────────────────────────────
    server.tool('query_events',
        'Query trace events with filtering: line/type/varName/seq range/cursor paging.',
        {
            sessionId: z.string().describe('session ID'),
            line:      z.number().int().optional().describe('filter by line number (optional)'),
            type:      z.string().optional().describe('event type e.g. END_EXPR/CALL_PRE/CALL (optional)'),
            types:     z.string().optional().describe('comma-separated types (optional, overrides type)'),
            varName:   z.string().optional().describe('variable name in writes or reads (optional)'),
            seqFrom:   z.number().int().optional().describe('start seq for exact positioning (optional)'),
            seqTo:     z.number().int().optional().describe('end seq (optional)'),
            cursor:    z.number().int().optional().describe('cursor paging: last seq of prev page (omit for first page)'),
            limit:     z.number().int().optional().describe('max results (default 50)'),
        },
        async ({ sessionId, line, type, types, varName, seqFrom, seqTo, cursor, limit = 50 }) =>
            safe(() => client.queryEvents(sessionId,
                { line, type, types, varName, seqFrom, seqTo, cursor, limit }))
    );

    server.tool('get_event_types',
        'Get all event types and their counts in the session.',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.getEventTypes(sessionId))
    );

    // ── Function analysis ─────────────────────────────────────────────────────
    server.tool('query_functions',
        'Query function call statistics (sort/search/builtin filter).',
        {
            sessionId:   z.string().describe('session ID'),
            search:      z.string().optional().describe('function name keyword (optional)'),
            minCalls:    z.number().int().optional().describe('minimum call count (default 1)'),
            hideBuiltin: z.boolean().optional().describe('hide JS builtin functions (default false)'),
            sortBy:      z.enum(['call_count','event_count']).optional().describe('sort field (default call_count)'),
            limit:       z.number().int().optional().describe('max results (default 50)'),
            offset:      z.number().int().optional().describe('pagination offset (default 0)'),
            fnDefIid:    z.number().int().optional().describe('filter by function definition iid (optional)'),
            line:        z.number().int().optional().describe('filter by call site line (optional)'),
        },
        async ({ sessionId, search, minCalls = 1, hideBuiltin = false,
                 sortBy = 'call_count', limit = 50, offset = 0, fnDefIid, line }) =>
            safe(() => client.queryFunctions(sessionId, {
                search, minCalls, hideBuiltin: hideBuiltin ? 1 : 0,
                sortBy, limit, offset, fnDefIid, line,
            }))
    );

    server.tool('get_function_calls',
        'Get all call records for a function (args, return value, SEQ range, depth).',
        {
            sessionId: z.string().describe('session ID'),
            fnName:    z.string().describe('function name'),
            fnDefIid:  z.number().int().optional().describe('function definition iid for disambiguation (optional)'),
            callSeq:   z.number().int().optional().describe('auto-navigate to page containing this call (optional)'),
            limit:     z.number().int().optional().describe('max results (default 100)'),
            offset:    z.number().int().optional().describe('pagination offset (default 0)'),
        },
        async ({ sessionId, fnName, fnDefIid, callSeq, limit = 100, offset = 0 }) =>
            safe(() => client.getFunctionCalls(sessionId, fnName,
                { fnDefIid, callSeq, limit, offset }))
    );

    server.tool('get_function_callers',
        'Reverse call graph: get all callers of a function sorted by call count desc.',
        {
            sessionId: z.string().describe('session ID'),
            fnName:    z.string().describe('target function name'),
            fnIid:     z.number().int().optional().describe('iid for disambiguation (optional)'),
            limit:     z.number().int().optional().describe('max results (default 50)'),
        },
        async ({ sessionId, fnName, fnIid, limit = 50 }) =>
            safe(() => client.getFunctionCallers(sessionId, fnName, { fnIid, limit }))
    );

    server.tool('get_call_stack',
        'Get full call stack (ancestor frames ascending) for a specific call.',
        {
            sessionId: z.string().describe('session ID'),
            callSeq:   z.number().int().describe('start seq of the call frame'),
            returnSeq: z.number().int().describe('return seq of the call frame'),
            depth:     z.number().int().optional().describe('call depth (optional)'),
        },
        async ({ sessionId, callSeq, returnSeq, depth }) =>
            safe(() => client.getCallStack(sessionId, callSeq, returnSeq, depth))
    );

    server.tool('get_annotated_source',
        'Get function source with per-line execution counts and variable values for one call.',
        {
            sessionId: z.string().describe('session ID'),
            callId:    z.number().int().describe('call record ID (from get_function_calls id field)'),
        },
        async ({ sessionId, callId }) =>
            safe(() => client.getAnnotatedSource(sessionId, callId))
    );

    // ── Hot paths / CFG ───────────────────────────────────────────────────────
    server.tool('get_hot_paths',
        'Get most-executed code locations (iid, line, srcText, execution count).',
        {
            sessionId: z.string().describe('session ID'),
            topN:      z.number().int().optional().describe('return top N results (default 20)'),
        },
        async ({ sessionId, topN = 20 }) => {
            return safe(async () => {
                const data = await client.getHotIids(sessionId);
                const arr = Array.isArray(data) ? data
                    : (data.iids || data.hotIids || Object.values(data)[0] || []);
                return arr.slice(0, topN);
            });
        }
    );

    server.tool('get_call_graph',
        'Get function call graph (nodes=functions, edges=calls with counts).',
        {
            sessionId: z.string().describe('session ID'),
            rootFn:    z.string().optional().describe('root function for subtree view (optional)'),
            depth:     z.number().int().optional().describe('expansion depth (default 3)'),
        },
        async ({ sessionId, rootFn, depth = 3 }) =>
            safe(() => client.getCallGraph(sessionId, { rootFn, depth }))
    );

    server.tool('get_cfg',
        'Get dynamic control flow graph (function topology with loop annotations and hotspot IIDs).',
        {
            sessionId:   z.string().describe('session ID'),
            rootFn:      z.string().optional().describe('root function (optional)'),
            depth:       z.number().int().optional().describe('depth (default 3, max 8)'),
            minCount:    z.number().int().optional().describe('min iid execution count threshold (default 10)'),
            foldLoops:   z.boolean().optional().describe('fold loop blocks (default true)'),
            includeIids: z.boolean().optional().describe('include hotspot IID nodes (default true)'),
        },
        async ({ sessionId, rootFn, depth = 3, minCount = 10, foldLoops = true, includeIids = true }) =>
            safe(() => client.getCfg(sessionId, { rootFn, depth, minCount, foldLoops, includeIids }))
    );

    server.tool('get_fn_cfg',
        'Get IDA-style intra-function CFG (basic blocks + jump edges) by sampling calls.',
        {
            sessionId: z.string().describe('session ID'),
            fnName:    z.string().describe('target function name'),
            maxCalls:  z.number().int().optional().describe('max calls to sample (default 20, max 100)'),
        },
        async ({ sessionId, fnName, maxCalls = 20 }) =>
            safe(() => client.getFnCfg(sessionId, fnName, { maxCalls }))
    );

    server.tool('get_flamegraph',
        'Generate Speedscope-compatible flame graph JSON (importable at speedscope.app).',
        {
            sessionId: z.string().describe('session ID'),
            seqFrom:   z.number().int().optional().describe('start seq (optional, full trace if omitted)'),
            seqTo:     z.number().int().optional().describe('end seq (optional)'),
            maxDepth:  z.number().int().optional().describe('max call depth (default 20)'),
            minSelf:   z.number().optional().describe('filter small self-time functions (default 0)'),
        },
        async ({ sessionId, seqFrom, seqTo, maxDepth = 20, minSelf = 0 }) =>
            safe(() => client.getFlamegraph(sessionId, { seqFrom, seqTo, maxDepth, minSelf }))
    );

    server.tool('get_loop_detail',
        'Get per-iteration variable snapshots (reads+writes from A5 LoopDetector).',
        {
            sessionId: z.string().describe('session ID'),
            loopId:    z.number().int().optional().describe('loop ID (optional, returns all if omitted)'),
            seqFrom:   z.number().int().optional().describe('start seq filter (optional)'),
            seqTo:     z.number().int().optional().describe('end seq filter (optional)'),
            limit:     z.number().int().optional().describe('max iteration records (default 100)'),
            loopsOnly: z.boolean().optional().describe('return loop list only without iterations (default false)'),
        },
        async ({ sessionId, loopId, seqFrom, seqTo, limit = 100, loopsOnly = false }) =>
            safe(() => client.getLoopIterations(sessionId, {
                loopId, seqFrom, seqTo, limit, loopsOnly: loopsOnly ? 1 : 0,
            }))
    );

    // ── Dataflow / Taint ──────────────────────────────────────────────────────
    server.tool('trace_taint',
        'Taint tracking: forward=trace pollution path, backward=trace data source. Returns DAG.',
        {
            sessionId: z.string().describe('session ID'),
            varName:   z.string().describe('target variable name'),
            direction: z.enum(['forward','backward']).optional().describe('forward (default) or backward'),
            startSeq:  z.number().int().optional().describe('start event seq (optional)'),
        },
        async ({ sessionId, varName, direction = 'forward', startSeq = null }) =>
            safe(() => client.traceTaint(sessionId, varName, direction, startSeq))
    );

    server.tool('get_dataflow',
        'Query dataflow edges (A2 DataFlowGraph) with edge type and variable name filtering.',
        {
            sessionId: z.string().describe('session ID'),
            edgeType:  z.enum(['assign','copy','call_arg','call_ret','field_write','field_read']).optional().describe('edge type filter (optional)'),
            varName:   z.string().optional().describe('variable name fuzzy search (optional)'),
            varExact:  z.string().optional().describe('exact variable name (optional)'),
            seqFrom:   z.number().int().optional().describe('start seq filter (optional)'),
            seqTo:     z.number().int().optional().describe('end seq filter (optional)'),
            limit:     z.number().int().optional().describe('max results (default 100)'),
        },
        async ({ sessionId, edgeType, varName, varExact, seqFrom, seqTo, limit = 100 }) =>
            safe(() => client.getDataflow(sessionId,
                { edgeType, varName, varExact, seqFrom, seqTo, limit }))
    );

    server.tool('get_dataflow_subgraph',
        'BFS-expand N-hop dataflow subgraph centered on variable name or event ID.',
        {
            sessionId: z.string().describe('session ID'),
            varName:   z.string().optional().describe('starting variable name (choose one of varName/eventId)'),
            eventId:   z.number().int().optional().describe('starting event ID (choose one of varName/eventId)'),
            direction: z.enum(['forward','backward','both']).optional().describe('direction (default both)'),
            hops:      z.number().int().optional().describe('max hops (default 3, max 6)'),
            maxNodes:  z.number().int().optional().describe('max nodes (default 80)'),
        },
        async ({ sessionId, varName, eventId, direction = 'both', hops = 3, maxNodes = 80 }) =>
            safe(() => client.getDataflowSubgraph(sessionId,
                { varName, eventId, direction, hops, maxNodes }))
    );

    // ── Value search ──────────────────────────────────────────────────────────
    server.tool('value_search',
        'Search trace events by value (exact number/range/exact string/wildcard string).',
        {
            sessionId: z.string().describe('session ID'),
            str:       z.string().optional().describe('exact string value (optional)'),
            strLike:   z.string().optional().describe('wildcard string (* matches any, e.g. *secret*) (optional)'),
            num:       z.number().optional().describe('exact numeric value (optional)'),
            numMin:    z.number().optional().describe('numeric lower bound (optional)'),
            numMax:    z.number().optional().describe('numeric upper bound (optional)'),
            varName:   z.string().optional().describe('filter by variable name (optional)'),
            limit:     z.number().int().optional().describe('max results (default 50)'),
        },
        async ({ sessionId, str, strLike, num, numMin, numMax, varName, limit = 50 }) =>
            safe(() => client.valueSearchEvents(sessionId,
                { str, strLike, num, numMin, numMax, varName, limit }))
    );

    server.tool('get_value_patterns',
        'Get value pattern detection (A8: 35+ magic constants + semantic labels + Shannon entropy).',
        {
            sessionId:   z.string().describe('session ID'),
            patternType: z.string().optional().describe('semantic type filter: timestamp_ms/uuid/hex_str/base64_charset/etc (optional)'),
            onlyCrypto:  z.boolean().optional().describe('return only crypto magic constant matches (default false)'),
            varName:     z.string().optional().describe('filter by variable name (optional)'),
            limit:       z.number().int().optional().describe('max results (default 100)'),
        },
        async ({ sessionId, patternType, onlyCrypto = false, varName, limit = 100 }) =>
            safe(() => client.getValuePatterns(sessionId, {
                patternType, onlyCrypto: onlyCrypto ? '1' : undefined, varName, limit,
            }))
    );

    server.tool('get_object_timelines',
        'Get object property mutation timeline (A7 ObjectMutationTracker output).',
        {
            sessionId: z.string().describe('session ID'),
            seqFrom:   z.number().int().optional().describe('start seq filter (optional)'),
            seqTo:     z.number().int().optional().describe('end seq filter (optional)'),
            limit:     z.number().int().optional().describe('max results (default 100)'),
        },
        async ({ sessionId, seqFrom, seqTo, limit = 100 }) =>
            safe(() => client.getObjectTimelines(sessionId, { seqFrom, seqTo, limit }))
    );

    // ── Crypto / Signature / Web API ──────────────────────────────────────────
    server.tool('detect_crypto',
        'Detect cryptographic algorithm patterns (I1 CryptoDetector): algorithm, confidence 0-1, evidence.',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.detectCrypto(sessionId))
    );

    server.tool('analyze_signature',
        'Get comprehensive algorithm/signature analysis report (I4 AlgorithmSummarizer): Markdown + findings.',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.analyzeSignature(sessionId))
    );

    server.tool('get_summary',
        'Alias for analyze_signature. Get I4 AlgorithmSummarizer analysis summary report.',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.analyzeSignature(sessionId))
    );

    server.tool('get_web_api_calls',
        'Get Web API call detection (I5 WebApiDetector: BOM/DOM host object access, 3-level confidence).',
        {
            sessionId:       z.string().describe('session ID'),
            category:        z.string().optional().describe('host object category: window/document/navigator/fetch/xhr/storage/etc (optional)'),
            confidenceLevel: z.enum(['confirmed','propagated','inferred']).optional().describe('confidence filter (optional)'),
            search:          z.string().optional().describe('property name keyword (optional)'),
            limit:           z.number().int().optional().describe('max results (default 200)'),
        },
        async ({ sessionId, category, confidenceLevel, search, limit = 200 }) =>
            safe(() => client.getWebApiCalls(sessionId,
                { category, confidence_level: confidenceLevel, search, limit }))
    );

    // ── Bookmarks ─────────────────────────────────────────────────────────────
    server.tool('manage_bookmarks',
        'Manage event bookmarks: list all / create new / delete by ID.',
        {
            action:     z.enum(['list','create','delete']).describe('list | create | delete'),
            sessionId:  z.string().describe('session ID'),
            seq:        z.number().int().optional().describe('event seq (required for create)'),
            label:      z.string().optional().describe('bookmark title (optional for create)'),
            note:       z.string().optional().describe('bookmark note (optional for create)'),
            bookmarkId: z.number().int().optional().describe('bookmark ID (required for delete)'),
        },
        async ({ action, sessionId, seq, label = '', note = '', bookmarkId }) => {
            if (action === 'list')   return safe(() => client.listBookmarks(sessionId));
            if (action === 'create') return safe(() => client.createBookmark(sessionId, seq, label, note));
            if (action === 'delete') return safe(() => client.deleteBookmark(sessionId, bookmarkId));
            return errResult(new Error(`Unknown action: ${action}. Valid: list/create/delete`));
        }
    );

    // ── Plugin stats / Summary ────────────────────────────────────────────────
    server.tool('get_plugin_stats',
        'Get per-plugin output statistics summary (from plugin_checkpoints.summary_json).',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.getPluginStats(sessionId))
    );

    // ── Multi-session comparison ──────────────────────────────────────────────
    server.tool('compare_sessions',
        'Compare 2-8 sessions: overall metrics, function distribution, hot IIDs, loops.',
        {
            sessionIds: z.array(z.string()).describe('array of 2-8 session IDs'),
            dimensions: z.array(z.string()).optional().describe('dimensions: sessions/functions/hot-iids/loops (default all)'),
        },
        async ({ sessionIds, dimensions = ['sessions', 'functions', 'hot-iids', 'loops'] }) => {
            return safe(async () => {
                const results = {};
                const tasks = [];
                if (dimensions.includes('sessions'))  tasks.push(['sessions',  client.compareSessions(sessionIds)]);
                if (dimensions.includes('functions')) tasks.push(['functions', client.compareFunctions(sessionIds)]);
                if (dimensions.includes('hot-iids'))  tasks.push(['hot-iids',  client.compareHotIids(sessionIds)]);
                if (dimensions.includes('loops'))     tasks.push(['loops',     client.compareLoops(sessionIds)]);
                await Promise.all(tasks.map(async ([key, promise]) => {
                    results[key] = await promise;
                }));
                return results;
            });
        }
    );

    // ── Workspace (Projects) ──────────────────────────────────────────────────
    server.tool('list_projects',
        'List all workspaces (projects) with instrumentation status and sessions.',
        {},
        async () => safe(() => client.listProjects())
    );

    server.tool('get_project',
        'Get workspace (project) details: instrumentation status, sessions, file sizes.',
        {
            projectId: z.string().describe('project ID'),
        },
        async ({ projectId }) => safe(() => client.getProject(projectId))
    );

    // ── Storage / Trace files ─────────────────────────────────────────────────
    server.tool('get_storage_stats',
        'Scan data directory for storage statistics and cleanup suggestions.',
        {},
        async () => safe(() => client.getStorageStats())
    );

    server.tool('list_trace_files',
        'List WebSocket-collected trace files (.bin) in the traces directory.',
        {
            q:     z.string().optional().describe('search query (optional)'),
            limit: z.number().int().optional().describe('max results (default 100)'),
        },
        async ({ q, limit = 100 }) =>
            safe(() => client.listTraceFiles({ q, limit }))
    );

    server.tool('import_trace',
        'Import a trace .bin file from the traces directory as a new analysis session.',
        {
            filename:  z.string().describe('trace filename (e.g. trace_20260413_124434_932_005.bin)'),
            name:      z.string().optional().describe('session name (optional)'),
            projectId: z.string().optional().describe('workspace project ID to associate smap (optional)'),
        },
        async ({ filename, name = null, projectId = null }) =>
            safe(() => client.importTrace(filename, name, projectId))
    );

    // ── Session checkpoints ───────────────────────────────────────────────────
    server.tool('get_session_checkpoints',
        'Query plugin checkpoint/recovery status for a session (shows is_stale, duration_ms per plugin).',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.getSessionCheckpoints(sessionId))
    );

    // ── Project deletion ──────────────────────────────────────────────────────
    server.tool('delete_project',
        'Delete a workspace (project) and all associated files from disk and DB.',
        {
            projectId: z.string().describe('project ID to delete'),
        },
        async ({ projectId }) => safe(() => client.deleteProject(projectId))
    );

    // ── Trace collection stats ────────────────────────────────────────────────
    server.tool('get_trace_stats',
        'Get WebSocket trace collection statistics (connections, batches, events, bytes, uptime).',
        {},
        async () => safe(() => client.getTraceStats())
    );

    // ── Trace file management ─────────────────────────────────────────────────
    server.tool('manage_trace_files',
        'Manage trace .bin files: set alias / delete single file / batch delete files.',
        {
            action:   z.enum(['alias','delete','batch-delete']).describe('alias | delete | batch-delete'),
            name:     z.string().optional().describe('trace filename (required for alias/delete)'),
            alias:    z.string().optional().describe('new alias (required for alias action)'),
            names:    z.array(z.string()).optional().describe('array of filenames (required for batch-delete)'),
        },
        async ({ action, name, alias, names }) => {
            if (action === 'alias')        return safe(() => client.setTraceFileAlias(name, alias));
            if (action === 'delete')       return safe(() => client.deleteTraceFile(name));
            if (action === 'batch-delete') return safe(() => client.batchDeleteTraceFiles(names));
            return errResult(new Error(`Unknown action: ${action}. Valid: alias/delete/batch-delete`));
        }
    );

    // ── Storage cleanup ───────────────────────────────────────────────────────
    server.tool('storage_delete',
        'Batch delete orphaned uploads/session dirs/project dirs (items from get_storage_stats suggestions).',
        {
            items: z.array(z.object({
                type: z.enum(['upload','session_dir','project_dir']).describe('item type'),
                path: z.string().describe('absolute path of the item'),
                id:   z.string().optional().describe('session or project ID (if applicable)'),
            })).describe('array of items to delete (from get_storage_stats suggestions.items)'),
        },
        async ({ items }) => safe(() => client.storageDelete(items))
    );

    // ── Compare events ────────────────────────────────────────────────────────
    server.tool('compare_events',
        'Compare event type distribution across 2-8 sessions (counts per type per session).',
        {
            sessionIds: z.array(z.string()).describe('array of 2-8 session IDs'),
        },
        async ({ sessionIds }) => safe(() => client.compareEvents(sessionIds))
    );

    // ── Dataflow vars ─────────────────────────────────────────────────────────
    server.tool('get_dataflow_vars',
        'List all unique variable names appearing in dataflow edges (prefix search).',
        {
            sessionId: z.string().describe('session ID'),
            prefix:    z.string().optional().describe('variable name prefix filter (optional)'),
        },
        async ({ sessionId, prefix = '' }) =>
            safe(() => client.getDataflowVars(sessionId, prefix))
    );

    // ── Value dict ────────────────────────────────────────────────────────────
    server.tool('get_value_dict_stats',
        'Get value dictionary statistics (total count, breakdown by type, top referenced values).',
        {
            sessionId: z.string().describe('session ID'),
        },
        async ({ sessionId }) => safe(() => client.getValueDictStats(sessionId))
    );

    server.tool('get_value_dict',
        'Query value dictionary entries with type/text/range filters and pagination.',
        {
            sessionId:    z.string().describe('session ID'),
            type:         z.enum(['num','str','bool','null','obj']).optional().describe('value type filter (optional)'),
            text:         z.string().optional().describe('exact text match (optional)'),
            numMin:       z.number().optional().describe('numeric lower bound (optional, type=num only)'),
            numMax:       z.number().optional().describe('numeric upper bound (optional, type=num only)'),
            withRefCount: z.boolean().optional().describe('include reference count (slower, default false)'),
            offset:       z.number().int().optional().describe('pagination offset (default 0)'),
            limit:        z.number().int().optional().describe('max results (default 50)'),
        },
        async ({ sessionId, type, text, numMin, numMax, withRefCount = false, offset = 0, limit = 50 }) =>
            safe(() => client.getValueDict(sessionId, { type, text, numMin, numMax, withRefCount, offset, limit }))
    );

    server.tool('get_value_pattern_full_value',
        'Get the complete raw value for a value pattern match (A8, v2+).',
        {
            sessionId: z.string().describe('session ID'),
            patternId: z.number().int().describe('pattern ID from get_value_patterns results'),
        },
        async ({ sessionId, patternId }) =>
            safe(() => client.getValuePatternFullValue(sessionId, patternId))
    );

    server.tool('value_index_search',
        'Fallback string search in value_dict table (at least 2 chars, returns top 50 by occurrence count).',
        {
            sessionId: z.string().describe('session ID'),
            q:         z.string().describe('search keyword (at least 2 characters)'),
        },
        async ({ sessionId, q }) => safe(() => client.valueIndexSearch(sessionId, q))
    );

    // ── Call own events ───────────────────────────────────────────────────────
    server.tool('get_call_own_events',
        'Get event stream directly owned by a single call (excluding sub-call events), with pagination.',
        {
            sessionId: z.string().describe('session ID'),
            callId:    z.number().int().describe('call record ID (from get_function_calls id field)'),
            limit:     z.number().int().optional().describe('max results (default 50)'),
            offset:    z.number().int().optional().describe('pagination offset (default 0)'),
        },
        async ({ sessionId, callId, limit = 50, offset = 0 }) =>
            safe(() => client.getCallOwnEvents(sessionId, callId, { limit, offset }))
    );

    // ── Event owner function ──────────────────────────────────────────────────
    server.tool('get_event_owner_fn',
        'Find the nearest enclosing function call frame for a given event seq.',
        {
            sessionId: z.string().describe('session ID'),
            seq:       z.number().int().describe('event seq number'),
        },
        async ({ sessionId, seq }) => safe(() => client.getEventOwnerFn(sessionId, seq))
    );
}
