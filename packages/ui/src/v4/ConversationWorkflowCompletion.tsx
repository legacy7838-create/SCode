import { useMemo } from "react";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkflowCompletionCard,
  type WorkflowCompletionFigures,
} from "@/components/workflow-timeline/WorkflowCompletionCard.js";
import {
  completionArtifactLayout,
  completionPreviewIds,
} from "@/components/workflow-timeline/WorkflowCompletionArtifacts.js";
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useHasV4Conversation } from "@/v4/V4ConversationContext.js";
import type { WorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";

/**
 * Placement of the completion card: wiring the parsed completion facts to the host callbacks and
 * artifact fetching. The presence of a callback is the gate (following
 * `ConversationWorkflowDigests`): ⤢ needs `onOpenWorkflowRun` + sessionId + the linked
 * `toolCallId`; tiles and pills need `onOpenWorkflowArtifact`
 * + sessionId (no toolCallId needed, the same gate as the notification row).
 *
 * The artifact list is **based on the notification payload** (persisted with the notification, so
 * it survives a cold restore); when the session is present, the existing artifact hook fills in
 * byte counts / origin / kanban spec / deliverable flags, and attaches a preview to the
 * deliverable's frame. Hosts without session context (static rendering, replay) draw a cold-state
 * card with glyphs only — the same card, one layer fewer.
 */
export function ConversationWorkflowCompletion({
  completion,
  context,
  turnKey,
}: {
  completion: WorkflowTurnCompletion;
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const hasConversation = useHasV4Conversation();
  const sessionId = context.sessionId ?? undefined;
  const { summary } = completion;
  const run = summary?.run;

  const figures: WorkflowCompletionFigures = {
    ...(completion.durationMs === undefined ? {} : { durationMs: completion.durationMs }),
    ...(run === undefined
      ? {}
      : {
          tokens: run.usage.spentTokens,
          subagents: run.actors.length,
          // The card does not say "step": the fourth box is the number of stages advanced; unmarked scripts do not have it, so the box is written `—`.
          ...(run.phases !== undefined && run.phases.length > 0
            ? { phases: run.phases.length }
            : {}),
        }),
  };
  const onOpenRun =
    context.onOpenWorkflowRun && sessionId && summary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: sessionId,
            toolCallId: summary.toolCallId!,
            runId: completion.runId,
            workflowName: completion.name,
          })
      : undefined;
  // The open request is constructed based on the list currently on hand, so it is a factory that takes parameters based on the list rather than a closed callback:
  // The cold state only has notification payload (with `contentType`, without `sourcePath`), under the live path
  // `WorkflowCompletionWithData` takes the completed copy and recreates it, so that the source can be brought along. Host data `contentType`
  // To determine the html product, open the browser tab directly.
  const openArtifactFrom =
    context.onOpenWorkflowArtifact && sessionId
      ? (artifacts: readonly WorkflowCompletionArtifact[]) => (artifactId: string) => {
          const artifact = artifacts.find((candidate) => candidate.id === artifactId);
          context.onOpenWorkflowArtifact?.({
            parentSessionId: sessionId,
            runId: completion.runId,
            artifactId,
            ...(artifact?.title === undefined ? {} : { title: artifact.title }),
            ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
            ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
          });
        }
      : undefined;
  const onOpenArtifact = openArtifactFrom?.(completion.artifacts);

  const shared = {
    artifactsTruncated: completion.artifactsTruncated,
    figures,
    name: completion.name,
    testIdKey: turnKey,
    ...(onOpenRun === undefined ? {} : { onOpenRun }),
    ...(onOpenArtifact === undefined ? {} : { onOpenArtifact }),
  };

  if (!hasConversation || sessionId === undefined) {
    return <WorkflowCompletionCard {...shared} artifacts={completion.artifacts} />;
  }
  return (
    <WorkflowCompletionWithData
      completion={completion}
      live={run?.artifacts}
      sessionId={sessionId}
      shared={shared}
      theme={context.theme}
      {...(openArtifactFrom === undefined ? {} : { openArtifactFrom })}
    />
  );
}

