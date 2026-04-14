#!/usr/bin/env node
/**
 * jta-mcp-streamable.mjs — JTA MCP Server (Streamable HTTP transport)
 *
 * 遵循 MCP 2025-03-26 规范，适用于：
 *   - 新版 Claude Desktop
 *   - Cursor、CatPaw 等支持 Streamable HTTP 的客户端
 *   - 任何 MCP 兼容的远程 LLM 访问
 *
 * 启动方式：
 *   node mcp/jta-mcp-streamable.mjs [--port 4001] [--jta-url http://localhost:33000]
 *
 * 端点（单一端点，支持流式响应）：
 *   POST /mcp  — 所有 MCP 交互（initialize / tools/list / tools/call）
 *   GET  /mcp  — 建立 SSE 流（Streamable HTTP 模式）
 *
 * CatPaw / Cursor 配置示例（Streamable HTTP）：
 *   URL: http://localhost:4001/mcp
 *   Transport: streamable-http
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { JtaClient } from './client.mjs';
import { registerTools } from './tools.mjs';

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const portIdx   = args.indexOf('--port');
const jtaUrlIdx = args.indexOf('--jta-url');

const PORT    = portIdx   >= 0 ? Number(args[portIdx + 1])   : (process.env.MCP_PORT    ? Number(process.env.MCP_PORT)    : 4001);
const JTA_URL = jtaUrlIdx >= 0 ? args[jtaUrlIdx + 1]         : (process.env.JTA_URL                                       || 'http://localhost:33000');

// ── 初始化 ────────────────────────────────────────────────────────────────────
const client = new JtaClient(JTA_URL);
const app = express();
app.use(express.json());

// 存储活跃的 session（sessionId → { transport, server }）
const sessions = new Map();

// ── /mcp 端点 ─────────────────────────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // 已有会话：复用现有 transport
    if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
    }

    // 新会话：创建 server + transport
    const newSessionId = sessionId || randomUUID();
    const mcpServer = new McpServer({
        name: 'jta-mcp',
        version: '1.0.0',
    });
    registerTools(mcpServer, client);

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: mcpServer });
            console.error(`[jta-mcp-streamable] Session initialized: ${sid}`);
        },
    });

    // 会话关闭时清理
    transport.onclose = () => {
        sessions.delete(newSessionId);
        console.error(`[jta-mcp-streamable] Session closed: ${newSessionId}`);
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
        // GET /mcp 不带 session，返回说明
        res.status(400).json({
            error: 'Missing or invalid mcp-session-id header. Use POST /mcp first to initialize.',
        });
        return;
    }
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        sessions.delete(sessionId);
        console.error(`[jta-mcp-streamable] Session deleted: ${sessionId}`);
    } else {
        res.status(404).json({ error: `Session not found: ${sessionId}` });
    }
});

// 健康检查
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        transport: 'streamable-http',
        activeSessions: sessions.size,
        jtaUrl: JTA_URL,
    });
});

// ── 启动 ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.error(`[jta-mcp-streamable] Listening on http://localhost:${PORT}`);
    console.error(`[jta-mcp-streamable]   POST /mcp    — MCP Streamable HTTP endpoint`);
    console.error(`[jta-mcp-streamable]   GET  /mcp    — SSE stream (with mcp-session-id header)`);
    console.error(`[jta-mcp-streamable]   DELETE /mcp  — Close session`);
    console.error(`[jta-mcp-streamable]   JTA URL: ${JTA_URL}`);
    console.error('[jta-mcp-streamable] Ready for MCP 2025-03-26 compatible clients.');
});
