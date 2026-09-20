import type { KgEdge, KgGraph, KgNode } from './builder';

export interface KgFilters {
  showMemory: boolean;
  showEntity: boolean;
  showMembership: boolean;
  showTriple: boolean;
  showLink: boolean;
  tags: string[];
}

export const MEMORIES_ONLY_FILTERS: KgFilters = {
  showMemory: true,
  showEntity: false,
  showMembership: false,
  showTriple: false,
  showLink: true,
  tags: [],
};

function nodeVisible(node: KgNode, filters: KgFilters): boolean {
  if (node.kind === 'memory') {
    if (!filters.showMemory) return false;
    if (filters.tags.length === 0) return true;
    if (!('tags' in node.data)) return false;
    const tags = (node.data as { tags?: string[] }).tags;
    return Array.isArray(tags) && filters.tags.some((tag) => tags.includes(tag));
  }
  return filters.showEntity;
}

function edgeVisible(edge: KgEdge, filters: KgFilters): boolean {
  if (edge.kind === 'membership') return filters.showMembership;
  if (edge.kind === 'triple') return filters.showTriple;
  return filters.showLink;
}

export function filterKgGraph(graph: KgGraph, filters: KgFilters): KgGraph {
  const visibleIds = new Set(graph.nodes.filter((node) => nodeVisible(node, filters)).map((node) => node.id));
  return {
    nodes: graph.nodes.filter((node) => visibleIds.has(node.id)),
    edges: graph.edges.filter((edge) => (
      edgeVisible(edge, filters) && visibleIds.has(edge.source) && visibleIds.has(edge.target)
    )),
  };
}

export function kgNeighbors(graph: KgGraph, nodeId: string): Set<string> {
  const result = new Set([nodeId]);
  for (const edge of graph.edges) {
    if (edge.source === nodeId) result.add(edge.target);
    if (edge.target === nodeId) result.add(edge.source);
  }
  return result;
}
