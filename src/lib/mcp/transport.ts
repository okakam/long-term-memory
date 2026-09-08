import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { getMemoryService } from '@/lib/memory/singleton';
import { authRequired } from '@/lib/auth/config';
import { assertProjectAccess } from '@/lib/auth/access';
import { requireMcpPrincipal } from '@/lib/auth/pat';
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

  const maintenanceToken = extractMaintenanceToken(req);
  const writeTools = new Set([
    'remember_user_fact', 'remember_reference', 'remember_session_summary',
    'remember_feedback', 'remember_project_fact', 'update_memory',
    'forget_memory', 'link_memories',
  ]);
  const maintenanceTools = new Set(['reindex']);
  const toolName = typeof message === 'object' && message !== null && 'params' in message
    && typeof (message as { params?: unknown }).params === 'object'
    && (message as { params?: { name?: unknown } }).params?.name;
  const isWrite = typeof toolName === 'string' && writeTools.has(toolName);
  const isMaintenance = typeof toolName === 'string' && maintenanceTools.has(toolName);
  let principal: { userId: string; tokenId: string } | undefined;
  if (authRequired()) {
    try {
      principal = await requireMcpPrincipal(req);
      if (isWrite && projectId === '__shared__'
        && (!grantsSharedWrite(maintenanceToken) || principal.userId !== process.env.LTM_CURATOR_USER_ID)) {
        return new Response('project access denied', { status: 403 });
      }
      await assertProjectAccess(principal, projectId, isMaintenance ? 'maintain' : (isWrite ? (projectId === '__shared__' ? 'maintain' : 'write') : 'read'));
    } catch (error) {
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 401;
      return new Response(status === 403 ? 'project access denied' : 'authentication required', { status });
    }
  }
  const canWriteShared = grantsSharedWrite(maintenanceToken)
    && (!authRequired() || principal?.userId === process.env.LTM_CURATOR_USER_ID);
  const ctx: ToolContext = {
    projectId,
    svc: options.service ?? getMemoryService(),
    canWriteShared,
    principal,
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
