/**
 * `@zcode/rust/task-index` — the automation repository.
 *
 * Spec: docs/specs/rust-native-task-index.md §15, §27.
 *
 * These are the methods of `automationRepo.ts`, transcribed one for one. They hang off
 * `TaskIndexStore` rather than a second class, because that is where the Rust surface puts them:
 * a separate napi class would have to take the store by reference, and napi's `ClassInstance`
 * cannot unwrap a `TaskIndexStore`, so the facades would have been unable to share one
 * connection and one migration ledger.
 *
 * The requests cross the boundary as JSON strings, matching the rest of this package: the domain
 * types stay in TypeScript where the contracts live, and `@zcode/rust` stays free of npm
 * dependencies. The returned values are `unknown` for the same reason; `automationRepo.ts` narrows
 * them to the shared types at the boundary.
 *
 * There is **no JavaScript fallback** (`docs/specs/rust-native-ports.md` invariant 1).
 * `loadNative` throws when the binary is missing. A scheduling state machine that silently
 * half-runs is worse than one that refuses to start: a claim that is taken but never dispatched,
 * or a run whose outcome is never written back, fails silently until a week of work is missing.
 */
import { NATIVE_STORE, type NativeStore, type TaskIndexStore } from "./taskIndex.js";

/** The repository handle over the one native object. */
export class AutomationRepository {
  readonly #store: NativeStore;

  constructor(store: TaskIndexStore) {
    this.#store = store[NATIVE_STORE];
  }

