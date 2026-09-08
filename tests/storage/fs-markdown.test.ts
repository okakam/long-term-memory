import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { computeHash } from '@/lib/markdown/file-io';
import { FsMarkdownStore } from '@/lib/storage/fs-markdown';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore() {
  const root = mkdtempSync(join(tmpdir(), 'ltm-fs-store-'));
  roots.push(root);
  return { root, store: new FsMarkdownStore(root) };
}

describe('FsMarkdownStore', () => {
  test('write/read/list/remove と UTF-8 byte size の契約を満たす', async () => {
    const { root, store } = createStore();
    const key = 'projects/my-project/memories/example.md';
    const text = '本文𠮷\n';

    const stored = await store.write(key, text);
    expect(stored).toMatchObject({ key, size: Buffer.byteLength(text) });
    expect(stored.updatedAt).toBeInstanceOf(Date);
    expect(await store.read(key)).toBe(text);
    expect(readFileSync(join(root, key), 'utf8')).toBe(text);
    expect(await store.list('projects/my-project/memories/')).toEqual([stored]);

    await store.remove(key);
    await expect(store.read(key)).rejects.toThrow();
    expect(await store.list('projects/my-project/memories/')).toEqual([]);
  });

  test('overwrite=false の既存キー書き込みを拒否する', async () => {
    const { store } = createStore();
    const key = 'projects/my-project/memories/example.md';
    await store.write(key, 'first');
    await expect(store.write(key, 'second', { overwrite: false })).rejects.toThrow();
    expect(await store.read(key)).toBe('first');
  });

  test('root 外へ逸脱する key と prefix を拒否する', async () => {
    const { store } = createStore();
    await expect(store.write('../escape.md', 'secret')).rejects.toThrow();
    await expect(store.read('/absolute.md')).rejects.toThrow();
    await expect(store.list('projects/../')).rejects.toThrow();
  });

  test('markdown 全文の SHA-256 を決定的に計算する', () => {
    expect(computeHash('---\nid: one\n---\nbody\n')).toBe('ace4033d78830e91a2011e9708e57452c454830645d5a684daa500d301c7e410');
    expect(computeHash('---\nid: one\n---\nbody\n')).toBe(computeHash('---\nid: one\n---\nbody\n'));
    expect(computeHash('body')).not.toBe(computeHash('body\n'));
  });
});
