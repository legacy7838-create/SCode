/**
 * Sample source for the main window renderer's heap (the fourth row of the registry).
 *
 * The renderer reads `performance.memory` every 60 seconds and, in the very same reading it uses
 * for the local diagnostics log, sends it one-way to main through the preload bridge; the most
 * recent reading is stored here and folded into the complete `renderer_main` role sample on the
 * next 10 second tick, becoming `heap_used_kb_mean` / `heap_used_kb_peak`.
 *
 * Heap only: the sole source of the renderer's CPU and RSS is main's `getAppMetrics()`, and
 * mixing 60-second readings into the 10-second series would pollute `sample_count` and the
 * statistics. Each reading contributes exactly one heap sample (cleared on delivery); a stale
 * value is never passed off as the current fact.
 *
 * Attribution only trusts the sending webContents: only the main window's webContents is
 * `renderer_main`, and samples from the resource manager / about / DevTools / `<webview>` guest
 * are dropped outright (they belong to `chromium_other` and `renderer_guest`, which carry no heap
 * in the role definition table).
 */

import { ipcMain } from "electron";
import { PlatformChannels, rendererHeapSampleSchema } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { isMainApplicationWindowWebContents } from "./resourceManagerWindow.js";

/** Sender webContents id → Not yet delivered heap reads (KB). */
const pendingHeapUsedKb = new Map<number, number>();

/**
 * Trust boundary on the main side: payload comes from renderer and is verified according to `strict` schema.
 * Illegal messages (missing fields, wrong types, entrained paths and other redundant fields) are directly discarded without throwing errors.
 */
function ingestRendererHeapSample(webContentsId: number, raw: unknown): void {
  if (!isMainApplicationWindowWebContents(webContentsId)) {
    return;
  }
  const parsed = rendererHeapSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  pendingHeapUsedKb.set(webContentsId, parsed.data.heapUsedKb);
}

/** Main-side landing point of the preload bridge: it only listens for one-way sends and offers no invoke. */
export function registerRendererHeapSampleIpc(): void {
  // This channel only allows one listener: repeated registrations do not overlap, preventing the same sample from being ingested multiple times.
  ipcMain.removeAllListeners(PlatformChannels.ReportRendererHeapSample);
  ipcMain.on(PlatformChannels.ReportRendererHeapSample, (event, payload: unknown) => {
    ingestRendererHeapSample(event.sender.id, payload);
  });
}

export const rendererHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "renderer_heap",
  sample(context) {
    // Take it away first and then deliver it: a delivery error will not leave the old reading to the next tick.
    const arrivedHeapUsedKb = [...pendingHeapUsedKb.values()];
    pendingHeapUsedKb.clear();
    if (arrivedHeapUsedKb.length === 0) {
      return;
    }
    /**
     * With multiple windows, takes the maximum among the readings that arrived on this tick. This
     * is not rss's "max over all processes in the same tick": each window's 60-second timer has
     * its own phase, so a given 10-second tick usually only receives readings from some of those
     * windows. `heap_used_kb_peak` is therefore the largest single window, and
     * `heap_used_kb_mean` is a blended average across the per-window readings. Heap is only an
     * extra dimension on a 60-second cadence, so no old reading is kept around for it (the other
     * side of clearing on delivery).
     */
    context.addRoleHeapSample("renderer_main", Math.max(...arrivedHeapUsedKb));
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
