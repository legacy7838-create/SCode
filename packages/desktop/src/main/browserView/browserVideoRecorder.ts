import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingArtifact, BrowserViewportSize } from "@zcode/shared";

export interface BrowserWebmRecorderFactoryInput {
  outputPath: string;
  targetFrame: unknown;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
}

export interface BrowserWebmRecorderSession {
  /** Stops the Chromium MediaRecorder and waits for the last WebM chunk to reach disk safely. */
  stop(): Promise<void>;
  /** Aborts the recording and closes the renderer/stream/file handles; must be safe to call repeatedly. */
  cancel(): Promise<void>;
}

export type BrowserWebmRecorderFactory = (
  input: BrowserWebmRecorderFactoryInput,
) => Promise<BrowserWebmRecorderSession>;

function abortError(message = "Browser recording cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * Orchestrates one IAB WebM recording. The concrete media capabilities are injected by Desktop main,
 * so the pure orchestration layer stays free of Electron: that keeps failure cleanup and the artifact
 * contract verifiable, and avoids Service/Host referencing the Runtime implementation in reverse.
 */
export async function recordBrowserVideo(input: {
  targetFrame: unknown;
  tempRoot: string;
  recordingId: string;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
  executeScenario(): Promise<void>;
  onPhase?(phase: "capturing" | "finalizing"): void;
  onCaptureComplete?(): void;
  createRecorder: BrowserWebmRecorderFactory;
  now?: () => number;
}): Promise<BrowserRecordingArtifact> {
  const outputPath = join(input.tempRoot, `${input.recordingId}.webm`);
  const now = input.now ?? Date.now;
  let recorder: BrowserWebmRecorderSession | undefined;
  let completed = false;

  try {
    throwIfAborted(input.signal);
    recorder = await input.createRecorder({
      outputPath,
      targetFrame: input.targetFrame,
      viewport: input.viewport,
      fps: input.fps,
      signal: input.signal,
    });
    throwIfAborted(input.signal);

    const captureStartedAt = now();
    input.onPhase?.("capturing");
    await input.executeScenario();
    throwIfAborted(input.signal);
    const durationMs = Math.max(0, Math.round(now() - captureStartedAt));

    // Page framing has ended: release the background surface watchdog first, and then wait for the recorder flush tail block.
    input.onCaptureComplete?.();
    input.onPhase?.("finalizing");
    await recorder.stop();
    throwIfAborted(input.signal);

    const artifactStat = await stat(outputPath);
    if (!artifactStat.isFile() || artifactStat.size === 0) {
      throw new Error("Browser recording produced an empty WebM artifact");
    }
    completed = true;
    return {
      path: outputPath,
      mimeType: "video/webm",
      width: input.viewport.width,
      height: input.viewport.height,
      fps: input.fps,
      durationMs,
      frameCount: Math.max(1, Math.round((durationMs / 1_000) * input.fps)),
    };
  } finally {
    if (!completed) {
      // When the MediaRecorder fails or the scene action is thrown incorrectly, the remaining EBML header looks like a video but cannot be played;
      // The recorder must be closed and the semi-finished product must be deleted at the same time to avoid status from exposing false artifacts.
      await recorder?.cancel().catch(() => undefined);
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }
}
