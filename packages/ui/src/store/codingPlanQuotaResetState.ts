import type { BroadcastClaimLease, BroadcastMessage, IBroadcastService } from "@zcode/services";
import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";

export interface CodingPlanQuotaResetAutomaticObservation {
  completedAt: number;
  /**
   * The auth session counter incremented when the user goes from signed out to signed in within one
   * renderer lifetime.
   */
  authSessionSeq: number;
}

export interface CodingPlanQuotaResetAutomaticObservations {
  fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
  week: CodingPlanQuotaResetAutomaticObservation | null;
}

/**
 * Cross-window played records: source + type → the used_at whose completion toast has already
 * played in some window.
 */
export interface CodingPlanQuotaResetAutoPlayedSlot {
  fiveHour: number | null;
  week: number | null;
}

interface CodingPlanQuotaResetStoreState {
  authSessionSeq: number;
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
}

/**
 * The cross-window broadcast channel for "the completion toast plays only once across windows"
 * (state: prefix follows the cross-window state sync convention).
 */
const CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL = "state:codereset-autoplayed";

interface CodingPlanQuotaResetAutoPlayedBroadcastPayload {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}

function buildCodingPlanQuotaResetAutoPlayClaimKey(
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): string {
  return `coding-plan-reset-autoplay:${encodeURIComponent(sourceKey)}:${resetType}:${completedAt}`;
}

function parseCodingPlanQuotaResetAutoPlayedPayload(
  payload: unknown,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const sourceKey = typeof record.sourceKey === "string" ? record.sourceKey.trim() : "";
  const resetType =
    record.resetType === "WEEK" || record.resetType === "FIVE_HOUR" ? record.resetType : null;
  const completedAt =
    typeof record.completedAt === "number" && Number.isFinite(record.completedAt)
      ? record.completedAt
      : null;
  if (!sourceKey || !resetType || completedAt === null) {
    return null;
  }
  return { sourceKey, resetType, completedAt };
}

/**
 * Resolves the cross-window "completion already played" broadcast; messages from another channel,
 * local echoes, and invalid payloads all return null.
 *
 * The host's send first echoes the message locally to this window's renderer (with no
 * sourceWindowId); only cross-window messages relayed by the BroadcastHub carry a sourceWindowId,
 * so local echoes must be ignored, otherwise the "already played" this window just broadcast would
 * suppress its own animation on the spot.
 */
export function parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (message.channel !== CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL) {
    return null;
  }
  if (message.sourceWindowId === undefined) {
    return null;
  }
  return parseCodingPlanQuotaResetAutoPlayedPayload(message.payload);
}

/**
 * Broadcasts the used_at of a completion toast played for the first time in this window; other
 * windows suppress the toast for the same used_at on receipt.
 */
function broadcastCodingPlanQuotaResetAutoPlayed(
  broadcastService: Pick<IBroadcastService, "send">,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): void {
  void broadcastService.send({
    channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
    payload: { sourceKey, resetType, completedAt },
  });
}

interface CodingPlanQuotaResetStoreUpdate {
  patch: Pick<
    CodingPlanQuotaResetStoreState,
    | "codingPlanQuotaResetUiBySource"
    | "codingPlanQuotaResetAutomaticObservationsBySource"
    | "codingPlanQuotaResetAutoPlayedBySource"
  >;
}

/**
 * Atomically writes the reset UI state and the auth-session trace of completion, so that the entry
 * and the observation record never disagree across renders.
 *
 * Status observation and Composer playback eligibility must stay separate. The settings page /
 * Usage page also call this function, so writing played directly here would consume the
 * cross-window playback eligibility before any Tooltip/confetti was ever shown.
 */
