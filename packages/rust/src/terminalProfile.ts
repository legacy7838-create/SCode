/**
 * Typed wrapper over the zcode-terminal-profile napi binary.
 *
 * Spec: docs/specs/rust-native-terminal-profile.md
 *
 * The crate owns the detection ladder, the shell/cwd ladders and the spawn policy check.
 * This module is the only place that knows how to reach the binary; consumers import it
 * through the `@zcode/rust/terminal-profile` subpath.
 *
 * Load errors are thrown loudly by `loadNative` — there is no JavaScript fallback here, and
 * the TypeScript implementation this replaced has been deleted rather than disabled.
 */
import { loadNative } from "./loader.js";

export interface NativeTerminalEnvInput {
    /** `env.HOME` */
    home?: string;
    /** `env.USERPROFILE` */
    userProfile?: string;
    /** `env.LOCALAPPDATA` */
    localAppData?: string;
    /** `env.APPDATA` */
    appData?: string;
    /** `env.XDG_CONFIG_HOME` */
    xdgConfigHome?: string;
    /** `env.SHELL` */
    shell?: string;
    /** `env.PATH` */
    path?: string;
    /** `env.ComSpec` */
    comSpec?: string;
    /** `os.homedir()` — the last fallback of the home chain. */
    homeDir: string;
}

export interface NativeTerminalThemeProfile {
    foreground?: string;
    background?: string;
    cursor?: string;
    cursorAccent?: string;
    selectionBackground?: string;
    selectionInactiveBackground?: string;
    black?: string;
    red?: string;
    green?: string;
    yellow?: string;
    blue?: string;
    magenta?: string;
    cyan?: string;
    white?: string;
    brightBlack?: string;
    brightRed?: string;
    brightGreen?: string;
    brightYellow?: string;
    brightBlue?: string;
    brightMagenta?: string;
    brightCyan?: string;
    brightWhite?: string;
}

export interface NativeTerminalProfileRequest {
    platform: string;
    env: NativeTerminalEnvInput;
    terminalFontFamily?: string;
    terminalInheritSystemProfile?: boolean;
    /** `plutil -convert json` output for `com.googlecode.iterm2.plist`. */
    iterm2PlistJson?: string;
    /** `plutil -convert json` output for `com.apple.Terminal.plist`. */
    macosTerminalPlistJson?: string;
}

export interface NativeTerminalFontProfile {
    fontFamily: string;
    fontSize?: number;
    theme?: NativeTerminalThemeProfile;
    /**
     * `"custom" | "system" | "fallback"`.
     *
     * The native side emits exactly these three literals — `crates/zcode-terminal-profile/src/detectors.rs`
     * produces `"custom"`, `"system"` and `"fallback"` and nothing else — and each is pinned by a
     * `#[test]` in the same file. Declaring the union here records that closed set; `string` would
     * be a wider type than the binary can actually produce.
     */
    source: "custom" | "system" | "fallback";
}

export interface NativeTerminalDetectedProfile {
    fontFamily?: string;
    fontSize?: number;
    theme?: NativeTerminalThemeProfile;
}

export interface NativeTerminalShellRequest {
    platform: string;
    shell?: string;
    comSpec?: string;
    path?: string;
}

export interface NativeTerminalCwdRequest {
    cwd?: string;
    home?: string;
    homeDir: string;
}

export interface NativeTerminalSpawnPolicy {
    /** Exact binaries the shell ladder may return; compared with `==`. */
    allowedShells: string[];
    /** Directories a pty may start in, after symlink resolution. */
    allowedCwdRoots: string[];
    /** Environment variable names stripped from the child environment. */
    envDenylist: string[];
    /** Whether the child inherits the parent environment at all. */
    inheritEnv: boolean;
    maxCols: number;
    maxRows: number;
}

export interface NativeTerminalSpawnRequest {
    platform: string;
    shell: string;
    cwd: string;
    cols: number;
    rows: number;
}

export interface NativeTerminalSpawnDecision {
    allowed: boolean;
    reason: string;
}

export interface NativeTerminalProfileModule {
    resolveTerminalFontProfile(
        request: NativeTerminalProfileRequest,
    ): Promise<NativeTerminalFontProfile>;
    parseIterm2Plist(plistJson: string): NativeTerminalDetectedProfile | null;
    parseMacOsTerminalPlist(plistJson: string): NativeTerminalDetectedProfile | null;
    resolveTerminalShell(request: NativeTerminalShellRequest): string;
    resolveTerminalCwd(request: NativeTerminalCwdRequest): string;
    checkTerminalSpawnPolicy(
        policy: NativeTerminalSpawnPolicy,
        request: NativeTerminalSpawnRequest,
    ): NativeTerminalSpawnDecision;
}

let _cached: NativeTerminalProfileModule | null = null;

export function loadTerminalProfile(): NativeTerminalProfileModule {
    if (!_cached) {
        _cached = loadNative<NativeTerminalProfileModule>("zcode-terminal-profile");
    }
    return _cached;
}

export function resolveTerminalFontProfile(
    request: NativeTerminalProfileRequest,
): Promise<NativeTerminalFontProfile> {
    return loadTerminalProfile()
        .resolveTerminalFontProfile(request)
        // The native object sets its keys in napi's order; the payload this replaces emitted
        // `fontFamily, fontSize, theme, source`, and it goes to the renderer through
        // `JSON.stringify`, where key order is bytes. Rebuilding it here keeps those bytes.
        .then((profile) => ({
            fontFamily: profile.fontFamily,
            fontSize: profile.fontSize,
            theme: profile.theme,
            source: profile.source,
        }));
}

export function parseIterm2Plist(plistJson: string): NativeTerminalDetectedProfile | null {
    return loadTerminalProfile().parseIterm2Plist(plistJson);
}

export function parseMacOsTerminalPlist(plistJson: string): NativeTerminalDetectedProfile | null {
    return loadTerminalProfile().parseMacOsTerminalPlist(plistJson);
}

export function resolveTerminalShell(request: NativeTerminalShellRequest): string {
    return loadTerminalProfile().resolveTerminalShell(request);
}

export function resolveTerminalCwd(request: NativeTerminalCwdRequest): string {
    return loadTerminalProfile().resolveTerminalCwd(request);
}

export function checkTerminalSpawnPolicy(
    policy: NativeTerminalSpawnPolicy,
    request: NativeTerminalSpawnRequest,
): NativeTerminalSpawnDecision {
    return loadTerminalProfile().checkTerminalSpawnPolicy(policy, request);
}
