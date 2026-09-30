import type { LaunchMarks } from "@zcode/shared";

// Startup timing (epoch ms): T0 process creation / T1 main JS / T2 whenReady. T3 is recorded in loadWindow.
// into a separate module to avoid being dragged down by the bootstrap side effect chain of index.js (such as desktopHostProcess also reads these tags).
// process.getCreationTime is an API extended by Electron to process; it does not exist in the node environment (including single test) and needs to be guarded.
const launchCreatedAt =
  (typeof process.getCreationTime === "function" ? process.getCreationTime() : null) ?? Date.now();
const launchMainStart = Date.now();
let launchAppReady = launchMainStart;

export function markMainLaunchAppReady(): void {
  launchAppReady = Date.now();
}

export function getMainLaunchPartialMarks(): Omit<LaunchMarks, "loadUrl"> {
  return { createdAt: launchCreatedAt, mainStart: launchMainStart, appReady: launchAppReady };
}