  /** `create` — the count guard and the insert are one transaction. */
  async automationCreate(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationCreate(JSON.stringify(request)));
  }

  /** `list` — the workspace-scoped list, newest first. */
  async automationList(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationList(JSON.stringify(request)));
  }

  /** `get` — one automation, or `null`. */
  async automationGet(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationGet(JSON.stringify(request)));
  }

  /** `getModelSelectionForDispatch` — the three-way decision, never a silent default. */
  async automationGetModelSelectionForDispatch(request: unknown): Promise<unknown> {
    return JSON.parse(
      await this.#store.automationGetModelSelectionForDispatch(JSON.stringify(request)),
    );
  }

  /** `getBotDeliveryTarget` — the internal source, never part of the display model. */
  async automationGetBotDeliveryTarget(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationGetBotDeliveryTarget(JSON.stringify(request)));
  }

  /** `hasTaskBinding` — the authorization criterion itself, scoped by workspace. */
  async automationHasTaskBinding(request: unknown): Promise<boolean> {
    return this.#store.automationHasTaskBinding(JSON.stringify(request));
  }

  /** `getScheduledRunCount` — `null` when the automation is gone. */
  async automationGetScheduledRunCount(request: unknown): Promise<number | null> {
    return this.#store.automationGetScheduledRunCount(JSON.stringify(request));
  }

  /** `update` — the tri-state edit, with `enabled` derived from the lifecycle. */
  async automationUpdate(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationUpdate(JSON.stringify(request)));
  }

  /** `delete` — `true` when a row was removed. */
  async automationDelete(request: unknown): Promise<boolean> {
    return this.#store.automationDelete(JSON.stringify(request));
  }

  /** `setEnabled` — pause / resume, keeping the schedule. */
  async automationSetEnabled(request: unknown): Promise<void> {
    await this.#store.automationSetEnabled(JSON.stringify(request));
  }

  /** `restart` — back to active, counters and retry state cleared. */
  async automationRestart(request: unknown): Promise<void> {
    await this.#store.automationRestart(JSON.stringify(request));
  }

  /** `runNow` — the manual run, taking the single-flight lock. */
  async automationRunNow(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationRunNow(JSON.stringify(request)));
  }

  /** `claimDue` — the backoff-aware claim, in one transaction. */
  async automationClaimDue(now: number = Date.now()): Promise<unknown> {
    return JSON.parse(await this.#store.automationClaimDue(now));
  }

  /** `claimManualRuns` — the manual-run queue. */
  async automationClaimManualRuns(now: number = Date.now()): Promise<unknown> {
    return JSON.parse(await this.#store.automationClaimManualRuns(now));
  }

  /** `markDispatched` — the successful-dispatch settlement. */
  async automationMarkDispatched(request: unknown): Promise<void> {
    await this.#store.automationMarkDispatched(JSON.stringify(request));
  }

  /** `markDispatchFailed` — transient backoff and the terminal give-up. */
  async automationMarkDispatchFailed(request: unknown): Promise<void> {
    await this.#store.automationMarkDispatchFailed(JSON.stringify(request));
  }

  /** `releaseClaim` — clears the claim; `true` when there was one. */
  async automationReleaseClaim(request: unknown): Promise<boolean> {
    return this.#store.automationReleaseClaim(JSON.stringify(request));
  }

  /** `releaseManualClaim` — releases the lock only, leaving the schedule untouched. */
  async automationReleaseManualClaim(request: unknown): Promise<void> {
    await this.#store.automationReleaseManualClaim(JSON.stringify(request));
  }

  /** `touchManualClaim` — renews the lease for a long manual run. */
  async automationTouchManualClaim(request: unknown): Promise<void> {
    await this.#store.automationTouchManualClaim(JSON.stringify(request));
  }

  /** `skipAndReschedule` — the missed-fire-window compensation. */
  async automationSkipAndReschedule(request: unknown): Promise<void> {
    await this.#store.automationSkipAndReschedule(JSON.stringify(request));
  }

  /** `ensureRunClaimed` — the fallback row, without bumping `attempts`. */
  async automationEnsureRunClaimed(request: unknown): Promise<void> {
    await this.#store.automationEnsureRunClaimed(JSON.stringify(request));
  }

  /** `upsertRunClaimed` — the claim upsert; a retry reuses its run row. */
  async automationUpsertRunClaimed(request: unknown): Promise<void> {
    await this.#store.automationUpsertRunClaimed(JSON.stringify(request));
  }

  /** `fixRunModelSelection` — pins the selection on first submit. */
  async automationFixRunModelSelection(request: unknown): Promise<unknown> {
    return JSON.parse(
      await this.#store.automationFixRunModelSelection(JSON.stringify(request)),
    );
  }

  /** `markRunDispatch` — the dispatch result onto the run row. */
  async automationMarkRunDispatch(request: unknown): Promise<void> {
    await this.#store.automationMarkRunDispatch(JSON.stringify(request));
  }

  /** `markManualRunDispatched` — idempotent at the first `dispatched`. */
  async automationMarkManualRunDispatched(request: unknown): Promise<boolean> {
    return this.#store.automationMarkManualRunDispatched(JSON.stringify(request));
  }

  /** `markRunOutcome` — the session runtime's write-back, guarded against `running` regressions. */
  async automationMarkRunOutcome(request: unknown): Promise<void> {
    await this.#store.automationMarkRunOutcome(JSON.stringify(request));
  }

  /** `recordSkippedRun` — a skipped row, without touching the counters. */
  async automationRecordSkippedRun(request: unknown): Promise<void> {
    await this.#store.automationRecordSkippedRun(JSON.stringify(request));
  }

  /** `listRuns` — the run history, newest first. */
  async automationListRuns(request: unknown): Promise<unknown> {
    return JSON.parse(await this.#store.automationListRuns(JSON.stringify(request)));
  }

  /** `getRun` — one run, or `null`. */
  async automationGetRun(runId: string): Promise<unknown> {
    return JSON.parse(await this.#store.automationGetRun(runId));
  }

  /** `deleteRun` — scoped by workspace when one is given. */
  async automationDeleteRun(request: unknown): Promise<void> {
    await this.#store.automationDeleteRun(JSON.stringify(request));
  }

  /** `pruneRuns` — the retention sweep; returns how many rows it dropped. */
  async automationPruneRuns(request: unknown): Promise<number> {
    return this.#store.automationPruneRuns(JSON.stringify(request));
  }
}

/** The repository handle — the same store, wrapped. */
export function automationRepository(store: TaskIndexStore): AutomationRepository {
  return new AutomationRepository(store);
}