function updateCodingPlanQuotaResetStoreState(
  state: CodingPlanQuotaResetStoreState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
  authSessionSeq: number,
): CodingPlanQuotaResetStoreUpdate {
  // The asynchronous status in the old authentication session may not be returned until you log out and the component is uninstalled.
  // Store must verify the sequence number at the atomic write point, and cannot only rely on refs in unloaded Hooks that will no longer be updated.
  if (state.authSessionSeq !== authSessionSeq) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextEntries = { ...state.codingPlanQuotaResetUiBySource };
  const current = nextEntries[sourceKey] ?? { fiveHour: null, week: null };
  const updated =
    resetType === "WEEK" ? { ...current, week: entry } : { ...current, fiveHour: entry };
  if (updated.fiveHour === null && updated.week === null) {
    delete nextEntries[sourceKey];
  } else {
    nextEntries[sourceKey] = updated;
  }

  const automaticCompletedAt =
    entry?.status === "completed" && entry.startedAt === null ? entry.completedAt : null;
  if (automaticCompletedAt === null) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const currentObservations = state.codingPlanQuotaResetAutomaticObservationsBySource[
    sourceKey
  ] ?? {
    fiveHour: null,
    week: null,
  };
  const previousObservation =
    resetType === "WEEK" ? currentObservations.week : currentObservations.fiveHour;
  // The observation record represents "the first time the authentication session for used_at was seen". The same history after logging in again
  // Reconciliation can only update the entry, and cannot rewrite the observation to the new session, otherwise the old animation will be played again in the next round.
  if (previousObservation?.completedAt === automaticCompletedAt) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextObservations = {
    ...state.codingPlanQuotaResetAutomaticObservationsBySource,
  };
  const observation = { completedAt: automaticCompletedAt, authSessionSeq };
  nextObservations[sourceKey] =
    resetType === "WEEK"
      ? { ...currentObservations, week: observation }
      : { ...currentObservations, fiveHour: observation };

  return {
    patch: {
      codingPlanQuotaResetUiBySource: nextEntries,
      codingPlanQuotaResetAutomaticObservationsBySource: nextObservations,
      codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
    },
  };
}

/**
 * Applies an "already played" broadcast from another window: merges the played record and clears
 * the observedAt of the same used_at completion currently playing in this window (collapsing the
 * Tooltip and preventing a later confetti catch-up).
 */
export function applyCodingPlanQuotaResetAutoPlayedBroadcast(
  state: Pick<
    CodingPlanQuotaResetStoreState,
    "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
  >,
  payload: CodingPlanQuotaResetAutoPlayedBroadcastPayload,
): Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
> {
  const playedBySource = { ...state.codingPlanQuotaResetAutoPlayedBySource };
  const slot = playedBySource[payload.sourceKey] ?? { fiveHour: null, week: null };
  const currentPlayed = payload.resetType === "WEEK" ? slot.week : slot.fiveHour;
  // Cross-window messages may arrive out of order. played is a monotonic cursor of "at least which used_at has been played",
  // If the old broadcast is late, the new record cannot be rolled back, otherwise the subsequent status will regard the broadcast as a candidate again.
  if (currentPlayed === null || payload.completedAt > currentPlayed) {
    playedBySource[payload.sourceKey] =
      payload.resetType === "WEEK"
        ? { ...slot, week: payload.completedAt }
        : { ...slot, fiveHour: payload.completedAt };
  }

  const entriesBySource = { ...state.codingPlanQuotaResetUiBySource };
  const entries = entriesBySource[payload.sourceKey];
  const key = payload.resetType === "WEEK" ? "week" : "fiveHour";
  const entry = entries?.[key];
  if (
    entry &&
    entry.status === "completed" &&
    entry.startedAt === null &&
    entry.completedAt === payload.completedAt &&
    entry.observedAt !== null
  ) {
    entriesBySource[payload.sourceKey] = {
      ...entries,
      [key]: { ...entry, observedAt: null },
    } as CodingPlanQuotaResetUiEntries;
  }

  return {
    codingPlanQuotaResetUiBySource: entriesBySource,
    codingPlanQuotaResetAutoPlayedBySource: playedBySource,
  };
}

type CodingPlanQuotaResetAutoPlayState = Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
>;

export interface CodingPlanQuotaResetAutoPlayReservation {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
  lease: BroadcastClaimLease;
}

export type CodingPlanQuotaResetAutoPlayReservationAttempt =
  | { status: "reserved"; reservation: CodingPlanQuotaResetAutoPlayReservation }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

function isCodingPlanQuotaResetAutoPlayCandidate(
  state: CodingPlanQuotaResetAutoPlayState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): boolean {
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const candidate = state.codingPlanQuotaResetUiBySource[sourceKey]?.[key];
  const played = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  return Boolean(
    candidate?.status === "completed" &&
    candidate.startedAt === null &&
    candidate.observedAt !== null &&
    candidate.completedAt === completedAt &&
    (played === null || played < completedAt),
  );
}

/**
 * The Composer requests a temporary reservation before playing a completion toast.
 *
 * The reservation and the played commit must be separate. While waiting on Main the component may
 * unmount or switch source; at this stage only a temporary lease carrying a token is taken, played
 * is not written, nothing is broadcast, and busy is not mistaken for already played.
 */
