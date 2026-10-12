import type { Memory, MemoryType } from '@/lib/memory/types';
import { MaintenanceSettingsSchema, type MaintenanceSettings } from '@/lib/maintenance/types';

export const DEFAULT_MAINTENANCE_SETTINGS: MaintenanceSettings = {
  enabled: false,
  review_days: { project: 90, reference: 180, user: 365, feedback: 365 },
  session_archive_days: 90,
  version: 0,
};

export const RETRY_REVIEW_DAYS = 7;
export const MISSING_LINK_GRACE_DAYS = 30;

function addUtcDays(anchor: string, days: number): string {
  const timestamp = Date.parse(anchor);
  if (!Number.isFinite(timestamp)) throw new Error('review anchor must be a valid timestamp');
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function retryReviewAt(anchor: string): string {
  return addUtcDays(anchor, RETRY_REVIEW_DAYS);
}

export function reviewSchedule(
  type: MemoryType,
  anchor: string,
  settingsInput: MaintenanceSettings,
): { last_reviewed_at: string; next_review_at: string } {
  const settings = MaintenanceSettingsSchema.parse(settingsInput);
  const normalizedAnchor = new Date(anchor);
  if (Number.isNaN(normalizedAnchor.getTime())) throw new Error('review anchor must be a valid timestamp');
  const lastReviewedAt = normalizedAnchor.toISOString();
  const days = type === 'session' ? settings.session_archive_days : settings.review_days[type];
  return { last_reviewed_at: lastReviewedAt, next_review_at: addUtcDays(lastReviewedAt, days) };
}

export function deriveLegacyReview(memory: Memory, settingsInput: MaintenanceSettings): string {
  const settings = MaintenanceSettingsSchema.parse(settingsInput);
  if (memory.type === 'session') {
    return addUtcDays(memory.created_at, settings.session_archive_days);
  }
  if (memory.next_review_at) return memory.next_review_at;
  return addUtcDays(memory.updated_at, settings.review_days[memory.type]);
}