/**
 * The list from the notification payload plus what the hook view adds. Order and identity belong to
 * the payload (it is the fact at the moment of the notification, and the deliverable is already
 * first); when the payload has been folded (over 8), the extra artifacts in the journal are
 * appended at the end, going into the index or the "{n} more" door. A flag or caption counts from
 * either source (older payloads have neither key, and the hook fills them back in from the
 * journal).
 */
function mergeCompletionArtifacts(
  base: readonly WorkflowCompletionArtifact[],
  views: readonly WorkflowRunArtifactView[],
): WorkflowCompletionArtifact[] {
  const byId = new Map(views.map((view) => [view.id, view] as const));
  const merged = base.map((artifact) => {
    const view = byId.get(artifact.id);
    if (view === undefined) return artifact;
    byId.delete(artifact.id);
    return {
      ...artifact,
      version: Math.max(artifact.version ?? 1, view.version),
      ...(view.contentType === undefined ? {} : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined ? {} : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
      itemCount: view.itemCount,
    } satisfies WorkflowCompletionArtifact;
  });
  for (const view of byId.values()) {
    merged.push({
      id: view.id,
      kind: view.kind,
      version: view.version,
      itemCount: view.itemCount,
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.contentType === undefined ? {} : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined ? {} : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
    });
  }
  return merged;
}

function WorkflowCompletionWithData({
  completion,
  live,
  openArtifactFrom,
  sessionId,
  shared,
  theme,
}: {
  completion: WorkflowTurnCompletion;
  live: readonly WorkflowRunArtifactSummary[] | undefined;
  /**
   * Factory for open requests; absent means the host supplied no open capability (the same gate as
   * `shared.onOpenArtifact`).
   */
  openArtifactFrom?: (
    artifacts: readonly WorkflowCompletionArtifact[],
  ) => (artifactId: string) => void;
  sessionId: string;
  shared: Omit<Parameters<typeof WorkflowCompletionCard>[0], "artifacts" | "renderPreview">;
  theme: ConversationRowRenderContext["theme"];
}) {
  const state = useWorkflowRunArtifacts({
    sessionId,
    runId: completion.runId,
    ...(live === undefined ? {} : { live }),
  });
  const artifacts = useMemo(
    () => mergeCompletionArtifacts(completion.artifacts, state.artifacts),
    [completion.artifacts, state.artifacts],
  );
  // `artifactsTruncated` says that the **notification payload** has been chopped at 8 pieces, while the list of drawings here has been made by live projection/
  // Journal completion (runs with many products are normal), `+N` and "N more" are still written with ellipsis according to the load flag - what the user sees
  // It's "there's one more", and the number is obviously already known. The flag is disabled when the list is complete; only the old CLI (journal cannot be found) or not yet
  // When the answer came up, it was still an ellipsis, and the number was indeed unknowable at that time.
  const artifactsTruncated = shared.artifactsTruncated === true && !state.complete;
  const renderPreview = (artifact: WorkflowCompletionArtifact) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version ?? 1}`}
      runId={completion.runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // Only the drawn boxes hang in the preview - today only the deliverable row has boxes; the index row and "N more" bytes are not read.
  const previewIds = useMemo(
    () => completionPreviewIds(completionArtifactLayout(artifacts, artifactsTruncated)),
    [artifacts, artifactsTruncated],
  );
  // The completed list recreates a callback: `sourcePath` that does not exist in the payload, `contentType` that does not exist in the old payload
  // They are all added back from the journal/living projection, and they are all available when you click on them.
  const onOpenArtifact = openArtifactFrom?.(artifacts);
  return (
    <WorkflowCompletionCard
      {...shared}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
      artifactsTruncated={artifactsTruncated}
      artifacts={artifacts}
      renderPreview={(artifact) =>
        previewIds.has(artifact.id) ? renderPreview(artifact) : undefined
      }
    />
  );
}
