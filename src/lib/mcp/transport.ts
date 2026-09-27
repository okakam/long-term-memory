import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { getMemoryService } from '@/lib/memory/singleton';
import { authRequired } from '@/lib/auth/config';
import { getOAuthConfiguration } from '@/lib/oauth/config';
import { oauthInsufficientScopeResponse, oauthUnauthorizedResponse } from '@/lib/oauth/http';
import { OAuthProtocolError } from '@/lib/oauth/service';
import { createProjectAccessGuard, extractMaintenanceToken } from './context';
import { grantsSharedWrite } from './auth';
import { requireMcpPrincipal, type McpPrincipal } from './principal';
import { createMcpSession, getOrCreateSession, McpRequestTimeoutError, type McpSession } from './session';
import type { ToolContext } from './context';

export type McpTransportMode = 'local-session' | 'stateless';

export interface McpRequestOptions {
  mode?: McpTransportMode;
  timeoutMs?: number;
  service?: ToolContext['svc'];
}

function defaultMode(): McpTransportMode {
  return 'stateless';
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

function authenticationErrorResponse(error: unknown, oauthEnabled: boolean, metadataUrl: URL): Response {
  if (error instanceof OAuthProtocolError && error.code === 'insufficient_scope') {
    return oauthInsufficientScopeResponse(metadataUrl, 'mcp:access');
  }
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 401;
  if (oauthEnabled && status === 401) return oauthUnauthorizedResponse(metadataUrl);
  return new Response(status === 403 ? 'project access denied' : 'authentication required', { status });
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

  if (new URL(req.url).searchParams.has('project_id')) {
    return badRequest('project_id query is no longer supported; pass project_id in tool arguments');
  }

  let message: unknown;
  try {
    message = await req.json();
  } catch {
    return badRequest('invalid JSON body');
  }
  if (!isJsonRpcRequest(message)) return badRequest('invalid JSON body');

  let oauthConfiguration: ReturnType<typeof getOAuthConfiguration>;
  try {
    oauthConfiguration = getOAuthConfiguration();
  } catch {
    return new Response('OAuth configuration is invalid', { status: 500, headers: { 'cache-control': 'no-store' } });
  }

  const maintenanceToken = extractMaintenanceToken(req);
  let principal: McpPrincipal | undefined;
  if (authRequired()) {
    try {
      principal = await requireMcpPrincipal(req);
    } catch (error) {
      return authenticationErrorResponse(error, oauthConfiguration.enabled, oauthConfiguration.metadataUrl);
    }
  }
  const canWriteShared = grantsSharedWrite(maintenanceToken)
    && (!authRequired()
      || (principal?.credentialKind === 'pat' && principal.userId === process.env.LTM_CURATOR_USER_ID));
  const ctx: ToolContext = {
    svc: options.service ?? getMemoryService(),
    canWriteShared,
    principal,
    maintenanceToken,
    requireProjectAccess: createProjectAccessGuard({ principal, maintenanceToken }),
  };
  const mode = options.mode ?? defaultMode();
  const timeoutMs = options.timeoutMs ?? 30_000;
  let session: McpSession;
  try {
    session = mode === 'stateless' ? await createMcpSession(ctx) : await getOrCreateSession(ctx);
    const response = await session.runWithContext(ctx, () => dispatch(session, message as JSONRPCMessage, timeoutMs));
    if (!hasId(message as JSONRPCMessage)) {
      if (mode === 'stateless') await session.close();
      return new Response(null, { status: 202 });
    }
    if (mode === 'stateless') await session.close();
    return jsonResponse(response, 200, req);
  } catch (error) {
    if (mode === 'stateless' && session!) await session.close().catch(() => undefined);
    if (error instanceof McpRequestTimeoutError) {
      const id = hasId(message as JSONRPCMessage) ? (message as { id: string | number }).id : null;
      return errorResponse(id, -32000, 'timeout waiting for MCP response');
    }
    throw error;
  }
}
