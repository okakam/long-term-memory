import { readFileSync } from 'node:fs';

import { recallAtK, reciprocalRank } from '@/lib/eval/metrics';
import { getMemoryService, resetMemoryService } from '@/lib/memory/singleton';

interface GoldQuery {
  id: string;
  subset: string;
  query: string;
  query_entities?: string[];
  relevant: string[];
}
interface GoldFile {
  project_id: string;
  queries: GoldQuery[];
}

const file = process.argv[2];
if (!file) throw new Error('usage: pnpm tsx scripts/eval-recall.ts <gold.json>');
const gold = JSON.parse(readFileSync(file, 'utf8')) as GoldFile;
const service = getMemoryService();

async function main(): Promise<void> {
  const subsets = [...new Set(gold.queries.map((query) => query.subset))];
  const report = Object.fromEntries(await Promise.all(subsets.map(async (subset) => {
    const queries = gold.queries.filter((query) => query.subset === subset);
    const scores = await Promise.all(queries.map(async (query) => {
      const bm25 = (await service.searchFulltext(gold.project_id, query.query, { limit: 5 })).map((memory) => memory.name);
      const hybrid = (await service.searchAssociative(gold.project_id, query.query, { queryEntities: query.query_entities, limit: 5 })).map((memory) => memory.name);
    return {
      id: query.id,
      bm25: { recall_at_5: recallAtK(bm25, query.relevant, 5), mrr: reciprocalRank(bm25, query.relevant) },
      hybrid: { recall_at_5: recallAtK(hybrid, query.relevant, 5), mrr: reciprocalRank(hybrid, query.relevant) },
    };
    }));
    const average = (key: 'recall_at_5' | 'mrr', method: 'bm25' | 'hybrid') => scores.reduce((sum, score) => sum + score[method][key], 0) / (scores.length || 1);
    return [subset, { queries: scores.length, bm25: { recall_at_5: average('recall_at_5', 'bm25'), mrr: average('mrr', 'bm25') }, hybrid: { recall_at_5: average('recall_at_5', 'hybrid'), mrr: average('mrr', 'hybrid') } }];
  })));
  console.log(JSON.stringify({ project_id: gold.project_id, subsets: report }, null, 2));
  resetMemoryService();
}

void main();
