// ============================================================
// Dynamic Workflow Run: merged projection of user plane artifacts (journal line → port artifacts)
// ============================================================
// dynamic-workflow-run-observation.ts reaches the upper limit of oxlint max-lines (400 lines), and the entire paragraph
// The artifacts ({@link artifactsOf} and its private decoder) are merged into this file. Export the observation surface as it is, four
// The call point (snapshot/getRunDetail/listArtifacts/saved-workflows hub) therefore does not need to change a single line.
//
// ⚠ Terminology: The artifact here is the output of the script published to the user via `artifact.*` **(journal
// `kind = "artifact"` line), not the engine-internal `RunSettlement.artifact` (the top-level return value of the script, on the port
// called `output` / `result`). Two meanings of the same word.

import type { DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactKind,
  DynamicWorkflowRunArtifactVersion,
} from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/**
 * The terminal-state snapshot and the `artifacts` on `getRunDetail`: **user-facing artifacts**.
 *
 * ⚠ Terminology: an artifact here is an output a script publishes for the user through `artifact.*` (journal
 * rows with `kind = "artifact"`), **not** the engine-internal `RunSettlement.artifact` (the script's top-level
 * return value, called `output` / `result` on the port). One word, two meanings.
 *
 * The sourcing follows the same rule as `reportsOf` on the observation side — the journal is the **durable home** of the version history (the memory-only
 * `workflowRuns.artifacts` projection carries only the latest metadata and is empty after a cold recovery), while a failed / cancelled run
 * must still hand over the artifacts it already published (a run that died at step 12 still delivered the earlier chart).
 *
 * `listArtifactRows` is not on the engine's {@link JournalStorePort} (the engine never enumerates or aggregates), so it is hooked up by the
 * house rule of **capability probing**: absent means the whole field is absent instead of throwing — the injected test store and the implementations
 * without introspection queries must keep working.
 *
 * Merge rules:
 *   - Only `completed` rows are collected. A failed publish takes neither an id nor a version number; counting it in the version
 *     history would make "version 3" in the UI point at bytes that never existed.
 *   - Rows with the same id are ordered by `version` ascending; `title` / `contentType` / `sourcePath` / `spec` and the rest that are lifted to
 *     the top level are the **latest** values, so a reader who only cares about "what is it now" need not dig through the versions himself.
 *   - `itemCount` = the number of `report` rows tagged with this id (the data volume of a preset board, and also the UI's refresh signal).
 *     Content artifacts are always 0.
 *
 * `nodes` is the node list the caller already has in hand (on the snapshot path one and the same `listNodes` call feeds both reports and this function);
 * when absent, fetch it here. When only partially available, the whole field is absent — an empty array reads like "it ran but produced nothing", whereas absence means "this run
 * has no such concept as artifacts".
 */
