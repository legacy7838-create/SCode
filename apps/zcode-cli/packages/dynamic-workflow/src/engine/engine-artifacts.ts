/**
 * engine.ts has hit oxlint's max-lines limit (400 lines), so publishing / declaring / admitting / settling / resume-restoring the
 * **user-facing artifacts** (`artifact.*`) is split into this file; the public surface is still exported from engine.ts.
 *
 * ⚠ Terminology: everything below means a **user-facing artifact** (an output the script publishes for the user to see), not RunSettlement.artifact.
 * The free functions read and write engine state through the {@link EngineState} seam; the same-named methods on WorkflowEngine are only thin delegations.
 */

import { canonicalJson, inputHash } from "./hash.js";
import { ARTIFACT_CAPS } from "../facade/artifact-caps.js";
import {
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactPresetOp,
} from "../facade/registry.js";
import { heldResolution } from "./replay-order.js";
import {
  primaryArtifactId,
  primaryConflict,
  primaryConflictMessage,
} from "./engine-artifacts-primary.js";
import { validateArtifactSpec } from "./artifact-spec.js";
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type {
  ArtifactPublishRequest,
  ArtifactRef,
  ArtifactVersionRecord,
  InstanceRef,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publishes one **content artifact** (`artifact.file` / `artifact.markdown`). Effect family: the driver copies the bytes into the
 * store, success fulfils the {@link ArtifactRef}, and failure **rejects catchably** — the script's gating idiom is
 * `try { await artifact.file(...) } catch { …have a subagent write it… }`.
 *
 * The order:
 * 1. `nextOrdinal` → journal hit? A hit short-circuits: compared by inputHash, a successful record returns its ArtifactRef,
 *    while a **failed record is re-rejected as it was recorded** (resume is crash recovery, not re-verification: a publication that failed is still
 *    that very failure after recovery, and rerunning it would take the script's catch branch down two different paths). A hit never **re-emits an event** (same as report).
 * 2. No hit: kind ownership → the id count limit → the version count limit, all three of them node-level rejections (there is a promise that can reject).
 * 3. The version number is computed **before** dispatch and handed to the driver (the store's toolCallId has to carry it, one set of bytes per version).
 * 4. `putNode(running)` → driver → on success `putNode(completed)` + `artifact-published`;
 *    on failure `putNode(failed)` + `artifact-failed` → reject.
 *
 * Neither path **emits any node lifecycle event** (node-queued / dispatched / settled): an artifact site is not a node in either of the two
 * graphs, and a node-settled landing on such a site gets projected and reduced into `nodes[]`, becoming an unexplainable unknown node in the run panel.
 */
export function publishContentArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactContentOp,
  args: unknown[],
): Promise<ArtifactRef> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const id = args[0];
  const payload = args[1];
  // Runtime guardrails for argument shapes (compile-time literal id diagnostics and facade types are the front door): non-strings that go here
  // It can only be that something bypasses compilation. Use DriverError instead of an Artifact* code - let those codes only represent them
  // respective things (same as probeReportItem’s coding argument for “item is not JSON”).
  //
  // These two **do not drop journal lines and do not send events** are different from all the failure paths below. The reason is that they are deterministic:
  // The conclusion is only determined by args. There is no driver round trip. If resume runs the same call again, it will inevitably get the same rejection, so
  // There is no need for a line of records to pin it down (the requirement of "settled failure" is for the driver that has been executed,
  // The kind that may not fail next time). Besides, there is no id to write into `artifact_id` or event - make one up
  // It will only make readers think that there really is such a product.
  if (typeof id !== "string" || id === "") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: id must be a non-empty string (at ${refToString(instance)}).`,
      ),
    );
  }
  if (typeof payload !== "string") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        op === "file"
          ? `artifact.file: path must be a string (at ${refToString(instance)}).`
          : `artifact.markdown: content must be a string (at ${refToString(instance)}).`,
      ),
    );
  }
  // `opts.primary` is read by **engine**: driver does not know
  // The opts key is always allowed, and "all runs at most one primary" are run-level facts that only the engine knows. non-boolean values vs. above
  // Both are guardrails of certainty - no failure, no incident.
  const primaryOption = (args[2] as { primary?: unknown } | undefined)?.primary;
  if (primaryOption !== undefined && typeof primaryOption !== "boolean") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: opts.primary must be a boolean (at ${refToString(instance)}).`,
      ),
    );
  }
  const hash = inputHash({ args, id, op });

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      state.failRun(err);
      return Promise.reject(err);
    }
    // Same as ask / world hit: the release point passes the replay sequence gate. Publish is an effect, and the script must await it, so it is also a decision
    // The release point of the subsequent continuation sequence; the preset declaration is synchronized void, never takes this path, and therefore never occupies the gate.
    if (recorded.status === "completed") {
      const record = recorded.result as ArtifactVersionRecord;
      return heldResolution(state.holdForReplay, instance, () => ({
        id: record.id,
        version: record.version,
      }));
    }
    if (recorded.status === "failed") {
      return heldResolution(state.holdForReplay, instance, () => {
        throw WorkflowError.fromJSON(recorded.error!);
      });
    }
    // status === "running": Crash during execution, fall down and execute live again (the copy of bytes is idempotent,
    // The version number is derived from the number of completed lines, so re-running will not skip the number).
  }

  // Sticky: This id is already primary, so is this version, regardless of whether `primary` is written again this time.
  const idState = state.artifacts.get(id);
  const primary = primaryOption === true || idState?.primary === true;
  const admission = admitArtifact(state, id, op, primary);
  if (admission !== undefined) {
    return Promise.reject(settleArtifactFailure(state, instance, hash, { id, op }, admission));
  }

  const version = (idState?.versions ?? 0) + 1;
  const publish = state.driver.executeArtifactPublish;
  if (publish === undefined) {
    // The assembly does not have the release capability on the driver side (pure replay/fake without store connection). **Loud one naming failure**,
    // It is not silently downgraded to "released an empty product" - the script is visible and the node is dropped into the library as failed.
    return Promise.reject(
      settleArtifactFailure(
        state,
        instance,
        hash,
        { id, op },
        new WorkflowError(
          "ArtifactStoreUnavailable",
          `Cannot publish "${id}": this host has no artifact store (at ${refToString(instance)}).`,
        ),
      ),
    );
  }

  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "running",
    artifactId: id,
  });

  const request: ArtifactPublishRequest = {
    runId: state.runId,
    siteId,
    ordinal,
    op,
    id,
    version,
    ...(op === "file" ? { path: payload } : { content: payload }),
    ...(args[2] === undefined ? {} : { opts: args[2] }),
  };
  return publish.call(state.driver, request).then(
    (record) => settleArtifactPublish(state, instance, hash, { id, op, version, primary }, record),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `Artifact publish failed: ${op} "${id}".`, {
              cause,
            });
      throw settleArtifactFailure(state, instance, hash, { id, op }, err);
    },
  );
}

