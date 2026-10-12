import { randomUUID } from 'node:crypto';

export type MaintenanceToolName = 'maintenance_list_projects' | 'maintenance_snapshot' | 'maintenance_apply';
export type CurationToolName = 'list_projects' | 'curation_snapshot' | 'curation_apply' | 'curation_checkpoint';
export type McpToolName = MaintenanceToolName | CurationToolName;

export interface McpClientOptions {
  baseUrl: string;
  bearerToken: string;
  operationMode?: 'maintenance' | 'curation';
  maintenanceToken?: string;
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class McpClientError extends Error {
  constructor() {
    super('maintenance MCP request failed');
    this.name = 'McpClientError';
  }
}

export class McpToolError extends Error {
  constructor() {
    super('maintenance MCP tool rejected the request');
    this.name = 'McpToolError';
  }
}

interface JsonRpcResponse {
  error?: unknown;
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
}

function endpoint(baseUrl: string): string {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new McpClientError(); }
  const localHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if ((!localHttp && parsed.protocol !== 'https:') || (parsed.port !== '' && parsed.port !== '443' && !localHttp)
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    || parsed.pathname !== '/' || parsed.hostname.length === 0) throw new McpClientError();
  return parsed.origin + '/api/mcp';
}

async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) throw new McpClientError();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpClientError();
      }
      chunks.push(value);
    }
  } catch {
    throw new McpClientError();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

export async function callMcpTool<T>(
  options: McpClientOptions,
  name: McpToolName,
  args: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(120_000, Math.max(1_000, options.timeoutMs ?? 30_000)));
  try {
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${options.bearerToken}`);
    headers.set('content-type', 'application/json');
    const operationMode = options.operationMode ?? 'maintenance';
    headers.set('x-ltm-operation-mode', operationMode);
    if (operationMode === 'curation') {
      if (!options.maintenanceToken) throw new McpClientError();
      headers.set('x-ltm-maintenance-token', options.maintenanceToken);
    }
    const response = await (options.fetcher ?? fetch)(endpoint(options.baseUrl), {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    if (!response.ok) throw new McpClientError();
    const raw = await readBounded(response.body, options.maxResponseBytes ?? 8 * 1024 * 1024);
    let payload: JsonRpcResponse;
    try { payload = JSON.parse(raw) as JsonRpcResponse; } catch { throw new McpClientError(); }
    if (payload.error !== undefined) throw new McpClientError();
    if (payload.result?.isError) throw new McpToolError();
    const text = payload.result?.content?.find((item) => item.type === 'text')?.text;
    if (!text) throw new McpClientError();
    try { return JSON.parse(text) as T; } catch { throw new McpClientError(); }
  } catch (error) {
    if (error instanceof McpClientError || error instanceof McpToolError) throw error;
    throw new McpClientError();
  } finally {
    clearTimeout(timeout);
  }
}
