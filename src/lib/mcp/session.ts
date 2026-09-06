import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { randomUUID } from 'node:crypto';
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js';

import { resetMemoryService } from '@/lib/memory/singleton';
import { recordConnect } from '@/lib/telemetry/recorder';

import { createMcpServer } from './server';
import type { ToolContext } from './context';

export class McpRequestTimeoutError extends Error {
  constructor() {
    super('timeout waiting for MCP response');
    this.name = 'McpRequestTimeoutError';
  }
}

export interface McpSession {
  readonly server: ReturnType<typeof createMcpServer>;
  readonly clientTransport: InMemoryTransport;
  send(message: JSONRPCMessage, timeoutMs?: number): Promise<JSONRPCMessage | undefined>;
  acceptInitialize(message: JSONRPCMessage, timeoutMs?: number): Promise<JSONRPCMessage | undefined>;
  initialize(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

type Resolver = { resolve: (message: JSONRPCMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function messageId(message: JSONRPCMessage): RequestId | undefined {
  if (!('id' in message) || message.id === undefined || message.id === null) return undefined;
  return message.id;
}

let syntheticId = 0;

export async function createMcpSession(ctx: ToolContext): Promise<McpSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sessionId = randomUUID();
  const sessionContext = { ...ctx, sessionId };
  const server = createMcpServer(sessionContext);
  const pending = new Map<string, Resolver>();
  let initialization: Promise<void> | null = null;
  let closed = false;

  clientTransport.onmessage = (message) => {
    const id = messageId(message);
    if (id === undefined) return;
    const resolver = pending.get(requestKey(id));
    if (!resolver) return;
    pending.delete(requestKey(id));
    clearTimeout(resolver.timer);
    resolver.resolve(message);
  };
  clientTransport.onerror = (error) => {
    for (const [key, resolver] of pending) {
      pending.delete(key);
      clearTimeout(resolver.timer);
      resolver.reject(error);
    }
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  const session: McpSession = {
    server,
    clientTransport,
    send: async (message, timeoutMs = 30_000) => {
      if (closed) throw new Error('MCP session is closed');
      const id = messageId(message);
      if (id === undefined) {
        await clientTransport.send(message);
        return undefined;
      }
      const key = requestKey(id);
      const response = new Promise<JSONRPCMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new McpRequestTimeoutError());
        }, Math.max(0, timeoutMs));
        pending.set(key, { resolve, reject, timer });
      });
      try {
        await clientTransport.send(message);
      } catch (error) {
        const resolver = pending.get(key);
        if (resolver) {
          pending.delete(key);
          clearTimeout(resolver.timer);
          resolver.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return response;
    },
    acceptInitialize: async (message, timeoutMs = 30_000) => {
      if (initialization) return session.send(message, timeoutMs);
      const responsePromise = session.send(message, timeoutMs).then(async (response) => {
        await recordConnect({ projectId: sessionContext.projectId, sessionId });
        return response;
      });
      initialization = responsePromise.then(() => undefined).catch((error) => {
        initialization = null;
        throw error;
      });
      return responsePromise;
    },
    initialize: async (timeoutMs = 30_000) => {
      if (initialization) return initialization;
      const id = `__ltm_init__${++syntheticId}`;
      initialization = (async () => {
        await session.send({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'long-term-memory-bridge', version: '0.1.0' },
          },
        }, timeoutMs);
        await session.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        await recordConnect({ projectId: sessionContext.projectId, sessionId });
      })().catch((error) => {
        initialization = null;
        throw error;
      });
      return initialization;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const [key, resolver] of pending) {
        pending.delete(key);
        clearTimeout(resolver.timer);
        resolver.reject(new Error('MCP session is closed'));
      }
      await server.close();
    },
  };
  return session;
}

const sessions = new Map<string, Promise<McpSession>>();

export function getOrCreateSession(ctx: ToolContext): Promise<McpSession> {
  const key = `${ctx.projectId}#${ctx.canWriteShared ? 'rw' : 'ro'}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const promise = createMcpSession(ctx);
  sessions.set(key, promise);
  void promise.catch(() => {
    if (sessions.get(key) === promise) sessions.delete(key);
  });
  return promise;
}

export async function resetSessionState(): Promise<void> {
  const current = [...sessions.values()];
  sessions.clear();
  const resolved = await Promise.allSettled(current);
  await Promise.all(resolved.flatMap((item) => item.status === 'fulfilled' ? [item.value.close()] : []));
  resetMemoryService();
}