/**
 * Declares one **predefined artifact** (`artifact.chart` / `table` / `metrics` / `board`). Declaration family: synchronous,
 * no return value, **not through the driver** — a declaration has nothing to wait for.
 *
 * The order: `nextOrdinal` → a hit returns immediately → spec shape validation
 * → an existing declaration for the same id? an identical canonical ⇒ idempotent no-op (no new row, no event); a different one ⇒ failRun
 * → the limits → `putNode(completed)` + `artifact-published`.
 *
 * All three failures (invalid spec / same id with a different spec / over a limit) fail the run instead of rejecting: a void return has no rejection
 * channel, which is the same argument as for the two limits of `report`.
 */
export function declarePresetArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactPresetOp,
  args: unknown[],
): void {
  if (state.isRunSettled()) return; // Same as report/log
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const id = args[0];
  if (typeof id !== "string" || id === "") {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: id must be a non-empty string (at ${refToString(instance)}).`,
      ),
    );
    return;
  }
  const spec = args[1];
  const hash = inputHash({ args, id, op });

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // replay deduplication: skip silently (same as report)
  }

  const problem = validateArtifactSpec(op, spec);
  if (problem !== undefined) {
    state.failRun(
      new WorkflowError(
        "ArtifactSpecInvalid",
        `Artifact "${id}" has an invalid spec (at ${refToString(instance)}): ${problem}`,
      ),
    );
    return;
  }

  const canonical = canonicalJson(spec);
  const idState = state.artifacts.get(id);
  if (idState !== undefined) {
    if (idState.kind !== op) {
      state.failRun(
        new WorkflowError(
          "ArtifactKindMismatch",
          `Artifact id "${id}" is already a ${idState.kind} and cannot be declared as a ${op} ` +
            `(at ${refToString(instance)}). An id belongs to one artifact kind for the whole run; ` +
            `use a different id.`,
        ),
      );
      return;
    }
    if (idState.spec === canonical) return; // Idempotent no-op: no new lines, no events
    state.failRun(
      new WorkflowError(
        "ArtifactRedeclared",
        `Artifact "${id}" was already declared with a different spec (at ${refToString(instance)}). ` +
          `The spec for one id must stay identical (an identical re-declaration is a no-op); ` +
          `declare it once at the top of the script.`,
      ),
    );
    return;
  }
  // `primary` enters the canonical spec, so the flag with the same id is changed to ArtifactRedeclared (rejected above); here we only have
  // **NEW** The id wants to be primary and the other id is already - the preset family has no reject channel, failRun.
  const wantsPrimary = (spec as { primary?: unknown }).primary === true;
  const holder = wantsPrimary ? primaryArtifactId(state) : undefined;
  if (holder !== undefined && holder !== id) {
    state.failRun(
      new WorkflowError(
        "ArtifactPrimaryConflict",
        primaryConflictMessage(id, holder, `declare "${id}" without primary`, instance),
      ),
    );
    return;
  }
  if (state.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
    state.failRun(
      new WorkflowError(
        "ArtifactCapExceeded",
        `Cannot declare "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ` +
          `ids, the maximum. Reuse an existing id or publish fewer artifacts.`,
      ),
    );
    return;
  }

  // The statement is **write-once** (same as report): there are no driver calls between admission and settlement, nothing can fail in the middle.
  const record = presetRecord(id, op, spec);
  state.artifacts.set(id, {
    kind: op,
    spec: canonical,
    versions: 1,
    ...(wantsPrimary ? { primary: true as const } : {}),
  });
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "completed",
    result: record,
    artifactId: id,
  });
  state.record({ type: "artifact-published", instance, artifact: record });
}

