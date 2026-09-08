import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { parseMemoryString } from '@/lib/markdown/frontmatter';
import type { Memory } from '@/lib/memory/types';

export function atomicWriteText(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw error;
  }
}

export function readMemoryFile(path: string): Memory {
  return parseMemoryString(readFileSync(path, 'utf8'));
}

export function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
