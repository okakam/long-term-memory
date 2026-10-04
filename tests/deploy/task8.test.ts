import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { assertTools, smoke } from '../../scripts/cloud-run-smoke';
import { SETUP_MANIFEST } from '../../src/lib/mcp/setup-manifest.generated';

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

test('環境変数サンプルはCloud Run/Firebase/GCSのキーだけを含み秘密値を含まない', () => {
  const env = read('.env.example');
  for (const name of [
    'LTM_STORAGE_DRIVER', 'AUTH_REQUIRED', 'LTM_LOCAL_USER_ID', 'LTM_GCS_BUCKET', 'LTM_GCS_PREFIX',
    'FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID', 'MCP_PUBLIC_URL',
    'MCP_ALLOWED_ORIGINS', 'LTM_CURATOR_USER_ID', 'LTM_MAINTENANCE_TOKEN',
  ]) expect(env).toMatch(new RegExp('^' + name + '=', 'm'));
  expect(env).not.toMatch(/^(?:TURSO|BLOB|UPSTASH|CLERK|VERCEL).*=[^\s]+/m);
  expect(env).not.toMatch(/^(?:AWS_|LTM_S3_).*=[^\s]+/m);
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

  const commonGroup = headerGroups.find((group) => group.source === '/(.*)');
  expect(commonGroup).toBeDefined();
  const commonHeaders = new Map(commonGroup?.headers.map((header) => [header.key, header.value]));
  expect(commonHeaders.get('X-Content-Type-Options')).toBe('nosniff');
  expect(commonHeaders.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(commonHeaders.get('X-Frame-Options')).toBe('DENY');
  if (process.env.NODE_ENV === 'production') {
    expect(commonHeaders.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
  }

  const cspGroups = headerGroups.filter((group) => group.headers.some((header) => header.key === 'Content-Security-Policy'));
  expect(cspGroups).toHaveLength(1);
  expect(cspGroups[0].source).toBe('/((?!oauth/authorize$).*)');
  expect(cspGroups[0].headers.find((header) => header.key === 'Content-Security-Policy')?.value).toContain("form-action 'self'");
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
  expect(workflow).toContain('--retry-all-errors');
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
  expect(workflow).toContain('LTM_GCS_BUCKET');
  expect(workflow).toContain('LTM_GCS_PREFIX');
  expect(workflow).not.toContain('AWS_ACCESS_KEY_ID');
  expect(workflow).not.toContain('LTM_S3_BUCKET');
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
  expect(smoke).toContain('`${baseUrl}/api/mcp`');
  expect(smoke).not.toContain('/api/mcp?project_id=');
  expect(smoke).toContain("'list_projects'");
  expect(smoke).toContain('project_id: projectId');
  expect(smoke).toContain('isError');
  expect(smoke).toContain("params: { name: 'list_projects', arguments: {} }");
  for (const toolCall of [
    "callTool(baseUrl, projectId, token, 5, 'get_memory'",
    "callTool(baseUrl, projectId, token, 6, 'update_memory'",
    "callTool(baseUrl, projectId, token, 8, 'link_memories'",
    "callTool(baseUrl, projectId, token, 10, 'reindex'",
    "callTool(baseUrl, projectId, token, 12, 'forget_memory'",
  ]) expect(smoke).toContain(toolCall);
});

const expectedTools = [
  'list_memories_by_type', 'search_by_tag', 'find_related', 'search_memories', 'get_memory', 'get_memory_index',
  'remember_user_fact', 'remember_reference', 'remember_session_summary', 'remember_feedback', 'remember_project_fact',
  'update_memory', 'forget_memory', 'link_memories', 'list_projects', 'reindex', 'setup_client_environment',
];

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('Cloud Run smokeのinventoryはsetupを含む17 toolsを要求する', () => {
  expect(() => assertTools({ result: { tools: expectedTools.map((name) => ({ name })) } })).not.toThrow();
  expect(() => assertTools({ result: { tools: expectedTools.slice(0, -1).map((name) => ({ name })) } })).toThrow('unexpected MCP tool catalog');
});

function stubSmoke(setup: object) {
  vi.stubEnv('CLOUD_RUN_URL', 'https://smoke.example');
  vi.stubEnv('LTM_MCP_TOKEN', 'test-bearer');
  vi.stubEnv('LTM_SMOKE_PROJECT_ID', 'smoke');
  const requests: Array<{ name: string; arguments: Record<string, unknown>; authorization: string | null }> = [];
  let savedName = '';
  let targetName = '';
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (!init) return Response.json({ ok: true });
    const request = JSON.parse(String(init.body));
    if (request.method === 'tools/list') return Response.json({ result: { tools: expectedTools.map((name) => ({ name })) } });
    if (request.method === 'initialize') return Response.json({ result: {} });
    const { name, arguments: args } = request.params;
    requests.push({ name, arguments: args, authorization: new Headers(init.headers).get('authorization') });
    let value: unknown = {};
    if (name === 'setup_client_environment') value = setup;
    if (name === 'list_projects') value = [{ project_id: 'smoke' }];
    if (name === 'remember_reference') {
      if (!savedName) savedName = args.name; else targetName = args.name;
    }
    if (name === 'get_memory') value = { name: savedName, links: [targetName] };
    if (name === 'search_memories') value = [{ name: savedName }];
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
  });
  return requests;
}

test('Cloud Run smokeはBearerでproject_idなしのCodex setupと既存project toolsを呼ぶ', async () => {
  const requests = stubSmoke({ ...SETUP_MANIFEST, client: 'codex' });
  await smoke();
  expect(requests.find((request) => request.name === 'setup_client_environment')).toEqual({
    name: 'setup_client_environment', arguments: { client: 'codex' }, authorization: 'Bearer test-bearer',
  });
  const projectCalls = requests.filter((request) => !['list_projects', 'setup_client_environment'].includes(request.name));
  expect(projectCalls.length).toBeGreaterThan(0);
  for (const request of projectCalls) expect(request.arguments.project_id).toBe('smoke');
});

test.each([
  { client: 'claude-code' },
  { schema_version: 2 },
  { guide_markdown: '' },
  { assets: SETUP_MANIFEST.assets.map((asset, index) => index === 0 ? { ...asset, content: 'tampered' } : asset) },
])('Cloud Run smokeは不正setup応答 %j を拒否する', async (patch) => {
  stubSmoke({ ...SETUP_MANIFEST, client: 'codex', ...patch });
  await expect(smoke()).rejects.toThrow('smoke setup');
});
