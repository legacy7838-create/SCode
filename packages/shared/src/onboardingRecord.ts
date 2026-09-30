import { z } from "zod";

/**
 * Onboarding completion record (three-step wizard: occupation / mode / preferences).
 *
 * Design constraints:
 * - Standalone local JSON (~/.zcode/v2/onboarding-record.json), never mixed into AppSettings;
 * - deviceMid is the device anchor; entries support several userId (multiple people signed in) as well as null (apikey / signed out);
 * - uploadState reserves room for a later server upload: pending → uploaded;
 * - Skipping is an explicit answer: when a page is skipped its field is recorded as null, which is distinct from "a value was explicitly chosen".
 */

/** occupation is a non-empty string rather than an enum: the occupation list keeps evolving, and old records must not fail validation just because the enum narrowed. */
export const onboardingOccupationSchema = z.string().min(1).nullable();

export const onboardingInterfaceModeSchema = z.enum(["coding", "office"]).nullable();

export const onboardingRecordEntrySchema = z.object({
  userId: z.string().min(1).nullable(),
  occupation: onboardingOccupationSchema,
  interfaceMode: onboardingInterfaceModeSchema,
  memoryEnabled: z.boolean().nullable(),
  proactiveSuggestionsEnabled: z.boolean().nullable(),
  completedAt: z.string().min(1),
  uploadState: z.literal("pending"),
});

export const onboardingDecisionSchema = z.object({
  userId: z.string().min(1).nullable(),
  status: z.enum(["dismissed", "existing_local_user"]),
  reason: z.enum(["user_closed", "existing_local_task"]),
  decidedAt: z.string().min(1),
});

const onboardingRecordFileV1Schema = z.object({
  version: z.literal(1),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
});

const onboardingRecordFileV2Schema = z.object({
  version: z.literal(2),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
  decisions: z.array(onboardingDecisionSchema),
});

/** v1 needs no startup migration; reads backfill an empty decisions array, and the next business write naturally lands as v2. */
export const onboardingRecordFileSchema = z
  .union([onboardingRecordFileV1Schema, onboardingRecordFileV2Schema])
  .transform((file) =>
    file.version === 1 ? { ...file, version: 2 as const, decisions: [] } : file,
  );

export type OnboardingRecordEntry = z.infer<typeof onboardingRecordEntrySchema>;
export type OnboardingDecision = z.infer<typeof onboardingDecisionSchema>;

/** appendRecord's input: the server (host) fills in userId, callers do not pass it. */
export type OnboardingRecordEntryInput = Omit<OnboardingRecordEntry, "userId" | "uploadState">;

export type OnboardingRecordFile = z.infer<typeof onboardingRecordFileSchema>;
