import { memo } from "react";
import { SquareArrowRightEnter } from "lucide-react";

import type { Locale } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
// Injection boundary: the read-only timeline is shared by anonymous public sharing pages and cannot statically rely on the open-with subtree;
// OpenSplitButton (desktop capabilities such as platform hooks, tab store, file tree model, etc.) can only be used in this Desktop
// Introduced on the consumer side and injected via artifactOpenAction, the public page entry graph therefore does not contain this subtree.
import { OpenSplitButton } from "@/OpenSplitButton.js";

const EMPTY_ARTIFACT_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS: ReadonlyMap<string, string> = new Map();

/**
 * The read-only block + divider at the top of the conversation after importing a share. It uses the
 * import icon, so it is not confused with the Fork marker.
 *
 * The read-only block reuses the share page's renderer directly, so the public rows never have to
 * be mapped back into Messages (that direction is lossy and undefined; Fork is simple only because
 * it clones real Messages).
 *
 * Local results do not go through the share page's artifactUrls/window.open; the open control of
 * the normal preview card is reused only when the import side explicitly passes in a
 * workspaceRelativePath and a Desktop open callback.
 */
export const ConversationShareImportNotice = memo(function ConversationShareImportNotice({
  rows,
  locale,
  theme,
  codePreviewSettings,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  unsupportedRowCount = 0,
  onOpenShareUrl,
  onOpenFileLink,
  onOpenCodeViewer,
}: {
  rows: readonly ConversationRow[];
  locale: Locale;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  artifactNames?: ReadonlyMap<string, string>;
  artifactWorkspaceRelativePaths?: ReadonlyMap<string, string>;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  unsupportedRowCount?: number;
  onOpenShareUrl?: () => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "conversationShare.import.dividerLabel" });
  return (
    <div data-conversation-share-import-notice="true" className="flex w-full flex-col">
      <ConversationShareReadonlyTimeline
        rows={rows}
        locale={locale}
        {...(theme ? { theme } : {})}
        {...(codePreviewSettings ? { codePreviewSettings } : {})}
        artifactNames={artifactNames}
        artifactWorkspaceRelativePaths={artifactWorkspaceRelativePaths}
        {...(workspacePath ? { workspacePath } : {})}
        {...(workspaceIdentity ? { workspaceIdentity } : {})}
        {...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {})}
        unsupportedRowCount={unsupportedRowCount}
        artifactOpenAction={OpenSplitButton}
        onOpenFileLink={onOpenFileLink}
        onOpenCodeViewer={onOpenCodeViewer}
      />
      {onOpenShareUrl ? (
        <button
          type="button"
          data-conversation-share-import-divider="true"
          className="group/share-import flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle hover:text-foreground"
          onClick={onOpenShareUrl}
        >
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <SquareArrowRightEnter aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words text-center leading-5 underline-offset-4 group-hover/share-import:underline">
            {label}
          </span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </button>
      ) : (
        <div
          data-conversation-share-import-divider="true"
          className="flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle"
        >
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <SquareArrowRightEnter aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words text-center leading-5">{label}</span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </div>
      )}
    </div>
  );
});
