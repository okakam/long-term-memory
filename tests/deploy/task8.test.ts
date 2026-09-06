import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

import nextConfig from '../../next.config';

const root = resolve(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

test('Docker配布設定は本番Node runtimeと明示的schemaを含む', () => {
  const dockerfile = read('Dockerfile');
  expect(dockerfile).toContain('ARG NODE_IMAGE=node:22-bookworm-slim');
  expect(dockerfile).toContain('pnpm install --frozen-lockfile');
  expect(dockerfile).toContain('COPY --from=builder  /app/src/lib/db/schema.sql ./src/lib/db/schema.sql');
  expect(dockerfile).toContain('EXPOSE 3939');
  const compose = read('docker-compose.yml');
  expect(compose).toContain('create_host_path: false');
  expect(compose).toContain('target: /data');
  expect(compose).toContain('3939:3939');
});

test('Vercel環境変数サンプルは必須キーを網羅し秘密値を含まない', () => {
  const env = read('.env.example');
  for (const name of [
    'LTM_STORAGE_DRIVER',
    'TURSO_DATABASE_URL',
    'TURSO_AUTH_DATABASE_URL',
    'TURSO_TELEMETRY_DATABASE_URL',
    'BLOB_READ_WRITE_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'LTM_MAINTENANCE_TOKEN',
    'LTM_CURATOR_USER_ID',
    'LTM_BOOTSTRAP_OWNER_USER_ID',
    'LTM_BLOB_PREFIX',
    'MCP_PUBLIC_URL',
    'MCP_ALLOWED_ORIGINS',
    'AUTH_REQUIRED',
    'CLERK_SECRET_KEY',
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_CLERK_SIGN_IN_URL',
    'NEXT_PUBLIC_CLERK_SIGN_UP_URL',
  ]) {
    expect(env).toMatch(new RegExp('^' + name + '=', 'm'));
  }
  expect(env).not.toMatch(/^(?:TURSO|BLOB|UPSTASH|CLERK_SECRET_KEY|LTM_MAINTENANCE_TOKEN).*=[^\s]+/m);
});

test('Vercel設定とNext security headersを固定する', async () => {
  const vercel = JSON.parse(read('vercel.json')) as {
    installCommand: string;
    buildCommand: string;
    functions?: Record<string, { maxDuration?: number }>;
  };
  expect(vercel.installCommand).toBe('pnpm install --frozen-lockfile');
  expect(vercel.buildCommand).toBe('pnpm build');
  expect(vercel.functions?.['src/app/api/mcp/route.ts']?.maxDuration).toBe(60);

  const headerGroups = await nextConfig.headers?.() ?? [];
  const headers = new Map(headerGroups.flatMap((group) => group.headers.map((header) => [header.key, header.value])));
  expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
});

test('CIは通常検証・migration preflight・固定Vercel CLI smokeを定義する', () => {
  const testWorkflow = read('.github/workflows/test.yml');
  expect(testWorkflow).toContain('version: 11.1.3');
  expect(testWorkflow).toContain('pnpm test');
  expect(testWorkflow).toContain('pnpm lint');
  expect(testWorkflow).toContain('NODE_ENV=production pnpm build');
  expect(testWorkflow).toContain('scripts/preflight-migration.ts');
  expect(testWorkflow).toContain('scripts/probe-turso.ts');

  const vercelWorkflow = read('.github/workflows/vercel.yml');
  expect(vercelWorkflow).toContain('version: 11.1.3');
  expect(vercelWorkflow).toContain('vercel@41.7.3');
  expect(vercelWorkflow).toContain('vercel@41.7.3 pull --yes');
  expect(vercelWorkflow).toContain('vercel@41.7.3 build');
  expect(vercelWorkflow).toContain('vercel@41.7.3 deploy --prebuilt');
  expect(vercelWorkflow).toContain('scripts/vercel-smoke.ts');
});

test('deploy smokeと運用手順をリポジトリ内に用意する', () => {
  expect(existsSync(resolve(root, 'scripts/vercel-smoke.ts'))).toBe(true);
  expect(existsSync(resolve(root, 'docs/vercel-operations.md'))).toBe(true);
  expect(read('scripts/vercel-smoke.ts')).toContain('tools/list');
  expect(read('docs/vercel-operations.md')).toContain('vercel@41.7.3 rollback');
});
