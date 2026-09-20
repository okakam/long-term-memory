import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

import nextConfig from '../../next.config';

const root = resolve(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

test('Docker配布設定はCloud RunのPORTと一時SQLiteを使う', () => {
  const dockerfile = read('Dockerfile');
  expect(dockerfile).toContain('ARG NODE_IMAGE=node:22-bookworm-slim');
  expect(dockerfile).toContain('pnpm install --frozen-lockfile');
  expect(dockerfile).toContain('LTM_HOME=/tmp/long-term-memory');
  expect(dockerfile).toContain('LTM_STORAGE_DRIVER=cloud');
  expect(dockerfile).toContain('AUTH_REQUIRED=1');
  expect(dockerfile).toContain('PORT=8080');
  expect(dockerfile).toContain('EXPOSE 8080');
  expect(dockerfile).toContain('${PORT:-8080}');
  const compose = read('docker-compose.yml');
  expect(compose).toContain('create_host_path: false');
  expect(compose).toContain('target: /data');
  expect(compose).toContain('3939:3939');
  expect(compose).toContain('LTM_STORAGE_DRIVER: local');
});

test('環境変数サンプルはCloud Run/Firebase/S3のキーだけを含み秘密値を含まない', () => {
  const env = read('.env.example');
  for (const name of [
    'LTM_STORAGE_DRIVER', 'AUTH_REQUIRED', 'LTM_LOCAL_USER_ID', 'LTM_S3_BUCKET', 'LTM_S3_PREFIX', 'AWS_REGION',
    'FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID', 'MCP_PUBLIC_URL',
    'MCP_ALLOWED_ORIGINS', 'LTM_CURATOR_USER_ID', 'LTM_MAINTENANCE_TOKEN',
  ]) expect(env).toMatch(new RegExp('^' + name + '=', 'm'));
  expect(env).not.toMatch(/^(?:TURSO|BLOB|UPSTASH|CLERK|VERCEL).*=[^\s]+/m);
});

test('Next security headersはFirebase endpointと基本防御を含む', async () => {
  const headerGroups = await nextConfig.headers?.() ?? [];
  const headers = new Map(headerGroups.flatMap((group) => group.headers.map((header) => [header.key, header.value])));
  expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  const csp = headers.get('Content-Security-Policy') ?? '';
  expect(csp).toContain('identitytoolkit.googleapis.com');
  expect(csp).toMatch(/frame-src 'self' https:\/\/\*\.firebaseapp\.com https:\/\/\*\.web\.app https:\/\/accounts\.google\.com/);
  expect(csp).toContain("frame-ancestors 'none'");
});

test('Cloud Run workflowはPRでruntime secretを使わず低コスト設定でdeployする', () => {
  const workflow = read('.github/workflows/cloud-run.yml');
  expect(workflow).toContain('pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]');
  expect(workflow).toContain('push:\n    branches: [main]');
  expect(workflow).toMatch(/if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/);
  expect(workflow).toContain('group: cloud-run-production');
  expect(workflow).toContain('pnpm test');
  expect(workflow).toContain('NODE_ENV=production pnpm build');
  expect(workflow).toContain('docker build');
  expect(workflow).toContain('docker run --detach --name "$container_name"');
  expect(workflow).toContain('--env AUTH_REQUIRED=0');
  expect(workflow).toContain('--env LTM_STORAGE_DRIVER=local');
  expect(workflow).toContain('http://127.0.0.1:8080/api/health');
  expect(workflow).toContain('docker rm --force "$container_name"');
  expect(workflow).toContain('id-token: write');
  expect(workflow).toContain('--min 0 --max 1 --concurrency 1');
  expect(workflow).toContain('--allow-unauthenticated');
  expect(workflow).toContain('--cpu 1 --memory 512Mi');
  expect(workflow).toContain('--service-account');
  expect(workflow).toContain('--set-env-vars');
  expect(workflow).toContain('LTM_STORAGE_DRIVER=cloud');
  expect(workflow).toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
  expect(workflow).toContain('--set-secrets');
  expect(workflow).toContain('AWS_ACCESS_KEY_ID');
  const verify = workflow.slice(0, workflow.indexOf('  deploy:'));
  expect(verify).not.toContain('secrets.');
});

test('Firebase/Firestore設定とCloud Run smokeをリポジトリ内に用意する', () => {
  expect(existsSync(resolve(root, 'firebase.json'))).toBe(true);
  expect(existsSync(resolve(root, 'firestore.rules'))).toBe(true);
  expect(read('firestore.rules')).toContain('allow read, write: if false');
  expect(read('firestore.indexes.json')).toContain('"indexes": []');
  expect(read('src/app/api/health/route.ts')).toContain("service: 'long-term-memory'");
  expect(read('scripts/cloud-run-smoke.ts')).toContain('tools/list');
  expect(read('scripts/cloud-run-smoke.ts')).toContain('CLOUD_RUN_URL');
  expect(existsSync(resolve(root, 'src/app/api/auth/config/route.ts'))).toBe(true);
  expect(existsSync(resolve(root, 'docs/eval/cloud-run-smoke.json'))).toBe(true);
});

test('Cloud Run smokeはMCPの主要read/write/reindex経路を実際に呼び出す', () => {
  const smoke = read('scripts/cloud-run-smoke.ts');
  for (const toolCall of [
    "callTool(baseUrl, projectId, token, 4, 'get_memory'",
    "callTool(baseUrl, projectId, token, 5, 'update_memory'",
    "callTool(baseUrl, projectId, token, 7, 'link_memories'",
    "callTool(baseUrl, projectId, token, 9, 'reindex'",
    "callTool(baseUrl, projectId, token, 11, 'forget_memory'",
  ]) expect(smoke).toContain(toolCall);
});
