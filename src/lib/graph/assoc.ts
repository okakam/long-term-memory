import type Database from 'better-sqlite3';

import { personalizedPageRank, type PprOptions, type WeightedGraph } from '@/lib/graph/ppr';

export const ASSOC_WEIGHTS = { manualLink: 2.0, triple: 1.0, membership: 1.0 } as const;

function addEdge(adjacency: Map<string, Array<{ to: string; w: number }>>, from: string, to: string, w: number): void {
  if (from === to) return;
  adjacency.get(from)?.push({ to, w });
  adjacency.get(to)?.push({ to: from, w });
}

export function buildAssociativeGraph(db: Database.Database, projectId: string): WeightedGraph {
  const memoryIds = (db.prepare('SELECT id FROM memories WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map((row) => row.id);
  const entityIds = (db.prepare('SELECT id FROM entities WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map((row) => `ent:${row.id}`);
  const nodes = [...memoryIds, ...entityIds];
  const adjacency = new Map(nodes.map((node) => [node, [] as Array<{ to: string; w: number }>]));
  const memberships = db.prepare(`SELECT me.memory_id AS memoryId, me.entity_id AS entityId FROM memory_entities me
    JOIN memories m ON m.id = me.memory_id WHERE m.project_id = ?`).all(projectId) as Array<{ memoryId: string; entityId: string }>;
  for (const membership of memberships) addEdge(adjacency, membership.memoryId, `ent:${membership.entityId}`, ASSOC_WEIGHTS.membership);

  const triples = db.prepare(`SELECT ee.src_entity_id AS src, ee.dst_entity_id AS dst, COUNT(*) AS count
    FROM entity_edges ee JOIN entities e ON e.id = ee.src_entity_id
    WHERE e.project_id = ? GROUP BY ee.src_entity_id, ee.dst_entity_id`).all(projectId) as Array<{ src: string; dst: string; count: number }>;
  for (const triple of triples) addEdge(adjacency, `ent:${triple.src}`, `ent:${triple.dst}`, ASSOC_WEIGHTS.triple * triple.count);

  const links = db.prepare(`SELECT l.src_id AS src, dst.id AS dst FROM links l
    JOIN memories src_memory ON src_memory.id = l.src_id
    JOIN memories dst ON dst.project_id = src_memory.project_id AND dst.name = l.dst_name
    WHERE src_memory.project_id = ?`).all(projectId) as Array<{ src: string; dst: string }>;
  for (const link of links) addEdge(adjacency, link.src, link.dst, ASSOC_WEIGHTS.manualLink);
  return { nodes, adjacency };
}

export function resolveSeedEntities(db: Database.Database, projectId: string, names: string[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const canonical = db.prepare('SELECT id FROM entities WHERE project_id = ? AND name = ? COLLATE NOCASE LIMIT 1').get(projectId, name) as { id: string } | undefined;
    const alias = canonical ?? db.prepare(`SELECT e.id FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
      WHERE e.project_id = ? AND a.alias = ? COLLATE NOCASE LIMIT 1`).get(projectId, name) as { id: string } | undefined;
    if (alias && !ids.includes(alias.id)) ids.push(alias.id);
  }
  return ids;
}

export function rankMemoriesByPpr(
  db: Database.Database,
  projectId: string,
  ftsHitMemoryIds: string[],
  queryEntityNames: string[],
  options: PprOptions = {},
): Array<{ id: string; relevance: number }> {
  const graph = buildAssociativeGraph(db, projectId);
  const entitySeeds = resolveSeedEntities(db, projectId, queryEntityNames).map((id) => `ent:${id}`);
  const seeds = [...new Set([...ftsHitMemoryIds, ...entitySeeds])];
  const scores = personalizedPageRank(graph, seeds, options);
  return [...graph.nodes]
    .filter((node) => !node.startsWith('ent:') && (scores.get(node) ?? 0) > 1e-12)
    .map((id) => ({ id, relevance: scores.get(id)! }))
    .sort((left, right) => right.relevance - left.relevance);
}
