import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authRequired: vi.fn(() => true),
  requireWebPrincipal: vi.fn(async () => ({ userId: 'owner' })),
  assertSameOrigin: vi.fn(),
  getAuthStore: vi.fn(),
  getMemoryService: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({ authRequired: mocks.authRequired }));
vi.mock('@/lib/auth/web-principal', () => ({ requireWebPrincipal: mocks.requireWebPrincipal }));
vi.mock('@/lib/auth/access', () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  AuthorizationError: class AuthorizationError extends Error { readonly status = 403; },
}));
vi.mock('@/lib/auth/store', () => ({ getAuthStore: mocks.getAuthStore }));
vi.mock('@/lib/memory/singleton', () => ({ getMemoryService: mocks.getMemoryService }));

import * as settingsRoute from '@/app/api/projects/[id]/maintenance/route';
import * as historyRoute from '@/app/api/projects/[id]/maintenance/history/route';
import * as restoreRoute from '@/app/api/projects/[id]/maintenance/restore/route';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';

const memory = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZ',
  name: 'archived-note',
  description: 'Archived note description',
  type: 'project' as const,
  tags: [], links: [], entities: [], triples: [], supersedes: [],
  body: 'private memory body must never be returned',
  status: 'archived' as const,
  archived_at: '2026-10-01T00:00:00.000Z',
  archive_reason: 'completed',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};
const currentHash = 'a'.repeat(64);
const revision = {
  id: 'revision-1', memory_id: memory.id, content_key: 'private/gcs/key.md',
  content_hash: 'b'.repeat(64), created_at: '2026-10-01T00:00:00.000Z',
  operation_id: 'operation-1', reason_code: 'completed' as const,
};
const event = {
  operation_id: 'operation-1', project_id: 'project', memory_ids: [memory.id], revision_ids: [revision.id],
  action: 'archive' as const, reason_code: 'completed' as const, created_at: '2026-10-01T00:00:00.000Z',
};

let membershipRole: 'owner' | 'member' | null;
let settings: typeof DEFAULT_MAINTENANCE_SETTINGS;
let service: Record<string, ReturnType<typeof vi.fn>>;

