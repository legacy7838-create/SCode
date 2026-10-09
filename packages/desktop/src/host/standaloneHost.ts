/**
 * Standalone Tauri Host sidecar entry (Phase 1).
 *
 * Runs the window-scoped Local Host as a plain Node process: it builds the real service collection
 * (`createLocalServices`) under a database-startup lifecycle, then serves it to the Tauri renderer over
 * a loopback WebSocket `ChannelServer` (`createWsChannelServer`). On listen it prints
 * `ZCODE_WS_READY <port>` so the Rust shell (which already parses this in `spawn_sidecar_*_discover_port`)
 * can hand the renderer the port.
 *
 * This is intentionally SEPARATE from the Electron-era `InitLocal` parentPort path in `index.ts` — it
 * reuses the same exported service primitives (`@zcode/services/node`) without modifying that path, so
 * the shipping startup flow is untouched. Desktop-integration reporters (cron/offpeak dispatch results,
 * resource telemetry, network-policy, feedback-via-main) are not yet re-homed; they degrade to no-ops /
 * local logs here and are tracked as Phase 3 surfaces. See `tauri-port/PORTING.md`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createHostApiNetworkTransport,
  createLocalServices,
  createServiceLogger,
  createSettingServiceWithMigrations,
} from "@zcode/services/node";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createWsChannelServer } from "./wsServe.js";

type LocalServices = ReturnType<typeof createLocalServices>;

/** Bootstrap descriptor assembled from the environment the Rust shell passes when spawning us. */
export interface StandaloneHostInit {
  databaseStartupId?: string;
  workspacePath?: string;
  deviceMid?: string;
  providerConfigFilePath: string;
  agentSpawnFallbackCwd?: string;
  runtimeProcessEnvPatch?: Record<string, string>;
  /** Requested WS port; 0 lets the OS pick an ephemeral port (discovered via `ZCODE_WS_READY`). */
  wsPort: number;
}

/** Read the {@link StandaloneHostInit} from `ZCODE_*` env vars set by the Rust spawner. */
export function readStandaloneHostInitFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StandaloneHostInit {
  const wsPortRaw = env["ZCODE_WS_PORT"]?.trim();
  const wsPort = wsPortRaw ? Number(wsPortRaw) : 0;
  if (!Number.isInteger(wsPort) || wsPort < 0 || wsPort > 65535) {
    throw new Error(`Invalid ZCODE_WS_PORT: ${JSON.stringify(wsPortRaw)}`);
  }
  const patch = env["ZCODE_RUNTIME_ENV_PATCH_JSON"]
    ? (JSON.parse(env["ZCODE_RUNTIME_ENV_PATCH_JSON"]) as Record<string, string>)
    : undefined;
  return {
    databaseStartupId: env["ZCODE_DB_STARTUP_ID"]?.trim() || undefined,
    workspacePath: env["ZCODE_WORKSPACE_PATH"]?.trim() || undefined,
    deviceMid: env["ZCODE_DEVICE_MID"]?.trim() || undefined,
    providerConfigFilePath: ensureProviderConfigFile(
      env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_PATH"],
    ),
    agentSpawnFallbackCwd: env["ZCODE_AGENT_SPAWN_FALLBACK_CWD"]?.trim() || undefined,
    runtimeProcessEnvPatch: patch,
    wsPort,
  };
}

/**
 * Resolve the built-in provider config path, defaulting to a writable dev location and creating an
 * empty config if absent. Real provider-config management is a Phase-3 surface; this keeps the
 * standalone dev sidecar bootable without the (deleted) Electron main supplying the path.
 */
function ensureProviderConfigFile(configured: string | undefined): string {
  const path = configured?.trim() || join(tmpdir(), "zcode-host-dev", "providers.json");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ providers: {} }), "utf8");
  }
  return path;
}

/**
 * Build the local service collection under a database-startup lifecycle, then serve it over WS.
 *
 * @returns The bound loopback port (also printed to stdout as `ZCODE_WS_READY <port>`).
 */
export async function startStandaloneHost(init: StandaloneHostInit): Promise<number> {
  const logger = createServiceLogger("desktop-host-standalone");
  logger.info(`standalone host booting workspace=${init.workspacePath ?? process.cwd()}`);

  let services: LocalServices | undefined;
  let failure: unknown;
  let notifySettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    notifySettled = resolve;
  });

  const startup = createHostDatabaseStartup({
    startupId: init.databaseStartupId,
    cwd: init.agentSpawnFallbackCwd ?? process.cwd(),
    workingDirectories: init.workspacePath ? [init.workspacePath] : [],
    env: init.runtimeProcessEnvPatch,
    publish: (state) => {
      logger.info(`database startup phase=${state.phase}`);
      if (state.phase === "ready") notifySettled();
    },
    onFailure: (error) => {
      failure = error;
      notifySettled();
    },
    initializeServices: async () => {
      const { service: settingService, prepareLegacyAccountConnections } =
        createSettingServiceWithMigrations();
      const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
        const settings = await settingService.get();
        return {
          httpProxy: settings.httpProxy,
          noProxy: settings.httpProxyNoProxy,
          caCertPath: settings.httpProxyCaCertPath,
        };
      });
      services = await initializeHostApiNetworkTransportOwner({
        transport: hostApiNetworkTransport,
        log: (message, details) => logger.warn(message, details),
        establishOwner: () =>
          createLocalServices({
            settingService,
            prepareLegacyAccountConnections,
            hostApiNetworkTransport,
            zcodeBuiltinProviderConfigFilePath: init.providerConfigFilePath,
            zcodeAgentSpawnFallbackCwd: init.agentSpawnFallbackCwd,
            runtimeProcessEnvPatch: init.runtimeProcessEnvPatch,
            serviceAuthorityMode: "desktop-local",
            agentRuntimeContext: {
              getDeviceMid: () => init.deviceMid,
              runtimeSurface: "desktop_local_host",
            },
          }),
      });
    },
  });

  await startup.coordinator.start();
  await settled;
  if (failure) throw failure;
  if (!services) throw new Error("standalone host services were not initialized");

  const port = await serveServicesOverWebSocket(services, init.wsPort, logger);
  // Rust discovers the bound port by reading this exact stdout line.
  process.stdout.write(`ZCODE_WS_READY ${port}\n`);
  return port;
}

/** Start a loopback WebSocket server and expose every service channel to each accepted connection. */
function serveServicesOverWebSocket(
  services: LocalServices,
  requestedPort: number,
  logger: ReturnType<typeof createServiceLogger>,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: requestedPort });
    wss.on("listening", () => {
      resolve((wss.address() as AddressInfo).port);
    });
    wss.on("error", reject);
    wss.on("connection", (ws) => {
      const handle = createWsChannelServer(ws, {
        name: "host",
        log: (message, ...args) => logger.info(message, ...args),
      });
      // Core channels only for now; per-connection agent controller scope + media/task routing
      // overrides are added alongside the Phase 3 re-homing of the Electron-main surfaces.
      services.exposeOnChannelServer(handle.server);
    });
  });
}

// Self-executing sidecar entry: only when explicitly asked, so the module stays importable by tests.
if (process.env["ZCODE_HOST_WS"] === "1") {
  void startStandaloneHost(readStandaloneHostInitFromEnv()).catch((error: unknown) => {
    process.stderr.write(`standalone host failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
