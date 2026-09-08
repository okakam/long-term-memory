const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SHARED_PROJECT_ID = '__shared__';

export class SlugError extends Error {
  constructor(public readonly field: string, public readonly value: unknown) {
    super(`invalid ${field}: ${String(value)} (expected lowercase a-z, 0-9, hyphen-separated, 1..64 chars)`);
    this.name = 'SlugError';
  }
}

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && SLUG_RE.test(value);
}

export function isReservedProjectId(value: unknown): value is typeof SHARED_PROJECT_ID {
  return value === SHARED_PROJECT_ID;
}

export function assertProjectId(value: unknown): string {
  if (!isValidSlug(value) && !isReservedProjectId(value)) throw new SlugError('project_id', value);
  return value;
}

export function assertMemoryName(value: unknown): string {
  if (!isValidSlug(value)) throw new SlugError('memory name', value);
  return value;
}
