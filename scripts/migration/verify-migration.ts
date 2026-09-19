import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { computeHash } from '@/lib/markdown/file-io';
import { parseMemoryString } from '@/lib/markdown/frontmatter';
import type { MarkdownStore } from '@/lib/storage/contracts';
import { createMarkdownStore } from '@/lib/storage/factory';
import { memoryObjectKey, s3StoragePrefix } from '@/lib/storage/s3-markdown';
import { createFirestoreMetadataStore, type FirestoreMetadataStore } from '@/lib/storage/firestore-metadata';
import type { MigrationManifest } from './export-vercel';

export interface VerificationReport {
  source_count: number;
  target_count: number;
  missing_keys: string[];
  extra_keys: string[];
  hash_mismatches: string[];
  parse_failures: string[];
  membership_mismatches: string[];
  memory_mismatches: string[];
  name_index_mismatches: string[];
  pat_mismatches: string[];
  tombstone_mismatches: string[];
  ok: boolean;
}

export interface VerifyMigrationInput {
  manifestPath: string;
  s3: { markdown: MarkdownStore; prefix?: string };
  firestore: { metadata: FirestoreMetadataStore };
  firebaseUidMap?: Record<string, string>;
}

function readManifest(path: string): MigrationManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as MigrationManifest;
  if (manifest.source !== 'vercel' || !Array.isArray(manifest.projects)) throw new Error('invalid migration manifest');
  return manifest;
}

