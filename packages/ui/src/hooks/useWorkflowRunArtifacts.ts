import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkflowRunArtifact,
  WorkflowRunArtifactKind,
  WorkflowRunArtifactSummary,
  WorkflowRunArtifactVersion,
} from "@zcode/shared/zcode-protocol-v4";
import { orderArtifactsPrimaryFirst } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * ⚠ Terminology: the artifact in this module is an **output a script publishes to the user through
 * `artifact.*`**, not the engine-internal homonym "the script's top-level return value".
 */

/**
 * A merged view of one artifact: **fresh metadata** from the live projection + **complete
 * metadata** from the journal (version history and spec).
 *
 * Neither source can be dropped, so this type is their union rather than an either/or:
 * - The live projection (`workflowRuns[].artifacts`) deliberately carries only the latest version's
 *   metadata — it is a high-frequency state key, and carrying the spec and every version would make
 *   each frame resend data that never changes;
 * - The journal query carries `versions` and `spec`, and **the preset dashboard cannot be drawn
 *   without the spec**, so a journal query still has to be issued even when the run is right there
 *   in the live projection.
 */
export interface WorkflowRunArtifactView {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  /** Byte size of the latest version (content artifacts only). */
  bytes?: number;
  /**
   * Original path relative to the workspace (only `file` artifacts have it) — "Show in workspace"
   * locates the file by it.
   */
  sourcePath?: string;
  /** Latest version number. */
  version: number;
  /**
   * Versions in ascending order; the key is absent entirely when the journal query is missing (old
   * CLI / read failure), and the version stepper then degrades to the latest version only.
   */
  versions?: readonly WorkflowRunArtifactVersion[];
  /**
   * The spec of the preset dashboard; likewise absent when the journal query is missing, so the
   * dashboard card falls back to "details unavailable".
   */
  spec?: unknown;
  /**
   * The number of report entries tagged with this id — the **refresh signal** for the dashboard
   * data hook.
   */
  itemCount: number;
  /** The deliverable of the run; either source carrying it is enough. */
  primary?: true;
}

interface WorkflowRunArtifactsViewState {
  artifacts: readonly WorkflowRunArtifactView[];
  /**
   * The **primary** source of the metadata. `live` = the run is still in the live projection (the
   * journal is then only used to fill in spec / versions); `journal` = cold recovery, or eviction
   * by the 8-run cap, so the whole list comes from the journal.
   *
   * It is not a marker for "whether the journal was queried" — both cases query it — but rather an
   * observable criterion for readers and tests: did this list grow in real time along with the run,
   * or was it read back from the log afterwards.
   */
  source: "live" | "journal";
  loading: boolean;
  /**
   * The session does not support artifact queries (old CLI): content artifacts are still listable,
   * but the preset dashboard cannot be drawn.
   */
  unavailable: boolean;
  error: string | null;
  /**
   * This list is **complete**: the live projection is present (its cap of 32 is the engine's
   * per-run cap, so it is never cut), or the journal has already answered. The completion card uses
   * it to decide whether `+N` shows a number or an ellipsis — the notification payload is cut at 8
   * items, and that is a fact about the **payload**, not about the list drawn here; when the
   * capability is missing (old CLI) the list may genuinely be incomplete and still stays false.
   */
  complete: boolean;
}

/**
 * A missing capability (the CLI has none of the host queries `listArtifacts` relies on) must be
 * distinguishable from "this run has no artifacts": the former has to make the preset card say
 * "details unavailable", the latter leaves the whole region absent. The criterion is read the same
 * way as in `useWorkflowRunJournalSummaries` — once an error crosses JSON-RPC only the message is
 * reliable, so both the reasonCode and the capability name are matched.
 */
function isWorkflowRunArtifactsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactRows");
}

/**
 * The **shape signature** of that set of summaries in the live projection: `id:kind:version`
 * concatenated entry by entry.
 *
 * What triggers a journal re-query is this signature rather than a reference to the whole array:
 * every arriving `report` in the projection creates a new array (`itemCount` changed), but a change
 * in entry count **does not** change any artifact's version or spec — using the reference as the
 * dependency would make a dashboard that reports every turn re-query the journal on every turn.
 * Conversely, a new artifact appearing and a new version of the same id both change this signature,
 * and those two things are exactly what **must** trigger a re-query (a new artifact needs its spec,
 * a new version needs its versions).
 */
function summariesSignature(summaries: readonly WorkflowRunArtifactSummary[] | undefined): string {
  if (summaries === undefined) return "";
  return summaries.map((summary) => `${summary.id}:${summary.kind}:${summary.version}`).join("|");
}

