import { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zcode-agent/zcodeAgent.js";
/* eslint-disable max-lines -- zcodeAgentProcessManager centrally maintains agent sub-process startup, reuse, timeout recycling and runtime identity. Splitting will expand the process life cycle state synchronization area */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Emitter } from "@zcode/rpc";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@zcode/shared/process-diagnostic";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  ZCODE_RUNTIME_ENV_KEY,
  resolveWorkspaceKey,
  resolveZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
} from "@zcode/shared";
import {
  findZCodeAgentRuntimeBinary,
  findZCodeAgentRuntimeNodeBundle,
} from "../runtime-tools/providerRuntimeResolver.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "./zcodeStdioTransport.js";
import { readZCodeStdioTapDevState } from "./zcodeStdioTapDevConfig.js";
import type { ZCodeAgentPresentationSurface } from "./zcodeAgentPresentationSurface.js";
import { shouldSpawnInDetachedProcessGroup } from "../process/processTreeTerminator.js";
import type { RuntimeProcessLifecycleReporter } from "../process/runtimeProcessLifecycle.js";
import { buildAgentWorkspaceIdentityEnv } from "../runtime-tools/agentProxyEnv.js";

export interface ZCodeAgentCommand {
  /** Stores dedicated Worker entry for local supporting CLI bundle; remote/custom commands do not infer capabilities. */
  storagePreparationEntry?: string;
  /** The Agent deployed this time supports startup notification before migration; the old custom commands maintain the original protocol. */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ZCodeAgentCommandResolverContext {
  presentationSurface?: ZCodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export type ZCodeAgentCommandResolver = (
  context: ZCodeAgentCommandResolverContext,
) => Promise<ZCodeAgentCommand | null> | ZCodeAgentCommand | null;

export interface ZCodeAgentProcessManagerOptions {
  commandResolver?: ZCodeAgentCommandResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * Process swim lane identifier. Different swim lanes in the same workspace have independent manager instances; lanes will write
   * runtimeIdentity and spawn/exit logs for easy troubleshooting.
   * The default is the chat main lane, without adding any tags.
   */
  lane?: string;
  /**
   * Idle recycling threshold: If there is no request flying on the connection for more than this time, the entire process tree will be actively recycled.
   * GetClient will be transparently restarted next time. Only for mcp-status "on-demand detection, MCP sub-process hanging in the process"
   * The control plane lane is used; chat / plugin is not recycled by default.
   */
  idleTimeoutMs?: number;
  /**
   * Only used if the default process cwd is equal to the target workspace and that directory is not available.
   * Business workspacePath/workspaceKey does not change with cwd.
   */
  spawnFallbackCwd?: string;
  /**
   * Additional environment variables that are parsed before each spawn agent child process (incorporated after process.env and before the workspace variable).
   * It is used to inject the proxy and other configurations of the settings page into the child process; it is read when spawn is pressed, and it will naturally "take effect next time it is started".
   *
   * context carries the workspace identification triplet of this spawn (workspacePath/workspaceIdentity/workspaceKey),
   * Enable CUA broker credential injection to record Helper admission by workspace (see services/node.ts
   * cuaProductHelperWorkspaceRegistry). Helper lifecycle will no longer recycle or restart existing Agents.
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Optional external spawn admission hook. CUA default assembly no longer injects Helper recovery gate.
   * Avoid Helper lifecycle blocking or indirect Agent restart; keep this common hook for use by other product strategies.
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
}

interface ManagedZCodeAgentProcess {
  client: ZCodeProtocolClient;
  child: ChildProcessWithoutNullStreams;
  cleanupPromise?: Promise<void>;
  exited: boolean;
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

type AgentProcessCleanupReason =
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "workspace-dispose"
  | "workspace-dispose-retry";

interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

const E2E_COVERAGE_PRELOAD_SOURCE = `
const { takeCoverage } = require("node:v8");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const coverageDirectory = process.env.NODE_V8_COVERAGE;
let coverageFlushStarted = false;
for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const flushCoverage = () => {
    if (coverageFlushStarted) return;
    coverageFlushStarted = true;
    if (coverageDirectory) {
      writeFileSync(
        resolve(coverageDirectory, \`coverage-signal-\${process.pid}.marker\`),
        signal,
      );
    }
    try {
      takeCoverage();
    } catch (error) {
      if (coverageDirectory) {
        writeFileSync(
          resolve(coverageDirectory, \`coverage-signal-error-\${process.pid}.txt\`),
          error instanceof Error ? error.stack || error.message : String(error),
        );
      }
    }
    if (process.listenerCount(signal) !== 1) return;
    setTimeout(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    }, 1000);
  };
  process.prependListener(signal, flushCoverage);
}
if (coverageDirectory) {
  writeFileSync(resolve(coverageDirectory, \`coverage-ready-\${process.pid}.marker\`), "");
}
`;

function buildE2EAgentCoverageEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "zcode-e2e-coverage-preload.cjs");
  // When the CLI bundle is not compressed, the parsing time may exceed the E2E early exit window. Normal shutdown
  // The handler received SIGTERM before it was registered. Use NODE_OPTIONS preload to take over the download before parsing the bundle.
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * (CLI reconnect and redefine boundaries): The agent process of the same workspace is rebuilt (after timeout/crash
 * The first getClient is pulled up again). v4 subscription (sessions-index/workspace-config/conversation)
 * All live in the CLI process memory, and will become invalid when the process is replaced - the subscriber must resend the subscribe after receiving this event.
 */
interface ZCodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
}

export interface ZCodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** Process swim lane identifier; chat main swim lane is empty by default. */
  lane?: string;
}

interface ZCodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}

