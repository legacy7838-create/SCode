/**
 * engine.ts hit the oxlint max-lines limit (400 lines), so the publishing path of `report()` (the serialization probe, replay
 * dedup, label validation, the two caps, the single write) is split into this file; the public surface is still exported from
 * engine.ts.
 *
 * The free functions read and write engine state through the {@link EngineState} seam; WorkflowEngine.report is a thin delegation.
 */

import { inputHash } from "./hash.js";
import { REPORT_CAPS } from "../facade/report-caps.js";
import { declaredPresetIds, isDeclaredPreset } from "./engine-artifacts.js";
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publish one intermediate result (Boundary A's `report`). Synchronous, no return value, no driver round trip: it writes
 * one journal row, emits one event, and is done.
 *
 * Four things, and the order is deliberate:
 *
 * 1. **The serialization probe goes first**. One `JSON.stringify` call gets two things at once: whether the item can be
 *    represented as JSON at all, and its byte size (the measure the cap works in). It has to come before canonicalJson — an item
 *    with a cycle makes canonicalJson recurse until the stack blows, which is a crash rather than a readable failure.
 * 2. **A replay hit is skipped**: no event, no rewritten record. Before skipping, inputHash is compared; a mismatch fails the run
 *    loudly as a purity violation. This comparison is **defensive** (a report derives from values the journal has already pinned),
 *    but it is free, and a divergence here means the whole replay is unreliable — a reader of the Results panel should never,
 *    unknowingly, see that.
 * 3. **Caps before persistence**: if either the count or the per-item byte size is exceeded, the whole run fails with
 *    `ReportCapExceeded`. Run-level rather than node-level, because `report` returns `void` and there is nowhere for a node to
 *    reject it.
 * 4. **One write**: `completed`, no actor fields.
 */
export function publishReport(
  state: EngineState,
  siteId: string,
  item: unknown,
  artifactId?: string,
): void {
  if (state.isRunSettled()) return; // Same as log: no longer accepted after settlement
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const serialized = probeReportItem(state, instance, item);
  if (serialized === undefined) return; // Probe failedRun
  // inputHash deliberately only covers item, and labels are not hashed: labels are compile-time literals on the site, and resume
  // The script is required to be the same byte by byte (script_hash), so tags with the same (siteId, ordinal) cannot change. add it to
  // The only effect of hash input is to make **each** unlabeled report in the existing journal appear when resume
  // InputHashMismatch - A destructive load deformation with no gain.
  const hash = inputHash(item);

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // replay deduplication: skip silently (no events, no repeated append)
  }

  // Tag present: it must have been declared as a **preset** product. Check before the upper limit - a label pointing to a non-existent board
  // It's because the script is wrongly written, not the capacity event. Mixing the two together will make the error code deceptive.
  // failRun instead of reject for exactly the same reason as report 's two upper bounds: void returns no reject channel.
  if (artifactId !== undefined && !isDeclaredPreset(state, artifactId)) {
    state.failRun(
      new WorkflowError(
        "ArtifactUndeclared",
        `report() tag "${artifactId}" is not a declared preset artifact ` +
          `(at ${refToString(instance)}). Declare it once at the top of the script, e.g. ` +
          `artifact.chart("${artifactId}", …), before tagging reports with it. Declared presets: ` +
          `${declaredPresetIds(state).join(", ") || "(none)"}.`,
      ),
    );
    return;
  }

  if (!reserveReport(state, instance, serialized)) return;
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "report",
    inputHash: hash,
    status: "completed",
    result: item,
    // The labeled report line is the landing point of the invariant "Kanban = projection of journal": each point of a Kanban board
    // Just one line kind = report ∧ artifact_id = the id.
    ...(artifactId === undefined ? {} : { artifactId }),
  });
  state.record({
    type: "report",
    instance,
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  });
}

/**
 * The **runtime JSON guard rail** for report (the compile-time serializability diagnostic is the suspenders, this is the belt).
 * Returns the serialized text of the item; when it cannot be represented, failRun and return undefined.
 *
 * Why `JSON.stringify` rather than `canonicalJson`: canonicalJson is **total** (it silently folds undefined/functions into `"null"`,
 * and recurses until the stack blows on a cycle), which is exactly what it should be as a hash input, but as a guard rail it would
 * quietly land a truncated item in the journal. `JSON.stringify` is the opposite: cycles and bigint throw, and
 * undefined/functions/symbol return undefined — both cases can be caught as one loud failure.
 *
 * The error code is `DriverError` rather than `ReportCapExceeded`: this is not a cap (a cap is about a quantity), but the
 * contract "the item is JSON" being broken, and the front door of that contract is the compile-time diagnostic. Getting here
 * means something went around that door (typically a cycle built through `any`), so it is a contract break and not a capacity
 * event — keeping `ReportCapExceeded` meaning only "cap" is what lets a reader act on the code.
 */
function probeReportItem(
  state: EngineState,
  instance: InstanceRef,
  item: unknown,
): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(item);
  } catch (cause) {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item cannot be serialized to JSON (a cycle or a bigint) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
        { cause },
      ),
    );
    return undefined;
  }
  if (serialized === undefined) {
    // JSON.stringify returns undefined for undefined / function / symbol.
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item is not a JSON value (undefined, a function or a symbol) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
      ),
    );
    return undefined;
  }
  return serialized;
}

/** The two caps of report (item count, per-item byte size). Exceeding either fails the run and returns false. */
function reserveReport(state: EngineState, instance: InstanceRef, serialized: string): boolean {
  const bytes = utf8ByteLength(serialized);
  if (bytes > REPORT_CAPS.maxItemSerializedBytes) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} is ${bytes} bytes, over the ` +
          `${REPORT_CAPS.maxItemSerializedBytes}-byte limit. Report a summary instead.`,
      ),
    );
    return false;
  }
  if (state.reportCount() >= REPORT_CAPS.maxItemsPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. ` +
          `Report findings, not chatter.`,
      ),
    );
    return false;
  }
  state.countReport();
  return true;
}

/**
 * The UTF-8 byte size of a string (the measure for the per-item report cap). Uses `TextEncoder` (an ECMAScript/WHATWG
 * standard global) rather than `Buffer.byteLength`: this package keeps a zero node-builtin dependency. The cap argues in
 * **bytes**, not characters — Chinese findings have roughly a third as many characters as bytes, and counting characters would
 * make the cap useless.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
