import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { TID_WORKFLOW_ARTIFACT_PANE } from "@zcode/shared";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  canRevealArtifactInWorkspace,
  isArtifactPresetKind,
  isTextArtifactContentType,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactBody } from "@/app-shell/workflow-artifacts/WorkflowArtifactBody.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import { joinFilePath } from "@/lib/path.js";
import type { WorkflowArtifactSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme, type Theme } from "@/useTheme.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * Stable empty summary list: the `artifacts` key is **absent** when there are zero artifacts, and
 * collapsing it into a freshly built `[]` on every frame would change the merge hook's dependency
 * every frame, so the journal would be re-queried on every frame.
 */
const EMPTY_SUMMARIES: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowArtifactContent = memo(function WorkflowArtifactContent({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");

  // Subscribe to the projection of **parent session** (as per PlanDetail / WorkflowRun details page): the fresh metadata of the product is the parent session
  // Part of the shadow, not local cache of this panel.
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const run = useMemo(
    () => state.snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [state.snapshot?.workflowRuns, tab.runId],
  );
  // run is not in the live projection (cold recovery / eliminated by 8-run cap) ⇒ entire list goes to journal; present but zero products ⇒ empty array.
  const live = run === undefined ? undefined : (run.artifacts ?? EMPTY_SUMMARIES);
  const {
    artifacts,
    loading: metadataLoading,
    unavailable,
  } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(live === undefined ? {} : { live }),
  });

  const artifact = useMemo(
    () => artifacts.find((candidate) => candidate.id === tab.artifactId),
    [artifacts, tab.artifactId],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-artifact-source={live === undefined ? "journal" : "live"}
      data-testid={TID_WORKFLOW_ARTIFACT_PANE}
      data-workflow-artifact-id={tab.artifactId}
      data-workflow-run-id={tab.runId}
    >
      {artifact === undefined ? (
        // The three states must be separated: still reading / product details cannot be read in this session (old CLI) / finished reading but the id is not there
        // (The journal of run has been cleared, or the product pointed to by chip does not exist). Combined into a sentence of "reading"
        // The result is that the last situation is always stuck on loading copy.
        <div className="flex h-full items-center justify-center p-6 text-center">
          <p
            className="text-ui-base text-foreground-subtle"
            data-testid="workflow-artifact-placeholder"
          >
            {intl.formatMessage({
              id: metadataLoading
                ? "chat.toolCall.workflow.run.artifacts.loading"
                : unavailable
                  ? "chat.toolCall.workflow.run.artifacts.unavailable"
                  : "chat.toolCall.workflow.run.artifacts.missing",
            })}
          </p>
        </div>
      ) : (
        <WorkflowArtifactView
          artifact={artifact}
          metadataLoading={metadataLoading}
          tab={tab}
          theme={theme}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
        />
      )}
    </div>
  );
});

/**
 * Header + body. Mounted only once the artifact is known to be present, so the byte and item hooks
 * can be called unconditionally here (on a frame with no artifact this component is not rendered at
 * all, so the hook count stays constant).
 */
