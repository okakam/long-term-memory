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

  const membershipMismatches: string[] = [];
  const mapUid = (uid: string) => input.firebaseUidMap?.[uid] ?? uid;
  for (const project of manifest.auth.projects) {
    const target = await input.firestore.metadata.getProject(project.project_id);
    if (!target || target.owner_user_id !== mapUid(project.owner_user_id)) membershipMismatches.push(`${project.project_id}:owner`);
    for (const member of manifest.auth.members.filter((item) => item.project_id === project.project_id)) {
      const targetMember = await input.firestore.metadata.getMembership(project.project_id, mapUid(member.user_id));
      if (!targetMember || targetMember.role !== member.role) membershipMismatches.push(`${project.project_id}:member:${member.user_id}`);
    }
  }
  const patMismatches: string[] = [];
  for (const token of manifest.auth.tokens) {
    const target = await input.firestore.metadata.findTokenByHash(token.token_hash);
    if (!target || target.id !== token.id) patMismatches.push(token.id);
  }

  return {
    source_count: expected.size,
    target_count: targetKeys.size,
    missing_keys: missingKeys.sort(),
    extra_keys: extraKeys.sort(),
    hash_mismatches: hashMismatches.sort(),
    parse_failures: parseFailures.sort(),
    membership_mismatches: membershipMismatches.sort(),
    pat_mismatches: patMismatches.sort(),
    tombstone_mismatches: [],
    ok: missingKeys.length === 0 && extraKeys.length === 0 && hashMismatches.length === 0
      && parseFailures.length === 0 && membershipMismatches.length === 0 && patMismatches.length === 0,
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