export function artifactsOf(
  runId: string,
  journal: JournalStorePort,
  nodes?: readonly NodeRecord[],
): { artifacts?: readonly DynamicWorkflowRunArtifact[] } {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  if (typeof candidate.listArtifactRows !== "function") return {};
  const rows = candidate.listArtifactRows(runId);
  if (rows.length === 0) return {};

  // id → version accumulator. Insertion order = first occurrence order, which is the order of `artifacts` on the port contract.
  const byId = new Map<
    string,
    { kind: DynamicWorkflowRunArtifactKind; versions: DynamicWorkflowRunArtifactVersion[] }
  >();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const record = row.result;
    if (record === null || typeof record !== "object") continue;
    const version = artifactVersionOf(record as Record<string, unknown>);
    if (version === undefined) continue;
    const id =
      typeof row.artifactId === "string" && row.artifactId.length > 0
        ? row.artifactId
        : stringField(record as Record<string, unknown>, "id");
    const kind = artifactKindOf((record as Record<string, unknown>).kind);
    if (id === undefined || kind === undefined) continue;
    const bucket = byId.get(id);
    if (bucket === undefined) byId.set(id, { kind, versions: [version] });
    else bucket.versions.push(version);
  }
  if (byId.size === 0) return {};

  // The tag count only scans the node table when there is a preset Kanban board: the `itemCount` of the content product is always 0, and `listNodes`
  // It is a full table decoding. There are 50 lines in the hub page, and this function is called once for each line. This short circuit is the only blocker on that path.
  const needsTally = [...byId.values()].some((bucket) => PRESET_ARTIFACT_KINDS.has(bucket.kind));
  const itemCounts = needsTally ? tagItemCounts(nodes ?? journal.listNodes(runId)) : undefined;
  const artifacts = [...byId].map(([id, bucket]) => {
    const versions = [...bucket.versions].sort((left, right) => left.version - right.version);
    // Latest version = the one with the largest version number. Empty bucket is not possible (at least one during construction).
    const latest = versions[versions.length - 1]!;
    // The flag is attached by id (the engine guarantees that it will be included in subsequent versions), and it will be included in any version - the line dropped by the old CLI does not have this key.
    const primary = versions.some((version) => version.primary === true);
    return {
      id,
      kind: bucket.kind,
      ...(latest.title === undefined ? {} : { title: latest.title }),
      ...(latest.description === undefined ? {} : { description: latest.description }),
      ...(latest.contentType === undefined ? {} : { contentType: latest.contentType }),
      ...(latest.sourcePath === undefined ? {} : { sourcePath: latest.sourcePath }),
      ...(latest.spec === undefined ? {} : { spec: latest.spec }),
      version: latest.version,
      versions,
      itemCount: itemCounts?.get(id) ?? 0,
      ...(primary ? { primary: true as const } : {}),
    } satisfies DynamicWorkflowRunArtifact;
  });
  // Deliverables take the lead, the rest remain in first release order:
  // The order is determined here once. Snapshot/GetWorkflowRun/hub/v4 queries are all read from here. No upper bound can cut it.
  // `Array.prototype.sort` is stable since ES2019, so the relative order between non-primary objects does not change.
  artifacts.sort((left, right) => Number(right.primary === true) - Number(left.primary === true));
  return { artifacts };
}

/** Per-id count of the tagged report rows (`kind = "report" ∧ artifact_id = ?` — the data volume of the board). */
function tagItemCounts(nodes: readonly NodeRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== "report" || node.artifactId === undefined) continue;
    counts.set(node.artifactId, (counts.get(node.artifactId) ?? 0) + 1);
  }
  return counts;
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/** The four members of a preset board: only they are fed by tagged `report`; `itemCount` for a content artifact is always 0. */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "chart",
  "table",
  "metrics",
  "board",
]);

function artifactKindOf(value: unknown): DynamicWorkflowRunArtifactKind | undefined {
  return typeof value === "string" && ARTIFACT_KINDS.has(value)
    ? (value as DynamicWorkflowRunArtifactKind)
    : undefined;
}

/**
 * `ArtifactVersionRecord` on `dwf_node.result_json` → the port's version item. The row shape comes from the engine and
 * the driver, but it has been through a JSON round trip and may come from an older CLI, so every field is narrowed defensively: if `version`
 * is not a positive integer the whole row is dropped (a version with no version number cannot be located in the UI, nor can its bytes be read).
 */
function artifactVersionOf(
  record: Record<string, unknown>,
): DynamicWorkflowRunArtifactVersion | undefined {
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const bytes = record.bytes;
  // The driver always writes `publishedAt`, which is optional depending on the engine type. Give 0 in absence instead of dropping rows:
  // A product without a timestamp is still viewable, and throwing it away leaves a hole in the UI for the version number.
  const publishedAt = typeof record.publishedAt === "number" ? record.publishedAt : 0;
  const title = stringField(record, "title");
  const description = stringField(record, "description");
  const contentType = stringField(record, "contentType");
  const uri = stringField(record, "uri");
  const sourcePath = stringField(record, "sourcePath");
  return {
    version,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(typeof bytes === "number" && Number.isFinite(bytes) ? { bytes } : {}),
    ...(uri === undefined ? {} : { uri }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    publishedAt,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
