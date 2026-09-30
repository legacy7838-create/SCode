/**
 * Source of truth for the System Settings window position: spawns a long-lived
 * `zcode-window-bounds` and reads its stdout.
 *
 * Every design constraint here follows from a single rule: snapping is a visual enhancement,
 * never a usability prerequisite:
   - Missing binary, failed spawn, crashed process, corrupted output — every one of them surfaces
 *     as `latest() === null`, and the positioner takes its fail-open branch to place the panel at
 *     the bottom of the screen. **No path may throw**, or a purely cosmetic problem escalates
 *     into "the permission onboarding cannot open".
   - Stop reporting the stale position the moment the process dies: otherwise the panel stays
 *     pinned wherever Settings last appeared, which is worse than the screen bottom (the user
 *     would think the panel has hung).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Rect } from "./cuaPermissionPanelPositioner.js";

interface SystemSettingsWindowWatcher {
  start(): void;
  stop(): void;
  /** The last successfully parsed system settings main window bounds; if not available, it is null. */
  latest(): Rect | null;
}

interface CreateSystemSettingsWindowWatcherOptions {
  binaryPath: string;
  intervalMs?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: (binaryPath: string, args: string[]) => ChildProcess;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

const DEFAULT_INTERVAL_MS = 150;

interface RawWindow {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  layer?: unknown;
}

function toRect(raw: RawWindow): Rect | null {
  const { x, y, w, h, layer } = raw;
  // Only recognize layer 0: The settings page will bring up the auxiliary layer (tooltip, pop-up selector) of layer > 0,
  // Snapping to them will throw the panel into the corner of the screen.
  if (layer !== 0) return null;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function parseLine(line: string): Rect | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  // Take the layer-0 window with the largest area, not the first one in z-order.
  //
  // After dragging and landing, the system settings will pop up a modal prompt ("…may not be able to record
  // the contents of your screen until it is quit..."), it belongs to the System Settings process and is also
  // layer 0, and z-ordered further forward than the main window. Taking the first one will cause the floating window to snap to the bottom of the prompt box and tuck itself under it.
  // The main Settings window is always the largest of these windows.
  let best: Rect | null = null;
  let bestArea = 0;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const rect = toRect(entry as RawWindow);
    if (!rect) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

export function createSystemSettingsWindowWatcher(
  options: CreateSystemSettingsWindowWatcherOptions,
): SystemSettingsWindowWatcher {
  const platform = options.platform ?? process.platform;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const spawnProcess =
    options.spawnProcess ?? ((path, args) => spawn(path, args, { stdio: "pipe" }));

  let child: ChildProcess | null = null;
  let current: Rect | null = null;
  // The chunking of stdout has nothing to do with line boundaries, and you must save the lines yourself; direct parse by chunk will fail intermittently on real machines.
  let buffer = "";

  function reset(): void {
    current = null;
    buffer = "";
  }

  return {
    start(): void {
      if (platform !== "darwin" || child) return;
      try {
        child = spawnProcess(options.binaryPath, [String(intervalMs)]);
      } catch (error) {
        // The binary is not packaged/has no execution permission: fail-open, the panel can still be used, but it will not be absorbed.
        options.logger.warn(
          "[cua-permission-panel] window bounds helper unavailable; panel will not anchor",
          error instanceof Error ? error.message : String(error),
        );
        child = null;
        return;
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = buffer.split("\n");
        // The last paragraph may be an incomplete line and remains in the buffer waiting for the next chunk.
        buffer = lines.pop() ?? "";
        // Only take the last complete line: the middle ones are all expired positions
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          if (line.trim().length === 0) continue;
          current = parseLine(line);
          return;
        }
      });

      child.on("error", (error: Error) => {
        options.logger.warn("[cua-permission-panel] window bounds helper error", error.message);
        reset();
        child = null;
      });

      child.on("exit", (code: number | null) => {
        // Don't report the stale position when the process dies - it's more confusing to have the panel stuck in the old position than to fall back to the bottom of the screen.
        if (code !== 0 && code !== null) {
          options.logger.warn("[cua-permission-panel] window bounds helper exited", code);
        }
        reset();
        child = null;
      });
    },

    stop(): void {
      if (child) {
        try {
          child.kill();
        } catch {
          // Exited, ignore
        }
        child = null;
      }
      reset();
    },

    latest(): Rect | null {
      return current;
    },
  };
}
