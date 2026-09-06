import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { LocalIndexStore } from '@/lib/storage/local-index';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';
import { migrateAuth } from '@/lib/auth/migrate';
import { assertProjectAccess } from '@/lib/auth/access';

async function setup() {
  const db = new Database(':memory:');
  const index = new LocalIndexStore(db);
  await migrateAuth(index);
  const store = new AuthStore(index);
  setAuthStoreForTests(store);
  await store.createProject('project', 'owner');
  await store.addMember('project', 'member', 'member');
  return { db };
}

afterEach(async () => {
  delete process.env.LTM_CURATOR_USER_ID;
  await resetAuthStoreForTests();
});

test('owner/member は read/write、membership 外は 403', async () => {
  const { db } = await setup();
  try {
    await expect(assertProjectAccess({ userId: 'owner' }, 'project', 'read')).resolves.toBeUndefined();
    await expect(assertProjectAccess({ userId: 'member' }, 'project', 'write')).resolves.toBeUndefined();
    await expect(assertProjectAccess({ userId: 'other' }, 'project', 'read')).rejects.toMatchObject({ status: 403 });
  } finally { db.close(); }
});

test('__shared__ は認証済み read のみ、curator の maintain だけを許可する', async () => {
  const { db } = await setup();
  try {
    await expect(assertProjectAccess({ userId: 'anyone' }, '__shared__', 'read')).resolves.toBeUndefined();
    await expect(assertProjectAccess({ userId: 'anyone' }, '__shared__', 'write')).rejects.toMatchObject({ status: 403 });
    process.env.LTM_CURATOR_USER_ID = 'curator';
    await expect(assertProjectAccess({ userId: 'curator' }, '__shared__', 'maintain')).resolves.toBeUndefined();
    await expect(assertProjectAccess({ userId: 'other' }, '__shared__', 'maintain')).rejects.toMatchObject({ status: 403 });
  } finally { db.close(); }
});
