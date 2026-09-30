import type { Hook } from "@zcode/shared";
import { CircleAlert } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Keep the same decision as the inline Trust button in HooksList, so the risk notice does not
 * create a second review state.
 */
export function requiresWorkspaceHookTrust(hook: Hook): boolean {
  return Boolean(hook.workspaceHook) && hook.workspaceHook?.trustState !== "trusted_persistent";
}

function hasWorkspaceHooksRequiringReview(hooks: readonly Hook[]): boolean {
  return hooks.some(requiresWorkspaceHookTrust);
}

export function shouldShowWorkspaceHookTrustNotice({
  hooks,
  loadedWorkspaceKey,
  rpcReady,
  targetWorkspaceKey,
}: {
  hooks: readonly Hook[];
  loadedWorkspaceKey: string | null;
  rpcReady: boolean;
  targetWorkspaceKey: string | null;
}): boolean {
  // hooksStore is a singleton. After switching workspace, the connection phase may still retain the previous one.
  // workspace hooks. The security prompt is only allowed to be displayed when the current target is ready and the snapshot key matches.
  // Avoid attributing risk from A to B being connected.
  return (
    rpcReady &&
    targetWorkspaceKey !== null &&
    loadedWorkspaceKey === targetWorkspaceKey &&
    hasWorkspaceHooksRequiringReview(hooks)
  );
}

/**
 * Only shows the risk explanation for the current scope; review, navigation and toggle interaction
 * remain the responsibility of the existing components.
 */
export function WorkspaceHookTrustNotice({ hooks }: { hooks: readonly Hook[] }) {
  const { intl } = useZCodeIntl();

  if (!hasWorkspaceHooksRequiringReview(hooks)) return null;

  return (
    <div
      role="note"
      data-testid="workspace-hook-trust-notice"
      className="flex w-full items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-ui-base text-foreground"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0">{intl.formatMessage({ id: "settings.hooks.review.notice" })}</p>
    </div>
  );
}
