import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { getMemoryService } from '@/lib/memory/singleton';
import { extractMaintenanceToken, extractProjectId } from './context';
import { grantsSharedWrite } from './auth';
import { createMcpSession, getOrCreateSession, McpRequestTimeoutError, type McpSession } from './session';
import type { ToolContext } from './context';

export type McpTransportMode = 'local-session' | 'vercel-stateless';

export interface McpRequestOptions {
  mode?: McpTransportMode;
  timeoutMs?: number;
  service?: ToolContext['svc'];
}

function defaultMode(): McpTransportMode {
  return process.env.VERCEL === '1' ? 'vercel-stateless' : 'local-session';
}

function jsonResponse(value: unknown, status = 200, request: Request | null = null): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  const diagnosticSessionId = request?.headers.get('mcp-session-id');
  if (diagnosticSessionId) headers.set('mcp-session-id', diagnosticSessionId);
  return new Response(JSON.stringify(value), { status, headers });
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function errorResponse(id: string | number | null, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

function isJsonRpcRequest(value: unknown): value is JSONRPCMessage & { method: string } {
  return typeof value === 'object' && value !== null && 'jsonrpc' in value && 'method' in value
    && (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
    && typeof (value as { method?: unknown }).method === 'string';
}

function hasId(value: JSONRPCMessage): value is JSONRPCMessage & { id: string | number } {
  return 'id' in value && value.id !== undefined && value.id !== null;
}

async function dispatch(session: McpSession, message: JSONRPCMessage, timeoutMs: number): Promise<JSONRPCMessage | undefined> {
  if ('method' in message && message.method === 'initialize') {
    return session.acceptInitialize(message, timeoutMs);
  }
  await session.initialize(timeoutMs);
  return session.send(message, timeoutMs);
}

export async function handleMcpRequest(req: Request, options: McpRequestOptions = {}): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let projectId: string;
  try {
    projectId = extractProjectId(new URL(req.url));
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : String(error));
  }

  let message: unknown;
  try {
    message = await req.json();
  } catch {
    return badRequest('invalid JSON body');
  }
  if (!isJsonRpcRequest(message)) return badRequest('invalid JSON body');

  const canWriteShared = grantsSharedWrite(extractMaintenanceToken(req));
  const ctx: ToolContext = {
    projectId,
    svc: options.service ?? getMemoryService(),
    canWriteShared,
  };
  const mode = options.mode ?? defaultMode();
  const timeoutMs = options.timeoutMs ?? 30_000;
  let session: McpSession;
  try {
    session = mode === 'vercel-stateless' ? await createMcpSession(ctx) : await getOrCreateSession(ctx);
    const response = await dispatch(session, message as JSONRPCMessage, timeoutMs);
    if (!hasId(message as JSONRPCMessage)) {
      if (mode === 'vercel-stateless') await session.close();
      return new Response(null, { status: 202 });
    }
    if (mode === 'vercel-stateless') await session.close();
    return jsonResponse(response, 200, req);
  } catch (error) {
    if (mode === 'vercel-stateless' && session!) await session.close().catch(() => undefined);
    if (error instanceof McpRequestTimeoutError) {
      const id = hasId(message as JSONRPCMessage) ? (message as { id: string | number }).id : null;
      return errorResponse(id, -32000, 'timeout waiting for MCP response');
    }
    throw error;
  }
}
