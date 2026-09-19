import { createClient } from '@libsql/client';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { computeHash } from '@/lib/markdown/file-io';
import { assertMemoryName, assertProjectId } from '@/lib/slug';
import type { IndexStore, MarkdownStore } from '@/lib/storage/contracts';
import { TursoIndexStore } from '@/lib/storage/turso-index';
import type { MemberRecord, ProjectRecord, TokenRecord } from '@/lib/auth/store';
import { createLegacyVercelBlobStore } from './legacy-vercel-blob';

interface MemoryRow {
  id: string;
  project_id: string;
  name: string;
  file_path: string;
  content_hash: string;
}

export interface ExportMemoryRecord {
  id: string;
  name: string;
  key: string;
  content_hash: string;
  local_path: string;
}

export interface MigrationManifest {
  generated_at: string;
  source: 'vercel';
  projects: Array<{
    project_id: string;
    memories: ExportMemoryRecord[];
  }>;
  auth: {
    projects: ProjectRecord[];
    members: MemberRecord[];
    tokens: TokenRecord[];
  };
}

export interface ExportVercelOptions {
  outputDir: string;
  blobToken: string;
  memoryDbUrl: string;
  memoryDbToken: string;
  authDbUrl: string;
  authDbToken: string;
  markdownStore?: MarkdownStore;
  memoryDb?: IndexStore;
  authDb?: IndexStore;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function openLegacyDb(url: string, authToken: string): { store: IndexStore; close: () => void } {
  const client = createClient({ url, authToken });
  const store = new TursoIndexStore(client, client);
  return { store, close: () => store.close() };
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function secureWrite(path: string, contents: string): void {
  secureDirectory(dirname(path));
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function tokenRows(rows: TokenRecord[]): TokenRecord[] {
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    token_prefix: row.token_prefix,
    label: row.label,
    audience: row.audience,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  }));
}

export async function exportVercelData(options: ExportVercelOptions): Promise<MigrationManifest> {
  const outputDir = resolve(options.outputDir);
  secureDirectory(outputDir);

    const markdown = options.markdownStore ?? createLegacyVercelBlobStore(options.blobToken);
  const memoryConnection = options.memoryDb ? null : openLegacyDb(options.memoryDbUrl, options.memoryDbToken);
  const authConnection = options.authDb ? null : openLegacyDb(options.authDbUrl, options.authDbToken);
  const memoryDb = options.memoryDb ?? memoryConnection!.store;
  const authDb = options.authDb ?? authConnection!.store;

  try {
    const [memoryRows, projects, members, tokens] = await Promise.all([
      memoryDb.query<MemoryRow>(
        'SELECT id, project_id, name, file_path, content_hash FROM memories ORDER BY project_id, name',
      ),
      authDb.query<ProjectRecord>(
        'SELECT project_id, owner_user_id, created_at, updated_at FROM projects ORDER BY project_id',
      ),
      authDb.query<MemberRecord>(
        'SELECT project_id, user_id, role FROM project_members ORDER BY project_id, user_id',
      ),
      authDb.query<TokenRecord>(
        'SELECT id, user_id, token_hash, token_prefix, label, audience, created_at, last_used_at, expires_at, revoked_at ' +
        'FROM mcp_tokens ORDER BY created_at, id',
      ),
    ]);

    const projectMap = new Map<string, ExportMemoryRecord[]>();
    for (const project of projects) projectMap.set(project.project_id, []);

    for (const row of memoryRows) {
      const raw = await markdown.read(row.file_path);
      const contentHash = computeHash(raw);
      if (contentHash !== row.content_hash) {
        throw new Error(`memory content hash mismatch: ${row.project_id}/${row.name}`);
      }

      const projectId = assertProjectId(row.project_id);
      const name = assertMemoryName(row.name);
      const localPath = join(outputDir, 'markdown', projectId, name, `${contentHash}.md`);
      secureWrite(localPath, raw);
      const memories = projectMap.get(projectId) ?? [];
      memories.push({
        id: row.id,
        name,
        key: row.file_path,
        content_hash: contentHash,
        local_path: localPath,
      });
      projectMap.set(projectId, memories);
    }

    const manifest: MigrationManifest = {
      generated_at: new Date().toISOString(),
      source: 'vercel',
      projects: [...projectMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([project_id, memories]) => ({
        project_id,
        memories: memories.sort((left, right) => left.name.localeCompare(right.name)),
      })),
      auth: { projects, members, tokens: tokenRows(tokens) },
    };
    secureWrite(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    memoryConnection?.close();
    authConnection?.close();
  }
}

async function main(): Promise<void> {
  const manifest = await exportVercelData({
    outputDir: requiredEnv('MIGRATION_OUTPUT_DIR'),
    blobToken: requiredEnv('BLOB_READ_WRITE_TOKEN'),
    memoryDbUrl: requiredEnv('TURSO_DATABASE_URL'),
    memoryDbToken: requiredEnv('TURSO_AUTH_TOKEN'),
    authDbUrl: requiredEnv('TURSO_AUTH_DATABASE_URL'),
    authDbToken: requiredEnv('TURSO_AUTH_DATABASE_TOKEN'),
  });
  console.log(`Exported ${manifest.projects.reduce((sum, project) => sum + project.memories.length, 0)} memories`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Vercel export failed');
    process.exitCode = 1;
  });
}
