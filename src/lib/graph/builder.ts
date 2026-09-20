import type { MemoryType } from '@/lib/memory/types';

export interface KgGraphData {
  memories: Array<{ id: string; name: string; type: MemoryType; description: string; tags: string[] }>;
  entities: Array<{ id: string; name: string }>;
  memberships: Array<{ memoryId: string; entityId: string }>;
  edges: Array<{ srcEntityId: string; dstEntityId: string; relation: string }>;
  links: Array<{ srcMemoryId: string; dstName: string }>;
}

export interface KgMemoryNodeData {
  label: string;
  memoryType: MemoryType;
  description: string;
  tags: string[];
}

export interface KgNode {
  id: string;
  kind: 'memory' | 'entity';
  data: KgMemoryNodeData | { label: string };
}

export type KgEdgeKind = 'membership' | 'triple' | 'link';

export interface KgEdge {
  id: string;
  source: string;
  target: string;
  kind: KgEdgeKind;
  weight: number;
  label?: string;
}

export interface KgGraph {
  nodes: KgNode[];
  edges: KgEdge[];
}

export function buildKgGraph(data: KgGraphData): KgGraph {
  const nodes: KgNode[] = data.memories.map((memory) => ({
    id: memory.id,
    kind: 'memory',
    data: {
      label: memory.name,
      memoryType: memory.type,
      description: memory.description,
      tags: memory.tags,
    },
  }));
  nodes.push(...data.entities.map((entity) => ({
    id: 'ent:' + entity.id,
    kind: 'entity' as const,
    data: { label: entity.name },
  })));

  const memoryIds = new Set(data.memories.map((memory) => memory.id));
  const entityIds = new Set(data.entities.map((entity) => entity.id));
  const edges: KgEdge[] = [];
  for (const membership of data.memberships) {
    if (!memoryIds.has(membership.memoryId) || !entityIds.has(membership.entityId)) continue;
    edges.push({
      id: 'mem:' + membership.memoryId + '->' + membership.entityId,
      source: membership.memoryId,
      target: 'ent:' + membership.entityId,
      kind: 'membership',
      weight: 1,
    });
  }
  for (const edge of data.edges) {
    if (!entityIds.has(edge.srcEntityId) || !entityIds.has(edge.dstEntityId)) continue;
    edges.push({
      id: 'tri:' + edge.srcEntityId + '->' + edge.dstEntityId + ':' + edge.relation,
      source: 'ent:' + edge.srcEntityId,
      target: 'ent:' + edge.dstEntityId,
      label: edge.relation,
      kind: 'triple',
      weight: 1,
    });
  }
  const idByName = new Map(data.memories.map((memory) => [memory.name, memory.id]));
  for (const link of data.links) {
    const target = idByName.get(link.dstName);
    if (!target || !memoryIds.has(link.srcMemoryId)) continue;
    edges.push({
      id: 'lnk:' + link.srcMemoryId + '->' + target,
      source: link.srcMemoryId,
      target,
      kind: 'link',
      weight: 2,
    });
  }
  return { nodes, edges };
}
