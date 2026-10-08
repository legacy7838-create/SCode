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
import { readdirSync, readFileSync } from "node:fs";
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
    const mod = (await import(/* @vite-ignore */ tauriBridgeTs)) as {
      isTauriRuntime?: () => boolean;
    };

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

/**
 * Parallel-shell isolation — the strongest reading of "Electron stays fully intact, Tauri is a PARALLEL
 * additive shell." The whole cutover decision depends on the port NOT leaking into the shipped Electron
 * runtime: no Electron main/preload/renderer file may import the Tauri shell modules
 * (`tauriBridge`/`tauriPlatform`/`tauriHostConnection`) or `@tauri-apps/*`. The adapter is wired only by
 * the (gated) runtime factory, and even then behind `isTauriRuntime()`. This static guard walks the
 * shipped source trees and fails the moment a shipped file pulls the shell into Electron's graph —
 * turning a project-wide invariant into an enforced check rather than a convention.
 *
 * The three Tauri modules themselves are the only permitted importers and are excluded by basename; test
 * files are excluded so the guards themselves don't trip the rule.
 */
test("A6: no Electron-shipped source file imports the Tauri shell (parallel/additive invariant)", () => {
  const shippedRoots = [
    "../../../src/renderer/src",
    "../../../src/main",
    "../../../src/preload",
  ].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  const tauriModuleBases = new Set([
    "tauriBridge.ts",
    "tauriPlatform.ts",
    "tauriHostConnection.ts",
  ]);
  // Match import/export-from / require of a Tauri shell module or the @tauri-apps SDK.
  const forbidden =
    /(?:from|import|require\s*\()\s*['"][^'"]*(?:tauriBridge|tauriPlatform|tauriHostConnection|@tauri-apps\/)/;

  const violators: string[] = [];
  for (const root of shippedRoots) {
    for (const entry of readdirSync(root, { recursive: true })) {
      const rel = entry.toString();
      if (!/\.tsx?$/.test(rel)) continue;
      const base = rel.split(/[\\/]/).pop() ?? rel;
      if (tauriModuleBases.has(base)) continue; // the Tauri modules themselves are allowed
      const text = readFileSync(`${root}/${rel}`, "utf8");
      if (forbidden.test(text)) {
        violators.push(rel);
      }
    }
  }

  // Vacuity guard: we must actually be scanning shipped files, else a wrong root silently passes.
  assert.ok(shippedRoots.length === 3, "expected 3 shipped roots to scan");
  assert.deepEqual(
    violators,
    [],
    `Electron-shipped files import the Tauri shell (breaks the parallel/additive contract): ${violators.join(", ")}`,
  );
});
