import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelConfigResolution } from "@zcode/provider";
import { useIdleTrigger } from "@/settings/model-provider-section/useIdleTrigger.js";

export function useModelConfigResolution({
  open,
  enabled = true,
  originalModelId,
  modelId,
  resolve,
}: {
  open: boolean;
  enabled?: boolean;
  originalModelId?: string;
  modelId: string;
  resolve?: (modelId: string) => Promise<ModelConfigResolution>;
}) {
  const [result, setResult] = useState<{
    readonly modelId: string;
    readonly identity: object;
    readonly resolution: ModelConfigResolution;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const generationRef = useRef(0);
  const identity = useMemo(() => ({}), [open, modelId, resolve]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inheritedSignatureRef = useRef<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveCurrent = useCallback(
    async (restore?: {
      isCurrent: () => boolean;
      apply: (resolution: ModelConfigResolution) => void;
    }): Promise<ModelConfigResolution | undefined> => {
      const normalizedModelId = modelId.trim();
      if (
        !open ||
        !resolve ||
        !normalizedModelId ||
        (!restore && (!enabled || normalizedModelId === originalModelId))
      ) {
        return undefined;
      }
      const generation = ++generationRef.current;
      const isCurrent = () =>
        generationRef.current === generation &&
        identityRef.current === identity &&
        (restore ? restore.isCurrent() : enabledRef.current === enabled);
      setResolving(true);
      try {
        const resolution = await resolve(normalizedModelId);
        if (!isCurrent()) return undefined;
        const inheritedSignature = JSON.stringify(resolution.inheritedConfig);
        if (
          resolution.issues.length === 0 &&
          inheritedSignatureRef.current !== inheritedSignature
        ) {
          inheritedSignatureRef.current = inheritedSignature;
          setDefaultsLoaded(true);
          if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = setTimeout(() => {
            feedbackTimerRef.current = null;
            setDefaultsLoaded(false);
          }, 3_500);
        }
        const nextResult = { modelId: normalizedModelId, identity, resolution };
        setResult(nextResult);
        restore?.apply(resolution);
        return resolution;
      } catch (error) {
        // Errors in old restore requests must also obey the identity/edit generation and cannot overwrite subsequent field feedback from the user.
        if (!isCurrent()) return undefined;
        throw error;
      } finally {
        if (generationRef.current === generation) setResolving(false);
      }
    },
    [enabled, identity, modelId, open, originalModelId, resolve],
  );

  const idle = useIdleTrigger(() => resolveCurrent());

  useEffect(() => {
    generationRef.current += 1;
    const normalizedModelId = modelId.trim();
    if (
      !open ||
      !enabled ||
      !resolve ||
      !normalizedModelId ||
      normalizedModelId === originalModelId
    ) {
      idle.cancel();
      setResult(null);
      setResolving(false);
      setDefaultsLoaded(false);
      if (!open) inheritedSignatureRef.current = null;
      return;
    }
    // Successfully restored and submitted in the same batch as smart mode enabled, the same results will be used and automatic analysis will not be sent immediately.
    if (result?.identity === identity) return;
    idle.schedule();
  }, [
    enabled,
    identity,
    idle.cancel,
    idle.schedule,
    modelId,
    open,
    originalModelId,
    resolve,
    result,
  ]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    },
    [],
  );

  // A→B→A cannot reuse the first reply of A; the same ID does not represent the same editing/account environment generation.
  const activeResult = result?.identity === identity ? result.resolution : null;
  return {
    cancel: () => {
      generationRef.current += 1;
      idle.cancel();
      setResult(null);
    },
    restore: (intent: {
      isCurrent: () => boolean;
      apply: (resolution: ModelConfigResolution) => void;
    }) => {
      idle.cancel();
      return resolveCurrent(intent);
    },
    defaultsLoaded,
    flush: idle.flush,
    resolution: activeResult,
    resolving,
    scheduled: idle.scheduled,
  } as const;
}
