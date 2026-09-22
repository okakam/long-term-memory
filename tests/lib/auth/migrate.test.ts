import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { CURRENT_AUTH_VERSION, migrateAuthLocal } from '@/lib/auth/migrate';

test('auth migration v2はOAuth tableを追加し、既存PAT tableを維持する', () => {
  const db = new Database(':memory:');
  try {
    migrateAuthLocal(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => (row as { name: string }).name);
    expect(db.prepare('SELECT version FROM auth_schema_version').get()).toEqual({ version: CURRENT_AUTH_VERSION });
    expect(tables).toEqual(expect.arrayContaining([
      'mcp_tokens',
      'oauth_clients',
      'oauth_authorization_transactions',
      'oauth_authorization_codes',
      'oauth_access_tokens',
      'oauth_refresh_tokens',
      'oauth_grants',
      'oauth_rate_limits',
    ]));
  } finally {
    db.close();
  }
});
