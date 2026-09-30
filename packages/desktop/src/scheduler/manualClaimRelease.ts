interface ManualClaimReleaseRepo {
  get(automationId: string): Promise<{ workspaceKey: string } | null>;
  getRun(runId: string): Promise<{ workspaceKey: string } | null>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

interface ManualClaimReleaseParams {
  repo: ManualClaimReleaseRepo;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logError: (message: string) => void;
}

async function releaseManualClaimForSettledRun(params: ManualClaimReleaseParams): Promise<void> {
  const releaseWorkspaceKey =
    params.workspaceKey ??
    (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
    (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
  if (!releaseWorkspaceKey) {
    params.logError(
      `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
    );
    return;
  }
  // It is possible to still receive late returns from main after scheduler restart/inFlight loss; manual
  // The single-flight lock must use the run ledger or automation to retrieve the workspaceKey, otherwise it will be stuck in stale recycling.
  await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
}

export async function settleManualClaimForDispatchResult(
  params: ManualClaimReleaseParams & { ok: boolean },
): Promise<void> {
  // host ok only means prompt accepted/queued, the real final state is determined by host subscription
  // Close; the scheduler only releases the manual claim when dispatch fails and there are no turns to wait for.
  if (params.ok) return;
  await releaseManualClaimForSettledRun(params);
}
