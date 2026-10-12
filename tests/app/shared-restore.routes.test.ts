import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'curator' })),
  assertSameOrigin: vi.fn(),
  getMemoryService: vi.fn(),
}));

vi.mock('@/lib/auth/web-principal', () => ({ requireWebPrincipal: mocks.requireWebPrincipal }));
vi.mock('@/lib/auth/access', () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  AuthorizationError: class AuthorizationError extends Error { readonly status = 403; },
}));
vi.mock('@/lib/memory/singleton', () => ({ getMemoryService: mocks.getMemoryService }));

import * as route from '@/app/api/projects/[id]/maintenance/restore-requests/route';

const currentHash = 'a'.repeat(64);
const revision = { id: 'revision-1', memory_id: 'memory-1', content_key: 'private/key', content_hash: 'b'.repeat(64), created_at: '2026-10-01T00:00:00.000Z', operation_id: 'op-1', reason_code: 'completed' };
let created: Record<string, unknown> | null;
const context = { params: Promise.resolve({ id: '__shared__' }) };

function request(url: string, method = 'GET', body?: object) {
  return new Request(url, {
    method,
    headers: { origin: 'https://example.test', host: 'example.test', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.stubEnv('LTM_CURATOR_USER_ID', 'curator');
  mocks.requireWebPrincipal.mockResolvedValue({ userId: 'curator' });
  mocks.assertSameOrigin.mockReset();
  created = null;
  mocks.getMemoryService.mockReturnValue({
    getMaintenanceMemory: vi.fn(async () => ({ memory: { id: 'memory-1' }, content_hash: currentHash })),
    listRevisionsAsync: vi.fn(async () => [revision]),
    curationStore: {
      createRestoreRequest: vi.fn(async (input: Record<string, unknown>) => {
        created = { ...input, id: '01J9C7Q4VY3E5M8H2N6K0P1RAB', state: 'pending' };
        return created;
      }),
      listRestoreRequests: vi.fn(async () => created ? [created] : []),
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test('only curator can create and list shared restore requests', async () => {
  mocks.requireWebPrincipal.mockResolvedValueOnce({ userId: 'ordinary-user' });
  const denied = await route.POST(request('https://example.test/api/projects/__shared__/maintenance/restore-requests', 'POST', {
    memory_id: 'memory-1', revision_id: revision.id, expected_hash: currentHash,
  }), context);
  expect(denied.status).toBe(403);

  const accepted = await route.POST(request('https://example.test/api/projects/__shared__/maintenance/restore-requests', 'POST', {
    memory_id: 'memory-1', revision_id: revision.id, expected_hash: currentHash,
  }), context);
  expect(accepted.status).toBe(202);
  await expect(accepted.json()).resolves.toMatchObject({ request: { state: 'pending' } });
  const listed = await route.GET(request('https://example.test/api/projects/__shared__/maintenance/restore-requests'), context);
  await expect(listed.json()).resolves.toMatchObject({ requests: [{ state: 'pending' }] });
});

test('shared restore request rejects stale hash or missing revision', async () => {
  const stale = await route.POST(request('https://example.test/api/projects/__shared__/maintenance/restore-requests', 'POST', {
    memory_id: 'memory-1', revision_id: revision.id, expected_hash: 'c'.repeat(64),
  }), context);
  expect(stale.status).toBe(409);

  const missing = await route.POST(request('https://example.test/api/projects/__shared__/maintenance/restore-requests', 'POST', {
    memory_id: 'memory-1', revision_id: 'missing', expected_hash: currentHash,
  }), context);
  expect(missing.status).toBe(404);
  expect(created).toBeNull();
});
