import type { MemoryType } from '@/lib/memory/types';

export const HALF_LIFE_DAYS: Record<MemoryType, number | null> = {
  user: null,
  feedback: null,
  reference: 180,
  project: 60,
  session: 30,
};
export const RECENCY_WEIGHT = 0.2;
export const SUPERSEDED_PENALTY = 0.5;

export interface RerankItem {
  relevance: number;
  updated_at: string;
  type: MemoryType;
  superseded?: boolean;
  superseded_by?: string;
}

export function decayFactor(updatedAt: string, now: Date, type: MemoryType): number {
  const halfLife = HALF_LIFE_DAYS[type];
  if (halfLife === null) return 1;
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) return 1;
  const ageDays = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
  return 0.5 ** (ageDays / halfLife);
}

export function normalizeRelevance(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  if (span === 0) return values.map(() => 1);
  return values.map((value) => (value - min) / span);
}

export function rerank<T extends RerankItem>(items: T[], now = new Date()): T[] {
  const normalized = normalizeRelevance(items.map((item) => item.relevance));
  return items.map((item, index) => ({
    item,
    score: normalized[index] + RECENCY_WEIGHT * decayFactor(item.updated_at, now, item.type)
      - ((item.superseded || item.superseded_by !== undefined) ? SUPERSEDED_PENALTY : 0),
    index,
  })).sort((left, right) => right.score - left.score || left.index - right.index).map(({ item }) => item);
}
