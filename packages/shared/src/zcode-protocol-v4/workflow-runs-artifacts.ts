// ============================================================
// The user interface product part in workflowRuns reduction
// ============================================================
// Detached from workflow-runs-reducer.ts (max-lines gate), the same precedent as workflow-runs-concurrency.ts:
// The main reduction leaves only the assignment of switch, and the three rules of production live here. Same discipline: pure functions, no clocks, no I/O.
//
// ⚠ Terminology: The artifact of this module is the script
// `artifact.*` output published for **users** to see. Called by `resultPreview` in main reduction
// The artifact in `serializeWorkflowArtifact` (workflow-artifact.ts, singular) is **another meaning**
// ——The engine's internal name for "script top-level return value" is for the model to see. The two have nothing to do with each other.
//
// Each of the three rules has its own key. This is the most important sentence of this module:
//   artifact-published ⇒ press **product id** upsert. Re-release with the same ID is a new version and must cover the same card;
//                        The two versions of the same id come from two different **site instances**, so this cannot
//                        Use nodes/actors/reports with the (siteId, ordinal) key.
//   artifact-failed ⇒ inactive state (in the main reduction, there is only one return line). Failed line not claiming id /kind /
//                        version, there is nothing to upsert.
//   report(artifactId) ⇒ Increase the itemCount of this id by one. The deduplication key returns to (siteId, ordinal) - it is a
//                        report, the identity is still the identity of report.

import {
  WORKFLOW_ARTIFACT_LIMITS,
  type WorkflowRunArtifactKind,
  type WorkflowRunArtifactSummary,
} from "./workflow-artifacts.js";

/** The six member kinds of an artifact. The reduction does not validate a schema, so it carries its own closed-set table for interpretation. */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<WorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/**
 * `ArtifactVersionRecord` from an `artifact-published` payload → the **latest version** metadata
 * in the snapshot.
 *
 * `versions` / `spec` / `description` / `uri` / `sourcePath` / `publishedAt` are dropped: the
 * snapshot is a high-frequency state key, and its readers only need "which artifacts exist, what
 * version is current, did it change". Full metadata goes through the `workflowRunArtifacts` query,
 * bytes through `workflowRunArtifactRead` — the journal always stays authoritative.
 *
 * Missing any of `id` / `kind` / `version` means there is nothing to display (returns undefined,
 * only bumping the watermark): a card whose kind cannot be recognized can neither pick an icon
 * nor dispatch a renderer. The remaining fields are carried when present and the whole key is
 * absent when not.
 */
export function workflowArtifactSummary(value: unknown): WorkflowRunArtifactSummary | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const kind = nonEmptyString(value.kind);
  const version = value.version;
  if (id === undefined || kind === undefined || !ARTIFACT_KINDS.has(kind)) return undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const title = nonEmptyString(value.title);
  const contentType = nonEmptyString(value.contentType);
  const bytes = value.bytes;
  return {
    id: id.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: kind as WorkflowRunArtifactKind,
    ...(title === undefined
      ? {}
      : { title: title.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxTitleLength) }),
    version: Math.min(version, WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    ...(contentType === undefined ? {} : { contentType: contentType.slice(0, 128) }),
    ...(typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? { bytes } : {}),
    ...(value.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * Upserts into the bounded artifact table by **artifact id**, and **preserves the existing
 * entry's `itemCount`**.
 *
 * Preserving the count is the only substantive difference between this function and
 * `upsertBoundedByInstance`, and the reason it exists: a new version's record carries no
 * `itemCount` (that is tallied from tagged reports, not a fact at publish time), so a wholesale
 * replacement would zero out the count of a board that is still being fed data — the refresh
 * signal would go to zero and the board would never fetch deltas again.
 *
 * On hitting the bound, semantics are the same family as the other three tables: reject the new
 * entry, keep updating existing entries as usual.
 */
export function upsertBoundedByArtifactId(
  list: readonly WorkflowRunArtifactSummary[],
  entry: WorkflowRunArtifactSummary,
  limit: number,
): { list: WorkflowRunArtifactSummary[]; truncated: boolean } {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    const previous = list[index]!;
    const next = [...list];
    next[index] = {
      ...entry,
      ...(previous.itemCount === undefined ? {} : { itemCount: previous.itemCount }),
    };
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/**
 * A tagged `report` lands on some artifact: increment that id's `itemCount`.
 *
 * When the table has no such id, the **count is ignored** (the original table is returned, and the
 * entry still goes into `reports` as usual). This is impossible at runtime — the tag of
 * `report(item, tag)` must first have been declared as a preset artifact, otherwise the engine
 * fails the run — so this is purely defensive: under out-of-order events or truncated payloads,
 * it is better to lose one count than to conjure a card that has no spec and cannot be rendered.
 *
 * **The direction of the count's inaccuracy is intentional.** The dedup key (siteId, ordinal)
 * comes from the `reports` table, and that table refuses new entries past 64 — once over the
 * bound, a replayed tagged report cannot recognize itself as a replay and counts once extra. That
 * direction was chosen because `itemCount`'s only job is a **refresh signal**: counting once extra
 * makes the board send one more incremental query carrying `afterSequence` and get back zero rows,
 * which is harmless; counting once short (for instance by changing it to "stop counting once over
 * the bound") would freeze the line chart forever at the 64th point, and that is precisely the
 * reason this feature exists. Once the bound is hit `truncated` is already set, so readers know
 * that both `reports` and `itemCount` are approximations; the entry's **authoritative** count
 * lives in the journal, reachable by paging through `workflowRunArtifactData`.
 */
export function countTaggedReport(
  list: readonly WorkflowRunArtifactSummary[] | undefined,
  artifactId: string,
): WorkflowRunArtifactSummary[] | undefined {
  if (list === undefined) return undefined;
  const index = list.findIndex((item) => item.id === artifactId);
  // Return undefined = **This key does not need to be touched**: The caller does not write artifacts at all, so idempotent replay results
  // byte-for-byte identical run objects, the top-level JSON comparison then returns null.
  if (index < 0) return undefined;
  const previous = list[index]!;
  const next = [...list];
  next[index] = { ...previous, itemCount: (previous.itemCount ?? 0) + 1 };
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
