import { MemoryService } from '@/lib/memory/service';
import { RemoteMemoryService } from '@/lib/memory/remote-service';
import { resolveStorageMode } from '@/lib/storage/contracts';

export type MemoryServiceLike = MemoryService | RemoteMemoryService;

let instance: MemoryServiceLike | null = null;

export function getMemoryService(): MemoryServiceLike {
  if (!instance) {
    const mode = process.env.VERCEL === '1' ? 'vercel' : resolveStorageMode();
    instance = mode === 'vercel' ? RemoteMemoryService.openDefault() : MemoryService.openDefault();
  }
  return instance;
}

export function resetMemoryService(): void {
  if (!instance) return;
  try { instance.close(); } catch { /* test cleanup must be best effort */ }
  instance = null;
}
