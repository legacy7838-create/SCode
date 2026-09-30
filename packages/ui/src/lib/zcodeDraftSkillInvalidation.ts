import type { IZCodeSessionService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface DeferredDraftRuntimeChangeParams {
  logScope: string;
  reason: string;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  zcodeSessionService: Pick<IZCodeSessionService, "closeSession">;
}

export async function invalidateDeferredDraftSessionForRuntimeChange(
  params: DeferredDraftRuntimeChangeParams,
): Promise<void> {
  if (!params.workspacePath) {
    return;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const store = useZCodeSessionStore.getState();
  const draftSessionId = store.getWorkspaceState(
    params.workspacePath,
    workspaceIdentity,
  ).draftSessionId;
  // Protocol-v4 draft sessions are preheated locally by pane, and draftSessionId will remain null.
  // Regardless of whether the legacy session exists, a runtime-invalidated version of the workspace isolation must be released first.
  store.invalidateDraftRuntime(params.workspacePath, workspaceIdentity);
  if (!draftSessionId) {
    return;
  }

  try {
    await params.zcodeSessionService.closeSession({
      workspacePath: params.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId: draftSessionId,
    });
    logger.info(`[${params.logScope}] invalidated deferred draft session after runtime change`, {
      draftSessionId,
      reason: params.reason,
      workspaceIdentity: workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
  } catch (error) {
    logger.warn(`[${params.logScope}] close deferred draft session after runtime change failed`, {
      draftSessionId,
      reason: params.reason,
      workspaceIdentity: workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function invalidateDeferredDraftSessionForSkillChange(
  params: Omit<DeferredDraftRuntimeChangeParams, "logScope">,
): Promise<void> {
  await invalidateDeferredDraftSessionForRuntimeChange({ ...params, logScope: "skills" });
}