function WorkflowArtifactView({
  artifact,
  metadataLoading,
  tab,
  theme,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  artifact: WorkflowRunArtifactView;
  /**
   * Metadata (including the spec for prebuilt boards) is still loading; the body uses it to tell
   * "not here yet" apart from "genuinely absent".
   */
  metadataLoading: boolean;
  tab: WorkflowArtifactSidePaneTab;
  theme: Theme;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const preset = isArtifactPresetKind(artifact.kind);

  // The drop point for the version stepper. The `version` on the tab is just the initial value when opened (chip never carries a version number,
  // The latest version if absent); it will be translated by the user later. The product has been changed (the same tab will not be used, but components may be reused) or the latest version
  // Reset back to the latest version when upgrading - if the new version lands while you are looking at the historical version, the jump will be very abrupt, so it is only reset when the id changes.
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(tab.version);
  useEffect(() => {
    setSelectedVersion(tab.version);
  }, [artifact.id, tab.version]);

  const availableVersions = useMemo(() => {
    if (artifact.versions !== undefined && artifact.versions.length > 0) {
      return artifact.versions.map((entry) => entry.version);
    }
    // When the journal cannot be read (old CLI / read failure), only the latest version can be viewed - do not make up 1..n based on `version`,
    // That would cause the stepper to point to a batch of unreachable version numbers.
    return [artifact.version];
  }, [artifact.version, artifact.versions]);

  const version =
    selectedVersion !== undefined && availableVersions.includes(selectedVersion)
      ? selectedVersion
      : artifact.version;
  const versionIndex = availableVersions.indexOf(version);
  const isLatestVersion = version === artifact.version;

  const bytesState = useWorkflowRunArtifactBytes({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    version,
    enabled: !preset,
  });
  const dataState = useWorkflowRunArtifactData({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    itemCount: artifact.itemCount,
    enabled: preset,
  });

  // "Display in workspace" and "Open in browser" of html share this path: `sourcePath` relative to workspace
  // Spelling workspacePath is the real location on this machine. Remote workspaces and unoriginal artifacts don't get it.
  const sourcePath = artifact.sourcePath;
  const localSourcePath =
    sourcePath !== undefined &&
    canRevealArtifactInWorkspace({
      sourcePath,
      ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
      ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    })
      ? joinFilePath(tab.workspacePath, sourcePath)
      : undefined;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyable =
    !preset && bytesState.bytes !== null && isTextArtifactContentType(artifact.contentType);
  const handleCopy = useCallback(() => {
    if (bytesState.bytes === null) return;
    void navigator.clipboard
      ?.writeText(new TextDecoder().decode(bytesState.bytes))
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [bytesState.bytes]);

  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });

  return (
    <>
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The same square tile as the artifact pill: the tab header is that pill grown up. */}
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-surface-hover text-foreground-subtle">
            <ArtifactKindIcon className="size-3.5" kind={artifact.kind} />
          </span>
          <h2
            className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            data-testid="workflow-artifact-title"
            title={title}
          >
            {title}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-ui-sm text-foreground-subtle">{kindLabel}</span>
          <ArtifactVersionStepper
            availableVersions={availableVersions}
            onSelect={setSelectedVersion}
            version={version}
            versionIndex={versionIndex}
          />
          <div className="ml-auto flex items-center gap-1">
            {localSourcePath !== undefined && onRevealFileInTree !== undefined ? (
              <Button
                data-testid="workflow-artifact-reveal"
                onClick={() => onRevealFileInTree(localSourcePath)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
              </Button>
            ) : null}
            {copyable ? (
              <Button
                data-testid="workflow-artifact-copy"
                onClick={handleCopy}
                size="sm"
                type="button"
                variant="ghost"
              >
                <CopyIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({
                  id: copied
                    ? "chat.toolCall.workflow.run.artifacts.copied"
                    : "chat.toolCall.workflow.run.artifacts.copy",
                })}
              </Button>
            ) : null}
          </div>
        </div>
        {/* The author's own description (in the user's language); when absent, the whole row does not render. */}
        {artifact.description === undefined ? null : (
          <p className="mt-1.5 text-ui-sm text-foreground-subtle">{artifact.description}</p>
        )}
      </header>

      <div className="min-h-0 flex-1">
        <WorkflowArtifactBody
          artifact={artifact}
          blob={bytesState.blob}
          bytes={bytesState.bytes}
          error={bytesState.error}
          isLatestVersion={isLatestVersion}
          items={dataState.items}
          loading={bytesState.loading}
          metadataLoading={metadataLoading}
          objectUrl={bytesState.objectUrl}
          resolvedTheme={resolveTheme(theme)}
          theme={theme}
          version={version}
          {...(localSourcePath === undefined ? {} : { localSourcePath })}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(localSourcePath !== undefined && onRevealFileInTree !== undefined
            ? { onReveal: () => onRevealFileInTree(localSourcePath) }
            : {})}
        />
      </div>
    </>
  );
}

/**
 * Version stepper `‹ v2 / 3 ›`. With only one version the whole block is absent — a stepper whose
 * two ends are permanently disabled is just noise.
 *
 * It steps through the **array of known versions** rather than adding and subtracting numbers: when
 * the journal cannot be read the array holds only the latest entry, so the stepper naturally
 * disappears instead of offering a batch of version numbers whose bytes cannot be fetched.
 */
function ArtifactVersionStepper({
  availableVersions,
  version,
  versionIndex,
  onSelect,
}: {
  availableVersions: readonly number[];
  version: number;
  versionIndex: number;
  onSelect: (version: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (availableVersions.length <= 1) {
    return (
      <span
        className="font-mono text-ui-xs text-foreground-subtlest"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.version" },
          { version: String(version) },
        )}
      </span>
    );
  }
  const previous = availableVersions[versionIndex - 1];
  const next = availableVersions[versionIndex + 1];
  return (
    <div className="flex items-center gap-0.5" data-testid="workflow-artifact-version-stepper">
      <Button
        aria-label={intl.formatMessage({
          id: "chat.toolCall.workflow.run.artifacts.previousVersion",
        })}
        data-testid="workflow-artifact-version-previous"
        disabled={previous === undefined}
        onClick={() => (previous === undefined ? undefined : onSelect(previous))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <span
        className="font-mono text-ui-xs text-foreground-subtle"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.versionOf" },
          { total: String(availableVersions.length), version: String(version) },
        )}
      </span>
      <Button
        aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.nextVersion" })}
        data-testid="workflow-artifact-version-next"
        disabled={next === undefined}
        onClick={() => (next === undefined ? undefined : onSelect(next))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * A full-size viewing tab for a dwf artifact.
 *
 * ⚠ Terminology: an artifact here is an output a script delivers to the user through `artifact.*`,
 * not the engine-internal homonym "the script's top-level return value".
 *
 * The data splits three ways: **metadata** goes through `useWorkflowRunArtifacts` (live projection
 * + journal merge), **bytes** through `useWorkflowRunArtifactBytes` (chunked Blob assembly), and
 *   **board items** through `useWorkflowRunArtifactData` (`itemCount` rising means resuming the
 *   incremental fetch). The three are unrelated to each other, so a board never reads bytes, and a
 *   pdf never digs through the journal's report rows.
 */
export const WorkflowArtifactSidePane = memo(function WorkflowArtifactSidePane({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  /** The "open in browser" action for an html artifact. */
  onOpenBrowserUrl?: (url: string) => void;
  /** "Show in workspace": reuses the existing file-tree reveal (the same path as the Git panel). */
  onRevealFileInTree?: (path: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowArtifactContent
        tab={tab}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
      />
    </V4PaneConversationProvider>
  );
});
