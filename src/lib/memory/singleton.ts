import { MemoryService } from '@/lib/memory/service';

let instance: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!instance) instance = MemoryService.openDefault();
  return instance;
}

export function resetMemoryService(): void {
  if (!instance) return;
  try { instance.close(); } catch { /* test cleanup must be best effort */ }
  instance = null;
}
