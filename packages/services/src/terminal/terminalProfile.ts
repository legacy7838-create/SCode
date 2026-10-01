import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    resolveTerminalCwd as resolveTerminalCwdNative,
    resolveTerminalFontProfile as resolveTerminalFontProfileNative,
    resolveTerminalShell as resolveTerminalShellNative,
} from "@zcode/rust/terminal-profile";
import type { TerminalThemeProfile } from "./terminalProfileTypes.js";
import type { AppSettings } from "@zcode/shared";
export type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfileTypes.js";

interface TerminalFontProfile {
    fontFamily: string;
    fontSize?: number;
    theme?: TerminalThemeProfile;
    source: "custom" | "system" | "fallback";
}

interface TerminalFontProfileInput {
    settings: Pick<AppSettings, "terminalFontFamily" | "terminalInheritSystemProfile">;
    env?: NodeJS.ProcessEnv;
}

const MACOS_PLIST_READ_TIMEOUT_MS = 2_000;

/**
 * The one child-process spawn left in this module, and the reason the rest of it is not here
 * any more.
 *
 * `plutil` is the only way to read a binary or XML plist on macOS from Node, and invariant 5
 * of docs/specs/rust-native-terminal-profile.md forbids a spawned child inside a ported
 * feature. So the *read* stayed in TypeScript and everything downstream of the plist — the
 * `New Bookmarks` ordering, the `Normal Font` descriptor, the archived `NSData` font name and
 * every colour — moved to Rust and consumes this string. See the spec §2.2.
 */
function readMacOsPlistJson(filePath: string): string | undefined {
    if (process.platform !== "darwin" || !existsSync(filePath)) {
        return undefined;
    }

    try {
        return execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], {
            encoding: "utf8",
            windowsHide: true,
            timeout: MACOS_PLIST_READ_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024,
        });
    } catch {
        // A missing plist, an unreadable one, or a `plutil` failure is a silently skipped
        // source: the terminal falls back to the next detector.
        return undefined;
    }
}

/**
 * Resolves the font family, size and colour profile a terminal panel should render with.
 *
 * The detection ladder, the JSONC/TOML/YAML parsing, the plist parsing and the font-stack
 * dedupe all live in `zcode-terminal-profile`; the TypeScript implementation that used to own
 * them was deleted in the same change. The call is a Promise because the ladder reads up to
 * eleven config files and therefore runs as a native async task (invariant 4).
 */
export async function resolveTerminalFontProfile(
    input: TerminalFontProfileInput,
): Promise<TerminalFontProfile> {
    const env = input.env ?? process.env;
    const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
    return resolveTerminalFontProfileNative({
        platform: process.platform,
        env: {
            home: env.HOME,
            userProfile: env.USERPROFILE,
            localAppData: env.LOCALAPPDATA,
            appData: env.APPDATA,
            xdgConfigHome: env.XDG_CONFIG_HOME,
            homeDir,
        },
        terminalFontFamily: input.settings.terminalFontFamily,
        terminalInheritSystemProfile: input.settings.terminalInheritSystemProfile,
        iterm2PlistJson: readMacOsPlistJson(
            join(homeDir, "Library", "Preferences", "com.googlecode.iterm2.plist"),
        ),
        macosTerminalPlistJson: readMacOsPlistJson(
            join(homeDir, "Library", "Preferences", "com.apple.Terminal.plist"),
        ),
    });
}

/**
 * `resolveTerminalShell` — `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`, and on Windows
 * `pwsh.exe` → `powershell.exe` → `%ComSpec%` → `cmd.exe`. First *executable* candidate wins;
 * throws with the legacy message when there is none, because a terminal that spawns nothing
 * is the safe failure.
 */
export function resolveTerminalShell(): string {
    return resolveTerminalShellNative({
        platform: process.platform,
        shell: process.env.SHELL,
        comSpec: process.env.ComSpec,
        path: process.env.PATH,
    });
}

/**
 * `resolveTerminalCwd` — the requested directory → `$HOME` → `os.homedir()` → `/`, first one
 * that stats as a directory.
 */
export function resolveTerminalCwd(cwd?: string): string {
    return resolveTerminalCwdNative({
        cwd,
        home: process.env.HOME,
        homeDir: homedir(),
    });
}
