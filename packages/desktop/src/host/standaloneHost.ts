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
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createHostApiNetworkTransport,
  createLocalServices,
  createServiceLogger,
  createSettingServiceWithMigrations,
} from "@zcode/services/node";
import { IWindowControllerService, IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
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
    providerConfigFilePath: resolveProviderConfigFile(
      env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_PATH"],
    ),
    agentSpawnFallbackCwd: env["ZCODE_AGENT_SPAWN_FALLBACK_CWD"]?.trim() || undefined,
    runtimeProcessEnvPatch: patch,
    wsPort,
  };
}

/**
 * Resolve the built-in provider config path.
 *
 * Bug 修复依据：这里原来是 `configured ?? /tmp/zcode-host-dev/providers.json`，并且在文件不存在时
 * 直接写出 `{"providers":{}}`。那个内容**不是**合法的 `ZCodeBuiltinRelease` envelope
 * （缺少 `schemaVersion` / `revision` / `config{providerConfigRules,modelConfigRules}`，而且顶层
 * `providers` 会被 strict schema 拒绝），所以每次启动都会报
 * `Unrecognized key: "providers"` + `expected number, received undefined`；Provider 启动状态因此
 * 永不 settled，`shouldBlockRootRender()` 恒为 true，窗口永远卡在启动 logo。打包态之所以命中它，
 * 是因为 Rust spawner 从不传 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_PATH`。
 *
 * 现在：调用方给了路径就用它（不再写任何兼容文件）；未给则从当前目录向上找仓库内的
 * `config/provider/zcode-builtin.json`（dev 态的正解）；仍找不到就返回一个不存在的默认路径。
 * `readReleaseCandidate()` 对 ENOENT 是当“没有候选”处理的，比起每启动一次就写一刑非法文件，
 * 缺席是可诚实降级的状态。
 */
function resolveProviderConfigFile(configured: string | undefined): string {
  const requested = configured?.trim();
  if (requested) return requested;

  const relative = join("config", "provider", "zcode-builtin.json");
  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(tmpdir(), "zcode-host-dev", "zcode-builtin.json");
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

  // Window-controller runtime: the renderer's `window-controller` channel needs it registered on the
  // service collection + a per-connection attachment override (mirrors the Electron expose path).
  // Local-only resolveSource: the standalone sidecar serves a single local workspace set.
  const resolvedServices = services;
  const windowHostControllerRuntime = createWindowHostControllerRuntime({
    createId: randomUUID,
    resolveSource: (scope) => {
      const taskService = resolvedServices.getOptional(IZCodeTaskService);
      if (!taskService) return null;
      return {
        scope: {
          kind: "local" as const,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
        taskService,
        agentService: resolvedServices.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    },
  });
  resolvedServices.register(IWindowControllerService, windowHostControllerRuntime.service);

  const port = await serveServicesOverWebSocket(
    resolvedServices,
    windowHostControllerRuntime,
    init.wsPort,
    logger,
  );
  // Rust discovers the bound port by reading this exact stdout line.
  process.stdout.write(`ZCODE_WS_READY ${port}\n`);
  return port;
}

/** Start a loopback WebSocket server and expose every service channel to each accepted connection. */
function serveServicesOverWebSocket(
  services: LocalServices,
  windowHostControllerRuntime: ReturnType<typeof createWindowHostControllerRuntime>,
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
      // Per-connection window-controller attachment override (mirrors the Electron expose path) so the
      // renderer's `window-controller` channel resolves. Agent-scope / media / task routing overrides
      // remain Phase 3 surfaces.
      const overrides = new Map<string, unknown>([
        [
          IWindowControllerService.channelName,
          windowHostControllerRuntime.createAttachmentService(),
        ],
      ]);
      services.exposeOnChannelServer(handle.server, overrides);
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
