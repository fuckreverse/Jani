# JTA Analysis SOPs

## Table of Contents
1. [SOP-1: Analyze a Code Snippet](#sop-1-analyze-a-code-snippet)
2. [SOP-2: Function Behavior Deep Dive](#sop-2-function-behavior-deep-dive)
3. [SOP-3: Trace a Value's Origin or Propagation](#sop-3-trace-a-values-origin-or-propagation)
4. [SOP-4: Detect Crypto / Obfuscation / Signing Logic](#sop-4-detect-crypto--obfuscation--signing-logic)
5. [SOP-5: Performance Hot Path Analysis](#sop-5-performance-hot-path-analysis)

---

## SOP-1: Analyze a Code Snippet

**Goal:** Run JS code through JTA, collect a trace, get a sessionId to start analysis.

```
1. run_instrumented(code, filename?)
      → { runId }

2. [Loop] get_run_status(runId)   ← poll every 1-2s until status === "done"
      → { status, sessionId, stdout, stderr, exitCode }
      ⚠ If status === "error": show stderr to user, stop.

3. get_session(sessionId)
      → confirms pluginStatus, smapAvailable, eventCount

4. [If plugins still running] wait, then re-check get_session or get_plugin_stats
      → Phase1 (F1) is instant; Phase2–4 run in background (~seconds to minutes)

5. Start analysis → go to SOP-2 / SOP-3 / SOP-4 based on user goal
```

**Notes:**
- `env` defaults to `"node"`. Use `env: "jsdom"` for browser-API-heavy code.
- `preprocess: { enabled: true, preset: "full" }` helps with minified/obfuscated input.
- If code is already instrumented or huge, use `import_trace` instead.

---

## SOP-2: Function Behavior Deep Dive

**Goal:** Understand what a specific function does, how often it's called, what args/return values it sees.

```
1. query_functions(sessionId, { search: "funcName", limit: 20 })
      → { functions: [{ fn_name, fn_def_iid, call_count, event_count, min_line }] }
      ⚠ Use fn_def_iid to disambiguate overloaded names in next steps.

2. get_function_calls(sessionId, fnName, { fnDefIid, limit: 50 })
      → { calls: [{ id, call_seq, return_seq, depth, args, return_value }] }
      Key fields: id = callId, call_seq/return_seq = SEQ range of this invocation

3. [Pick one call] get_annotated_source(sessionId, callId)
      → { lines: [{ line, srcText, execCount, writes, reads }] }
      → Shows per-line execution count + variable values for that exact call

4. [Drill into events] get_call_own_events(sessionId, callId, { limit: 50 })
      → { events: [...], total }
      → Only events directly owned by this call (sub-calls excluded)

5. [Understand callers] get_function_callers(sessionId, fnName, { fnIid })
      → { callers: [{ callerFnName, callCount }], totalCalls }

6. [Get full call stack for one call] get_call_stack(sessionId, callSeq, returnSeq, depth)
      → { stack: [{ fnName, depth, args, callSeq, returnSeq }] }
```

**Tips:**
- `call_count` = total invocations; `event_count` = average events per call (complexity indicator).
- If the function appears many times with different `fn_def_iid`, it's defined in multiple places (same name, different code).
- Use `get_call_stack` when you need to understand what triggered a specific call.

---

## SOP-3: Trace a Value's Origin or Propagation

**Goal:** Find where a specific value comes from or where it flows to.

```
1. [Find events containing the value]
   value_search(sessionId, { str: "target_value", limit: 50 })
   OR value_search(sessionId, { strLike: "*secret*", limit: 50 })
   OR value_search(sessionId, { num: 12345 })
      → { events: [{ event_id, var_name, val_str, seq }] }

2. [Find which function owns the event]
   get_event_owner_fn(sessionId, seq)
      → { call: { fnName, callSeq, returnSeq, depth } }

3. [Trace backward: find where the value came from]
   trace_taint(sessionId, varName, "backward", startSeq?)
      → { nodes, edges }  — DAG of upstream data sources

4. [Trace forward: find where value flows to]
   trace_taint(sessionId, varName, "forward")
      → DAG of downstream consumers

5. [Expand N-hop dataflow subgraph]
   get_dataflow_subgraph(sessionId, { varName, direction: "both", hops: 3 })
      → { nodes, edges, stats }
      → Visualize as graph; nodes are vars or events

6. [Get raw dataflow edges]
   get_dataflow(sessionId, { varName: "target", edgeType: "assign" })
      → { edges: [{ from_var, to_var, edge_type, from_line, to_line }] }
```

**Tips:**
- `value_index_search(sessionId, q)` is a fallback when you only have a partial string.
- `get_value_patterns` finds crypto-like values (high entropy, magic constants) automatically.
- Use `get_dataflow_vars(sessionId, prefix)` to discover variable names in the dataflow graph.

---

## SOP-4: Detect Crypto / Obfuscation / Signing Logic

**Goal:** Reverse-engineer what cryptographic or signing algorithm a JS script uses.

```
1. [Quick overview]
   detect_crypto(sessionId)
      → { algorithms: [{ name, confidence, evidence }] }
      → Confidence 0-1; >0.7 = high confidence

2. [Find crypto magic constants & entropy patterns]
   get_value_patterns(sessionId, { onlyCrypto: true, limit: 100 })
      → { patterns: [{ value_hash, count, matched_constant, pattern_type, entropy, var_name }] }

3. [Get full value of a pattern match (e.g. a key schedule constant)]
   get_value_pattern_full_value(sessionId, patternId)
      → { fullValue: "..." }

4. [Find browser/Node API usage (fetch, crypto.subtle, XHR, etc.)]
   get_web_api_calls(sessionId, { category: "fetch" })
   get_web_api_calls(sessionId, { category: "xhr" })
   get_web_api_calls(sessionId, { search: "sign" })
      → { items: [{ property_name, host_obj, access_type, confidence_level, line }] }

5. [Get the full analysis report]
   analyze_signature(sessionId)   OR   get_summary(sessionId)
      → Markdown report with findings, algorithm summary, suspicion indicators

6. [Inspect specific function that handles the crypto]
   → Go to SOP-2 with the suspected function name from step 1/5
```

**Tips:**
- `detect_crypto` runs plugin I1; `analyze_signature` runs I4 (more comprehensive).
- `get_value_patterns` with `patternType: "base64_charset"` finds base64-encoded payloads.
- `get_value_patterns` with `patternType: "uuid"` or `patternType: "hex_str"` finds nonce/token patterns.
- If plugins haven't run: `run_plugin(sessionId, { plugins: ["I1_CryptoDetector", "I4_AlgorithmSummarizer"] })`.

---

## SOP-5: Performance Hot Path Analysis

**Goal:** Find which code runs most frequently and understand loop behavior.

```
1. [Find hottest execution locations]
   get_hot_paths(sessionId, { topN: 20 })
      → [{ iid, line, srcText, count }]  — sorted by execution count

2. [Flamegraph for overall time distribution]
   get_flamegraph(sessionId, { maxDepth: 20 })
      → Speedscope-compatible JSON — import at speedscope.app

3. [Function-level call distribution]
   query_functions(sessionId, { sortBy: "event_count", limit: 20 })
      → Functions sorted by complexity (avg own event count)

4. [IDA-style CFG for a hot function]
   get_fn_cfg(sessionId, fnName, { maxCalls: 20 })
      → { blocks, edges }  — basic blocks + jump edges

5. [Detect loops and their iteration counts]
   get_loop_detail(sessionId, { loopsOnly: true })
      → { loops: [{ id, iid, line, src_text, iteration_count, median_gap }] }

6. [Inspect a specific loop's per-iteration variable snapshots]
   get_loop_detail(sessionId, { loopId, limit: 50 })
      → { iterations: [{ iteration_idx, vars_snapshot: { w: {writes}, r: {reads} } }] }

7. [Dynamic CFG across all functions]
   get_cfg(sessionId, { rootFn: "hotFunctionName", depth: 4 })
      → { nodes, edges }  — function call topology with loop annotations
```

**Tips:**
- `get_flamegraph` with `seqFrom/seqTo` focuses on a time window (e.g. one request).
- High `iteration_count` with low `median_gap` = tight inner loop = prime optimization target.
- Use `get_call_graph` to see the overall call tree depth and call counts per edge.

## Validate analysis before interpreting results

Check session status and trace_integrity before concluding. A failed/blocked plugin is not a successful empty result. Rerun stale checkpoints; preserve and inspect original Trace on import failure. Treat old traces without dynamic identities and unverified-end traces as incomplete evidence. Run arbitrary untrusted JavaScript only in an external OS sandbox; the local Node runner is not one.

## Large dataflow sessions

Run A2-DataFlowGraph to publish disk shards, then query small subgraphs around specific event IDs or variables. Respect stats.truncated and expand in bounded steps. A failed rebuild preserves the previous successful generation; inspect checkpoint status before interpreting it. Rebuild interrupted jobs from source rather than trying to use partial shard directories.
