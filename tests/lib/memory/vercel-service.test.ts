import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMemoryService, resetMemoryService } from '@/lib/memory/singleton';
import { RemoteMemoryService } from '@/lib/memory/remote-service';
import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';
import { openTursoDb } from '@/lib/storage/turso-index';

const roots: string[] = [];

afterEach(() => {
  resetMemoryService();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
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
  const service = new RemoteMemoryService(openTursoDb({ url: clientUrl, authToken: 'test-token' }), markdown);

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
