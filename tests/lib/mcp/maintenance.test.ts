import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { computeHash } from '@/lib/markdown/file-io';
import { MemoryService } from '@/lib/memory/service';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { handleMcpRequest } from '@/lib/mcp/transport';
import { openDb } from '@/lib/db/connection';
import { resolveStorage } from '@/lib/paths';
import { resetSessionState } from '@/lib/mcp/session';

const ENV_KEYS = ['AUTH_REQUIRED', 'MCP_OAUTH_ENABLED', 'LTM_AUTO_MAINTENANCE_TOKEN', 'LTM_MAINTENANCE_TOKEN'];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const databases: Database.Database[] = [];

function serviceFixture() {
  const root = mkdtempSync(join('/tmp', 'ltm-mcp-maintenance-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  databases.push(db);
  return { storage, db, service: MemoryService.open(db, storage) };
}

async function call(service: MemoryService, id: number, params: Record<string, unknown>, token = 'ltm_auto_test') {
  return handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-ltm-operation-mode': 'maintenance',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }),
  }), { mode: 'stateless', service });
}

afterEach(async () => {
  await resetSessionState();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('automation bearer exposes only its three maintenance tools', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_AUTO_MAINTENANCE_TOKEN = 'ltm_auto_test';
  const { service } = serviceFixture();
  const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ltm_auto_test',
      'x-ltm-operation-mode': 'maintenance',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }), { mode: 'stateless', service });

  expect(response.status).toBe(200);
  const names = (await response.json()).result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toEqual(['maintenance_list_projects', 'maintenance_snapshot', 'maintenance_apply']);

  const forbidden = await call(service, 2, {
    name: 'remember_user_fact',
    arguments: { project_id: 'alpha', name: 'must-not-save', description: 'x', body: 'x', entities: [{ name: 'x' }] },
  });
  const errorBody = await forbidden.json();
  expect(errorBody.error || errorBody.result?.isError).toBeTruthy();
  expect(service.listProjects()).toEqual([]);
});

test('automation credentials require their own mode and exact token', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_AUTO_MAINTENANCE_TOKEN = 'ltm_auto_test';
  const { service } = serviceFixture();
  const request = (headers: Record<string, string>) => handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
  }), { mode: 'stateless', service });

  await expect(request({ authorization: 'Bearer ltm_auto_test' })).resolves.toMatchObject({ status: 401 });
  await expect(request({ authorization: 'Bearer wrong', 'x-ltm-operation-mode': 'maintenance' })).resolves.toMatchObject({ status: 401 });
  await expect(request({ authorization: 'Bearer ltm_auto_test', 'x-ltm-operation-mode': 'maintenance' })).resolves.toMatchObject({ status: 200 });
});

test('local-session does not reuse the normal registry for automation credentials', async () => {
  process.env.AUTH_REQUIRED = '0';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_AUTO_MAINTENANCE_TOKEN = 'ltm_auto_test';
  const { service } = serviceFixture();
  const request = (id: number, maintenance: boolean) => handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: maintenance ? {
      authorization: 'Bearer ltm_auto_test', 'x-ltm-operation-mode': 'maintenance',
    } : {},
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  }), { mode: 'local-session', service });

  const normal = await request(30, false);
  expect((await normal.json()).result.tools).toHaveLength(17);
  const automated = await request(31, true);
  expect((await automated.json()).result.tools.map((tool: { name: string }) => tool.name)).toHaveLength(3);
  const normalAgain = await request(32, false);
  expect((await normalAgain.json()).result.tools).toHaveLength(17);
});

test('maintenance_list_projects returns only enabled ordinary projects', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_AUTO_MAINTENANCE_TOKEN = 'ltm_auto_test';
  const { service } = serviceFixture();
  service.save('alpha', { name: 'alpha-note', description: 'alpha', type: 'project', body: 'Alpha.' });
  service.save('beta', { name: 'beta-note', description: 'beta', type: 'project', body: 'Beta.' });
  service.save('__shared__', { name: 'shared-note', description: 'shared', type: 'project', body: 'Shared.' });
  await service.maintenanceStore.saveSettings('alpha', { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true }, 0);
  await service.maintenanceStore.saveSettings('beta', { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: false }, 0);

  const response = await call(service, 4, { name: 'maintenance_list_projects', arguments: {} });
  const result = JSON.parse((await response.json()).result.content[0].text);
  expect(result).toEqual([{ project_id: 'alpha', settings_version: 1 }]);
});

test('opt_out_revokes_inflight_apply', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.LTM_AUTO_MAINTENANCE_TOKEN = 'ltm_auto_test';
  const { storage, service } = serviceFixture();
  const memory = service.save('alpha', {
    name: 'review-candidate', description: 'review', type: 'project', body: 'A claim to review.',
  });
  const settings = await service.maintenanceStore.saveSettings('alpha', {
    ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true,
  }, 0);
  const hash = computeHash(readFileSync(storage.memoryFile('alpha', memory.name), 'utf8'));
  const originalApply = service.applyMutationAsync.bind(service);
  service.applyMutationAsync = async (request) => {
    const current = await service.maintenanceStore.getSettings('alpha');
    await service.maintenanceStore.saveSettings('alpha', { ...current, enabled: false }, current.version);
    return originalApply(request);
  };

  const response = await call(service, 5, {
    name: 'maintenance_apply',
    arguments: {
      project_id: 'alpha',
      proposal: {
        operation_id: 'inflight-opt-out',
        settings_version: settings.version,
        expected_hashes: { [memory.id]: hash },
        action: { type: 'review', memory_id: memory.id, review_state: 'ambiguous' },
        reason_code: 'ambiguous',
        evidence: [{ memory_id: memory.id, content_hash: hash, start: 0, end: memory.body.length }],
      },
    },
  });
  expect((await response.json()).result).toMatchObject({ isError: true });
  expect(service.get('alpha', memory.id)).toMatchObject({ status: 'active', body: memory.body });
  expect(await service.listRevisionsAsync('alpha', memory.id)).toHaveLength(0);
});
