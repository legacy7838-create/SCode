import { useCallback, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeProvider } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildWorkspaceSessionReloadDraftError,
  shouldDebounceWorkspaceSessionReload,
} from "@/lib/workspaceSessionReloadPlan.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

export function useWorkspaceSessionReload({
  intl,
  services,
  workspaceAbsPath,
  reloadSessionDisabled,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  services: IServiceAccessor;
  workspaceAbsPath: string;
  reloadSessionDisabled: boolean;
}) {
  const [reloadSessionPending, setReloadSessionPending] = useState(false);
  const workspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspaceAbsPath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const lastReloadSessionTriggeredAtRef = useRef<number | null>(null);

  const handleReloadSession = useCallback(
    async (options?: { resumeTaskId?: string | null; provider?: ZCodeProvider | null }) => {
      if (reloadSessionDisabled || reloadSessionPending) {
        return;
      }

      const now = Date.now();
      if (shouldDebounceWorkspaceSessionReload(lastReloadSessionTriggeredAtRef.current, now)) {
        // Both the header and error bar can trigger reload, and a short-term double-click/connect-dot concurrent reconstruction will occur.
        // Here, time window anti-shaking is performed at the entrance to avoid concurrent calls to restartWorkspaceProcess to preempt the same provider-workspace.
        logger.info(
          `[App] ignoring duplicate workspace session rebuild request workspace=${workspaceAbsPath}`,
        );
        return;
      }
      lastReloadSessionTriggeredAtRef.current = now;
      setReloadSessionPending(true);

      const zcodeSessionStore = useZCodeSessionStore.getState();
      const latestWorkspaceState = zcodeSessionStore.getWorkspaceState(
        workspaceAbsPath,
        workspaceIdentity,
      );
      const actionScope = resolveWorkspaceModelConfigSyncScope(latestWorkspaceState);
      const provider: ZCodeProvider = options?.provider ?? actionScope.provider;
      const resumeTaskId =
        options?.resumeTaskId?.trim() || latestWorkspaceState.activeTaskId || undefined;
      const shouldPrepareWorkspace = !resumeTaskId;

      // Before the Reload session, only the service layer reconstruction process was called, and the workspaceInit status was not synchronized to the UI store.
      // In the draft state, the subsequent preparation process will continue to read the old state, and users will misjudge that this reconstruction has not taken effect.
      // Initializing/ready/failed is explicitly written here to ensure that the reconstruction status is consistent with the session process.
      zcodeSessionStore.setWorkspaceInitState(
        workspaceAbsPath,
        "initializing",
        null,
        workspaceIdentity,
      );
      if (shouldPrepareWorkspace) {
        zcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "loading", workspaceIdentity);
        // If you do not clear the old errors after clicking reload in the draft state, the input area will continue to display the previous round of failure prompts.
        // Users may misjudge that this reconstruction still fails. Here, the draft errors are cleared at the beginning of a new round of reconstruction.
        zcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
        zcodeSessionStore.setTaskState(workspaceAbsPath, "idle", null, workspaceIdentity);
      }

      try {
        await services.zcodeTaskService.restartWorkspaceProcess({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
          resumeTaskId,
        });

        if (shouldPrepareWorkspace) {
          const prepareResult = await prepareWorkspaceWithZCodeSessionService({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            provider,
            zcodeSessionService: services.zcodeSessionService,
          });

          const latestAfterPrepare = zcodeSessionStore.getWorkspaceState(
            workspaceAbsPath,
            workspaceIdentity,
          );
          if (latestAfterPrepare.selectedProvider === provider) {
            const latestAfterResolve = zcodeSessionStore.getWorkspaceState(
              workspaceAbsPath,
              workspaceIdentity,
            );
            if (latestAfterResolve.selectedProvider === provider) {
              zcodeSessionStore.setConfigOptions(
                workspaceAbsPath,
                prepareResult.configOptions ?? [],
                workspaceIdentity,
              );
              zcodeSessionStore.setConfigOptionsStatus(
                workspaceAbsPath,
                "ready",
                workspaceIdentity,
              );
              zcodeSessionStore.setSlashCommands(
                workspaceAbsPath,
                prepareResult.slashCommands ?? [],
                workspaceIdentity,
              );
              zcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
            }
          }
        }

        zcodeSessionStore.setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
        zcodeSessionStore.setWorkspaceInitState(workspaceAbsPath, "ready", null, workspaceIdentity);

        logger.info(
          `[App] workspace session rebuild done workspace=${workspaceAbsPath} provider=${provider} resumeTaskId=${resumeTaskId ?? "<none>"}`,
        );
        toast(intl.formatMessage({ id: "appHeader.reloadSessionSuccess" }));
      } catch (error) {
        const reloadDraftError = buildWorkspaceSessionReloadDraftError(error, {
          workspacePath: workspaceAbsPath,
          provider,
        });
        const message = reloadDraftError.message;
        logger.warn(
          `[App] workspace session rebuild failed workspace=${workspaceAbsPath} provider=${provider}`,
          {
            resumeTaskId: resumeTaskId ?? null,
            message,
          },
        );
        zcodeSessionStore.setWorkspaceInitState(
          workspaceAbsPath,
          "failed",
          message,
          workspaceIdentity,
        );
        if (shouldPrepareWorkspace) {
          zcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "error", workspaceIdentity);
          // In draft state, old errors will be cleared before reloading; if draftError is not backfilled after failure,
          // Only toasts are left in the chat area, and users cannot see detailed error reports that can be retried. Here, standardized errors are uniformly backfilled into the input area.
          zcodeSessionStore.setDraftError(workspaceAbsPath, reloadDraftError, workspaceIdentity);
        }
        toast(intl.formatMessage({ id: "appHeader.reloadSessionFailed" }));
      } finally {
        setReloadSessionPending(false);
      }
    },
    [
      intl,
      reloadSessionDisabled,
      reloadSessionPending,
      services.zcodeTaskService,
      services.zcodeSessionService,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  return {
    reloadSessionPending,
    handleReloadSession,
  };
}
