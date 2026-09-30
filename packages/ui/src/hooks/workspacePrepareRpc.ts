/**
 * The single landing point for workspace prepare's protocol RPCs.
 *
 * Why it was split out: useWorkspacePrepare.ts keeps only the lightweight decision entry point that
 * can be unit-tested; this reads workspace presentation only (mode/slash commands); the facts about
 * model selection are provided by the target Host View.
 */
import type { IZCodeSessionService } from "@zcode/services";
import { type ZCodeProvider, type ZCodeWorkspacePrepareResult } from "@zcode/shared";
import { getChatErrorMessage } from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";
import { zcodeWorkspacePresentationToConfigOptions } from "@/lib/zcodeSessionProjection.js";

export async function prepareWorkspaceWithZCodeSessionService(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
  zcodeSessionService: Pick<IZCodeSessionService, "readWorkspacePresentation">;
}): Promise<ZCodeWorkspacePrepareResult> {
  const startedAt = Date.now();
  logger.info("[zcode-workspace-presentation] workspace prepare start", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
  });

  let presentation: Awaited<ReturnType<IZCodeSessionService["readWorkspacePresentation"]>>;
  try {
    presentation = await params.zcodeSessionService.readWorkspacePresentation({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
  } catch (error) {
    logger.warn("[zcode-workspace-presentation] readWorkspacePresentation failed", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      provider: params.provider,
      durationMs: Date.now() - startedAt,
      error: getChatErrorMessage(error),
    });
    throw error;
  }

  const readPresentationDurationMs = Date.now() - startedAt;
  const configOptions = zcodeWorkspacePresentationToConfigOptions(presentation.mode);
  const totalDurationMs = Date.now() - startedAt;
  logger.info("[zcode-workspace-presentation] readWorkspacePresentation done", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
    readPresentationDurationMs,
    totalDurationMs,
    configOptionsCount: configOptions.length,
    modeCurrent: presentation.mode,
  });

  return {
    workspacePath: params.workspacePath,
    preparedSessionId: "",
    version: "ZCode Protocol/1",
    provider: params.provider,
    configOptions,
    slashCommands: presentation.slashCommands,
  };
}
