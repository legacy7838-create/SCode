import { useLayoutEffect, useRef } from "react";
import { createSessionTraceId } from "@zcode/shared";
import type { ConversationOpenTiming, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  reportSessionOpenResult,
  reportSessionOpenStart,
  type SessionOpenIdentity,
  type SessionOpenKind,
  type SessionOpenArmsReporter,
  type SessionOpenTrigger,
} from "@/lib/sessionOpenArmsTelemetry.js";
import type { SessionOpenRendererTiming } from "@/v4/conversationProjectionStore.js";

const SESSION_OPEN_TIMEOUT_MS = 30_000;

interface SessionOpenRuntime {
  identity: SessionOpenIdentity;
  startedAt: number;
  finished: boolean;
  commitAt?: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function scheduleAfterPaint(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(callback);
  });
  return () => {
    if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
    if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
  };
}

function errorCodeFromMessage(message: string | null): string | undefined {
  if (!message) return undefined;
  return /^fault\.[A-Za-z0-9._-]+$/.test(message.trim())
    ? message.trim()
    : /\((fault\.[A-Za-z0-9._-]+)\)\s*$/.exec(message)?.[1];
}

function finishSessionOpen(
  runtime: SessionOpenRuntime,
  status: "success" | "failed" | "timeout",
  options: {
    snapshot?: ConversationSnapshot | null;
    openTiming?: ConversationOpenTiming;
    rendererTiming?: SessionOpenRendererTiming;
    paintToInteractiveMs?: number;
    errorMessage?: string | null;
    reporter?: SessionOpenArmsReporter | null;
  } = {},
): void {
  if (runtime.finished) return;
  runtime.finished = true;
  if (runtime.timeoutId !== undefined) clearTimeout(runtime.timeoutId);
  // Bug reason: warm/keep-warm both reuse the existing projection store, and the timing in state belongs to the previous time
  // cold subscribe; only the cold opening that actually creates the store and subscribes to it this time can carry the time consumption in these stages.
  const hasCurrentSubscribeTiming = runtime.identity.openKind === "cold";
  const openTiming = hasCurrentSubscribeTiming ? options.openTiming : undefined;
  const rendererTiming = hasCurrentSubscribeTiming ? options.rendererTiming : undefined;
  const snapshot = options.snapshot;
  reportSessionOpenResult(
    {
      ...runtime.identity,
      status,
      totalMs: Math.max(0, now() - runtime.startedAt),
      errorPhase: status === "success" ? undefined : "conversation_subscribe",
      errorCode: errorCodeFromMessage(options.errorMessage ?? null),
      rendererPrepareMs: rendererTiming?.rendererPrepareMs,
      hostPrepareMs: openTiming?.hostPrepareMs,
      providerRegistrySyncMs: openTiming?.providerRegistrySyncMs,
      taskMetaReadMs: openTiming?.taskMetaReadMs,
      cliRequestMs: openTiming?.cliRequestMs,
      cliBootstrapMs: openTiming?.cliBootstrapMs,
      cliSessionRestoreMs: openTiming?.cliSessionRestoreMs,
      initialFrameEncodeMs: openTiming?.initialFrameEncodeMs,
      initialFrameTransportMs: rendererTiming?.initialFrameTransportMs,
      rendererSnapshotApplyMs: rendererTiming?.rendererSnapshotApplyMs,
      reactRenderMs:
        runtime.commitAt !== undefined && rendererTiming?.snapshotAppliedAt !== undefined
          ? Math.max(0, runtime.commitAt - rendererTiming.snapshotAppliedAt)
          : undefined,
      paintToInteractiveMs: options.paintToInteractiveMs,
      cliProcessState: openTiming?.cliProcessState,
      sessionRuntimeState: openTiming?.sessionRuntimeState,
      snapshotRowCount: openTiming?.snapshotRowCount ?? snapshot?.rows.window.length,
    },
    options.reporter,
  );
}

interface UseSessionOpenArmsTelemetryParams {
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  openTiming?: ConversationOpenTiming;
  rendererTiming?: SessionOpenRendererTiming;
  openKind?: SessionOpenKind;
  openTrigger?: SessionOpenTrigger;
  startedAt?: number;
  status: "connecting" | "live" | "error" | "closed";
  lastError: string | null;
  enabled?: boolean;
  readOnly?: boolean;
  reporter?: SessionOpenArmsReporter | null;
}

/**
 * The pane's first acquire is the Renderer-observable start of the open; one logical open reports
 * only one start/result pair. Web/mobile stay no-ops even when mounted, because the reporter is not
 * installed there.
 */
export function useSessionOpenArmsTelemetry({
  sessionId,
  snapshot,
  openTiming,
  rendererTiming,
  openKind,
  openTrigger,
  startedAt,
  status,
  lastError,
  enabled = true,
  readOnly = false,
  reporter,
}: UseSessionOpenArmsTelemetryParams): void {
  const runtimeRef = useRef<SessionOpenRuntime | null>(null);
  const latestTimingRef = useRef<{
    openTiming?: ConversationOpenTiming;
    rendererTiming?: SessionOpenRendererTiming;
  }>({ openTiming, rendererTiming });
  latestTimingRef.current = { openTiming, rendererTiming };

  useLayoutEffect(() => {
    if (!enabled || readOnly || !sessionId) {
      runtimeRef.current = null;
      return undefined;
    }
    const resolvedOpenKind: SessionOpenKind =
      openKind ?? (snapshot?.sessionId === sessionId ? "keep_warm" : "cold");
    const runtime: SessionOpenRuntime = {
      identity: {
        sessionOpenId: createSessionTraceId(),
        sessionId,
        openTrigger: openTrigger ?? "pane",
        openKind: resolvedOpenKind,
        clientMode: "desktop-continuous",
      },
      startedAt: startedAt ?? now(),
      finished: false,
    };
    runtimeRef.current = runtime;
    reportSessionOpenStart(runtime.identity, reporter);
    runtime.timeoutId = setTimeout(() => {
      const latestTiming = latestTimingRef.current;
      finishSessionOpen(runtime, "timeout", {
        openTiming: latestTiming.openTiming,
        rendererTiming: latestTiming.rendererTiming,
        reporter,
      });
    }, SESSION_OPEN_TIMEOUT_MS);
    return () => {
      if (runtime.timeoutId !== undefined) clearTimeout(runtime.timeoutId);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [enabled, openKind, openTrigger, readOnly, reporter, sessionId, startedAt]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    // Reason for the bug: Runtime reconnection will retain the old snapshot; during connecting/error, only sessionId hits will
    // Opens that are not yet interactive or that ultimately fail are recorded as successes in advance. The successful final state must be consistent with the live state of the UI.
    if (
      !runtime ||
      runtime.finished ||
      status !== "live" ||
      !sessionId ||
      snapshot?.sessionId !== sessionId
    ) {
      return;
    }
    runtime.commitAt = now();
    const cancelPaint = scheduleAfterPaint(() => {
      finishSessionOpen(runtime, "success", {
        snapshot,
        openTiming,
        rendererTiming,
        paintToInteractiveMs: Math.max(0, now() - runtime.commitAt!),
        reporter,
      });
    });
    return cancelPaint;
  }, [openTiming, rendererTiming, reporter, sessionId, snapshot, status]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.finished || status !== "error") return;
    finishSessionOpen(runtime, "failed", {
      openTiming,
      rendererTiming,
      errorMessage: lastError,
      reporter,
    });
  }, [lastError, openTiming, rendererTiming, reporter, status]);
}
