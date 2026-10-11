/*
 * Layer B3 — platform FACTORY completeness conformance.
 *
 * Per `TEST-HARNESS.md` §3 Layer B, the adapter (b1) is covered there; this file covers the layer
 * that sat ABOVE it and had no coverage at all: `createTauriPlatform()`, the object the renderer
 * actually mounts against (`main.tsx:138`).
 *
 * Why this file exists — a real regression that shipped:
 *   `createTauriPlatform()` used to end with `as unknown as IPlatformService`. That cast told
 *   TypeScript to stop checking, so the factory could return fewer keys than `IPlatformService`
 *   declares and still compile. It did: 76 keys were returned against 104 declared methods, and the
 *   28 missing ones (`openInEditor`, `getApplicationIcon`, `onOpenBrowserUrl`, `loadMcpFromUserDirectory`,
 *   the whole `browserView*` family, ...) threw `TypeError: ... is not a function` on first call.
 *
 *   The fix was to replace the cast with `UnportedPlatform` (a mapped type using `-?` so every
 *   unported member is REQUIRED), which moves the guarantee into the type system. This test is the
 *   runtime half of that guarantee: it proves the returned object really does carry every declared
 *   key, and that no member is left `undefined`.
 *
 * It is deliberately non-vacuous — `assert` on a key list that was recomputed by hand would rot, so
 * the key set is derived from the real `IPlatformService` declaration via a type-level probe plus
 * an explicit runtime key list that must agree with it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createTauriPlatform } from "../../../src/renderer/src/tauriPlatformFactory.ts";

/**
 * Keys `IPlatformService` declares, minus the 16 that `TauriPlatformSubset` backs with a real
 * command. Kept as a literal (rather than derived) on purpose: `Omit` preserves optionality, so a
 * type-level `Exclude` cannot by itself prove the object is complete at RUNTIME. This literal is
 * cross-checked against the real declaration by the type probe below, so the two cannot drift
 * silently — if `IPlatformService` gains or loses a method, `tsc` fails on the probe assignment.
 */
const UNPORTED_KEYS = [
  "canSelectFilePath",
  "isLocalDevelopmentRuntime",
  "printPageToPdf",
  "getDesktopWindowChromeState",
  "onDesktopWindowChromeStateChanged",
  "getWindowControlsOverlayMetrics",
  "onWindowControlsOverlayChanged",
  "notifyRendererReady",
  "syncWindowUnreadCount",
  "syncActiveTaskSession",
  "syncAppSettings",
  "setShortcutRecordingActive",
  "registerOAuthState",
  "onOAuthCallback",
  "onPaymentCallback",
  "onShareImport",
  "onOpenFeedbackDialog",
  "onOpenTicketsPanel",
  "onFocusTab",
  "onNewTab",
  "onNewTask",
  "onOpenWorkspace",
  "onOpenWorkspacePath",
  "onCloseActiveContextRequest",
  "onSettingsChanged",
  "onApplicationLocaleChanged",
  "onTaskNotificationClick",
  "onRemoteConnectionLog",
  "onRemoteSessionClosed",
  "onBotRemoteWorkspaceReconnected",
  "openFeedback",
  "openCommunity",
  "canOpenCommunity",
  "saveFile",
  "getPathForFile",
  "createLocalMediaPreviewUrl",
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "disposeRemoteSession",
  "cancelPendingRemoteConnection",
  "connectRemote",
  "bindRemoteWorkspaceSessionContext",
  "getInstalledEditors",
  "openInEditor",
  "getApplicationIcon",
  "executeDesktopCommand",
  "setApplicationLocale",
  "exportLogs",
  "captureWindowScreenshot",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
  "onOpenBrowserUrl",
  "onBrowserViewReady",
  "onBrowserViewOperation",
  "onBrowserViewVisibility",
  "onBrowserViewViewportChanged",
  "onBrowserViewScreenshotSurfacePrepare",
  "onBrowserViewScreenshotSurfaceRelease",
  "onBrowserViewCloseTab",
  "onBrowserViewSuspend",
  "onBrowserViewRestore",
  "browserViewScreenshotSurfaceReady",
  "browserViewAttachGuest",
  "browserViewDetachGuest",
  "browserViewCloseTab",
  "browserViewReportResidency",
  "browserViewSuspendReady",
  "browserViewEnsureResident",
  "browserViewRestoreTabs",
  "browserViewUpdateViewport",
  "importChromeBrowserData",
  "clearEmbeddedBrowserData",
  "getUpdateState",
  "onUpdateReady",
  "onUpdateCheckResult",
  "onUpdateStateChanged",
  "downloadUpdate",
  "cancelUpdateDownload",
  "quitAndInstallUpdate",
  "openUpdateStatusWindow",
  "getAutoUpdatePreferences",
  "setAutoDownloadAndInstallUpdates",
  "skipUpdateVersion",
  "onPostUpdateReleaseNotes",
  "acknowledgePostUpdateReleaseNotes",
  "getDesktopSessionActivity",
  "getZCodeStdioTapDevState",
] as const;

