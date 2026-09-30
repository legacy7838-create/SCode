// Image replay, reseeding and interrupted notice during cold start/restore session.
//
// Three disciplines:
//   1. The running state **only** comes from the playback: `replayWorkflowRuns` is handed over by the journal cast in sequence order, and the live
//      The same kind of progress envelope, fed to the shared reducer one by one - ordered real event replay will not make the phase fall back (the ban is for
//      The prohibition on "using abstracts to synthesize out-of-order events" still holds: abstracts only supplement display names).
//   2. When reseeding, only the display name is moved: label / updatedAt; no status is created, no resumable is created (that is the status bit, moved by the reducer).
//   3. There is no second clock: it is only checked once when mounting and app replacement, without polling or setInterval.
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiListWorkflowRuns, TuiReplayWorkflowRuns, TuiWorkflowRunSummary } from "./types.js";
import type { TuiWorkflowRunSeed } from "./app-workflow-mirror.js";

/** summary -> the seed entry. It only carries over the display facts the server gave, and defaults stay default everywhere (no label is invented). */
function workflowRunSeedFromSummary(summary: TuiWorkflowRunSummary): TuiWorkflowRunSeed {
  return {
    runId: summary.runId,
    ...(summary.label === undefined ? {} : { label: summary.label }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
  };
}

/** One notice text. When label is absent it falls back to runId — a list missing one label is a degradation, not an error. */
function workflowInterruptedNoticeText(seed: TuiWorkflowRunSeed, copy: TuiCopy): string {
  return copy.transcript.workflow.interruptedNotice({
    label: seed.label ?? seed.runId,
    runId: seed.runId,
  });
}

/**
 * Appends the notice rows of resumable runs to the transcript. No runs means zero output (an Excludes case in the spec).
 *
 * It uses system rows rather than faking user rows: this is not something the user said.
 */
function appendWorkflowInterruptedNotices(
  messages: Message[],
  seeds: readonly TuiWorkflowRunSeed[],
  copy: TuiCopy,
): Message[] {
  if (seeds.length === 0) return messages;
  return [
    ...messages,
    ...seeds.map((seed) => ({
      content: workflowInterruptedNoticeText(seed, copy),
      role: "system" as const,
    })),
  ];
}

/**
 * The runs to surface after startup / `/resume`: the ones the server calls `resumable`.
 *
 * **Deliberately unsorted**: `updatedAt` is a pure display field and the port's own comment explicitly forbids using it to reorder on the read side — ordering is the storage layer's job
 * (most recently updated first), and sorting again on the read side would drift from the server's tie-break.
 */
function interruptedWorkflowNotices(
  summaries: readonly TuiWorkflowRunSummary[],
): readonly TuiWorkflowRunSeed[] {
  return summaries.filter((summary) => summary.resumable === true).map(workflowRunSeedFromSummary);
}

/**
 * On mount, replay first, then seed once.
 *
 * The order matters here: the replay lands first, so a card shows real step counts the moment it appears; the seed afterwards only supplies names. A failure of both queries must not keep
 * the TUI from starting — the live events will still draw the in-flight runs.
 *
 * The callback is called indirectly through a ref, and only the identity of the two query functions goes into the dependencies: the argument object is new on every render, and depending on it directly
 * would make this effect re-run the query on every render (and that would be a second clock).
 */
export function useWorkflowRunSeeding(input: {
  copy: TuiCopy;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  /** The runs already in the mirror (those whose events this process has already received) — the replay excludes them. */
  knownRunIds: () => ReadonlySet<string>;
  replay: (envelopes: readonly WorkflowRunProgressEnvelope[]) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): void {
  const latest = React.useRef(input);
  latest.current = input;
  const { listWorkflowRuns, replayWorkflowRuns } = input;

  React.useEffect(() => {
    if (!listWorkflowRuns && !replayWorkflowRuns) return;
    let cancelled = false;
    void (async () => {
      if (replayWorkflowRuns) {
        try {
          const envelopes = await replayWorkflowRuns({
            excludeRunIds: latest.current.knownRunIds(),
          });
          if (cancelled) return;
          if (envelopes.length > 0) latest.current.replay(envelopes);
        } catch {
          // Failure to replay should not keep TUI from getting up.
        }
      }
      if (!listWorkflowRuns) return;
      let summaries: readonly TuiWorkflowRunSummary[];
      try {
        summaries = await listWorkflowRuns();
      } catch {
        return;
      }
      if (cancelled || summaries.length === 0) return;
      latest.current.seed(summaries.map(workflowRunSeedFromSummary));
      // The order is server-side order (most recently updated first) - port annotations disable read-side reordering.
      const resumable = interruptedWorkflowNotices(summaries);
      if (resumable.length === 0) return;
      latest.current.setMessages((current) =>
        appendWorkflowInterruptedNotices(current, resumable, latest.current.copy),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [listWorkflowRuns, replayWorkflowRuns]);
}
