import { MemoryService } from '@/lib/memory/service';
import { CloudMemoryService } from '@/lib/memory/cloud-service';
import { resolveStorageMode } from '@/lib/storage/contracts';

export type MemoryServiceLike = MemoryService | CloudMemoryService;

let instance: MemoryServiceLike | null = null;

export function getMemoryService(): MemoryServiceLike {
  if (!instance) {
    const mode = resolveStorageMode();
    instance = mode === 'cloud' ? CloudMemoryService.openDefault() : MemoryService.openDefault();
  }
  return instance;
}

export function resetMemoryService(): void {
  if (!instance) return;
  try { instance.close(); } catch { /* test cleanup must be best effort */ }
  instance = null;
}
