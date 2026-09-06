import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';

const mocks = vi.hoisted(() => ({
  getMemoryService: vi.fn(),
  requireWebPrincipal: vi.fn(async () => ({ userId: 'user-1' })),
  assertProjectAccess: vi.fn(async () => undefined),
  assertSameOrigin: vi.fn(),
}));

vi.mock('@/lib/memory/singleton', () => ({ getMemoryService: mocks.getMemoryService }));
vi.mock('@/lib/auth/clerk', () => ({ requireWebPrincipal: mocks.requireWebPrincipal }));
vi.mock('@/lib/auth/access', () => ({
  assertProjectAccess: mocks.assertProjectAccess,
  assertSameOrigin: mocks.assertSameOrigin,
}));

import { DELETE, PUT } from '@/app/api/memories/[id]/route';

const saved = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZ',
  name: 'memory-name',
  description: 'description',
  type: 'project' as const,
  tags: ['old'],
  links: [],
  entities: [{ name: 'TypeScript', aliases: [] }],
  triples: [],
  supersedes: [],
  body: 'body',
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-05T00:00:00.000Z',
};

function request(url: string, method: string, body?: string): Request {
  return new Request(url, {
    method,
    headers: {
      origin: 'https://example.test',
      host: 'example.test',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body,
  });
}

const context = { params: Promise.resolve({ id: 'memory-name' }) };

beforeEach(() => {
  vi.stubEnv('AUTH_REQUIRED', '0');
  vi.stubEnv('VERCEL', '0');
  mocks.getMemoryService.mockReturnValue({
    updateAsync: vi.fn(async () => saved),
    forgetAsync: vi.fn(async () => undefined),
  } as unknown as MemoryService);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test('PUT は project_id 欠落・不正 JSON・strict unknown key を 400 にする', async () => {
  const missing = await PUT(request('https://example.test/api/memories/memory-name', 'PUT', '{}'), context);
  expect(missing.status).toBe(400);
  expect(await missing.text()).toBe('project_id query param required');

  const broken = await PUT(request('https://example.test/api/memories/memory-name?project_id=project', 'PUT', '{'), context);
  expect(broken.status).toBe(400);
  expect(await broken.text()).toBe('invalid JSON body');

  const strict = await PUT(request('https://example.test/api/memories/memory-name?project_id=project', 'PUT', JSON.stringify({ body: 'new', entities: [] })), context);
  expect(strict.status).toBe(400);
  expect(mocks.getMemoryService().updateAsync).not.toHaveBeenCalled();
});

test('PUT は shared を拒否し、成功時に strict patch だけを service へ渡す', async () => {
  const shared = await PUT(request('https://example.test/api/memories/memory-name?project_id=__shared__', 'PUT', JSON.stringify({ body: 'new' })), context);
  expect(shared.status).toBe(403);
  expect(await shared.text()).toBe('shared scope is read-only');

  const response = await PUT(request('https://example.test/api/memories/memory-name?project_id=project', 'PUT', JSON.stringify({
    description: 'new description',
    body: 'new body',
    tags: ['new'],
    links: ['other'],
  })), context);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual(saved);
  expect(mocks.getMemoryService().updateAsync).toHaveBeenCalledWith('project', 'memory-name', {
    description: 'new description',
    body: 'new body',
    tags: ['new'],
    links: ['other'],
  });
});

test('PUT/DELETE は not found を 404、DELETE 成功を deleted true で返す', async () => {
  const service = mocks.getMemoryService();
  const error = new Error('memory not found: missing');
  error.name = 'MemoryNotFoundError';
  service.updateAsync.mockRejectedValueOnce(error);
  const notFound = await PUT(request('https://example.test/api/memories/missing?project_id=project', 'PUT', JSON.stringify({ body: 'new' })), {
    params: Promise.resolve({ id: 'missing' }),
  });
  expect(notFound.status).toBe(404);

  const deleted = await DELETE(request('https://example.test/api/memories/memory-name?project_id=project', 'DELETE'), context);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });
  expect(service.forgetAsync).toHaveBeenCalledWith('project', 'memory-name');
});

test('API は不正 project_id を 400、予期しない service error を 500 の text/plain で返す', async () => {
  const invalid = await PUT(request('https://example.test/api/memories/memory-name?project_id=Bad_Project', 'PUT', JSON.stringify({ body: 'new' })), context);
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get('content-type')).toBe('text/plain');
  expect(await invalid.text()).toContain('invalid project_id');

  const service = mocks.getMemoryService();
  service.updateAsync.mockRejectedValueOnce(new Error('database detail must not leak'));
  const failed = await PUT(request('https://example.test/api/memories/memory-name?project_id=project', 'PUT', JSON.stringify({ body: 'new' })), context);
  expect(failed.status).toBe(500);
  expect(await failed.text()).toBe('request failed');
});

test('DELETE は not found を 404 で返す', async () => {
  const service = mocks.getMemoryService();
  const error = new Error('memory not found: missing');
  error.name = 'MemoryNotFoundError';
  service.forgetAsync.mockRejectedValueOnce(error);
  const response = await DELETE(request('https://example.test/api/memories/missing?project_id=project', 'DELETE'), {
    params: Promise.resolve({ id: 'missing' }),
  });
  expect(response.status).toBe(404);
});
