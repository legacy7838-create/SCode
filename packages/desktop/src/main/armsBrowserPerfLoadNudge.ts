import type { WebContents } from "electron";

/**
 * autoInject only executes JavaScript init when it is dom-ready. In Vite scenarios, window.load often ends earlier.
 * perf-collector's onLoad/sendPerf will not run (webvitals can still be reported, so perf=0 in beforeReport).
 * Reissue load after did-finish-load and dom-ready, and wait for RumSDK to be ready.
 */
const ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT = `(function () {
  function dispatchLoad() {
    try {
      window.dispatchEvent(new Event("load"));
    } catch (e) {}
  }
  function tryNudge(attempt) {
    if (typeof window.RumSDK !== "undefined" && window.RumSDK.default) {
      if (document.readyState === "complete") {
        dispatchLoad();
      }
      return;
    }
    if (attempt < 80) {
      setTimeout(function () {
        tryNudge(attempt + 1);
      }, 25);
    }
  }
  if (document.readyState === "complete") {
    tryNudge(0);
  } else {
    window.addEventListener(
      "load",
      function () {
        tryNudge(0);
      },
      { once: true }
    );
  }
})();`;

export function scheduleArmsBrowserPerfLoadNudge(webContents: WebContents): void {
  const nudge = (): void => {
    if (webContents.isDestroyed()) {
      return;
    }
    void webContents.executeJavaScript(ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT, true).catch(() => {
      // Ignored when non-main window or injection fails
    });
  };

  webContents.on("did-finish-load", nudge);
  // Hangs in dom-ready with SDK autoInject, delays for one beat and waits for RumSDK.default.init to complete
  webContents.on("dom-ready", () => {
    setTimeout(nudge, 0);
    setTimeout(nudge, 150);
  });
}
