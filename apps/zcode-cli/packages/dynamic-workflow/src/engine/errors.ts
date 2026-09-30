/**
 * The engine's structured errors: stable error codes, serializable shapes, and the {@link WorkflowError} thrown across Boundary A.
 * This module depends on the schema's Violation and the terminal details; types.ts re-exports these types for callers.
 */

import type { Violation } from "../schema/types.js";
import type { ProviderStopDetails } from "./run-terminal.js";

/**
 * The stable error codes. They distinguish node-level (rejecting the promise of a single ask) from run-level (failing the whole run):
 * - node-level: ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
 *   WorldReadCapExceeded — a world read exceeded the cap of its op (`files.grep`: 2000 hits or 256KB serialized, whichever
 *   comes first rejects; `git.diff`: 512KB; see `facade/world-read-caps.ts`). It is node-level rather than run-level on the
 *   strength of the **rejection channel**, not its severity: a world read returns a promise the script can `catch`, so "narrow the
 *   pattern or add a glob" is a road the script can really take. It is also deliberately **not** folded into
 *   DriverError — a cap is a contract the script can rewrite itself against, and telling the two apart by matching the message
 *   text is exactly what this union type exists to prevent.
 * - run-level: InputHashMismatch / UnknownActor / MissingAskSpec /
 *   DuplicateActorName — two createActor calls in the same run got the same **non-empty** effective name
 *   (effective name = `spec.name` after normalizePersona, where persona.name overrides the name argument). The rule applies to
 *   **all** runs and not just amended ones: a named actor is the identity key of amend-resume cache imports, and any run is a
 *   potential predecessor of a future amendment, so a duplicate name in the predecessor makes the import match ambiguous. Anonymous
 *   (name absent or an empty string) is neither checked nor forbidden — the price is not being eligible for the cache.
 *   Duplicate literal names additionally get a compile-time courtesy diagnostic (analysis/actor-names.ts), but dynamic names can
 *   only be checked at runtime, so this rule is the real gate.
 *   ReportCapExceeded — a run exceeds 256 reports, or a single item serializes to more than 32KB
 *   (see `facade/report-caps.ts`). It is run-level rather than node-level, by the same boundary as WorldReadCapExceeded above but
 *   with the opposite conclusion: `report` returns `void`, so the script has **no** channel to catch, and there is nowhere to put it
 *   but the run. Precisely for that reason, both numbers must be wide enough that a reasonable script never hits them — a script
 *   author cannot write a recovery path for them. Also deliberately not folded into DriverError: a cap is a contract the script
 *   can rewrite itself against.
 * - Construction-time (the run has not started, the engine constructor throws synchronously): ScriptHashMismatch
 * - Host-level (**never produced by the engine**): Interrupted — the process owning that run is gone before settlement, and the
 *   host converges the record stuck at running on the next construction (orphan convergence in
 *   `bootstrap/src/app/dynamic-workflow-run-service.ts`). It must be an **independent code** rather than reusing DriverError: a
 *   script throwing on its own is also encoded as DriverError (`dynamic-workflow-runtime/src/harness.ts:311`), and if the two
 *   shared a code then "the process was killed" and "the script really failed" could only be told apart by the message text —
 *   which is exactly what this union type has to avoid.
 *   ProviderStop — a model request of a subagent (or of the tool side) hit a **deterministic** model-side error (expired auth, a
 *   model not in the plan, exhausted quota, etc.), and the driver stops the run as `stopped(provider)` rather than failing the
 *   node; the structured details are in `providerStop`. It is the other host-level one: the engine only persists it verbatim in
 *   `stop("provider", error)`.
 * Every flow decision uses the codes defined here and never matches error text.
 */
export type WorkflowErrorCode =
  | "ValidationFailed"
  | "ResultNotSubmitted"
  | "DriverError"
  | "WorldReadCapExceeded"
  | "Cancelled"
  | "ContextLimit"
  | "ReportCapExceeded"
  | "InputHashMismatch"
  | "UnknownActor"
  | "MissingAskSpec"
  | "DuplicateActorName"
  | "ScriptHashMismatch"
  | "Interrupted"
  | "ProviderStop"
  // ——————————User interface products————————————
  // ⚠ Terminology: This batch of artifacts are all **user-side products** (outputs released by the script for users to see), and
  // `RunSettlement.artifact` (the top-level return value) is irrelevant.
  //
  // The channel is split by **member family**, which is the same argument as the WorldReadCapExceeded / ReportCapExceeded boundary:
  // Content members (`file`/`markdown`) return promise, and the script can be caught, so it is rejected at the node level; preset members
  // Returning void, there is nothing to reject into, so the same thing is true for failRun in that family. Three driver side
  // The code (Missing/Outside/TooLarge/StoreUnavailable) can only come from content members, so it is always at the node level.
  | "ArtifactSourceMissing"
  | "ArtifactPathOutsideWorkspace"
  | "ArtifactTooLarge"
  | "ArtifactStoreUnavailable"
  | "ArtifactVersionCapExceeded"
  | "ArtifactKindMismatch"
  | "ArtifactCapExceeded"
  | "ArtifactSpecInvalid"
  | "ArtifactRedeclared"
  | "ArtifactUndeclared"
  // The second id wants to be the primary: the content member is rejected at the node level.
  // The preset member is failRun - the same line of demarcation as above.
  | "ArtifactPrimaryConflict";

/**
 * A structured comparison of mismatched values (which side changed). The value in the record is `expected`, the one passed in
 * this time is `got`. Whoever debugs a rejected resume needs these two values, not a regex scraped out of the message —
 * neither flow decisions nor display should depend on the error text.
 */
export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

/** The serializable shape of an error, persisted in the journal (dwf_node.error_json / dwf_run.failure_json). */
export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
  /** Only present when `code === "ProviderStop"`. */
  providerStop?: ProviderStopDetails;
}

/**
 * The structured error thrown across Boundary A. With a stable code and optional violations / finalText / mismatch, so that
 * the script-side try/catch and the layers above can both handle it structurally instead of by string matching.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly violations?: Violation[];
  readonly finalText?: string;
  readonly mismatch?: WorkflowErrorMismatch;
  readonly providerStop?: ProviderStopDetails;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    extra?: {
      violations?: Violation[];
      finalText?: string;
      mismatch?: WorkflowErrorMismatch;
      providerStop?: ProviderStopDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (extra?.violations !== undefined) this.violations = extra.violations;
    if (extra?.finalText !== undefined) this.finalText = extra.finalText;
    if (extra?.mismatch !== undefined) this.mismatch = extra.mismatch;
    if (extra?.providerStop !== undefined) this.providerStop = extra.providerStop;
    if (extra?.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }

  /** Convert to the serializable shape for persisting in the journal. */
  toJSON(): WorkflowErrorJson {
    const json: WorkflowErrorJson = { code: this.code, message: this.message };
    if (this.violations !== undefined) json.violations = this.violations;
    if (this.finalText !== undefined) json.finalText = this.finalText;
    if (this.mismatch !== undefined) json.mismatch = this.mismatch;
    if (this.providerStop !== undefined) json.providerStop = this.providerStop;
    return json;
  }

  /** Rebuild from a journal record (used when a replay hits a failed node). */
  static fromJSON(json: WorkflowErrorJson): WorkflowError {
    return new WorkflowError(json.code, json.message, {
      violations: json.violations,
      finalText: json.finalText,
      mismatch: json.mismatch,
      providerStop: json.providerStop,
    });
  }
}
