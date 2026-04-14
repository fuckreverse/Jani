#!/usr/bin/env node
/**
 * jta-mcp-stdio.mjs — JTA MCP Server (stdio transport)
 *
 * 用途：供本地 Claude Desktop / CatPaw / OpenClaw 等客户端直连使用。
 *
 * 启动方式：
 *   node mcp/jta-mcp-stdio.mjs [--jta-url http://localhost:33000]
 *
 * Claude Desktop 配置示例（claude_desktop_config.json）：
 *   {
 *     "mcpServers": {
 *       "jta": {
 *         "command": "node",
 *         "args": ["/path/to/jalangi2/analyzer/mcp/jta-mcp-stdio.mjs",
 *                  "--jta-url", "http://localhost:33000"]
 *       }
 *     }
 *   }
 *
 * CatPaw MCP 配置示例：
 *   Transport: stdio
 *   Command: node /path/to/analyzer/mcp/jta-mcp-stdio.mjs --jta-url http://localhost:33000
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JtaClient } from './client.mjs';
import { registerTools } from './tools.mjs';

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jtaUrlIdx = args.indexOf('--jta-url');
const JTA_URL = jtaUrlIdx >= 0 ? args[jtaUrlIdx + 1] : (process.env.JTA_URL || 'http://localhost:33000');

// ── 初始化 ────────────────────────────────────────────────────────────────────
const client = new JtaClient(JTA_URL);

const server = new McpServer({
    name: 'jta-mcp',
    version: '1.0.0',
});

// 注册所有工具
registerTools(server, client);

// ── 启动 stdio 传输 ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();

process.stderr.write(`[jta-mcp-stdio] Starting, JTA URL: ${JTA_URL}\n`);

await server.connect(transport);

process.stderr.write('[jta-mcp-stdio] Connected, ready to receive tool calls.\n');
