import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import type { ITerminalService, TerminalWindowsPtyInfo } from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
type PtySpawnOptions = Parameters<NodePtyModule["spawn"]>[2];

interface TerminalInstance {
  pty: IPty;
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
}

let hasEnsuredNodePtyHelper = false;
let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

async function loadNodePtyModule(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const message = error instanceof Error ? error.message : String(error);
      // When the remote server starts, all services will be created first. Previously, the top-level import node-pty was used.
      // As long as the current platform lacks pty.node, it will crash directly during the service registration phase, and the entire remote connection link will fail.
      // After changing to lazy loading, the server can complete the handshake first, and only expose the "terminal unavailable" error when the terminal is actually created.
      throw new Error(`node-pty is unavailable in this runtime: ${message}`);
    }) as Promise<NodePtyModule>;
  }

  return nodePtyModulePromise;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split(".")[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== "win32") return undefined;

  return {
    backend: "conpty",
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
}

function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== "darwin") return null;

  try {
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

    let helperPath = resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`);
    helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
    helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
    return helperPath;
  } catch {
    return null;
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (hasEnsuredNodePtyHelper || process.platform !== "darwin") return;
  hasEnsuredNodePtyHelper = true;

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !existsSync(helperPath)) return;

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // The node-pty spawn-helper in the current environment has lost execution permission.
    // child_process.spawn still works, but node-pty will call this helper first when starting the pseudo terminal on macOS,
    // If the helper is not executable, posix_spawnp failed will be reported directly.
    // Here, the helper is corrected to 0755 before actual spawning to prevent the terminal from being unable to open due to permission drift of the installed product.
  }

  try {
    chmodSync(helperPath, 0o755);
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}. ${message}`);
  }
}

function shouldFallbackFromConptyDll(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
    message,
  );
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

const DARWIN_GUI_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged.join(delimiter);
}

function resolveDarwinTerminalPath(env: NodeJS.ProcessEnv): string {
  return mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
}

function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv): string {
  const inheritedUtf8Locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;

  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

function resolveTerminalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale = resolveFallbackUtf8Locale(env);

  // When macOS starts Electron from the Dock/Finder/login item, the parent process usually only takes /usr/bin:/bin:/usr/sbin:/sbin.
  // PATH is even missing; although the built-in terminal opens the login shell, zsh/bash will still inherit this too narrow PATH first.
  // As a result, common commands such as npm/node/pnpm other than ls cannot be found, and some users' profiles will not be refilled.
  // Here we only fill in the common Homebrew and system paths in the environment passed to the terminal, do not change the global process.env, and retain the user's existing order.
  if (process.platform === "darwin") {
    nextEnv.PATH = resolveDarwinTerminalPath(env);
  }

  // The runtime login shell environment collection will use TERM=dumb / CI=1 to prevent the profile script from entering the interactive branch.
  // But the real terminal panel must be started as an interactive terminal, otherwise starship, p10k, color capability detection, etc. will be degraded to unstyled output.
  nextEnv.TERM = "xterm-256color";
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || "truecolor";
  if (nextEnv.CI === "1" && env.TERM === "dumb") {
    delete nextEnv.CI;
  }

  // When Electron is started from the GUI, the host process may not inherit the UTF-8 locale of the login shell.
  // The sub-shell will fall into the C/POSIX locale, and the Chinese path will be displayed by zsh/bash as escaped garbled characters such as \M-^.
  // Here, UTF-8 is only added when the locale is missing or is explicitly C/POSIX, and the UTF-8 locale already configured by the user is retained.
  if (isMissingOrCLocale(nextEnv.LANG)) {
    nextEnv.LANG = fallbackLocale;
  }
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) {
    nextEnv.LC_CTYPE = fallbackLocale;
  }
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }

  return nextEnv;
}

function spawnTerminalProcess(params: {
  nodePty: NodePtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;

  if (process.platform !== "win32") {
    return nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: "utf8",
    });
  }

  const windowsBaseOptions = {
    useConpty: true,
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } satisfies PtySpawnOptions;

  try {
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: true,
    });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) {
      throw error;
    }

    // When node-pty's experimental useConptyDll is turned on under Windows, some Electron/installation package environments will start before the shell actually starts.
    // Just because the native module positioning of compty.node/compty.dll fails and directly reports an error, the terminal cannot be opened.
    // Here, we only fall back to the system's built-in ConPTY when hitting this type of DLL loading error, which not only retains the priority of the new version of the path, but also avoids misjudgment of ordinary startup failures as retryable.
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: false,
    });
  }
}