/**
 * Admission of a content artifact: kind ownership → the id count limit → the version count limit. Returns the rejection reason; `undefined` means let it through.
 *
 * All three are **node-level** rejections (a content member has a promise that can reject), in contrast to the three of the same name in the predefined family —
 * that family can only failRun. Same fact, two channels, and the difference lies in the return type rather than in severity.
 */
function admitArtifact(
  state: EngineState,
  id: string,
  op: ArtifactContentOp,
  primary: boolean,
): WorkflowError | undefined {
  const idState = state.artifacts.get(id);
  if (idState !== undefined && idState.kind !== op) {
    return new WorkflowError(
      "ArtifactKindMismatch",
      `Artifact id "${id}" is already a ${idState.kind} and cannot be published as a ${op}. An id ` +
        `belongs to one artifact kind for the whole run (publishing the same id again creates a ` +
        `new version, and a version cannot change what it is); use a different id.`,
    );
  }
  // Primary conflicts are ranked before the upper limit: an id intended to be a deliverable is rejected because the reason should be "there is already a deliverable", not "full".
  const holder = primaryConflict(state, id, primary);
  if (holder !== undefined) {
    return new WorkflowError(
      "ArtifactPrimaryConflict",
      primaryConflictMessage(id, holder, `publish "${id}" without primary`, undefined),
    );
  }
  if (idState === undefined && state.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
    return new WorkflowError(
      "ArtifactCapExceeded",
      `Cannot publish "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ` +
        `ids, the maximum. Publish a new version of an existing id instead.`,
    );
  }
  if (idState !== undefined && idState.versions >= ARTIFACT_CAPS.maxVersionsPerArtifact) {
    return new WorkflowError(
      "ArtifactVersionCapExceeded",
      `Artifact "${id}" already has ${idState.versions} versions, the maximum of ` +
        `${ARTIFACT_CAPS.maxVersionsPerArtifact}. Publish the final content in fewer versions.`,
    );
  }
  return undefined;
}

/**
 * A content artifact published successfully: write the completed row + do the accounting + emit `artifact-published`, and return the ref the script asked for.
 *
 * The identity (id / kind / version number) always comes from **the engine's own computed copy** (`issued`), not from the same-named fields of the record the
 * driver returns: the version number is derived by the engine from the journal and handed down, and letting it take a detour through the driver and read back
 * would only add one more place where the two can disagree. The driver's record is responsible for what it genuinely owns — uri / bytes /
 * contentType / sourcePath — and all of that goes to the journal verbatim.
 */