const serviceLog = createServiceLogger("zcode-agent");

const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;
const AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_STDERR_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_STDERR_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

function redactAgentDiagnostic(value: string): string {
  return (
    value
      .replace(AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_STDERR_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // Bare keys must also be masked before cross-process diagnostics and production logging.
      .replace(AGENT_STDERR_API_KEY_PATTERN, "$1<redacted>")
  );
}

const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};

function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnostic(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}

function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function buildZCodeAgentSpawnPreflight(
  command: ZCodeAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ZCodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveZCodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // The ENOENT of Node spawn may come from missing command or missing cwd.
    // The production log records the visibility of both before spawning to avoid misjudgment of workspace path loss as automatic update binary loss.
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

function resolveBundledWorkspaceZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const distEntrypoint = findUpward("apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (distEntrypoint) {
    const useBytecode =
      process.versions.electron && process.env.ZCODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), "zcode.bytecode.cjs")
      : distEntrypoint;
    // This sync command resolver inherits the existing existsSync contract; explicit testing cannot silently fall back to JS.
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error(
        "The desktop Agent bytecode entrypoint is missing; run pnpm build:desktop-agent:bytecode",
      );
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // The V8 snapshots of Worker and Electron Node child processes can be different; the temporary storage is ready to continue using JS.
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // The desktop host runs in the Electron utility process, and process.execPath points to the Electron Helper.
      // The Node running mode is explicitly enabled here to prevent the built-in zcode-agent from being started as an Electron/Chromium sub-process and getting stuck in GPU initialization.
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zcode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

function resolveDeployedZCodeAgentBinaryCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // The old resolver only recognized ZCODE_AGENT_SERVER_COMMAND env and monorepo source trees.
  // SSH remotely deploys the zcode-server.cjs single file to ~/.zcode/server/. The cwd of the host process is not in the warehouse.
  // env will not be inherited by ssh exec, even if zcode-agent has been deployed to ~/.zcode/server/agents/glm/,
  // The resolver cannot be found. The first time getClient throws "ZCode agent server command is not configured".
  // The candidate chain of findZCodeAgentRuntimeBinary is reused here (including GLM_BINARY_PATH env,
  // packagedResourcesPath, ~/.zcode/server/agents/glm, bundled-agents, etc.),
  // Treat the deployed native binary as the final fallback, and the remote/desktop packaging format can be hit.
  const binaryPath = findZCodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ZCODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

function resolveElectronRuntimeZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // Desktop packaging state: host runs in Electron utility process, process.execPath points to Electron Helper,
  // Its built-in Node runtime is consistent with the zcode-cli target version (Electron 41 = Node 24.x).
  // Here we directly use the Electron Node that comes with the app to execute the zcode.cjs written in resources/glm.
  // There is no longer an independent Node binary built into the package (the size is reduced from ~180MB to ~16MB, and the same JS is used across platforms).
  // Use process.versions.electron as a gate: the remote SSH/WSL host is run by the system Node and does not have electron.
  // I will skip this and continue to use the native binary. The desktop/remote links do not affect each other.
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findZCodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [bundlePath, ...ZCODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // Key: It must be started in pure Node mode, otherwise the child process will be stuck in GPU initialization as an Electron/Chromium child process.
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function resolveDefaultZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ZCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // Sequence: env explicit coverage → monorepo dev source code/dist (dev changes to the source code take effect immediately and will not be installed by the remote history native binary
  // Preemptive matching) → Desktop packaged state Electron Node runtime runs zcode.cjs → native binary has been deployed (remote SSH cover).
  const bundled =
    resolveBundledWorkspaceZCodeAgentCommand(context) ??
    resolveElectronRuntimeZCodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedZCodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

function applyPresentationSurfaceToCommand(
  command: ZCodeAgentCommand | null,
  presentationSurface: ZCodeAgentCommandResolverContext["presentationSurface"],
): ZCodeAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Reason for the bug: The old logic consumes the next token unconditionally, and the isolated --surface will cause subsequent
      // --stdio and other options are swallowed together, causing the custom Agent command to lose the protocol startup parameters.
      // Only clear non-option values ​​belong to --surface; other options continue to follow the original parameter link.
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

function wrapZCodeAgentCommandWithStdioTapDevProxy(
  command: ZCodeAgentCommand,
  workspaceKey: string,
): ZCodeAgentCommand {
  const tapState = readZCodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/zcode-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ZCode stdio tap proxy enabled but script not found");
    return command;
  }

  // The data volume of the raw stdio frame in the development state is at the same level as the message flow, and cannot be entered into the ordinary info log.
  // Here, the bypass proxy is only used to write to the disk when the explicit switch is turned on. The production build and default development path are not affected.
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

export class ZCodeAgentProcessManager {
  private readonly processesByWorkspaceKey = new Map<string, ManagedZCodeAgentProcess>();
  private readonly ownedProcesses = new Set<ManagedZCodeAgentProcess>();
  private readonly startingByWorkspaceKey = new Map<string, Promise<ZCodeProtocolClient>>();
  private readonly restartGenerationByWorkspaceKey = new Map<string, number>();
  private readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
  private readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  private readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  private readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ZCodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  private readonly commandResolver: ZCodeAgentCommandResolver;
  private readonly presentationSurface: ZCodeAgentProcessManagerOptions["presentationSurface"];
  private readonly requestTimeoutMs: number | undefined;
  private readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  private readonly resolveSpawnEnv: ZCodeAgentProcessManagerOptions["resolveSpawnEnv"];
  private readonly waitForSpawnAdmission: ZCodeAgentProcessManagerOptions["waitForSpawnAdmission"];
  private readonly spawnFallbackCwd: string | undefined;
  private readonly lane: string | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly runtimeRestartedEmitter = new Emitter<ZCodeAgentRuntimeRestartedEvent>();
  private readonly runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  private disposeAllInFlight: Promise<void> | undefined;
  private disposed = false;

  /** Process generation notification (triggered when generation>1); v4 subscribers resubscribe accordingly, see ZCodeAgentRuntimeRestartedEvent. */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** The process is available after it is actually spawned and unavailable after the current protocol client is closed. */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ZCodeAgentProcessManagerOptions) {
    this.commandResolver = options?.commandResolver ?? resolveDefaultZCodeAgentCommand;
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  }

  private reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // Process life cycle reporting is a side-channel observation, and temporary failures must not prevent agent startup or recycling.
      warnLog("ZCode agent process lifecycle reporter failed", error);
    }
  }

  private clearIdleTimer(managed: ManagedZCodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * Idle recycling: reset the timer every time the in-flight request reaches zero; if there are still no requests in flight and the process is still the current active instance,
   * Actively recycle the entire process tree (including the MCP child processes hanging below it). Attribution to expected/idle-timeout,
   * Will not be monitored as a crash. If there is a new request in flight when the point is reached, do nothing and wait for the next reset to zero to restart the timer.
   */
  private scheduleIdleReclaim(workspaceKey: string, managed: ManagedZCodeAgentProcess): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // The old startup request of the custom Agent may be settled before database preparation can continue; no in-flight RPC does not mean that the migration is idle.
      if (
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ZCode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // The idle timer cannot lock the host process into the event loop.
    timer.unref?.();
    managed.idleTimer = timer;
  }

  private recordTerminationIntent(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // Protocol close may be the result of Agent crash, only recycling initiated by Host
    // To establish exit intention. The reason for the first cleanup is the root cause fact, and subsequent idempotent recycling such as app quit cannot
    // Rewrite the exception protocol close that has occurred to expected.
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  private reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    const workspaceKey = managed.runtimeIdentity.workspaceKey;
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
      managed.runtimeIdentity.identity
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "unavailable",
    });
  }

  private reportRuntimeReady(managed: ManagedZCodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.child.pid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.child.pid!,
        provider: ZCODE_AGENT_PROVIDER,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

  private cleanupManagedProcess(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // protocol close will only make the client no longer reusable, but it does not mean that its corresponding
    // The OS process has exited. Bind the recycling Promise to the managed process, timeout, restart and
    // app quit can share the same idempotent recycling, and the Host will not lose ownership of the retired process.
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(() => {
        cleanupCompleted = true;
        log("ZCode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    if (options.reportError !== false) {
      void cleanupPromise.catch((error) => {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
          error,
        });
      });
    }
    return cleanupPromise;
  }

  private async cleanupManagedProcessForShutdown(managed: ManagedZCodeAgentProcess): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

  private async cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // The process tree/exit observation of the first cleanup may only be in the intermediate state; when the retry succeeds,
      // The first rejection should not be escalated to a production error alert early. The final failure is still reported once by this method.
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows process table query/exit events may lag behind temporarily, and the first cleanup will falsely report root
      // Residue. Neither restart/app quit can expose this intermediate state to the caller. It needs to be retried and reused.
      // Transport internal snapshot; real residue will continue to be thrown in the second cleanup.
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ZCode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, { reportError: false });
      } catch (finalError) {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    const workspaceKey = resolveWorkspaceKey(params);
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed) {
      return existing.client;
    }

    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ZCode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ZCode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      return client;
    }

    // After the agent starts the frontend, host warmup and UI readWorkspacePresentation/sendPrompt for the first time
    // May enter getClient at the same time. Here, the promises in startup are converged according to the workspaceKey to avoid repeated spawning in the same workspace.
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
    }
  }

  /**
   * Only the registered runtime client is read; passive observer uses this entry to avoid the implicit spawn of getClient.
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed && !managed.child.killed ? managed.client : undefined;
  }

  /** Resource manager: currently alive managed runtime (pid + workspace + client) */
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ZCodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ZCodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.child.pid !== "number") continue;
      result.push({
        pid: managed.child.pid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** The Agent service is called after passing the provider/model access control for the first time; the same runtime is only reported once. */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient may return earlier than the asynchronous spawn event of ChildProcess, or during await
    // Replaced by new runtime. Only the process that returns this entry is marked ready, and the spawn callback guarantees the start → ready sequence.
    this.reportRuntimeReady(managed);
  }

  private async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient> {
    const startStartedAt = Date.now();
    const resolveCommandStartedAt = Date.now();
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
    if (!command) {
      throw new Error(
        "ZCode agent server command is not configured. Set ZCODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("ZCode agent process start was cancelled.");
    }
    const effectiveCommand = wrapZCodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ZCode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery may start during command resolve; wait once first to ensure env resolution is used
    // Broker credentials after recovery instead of bringing old state to spawn boundary.
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // Set the page agent and other runtime env to be merged after process.env (overwriting the inherited shell variable of the same name),
    // But still keep command.env (deployment specific) at the highest priority.
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // While the app is shutting down, the booting warmup may have just finished command/env resolve.
      // At this time, continuing to spawn will bypass the snapshot of disposeAllAndWait and recreate an unmanaged agent process.
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // Changing the model will restart a single workspace. If the old startup request is restored after a reboot,
      // You cannot continue spawning and writing back to the process pool, otherwise the new configuration will be overwritten by the old agent.
      throw new Error("ZCode agent process start was cancelled.");
    }
    // The cwd probe also leaves the event loop and must be placed before final admission and destruction/generation checks.
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolve itself is asynchronous, and the recovery barrier may be closed again during this period; it must be before spawn
    // Wait and recheck the generation, don't just rely on the first admission.
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ZCode agent process start was cancelled.");
    }
    // When the app is started in local development mode, let the agent sub-process also bring ZCODE_RUNTIME_ENV=development;
    // NODE_ENV is no longer passed to prevent user shell/runtime variables from affecting the ZCode running mode or leaking to the Bash tool.
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // The agent may then spawn actual runtime/MCP child processes. Under POSIX, let the wrapper enter an independent process group.
      // The process tree can be recycled as a whole when it is closed; Windows remains non-detached and handed over to taskkill /T for processing.
      detached: shouldSpawnInDetachedProcessGroup(),
      env: {
        ...sanitizeZCodeRuntimeEnv(process.env),
        [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
        ...spawnEnv,
        ...effectiveCommand.env,
        // Identity/isolation semantics use workspaceIdentity; cwd continues to use workspacePath.
        ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
        ...buildE2EAgentCoverageEnv(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    const stderrTail = createAgentStderrTail();
    const transport = new ZCodeStdioTransport(child, {
      onStderrLine: (line) => {
        const diagnostic = parseZCodeProcessDiagnostic(line);
        if (diagnostic && typeof child.pid === "number") {
          // Root cause: Saving only the exit tail will miss exceptions that survive the runtime; this bypass does not rely on the debug switch.
          // The child when the identity binding is created cannot check the current workspace to avoid late event string processes after restarting.
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              runtimeGeneration,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // The desensitized placeholder may be longer than the original text and must be limited again to avoid legal exceptions rejected by the IPC schema.
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // Under POSIX, the child is started by this manager with detached=true, and the pid is also the Host.
      // Owned independent PGID; cleanup can still recycle descendants of the same group by group after an abnormal root exit.
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    // After the Agent process is restarted, the Host still needs runtime identity to distinguish old and new subscriptions and run commands.
    // The Provider Registry is rebuilt by the new Worker from the Config of its Environment and is no longer re-issued by the UI.
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // Lifecycle event association only requires the opaque identity of this runtime and cannot reuse the protocol identity containing workspaceKey.
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ZCodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}`,
      ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    const managed: ManagedZCodeAgentProcess = {
      child,
      client,
      exited: false,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
    const publishStorage = () => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(workspaceKey, managed);
      }
      this.storageStartupEmitter.fire({
        workspaceKey,
        snapshot: { generation: runtimeGeneration, state: client.storageStartup.snapshot ?? null },
      });
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() will first return ChildProcess and then report cwd/command ENOENT asynchronously.
      // The old code issued runtimeRestarted before confirming that spawn was successful, and the subscriber immediately reconnected and triggered again
      // Start, eventually forming a self-excited storm of failed startup -> false restart -> reconnection. Only spawn events represent
      // The new CLI runtime is real and can safely notify v4 subscribers to resubscribe.
      if (runtimeGeneration > 1 && this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity });
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, runtimeIdentity.identity);
        this.runtimeLifecycleEmitter.fire({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          workspaceKey,
          runtimeIdentity,
          state: "available",
        });
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ZCode agent process started", {
        workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: child.pid,
        durationMs: Date.now() - startStartedAt,
      });
    });
    child.once("error", (error) => {
      errorLog(
        `ZCode agent process error${this.processLifecycleReporter?.onError ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof child.pid === "number" ? child.pid : null,
          provider: ZCODE_AGENT_PROVIDER,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: params.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
      if (child.pid == null) {
        this.ownedProcesses.delete(managed);
      }
    });
    child.once("exit", async (code, signal) => {
      managed.exited = true;
      this.clearIdleTimer(managed);
      const endedAt = Date.now();
      const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
      // Protocol parsing/stream failure will first trigger protocol-close, and then the Host will use SIGTERM
      // Recycle still alive processes. If only the active termination intent is transparently transmitted, the desktop can only see the final signal.
      // Unable to distinguish protocol failure from controlled exit; retain first cleanup cause as structured root cause.
      const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
      // The protocol has expired immediately, but exit preceded stderr EOF; retaining old runtime closure identity for final diagnostics.
      await transport.waitForStderrDrain();
      const stderr = stderrTail.snapshot();
      const exitContext = {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        code,
        signal,
        terminationKind,
        terminationReason,
      };
      // The previous log only had the new "process started" and lacked the exit trace of the old pid.
      // After agent native crashes, the UI will only see protocol close/Session is not active, and cannot determine whether it crashed or actively restarted.
      log("ZCode agent process exited", exitContext);
      if (terminationKind === "unexpected") {
        // Agent's top-level exception only writes stderr and exits with non-zero code; stderr used to only enter the development state
        // debug, the production log only has code=1, and the exception cannot be restored. You cannot judge only by non-zero code: signal crash
        // The same as the long-running Agent's self-exit 0, which is an unexpected exit.
        // There are already independent life cycle events, and the wrapper log is explicitly marked to prevent Electron from counting it as a JS exception.
        errorLog(
          `ZCode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
          {
            ...exitContext,
            stderr,
          },
        );
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onExit({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            exitCode: code,
            signal,
            endedAt,
            terminationKind,
            runtimeReady: managed.readyAt != null,
            ...(terminationReason ? { terminationReason } : {}),
            runtimeGeneration,
            runtimeInstanceId,
            uptimeMs: Math.max(0, endedAt - startedAt),
            stderrLineCount: stderr.lineCount,
            ...(terminationKind === "unexpected" && stderr.tail.length > 0
              ? { stderrTail: stderr.tail }
              : {}),
          }),
        );
      }
    });
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ZCode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: child.pid,
          },
        );
        return;
      }
      warnLog("ZCode agent request timed out; disposing stale protocol client", {
        workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: child.pid,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // timeout indicates that the protocol request/response link is no longer trustworthy. The old implementation only rejects the current request,
      // However, the child has not yet exited, and the subsequent workspace will continue to reuse the bad client and time out repeatedly.
      // Here we actively recycle the process tree, allowing getClient to pull up a clean app-server again next time.
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(workspaceKey) === managed;
      log("ZCode agent protocol client closed", {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
      if (this.ownedProcesses.has(managed)) {
        // The root child's exit does not mean that the same set of MCP descendants have exited. Even if protocol close
        // When the root process exits, the Host ownership must be released only after idempotent recycling is completed according to the original process group.
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    return client;
  }

  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAgentRuntimeIdentity> {
    const workspaceKey = resolveWorkspaceKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity is the query interface, but the old implementation reuses the startup getClient.
    // Causes passive probes such as provider saving to implicitly spawn the Agent CLI by the number of workspaces.
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return managed.runtimeIdentity;
  }

  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ZCODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params);
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose cannot delete an unfinished start promise from the tracking table. Deletion will make
    // The next time getClient in recovery/UI opens another spawn, the old promise may then go out of sync.
    // resolve writes back to the process pool, forming a spawn/dispose storm in the same workspace. Generational check will make old
    // The promise fails before the actual spawn, and finally cleans the map according to the promise identity.
    if (managed) {
      // restartWorkspaceProcess should only recycle the agent of the current workspace.
      // DisposeAll cannot be reused, otherwise the entire manager will be marked as closed, and subsequent launches/preheating cannot be restarted.
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("ZCode agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

  private abortAllPendingStarts(
    reason = new Error("ZCode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // When app/host exits, the old logic only synchronizes the dispose client, and the SIGKILL of the underlying process tree is covered.
    // Relying on the unref timer, the timer will no longer be executed after the host exits, and zcode-cli will remain as an orphan process.
    // This allows the host to wait for the agent process tree of each workspace to complete graceful + force cleanup.
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