export async function reserveCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "acquireClaim" | "releaseClaim">;
  readState: () => CodingPlanQuotaResetAutoPlayState;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> {
  const { broadcastService, readState, writeState, sourceKey, resetType, completedAt } = params;
  const payload = { sourceKey, resetType, completedAt };
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const initialState = readState();
  const initialPlayed =
    initialState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  if (initialPlayed !== null && initialPlayed >= completedAt) {
    writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    return { status: "blocked" };
  }
  if (!isCodingPlanQuotaResetAutoPlayCandidate(initialState, sourceKey, resetType, completedAt)) {
    return { status: "blocked" };
  }

  let claimResult;
  try {
    claimResult = await broadcastService.acquireClaim(
      buildCodingPlanQuotaResetAutoPlayClaimKey(sourceKey, resetType, completedAt),
    );
  } catch {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "busy") {
    return { status: "retry", retryAfterMs: Math.max(50, claimResult.retryAfterMs) };
  }
  if (claimResult.status === "unavailable") {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "committed") {
    // committed only means that Main has a permanent claim; loser is still waiting for the real played broadcast/local cursor,
    // You cannot clear observedAt here, otherwise "occupied" will be mistaken for "played" again.
    return { status: "blocked" };
  }

  const latestState = readState();
  if (!isCodingPlanQuotaResetAutoPlayCandidate(latestState, sourceKey, resetType, completedAt)) {
    await broadcastService.releaseClaim(claimResult.lease);
    const latestPlayed =
      latestState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
    if (latestPlayed !== null && latestPlayed >= completedAt) {
      writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    }
    return { status: "blocked" };
  }

  return {
    status: "reserved",
    reservation: { sourceKey, resetType, completedAt, lease: claimResult.lease },
  };
}

/**
 * Commits the reservation once the component confirms it is still mounted, source/candidate match,
 * and it is about to be shown. This function writes the local played synchronously, then sends the
 * Main commit and the played broadcast; no unmount can interleave within a single JS task.
 */
export function commitCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "commitClaim" | "send">;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): boolean {
  const { broadcastService, writeState, reservation } = params;
  const { sourceKey, resetType, completedAt } = reservation;
  let committed = false;
  writeState((state) => {
    if (!isCodingPlanQuotaResetAutoPlayCandidate(state, sourceKey, resetType, completedAt)) {
      return state;
    }
    committed = true;
    const slots = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey] ?? {
      fiveHour: null,
      week: null,
    };
    return {
      codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
      codingPlanQuotaResetAutoPlayedBySource: {
        ...state.codingPlanQuotaResetAutoPlayedBySource,
        [sourceKey]:
          resetType === "WEEK"
            ? { ...slots, week: completedAt }
            : { ...slots, fiveHour: completedAt },
      },
    };
  });
  if (!committed) {
    return false;
  }

  void broadcastService.commitClaim(reservation.lease);
  broadcastCodingPlanQuotaResetAutoPlayed(broadcastService, sourceKey, resetType, completedAt);
  return true;
}

export async function releaseCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "releaseClaim">;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): Promise<void> {
  await params.broadcastService.releaseClaim(params.reservation.lease);
}

interface CodingPlanQuotaResetStoreActions {
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

type CodingPlanQuotaResetStoreWriter = (
  updater: (state: CodingPlanQuotaResetStoreState) => Partial<CodingPlanQuotaResetStoreState>,
) => void;

/** Keeps the reset-state actions in this domain file, so the global Store does not swell again. */
export function createCodingPlanQuotaResetStoreActions(params: {
  broadcastService: Pick<
    IBroadcastService,
    "acquireClaim" | "commitClaim" | "releaseClaim" | "send"
  >;
  readState: () => CodingPlanQuotaResetStoreState;
  writeState: CodingPlanQuotaResetStoreWriter;
}): CodingPlanQuotaResetStoreActions {
  const { broadcastService, readState, writeState } = params;
  return {
    setCodingPlanQuotaResetUiEntry: (sourceKey, resetType, entry, authSessionSeq) =>
      writeState(
        (state) =>
          updateCodingPlanQuotaResetStoreState(state, sourceKey, resetType, entry, authSessionSeq)
            .patch,
      ),
    reserveCodingPlanQuotaResetAutoPlay: (sourceKey, resetType, completedAt) =>
      reserveCodingPlanQuotaResetAutoPlay({
        broadcastService,
        readState,
        writeState: (updater) => writeState((state) => updater(state)),
        sourceKey,
        resetType,
        completedAt,
      }),
    commitCodingPlanQuotaResetAutoPlay: (reservation) =>
      commitCodingPlanQuotaResetAutoPlay({
        broadcastService,
        writeState: (updater) => writeState((state) => updater(state)),
        reservation,
      }),
    releaseCodingPlanQuotaResetAutoPlay: (reservation) =>
      releaseCodingPlanQuotaResetAutoPlay({ broadcastService, reservation }),
  };
}
