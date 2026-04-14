# JTA Core Concepts

## Table of Contents
1. [ID Reference: seq / iid / callId / callSeq / fnDefIid / fnIid](#1-id-reference)
2. [Event Types](#2-event-types)
3. [Plugin Execution Order (Phase 1–4)](#3-plugin-execution-order)
4. [Pagination Mechanisms](#4-pagination-mechanisms)
5. [Value Pattern Types](#5-value-pattern-types)

---

## 1. ID Reference

| ID | Type | Meaning | Where to get it |
|---|---|---|---|
| `sessionId` | string UUID | Identifies an analysis session | `list_sessions`, `run_instrumented`→`get_run_status` |
| `seq` | integer | Sequential event number (1-based, unique per session) | Any event object's `seq` or `id` field |
| `iid` | integer (step=8) | Instruction ID — identifies a specific AST node in the instrumented code; same node always gets same iid | `iidSourceInfo` in smap, any event's `iid` field |
| `callId` | integer | Primary key of a `call_edges` DB row — identifies one specific function invocation | `get_function_calls` → `calls[].id` |
| `callSeq` | integer | The `seq` of the CALL_PRE event that started an invocation (= start of SEQ range) | `get_function_calls` → `calls[].call_seq` |
| `returnSeq` | integer | The `seq` of the RETURN event that ended an invocation (= end of SEQ range) | `get_function_calls` → `calls[].return_seq` |
| `fnDefIid` | integer | iid of the function *definition* site — same for every call to the same function body | `get_function_calls` → `calls[].fn_def_iid`; `query_functions` → `functions[].fn_def_iid` |
| `fnIid` | integer | iid of the function *call* site — where the call was made from | `get_function_callers` → `callers[].callerFnIid` |
| `projectId` | string UUID | Workspace identifier (holds the original JS + instrumented version + smap) | `list_projects` |
| `patternId` | integer | Primary key in `value_patterns` table | `get_value_patterns` → `patterns[].id` |

### Common Confusion: callId vs callSeq

- Use `callId` when calling `get_annotated_source` or `get_call_own_events` (DB row PK).
- Use `callSeq` + `returnSeq` when calling `get_call_stack` (SEQ-based range lookup).
- Both come from `get_function_calls` response.

### Common Confusion: fnDefIid vs fnIid

- `fnDefIid` → points to the function body definition. Use to uniquely identify a function even when multiple call sites exist. Preferred for all filtering.
- `fnIid` → points to the call site expression. Used in `get_function_callers` to filter by caller location.

### IID numbering

- IIDs increment by **8** (not 1). Multiple sub-operations on the same AST node share a consecutive range.
- IID `0` is special — used for events that don't map to a source position.

---

## 2. Event Types

Key event types you'll encounter in `query_events` results:

| Type | Meaning |
|---|---|
| `CALL_PRE` | Function call about to happen (args available) |
| `CALL` | Function returned (return value available) |
| `END_EXPR` | Expression evaluated (value available) |
| `READ` | Variable read |
| `WRITE` | Variable write |
| `GET_FIELD` | Property read (`obj.prop`) |
| `PUT_FIELD` | Property write (`obj.prop = val`) |
| `BINARY` | Binary operator evaluated |
| `UNARY` | Unary operator evaluated |
| `CONDITIONAL` | Branch condition evaluated |
| `RETURN` | Return statement executed |
| `LITERAL` | Literal value encountered |

Use `get_event_types(sessionId)` to see all types present + their counts in a specific session.

---

## 3. Plugin Execution Order

Plugins run in 4 phases. Later phases depend on earlier ones.

```
Phase 1 (synchronous, runs on session creation):
  F1_EventIndex       — indexes all events into SQLite; enables all event queries

Phase 2 (background, auto-scheduled after Phase 1):
  F2_SmapLoader       — loads source map; enables line↔iid mapping + srcText fields
  F3_CallGraphBuilder — builds call_edges table; enables function analysis
  F4_VariableLifetime — lifetime analysis for variable reads/writes

Phase 3 (background, after Phase 2):
  A1_TaintTracker     — taint propagation (enables trace_taint)
  A2_DataFlowGraph    — dataflow edges (enables get_dataflow*)
  A3_HotPathAnalyzer  — iid execution counts (enables get_hot_paths, get_cfg)
  A5_LoopDetector     — loop detection (enables get_loop_detail)
  A7_ObjectMutationTracker — property timelines (enables get_object_timelines)
  A8_ValuePatternDetector  — pattern detection (enables get_value_patterns)

Phase 4 (background, after Phase 3):
  I1_CryptoDetector   — crypto pattern detection (enables detect_crypto)
  I2_SignatureAnalyzer
  I3_ObfuscationDetector
  I4_AlgorithmSummarizer — full report (enables analyze_signature)
  I5_WebApiDetector   — Web API detection (enables get_web_api_calls)
```

**If a tool returns empty results**, check `get_session_checkpoints(sessionId)` — the required plugin may not have run yet. Trigger manually with `run_plugin(sessionId, { plugins: ["PluginId"] })`.

---

## 4. Pagination Mechanisms

### Cursor paging (recommended for sequential browsing)

```
First page:  query_events(sessionId, { limit: 50 })
             → response: { events, hasMore, nextCursor }

Next page:   query_events(sessionId, { cursor: nextCursor, limit: 50 })
             → response: { events, hasMore, nextCursor }
```
- Cursor = last `seq` of the previous page
- O(log N) B-tree lookup; efficient for deep pages

### seqFrom positioning (for jumping to a specific seq)

```
query_events(sessionId, { seqFrom: 12345, limit: 50 })
```
- Jumps directly to seq ≥ 12345
- Used when cross-referencing from another tool's result

### Offset paging (simple, for functions/values)

```
get_function_calls(sessionId, fnName, { limit: 100, offset: 200 })
get_value_dict(sessionId, { limit: 50, offset: 100 })
```
- Standard `offset + limit`; less efficient for very deep pages

---

## 5. Value Pattern Types

Used in `get_value_patterns(sessionId, { patternType: "..." })`:

| patternType | Meaning |
|---|---|
| `timestamp_ms` | Unix timestamp in milliseconds (13-digit number) |
| `timestamp_s` | Unix timestamp in seconds (10-digit number) |
| `uuid` | UUID string format |
| `hex_str` | Pure hex string (even length, ≥16 chars) |
| `base64_charset` | Characters all in base64 alphabet |
| `base64_encoded` | Valid base64-encoded content |
| `custom_alphabet` | Repeated use of a custom character set (token alphabet) |
| `ip_addr` | IPv4 or IPv6 address |
| `url` | URL string |
| `json_obj` | JSON-serialized object |
| `byte_array` | Array of integers 0-255 |

**Crypto magic constants** (detected by `onlyCrypto: true`): S-box constants, MD5/SHA round constants, AES key schedule constants, etc. The `matched_constant` field names the specific constant matched.

**Entropy**: Shannon entropy of the value string. High entropy (>4.5 bits/char) suggests encrypted or random data.
