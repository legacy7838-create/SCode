import { memo, useCallback, useState } from "react";
import {
  TID_V4_WORKSPACE_HOOK_PENDING_BANNER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  findWorkspaceHookCommandBinding,
  useWorkspaceHookReviewStore,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { sendWorkspaceHookCommand } from "@/settings/workspaceHookReviewCommands.js";

/**
 * Soft-gate dismiss store: a lightweight module-level Map. The idempotent key = sessionId +
 * bundleDigest; the banner reappears once the bundle changes. Nothing is written to disk—the prompt
 * returns after a refresh or reload, which matches the product semantics of “the user should know”.
 */
class WorkspaceHookPendingDismissStore {
  private dismissed = new Set<string>();

  /** Mark a given session+bundle combination as dismissed */
  dismiss(sessionId: string, bundleDigest: string): void {
    this.dismissed.add(this.key(sessionId, bundleDigest));
  }

  /** Query whether it has already been dismissed */
  isDismissed(sessionId: string, bundleDigest: string): boolean {
    return this.dismissed.has(this.key(sessionId, bundleDigest));
  }

  /** Clear all dismiss records (for tests) */
  clear(): void {
    this.dismissed.clear();
  }

  private key(sessionId: string, bundleDigest: string): string {
    return `${sessionId}:${bundleDigest}`;
  }
}

const workspaceHookPendingDismissStore = new WorkspaceHookPendingDismissStore();

interface WorkspaceHookAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

interface WorkspaceHookPendingBannerProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceHookAdmissionInfo | null;
}

/**
 * The always-on soft-gate banner.
 *
 * Shown when snapshot.workspaceHookAdmission.pendingCount > 0, offering [Go review] and [Dismiss].
 * - [Go review]: opens the Hooks section of the settings page + sends the
 *   requestWorkspaceHookReview command. A failure to send the command does not block the navigation
 *   (fault tolerance; the logger records a warn).
 * - [Dismiss]: dismisses locally in the renderer, with the idempotent key = sessionId +
 *   bundleDigest.
 */
export const WorkspaceHookPendingBanner = memo(function WorkspaceHookPendingBanner({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: WorkspaceHookPendingBannerProps) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const commandBindings = useWorkspaceHookReviewStore((state) => state.commandBindings);
  const [, setDismissRevision] = useState(0);

  const handleReview = useCallback(() => {
    // Open the settings page in two lines: set the intent and then open the tab (imitation of V4ComposerToolbar's handleOpenModelProviderSettings)
    setPendingSettingsSectionIntent("hooks");
    openSettingsTab?.();

    // Send the requestWorkspaceHookReview command via command binding.
    // This channel is designed to preserve the command channel when there is no pending review interaction.
    const binding = findWorkspaceHookCommandBinding(
      commandBindings,
      workspacePath,
      workspaceIdentity,
    );
    if (binding && admission) {
      const payload = {
        sessionId,
        workspaceIdentity: admission.workspaceIdentity ?? workspaceIdentity ?? workspacePath,
        bundleDigest: admission.bundleDigest,
      };
      void sendWorkspaceHookCommand(
        binding as Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
        sessionId,
        "requestWorkspaceHookReview",
        payload,
      ).catch((error) => {
        // Failure to send the command does not block navigation (fault tolerance) - the user has reached the settings page and can operate manually.
        logger.warn("[workspace-hook-pending] failed to send requestWorkspaceHookReview", {
          sessionId,
          bundleDigest: admission.bundleDigest,
          error,
        });
      });
    }
  }, [admission, commandBindings, openSettingsTab, sessionId, workspaceIdentity, workspacePath]);

  const handleDismiss = useCallback(() => {
    if (admission) {
      runUserAction({
        input: { featureId: "conversation.blocking.hook", action: "dismiss", trigger: "button" },
        operation: () => {
          workspaceHookPendingDismissStore.dismiss(sessionId, admission.bundleDigest);
          // Reason for the bug: The writing of module-level Set does not belong to the React state, and the memo component will not be re-rendered.
          setDismissRevision((revision) => revision + 1);
        },
        completed: { resultSource: "local_commit" },
        failureStage: "hook_dismiss",
      });
    }
  }, [admission, sessionId]);

  if (!admission || admission.pendingCount <= 0) {
    return null;
  }

  // Idempotent dismiss check: Same as if bundle has been dismissed, it will be hidden
  if (workspaceHookPendingDismissStore.isDismissed(sessionId, admission.bundleDigest)) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_HOOK_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage(
          { id: "chat.workspaceHookPending.message" },
          { count: admission.pendingCount },
        )}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.review" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.dismiss" })}
      </button>
    </div>
  );
});
