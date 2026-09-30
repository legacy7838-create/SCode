/* eslint-disable max-lines -- install verification, the main-level permission session, and the drag TOCTOU guard all maintain the same Helper identity. */
// Authorized boot does not trigger any macOS native permission pop-ups. If each TCC stage first passes LaunchServices
// Pull up the Helper into one-time permission request mode, and hit AXIsProcessTrustedWithOptions{prompt:true} in the Helper process
// / CGRequestScreenCaptureAccess to "automatically appear in the permission list" at the cost of a system dialog box that interrupts the user.
// Only the corresponding settings page is opened. The Helper enters the TCC list by dragging .app into the list from the floating window.
// (In actual measurement, the auth_value after dragging in is directly 2, which is one step less than the pop-up window - the pop-up window only creates entries, and the user still needs to find and check them by himself).
// The signature verification fingerprint of each stage is no longer handed over to the final inspection before open(2), but is registered to the session and consumed by the synchronous comparison before dragstart.
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import type { CuaHelperInstallerOptions } from "@zcode/services/node";
import {
  resolveHelperPermissionSubjectIdentity,
  type HelperPermissionSubjectIdentity,
} from "@zcode/services/cua-permission-broker";
import type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { createDesktopCuaHelperInstaller } from "./desktopCuaHelperInstaller.js";

const MACOS_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

