import type {
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
  OnboardingDecision,
} from "@zcode/shared";
import { ServiceChannels, type AppSettings } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Range of settings fields back-filled from the record when the login state changes (settings remains the single source of truth at runtime). */
export interface OnboardingSettingsSyncPatch {
  onboardingOccupation?: AppSettingsPatchOccupation;
  proactiveSuggestionsEnabled?: boolean;
  memoryEnabled?: boolean;
}

type AppSettingsPatchOccupation = NonNullable<AppSettings["onboardingOccupation"]>;

export interface IOnboardingRecordService {
  /**
   * Appends one onboarding-completion record. Creates the file and pins deviceMid when it does
   * not exist (the in-file value is authoritative from then on); userId is filled in by the
   * service from the current login state and is not passed by the caller.
   */
  appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void>;
  /** Trigger decision: true when the current user (logged in → userId; apikey/not logged in → null) has no matching record or the file does not exist. */
  shouldOnboard(deviceMid: string): Promise<boolean>;
  /** Persists dismissed when the user closes the first-run onboarding; a no-op when an answer already exists. */
  dismissOnboarding(deviceMid: string): Promise<void>;
  /**
   * Login claiming: when the current userId has no entry but an anonymous (null) entry exists,
   * the null entry is handed over to that userId (rewritten rather than copied, so a single
   * onboarding action cannot produce two entries and pollute the upload statistics). The same
   * person going "answer once while logged out → log in" is no longer treated as a new user
   * and onboarded twice; the anonymous state triggering onboarding again after losing its
   * record is expected.
   * It is an idempotent no-op when logged out (userId=null) or an entry already exists.
   */
  claimAnonymousRecord(): Promise<void>;
  /** The current user's most recent answer (used to prefill when onboarding reopens); null when there is no record. */
  getLatestEntry(): Promise<OnboardingRecordEntry | null>;
  /**
   * Syncs the current user's most recent answer from the record back into settings (switching
   * accounts restores that user's occupation/preferences, and the recommendation area content
   * switches with it). Fields recorded as null on the skip page are back-filled with
   * conservative defaults (occupation other, preferences off), matching the onboarding skip
   * behaviour; settings are left untouched when the user has no record.
   */
  syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null>;
  /**
   * Writes preferences back into the record after the user edits them manually (the record
   * keeps "this user's latest preferences", consistent with the manual entry point in settings,
   * so switching accounts and syncing cannot resurrect a switch that was turned off). Ignored
   * when the current user has no entry.
   */
  updateRecordPreferences(
    patch: Partial<
      Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
    >,
  ): Promise<void>;
  /** Reads the whole record file (for later upload to the server); null when the file does not exist. */
  getRecords(): Promise<OnboardingRecordFile | null>;
  /** Deletes the record file (for debugging). */
  clearRecords(): Promise<void>;
}

/** Factory input: injected userId resolution (oauthCredentialRepo in production wiring, a stub in tests). */
export interface CreateOnboardingRecordServiceOptions {
  loadUserId: () => Promise<string | null>;
  hasExistingLocalTask: () => Promise<boolean>;
}

export type OnboardingRecordServiceFactory = (
  options: CreateOnboardingRecordServiceOptions,
) => IOnboardingRecordService;

export const IOnboardingRecordService = createServiceDescriptor<IOnboardingRecordService>(
  ServiceChannels.OnboardingRecord,
);

export type {
  OnboardingDecision,
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
};
