import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

test('Cloud Run deployはOAuth feature flagをEnvironment variableから注入する', () => {
  const workflow = read('.github/workflows/cloud-run.yml');
  expect(workflow).toContain('MCP_OAUTH_ENABLED=${{ vars.MCP_OAUTH_ENABLED }}');
});

test('Codex手順はOAuth loginを案内し、curator PAT運用を維持する', () => {
  const setup = read('docs/post-mcp-setup.md');
  expect(setup).toContain('codex mcp remove long-term-memory');
  expect(setup).toContain('codex mcp login long-term-memory');
  expect(setup).toContain('LTM_MAINTENANCE_TOKEN');
  const codexSetup = setup.split('### Codexでskillを使う場合', 1)[0];
  expect(codexSetup).not.toContain('--bearer-token-env-var LTM_MCP_TOKEN');
  expect(setup).toContain('--bearer-token-env-var LTM_MCP_TOKEN');
});

test('OAuth rolloutとrollbackは本番ドキュメントに記録される', () => {
  const deployment = read('docs/cloud-run-production-deployment.md');
  expect(deployment).toContain('MCP_OAUTH_ENABLED');
  expect(deployment).toContain('flagを `0`');
  expect(deployment).toContain('PAT smoke');
});
