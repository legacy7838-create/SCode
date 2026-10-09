/*
 * Layer A6 — tauriBridge import-safety + runtime capability probe.
 *
 * `tauriBridge.ts` is imported unconditionally by the renderer entry, so importing it must have ZERO
 * side effects and it must select the Tauri path only via a runtime probe of
 * `window.__TAURI_INTERNALS__` — never by assuming that global exists at load time. If the module
 * called `invoke()` at top level, or hard-referenced the Tauri global on import, merely importing it
 * in a non-Tauri JS context (unit tests run under plain Node with a fake `window`) would throw.
 * No other test guards this, so it is asserted here: under a Tauri-less `window`, the module imports
 * cleanly and `isTauriRuntime()` returns `false`; once a Tauri global is present it returns `true`.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

    assert.equal(typeof mod.isTauriRuntime, "function", "tauriBridge must export isTauriRuntime()");
    // With no Tauri global, the probe MUST report false, so non-Tauri JS contexts
    // (tests, SSR) importing the bridge never trip a hard Tauri-global read.
    assert.equal(
      mod.isTauriRuntime!(),
      false,
      "isTauriRuntime() must be false when window lacks __TAURI_INTERNALS__",
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
 * Tauri-only-entry guard — Electron has been removed as the desktop runtime, so the shipped renderer
 * entry must install the Tauri platform and the Electron process layer must stay gone. This is the
 * inverse of the old parallel-shell isolation test (which forbade Tauri leaking into Electron).
 *  - The Electron-only process trees (`src/main`, `src/preload`) and the Electron platform modules
 *    (`desktopPlatform.ts`, `desktopBrowserPlatformBridge.ts`) must not exist — re-adding them is a
 *    contract break.
 *  - `main.tsx` must install `createTauriPlatform()` unconditionally and must NOT import the deleted
 *    Electron platform factory. Positive content assertions keep the scan non-vacuous.
 */
test("A6: Tauri is the sole desktop entry and the Electron process layer is gone", () => {
  const root = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

  // Electron-only trees/modules that must never come back.
  for (const gone of [
    "../../../src/main",
    "../../../src/preload",
    "../../../src/renderer/src/desktopPlatform.ts",
    "../../../src/renderer/src/desktopBrowserPlatformBridge.ts",
  ]) {
    assert.equal(
      existsSync(root(gone)),
      false,
      `Electron runtime artifact must be removed: ${gone}`,
    );
  }

  // The shipped entry must install the Tauri platform, and must not reach for the Electron factory.
  const mainTsx = readFileSync(root("../../../src/renderer/src/main.tsx"), "utf8");
  assert.match(mainTsx, /createTauriPlatform\s*\(/, "main.tsx must install createTauriPlatform()");
  assert.doesNotMatch(
    mainTsx,
    /createDesktopPlatform|from "\.\/desktopPlatform|from "\.\/desktopBrowserPlatformBridge/,
    "main.tsx must not import the removed Electron platform factory",
  );
});

/**
 * Electron decoupling tripwire — no file under `packages/desktop/src` may import the `electron`
 * package (value or type). The backend Host/scheduler were de-coupled via local structural types
 * (`ipcTypes.ts`, `parentPortTypes.ts`); reintroducing an `electron` import means the desktop source
 * is no longer runtime-neutral, which the Tauri-only cutover forbids. Comment mentions of "Electron"
 * are allowed; only `import`/`require` statements are matched.
 */
test("A6: no desktop source file imports the electron package", () => {
  const srcRoot = fileURLToPath(new URL("../../../src", import.meta.url));
  const electronImport =
    /(?:import\b[^;'"]*\bfrom\s*|^\s*(?:import\s*)|require\s*\(\s*)['"]electron['"]/m;
  const offenders: string[] = [];
  for (const entry of readdirSync(srcRoot, { recursive: true })) {
    const rel = entry.toString();
    if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) continue;
    const full = `${srcRoot}/${rel}`;
    if (electronImport.test(readFileSync(full, "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `desktop source still imports the electron package: ${offenders.join(", ")}`,
  );
});
