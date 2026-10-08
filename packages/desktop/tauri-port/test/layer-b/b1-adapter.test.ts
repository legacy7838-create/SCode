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

/** Captures the handler the adapter passes into `listenDesktopZoomChanged` (set by the fake below). */
let capturedZoomHandler: ((state: { zoomLevel: number }) => void) | undefined;
/** Captures the handler the adapter passes into `listenWindowFullscreenChanged` (set by the fake below). */
let capturedFullscreenHandler: ((isFullscreen: boolean) => void) | undefined;

interface FakeOptions {
  /** Value the file/dir pickers resolve to (array = selection, `null` = cancel). */
  openDialogResult?: string[] | null;
  /** When true, the `openExternal` stub rejects (exercises the fire-and-forget catch). */
  openExternalThrows?: boolean;
  /** Raw OS locale the `getSystemLocale` stub returns (defaults to a non-supported locale). */
  systemLocale?: string;
  /** When true, the `openPath` stub rejects (exercises openExternalFile's error mapping). */
  openFileThrows?: boolean;
  /** When true, the `showTaskNotification` stub rejects (exercises the fire-and-forget catch). */
  showTaskNotificationThrows?: boolean;
}

/** A recording fake-deps bundle: captures calls and returns contract-shaped values per `FakeOptions`. */
function fakeDeps(opts: FakeOptions = {}): {
  deps: TauriPlatformDeps;
  calls: string[];
} {
  const calls: string[] = [];
  // Explicit `null` (cancelled) must survive, so distinguish it from an omitted option (`undefined`)
  // rather than using `??`, which would collapse `null` back to the default.
  const dialogResult =
    opts.openDialogResult === undefined ? ["picked"] : opts.openDialogResult;
  const deps: TauriPlatformDeps = {
    createTempTextAttachment: async (text, filename) => {
      calls.push(`createTempTextAttachment:${text}|${String(filename)}`);
      return {
        filename: "x.txt",
        localPath: "/tmp/x.txt",
        mimeType: "text/plain" as const,
        sizeBytes: text.length,
      };
    },
    selectDirectory: async (multiple) => {
      calls.push(`selectDirectory:${multiple}`);
      return dialogResult;
    },
    showOpenDialog: async (options) => {
      calls.push(`showOpenDialog:${options.multiple === true}`);
      return dialogResult;
    },
    showTaskNotification: async (taskId, status, title, body, requestId) => {
      calls.push(
        `showTaskNotification:${taskId}|${status}|${title}|${body}|${String(requestId)}`,
      );
      if (opts.showTaskNotificationThrows) {
        throw new Error("permission denied");
      }
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
    listenDesktopZoomChanged: async (handler) => {
      calls.push("listenDesktopZoomChanged");
      // Hand the caller's handler straight back so the test can assert it was wired through.
      capturedZoomHandler = handler;
      return () => calls.push("unlisten");
    },
    listenWindowFullscreenChanged: async (handler) => {
      calls.push("listenWindowFullscreenChanged");
      capturedFullscreenHandler = handler;
      return () => calls.push("unlistenFullscreen");
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
  assert.deepEqual(calls, [
    "setWindowTheme:main:dark",
    "setWindowTheme:main:null",
  ]);
});

test("B1: openInFileManager delegates to openPath and returns {success:true}", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  assert.deepEqual(await platform.openInFileManager("/tmp/x"), {
    success: true,
  });
  assert.deepEqual(calls, ["openPath:/tmp/x"]);
});

test("B1: openInFileManager maps a rejected open to {success:false,error}", async () => {
  const { deps } = fakeDeps({ openFileThrows: true });
  const platform = createTauriPlatformSubset(deps);
  const result = await platform.openInFileManager("/nope");
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /open failed/);
});

