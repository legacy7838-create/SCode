/**
 * Where a click on an html artifact lands.
 *
 * An html artifact pill means "let me look at this page", not "let me look at this page's metadata
 * card and then click once more on the card to see the page". So wherever the embedded browser
 * **can** be opened directly, open it directly and let the artifact tab fall back to being the
 * fallback. The criteria come from the same source as `shouldOpenAssistantHtmlInBrowser`
 * (lib/assistantPreviewCards.ts):
 *
 * - Strict equality with `text/html`, the very same criterion `WorkflowArtifactBody` uses to decide
 *   whether to draw the html card. Loosening it to `text/html; charset=utf-8` would let "open
 *   directly" and "does the card have that button" diverge.
 * - With no embedded browser (Web / phone remote control) `handleOpenBrowserUrl` only does
 *   `window.open`, and `file://` cannot be opened there — it has to fall back to the artifact tab.
 * - The `sourcePath` of a remote workspace (SSH / WSL) and of phone remote control does not exist
 *   on this machine, same as `canRevealArtifactInWorkspace`.
 *
 * A missing `contentType` (old CLI, cold restore, or a surface that simply carries no summary)
 * always falls back to the artifact tab: when it cannot be determined, take the original route and
 * never guess.
 */
export function shouldOpenWorkflowArtifactInBrowser(params: {
  contentType?: string;
  supportsEmbeddedBrowser: boolean;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    params.contentType === "text/html" &&
    params.supportsEmbeddedBrowser &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}
