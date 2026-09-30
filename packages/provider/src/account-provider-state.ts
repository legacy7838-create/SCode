import type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * Why an account is unavailable; it only answers "why is it unavailable".
 *
 * After the provider-refactor the UI can only see availability=unavailable + entitled=false, which flattens "not signed in", "not connected",
 * "credential retrieval/validation failed" and "the server explicitly states there is no entitlement for that plan" into one and the same thing, so
 * a user who is signed in but has no plan gets displayed as "not connected". The reason has to ship together with the State so the UI does not have to
 * guess it with a second request (an unavailable provider never issues an entitlement query again).
 */
export type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * Live account facts, not a config Overlay and never written to user settings.
 * current means it matches the current account access context: Start may be true at the same time as the currently paid plan; Off-Peak is undefined.
 */
export interface AccountProviderState {
  readonly availability: "available" | "pending" | "unavailable" | "unknown";
  readonly entitled: boolean;
  /** Only meaningful when availability === "unavailable"; unknown means the reason could not be determined in this round. */
  readonly unavailableReason?: AccountProviderUnavailableReason;
  readonly current?: boolean;
  /** The account/connection identity of the same snapshot, used only to isolate state changes; not persisted and never containing credentials. */
  readonly connectionKey?: string;
  /** Unix seconds; the same unit as billing effective_at. */
  readonly effectiveAt?: number;
}

export type AccountProviderStates = Readonly<Record<string, AccountProviderState>>;
