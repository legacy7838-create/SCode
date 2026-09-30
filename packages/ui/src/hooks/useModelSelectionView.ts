import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type ModelSelectionState =
  | { status: "loading" }
  | { status: "ready"; view: ModelSelectionView }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };

export interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
}

interface OwnedModelSelectionState {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: "remote-waiting" | "missing-target";
  inputKey: string | undefined;
  state: ModelSelectionState;
}

// A transient first-read IO failure may not emit a Provider change event; re-read at most twice, never poll business state or retry writes.
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;
function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

function initialState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
): ModelSelectionState {
  return enabled && service
    ? { status: "loading" }
    : { status: "unavailable", reason: unavailableReason };
}

/**
 * Subscribes to the explicit Host Service; the returned state binds to the new owner within the
 * same render, so the old Host View is never exposed.
 */
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: "remote-waiting" | "missing-target" = "remote-waiting",
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const normalizedService = service ?? null;
  // Callers may build the input object on every render; ownership binds by selected contents (inputKey), not object reference, so we don't resubscribe.
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialState(normalizedService, enabled, unavailableReason),
  }));
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const generationRef = useRef(0);
  const ownerMatches =
    owned.service === normalizedService &&
    owned.enabled === enabled &&
    owned.inputKey === inputKey &&
    owned.unavailableReason === unavailableReason;
  const visibleState = ownerMatches
    ? owned.state
    : initialState(normalizedService, enabled, unavailableReason);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === normalizedService &&
      previous.enabled === enabled &&
      previous.inputKey === inputKey &&
      previous.unavailableReason === unavailableReason &&
      previous.state.status === "ready"
        ? previous.state
        : null;
    setOwned({
      service: normalizedService,
      enabled,
      unavailableReason,
      inputKey,
      state: retainedReady ?? initialState(normalizedService, enabled, unavailableReason),
    });
    if (!enabled || !normalizedService) return;

    let latestRevision = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    let requestId = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const commit = (candidate: ModelSelectionView): void => {
      if (generation !== generationRef.current || candidate.revision < latestRevision) return;
      latestRevision = candidate.revision;
      hasReadyView = true;
      cancelRetry();
      setOwned({
        service: normalizedService,
        enabled,
        unavailableReason,
        inputKey,
        state: { status: "ready", view: candidate },
      });
    };
    const read = (): void => {
      cancelRetry();
      const request = ++requestId;
      void normalizedService.getView(stableInput).then(
        (candidate) => {
          if (request === requestId) commit(candidate);
        },
        (cause: unknown) => {
          if (generation !== generationRef.current || request !== requestId) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] failed to read target Host View", { error });
          // A read failure is not a selection invalidation. A refresh failure after success keeps the previous View; the first failure is visible and retried with bounded re-reads.
          if (!hasReadyView) {
            setOwned({
              service: normalizedService,
              enabled,
              unavailableReason,
              inputKey,
              state: { status: "error", error },
            });
            const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
            if (delay !== undefined && isTransientReadError(cause)) {
              retryCount += 1;
              retryTimer = setTimeout(read, delay);
            }
          }
        },
      );
    };
    const subscription = normalizedService.onDidChange((candidate) => {
      if (generation !== generationRef.current) return;
      if (stableInput === undefined) commit(candidate);
      else {
        // A shared event carries no original intent from any one caller; use it only to trigger a re-read of the current input, never to take over the result directly.
        latestRevision = Math.max(latestRevision, candidate.revision);
        read();
      }
    });
    read();
    return () => {
      generationRef.current += 1;
      cancelRetry();
      subscription.dispose();
    };
  }, [enabled, normalizedService, reloadVersion, unavailableReason, inputKey, stableInput]);

  return { state: visibleState, reload: useCallback(() => reload(), []) };
}

/**
 * Model candidates come only from the explicit Workspace Target; while waiting for a remote,
 * Local/Base Host is not read.
 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    input,
  );
}
