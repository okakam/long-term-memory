import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';

/** 独立した一時テーブルだけで検証し、既存の索引には触れない。 */
export async function probeFtsCompatibility(client: Client): Promise<{ compatible: true }> {
  const table = `ltm_probe_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    await client.execute(`CREATE VIRTUAL TABLE ${table} USING fts5(name, description, body, content='', contentless_delete=1, tokenize='trigram')`);
    created = true;
    await client.execute({ sql: `INSERT INTO ${table}(rowid, name, description, body) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`, args: [1, '長期記憶', '', '無関係', 2, '無関係', '', '長期記憶'] });
    const matches = await client.execute({ sql: `SELECT rowid, bm25(${table}, 10, 5, 1) AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY score`, args: ['"長期記"'] });
    if (matches.rows.length !== 2 || Number(matches.rows[0].rowid) !== 1 || !(Number(matches.rows[0].score) < Number(matches.rows[1].score))) {
      throw new Error('weighted Japanese trigram match failed');
    }
    await client.execute({ sql: `DELETE FROM ${table} WHERE rowid = ?`, args: [1] });
    const remaining = await client.execute({ sql: `SELECT rowid FROM ${table} WHERE ${table} MATCH ?`, args: ['"長期記"'] });
    if (remaining.rows.length !== 1 || Number(remaining.rows[0].rowid) !== 2) throw new Error('contentless deletion failed');
    return { compatible: true };
  } finally {
    if (created) await client.execute(`DROP TABLE ${table}`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('missing configuration');
  // file: や :memory: をリモートゲート合格と誤認させない。
  if (!['libsql:', 'https:'].includes(new URL(url).protocol)) throw new Error('remote URL required');
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    await probeFtsCompatibility(client);
    console.log('Turso remote FTS5 compatibility: PASS');
  } finally { client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Turso remote FTS5 compatibility: FAIL. 設定または FTS5 機能を確認してください。接続情報は出力しません。');
    process.exitCode = 1;
  });
}
