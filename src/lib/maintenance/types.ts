import { z } from 'zod';

export const ReviewDaysSchema = z.object({
  project: z.number().int().min(1).max(3650),
  reference: z.number().int().min(1).max(3650),
  user: z.number().int().min(1).max(3650),
  feedback: z.number().int().min(1).max(3650),
});

export const MaintenanceSettingsSchema = z.object({
  enabled: z.boolean(),
  review_days: ReviewDaysSchema,
  session_archive_days: z.number().int().min(1).max(3650),
  version: z.number().int().nonnegative(),
});

export type ReviewDays = z.infer<typeof ReviewDaysSchema>;
export type MaintenanceSettings = z.infer<typeof MaintenanceSettingsSchema>;