interface OpenCuaAccessibilitySettingsOptions {
  initialPermission?: CuaPermissionKind;
  requiredPermissions?: CuaPermissionKind[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** IPC-injected renderer/webContents identity from main; recovery is only granted once for repeated joins to the same host. */
  participantKey?: string;
  sessionTimeoutMs?: number;
  settingsReturnTimeoutMs?: number;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  ensureHelperInstalled?: () => Promise<string>;
  /** Injected explicitly by test or host; production default resolves packaged Helper from Electron Resources. */
  bundledHelperAppPath?: string;
  /** Complete installation verification is re-executed before each TCC stage is started; installer.verifyInstalled is used by default in production. */
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
  openSettingsUrl?: (url: string) => Promise<void>;
  /**
   * You must first register the return signal before calling openSettings to avoid System Settings switching/returning from the listener empty window.
   * IPC production adapter listens to Electron app/browser-window; pure single test can execute openSettings immediately and return.
   */
  openSettingsAndWaitForReturn?: (options: {
    permission: CuaPermissionKind;
    sessionId: string;
    timeoutMs: number;
    signal: AbortSignal;
    openSettings: () => Promise<void>;
  }) => Promise<void>;
}

// This only limits the machine stage of "whether the system settings appear successfully"; once the settings page is confirmed to be in the foreground, the user's checked permissions are no longer subject to the wall clock.
// Countdown constraints are only ended by surface cancel, origin destroyed or app quit.
const DEFAULT_SETTINGS_RETURN_TIMEOUT_MS = 2 * 60_000;
// The old drag-and-drop guide ranked screen recording first, in the opposite order to the permissions list the user saw;
// When both items are missing at the same time, the auxiliary function will be processed first, and then the screen recording will be processed.
const PERMISSION_STAGE_ORDER: readonly CuaPermissionKind[] = ["accessibility", "screen_recording"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Drag and drop TOCTOU door: .app that has been verified during prepare may be overwritten by the attacker with the same UID before the user drags it into the system settings.
// The TCC is bound to the dragged bundle identity. There must be *synchronization* evidence that "the bytes have not changed since the verification" when dragging - but for 120MB
// Bundle runs codesign too slowly and misses the dragstart gesture. Use lightweight byte fingerprinting instead: ino/ctime/size of critical files (ctime is
// inode change time, user mode cannot call back), any replacement of Mach-O / signature list / Info.plist will change the fingerprint. prepare
// Catch once every time, compare synchronously before dragstart, if not matched, drag will be refused + clear the cache and prepare again. All that remains is the difference between the comparison and startDrag.
// Microsecond window (same origin and same magnitude as launch path verifyInstalled→launch).
type CuaHelperBundleFingerprint = string;

function statSignature(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.ctimeNs}:${st.size}`;
  } catch {
    return "MISSING";
  }
}

function bundleTreeFingerprint(root: string, maxEntries = 512): string {
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: "." },
  ];
  const parts: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (parts.length >= maxEntries) return `${parts.join(",")},TOO_MANY`;
    parts.push(`${current.relativePath}:${statSignature(current.absolutePath)}`);
    let children: string[];
    try {
      children = readdirSync(current.absolutePath).sort();
    } catch {
      continue;
    }
    for (const child of children) {
      pending.push({
        absolutePath: join(current.absolutePath, child),
        relativePath: `${current.relativePath}/${child}`,
      });
    }
  }
  return parts.join(",");
}

function captureCuaHelperBundleFingerprint(appPath: string): CuaHelperBundleFingerprint {
  const parts = [
    `app=${statSignature(appPath)}`,
    `sig=${statSignature(join(appPath, "Contents", "_CodeSignature", "CodeResources"))}`,
    `info=${statSignature(join(appPath, "Contents", "Info.plist"))}`,
    // ax_macos.node and the runtime dylib distributed with SEA are located in Resources. Only use the stat of CodeResources
    // Unable to detect in-place overwriting of resource files; recursively use inode/ctime/size to reject this TOCTOU synchronously in dragstart.
    `resources=${bundleTreeFingerprint(join(appPath, "Contents", "Resources"))}`,
  ];
  try {
    const macosDir = join(appPath, "Contents", "MacOS");
    const entries = readdirSync(macosDir).sort();
    parts.push(
      `macos=${entries.map((entry) => `${entry}:${statSignature(join(macosDir, entry))}`).join(",")}`,
    );
  } catch {
    parts.push("macos=MISSING");
  }
  return parts.join("|");
}

export function cuaHelperBundleFingerprintUnchanged(
  appPath: string,
  fingerprint: CuaHelperBundleFingerprint,
): boolean {
  return captureCuaHelperBundleFingerprint(appPath) === fingerprint;
}

function normalizePermission(value: unknown): CuaPermissionKind {
  return value === "screen_recording" ? "screen_recording" : "accessibility";
}

function normalizeRequiredPermissions(
  options: OpenCuaAccessibilitySettingsOptions,
): CuaPermissionKind[] {
  const requested = Array.isArray(options.requiredPermissions)
    ? options.requiredPermissions
    : [normalizePermission(options.initialPermission)];
  const requestedSet = new Set(
    requested.filter(
      (permission): permission is CuaPermissionKind =>
        permission === "screen_recording" || permission === "accessibility",
    ),
  );
  return PERMISSION_STAGE_ORDER.filter((permission) => requestedSet.has(permission));
}

function settingsUrlForPermission(permission: CuaPermissionKind): string {
  return permission === "screen_recording"
    ? MACOS_SCREEN_RECORDING_SETTINGS_URL
    : MACOS_ACCESSIBILITY_SETTINGS_URL;
}

function sameHelperPermissionIdentity(
  expected: HelperPermissionSubjectIdentity,
  actual: HelperPermissionSubjectIdentity,
): boolean {
  return (
    expected.appPath === actual.appPath &&
    expected.executablePath === actual.executablePath &&
    expected.displayName === actual.displayName &&
    expected.bundleId === actual.bundleId
  );
}

async function verifyHelperPermissionIdentityUnchanged(
  identity: HelperPermissionSubjectIdentity,
  options: OpenCuaAccessibilitySettingsOptions,
  phase: "launch" | "post-settings",
): Promise<CuaHelperBundleFingerprint> {
  const fingerprint = captureCuaHelperBundleFingerprint(identity.appPath);
  await options.verifyHelperInstalled?.(identity.appPath);
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(`ZCode Computer Use changed while its ${phase} signature was being verified`);
  }
  const currentIdentity = await (
    options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
  )(identity.appPath);
  if (!sameHelperPermissionIdentity(identity, currentIdentity)) {
    throw new Error(`ZCode Computer Use permission identity changed during ${phase} verification`);
  }
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(
      `ZCode Computer Use changed while its ${phase} permission identity was being resolved`,
    );
  }
  return fingerprint;
}

type CuaHelperInstallerLogger = NonNullable<CuaHelperInstallerOptions["logger"]>;

function toInstallerLogger(
  logger: OpenCuaAccessibilitySettingsOptions["logger"],
): CuaHelperInstallerLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (_traceId, ...args) => logger.debug?.(...args),
    info: (_traceId, ...args) => (logger.info ?? logger.warn)(...args),
    warn: (_traceId, ...args) => logger.warn(...args),
    error: (_traceId, ...args) => (logger.error ?? logger.warn)(...args),
  };
}

interface ActiveOnboardingSession {
  identity: HelperPermissionSubjectIdentity;
  sessionId: string;
  controller: AbortController;
  activeParticipants: Set<number>;
  requiredPermissions: Set<CuaPermissionKind>;
  processedPermissions: Set<CuaPermissionKind>;
  openedPermissions: CuaPermissionKind[];
  acceptingRequirements: boolean;
  recoveryOwnerParticipantKeys: Set<string>;
  /**
   * The signature verification fingerprint evidence re-established at each stage is consumed by the synchronous comparison before dragstart.
   * (The dragged bundle is the TCC binding object).
   */
  launchFingerprint?: CuaHelperBundleFingerprint;
  promise?: Promise<CuaAccessibilitySettingsResult>;
}

/**
 * main-process level coordinator. key uses Helper's exact authorization identity instead of renderer/window/workspace: macOS TCC
 * Only this authorized subject is recognized. If the same subject concurrently fires two sets of native prompts, they will compete with each other for focus and produce an unrecoverable intermediate state.
 */
class CuaPermissionOnboardingCoordinator {
  private readonly sessions = new Map<string, ActiveOnboardingSession>();
  private nextParticipantId = 0;

  constructor(private readonly createSessionId: () => string = randomUUID) {}

  run(
    identity: HelperPermissionSubjectIdentity,
    requiredPermissions: CuaPermissionKind[],
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    // bundle id + displayName is not "exact Helper identity". Within the development/upgrade window, two different paths or
    // The executable bundle can share these two strings; if the session is merged by mistake, the post-join window will change the permission results and restore the permissions.
    // Bind to the first app. The coordination key covers all immutable fields of the identity after signature verification, and any path/executable changes are isolated.
    const identityKey = [
      identity.bundleId,
      identity.displayName,
      identity.appPath,
      identity.executablePath,
    ].join("\0");
    const existing = this.sessions.get(identityKey);
    if (existing?.promise) {
      if (existing.acceptingRequirements) {
        for (const permission of requiredPermissions) {
          existing.requiredPermissions.add(permission);
        }
        options.logger?.info?.(
          "[cua-permission-onboarding] joined active Helper permission session",
          existing.sessionId,
          identity.bundleId,
        );
        return this.joinSession(existing, options.signal, options.participantKey);
      }
      // The previous session has entered the final state, but the asynchronous cleanup of the precise permissions helper has not yet completed. You must wait until the identity key is actually released.
      // Try again without allowing the new session to overlap with late LaunchServices instances.
      return existing.promise.then(() => {
        if (options.signal?.aborted) {
          return this.canceledParticipantResult(existing, options.signal.reason);
        }
        return this.run(identity, requiredPermissions, options);
      });
    }

    const session: ActiveOnboardingSession = {
      identity,
      sessionId: this.createSessionId(),
      controller: new AbortController(),
      activeParticipants: new Set(),
      requiredPermissions: new Set(requiredPermissions),
      processedPermissions: new Set(),
      openedPermissions: [],
      acceptingRequirements: true,
      recoveryOwnerParticipantKeys: new Set(),
    };
    const promise = this.runSession(session, options).finally(() => {
      if (this.sessions.get(identityKey) === session) {
        this.sessions.delete(identityKey);
      }
    });
    session.promise = promise;
    this.sessions.set(identityKey, session);
    return this.joinSession(session, options.signal, options.participantKey);
  }

  private joinSession(
    session: ActiveOnboardingSession,
    signal?: AbortSignal,
    participantKey?: string,
  ): Promise<CuaAccessibilitySettingsResult> {
    this.nextParticipantId += 1;
    const participantId = this.nextParticipantId;
    const recoveryParticipantKey = participantKey?.trim() || `participant:${participantId}`;
    session.activeParticipants.add(participantId);

    return new Promise<CuaAccessibilitySettingsResult>((resolve) => {
      let active = true;
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        session.activeParticipants.delete(participantId);
      };
      const onAbort = () => {
        if (!active) return;
        active = false;
        detach();
        resolve(this.canceledParticipantResult(session, signal?.reason));
        if (session.activeParticipants.size === 0 && !session.controller.signal.aborted) {
          // A shared session cannot be owned exclusively by the first caller signal. Any window closed removes only itself; the last participant
          // Cancel native flow before leaving, and close the requirement join door first. Subsequent explicit retries will wait for accurate cleanup.
          session.acceptingRequirements = false;
          session.controller.abort(
            signal?.reason ?? new Error("all CUA permission onboarding windows closed"),
          );
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      void session.promise!.then((result) => {
        if (!active) return;
        active = false;
        detach();
        const returned =
          result.success === true &&
          result.returnedFromSettings === true &&
          typeof result.sessionId === "string";
        // Promise continuations are executed serially within the main event loop. Repeated calls to the same renderer/webContents only
        // There is one to obtain recovery rights; different windows each have an independent host/Helper, and each must obtain recovery rights once, and global deduplication is not possible.
        const ownsRecovery =
          returned && !session.recoveryOwnerParticipantKeys.has(recoveryParticipantKey);
        if (ownsRecovery) session.recoveryOwnerParticipantKeys.add(recoveryParticipantKey);
        resolve({
          ...result,
          ...(returned ? { restartHelperAfterReturn: ownsRecovery } : {}),
        });
      });
    });
  }

  private canceledParticipantResult(
    session: ActiveOnboardingSession,
    reason: unknown,
  ): CuaAccessibilitySettingsResult {
    return {
      success: false,
      canceled: true,
      sessionId: session.sessionId,
      returnedFromSettings: false,
      error: `permission onboarding canceled: ${messageOf(
        reason ?? new Error("origin window closed"),
      )}`,
    };
  }

  private async runSession(
    session: ActiveOnboardingSession,
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    const configuredSessionTimeoutMs = options.sessionTimeoutMs;
    const sessionTimeoutMs =
      typeof configuredSessionTimeoutMs === "number" && Number.isFinite(configuredSessionTimeoutMs)
        ? Math.max(1, configuredSessionTimeoutMs)
        : null;
    const startedAt = Date.now();
    const controller = session.controller;
    const sessionTimer =
      sessionTimeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(`CUA permission onboarding session exceeded ${sessionTimeoutMs}ms`),
              ),
            sessionTimeoutMs,
          );
    let returnedCount = 0;

    try {
      while (true) {
        const permission = PERMISSION_STAGE_ORDER.find(
          (candidate) =>
            session.requiredPermissions.has(candidate) &&
            !session.processedPermissions.has(candidate),
        );
        if (!permission) {
          // The final identity check after the last page is returned will still await; if the join door remains open, the new permissions will be in
          // After the while has ended, it is silently merged and receives false success. Close the join door synchronously, allowing subsequent requests to wait for cleanup to open a new session.
          session.acceptingRequirements = false;
          break;
        }
        session.processedPermissions.add(permission);
        const remainingMs =
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : sessionTimeoutMs - (Date.now() - startedAt);
        if (Number.isFinite(remainingMs) && remainingMs <= 0) {
          controller.abort(new Error("CUA permission onboarding session timed out"));
          throw controller.signal.reason;
        }
        // The signature verification evidence of ensureInstalled for the first time cannot be reused across the time the user stays on the settings page. Processes with the same UID can be found in
        // Replace the installation directory before the next stage, causing the authorization to fall to another bundle. Each stage starts with “pre-fingerprint snapshot → complete
        // The evidence is re-established in the order of verify → accurate identity review → fingerprint and post-snapshot; any changes are fail-closed.
        //
        // The final check is synchronized before dragstart: Helper enters the TCC list by user dragging.
        // And TCC is bound to the bundle that was dragged in, so "the bytes have not changed before dragging" is close to
        // Real risks. The fingerprint is registered to the session for drag cache consumption (see desktopCuaPermissionIpc).
        session.launchFingerprint = await verifyHelperPermissionIdentityUnchanged(
          session.identity,
          options,
          "launch",
        );
        if (controller.signal.aborted) throw controller.signal.reason;

        const openSettingsUrl =
          options.openSettingsUrl ?? ((url: string) => shell.openExternal(url));
        const openSettings = async () => {
          await openSettingsUrl(settingsUrlForPermission(permission));
          if (!session.openedPermissions.includes(permission)) {
            session.openedPermissions.push(permission);
          }
        };
        const returnTimeoutMs = Math.min(
          options.settingsReturnTimeoutMs ?? DEFAULT_SETTINGS_RETURN_TIMEOUT_MS,
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : Math.max(1, sessionTimeoutMs - (Date.now() - startedAt)),
        );
        if (options.openSettingsAndWaitForReturn) {
          await options.openSettingsAndWaitForReturn({
            permission,
            sessionId: session.sessionId,
            timeoutMs: returnTimeoutMs,
            signal: controller.signal,
            openSettings,
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          returnedCount += 1;
        } else {
          // The old interface does not have a main return signal: retain the compatible behavior of "open settings page", but must never fake return=true.
          await openSettings();
          if (controller.signal.aborted) throw controller.signal.reason;
        }
      }

      // Helper upgrade/replacement may still occur between the last page return and restart. IPC background refresh drag cache does not belong to this time
      // Authorization evidence; the signature must be re-verified and bound to the same identity before success. When it changes, it is fail-closed and no recovery rights are issued.
      if (session.openedPermissions.length > 0) {
        await verifyHelperPermissionIdentityUnchanged(session.identity, options, "post-settings");
        if (controller.signal.aborted) throw controller.signal.reason;
      }
      return {
        success: true,
        sessionId: session.sessionId,
        returnedFromSettings:
          session.openedPermissions.length > 0 &&
          returnedCount === session.openedPermissions.length,
        error: undefined,
      };
    } catch (error) {
      session.acceptingRequirements = false;
      return {
        success: false,
        canceled: controller.signal.aborted || undefined,
        sessionId: session.sessionId,
        returnedFromSettings: false,
        error: `permission onboarding failed: ${messageOf(error)}`,
      };
    } finally {
      if (sessionTimer) clearTimeout(sessionTimer);
    }
  }
}

const mainCuaPermissionOnboardingCoordinator = new CuaPermissionOnboardingCoordinator();

export async function openCuaPermissionOnboarding(
  options: OpenCuaAccessibilitySettingsOptions = {},
): Promise<CuaAccessibilitySettingsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  let helperAppPath: string;
  try {
    helperAppPath = await (options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled)();
  } catch (error) {
    // Security boundary: When installation/verification fails
    // Must fail-closed and never fall back to the "path exists and used" unverified Helper - otherwise it will lead the user to Accessibility/
    // Screen Recording licenses old versions/bad signatures/buggy Team/replaced bundles, breaking "Helper is independent and subject to
    // "TeamIdentifier pinning's authorized principal" is the core boundary. The dev scene is handled by the installer inside
    // ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL takes over: ensureInstalled will return to the local app normally when passing dev verification.
    // This catch will not be entered at all; it will only come here if the actual verification fails.
    return {
      success: false,
      error: `ZCode Computer Use is unavailable (install/verification failed): ${messageOf(error)}`,
    };
  }

  let identity: HelperPermissionSubjectIdentity;
  try {
    identity = await (options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity)(
      helperAppPath,
    );
  } catch (error) {
    return {
      success: false,
      returnedFromSettings: false,
      error: `ZCode Computer Use permission identity verification failed: ${messageOf(error)}`,
    };
  }
  const verifiedOptions: OpenCuaAccessibilitySettingsOptions = {
    ...options,
    ...(options.verifyHelperInstalled
      ? { verifyHelperInstalled: options.verifyHelperInstalled }
      : defaultInstaller
        ? { verifyHelperInstalled: defaultInstaller.verifyInstalled }
        : {}),
  };
  return mainCuaPermissionOnboardingCoordinator.run(
    identity,
    normalizeRequiredPermissions(options),
    verifiedOptions,
  );
}

// The 2026-08 audit once deleted the drag and drop link as dead code (at that time, the rendering layer had no caller, and permission guidance relied on native pop-up windows to let the Helper
// Automatically enter the TCC list). After the pop-up window is removed, dragging becomes the **only** way for Helper to enter the permission list.
// Therefore, this function is restored. openCuaAccessibilitySettings (old confirmation popup channel) is not restored, it has been replaced by onboarding.

interface PrepareCuaHelperPermissionDragOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: OpenCuaAccessibilitySettingsOptions["logger"];
  /** Install+verify that shares the desktop installer factory with onboarding. Tests can be injected. */
  ensureHelperInstalled?: () => Promise<string>;
  bundledHelperAppPath?: string;
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
}

export interface PrepareCuaHelperPermissionDragMainResult extends PrepareCuaHelperPermissionDragResult {
  /**
   * Synchronous bundle fingerprint bound before and after this round's full code-signature
   * verification. Only the in-main memory cache may consume it — the IPC handler must strip this
   * field before returning to the renderer (exposing it across processes is both useless and a
   * wider attack surface).
   */
  helperBundleFingerprint?: CuaHelperBundleFingerprint;
}

// Drag-and-drop authorization and onboarding ultimately lead to the same TCC authorization subject, and the security verification must be consistent: the disk is old/badly signed/
// Error Team / .app replaced with user-writable content If dragged into Accessibility/Screen Recording, TCC authorization will fall into
// Error body, bypassing the entire TeamIdentifier pinning design. So you must go to the same install+verify before dragging
// (bundle id/version/arch/codesign/TeamIdentifier/Gatekeeper).
//
// However, Electron's native file drag requires event.sender.startDrag() to be called *synchronously* in the dragstart event link.
// Can't wait for these asynchronous I/O (otherwise the OS drag gesture window will be missed and the user will not be able to drag out any files). So put install+verify
// Split into this function: preheat and cache the verified path + fingerprint when the floating window is mounted, dragstart read-only cache and synchronize comparison (see
// desktopCuaPermissionIpc).
export async function prepareCuaHelperPermissionDrag(
  options: PrepareCuaHelperPermissionDragOptions = {},
): Promise<PrepareCuaHelperPermissionDragMainResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled
    )();
    // The key is the order: first capture the snapshot, then complete the verification, and then double-check once after the signature verification and after reading the identity. If in ensure/verify
    // By grabbing the fingerprint only after returning, the attacker can replace .app between the two, causing the malicious bytes to become "verified fingerprints" instead. Only the whole process remains unchanged
    // The same batch of bytes is allowed to be delivered to the synchronized dragstart cache.
    const verifiedFingerprint = captureCuaHelperBundleFingerprint(helperAppPath);
    await (options.verifyHelperInstalled ?? defaultInstaller?.verifyInstalled)?.(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag signature was being verified");
    }
    const identity = await (
      options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
    )(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag identity was being resolved");
    }
    return {
      success: true,
      helperAppPath,
      helperDisplayName: identity.displayName,
      helperBundleId: identity.bundleId,
      helperBundleFingerprint: verifiedFingerprint,
    };
  } catch (error) {
    const message = messageOf(error);
    options.logger?.warn(
      "[cua-permission-onboarding] helper install/verify failed; refusing to prepare drag of an unverified Helper",
      message,
    );
    return { success: false, error: message };
  }
}
