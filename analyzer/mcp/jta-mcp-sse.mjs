#!/usr/bin/env node
/**
 * jta-mcp-sse.mjs — JTA MCP Server (HTTP SSE transport，旧版兼容)
 *
 * 适用场景：远程 LLM、支持 MCP HTTP SSE 协议的旧版客户端。
 * 新版客户端推荐使用 jta-mcp-streamable.mjs（Streamable HTTP）。
 *
 * 启动方式：
 *   node mcp/jta-mcp-sse.mjs [--port 4000] [--jta-url http://localhost:33000]
 *
 * 端点：
 *   GET  /sse       — 建立 SSE 事件流（客户端订阅）
 *   POST /messages  — 发送 Tool 调用请求
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { JtaClient } from './client.mjs';
import { registerTools } from './tools.mjs';

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const portIdx   = args.indexOf('--port');
const jtaUrlIdx = args.indexOf('--jta-url');

const PORT    = portIdx   >= 0 ? Number(args[portIdx + 1])   : (process.env.MCP_PORT    ? Number(process.env.MCP_PORT)    : 4000);
const JTA_URL = jtaUrlIdx >= 0 ? args[jtaUrlIdx + 1]         : (process.env.JTA_URL                                       || 'http://localhost:33000');

// ── 初始化 ────────────────────────────────────────────────────────────────────
const client = new JtaClient(JTA_URL);

// 每个 SSE 连接对应一个独立的 McpServer + Transport 实例
const app = express();
app.use(express.json());

// 存储活跃的 SSE transport（连接 ID → transport）
const activeTransports = new Map();

app.get('/sse', async (req, res) => {
    console.error(`[jta-mcp-sse] New SSE connection from ${req.ip}`);

    // 为每个 SSE 连接创建独立的 server + transport
    const mcpServer = new McpServer({
        name: 'jta-mcp',
        version: '1.0.0',
    });
    registerTools(mcpServer, client);

    const transport = new SSEServerTransport('/messages', res);
    activeTransports.set(transport.sessionId, transport);

    res.on('close', () => {
        console.error(`[jta-mcp-sse] SSE connection closed: ${transport.sessionId}`);
        activeTransports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
    console.error(`[jta-mcp-sse] MCP Server connected, sessionId: ${transport.sessionId}`);
});

app.post('/messages', async (req, res) => {
    // 从查询参数或 header 获取 sessionId，路由到对应 transport
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId query parameter' });
    }

    const transport = activeTransports.get(sessionId);
    if (!transport) {
        return res.status(404).json({ error: `No active SSE connection for sessionId: ${sessionId}` });
    }

    await transport.handlePostMessage(req, res, req.body);
});

// 健康检查
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        transport: 'sse',
        activeConnections: activeTransports.size,
        jtaUrl: JTA_URL,
    });
});

// ── 启动 ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.error(`[jta-mcp-sse] Listening on http://localhost:${PORT}`);
    console.error(`[jta-mcp-sse]   GET  /sse      — SSE event stream`);
    console.error(`[jta-mcp-sse]   POST /messages — Tool call endpoint`);
    console.error(`[jta-mcp-sse]   JTA URL: ${JTA_URL}`);
});
