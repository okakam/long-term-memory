import { afterEach, expect, test } from 'vitest';

import { resolveStorage } from '@/lib/paths';

const originalHome = process.env.LTM_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LTM_HOME;
  else process.env.LTM_HOME = originalHome;
});

test('LTM_HOME 配下の全保存先を生成する', () => {
  process.env.LTM_HOME = '/tmp/ltm-test-home';
  const storage = resolveStorage();

  expect(storage).toMatchObject({
    home: '/tmp/ltm-test-home',
    indexDb: '/tmp/ltm-test-home/index.db',
    configJson: '/tmp/ltm-test-home/config.json',
    logsDir: '/tmp/ltm-test-home/logs',
  });
  expect(storage.projectDir('my-project')).toBe('/tmp/ltm-test-home/projects/my-project');
  expect(storage.memoriesDir('my-project')).toBe('/tmp/ltm-test-home/projects/my-project/memories');
  expect(storage.memoryFile('my-project', 'memory-name')).toBe('/tmp/ltm-test-home/projects/my-project/memories/memory-name.md');
  expect(storage.memoryIndexMd('my-project')).toBe('/tmp/ltm-test-home/projects/my-project/MEMORY.md');
});

test('resolveStorage は呼び出しごとに LTM_HOME を読む', () => {
  process.env.LTM_HOME = '/tmp/first-home';
  expect(resolveStorage().home).toBe('/tmp/first-home');
  process.env.LTM_HOME = '/tmp/second-home';
  expect(resolveStorage().home).toBe('/tmp/second-home');
});
