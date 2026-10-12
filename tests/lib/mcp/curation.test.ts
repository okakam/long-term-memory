import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';
import { handleMcpRequest } from '@/lib/mcp/transport';
import { resetSessionState } from '@/lib/mcp/session';

const ENV_KEYS = ['AUTH_REQUIRED', 'MCP_OAUTH_ENABLED', 'LTM_MAINTENANCE_TOKEN', 'LTM_AUTO_MAINTENANCE_TOKEN'];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalHome = process.env.LTM_HOME;
const roots: string[] = [];
const dbs: Database.Database[] = [];

function fixture() {
  const root = mkdtempSync(join('/tmp', 'ltm-curation-mcp-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  dbs.push(db);
  return MemoryService.open(db, storage);
}

async function request(service: MemoryService, id: number, mode?: string, maintenanceToken?: string) {
  return handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: {
      ...(mode ? { 'x-ltm-operation-mode': mode } : {}),
      ...(maintenanceToken ? { 'x-ltm-maintenance-token': maintenanceToken } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  }), { mode: 'stateless', service });
}

async function call(service: MemoryService, id: number, name: string, args: Record<string, unknown>) {
  return handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: { 'x-ltm-operation-mode': 'curation', 'x-ltm-maintenance-token': 'shared-maintenance-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  }), { mode: 'stateless', service });
}

afterEach(async () => {
  await resetSessionState();
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.LTM_HOME;
  else process.env.LTM_HOME = originalHome;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('curation mode requires shared maintenance gate and exposes only its dedicated tools', async () => {
  process.env.AUTH_REQUIRED = '0';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_MAINTENANCE_TOKEN = 'shared-maintenance-secret';
  const service = fixture();

  const denied = await request(service, 1, 'curation');
  expect(denied.status).toBe(403);

  const normal = await request(service, 2);
  expect((await normal.json()).result.tools).toHaveLength(17);

  const allowed = await request(service, 3, 'curation', 'shared-maintenance-secret');
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    'list_projects', 'curation_snapshot', 'curation_apply', 'curation_checkpoint',
  ]);
});

test('automation token and operation-mode header cannot grant shared curation access', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_AUTO_MAINTENANCE_TOKEN = 'ltm_auto_secret';
  process.env.LTM_MAINTENANCE_TOKEN = 'shared-maintenance-secret';
  const service = fixture();
  const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ltm_auto_secret',
      'x-ltm-operation-mode': 'curation',
      'x-ltm-maintenance-token': 'shared-maintenance-secret',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
  }), { mode: 'stateless', service });
  expect(response.status).toBe(401);
});

test('restore result checkpoint cannot mark a pending request complete', async () => {
  process.env.AUTH_REQUIRED = '0';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_MAINTENANCE_TOKEN = 'shared-maintenance-secret';
  const service = fixture();
  const request = await service.curationStore.createRestoreRequest({
    memory_id: 'memory-1', revision_id: 'revision-1', expected_hash: 'a'.repeat(64),
    requested_by: 'local-user', requested_at: '2026-10-12T00:00:00.000Z',
  });
  try {
    const pending = await call(service, 5, 'curation_checkpoint', {
      project_id: '__shared__', action: 'restore_result', request_id: request.id, state: 'succeeded',
    });
    expect((await pending.json()).result.isError).toBe(true);
    await expect(service.curationStore.getRestoreRequest(request.id)).resolves.toMatchObject({ state: 'pending' });

    await service.curationStore.completeRestoreRequest(request.id, {
      state: 'succeeded', completed_at: '2026-10-12T01:00:00.000Z',
    });
    const recorded = await call(service, 6, 'curation_checkpoint', {
      project_id: '__shared__', action: 'restore_result', request_id: request.id, state: 'succeeded',
    });
    expect((await recorded.json()).result.isError).not.toBe(true);
  } finally {
    service.close();
  }
});
