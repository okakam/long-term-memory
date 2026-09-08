export function rrfMerge<T>(lists: T[][], keyOf: (item: T) => string, k = 60): T[] {
  const scores = new Map<string, number>();
  const kept = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1));
      if (!kept.has(key)) kept.set(key, item);
    });
  }
  return [...kept.keys()]
    .sort((left, right) => scores.get(right)! - scores.get(left)!)
    .map((key) => kept.get(key)!);
}
