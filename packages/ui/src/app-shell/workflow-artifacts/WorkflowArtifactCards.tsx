/**
 * The three bodies that cannot be rendered inline (the html card, the metadata card for
 * out-of-schema types, the one-liner for loading / error).
 *
 * ⚠ Terminology: artifact = what the script publishes for the user to look at via `artifact.*`, not
 * the engine-internal namesake "the script's top-level return value".
 *
 * They are split out of `WorkflowArtifactBody.tsx` because of the line cap (400): that file's body
 * dispatches **by contentType**, and these three are where dispatch lands when it **cannot** handle
 * a case; by responsibility the two are meant to be read apart.
 */

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatArtifactBytes } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { toFileUrl } from "@/lib/path.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * The card shell shared by the two bodies that cannot be rendered inline (html and out-of-schema
 * types): title / type / size / origin, plus at most one action. Drawing each of them separately
 * would sooner or later leave one reporting a size and the other not.
 */
export function ArtifactMetadataCard({
  artifact,
  bytes,
  note,
  action,
  testId,
}: {
  artifact: WorkflowRunArtifactView;
  bytes: number;
  /**
   * The explanatory sentence below the card (why it is not rendered inline / what opening it
   * actually gives you).
   */
  note?: string;
  action?: { label: string; onActivate: () => void; testId?: string };
  testId: string;
}) {
  return (
    <div className="flex h-full min-h-0 items-start justify-center overflow-auto p-6">
      <div
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-card-border bg-card p-4"
        data-testid={testId}
      >
        <div className="min-w-0">
          <div className="truncate text-ui-base font-medium text-foreground">
            {artifact.title ?? artifact.id}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-ui-sm text-foreground-subtle">
            {artifact.contentType === undefined ? null : <span>{artifact.contentType}</span>}
            <span>{formatArtifactBytes(bytes)}</span>
          </div>
          {artifact.sourcePath === undefined ? null : (
            <div
              className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={artifact.sourcePath}
            >
              {artifact.sourcePath}
            </div>
          )}
        </div>
        {note === undefined ? null : (
          <p className="text-ui-sm text-foreground-subtle" data-testid="workflow-artifact-note">
            {note}
          </p>
        )}
        {action === undefined ? null : (
          <Button
            className="self-start"
            {...(action.testId === undefined ? {} : { "data-testid": action.testId })}
            onClick={action.onActivate}
            size="sm"
            type="button"
            variant="outline"
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The card for an html artifact (**no inline iframe**, see the header of this file).
 *
 * ## Why "Open in browser" uses the **original workspace path** instead of the pinned bytes in the
 * store
 *
 * The store handle is a `zcode-artifact://…` URL, not a filesystem path, so a browser tab cannot
 * open it; the protocol side also deliberately does not hand the store's on-disk path to the
 * renderer. The only thing that can become a `file://` URL is therefore `sourcePath` (the original
 * workspace-relative path). The cost, stated plainly: that is the file as it **currently is in the
 * workspace**, not the bytes pinned for this revision — which is why the card carries a sentence
 * saying so (the spec's "state on the card that what opens is the workspace copy"), and why this
 * button only appears on the **latest** revision: the original file of an older revision has long
 * since been overwritten by a same-named file, and passing it off as the historical revision would
 * be a quiet lie.
 */
export function WorkflowArtifactHtmlCard({
  artifact,
  bytes,
  localSourcePath,
  isLatestVersion,
  onOpenBrowserUrl,
  onReveal,
}: {
  artifact: WorkflowRunArtifactView;
  bytes: number;
  localSourcePath?: string;
  isLatestVersion: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onReveal?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const openable =
    isLatestVersion && localSourcePath !== undefined && onOpenBrowserUrl !== undefined;
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes}
      note={intl.formatMessage({
        id: openable
          ? "chat.toolCall.workflow.run.artifacts.openInBrowserNote"
          : "chat.toolCall.workflow.run.artifacts.localOnly",
      })}
      testId="workflow-artifact-html-card"
      {...(openable
        ? {
            action: {
              label: intl.formatMessage({
                id: "chat.toolCall.workflow.run.artifacts.openInBrowser",
              }),
              onActivate: () => onOpenBrowserUrl(toFileUrl(localSourcePath)),
              testId: "workflow-artifact-open-in-browser",
            },
          }
        : onReveal === undefined
          ? {}
          : {
              action: {
                label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
                onActivate: onReveal,
                testId: "workflow-artifact-html-reveal",
              },
            })}
    />
  );
}

/**
 * The one-liner in the body area (loading / error / cannot be previewed). All three share one shape
 * and differ only in color shade.
 */
export function ArtifactNotice({
  text,
  detail,
  tone,
  testId,
}: {
  text: string;
  detail?: string;
  tone?: "error";
  testId?: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-1 p-6 text-center"
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <p
        className={cn(
          "text-ui-base",
          tone === "error" ? "text-destructive" : "text-foreground-subtle",
        )}
      >
        {text}
      </p>
      {detail === undefined ? null : (
        <p
          className="max-w-full truncate font-mono text-ui-xs text-foreground-subtlest"
          title={detail}
        >
          {detail}
        </p>
      )}
    </div>
  );
}