function viewFromJournal(record: WorkflowRunArtifact): WorkflowRunArtifactView {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
    ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    // Journal entries carry no bytes (bytes live on the version), so take them from the latest version.
    ...(() => {
      const latest = record.versions.at(-1);
      return latest?.bytes === undefined ? {} : { bytes: latest.bytes };
    })(),
    version: record.version,
    versions: record.versions,
    itemCount: record.itemCount,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function viewFromSummary(summary: WorkflowRunArtifactSummary): WorkflowRunArtifactView {
  return {
    id: summary.id,
    kind: summary.kind,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.contentType === undefined ? {} : { contentType: summary.contentType }),
    ...(summary.bytes === undefined ? {} : { bytes: summary.bytes }),
    version: summary.version,
    itemCount: summary.itemCount ?? 0,
    ...(summary.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * Merges the two sources. **Order and identity are decided by the live projection** (it is the copy
 * that is growing along with the run); the journal only fills in the fields the live projection
 * deliberately leaves out, and ids present in the journal but absent from the live projection are
 * appended at the end — those artifacts still really exist after the projection's cap of 32
 * rejected new ones, and dropping them would make a full run's artifacts vanish into thin air.
 *
 * The deliverable leads afterwards (the rest stay in first-publish order): the live projection is
 * upserted in publish order and the journal path was already sorted, and the two paths converge on
 * the same order here.
 */
function mergeArtifacts(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  return orderArtifactsPrimaryFirst(mergeArtifactSources(live, journal));
}

function mergeArtifactSources(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  if (live === undefined) {
    return journal === undefined ? [] : journal.map(viewFromJournal);
  }
  const byId = new Map((journal ?? []).map((record) => [record.id, record] as const));
  const merged = live.map((summary) => {
    const record = byId.get(summary.id);
    if (record === undefined) return viewFromSummary(summary);
    byId.delete(summary.id);
    // Take the version from the live projection (the journal query may lag one publish); spec / versions only exist on the journal.
    // `itemCount` also comes from the live projection: it is the refresh signal, and a lagging beat means one fewer point drawn.
    return {
      ...viewFromJournal(record),
      ...viewFromSummary(summary),
      ...(record.versions.length === 0 ? {} : { versions: record.versions }),
      ...(record.spec === undefined ? {} : { spec: record.spec }),
      ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
      ...(record.description === undefined ? {} : { description: record.description }),
    } satisfies WorkflowRunArtifactView;
  });
  return [...merged, ...[...byId.values()].map(viewFromJournal)];
}

/**
 * The artifact list of a workflow run.
 *
 * ```
 * Live projection workflowRuns[].artifacts ─┐
 *   (fresh, no spec, cap 32)                ├─▶ merge ─▶ artifacts[]
 * Journal workflowRunArtifacts ─────────────┘
 *   (complete, includes versions + spec)
 * ```
 *
 * The journal query is issued in **both** cases: when the live projection is present, to fill in
 * spec / versions (the dashboard cannot be drawn without the spec); when the live projection is
 * absent, it is the only source (cold recovery / evicted by the 8-run cap). What triggers a
 * re-query is a change in the summaries' **shape signature**, not the array reference — see
 * `summariesSignature`.
 */
export function useWorkflowRunArtifacts(options: {
  sessionId: string;
  runId: string;
  /**
   * The artifact summaries of that run in the live projection. `undefined` = the run is not in the
   * live projection (`source` is then `journal`); an empty array = the run is present with zero
   * artifacts. The two mean different things, and callers must not collapse the former into the
   * latter.
   */
  live?: readonly WorkflowRunArtifactSummary[];
  enabled?: boolean;
}): WorkflowRunArtifactsViewState {
  const { workflowRunArtifacts } = useV4Conversation();
  const [journal, setJournal] = useState<readonly WorkflowRunArtifact[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request version: late responses after a run switch / session switch must be discarded and must not pollute the new run's list.
  const requestVersionRef = useRef(0);

  const enabled =
    options.enabled !== false && options.sessionId.length > 0 && options.runId.length > 0;
  const signature = summariesSignature(options.live);
  const { sessionId, runId } = options;

  const fetchArtifacts = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await workflowRunArtifacts({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setJournal(result.artifacts);
      setUnavailable(false);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunArtifactsCapabilityMissing(caught)) {
        // Capability absence is not an error: cards for content artifacts can still be drawn from the live projection, only dashboards cannot.
        setJournal(undefined);
        setUnavailable(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-artifacts] failed to read the artifact list", {
        error: message,
        runId,
        sessionId,
      });
      setError(message);
    }
  }, [runId, sessionId, workflowRunArtifacts]);

  useEffect(() => {
    // Switch run / switch session: drop the old run's list first, then refetch. Leaving old artifacts on screen is far more dangerous than a blank.
    requestVersionRef.current += 1;
    setJournal(undefined);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchArtifacts();
    // The signature is a deliberate dependency: a new artifact appearing / a new version of the same id both require a refetch; an `itemCount` change does not.
  }, [enabled, fetchArtifacts, signature]);

  return useMemo(
    () => ({
      artifacts: mergeArtifacts(options.live, journal),
      source: options.live === undefined ? "journal" : "live",
      loading,
      unavailable,
      error,
      complete: options.live !== undefined || journal !== undefined,
    }),
    [error, journal, loading, options.live, unavailable],
  );
}