function resolveTerminalShell(): string {
  if (process.platform === "win32") {
    // Windows PowerShell 5.1's PSReadLine makes it easier to redraw input line blanks to ANSI black background under ConPTY.
    // The terminal compatibility of PowerShell 7+ is closer to the desktop. The installed pwsh is used first. If it cannot be found, it will fall back to the system's own shell.
    const candidates = ["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"];

    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }

    throw new Error("No usable Windows shell found for terminal startup");
  }

  // Previously, the SHELL environment variable was directly trusted. If a non-existent shell path remains in the external environment,
  // The bottom layer of node-pty will directly hand this bad path to posix_spawnp, and an error will be reported when the terminal is created.
  // Here we first check whether SHELL is really executable. If it is not available, we will fall back according to the common shell order to avoid direct startup failure.
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  throw new Error("No usable shell found for terminal startup");
}

function resolveTerminalCwd(cwd?: string): string {
  // The workspace directory may have been deleted, moved, or an invalid path was passed in during startup.
  // Previously, passing this cwd to node-pty as it was would also fail in the spawn stage.
  // Here, priority is given to using the incoming directory. If it is unavailable, it will fall back to the HOME / system home / root directory to ensure that the terminal can still be launched.
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}

export function createTerminalService(dependencies: {
  settingService: ISettingService;
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>();
  let nextId = 0;
  // Memory diagnostic counter: when the client is disconnected and does not recycle pty
  // It will only increase, not decrease.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: terminals.size,
  }));

  function getTerminal(id: string): TerminalInstance {
    const t = terminals.get(id);
    if (!t) throw new Error(`Terminal not found: ${id}`);
    return t;
  }

  function cleanupTerminal(id: string): void {
    const terminal = terminals.get(id);
    if (!terminal) {
      return;
    }

    terminal.pty.kill();
    terminal.dataEmitter.dispose();
    terminal.exitEmitter.dispose();
    terminals.delete(id);
  }

  const service: ITerminalService & { disposeAll(): void } = {
    async create(params: { cols: number; rows: number; cwd?: string }): Promise<{
      id: string;
      shell: string;
      fontFamily: string;
      fontSize?: number;
      theme?: TerminalThemeProfile;
      fontFamilySource: TerminalFontFamilySource;
      windowsPty?: TerminalWindowsPtyInfo;
    }> {
      const id = String(nextId++);
      const shell = resolveTerminalShell();
      const cwd = resolveTerminalCwd(params.cwd);
      const env = resolveTerminalEnv();
      const terminalProfileSettings = await dependencies.settingService.get().catch(() => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      }));
      const fontProfile = resolveTerminalFontProfile({
        settings: terminalProfileSettings,
        env: process.env,
      });
      const nodePty = await loadNodePtyModule();
      ensureNodePtySpawnHelperExecutable();
      const dataEmitter = new Emitter<string>();
      const exitEmitter = new Emitter<number>();

      let p: IPty;
      try {
        p = spawnTerminalProcess({
          nodePty,
          shell,
          cols: params.cols,
          rows: params.rows,
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(
          `Failed to start terminal with shell '${shell}' in '${cwd}': ${getErrorMessage(error)}`,
        );
      }

      p.onData((data) => dataEmitter.fire(data));
      p.onExit(({ exitCode }) => {
        exitEmitter.fire(exitCode);
        dataEmitter.dispose();
        exitEmitter.dispose();
        terminals.delete(id);
      });

      terminals.set(id, { pty: p, dataEmitter, exitEmitter });
      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    },

    async write(params: { id: string; data: string }): Promise<void> {
      getTerminal(params.id).pty.write(params.data);
    },

    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      getTerminal(params.id).pty.resize(params.cols, params.rows);
    },

    async dispose(params: { id: string }): Promise<void> {
      cleanupTerminal(params.id);
    },

    onDynamicData(id: string): Event<string> {
      return getTerminal(id).dataEmitter.event;
    },

    onDynamicExit(id: string): Event<number> {
      return getTerminal(id).exitEmitter.event;
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      // The host process used to only end itself when the app was closed, and the subshells in the terminal were not explicitly killed one by one.
      // A local cleanup entry is added here so that the host can synchronously recycle all surviving terminal processes in the exit link.
      for (const id of Array.from(terminals.keys())) {
        cleanupTerminal(id);
      }
    },
  };

  return service;
}
