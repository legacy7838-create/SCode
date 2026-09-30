/**
 * useSystemService —— system service hooks
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  IntranetProbeRequest,
  IntranetProbeResult,
  IntranetProbeTarget,
  SystemInfo,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "./useServices.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_ATTEMPTS = 2;
const DEFAULT_PROBE_PORT = 22;
const MAX_PROBE_ATTEMPTS = 3;

function normalizeProbeTimeoutForStableKey(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeProbeAttemptsForStableKey(attempts: number | undefined): number {
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    return DEFAULT_PROBE_ATTEMPTS;
  }

  return Math.min(MAX_PROBE_ATTEMPTS, Math.max(1, Math.floor(attempts)));
}

function normalizeRequiredSuccessCountForStableKey(
  requiredSuccessCount: number | undefined,
  totalTargets: number,
): number {
  if (totalTargets <= 0) {
    return 1;
  }

  if (typeof requiredSuccessCount !== "number" || !Number.isFinite(requiredSuccessCount)) {
    return 1;
  }

  return Math.min(totalTargets, Math.max(1, Math.floor(requiredSuccessCount)));
}

function normalizeProbeTargetForStableKey(target: IntranetProbeTarget) {
  if (target.kind === "service") {
    const normalizedUrl = target.url.trim();
    const normalizedMarker = target.expectedMarker?.trim();
    const normalizedToken = target.token?.trim();

    return {
      kind: "service",
      id: target.id?.trim() || normalizedUrl,
      url: normalizedUrl,
      expectedMarker:
        normalizedMarker && normalizedMarker.length > 0 ? normalizedMarker : undefined,
      token: normalizedToken && normalizedToken.length > 0 ? normalizedToken : undefined,
      timeoutMs: normalizeProbeTimeoutForStableKey(target.timeoutMs),
    };
  }

  const normalizedHost = target.host.trim();
  const resolvedPort =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : DEFAULT_PROBE_PORT;

  return {
    kind: "tcp",
    id: target.id?.trim() || `${normalizedHost}:${resolvedPort}`,
    host: normalizedHost,
    port: resolvedPort,
    timeoutMs: normalizeProbeTimeoutForStableKey(target.timeoutMs),
  };
}

/**
 * Builds a stable key for a request, so that callers passing an inline object do not trigger
 * repeated auto-probes because the reference changes
 */
function createIntranetProbeRequestStableKey(request: IntranetProbeRequest | null): string {
  if (!request) {
    return "null";
  }

  const normalizedTargets = request.targets.map(normalizeProbeTargetForStableKey);
  return JSON.stringify({
    attempts: normalizeProbeAttemptsForStableKey(request.attempts),
    requiredSuccessCount: normalizeRequiredSuccessCountForStableKey(
      request.requiredSuccessCount,
      normalizedTargets.length,
    ),
    targets: normalizedTargets,
  });
}

/**
 * Only the last probe is allowed to write back, preventing concurrent requests from arriving out of
 * order and overwriting newer state
 */
function shouldApplyIntranetProbeRunResult(runId: number, latestRunId: number): boolean {
  return runId === latestRunId;
}

/** Fetches system info, with built-in loading/error/refresh state management */
export function useSystemInfo() {
  const { systemService } = useServices();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await systemService.info();
      setInfo(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [systemService]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { info, loading, error, refresh };
}

interface UseIntranetProbeOptions {
  enabled?: boolean;
  autoProbe?: boolean;
}

/**
 * Probes whether the current runtime environment meets the internal-network determination condition
 */
export function useIntranetProbe(
  request: IntranetProbeRequest | null,
  options: UseIntranetProbeOptions = {},
) {
  const { systemService } = useServices();
  const [result, setResult] = useState<IntranetProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const enabled = options.enabled ?? true;
  const autoProbe = options.autoProbe ?? true;
  const latestProbeRunIdRef = useRef(0);
  const latestRequestRef = useRef<IntranetProbeRequest | null>(request);
  latestRequestRef.current = request;
  const requestStableKey = createIntranetProbeRequestStableKey(request);

  const probeNow = useCallback(async () => {
    // Concurrent probes need generational control, otherwise an earlier request could return later and overwrite newer state.
    // Use a runId guard here so only the latest probe commits its result, keeping isIntranet from flickering back and forth on network jitter.
    const runId = latestProbeRunIdRef.current + 1;
    latestProbeRunIdRef.current = runId;
    const latestRequest = latestRequestRef.current;

    if (!enabled || !latestRequest) {
      setResult(null);
      setProbing(false);
      setError(null);
      return null;
    }

    setProbing(true);
    setError(null);
    try {
      const nextResult = await systemService.probeIntranet(latestRequest);
      if (!shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        return null;
      }
      setResult(nextResult);
      return nextResult;
    } catch (probeError) {
      const normalizedError =
        probeError instanceof Error ? probeError : new Error(String(probeError));
      if (!shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        return null;
      }
      setError(normalizedError);
      logger.warn("[IntranetProbe] intranet probe failed", normalizedError);
      return null;
    } finally {
      if (shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        setProbing(false);
      }
    }
  }, [enabled, systemService]);

  useEffect(() => {
    if (!autoProbe) {
      return;
    }

    // Auto-probing must not depend on the request object's reference: when the caller passes an inline object, the reference changes on every render,
    // which keeps the effect re-probing. So probeNow reads the latest request through a ref and keeps its own reference stable;
    // the effect senses content changes via requestStableKey, so a mere reference change does not trigger an auto probe.
    void probeNow();
  }, [autoProbe, enabled, probeNow, requestStableKey]);

  return {
    result,
    isIntranet: result?.isIntranet ?? false,
    probing,
    error,
    probeNow,
  };
}
