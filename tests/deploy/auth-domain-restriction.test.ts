import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

test('CIはFirebase Blocking Functionsのtestとbuildを実行する', async () => {
  const workflow = await readFile('.github/workflows/cloud-run.yml', 'utf8');
  expect(workflow).toContain('pnpm --dir functions --ignore-workspace install --frozen-lockfile --ignore-scripts');
  expect(workflow).toContain('pnpm --dir functions --ignore-workspace test');
  expect(workflow).toContain('pnpm --dir functions --ignore-workspace build');
});

test('運用ドキュメントはokakam.net制限とFunctions deployを記載する', async () => {
  const setup = await readFile('docs/google-cloud-cli-setup.md', 'utf8');
  const production = await readFile('docs/cloud-run-production-deployment.md', 'utf8');
  expect(setup).toContain('firebase deploy --project="$LTM_PROJECT_ID" --only functions');
  expect(setup).toContain('eventarcpublishing.googleapis.com');
  expect(production).toContain('okakam.net');
});
