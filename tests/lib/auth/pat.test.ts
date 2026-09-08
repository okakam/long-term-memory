import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { LocalIndexStore } from '@/lib/storage/local-index';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';
import { migrateAuth } from '@/lib/auth/migrate';
import { createPat, requireMcpPrincipal, revokePat } from '@/lib/auth/pat';

async function setup() {
  const db = new Database(':memory:');
  const index = new LocalIndexStore(db);
  await migrateAuth(index);
  const store = new AuthStore(index);
  setAuthStoreForTests(store);
  return { db, store };
}

afterEach(async () => { await resetAuthStoreForTests(); });

test('PAT は発行時だけ平文を返し、DB には hash だけ保存する', async () => {
  const { db, store } = await setup();
  try {
    const created = await createPat('user-1', 'CLI');
    expect(created.token).toMatch(/^ltm_[A-Za-z0-9_-]+$/);
    expect(created.tokenId).toBeTruthy();
    const row = (await store.rawQuery('SELECT token_hash, token_prefix FROM mcp_tokens'))[0] as { token_hash: string; token_prefix: string };
    expect(row.token_hash).not.toContain(created.token);
    expect(row.token_prefix).toBe(created.token.slice(0, 12));
    await expect(requireMcpPrincipal(new Request('https://example.test', { headers: { authorization: 'Bearer ' + created.token } })))
      .resolves.toMatchObject({ userId: 'user-1', tokenId: created.tokenId });
  } finally { db.close(); }
});

test('PAT は不正 scheme、期限切れ、失効を常に 401 として拒否する', async () => {
  const { db, store } = await setup();
  try {
    await expect(requireMcpPrincipal(new Request('https://example.test', { headers: { authorization: 'Basic ltm_bad' } }))).rejects.toMatchObject({ status: 401 });
    const expired = await createPat('user-1', 'expired');
    await store.db.exec('UPDATE mcp_tokens SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), expired.tokenId]);
    await expect(requireMcpPrincipal(new Request('https://example.test', { headers: { authorization: 'Bearer ' + expired.token } }))).rejects.toMatchObject({ status: 401 });
    const valid = await createPat('user-1', 'valid');
    await revokePat('user-1', valid.tokenId);
    await expect(requireMcpPrincipal(new Request('https://example.test', { headers: { authorization: 'Bearer ' + valid.token } }))).rejects.toMatchObject({ status: 401 });
  } finally { db.close(); }
});
