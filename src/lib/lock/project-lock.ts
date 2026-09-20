import { KeyedMutex } from '@/lib/memory/mutex';
import { assertProjectId } from '@/lib/slug';

const mutex = new KeyedMutex();

export interface ProjectLockOptions {
  waitMs?: number;
}

export function withProjectLock<T>(projectId: string, fn: () => Promise<T> | T, options: ProjectLockOptions = {}): Promise<T> {
  void options;
  return mutex.run(assertProjectId(projectId), fn);
}

export function resetProjectLockForTests(): void {
  // Cloud Runは単一インスタンスのKeyedMutexだけを使う。
}
