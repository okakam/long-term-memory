import { expect, test } from 'vitest';

import { KeyedMutex } from '@/lib/memory/mutex';

test('KeyedMutex は同じキーを直列化し異なるキーは並行実行する', async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = mutex.run('project', async () => {
    events.push('first:start');
    await gate;
    events.push('first:end');
  });
  const second = mutex.run('project', async () => events.push('second'));
  const other = mutex.run('other', async () => events.push('other'));

  await other;
  expect(events).toEqual(['first:start', 'other']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
});

test('KeyedMutex は例外後に同じキーを再利用できる', async () => {
  const mutex = new KeyedMutex();
  await expect(mutex.run('project', () => { throw new Error('failed'); })).rejects.toThrow('failed');
  await expect(mutex.run('project', () => 'recovered')).resolves.toBe('recovered');
});