export async function verifyMigration(input: VerifyMigrationInput): Promise<VerificationReport> {
  const manifest = readManifest(input.manifestPath);
  const prefix = input.s3.prefix ?? s3StoragePrefix();
  const expected = new Map<string, { projectId: string; id: string; hash: string; name: string }>();
  for (const project of manifest.projects) {
    for (const memory of project.memories) {
      expected.set(memoryObjectKey(prefix, project.project_id, memory.name, memory.content_hash), {
        projectId: project.project_id, id: memory.id, hash: memory.content_hash, name: memory.name,
      });
    }
  }

  const missingKeys: string[] = [];
  const extraKeys: string[] = [];
  const hashMismatches: string[] = [];
  const parseFailures: string[] = [];
  const targetKeys = new Set((await input.s3.markdown.list(prefix + '/')).map((object) => object.key));
  for (const [key, record] of expected) {
    if (!targetKeys.has(key)) {
      missingKeys.push(key);
      continue;
    }
    try {
      const raw = await input.s3.markdown.read(key);
      if (computeHash(raw) !== record.hash) hashMismatches.push(key);
      const memory = parseMemoryString(raw);
      if (memory.id !== record.id || memory.name !== record.name) parseFailures.push(key);
    } catch {
      parseFailures.push(key);
    }
  }
  for (const key of targetKeys) if (!expected.has(key)) extraKeys.push(key);

  const memoryMismatches: string[] = [];
  const nameIndexMismatches: string[] = [];
  for (const project of manifest.projects) {
    const targetRecords = await input.firestore.metadata.listMemoryIndexes(project.project_id);
    const targetById = new Map(targetRecords.map((record) => [record.id, record]));
    const targetNames = await input.firestore.metadata.listNameIndexes(project.project_id);
    const targetNameByName = new Map(targetNames.map((record) => [record.name, record]));
    const expectedIds = new Set<string>();
    const expectedNames = new Set<string>();
    for (const memory of project.memories) {
      expectedIds.add(memory.id);
      expectedNames.add(memory.name);
      const expectedKey = memoryObjectKey(prefix, project.project_id, memory.name, memory.content_hash);
      const target = targetById.get(memory.id);
      if (!target) {
        memoryMismatches.push(`${project.project_id}/${memory.name}:missing`);
        continue;
      }
      if (target.project_id !== project.project_id || target.name !== memory.name
        || target.content_key !== expectedKey || target.content_hash !== memory.content_hash) {
        memoryMismatches.push(`${project.project_id}/${memory.name}:metadata`);
      }
      const targetName = targetNameByName.get(memory.name);
      if (!targetName) {
        nameIndexMismatches.push(`${project.project_id}/${memory.name}:missing`);
      } else if (targetName.memory_id !== memory.id
        || targetName.name !== memory.name
        || targetName.content_key !== expectedKey
        || targetName.content_hash !== memory.content_hash) {
        nameIndexMismatches.push(`${project.project_id}/${memory.name}:metadata`);
      }
    }
    for (const target of targetRecords) {
      if (!expectedIds.has(target.id)) memoryMismatches.push(`${project.project_id}/${target.name}:extra`);
    }
    for (const target of targetNames) {
      if (!expectedNames.has(target.name)) nameIndexMismatches.push(`${project.project_id}/${target.name}:extra`);
    }
  }

  const membershipMismatches: string[] = [];
  const mapUid = (uid: string) => input.firebaseUidMap?.[uid] ?? uid;
  const expectedProjectIds = new Set(manifest.auth.projects.map((project) => project.project_id));
  for (const project of await input.firestore.metadata.listProjects()) {
    if (!expectedProjectIds.has(project.project_id)) membershipMismatches.push(`${project.project_id}:project:extra`);
  }
  for (const project of manifest.auth.projects) {
    const target = await input.firestore.metadata.getProject(project.project_id);
    if (!target || target.owner_user_id !== mapUid(project.owner_user_id)) membershipMismatches.push(`${project.project_id}:owner`);
    const expectedMembers = manifest.auth.members.filter((item) => item.project_id === project.project_id);
    const targetMembers = await input.firestore.metadata.listMembers(project.project_id);
    const targetMembersByUser = new Map(targetMembers.map((member) => [member.user_id, member]));
    for (const member of expectedMembers) {
      const targetMember = targetMembersByUser.get(mapUid(member.user_id));
      if (!targetMember || targetMember.role !== member.role) membershipMismatches.push(`${project.project_id}:member:${member.user_id}`);
    }
    const expectedMemberIds = new Set(expectedMembers.map((member) => mapUid(member.user_id)));
    for (const member of targetMembers) {
      if (!expectedMemberIds.has(member.user_id)) membershipMismatches.push(`${project.project_id}:member:${member.user_id}:extra`);
    }
  }
  const patMismatches: string[] = [];
  const expectedTokenIds = new Set(manifest.auth.tokens.map((token) => token.id));
  for (const token of manifest.auth.tokens) {
    const target = await input.firestore.metadata.findTokenByHash(token.token_hash);
    if (!target || target.id !== token.id || target.user_id !== mapUid(token.user_id)) patMismatches.push(token.id);
  }
  for (const token of await input.firestore.metadata.listTokenHashes()) {
    if (!expectedTokenIds.has(token.id)) patMismatches.push(`${token.id}:extra`);
  }
  const tombstoneMismatches: string[] = [];
  const expectedTombstones = new Map(
    (manifest.tombstones ?? []).map((tombstone) => [`${tombstone.project_id}:${tombstone.content_key}`, tombstone]),
  );
  const tombstoneProjects = new Set([
    ...manifest.projects.map((project) => project.project_id),
    ...manifest.auth.projects.map((project) => project.project_id),
    ...(manifest.tombstones ?? []).map((tombstone) => tombstone.project_id),
  ]);
  const targetTombstones = new Map<string, Awaited<ReturnType<FirestoreMetadataStore['listTombstones']>>[number]>();
  for (const projectId of tombstoneProjects) {
    for (const tombstone of await input.firestore.metadata.listTombstones(projectId)) {
      targetTombstones.set(`${projectId}:${tombstone.content_key}`, tombstone);
    }
  }
  for (const [key, source] of expectedTombstones) {
    const target = targetTombstones.get(key);
    if (!target || target.memory_id !== source.memory_id || target.deleted_at !== source.deleted_at) tombstoneMismatches.push(key);
  }
  for (const key of targetTombstones.keys()) if (!expectedTombstones.has(key)) tombstoneMismatches.push(key);

  return {
    source_count: expected.size,
    target_count: targetKeys.size,
    missing_keys: missingKeys.sort(),
    extra_keys: extraKeys.sort(),
    hash_mismatches: hashMismatches.sort(),
    parse_failures: parseFailures.sort(),
    membership_mismatches: membershipMismatches.sort(),
    memory_mismatches: memoryMismatches.sort(),
    name_index_mismatches: nameIndexMismatches.sort(),
    pat_mismatches: patMismatches.sort(),
    tombstone_mismatches: tombstoneMismatches.sort(),
    ok: missingKeys.length === 0 && extraKeys.length === 0 && hashMismatches.length === 0
      && parseFailures.length === 0 && membershipMismatches.length === 0 && patMismatches.length === 0
      && memoryMismatches.length === 0 && nameIndexMismatches.length === 0 && tombstoneMismatches.length === 0,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const uidMap = process.env.FIREBASE_UID_MAP
    ? JSON.parse(readFileSync(process.env.FIREBASE_UID_MAP, 'utf8')) as Record<string, string>
    : undefined;
  const report = await verifyMigration({
    manifestPath: requiredEnv('MIGRATION_MANIFEST'),
    s3: { markdown: createMarkdownStore({ mode: 'cloud' }), prefix: s3StoragePrefix() },
    firestore: { metadata: createFirestoreMetadataStore() },
    firebaseUidMap: uidMap,
  });
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'migration verification failed');
    process.exitCode = 1;
  });
}
