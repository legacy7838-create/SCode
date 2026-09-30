/* eslint-disable max-lines -- desktop runtime/env resolution must keep the main/host/remote assets startup boundary in one place; splitting it would widen the remote-connection regression surface. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ConnectOptions } from "@zcode/server/remote";
import { listSSHConfigAliasesFromLocalConfig } from "@zcode/services/node";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  ZCODE_APP_VERSION_ENV,
  ZCODE_AGENT_RUNTIME,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
  buildZCodeToolEnvPassthroughEnv,
  resolveRuntimeZCodeEndpointOrigin,
  readProductEndpointEnv,
  pickProductEndpointEnv,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  normalizeDynamicWorkflowMode,
  readZCodeAgentTelemetryEnv,
  sanitizeZCodeRuntimeEnv,
  type ZCodeRuntimeEnv,
} from "@zcode/shared";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import {
  getAppConfigDir,
  getDataBaseDir,
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "@zcode/services/node";
import {
  resolveRemoteCdnBaseUrls as resolveOrderedRemoteCdnBaseUrls,
  type ResolveRemoteCdnOptions,
} from "./remoteCdn.js";
import { getElectronAppPath, isElectronAppPackaged } from "./desktopElectronApp.js";

const isLocalDevelopmentRuntime = !isElectronAppPackaged();
export const desktopRuntimeEnv: ZCodeRuntimeEnv = isLocalDevelopmentRuntime
  ? "development"
  : "production";
// The identity depends on the compile-time flavor instead of ZCODE_ENV: the production backend build with ZCODE_PREVIEW_IDENTITY=1 is also Preview.
// A separate application name, Electron data directory, and Helper installation subdirectory are required to run side by side with the official version.
const isPreviewPackagedRuntime = !isLocalDevelopmentRuntime && ZCODE_PRODUCT_FLAVOR === "preview";

function readRuntimeEnvOverride(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function isTruthyRuntimeEnvOverride(name: string): boolean {
  const value = readRuntimeEnvOverride(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// e2e runs a production build, and by default will share the app name / userData with the official version of ZCode.
// After triggering the Electron single instance lock, only the existing window is activated, and Chromedriver cannot take over the test process.
// This allows testing to explicitly isolate the runtime identity, with the normal desktop/remote paths kept at their original defaults.
export const runtimeApplicationName =
  readRuntimeEnvOverride("ZCODE_DESKTOP_APPLICATION_NAME") ??
  (isLocalDevelopmentRuntime ? "ZCode Dev" : isPreviewPackagedRuntime ? "ZCode Preview" : "ZCode");
// Electron's app.getPath("home") does not necessarily follow the HOME coverage in the test process.
// The default workspace of e2e relies on the home path, so it provides explicit coverage to avoid writing tests to the developer's real ~/ZCodeProject.
export const runtimeHomePath = readRuntimeEnvOverride("ZCODE_DESKTOP_HOME_DIR");
// Chromedriver will inject temporary userData when managing Electron; appData cannot be read in advance during the import period in e2e default path mode.
export const shouldUseElectronDefaultUserDataPath = isTruthyRuntimeEnvOverride(
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
);
export const runtimeUserDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ??
  (shouldUseElectronDefaultUserDataPath
    ? undefined
    : join(getElectronAppPath("appData"), runtimeApplicationName));
export const runtimeSessionDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
  (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined);
// Chromedriver will inject the temporary --user-data-dir and wait for DevToolsActivePort in that directory.
// e2e If you use app.setPath to overwrite userData/sessionData, the port file will be written to another directory.
// As a result, Electron has been started but WebDriver session creation continues to fail. Keep the Chromedriver directory after turning on this switch in test mode.
export const hostModulePath = join(import.meta.dirname, "../host/index.js");
export const schedulerModulePath = join(import.meta.dirname, "../scheduler/index.js");
export function getCredentialsDir() {
  return getAppConfigDir();
}

export type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;
type LocalRuntimeEnv = Record<string, string | undefined>;

export async function listAvailableWSLDistros() {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
}

export async function listSSHConfigAliases() {
  return await listSSHConfigAliasesFromLocalConfig();
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function resolveWorkspaceRootForEnvFiles(): string | null {
  const workspaceRootCandidate = resolve(import.meta.dirname, "../../../..");
  return existsSync(join(workspaceRootCandidate, "pnpm-workspace.yaml"))
    ? workspaceRootCandidate
    : null;
}

export function loadHostProcessEnvFromLocalFiles(): Record<string, string> {
  if (isElectronAppPackaged()) {
    // The installation package does not embed OTLP endpoints or authentication to prevent CI credentials from being exposed with the product; connection configuration is provided by the runtime environment.
    // Only packaged identity metadata is retained, escalation is not enabled when endpoints are missing.
    return { ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged" };
  }

  const desktopRoot = resolve(import.meta.dirname, "../..");
  const workspaceRoot = resolveWorkspaceRootForEnvFiles();
  const fileCandidates = [
    ...(workspaceRoot
      ? [resolve(workspaceRoot, ".env"), resolve(workspaceRoot, ".env.local")]
      : []),
    // The development host process does not go through Vite and loads the same .env file by itself to keep the OAuth configuration consistent.
    ...(workspaceRoot && isLocalDevelopmentRuntime
      ? [
          resolve(workspaceRoot, ".env.development"),
          resolve(workspaceRoot, ".env.development.local"),
        ]
      : []),
    resolve(desktopRoot, ".env"),
    resolve(desktopRoot, ".env.local"),
    ...(isLocalDevelopmentRuntime
      ? [resolve(desktopRoot, ".env.development"), resolve(desktopRoot, ".env.development.local")]
      : []),
  ];

  const merged: Record<string, string> = {};
  const seen = new Set<string>();

  for (const candidate of fileCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!existsSync(candidate)) {
      continue;
    }

    // Previously, when pressing cwd to search for .env in the upper-level directory, it was easy to mistakenly read a file with the same name outside the workspace.
    // Here, the loading scope is converged to the workspace root and desktop package directories to avoid configuration source drift.
    const parsed = parseDotenv(readFileSync(candidate, "utf-8"));
    Object.assign(merged, parsed);
  }

  return applySelectedZCodeEnvLinks(merged);
}

function resolveDevelopmentMockCdnDir(): string {
  return join(import.meta.dirname, "../../mock-cdn");
}

function resolveAvailableDevelopmentMockCdnDir(): string | undefined {
  const mockCdnDir = resolveDevelopmentMockCdnDir();
  const releaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  // Development mock-cdn is an optional offline cache. If the current version directory does not exist, continue to pass mockCdnDir.
  // This will cause WSL/SSH reconnection to hit a local path that must be missing first, covering up the existing CDN/cache fallback.
  return existsSync(releaseDir) ? mockCdnDir : undefined;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldUseRemoteCdnInDevelopment(localEnv: LocalRuntimeEnv = {}): boolean {
  return isTruthyEnvFlag(resolveEnvValue("ZCODE_DEV_REMOTE_ASSET_USE_CDN", localEnv));
}

function resolveRemoteCdnBaseUrls(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): string[] {
  const raw = resolveEnvValue("ZCODE_REMOTE_ASSET_CDN_BASE_URL", localEnv);
  return resolveOrderedRemoteCdnBaseUrls({
    ...options,
    env: ZCODE_ENV,
    overrideBaseUrl: raw,
    version: ZCODE_VERSION,
  });
}

function resolveEnvValue(envName: string, localEnv: LocalRuntimeEnv = {}): string | undefined {
  return process.env[envName]?.trim() || localEnv[envName]?.trim() || undefined;
}

export function resolveZCodeEndpointEnvBaseOrigin(
  localEnv: LocalRuntimeEnv = {},
): string | undefined {
  const buildEnv = readProductEndpointEnv();
  // The main process will not rewrite .env when temporarily verifying the update service. The endpoint passed in from the command line must take precedence over local files.
  return (
    process.env["ZCODE_BASE_URL"]?.trim() ||
    process.env["ZCODE_ENDPOINT_ORIGIN"]?.trim() ||
    localEnv.ZCODE_BASE_URL?.trim() ||
    localEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    buildEnv.ZCODE_BASE_URL?.trim() ||
    buildEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    undefined
  );
}

function readDefinedProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function applySelectedZCodeEnvLinks(env: Record<string, string>): Record<string, string> {
  const endpointEnv = {
    ...readProductEndpointEnv(),
    ...env,
    ZCODE_ENV,
  };

  return {
    ...pickProductEndpointEnv(endpointEnv),
    ...env,
    ZCODE_BASE_URL: env.ZCODE_BASE_URL ?? resolveRuntimeZCodeEndpointOrigin(endpointEnv),
    ZAI_OAUTH_ORIGIN: env.ZAI_OAUTH_ORIGIN ?? resolveZaiOAuthOrigin(endpointEnv),
    ZAI_BUSINESS_BASE_URL: env.ZAI_BUSINESS_BASE_URL ?? resolveZaiBusinessBaseUrl(endpointEnv),
    ZAI_OAUTH_CLIENT_ID: env.ZAI_OAUTH_CLIENT_ID ?? resolveZaiOAuthClientId(endpointEnv),
  };
}

function resolveHostProcessNodeEnv(): ZCodeRuntimeEnv {
  return desktopRuntimeEnv;
}

function resolveRemoteAssetCacheDir(localEnv: LocalRuntimeEnv = {}): string {
  const overrideCacheDir = resolveEnvValue("ZCODE_REMOTE_ASSET_CACHE_DIR", localEnv);
  if (overrideCacheDir) {
    // The development state needs to reuse the official version of the remote cache to verify the download judgment, but cannot switch the Electron userData as a whole.
    // Therefore, only the remote assets cache directory is allowed to be overwritten to avoid contaminating login status, window status and other development data.
    return resolve(overrideCacheDir);
  }

  return join(getElectronAppPath("userData"), "remote-assets-cache");
}

export function resolveRemoteAssetDirs(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): RemoteAssetDirs {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options, localEnv);
  const remoteCdnBaseUrl = remoteCdnBaseUrls[0];

  // The remote resource previously shared the path in the installation package with the desktop local provider resource.
  // As a result, after packaging, the entire Linux remote runtime will be stuffed into the .app, which conflicts with the responsibility boundary of "remote resources go to CDN / mock-cdn".
  // This is changed to explicit diversion: mock-cdn in the read-only warehouse in the development state; CDN + local cache directory in the production state.
  // No longer expose the remote-assets path in any installation package to prevent remote resources from being stuffed back into the installation package again.
  // Function switch: The development state continues to use mock-cdn by default. Only when the switch is explicitly turned on can it switch to the public network CDN.
  // This is compatible with offline development scenarios and allows the real CDN download link to be verified in the development environment in advance.
  if (isElectronAppPackaged() || shouldUseRemoteCdnInDevelopment(localEnv)) {
    return {
      remoteCdnBaseUrl,
      remoteCdnBaseUrls,
      remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
    };
  }

  const developmentMockCdnDir = resolveAvailableDevelopmentMockCdnDir();
  return {
    ...(developmentMockCdnDir ? { mockCdnDir: developmentMockCdnDir } : {}),
    remoteCdnBaseUrl,
    remoteCdnBaseUrls,
    remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
  };
}

function resolveBundledZCodeAgentBinaryPath(): string | undefined {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const platformKey = resolvePlatformKeyForPackagedApp();
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, runtime.bundledResourceDir, ...entrySegments)
      : null,
    // The startup cwd of desktop development mode may be packages/desktop, or it may be the warehouse root.
    // Previously, bundled-agents were only deduced based on the relative path of import.meta.dirname.
    // Here, multiple candidate root directories that are consistent with the services side are completed to avoid resource parsing drift caused by different development/build/restart entrances.
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      import.meta.dirname,
      "../../bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledRuntimeToolBinaryPath(
  toolDir: string,
  binaryName: string,
): string | undefined {
  const candidateBinaryName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, "tools", toolDir, candidateBinaryName)
      : null,
    join(
      import.meta.dirname,
      "../../bundled-tools",
      resolvePlatformKeyForPackagedApp(),
      toolDir,
      candidateBinaryName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledLarkCliBinaryPath(): string | undefined {
  return resolveBundledRuntimeToolBinaryPath("lark-cli", "lark-cli");
}

export function resolveBundledGlmBinaryPath(): string | undefined {
  return resolveBundledZCodeAgentBinaryPath();
}

function resolveHostProcessBinaryEnv(
  envVar: string,
  hostProcessLocalEnv: Record<string, string>,
  bundledPath: string | undefined,
): string | undefined {
  // ZCode Agent and the app protocol adapt to the strongly binding version, and the production package must first use the fixed runtime carried with the package.
  // Even if the residual GLM_BINARY_PATH in the user machine or local .env exists, the version may be incompatible.
  // Only when the bundled runtime is missing, the explicit path will be used as a fallback to prevent the user's native CLI from overwriting the embedded version.
  if (bundledPath) {
    return bundledPath;
  }
  const explicitPath = process.env[envVar]?.trim() || hostProcessLocalEnv[envVar]?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return undefined;
}

function resolveWindowsAppInstallDirForDataBaseDirGuard(
  options: {
    platform?: NodeJS.Platform | string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (platform !== "win32" || !packaged) {
    return undefined;
  }

  const trimmedResourcesPath = resourcesPath?.trim();
  if (!trimmedResourcesPath) {
    return undefined;
  }

  return win32.dirname(trimmedResourcesPath);
}

/**
 * The local coverage of Dynamic Workflow grayscale is divided into three layers according to the build level.
 *
 *   - Unpackaged dev: transparently transmits legal values in the shell to facilitate manual file switching; illegal values are directly discarded instead of forwarded to the Host.
 *     Host therefore does not have to judge the source again;
 *   - Package preview: Fixed writing `alwaysOn`, ignoring shell, preview users always have this function;
 *   - Packaging for production: no writing, and the inherited value must be deleted, otherwise the local environment variable can turn on grayscale by itself.
 * Main is the only decision-maker: there are only two actions for this key: "write" and "delete", and it will never be transparently transmitted as it is.
 * Only the resolveDynamicWorkflowClientConfig on the Host side can unconditionally believe the value read.
 */
