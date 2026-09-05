import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolContext } from './context';
import { registerMetaTools } from './tools/meta';
import { registerReadTools } from './tools/read';
import { registerWriteTools } from './tools/write';

export type { ToolContext } from './context';

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'long-term-memory', version: '0.1.0' });
  registerWriteTools(server, ctx);
  registerReadTools(server, ctx);
  registerMetaTools(server, ctx);
  return server;
}
