import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

test('local wrapperはUTC backfill入力を渡し、既定でschedule扱いにする', () => {
  const wrapper = readFileSync(resolve(root, 'scripts/curator/run-curation.sh'), 'utf8');
  expect(wrapper).toContain('FROM_DATE="${FROM_DATE:-}"');
  expect(wrapper).toContain('TO_DATE="${TO_DATE:-}"');
  expect(wrapper).toContain('GITHUB_EVENT_NAME="${GITHUB_EVENT_NAME:-schedule}"');
  expect(wrapper).toContain('pnpm exec tsx scripts/curator/run-dated-curation.ts');
});

test('curatorはGitHub Actionsで実行せずlocal timerだけで定期実行する', () => {
  expect(existsSync(resolve(root, '.github/workflows/curator.yml'))).toBe(false);
  const wrapper = readFileSync(resolve(root, 'scripts/curator/run-curation.sh'), 'utf8');
  expect(wrapper).toContain('run.lock');
});