function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  if (options.isPreview) {
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  return {};
}

export function buildHostProcessEnv(hostProcessLocalEnv: Record<string, string>) {
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const larkCliBinaryPath = resolveBundledLarkCliBinaryPath();
  const resolvedGlmBinaryPath = resolveHostProcessBinaryEnv(
    "GLM_BINARY_PATH",
    hostProcessLocalEnv,
    glmBinaryPath,
  );
  const resolvedLarkCliBinaryPath = resolveHostProcessBinaryEnv(
    "ZCODE_LARK_CLI_BINARY",
    hostProcessLocalEnv,
    larkCliBinaryPath,
  );
  const dataBaseDir = getDataBaseDir();
  const rawInheritedEnv = {
    ...hostProcessLocalEnv,
    ...readDefinedProcessEnv(),
  };
  const packagedDesktop = isElectronAppPackaged();
  const bundledCuaHelperAppPath =
    process.platform !== "darwin"
      ? undefined
      : packagedDesktop
        ? join(process.resourcesPath, "cua-helper", HELPER_APP_NAME)
        : // Truthy grammar must match the producer's isUnsignedHelperLocalDevRequested
          // (1|true|on, case-insensitive). Accepting only the literal "1" silently
          // ignored `true`/`on` set by scripts following the documented dev flow.
          ["1", "true", "on"].includes(
              rawInheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL?.trim().toLowerCase() ?? "",
            )
          ? rawInheritedEnv.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() ||
            join(
              rawInheritedEnv.ZCODE_HOME?.trim() || join(homedir(), ".zcode"),
              "computer-use",
              "dev",
              DEV_HELPER_APP_NAME,
            )
          : undefined;
  const windowsAppInstallDir = resolveWindowsAppInstallDirForDataBaseDirGuard();
  const agentTelemetryEnv = readZCodeAgentTelemetryEnv(rawInheritedEnv);
  // The Desktop identity is trusted and injected by the host after reading from the credential warehouse and local state; the external environment can only configure OTLP connections.
  // You cannot forge uid/device/runtime surfaces or bypass the isolation boundaries of local identity state.
  for (const key of [
    "ZCODE_TELEMETRY_USER_ID",
    "ZCODE_TELEMETRY_USER_ID_HASH",
    "ZCODE_TELEMETRY_USER_SUBJECT_ID",
    "ZCODE_TELEMETRY_IDENTITY_STATE",
    "ZCODE_TELEMETRY_DEVICE_MID",
    "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  ]) {
    delete agentTelemetryEnv[key];
  }
  const inheritedEnv = applySelectedZCodeEnvLinks({
    ...sanitizeZCodeRuntimeEnv(rawInheritedEnv),
    ...buildZCodeToolEnvPassthroughEnv(rawInheritedEnv),
  });
  // A release app must never inherit the local unsigned-Helper escape hatch.
  // Otherwise a developer shell/launchctl variable can make the signed app
  // reject its verified bundled Helper and route onboarding to a stale dev app.
  if (packagedDesktop) {
    delete inheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL;
  }
  const dynamicWorkflowModeHostEnv = resolveDynamicWorkflowModeHostEnv({
    inheritedValue: rawInheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV],
    isPackaged: packagedDesktop,
    isPreview: isPreviewPackagedRuntime,
  });
  // Two of the three layers do not write this key, and the empty object cannot overwrite the inheritedEnv, so the inherited value is unconditionally deleted and then spread back according to the decision.
  // Without this line, the illegal values ​​​​of the production package and dev will be penetrated to the Host unchanged.
  delete inheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];

  return {
    ...inheritedEnv,
    // OTLP credentials are only directed to the host; they are captured and cleared from process.env immediately when the host initializes services.
    // Subsequent injection will only occur briefly when starting the Agent and will not enter Bash/MCP/tool env.
    ...agentTelemetryEnv,
    // NODE_ENV is no longer used by the ZCode runtime; it is reused by user shells, package managers, and test frameworks.
    // Here, ZCODE_RUNTIME_ENV is explicitly issued and NODE_ENV is cleared in the inheritance environment to avoid host/agent/Bash from being contaminated.
    [ZCODE_RUNTIME_ENV_KEY]: resolveHostProcessNodeEnv(),
    // Explicitly inject the compile-time product identity to ensure that the identity semantics of the main process and host are consistent; the address is resolved independently.
    // inheritedEnv completes the ZCode/ZAI link from the .env general variable, and uses the online default value if it is not overridden.
    ZCODE_ENV,
    // Preview shares tasks, configurations, and credentials with the production version, but different versions of Helper cannot overwrite each other or trigger downgrade protection.
    // Only isolate the running components under computer-use and do not rewrite the ZCODE_HOME / ZCODE_DATA_BASE_DIR business data root.
    ...(isPreviewPackagedRuntime ? { ZCODE_CUA_HELPER_INSTALL_VARIANT: "preview" } : {}),
    // Local override of Dynamic Workflow grayscale: Main written after decision, production package is empty object (inherited values ​​have been removed above).
    ...dynamicWorkflowModeHostEnv,
    // The default header of the model request is constructed by the agent process. In the past, only the shell env was inherited, resulting in the app version not being available when the desktop was started.
    // Here, it is explicitly issued from the main process. After the agent sub-process inherits the host env, it can stably write the request header.
    [ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,
    ...(dataBaseDir !== homedir() ? { ZCODE_DATA_BASE_DIR: dataBaseDir } : {}),
    ...(windowsAppInstallDir ? { [ZCODE_WINDOWS_APP_INSTALL_DIR_ENV]: windowsAppInstallDir } : {}),
    ...(bundledCuaHelperAppPath
      ? { [ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]: bundledCuaHelperAppPath }
      : {}),
    ...(resolvedGlmBinaryPath ? { GLM_BINARY_PATH: resolvedGlmBinaryPath } : {}),
    ...(resolvedLarkCliBinaryPath ? { ZCODE_LARK_CLI_BINARY: resolvedLarkCliBinaryPath } : {}),
  };
}
