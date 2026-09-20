import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { atomicWriteText } from '@/lib/markdown/file-io';
import { resolveStorage } from '@/lib/paths';
import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';

function validateRelativePath(value: string, allowEmpty = false): void {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new Error(`unsafe storage key: ${value}`);
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error(`unsafe storage key: ${value}`);
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export class FsMarkdownStore implements MarkdownStore {
  readonly root: string;

  constructor(root = resolveStorage().home) {
    this.root = resolve(root);
  }

  private pathFor(key: string, allowEmpty = false): string {
    validateRelativePath(key, allowEmpty);
    const path = resolve(this.root, key || '.');
    const relativePath = relative(this.root, path);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`unsafe storage key: ${key}`);
    }
    return path;
  }

  async read(key: string): Promise<string> {
    return readFileSync(this.pathFor(key), 'utf8');
  }

  async write(key: string, text: string, opts?: { overwrite?: boolean }): Promise<StoredObject> {
    const path = this.pathFor(key);
    if (opts?.overwrite === false && existsSync(path)) throw new Error(`storage object already exists: ${key}`);
    atomicWriteText(path, text);
    const stat = statSync(path);
    return { key, size: stat.size, updatedAt: stat.mtime };
  }

  async remove(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) unlinkSync(path);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const prefixPath = this.pathFor(prefix, true);
    const candidates = existsSync(prefixPath) && statSync(prefixPath).isFile()
      ? [prefixPath]
      : filesUnder(prefixPath);
    return candidates
      .map((path) => {
        const stat = statSync(path);
        return { key: relative(this.root, path).split(sep).join('/'), size: stat.size, updatedAt: stat.mtime };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}

export function createFsMarkdownStore(root?: string): FsMarkdownStore {
  return new FsMarkdownStore(root);
}