test("B1: openExternalFile delegates to openPath and returns {success:true}", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  assert.deepEqual(await platform.openExternalFile!("/tmp/doc.pdf"), {
    success: true,
  });
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
  const zh = createTauriPlatformSubset(
    fakeDeps({ systemLocale: "zh-TW" }).deps,
  );
  const de = createTauriPlatformSubset(
    fakeDeps({ systemLocale: "de-DE" }).deps,
  );
  const en = createTauriPlatformSubset(
    fakeDeps({ systemLocale: "en-US" }).deps,
  );
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

/** Flush pending microtasks (the async-listen → sync-disposer bridge). */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

test("B1: createTauriPlatformSubset exposes EXACTLY the ported method set (public-surface lock)", () => {
  // With DEFAULT deps this only builds the object (no invoke is called at construction, and the
  // module import is side-effect-free per a6), so it is safe headless. This locks the adapter's
  // public surface: adding a method without a conformance case, or silently dropping one, fails here.
  // Every key MUST be a real IPlatformService member (the Pick enforces it) AND have a delegation
  // case above — the union of both is the ported set.
  const keys = Object.keys(createTauriPlatformSubset()).sort();
  assert.deepEqual(keys, [
    "createTempTextAttachment",
    "getDesktopZoomLevel",
    "getSystemLocale",
    "onDesktopZoomLevelChanged",
    "onWindowFullscreenChanged",
    "openExternal",
    "openExternalFile",
    "openInFileManager",
    "selectDirectory",
    "selectFile",
    "selectFiles",
    "setTitleBarTheme",
    "showTaskNotification",
  ]);
});

test("B1: onDesktopZoomLevelChanged wires the handler and its disposer unlistens", async () => {
  capturedZoomHandler = undefined;
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  const seen: { zoomLevel: number }[] = [];

  const dispose = platform.onDesktopZoomLevelChanged!((s) => seen.push(s));
  await flush();
  // The adapter handed our handler to listen(); firing it like a real push must reach the caller.
  capturedZoomHandler?.({ zoomLevel: 2.5 });
  assert.deepEqual(seen, [{ zoomLevel: 2.5 }]);

  dispose();
  assert.ok(
    calls.includes("unlisten"),
    "disposer must invoke the unlisten the fake returned",
  );
});

test("B1: onDesktopZoomLevelChanged unlistens even if disposed before listen resolves (no leak)", async () => {
  let unlistenCalls = 0;
  let resolveListen: (fn: () => void) => void = () => {};
  const deps = {
    ...fakeDeps().deps,
    listenDesktopZoomChanged: () =>
      new Promise<() => void>((resolve) => {
        resolveListen = (fn) => resolve(fn);
      }),
  } as unknown as TauriPlatformDeps;
  const platform = createTauriPlatformSubset(deps);

  const dispose = platform.onDesktopZoomLevelChanged!(() => {});
  // Dispose BEFORE the listen promise settles — the adapter must still tear down on arrival.
  dispose();
  resolveListen(() => {
    unlistenCalls += 1;
  });
  await flush();
  assert.equal(
    unlistenCalls,
    1,
    "late-arriving unlisten must be invoked to avoid a leaked subscription",
  );
});

test("B1: onWindowFullscreenChanged forwards the bare boolean and its disposer unlistens", async () => {
  capturedFullscreenHandler = undefined;
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  const seen: boolean[] = [];

  const dispose = platform.onWindowFullscreenChanged!((v) => seen.push(v));
  await flush();
  // The adapter handed our handler to listenWindowFullscreenChanged(); firing it like a real push
  // (a bare boolean, NOT a wrapped object) must reach the caller unchanged.
  capturedFullscreenHandler?.(true);
  capturedFullscreenHandler?.(false);
  assert.deepEqual(seen, [true, false]);

  dispose();
  assert.ok(
    calls.includes("unlistenFullscreen"),
    "disposer must invoke the unlisten the fullscreen fake returned",
  );
});

test("B1: showTaskNotification destructures the payload onto the command's flat args", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  // The interface takes a TaskNotificationPayload object; the command takes positional args. This
  // locks the mapping (including the requestId passthrough) so a field-order bug can't slip through.
  platform.showTaskNotification!({
    taskId: "task-1",
    status: "permission_request",
    title: "Approval",
    body: "needs you",
    requestId: "req-9",
  });
  await flush();
  assert.deepEqual(calls, [
    "showTaskNotification:task-1|permission_request|Approval|needs you|req-9",
  ]);
});

test("B1: showTaskNotification omits requestId and never surfaces a delivery rejection", async () => {
  const { deps } = fakeDeps({ showTaskNotificationThrows: true });
  const platform = createTauriPlatformSubset(deps);
  // void return + fire-and-forget: a rejected invoke (e.g. denied OS permission) must not throw to
  // the caller (mirrors Electron's `ipcRenderer.send`, which cannot reject). requestId absent -> "undefined".
  assert.doesNotThrow(() =>
    platform.showTaskNotification!({
      taskId: "t",
      status: "completed",
      title: "x",
      body: "y",
    }),
  );
  await flush();
});

test("B1: createTempTextAttachment delegates text + filename and returns the command result", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  const result = await platform.createTempTextAttachment!({
    text: "hello",
    filename: "note",
  });
  // The interface request object is destructured onto the command's positional (text, filename).
  assert.deepEqual(calls, ["createTempTextAttachment:hello|note"]);
  assert.equal(result.localPath, "/tmp/x.txt");
  assert.equal(result.sizeBytes, 5);
  assert.equal(result.mimeType, "text/plain");
});

test("B1: createTempTextAttachment forwards an absent filename as undefined", async () => {
  const { deps, calls } = fakeDeps();
  const platform = createTauriPlatformSubset(deps);
  await platform.createTempTextAttachment!({ text: "abc" });
  // No filename -> String(undefined) = "undefined" in the recorder, proving the adapter does NOT
  // invent a default; the bridge maps undefined -> null -> Rust Option::None.
  assert.deepEqual(calls, ["createTempTextAttachment:abc|undefined"]);
});

test("B1: onWindowFullscreenChanged unlistens even if disposed before listen resolves (no leak)", async () => {
  let unlistenCalls = 0;
  let resolveListen: (fn: () => void) => void = () => {};
  const deps = {
    ...fakeDeps().deps,
    listenWindowFullscreenChanged: () =>
      new Promise<() => void>((resolve) => {
        resolveListen = (fn) => resolve(fn);
      }),
  } as unknown as TauriPlatformDeps;
  const platform = createTauriPlatformSubset(deps);

  const dispose = platform.onWindowFullscreenChanged!(() => {});
  dispose();
  resolveListen(() => {
    unlistenCalls += 1;
  });
  await flush();
  assert.equal(
    unlistenCalls,
    1,
    "late-arriving unlisten must be invoked to avoid a leaked subscription",
  );
});
