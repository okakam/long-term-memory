import { personalizedPageRank, type WeightedGraph } from '@/lib/graph/ppr';
import type { IndexStore } from '@/lib/storage/contracts';

const WEIGHTS = { manualLink: 2, triple: 1, membership: 1 } as const;

function addEdge(adjacency: Map<string, Array<{ to: string; w: number }>>, from: string, to: string, weight: number): void {
  if (from === to) return;
  adjacency.get(from)?.push({ to, w: weight });
  adjacency.get(to)?.push({ to: from, w: weight });
}

async function buildGraph(store: IndexStore, projectId: string): Promise<WeightedGraph> {
  const memories = await store.query<{ id: string }>('SELECT id FROM memories WHERE project_id = ?', [projectId]);
  const entities = await store.query<{ id: string }>('SELECT id FROM entities WHERE project_id = ?', [projectId]);
  const nodes = [...memories.map((row) => row.id), ...entities.map((row) => `ent:${row.id}`)];
  const adjacency = new Map(nodes.map((node) => [node, [] as Array<{ to: string; w: number }>]));

  const memberships = await store.query<{ memoryId: string; entityId: string }>(`SELECT me.memory_id AS memoryId, me.entity_id AS entityId
    FROM memory_entities me JOIN memories m ON m.id = me.memory_id WHERE m.project_id = ?`, [projectId]);
  for (const row of memberships) addEdge(adjacency, row.memoryId, `ent:${row.entityId}`, WEIGHTS.membership);

  const triples = await store.query<{ src: string; dst: string; count: number }>(`SELECT ee.src_entity_id AS src, ee.dst_entity_id AS dst, COUNT(*) AS count
    FROM entity_edges ee JOIN entities e ON e.id = ee.src_entity_id WHERE e.project_id = ? GROUP BY ee.src_entity_id, ee.dst_entity_id`, [projectId]);
  for (const row of triples) addEdge(adjacency, `ent:${row.src}`, `ent:${row.dst}`, WEIGHTS.triple * Number(row.count));

  const links = await store.query<{ src: string; dst: string }>(`SELECT l.src_id AS src, dst.id AS dst FROM links l
    JOIN memories src_memory ON src_memory.id = l.src_id JOIN memories dst
    ON dst.project_id = src_memory.project_id AND dst.name = l.dst_name WHERE src_memory.project_id = ?`, [projectId]);
  for (const row of links) addEdge(adjacency, row.src, row.dst, WEIGHTS.manualLink);
  return { nodes, adjacency };
}

async function resolveSeedEntities(store: IndexStore, projectId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const canonical = await store.query<{ id: string }>('SELECT id FROM entities WHERE project_id = ? AND name = ? COLLATE NOCASE LIMIT 1', [projectId, name]);
    const alias = canonical[0] ? canonical : await store.query<{ id: string }>(`SELECT e.id FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
      WHERE e.project_id = ? AND a.alias = ? COLLATE NOCASE LIMIT 1`, [projectId, name]);
    if (alias[0] && !ids.includes(alias[0].id)) ids.push(alias[0].id);
  }
  return ids;
}

export async function rankMemoriesByRemotePpr(
  store: IndexStore,
  projectId: string,
  ftsHitMemoryIds: string[],
  queryEntityNames: string[],
): Promise<Array<{ id: string; relevance: number }>> {
  const graph = await buildGraph(store, projectId);
  const entitySeeds = (await resolveSeedEntities(store, projectId, queryEntityNames)).map((id) => `ent:${id}`);
  const seeds = [...new Set([...ftsHitMemoryIds, ...entitySeeds])];
  const scores = personalizedPageRank(graph, seeds);
  return [...graph.nodes]
    .filter((node) => !node.startsWith('ent:') && (scores.get(node) ?? 0) > 1e-12)
    .map((id) => ({ id, relevance: scores.get(id)! }))
    .sort((left, right) => right.relevance - left.relevance);
}
