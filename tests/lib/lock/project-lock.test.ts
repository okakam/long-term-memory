import { expect, test } from 'vitest';

import { withProjectLock, type LockRedis } from '@/lib/lock/project-lock';

test('local project lock は同一 project の処理を直列化する', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withProjectLock('project', async () => {
    events.push('first:start');
    await gate;
    events.push('first:end');
  }, { mode: 'local' });
  const second = withProjectLock('project', async () => events.push('second'), { mode: 'local' });
  await Promise.resolve();
  expect(events).toEqual(['first:start']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first:start', 'first:end', 'second']);
});

test('Redis lease は token 一致時だけ compare-and-delete で解放する', async () => {
  let value: string | null = null;
  const calls: string[] = [];
  const redis: LockRedis = {
    async set(key, token) { calls.push(`set:${key}`); if (value !== null) return null; value = token; return 'OK'; },
    async eval(_script, keys, args) { calls.push(`eval:${keys[0]}`); if (value === args[0]) { value = null; return 1; } return 0; },
  };
  await withProjectLock('project', async () => expect(value).not.toBeNull(), { mode: 'vercel', redis });
  expect(value).toBeNull();
  expect(calls).toEqual(['set:ltm:lock:project', 'eval:ltm:lock:project']);
});