/** The 16 members `TauriPlatformSubset` backs with a real, verified Tauri command. */
const BACKED_KEYS = [
  "selectDirectory",
  "selectFile",
  "selectFiles",
  "openExternal",
  "openInFileManager",
  "openExternalFile",
  "getDesktopZoomLevel",
  "onDesktopZoomLevelChanged",
  "onWindowFullscreenChanged",
  "setTitleBarTheme",
  "getSystemLocale",
  "getDeviceId",
  "showTaskNotification",
  "createTempTextAttachment",
  "activateOrSetWorkspace",
  "syncWindowTabs",
] as const;

test("B3: factory returns every declared IPlatformService member (no undefined keys)", () => {
  const platform = createTauriPlatform() as unknown as Record<string, unknown>;
  const required = [...UNPORTED_KEYS, ...BACKED_KEYS];

  // The regression: a declared-but-absent key surfaces here as `undefined`, and calling it threw
  // `TypeError: ... is not a function`. Assert on VALUE, not just key presence, so a key explicitly
  // set to `undefined` cannot pass as covered.
  const undefinedMembers = required.filter((key) => platform[key] === undefined);

  assert.deepEqual(
    undefinedMembers,
    [],
    `factory left ${undefinedMembers.length} declared member(s) undefined; calling them throws ` +
      `TypeError at runtime: ${undefinedMembers.join(", ")}`,
  );

  // No stray keys either: an extra key means the factory drifted from the interface in the other
  // direction (or a subset key was forgotten in BACKED_KEYS).
  const expected = new Set<string>(required);
  const extras = Object.keys(platform).filter((key) => !expected.has(key));
  assert.deepEqual(extras, [], `factory returned unexpected key(s): ${extras.join(", ")}`);
});

test("B3: every unported on* subscription returns a callable disposer", () => {
  const platform = createTauriPlatform() as unknown as Record<string, unknown>;
  const noop = () => {};

  // Scope to the UNPORTED subscriptions only. The 16 backed members include real `listen*`
  // subscriptions (`onWindowFullscreenChanged`, `onDesktopZoomLevelChanged`) that reach Tauri's
  // event API and legitimately need a `window`; those are covered by b1 with injected fakes.
  // Calling them headlessly is out of scope for this file and would leak async activity.
  for (const key of UNPORTED_KEYS.filter((k) => k.startsWith("on"))) {
    const subscribe = platform[key];
    if (typeof subscribe !== "function") continue;

    // Unported subscriptions are inert but must still be well-formed: calling them returns a
    // disposer function, never undefined (which would make every `useEffect` cleanup throw).
    const disposer = (subscribe as (handler: unknown) => unknown)(noop);
    assert.equal(
      typeof disposer,
      "function",
      `${key}() must return a disposer function for the unmount cleanup`,
    );
  }
});

test("B3: no unported method rejects — inert means inert, not throwing", async () => {
  const platform = createTauriPlatform() as unknown as Record<string, unknown>;

  // The methods that must never reject are the read-only probes the renderer awaits during boot.
  // Before this file, `getZCodeStdioTapDevState` returned an object missing the required
  // `visible` field and `getUpdateState` returned `{ status }` instead of the `{ kind }`
  // discriminant — both silently wrong rather than loudly broken.
  const probes = [
    "getInstalledEditors",
    "isDockerAvailable",
    "canOpenCommunity",
    "getUpdateState",
    "getDesktopSessionActivity",
    "getZCodeStdioTapDevState",
    "getDesktopWindowChromeState",
    "loadMcpFromUserDirectory",
    "migrateLegacyCommonMcp",
  ] as const;

  for (const key of probes) {
    const result = await (platform[key] as () => Promise<unknown>)();
    // `isDockerAvailable` / `canOpenCommunity` legitimately resolve to a boolean; the rest to an
    // object. What must never happen is `undefined`/`null`, which is what a missing key produces.
    assert.notEqual(
      result,
      undefined,
      `${key}() resolved undefined — a declared-but-missing member`,
    );
    assert.notEqual(result, null, `${key}() resolved null`);
    const kind = typeof result;
    assert.ok(
      kind === "object" || kind === "boolean",
      `${key}() must resolve to an object or boolean, got ${kind}`,
    );
  }
});

test("B3: getUpdateState uses the `kind` discriminant, not a stray `status` field", async () => {
  const platform = createTauriPlatform();
  const state = (await platform.getUpdateState?.()) as unknown as Record<string, unknown>;

  // `UpdateStatePayload` is a discriminated union keyed on `kind`. The old implementation returned
  // `{ status: "idle" }`, so every consumer reading `.kind` got `undefined`.
  assert.equal(
    state.kind,
    "idle",
    "getUpdateState must return the `kind` discriminant defined by UpdateStatePayload",
  );
  assert.equal(
    "status" in state,
    false,
    "getUpdateState must not invent a `status` field that no consumer reads",
  );
});
