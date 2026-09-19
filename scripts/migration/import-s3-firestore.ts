import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { computeHash } from '@/lib/markdown/file-io';
import { parseMemoryString } from '@/lib/markdown/frontmatter';
import type { MarkdownStore } from '@/lib/storage/contracts';
import { createMarkdownStore } from '@/lib/storage/factory';
import { memoryObjectKey, s3StoragePrefix } from '@/lib/storage/s3-markdown';
import { createFirestoreMetadataStore, type FirestoreMetadataStore } from '@/lib/storage/firestore-metadata';
import type { MemberRecord, ProjectRecord, TokenRecord } from '@/lib/auth/store';
import type { MigrationManifest } from './export-vercel';

export interface MigrationS3Target {
  markdown: MarkdownStore;
  prefix?: string;
}

export interface MigrationFirestoreTarget {
  metadata: FirestoreMetadataStore;
}

export interface ImportReport {
  projects: number;
  members: number;
  tokens: number;
  memories: number;
  objects: number;
}

export interface ImportMigrationInput {
  manifestPath: string;
  s3: MigrationS3Target;
  firestore: MigrationFirestoreTarget;
  firebaseUidMap: Record<string, string>;
}

function readManifest(path: string): MigrationManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as MigrationManifest;
  if (manifest.source !== 'vercel' || !Array.isArray(manifest.projects)) throw new Error('invalid migration manifest');
  return manifest;
}

function mappedUid(uid: string, map: Record<string, string>): string {
  const mapped = map[uid];
  if (!mapped) throw new Error(`Firebase UID mapping is missing: ${uid}`);
  return mapped;
}

function targetKey(prefix: string, projectId: string, name: string, contentHash: string): string {
  return memoryObjectKey(prefix, projectId, name, contentHash);
}

async function importProject(
  project: ProjectRecord,
  members: MemberRecord[],
  tokens: TokenRecord[],
  metadata: FirestoreMetadataStore,
  uidMap: Record<string, string>,
): Promise<{ members: number; tokens: number }> {
  const owner = mappedUid(project.owner_user_id, uidMap);
  const existing = await metadata.getProject(project.project_id);
  if (!existing) await metadata.createProject(project.project_id, owner, project.created_at);
  else if (existing.owner_user_id !== owner) throw new Error(`project owner mismatch: ${project.project_id}`);

  let importedMembers = 0;
  for (const member of members.filter((item) => item.project_id === project.project_id)) {
    const userId = mappedUid(member.user_id, uidMap);
    const current = await metadata.getMembership(project.project_id, userId);
    if (!current) await metadata.addMember(project.project_id, userId, member.role);
    else if (current.role !== member.role) await metadata.setMemberRole(project.project_id, userId, member.role);
    importedMembers += 1;
  }

  let importedTokens = 0;
  for (const token of tokens) {
    const userId = mappedUid(token.user_id, uidMap);
    if (await metadata.findTokenByHash(token.token_hash)) continue;
    await metadata.insertToken({ ...token, user_id: userId });
    importedTokens += 1;
  }
  return { members: importedMembers, tokens: importedTokens };
}

export async function importMigration(input: ImportMigrationInput): Promise<ImportReport> {
  const manifest = readManifest(input.manifestPath);
  const prefix = input.s3.prefix ?? s3StoragePrefix();
  const members = manifest.auth.members;
  let report: ImportReport = { projects: 0, members: 0, tokens: 0, memories: 0, objects: 0 };

  for (const project of manifest.auth.projects) {
    const imported = await importProject(project, members, manifest.auth.tokens, input.firestore.metadata, input.firebaseUidMap);
    report = { ...report, projects: report.projects + 1, members: report.members + imported.members, tokens: report.tokens + imported.tokens };
  }

  for (const project of manifest.projects) {
    for (const memory of project.memories) {
      const raw = readFileSync(memory.local_path, 'utf8');
      if (computeHash(raw) !== memory.content_hash) throw new Error(`source content hash mismatch: ${project.project_id}/${memory.name}`);
      const parsed = parseMemoryString(raw);
      if (parsed.id !== memory.id || parsed.name !== memory.name) throw new Error(`source memory metadata mismatch: ${project.project_id}/${memory.name}`);
      const key = targetKey(prefix, project.project_id, memory.name, memory.content_hash);
      await input.s3.markdown.write(key, raw, { overwrite: true, contentHash: memory.content_hash });
      await input.firestore.metadata.putMemoryIndex(project.project_id, {
        id: parsed.id,
        project_id: project.project_id,
        name: parsed.name,
        type: parsed.type,
        description: parsed.description,
        body_chars: parsed.body.length,
        content_key: key,
        content_hash: memory.content_hash,
        tags: parsed.tags,
        links: parsed.links,
        supersedes: parsed.supersedes,
        entities: parsed.entities,
        triples: parsed.triples,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
      });
      report = { ...report, memories: report.memories + 1, objects: report.objects + 1 };
    }
  }
  return report;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const uidMap = JSON.parse(readFileSync(requiredEnv('FIREBASE_UID_MAP'), 'utf8')) as Record<string, string>;
  const report = await importMigration({
    manifestPath: requiredEnv('MIGRATION_MANIFEST'),
    s3: { markdown: createMarkdownStore({ mode: 'cloud' }), prefix: s3StoragePrefix() },
    firestore: { metadata: createFirestoreMetadataStore() },
    firebaseUidMap: uidMap,
  });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'migration import failed');
    process.exitCode = 1;
  });
}
