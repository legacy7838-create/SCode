// ============================================================
// Journal reading surface of user surface products (the access base shared by the three product methods of DynamicWorkflowRunPort)
// ============================================================
//
// ⚠ Terminology: The artifact here is the output of the script published to **users** through `artifact.*`, not internal to the engine
// `RunSettlement.artifact` (script top-level return value).

import type { DwfArtifactItem, DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunArtifactItem } from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/**
 * A journal that carries the artifact read surface. The **only** source of the signature is
 * adapters' {@link DwfRunIntrospectionQueries} (`import type`, zero runtime dependency) - the
 * same argument as for `DynamicWorkflowIntrospectableJournal`: these two queries are not on the
 * engine's {@link JournalStorePort} (the engine never enumerates artifacts and never joins the
 * event table), so they can only be wired up by capability detection.
 */
interface ArtifactReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listArtifactItems" | "listArtifactRows"> {}

/**
 * Whether the journal carries the artifact read surface. **Deliberately a sibling of
 * `supportsRunIntrospection` rather than an extension of it to six queries.**
 *
 * Those four (listRuns / getRunRow / countNodesByStatus / listRecentLogEvents) are one whole
 * capability: the list needs one, the detail needs the other three, and missing any one of them
 * should degrade the whole. The artifact read surface is a **second** capability that grew up
 * **later**, and the two do not depend on each other - a journal with only the first four (an old
 * adapter's dist, a test double that only implements introspection) should keep serving
 * `ListWorkflowRuns` / `GetWorkflowRun`, just without artifacts. Folding them into one probe
 * would make two long-working tools silently vanish for such journals, and the symptom would be
 * an awfully long way from the cause.
 */
export function supportsArtifactReads(journal: JournalStorePort): journal is ArtifactReadableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.listArtifactItems === "function" &&
    typeof candidate.listArtifactRows === "function"
  );
}

/**
 * The `report` entries feeding one preset artifact, in ascending journal sequence order.
 *
 * The storage layer honours limit **exactly** and never clamps by itself - so "fetch one extra
 * row to decide hasMore" is done by the caller (the gateway) passing limit+1, forwarded verbatim
 * here. An out-of-range cursor gets an empty page instead of an error: running into the end is a
 * normal paging outcome, not an anomaly.
 */
export function listArtifactItemsFrom(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  page: { afterSequence?: number; limit: number },
): DynamicWorkflowRunArtifactItem[] {
  if (!supportsArtifactReads(journal)) return [];
  const rows = journal.listArtifactItems(runId, artifactId, {
    ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
    limit: page.limit,
  });
  return rows.map(toArtifactItem);
}

/**
 * One storage row -> one port entry. The fields map one-to-one, and there is deliberately **no
 * preview serialization**: the board's pure functions fetch by field path (`ChartSpec.x.field`, of
 * the form "timing.after"), and a chunk of pretty JSON text cannot be fetched from. Entries are
 * already bounded on the wire by `REPORT_CAPS.maxItemSerializedBytes` (32KB), so there is no need
 * for a second layer.
 */
function toArtifactItem(row: DwfArtifactItem): DynamicWorkflowRunArtifactItem {
  return {
    sequence: row.sequence,
    siteId: row.siteId,
    ordinal: row.ordinal,
    item: row.item,
  };
}

/**
 * The artifact id claimed by one artifact node row.
 *
 * Prefer the `dwf_node.artifact_id` column (the indexed one added by a newer migration); the
 * record's `id` is only a fallback. The engine writes both in the same putNode, so they are
 * always equal, but an old row whose column is NULL should not make the whole row unreadable.
 */
export function artifactRowId(row: NodeRecord): string | undefined {
  if (typeof row.artifactId === "string" && row.artifactId.length > 0) return row.artifactId;
  const record = row.result;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const id = (record as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
