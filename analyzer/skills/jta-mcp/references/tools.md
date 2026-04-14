# JTA MCP Tools Reference (52 tools)

## Table of Contents
1. [Utility](#1-utility)
2. [Instrumentation & Execution](#2-instrumentation--execution)
3. [Session Management](#3-session-management)
4. [Event Query](#4-event-query)
5. [Function Analysis](#5-function-analysis)
6. [Hot Paths & Control Flow](#6-hot-paths--control-flow)
7. [Dataflow & Taint](#7-dataflow--taint)
8. [Value Search & Patterns](#8-value-search--patterns)
9. [Crypto / Signature / Web API](#9-crypto--signature--web-api)
10. [Bookmarks](#10-bookmarks)
11. [Multi-Session Comparison](#11-multi-session-comparison)
12. [Projects (Workspaces)](#12-projects-workspaces)
13. [Trace Files](#13-trace-files)
14. [Storage Management](#14-storage-management)

---

## 1. Utility

| Tool | Description |
|---|---|
| `health_check` | Ping JTA Server; returns status/version/uptime |

---

## 2. Instrumentation & Execution

| Tool | Key Params | Description |
|---|---|---|
| `instrument_code` | `code`, `filename?`, `sourceType?`, `preprocess?` | Instrument JS source; returns instrumented code + smap |
| `run_instrumented` | `code`, `filename?`, `env?` (node/jsdom), `preprocess?` | Run code in server sandbox (auto-instruments + ExecutionTrace); returns `runId` immediately |
| `get_run_status` | `runId` | Poll run status; when `status==="done"` returns `sessionId` |

---

## 3. Session Management

| Tool | Key Params | Description |
|---|---|---|
| `list_sessions` | — | List all sessions with status/eventCount/projectId |
| `get_session` | `sessionId` | Session detail: pluginStatus, fileInfo, smapCount |
| `delete_session` | `sessionId` | Delete session + all associated files and DB rows |
| `get_session_checkpoints` | `sessionId` | Plugin checkpoint recovery status; `is_stale=true` means needs re-run |
| `run_plugin` | `sessionId`, `plugins?[]`, `forceRerun?`, `phase?` | Trigger/re-run specific plugins or a whole phase |
| `get_plugin_stats` | `sessionId` | Per-plugin output statistics summary |

---

## 4. Event Query

| Tool | Key Params | Description |
|---|---|---|
| `query_events` | `sessionId`, `line?`, `type?`, `types?`, `varName?`, `seqFrom?`, `seqTo?`, `cursor?`, `limit?` | Filter trace events; cursor-based paging |
| `get_event_types` | `sessionId` | All event types and their counts |
| `get_event_owner_fn` | `sessionId`, `seq` | Find the nearest enclosing function call frame for an event |

---

## 5. Function Analysis

| Tool | Key Params | Description |
|---|---|---|
| `query_functions` | `sessionId`, `search?`, `sortBy?`, `minCalls?`, `hideBuiltin?`, `fnDefIid?`, `line?`, `limit?`, `offset?` | Aggregated function call stats |
| `get_function_calls` | `sessionId`, `fnName`, `fnDefIid?`, `callSeq?`, `limit?`, `offset?` | All call records for a function (args, return value, SEQ range) |
| `get_function_callers` | `sessionId`, `fnName`, `fnIid?`, `limit?` | Reverse call graph: who calls this function |
| `get_call_stack` | `sessionId`, `callSeq`, `returnSeq`, `depth?` | Full ancestor call stack for one invocation |
| `get_annotated_source` | `sessionId`, `callId` | Function source + per-line exec counts + variable values for one call |
| `get_call_own_events` | `sessionId`, `callId`, `limit?`, `offset?` | Events directly owned by one call (sub-calls excluded) |

---

## 6. Hot Paths & Control Flow

| Tool | Key Params | Description |
|---|---|---|
| `get_hot_paths` | `sessionId`, `topN?` | Top-N most-executed IIDs with line/srcText |
| `get_call_graph` | `sessionId`, `rootFn?`, `depth?` | Function call graph (nodes + edges with call counts) |
| `get_cfg` | `sessionId`, `rootFn?`, `depth?`, `minCount?`, `foldLoops?`, `includeIids?` | Dynamic control flow graph (function topology + loop/hotspot nodes) |
| `get_fn_cfg` | `sessionId`, `fnName`, `maxCalls?` | IDA-style intra-function CFG (basic blocks + jump edges) |
| `get_flamegraph` | `sessionId`, `seqFrom?`, `seqTo?`, `maxDepth?`, `minSelf?` | Speedscope-compatible flamegraph JSON |
| `get_loop_detail` | `sessionId`, `loopId?`, `seqFrom?`, `seqTo?`, `limit?`, `loopsOnly?` | Loop list + per-iteration variable snapshots (A5 output) |

---

## 7. Dataflow & Taint

| Tool | Key Params | Description |
|---|---|---|
| `trace_taint` | `sessionId`, `varName`, `direction?` (forward/backward), `startSeq?` | Taint tracking DAG: upstream sources or downstream sinks |
| `get_dataflow` | `sessionId`, `edgeType?`, `varName?`, `varExact?`, `seqFrom?`, `seqTo?`, `limit?` | Raw dataflow edges (A2 output) |
| `get_dataflow_subgraph` | `sessionId`, `varName?`, `eventId?`, `direction?`, `hops?`, `maxNodes?` | BFS N-hop subgraph centered on variable or event |
| `get_dataflow_vars` | `sessionId`, `prefix?` | All unique variable names in dataflow edges |

---

## 8. Value Search & Patterns

| Tool | Key Params | Description |
|---|---|---|
| `value_search` | `sessionId`, `str?`, `strLike?`, `num?`, `numMin?`, `numMax?`, `varName?`, `limit?` | Search events by value (exact/wildcard/range); returns full event objects |
| `value_index_search` | `sessionId`, `q` | Fallback: search value_dict strings (≥2 chars, top 50 by frequency) |
| `get_value_patterns` | `sessionId`, `patternType?`, `onlyCrypto?`, `varName?`, `limit?` | A8 pattern detection: 35+ magic constants, semantic labels, entropy |
| `get_value_pattern_full_value` | `sessionId`, `patternId` | Get complete raw value for a pattern match |
| `get_value_dict_stats` | `sessionId` | Value dictionary stats: total, breakdown by type, top referenced values |
| `get_value_dict` | `sessionId`, `type?`, `text?`, `numMin?`, `numMax?`, `withRefCount?`, `offset?`, `limit?` | Query value dictionary entries |
| `get_object_timelines` | `sessionId`, `seqFrom?`, `seqTo?`, `limit?` | Object property mutation timeline (A7 output) |

---

## 9. Crypto / Signature / Web API

| Tool | Key Params | Description |
|---|---|---|
| `detect_crypto` | `sessionId` | I1 CryptoDetector: algorithm, confidence 0-1, evidence |
| `analyze_signature` | `sessionId` | I4 AlgorithmSummarizer: full Markdown report + findings |
| `get_summary` | `sessionId` | Alias for `analyze_signature` |
| `get_web_api_calls` | `sessionId`, `category?`, `confidenceLevel?`, `search?`, `limit?` | I5 WebApiDetector: BOM/DOM host object access (fetch/XHR/navigator/etc.) |

---

## 10. Bookmarks

| Tool | Key Params | Description |
|---|---|---|
| `manage_bookmarks` | `action` (list/create/delete), `sessionId`, `seq?`, `label?`, `note?`, `bookmarkId?` | Create/list/delete event bookmarks for annotation |

---

## 11. Multi-Session Comparison

| Tool | Key Params | Description |
|---|---|---|
| `compare_sessions` | `sessionIds[]`, `dimensions?` | Compare 2-8 sessions: metrics/functions/hot-iids/loops (aggregated) |
| `compare_events` | `sessionIds[]` | Compare event type distribution across sessions |

> `compare_sessions` with `dimensions: ["sessions","functions","hot-iids","loops"]` calls all 4 compare APIs in parallel.

---

## 12. Projects (Workspaces)

| Tool | Key Params | Description |
|---|---|---|
| `list_projects` | — | List all workspaces with instrumentation status and sessions |
| `get_project` | `projectId` | Workspace details: instrumentation status, sessions, file sizes |
| `delete_project` | `projectId` | Delete workspace + all files from disk and DB |

---

## 13. Trace Files

| Tool | Key Params | Description |
|---|---|---|
| `list_trace_files` | `q?`, `limit?` | List `.bin` trace files collected via WebSocket |
| `import_trace` | `filename`, `name?`, `projectId?` | Import `.bin` file as a new analysis session |
| `get_trace_stats` | — | WebSocket Trace collection stats (connections/events/bytes/uptime) |
| `manage_trace_files` | `action` (alias/delete/batch-delete), `name?`, `alias?`, `names?[]` | Set alias, delete, or batch-delete trace files |

---

## 14. Storage Management

| Tool | Key Params | Description |
|---|---|---|
| `get_storage_stats` | — | Scan data directory: sizes, breakdown, cleanup suggestions |
| `storage_delete` | `items[]` ({type, path, id?}) | Batch delete orphaned uploads/session dirs/project dirs |
