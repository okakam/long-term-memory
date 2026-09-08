export interface WeightedEdge {
  to: string;
  w: number;
}

export interface WeightedGraph {
  nodes: Iterable<string>;
  adjacency: Map<string, WeightedEdge[]>;
}

export interface PprOptions {
  alpha?: number;
  maxIter?: number;
  tol?: number;
}

export const PPR_DEFAULTS: Required<PprOptions> = { alpha: 0.15, maxIter: 100, tol: 1e-6 };

export function personalizedPageRank(graph: WeightedGraph, seeds: string[], options: PprOptions = {}): Map<string, number> {
  const nodes = [...new Set(graph.nodes)];
  const nodeSet = new Set(nodes);
  const validSeeds = [...new Set(seeds)].filter((seed) => nodeSet.has(seed));
  if (nodes.length === 0 || validSeeds.length === 0) return new Map();
  const alpha = Math.min(Math.max(options.alpha ?? PPR_DEFAULTS.alpha, 0), 1);
  const maxIter = Math.max(1, Math.floor(options.maxIter ?? PPR_DEFAULTS.maxIter));
  const tol = Math.max(0, options.tol ?? PPR_DEFAULTS.tol);
  const seedMass = 1 / validSeeds.length;
  const restart = new Map(nodes.map((node) => [node, 0]));
  for (const seed of validSeeds) restart.set(seed, seedMass);
  let scores = new Map(nodes.map((node) => [node, restart.get(node)!]));
  const walk = 1 - alpha;

  for (let iteration = 0; iteration < maxIter; iteration += 1) {
    const next = new Map(nodes.map((node) => [node, alpha * (restart.get(node) ?? 0)]));
    let dangling = 0;
    for (const node of nodes) {
      const mass = scores.get(node) ?? 0;
      const edges = (graph.adjacency.get(node) ?? []).filter((edge) => nodeSet.has(edge.to) && edge.w > 0);
      const degree = edges.reduce((sum, edge) => sum + edge.w, 0);
      if (degree === 0) { dangling += mass; continue; }
      for (const edge of edges) next.set(edge.to, next.get(edge.to)! + walk * mass * edge.w / degree);
    }
    for (const seed of validSeeds) next.set(seed, next.get(seed)! + walk * dangling * seedMass);
    const delta = nodes.reduce((sum, node) => sum + Math.abs(next.get(node)! - scores.get(node)!), 0);
    scores = next;
    if (delta < tol) break;
  }
  return scores;
}
