import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { LocalIndexStore } from '@/lib/storage/local-index';
import { migrateAuth } from '@/lib/auth/migrate';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';
import { setFirebaseAuthForTests } from '@/lib/auth/firebase';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'owner' })),
}));
vi.mock('@/lib/auth/web-principal', () => mocks);

import * as membersRoute from '@/app/api/projects/[id]/members/route';

let db: Database.Database | undefined;

afterEach(async () => {
  await resetAuthStoreForTests();
  setFirebaseAuthForTests(null);
  db?.close();
  db = undefined;
  vi.clearAllMocks();
});

async function setup() {
  mocks.requireWebPrincipal.mockResolvedValue({ userId: 'owner' });
  db = new Database(':memory:');
  const index = new LocalIndexStore(db);
  await migrateAuth(index);
  const store = new AuthStore(index);
  setAuthStoreForTests(store);
  setFirebaseAuthForTests({
    verifyIdToken: vi.fn(),
    verifySessionCookie: vi.fn(),
    createSessionCookie: vi.fn(),
    getUser: vi.fn(async (userId: string) => ({
      uid: userId,
      email: userId === 'owner' ? 'owner@okakam.net' : 'member@okakam.net',
    })),
  });
  await store.createProject('project', 'owner');
}

function request(body: object) {
  return new Request('https://example.test/api/projects/project/members', {
    method: 'POST',
    headers: { origin: 'https://example.test', host: 'example.test' },
    body: JSON.stringify(body),
  });
}

function memberRequest(method: 'PATCH' | 'DELETE', body?: object) {
  return new Request('https://example.test/api/projects/project/members?user_id=owner', {
    method,
    headers: { origin: 'https://example.test', host: 'example.test' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('owner は member の追加・一覧・削除を行える', async () => {
  await setup();
  const context = { params: Promise.resolve({ id: 'project' }) };
  const added = await membersRoute.POST(request({ user_id: 'member' }), context);
  expect(added.status).toBe(201);
  await expect(added.json()).resolves.toEqual({
    project_id: 'project', user_id: 'member', email: 'member@okakam.net', role: 'member',
  });
  const listed = await membersRoute.GET(request({}), context);
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toEqual([
    { user_id: 'member', email: 'member@okakam.net', role: 'member' },
    { user_id: 'owner', email: 'owner@okakam.net', role: 'owner' },
  ]);
  const removed = await membersRoute.DELETE(new Request('https://example.test/api/projects/project/members?user_id=member', {
    method: 'DELETE', headers: { origin: 'https://example.test', host: 'example.test' },
  }), context);
  expect(removed.status).toBe(204);
});

test('member は membership API を変更できない', async () => {
  await setup();
  mocks.requireWebPrincipal.mockResolvedValue({ userId: 'member' });
  const context = { params: Promise.resolve({ id: 'project' }) };
  const response = await membersRoute.POST(request({ user_id: 'other' }), context);
  expect(response.status).toBe(403);
});

test('最後のownerをmemberへ変更又は削除できない', async () => {
  await setup();
  const context = { params: Promise.resolve({ id: 'project' }) };

  const changed = await membersRoute.PATCH(memberRequest('PATCH', { user_id: 'owner', role: 'member' }), context);
  expect(changed.status).toBe(409);

  const deleted = await membersRoute.DELETE(memberRequest('DELETE'), context);
  expect(deleted.status).toBe(409);
});
