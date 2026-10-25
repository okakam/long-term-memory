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

test('Functionsはupload単体でpnpm installできるようbuild script許可設定を持つ', async () => {
  // Cloud Buildはfunctions/だけを受け取るため、ルートのpnpm-workspace.yamlは使われない。
  const functionsWorkspace = await readFile('functions/pnpm-workspace.yaml', 'utf8');
  expect(functionsWorkspace).toMatch(/^allowBuilds:$/m);
  expect(functionsWorkspace).toContain("'@firebase/util': false");
  expect(functionsWorkspace).toContain('protobufjs: false');
});

test('FunctionsはCloud Buildのpnpm buildpackが要求する依存を明示する', async () => {
  // pnpm projectではFunctions Frameworkの明示が必須。firebase-adminはfirebase-functionsの必須peer。
  const manifest = JSON.parse(await readFile('functions/package.json', 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(manifest.dependencies).toHaveProperty('@google-cloud/functions-framework');
  expect(manifest.dependencies).toHaveProperty('firebase-admin');
  expect(manifest.dependencies).toHaveProperty('firebase-functions');
});
