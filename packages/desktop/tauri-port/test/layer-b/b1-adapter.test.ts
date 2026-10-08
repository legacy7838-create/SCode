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
  toSupportedLocale,
  type TauriPlatformDeps,
} from "../../../src/renderer/src/tauriPlatform.ts";

interface FakeOptions {
  /** Value the file/dir pickers resolve to (array = selection, `null` = cancel). */
  openDialogResult?: string[] | null;
  /** When true, the `openExternal` stub rejects (exercises the fire-and-forget catch). */
  openExternalThrows?: boolean;
  /** When true, the `showItemInFolder` stub rejects (exercises openInFileManager's error mapping). */
  revealThrows?: boolean;
  /** Raw OS locale the `getSystemLocale` stub returns (defaults to a non-supported locale). */
  systemLocale?: string;
  /** When true, the `openPath` stub rejects (exercises openExternalFile's error mapping). */
  openFileThrows?: boolean;
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
    showItemInFolder: async (path) => {
      calls.push(`showItemInFolder:${path}`);
      if (opts.revealThrows) {
        throw new Error("reveal failed");
      }
    },
    getSystemLocale: async () => {
      calls.push("getSystemLocale");
      return opts.systemLocale ?? "de-DE";
    },
    openPath: async (path) => {
      calls.push(`openPath:${path}`);
      if (opts.openFileThrows) {
        throw new Error("open failed");
      }
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

test("B1: openInFileManager returns {success:true} on a successful reveal", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  assert.deepEqual(await platform.openInFileManager("/tmp/x"), { success: true });
  assert.deepEqual(calls, ["showItemInFolder:/tmp/x"]);
});

test("B1: openInFileManager maps a rejected reveal to {success:false,error}", async () => {
  const { deps } = fakeDeps({ revealThrows: true });
  const platform = createTauriPlatformSubset(deps);
  const result = await platform.openInFileManager("/nope");
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /reveal failed/);
});

test("B1: openExternalFile delegates to openPath and returns {success:true}", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  assert.deepEqual(await platform.openExternalFile!("/tmp/doc.pdf"), { success: true });
  assert.deepEqual(calls, ["openPath:/tmp/doc.pdf"]);
});

test("B1: openExternalFile maps a rejected open to {success:false,error}", async () => {
  const { deps } = fakeDeps({ openFileThrows: true });
  const platform = createTauriPlatformSubset(deps);
  const result = await platform.openExternalFile!("/nope");
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /open failed/);
});

test("B1: getSystemLocale narrows a zh* locale to zh-CN and anything else to en-US", async () => {
  const zh = createTauriPlatformSubset(fakeDeps({ systemLocale: "zh-TW" }).deps);
  const de = createTauriPlatformSubset(fakeDeps({ systemLocale: "de-DE" }).deps);
  const en = createTauriPlatformSubset(fakeDeps({ systemLocale: "en-US" }).deps);
  assert.equal(await zh.getSystemLocale!(), "zh-CN");
  assert.equal(await de.getSystemLocale!(), "en-US");
  assert.equal(await en.getSystemLocale!(), "en-US");
});

test("B1: toSupportedLocale matches the Electron resolveSystemApplicationLocale rule", () => {
  assert.equal(toSupportedLocale("zh-CN"), "zh-CN");
  assert.equal(toSupportedLocale("ZH-Hans"), "zh-CN");
  assert.equal(toSupportedLocale("en-GB"), "en-US");
  assert.equal(toSupportedLocale("fr"), "en-US");
  assert.equal(toSupportedLocale(""), "en-US");
});
