import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import type { Memory } from '@/lib/memory/types';

const mocks = vi.hoisted(() => ({
  getMemoryService: vi.fn(),
}));

vi.mock('@/lib/memory/singleton', () => ({ getMemoryService: mocks.getMemoryService }));

import ProjectPage from '@/app/p/[slug]/page';
import MemoryDetailPage from '@/app/p/[slug]/memories/[name]/page';
import MemoriesPage from '@/app/p/[slug]/memories/page';
import MemoryEditor from '@/components/MemoryEditor';

const memory: Memory = {
  id: 'memory-id',
  name: 'project-memory',
  description: 'A project decision',
  type: 'project',
  tags: ['important'],
  links: [],
  entities: [{ name: 'TypeScript', aliases: ['TS'] }],
  triples: [['TypeScript', 'uses', 'TypeScript']],
  supersedes: [],
  body: '# Decision\\n\\nKeep the body visible.',
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-05T00:00:00.000Z',
};

beforeEach(() => {
  vi.stubEnv('AUTH_REQUIRED', '0');
  vi.stubEnv('VERCEL', '0');
  mocks.getMemoryService.mockReturnValue({
    listSummaries: vi.fn(() => []),
    listByType: vi.fn(() => [memory]),
    searchByTag: vi.fn(() => [memory]),
    get: vi.fn(() => memory),
    supersededByMap: vi.fn(() => new Map()),
    readKgGraph: vi.fn(() => ({ memories: [], entities: [], memberships: [], edges: [], links: [] })),
    kgStats: vi.fn(() => ({ entities: 0, edges: 0, memberships: 0 })),
  } as unknown as MemoryService);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test('project page は不正 slug を Invalid project slug として表示する', async () => {
  const element = await ProjectPage({ params: Promise.resolve({ slug: 'Bad_Slug' }) });
  expect(renderToStaticMarkup(element)).toContain('Invalid project slug.');
  expect(mocks.getMemoryService).not.toHaveBeenCalled();
});

test('memory detail は本文と entity alias を表示し、shared では Edit を隠す', async () => {
  const element = await MemoryDetailPage({
    params: Promise.resolve({ slug: '__shared__', name: 'project-memory' }),
  });
  const html = renderToStaticMarkup(element);
  expect(html).toContain('Keep the body visible.');
  expect(html).toContain('TS');
  expect(html).not.toContain('>Edit<');
});

test('MemoryEditor は shared/read-only を明示する', () => {
  const html = renderToStaticMarkup(createElement(MemoryEditor, { memory, projectId: '__shared__', readOnly: true }));
  expect(html).toContain('read-only');
  expect(html).not.toContain('Save');
});

test('shared の memories page は delete 操作を描画しない', async () => {
  const element = await MemoriesPage({
    params: Promise.resolve({ slug: '__shared__' }),
    searchParams: Promise.resolve({}),
  });
  const html = renderToStaticMarkup(element);
  expect(html).toContain('project-memory');
  expect(html).not.toContain('Delete');
});
