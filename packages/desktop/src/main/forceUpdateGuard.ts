import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  getForceUpdateMinimalVersionFromConfig,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
} from "@zcode/shared";
import { requestForceAutoUpdate, type ForceAutoUpdateState } from "./autoUpdater.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

const ZCODE_CLIENT_CONFIG_API_PATH = "/api/v1/client/configs";
const FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

interface ForceUpdateGuardOptions {
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  requestAutoUpdate?: (
    onStateChange?: (state: ForceAutoUpdateState) => void,
  ) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

function resolveForceUpdateClientConfigUrl(endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN): string {
  const url = new URL(
    `${buildZCodeEndpointUrls(endpointOrigin).origin}${ZCODE_CLIENT_CONFIG_API_PATH}`,
  );
  url.searchParams.set("app_version", ZCODE_VERSION);
  url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url.toString();
}

function getForceUpdateMinimalVersionFromClientConfig(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) {
    return undefined;
  }

  const envelope = config as {
    code?: unknown;
    data?: {
      configs?: unknown;
    };
  };
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    // /client/configs Like the service layer, only code=0 can be trusted to avoid accidentally triggering the strong update when the error envelope carries old data.
    throw new Error(`ZCode client config failed: ${envelope.code}`);
  }
  return getForceUpdateMinimalVersionFromConfig(envelope.data?.configs);
}

async function fetchRemoteForceUpdateConfig(
  endpointOrigin?: string,
  fetchRemoteConfig?: () => Promise<unknown>,
): Promise<unknown> {
  if (fetchRemoteConfig) {
    return fetchRemoteConfig();
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(resolveForceUpdateClientConfigUrl(endpointOrigin));
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // The strong update gate before startup cannot parse 4xx/5xx/HTML error pages as normal configuration, and uniformly take the offline downgrade path.
        fail(new Error(`force update config request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES) {
          // The remote configuration is read before the main window is created, and the response body must be limited to prevent abnormal responses from overwhelming the main process memory.
          fail(new Error("force update config response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
}): Promise<ForceUpdateRequirement | null> {
  const resolveFromConfig = (config: unknown) =>
    resolveForceUpdateRequirement({
      currentVersion: ZCODE_VERSION,
      forceUpdate: {
        minimalVersion:
          getForceUpdateMinimalVersionFromClientConfig(config) ??
          getForceUpdateMinimalVersionFromConfig(config) ??
          "",
      },
    });

  try {
    const remoteConfig = await fetchRemoteForceUpdateConfig(
      options.endpointOrigin,
      options.fetchRemoteConfig,
    );
    const remoteRequirement = resolveFromConfig(remoteConfig);
    if (remoteRequirement) {
      return remoteRequirement;
    }
  } catch (error) {
    // Reserved offline bypass interface: Do not turn off the switch when it is completely offline. You can then access an explicit offline bypass policy here.
    options.logger.warn(
      "[force-update] failed to read the remote force update config, skipping the force update check",
      { error },
    );
    return null;
  }

  return null;
}

function resolveForceUpdateDownloadUrl(endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN): string {
  return `${buildZCodeEndpointUrls(endpointOrigin).origin}/en`;
}

function formatForceUpdateDialogText(requirement: ForceUpdateRequirement): ForceUpdateDialogText {
  return {
    title: "Update ZCode",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Auto update",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement({
    ...options,
    endpointOrigin: options.endpointOrigin,
  });
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn(
    "[force-update] the remote config requires a force update, blocking main window creation",
    requirement,
  );
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement),
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    const url = resolveForceUpdateDownloadUrl(options.endpointOrigin);
    options.logger.info(`[force-update] the user chose to update manually: ${url}`);
    await shell.openExternal(url);
  }

  // You cannot enter the main interface after the forced upgrade is hit; exit after processing the pop-up window in the non-automatic upgrade path to avoid exposing the old client functions.
  app.quit();
  return { blocked: true, requirement };
}
