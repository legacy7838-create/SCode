/**
 * engine.ts has hit the oxlint max-lines limit (400 lines), so the explicit seams of the engine's private state are split out into this file;
 * the public surface is still exported from engine.ts.
 *
 * Several groups of WorkflowEngine methods (user-facing artifacts, report, world nodes and the import cache, run settlement) have been split into free functions in sibling
 * modules (engine-artifacts.ts / engine-report.ts / engine-world.ts / engine-settlement.ts).
 * They do not each hold state of their own; they read and write the engine's private fields through this seam: the seam is assembled by the engine in its constructor from arrow closures,
 * while the fields themselves stay private, so the engine's public surface changes not at all; the class keeps only a thin layer of delegating methods.
 *
 * Mutable scalars (the report counters, the import gate) are exposed as "a read method + a one-way write method" rather than as a getter/setter -- there is only
 * one way to write them (counters only increase, the gate only closes), and the seam says so on its face.
 */

import type { ImportedWorldQueue } from "./imported-cache.js";
import type { ArtifactOp } from "../facade/registry.js";
import type {
  ImportedRunCache,
  InstanceRef,
  JournalStorePort,
  RunEvent,
  RunStopReason,
  WorkflowDriver,
  WorkflowError,
} from "./types.js";

/**
 * The final settlement of a run: `completed` (the script returned) /
 * `errored` (an error of the script's own, not resumable) / `stopped` (it was stopped, always resumable; `error` is present only for
 * `provider` / `interrupted`).
 */
export type RunSettlement =
  | { status: "completed"; artifact: unknown }
  | { status: "errored"; error: WorkflowError }
  | { status: "stopped"; reason: RunStopReason; supersededBy?: string; error?: WorkflowError };

/**
 * The state of one user-facing artifact id within this run: which member kind it belongs to, how many versions have succeeded, and (seeded ones only) its
 * normalized spec. All three are derived from journal rows, so the resume reconstruction and the live bookkeeping arrive at one and the same table.
 */
export interface ArtifactIdState {
  kind: ArtifactOp;
  /** The number of versions that have succeeded (+1 per success of a content member; a seeded declaration is always 1). */
  versions: number;
  /** The canonicalJson of a seeded spec (the idempotence of a repeated declaration is judged against it). Absent for content members. */
  spec?: string;
  /** This id is the deliverable of the run (primary). At most one id in a run carries it; reconstructed from the completed row. */
  primary?: true;
}

/** The seam of the engine's private state: the free functions in the sibling modules read and write WorkflowEngine's private fields through it. */
export interface EngineState {
  readonly runId: string;
  readonly driver: WorkflowDriver;
  readonly journal: JournalStorePort;
  /**
   * The state of every **user-facing artifact** id of this run. Rebuilt on resume from the journal's
   * `kind: "artifact"` rows and maintained in memory thereafter -- the caps and the version numbers are run-level facts that stay continuous across resumes.
   *
   * ⚠ Terminology: artifact = a user-facing artifact, not `RunSettlement.artifact` (the top-level return value).
   */
  readonly artifacts: Map<string, ArtifactIdState>;
  /** The import cache of amend-resume (pure data; absent means this is not a revision continuation). */
  readonly importedCache: ImportedRunCache | undefined;
  /** The consumption cursor of the world import queue (the nth occurrence matches the nth entry). */
  readonly importedWorld: ImportedWorldQueue;

  isRunSettled(): boolean;
  /** The error used to reject / throw once the run has settled. */
  runError(): WorkflowError;
  /** The run-level failure (first-wins; see settleFailed in engine-settlement.ts). */
  failRun(error: WorkflowError): void;
  /** The event both lands in the journal and fans out (Boundary C); the birth phase is filled in by the engine's funnel. */
  record(event: RunEvent): void;
  /** The only place site ordinals are minted. */
  nextOrdinal(siteId: string): number;
  /**
   * Releases a hit under the constraint of the replay settlement order.
   * On a non-resume, or when the order table has no entry for this instance, `release` runs immediately.
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;

  /** The number of report entries published in this run (the counter for REPORT_CAPS.maxItemsPerRun, continuous across resumes). */
  reportCount(): number;
  /** A report entry that passed the cap check and is about to be persisted: the counter +1. */
  countReport(): void;

  /** Whether the import cache has been closed. */
  importClosed(): boolean;
  /** Closes the gate (never reopened). */
  closeImport(): void;

  /** Marks the run as settled; when a failure is given it also records the run-level failure reason (reused by runError). */
  markSettled(failure?: WorkflowError): void;
  /** Aborts all in-flight asks (delegated to the scheduler). */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void;
  /** Fulfils `engine.settled`. */
  resolveSettled(settlement: RunSettlement): void;
}
