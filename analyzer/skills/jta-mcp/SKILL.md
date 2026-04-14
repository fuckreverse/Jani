---
name: jta-mcp
description: "JTA (Jani Trace Analyzer) MCP Server usage guide. Use when analyzing JavaScript code with JTA MCP tools — instrument code, create/query analysis sessions, trace functions/values/dataflow/crypto, compare sessions, manage trace files. Activate on keywords like: JTA, trace analysis, sessionId, instrument code, function calls, taint tracking, crypto detection, hot paths, dataflow, MCP tools."
---

# JTA MCP Server

JTA (Jani Trace Analyzer) is a JS dynamic analysis platform. Its 52 MCP tools expose the full analysis pipeline.

## Start the Server

```bash
cd analyzer
npm run mcp:stdio        # stdio transport (Claude Desktop / CatPaw)
npm run mcp:sse          # SSE transport  (port 4000)
npm run mcp:streamable   # Streamable HTTP (port 4001)
```

JTA Server itself must also be running (separate process):
```bash
cd analyzer && npm run dev   # or: node server.mjs
```
Default JTA Server port: **33000**. MCP tools auto-connect to `http://localhost:33000`.

## Get a sessionId (Required by Most Tools)

Every analysis tool requires a `sessionId`. There are two ways to obtain one:

**Option A — Analyze code inline:**
1. `run_instrumented` → returns `runId` immediately
2. Poll `get_run_status(runId)` until `status === "done"` → response contains `sessionId`
3. Use `sessionId` in analysis tools

**Option B — Import an existing trace file:**
1. `list_trace_files` → find `.bin` filename
2. `import_trace(filename)` → returns `sessionId`

**Option C — Use an existing session:**
1. `list_sessions` → pick a `sessionId` from the list

## Reference Files

Read these reference files when needed — do NOT preload all of them:

| File | Load when... |
|---|---|
| [references/sop.md](references/sop.md) | User wants to analyze code or asks "how do I..."; contains step-by-step SOPs for 5 analysis scenarios |
| [references/tools.md](references/tools.md) | Need to find the right tool for a task; contains all 52 tools grouped by category |
| [references/concepts.md](references/concepts.md) | Confused about IDs (seq/iid/callId/callSeq/fnDefIid) or pagination; contains the full ID reference and plugin execution order |
