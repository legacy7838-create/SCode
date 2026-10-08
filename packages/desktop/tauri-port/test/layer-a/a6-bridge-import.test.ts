/*
 * Layer A6 — tauriBridge import-safety + runtime capability probe.
 *
 * The entire parallel-shell contract ("Electron stays fully intact and is never
 * removed until Tauri reaches verified parity") rests on one property of
 * `tauriBridge.ts`: importing it must have ZERO side effects and it must select
 * the Tauri path only via a runtime probe of `window.__TAURI_INTERNALS__` — never
 * by assuming that global exists at load time. If the module called `invoke()` at
 * top level, or hard-referenced the Tauri global on import, merely importing it in
 * an Electron/Chromium renderer (which has no Tauri internals) would throw and
 * break Electron. No other test guards this, so it is asserted here: under a
 * Tauri-less `window`, the module imports cleanly and `isTauriRuntime()` returns
 * `false` (the Electron path is preserved); once a Tauri global is present it
 * returns `true`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tauriBridgeTs = fileURLToPath(
  new URL("../../../src/renderer/src/tauriBridge.ts", import.meta.url),
);

test("A6: importing tauriBridge under a Tauri-less window throws nothing and probes false", async () => {
  // Simulate an Electron/Chromium renderer: a `window` exists but has NO Tauri
  // internals. Save/restore any pre-existing global so the test is self-contained.
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  const hadWindow = "window" in g;
  const prior = g.window;
  g.window = {};
  try {
    // A top-level `invoke()` or a hard Tauri-global read would make this import
    // reject — that is exactly the regression this test catches.
    const mod = (await import(
      /* @vite-ignore */ tauriBridgeTs
    )) as { isTauriRuntime?: () => boolean };

    assert.equal(
      typeof mod.isTauriRuntime,
      "function",
      "tauriBridge must export isTauriRuntime()",
    );
    // With no Tauri global, the probe MUST report false, so callers keep the
    // Electron path and Electron behavior is unchanged.
    assert.equal(
      mod.isTauriRuntime!(),
      false,
      "isTauriRuntime() must be false when window lacks __TAURI_INTERNALS__ (Electron intact)",
    );

    // Now flip it: install a Tauri global and re-call (isTauriRuntime reads window
    // at CALL time, so no re-import is needed). The probe must follow the runtime.
    g.window!["__TAURI_INTERNALS__"] = {};
    assert.equal(
      mod.isTauriRuntime!(),
      true,
      "isTauriRuntime() must be true once __TAURI_INTERNALS__ is present",
    );
  } finally {
    if (hadWindow) {
      g.window = prior;
    } else {
      delete g.window;
    }
  }
});
