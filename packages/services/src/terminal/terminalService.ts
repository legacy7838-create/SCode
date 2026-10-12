import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Emitter, type Event } from "@zcode/rpc";
import type { ISettingService } from "../setting/setting.js";
import type { ITerminalService, TerminalWindowsPtyInfo } from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/**
 * The Node-API surface of the Rust `zcode-pty` addon. It owns the PTY process, the
 * shell/cwd/env resolution, and streams output/exit back through the two callbacks.
 * Naming is camelCase because napi-rs converts the Rust `snake_case` exports.
 */
interface PtyAddon {
  createTerminal(
    opts: { id: string; cols: number; rows: number; cwd?: string },
    onData: (data: string) => void,
    onExit: (code: number) => void,
  ): string;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  killTerminal(id: string): void;
  killAllTerminals(): void;
}

// A JS-side handle: only the emitters. The PTY itself lives in the Rust addon registry,
// keyed by the same id string we generate here, so the two maps always agree.
interface TerminalInstance {
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
}

let cachedAddon: PtyAddon | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveNativePath(): string {
  const fromEnv = process.env.ZCODE_PTY_NATIVE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_PTY_NATIVE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // packages/services/src/terminal/terminalService.ts → packages/desktop/zcode-pty/zcode_pty.node
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../desktop/zcode-pty/zcode_pty.node");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-pty native addon not found at ${candidate}. Build it with: node packages/desktop/scripts/prepare-zcode-pty-native.mjs (or set ZCODE_PTY_NATIVE).`,
    );
  }
  return candidate;
}

// Loaded lazily (on first create), not at module top level, so a host on a platform that
// lacks the prebuilt addon still completes the RPC handshake and only reports "terminal
// unavailable" when a terminal is actually opened — preserving the old JS-addon behavior.
function loadPtyAddon(): PtyAddon {
  if (!cachedAddon) {
    const req = createRequire(import.meta.url);
    cachedAddon = req(resolveNativePath()) as PtyAddon;
  }
  return cachedAddon;
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

export function createTerminalService(dependencies: {
  settingService: ISettingService;
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 pty 时这里会只增不减。
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
    // Kill the PTY in the addon, then tear down the JS emitters and the map entry.
    // The addon also drops its registry entry; killTerminal on an already-exited id is a no-op error.
    try {
      loadPtyAddon().killTerminal(id);
    } catch {
      // The child may already be gone (exit thread removed it); nothing further to kill.
    }
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
      const terminalProfileSettings = await dependencies.settingService.get().catch(() => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      }));
      const fontProfile = resolveTerminalFontProfile({
        settings: terminalProfileSettings,
        env: process.env,
      });

      const dataEmitter = new Emitter<string>();
      const exitEmitter = new Emitter<number>();
      const addon = loadPtyAddon();

      let shell: string;
      try {
        // Rust resolves shell/cwd/env and spawns the PTY; the callbacks fire from its
        // reader/exit threads and are marshaled here into @zcode/rpc Events.
        shell = addon.createTerminal(
          { id, cols: params.cols, rows: params.rows, cwd: params.cwd },
          (data) => dataEmitter.fire(data),
          (code) => {
            exitEmitter.fire(code);
            dataEmitter.dispose();
            exitEmitter.dispose();
            terminals.delete(id);
          },
        );
      } catch (error) {
        // The child never started; drop the emitters we allocated so they don't leak.
        dataEmitter.dispose();
        exitEmitter.dispose();
        throw new Error(`Failed to start terminal: ${getErrorMessage(error)}`);
      }

      terminals.set(id, { dataEmitter, exitEmitter });
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
      getTerminal(params.id);
      loadPtyAddon().writeTerminal(params.id, params.data);
    },

    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      getTerminal(params.id);
      loadPtyAddon().resizeTerminal(params.id, params.cols, params.rows);
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
      // app 关闭时 host process 以前只会结束自身，terminal 里的子 shell 没有逐个显式 kill。
      // 这里让 Rust addon 先回收所有存活的 PTY，再拆掉 JS 侧的 emitter 与映射。
      try {
        loadPtyAddon().killAllTerminals();
      } catch {
        // Addon may never have loaded (no terminal was ever opened); nothing to kill.
      }
      for (const terminal of terminals.values()) {
        terminal.dataEmitter.dispose();
        terminal.exitEmitter.dispose();
      }
      terminals.clear();
    },
  };

  return service;
}