function settleArtifactPublish(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp; version: number; primary: boolean },
  record: ArtifactVersionRecord,
): ArtifactRef {
  if (state.isRunSettled()) throw state.runError();
  // There is a driver round trip between admission and settlement: two concurrent primary releases can pass admission. Check again during checkout.
  // The losing one takes the failed path - the failed line does not claim the flag, so there will never be two completed primary in the journal.
  const holder = primaryConflict(state, issued.id, issued.primary);
  if (holder !== undefined) {
    throw settleArtifactFailure(
      state,
      instance,
      hash,
      issued,
      new WorkflowError(
        "ArtifactPrimaryConflict",
        primaryConflictMessage(
          issued.id,
          holder,
          `publish "${issued.id}" without primary`,
          instance,
        ),
      ),
    );
  }
  // The flag is stamped by the engine: the driver's record is only responsible for what it really owns (uri/bytes/contentType/sourcePath).
  const stored: ArtifactVersionRecord = issued.primary ? { ...record, primary: true } : record;
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "completed",
    result: stored,
    artifactId: issued.id,
  });
  state.artifacts.set(issued.id, {
    kind: issued.op,
    versions: issued.version,
    ...(issued.primary ? { primary: true as const } : {}),
  });
  state.record({ type: "artifact-published", instance, artifact: stored });
  return { id: issued.id, version: issued.version };
}

/**
 * A content artifact that failed to publish: write the failed row + emit `artifact-failed`, and return the error to throw.
 *
 * Persisting is an existing requirement of replay soundness (a settled failure must be in the journal), otherwise resume would rerun a
 * failure the script had already caught — precisely what "resume is crash recovery, not re-verification" exists to prevent.
 *
 * The reader of node-settled
 * reduces it into `nodes[]` and looks up the corresponding node in the graph by site id, while an artifact site enters no graph at all — which would become an unexplainable unknown node on the run
 * panel. `artifact-failed` carries exactly what rendering a failure card needs
 * (id / kind / structured error) and does not impersonate a unit of work. The success side likewise emits only `artifact-published`.
 */
function settleArtifactFailure(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp },
  error: WorkflowError,
): WorkflowError {
  const json = error.toJSON();
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "failed",
    error: json,
    artifactId: issued.id,
  });
  state.record({
    type: "artifact-failed",
    instance,
    id: issued.id,
    op: issued.op,
    error: json,
  });
  return error;
}

/**
 * Resume restoration: folds one **completed** artifact record from the journal into the in-memory state.
 *
 * **Only completed rows claim an id**: a failed publication claims no id, no kind and no version. That is not merely about a tidy graph —
 * a failed row has an empty `result`, its kind cannot be restored, and if the live side claimed it while the resume side could not,
 * the same script would end up with two sets of limit books before and after a crash. Kind conflicts are guarded separately by a compile-time diagnostic, and this
 * runtime one (`ArtifactKindMismatch`) is about the ids that really were published successfully.
 */
export function rememberArtifactRow(
  state: EngineState,
  id: string | undefined,
  result: unknown,
): void {
  if (id === undefined || id === "") return;
  const record = (result ?? undefined) as ArtifactVersionRecord | undefined;
  if (record?.kind === undefined) return;
  const existing = state.artifacts.get(id);
  const spec = record.spec === undefined ? existing?.spec : canonicalJson(record.spec);
  const primary = record.primary === true || existing?.primary === true;
  state.artifacts.set(id, {
    kind: record.kind,
    ...(spec === undefined ? {} : { spec }),
    versions: (existing?.versions ?? 0) + 1,
    ...(primary ? { primary: true as const } : {}),
  });
}

/** Whether that id has already been declared as a **predefined** artifact (a legal target of a `report` tag). */
export function isDeclaredPreset(state: EngineState, id: string): boolean {
  const idState = state.artifacts.get(id);
  return idState !== undefined && isArtifactPresetOp(idState.kind);
}

/** The declared predefined ids (lexicographic) — only used to make the `ArtifactUndeclared` message actionable. */
export function declaredPresetIds(state: EngineState): string[] {
  return [...state.artifacts.entries()]
    .filter(([, idState]) => isArtifactPresetOp(idState.kind))
    .map(([id]) => id)
    .sort();
}

/**
 * The persisted record of a predefined declaration. `title` / `description` are **lifted** out of the spec: the readers of the card (the run side panel,
 * notifications, the hub) only get this record and should not have to resolve the spec just to show a title; the spec is still kept verbatim for renderers that
 * need the full shape. The version is always 1 — a declaration has no versions, it happens exactly once.
 */
function presetRecord(id: string, op: ArtifactPresetOp, spec: unknown): ArtifactVersionRecord {
  const options = (spec ?? {}) as { title?: unknown; description?: unknown; primary?: unknown };
  return {
    id,
    kind: op,
    version: 1,
    ...(typeof options.title === "string" ? { title: options.title } : {}),
    ...(typeof options.description === "string" ? { description: options.description } : {}),
    spec,
    ...(options.primary === true ? { primary: true as const } : {}),
  };
}
