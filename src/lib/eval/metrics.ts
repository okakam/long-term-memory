export function recallAtK(results: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const found = new Set(results.slice(0, Math.max(0, k)));
  return relevant.filter((item) => found.has(item)).length / relevant.length;
}

export function reciprocalRank(results: string[], relevant: string[]): number {
  const set = new Set(relevant);
  const index = results.findIndex((item) => set.has(item));
  return index < 0 ? 0 : 1 / (index + 1);
}
