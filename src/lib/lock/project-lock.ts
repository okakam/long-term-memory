import { randomUUID } from 'node:crypto';

import { Redis } from '@upstash/redis';

import { KeyedMutex } from '@/lib/memory/mutex';
import { assertProjectId } from '@/lib/slug';
import { resolveStorageMode, type StorageMode } from '@/lib/storage/contracts';

const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const localMutex = new KeyedMutex();
let redisClient: LockRedis | null = null;

export interface LockRedis {
  set(key: string, value: string, options: { nx: true; ex: number }): Promise<'OK' | string | null>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface ProjectLockOptions {
  mode?: StorageMode;
  redis?: LockRedis;
  ttlSeconds?: number;
  waitMs?: number;
  retryMs?: number;
}

function getRedis(): LockRedis {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for vercel locks');
  redisClient = new Redis({ url, token });
  return redisClient;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRedisLock<T>(projectId: string, fn: () => Promise<T> | T, options: ProjectLockOptions): Promise<T> {
  const redis = options.redis ?? getRedis();
  const key = `ltm:lock:${projectId}`;
  const owner = randomUUID();
  const ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds ?? 30));
  const waitMs = Math.max(0, options.waitMs ?? 5_000);
  const retryMs = Math.max(1, options.retryMs ?? 50);
  const started = Date.now();
  while (true) {
    const result = await redis.set(key, owner, { nx: true, ex: ttlSeconds });
    if (result === 'OK') break;
    if (Date.now() - started >= waitMs) throw new Error(`timed out acquiring project lock: ${projectId}`);
    await wait(Math.min(retryMs, Math.max(1, waitMs - (Date.now() - started))));
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_SCRIPT, [key], [owner]);
  }
}

export function withProjectLock<T>(projectId: string, fn: () => Promise<T> | T, options: ProjectLockOptions = {}): Promise<T> {
  const project = assertProjectId(projectId);
  const mode = options.mode ?? resolveStorageMode();
  if (mode === 'local') return localMutex.run(project, fn);
  return withRedisLock(project, fn, options);
}

export function resetProjectLockForTests(): void {
  redisClient = null;
}
