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
import { importMigration } from '../../scripts/migration/import-s3-firestore';
import { verifyMigration } from '../../scripts/migration/verify-migration';
import { FirestoreMetadataStore, type FirestoreDocument, type FirestoreGateway, type FirestoreTransaction } from '@/lib/storage/firestore-metadata';

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

class FakeFirestore implements FirestoreGateway {
  readonly documents = new Map<string, Record<string, unknown>>();
  async get(path: string): Promise<FirestoreDocument> { return this.snapshot(path); }
  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    const prefix = `${collectionPath}/`;
    return [...this.documents.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map((path) => this.snapshot(path));
  }
  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    this.documents.set(path, merge && this.documents.has(path) ? { ...this.documents.get(path), ...data } : { ...data });
  }
  async update(path: string, data: Record<string, unknown>): Promise<void> { await this.set(path, data, true); }
  async delete(path: string): Promise<void> { this.documents.delete(path); }
  async runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    return fn({ get: (path) => this.get(path), set: (path, data, merge) => this.set(path, data, merge), update: (path, data) => this.update(path, data), delete: (path) => this.delete(path) });
  }
  private snapshot(path: string): FirestoreDocument {
    return { id: path.split('/').at(-1)!, path, exists: this.documents.has(path), data: () => this.documents.get(path) };
  }
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
    await memoryDb.exec(
      'INSERT INTO memory_tombstones (project_id, memory_id, file_path, deleted_at) VALUES (?, ?, ?, ?)',
      ['demo', 'deleted-memory', 'projects/demo/memories/deleted-memory/old.md', '2026-09-18T00:00:00.000Z'],
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
      expect(manifest.tombstones).toEqual([{
        project_id: 'demo',
        memory_id: 'deleted-memory',
        content_key: 'projects/demo/memories/deleted-memory/old.md',
        deleted_at: '2026-09-18T00:00:00.000Z',
      }]);
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

describe('importMigration / verifyMigration', () => {
  test('同一manifestを二度importしても重複せず、UID mapping込みで検証できる', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ltm-import-test-'));
    roots.push(root);
    const raw = serializeMemory(memory());
    const sourcePath = join(root, 'migration.md');
    const manifestPath = join(root, 'manifest.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(sourcePath, raw, { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({
      generated_at: memory().created_at,
      source: 'vercel',
      projects: [{ project_id: 'demo', memories: [{ id: memory().id, name: memory().name, key: 'old-key', content_hash: computeHash(raw), local_path: sourcePath }] }],
      auth: {
        projects: [{ project_id: 'demo', owner_user_id: 'clerk-owner', created_at: memory().created_at, updated_at: memory().updated_at }],
        members: [{ project_id: 'demo', user_id: 'clerk-owner', role: 'owner' }],
        tokens: [{ id: 'token-id', user_id: 'clerk-owner', token_hash: 'hash', token_prefix: 'ltm_hash', label: 'test', audience: 'mcp', created_at: memory().created_at, last_used_at: null, expires_at: null, revoked_at: null }],
      },
      tombstones: [{ project_id: 'demo', memory_id: 'deleted-memory', content_key: 'projects/demo/memories/deleted-memory/old.md', deleted_at: '2026-09-18T00:00:00.000Z' }],
    }), { mode: 0o600 });
    const objects = new Map<string, string>();
    const markdown = createMarkdownStore(objects);
    const metadata = new FirestoreMetadataStore(new FakeFirestore());
    const input = {
      manifestPath,
      s3: { markdown, prefix: 'target' },
      firestore: { metadata },
      firebaseUidMap: { 'clerk-owner': 'firebase-owner' },
    };

    await importMigration(input);
    await importMigration(input);

    expect(objects).toHaveLength(1);
    expect(await metadata.listMemoryIndexes('demo')).toHaveLength(1);
    expect(await metadata.listTombstones('demo')).toEqual([{
      project_id: 'demo',
      memory_id: 'deleted-memory',
      content_key: 'projects/demo/memories/deleted-memory/old.md',
      deleted_at: '2026-09-18T00:00:00.000Z',
    }]);
    expect(await metadata.listMembers('demo')).toEqual([{ project_id: 'demo', user_id: 'firebase-owner', role: 'owner' }]);
    expect((await metadata.listTokens('firebase-owner'))).toHaveLength(1);
    await expect(verifyMigration(input)).resolves.toMatchObject({ source_count: 1, target_count: 1, ok: true });
  });

  test('UID mappingがないownerのimportを中断する', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ltm-import-mapping-test-'));
    roots.push(root);
    const manifestPath = join(root, 'manifest.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(manifestPath, JSON.stringify({
      generated_at: new Date().toISOString(), source: 'vercel', projects: [],
      auth: { projects: [{ project_id: 'demo', owner_user_id: 'clerk-owner', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], members: [], tokens: [] },
    }), { mode: 0o600 });
    await expect(importMigration({
      manifestPath,
      s3: { markdown: createMarkdownStore(new Map()), prefix: 'target' },
      firestore: { metadata: new FirestoreMetadataStore(new FakeFirestore()) },
      firebaseUidMap: {},
    })).rejects.toThrow('Firebase UID mapping is missing');
  });
});
