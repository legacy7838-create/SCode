/*
 * Layer B1 — tauriPlatform adapter conformance (transformation + delegation).
 *
 * Per `TEST-HARNESS.md` §3 Layer B, the adapter must map `IPlatformService` semantics onto the
 * verified command wrappers. This is headless: `createTauriPlatformSubset(deps)` takes injectable
 * bridge dependencies, so we assert the adapter's REAL transformation logic (single-path unwrap from
 * the `string[] | null` pickers, `"system"` theme → clear-override, level → `{ zoomLevel }` wrap,
 * fire-and-forget `openExternal`) WITHOUT a live Tauri runtime. Each assertion checks both the
 * returned shape and the exact argument delegated to the underlying wrapper.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createTauriPlatformSubset,
  type TauriPlatformDeps,
} from "../../../src/renderer/src/tauriPlatform.ts";

interface FakeOptions {
  /** Value the file/dir pickers resolve to (array = selection, `null` = cancel). */
  openDialogResult?: string[] | null;
  /** When true, the `openExternal` stub rejects (exercises the fire-and-forget catch). */
  openExternalThrows?: boolean;
}

/** A recording fake-deps bundle: captures calls and returns contract-shaped values per `FakeOptions`. */
function fakeDeps(opts: FakeOptions = {}): { deps: TauriPlatformDeps; calls: string[] } {
  const calls: string[] = [];
  // Explicit `null` (cancelled) must survive, so distinguish it from an omitted option (`undefined`)
  // rather than using `??`, which would collapse `null` back to the default.
  const dialogResult = opts.openDialogResult === undefined ? ["picked"] : opts.openDialogResult;
  const deps: TauriPlatformDeps = {
    selectDirectory: async (multiple) => {
      calls.push(`selectDirectory:${multiple}`);
      return dialogResult;
    },
    showOpenDialog: async (options) => {
      calls.push(`showOpenDialog:${options.multiple === true}`);
      return dialogResult;
    },
    openExternal: async (url) => {
      calls.push(`openExternal:${url}`);
      if (opts.openExternalThrows) {
        throw new Error("no handler");
      }
    },
    getDesktopZoomLevel: async (label) => {
      calls.push(`getDesktopZoomLevel:${label}`);
      return 2.5;
    },
    setWindowTheme: async (label, theme) => {
      calls.push(`setWindowTheme:${label}:${String(theme)}`);
    },
  };
  return { deps, calls };
}

test("B1: selectDirectory unwraps the single path from the picker's array", async () => {
  const { deps, calls } = fakeDeps({ openDialogResult: ["first", "second"] });
  const platform = createTauriPlatformSubset(deps);
  assert.equal(await platform.selectDirectory!(), "first");
  assert.deepEqual(calls, ["selectDirectory:false"]);
});

test("B1: selectFile takes the first result of a single-file dialog", async () => {
  const { deps, calls } = fakeDeps({ openDialogResult: ["chosen.pdf"] });
  const platform = createTauriPlatformSubset(deps);
  assert.equal(await platform.selectFile!(), "chosen.pdf");
  assert.deepEqual(calls, ["showOpenDialog:false"]);
});

test("B1: selectFile returns null when cancelled", async () => {
  const { deps } = fakeDeps({ openDialogResult: null });
  const platform = createTauriPlatformSubset(deps);
  assert.equal(await platform.selectFile!(), null);
});

test("B1: selectFiles returns [] when the multi picker is cancelled", async () => {
  const { deps, calls } = fakeDeps({ openDialogResult: null });
  const platform = createTauriPlatformSubset(deps);
  assert.deepEqual(await platform.selectFiles!(), []);
  assert.deepEqual(calls, ["showOpenDialog:true"]);
});

test("B1: openExternal delegates fire-and-forget with the url", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  platform.openExternal("https://example.com");
  // Synchronous delegation (the promise is intentionally not awaited; interface return is void).
  assert.deepEqual(calls, ["openExternal:https://example.com"]);
});

test("B1: openExternal does not surface an OS-launch rejection as an unhandled throw", async () => {
  const { deps } = fakeDeps({ openExternalThrows: true });
  const platform = createTauriPlatformSubset(deps);
  // Must not throw synchronously (the .catch swallows the async rejection).
  assert.doesNotThrow(() => platform.openExternal("x"));
});

test("B1: getDesktopZoomLevel wraps the tracked level into DesktopZoomState for the main window", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  assert.deepEqual(await platform.getDesktopZoomLevel!(), { zoomLevel: 2.5 });
  assert.deepEqual(calls, ["getDesktopZoomLevel:main"]);
});

test("B1: setTitleBarTheme maps light/dark directly and system to a null override", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  await platform.setTitleBarTheme("dark");
  await platform.setTitleBarTheme("system");
  assert.deepEqual(calls, ["setWindowTheme:main:dark", "setWindowTheme:main:null"]);
});
