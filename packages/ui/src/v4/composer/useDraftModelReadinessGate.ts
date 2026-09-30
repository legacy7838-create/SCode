import { useCallback, useEffect, useMemo, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import {
  buildModelConfigMissingUiError,
  type ModelConfigMissingUiError,
} from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessState {
  gateKey: string;
  status: DraftModelReadinessStatus;
  dismissed: boolean;
}

interface DraftModelReadinessGate {
  /**
   * Entering workspace prepare/prewarm is allowed only once readiness is confirmed or the check
   * itself is unavailable.
   */
  agentStartupAllowed: boolean;
  error: ModelConfigMissingUiError | null;
  dismissError(): void;
  /**
   * The authoritative re-check for first-send admission; false means the composer should be kept
   * and blocked returned.
   */
  ensureReadyForSend(): Promise<boolean>;
  /**
   * When the Host gate wins the race after the UI re-check, the same error is projected back onto
   * the draft banner.
   */
  markProviderNotReady(): void;
}

function resolveModelSelectionReadinessStatus(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * provider/model admission for V4 drafts.
 *
 * The V4 migration removed the old useWorkspacePrepare renderer readiness gate, so a draft's first
 * send registers a pending command first and is then rejected by the Host with provider_not_ready.
 * This deterministic rejection is afterwards misjudged by the recovery ledger as unknown. The UI
 * front gate is restored here; the Host gate continues to cover process-level races as a fallback.
 */
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  modelSelectionService: Pick<IModelSelectionService, "getView" | "onDidChange">;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled = sessionId === null && isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceKey}\u0000${displayProvider}`;
  const [state, setState] = useState<DraftModelReadinessState>(() => ({
    gateKey,
    status: enabled ? "checking" : "ready",
    dismissed: false,
  }));

  const commitStatus = useCallback(
    (status: DraftModelReadinessStatus, options: { revealMissing?: boolean } = {}) => {
      setState((current) => ({
        gateKey,
        status,
        dismissed:
          status === "missing"
            ? options.revealMissing
              ? false
              : current.gateKey === gateKey && current.status === "missing"
                ? current.dismissed
                : false
            : false,
      }));
    },
    [gateKey],
  );

  useEffect(() => {
    if (!enabled) {
      commitStatus("ready");
      return;
    }

    commitStatus("checking");
    let disposed = false;
    let registryEventVersion = 0;
    const applyStatus = (status: DraftModelReadinessStatus) => {
      if (disposed) return;
      commitStatus(status);
    };
    const subscription = modelSelectionService.onDidChange((view) => {
      registryEventVersion += 1;
      applyStatus(resolveModelSelectionReadinessStatus(view));
    });
    const initialReadVersion = registryEventVersion;
    void modelSelectionService
      .getView()
      .then((view) => {
        // When a read is initiated before and returns after a change event, the event snapshot is updated; old reads are prohibited from overwriting the new state.
        if (registryEventVersion !== initialReadVersion) return;
        applyStatus(resolveModelSelectionReadinessStatus(view));
      })
      .catch((error) => {
        handleReadinessFailure(error);
      });

    function handleReadinessFailure(error: unknown) {
      if (disposed) return;
      // A registry read exception is not equivalent to "there really is no model". Keep the Host access control as a backup to avoid
      // Transient failure errors in the app-global service appear as user configuration issues.
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry check failed, using Host gate", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    }

    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const effectiveState: DraftModelReadinessState =
    state.gateKey === gateKey
      ? state
      : { gateKey, status: enabled ? "checking" : "ready", dismissed: false };

  const markProviderNotReady = useCallback(() => {
    commitStatus("missing", { revealMissing: true });
  }, [commitStatus]);

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    try {
      const view = await modelSelectionService.getView();
      const status = resolveModelSelectionReadinessStatus(view);
      commitStatus(status, { revealMissing: status === "missing" });
      if (status === "missing") {
        logger.info("[v4-draft-readiness] no provider/model available, first draft send rejected", {
          providerCount: view.providers.length,
          revision: view.revision,
          workspaceKey,
        });
        return false;
      }
      return true;
    } catch (error) {
      // Consistent with the mount check: failure to read the registry does not pretend to be "no model", and the Host continues to start the access control decision.
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry recheck failed, using Host gate", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      return true;
    }
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const error = useMemo(
    () =>
      enabled && effectiveState.status === "missing" && !effectiveState.dismissed
        ? buildModelConfigMissingUiError()
        : null,
    [effectiveState.dismissed, effectiveState.status, enabled],
  );

  const dismissError = useCallback(() => {
    setState((current) =>
      current.gateKey === gateKey && current.status === "missing"
        ? { ...current, dismissed: true }
        : current,
    );
  }, [gateKey]);

  return {
    agentStartupAllowed:
      !enabled || effectiveState.status === "ready" || effectiveState.status === "check-failed",
    error,
    dismissError,
    ensureReadyForSend,
    markProviderNotReady,
  };
}