function request(url: string, method = 'GET', body?: object): Request {
  return new Request(url, {
    method,
    headers: {
      origin: 'https://example.test', host: 'example.test',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const context = { params: Promise.resolve({ id: 'project' }) };

beforeEach(() => {
  vi.stubEnv('AUTH_REQUIRED', '1');
  vi.stubEnv('LTM_CURATOR_USER_ID', 'curator');
  mocks.authRequired.mockReturnValue(true);
  mocks.requireWebPrincipal.mockResolvedValue({ userId: 'owner' });
  mocks.assertSameOrigin.mockReset();
  membershipRole = 'owner';
  settings = { ...DEFAULT_MAINTENANCE_SETTINGS, review_days: { ...DEFAULT_MAINTENANCE_SETTINGS.review_days } };
  mocks.getAuthStore.mockResolvedValue({
    getMembership: vi.fn(async (_projectId: string, userId: string) =>
      membershipRole ? { project_id: 'project', user_id: userId, role: membershipRole } : null),
  });
  service = {
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (_projectId: string, input: typeof settings, expectedVersion: number) => {
      settings = { ...input, version: expectedVersion + 1 };
      return settings;
    }),
    listEvents: vi.fn(async () => [event]),
    listRevisionsAsync: vi.fn(async () => [revision]),
    readRevision: vi.fn(async () => ({ revision, body: memory.body })),
    listArchivedMaintenanceMemories: vi.fn(async () => ({ items: [{ memory, content_hash: currentHash }], next_after: null })),
    getMaintenanceMemory: vi.fn(async () => ({ memory, content_hash: currentHash })),
    applyMutationAsync: vi.fn(async () => ({ operation_id: 'restore-1', outcome: 'applied', memory_ids: [memory.id], revision_ids: ['revision-2'] })),
  };
  mocks.getMemoryService.mockReturnValue({ maintenanceStore: service, ...service });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test('settings GET は無効の初期設定を返す', async () => {
  const response = await settingsRoute.GET(request('https://example.test/api/projects/project/maintenance'), context);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  await expect(response.json()).resolves.toMatchObject({ enabled: false, version: 0 });
});

test('memberは設定変更と復元ができず、未認証は401になる', async () => {
  membershipRole = 'member';
  const settingsResponse = await settingsRoute.PATCH(request('https://example.test/api/projects/project/maintenance', 'PATCH', settings), context);
  expect(settingsResponse.status).toBe(403);
  const restoreResponse = await restoreRoute.POST(request('https://example.test/api/projects/project/maintenance/restore', 'POST', {
    memory_id: memory.id, revision_id: revision.id, expected_hash: currentHash, operation_id: 'restore-1',
  }), context);
  expect(restoreResponse.status).toBe(403);

  mocks.requireWebPrincipal.mockRejectedValueOnce(Object.assign(new Error('authentication required'), { status: 401 }));
  const unauthenticated = await settingsRoute.GET(request('https://example.test/api/projects/project/maintenance'), context);
  expect(unauthenticated.status).toBe(401);
});

test('設定は不正なreview日数を400で拒否する', async () => {
  const invalid = { ...settings, review_days: { ...settings.review_days, project: 0 } };
  const response = await settingsRoute.PATCH(request('https://example.test/api/projects/project/maintenance', 'PATCH', invalid), context);
  expect(response.status).toBe(400);
  expect(service.saveSettings).not.toHaveBeenCalled();
});

test('historyはarchiveとrevision metadataを返すが本文と内部keyを含めない', async () => {
  const response = await historyRoute.GET(request(`https://example.test/api/projects/project/maintenance/history?memory_id=${memory.id}`), context);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(memory.body);
  expect(serialized).not.toContain('content_key');
  expect(serialized).not.toContain('private/gcs/key.md');
  expect(body).toMatchObject({ selected_memory: { memory_id: memory.id, current_hash: currentHash } });
  expect((body.selected_memory as { revisions: unknown[] }).revisions[0]).not.toHaveProperty('body');
});

test('sharedの履歴はcurator UIDだけが読めて、shared復元は拒否する', async () => {
  mocks.requireWebPrincipal.mockResolvedValueOnce({ userId: 'owner' });
  const denied = await historyRoute.GET(request('https://example.test/api/projects/__shared__/maintenance/history'), {
    params: Promise.resolve({ id: '__shared__' }),
  });
  expect(denied.status).toBe(403);

  mocks.requireWebPrincipal.mockResolvedValueOnce({ userId: 'curator' });
  const allowed = await historyRoute.GET(request('https://example.test/api/projects/__shared__/maintenance/history'), {
    params: Promise.resolve({ id: '__shared__' }),
  });
  expect(allowed.status).toBe(200);

  const restore = await restoreRoute.POST(request('https://example.test/api/projects/__shared__/maintenance/restore', 'POST', {}), {
    params: Promise.resolve({ id: '__shared__' }),
  });
  expect(restore.status).toBe(403);
});

test('ownerはarchived memoryをrevisionから復元できる', async () => {
  const response = await restoreRoute.POST(request('https://example.test/api/projects/project/maintenance/restore', 'POST', {
    memory_id: memory.id, revision_id: revision.id, expected_hash: currentHash, operation_id: 'restore-1',
  }), context);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: 'active', outcome: 'applied' });
  expect(service.applyMutationAsync).toHaveBeenCalledWith(expect.objectContaining({
    project_id: 'project', expected_hashes: { [memory.id]: currentHash },
    action: { type: 'restore', memory_id: memory.id, revision_id: revision.id }, reason_code: 'restored',
  }));
});

test('復元前hashが古ければ409で競合を返す', async () => {
  const response = await restoreRoute.POST(request('https://example.test/api/projects/project/maintenance/restore', 'POST', {
    memory_id: memory.id, revision_id: revision.id, expected_hash: 'c'.repeat(64), operation_id: 'restore-stale',
  }), context);
  expect(response.status).toBe(409);
  expect(service.applyMutationAsync).not.toHaveBeenCalled();
});
