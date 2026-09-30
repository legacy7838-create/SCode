import { z } from "zod";

// The reason is sent with the Account State and must be shared with the strict protocol enumeration to avoid rejection of the entire snapshot.
// credential-failed means that the credential acquisition/verification failed, and it cannot be concluded that OAuth has expired.
export const accountProviderUnavailableReasonSchema = z.enum([
  "not-authenticated",
  "not-connected",
  "credential-failed",
  "not-entitled",
]);
export type AccountProviderUnavailableReason = z.infer<
  typeof accountProviderUnavailableReasonSchema
>;
