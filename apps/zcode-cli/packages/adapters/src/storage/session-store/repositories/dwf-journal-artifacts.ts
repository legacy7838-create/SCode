/**
 * The two host read surfaces for user-facing **artifacts**.
 *
 * ⚠ The artifact here is the deliverable a script **publishes for the user to see** (file / markdown / preseeded
 * dashboard), not `RunSettlement.artifact` (the script's top-level return value). Both senses coexist.
 *
 * Why it lives **outside** `JournalStorePort`: the exact same argument as for `listRuns` — the engine only walks its
 * own ordinal chain via `listNodes` and is never responsible for "which artifacts does this run have" or "which entries
 * has a given dashboard received". Adding them to the domain port amounts to requiring every journal implementation
 * (including the engine's own in-memory one) to implement something the engine does not do. Consumers probe by
 * capability (`typeof journal.listArtifactRows === "function"`) to decide whether the read surface is available; the
 * single source of truth for the signature is `DwfRunIntrospectionQueries`.
 *
 * Why it lives **outside** dwf-journal.ts: the two queries only need one db handle (no shared state with the
 * write-read path of run/actor/node/event), and each carries a long argument for "why this table is the data source, why this is the sort order". The same split as dwf-journal-codecs.ts.
 */

import type { DwfJournalClient } from "@zcode/rust/events";
import type { NodeRecord } from "@zcode/dynamic-workflow";
import { decodeNode, type DwfEventRow, type DwfNodeRow } from "./dwf-journal-codecs.js";

/** The pagination bag for {@link listArtifactItems} (cursor = journal sequence). */
export interface DwfArtifactItemsQuery {
  /**
   * Returns only entries whose sequence is **strictly greater** than this value. The cursor is "the last sequence already read" and not an offset, with exactly the same semantics as `listEvents` — the
   * dashboard hook uses the very cursor it was already using.
   */
  afterSequence?: number;
  /**
   * Upper bound on entries per page, **required**. The storage layer does not guess a default for the caller: an
   * unbounded fetch query is the one shape that should never exist here.
   *
   * But **do not add your own ceiling here** (such as `Math.min(500, limit)`). Callers legitimately pass "clamped limit + 1" to determine `hasMore` (the extra row fetched does not go into the page) — a hard cap would
   * silently swallow the probe row, so `hasMore` would be permanently absent whenever limit equals the cap. The exact same argument as the truncation probe row of `DwfListRunsQuery.limit`.
   */
  limit: number;
}

/**
 * A `report` entry fed to a preseeded artifact, **addressed by journal sequence**.
 *
 * Why the key is the sequence rather than (siteId, ordinal): the UI's incremental fetch cursor is that same journal sequence (`afterSequence`, the shape used by
 * the run event query), and dwf_node has no such column. The site coordinates are still returned alongside the row — the reveal animation needs a
 * React key that stays stable across refetches, and both the sequence and the coordinates satisfy that.
 */
export interface DwfArtifactItem {
  /** The reported item's original value (arbitrary JSON; `REPORT_CAPS` already guarantees a bound on the write side). */
  item: unknown;
  ordinal: number;
  sequence: number;
  siteId: string;
}

/**
 * This run's **artifact rows** (`kind = 'artifact'`), in insertion order (`order by id`).
 *
 * One row = one version (publishing again under the same id is a new row, history is kept), so callers group by `artifactId` and take the
 * version from each row's `result` (`ArtifactVersionRecord`). The ordering is **insertion order** rather than `order by artifact_id, ordinal`: the
 * order of the versions is the order they were written, and the rows of the same id being adjacent is only a coincidence — building the
 * display order on top of that would make the versions of an interleaved script look out of order.
 *
 * Failed publications are in the result too (`status: "failed"` + `error`): the read surface has to be able to say "this publication did not
 * succeed", and filtering it out amounts to making a user-visible failure not exist on any surface.
 */
export function listArtifactRows(db: DwfJournalClient, runId: string): NodeRecord[] {
  const rows = db.exec<DwfNodeRow[]>("listArtifactRows", { runId });
  return rows.map(decodeNode);
}

/**
 * `report` entries fed to a preseeded artifact, paginated in ascending journal sequence (the dashboard's fetch surface).
 *
 * The data source is **dwf_event and not dwf_node**, even though both tables record the same batch of tagged reports. The reason
 * is the cursor: the UI pulls incrementally using the event log's `sequence`, and dwf_node has no sequence, only a composite
 * (siteId, ordinal) coordinate — faking a total order on top of it amounts to inventing a second cursor semantics for the
 * same data. So the filter is pushed down to `json_extract(payload_json, '$.artifactId') = ?`, and `dwf_event_artifact_idx`
 * (the expression index from 0029) has exactly this shape.
 *
 * `type = 'report'` is part of the condition as well: the `type` column is a redundancy kept for pushdown (the payload carries a
 * copy too). Without it, some other kind of event that happens to carry `artifactId` (today there is only `artifact-published`,
 * which carries a nested `artifact.id` rather than a top-level `artifactId`, but tomorrow is not guaranteed) would slip into the
 * dashboard's data stream.
 *
 * Untagged reports are naturally excluded: their payload simply has no `artifactId` key, `json_extract` yields NULL, and SQL's `= ?` does not match NULL.
 */
export function listArtifactItems(
  db: DwfJournalClient,
  runId: string,
  artifactId: string,
  query: DwfArtifactItemsQuery,
): DwfArtifactItem[] {
  // limit ≤ 0 is an empty page (floor here, no ceiling — see {@link DwfArtifactItemsQuery.limit}).
  if (query.limit <= 0) return [];
  const rows = db.exec<Pick<DwfEventRow, "payload_json" | "sequence">[]>("listArtifactItems", {
    runId,
    artifactId,
    afterSequence: query.afterSequence,
    limit: query.limit,
  });
  return rows.map((row) => {
    // The payload is the `RunEvent` that is stringified by appendEvent as is, so the narrow shape here is the same as
    // `{ type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }` has the same origin.
    const payload = JSON.parse(row.payload_json) as {
      instance: { ordinal: number; siteId: string };
      item: unknown;
    };
    return {
      sequence: row.sequence,
      siteId: payload.instance.siteId,
      ordinal: payload.instance.ordinal,
      item: payload.item,
    };
  });
}
