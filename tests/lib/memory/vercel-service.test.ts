import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMemoryService, resetMemoryService } from '@/lib/memory/singleton';
import { computeHash } from '@/lib/markdown/file-io';
import { RemoteMemoryService } from '@/lib/memory/remote-service';
import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';
import { openTursoDb } from '@/lib/storage/turso-index';

const roots: string[] = [];

const lockKeys: string[] = [];
const lockRedis = {
  async set(key: string) { lockKeys.push(key); return 'OK' as const; },
  async eval() { return 1; },
};

afterEach(() => {
  resetMemoryService();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  lockKeys.length = 0;
});

function memoryStore(): MarkdownStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async read(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
    async write(key, text): Promise<StoredObject> {
      objects.set(key, text);
      return { key, size: Buffer.byteLength(text), updatedAt: new Date() };
    },
    async remove(key) { objects.delete(key); },
    async list(prefix) {
      return [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: Buffer.byteLength(objects.get(key)!), updatedAt: new Date() }));
    },
  };
}

test('Vercel service はローカル保存先に触れず Turso 索引を使う', async () => {
  vi.stubEnv('LTM_STORAGE_DRIVER', 'vercel');
  vi.stubEnv('LTM_HOME', '/proc/1');
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-service-'));
  roots.push(root);
  vi.stubEnv('TURSO_DATABASE_URL', `file:${join(root, 'index.db')}`);
  vi.stubEnv('TURSO_AUTH_TOKEN', 'test-token');

  const service = getMemoryService();

  await expect(Promise.resolve(service.listProjects())).resolves.toEqual([]);
});


test('Vercel service は Blob を正本にして Turso 索引を更新する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-remote-'));
  roots.push(root);
  const clientUrl = `file:${join(root, 'index.db')}`;
  const markdown = memoryStore();
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown, lockRedis);

  const saved = await service.save('project', {
    name: 'remote-memory', description: 'remote description', type: 'project', body: 'remote body', tags: ['remote'],
  });
  expect(await service.get('project', saved.id)).toMatchObject({ name: 'remote-memory', body: 'remote body' });
  expect((await service.searchFulltext('project', 'remote')).map((item) => item.name)).toEqual(['remote-memory']);

  const updated = await service.update('project', saved.id, { body: 'updated body', tags: ['updated'] });
  expect(updated.body).toBe('updated body');
  expect((await service.listSummaries('project'))[0]).toMatchObject({ tags: ['updated'], body_chars: 12 });

  await service.reindex();
  expect(await service.get('project', saved.id)).toMatchObject({ body: 'updated body' });

  await service.forget('project', saved.id);
  await expect(service.get('project', saved.id)).rejects.toThrow('memory not found');
  expect(markdown.objects).toEqual(new Map());
  service.close();
});

test('forgetでBlob削除に失敗してもreindexで削除済み記憶が復活しない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-tombstone-'));
  roots.push(root);
  const markdown = memoryStore();
  const clientUrl = `file:${join(root, 'index.db')}`;
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown, lockRedis);

  const saved = await service.save('project', {
    name: 'deleted-memory', description: 'description', type: 'project', body: 'body',
  });
  const originalRemove = markdown.remove;
  markdown.remove = async () => { throw new Error('blob delete failed'); };
  await service.forget('project', saved.id);
  markdown.remove = originalRemove;

  await service.reindex('project');
  await expect(service.get('project', saved.id)).rejects.toThrow('memory not found');
  service.close();
});

test('reindexは設定したBlob prefix外のobjectを取り込まない', async () => {
  vi.stubEnv('LTM_BLOB_PREFIX', 'preview');
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-prefix-'));
  roots.push(root);
  const markdown = memoryStore();
  const clientUrl = `file:${join(root, 'index.db')}`;
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown, lockRedis);
  await service.save('project', {
    name: 'prefix-memory', description: 'description', type: 'project', body: 'body',
  });
  const raw = markdown.objects.get([...markdown.objects.keys()][0]);
  expect(raw).toBeDefined();
  const foreignRaw = raw!.replace('name: prefix-memory', 'name: foreign-memory');
  markdown.objects.set('production/project/memories/foreign-memory/' + computeHash(foreignRaw) + '.md', foreignRaw);

  await service.reindex('project');
  await expect(service.get('project', 'foreign-memory')).rejects.toThrow('memory not found');
  service.close();
});

test('remote service は rename でBlobと参照先を更新する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-rename-'));
  roots.push(root);
  const markdown = memoryStore();
  const clientUrl = 'file:' + join(root, 'index.db');
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown, lockRedis);
  const saved = await service.save('project', {
    name: 'old-name', description: 'description', type: 'project', body: 'body',
  });
  await service.save('project', {
    name: 'source-memory', description: 'description', type: 'project', body: 'body', links: ['old-name'],
  });
  await service.rename('project', 'old-name', 'new-name');
  await expect(service.get('project', 'old-name')).rejects.toThrow('memory not found');
  await expect(service.get('project', 'new-name')).resolves.toMatchObject({ id: saved.id, name: 'new-name' });
  await service.reindex('project');
  await expect(service.get('project', 'source-memory')).resolves.toMatchObject({ links: ['new-name'] });
  service.close();
});

test('renameで旧Blob削除に失敗してもreindexで旧memoryが復活しない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-rename-tombstone-'));
  roots.push(root);
  const markdown = memoryStore();
  const clientUrl = 'file:' + join(root, 'index.db');
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown, lockRedis);
  const saved = await service.save('project', {
    name: 'old-name', description: 'description', type: 'project', body: 'body',
  });
  const originalRemove = markdown.remove;
  markdown.remove = async () => { throw new Error('blob delete failed'); };
  await service.rename('project', 'old-name', 'new-name');
  markdown.remove = originalRemove;

  await service.reindex('project');
  await expect(service.get('project', saved.id)).resolves.toMatchObject({ name: 'new-name' });
  await expect(service.get('project', 'old-name')).rejects.toThrow('memory not found');
  service.close();
});

test('remote writeと全体reindexは共通のRedis global lockを使う', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-vercel-global-lock-'));
  roots.push(root);
  const markdown = memoryStore();
  const clientUrl = 'file:' + join(root, 'index.db');
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown, lockRedis);
  await service.saveAsync('project', {
    name: 'global-lock-memory', description: 'description', type: 'project', body: 'body',
  });
  expect(lockKeys).toContain('ltm:lock:__shared__');
  lockKeys.length = 0;
  await service.reindex();
  expect(lockKeys).toContain('ltm:lock:__shared__');
  service.close();
});
