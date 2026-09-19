import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { openLocalDb } from '@/lib/storage/local-index';
import { openLocalAuthDb } from '@/lib/auth/connection';
import { computeHash } from '@/lib/markdown/file-io';
import { serializeMemory } from '@/lib/markdown/frontmatter';
import type { Memory } from '@/lib/memory/types';
import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';
import { exportVercelData } from '../../scripts/migration/export-vercel';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memory(): Memory {
  return {
    id: '01J00000000000000000000000',
    name: 'migration-note',
    description: '移行テスト',
    type: 'reference',
    tags: ['migration'],
    links: [],
    entities: [],
    triples: [],
    source_refs: undefined,
    supersedes: [],
    body: '移行対象本文',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  };
}

function createMarkdownStore(objects: Map<string, string>): MarkdownStore {
  return {
    async read(key) {
      const text = objects.get(key);
      if (text === undefined) throw new Error(`missing object: ${key}`);
      return text;
    },
    async write(key, text): Promise<StoredObject> {
      objects.set(key, text);
      return { key, size: Buffer.byteLength(text), updatedAt: new Date() };
    },
    async remove(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, text]) => ({ key, size: Buffer.byteLength(text), updatedAt: new Date(0) }));
    },
  };
}

describe('exportVercelData', () => {
  test('同じMarkdownのhashをmanifestへ記録し、0600のファイルへexportする', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ltm-export-test-'));
    roots.push(root);
    const memoryDb = openLocalDb(join(root, 'memory.db'));
    const authDb = openLocalAuthDb(join(root, 'auth.db'));
    const raw = serializeMemory(memory());
    const key = 'projects/demo/memories/migration-note/' + computeHash(raw) + '.md';
    const markdown = createMarkdownStore(new Map([[key, raw]]));

    await memoryDb.exec(
      'INSERT INTO memories (id, project_id, name, type, description, body_chars, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [memory().id, 'demo', memory().name, memory().type, memory().description, memory().body.length, key, computeHash(raw), memory().created_at, memory().updated_at],
    );
    await authDb.exec(
      'INSERT INTO projects (project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ['demo', 'firebase-owner', memory().created_at, memory().updated_at],
    );
    await authDb.exec(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
      ['demo', 'firebase-owner', 'owner'],
    );
    await authDb.exec(
      'INSERT INTO mcp_tokens (id, user_id, token_hash, token_prefix, label, audience, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['token-id', 'firebase-owner', 'hashed-pat', 'ltm_secret', 'migration', 'mcp', memory().created_at],
    );

    try {
      const manifest = await exportVercelData({
        outputDir: join(root, 'export'),
        blobToken: 'BLOB_READ_WRITE_TOKEN-secret',
        memoryDbUrl: 'https://memory.example.invalid',
        memoryDbToken: 'TURSO_AUTH_TOKEN-secret',
        authDbUrl: 'https://auth.example.invalid',
        authDbToken: 'TURSO_AUTH_DATABASE_TOKEN-secret',
        markdownStore: markdown,
        memoryDb,
        authDb,
      });

      const exported = manifest.projects[0]?.memories[0];
      expect(exported).toMatchObject({ name: 'migration-note', key });
      expect(exported?.content_hash).toBe(computeHash(raw));
      expect(exported?.local_path).toContain('/markdown/demo/migration-note/');
      expect(readFileSync(exported!.local_path, 'utf8')).toBe(raw);
      expect(statSync(exported!.local_path).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, 'export', 'manifest.json'), 'utf8')).toContain('hashed-pat');
    } finally {
      memoryDb.close();
      authDb.close();
    }
  });

  test('manifestと出力ファイルへprovider credentialや平文PATを書き込まない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ltm-export-secret-test-'));
    roots.push(root);
    const memoryDb = openLocalDb(join(root, 'memory.db'));
    const authDb = openLocalAuthDb(join(root, 'auth.db'));
    const raw = serializeMemory(memory());
    const key = 'projects/demo/memories/migration-note/' + computeHash(raw) + '.md';
    const markdown = createMarkdownStore(new Map([[key, raw]]));

    await memoryDb.exec(
      'INSERT INTO memories (id, project_id, name, type, description, body_chars, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [memory().id, 'demo', memory().name, memory().type, memory().description, memory().body.length, key, computeHash(raw), memory().created_at, memory().updated_at],
    );

    try {
      await exportVercelData({
        outputDir: join(root, 'export'),
        blobToken: 'BLOB_READ_WRITE_TOKEN-secret',
        memoryDbUrl: 'https://memory.example.invalid',
        memoryDbToken: 'TURSO_AUTH_TOKEN-secret',
        authDbUrl: 'https://auth.example.invalid',
        authDbToken: 'TURSO_AUTH_DATABASE_TOKEN-secret',
        markdownStore: markdown,
        memoryDb,
        authDb,
      });
      const exportedText = readFileSync(join(root, 'export', 'manifest.json'), 'utf8');
      expect(exportedText).not.toContain('BLOB_READ_WRITE_TOKEN-secret');
      expect(exportedText).not.toContain('TURSO_AUTH_TOKEN-secret');
      expect(exportedText).not.toContain('CLERK_SECRET_KEY');
      expect(exportedText).not.toContain('plain-text-pat');
    } finally {
      memoryDb.close();
      authDb.close();
    }
  });
});
