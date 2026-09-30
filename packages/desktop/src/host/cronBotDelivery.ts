import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";

interface CronBotDeliveryRepo {
  getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined>;
}

interface CronBotDeliveryService {
  watchAutomationRun(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
}

/**
 * Completes the bot terminal-state subscription before the prompt is dispatched, so a task that
 * finishes before the listener gets registered does not miss its push-back.
 */
export async function watchCronRunBotDelivery(params: {
  automationId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  repo: CronBotDeliveryRepo;
  botsService: CronBotDeliveryService;
}): Promise<boolean> {
  const target = await params.repo.getBotDeliveryTarget(
    params.automationId,
    params.workspaceKey,
  );
  if (!target) return false;
  await params.botsService.watchAutomationRun({
    target,
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity
      ? { workspaceIdentity: params.workspaceIdentity }
      : {}),
  });
  return true;
}
